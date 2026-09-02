import { median, mean, rate } from '../util/stats.js';
import { config as defaultConfig } from '../config.js';

/**
 * Paper-trading-bok.
 *
 * Den här filen är hela poängen med projektet. Vilken scanner som helst kan
 * visa en lista med tokens som "ser lovande ut" — det som avgör om filtret är
 * värt något är om larmen i efterhand gick bättre än de tokens filtret
 * förkastade. Därför bokförs två grupper parallellt:
 *
 *   strategy — tokens som klarade grindarna OCH tröskeln för risk/momentum
 *   control  — tokens som klarade grindarna men inte tröskeln
 *
 * Utan kontrollgruppen mäter du bara marknaden, inte din edge.
 */
export class PaperLedger {
  /** @param {typeof defaultConfig} [cfg] */
  constructor(cfg = defaultConfig) {
    this.cfg = cfg;
    /** @type {Map<string, any>} */
    this.positions = new Map();
  }

  /**
   * @param {'strategy'|'control'} group
   * @param {import('../types.js').TokenMeta} meta
   * @param {number} entryPrice
   * @param {number} ts
   * @param {{archetype?: string, isTrap?: boolean}} [truth]
   * @param {{risk: number, momentum: number}} [scores]
   */
  open(group, meta, entryPrice, ts, truth = {}, scores = { risk: 0, momentum: 0 }) {
    if (this.positions.has(meta.address)) return;
    if (!(entryPrice > 0)) return;
    this.positions.set(meta.address, {
      group,
      symbol: meta.symbol,
      address: meta.address,
      entryPrice,
      entryTs: ts,
      lastPrice: entryPrice,
      peakPrice: entryPrice,
      troughPrice: entryPrice,
      marks: new Array(this.cfg.paper.horizons.length).fill(null),
      truth,
      scores,
    });
  }

  /** Uppdaterar öppna positioner med senaste pris och stämplar av horisonter. */
  mark(address, price, ts) {
    const pos = this.positions.get(address);
    if (!pos || !(price > 0)) return;
    pos.lastPrice = price;
    if (price > pos.peakPrice) pos.peakPrice = price;
    if (price < pos.troughPrice) pos.troughPrice = price;

    this.cfg.paper.horizons.forEach((h, i) => {
      // Första observationen efter horisonten vinner. Marknaden ger inga
      // exakta tidsstämplar, och att vänta på en perfekt mark ger hål i datan.
      if (pos.marks[i] === null && ts >= pos.entryTs + h) {
        pos.marks[i] = this.#netReturn(price, pos.entryPrice);
      }
    });
  }

  /** Stänger av alla horisonter som aldrig hann fyllas (t.ex. vid avstängning). */
  settle() {
    for (const pos of this.positions.values()) {
      pos.marks = pos.marks.map((m) =>
        m === null ? this.#netReturn(pos.lastPrice, pos.entryPrice) : m,
      );
    }
  }

  /** Avkastning netto efter rundturskostnad. */
  #netReturn(price, entryPrice) {
    const cost = (this.cfg.paper.roundTripCostPct ?? 0) / 100;
    return (price / entryPrice) * (1 - cost) - 1;
  }

  /** @param {'strategy'|'control'} group */
  #groupStats(group) {
    const list = [...this.positions.values()].filter((p) => p.group === group);
    const horizons = this.cfg.paper.horizons.map((_, i) => {
      const returns = list.map((p) => p.marks[i]).filter((r) => r !== null);
      return {
        label: this.cfg.paper.horizonLabels[i],
        n: returns.length,
        winRate: rate(returns, (r) => r > 0),
        median: median(returns),
        mean: mean(returns),
        best: returns.length ? Math.max(...returns) : 0,
        worst: returns.length ? Math.min(...returns) : 0,
      };
    });

    return {
      group,
      n: list.length,
      // Andel positioner som i efterhand visade sig vara en fälla. I mock-läget
      // finns facit; mot riktig data blir det här fältet 0 och man får luta
      // sig mot avkastningen istället.
      trapRate: rate(list, (p) => p.truth?.isTrap === true),
      // Värsta observerade nedgången från entry — det är det här talet som
      // avgör om positionsstorleken är hållbar, inte medianen.
      worstDrawdown: list.length
        ? Math.min(...list.map((p) => this.#netReturn(p.troughPrice, p.entryPrice)))
        : 0,
      horizons,
    };
  }

  stats() {
    return {
      strategy: this.#groupStats('strategy'),
      control: this.#groupStats('control'),
    };
  }

  /** Orealiserad avkastning netto för en öppen position, eller null. */
  unrealized(address) {
    const pos = this.positions.get(address);
    if (!pos) return null;
    return this.#netReturn(pos.lastPrice, pos.entryPrice);
  }

  recent(limit = 25) {
    return [...this.positions.values()]
      .sort((a, b) => b.entryTs - a.entryTs)
      .slice(0, limit)
      .map((p) => ({
        symbol: p.symbol,
        address: p.address,
        group: p.group,
        entryTs: p.entryTs,
        pnl: this.#netReturn(p.lastPrice, p.entryPrice),
        peak: this.#netReturn(p.peakPrice, p.entryPrice),
        marks: p.marks,
        archetype: p.truth?.archetype ?? null,
        scores: p.scores,
      }));
  }
}
