/**
 * Beslutstavla.
 *
 * Skillnaden mot en vanlig scanner är att varje köp måste bära en komplett
 * plan. En rankad lista utan storlek, ogiltighetsvillkor och utgång är inte
 * ett beslutsstöd — den flyttar bara ansvaret till läsaren i det ögonblick
 * då hen har som minst tid att tänka.
 */

const el = (id) => document.getElementById(id);
const dom = {
  board: el('board'), empty: el('empty'), funnel: el('funnel'),
  journal: el('journal'), calibration: el('calibration'),
  scatter: el('scatter'), mode: el('mode'), conn: el('conn'),
};

let cfg = null;
const pct = (x) => `${(x * 100).toFixed(0)} %`;
const signed = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)} %`;
const money = (x) => `$${Math.round(x).toLocaleString('sv-SE')}`;

const stream = new EventSource('/api/stream');
stream.addEventListener('open', () => (dom.conn.dataset.state = 'live'));
stream.addEventListener('error', () => (dom.conn.dataset.state = 'down'));

stream.addEventListener('snapshot', (e) => {
  const data = JSON.parse(e.data);
  cfg = data.config;
  dom.mode.textContent = {
    live: 'live: Jupiter + DexScreener',
    preview: 'preview: inspelad data',
    sim: 'simulering',
  }[cfg.mode] ?? cfg.mode;
  render(data);
});
stream.addEventListener('board', (e) => render(JSON.parse(e.data)));
stream.addEventListener('buy', (e) => {
  // Ett köp får inte hamna längre ned i en lista som just uppdaterats.
  const d = JSON.parse(e.data);
  document.title = `KÖP ${d.token.symbol} — memecoin-edge`;
  setTimeout(() => (document.title = 'memecoin-edge'), 20_000);
});

function render(data) {
  if (data.board) renderBoard(data.board);
  if (data.stats) renderStats(data.stats);
}

function renderBoard(board) {
  dom.empty.hidden = board.length > 0;
  dom.board.replaceChildren(...board.map(card));
  renderScatter(board);
}

function card(d) {
  const kind = d.verdict.toLowerCase();
  const node = document.createElement('article');
  node.className = `card ${kind}`;

  const t = d.edge.traction.score;
  const a = d.edge.attention.score;

  node.innerHTML = `
    <div class="card-top">
      <span class="verdict ${kind}">${d.verdict === 'BUY' ? 'KÖP' : d.verdict === 'WATCH' ? 'BEVAKA' : d.verdict === 'AVOID' ? 'UNDVIK' : 'SKIP'}</span>
      <span class="sym">$${esc(d.token.symbol)}</span>
      <span class="name">${esc(d.token.name ?? '')}</span>
      <span class="gap">gap <b>${d.edge.gap > 0 ? '+' : ''}${d.edge.gap.toFixed(0)}</b></span>
    </div>
    <p class="headline">${esc(d.headline)}</p>
    <div class="meters">
      <div>
        <div class="meter-label"><span>organisk traktion</span><b>${t.toFixed(0)}</b></div>
        <div class="track"><div class="fill traction" style="width:${t}%"></div></div>
      </div>
      <div>
        <div class="meter-label"><span>uppmärksamhet</span><b>${a.toFixed(0)}</b></div>
        <div class="track"><div class="fill attention" style="width:${a}%"></div></div>
      </div>
    </div>
    <div class="factors">${(d.reasons ?? []).map((r) => `<span class="factor">${esc(r)}</span>`).join('')}</div>
    ${d.plan ? planHtml(d.plan, d.token) : ''}`;
  return node;
}

function planHtml(plan, token) {
  return `
    <div class="plan">
      <div class="plan-row">
        <span>storlek</span>
        <div>
          <span class="size">${money(plan.sizeUsd)}</span>
          <span class="conviction">konviktion ${esc(plan.conviction)}</span>
          ${plan.sizeCappedByLiquidity ? '<span class="conviction">· begränsad av poolens djup</span>' : ''}
        </div>
      </div>
      <div class="plan-row">
        <span>entry</span>
        <div>${esc(plan.entry.note)}${plan.entry.priceUsd ? ` <span class="conviction">@ $${plan.entry.priceUsd.toPrecision(3)}</span>` : ''}</div>
      </div>
      <div class="plan-row">
        <span>ogiltig om</span>
        <ul>${plan.invalidation.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
      </div>
      <div class="plan-row">
        <span>exit</span>
        <div>
          <div class="ladder">
            ${plan.exit.ladder.map((r) => `<span class="rung">${esc(r.sell)} vid ${esc(r.at)}</span>`).join('')}
            <span class="rung stop">hård stop −${plan.exit.hardStopPct} %</span>
          </div>
          <div class="conviction" style="margin-top:5px">${esc(plan.exit.timeStop)}</div>
        </div>
      </div>
      ${plan.reputationNote ? `<div class="plan-row"><span>historik</span><div class="conviction">${esc(plan.reputationNote)}</div></div>` : ''}
    </div>`;
}

/**
 * Kvadrantvyn. Hela tesen på en bild: traktion lodrätt, uppmärksamhet
 * vågrätt. Uppe till vänster är det enda hörnet som är värt något.
 */
function renderScatter(board) {
  const W = 300, H = 220, pad = 26;
  const x = (v) => pad + (v / 100) * (W - pad * 2);
  const y = (v) => H - pad - (v / 100) * (H - pad * 2);

  const dots = board
    .filter((d) => d.edge)
    .map((d) => {
      const buy = d.verdict === 'BUY';
      const color = buy ? 'var(--green)' : d.verdict === 'AVOID' ? 'var(--red)' : 'var(--dim)';
      return `<circle cx="${x(d.edge.attention.score).toFixed(1)}" cy="${y(d.edge.traction.score).toFixed(1)}"
        r="${buy ? 5 : 3}" fill="${color}" opacity="${buy ? 0.95 : 0.5}"><title>${esc(d.token.symbol)} — ${esc(d.edge.quadrantLabel)}</title></circle>`;
    })
    .join('');

  dom.scatter.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Traktion mot uppmärksamhet">
      <rect x="${pad}" y="${pad}" width="${(W - pad * 2) * 0.45}" height="${(H - pad * 2) * 0.45}" fill="#34d39912"/>
      <rect x="${pad + (W - pad * 2) * 0.45}" y="${H - pad - (H - pad * 2) * 0.45}" width="${(W - pad * 2) * 0.55}" height="${(H - pad * 2) * 0.45}" fill="#fb718510"/>
      <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="var(--line)"/>
      <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${H - pad}" stroke="var(--line)"/>
      <text x="${pad + 4}" y="${pad + 12}" fill="var(--green)" font-size="9" font-family="var(--mono)">TIDIG</text>
      <text x="${W - pad - 4}" y="${H - pad - 6}" fill="var(--red)" font-size="9" text-anchor="end" font-family="var(--mono)">EXIT-LIKVIDITET</text>
      <text x="${W / 2}" y="${H - 6}" fill="var(--dim)" font-size="9" text-anchor="middle" font-family="var(--mono)">uppmärksamhet →</text>
      <text x="10" y="${H / 2}" fill="var(--dim)" font-size="9" text-anchor="middle" font-family="var(--mono)" transform="rotate(-90 10 ${H / 2})">traktion →</text>
      ${dots}
    </svg>`;
}

function renderStats(stats) {
  const c = stats.counters ?? {};
  dom.funnel.innerHTML = [
    ['Tokens sedda', c.tokensSeen ?? 0],
    ['Fällda av grindar', c.gateFailed ?? 0],
    ['Exit-likviditet', c.exitLiquidity ?? 0],
    ['Bevakas', c.watch ?? 0],
    ['Köp', c.buy ?? 0],
    ['Öppna i journalen', stats.openPositions ?? 0],
  ]
    .map(([label, v]) => `<div class="funnel-row"><span>${label}</span><b>${v}</b></div>`)
    .join('') + (stats.lastError ? `<div class="funnel-row"><span style="color:var(--red)">senaste fel</span><b class="conviction">${esc(stats.lastError)}</b></div>` : '');

  dom.journal.innerHTML = journalTable(stats.journal);
  dom.calibration.innerHTML = calibrationTable(stats.calibration);
}

function journalTable(journal) {
  if (!journal) return '<p class="hint">Ingen journal ännu.</p>';
  const labels = cfg?.horizonLabels ?? [];
  const section = (g, title) => {
    if (!g || g.n === 0) return `<tr class="head"><td colspan="5">${title} — inga positioner ännu</td></tr>`;
    const rows = g.horizons
      .map((h) =>
        h.n === 0
          ? `<tr><td class="muted">${h.label}</td><td colspan="4" class="muted">väntar på horisont</td></tr>`
          : `<tr><td>${h.label}</td><td>${h.n}</td><td>${pct(h.winRate)}</td>
             <td class="${h.median >= 0 ? 'pos' : 'neg'}">${signed(h.median)}</td>
             <td class="${h.mean >= 0 ? 'pos' : 'neg'}">${signed(h.mean)}</td></tr>`,
      )
      .join('');
    return `<tr class="head"><td colspan="5">${title} — n=${g.n}</td></tr>${rows}`;
  };
  return `<table>
    <thead><tr><th>horisont</th><th>n</th><th>träff</th><th>median</th><th>medel</th></tr></thead>
    <tbody>${section(journal.strategy, 'Köp')}${section(journal.control, 'Kontroll')}</tbody>
  </table>`;
}

function calibrationTable(calibration) {
  const entries = Object.entries(calibration ?? {});
  if (entries.length === 0) return '<p class="hint">Ingen kalibrering ännu.</p>';
  return `<table>
    <thead><tr><th>hink</th><th>n</th><th>träff</th><th>förväntan</th></tr></thead>
    <tbody>${entries
      .map(
        ([id, s]) => `<tr>
          <td class="${s.ready ? '' : 'muted'}">${id.replace('gap_', '').replace('_', '–')}</td>
          <td>${s.n}</td>
          <td class="${s.ready ? '' : 'muted'}">${s.ready ? pct(s.hitRate) : '—'}</td>
          <td class="${!s.ready ? 'muted' : s.expectancy >= 0 ? 'pos' : 'neg'}">${s.ready ? signed(s.expectancy) : 'för lite data'}</td>
        </tr>`,
      )
      .join('')}</tbody>
  </table>`;
}

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
