import { mulberry32 } from '../util/stats.js';

/**
 * Simulerad launch-ström.
 *
 * Finns för att systemet ska gå att köra och mäta utan API-nycklar, och för
 * att backtestet ska ha ett facit. Arketyperna är modellerade efter hur de
 * faktiska bedrägerierna ser ut on-chain, inte efter vad som är lätt att koda:
 * varje arketyp har både den metadata och det handelsmönster den brukar ha.
 *
 * @typedef {Object} Archetype
 * @property {string} id
 * @property {number} weight     Relativ frekvens.
 * @property {boolean} isTrap    Facit: hade du förlorat pengar här?
 */

/** @type {Archetype[]} */
export const archetypes = [
  { id: 'runner', weight: 8, isTrap: false },
  { id: 'organic_fade', weight: 22, isTrap: false },
  { id: 'slow_bleed', weight: 25, isTrap: false },
  { id: 'lp_pull', weight: 15, isTrap: true },
  { id: 'honeypot', weight: 10, isTrap: true },
  { id: 'mint_rug', weight: 8, isTrap: true },
  { id: 'bundle_dump', weight: 12, isTrap: true },
];

const SYMBOL_PARTS = [
  'DOGE', 'PEPE', 'WOJAK', 'CHAD', 'MOON', 'BONK', 'SHIB', 'FLOKI', 'TURBO',
  'MYRO', 'POPCAT', 'GIGA', 'BRETT', 'MOG', 'SNEK', 'BOME', 'WIF', 'ANDY',
];
const SUFFIXES = ['', '2', 'INU', 'AI', 'X', 'COIN', '69', 'SOL'];

function pickWeighted(rnd, items) {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rnd() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items.at(-1);
}

const between = (rnd, lo, hi) => lo + rnd() * (hi - lo);
const intBetween = (rnd, lo, hi) => Math.floor(between(rnd, lo, hi + 1));

/**
 * Bygger metadata som passar arketypen.
 * @returns {import('../types.js').TokenMeta}
 */
function buildMeta(rnd, archetype, createdAt, index) {
  const symbol =
    SYMBOL_PARTS[intBetween(rnd, 0, SYMBOL_PARTS.length - 1)] +
    SUFFIXES[intBetween(rnd, 0, SUFFIXES.length - 1)];

  const base = {
    address: `sim${index.toString().padStart(5, '0')}${Math.floor(rnd() * 1e6).toString(36)}`,
    symbol,
    chain: /** @type {'solana'} */ ('solana'),
    createdAt,
    mintAuthorityActive: false,
    freezeAuthorityActive: false,
    metadataMutable: rnd() < 0.05,
    upgradeableContract: false,
    lpLockedPct: between(rnd, 80, 100),
    lpUsd: between(rnd, 9_000, 60_000),
    buyTaxBps: 0,
    sellTaxBps: 0,
    sellSimulationOk: true,
    topHolderPct: between(rnd, 12, 35),
    devHoldingPct: between(rnd, 0.5, 5),
    bundledLaunchPct: between(rnd, 0, 8),
    deployer: `dev${Math.floor(rnd() * 1e6).toString(36)}`,
    deployerFlagged: rnd() < 0.04,
  };

  switch (archetype.id) {
    case 'honeypot':
      return {
        ...base,
        sellSimulationOk: rnd() < 0.3,
        sellTaxBps: intBetween(rnd, 1500, 9900),
        buyTaxBps: intBetween(rnd, 0, 500),
        upgradeableContract: rnd() < 0.6,
      };
    case 'mint_rug':
      return { ...base, mintAuthorityActive: true, freezeAuthorityActive: rnd() < 0.5 };
    case 'lp_pull':
      return {
        ...base,
        lpLockedPct: between(rnd, 0, 45),
        lpUsd: between(rnd, 6_000, 25_000),
        devHoldingPct: between(rnd, 4, 14),
      };
    case 'bundle_dump':
      // Klarar de hårda grindarna. Det är riskpoängen som ska fånga den här.
      return {
        ...base,
        bundledLaunchPct: between(rnd, 18, 45),
        devHoldingPct: between(rnd, 6, 18),
        topHolderPct: between(rnd, 45, 80),
      };
    case 'runner':
      return {
        ...base,
        lpUsd: between(rnd, 18_000, 90_000),
        topHolderPct: between(rnd, 10, 26),
        devHoldingPct: between(rnd, 0, 3),
        bundledLaunchPct: between(rnd, 0, 5),
        deployerFlagged: false,
      };
    default:
      return base;
  }
}

/**
 * Genererar hela handelsförloppet för en launch, en timme framåt.
 * Priset drivs av nettoflödet mot poolens djup — grov men riktningsmässigt
 * korrekt modell av en konstant-produkt-pool.
 */
function buildTrades(rnd, meta, archetype, startTs) {
  const trades = [];
  const durationMs = 60 * 60_000;
  let price = between(rnd, 0.000008, 0.00035);
  let depth = meta.lpUsd;

  // När fällan slår igen.
  const rugAt =
    archetype.id === 'lp_pull'
      ? startTs + between(rnd, 3, 12) * 60_000
      : archetype.id === 'bundle_dump'
        ? startTs + between(rnd, 2, 7) * 60_000
        : Infinity;

  // Hur brett intresset är, och hur snabbt det svalnar.
  const peakBuyersPerMin =
    { runner: between(rnd, 14, 40), organic_fade: between(rnd, 8, 18), slow_bleed: between(rnd, 2, 6) }[
      archetype.id
    ] ?? between(rnd, 6, 22);
  const decayMinutes =
    { runner: between(rnd, 25, 55), organic_fade: between(rnd, 6, 14), slow_bleed: between(rnd, 3, 8) }[
      archetype.id
    ] ?? between(rnd, 4, 12);

  // Hur snabbt de tidiga köparna vänder till säljare. Det här är den enskilt
  // viktigaste parametern för att simuleringen ska vara ärlig: utan ett
  // säljtryck som tar över efter den första pumpen blir varje tidig entry
  // lönsam, och då mäter backtestet simulatorn istället för strategin.
  const flipProfile =
    {
      runner: { max: 0.56, rampMinutes: 40 },
      organic_fade: { max: 0.86, rampMinutes: 11 },
      slow_bleed: { max: 0.9, rampMinutes: 7 },
    }[archetype.id] ?? { max: 0.82, rampMinutes: 14 };

  const walletAge = () => (rnd() < (archetype.id === 'bundle_dump' ? 0.75 : 0.35) ? between(rnd, 0.1, 24) : between(rnd, 24, 9000));

  let ts = startTs;
  let walletSeq = 0;
  const holders = [];

  while (ts < startTs + durationMs) {
    const minutesIn = (ts - startTs) / 60_000;
    const rugged = ts >= rugAt;

    if (rugged) {
      // Likviditeten dras eller bundle-walletsen dumpar: priset kollapsar en gång.
      if (!trades.some((t) => t.rug)) {
        price *= archetype.id === 'lp_pull' ? 0.02 : 0.12;
        depth *= 0.15;
        trades.push({
          token: meta.address, ts, side: 'sell', amountUsd: depth * 4,
          priceUsd: price, wallet: meta.deployer, walletAgeHours: 2, smartMoney: false, rug: true,
        });
      }
    }

    const intensity = rugged ? 0.05 : Math.exp(-minutesIn / decayMinutes);
    const buyersThisStep = Math.max(0, peakBuyersPerMin * intensity * 0.25); // 15-sekunderssteg
    const events = Math.round(buyersThisStep + (rnd() < buyersThisStep % 1 ? 1 : 0));

    for (let i = 0; i < events; i++) {
      const eventTs = ts + rnd() * 15_000;
      // Säljtrycket växer över tid när tidiga köpare tar hem.
      const sellPressure = rugged
        ? 0.95
        : Math.min(flipProfile.max, 0.1 + minutesIn / flipProfile.rampMinutes);
      const isSell = holders.length > 3 && rnd() < sellPressure;

      let wallet;
      if (isSell) {
        wallet = holders[intBetween(rnd, 0, holders.length - 1)];
      } else {
        wallet = { id: `w${meta.address}_${walletSeq++}`, age: walletAge() };
        holders.push(wallet);
      }

      const amountUsd = Math.exp(between(rnd, Math.log(25), Math.log(archetype.id === 'runner' ? 4500 : 1800)));
      const signed = isSell ? -amountUsd : amountUsd;
      // Prispåverkan skalar med orderns storlek mot poolens djup.
      price *= 1 + (signed / Math.max(depth, 1)) * 0.85;
      price = Math.max(price, 1e-12);
      depth = Math.max(1_000, depth + signed * 0.5);

      trades.push({
        token: meta.address,
        ts: eventTs,
        side: isSell ? 'sell' : 'buy',
        amountUsd,
        priceUsd: price,
        wallet: wallet.id,
        walletAgeHours: wallet.age,
        smartMoney: !isSell && rnd() < (archetype.id === 'runner' ? 0.09 : 0.015),
        rug: false,
      });
    }

    ts += 15_000;
  }

  trades.sort((a, b) => a.ts - b.ts);
  return trades;
}

/**
 * Två oberoende slumpströmmar från ett frö.
 *
 * Arketypvalet får en egen ström eftersom olika arketyper drar olika många
 * slumptal när de genereras. Med en delad ström blir antalet dragningar en
 * återkoppling in i nästa val, och fördelningen driver mätbart från vikterna.
 *
 * @param {number} seed
 */
export function createStreams(seed) {
  return {
    pick: mulberry32(seed ^ 0x9e3779b9),
    gen: mulberry32(seed),
  };
}

/**
 * Skapar en launch komplett med facit.
 * @param {ReturnType<typeof createStreams>} streams
 * @param {number} startTs
 * @param {number} index
 */
export function generateLaunch(streams, startTs, index) {
  const archetype = pickWeighted(streams.pick, archetypes);
  const rnd = streams.gen;
  const meta = buildMeta(rnd, archetype, startTs, index);
  const trades = buildTrades(rnd, meta, archetype, startTs);
  return { meta, trades, truth: { archetype: archetype.id, isTrap: archetype.isTrap } };
}

/**
 * Live-källa: matar ut launches och trades i (accelererad) realtid.
 *
 * @param {{seed?: number, speed?: number, launchIntervalMs?: number}} [opts]
 */
export function createMockSource(opts = {}) {
  const { seed = Date.now() & 0xffff, speed = 12, launchIntervalMs = 45_000 } = opts;
  const streams = createStreams(seed);
  const rnd = streams.gen;
  let index = 0;
  let timer = null;
  /** @type {{ts: number, run: () => void}[]} */
  let queue = [];
  let virtualNow = Date.now();
  let nextLaunchAt = virtualNow;

  const schedule = (ts, run) => {
    const at = { ts, run };
    // Insertion sort räcker: kön är kort och nästan alltid redan sorterad.
    let i = queue.length;
    while (i > 0 && queue[i - 1].ts > ts) i--;
    queue.splice(i, 0, at);
  };

  return {
    name: 'mock',
    seed,
    /**
     * @param {{onToken: (m: any, truth: any) => void, onTrade: (t: any) => void, onTick: (now: number) => void}} handlers
     */
    start(handlers) {
      timer = setInterval(() => {
        virtualNow += 1000 * speed;

        while (virtualNow >= nextLaunchAt) {
          const launch = generateLaunch(streams, nextLaunchAt, index++);
          schedule(launch.meta.createdAt, () => handlers.onToken(launch.meta, launch.truth));
          for (const trade of launch.trades) {
            schedule(trade.ts, () => handlers.onTrade(trade));
          }
          nextLaunchAt += launchIntervalMs * (0.5 + rnd());
        }

        while (queue.length > 0 && queue[0].ts <= virtualNow) {
          queue.shift().run();
        }
        handlers.onTick(virtualNow);
      }, 1000);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      queue = [];
    },
  };
}
