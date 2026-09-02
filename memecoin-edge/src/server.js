import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = fileURLToPath(new URL('../web/', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * HTTP + Server-Sent Events. Medvetet utan ramverk och utan WebSocket:
 * flödet går bara åt ett håll (server → webbläsare), och SSE återansluter
 * av sig självt när nätet glappar. En WebSocket hade krävt egen
 * reconnect-logik för exakt ingen vinst här.
 */
export function createServer(pipeline, cfg) {
  /** @type {Set<http.ServerResponse>} */
  const clients = new Set();

  const send = (res, event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const broadcast = (event, data) => {
    for (const res of clients) {
      try {
        send(res, event, data);
      } catch {
        clients.delete(res);
      }
    }
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      clients.add(res);
      send(res, 'snapshot', { candidates: pipeline.candidates(), stats: pipeline.stats(), config: publicConfig(cfg) });
      req.on('close', () => clients.delete(res));
      return;
    }

    if (url.pathname === '/api/candidates') return json(res, pipeline.candidates());
    if (url.pathname === '/api/stats') return json(res, pipeline.stats());
    if (url.pathname === '/api/positions') return json(res, pipeline.ledger.recent(40));
    if (url.pathname === '/api/config') return json(res, publicConfig(cfg));

    // Statisk servering. Normaliserar bort ".." så att sökvägen inte kan
    // ta sig ur web/-katalogen.
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const filePath = path.join(webDir, path.normalize(rel));
    if (!filePath.startsWith(webDir)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(filePath, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
      res.end(buf);
    });
  });

  return { server, broadcast, clients };
}

function json(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** Bara de trösklar gränssnittet behöver visa. */
function publicConfig(cfg) {
  return {
    source: cfg.source,
    maxRisk: cfg.risk.maxScore,
    minMomentum: cfg.momentum.minScore,
    maxAgeMinutes: cfg.alert.maxAgeMinutes,
    horizonLabels: cfg.paper.horizonLabels,
    roundTripCostPct: cfg.paper.roundTripCostPct,
  };
}
