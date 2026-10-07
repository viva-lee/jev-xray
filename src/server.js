import http from 'node:http';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildReport } from './report.js';

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/color.js': ['color.js', 'text/javascript; charset=utf-8'],
  '/treemap.js': ['treemap.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

const webFile = (name) => fileURLToPath(new URL(`../web/${name}`, import.meta.url));

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// POST endpoints spend the user's API credits, so only this page may call them:
// JSON content type (forces a CORS preflight we never answer) and a local Origin.
function isTrustedWrite(req, port) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export function startServer(engine, { port = 4242, host = '127.0.0.1' } = {}) {
  const clients = new Set();
  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  };
  for (const event of ['answer', 'lens', 'stats', 'status', 'fatal', 'fileError']) {
    engine.on(event, (data) => broadcast(event, data));
  }

  let boundPort = port;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}`);
    try {
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [name, type] = STATIC[url.pathname];
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(await fs.readFile(webFile(name)));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/snapshot') {
        sendJson(res, 200, engine.snapshot());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/report.html') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': `attachment; filename="${engine.scan.name}-xray.html"`,
        });
        res.end(await buildReport(engine.snapshot()));
        return;
      }
      if (req.method === 'POST' && (url.pathname === '/api/ask' || url.pathname === '/api/lines')) {
        if (!isTrustedWrite(req, boundPort)) {
          sendJson(res, 403, { error: 'Forbidden.' });
          return;
        }
        const body = await readJson(req);
        if (url.pathname === '/api/ask') {
          const { lens } = engine.ask({ question: body.question, type: body.type, options: body.options || [] });
          sendJson(res, 202, { lens });
        } else {
          sendJson(res, 200, await engine.findLines(Number(body.fileId), String(body.lensKey)));
        }
        return;
      }
      sendJson(res, 404, { error: 'Not found.' });
    } catch (err) {
      sendJson(res, err.fatal ? 502 : 400, { error: err.message });
    }
  });

  return new Promise((resolve, reject) => {
    const tryListen = (p, attemptsLeft) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attemptsLeft > 0) tryListen(p + 1, attemptsLeft - 1);
        else reject(err);
      });
      server.listen(p, host, () => {
        boundPort = p;
        resolve({ server, url: `http://${host === '127.0.0.1' ? 'localhost' : host}:${p}/` });
      });
    };
    tryListen(port, 20);
  });
}
