'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { Store } = require('./lib/store');
const { summarize, extractRawValue, validateCreate, validateEdit } = require('./lib/envelope');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1024 * 1024;

const store = new Store(DATA_DIR);
const startedAt = Date.now();

function send(res, status, text, contentType) {
  res.writeHead(status, {
    'content-type': contentType || 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj));
}

/** Package detail with the extension subtree spliced in as its raw bytes. */
function packageDetail(pkg) {
  const head = {
    id: pkg.id,
    revision: pkg.revision,
    summary: summarize(pkg.core, pkg.extensionsRaw),
    core: pkg.core,
    extensionsPreserved: true,
    adjudications: pkg.adjudications,
  };
  const json = JSON.stringify(head);
  return json.slice(0, -1) + ',"extensions":' + pkg.extensionsRaw + '}';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return sendJson(res, 200, {
        status: 'ok',
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        packages: store.list().length,
      });
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && url.pathname === '/api/packages') {
      return sendJson(res, 200, { packages: store.list() });
    }

    if (req.method === 'POST' && url.pathname === '/api/packages') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return sendJson(res, 400, { error: 'invalid JSON body' });
      }
      const check = validateCreate(body, extractRawValue(raw, 'extensions'));
      if (check.error) return sendJson(res, 422, { error: check.error });
      let pkg;
      try {
        pkg = store.create(check.value);
      } catch (e) {
        if (e.code === 'DUPLICATE') return sendJson(res, 409, { error: e.message });
        throw e;
      }
      return send(res, 201, packageDetail(pkg));
    }

    if (route[0] === 'api' && route[1] === 'packages' && route[2]) {
      const pkg = store.get(route[2]);
      if (!pkg) return sendJson(res, 404, { error: 'unknown package: ' + route[2] });

      if (req.method === 'GET' && route.length === 3) {
        return send(res, 200, packageDetail(pkg));
      }

      if (req.method === 'POST' && route.length === 4 && route[3] === 'edits') {
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return sendJson(res, 400, { error: 'invalid JSON body' });
        }
        const check = validateEdit(body);
        if (check.error) return sendJson(res, 422, { error: check.error });
        const outcome = store.submitEdit(pkg.id, check.value);
        return sendJson(res, outcome.status, {
          adjudication: outcome.adjudication,
          revision: store.get(pkg.id).revision,
          summary: summarize(pkg.core, pkg.extensionsRaw),
        });
      }
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendJson(res, 500, { error: 'internal error: ' + err.message });
  }
});

server.listen(PORT, () => {
  console.log(`satellite command package service listening on :${PORT}, data dir ${DATA_DIR}`);
});
