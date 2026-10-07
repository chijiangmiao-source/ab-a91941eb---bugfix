'use strict';

// Adjudication engine for partial edits submitted by maintenance terminals.
//
// Conflict detection works at LEAF granularity. A terminal may declare that it
// knows a whole parent object (e.g. "core.parameters") and resubmit that whole
// object while having changed only one leaf (e.g. deltaV); a concurrent stale
// edit that changed a different leaf (e.g. window) must still merge. This
// requires two things:
//
//  1. Every revision records the leaf paths it ACTUALLY changed, never the
//     declared parent path. A parent-object resubmission whose sibling leaves
//     carry unchanged values expands to just the changed leaf paths.
//  2. A stale edit merges only the leaf changes the terminal intended relative
//     to its base revision. The unchanged siblings carried along in a
//     parent-object submission are not written, so they can never clobber
//     values another terminal committed in the meantime.
//
// Other rules:
//  - An edit may only touch canonical core paths covered by the terminal's
//    declared knownFields; deleting (unset) an undeclared/unknown field is
//    rejected. The extension subtree is never addressable.
//  - A stale edit (baseRevision < current) conflicts only when an intended
//    leaf was also changed since its base AND resolves to a different value
//    (or one side deleted/retyped what the other changed). Same value is not a
//    conflict. Rejections never rewrite existing revisions.
//  - requestId is an idempotency key: replaying the identical payload returns
//    the recorded adjudication; reusing the id with a different payload is
//    rejected.

const {
  canonicalize,
  sha256,
  covers,
  getAt,
  setAt,
  unsetAt,
  summarize,
} = require('./envelope');

function requestHash(edit) {
  return sha256(canonicalize({
    requestId: edit.requestId,
    baseRevision: edit.baseRevision,
    knownFields: edit.knownFields,
    set: edit.set,
    unset: edit.unset,
  }));
}

/** Paths declared in the envelope, sorted and de-duplicated (may be parents). */
function declaredPaths(edit) {
  return [...new Set([...Object.keys(edit.set), ...edit.unset])].sort();
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function sameValue(a, b) {
  return canonicalize(a) === canonicalize(b);
}

/** Enumerate leaf paths under a node. Arrays and primitives are leaves. */
function scanLeaves(node, prefix, out) {
  if (isPlainObject(node)) {
    const keys = Object.keys(node);
    if (keys.length === 0) out.push(prefix); // {} is replaced as a unit
    for (const k of keys) scanLeaves(node[k], prefix + '.' + k, out);
  } else {
    out.push(prefix);
  }
}

/**
 * Leaf-level diff of two rooted documents ({ core }).
 *
 * Results land in `setMap` (leaf path -> value in `after`) and `unsetList`
 * (leaf paths removed in `after`). Replacing a subtree expands to its
 * individual leaves, so parent-object submissions never hide which leaves
 * really moved: resubmitting core.parameters with only deltaV different yields
 * a single intended leaf change regardless of the declared path.
 */
function diffLeaves(before, after, prefix, c) {
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      diffLeaves(before[k], after[k], prefix + '.' + k, c);
    }
    return;
  }
  if (sameValue(before, after)) return;

  if (after === undefined) {
    // Deleting a subtree subsumes its leaves; one unset of the prefix.
    c.unsetList.push(prefix);
    return;
  }
  if (isPlainObject(after)) {
    // Primitive -> object: the old unit value is removed and each new leaf is
    // written.
    if (before !== undefined) c.unsetList.push(prefix);
    const leaves = [];
    scanLeaves(after, prefix, leaves);
    for (const leaf of leaves) c.setMap.set(leaf, getAt(c.afterDoc, leaf));
    return;
  }
  if (isPlainObject(before)) {
    // Object -> primitive: old leaves are removed, the new unit value is set.
    const leaves = [];
    scanLeaves(before, prefix, leaves);
    for (const leaf of leaves) c.unsetList.push(leaf);
    c.setMap.set(prefix, after);
    return;
  }
  c.setMap.set(prefix, after); // primitive -> primitive, or newly added
}

function leafDiff(beforeDoc, afterDoc) {
  const c = { beforeDoc, afterDoc, setMap: new Map(), unsetList: [] };
  diffLeaves(beforeDoc.core, afterDoc.core, 'core', c);
  c.unsetList.sort();
  return c;
}

function intentPaths(intent) {
  return [...new Set([...intent.setMap.keys(), ...intent.unsetList])].sort();
}

/** True when one canonical path is the other or an ancestor of it. */
function pathRelated(a, b) {
  return a === b || a.startsWith(b + '.') || b.startsWith(a + '.');
}

/** Core document as of a given revision; null when no snapshot exists. */
function coreAtRevision(pkg, revision) {
  if (revision === pkg.revision) return pkg.core;
  const entry = pkg.history.find((h) => h.revision === revision && h.core !== undefined);
  return entry ? entry.core : null;
}

// Canonical paths carry a "core." prefix, so edits are applied to a document
// wrapper { core } and the next core is unwrapped afterwards.
function applyEdit(core, edit) {
  let doc = { core };
  for (const [p, v] of Object.entries(edit.set)) doc = setAt(doc, p, v);
  for (const p of edit.unset) doc = unsetAt(doc, p);
  return doc.core;
}

/** Apply only intended leaf changes onto a (possibly newer) core. */
function applyIntent(core, intent) {
  let doc = { core };
  // Unsets first so a subtree retype (delete prefix, write child leaves)
  // settles on the written leaves.
  for (const leaf of intent.unsetList) doc = unsetAt(doc, leaf);
  for (const [leaf, value] of intent.setMap) doc = setAt(doc, leaf, value);
  return doc.core;
}

/**
 * Adjudicate a validated edit against package state `pkg`.
 * Pure: returns { status, adjudication, commit? } without mutating pkg.
 * `commit` carries the next core/revision when the edit is accepted.
 */
function adjudicateEdit(pkg, edit, now) {
  const at = now || new Date().toISOString();
  const hash = requestHash(edit);
  const paths = declaredPaths(edit);

  const prior = pkg.adjudications.find((a) => a.requestId === edit.requestId);
  if (prior) {
    if (prior.requestHash === hash) {
      return {
        status: 200,
        adjudication: { ...prior, replayed: true },
      };
    }
    return {
      status: 409,
      adjudication: {
        requestId: edit.requestId,
        requestHash: hash,
        result: 'rejected',
        reason: 'request-id-payload-mismatch',
        detail: 'requestId was already used with a different payload',
        baseRevision: edit.baseRevision,
        revision: pkg.revision,
        changedPaths: paths,
        digest: summarize(pkg.core, pkg.extensionsRaw).digest,
        at,
      },
    };
  }

  const reject = (status, reason, detail, changedPaths) => ({
    status,
    adjudication: {
      requestId: edit.requestId,
      requestHash: hash,
      result: 'rejected',
      reason,
      detail,
      baseRevision: edit.baseRevision,
      revision: pkg.revision,
      changedPaths: changedPaths || paths,
      digest: summarize(pkg.core, pkg.extensionsRaw).digest,
      at,
    },
  });

  // Every changed path must be covered by the terminal's declared known
  // fields. Unsetting an unknown field is a deletion of unknown data.
  for (const p of paths) {
    if (!edit.knownFields.some((k) => covers(k, p))) {
      const kind = edit.unset.includes(p) ? 'unknown-field-delete' : 'unknown-field-write';
      return reject(422, kind, 'path not covered by declared knownFields: ' + p);
    }
  }

  if (edit.baseRevision > pkg.revision) {
    return reject(409, 'base-revision-in-the-future',
      `baseRevision ${edit.baseRevision} exceeds current revision ${pkg.revision}`);
  }

  const baseCore = coreAtRevision(pkg, edit.baseRevision);
  if (baseCore === null) {
    return reject(409, 'base-revision-unavailable',
      `core snapshot for baseRevision ${edit.baseRevision} is not available`);
  }

  // Intended leaf changes = diff between the base document and what the edit
  // produces when applied directly onto that base. Sibling leaves carried
  // unchanged inside a resubmitted parent object are intentionally absent.
  const intent = leafDiff({ core: baseCore }, { core: applyEdit(baseCore, edit) });
  const intendedLeaves = intentPaths(intent);

  const stale = edit.baseRevision < pkg.revision;
  const currentDoc = { core: pkg.core };

  if (stale) {
    // Leaves actually changed by revisions committed after the edit's base.
    const since = new Set();
    for (const h of pkg.history) {
      if (h.revision > edit.baseRevision) {
        for (const p of h.changedPaths) since.add(p);
      }
    }

    const conflicts = new Set();
    for (const leaf of intendedLeaves) {
      const related = [...since].filter((s) => pathRelated(leaf, s));
      if (related.length === 0) continue;
      const isPureSet = intent.setMap.has(leaf) && !intent.unsetList.includes(leaf);
      if (isPureSet) {
        for (const s of related) {
          if (s !== leaf || !sameValue(intent.setMap.get(leaf), getAt(currentDoc, leaf))) {
            conflicts.add(leaf); // different leaf value, or a subtree retype
          }
        }
      } else if (related.some((s) => getAt(currentDoc, s) !== undefined)) {
        // This edit deletes/retypes a leaf a concurrent revision still keeps.
        conflicts.add(leaf);
      }
    }
    if (conflicts.size > 0) {
      return reject(409, 'conflicting-paths',
        'leaf paths changed concurrently with different values: ' + [...conflicts].sort().join(', '),
        intendedLeaves);
    }
  }

  // Merge only intended leaves onto the current core. Unchanged siblings that
  // ride along in a parent-object submission are deliberately not rewritten.
  const nextCore = applyIntent(pkg.core, intent);
  const revision = pkg.revision + 1;
  const summary = summarize(nextCore, pkg.extensionsRaw);

  // What this revision really changed relative to its parent revision.
  const landed = leafDiff(currentDoc, { core: nextCore });
  const landedPaths = intentPaths(landed);

  return {
    status: 200,
    adjudication: {
      requestId: edit.requestId,
      requestHash: hash,
      result: stale ? 'merged' : 'applied',
      baseRevision: edit.baseRevision,
      revision,
      changedPaths: landedPaths,
      digest: summary.digest,
      at,
    },
    commit: {
      core: nextCore,
      revision,
      changedPaths: intendedLeaves,
    },
  };
}

module.exports = {
  adjudicateEdit,
  requestHash,
  declaredPaths,
  leafDiff,
  applyEdit,
};
