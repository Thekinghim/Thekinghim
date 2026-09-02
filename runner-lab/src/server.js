import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = fileURLToPath(new URL('../web/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

/**
 * HTTP + Server-Sent Events. Utan ramverk och utan WebSocket åt klienten:
 * flödet går bara ett håll, och SSE återansluter av sig självt.
 */
export function createServer(app) {
  /** @type {Set<http.ServerResponse>} */
  const clients = new Set();

  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(frame); } catch { clients.delete(res); }
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      clients.add(res);
      res.write(`event: snapshot\ndata: ${JSON.stringify(app.snapshot())}\n\n`);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (url.pathname === '/api/snapshot') return json(res, app.snapshot());

    // Analys av en inklistrad CA. Kör de riktiga on-chain-kontrollerna.
    if (url.pathname === '/api/lookup') {
      const mint = (url.searchParams.get('mint') ?? '').trim();
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
        return json(res, { error: 'Ogiltig Solana-adress' }, 400);
      }
      try {
        return json(res, await app.lookup(mint));
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const file = path.join(webDir, path.normalize(rel));
    if (!file.startsWith(webDir)) return void res.writeHead(403).end('Forbidden');

    fs.readFile(file, (err, buf) => {
      if (err) return void res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(buf);
    });
  });

  return { server, broadcast, clients };
}

function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
