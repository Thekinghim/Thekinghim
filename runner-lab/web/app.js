/**
 * Runner Lab — klient.
 *
 * Tar emot hela ögonblicksbilden över SSE en gång per sekund. Servern
 * aggregerar redan, så klienten behöver inte hålla egen händelsehistorik;
 * det gör att en flik som legat i bakgrunden aldrig visar gammal data.
 */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let snap = null;
let selected = null;
let filter = 'all';
let lastFrameAt = 0;
let lookupResult = null;

const sol = (n) => `${(+n || 0).toFixed(n >= 100 ? 0 : 2)} SOL`;
const age = (s) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${(s / 3600).toFixed(1)}h`);

function avatar(mint, symbol) {
  let h = 0;
  for (let i = 0; i < mint.length; i++) h = (h * 31 + mint.charCodeAt(i)) >>> 0;
  return { bg: `hsl(${h % 360} 58% 60%)`, txt: (symbol || mint).slice(0, 2).toUpperCase() };
}

const stream = new EventSource('/api/stream');
stream.addEventListener('snapshot', (e) => {
  const now = performance.now();
  if (lastFrameAt) $('latency').textContent = `${Math.round(now - lastFrameAt)} ms`;
  lastFrameAt = now;
  snap = JSON.parse(e.data);
  render();
});
stream.addEventListener('error', () => {
  $('dot').dataset.live = '0';
  $('state').textContent = 'frånkopplad';
});

function render() {
  if (!snap) return;
  const s = snap.status;

  $('dot').dataset.live = s.state === 'live' || s.state === 'replay' ? '1' : '';
  $('state').textContent = s.synthetic ? 'SYNTETISK DATA' : s.state === 'live' ? 'LIVE' : s.state;
  $('source').textContent = s.synthetic ? 'syntetisk ström' : `källa: ${s.source}`;
  $('window').textContent = `fönster ${snap.config.windowMinutes} min · spårar ${s.tracked ?? 0}/${snap.config.maxTracked}`;
  $('updated').textContent = `uppdaterad ${new Date().toLocaleTimeString('sv-SE')}`;

  renderStrip();
  renderCards();
  renderSide();
}

function renderStrip() {
  const c = snap.counters, p = snap.preflight, st = snap.store, cr = snap.creators;
  const rows = [
    ['Listningar sedda', c.launches, '', `${c.dropped} har fallit ur fönstret`],
    ['Trade-event', c.trades, c.trades > 0 ? 'good' : 'warn', c.trades === 0 ? 'inga spårade mints ännu' : 'från spårade mints'],
    ['Kvalificerade', c.qualified, c.qualified ? 'good' : '', `≥ ${snap.config.minUniqueBuyers} unika köpare`],
    ['Arkiverade event', st.written, '', `${st.duplicates} dubbletter kastade`],
    ['Preflight', `${p.done}/${p.done + p.queued + p.running}`, p.unknown ? 'warn' : 'good',
      `${p.failed} fällda · ${p.unknown} okända`],
    ['Migrationer', c.migrations, c.migrations ? 'good' : '', 'bonding curve fylld'],
    ['Creator-register', cr.launches, '', `${cr.repeatCreators} återkommande`],
  ];
  $('strip').innerHTML = rows.map(([k, v, cls, sub]) =>
    `<div class="stat"><span>${k}</span><b class="${cls}">${v}</b><i>${sub}</i></div>`).join('');
}

function renderCards() {
  const board = snap.board.filter((t) =>
    filter === 'all' ||
    (filter === 'qualified' && t.qualified) ||
    (filter === 'flow' && t.metrics.trades > 0));

  $('feedsub').textContent =
    `${snap.board.length} i fönstret · ${snap.board.filter((t) => t.qualified).length} kvalificerade`;
  $('empty').hidden = board.length > 0;
  if (selected === null && board.length) selected = board[0].mint;

  $('cards').innerHTML = board.map((t) => {
    const a = avatar(t.mint, t.symbol);
    const m = t.metrics;
    const share = t.creatorOpeningShare;

    const tags = [];
    if (t.qualified) tags.push(['ok', 'kvalificerad']);
    if (t.migratedAt) tags.push(['ok', 'migrerad']);
    if (!t.tracking && !t.qualified) tags.push(['mut', 'ej spårad']);
    if (share !== null && share > 12) tags.push(['bad', `dev tog ${share.toFixed(0)} %`]);
    else if (share !== null) tags.push(['mut', `dev ${share.toFixed(1)} %`]);
    if (t.preflight) {
      const st = t.preflight.state;
      tags.push([st === 'pass' ? 'ok' : st === 'fail' ? 'bad' : 'warn', `preflight ${st}`]);
    }
    if (t.flowReversed) tags.push(['bad', 'flödet vänt']);
    if (t.earlyExits > 2) tags.push(['warn', `${t.earlyExits} tidiga ur`]);

    return `<button type="button" class="card ${t.qualified ? 'qualified' : ''}" data-mint="${esc(t.mint)}"
        aria-selected="${t.mint === selected}">
      <div class="chead">
        <span class="ava" style="background:${a.bg}">${esc(a.txt)}</span>
        <span class="cid">
          <div class="cname">${esc(t.name || t.symbol || 'namnlös')}</div>
          <div class="cticker">$${esc(t.symbol || '?')}</div>
        </span>
        <span class="cage">${age(t.ageSec)}</span>
      </div>
      <div class="mint">${esc(t.mint)}</div>
      <div class="tags">${tags.map(([c, l]) => `<span class="tag ${c}">${esc(l)}</span>`).join('')}</div>
      <div class="metrics">
        <div><span>unika köpare 60s</span><b class="${m.uniqueBuyers ? 'good' : 'mut'}">${m.uniqueBuyers}</b></div>
        <div><span>tx/sek</span><b class="${m.txPerSec ? '' : 'mut'}">${m.txPerSec.toFixed(2)}</b></div>
        <div><span>netto 60s</span><b class="${m.netSol > 0 ? 'good' : m.netSol < 0 ? 'bad' : 'mut'}">${m.netSol >= 0 ? '+' : ''}${m.netSol.toFixed(2)}</b></div>
        <div><span>market cap</span><b>${(m.marketCapSol || t.launchMarketCapSol).toFixed(1)}</b></div>
      </div>
      <span class="buy" data-href="https://pump.fun/coin/${esc(t.mint)}">KÖP PÅ PUMP.FUN ↗</span>
    </button>`;
  }).join('');

  document.querySelectorAll('.card').forEach((el) => {
    el.addEventListener('click', (e) => {
      const buy = e.target.closest('.buy');
      if (buy) { window.open(buy.dataset.href, '_blank', 'noopener'); return; }
      selected = el.dataset.mint;
      render();
    });
  });
}

function renderSide() {
  const t = snap.board.find((x) => x.mint === selected);
  const lr = lookupResult;

  if (!t && !lr) {
    $('side').innerHTML = `<div class="panel"><h3>Detalj</h3>
      <p class="note">Välj ett coin i flödet, eller klistra in en CA ovan för att köra kontrollerna mot en godtycklig mint.</p></div>`;
    return;
  }

  const src = lr ?? t;
  const mint = lr ? lr.mint : t.mint;
  const a = avatar(mint, t?.symbol);
  const auth = lr?.authorities ?? null;
  const hold = lr?.holders ?? (t?.holders ?? null);
  const pf = t?.preflight;

  const authRow = auth
    ? (auth.unknown
        ? `<dd class="unknown">okänd — ${esc(auth.reason)}</dd>`
        : auth.mintAuthorityActive || auth.freezeAuthorityActive
          ? `<dd class="bad">${auth.mintAuthorityActive ? 'mint aktiv' : ''}${auth.mintAuthorityActive && auth.freezeAuthorityActive ? ' + ' : ''}${auth.freezeAuthorityActive ? 'freeze aktiv' : ''}</dd>`
          : `<dd class="good">mint och freeze återkallade</dd>`)
    : pf
      ? `<dd class="${pf.checks.authority?.state === 'pass' ? 'good' : pf.checks.authority?.state === 'fail' ? 'bad' : 'unknown'}">${esc(pf.checks.authority?.detail ?? pf.state)}</dd>`
      : `<dd class="unknown">ej körd</dd>`;

  const holdersBlock = hold && !hold.unknown
    ? `<div class="hold">${hold.top.slice(0, 6).map((h) =>
        `<div><span>${esc(h.address.slice(0, 12))}…</span><b>${h.pct.toFixed(1)} %</b></div>`).join('')}</div>`
    : `<p class="note ${hold?.unknown ? 'unknown' : ''}">${hold?.unknown ? esc(hold.reason) : 'ej hämtad'}</p>`;

  $('side').innerHTML = `
    <div class="panel">
      <h3>${lr ? 'CA-analys' : 'Detalj'}</h3>
      <div class="chead" style="margin-bottom:12px">
        <span class="ava" style="background:${a.bg}">${esc(a.txt)}</span>
        <span class="cid">
          <div class="cname">${esc(t?.name || 'okänd i radarn')}</div>
          <div class="cticker">$${esc(t?.symbol || '?')}</div>
        </span>
      </div>
      <div class="addr" style="margin-bottom:12px">${esc(mint)}</div>
      <dl class="kv">
        <div class="row"><dt>Authority</dt>${authRow}</div>
        <div class="row"><dt>Topp 10</dt><dd class="mono ${hold && !hold.unknown ? (hold.topHolderPct > 60 ? 'bad' : 'good') : 'unknown'}">${
          hold && !hold.unknown ? `${hold.topHolderPct.toFixed(1)} %` : 'okänd'}</dd></div>
        <div class="row"><dt>Dev tog</dt><dd class="mono">${
          t?.creatorOpeningShare !== null && t?.creatorOpeningShare !== undefined
            ? `${t.creatorOpeningShare.toFixed(2)} % · ${sol(t.creatorInitialSol)}` : '—'}</dd></div>
        <div class="row"><dt>Creator</dt><dd class="mono">${esc((lr?.creator ?? t?.creator ?? '—').slice(0, 22))}</dd></div>
        ${lr?.reputation ? `<div class="row"><dt>Historik</dt><dd class="mono">${
          lr.reputation.known
            ? `${lr.reputation.graduations}/${lr.reputation.settledLaunches} graduerade`
            : 'ingen avgjord launch ännu'}</dd></div>` : ''}
      </dl>
      <a class="buy" style="margin-top:13px" href="https://pump.fun/coin/${esc(mint)}" target="_blank" rel="noopener">ÖPPNA PÅ PUMP.FUN ↗</a>
    </div>

    <div class="panel">
      <h3>Största innehavare</h3>
      ${holdersBlock}
    </div>

    <div class="panel">
      <h3>Vad verktyget inte vet</h3>
      <p class="note">Kvalificering betyder att en token har riktig aktivitet — inte att den är säker.
      Preflight körs efteråt, och ett <span class="unknown">okänt</span> resultat räknas aldrig som godkänt.</p>
      <dl class="kv">
        <div class="row"><dt>Basfrekvens</dt><dd class="mono">${
          snap.creators.baseGraduationRate !== null
            ? `${(snap.creators.baseGraduationRate * 100).toFixed(1)} % graduerar`
            : 'för lite egen data'}</dd></div>
        <div class="row"><dt>Egen inspelning</dt><dd class="mono">${snap.creators.launches} launches · ${snap.creators.graduations} graduationer</dd></div>
      </dl>
    </div>`;
}

document.querySelectorAll('.tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    filter = b.dataset.f;
    document.querySelectorAll('.tabs button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
    render();
  });
});

async function runLookup() {
  const mint = $('ca').value.trim();
  if (!mint) return;
  $('analyze').disabled = true;
  $('analyze').textContent = 'KÖR…';
  try {
    const res = await fetch(`/api/lookup?mint=${encodeURIComponent(mint)}`);
    const body = await res.json();
    if (body.error) {
      lookupResult = null;
      $('side').innerHTML = `<div class="panel"><h3>CA-analys</h3><p class="note bad">${esc(body.error)}</p></div>`;
      return;
    }
    lookupResult = body;
    selected = body.mint;
    render();
  } finally {
    $('analyze').disabled = false;
    $('analyze').textContent = 'ANALYSERA';
  }
}
$('analyze').addEventListener('click', runLookup);
$('ca').addEventListener('keydown', (e) => { if (e.key === 'Enter') runLookup(); });
