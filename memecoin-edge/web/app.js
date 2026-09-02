/**
 * Dashboard. Tar emot uppdateringar över SSE och ritar om det som ändrats.
 *
 * Kandidater hålls i en Map på adress istället för att listan byggs om från
 * servern varje gång — flödet kan gå i hundratals uppdateringar per sekund
 * och en full omrendering per handel gör sidan obrukbar.
 */

const el = {
  candidates: document.getElementById('candidates'),
  empty: document.getElementById('empty'),
  funnel: document.getElementById('funnel'),
  gates: document.getElementById('gates'),
  paper: document.getElementById('paper'),
  source: document.getElementById('source'),
  thresholds: document.getElementById('thresholds'),
  conn: document.getElementById('conn'),
};

/** @type {Map<string, any>} */
const candidates = new Map();
let cfg = null;
let renderQueued = false;

const pct = (x) => `${(x * 100).toFixed(0)} %`;
const signed = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)} %`;

const stream = new EventSource('/api/stream');

stream.addEventListener('open', () => (el.conn.dataset.state = 'live'));
stream.addEventListener('error', () => (el.conn.dataset.state = 'down'));

stream.addEventListener('snapshot', (e) => {
  const data = JSON.parse(e.data);
  cfg = data.config;
  el.source.textContent = `källa: ${cfg.source}`;
  el.thresholds.innerHTML = `
    <span>momentum ≥ <b>${cfg.minMomentum}</b></span>
    <span>risk ≤ <b>${cfg.maxRisk}</b></span>
    <span>ålder ≤ <b>${cfg.maxAgeMinutes} min</b></span>
    <span>kostnad <b>${cfg.roundTripCostPct} %</b></span>`;
  for (const c of data.candidates) candidates.set(c.meta.address, c);
  renderStats(data.stats);
  queueRender();
});

stream.addEventListener('candidate', (e) => {
  const c = JSON.parse(e.data);
  candidates.set(c.meta.address, c);
  queueRender();
});

stream.addEventListener('alert', (e) => {
  const c = JSON.parse(e.data);
  candidates.set(c.meta.address, c);
  queueRender();
});

stream.addEventListener('stats', (e) => renderStats(JSON.parse(e.data)));

/** Samlar uppdateringar till nästa animationsruta. */
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderCandidates();
  });
}

function renderCandidates() {
  const now = Date.now();
  const list = [...candidates.values()]
    .filter((c) => c.ageMinutes <= (cfg?.maxAgeMinutes ?? 30))
    .sort((a, b) => {
      if (a.alerted !== b.alerted) return a.alerted ? -1 : 1;
      return b.momentum.score - a.momentum.score;
    })
    .slice(0, 30);

  // Städa bort det som fallit ur fönstret så att Map:en inte växer obegränsat.
  for (const [addr, c] of candidates) {
    if (c.ageMinutes > (cfg?.maxAgeMinutes ?? 30) + 5) candidates.delete(addr);
  }

  el.empty.hidden = list.length > 0;
  el.candidates.replaceChildren(...list.map(card));
}

function card(c) {
  const node = document.createElement('article');
  node.className = `card${c.alerted ? ' alerted' : ''}`;

  const riskClass = c.safety.riskScore <= 25 ? 'risk-low' : c.safety.riskScore <= 45 ? 'risk-mid' : 'risk-high';

  const topFactors = [...c.momentum.factors]
    .sort((a, b) => b.points - a.points)
    .slice(0, 3)
    .map((f) => `<span class="factor ${f.points > 0 ? 'strong' : ''}">${f.detail}</span>`)
    .join('');

  const riskNotes = [...c.safety.riskFactors]
    .filter((f) => f.points > 1)
    .sort((a, b) => b.points - a.points)
    .slice(0, 2)
    .map((f) => `<span class="factor warn">${f.detail}</span>`)
    .join('');

  node.innerHTML = `
    <div class="card-top">
      <span class="sym">${escapeHtml(c.meta.symbol)}</span>
      <span class="addr">${escapeHtml(c.meta.address.slice(0, 10))}…</span>
      ${c.alerted && c.alert
        ? `<span class="badge alert">larm @ ${c.alert.ageMinutes} min · ${c.alert.momentum.toFixed(0)}</span>`
        : ''}
      ${c.pnlSinceAlert !== null && c.pnlSinceAlert !== undefined
        ? `<span class="pnl ${c.pnlSinceAlert >= 0 ? 'pos' : 'neg'}">${signed(c.pnlSinceAlert)}</span>`
        : ''}
      <span class="age">${c.ageMinutes.toFixed(1)} min</span>
    </div>
    <div class="scores">
      <div>
        <div class="score-label"><span>momentum</span><b>${c.momentum.score.toFixed(0)}</b></div>
        <div class="track"><div class="fill momentum" style="width:${c.momentum.score}%"></div></div>
      </div>
      <div>
        <div class="score-label"><span>risk</span><b>${c.safety.riskScore.toFixed(0)}</b></div>
        <div class="track"><div class="fill ${riskClass}" style="width:${c.safety.riskScore}%"></div></div>
      </div>
    </div>
    <div class="factors">${topFactors}${riskNotes}</div>`;
  return node;
}

function renderStats(stats) {
  const c = stats.counters;
  el.funnel.innerHTML = [
    ['Upptäckta pooler', c.seen],
    ['Fällda av hårda grindar', c.gateFailed],
    ['Under tröskel', c.riskRejected],
    ['Larm', c.alerted],
    ['Följs just nu', stats.tracking],
  ]
    .map(([label, value]) => `<div class="funnel-row"><span>${label}</span><b>${value}</b></div>`)
    .join('');

  const gateRows = Object.entries(stats.gateFailures).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...gateRows.map(([, n]) => n));
  el.gates.innerHTML =
    gateRows
      .map(
        ([gate, n]) => `
      <div class="bar-row">
        <div class="bar-top"><span>${gate}</span><span>${n}</span></div>
        <div class="track"><div class="fill" style="width:${(n / max) * 100}%"></div></div>
      </div>`,
      )
      .join('') || '<p class="hint">Inga utslag ännu.</p>';

  el.paper.innerHTML = paperTable(stats.paper);
}

function paperTable(paper) {
  const labels = cfg?.horizonLabels ?? [];
  const section = (g, title) => {
    if (g.n === 0) return `<tr class="head"><td colspan="5">${title} — inga positioner</td></tr>`;
    const rows = g.horizons
      .filter((h) => h.n > 0)
      .map(
        (h) => `<tr>
          <td>${h.label}</td>
          <td>${h.n}</td>
          <td>${pct(h.winRate)}</td>
          <td class="${h.median >= 0 ? 'pos' : 'neg'}">${signed(h.median)}</td>
          <td class="${h.mean >= 0 ? 'pos' : 'neg'}">${signed(h.mean)}</td>
        </tr>`,
      )
      .join('');
    return `<tr class="head"><td colspan="5">${title} — n=${g.n}</td></tr>${rows}`;
  };

  return `<table>
    <thead><tr><th>horisont</th><th>n</th><th>träff</th><th>median</th><th>medel</th></tr></thead>
    <tbody>
      ${section(paper.strategy, 'Larm')}
      ${section(paper.control, 'Kontroll')}
    </tbody>
  </table>`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
}
