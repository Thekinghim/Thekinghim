import { evaluateSolanaGates } from './gates.js';
import { attentionGap } from './attention.js';

/**
 * Omvandlar poäng till ett beslut.
 *
 * En rankad lista är inte ett svar på frågan "vad ska jag köpa". Den här
 * filen tvingar fram de fyra sakerna som faktiskt behövs för att kunna
 * agera: hur mycket, till vilket pris, vad som gör tesen fel, och när du
 * går ur.
 *
 * Exit-stegen är inte pynt. Med en träffprocent runt 25–30 och en
 * fettsvansad fördelning är utgångsregeln värd mer än ingångsregeln: den
 * som tar hem vinsten vid +30 % kapar exakt den svans som betalar för alla
 * förluster. Stegen nedan är byggda för att göra motsatsen — säkra kapitalet
 * tidigt och låta en rest ligga kvar.
 */

export const decisionConfig = {
  /** Riskbudget per dag i din valuta. Positionsstorlekar räknas mot den. */
  dailyRiskBudget: Number(process.env.DAILY_RISK_BUDGET ?? 1000),
  /** Andel av dagsbudgeten en enskild position får ta, per konviktionsnivå. */
  sizeByConviction: { hög: 0.06, medel: 0.035, låg: 0.02 },
  minGapToBuy: 25,
  minTractionToBuy: 55,
  maxAttentionToBuy: 45,
  /** Hård stop i procent från entry. */
  stopLossPct: 35,
  /** Trailing stop på resten, i procent från toppen. */
  trailingPct: 30,
};

/**
 * @param {*} token Normaliserad Jupiter-token.
 * @param {{boostUsd?: number, socialCount?: number, volume1h?: number, liquidityUsd?: number, pair?: any}} context
 * @param {{score: number, note: string} | null} [reputation]
 * @param {typeof decisionConfig} [cfg]
 */
export function decide(token, context = {}, reputation = null, cfg = decisionConfig) {
  const safety = evaluateSolanaGates(token);
  const edge = attentionGap(token, context);

  if (!safety.passed) {
    return {
      token, safety, edge, reputation,
      verdict: 'AVOID',
      headline: safety.failed[0].reason,
      reasons: safety.failed.map((g) => g.reason),
      plan: null,
    };
  }

  // Exit-likviditet är en egen kategori, inte bara "låg poäng". Någon har
  // betalat för att du ska se den här token, och de organiska köparna
  // uteblir. Det är ett aktivt avslag.
  if (edge.quadrant === 'exit_liquidity') {
    return {
      token, safety, edge, reputation,
      verdict: 'AVOID',
      headline: 'Betald synlighet utan organiska köpare — du är utgången',
      reasons: [
        edge.attention.factors.find((f) => f.id === 'paidBoosts').detail,
        edge.traction.factors.find((f) => f.id === 'organicShare').detail,
        edge.traction.factors.find((f) => f.id === 'organicBuyers').detail,
      ],
      plan: null,
    };
  }

  const buyable =
    edge.gap >= cfg.minGapToBuy &&
    edge.traction.score >= cfg.minTractionToBuy &&
    edge.attention.score <= cfg.maxAttentionToBuy;

  if (!buyable) {
    return {
      token, safety, edge, reputation,
      verdict: edge.traction.score >= 40 ? 'WATCH' : 'SKIP',
      headline:
        edge.quadrant === 'crowded'
          ? 'Traktionen finns men uppmärksamheten hann före'
          : `Gap ${edge.gap.toFixed(0)} under tröskeln ${cfg.minGapToBuy}`,
      reasons: topReasons(edge),
      plan: null,
    };
  }

  const conviction = convictionFor(edge, reputation);
  const size = Math.round(cfg.dailyRiskBudget * cfg.sizeByConviction[conviction]);
  const price = token.priceUsd ?? context.pair?.priceUsd ?? null;

  return {
    token, safety, edge, reputation,
    verdict: 'BUY',
    headline: `${edge.quadrant === 'early' ? 'Tidig traktion' : 'Traktion'} före uppmärksamhet — gap ${edge.gap.toFixed(0)}`,
    reasons: topReasons(edge),
    plan: buildPlan({ token, edge, context, conviction, size, price, cfg, reputation }),
  };
}

function convictionFor(edge, reputation) {
  let score = edge.gap;
  // Deployerns historik flyttar konviktionen, aldrig grindarna. En bra
  // historik gör inte en osäker token köpbar — den gör en köpbar token större.
  if (reputation) score += reputation.score;
  if (score >= 55 && edge.traction.score >= 70) return 'hög';
  if (score >= 35) return 'medel';
  return 'låg';
}

function buildPlan({ token, edge, context, conviction, size, price, cfg, reputation }) {
  const liquidity = context.liquidityUsd ?? token.liquidityUsd ?? 0;
  // Positionen får inte vara så stor att din egen sälj flyttar priset.
  // 0,5 % av poolen är en försiktig gräns på tunna memecoin-pooler.
  const liquidityCap = Math.round(liquidity * 0.005);
  const finalSize = Math.min(size, liquidityCap || size);

  const organic5m = token.stats5m?.numOrganicBuyers ?? 0;

  return {
    conviction,
    sizeUsd: finalSize,
    sizeCappedByLiquidity: finalSize < size,
    entry: {
      type: 'marknad',
      note: `Dela i två delar. Halva nu, halva om ${Math.round(organic5m * 0.6)} organiska köpare/5 min håller i sig nästa avläsning.`,
      priceUsd: price,
    },
    // Konkret, observerbart, och kontrollerbart i samma data vi redan hämtar.
    invalidation: [
      `Organiska köpare / 5 min faller under ${Math.max(5, Math.round(organic5m * 0.35))}`,
      `Likviditeten faller under $${Math.round(liquidity * 0.7).toLocaleString('sv-SE')}`,
      `Topp-innehavare stiger över ${Math.min(60, Math.round((token.topHolderPct ?? 30) + 12))} %`,
      'Boosts dyker upp innan priset rört sig — då köpte någon annan uppmärksamheten, inte marknaden',
    ],
    exit: {
      ladder: [
        { at: '2×', sell: '50 %', why: 'insatsen hem — resten är gratis' },
        { at: '4×', sell: '25 %', why: 'säkrar vinsten utan att stänga svansen' },
        { at: 'trailing', sell: '25 %', why: `ligger kvar tills −${cfg.trailingPct} % från toppen` },
      ],
      hardStopPct: cfg.stopLossPct,
      timeStop:
        'Ur efter 45 min om gapet fallit under 10 och positionen inte är i vinst — tesen var fel, inte tidig.',
    },
    reputationNote: reputation?.note ?? 'Deployern är ny för verktyget — ingen historik ännu.',
  };
}

function topReasons(edge) {
  const up = [...edge.traction.factors].sort((a, b) => b.points - a.points).slice(0, 3);
  const down = [...edge.attention.factors].sort((a, b) => a.points - b.points).slice(0, 2);
  return [...up.map((f) => f.detail), ...down.map((f) => f.detail)];
}
