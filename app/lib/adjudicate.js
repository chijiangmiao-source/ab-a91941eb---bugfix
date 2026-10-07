'use strict';

// Adjudication engine for partial edits submitted by maintenance terminals.
//
// Rules enforced here:
//  - An edit may only touch canonical core paths covered by the terminal's
//    declared knownFields; deleting (unset) an undeclared/unknown field is
//    rejected. The extension subtree is never addressable, so it survives
//    old terminals byte-for-byte by construction.
//  - Conflict detection is leaf-level, not prefix-level. A terminal that knows
//    a whole parent object and resubmits it only "changes" the leaves that
//    differ from its base; a concurrent terminal that changed a sibling leaf
//    merges cleanly. Two stale edits conflict only when they actually change
//    the same leaf to different outcomes (and deleting what a concurrent
//    edit modified is a conflict too).
//  - Merging applies only the edit's effective leaves onto the current core,
//    so a parent-object submission can never overwrite siblings another
//    terminal committed in between.
//  - requestId is an idempotency key: replaying the identical payload returns
//    the recorded adjudication; reusing the id with a different payload is
//    rejected. Rejections never rewrite existing revisions.

const {
  canonicalize,
  sha256,
  covers,
  getAt,
  setAt,
  unsetAt,
  hasPath,
  diffLeaves,
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

/** Paths declared by an edit envelope, sorted and de-duplicated. */
function changedPaths(edit) {
  return [...new Set([...Object.keys(edit.set), ...edit.unset])].sort();
}

// Canonical paths carry a "core." prefix, so edits are applied to a document
// wrapper { core } and the next core is unwrapped afterwards.
function applyEdit(core, edit) {
  let doc = { core };
  for (const [p, v] of Object.entries(edit.set)) doc = setAt(doc, p, v);
  for (const p of edit.unset) doc = unsetAt(doc, p);
  return doc.core;
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Core snapshot the edit was authored against. The store keeps one snapshot
 * per revision (createdCore for rev 1, coreAfter per history entry). Returns
 * null for documents written by an older store version that lack snapshots.
 */
function baseSnapshot(pkg, revision) {
  if (revision === pkg.revision) return clone(pkg.core);
  if (revision === 1 && pkg.createdCore !== undefined) return clone(pkg.createdCore);
  const h = pkg.history.find((e) => e.revision === revision);
  if (h && h.coreAfter !== undefined) return clone(h.coreAfter);
  return null;
}

function snapshotAt(pkg, revision) {
  if (revision === 1 && pkg.createdCore !== undefined) return clone(pkg.createdCore);
  const h = pkg.history.find((e) => e.revision === revision);
  if (h && h.coreAfter !== undefined) return clone(h.coreAfter);
  return revision === pkg.revision ? clone(pkg.core) : null;
}

/** Leaves actually changed between two consecutive committed revisions. */
function revisionLeafChanges(pkg, revision) {
  const before = snapshotAt(pkg, revision - 1);
  const after = snapshotAt(pkg, revision);
  if (before === null || after === null) return null;
  return new Set(diffLeaves({ core: before }, { core: after }));
}

/**
 * Apply a set of effective leaves (taken from the merged candidate) onto the
 * current core, touching nothing else. Leaves absent from the candidate were
 * deleted by the edit; parent objects emptied by such deletions are pruned
 * only when the candidate lacks them too (so an explicitly empty object that
 * is the committed value survives).
 */
function applyLeaves(currentCore, candidateCore, leaves) {
  let doc = { core: currentCore };
  const removed = [];
  for (const leaf of leaves) {
    if (hasPath({ core: candidateCore }, leaf)) {
      doc = setAt(doc, leaf, getAt({ core: candidateCore }, leaf));
    } else {
      doc = unsetAt(doc, leaf);
      removed.push(leaf.split('.'));
    }
  }
  // Prune ancestors emptied by a deletion while the candidate lacks them.
  for (const segs of removed) {
    for (let depth = segs.length - 1; depth >= 1; depth--) {
      const ancestor = segs.slice(0, depth).join('.');
      if (hasPath({ core: candidateCore }, ancestor)) break;
      const node = getAt(doc, ancestor);
      if (node !== null && typeof node === 'object' && !Array.isArray(node)
        && Object.keys(node).length === 0) {
        doc = unsetAt(doc, ancestor);
      } else {
        break;
      }
    }
  }
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
  const declared = changedPaths(edit);

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
        changedPaths: declared,
        digest: summarize(pkg.core, pkg.extensionsRaw).digest,
        at,
      },
    };
  }

  const reject = (status, reason, detail, paths) => ({
    status,
    adjudication: {
      requestId: edit.requestId,
      requestHash: hash,
      result: 'rejected',
      reason,
      detail,
      baseRevision: edit.baseRevision,
      revision: pkg.revision,
      changedPaths: paths || declared,
      digest: summarize(pkg.core, pkg.extensionsRaw).digest,
      at,
    },
  });

  // Every declared path must be covered by the terminal's declared known
  // fields. Unsetting an unknown field is a deletion of unknown data.
  for (const p of declared) {
    if (!edit.knownFields.some((k) => covers(k, p))) {
      const kind = edit.unset.includes(p) ? 'unknown-field-delete' : 'unknown-field-write';
      return reject(422, kind, 'path not covered by declared knownFields: ' + p);
    }
  }

  if (edit.baseRevision > pkg.revision) {
    return reject(409, 'base-revision-in-the-future',
      `baseRevision ${edit.baseRevision} exceeds current revision ${pkg.revision}`);
  }

  const stale = edit.baseRevision < pkg.revision;
  const baseCore = baseSnapshot(pkg, edit.baseRevision);
  // A document persisted before leaf snapshots existed cannot be three-way
  // merged at any base (a missing rev-1 snapshot breaks every chain), so fall
  // back to the conservative prefix-overlap checks for the whole document.
  const legacy = pkg.createdCore === null || pkg.createdCore === undefined;

  // Legacy fallback: documents persisted before leaf snapshots existed cannot
  // be three-way merged, so fall back to conservative prefix-overlap checks.
  if (stale && (legacy || baseCore === null)) {
    const since = new Set();
    for (const h of pkg.history) {
      if (h.revision > edit.baseRevision) for (const p of h.changedPaths) since.add(p);
    }
    const conflicts = [];
    const doc = { core: pkg.core };
    for (const p of declared) {
      const related = [...since].some((c) => covers(p, c) || covers(c, p));
      if (!related) continue;
      if (Object.prototype.hasOwnProperty.call(edit.set, p)) {
        if (canonicalize(edit.set[p]) !== canonicalize(getAt(doc, p))) conflicts.push(p);
      } else if (getAt(doc, p) !== undefined) {
        conflicts.push(p);
      }
    }
    if (conflicts.length > 0) {
      return reject(409, 'conflicting-paths',
        'paths changed concurrently with different values: ' + conflicts.sort().join(', '));
    }
  }

  // What the world looked like to the editing terminal, and what it would
  // make the core look like: the edit applied wholesale onto ITS base.
  const viewCore = stale && baseCore !== null ? baseCore : pkg.core;
  const candidateCore = applyEdit(viewCore, edit);
  const effectiveLeaves = diffLeaves({ core: viewCore }, { core: candidateCore });

  let conflicts = [];
  if (stale && baseCore !== null) {
    // Leaves changed by revisions committed after the edit's base.
    const sinceLeaves = new Set();
    for (let rev = edit.baseRevision + 1; rev <= pkg.revision; rev++) {
      const changes = revisionLeafChanges(pkg, rev);
      if (changes === null) {
        return reject(409, 'merge-base-unavailable',
          `cannot reconstruct revision ${rev} for a three-way merge`);
      }
      for (const leaf of changes) sinceLeaves.add(leaf);
    }

    const candDoc = { core: candidateCore };
    const curDoc = { core: pkg.core };
    for (const leaf of effectiveLeaves) {
      const related = [...sinceLeaves].filter((c) => leaf === c || covers(leaf, c) || covers(c, leaf));
      if (related.length === 0) continue;
      const editRemoved = !hasPath(candDoc, leaf);
      const nowPresent = hasPath(curDoc, leaf);
      if (editRemoved) {
        // Concurrent edit modified/re-created a leaf this edit deletes.
        if (related.some((c) => c === leaf && nowPresent)) conflicts.push(leaf);
        // Structural clash (subtree replaced by a scalar, or vice versa).
        if (related.some((c) => c !== leaf)) conflicts.push(leaf);
      } else if (related.includes(leaf)) {
        if (!nowPresent || canonicalize(getAt(candDoc, leaf)) !== canonicalize(getAt(curDoc, leaf))) {
          conflicts.push(leaf);
        }
      } else {
        // Edit's effective leaf is an ancestor/descendant of a concurrently
        // changed leaf: object-vs-scalar structural clash, always a conflict.
        conflicts.push(leaf);
      }
    }
    conflicts = [...new Set(conflicts)].sort();
  }

  if (conflicts.length > 0) {
    return reject(409, 'conflicting-paths',
      'leaves changed concurrently with different values: ' + conflicts.join(', '), conflicts);
  }

  // Merge only this edit's effective leaves onto the current core. Sibling
  // fields submitted unchanged inside a parent object are never rewritten.
  const nextCore = stale && baseCore !== null
    ? applyLeaves(pkg.core, candidateCore, effectiveLeaves)
    : candidateCore;
  const revision = pkg.revision + 1;
  const summary = summarize(nextCore, pkg.extensionsRaw);

  return {
    status: 200,
    adjudication: {
      requestId: edit.requestId,
      requestHash: hash,
      result: stale ? 'merged' : 'applied',
      baseRevision: edit.baseRevision,
      revision,
      changedPaths: effectiveLeaves,
      digest: summary.digest,
      at,
    },
    commit: { core: nextCore, revision, changedPaths: effectiveLeaves },
  };
}

module.exports = { adjudicateEdit, requestHash, changedPaths, applyEdit };
