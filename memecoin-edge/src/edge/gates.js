/**
 * Hårda grindar för Solana, mot verklig Jupiter-data.
 *
 * Skiljer sig från `src/safety/rules.js` på en avgörande punkt: den här
 * uppsättningen vet vilka fält som faktiskt går att hämta gratis, och har
 * en egen grind för det som *inte* går att veta. "Vi vet inte" är ett
 * giltigt skäl att inte handla, och det är den vanligaste orsaken till
 * avslag i praktiken.
 */

/** Standard SPL Token. Token-2022 kan bära transfer hooks som blockerar sälj. */
const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export const solanaGateConfig = {
  maxTopHolderPct: 45,
  minLiquidityUsd: 12_000,
  minHolderCount: 60,
  minLpBurnedPct: 50,
};

const pass = (id, reason) => ({ id, passed: true, reason });
const fail = (id, reason) => ({ id, passed: false, reason });

/**
 * @param {*} t Normaliserad Jupiter-token.
 * @param {typeof solanaGateConfig} [cfg]
 */
export function evaluateSolanaGates(t, cfg = solanaGateConfig) {
  const gates = [];

  gates.push(
    t.mintAuthorityActive
      ? fail('mint_authority', 'Mint authority ej återkallad — supply kan spädas ut')
      : pass('mint_authority', 'Mint authority återkallad'),
  );

  gates.push(
    t.freezeAuthorityActive
      ? fail('freeze_authority', 'Freeze authority ej återkallad — din wallet kan frysas')
      : pass('freeze_authority', 'Freeze authority återkallad'),
  );

  const program = t.raw?.tokenProgram;
  gates.push(
    program && program !== SPL_TOKEN_PROGRAM && !t.isVerified
      ? fail('token_program', 'Token-2022 utan verifiering — transfer hooks kan blockera sälj')
      : pass('token_program', 'Standard SPL Token'),
  );

  // Saknad data är inte neutral. Kan vi inte se koncentrationen kan vi inte
  // heller utesluta att en wallet äger allt.
  if (t.topHolderPct === null) {
    gates.push(fail('holder_data', 'Innehavarfördelning saknas i datan'));
  } else if (t.topHolderPct > cfg.maxTopHolderPct) {
    gates.push(fail('holder_concentration', `Topp-innehavare äger ${t.topHolderPct.toFixed(0)} %`));
  } else {
    gates.push(pass('holder_concentration', `Topp-innehavare äger ${t.topHolderPct.toFixed(0)} %`));
  }

  // LP-lås rapporteras inte alltid. Saknas fältet accepterar vi det bara
  // om poolen är djup nog att en dragning skulle synas i likviditeten.
  if (t.lpLockedPct !== null && t.lpLockedPct < cfg.minLpBurnedPct) {
    gates.push(fail('lp_locked', `Endast ${t.lpLockedPct.toFixed(0)} % av LP bränd`));
  } else {
    gates.push(pass('lp_locked', t.lpLockedPct === null ? 'LP-status okänd' : `${t.lpLockedPct.toFixed(0)} % av LP bränd`));
  }

  const liquidity = t.liquidityUsd ?? 0;
  gates.push(
    liquidity < cfg.minLiquidityUsd
      ? fail('liquidity_floor', `Likviditet $${Math.round(liquidity).toLocaleString('sv-SE')} under golvet`)
      : pass('liquidity_floor', `Likviditet $${Math.round(liquidity).toLocaleString('sv-SE')}`),
  );

  gates.push(
    (t.holderCount ?? 0) < cfg.minHolderCount
      ? fail('holder_floor', `Endast ${t.holderCount ?? 0} innehavare`)
      : pass('holder_floor', `${t.holderCount.toLocaleString('sv-SE')} innehavare`),
  );

  // Utan färsk femminutersstatistik finns inget att bedöma traktion på.
  gates.push(
    t.stats5m?.numOrganicBuyers === null || t.stats5m?.numBuys === null
      ? fail('stats_data', 'Femminutersstatistik saknas')
      : pass('stats_data', 'Statistik komplett'),
  );

  return { passed: gates.every((g) => g.passed), gates, failed: gates.filter((g) => !g.passed) };
}
