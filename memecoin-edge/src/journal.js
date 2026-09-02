import fs from 'node:fs';
import path from 'node:path';

/**
 * Framåtriktad journal mot riktiga priser.
 *
 * Skillnaden mot backtestet är hela poängen: här finns inget facit i förväg
 * och ingen simulator som kan smickra modellen. Varje beslut skrivs ned med
 * tidsstämpel och verkligt pris, och läses av först när horisonten passerat.
 *
 * Kontrollgruppen är tokens som klarade grindarna men fick WATCH eller SKIP.
 * Utan den vet du bara hur marknaden gick, inte om dina trösklar tillförde
 * något.
 *
 * Skrivs till disk som NDJSON. En forward test som inte överlever en
 * omstart är ingen forward test.
 */
export class Journal {
  /**
   * @param {{dir: string, horizons: number[], horizonLabels: string[], roundTripCostPct: number}} cfg
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.file = path.join(cfg.dir, 'journal.ndjson');
    /** @type {Map<string, any>} */
    this.positions = new Map();
    fs.mkdirSync(cfg.dir, { recursive: true });
    this.#load();
  }

  #load() {
    if (!fs.existsSync(this.file)) return;
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        // Senare rad för samma adress ersätter tidigare — filen är en logg,
        // inte en databas, och sista ordet gäller.
        this.positions.set(row.address, row);
      } catch {
        // En trasig rad ska inte ta ner hela historiken.
      }
    }
  }

  #append(row) {
    fs.appendFileSync(this.file, `${JSON.stringify(row)}\n`);
  }

  /**
   * @param {'strategy'|'control'} group
   * @param {*} decision
   * @param {number} price
   * @param {string|null} bucket
   */
  open(group, decision, price, bucket) {
    const address = decision.token.address;
    if (this.positions.has(address)) return false;
    if (!(price > 0)) return false;

    const row = {
      address,
      symbol: decision.token.symbol,
      group,
      verdict: decision.verdict,
      quadrant: decision.edge.quadrant,
      gap: decision.edge.gap,
      traction: decision.edge.traction.score,
      attention: decision.edge.attention.score,
      bucket,
      entryPrice: price,
      entryTs: Date.now(),
      lastPrice: price,
      peakPrice: price,
      troughPrice: price,
      marks: new Array(this.cfg.horizons.length).fill(null),
      headline: decision.headline,
    };
    this.positions.set(address, row);
    this.#append(row);
    return true;
  }

  /** Uppdaterar öppna positioner. Skriver bara till disk när något stämplats. */
  mark(address, price, now = Date.now()) {
    const pos = this.positions.get(address);
    if (!pos || !(price > 0)) return;

    pos.lastPrice = price;
    pos.peakPrice = Math.max(pos.peakPrice, price);
    pos.troughPrice = Math.min(pos.troughPrice, price);

    let stamped = false;
    this.cfg.horizons.forEach((h, i) => {
      if (pos.marks[i] === null && now >= pos.entryTs + h) {
        pos.marks[i] = this.netReturn(price, pos.entryPrice);
        stamped = true;
      }
    });
    if (stamped) this.#append(pos);
  }

  netReturn(price, entryPrice) {
    return (price / entryPrice) * (1 - this.cfg.roundTripCostPct / 100) - 1;
  }

  /** Positioner som fortfarande behöver prisuppdateringar. */
  openAddresses() {
    const maxHorizon = Math.max(...this.cfg.horizons);
    const now = Date.now();
    return [...this.positions.values()]
      .filter((p) => now - p.entryTs <= maxHorizon)
      .map((p) => p.address);
  }

  /** Stängda positioner, för kalibreringen. */
  closed() {
    return [...this.positions.values()].filter((p) => p.marks.some((m) => m !== null));
  }

  stats() {
    const groupStats = (group) => {
      const list = [...this.positions.values()].filter((p) => p.group === group);
      return {
        group,
        n: list.length,
        horizons: this.cfg.horizons.map((_, i) => {
          const returns = list.map((p) => p.marks[i]).filter((m) => m !== null && m !== undefined);
          const sorted = [...returns].sort((a, b) => a - b);
          const mid = sorted.length >> 1;
          return {
            label: this.cfg.horizonLabels[i],
            n: returns.length,
            winRate: returns.length ? returns.filter((r) => r > 0).length / returns.length : 0,
            median: sorted.length ? (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) : 0,
            mean: returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0,
            best: returns.length ? Math.max(...returns) : 0,
            worst: returns.length ? Math.min(...returns) : 0,
          };
        }),
      };
    };
    return { strategy: groupStats('strategy'), control: groupStats('control') };
  }
}
