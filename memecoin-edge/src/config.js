/**
 * Central konfiguration. Allt som är en tröskel ska bo här, inte spritt i koden —
 * hela poängen med systemet är att kunna skruva på trösklarna och mäta utfallet.
 */
export const config = {
  /** Vilken ingest-källa som används: "mock" | "solana" | "evm" */
  source: process.env.SOURCE ?? 'mock',

  server: {
    port: Number(process.env.PORT ?? 8787),
    host: process.env.HOST ?? '127.0.0.1',
  },

  /**
   * Hårda diskvalificerare. Ett enda utslag här och token slängs — ingen poäng,
   * ingen "men momentum ser bra ut". Det är den här listan som gör systemet
   * lönsamt, inte scoringen.
   */
  gates: {
    /** Minsta andel av LP som måste vara bränd eller låst. */
    minLpLockedPct: 50,
    /** Maximal säljskatt i baspunkter (1000 = 10 %). */
    maxSellTaxBps: 1000,
    /** Maximal köpskatt i baspunkter. */
    maxBuyTaxBps: 1000,
    /** Minsta likviditet i USD. Tunn pool = du är exit-likviditeten. */
    minLpUsd: 8_000,
  },

  /** Mjuka riskvikter (0–100 riskpoäng, högre = värre). */
  risk: {
    /** Max riskpoäng för att en token ska få larma. */
    maxScore: 45,
    weights: {
      topHolderConcentration: 30,
      devHolding: 20,
      bundledLaunch: 20,
      freshWalletBuyers: 15,
      thinLiquidity: 10,
      lowHolderCount: 5,
    },
  },

  /** Momentumvikter (0–100 poäng, högre = starkare tidig traktion). */
  momentum: {
    /** Minsta momentumpoäng för larm. */
    minScore: 60,
    /** Rullande fönster för hastighetsmått. */
    windowMs: 3 * 60_000,
    weights: {
      uniqueBuyerVelocity: 30,
      buyerSellerRatio: 15,
      netInflowAcceleration: 20,
      holderGrowth: 15,
      smartMoney: 15,
      buyerDispersion: 5,
    },
  },

  /**
   * Larmfönstret. Efter ~30 min är informationen inte längre asymmetrisk —
   * då syns token i alla andra scanners också och edgen är borta.
   */
  alert: {
    maxAgeMinutes: 30,
    minAgeSeconds: 45,
    minTrades: 25,
  },

  /** Paper-trading: horisonter (ms) som varje larm mäts på. */
  paper: {
    horizons: [5 * 60_000, 15 * 60_000, 60 * 60_000],
    horizonLabels: ['5m', '15m', '1h'],
    /**
     * Rundturskostnad i procent: swapavgift, prioriteringsavgift och slippage
     * på båda sidor. Dras av från varje redovisad avkastning. En backtest utan
     * den här posten visar systematiskt en edge som inte finns — på tunna
     * pooler är den ofta större än medianavkastningen.
     */
    roundTripCostPct: Number(process.env.ROUND_TRIP_COST_PCT ?? 3.5),
  },
};
