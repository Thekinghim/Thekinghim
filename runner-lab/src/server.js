import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const webDir = fileURLToPath(new URL('../web/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

/**
 * HTTP + Server-Sent Events. Utan ramverk och utan WebSocket åt klienten:
 * flödet går bara ett håll, och SSE återansluter av sig självt.
 */
export function createServer(app, cfg = config) {
  /** @type {Set<http.ServerResponse>} */
  const clients = new Set();

  /**
   * Enkel per-IP-takthållare för de endpoints som kostar RPC-anrop.
   * En publik adress betyder att vem som helst kan be om hundra uppslag i
   * sekunden, och då är det vår RPC-kvot som tar slut, inte deras.
   */
  const hits = new Map();
  function allow(ip, limit = 30, windowMs = 60_000) {
    const now = Date.now();
    const rec = hits.get(ip);
    if (!rec || now - rec.start > windowMs) {
      hits.set(ip, { start: now, n: 1 });
      return true;
    }
    rec.n++;
    return rec.n <= limit;
  }
  // Städa bort gamla poster så att kartan inte växer obegränsat.
  setInterval(() => {
    const cutoff = Date.now() - 120_000;
    for (const [ip, rec] of hits) if (rec.start < cutoff) hits.delete(ip);
  }, 60_000).unref();

  // Puls på tysta anslutningar. En kommentarrad ignoreras av EventSource men
  // håller proxyn från att stänga anslutningen.
  setInterval(() => {
    for (const res of clients) {
      try { res.write(': ping\n\n'); } catch { clients.delete(res); }
    }
  }, cfg.server.keepAliveMs).unref();

  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(frame); } catch { clients.delete(res); }
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
      ?? req.socket.remoteAddress ?? 'okänd';

    // Hostingplattformar pollar en hälsoadress för att veta om instansen lever.
    if (url.pathname === '/health') {
      const s = app.snapshot();
      return json(res, {
        ok: true,
        source: s.status.source,
        state: s.status.state,
        clients: clients.size,
        launches: s.counters.launches,
        uptimeSec: Math.round(process.uptime()),
      });
    }

    if (url.pathname === '/api/stream') {
      if (clients.size >= cfg.server.maxClients) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        return void res.end('För många anslutna just nu. Försök om en stund.');
      }
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

    if (url.pathname === '/api/detail') {
      if (!allow(ip, 120)) return json(res, { error: 'För många förfrågningar' }, 429);
      const mint = (url.searchParams.get('mint') ?? '').trim();
      const detail = await app.detail(mint);
      return json(res, detail ?? { error: 'Okänd mint i radarn' }, detail ? 200 : 404);
    }

    // Analys av en inklistrad CA. Kör de riktiga on-chain-kontrollerna.
    if (url.pathname === '/api/lookup') {
      // Uppslag kostar två RPC-anrop, så taket är hårdare här.
      if (!allow(ip, 20)) return json(res, { error: 'För många förfrågningar' }, 429);
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
