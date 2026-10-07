'use strict';

// Adjudication engine for partial edits submitted by maintenance terminals.
//
// Rules enforced here:
//  - An edit may only touch canonical core paths covered by the terminal's
//    declared knownFields; deleting (unset) an undeclared/unknown field is
//    rejected. The extension subtree is never addressable, so it survives
//    old terminals byte-for-byte by construction.
//  - A stale edit (baseRevision < current) merges only when every path it
//    changes that was also changed since its base resolves to the same
//    outcome. Same path with different values is a conflict and is rejected.
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

/** Paths actually changed by an edit, sorted and de-duplicated. */
function changedPaths(edit) {
  return [...new Set([...Object.keys(edit.set), ...edit.unset])].sort();
}

/** Effective paths of an applied edit: where the document really differs. */
function effectivePaths(before, after, paths) {
  return paths.filter(
    (p) => canonicalize(getAt(before, p)) !== canonicalize(getAt(after, p)),
  );
}

function overlappingPaths(paths, since) {
  const overlaps = new Map();
  if (paths.length === 0 || since.size === 0) return overlaps;
  for (const path of paths) {
    const related = [];
    for (const changed of [...since].sort()) {
      if (covers(path, changed) || covers(changed, path)) related.push(changed);
    }
    if (related.length > 0) overlaps.set(path, related);
  }
  return overlaps;
}

// Canonical paths carry a "core." prefix, so edits are applied to a document
// wrapper { core } and the next core is unwrapped afterwards.
function applyEdit(core, edit) {
  let doc = { core };
  for (const [p, v] of Object.entries(edit.set)) doc = setAt(doc, p, v);
  for (const p of edit.unset) doc = unsetAt(doc, p);
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
  const paths = changedPaths(edit);

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

  const reject = (status, reason, detail) => ({
    status,
    adjudication: {
      requestId: edit.requestId,
      requestHash: hash,
      result: 'rejected',
      reason,
      detail,
      baseRevision: edit.baseRevision,
      revision: pkg.revision,
      changedPaths: paths,
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

  // Paths changed by revisions after the edit's base.
  const since = new Set();
  for (const h of pkg.history) {
    if (h.revision > edit.baseRevision) {
      for (const p of h.changedPaths) since.add(p);
    }
  }

  const stale = edit.baseRevision < pkg.revision;
  if (stale) {
    const doc = { core: pkg.core };
    const conflicts = [];
    const overlaps = overlappingPaths(paths, since);
    for (const p of paths) {
      if (!overlaps.has(p)) continue;
      const current = getAt(doc, p);
      if (Object.prototype.hasOwnProperty.call(edit.set, p)) {
        if (canonicalize(edit.set[p]) !== canonicalize(current)) {
          conflicts.push(p);
        }
      } else if (current !== undefined) {
        // Edit deletes a path a concurrent revision re-created or modified.
        conflicts.push(p);
      }
    }
    if (conflicts.length > 0) {
      return reject(409, 'conflicting-paths',
        'paths changed concurrently with different values: ' + conflicts.sort().join(', '));
    }
  }

  const nextCore = applyEdit(pkg.core, edit);
  const effective = effectivePaths({ core: pkg.core }, { core: nextCore }, paths);
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
      changedPaths: effective,
      digest: summary.digest,
      at,
    },
    commit: { core: nextCore, revision, changedPaths: effective },
  };
}

module.exports = { adjudicateEdit, requestHash, changedPaths, applyEdit };
