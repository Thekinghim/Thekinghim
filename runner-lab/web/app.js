/**
 * Runner Lab — terminal.
 *
 * Renderingen är inkrementell med flit. Tidigare skrevs hela kolumn-DOM:en om
 * vid varje serveruppdatering, alltså varje sekund, vilket förstörde
 * scrollcontainern: man kastades till toppen en gång i sekunden och kunde i
 * praktiken inte läsa listan. Nu behålls en nod per mint och bara det som
 * faktiskt ändrats skrivs om.
 */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const LANES = [
  { id: 'new', label: 'Nya listningar', empty: 'Väntar på första listningen…' },
  { id: 'completing', label: 'Fyller kurvan', empty: 'Ingen över halva kurvan.' },
  { id: 'migrated', label: 'Migrerade', empty: 'Ingen migration ännu.' },
];
const SORTS = [
  { id: 'age', label: 'ny', cmp: (a, b) => a.ageSec - b.ageSec },
  { id: 'buyers', label: 'köpare', cmp: (a, b) => b.metrics.uniqueBuyers - a.metrics.uniqueBuyers },
  { id: 'mc', label: 'mc', cmp: (a, b) => mcOf(b) - mcOf(a) },
];
const VERDICT_RANK = { 'KÖP': 0, 'VÄNTA': 1, 'SKIPPA': 2 };
const MIN_SETTLED = 20;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

let snap = null;
let sortBy = { new: 'age', completing: 'mc', migrated: 'age' };
let query = '';
let openMint = null;
let lookupResult = null;
let lastPush = 0;

/** mint -> { el, sig } så att en rad kan uppdateras utan att bytas ut. */
const nodes = new Map();
/** Kolumner användaren håller pekaren över fryses tills hen lämnar dem. */
const frozen = new Set();
/** Kolumner som fått uppdateringar medan de var frysta. */
const stale = new Set();
const laneEls = new Map();

const mcOf = (t) => t.metrics.marketCapSol || t.launchMarketCapSol || 0;
const fmt = (n, d = 1) => (+n || 0).toFixed(d);
const ageText = (s) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s`
  : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);

function avatar(mint, symbol) {
  let h = 0;
  for (let i = 0; i < mint.length; i++) h = (h * 31 + mint.charCodeAt(i)) >>> 0;
  return { bg: `hsl(${h % 360} 55% 58%)`, txt: (symbol || mint).slice(0, 2).toUpperCase() };
}

/* ---------- ström ---------- */
const stream = new EventSource('/api/stream');
stream.addEventListener('snapshot', (e) => {
  const now = performance.now();
  if (lastPush) $('lat').textContent = `${Math.round(now - lastPush)}ms`;
  lastPush = now;
  snap = JSON.parse(e.data);
  render();
});
stream.addEventListener('error', () => {
  $('dot').dataset.live = '0';
  $('state').textContent = 'frånkopplad';
});

/* ---------- kolumnskelett, byggs en gång ---------- */
function buildShell() {
  $('lanes').innerHTML = LANES.map((lane) => `
    <section class="lane" data-lane="${lane.id}">
      <div class="lane-head">
        <h2>${lane.label}</h2><span class="n" data-count>0</span>
        <span class="paused" data-paused hidden>pausad</span>
        <div class="sorts">${SORTS.map((s) =>
          `<button type="button" data-lane="${lane.id}" data-sort="${s.id}"
             aria-pressed="${sortBy[lane.id] === s.id}">${s.label}</button>`).join('')}</div>
      </div>
      <div class="list" data-list></div>
    </section>`).join('');

  for (const lane of LANES) {
    const section = document.querySelector(`.lane[data-lane="${lane.id}"]`);
    const list = section.querySelector('[data-list]');
    laneEls.set(lane.id, {
      section,
      list,
      count: section.querySelector('[data-count]'),
      paused: section.querySelector('[data-paused]'),
    });

    // Frys kolumnen medan pekaren är i den. En lista som sorterar om under
    // markören går inte att klicka i, och det är hela poängen med att kunna
    // läsa flödet.
    section.addEventListener('pointerenter', () => {
      frozen.add(lane.id);
      laneEls.get(lane.id).paused.hidden = false;
    });
    section.addEventListener('pointerleave', () => {
      frozen.delete(lane.id);
      laneEls.get(lane.id).paused.hidden = true;
      if (stale.delete(lane.id)) render();
    });
  }

  document.querySelectorAll('.lane-head button').forEach((b) => {
    b.addEventListener('click', () => {
      sortBy[b.dataset.lane] = b.dataset.sort;
      document.querySelectorAll(`.lane-head button[data-lane="${b.dataset.lane}"]`)
        .forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
      // Sortering är en uttrycklig handling — den ska slå igenom direkt även
      // om pekaren råkar ligga i kolumnen.
      frozen.delete(b.dataset.lane);
      render();
      frozen.add(b.dataset.lane);
    });
  });
}

/* ---------- rendering ---------- */
function render() {
  if (!snap) return;
  const s = snap.status;
  $('dot').dataset.live = s.state === 'live' || s.state === 'replay' ? '1' : '';
  $('state').textContent = s.state === 'live' ? 'LIVE' : s.state;
  $('mL').textContent = snap.counters.launches;
  $('mT').textContent = snap.counters.trades;
  $('mA').textContent = snap.store.written;
  $('mS').textContent = `${s.tracked ?? 0}/${snap.config.maxTracked}`;

  renderRecord();

  const q = query.toLowerCase();
  const isAddress = SOLANA_ADDRESS.test(query);
  const match = (t) => !q ||
    t.mint.toLowerCase().includes(q) ||
    (t.symbol ?? '').toLowerCase().includes(q) ||
    (t.name ?? '').toLowerCase().includes(q);

  const seen = new Set();
  for (const lane of LANES) {
    const rows = snap.board.filter((t) => t.lane === lane.id && match(t));
    const inner = SORTS.find((x) => x.id === sortBy[lane.id]).cmp;
    rows.sort((a, b) =>
      (VERDICT_RANK[a.verdict?.verdict ?? 'VÄNTA'] - VERDICT_RANK[b.verdict?.verdict ?? 'VÄNTA'])
      || inner(a, b));
    for (const r of rows) seen.add(r.mint);
    syncLane(lane, rows);
  }

  // Släpp noder för mints som fallit ur radarn.
  for (const [mint, entry] of nodes) {
    if (seen.has(mint)) continue;
    entry.el.remove();
    nodes.delete(mint);
  }

  // En adress som inte finns i radarn ska slås upp, inte ge en tom sida.
  if (isAddress && !snap.board.some((t) => t.mint === query)) {
    if (lookupResult?.mint !== query) runLookup(query);
  }
}

/**
 * Uppdaterar en kolumn utan att röra scrollcontainern.
 *
 * Varje rad har en signatur över det som faktiskt visas. Ändras den inte rörs
 * noden inte alls — det är därför hovring, textmarkering och scroll överlever
 * en uppdatering varje sekund.
 */
function syncLane(lane, rows) {
  const el = laneEls.get(lane.id);
  el.count.textContent = String(rows.length);
  const tabCount = document.querySelector(`[data-tabcount="${lane.id}"]`);
  if (tabCount) tabCount.textContent = String(rows.length);

  if (frozen.has(lane.id)) {
    stale.add(lane.id);
    // Innehållet i befintliga rader får uppdateras — det är omsorteringen och
    // in-/utplockningen som stör.
    for (const row of rows) {
      const node = nodes.get(row.mint);
      if (node) updateRow(node, row);
    }
    return;
  }

  if (rows.length === 0) {
    if (!el.list.querySelector('.lane-empty')) {
      el.list.innerHTML = `<p class="lane-empty">${esc(lane.empty)}</p>`;
    }
    return;
  }
  el.list.querySelector('.lane-empty')?.remove();

  let cursor = el.list.firstElementChild;
  for (const row of rows) {
    let node = nodes.get(row.mint);
    if (!node) {
      const div = document.createElement('button');
      div.type = 'button';
      div.className = 'row fresh';
      div.dataset.mint = row.mint;
      div.addEventListener('click', onRowClick);
      node = { el: div, sig: '' };
      nodes.set(row.mint, node);
    }
    updateRow(node, row);

    if (cursor === node.el) {
      cursor = cursor.nextElementSibling;
    } else {
      el.list.insertBefore(node.el, cursor);
    }
  }
}

function updateRow(node, row) {
  const sig = signature(row);
  node.el.setAttribute('aria-selected', String(row.mint === openMint));
  if (node.sig === sig) return;
  node.sig = sig;
  node.el.className = `row ${rowClass(row)}${node.sig === '' ? ' fresh' : ''}`;
  node.el.innerHTML = rowHtml(row);
}

/** Allt som syns i raden utom åldern, som tickar separat. */
function signature(t) {
  const m = t.metrics;
  return [
    t.verdict?.verdict, t.verdict?.reason, t.lane, t.tracking, t.qualified,
    t.probeExpired, t.flowReversed, t.migratedAt, t.earlyExits, t.devSells,
    t.bundle?.bundleShare?.toFixed(3), t.bundle?.knownSnipers, t.bundle?.openingBuyers,
    t.preflight?.checks?.authority?.state, t.holders?.topHolderPct?.toFixed(0),
    t.creatorOpeningShare?.toFixed(1), t.curveProgress?.toFixed(3),
    m.uniqueBuyers, m.uniqueSellers, m.netSol.toFixed(2), mcOf(t).toFixed(1),
    t.meta?.image, t.meta?.description?.length,
  ].join('|');
}

const rowClass = (t) => {
  const v = t.verdict?.verdict;
  return v === 'KÖP' ? 'is-buy' : v === 'SKIPPA' ? 'is-skip' : '';
};

function rowHtml(t) {
  const a = avatar(t.mint, t.symbol);
  const m = t.metrics;
  const live = t.tracking || m.totalTrades > 0;
  const v = t.verdict ?? { verdict: 'VÄNTA', reason: '', missing: [] };
  const vcls = v.verdict === 'KÖP' ? 'buy' : v.verdict === 'SKIPPA' ? 'skip' : 'wait';

  const pills = [];
  if (t.devSells > 0) pills.push(['bad', `DEV SÅLT ${fmt(t.devSoldSol, 2)} SOL`]);
  if (t.bundle) {
    const b = t.bundle;
    const pct = b.bundleShare * 100;
    if (pct >= 25) pills.push(['bad', `bundle ${pct.toFixed(0)}%`]);
    else if (pct >= 12) pills.push(['warn', `bundle ${pct.toFixed(0)}%`]);
    else if (b.openingBuyers > 0) pills.push(['mut', `bundle ${pct.toFixed(0)}%`]);
    if (b.knownSnipers > 0) pills.push(['warn', `${b.knownSnipers} kända snipers`]);
  }
  if (t.flowReversed) pills.push(['bad', 'flödet vänt']);
  if (t.creatorOpeningShare !== null) {
    const d = t.creatorOpeningShare;
    pills.push([d > 12 ? 'bad' : d > 5 ? 'warn' : 'mut', `dev ${fmt(d, 1)}%`]);
  } else pills.push(['mut', 'dev ?']);
  if (t.preflight?.checks?.authority) {
    const st = t.preflight.checks.authority.state;
    pills.push([st === 'pass' ? 'ok' : st === 'fail' ? 'bad' : 'warn',
      st === 'pass' ? 'authority ok' : st === 'fail' ? 'authority fail' : 'authority ?']);
  }
  if (t.holders && !t.holders.unknown) {
    pills.push([t.holders.topHolderPct > 60 ? 'bad' : 'ok', `top10 ${fmt(t.holders.topHolderPct, 0)}%`]);
  }
  if (t.probeExpired && !t.qualified) pills.push(['mut', 'ingen traktion']);
  if (t.migratedAt) pills.push(['info', 'migrerad']);

  const p = t.curveProgress;
  const curve = p === null ? '' :
    `<span class="curve"><span class="track"><i class="${p > 0.8 ? 'hi' : ''}" style="width:${(p * 100).toFixed(1)}%"></i></span><span>${(p * 100).toFixed(0)}%</span></span>`;

  const thumb = t.meta?.image
    ? `<span class="thumb"><img src="${esc(t.meta.image)}" alt="" loading="lazy"
         onerror="this.parentNode.style.background='${a.bg}';this.parentNode.textContent='${esc(a.txt)}'"></span>`
    : `<span class="thumb" style="background:${a.bg}">${esc(a.txt)}</span>`;

  return `${thumb}
    <span class="body">
      <span class="by">skapad av <b>${esc((t.creator ?? '?').slice(0, 8))}</b> · <span class="age" data-age="${t.ageSec}">${ageText(t.ageSec)}</span></span>
      <span class="mcap"><i>market cap</i> ${fmt(mcOf(t), 1)} SOL ${live
        ? `<i>·</i> ${m.uniqueBuyers} köpare <span class="${m.netSol < 0 ? 'neg' : ''}">${m.netSol >= 0 ? '+' : ''}${fmt(m.netSol, 2)}</span>`
        : '<i>· flöde —</i>'}</span>
      <span class="title">${esc(t.name || 'namnlös')} <span>(${esc(t.symbol || '?')})</span></span>
      ${t.meta?.description ? `<span class="desc">${esc(t.meta.description)}</span>` : ''}
      ${curve}
      <span class="pills">${pills.map(([c, l]) => `<span class="pill ${c}">${esc(l)}</span>`).join('')}</span>
      <span class="acts">
        <span class="cp" data-copy="${esc(t.mint)}">KOPIERA</span>
        <a class="go ${vcls}" href="https://pump.fun/coin/${esc(t.mint)}" target="_blank" rel="noopener">${
          v.verdict === 'KÖP' ? 'KÖP NU ↗' : v.verdict === 'SKIPPA' ? 'öppna ändå ↗' : 'öppna ↗'}</a>
      </span>
    </span>
    <span class="vd ${vcls}">${v.verdict}${v.verdict === 'VÄNTA' && v.missing.length ? `<small>${v.missing.length} saknas</small>` : ''}</span>`;
}

/* ---------- träffbild ----------
   Siffror visas bara när de har underlag. En graduationsandel räknad på tre
   domar är brus, och att visa den ändå är snabbaste sättet att förlora någon
   som förstår vad talet betyder. */
function renderRecord() {
  const o = snap.outcomes;
  const el = $('record');
  if (!o || !el) return;

  const pct = (x) => (x === null ? '—' : `${(x * 100).toFixed(1)} %`);
  const buy = o.classes['KÖP'];
  const wait = o.classes['VÄNTA'];
  const skip = o.classes['SKIPPA'];
  const enough = (c) => c.settled >= MIN_SETTLED;

  const cells = [
    { label: 'Domar avgjorda', value: String(buy.settled + wait.settled + skip.settled),
      sub: `${o.totalGraded} bokförda · ${o.settleHours} h till avgörande` },
    { label: 'KÖP graduerar', value: enough(buy) ? pct(buy.graduationRate) : '—',
      cls: enough(buy) ? 'good' : 'mut',
      sub: enough(buy) ? `${buy.graduated} av ${buy.settled}` : `${buy.settled}/${MIN_SETTLED} avgjorda`,
      lead: enough(buy) },
    { label: 'Basfrekvens', value: o.baseGraduationRate === null ? '—' : pct(o.baseGraduationRate),
      sub: 'hela flödet' },
    { label: 'Lyft mot flödet',
      value: o.lift === null || !enough(buy) ? '—' : `${o.lift.toFixed(1)}×`,
      cls: !enough(buy) ? 'mut' : o.lift >= 1.5 ? 'good' : o.lift < 1 ? 'bad' : '',
      sub: enough(buy) ? 'KÖP mot basen' : `kräver ${MIN_SETTLED} avgjorda` },
    { label: 'SKIPPA graduerar', value: enough(skip) ? pct(skip.graduationRate) : '—',
      cls: enough(skip) ? '' : 'mut',
      sub: enough(skip) ? 'ska ligga under basen' : `${skip.settled}/${MIN_SETTLED} avgjorda` },
    { label: 'Median topp, KÖP',
      value: buy.medianPeakMultiple === null || !enough(buy) ? '—' : `${buy.medianPeakMultiple.toFixed(2)}×`,
      sub: 'undre gräns' },
  ];

  el.innerHTML = cells.map((c) =>
    `<div class="rec ${c.lead ? 'lead' : ''}"><span>${esc(c.label)}</span>` +
    `<b class="${c.cls ?? ''}">${esc(c.value)}</b><i>${esc(c.sub)}</i></div>`).join('');
}

/* Åldrarna tickar lokalt mellan serveruppdateringarna. Utan det ser
   terminalen frusen ut en sekund i taget. */
setInterval(() => {
  document.querySelectorAll('.age').forEach((el) => {
    const s = Number(el.dataset.age) + 1;
    el.dataset.age = s;
    el.textContent = ageText(s);
  });
}, 1000);

/* ---------- interaktion ---------- */
async function onRowClick(e) {
  const cp = e.target.closest('[data-copy]');
  if (cp) {
    e.preventDefault(); e.stopPropagation();
    flash(cp, (await copyText(cp.dataset.copy)) ? 'KOPIERAD' : 'MISSLYCKADES');
    return;
  }
  const link = e.target.closest('a');
  if (link) {
    e.preventDefault(); e.stopPropagation();
    await openOrCopy(link.href, link);
    return;
  }
  openMint = e.currentTarget.dataset.mint;
  lookupResult = null;
  refreshDrawer();
}

/**
 * Kopiering som fungerar även där clipboard-API:t är avstängt.
 * Utan fallback ser knappen ut att fungera medan ingenting hamnar i urklipp —
 * värsta felläget när nästa steg är att klistra in en adress i en handelsapp.
 */
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* faller igenom */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove();
    return ok;
  } catch { return false; }
}

/** Öppnar en länk, eller kopierar adressen när popup-fönster är blockerade. */
async function openOrCopy(url, el) {
  if (window.open(url, '_blank', 'noopener')) return;
  flash(el, (await copyText(url)) ? 'LÄNK KOPIERAD' : 'BLOCKERAD');
}

function flash(el, text) {
  if (!el) return;
  const original = el.textContent;
  el.textContent = text;
  el.classList.add('done');
  setTimeout(() => { el.textContent = original; el.classList.remove('done'); }, 1400);
}

/* ---------- uppslag av godtycklig adress ---------- */
async function runLookup(mint) {
  $('state').textContent = 'slår upp…';
  try {
    const res = await fetch(`/api/lookup?mint=${encodeURIComponent(mint)}`);
    const body = await res.json();
    lookupResult = body.error ? null : body;
    openMint = body.error ? null : mint;
    drawLookup(body, mint);
  } catch (err) {
    drawLookup({ error: err.message }, mint);
  }
}

function drawLookup(body, mint) {
  const el = $('drawer');
  if (body.error) {
    el.innerHTML = `<h3>Uppslag</h3><div class="addr">${esc(mint)}</div>
      <p class="note" style="color:var(--red)">${esc(body.error)}</p>`;
  } else {
    const a = body.authorities;
    const h = body.holders;
    const authClass = a.unknown ? 'unk' : (a.mintAuthorityActive || a.freezeAuthorityActive) ? 'bad' : 'ok';
    const authText = a.unknown ? `okänd — ${a.reason}`
      : a.mintAuthorityActive || a.freezeAuthorityActive
        ? [a.mintAuthorityActive && 'mint aktiv', a.freezeAuthorityActive && 'freeze aktiv'].filter(Boolean).join(' + ')
        : 'mint och freeze återkallade';

    el.innerHTML = `
      <div class="dhead"><span><b>Uppslag</b><br><span>utanför radarn</span></span>
        <button type="button" class="dclose" id="dclose" aria-label="Stäng">×</button></div>
      <div class="addr">${esc(mint)}</div>
      <div class="sect"><h3>Kontroller</h3>
        <dl class="kv">
          <div class="r"><dt>Authority</dt><dd class="${authClass}">${esc(authText)}</dd></div>
          <div class="r"><dt>Topp 10</dt><dd class="${h.unknown ? 'unk' : h.topHolderPct > 60 ? 'bad' : 'ok'}">${
            h.unknown ? esc(h.reason) : `${fmt(h.topHolderPct, 1)} %`}</dd></div>
          <div class="r"><dt>I radarn</dt><dd>${body.known ? 'ja' : 'nej — utanför fönstret'}</dd></div>
        </dl></div>
      ${h.unknown ? '' : `<div class="sect"><h3>Största innehavare</h3><div class="hold">${
        h.top.slice(0, 8).map((x) => `<div><span>${esc(x.address.slice(0, 16))}…</span><b>${fmt(x.pct, 1)} %</b></div>`).join('')
      }</div></div>`}
      <a class="dgo muted" href="https://pump.fun/coin/${esc(mint)}" target="_blank" rel="noopener">ÖPPNA PÅ PUMP.FUN ↗</a>`;
  }
  openDrawer();
}

/* ---------- lådan ---------- */
async function refreshDrawer() {
  if (!openMint) return;
  const res = await fetch(`/api/detail?mint=${encodeURIComponent(openMint)}`);
  const d = await res.json();
  if (d.error) { closeDrawer(); return; }

  const a = avatar(d.mint, d.symbol);
  const m = d.metrics;
  const pf = d.preflight;
  const meta = d.meta;
  const v = d.verdict;

  const socials = meta
    ? [meta.twitter && ['X', meta.twitter], meta.telegram && ['TG', meta.telegram], meta.website && ['WEB', meta.website]]
        .filter(Boolean)
        .map(([l, u]) => `<a class="pill info" href="${esc(u)}" target="_blank" rel="noopener">${l}</a>`).join(' ')
    : '';

  $('drawer').innerHTML = `
    <div class="dhead">
      ${meta?.image
        ? `<img class="thumb" src="${esc(meta.image)}" alt="" style="width:44px;height:44px">`
        : `<span class="thumb" style="background:${a.bg};width:44px;height:44px">${esc(a.txt)}</span>`}
      <span><b>$${esc(d.symbol || '?')}</b><br><span>${esc(d.name || '')}</span></span>
      <button type="button" class="dclose" id="dclose" aria-label="Stäng">×</button>
    </div>

    ${v ? `<div class="sect" style="text-align:center">
      <div class="vd ${v.verdict === 'KÖP' ? 'buy' : v.verdict === 'SKIPPA' ? 'skip' : 'wait'}"
           style="width:100%;font-size:19px;padding:13px 0">${v.verdict}</div>
      <p class="note" style="margin-top:9px">${esc(v.reason)}</p>
      ${v.missing?.length ? `<p class="note" style="color:var(--amber)">Saknas: ${v.missing.map(esc).join(', ')}</p>` : ''}
    </div>` : ''}

    ${meta?.description ? `<p class="note" style="margin-bottom:10px">${esc(meta.description)}</p>` : ''}
    ${socials ? `<div class="pills" style="margin-bottom:12px">${socials}</div>` : ''}
    <div class="addr">${esc(d.mint)}</div>

    <div class="sect"><h3>Marknad</h3>
      ${sparkline(d.series)}
      <dl class="kv" style="margin-top:10px">
        <div class="r"><dt>Market cap</dt><dd>${fmt(m.marketCapSol || d.launchMarketCapSol, 2)} SOL</dd></div>
        <div class="r"><dt>Kurva</dt><dd>${d.curveProgress === null ? '<span class="unk">okänd</span>' : `${(d.curveProgress * 100).toFixed(1)} %`}</dd></div>
        <div class="r"><dt>Köpare 60s</dt><dd>${m.uniqueBuyers} mot ${m.uniqueSellers} säljare</dd></div>
        <div class="r"><dt>Netto 60s</dt><dd class="${m.netSol > 0 ? 'ok' : 'bad'}">${m.netSol >= 0 ? '+' : ''}${fmt(m.netSol, 3)} SOL</dd></div>
      </dl></div>

    <div class="sect"><h3>Risk</h3>
      <dl class="kv">
        <div class="r"><dt>Authority</dt><dd class="${pf?.checks?.authority?.state === 'pass' ? 'ok' : pf?.checks?.authority?.state === 'fail' ? 'bad' : 'unk'}">${
          esc(pf?.checks?.authority?.detail ?? 'ej körd')}</dd></div>
        <div class="r"><dt>Topp 10</dt><dd class="${d.holders && !d.holders.unknown ? (d.holders.topHolderPct > 60 ? 'bad' : 'ok') : 'unk'}">${
          d.holders && !d.holders.unknown ? `${fmt(d.holders.topHolderPct, 1)} %` : 'okänd'}</dd></div>
        <div class="r"><dt>Dev tog</dt><dd>${d.creatorOpeningShare !== null ? `${fmt(d.creatorOpeningShare, 2)} % · ${fmt(d.creatorInitialSol, 2)} SOL` : '<span class="unk">okänd</span>'}</dd></div>
        <div class="r"><dt>Tidiga ur</dt><dd>${d.earlyExits} av de första köparna</dd></div>
        <div class="r"><dt>Creator</dt><dd>${esc((d.creator ?? '—').slice(0, 20))}</dd></div>
        <div class="r"><dt>Historik</dt><dd>${d.reputation?.known
          ? `${d.reputation.graduations}/${d.reputation.settledLaunches} graduerade`
          : '<span class="unk">ingen avgjord launch</span>'}</dd></div>
      </dl></div>

    ${d.bundle ? `<div class="sect"><h3>Bundle</h3>
      <dl class="kv">
        <div class="r"><dt>Öppningsköp</dt><dd>${d.bundle.openingBuyers} wallets inom 3 s</dd></div>
        <div class="r"><dt>Bundlad andel</dt><dd class="${d.bundle.bundleShare >= 0.25 ? 'bad' : d.bundle.bundleShare >= 0.12 ? 'unk' : 'ok'}">${
          (d.bundle.bundleShare * 100).toFixed(1)} % av supplyn, dev inräknad</dd></div>
        <div class="r"><dt>Kända snipers</dt><dd class="${d.bundle.knownSnipers ? 'unk' : ''}">${d.bundle.knownSnipers}</dd></div>
        ${d.bundle.identicalSized ? '<div class="r"><dt>Mönster</dt><dd class="unk">identiska belopp — ett skript</dd></div>' : ''}
        ${d.bundle.delta !== null ? `<div class="r"><dt>Topp 10 rå → slagen</dt><dd>${fmt(d.holders.topHolderPct, 0)} % → minst ${fmt(d.bundle.mergedTopHolderPct, 0)} %</dd></div>` : ''}
      </dl>
      ${d.openingBuyers?.length ? `<div class="hold" style="margin-top:9px">${d.openingBuyers.slice(0, 8).map((b) =>
        `<div><span>${esc(b.wallet.slice(0, 14))}… <i style="color:var(--faint)">${b.msAfterLaunch} ms</i></span><b>${fmt(b.sol, 3)}</b></div>`).join('')}</div>` : ''}
    </div>` : ''}

    <div class="sect"><h3>Största innehavare</h3>
      ${d.holders && !d.holders.unknown
        ? `<div class="hold">${d.holders.top.slice(0, 8).map((h) =>
            `<div><span>${esc(h.address.slice(0, 16))}…</span><b>${fmt(h.pct, 1)} %</b></div>`).join('')}</div>`
        : `<p class="note">${esc(d.holders?.reason ?? 'ej hämtad')}</p>`}</div>

    <div class="sect"><h3>Senaste affärer</h3>
      ${d.tape?.length
        ? `<div class="hold">${d.tape.slice(0, 14).map((t) =>
            `<div><span style="color:${t.side === 'buy' ? 'var(--green)' : 'var(--red)'}">${t.side === 'buy' ? 'KÖP ' : 'SÄLJ'} ${esc(t.wallet.slice(0, 10))}…</span><b>${fmt(t.sol, 3)}</b></div>`).join('')}</div>`
        : '<p class="note">Inga affärer ännu — token spåras först när den kvalificerat sig.</p>'}</div>

    <a class="dgo ${v?.verdict === 'KÖP' ? '' : 'muted'}" href="https://pump.fun/coin/${esc(d.mint)}"
       target="_blank" rel="noopener">${v?.verdict === 'KÖP' ? 'KÖP PÅ PUMP.FUN ↗' : 'ÖPPNA PÅ PUMP.FUN ↗'}</a>`;
  openDrawer();
}

function openDrawer() {
  $('drawer').hidden = false;
  $('scrim').hidden = false;
  document.body.classList.add('drawer-open');
  $('dclose')?.addEventListener('click', closeDrawer);
  $('drawer').querySelectorAll('a[href]').forEach((el) => {
    el.addEventListener('click', async (ev) => { ev.preventDefault(); await openOrCopy(el.href, el); });
  });
}

function closeDrawer() {
  openMint = null;
  lookupResult = null;
  $('drawer').hidden = true;
  $('scrim').hidden = true;
  document.body.classList.remove('drawer-open');
  render();
}

/** Prisgraf ur marknadsvärdesserien. Skalan sätts av serien själv. */
function sparkline(series) {
  if (!series || series.length < 2) return '<p class="note">För få datapunkter för en graf.</p>';
  const W = 380, H = 90, pad = 4;
  const vals = series.map((p) => p.mc);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x = (i) => pad + (i / (series.length - 1)) * (W - pad * 2);
  const y = (v) => H - pad - ((v - lo) / span) * (H - pad * 2 - 12);
  const line = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.mc).toFixed(1)}`).join(' ');
  const up = vals.at(-1) >= vals[0];
  const c = up ? 'var(--green)' : 'var(--red)';
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Marknadsvärde över tid">
    <path d="${line} L${x(series.length - 1).toFixed(1)} ${H - pad} L${x(0).toFixed(1)} ${H - pad} Z" fill="${c}" opacity=".1"/>
    <path d="${line}" fill="none" stroke="${c}" stroke-width="1.6" stroke-linejoin="round"/>
    <circle cx="${x(series.length - 1).toFixed(1)}" cy="${y(vals.at(-1)).toFixed(1)}" r="2.6" fill="${c}"/>
    <text x="${pad}" y="11" fill="var(--faint)" font-family="var(--mono)" font-size="9">${hi.toFixed(1)}</text>
    <text x="${pad}" y="${H - 1}" fill="var(--faint)" font-family="var(--mono)" font-size="9">${lo.toFixed(1)}</text>
  </svg>`;
}

/* ---------- toppbar ---------- */
$('scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
  if (e.key === '/' && document.activeElement !== $('ca')) { e.preventDefault(); $('ca').focus(); }
});
$('ca').addEventListener('input', (e) => { query = e.target.value.trim(); render(); });
$('help').addEventListener('click', () => {
  const bar = $('helpbar');
  bar.hidden = !bar.hidden;
  $('help').setAttribute('aria-expanded', String(!bar.hidden));
});

/* ---------- mobilflikar ---------- */
let activeLane = 'new';

function buildTabs() {
  const el = $('tabs');
  el.innerHTML = LANES.map((l) =>
    `<button type="button" data-tab="${l.id}" aria-pressed="${l.id === activeLane}">${
      esc(l.label)}<b data-tabcount="${l.id}">0</b></button>`).join('');
  el.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      activeLane = b.dataset.tab;
      $('lanes').dataset.active = activeLane;
      el.querySelectorAll('button').forEach((o) => o.setAttribute('aria-pressed', String(o === b)));
    });
  });
  $('lanes').dataset.active = activeLane;
}

buildShell();
buildTabs();
