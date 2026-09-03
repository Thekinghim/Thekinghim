import fs from 'node:fs';
import path from 'node:path';

/**
 * Creator-register byggt ur den egna inspelningen av pump.fun-strömmen.
 *
 * Varför det här är produktens kärna: MELT:s publika dataset har inget
 * användbart creator-fält (det är en konstant för alla 46 139 rader), och
 * ingen datatjänst säljer en creator-historik. Den går bara att äga genom
 * att spela in strömmen från dag ett. Värdet växer varje dygn verktyget
 * körs och kan inte köpas ikapp — det är den enda beståndsdelen här som
 * konkurrenter inte kan replikera på en eftermiddag.
 *
 * Utfallsmåttet är **graduation**: att bonding curve fylls och token
 * migrerar till en DEX. Det valdes för att det är binärt, observerbart i
 * samma gratisström, och sällsynt nog att bära information. Runners
 * graduerar praktiskt taget alltid; skräp gör det nästan aldrig.
 *
 * Punkt-i-tiden-korrekthet (CLAUDE.md regel 1): beslutstidpunkten är när en
 * ny launch dyker upp. `reputationAt` räknar bara launches som redan
 * *avgjorts* före den tidpunkten — en launch som fortfarande kan gradera
 * räknas varken som lyckad eller misslyckad.
 */

/** Hur länge en launch får chansen att gradera innan den räknas som avgjord. */
const SETTLE_MS = 12 * 3600_000;

export class CreatorRegistry {
  /** @param {{dir: string}} cfg */
  constructor(cfg) {
    this.dir = cfg.dir;
    this.file = path.join(cfg.dir, 'launches.ndjson');
    /** @type {Map<string, {mint: string, creator: string, ts: number, graduatedAt: number|null, symbol: string}>} */
    this.launches = new Map();
    /** @type {Map<string, string[]>} creator -> mints */
    this.byCreator = new Map();
    fs.mkdirSync(cfg.dir, { recursive: true });
    this.#load();
  }

  #load() {
    if (!fs.existsSync(this.file)) return;
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        this.#index(JSON.parse(line));
      } catch {
        // En trasig rad får inte ta ner hela registret.
      }
    }
  }

  #index(row) {
    const existing = this.launches.get(row.mint);
    if (existing) {
      // Senare rad vinner — så registreras en graduation på en befintlig launch.
      Object.assign(existing, row);
      return;
    }
    this.launches.set(row.mint, row);
    if (!row.creator) return;
    const list = this.byCreator.get(row.creator);
    if (list) list.push(row.mint);
    else this.byCreator.set(row.creator, [row.mint]);
  }

  #append(row) {
    fs.appendFileSync(this.file, `${JSON.stringify(row)}\n`);
  }

  /** @param {import('../ingest/pumpportal.js').PumpLaunch} launch */
  recordLaunch(launch) {
    if (this.launches.has(launch.mint)) return false;
    const row = {
      mint: launch.mint,
      creator: launch.creator,
      symbol: launch.symbol,
      name: launch.name,
      ts: launch.ts,
      initialBuySol: launch.initialBuySol,
      marketCapSol: launch.marketCapSol,
      graduatedAt: null,
    };
    this.#index(row);
    this.#append(row);
    return true;
  }

  /** @param {string} mint */
  recordGraduation(mint, ts = Date.now()) {
    const row = this.launches.get(mint);
    if (!row || row.graduatedAt) return false;
    row.graduatedAt = ts;
    this.#append(row);
    return true;
  }

  /**
   * Creatorns meritlista som den såg ut vid `now`.
   *
   * Räknar bara launches som både skedde före `now` och hunnit bli avgjorda,
   * så att ett utfall aldrig kan läcka bakåt in i ett tidigare beslut.
   *
   * @param {string} creator
   * @param {number} now
   */
  reputationAt(creator, now = Date.now()) {
    const mints = this.byCreator.get(creator) ?? [];
    let settled = 0;
    let graduated = 0;
    let lastLaunchTs = 0;
    let launchesLast24h = 0;

    for (const mint of mints) {
      const row = this.launches.get(mint);
      if (!row || row.ts >= now) continue;
      lastLaunchTs = Math.max(lastLaunchTs, row.ts);
      if (now - row.ts <= 24 * 3600_000) launchesLast24h++;

      const decided = row.graduatedAt !== null || now - row.ts >= SETTLE_MS;
      if (!decided) continue;
      settled++;
      // Räknas bara om graduationen faktiskt hunnit ske före beslutstidpunkten.
      if (row.graduatedAt !== null && row.graduatedAt < now) graduated++;
    }

    return {
      known: settled > 0,
      settledLaunches: settled,
      graduations: graduated,
      graduationRate: settled > 0 ? graduated / settled : null,
      launchesLast24h,
      minutesSinceLastLaunch: lastLaunchTs ? (now - lastLaunchTs) / 60_000 : null,
    };
  }

  /**
   * Basfrekvensen i den egna inspelningen. Utan den betyder en creators
   * graduationsandel ingenting — den ska jämföras mot något.
   */
  baseRate(now = Date.now()) {
    let settled = 0;
    let graduated = 0;
    for (const row of this.launches.values()) {
      if (row.ts >= now) continue;
      if (row.graduatedAt === null && now - row.ts < SETTLE_MS) continue;
      settled++;
      if (row.graduatedAt !== null && row.graduatedAt < now) graduated++;
    }
    return { settled, graduated, rate: settled > 0 ? graduated / settled : null };
  }

  stats() {
    const base = this.baseRate();
    const repeat = [...this.byCreator.values()].filter((m) => m.length > 1).length;
    return {
      launches: this.launches.size,
      creators: this.byCreator.size,
      repeatCreators: repeat,
      graduations: base.graduated,
      baseGraduationRate: base.rate,
      settled: base.settled,
    };
  }
}
