'use strict';

// Acceptance verifier. Stages, in order:
//   1. envelope contract tests  (node --test app/tests)
//   2. build checks             (syntax check of every JS file, manifest sanity)
//   3. HTTP smoke               (health, field preservation, conflict handling)
// The process exit code is the acceptance result: 0 = accepted, 1 = rejected.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
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
