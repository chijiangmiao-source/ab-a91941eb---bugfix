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

function multiParamStore() {
  const dir = tmpDir();
  const store = new Store(dir);
  const body = `{"core":{"command":"ORBIT_RAISE","parameters":{"deltaV":12.5,"window":"2026-10-08T02:00:00Z","mode":"SAFE"}},"extensions":${EXT_RAW}}`;
  const raw = env.extractRawValue(body, 'extensions');
  const pkg = store.create(env.validateCreate(JSON.parse(body), raw).value);
  return { dir, store, pkg, raw };
}

// Terminal A declares it knows the whole parameters object and resubmits it
// with only deltaV changed; terminal B knows only window.
const W0 = '2026-10-08T02:00:00Z';
const W1 = '2026-10-09T03:00:00Z';
const params0 = { deltaV: 12.5, window: W0, mode: 'SAFE' };

function editA(over = {}) {
  return edit({
    requestId: 'term-A',
    knownFields: ['core.parameters'],
    set: { 'core.parameters': { deltaV: 14.0, window: W0, mode: 'SAFE' } },
    ...over,
  });
}
function editB(over = {}) {
  return edit({
    requestId: 'term-B',
    knownFields: ['core.parameters.window'],
    set: { 'core.parameters.window': W1 },
    ...over,
  });
}

test('parent-object resubmission records only the leaf it actually changed', () => {
  const { store, pkg } = multiParamStore();
  const a = store.submitEdit(pkg.id, editA());
  assert.equal(a.adjudication.result, 'applied');
  assert.deepEqual(a.adjudication.changedPaths, ['core.parameters.deltaV']);
  assert.deepEqual(store.get(pkg.id).history.find((h) => h.revision === 2).changedPaths,
    ['core.parameters.deltaV']);
});

test('stale leaf edits to different fields merge regardless of commit order', () => {
  for (const order of [['A', 'B'], ['B', 'A']]) {
    const { store, pkg } = multiParamStore();
    const first = order[0] === 'A' ? editA() : editB();
    const second = order[1] === 'A' ? editA() : editB();
    const r1 = store.submitEdit(pkg.id, first);
    const r2 = store.submitEdit(pkg.id, second);
    assert.equal(r1.adjudication.result, 'applied', 'order ' + order);
    assert.equal(r2.adjudication.result, 'merged', 'order ' + order);
    assert.equal(r2.adjudication.revision, 3, 'order ' + order);
    const p = store.get(pkg.id);
    assert.equal(p.revision, 3);
    assert.equal(p.core.parameters.deltaV, 14.0);
    assert.equal(p.core.parameters.window, W1);
    assert.equal(p.core.parameters.mode, 'SAFE'); // untouched sibling
    assert.equal(p.core.command, 'ORBIT_RAISE');
  }
});

test('two stale edits changing the same leaf with different values conflict', () => {
  const { store, pkg } = multiParamStore();
  store.submitEdit(pkg.id, editB()); // window -> W1, rev 2
  const clash = store.submitEdit(pkg.id, edit({
    requestId: 'same-leaf',
    baseRevision: 1,
    knownFields: ['core.parameters.window'],
    set: { 'core.parameters.window': '2026-10-11T00:00:00Z' },
  }));
  assert.equal(clash.adjudication.result, 'rejected');
  assert.equal(clash.adjudication.reason, 'conflicting-paths');
  assert.deepEqual(clash.adjudication.changedPaths, ['core.parameters.window']);
  assert.equal(store.get(pkg.id).revision, 2);
  assert.equal(store.get(pkg.id).core.parameters.window, W1);
});

test('whole-object submission whose changed leaf really overlaps is not merged', () => {
  const { store, pkg } = multiParamStore();
  // Revision 2 really changes deltaV.
  store.submitEdit(pkg.id, edit({
    requestId: 'dv-first',
    knownFields: ['core.parameters.deltaV'],
    set: { 'core.parameters.deltaV': 14.0 },
  }));
  // Stale whole-object resubmission based on rev 1: its real leaf change is
  // deltaV -> 99 (window/mode carried unchanged). Must conflict, not merge.
  const clash = store.submitEdit(pkg.id, edit({
    requestId: 'whole-overlap',
    baseRevision: 1,
    knownFields: ['core.parameters'],
    set: { 'core.parameters': { deltaV: 99, window: W0, mode: 'SAFE' } },
  }));
  assert.equal(clash.adjudication.result, 'rejected');
  assert.equal(clash.adjudication.reason, 'conflicting-paths');
  assert.equal(store.get(pkg.id).revision, 2);
  assert.equal(store.get(pkg.id).core.parameters.deltaV, 14.0);
});

test('merging a stale parent-object edit never clobbers committed siblings', () => {
  const { store, pkg } = multiParamStore();
  // B commits the new window first.
  store.submitEdit(pkg.id, editB({ requestId: 'term-B' }));
  // A's stale whole-object payload still contains the OLD window; merging it
  // must keep B's window and only land A's deltaV.
  const merged = store.submitEdit(pkg.id, editA({ requestId: 'term-A' }));
  assert.equal(merged.adjudication.result, 'merged');
  const p = store.get(pkg.id);
  assert.equal(p.core.parameters.deltaV, 14.0);
  assert.equal(p.core.parameters.window, W1);
  assert.deepEqual(merged.adjudication.changedPaths, ['core.parameters.deltaV']);
});

test('restart replays merged requests at their first revision and keeps extensions', () => {
  const { dir, store, pkg, raw } = multiParamStore();
  const a = store.submitEdit(pkg.id, editA());
  const b = store.submitEdit(pkg.id, editB());
  assert.equal(b.adjudication.revision, 3);

  const reopened = new Store(dir);
  const replayB = reopened.submitEdit(pkg.id, editB());
  assert.equal(replayB.adjudication.replayed, true);
  assert.equal(replayB.adjudication.revision, 3);
  assert.equal(replayB.adjudication.digest, b.adjudication.digest);
  const replayA = reopened.submitEdit(pkg.id, editA());
  assert.equal(replayA.adjudication.replayed, true);
  assert.equal(replayA.adjudication.revision, a.adjudication.revision);

  const loaded = reopened.get(pkg.id);
  assert.equal(loaded.revision, 3);
  assert.equal(loaded.extensionsRaw, raw);
  assert.equal(loaded.core.parameters.deltaV, 14.0);
  assert.equal(loaded.core.parameters.window, W1);
  // A disjoint stale edit based on rev 1 must still merge after restart.
  const later = reopened.submitEdit(pkg.id, edit({
    requestId: 'post-restart-mode',
    baseRevision: 1,
    knownFields: ['core.parameters.mode'],
    set: { 'core.parameters.mode': 'MANUAL' },
  }));
  assert.equal(later.adjudication.result, 'merged');
  assert.equal(later.adjudication.revision, 4);
  assert.equal(reopened.get(pkg.id).core.parameters.window, W1);
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
