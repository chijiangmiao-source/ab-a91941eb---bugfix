'use strict';

// Acceptance verifier. Stages, in order:
//   1. envelope contract tests  (node --test app/tests)
//   2. build checks             (syntax check of every JS file, manifest sanity)
//   3. HTTP smoke               (health, field preservation, conflict handling)
// The process exit code is the acceptance result: 0 = accepted, 1 = rejected.

const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP_URL = (process.env.APP_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const HEALTH_TIMEOUT_MS = Number(process.env.HEALTH_TIMEOUT_MS || 60000);

const results = [];
function record(stage, name, ok, detail) {
  results.push({ stage, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${stage}] ${name}${detail ? ' — ' + detail : ''}`);
}

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/* ---------------- Stage 1: envelope contract tests ---------------- */

function stageContractTests() {
  const r = run(process.execPath, ['--test', 'app/tests/']);
  const ok = r.code === 0;
  const summary = (r.out.match(/# pass \d+/) || [''])[0];
  record('contract', 'envelope contract tests (node --test app/tests)', ok,
    ok ? summary : r.out.split('\n').filter((l) => l.includes('fail')).slice(0, 3).join(' | '));
  if (!ok) console.log(r.out);
  return ok;
}

/* ---------------- Stage 2: build checks ---------------- */

function stageBuildChecks() {
  let ok = true;
  const files = [...listJsFiles(path.join(ROOT, 'app')), ...listJsFiles(path.join(ROOT, 'verify'))];
  for (const f of files) {
    const r = run(process.execPath, ['--check', f]);
    if (r.code !== 0) {
      ok = false;
      record('build', 'syntax check ' + path.relative(ROOT, f), false, r.out.trim().split('\n')[0]);
    }
  }
  record('build', `syntax check of ${files.length} JS files`, ok);

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/package.json'), 'utf8'));
  const manifestOk = manifest.main === 'server.js' && typeof manifest.scripts.start === 'string';
  record('build', 'package manifest declares start entrypoint', manifestOk);
  ok = ok && manifestOk;

  const required = ['app/server.js', 'app/public/index.html', 'Dockerfile', 'docker-compose.yml'];
  const missing = required.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  record('build', 'required artifacts present (' + required.join(', ') + ')', missing.length === 0,
    missing.length ? 'missing: ' + missing.join(', ') : undefined);
  return ok && manifestOk && missing.length === 0;
}

/* ---------------- Stage 3: HTTP smoke ---------------- */

async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(APP_URL + '/healthz');
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function extractRaw(text, key) {
  const m = text.match(new RegExp('"' + key + '"\\s*:'));
  if (!m) return null;
  let i = m.index + m[0].length;
  while (' \t\r\n'.includes(text[i])) i++;
  const start = i;
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { i++; while (text[i] !== '"') { if (text[i] === '\\') i++; i++; } }
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { if (depth === 0) break; depth--; }
    else if (c === ',' && depth === 0) break;
  }
  return text.slice(start, i);
}

async function api(method, url, body) {
  const res = await fetch(APP_URL + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* keep raw text */ }
  return { status: res.status, text, data };
}

/* ---- Leaf-aware merge scenarios (the stale-edit conflict repair) ---- */

const SCEN_EXT_RAW = '{ "x-firmware-2.0": { "attitudeTrim": [0.1, -0.2, 0.05], "mode": "SEMI" },\n'
  + '  "signatures": ["gs:7f3a", "qc:91bc"], "x-window-policy": { "earliest": "2026-10-08T00:00:00Z" } }';

const SCEN_CORE = () => JSON.parse(JSON.stringify({
  command: 'ORBIT_RAISE',
  target: 'SAT-01',
  parameters: { deltaV: 12.5, window: '2026-10-08T02:00:00Z', mode: 'SAFE' },
}));

// Terminal A: knows the whole parameters object but only changes deltaV.
function editA(rid, baseRevision, deltaV) {
  return {
    requestId: rid,
    baseRevision,
    knownFields: ['core.parameters'],
    changes: { set: { 'core.parameters': {
      deltaV, window: '2026-10-08T02:00:00Z', mode: 'SAFE',
    } }, unset: [] },
  };
}
// Terminal B: only knows the execution window.
function editB(rid, baseRevision, window) {
  return {
    requestId: rid,
    baseRevision,
    knownFields: ['core.parameters.window'],
    changes: { set: { 'core.parameters.window': window }, unset: [] },
  };
}

async function createScenarioPackage() {
  const res = await fetch(APP_URL + '/api/packages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: `{"core":${JSON.stringify(SCEN_CORE())},"extensions":${SCEN_EXT_RAW}}`,
  });
  const text = await res.text();
  return { status: res.status, data: JSON.parse(text), text };
}

async function stageLeafMergeScenarios(api, check) {
  // The web page itself must be served.
  const page = await api('GET', '/');
  check('review page is served', page.status === 200 && /<!DOCTYPE html>/i.test(page.text));

  // --- Commit order 1: parent-object terminal A first, leaf terminal B second.
  const p1 = await createScenarioPackage();
  check('scenario package created with multi-parameter core + extensions',
    p1.status === 201 && p1.data.revision === 1, 'id=' + p1.data.id);
  const a1 = await api('POST', `/api/packages/${p1.data.id}/edits`, editA('lm-a1', 1, 15.0));
  check('order-1: terminal A (whole object, only deltaV changed) applied',
    a1.status === 200 && a1.data.adjudication.result === 'applied'
      && JSON.stringify(a1.data.adjudication.changedPaths) === JSON.stringify(['core.parameters.deltaV']),
    JSON.stringify(a1.data && a1.data.adjudication));
  const b1 = await api('POST', `/api/packages/${p1.data.id}/edits`,
    editB('lm-b1', 1, '2026-10-09T04:30:00Z'));
  check('order-1: stale terminal B (window only) is merged, not path-conflicted',
    b1.status === 200 && b1.data.adjudication.result === 'merged'
      && b1.data.adjudication.revision === 3,
    `${b1.status} ${JSON.stringify(b1.data && b1.data.adjudication)}`);
  const s1 = await api('GET', `/api/packages/${p1.data.id}`);
  check('order-1: merged core keeps A deltaV and B window, mode untouched',
    s1.data.revision === 3
      && s1.data.core.parameters.deltaV === 15.0
      && s1.data.core.parameters.window === '2026-10-09T04:30:00Z'
      && s1.data.core.parameters.mode === 'SAFE');
  check('order-1: canonical summary recomputed (64-hex digest)',
    /^[0-9a-f]{64}$/.test(s1.data.summary.digest));
  check('order-1: extension raw bytes still byte-for-byte',
    extractRaw(s1.text, 'extensions') === SCEN_EXT_RAW);
  const results1 = s1.data.adjudications.map((x) => x.result);
  check('order-1: adjudication records applied then merged',
    results1.includes('applied') && results1.includes('merged') && !results1.includes('rejected'),
    results1.join(','));

  // --- Commit order 2: leaf terminal B first, parent-object terminal A second.
  const p2 = await createScenarioPackage();
  const b2 = await api('POST', `/api/packages/${p2.data.id}/edits`,
    editB('lm-b2', 1, '2026-10-09T04:30:00Z'));
  check('order-2: terminal B (window) applied', b2.status === 200);
  const a2 = await api('POST', `/api/packages/${p2.data.id}/edits`, editA('lm-a2', 1, 15.0));
  check('order-2: stale parent-object submission is merged without clobbering B window',
    a2.status === 200 && a2.data.adjudication.result === 'merged'
      && a2.data.adjudication.revision === 3,
    `${a2.status} ${JSON.stringify(a2.data && a2.data.adjudication)}`);
  const s2 = await api('GET', `/api/packages/${p2.data.id}`);
  check('order-2: core has both new deltaV and B committed window',
    s2.data.core.parameters.deltaV === 15.0
      && s2.data.core.parameters.window === '2026-10-09T04:30:00Z'
      && s2.data.core.parameters.mode === 'SAFE');

  // --- Same leaf changed to different values by two stale terminals: rejected.
  const p3 = await createScenarioPackage();
  await api('POST', `/api/packages/${p3.data.id}/edits`, editB('lm-c1', 1, '2026-10-09T04:30:00Z'));
  const c2 = await api('POST', `/api/packages/${p3.data.id}/edits`, editB('lm-c2', 1, '2026-10-10T00:00:00Z'));
  check('same leaf, different values: rejected as conflicting-paths',
    c2.status === 409 && c2.data.adjudication.reason === 'conflicting-paths'
      && c2.data.adjudication.changedPaths.includes('core.parameters.window'));
  const s3 = await api('GET', `/api/packages/${p3.data.id}`);
  check('same-leaf conflict advances no revision and keeps first value',
    s3.data.revision === 2 && s3.data.core.parameters.window === '2026-10-09T04:30:00Z');

  // --- Whole-object submission that really overlaps on a leaf: rejected.
  const p4 = await createScenarioPackage();
  await api('POST', `/api/packages/${p4.data.id}/edits`, editA('lm-d1', 1, 15.0));
  const d2 = await api('POST', `/api/packages/${p4.data.id}/edits`, editA('lm-d2', 1, 20.0));
  check('whole-object submit that really changes the same leaf is not merged',
    d2.status === 409 && d2.data.adjudication.reason === 'conflicting-paths'
      && d2.data.adjudication.changedPaths.includes('core.parameters.deltaV'),
    `${d2.status} ${JSON.stringify(d2.data && d2.data.adjudication)}`);
  const s4 = await api('GET', `/api/packages/${p4.data.id}`);
  check('whole-object conflict keeps revision 2 and first terminal value',
    s4.data.revision === 2 && s4.data.core.parameters.deltaV === 15.0
      && s4.data.core.parameters.window === '2026-10-08T02:00:00Z');
}

/* ---- Restart replay on an isolated data volume ---- */

function freePort() {
  return new Promise((resolve, reject) => {
    const net = require('node:net');
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function startServer(dir, port) {
  return spawn(process.execPath, [path.join(ROOT, 'app/server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dir },
    stdio: 'ignore',
  });
}

async function stopServer(child) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');
  try { await require('node:events').once(child, 'exit'); } catch { /* already gone */ }
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url + '/healthz');
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function stageRestartReplay(check) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'satcmd-verify-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  let child = startServer(dir, port);
  let up = await waitFor(base, 30000);
  check('restart: isolated server starts healthy', up, base);
  if (!up) { await stopServer(child); return; }

  const created = await fetch(base + '/api/packages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: `{"core":${JSON.stringify(SCEN_CORE())},"extensions":${SCEN_EXT_RAW}}`,
  }).then((r) => r.json());
  const id = created.id;
  const firstA = await fetch(base + `/api/packages/${id}/edits`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(editA('rr-a', 1, 15.0)),
  }).then((r) => r.json());
  const firstB = await fetch(base + `/api/packages/${id}/edits`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(editB('rr-b', 1, '2026-10-09T04:30:00Z')),
  }).then((r) => r.json());
  check('restart: both edits accepted before restart (applied + merged, rev 3)',
    firstA.adjudication.result === 'applied' && firstB.adjudication.result === 'merged'
      && firstB.adjudication.revision === 3,
    JSON.stringify(firstB.adjudication));

  // Restart the service against the same isolated data volume.
  await stopServer(child);
  child = startServer(dir, port);
  up = await waitFor(base, 30000);
  check('restart: service is healthy again on the same volume', up);

  const after = await fetch(base + `/api/packages/${id}`).then(async (r) => ({
    status: r.status, text: await r.text(), data: null,
  }));
  after.data = JSON.parse(after.text);
  check('restart: current revision and both terminal values survive',
    after.data.revision === 3
      && after.data.core.parameters.deltaV === 15.0
      && after.data.core.parameters.window === '2026-10-09T04:30:00Z'
      && after.data.core.parameters.mode === 'SAFE');
  check('restart: new terminal reads complete extension content',
    after.data.extensions && after.data.extensions['x-window-policy']
      && after.data.extensions['x-window-policy'].earliest === '2026-10-08T00:00:00Z');
  check('restart: extension raw bytes survive verbatim',
    extractRaw(after.text, 'extensions') === SCEN_EXT_RAW);

  // Stable request ids replay their first adjudication (revision + summary).
  const replayA = await fetch(base + `/api/packages/${id}/edits`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(editA('rr-a', 1, 15.0)),
  }).then((r) => r.json());
  check('restart: request A replays its first revision 2 and digest',
    replayA.adjudication.replayed === true
      && replayA.adjudication.revision === firstA.adjudication.revision
      && replayA.adjudication.digest === firstA.adjudication.digest
      && replayA.adjudication.result === 'applied');
  const replayB = await fetch(base + `/api/packages/${id}/edits`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(editB('rr-b', 1, '2026-10-09T04:30:00Z')),
  }).then((r) => r.json());
  check('restart: request B replays its first revision 3, merged verdict and digest',
    replayB.adjudication.replayed === true
      && replayB.adjudication.revision === 3
      && replayB.adjudication.result === 'merged'
      && replayB.adjudication.digest === firstB.adjudication.digest);
  const finalState = await fetch(base + `/api/packages/${id}`).then((r) => r.json());
  check('restart: replays do not advance the revision', finalState.revision === 3);

  await stopServer(child);
}

async function stageHttpSmoke() {
  let ok = true;
  const check = (name, cond, detail) => { record('smoke', name, !!cond, detail); ok = ok && !!cond; };

  check('health endpoint responds ok', await waitForHealth(), APP_URL + '/healthz');
  if (!ok) return false;
  const health = await api('GET', '/healthz');
  check('health payload reports status ok', health.status === 200 && health.data && health.data.status === 'ok');

  // --- Field preservation -------------------------------------------------
  const extRaw = '{ "x-firmware-2.0": { "attitudeTrim": [0.1, -0.2, 0.05] },\n  "signatures": ["gs:7f3a", "qc:91bc"] }';
  const createRes = await fetch(APP_URL + '/api/packages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: `{"core":{"command":"ORBIT_RAISE","target":"SAT-01","parameters":{"deltaV":12.5,"window":"2026-10-08T02:00:00Z"}},"extensions":${extRaw}}`,
  });
  const created = await createRes.json();
  check('create package with core + extensions', createRes.status === 201 && created.revision === 1,
    'id=' + created.id);
  const id = created.id;

  // Old terminal: knows only core.command, submits a partial edit.
  const oldEdit = await api('POST', `/api/packages/${id}/edits`, {
    requestId: 'smoke-old-1',
    baseRevision: 1,
    knownFields: ['core.command'],
    changes: { set: { 'core.command': 'ORBIT_LOWER' }, unset: [] },
  });
  check('old-terminal partial edit applied', oldEdit.status === 200 && oldEdit.data.adjudication.result === 'applied');

  const after = await api('GET', `/api/packages/${id}`);
  const servedRaw = extractRaw(after.text, 'extensions');
  check('extension subtree preserved byte-for-byte after old-terminal edit',
    servedRaw === extRaw, servedRaw === extRaw ? undefined : `got: ${servedRaw}`);
  check('core edit took effect', after.data.core.command === 'ORBIT_LOWER');
  check('canonical summary exposed', typeof after.data.summary.digest === 'string' && after.data.summary.digest.length === 64);

  // Deleting an unknown field must be rejected and rewrite nothing.
  const del = await api('POST', `/api/packages/${id}/edits`, {
    requestId: 'smoke-del-1',
    baseRevision: 2,
    knownFields: ['core.command'],
    changes: { set: {}, unset: ['core.parameters.window'] },
  });
  check('deleting an unknown field is rejected',
    del.status === 422 && del.data.adjudication.reason === 'unknown-field-delete');
  const afterDel = await api('GET', `/api/packages/${id}`);
  check('rejection rewrote no revision', afterDel.data.revision === 2
    && afterDel.data.core.parameters.window === '2026-10-08T02:00:00Z');

  // --- Conflict handling ----------------------------------------------------
  const c = await api('POST', '/api/packages', {
    core: { command: 'DEPLOY', params: { antenna: 'A', power: 10 } },
    extensions: { 'x-band-plan': { slot: 4 } },
  });
  const cid = c.data.id;
  const e1 = await api('POST', `/api/packages/${cid}/edits`, {
    requestId: 'smoke-c1', baseRevision: 1, knownFields: ['core.params.antenna'],
    changes: { set: { 'core.params.antenna': 'B' }, unset: [] },
  });
  check('first stale-branch edit applied', e1.status === 200 && e1.data.adjudication.revision === 2);

  const e2 = await api('POST', `/api/packages/${cid}/edits`, {
    requestId: 'smoke-c2', baseRevision: 1, knownFields: ['core.params.power'],
    changes: { set: { 'core.params.power': 20 }, unset: [] },
  });
  check('disjoint stale edit merges', e2.status === 200 && e2.data.adjudication.result === 'merged');

  const e3 = await api('POST', `/api/packages/${cid}/edits`, {
    requestId: 'smoke-c3', baseRevision: 1, knownFields: ['core.params.antenna'],
    changes: { set: { 'core.params.antenna': 'C' }, unset: [] },
  });
  check('overlapping stale edit with different value is rejected',
    e3.status === 409 && e3.data.adjudication.reason === 'conflicting-paths');
  const afterConflict = await api('GET', `/api/packages/${cid}`);
  check('conflict rewrote no revision', afterConflict.data.revision === 3
    && afterConflict.data.core.params.antenna === 'B'
    && afterConflict.data.core.params.power === 20);

  // --- Request-id replay ----------------------------------------------------
  const replay = await api('POST', `/api/packages/${cid}/edits`, {
    requestId: 'smoke-c1', baseRevision: 1, knownFields: ['core.params.antenna'],
    changes: { set: { 'core.params.antenna': 'B' }, unset: [] },
  });
  check('identical request replays same adjudication',
    replay.status === 200 && replay.data.adjudication.replayed === true
    && replay.data.adjudication.revision === 2);
  const replace = await api('POST', `/api/packages/${cid}/edits`, {
    requestId: 'smoke-c1', baseRevision: 1, knownFields: ['core.params.antenna'],
    changes: { set: { 'core.params.antenna': 'Z' }, unset: [] },
  });
  check('same requestId with different payload is rejected',
    replace.status === 409 && replace.data.adjudication.reason === 'request-id-payload-mismatch');

  // New terminal reads back the full extension content.
  const full = await api('GET', `/api/packages/${cid}`);
  check('new terminal reads complete extension content',
    full.data.extensions && full.data.extensions['x-band-plan'].slot === 4);

  // --- Leaf-aware stale-merge repair (both orders, conflicts, overlaps) ------
  await stageLeafMergeScenarios(api, check);

  // --- Restart replay on an isolated data volume -----------------------------
  await stageRestartReplay(check);

  return ok;
}

/* ---------------- Orchestration ---------------- */

(async () => {
  console.log('== satellite command package acceptance ==');
  console.log('target: ' + APP_URL);
  const contract = stageContractTests();
  const build = stageBuildChecks();
  const smoke = contract && build ? await stageHttpSmoke() : false;
  if (!contract || !build) console.log('skipping HTTP smoke: earlier stage failed');

  const failed = results.filter((r) => !r.ok);
  console.log('------------------------------------------');
  console.log(`checks: ${results.length}, failed: ${failed.length}`);
  for (const f of failed) console.log(`  FAILED [${f.stage}] ${f.name}`);
  const accepted = contract && build && smoke;
  console.log(accepted ? 'ACCEPTED' : 'REJECTED');
  process.exit(accepted ? 0 : 1);
})().catch((err) => {
  console.error('verifier crashed: ' + err.stack);
  process.exit(1);
});
