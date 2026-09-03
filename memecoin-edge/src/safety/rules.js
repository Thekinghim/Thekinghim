/**
 * Hårda grindar mot rug pulls.
 *
 * Varje regel svarar på en fråga av typen "kan utgivaren ta mina pengar utan
 * att sälja på marknaden?". Är svaret ja finns ingen prissättning som gör
 * positionen vettig, så det här är binära avslag — inte poängavdrag.
 */

/** @typedef {import('../types.js').TokenMeta} TokenMeta */
/** @typedef {import('../types.js').GateResult} GateResult */

/**
 * @typedef {Object} Gate
 * @property {string} id
 * @property {string} label
 * @property {(meta: TokenMeta, cfg: any) => GateResult} check
 */

const pass = (id, reason) => ({ id, passed: true, reason });
const fail = (id, reason) => ({ id, passed: false, reason });

/** @type {Gate[]} */
export const gates = [
  {
    id: 'mint_authority',
    label: 'Mint authority återkallad',
    check: (m) =>
      m.mintAuthorityActive
        ? fail('mint_authority', 'Mint authority är aktiv — supply kan spädas ut när som helst')
        : pass('mint_authority', 'Mint authority återkallad'),
  },
  {
    id: 'freeze_authority',
    label: 'Freeze authority återkallad',
    check: (m) =>
      m.freezeAuthorityActive
        ? fail('freeze_authority', 'Freeze authority är aktiv — din wallet kan frysas så att du inte kan sälja')
        : pass('freeze_authority', 'Freeze authority återkallad'),
  },
  {
    id: 'lp_locked',
    label: 'LP bränd eller låst',
    check: (m, cfg) =>
      m.lpLockedPct < cfg.gates.minLpLockedPct
        ? fail('lp_locked', `Endast ${m.lpLockedPct.toFixed(0)} % av LP är låst (kräver ${cfg.gates.minLpLockedPct} %) — poolen kan dras`)
        : pass('lp_locked', `${m.lpLockedPct.toFixed(0)} % av LP bränd/låst`),
  },
  {
    id: 'sell_simulation',
    label: 'Sälj går igenom',
    check: (m) =>
      m.sellSimulationOk
        ? pass('sell_simulation', 'Simulerad sälj lyckades')
        : fail('sell_simulation', 'Simulerad sälj misslyckades — honeypot'),
  },
  {
    id: 'tax',
    label: 'Rimlig skatt',
    check: (m, cfg) => {
      if (m.sellTaxBps > cfg.gates.maxSellTaxBps)
        return fail('tax', `Säljskatt ${(m.sellTaxBps / 100).toFixed(1)} % överstiger taket`);
      if (m.buyTaxBps > cfg.gates.maxBuyTaxBps)
        return fail('tax', `Köpskatt ${(m.buyTaxBps / 100).toFixed(1)} % överstiger taket`);
      return pass('tax', `Skatt ${(m.buyTaxBps / 100).toFixed(1)} / ${(m.sellTaxBps / 100).toFixed(1)} %`);
    },
  },
  {
    id: 'immutable',
    label: 'Kod och metadata låsta',
    check: (m) => {
      if (m.upgradeableContract)
        return fail('immutable', 'Uppgraderbar proxy — logiken kan bytas ut efter att du köpt');
      if (m.metadataMutable)
        return fail('immutable', 'Metadata är muterbar — token kan byta identitet efter listning');
      return pass('immutable', 'Kod och metadata låsta');
    },
  },
  {
    id: 'liquidity_floor',
    label: 'Golv för likviditet',
    check: (m, cfg) =>
      m.lpUsd < cfg.gates.minLpUsd
        ? fail('liquidity_floor', `Likviditet $${Math.round(m.lpUsd).toLocaleString('sv-SE')} under golvet — du blir exit-likviditeten`)
        : pass('liquidity_floor', `Likviditet $${Math.round(m.lpUsd).toLocaleString('sv-SE')}`),
  },
  {
    id: 'deployer_history',
    label: 'Deployer utan rug-historik',
    check: (m) =>
      m.deployerFlagged
        ? fail('deployer_history', 'Deployern är kopplad till tidigare rugs')
        : pass('deployer_history', 'Ingen känd rug-historik'),
  },
];

/**
 * Mjuka riskfaktorer. De diskvalificerar inte i sig men adderar riskpoäng —
 * en token kan vara tekniskt "säker" och ändå vara en uppenbar fälla om
 * deployern sitter på halva supplyn.
 *
 * @type {{id: string, weightKey: string, score: (m: TokenMeta, ctx: any) => number, detail: (m: TokenMeta, ctx: any) => string}[]}
 */
export const riskFactors = [
  {
    id: 'topHolderConcentration',
    weightKey: 'topHolderConcentration',
    // 20 % topp-10 är normalt; 60 %+ betyder att några få wallets äger marknaden.
    score: (m) => Math.min(1, Math.max(0, (m.topHolderPct - 20) / 40)),
    detail: (m) => `Topp 10 äger ${m.topHolderPct.toFixed(0)} %`,
  },
  {
    id: 'devHolding',
    weightKey: 'devHolding',
    score: (m) => Math.min(1, Math.max(0, (m.devHoldingPct - 3) / 12)),
    detail: (m) => `Dev äger ${m.devHoldingPct.toFixed(1)} %`,
  },
  {
    id: 'bundledLaunch',
    weightKey: 'bundledLaunch',
    // Bundlad launch = deployern köpte sin egen token i listningsblocket.
    score: (m) => Math.min(1, Math.max(0, (m.bundledLaunchPct - 5) / 25)),
    detail: (m) => `${m.bundledLaunchPct.toFixed(0)} % köpt i listningsblocket`,
  },
  {
    id: 'freshWalletBuyers',
    weightKey: 'freshWalletBuyers',
    score: (_m, ctx) => Math.min(1, Math.max(0, (ctx.freshWalletBuyerRate - 0.3) / 0.4)),
    detail: (_m, ctx) => `${Math.round(ctx.freshWalletBuyerRate * 100)} % av köparna är wallets < 24 h gamla`,
  },
  {
    id: 'thinLiquidity',
    weightKey: 'thinLiquidity',
    score: (m) => Math.min(1, Math.max(0, (40_000 - m.lpUsd) / 32_000)),
    detail: (m) => `Likviditet $${Math.round(m.lpUsd).toLocaleString('sv-SE')}`,
  },
  {
    id: 'lowHolderCount',
    weightKey: 'lowHolderCount',
    score: (_m, ctx) => Math.min(1, Math.max(0, (150 - ctx.holderCount) / 130)),
    detail: (_m, ctx) => `${ctx.holderCount} innehavare`,
  },
];
