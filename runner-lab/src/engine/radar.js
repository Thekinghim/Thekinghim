import { TokenWindow } from './windows.js';
import { config } from '../config.js';
import { verdictFor } from './verdict.js';

/**
 * Radarn: håller varje ny mint i fönstret, uppdaterar mått från trades och
 * avgör vilka som förtjänar de dyra kontrollerna (RPC-uppslag, holder-analys).
 *
 * Kvalificering är inte ett köpråd. Den svarar på en enda fråga: har den här
 * token tillräckligt med riktig aktivitet för att det ska vara värt att
 * spendera nätverksanrop på? Ett köpbeslut kräver kontrollerna som körs
 * efteråt, och tills de är klara säger radarn ingenting om risk.
 */
export class Radar {
  constructor(handlers = {}) {
    this.handlers = handlers;
    /** @type {Map<string, any>} */
    this.tokens = new Map();
    this.counters = { launches: 0, trades: 0, qualified: 0, migrations: 0, dropped: 0, devSells: 0 };
  }

  /** @param {*} raw PumpPortal create-event. */
  onLaunch(raw) {
    if (!raw?.mint || this.tokens.has(raw.mint)) return null;
    this.counters.launches++;

    const entry = {
      mint: raw.mint,
      name: raw.name ?? '',
      symbol: raw.symbol ?? '',
      creator: raw.traderPublicKey ?? null,
      uri: raw.uri ?? null,
      launchedAt: Date.now(),
      launchMarketCapSol: Number(raw.marketCapSol ?? 0),
      creatorInitialSol: Number(raw.solAmount ?? 0),
      creatorInitialTokens: Number(raw.initialBuy ?? 0),
      vTokens: Number(raw.vTokensInBondingCurve ?? 0),
      vSolAtLaunch: Number(raw.vSolInBondingCurve ?? 0),
      window: new TokenWindow(raw.mint, config.radar.rollingMs),
      qualified: false,
      tracking: false,
      migratedAt: null,
      preflight: null,
      holders: null,
      /**
       * Deployerns egna säljningar.
       *
       * Creator-walleten står i launch-eventet och varje handel bär sin
       * wallet, så det här är inte en uppskattning — det är samma adress
       * eller inte. Ingen annan signal i verktyget är lika entydig, och det
       * är den enda som ensam räcker för att aldrig röra en token.
       */
      devSells: 0,
      devSoldSol: 0,
      devSoldAt: null,
    };
    this.tokens.set(raw.mint, entry);
    this.handlers.onNew?.(entry);
    return entry;
  }

  /** @param {*} raw PumpPortal buy/sell-event. */
  onTrade(raw) {
    const entry = this.tokens.get(raw?.mint);
    if (!entry) return;
    this.counters.trades++;

    if (raw.txType === 'sell' && entry.creator && raw.traderPublicKey === entry.creator) {
      entry.devSells++;
      entry.devSoldSol += Number(raw.solAmount ?? 0);
      entry.devSoldAt = Date.now();
      this.counters.devSells++;
      this.handlers.onDevSell?.(entry, Number(raw.solAmount ?? 0));
    }

    entry.window.add({
      ts: Date.now(),
      side: raw.txType,
      sol: Number(raw.solAmount ?? 0),
      wallet: raw.traderPublicKey ?? 'okänd',
      marketCapSol: Number(raw.marketCapSol ?? 0),
      vSol: Number(raw.vSolInBondingCurve ?? 0),
    });

    if (!entry.qualified) {
      const m = entry.window.metrics();
      if (m.uniqueBuyers >= config.radar.minUniqueBuyers && m.netSol > 0) {
        entry.qualified = true;
        this.counters.qualified++;
        this.handlers.onQualified?.(entry);
      }
    }
  }

  onMigration(raw) {
    this.counters.migrations++;
    const entry = this.tokens.get(raw?.mint);
    if (entry) {
      entry.migratedAt = Date.now();
      this.handlers.onMigration?.(entry);
    }
    return entry;
  }

  /**
   * Hur långt bonding curve har fyllts, 0–1.
   *
   * Returnerar null när vi inte sett något virtuellt SOL-värde. Att gissa 0
   * skulle placera token i "nya" som om ingenting hänt, vilket är fel svar
   * på frågan "vet vi?".
   */
  static curveProgress(entry, metrics, cfg) {
    const vSol = metrics.vSol || entry.vSolAtLaunch;
    if (!(vSol > 0)) return null;
    const real = vSol - cfg.curve.virtualStartSol;
    return Math.max(0, Math.min(1, real / cfg.curve.graduationSol));
  }

  /**
   * Andel av supplyn skaparen tog i samma transaktion som skapandet.
   * Returnerar null när fälten saknas — okänt är inte noll.
   */
  static creatorOpeningShare(entry) {
    const total = entry.creatorInitialTokens + entry.vTokens;
    if (!(total > 0)) return null;
    return (entry.creatorInitialTokens / total) * 100;
  }

  /**
   * Släpper prenumerationer och tokens som inte längre är intressanta.
   *
   * Två skäl att släppa en prenumeration:
   *   1. Probe-fönstret gick ut utan att token kvalificerade sig.
   *   2. Token föll ur radarfönstret helt.
   *
   * @returns {{release: string[], drop: string[]}} mints att avprenumerera,
   *   och de som dessutom togs bort ur radarn.
   */
  evict(now = Date.now()) {
    const maxAge = config.radar.windowMinutes * 60_000;
    const probeMs = config.radar.probeSeconds * 1000;
    const release = [];
    const drop = [];

    for (const [mint, entry] of this.tokens) {
      const age = now - entry.launchedAt;

      // Probe utgången utan traktion: sluta lyssna, men behåll raden i radarn
      // så att den syns tills fönstret går ut.
      if (entry.tracking && !entry.qualified && age > probeMs) {
        entry.tracking = false;
        entry.probeExpired = true;
        release.push(mint);
      }

      if (age <= maxAge) continue;
      // Migrerade tokens behålls längre — de är utfallsdata.
      if (entry.migratedAt && now - entry.migratedAt < 3600_000) continue;

      this.tokens.delete(mint);
      this.counters.dropped++;
      drop.push(mint);
      if (entry.tracking) release.push(mint);
    }
    return { release, drop };
  }

  /** Kandidater i fönstret, mest aktiva först. */
  board(limit = 60) {
    const now = Date.now();
    const rows = [];
    for (const entry of this.tokens.values()) {
      const metrics = entry.window.metrics(now);
      const progress = Radar.curveProgress(entry, metrics, config);
      const lane = entry.migratedAt
        ? 'migrated'
        : progress !== null && progress >= config.curve.completingFrom
          ? 'completing'
          : 'new';
      rows.push({
        lane,
        curveProgress: progress,
        mint: entry.mint,
        name: entry.name,
        symbol: entry.symbol,
        creator: entry.creator,
        ageSec: Math.round((now - entry.launchedAt) / 1000),
        launchMarketCapSol: entry.launchMarketCapSol,
        creatorInitialSol: entry.creatorInitialSol,
        creatorOpeningShare: Radar.creatorOpeningShare(entry),
        qualified: entry.qualified,
        tracking: entry.tracking,
        probeExpired: entry.probeExpired === true,
        migratedAt: entry.migratedAt,
        preflight: entry.preflight,
        holders: entry.holders,
        earlyExits: entry.window.earlyBuyersExited(),
        devSells: entry.devSells,
        devSoldSol: entry.devSoldSol,
        devSoldAt: entry.devSoldAt,
        // Kvalificering är klibbig — anropen är redan spenderade och ska inte
        // spenderas om. Men ett flöde som vänt måste synas, annars ser en
        // token som dumpas fortfarande ut som en kandidat.
        flowReversed: entry.qualified && metrics.netSol < 0,
        meta: entry.meta ?? null,
        series: entry.window.series,
        metrics,
      });
      rows[rows.length - 1].verdict = verdictFor(rows[rows.length - 1]);
    }
    rows.sort((a, b) => {
      if (a.qualified !== b.qualified) return a.qualified ? -1 : 1;
      if (b.metrics.uniqueBuyers !== a.metrics.uniqueBuyers) {
        return b.metrics.uniqueBuyers - a.metrics.uniqueBuyers;
      }
      return a.ageSec - b.ageSec;
    });
    return rows.slice(0, limit);
  }
}
