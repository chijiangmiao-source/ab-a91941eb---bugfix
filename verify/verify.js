'use strict';

// Acceptance verifier. Stages, in order:
//   1. envelope contract tests  (node --test app/tests)
//   2. build checks             (syntax check of every JS file, manifest sanity)
//   3. HTTP scenarios           (health/page, field preservation, leaf-level
//                                stale merges in both commit orders, same-leaf
//                                conflicts, whole-object real-overlap
//                                conflicts, request-id replay)
//   4. restart suite            (server killed and restarted on an isolated
//                                data volume: accepted request ids replay
//                                their first revision and summary, extension
//                                bytes survive, later stale edits still merge)
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

/* ---------------- HTTP helpers ---------------- */

async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || HEALTH_TIMEOUT_MS);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl + '/healthz');
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
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

async function http(baseUrl, method, url, body, raw) {
  const res = await fetch(baseUrl + url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* keep raw text */ }
  return { status: res.status, text, data };
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

/* ---------------- Stage 3: HTTP scenarios ---------------- */

// Multi-parameter command package used by the leaf-merge scenarios.
const SCEN_EXT = '{ "x-firmware-2.0": { "attitudeTrim": [0.1, -0.2, 0.05] },\n'
  + '  "signatures": ["gs:7f3a", "qc:91bc"] }';
const W0 = '2026-10-08T02:00:00Z';
const W1 = '2026-10-09T03:00:00Z';
const W2 = '2026-10-11T00:00:00Z';

function scenarioCreateBody(id) {
  return `{"id":"${id}","core":{"command":"ORBIT_RAISE","target":"SAT-01",`
    + `"parameters":{"deltaV":12.5,"window":"${W0}","mode":"SAFE"}},`
    + `"extensions":${SCEN_EXT}}`;
}

// Terminal A: declares it knows the WHOLE parameters object, resubmits it
// with only deltaV changed.
function editTermA(requestId, base) {
  return {
    requestId,
    baseRevision: base,
    knownFields: ['core.parameters'],
    changes: { set: { 'core.parameters': { deltaV: 14.0, window: W0, mode: 'SAFE' } }, unset: [] },
  };
}
// Terminal B: declares it knows only the execution window leaf.
function editTermB(requestId, base, window) {
  return {
    requestId,
    baseRevision: base,
    knownFields: ['core.parameters.window'],
    changes: { set: { 'core.parameters.window': window || W1 }, unset: [] },
  };
}

// Unique per process so re-running the verifier against a persistent volume
// never collides with package ids from an earlier run.
const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

async function stageHttpScenarios() {
  let ok = true;
  const check = (stage, name, cond, detail) => {
    record(stage, name, !!cond, detail); ok = ok && !!cond;
  };

  check('http', 'health endpoint responds ok', await waitForHealth(APP_URL), APP_URL + '/healthz');
  if (!ok) return false;
  const health = await http(APP_URL, 'GET', '/healthz');
  check('http', 'health payload reports status ok',
    health.status === 200 && health.data && health.data.status === 'ok');

  // The review page must be served.
  const pageRes = await fetch(APP_URL + '/');
  const pageText = await pageRes.text();
  check('http', 'review page is served',
    pageRes.status === 200 && pageRes.headers.get('content-type').includes('text/html')
    && pageText.includes('星载指令包'));

  // --- Legacy field-preservation scenario ----------------------------------
  const extRaw = '{ "x-firmware-2.0": { "attitudeTrim": [0.1, -0.2, 0.05] },\n  "signatures": ["gs:7f3a", "qc:91bc"] }';
  const createRes = await fetch(APP_URL + '/api/packages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: `{"id":"smoke-legacy-${RUN}","core":{"command":"ORBIT_RAISE","target":"SAT-01","parameters":{"deltaV":12.5,"window":"${W0}"}},"extensions":${extRaw}}`,
  });
  const created = await createRes.json();
  check('http', 'create package with core + extensions', createRes.status === 201 && created.revision === 1,
    'id=' + created.id);

  const oldEdit = await http(APP_URL, 'POST', `/api/packages/${created.id}/edits`, {
    requestId: 'smoke-old-1',
    baseRevision: 1,
    knownFields: ['core.command'],
    changes: { set: { 'core.command': 'ORBIT_LOWER' }, unset: [] },
  });
  check('http', 'old-terminal partial edit applied',
    oldEdit.status === 200 && oldEdit.data.adjudication.result === 'applied');

  const after = await http(APP_URL, 'GET', `/api/packages/${created.id}`);
  const servedRaw = extractRaw(after.text, 'extensions');
  check('http', 'extension subtree preserved byte-for-byte after old-terminal edit',
    servedRaw === extRaw, servedRaw === extRaw ? undefined : `got: ${servedRaw}`);
  check('http', 'core edit took effect', after.data.core.command === 'ORBIT_LOWER');
  check('http', 'canonical summary exposed',
    typeof after.data.summary.digest === 'string' && after.data.summary.digest.length === 64);

  const del = await http(APP_URL, 'POST', `/api/packages/${created.id}/edits`, {
    requestId: 'smoke-del-1',
    baseRevision: 2,
    knownFields: ['core.command'],
    changes: { set: {}, unset: ['core.parameters.window'] },
  });
  check('http', 'deleting an unknown field is rejected',
    del.status === 422 && del.data.adjudication.reason === 'unknown-field-delete');
  const afterDel = await http(APP_URL, 'GET', `/api/packages/${created.id}`);
  check('http', 'rejection rewrote no revision', afterDel.data.revision === 2
    && afterDel.data.core.parameters.window === W0);

  // --- Leaf-level stale merge, order 1: A first, then B --------------------
  const o1 = await http(APP_URL, 'POST', '/api/packages', scenarioCreateBody('scenario-ab-' + RUN), true);
  check('leaf-merge', 'create multi-parameter package (A then B)', o1.status === 201 && o1.data.revision === 1);
  const id1 = o1.data.id;

  const a1 = await http(APP_URL, 'POST', `/api/packages/${id1}/edits`, editTermA('term-A', 1));
  check('leaf-merge', 'A: whole-object submission with only deltaV changed is applied at rev 2',
    a1.status === 200 && a1.data.adjudication.result === 'applied'
    && a1.data.adjudication.revision === 2
    && JSON.stringify(a1.data.adjudication.changedPaths) === JSON.stringify(['core.parameters.deltaV']),
    JSON.stringify(a1.data && a1.data.adjudication));

  const b1 = await http(APP_URL, 'POST', `/api/packages/${id1}/edits`, editTermB('term-B', 1));
  check('leaf-merge', 'B: stale window-only edit is MERGED (not a path conflict) at rev 3',
    b1.status === 200 && b1.data.adjudication.result === 'merged'
    && b1.data.adjudication.revision === 3
    && JSON.stringify(b1.data.adjudication.changedPaths) === JSON.stringify(['core.parameters.window']),
    b1.text);

  const s1 = await http(APP_URL, 'GET', `/api/packages/${id1}`);
  check('leaf-merge', 'merged state keeps A deltaV and B window, mode/command untouched',
    s1.data.core.parameters.deltaV === 14.0
    && s1.data.core.parameters.window === W1
    && s1.data.core.parameters.mode === 'SAFE'
    && s1.data.core.command === 'ORBIT_RAISE'
    && s1.data.revision === 3);
  check('leaf-merge', 'extension bytes survive the merge byte-for-byte',
    extractRaw(s1.text, 'extensions') === SCEN_EXT);
  const digest3 = s1.data.summary.digest;
  check('leaf-merge', 'canonical summary reflects both merged changes',
    digest3.length === 64
    && s1.data.summary.canonical.includes('"deltaV":14')
    && s1.data.summary.canonical.includes(`"window":"${W1}"`));
  const results1 = s1.data.adjudications.map((a) => a.result + '@' + a.revision).join(',');
  check('leaf-merge', 'adjudication record shows applied@2 then merged@3',
    results1 === 'applied@2,merged@3', results1);

  // Same leaf, different value, stale base 1: must be rejected, rev unchanged.
  const clash = await http(APP_URL, 'POST', `/api/packages/${id1}/edits`,
    editTermB('term-B-clash', 1, W2));
  check('leaf-merge', 'stale edit of the SAME leaf with a different value is rejected',
    clash.status === 409 && clash.data.adjudication.reason === 'conflicting-paths'
    && clash.data.adjudication.changedPaths.includes('core.parameters.window'));
  const s1b = await http(APP_URL, 'GET', `/api/packages/${id1}`);
  check('leaf-merge', 'same-leaf conflict does not advance the revision or change values',
    s1b.data.revision === 3 && s1b.data.core.parameters.window === W1
    && s1b.data.core.parameters.deltaV === 14.0);

  // Whole-object stale submission that REALLY changes deltaV must conflict.
  const wholeClash = await http(APP_URL, 'POST', `/api/packages/${id1}/edits`, {
    requestId: 'whole-overlap',
    baseRevision: 1,
    knownFields: ['core.parameters'],
    changes: { set: { 'core.parameters': { deltaV: 99, window: W0, mode: 'SAFE' } }, unset: [] },
  });
  check('leaf-merge', 'stale whole-object submission whose real leaf change overlaps is rejected',
    wholeClash.status === 409 && wholeClash.data.adjudication.reason === 'conflicting-paths'
    && wholeClash.data.adjudication.changedPaths.includes('core.parameters.deltaV'),
    wholeClash.text);
  const s1c = await http(APP_URL, 'GET', `/api/packages/${id1}`);
  check('leaf-merge', 'whole-object conflict does not clobber committed siblings',
    s1c.data.revision === 3 && s1c.data.core.parameters.deltaV === 14.0
    && s1c.data.core.parameters.window === W1);

  // Request-id replay returns the first adjudication.
  const replayB = await http(APP_URL, 'POST', `/api/packages/${id1}/edits`, editTermB('term-B', 1));
  check('leaf-merge', 'accepted request id replays its first revision and summary',
    replayB.status === 200 && replayB.data.adjudication.replayed === true
    && replayB.data.adjudication.revision === 3
    && replayB.data.adjudication.digest === b1.data.adjudication.digest);
  const replayA = await http(APP_URL, 'POST', `/api/packages/${id1}/edits`, editTermA('term-A', 1));
  check('leaf-merge', 'terminal A request id also replays at rev 2',
    replayA.data.adjudication.replayed === true
    && replayA.data.adjudication.revision === 2
    && replayA.data.adjudication.result === 'applied');

  // A new terminal reads the full extension content.
  const fresh = await http(APP_URL, 'GET', `/api/packages/${id1}`);
  check('leaf-merge', 'a new terminal reads the complete extension content',
    fresh.data.extensions && Array.isArray(fresh.data.extensions.signatures)
    && fresh.data.extensions['x-firmware-2.0'].attitudeTrim[0] === 0.1);

  // --- Leaf-level stale merge, order 2: B first, then A --------------------
  const o2 = await http(APP_URL, 'POST', '/api/packages', scenarioCreateBody('scenario-ba-' + RUN), true);
  check('order-2', 'create multi-parameter package (B then A)', o2.status === 201);
  const id2 = o2.data.id;
  const b2 = await http(APP_URL, 'POST', `/api/packages/${id2}/edits`, editTermB('term-B2', 1));
  check('order-2', 'B first: window edit applied at rev 2',
    b2.status === 200 && b2.data.adjudication.result === 'applied'
    && b2.data.adjudication.revision === 2);
  const a2 = await http(APP_URL, 'POST', `/api/packages/${id2}/edits`, editTermA('term-A2', 1));
  check('order-2', 'A second: stale whole-object edit merges at rev 3 without reverting B window',
    a2.status === 200 && a2.data.adjudication.result === 'merged'
    && a2.data.adjudication.revision === 3
    && JSON.stringify(a2.data.adjudication.changedPaths) === JSON.stringify(['core.parameters.deltaV']),
    a2.text);
  const s2 = await http(APP_URL, 'GET', `/api/packages/${id2}`);
  check('order-2', 'both commit orders converge to A deltaV + B window',
    s2.data.revision === 3
    && s2.data.core.parameters.deltaV === 14.0
    && s2.data.core.parameters.window === W1
    && s2.data.core.parameters.mode === 'SAFE');
  check('order-2', 'extension bytes preserved in order 2',
    extractRaw(s2.text, 'extensions') === SCEN_EXT);

  // Same-leaf clash in order 2 as well.
  const clash2 = await http(APP_URL, 'POST', `/api/packages/${id2}/edits`,
    editTermB('term-B2-clash', 1, W2));
  check('order-2', 'same-leaf different-value stale edit rejected in order 2',
    clash2.status === 409 && clash2.data.adjudication.reason === 'conflicting-paths'
    && (await http(APP_URL, 'GET', `/api/packages/${id2}`)).data.revision === 3);

  return ok;
}

/* ---------------- Stage 4: restart on an isolated data volume ---------------- */

function startServer(port, dataDir) {
  const child = spawn(process.execPath, [path.join(ROOT, 'app/server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write('[isolated] ' + d));
  return child;
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
    child.on('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

async function stageRestartSuite() {
  let ok = true;
  const check = (name, cond, detail) => {
    record('restart', name, !!cond, detail); ok = ok && !!cond;
  };

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satcmd-iso-'));
  const port = 8091;
  const base = `http://127.0.0.1:${port}`;
  let digestA;
  let digestB;

  let child = startServer(port, dataDir);
  try {
    check('isolated server reaches healthy state', await waitForHealth(base, 30000), dataDir);

    const created = await http(base, 'POST', '/api/packages',
      scenarioCreateBody('restart-pkg'), true);
    check('package created on isolated volume', created.status === 201 && created.data.revision === 1);
    const id = created.data.id;

    const a = await http(base, 'POST', `/api/packages/${id}/edits`, editTermA('rt-A', 1));
    const b = await http(base, 'POST', `/api/packages/${id}/edits`, editTermB('rt-B', 1));
    check('A applied then B merged before restart',
      a.data.adjudication.result === 'applied' && a.data.adjudication.revision === 2
      && b.data.adjudication.result === 'merged' && b.data.adjudication.revision === 3);
    digestA = a.data.adjudication.digest;
    digestB = b.data.adjudication.digest;

    const before = await http(base, 'GET', `/api/packages/${id}`);
    check('pre-restart state has merged values and raw extension bytes',
      before.data.revision === 3
      && before.data.core.parameters.deltaV === 14.0
      && before.data.core.parameters.window === W1
      && extractRaw(before.text, 'extensions') === SCEN_EXT);
  } finally {
    await stopServer(child);
  }

  // Real restart: a brand-new process over the same isolated data volume.
  child = startServer(port, dataDir);
  try {
    check('restarted server reaches healthy state', await waitForHealth(base, 30000));

    const replayA = await http(base, 'POST', `/api/packages/restart-pkg/edits`, editTermA('rt-A', 1));
    check('after restart, request id rt-A replays its FIRST revision and summary',
      replayA.status === 200 && replayA.data.adjudication.replayed === true
      && replayA.data.adjudication.revision === 2
      && replayA.data.adjudication.result === 'applied'
      && replayA.data.adjudication.digest === digestA,
      replayA.text);
    const replayB = await http(base, 'POST', `/api/packages/restart-pkg/edits`, editTermB('rt-B', 1));
    check('after restart, request id rt-B replays its FIRST revision and summary',
      replayB.status === 200 && replayB.data.adjudication.replayed === true
      && replayB.data.adjudication.revision === 3
      && replayB.data.adjudication.result === 'merged'
      && replayB.data.adjudication.digest === digestB);

    const after = await http(base, 'GET', '/api/packages/restart-pkg');
    check('after restart, revision/values are intact',
      after.status === 200 && after.data.revision === 3
      && after.data.core.parameters.deltaV === 14.0
      && after.data.core.parameters.window === W1
      && after.data.core.parameters.mode === 'SAFE');
    check('after restart, a new terminal still reads the full extension content byte-for-byte',
      extractRaw(after.text, 'extensions') === SCEN_EXT
      && after.data.extensions.signatures.join(',') === 'gs:7f3a,qc:91bc');
    check('after restart, canonical summary is unchanged',
      after.data.summary.digest === digestB);
    check('after restart, adjudication history is intact',
      after.data.adjudications.map((x) => x.result + '@' + x.revision).join(',')
      === 'applied@2,merged@3');

    // A fresh terminal's stale edit (base rev 1) must still merge after the
    // restart, and must not revert either committed change.
    const modeEdit = await http(base, 'POST', '/api/packages/restart-pkg/edits', {
      requestId: 'rt-mode',
      baseRevision: 1,
      knownFields: ['core.parameters.mode'],
      changes: { set: { 'core.parameters.mode': 'MANUAL' }, unset: [] },
    });
    check('after restart, disjoint stale edit still merges at rev 4',
      modeEdit.status === 200 && modeEdit.data.adjudication.result === 'merged'
      && modeEdit.data.adjudication.revision === 4);
    const finalState = await http(base, 'GET', '/api/packages/restart-pkg');
    check('post-restart merge keeps all previously committed leaves',
      finalState.data.core.parameters.deltaV === 14.0
      && finalState.data.core.parameters.window === W1
      && finalState.data.core.parameters.mode === 'MANUAL'
      && extractRaw(finalState.text, 'extensions') === SCEN_EXT);
  } finally {
    await stopServer(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return ok;
}

/* ---------------- Orchestration ---------------- */

(async () => {
  console.log('== satellite command package acceptance ==');
  console.log('target: ' + APP_URL);
  const contract = stageContractTests();
  const build = stageBuildChecks();
  const httpOk = contract && build ? await stageHttpScenarios() : false;
  if (!contract || !build) console.log('skipping HTTP scenarios: earlier stage failed');
  const restartOk = contract && build && httpOk ? await stageRestartSuite() : false;

  const failed = results.filter((r) => !r.ok);
  console.log('------------------------------------------');
  console.log(`checks: ${results.length}, failed: ${failed.length}`);
  for (const f of failed) console.log(`  FAILED [${f.stage}] ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
  const accepted = contract && build && httpOk && restartOk;
  console.log(accepted ? 'ACCEPTED' : 'REJECTED');
  process.exit(accepted ? 0 : 1);
})().catch((err) => {
  console.error('verifier crashed: ' + err.stack);
  process.exit(1);
});
