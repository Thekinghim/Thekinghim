import { saturate, logistic } from '../util/stats.js';
import { config as defaultConfig } from '../config.js';

/**
 * Momentumscoring för tidig fas.
 *
 * Medvetet val: ingen komponent tittar på volym i USD. Volym är det enklaste
 * måttet att förfalska — en wallet kan wash-tradea fram vilken volymkurva som
 * helst för kostnaden av avgifterna. Unika köpare, innehavartillväxt och
 * accelererande nettoinflöde kostar däremot riktiga wallets och riktigt
 * kapital att förfalska, och det är där signalen sitter.
 *
 * @param {ReturnType<import('./window.js').TradeWindow['metrics']>} m
 * @param {typeof defaultConfig} [cfg]
 * @returns {import('../types.js').MomentumVerdict}
 */
export function scoreMomentum(m, cfg = defaultConfig) {
  const w = cfg.momentum.weights;

  // Nettoinflödets acceleration: senaste halvan av fönstret mot den tidigare.
  // Ett flöde som planar ut är slutet på rörelsen, inte början.
  const accel =
    m.netFlowEarlier > 0
      ? m.netFlowRecent / m.netFlowEarlier
      : m.netFlowRecent > 0
        ? 2
        : 0;

  const components = [
    {
      id: 'uniqueBuyerVelocity',
      value: saturate(m.uniqueBuyersPerMin, 12),
      weight: w.uniqueBuyerVelocity,
      detail: `${m.uniqueBuyersPerMin.toFixed(1)} unika köpare/min`,
    },
    {
      id: 'buyerSellerRatio',
      value: logistic(m.buyerSellerRatio, 1.8, 1.2),
      weight: w.buyerSellerRatio,
      detail: `${m.uniqueBuyers} köpare / ${m.uniqueSellers} säljare`,
    },
    {
      id: 'netInflowAcceleration',
      value: m.netFlowUsd <= 0 ? 0 : saturate(accel, 2.5),
      weight: w.netInflowAcceleration,
      detail:
        m.netFlowUsd <= 0
          ? 'Nettoutflöde'
          : `Inflöde ×${accel.toFixed(2)} mot föregående halva`,
    },
    {
      id: 'holderGrowth',
      value: saturate(m.holderGrowthPerMin, 8),
      weight: w.holderGrowth,
      detail: `+${m.holderGrowthPerMin.toFixed(1)} innehavare/min`,
    },
    {
      id: 'smartMoney',
      value: saturate(m.smartMoneyBuyers, 3),
      weight: w.smartMoney,
      detail: `${m.smartMoneyBuyers} wallets från PnL-listan köper`,
    },
    {
      id: 'buyerDispersion',
      // Inverterat: låg koncentration i köpflödet är det positiva.
      value: 1 - saturate(m.largestBuyShare, 0.6),
      weight: w.buyerDispersion,
      detail: `Största köparen står för ${Math.round(m.largestBuyShare * 100)} % av köpvolymen`,
    },
  ];

  const total = components.reduce((sum, c) => sum + c.value * c.weight, 0);
  const maxPossible = components.reduce((sum, c) => sum + c.weight, 0);

  return {
    score: Math.round((total / maxPossible) * 1000) / 10,
    factors: components.map((c) => ({
      id: c.id,
      points: Math.round(c.value * c.weight * 10) / 10,
      detail: c.detail,
    })),
    metrics: m,
  };
}
