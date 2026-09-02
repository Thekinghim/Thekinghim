export const config = {
  source: process.env.SOURCE ?? 'live',
  recordOnly: process.env.RECORD_ONLY === '1',

  server: {
    port: Number(process.env.PORT ?? 4173),
    host: process.env.HOST ?? '127.0.0.1',
  },

  pumpportal: {
    ws: process.env.PUMPPORTAL_WS ?? 'wss://pumpportal.fun/api/data',
    /**
     * subscribeTokenTrade är mätad hos PumpPortal. Vi prenumererar därför
     * bara på de mints som faktiskt är kandidater, och släpper dem när de
     * faller ur fönstret.
     */
    maxTrackedMints: Number(process.env.MAX_TRACKED ?? 120),
  },

  rpc: {
    // Publik endpoint räcker för enstaka konto-uppslag. Sätt egen för högre tak.
    url: process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com',
    /** Max samtidiga preflight-jobb. Publika noder stryper aggressivt. */
    concurrency: Number(process.env.RPC_CONCURRENCY ?? 2),
    minIntervalMs: Number(process.env.RPC_MIN_INTERVAL_MS ?? 400),
  },

  radar: {
    /** Hur länge en token räknas som "tidig" och visas i radarn. */
    windowMinutes: Number(process.env.WINDOW_MINUTES ?? 30),
    /** Rullande fönster för hastighetsmått. */
    rollingMs: 60_000,
    /** Minsta antal unika köpare innan en kandidat får kvalificeras. */
    minUniqueBuyers: Number(process.env.MIN_BUYERS ?? 8),
  },

  store: {
    dir: process.env.DATA_DIR ?? new URL('../data/', import.meta.url).pathname,
  },
};
