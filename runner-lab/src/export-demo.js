/**
 * Exporterar en delbar ögonblicksbild av terminalen.
 *
 * Varför den finns: en publicerad sida kan inte öppna WebSockets mot
 * pump.fun, så en demo måste vara en ögonblicksbild. Men den ska vara *din*
 * ögonblicksbild, tagen på din maskin, med mynt som listades för minuter
 * sedan — inte gammal data från någon annan.
 *
 * Kör medan `npm start` är igång:
 *   npm run export-demo
 *
 * Resultatet är en enda självbärande HTML-fil utan externa anrop.
 *
 * Flaggor:
 *   --max-age-min=N   ta bara med mynt yngre än N minuter (standard 180)
 *   --out=fil.html    var filen skrivs (standard demo.html)
 *   --port=N          porten där terminalen körs (standard config.server.port)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const maxAgeMin = Number(arg('max-age-min', 180));
const out = arg('out', 'demo.html');
const port = Number(arg('port', config.server.port));
const base = `http://${config.server.host}:${port}`;

const webDir = fileURLToPath(new URL('../web/', import.meta.url));

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url} svarade ${res.status}`);
  return res.json();
}

try {
  const snapshot = await getJson(`${base}/api/snapshot`);

  // Åldersgränsen är hela poängen: en demo som visar ett dygn gamla mynt
  // säger ingenting om ett verktyg vars fönster är minuter.
  const maxAgeSec = maxAgeMin * 60;
  const fresh = snapshot.board.filter((t) => t.ageSec <= maxAgeSec);

  if (fresh.length === 0) {
    console.error(
      `\nInga mynt yngre än ${maxAgeMin} min i radarn.\n` +
      'Låt `npm start` gå en stund först, eller höj --max-age-min.\n',
    );
    process.exit(1);
  }
  snapshot.board = fresh;

  const details = {};
  for (const t of fresh) {
    try {
      const d = await getJson(`${base}/api/detail?mint=${encodeURIComponent(t.mint)}`);
      if (!d.error) details[t.mint] = d;
    } catch {
      // En mint som hunnit falla ur radarn mellan anropen hoppas över.
    }
  }

  const css = fs.readFileSync(path.join(webDir, 'style.css'), 'utf8');
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  let js = fs.readFileSync(path.join(webDir, 'app.js'), 'utf8');

  const body = html.slice(html.indexOf('<header class="bar">'), html.indexOf('<script src="/app.js"'));

  // Byt ut det som pratar med servern mot inbäddad data.
  //
  // Strömmen ersätts med ett tomt objekt i stället för att klippas bort.
  // Klipper man bort deklarationen står lyssnarna kvar och refererar en
  // variabel som inte finns, och hela sidan dör på första raden.
  js = js.replace(
    "new EventSource('/api/stream')",
    '{ addEventListener() {} }',
  );
  js = js.replace(
    'stream.addEventListener(\'snapshot\'',
    'snap = DEMO.snapshot;\nstream.addEventListener(\'snapshot\'',
  );
  js = js.replace(
    /  const res = await fetch\(`\/api\/detail[\s\S]*?if \(d\.error\) \{ closeDrawer\(\); return; \}/,
    '  const d = DEMO.details[openMint];\n  if (!d) { closeDrawer(); return; }',
  );
  js += '\nrender();\n';

  const oldest = Math.max(...fresh.map((t) => t.ageSec));
  const stamp = new Date().toLocaleString('sv-SE');

  const page = `<!doctype html>
<html lang="sv"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Runner Lab</title>
<style>
${css}
body{overflow:auto}
.lanes{height:auto;min-height:620px}
.demo-note{display:flex;gap:11px;align-items:flex-start;background:var(--col);
  border-bottom:1px solid var(--line);border-left:3px solid var(--amber);
  padding:11px 14px;font-size:12.5px;color:var(--dim)}
.demo-note b{color:var(--ink)}
.demo-note .tag{font:10px var(--mono);color:var(--amber);letter-spacing:.1em;white-space:nowrap;padding-top:2px}
</style></head><body>
${body}
<div class="demo-note">
  <span class="tag">ÖGONBLICKSBILD</span>
  <span>Tagen <b>${stamp}</b> från en live-körning mot pump.fun.
  ${fresh.length} mynt, det äldsta <b>${Math.round(oldest / 60)} min</b> gammalt.
  Riktiga mintadresser — slå upp dem. Flödet uppdateras inte i den här filen;
  kör <b>npm start</b> för live.</span>
</div>
<script>
const DEMO = ${JSON.stringify({ snapshot, details })};
${js}
</script></body></html>`;

  fs.writeFileSync(out, page);
  console.log(
    `\n  ${out} — ${fresh.length} mynt, äldsta ${Math.round(oldest / 60)} min\n` +
    `  ${(page.length / 1024).toFixed(0)} kB, självbärande. Ladda upp var som helst.\n`,
  );
} catch (err) {
  console.error(`\nKunde inte exportera: ${err.message}`);
  console.error(`Kör terminalen först: npm start  (väntade svar på ${base})\n`);
  process.exit(1);
}
