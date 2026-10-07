'use strict';

// Persistent package store. Each package is one JSON document on disk,
// written atomically (tmp + rename) after every accepted adjudication, so a
// service restart replays identical revisions, digests and request-id
// adjudications. The extension subtree is stored as its original raw bytes
// (extensionsRaw), physically separated from the editable core document.
//
// Each history entry also stores the full core snapshot of the resulting
// revision. Leaf-level stale-edit adjudication must diff an edit against the
// core as of its declared baseRevision, so the base document has to survive
// restarts. Revision 1 is represented by a snapshot entry with revision 1 so
// that edits based on revision 1 remain replayable after a restart.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { summarize } = require('./envelope');
const { adjudicateEdit } = require('./adjudicate');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.packages = new Map();
    fs.mkdirSync(dir, { recursive: true });
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      this.#migrate(pkg);
      this.packages.set(pkg.id, pkg);
    }
  }

  /**
   * Ensure every revision 1..revision has a core snapshot. Documents created
   * before snapshots existed only carry the current core; the revision-1
   * snapshot can still be seeded, which is what restart-replay requires.
   */
  #migrate(pkg) {
    if (!Array.isArray(pkg.history)) pkg.history = [];
    if (!Array.isArray(pkg.adjudications)) pkg.adjudications = [];
    const first = pkg.history.find((h) => h.revision === 1);
    if (!first) {
      pkg.history.unshift({ revision: 1, requestId: null, changedPaths: [], core: pkg.core });
    }
    for (const h of pkg.history) {
      if (h.core === undefined) h.core = null; // unknowable intermediate snapshot
    }
  }

  list() {
    return [...this.packages.values()].map((pkg) => ({
      id: pkg.id,
      revision: pkg.revision,
      digest: summarize(pkg.core, pkg.extensionsRaw).digest,
    }));
  }

  get(id) {
    return this.packages.get(id) || null;
  }

  create({ id, core, extensionsRaw }) {
    const pkgId = id || 'pkg-' + crypto.randomBytes(6).toString('hex');
    if (this.packages.has(pkgId)) {
      const err = new Error('package already exists: ' + pkgId);
      err.code = 'DUPLICATE';
      throw err;
    }
    const pkg = {
      id: pkgId,
      revision: 1,
      core,
      extensionsRaw,
      // Seed the revision-1 snapshot; edits based on revision 1 stay
      // adjudicable after a restart.
      history: [{ revision: 1, requestId: null, changedPaths: [], core }],
      adjudications: [],
      createdAt: new Date().toISOString(),
    };
    this.packages.set(pkgId, pkg);
    this.#persist(pkg);
    return pkg;
  }

  /** Adjudicate a validated edit; persist when a commit is produced. */
  submitEdit(id, edit) {
    const pkg = this.packages.get(id);
    if (!pkg) return null;
    const outcome = adjudicateEdit(pkg, edit);
    const { adjudication, commit } = outcome;
    if (commit) {
      pkg.core = commit.core;
      pkg.revision = commit.revision;
      pkg.history.push({
        revision: commit.revision,
        requestId: edit.requestId,
        changedPaths: commit.changedPaths,
        core: commit.core,
      });
    }
    if (!adjudication.replayed) {
      pkg.adjudications.push(adjudication);
    }
    if (commit || !adjudication.replayed) this.#persist(pkg);
    return outcome;
  }

  #persist(pkg) {
    const file = path.join(this.dir, pkg.id + '.json');
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(pkg));
    fs.renameSync(tmp, file);
  }
}

module.exports = { Store };
