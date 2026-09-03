/**
 * Runner Lab — terminal.
 *
 * Tre kolumner efter pump.fun:s livscykel. Servern skickar hela
 * ögonblicksbilden en gång per sekund; klienten håller ingen egen historik,
 * så en flik som legat i bakgrunden visar aldrig gammal data.
 *
 * Åldrarna tickar lokalt mellan sändningarna. Utan det ser terminalen
 * frusen ut en sekund i taget, vilket är det första man reagerar på.
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
  { id: 'mc', label: 'mc', cmp: (a, b) => (b.metrics.marketCapSol || b.launchMarketCapSol) - (a.metrics.marketCapSol || a.launchMarketCapSol) },
];

let snap = null;
let sortBy = { new: 'age', completing: 'mc', migrated: 'age' };
let query = '';
let openMint = null;
let seen = new Set();
let lastPush = 0;

const fmt = (n, d = 1) => (+n || 0).toFixed(d);
const ageText = (s) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);

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

/* ---------- träffbild ----------
   Ligger överst för att det är det första en betalande besökare vill se:
   inte vad verktyget påstår nu, utan vad det påstod förut och hur det gick.

   Siffror visas bara när de har underlag. En graduationsandel räknad på tre
   domar är brus, och att visa den ändå är det snabbaste sättet att förlora
   någon som förstår vad talet betyder. */
const MIN_SETTLED = 20;

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
    { label: 'Domar avgjorda',
      value: String(buy.settled + wait.settled + skip.settled),
      sub: `${o.totalGraded} bokförda · ${o.settleHours} h till avgörande` },

    { label: 'KÖP graduerar',
      value: enough(buy) ? pct(buy.graduationRate) : '—',
      cls: enough(buy) ? 'good' : 'mut',
      sub: enough(buy) ? `${buy.graduated} av ${buy.settled}` : `${buy.settled}/${MIN_SETTLED} avgjorda`,
      lead: enough(buy) },

    { label: 'Basfrekvens',
      value: o.baseGraduationRate === null ? '—' : pct(o.baseGraduationRate),
      sub: 'hela flödet' },

    { label: 'Lyft mot flödet',
      value: o.lift === null || !enough(buy) ? '—' : `${o.lift.toFixed(1)}×`,
      cls: !enough(buy) ? 'mut' : o.lift >= 1.5 ? 'good' : o.lift < 1 ? 'bad' : '',
      sub: enough(buy) ? 'KÖP mot basen' : `kräver ${MIN_SETTLED} avgjorda` },

    { label: 'SKIPPA graduerar',
      value: enough(skip) ? pct(skip.graduationRate) : '—',
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
  const match = (t) => !q ||
    t.mint.toLowerCase().includes(q) ||
    (t.symbol ?? '').toLowerCase().includes(q) ||
    (t.name ?? '').toLowerCase().includes(q);

  $('lanes').innerHTML = LANES.map((lane) => {
    const rows = snap.board.filter((t) => t.lane === lane.id && match(t));
    const rank = { 'KÖP': 0, 'VÄNTA': 1, 'SKIPPA': 2 };
    const inner = SORTS.find((s) => s.id === sortBy[lane.id]).cmp;
    // Omdömet går före vald sortering: ett KÖP får aldrig hamna under
    // trettio rader man ändå ska skippa.
    rows.sort((a, b) => (rank[a.verdict?.verdict ?? 'VÄNTA'] - rank[b.verdict?.verdict ?? 'VÄNTA']) || inner(a, b));
    return `<section class="lane" data-lane="${lane.id}">
      <div class="lane-head">
        <h2>${lane.label}</h2><span class="n">${rows.length}</span>
        <div class="sorts">${SORTS.map((s) =>
          `<button type="button" data-lane="${lane.id}" data-sort="${s.id}"
             aria-pressed="${sortBy[lane.id] === s.id}">${s.label}</button>`).join('')}</div>
      </div>
      <div class="list">${rows.length
        ? rows.map(rowHtml).join('')
        : `<p class="lane-empty">${esc(snap.status.empty ? (snap.status.detail ?? 'Inget arkiv att spela upp.') : lane.empty)}</p>`}</div>
    </section>`;
  }).join('');

  bind();
  if (openMint) refreshDrawer();
}

function rowHtml(t) {
  const a = avatar(t.mint, t.symbol);
  const m = t.metrics;
  const mc = m.marketCapSol || t.launchMarketCapSol;
  const fresh = !seen.has(t.mint);
  seen.add(t.mint);
  // En token utan prenumeration har inget uppmätt flöde. Att visa 0 vore ett
  // påstående vi inte kan göra — skillnaden mellan "ingen köper" och "vi
  // lyssnar inte" är hela poängen.
  const live = t.tracking || m.totalTrades > 0;

  const v = t.verdict ?? { verdict: 'VÄNTA', reason: '', missing: [] };
  const vcls = v.verdict === 'KÖP' ? 'buy' : v.verdict === 'SKIPPA' ? 'skip' : 'wait';

  const pills = [];
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
    `<div class="curve"><div class="track"><i class="${p > 0.8 ? 'hi' : ''}" style="width:${(p * 100).toFixed(1)}%"></i></div><span>${(p * 100).toFixed(0)}%</span></div>`;

  const thumb = t.meta?.image
    ? `<span class="thumb"><img src="${esc(t.meta.image)}" alt="" loading="lazy"
         onerror="this.parentNode.style.background='${a.bg}';this.parentNode.textContent='${esc(a.txt)}'"></span>`
    : `<span class="thumb" style="background:${a.bg}">${esc(a.txt)}</span>`;

  // pump.fun:s radordning: skapare + ålder, market cap, namn (TICKER), beskrivning.
  return `<button type="button" class="row${fresh ? ' fresh' : ''} ${vcls === 'buy' ? 'is-buy' : vcls === 'skip' ? 'is-skip' : ''}"
      data-mint="${esc(t.mint)}" aria-selected="${t.mint === openMint}">
    ${thumb}
    <span class="body">
      <span class="by">skapad av <b>${esc((t.creator ?? '?').slice(0, 8))}</b> · <span class="age" data-age="${t.ageSec}">${ageText(t.ageSec)}</span></span>
      <span class="mcap"><i>market cap</i> ${fmt(mc, 1)} SOL ${live
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
    <span class="vd ${vcls}">${v.verdict}${v.verdict === 'VÄNTA' && v.missing.length ? `<small>${v.missing.length} saknas</small>` : ''}</span>
  </button>`;
}

/**
 * Kopiering som fungerar även där clipboard-API:t är avstängt.
 *
 * `navigator.clipboard` kräver säker kontext och tillåtelse, och saknas i en
 * sandlådad iframe. Utan fallback ser knappen ut att fungera medan ingenting
 * hamnar i urklipp — det värsta felläget, eftersom man klistrar in fel adress
 * i en handelsapp och märker det först efteråt.
 */
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* faller igenom */ }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Öppnar en länk, och faller tillbaka på att kopiera adressen när
 * popup-fönster är blockerade (vilket de är i en sandlådad iframe).
 */
async function openOrCopy(url, el) {
  const win = window.open(url, '_blank', 'noopener');
  if (win) return;
  const ok = await copyText(url);
  flash(el, ok ? 'LÄNK KOPIERAD' : 'BLOCKERAD');
}

function flash(el, text) {
  if (!el) return;
  const original = el.textContent;
  el.textContent = text;
  el.classList.add('done');
  setTimeout(() => { el.textContent = original; el.classList.remove('done'); }, 1400);
}

function bind() {
  document.querySelectorAll('.lane-head button').forEach((b) => {
    b.addEventListener('click', () => { sortBy[b.dataset.lane] = b.dataset.sort; render(); });
  });
  document.querySelectorAll('.row').forEach((el) => {
    el.addEventListener('click', async (e) => {
      const cp = e.target.closest('[data-copy]');
      if (cp) {
        e.preventDefault();
        e.stopPropagation();
        flash(cp, (await copyText(cp.dataset.copy)) ? 'KOPIERAD' : 'MISSLYCKADES');
        return;
      }

      const link = e.target.closest('a');
      if (link) {
        e.preventDefault();
        e.stopPropagation();
        await openOrCopy(link.href, link);
        return;
      }
      openMint = el.dataset.mint;
      refreshDrawer(true);
    });
  });
}

/* Åldrarna tickar mellan serveruppdateringarna. */
setInterval(() => {
  document.querySelectorAll('.age').forEach((el) => {
    const s = Number(el.dataset.age) + 1;
    el.dataset.age = s;
    el.textContent = ageText(s);
  });
}, 1000);

/* ---------- lådan ---------- */
async function refreshDrawer(open = false) {
  if (!openMint) return;
  const res = await fetch(`/api/detail?mint=${encodeURIComponent(openMint)}`);
  const d = await res.json();
  if (d.error) { closeDrawer(); return; }

  const a = avatar(d.mint, d.symbol);
  const m = d.metrics;
  const pf = d.preflight;
  const meta = d.meta;

  const authRow = pf
    ? `<dd class="${pf.checks.authority?.state === 'pass' ? 'ok' : pf.checks.authority?.state === 'fail' ? 'bad' : 'unk'}">${esc(pf.checks.authority?.detail ?? pf.state)}</dd>`
    : '<dd class="unk">ej körd</dd>';

  const socials = meta
    ? [meta.twitter && ['X', meta.twitter], meta.telegram && ['TG', meta.telegram], meta.website && ['WEB', meta.website]]
        .filter(Boolean)
        .map(([l, u]) => `<a class="pill info" href="${esc(u)}" target="_blank" rel="noopener">${l}</a>`).join(' ')
    : '';

  $('drawer').innerHTML = `
    <div class="dhead">
      ${meta?.image
        ? `<img class="ava" src="${esc(meta.image)}" alt="" style="object-fit:cover" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ava',style:'background:${a.bg}',textContent:'${esc(a.txt)}'}))">`
        : `<span class="ava" style="background:${a.bg}">${esc(a.txt)}</span>`}
      <span><b>$${esc(d.symbol || '?')}</b><br><span>${esc(d.name || '')}</span></span>
      <button type="button" class="dclose" id="dclose" aria-label="Stäng">×</button>
    </div>

    ${d.verdict ? `<div class="sect" style="text-align:center">
      <div class="vd ${d.verdict.verdict === 'KÖP' ? 'buy' : d.verdict.verdict === 'SKIPPA' ? 'skip' : 'wait'}"
           style="width:100%;font-size:19px;padding:13px 0">${d.verdict.verdict}</div>
      <p class="note" style="margin-top:9px">${esc(d.verdict.reason)}</p>
      ${d.verdict.missing?.length ? `<p class="note" style="color:var(--amber)">Saknas: ${d.verdict.missing.map(esc).join(', ')}</p>` : ''}
    </div>` : ''}
    ${meta?.description ? `<p class="note" style="margin-bottom:10px">${esc(meta.description)}</p>` : ''}
    ${socials ? `<div class="pills" style="margin-bottom:12px">${socials}</div>` : ''}

    <div class="addr">${esc(d.mint)}</div>

    <div class="sect">
      <h3>Marknad</h3>
      ${sparkline(d.series)}
      <dl class="kv" style="margin-top:10px">
        <div class="r"><dt>Market cap</dt><dd>${fmt(m.marketCapSol || d.launchMarketCapSol, 2)} SOL</dd></div>
        <div class="r"><dt>Kurva</dt><dd>${d.curveProgress === null ? '<span class="unk">okänd</span>' : `${(d.curveProgress * 100).toFixed(1)} %`}</dd></div>
        <div class="r"><dt>Köpare 60s</dt><dd>${m.uniqueBuyers} mot ${m.uniqueSellers} säljare</dd></div>
        <div class="r"><dt>Netto 60s</dt><dd class="${m.netSol > 0 ? 'ok' : 'bad'}">${m.netSol >= 0 ? '+' : ''}${fmt(m.netSol, 3)} SOL</dd></div>
        <div class="r"><dt>Största order</dt><dd>${(m.largestBuyShare * 100).toFixed(0)} % av köpvolymen</dd></div>
      </dl>
    </div>

    <div class="sect">
      <h3>Risk</h3>
      <dl class="kv">
        <div class="r"><dt>Authority</dt>${authRow}</div>
        <div class="r"><dt>Topp 10</dt><dd class="${d.holders && !d.holders.unknown ? (d.holders.topHolderPct > 60 ? 'bad' : 'ok') : 'unk'}">${
          d.holders && !d.holders.unknown ? `${fmt(d.holders.topHolderPct, 1)} %` : 'okänd'}</dd></div>
        <div class="r"><dt>Dev tog</dt><dd>${d.creatorOpeningShare !== null ? `${fmt(d.creatorOpeningShare, 2)} % · ${fmt(d.creatorInitialSol, 2)} SOL` : '<span class="unk">okänd</span>'}</dd></div>
        <div class="r"><dt>Tidiga ur</dt><dd>${d.earlyExits} av de första köparna</dd></div>
        <div class="r"><dt>Creator</dt><dd>${esc((d.creator ?? '—').slice(0, 20))}</dd></div>
        <div class="r"><dt>Historik</dt><dd>${d.reputation?.known
          ? `${d.reputation.graduations}/${d.reputation.settledLaunches} graduerade`
          : '<span class="unk">ingen avgjord launch</span>'}</dd></div>
      </dl>
    </div>

    <div class="sect">
      <h3>Största innehavare</h3>
      ${d.holders && !d.holders.unknown
        ? `<div class="hold">${d.holders.top.slice(0, 8).map((h) =>
            `<div><span>${esc(h.address.slice(0, 16))}…</span><b>${fmt(h.pct, 1)} %</b></div>`).join('')}</div>`
        : `<p class="note">${esc(d.holders?.reason ?? 'ej hämtad')}</p>`}
    </div>

    <div class="sect">
      <h3>Senaste affärer</h3>
      ${d.tape?.length
        ? `<div class="hold">${d.tape.slice(0, 14).map((t) =>
            `<div><span style="color:${t.side === 'buy' ? 'var(--green)' : 'var(--red)'}">${t.side === 'buy' ? 'KÖP ' : 'SÄLJ'} ${esc(t.wallet.slice(0, 10))}…</span><b>${fmt(t.sol, 3)}</b></div>`).join('')}</div>`
        : '<p class="note">Inga affärer ännu — token spåras först när den kvalificerat sig.</p>'}
    </div>

    <a class="dgo ${d.verdict?.verdict === 'KÖP' ? '' : 'muted'}" href="https://pump.fun/coin/${esc(d.mint)}"
       target="_blank" rel="noopener">${d.verdict?.verdict === 'KÖP' ? 'KÖP PÅ PUMP.FUN ↗' : 'ÖPPNA PÅ PUMP.FUN ↗'}</a>`;

  $('drawer').hidden = false;
  $('scrim').hidden = false;
  $('dclose').addEventListener('click', closeDrawer);
  $('drawer').querySelectorAll('a[href]').forEach((el) => {
    el.addEventListener('click', async (ev) => { ev.preventDefault(); await openOrCopy(el.href, el); });
  });
  if (open) $('drawer').scrollTop = 0;
}

/**
 * Prisgraf ur marknadsvärdesserien. Skalan sätts av serien själv, och
 * etiketterna namnger värden grafen faktiskt når.
 */
function sparkline(series) {
  if (!series || series.length < 2) return '<p class="note">För få datapunkter för en graf.</p>';
  const W = 380, H = 90, pad = 4;
  const vals = series.map((p) => p.mc);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x = (i) => pad + (i / (series.length - 1)) * (W - pad * 2);
  const y = (v) => H - pad - ((v - lo) / span) * (H - pad * 2 - 12);

  const line = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.mc).toFixed(1)}`).join(' ');
  const area = `${line} L${x(series.length - 1).toFixed(1)} ${H - pad} L${x(0).toFixed(1)} ${H - pad} Z`;
  const up = vals.at(-1) >= vals[0];
  const c = up ? 'var(--green)' : 'var(--red)';

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Marknadsvärde över tid">
    <path d="${area}" fill="${c}" opacity=".1"/>
    <path d="${line}" fill="none" stroke="${c}" stroke-width="1.6" stroke-linejoin="round"/>
    <circle cx="${x(series.length - 1).toFixed(1)}" cy="${y(vals.at(-1)).toFixed(1)}" r="2.6" fill="${c}"/>
    <text x="${pad}" y="11" fill="var(--faint)" font-family="var(--mono)" font-size="9">${hi.toFixed(1)}</text>
    <text x="${pad}" y="${H - 1}" fill="var(--faint)" font-family="var(--mono)" font-size="9">${lo.toFixed(1)}</text>
  </svg>`;
}

function closeDrawer() {
  openMint = null;
  $('drawer').hidden = true;
  $('scrim').hidden = true;
  render();
}
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
