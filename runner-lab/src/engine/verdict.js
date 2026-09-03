import { config } from '../config.js';

/**
 * Ett svar per token: KÖP, VÄNTA eller SKIPPA.
 *
 * Regeln som håller ihop det hela: **okänt blir aldrig KÖP.** Saknas en
 * kontroll är svaret VÄNTA, inte ett antagande åt något håll. Det är
 * skillnaden mellan ett verktyg man kan lita på och ett som ser säkert ut.
 *
 * SKIPPA vinner alltid över KÖP. Ett enda diskvalificerande fynd räcker,
 * hur bra allt annat än ser ut — det finns inget pris som gör en token med
 * aktiv mint authority köpbar.
 */

export const RULES = {
  /** Diskvalificerande. Ett utslag räcker. */
  maxTopHolderPct: 60,
  /**
   * Andel av supplyn som köptes innan någon hann reagera, dev inräknad.
   * Över en fjärdedel äger en aktör marknaden oavsett vad topp-10 säger.
   */
  maxBundleShare: 0.25,
  maxDevOpeningPct: 15,
  maxEarlyExits: 4,
  /** Krav för KÖP. Alla måste vara uppfyllda. */
  buy: {
    maxTopHolderPct: 45,
    maxDevOpeningPct: 8,
    minUniqueBuyers: 12,
    minNetSol: 0.5,
    minCurveProgress: 0.06,
  },
};

/**
 * @param {*} row En rad från Radar.board().
 * @returns {{verdict:'KÖP'|'VÄNTA'|'SKIPPA', reason:string, missing:string[]}}
 */
export function verdictFor(row) {
  const m = row.metrics;
  const pf = row.preflight;
  const holders = row.holders;
  const dev = row.creatorOpeningShare;

  // ---- Diskvalificerande ----
  // Deployern som säljer sin egen token står först. Det är den enda signalen
  // som inte kräver någon tolkning alls: samma wallet som skapade token
  // lämnar den. Allt annat på listan är sannolikheter; det här är ett faktum.
  if (row.devSells > 0) {
    return {
      verdict: 'SKIPPA',
      reason: `dev har sålt ${row.devSoldSol.toFixed(2)} SOL av sin egen token`,
      missing: [],
    };
  }
  if (pf?.checks?.authority?.state === 'fail') {
    return { verdict: 'SKIPPA', reason: pf.checks.authority.detail, missing: [] };
  }
  if (row.bundle && row.bundle.bundleShare > RULES.maxBundleShare) {
    return {
      verdict: 'SKIPPA',
      reason: `bundlat ${(row.bundle.bundleShare * 100).toFixed(0)} % av supplyn i öppningen`,
      missing: [],
    };
  }
  if (holders && !holders.unknown && holders.topHolderPct > RULES.maxTopHolderPct) {
    return { verdict: 'SKIPPA', reason: `topp 10 äger ${holders.topHolderPct.toFixed(0)} %`, missing: [] };
  }
  if (dev !== null && dev > RULES.maxDevOpeningPct) {
    return { verdict: 'SKIPPA', reason: `dev tog ${dev.toFixed(0)} % i öppningen`, missing: [] };
  }
  if (row.flowReversed) {
    return { verdict: 'SKIPPA', reason: 'nettoflödet har vänt negativt', missing: [] };
  }
  if (row.earlyExits > RULES.maxEarlyExits) {
    return { verdict: 'SKIPPA', reason: `${row.earlyExits} av de första köparna har gått ur`, missing: [] };
  }
  if (row.probeExpired && !row.qualified) {
    return { verdict: 'SKIPPA', reason: 'ingen traktion inom probe-fönstret', missing: [] };
  }

  // ---- Vad vi ännu inte vet ----
  const missing = [];
  if (!pf?.checks?.authority) missing.push('authority-kontroll');
  else if (pf.checks.authority.state === 'unknown') missing.push('authority okänd');
  if (!holders || holders.unknown) missing.push('innehavarfördelning');
  // En bundle-andel som bara är en undre gräns duger till att fälla, men
  // aldrig till att fria.
  if (row.bundle?.shareIsLowerBound) missing.push('bundle-andel ofullständig');
  if (dev === null) missing.push('dev-andel');
  if (!row.tracking && m.totalTrades === 0) missing.push('flöde');
  if (missing.length > 0) {
    return { verdict: 'VÄNTA', reason: `saknar ${missing[0]}`, missing };
  }

  // ---- Krav för KÖP ----
  const b = RULES.buy;
  const fails = [];
  if (holders.topHolderPct > b.maxTopHolderPct) fails.push(`topp 10 ${holders.topHolderPct.toFixed(0)} %`);
  if (dev > b.maxDevOpeningPct) fails.push(`dev ${dev.toFixed(1)} %`);
  if (m.uniqueBuyers < b.minUniqueBuyers) fails.push(`${m.uniqueBuyers} köpare`);
  if (row.bundle?.knownSnipers >= 2) fails.push(`${row.bundle.knownSnipers} kända snipers i öppningen`);
  if (row.bundle?.mergedTopHolderPct > b.maxTopHolderPct) {
    fails.push(`sammanslagen topp 10 ${row.bundle.mergedTopHolderPct.toFixed(0)} %`);
  }
  if (m.netSol < b.minNetSol) fails.push(`netto ${m.netSol.toFixed(2)} SOL`);
  if (row.curveProgress !== null && row.curveProgress < b.minCurveProgress) {
    fails.push(`kurva ${(row.curveProgress * 100).toFixed(0)} %`);
  }

  if (fails.length > 0) {
    return { verdict: 'VÄNTA', reason: `under tröskel: ${fails[0]}`, missing: [] };
  }

  return {
    verdict: 'KÖP',
    reason: `${m.uniqueBuyers} köpare · +${m.netSol.toFixed(1)} SOL · dev ${dev.toFixed(1)} %`,
    missing: [],
  };
}
