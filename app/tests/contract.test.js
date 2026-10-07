'use strict';

// Envelope contract tests: canonicalization, raw-subtree preservation,
// adjudication rules, and persistence/replay across restarts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const env = require('../lib/envelope');
const { Store } = require('../lib/store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'satcmd-'));
}

const EXT_RAW = '{ "x-firmware-2.0": { "attitudeTrim": [0.1, -0.2, 0.05] },\n  "signatures": ["gs:7f3a", "qc:91bc"] }';

function makeStore() {
  const dir = tmpDir();
  const store = new Store(dir);
  const body = `{"core":{"command":"ORBIT_RAISE","target":"SAT-01","parameters":{"deltaV":12.5,"window":"2026-10-08T02:00:00Z"}},"extensions":${EXT_RAW}}`;
  const raw = env.extractRawValue(body, 'extensions');
  const check = env.validateCreate(JSON.parse(body), raw);
  assert.equal(check.error, undefined);
  const pkg = store.create(check.value);
  return { dir, store, pkg, raw };
}

function edit(over) {
  const base = {
    requestId: 'req-1',
    baseRevision: 1,
    knownFields: ['core.command', 'core.parameters.deltaV', 'core.parameters.window'],
    set: { 'core.command': 'ORBIT_LOWER' },
    unset: [],
  };
  const merged = { ...base, ...over };
  const check = env.validateEdit({
    requestId: merged.requestId,
    baseRevision: merged.baseRevision,
    knownFields: merged.knownFields,
    changes: { set: merged.set, unset: merged.unset },
  });
  assert.equal(check.error, undefined, check.error);
  return check.value;
}

test('canonicalization is key-order independent and stable', () => {
  const a = env.canonicalize({ b: 1, a: { d: [3, 2], c: 'x' } });
  const b = env.canonicalize({ a: { c: 'x', d: [3, 2] }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":"x","d":[3,2]},"b":1}');
});

test('extractRawValue returns the extension subtree byte-for-byte', () => {
  const body = `{"core":{"a":1},"extensions":${EXT_RAW} ,"other":"x}"}`;
  assert.equal(env.extractRawValue(body, 'extensions'), EXT_RAW);
  assert.equal(env.extractRawValue('{"core":{}}', 'extensions'), null);
});

test('canonical summary is deterministic regardless of raw extension formatting', () => {
  const core = { command: 'X' };
  const s1 = env.summarize(core, EXT_RAW);
  const s2 = env.summarize(core, '{"signatures":["gs:7f3a","qc:91bc"],"x-firmware-2.0":{"attitudeTrim":[0.1,-0.2,0.05]}}');
  assert.equal(s1.digest, s2.digest);
  assert.equal(s1.algorithm, 'sha256');
});

test('old-terminal edit preserves the unknown extension subtree byte-for-byte', () => {
  const { store, pkg, raw } = makeStore();
  const out = store.submitEdit(pkg.id, edit({}));
  assert.equal(out.adjudication.result, 'applied');
  assert.equal(out.adjudication.revision, 2);
  assert.equal(store.get(pkg.id).extensionsRaw, raw);
  assert.equal(store.get(pkg.id).core.command, 'ORBIT_LOWER');
  assert.equal(store.get(pkg.id).core.target, 'SAT-01');
});

test('stale edits merge only when changed canonical paths do not overlap', () => {
  const { store, pkg } = makeStore();
  const a = store.submitEdit(pkg.id, edit({ requestId: 'a', set: { 'core.command': 'ORBIT_LOWER' } }));
  assert.equal(a.adjudication.result, 'applied');

  // Disjoint path from the same base: merges.
  const b = store.submitEdit(pkg.id, edit({
    requestId: 'b',
    baseRevision: 1,
    set: { 'core.parameters.deltaV': 9.5 },
  }));
  assert.equal(b.adjudication.result, 'merged');
  assert.equal(b.adjudication.revision, 3);
  assert.equal(store.get(pkg.id).core.command, 'ORBIT_LOWER');
  assert.equal(store.get(pkg.id).core.parameters.deltaV, 9.5);

  // Overlapping path with a different value: rejected, revision untouched.
  const c = store.submitEdit(pkg.id, edit({
    requestId: 'c',
    baseRevision: 1,
    set: { 'core.command': 'SAFE_MODE' },
  }));
  assert.equal(c.adjudication.result, 'rejected');
  assert.equal(c.adjudication.reason, 'conflicting-paths');
  assert.equal(store.get(pkg.id).revision, 3);
  assert.equal(store.get(pkg.id).core.command, 'ORBIT_LOWER');

  // Overlapping path with the same value: not a conflict.
  const d = store.submitEdit(pkg.id, edit({
    requestId: 'd',
    baseRevision: 1,
    set: { 'core.command': 'ORBIT_LOWER' },
  }));
  assert.equal(d.adjudication.result, 'merged');
});

test('deleting an unknown field is rejected and rewrites nothing', () => {
  const { store, pkg } = makeStore();
  const out = store.submitEdit(pkg.id, edit({
    requestId: 'del-1',
    set: {},
    unset: ['core.parameters.window'], // not covered by knownFields below
    knownFields: ['core.command'],
  }));
  assert.equal(out.adjudication.result, 'rejected');
  assert.equal(out.adjudication.reason, 'unknown-field-delete');
  assert.equal(store.get(pkg.id).revision, 1);
  assert.equal(store.get(pkg.id).core.parameters.window, '2026-10-08T02:00:00Z');
});

test('writing a field outside declared knownFields is rejected', () => {
  const { store, pkg } = makeStore();
  const out = store.submitEdit(pkg.id, edit({
    requestId: 'w-1',
    knownFields: ['core.command'],
    set: { 'core.parameters.deltaV': 1 },
  }));
  assert.equal(out.adjudication.result, 'rejected');
  assert.equal(out.adjudication.reason, 'unknown-field-write');
  assert.equal(store.get(pkg.id).revision, 1);
});

test('edits can never address the extension subtree', () => {
  const check = env.validateEdit({
    requestId: 'x', baseRevision: 1, knownFields: ['extensions'],
    changes: { set: { 'extensions.signatures': [] }, unset: [] },
  });
  assert.match(check.error, /knownFields|path/);
  const check2 = env.validateEdit({
    requestId: 'x', baseRevision: 1, knownFields: ['core.command'],
    changes: { set: { 'extensions.signatures': [] }, unset: [] },
  });
  assert.match(check2.error, /core path/);
});

test('same requestId with identical payload replays; different payload is rejected', () => {
  const { store, pkg } = makeStore();
  const first = store.submitEdit(pkg.id, edit({ requestId: 'dup' }));
  assert.equal(first.adjudication.result, 'applied');
  assert.equal(first.adjudication.revision, 2);

  const replay = store.submitEdit(pkg.id, edit({ requestId: 'dup' }));
  assert.equal(replay.adjudication.replayed, true);
  assert.equal(replay.adjudication.revision, 2);
  assert.equal(store.get(pkg.id).revision, 2);

  const replaced = store.submitEdit(pkg.id, edit({
    requestId: 'dup',
    set: { 'core.command': 'SAFE_MODE' },
  }));
  assert.equal(replaced.adjudication.result, 'rejected');
  assert.equal(replaced.adjudication.reason, 'request-id-payload-mismatch');
  assert.equal(store.get(pkg.id).revision, 2);
  assert.equal(store.get(pkg.id).core.command, 'ORBIT_LOWER');
});

test('restart reloads state: same request replays same revision and digest, extensions intact', () => {
  const { dir, store, pkg, raw } = makeStore();
  const applied = store.submitEdit(pkg.id, edit({ requestId: 'persist-1' }));
  const digestBefore = env.summarize(store.get(pkg.id).core, raw).digest;

  // Simulate service restart: a fresh Store over the same data dir.
  const reopened = new Store(dir);
  const loaded = reopened.get(pkg.id);
  assert.equal(loaded.revision, 2);
  assert.equal(loaded.extensionsRaw, raw);
  assert.equal(env.summarize(loaded.core, loaded.extensionsRaw).digest, digestBefore);

  const replay = reopened.submitEdit(pkg.id, edit({ requestId: 'persist-1' }));
  assert.equal(replay.adjudication.replayed, true);
  assert.equal(replay.adjudication.revision, applied.adjudication.revision);
  assert.equal(replay.adjudication.digest, applied.adjudication.digest);
});

test('create envelope validation rejects malformed bodies', () => {
  assert.match(env.validateCreate(null, null).error, /object/);
  assert.match(env.validateCreate({ core: [] }, null).error, /core/);
  assert.match(env.validateCreate({ core: {}, extensions: 5 }, null).error, /extensions/);
  assert.match(env.validateCreate({ core: {} }, '{bad json').error, /JSON/);
  assert.equal(env.validateCreate({ core: {} }, null).error, undefined);
});

test('edit envelope validation rejects malformed edits', () => {
  const bad = (mut) => env.validateEdit({
    requestId: 'r', baseRevision: 1, knownFields: ['core.command'],
    changes: { set: { 'core.command': 'X' }, unset: [] }, ...mut,
  });
  assert.match(bad({ requestId: '' }).error, /requestId/);
  assert.match(bad({ baseRevision: 0 }).error, /baseRevision/);
  assert.match(bad({ knownFields: ['nope'] }).error, /knownFields/);
  assert.match(bad({ changes: { set: {}, unset: [] } }).error, /empty/);
  assert.match(bad({ changes: { set: { 'core.a': 1 }, unset: ['core.a'] } }).error, /both/);
});
