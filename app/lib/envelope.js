'use strict';

// Envelope primitives: canonicalization, canonical paths, raw-subtree extraction.
// The extension subtree of a command package is treated as opaque bytes: it is
// captured verbatim from the create request body and never re-serialized.

const crypto = require('node:crypto');

/** Deterministic JSON serialization: object keys sorted, no whitespace. */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Canonical paths address core fields only, e.g. "core.parameters.deltaV".
// The extension subtree is not addressable and therefore never editable.
const PATH_RE = /^core(\.[A-Za-z0-9_-]+)+$/;

function isValidPath(path) {
  return typeof path === 'string' && PATH_RE.test(path);
}

function isValidKnownField(field) {
  return field === 'core' || isValidPath(field);
}

/** True when declared known field `known` covers canonical path `path`. */
function covers(known, path) {
  return path === known || path.startsWith(known + '.');
}

function getAt(obj, path) {
  let node = obj;
  for (const seg of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[seg];
  }
  return node;
}

function setAt(obj, path, value) {
  const segs = path.split('.');
  const root = Array.isArray(obj) ? obj.slice() : { ...obj };
  let node = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const next = node[segs[i]];
    const copy = next === null || typeof next !== 'object' ? {} : Array.isArray(next) ? next.slice() : { ...next };
    node[segs[i]] = copy;
    node = copy;
  }
  node[segs[segs.length - 1]] = value;
  return root;
}

function unsetAt(obj, path) {
  const segs = path.split('.');
  const root = Array.isArray(obj) ? obj.slice() : { ...obj };
  let node = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const next = node[segs[i]];
    if (next === null || typeof next !== 'object') return root; // already absent
    const copy = Array.isArray(next) ? next.slice() : { ...next };
    node[segs[i]] = copy;
    node = copy;
  }
  delete node[segs[segs.length - 1]];
  return root;
}

/**
 * Locate the raw JSON text of a top-level property value inside a JSON object
 * body. Returns null when the key is absent at depth 1. This is how the
 * extension subtree is preserved byte-for-byte: its source bytes are stored
 * and replayed verbatim, never parsed-and-reserialized for output.
 */
function extractRawValue(bodyText, key) {
  const n = bodyText.length;
  let i = 0;
  const ws = () => { while (i < n && ' \t\r\n'.includes(bodyText[i])) i++; };
  ws();
  if (bodyText[i] !== '{') return null;
  i++;
  let depth = 1;
  while (i < n && depth === 1) {
    ws();
    if (bodyText[i] === '}') return null;
    if (bodyText[i] !== '"') return null;
    const keyStart = i;
    i++;
    while (i < n && bodyText[i] !== '"') {
      if (bodyText[i] === '\\') i++;
      i++;
    }
    i++; // closing quote
    const prop = JSON.parse(bodyText.slice(keyStart, i));
    ws();
    if (bodyText[i] !== ':') return null;
    i++;
    ws();
    const valStart = i;
    // Scan the value, tracking nesting and strings.
    let d = 0;
    let done = false;
    while (i < n && !done) {
      const c = bodyText[i];
      if (c === '"') {
        i++;
        while (i < n && bodyText[i] !== '"') {
          if (bodyText[i] === '\\') i++;
          i++;
        }
        i++;
      } else if (c === '{' || c === '[') {
        d++;
        i++;
      } else if (c === '}' || c === ']') {
        if (d === 0) {
          done = true; // terminator belongs to the enclosing object
        } else {
          d--;
          i++;
        }
      } else if (c === ',' && d === 0) {
        done = true;
      } else {
        i++;
      }
    }
    if (prop === key) {
      return bodyText.slice(valStart, i).trim();
    }
    if (bodyText[i] === ',') i++;
  }
  return null;
}

/** Canonical summary of a package state: stable digest over core + extensions. */
function summarize(core, extensionsRaw) {
  const canonical = canonicalize({ core, extensions: JSON.parse(extensionsRaw) });
  return { algorithm: 'sha256', digest: sha256(canonical), canonical };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Validate a create-package envelope. Returns {error} or {value}. */
function validateCreate(body, extensionsRaw) {
  if (!isPlainObject(body)) return { error: 'body must be a JSON object' };
  if (body.id !== undefined && (typeof body.id !== 'string' || !ID_RE.test(body.id))) {
    return { error: 'id must match ' + ID_RE };
  }
  if (!isPlainObject(body.core)) return { error: 'core must be a JSON object' };
  let raw = extensionsRaw;
  if (raw === null || raw === undefined) {
    if (body.extensions !== undefined && !isPlainObject(body.extensions)) {
      return { error: 'extensions must be a JSON object' };
    }
    raw = '{}';
  } else {
    try {
      if (!isPlainObject(JSON.parse(raw))) return { error: 'extensions must be a JSON object' };
    } catch {
      return { error: 'extensions is not valid JSON' };
    }
  }
  return { value: { id: body.id, core: body.core, extensionsRaw: raw } };
}

/** Validate an edit envelope. Returns {error} or {value}. */
function validateEdit(body) {
  if (!isPlainObject(body)) return { error: 'body must be a JSON object' };
  if (typeof body.requestId !== 'string' || body.requestId.length < 1 || body.requestId.length > 128) {
    return { error: 'requestId must be a string of 1..128 chars' };
  }
  if (!Number.isInteger(body.baseRevision) || body.baseRevision < 1) {
    return { error: 'baseRevision must be an integer >= 1' };
  }
  if (!Array.isArray(body.knownFields) || !body.knownFields.every(isValidKnownField)) {
    return { error: 'knownFields must be an array of canonical core paths' };
  }
  if (!isPlainObject(body.changes)) return { error: 'changes must be an object' };
  const set = body.changes.set === undefined ? {} : body.changes.set;
  const unset = body.changes.unset === undefined ? [] : body.changes.unset;
  if (!isPlainObject(set)) return { error: 'changes.set must be an object mapping canonical paths to values' };
  if (!Array.isArray(unset)) return { error: 'changes.unset must be an array of canonical paths' };
  for (const p of Object.keys(set)) {
    if (!isValidPath(p)) return { error: 'changes.set key is not a core path: ' + p };
    if (set[p] === undefined) return { error: 'changes.set value must not be undefined: ' + p };
  }
  for (const p of unset) {
    if (!isValidPath(p)) return { error: 'changes.unset entry is not a core path: ' + String(p) };
  }
  for (const p of unset) {
    if (Object.prototype.hasOwnProperty.call(set, p)) {
      return { error: 'path appears in both set and unset: ' + p };
    }
  }
  if (Object.keys(set).length === 0 && unset.length === 0) {
    return { error: 'changes must not be empty' };
  }
  return {
    value: {
      requestId: body.requestId,
      baseRevision: body.baseRevision,
      knownFields: body.knownFields.slice(),
      set,
      unset: unset.slice(),
    },
  };
}

module.exports = {
  canonicalize,
  sha256,
  isValidPath,
  isValidKnownField,
  covers,
  getAt,
  setAt,
  unsetAt,
  extractRawValue,
  summarize,
  validateCreate,
  validateEdit,
};
