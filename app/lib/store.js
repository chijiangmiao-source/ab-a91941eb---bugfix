'use strict';

// Persistent package store. Each package is one JSON document on disk,
// written atomically (tmp + rename) after every accepted adjudication, so a
// service restart replays identical revisions, digests and request-id
// adjudications. The extension subtree is stored as its original raw bytes
// (extensionsRaw), physically separated from the editable core document.

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
      this.packages.set(pkg.id, pkg);
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
      history: [],
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
