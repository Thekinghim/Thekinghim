import fs from 'node:fs';
import path from 'node:path';

/**
 * Bundle-detektion — H1 i PLAN.md.
 *
 * Tesen: den råa topp-10-andelen ljuger, eftersom en deployer sprider sitt
 * innehav över flera wallets som köper i samma ögonblick som listningen.
 * Slår man ihop de wallets som köpte innan någon människa hunnit reagera —
 * plus deployern själv — till en enda aktör får man den riktiga
 * koncentrationen. Skillnaden mellan rå och sammanslagen är signalen.
 *
 * Två saker gör det räkningsbart ur strömmen utan extra anrop:
 *
 *   1. Öppningsfönstret. Handlar som landar inom sekunder efter listningen
 *      kommer från bottar, aldrig från människor. Deras tokenmängd är känd.
 *
 *   2. Återkomst. En wallet som är öppningsköpare i token efter token är en
 *      sniper eller en bundlare. Det går bara att se om man spelat in
 *      strömmen — och det har vi. Registret växer för varje listning.
 *
 * pump.fun-tokens har fast supply på en miljard, så tokenmängd delat med
 * SUPPLY är andel av allt som finns.
 */

export const SUPPLY = 1_000_000_000;

/** Hur långt efter listningen en handel räknas som "innan någon hann reagera". */
export const OPENING_WINDOW_MS = Number(process.env.OPENING_WINDOW_MS ?? 3000);

/** Från hur många öppningsköp en wallet räknas som känd sniper. */
export const KNOWN_SNIPER_MIN = 3;

export class SniperRegistry {
  /** @param {{dir: string}} cfg */
  constructor(cfg) {
    this.file = path.join(cfg.dir, 'snipers.ndjson');
    /** @type {Map<string, {n: number, lastMint: string, lastTs: number}>} */
    this.wallets = new Map();
    fs.mkdirSync(cfg.dir, { recursive: true });
    this.#load();
  }

  #load() {
    if (!fs.existsSync(this.file)) return;
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        this.wallets.set(row.wallet, { n: row.n, lastMint: row.lastMint, lastTs: row.lastTs });
      } catch { /* trasig rad ska inte ta ner registret */ }
    }
  }

  /** Bokför att en wallet var öppningsköpare i en token. Räknar varje token en gång. */
  record(wallet, mint, ts = Date.now()) {
    const row = this.wallets.get(wallet);
    if (row?.lastMint === mint) return row.n;
    const next = { n: (row?.n ?? 0) + 1, lastMint: mint, lastTs: ts };
    this.wallets.set(wallet, next);
    fs.appendFileSync(this.file, `${JSON.stringify({ wallet, ...next })}\n`);
    return next.n;
  }

  count(wallet) {
    return this.wallets.get(wallet)?.n ?? 0;
  }

  isKnown(wallet) {
    return this.count(wallet) >= KNOWN_SNIPER_MIN;
  }

  stats() {
    let known = 0;
    for (const r of this.wallets.values()) if (r.n >= KNOWN_SNIPER_MIN) known++;
    return { wallets: this.wallets.size, known };
  }
}

/**
 * Räknar bundle-andelen och den sammanslagna koncentrationen för en token.
 *
 * @param {{creator: string|null, creatorInitialTokens: number,
 *          openingBuyers: {wallet: string, tokens: number, sol: number}[]}} entry
 * @param {SniperRegistry|null} registry
 * @param {{top: {address: string, pct: number}[], topHolderPct: number} | null} holders
 *   Innehavare från RPC, om de hämtats. Adresserna är token-konton, inte
 *   wallets, så de går inte att matcha mot öppningsköparna — men den råa
 *   topp-10-siffran finns där och det är den vi visar deltat mot.
 */
export function analyzeBundle(entry, registry = null, holders = null) {
  const opening = entry.openingBuyers ?? [];

  // Devens öppningsköp är per definition bundlat: det sker i samma
  // transaktion som skapandet.
  const devTokens = entry.creatorInitialTokens ?? 0;

  // En öppningsköpare vars tokenmängd saknas gör hela andelen till en undre
  // gräns. Att räkna den som noll vore att underskatta koncentrationen, och
  // en underskattad bundle-andel är exakt det fel som förvandlar ett SKIPPA
  // till ett KÖP.
  const unknownTokens = opening.filter((b) => b.tokens === null).length;
  const openingTokens = opening.reduce((s, b) => s + (b.tokens ?? 0), 0);
  const bundledTokens = devTokens + openingTokens;
  const bundleShare = bundledTokens / SUPPLY;
  const shareIsLowerBound = unknownTokens > 0;

  const knownSnipers = registry ? opening.filter((b) => registry.isKnown(b.wallet)).length : 0;

  // Identiska belopp i öppningsfönstret är ett skript, inte flera personer.
  // Heuristik 5 i CLAUDE.md: bara som förstärkning, aldrig ensam.
  const sizes = new Map();
  for (const b of opening) {
    const key = b.sol.toFixed(3);
    sizes.set(key, (sizes.get(key) ?? 0) + 1);
  }
  const identicalSized = Math.max(0, ...sizes.values()) >= 3;

  /**
   * Sammanslagen topp-10: den råa siffran från RPC, plus det bundlade
   * innehavet som en enda aktör om det inte redan är det största kontot.
   *
   * Det är en undre gräns på den riktiga koncentrationen — vi kan inte veta
   * vilka RPC-konton som tillhör öppningsköparna, bara att de tillsammans
   * äger minst `bundleShare`. Deltat rapporteras därför som "minst".
   */
  let mergedTopHolderPct = null;
  let delta = null;
  if (holders && !holders.unknown && Number.isFinite(holders.topHolderPct)) {
    const largest = holders.top?.[0]?.pct ?? 0;
    const bundlePct = bundleShare * 100;
    mergedTopHolderPct = Math.min(100, Math.max(holders.topHolderPct, bundlePct + (holders.topHolderPct - largest)));
    delta = Math.max(0, mergedTopHolderPct - holders.topHolderPct);
  }

  return {
    bundleShare,
    shareIsLowerBound,
    unknownTokens,
    bundledTokens,
    openingBuyers: opening.length,
    knownSnipers,
    identicalSized,
    mergedTopHolderPct,
    delta,
  };
}
