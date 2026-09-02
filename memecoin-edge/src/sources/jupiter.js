/**
 * Jupiter Token API v2 — gratis, ingen nyckel på `lite-api`-värden.
 *
 * Den här källan bär nästan hela verktyget, av två skäl:
 *
 * 1. Den ger säkerhetsdatan direkt: mint- och freeze-authority, andel hos
 *    de största innehavarna, antal innehavare. Det är kontroller som annars
 *    kräver egna RPC-anrop mot en betald nod.
 *
 * 2. Den ger `organicScore` och `numOrganicBuyers` — Jupiters egen
 *    uppskattning av hur mycket av aktiviteten som inte är wash trading.
 *    Att få den beräkningen gratis är den enskilt största anledningen till
 *    att en privatperson kan bygga något vettigt utan datalicens.
 *
 * Endpoints: https://dev.jup.ag/docs/tokens/v2
 */
import { getJson, RateLimiter } from './http.js';

const BASE = process.env.JUPITER_BASE ?? 'https://lite-api.jup.ag';

// Gratisnivån tål 60 anrop/minut. `api.jup.ag` är snabbare men kräver nyckel.
const limiter = new RateLimiter(60);

/** Nyligen skapade tokens med fullständig statistik. Vår upptäcktskälla. */
export async function fetchRecent() {
  const body = await getJson(`${BASE}/tokens/v2/recent`, { limiter, label: 'jupiter/recent' });
  return normalizeList(body);
}

/** Slår upp specifika mints (kommaseparerat, max 100 per anrop). */
export async function fetchTokens(mints) {
  if (mints.length === 0) return [];
  const query = mints.slice(0, 100).join(',');
  const body = await getJson(`${BASE}/tokens/v2/search?query=${query}`, {
    limiter,
    label: 'jupiter/search',
  });
  return normalizeList(body);
}

/** Svaret kommer ibland som array, ibland inbäddat. Tål båda. */
function normalizeList(body) {
  const list = Array.isArray(body) ? body : (body?.tokens ?? body?.data ?? []);
  return list.map(normalizeToken).filter(Boolean);
}

/**
 * Plattar ut Jupiters svar till vår interna form.
 *
 * Saknade fält blir `null`, aldrig 0. Skillnaden är avgörande: 0 organiska
 * köpare betyder "ingen köper", null betyder "vi vet inte". Det första är
 * en signal, det andra ska diskvalificera token från beslut.
 */
export function normalizeToken(raw) {
  if (!raw?.id) return null;
  const audit = raw.audit ?? {};
  const s5 = raw.stats5m ?? {};
  const s1h = raw.stats1h ?? {};

  return {
    address: raw.id,
    symbol: raw.symbol ?? raw.id.slice(0, 6),
    name: raw.name ?? '',
    chain: 'solana',
    decimals: raw.decimals,
    firstPool: raw.firstPool ?? null,
    createdAt: raw.firstPool?.createdAt ? Date.parse(raw.firstPool.createdAt) : null,

    // Säkerhet. `!== false` betyder att ett saknat fält räknas som "ej
    // avstängd" — fail closed, samma princip som resten av verktyget.
    mintAuthorityActive: audit.mintAuthorityDisabled !== true,
    freezeAuthorityActive: audit.freezeAuthorityDisabled !== true,
    topHolderPct: num(audit.topHoldersPercentage),
    devHoldingPct: num(audit.devBalancePercentage),
    lpLockedPct: num(audit.lpBurnedPercentage),
    isVerified: raw.isVerified === true,

    holderCount: num(raw.holderCount),
    organicScore: num(raw.organicScore),
    organicScoreLabel: raw.organicScoreLabel ?? null,
    liquidityUsd: num(raw.liquidity),
    priceUsd: num(raw.usdPrice ?? raw.price),
    fdv: num(raw.fdv ?? raw.mcap),

    stats5m: normalizeStats(s5),
    stats1h: normalizeStats(s1h),
    raw,
  };
}

function normalizeStats(s) {
  return {
    priceChange: num(s.priceChange),
    holderChange: num(s.holderChange),
    liquidityChange: num(s.liquidityChange),
    buyVolume: num(s.buyVolume),
    sellVolume: num(s.sellVolume),
    buyOrganicVolume: num(s.buyOrganicVolume),
    sellOrganicVolume: num(s.sellOrganicVolume),
    numBuys: num(s.numBuys),
    numSells: num(s.numSells),
    numTraders: num(s.numTraders),
    numOrganicBuyers: num(s.numOrganicBuyers),
    numNetBuyers: num(s.numNetBuyers),
  };
}

/** null för saknat värde, aldrig 0 — se kommentaren i normalizeToken. */
const num = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
