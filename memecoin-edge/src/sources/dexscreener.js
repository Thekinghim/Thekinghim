/**
 * DexScreener — gratis, ingen nyckel.
 *
 * Vi använder den inte för att hitta tokens. Vi använder den för att mäta
 * **uppmärksamhet**: vem som betalar för synlighet och vem som redan hunnit
 * fylla i sina sociala länkar.
 *
 * Det är en ovanlig användning. De flesta verktyg läser DexScreener för att
 * hitta det som trendar — alltså det som redan har uppmärksamhet. Vi läser
 * samma data för att kunna sortera bort det.
 *
 * Takgränser (docs.dexscreener.com/api/reference):
 *   /token-boosts/*, /token-profiles/*  60 anrop/min
 *   /latest/dex/*                       300 anrop/min
 */
import { getJson, RateLimiter } from './http.js';

const BASE = 'https://api.dexscreener.com';
const attentionLimiter = new RateLimiter(60);
const pairLimiter = new RateLimiter(300);

/** Tokens som just nu köper synlighet. Returnerar Map: adress → boostbelopp. */
export async function fetchBoostedTokens() {
  const [latest, top] = await Promise.all([
    getJson(`${BASE}/token-boosts/latest/v1`, { limiter: attentionLimiter, label: 'dex/boosts-latest' }),
    getJson(`${BASE}/token-boosts/top/v1`, { limiter: attentionLimiter, label: 'dex/boosts-top' }),
  ]);

  const map = new Map();
  for (const entry of [...asArray(latest), ...asArray(top)]) {
    if (entry?.chainId !== 'solana' || !entry.tokenAddress) continue;
    const amount = Number(entry.totalAmount ?? entry.amount ?? 0);
    map.set(entry.tokenAddress, Math.max(map.get(entry.tokenAddress) ?? 0, amount));
  }
  return map;
}

/** Tokens som fyllt i profil (ikon, beskrivning, sociala länkar). Map: adress → antal länkar. */
export async function fetchTokenProfiles() {
  const body = await getJson(`${BASE}/token-profiles/latest/v1`, {
    limiter: attentionLimiter,
    label: 'dex/profiles',
  });
  const map = new Map();
  for (const entry of asArray(body)) {
    if (entry?.chainId !== 'solana' || !entry.tokenAddress) continue;
    map.set(entry.tokenAddress, (entry.links ?? []).length + (entry.description ? 1 : 0));
  }
  return map;
}

/**
 * Pardata för upp till 30 mints i ett anrop. Ger likviditet, ålder och
 * köp/sälj-räknare som komplement till Jupiter.
 */
export async function fetchPairs(mints) {
  if (mints.length === 0) return new Map();
  const body = await getJson(`${BASE}/latest/dex/tokens/${mints.slice(0, 30).join(',')}`, {
    limiter: pairLimiter,
    label: 'dex/tokens',
  });

  const map = new Map();
  for (const pair of asArray(body?.pairs)) {
    const address = pair?.baseToken?.address;
    if (!address) continue;
    // En token kan ha flera pooler. Den djupaste är den som sätter priset
    // och den enda du realistiskt kan handla i.
    const existing = map.get(address);
    const liquidity = Number(pair.liquidity?.usd ?? 0);
    if (existing && existing.liquidityUsd >= liquidity) continue;

    map.set(address, {
      pairAddress: pair.pairAddress,
      dexId: pair.dexId,
      url: pair.url,
      priceUsd: Number(pair.priceUsd ?? 0) || null,
      liquidityUsd: liquidity,
      fdv: Number(pair.fdv ?? 0) || null,
      pairCreatedAt: Number(pair.pairCreatedAt ?? 0) || null,
      txns: pair.txns ?? {},
      volume: pair.volume ?? {},
      priceChange: pair.priceChange ?? {},
      boostsActive: Number(pair.boosts?.active ?? 0),
      socialCount: (pair.info?.socials?.length ?? 0) + (pair.info?.websites?.length ?? 0),
      hasImage: Boolean(pair.info?.imageUrl),
    });
  }
  return map;
}

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);
