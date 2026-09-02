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

  /**
   * pump.fun-kurvans konstanter.
   *
   * Kurvan startar med 30 virtuella SOL och graduerar när ungefär 85 riktiga
   * SOL samlats in. PumpPortal rapporterar `vSolInBondingCurve` som virtuell
   * summa, alltså riktig + 30. Progress = (vSol − 30) / 85.
   *
   * Siffrorna är pump.fun:s och kan ändras av dem. Ändras de blir kolumnen
   * "fyller kurvan" fel innan något annat går sönder, så de ligger här.
   */
  curve: {
    virtualStartSol: Number(process.env.CURVE_VIRTUAL_START ?? 30),
    graduationSol: Number(process.env.CURVE_GRADUATION_SOL ?? 85),
    /** Från vilken andel en token räknas som "fyller kurvan". */
    completingFrom: Number(process.env.CURVE_COMPLETING_FROM ?? 0.5),
  },

  radar: {
    /** Hur länge en token räknas som "tidig" och visas i radarn. */
    windowMinutes: Number(process.env.WINDOW_MINUTES ?? 30),
    /** Rullande fönster för hastighetsmått. */
    rollingMs: 60_000,
    /** Minsta antal unika köpare innan en kandidat får kvalificeras. */
    minUniqueBuyers: Number(process.env.MIN_BUYERS ?? 8),
    /**
     * Hur länge en ny token får en trade-prenumeration innan den släpps.
     *
     * Utan det här fönstret låser sig hela kedjan: kvalificering kräver
     * trades, trades kräver prenumeration, och prenumerationen startade
     * tidigare först vid kvalificering. Varje ny token får därför lyssnas
     * på en stund, och de som inte visar aktivitet släpps igen.
     */
    probeSeconds: Number(process.env.PROBE_SECONDS ?? 90),
  },

  store: {
    dir: process.env.DATA_DIR ?? new URL('../data/', import.meta.url).pathname,
  },
};
