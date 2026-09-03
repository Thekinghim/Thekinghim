/**
 * Rullande handelsfönster per token.
 *
 * Håller bara det som behövs för hastighetsmått, inte hela historiken —
 * en scanner som lyssnar på tusen tokens samtidigt får inte läcka minne.
 */

/** @typedef {import('../types.js').Trade} Trade */

export class TradeWindow {
  /**
   * @param {string} token
   * @param {number} windowMs  Hur långt bakåt hastighetsmåtten tittar.
   */
  constructor(token, windowMs) {
    this.token = token;
    this.windowMs = windowMs;
    /** @type {Trade[]} */
    this.trades = [];
    /** @type {Map<string, number>} wallet -> nettoposition i USD */
    this.positions = new Map();
    this.totalTrades = 0;
    this.lastPrice = 0;
    this.firstTs = 0;
    this.lastTs = 0;
    /** Snapshots av innehavarantal för att mäta acceleration. */
    this.holderSeries = [];
  }

  /** @param {Trade} trade */
  add(trade) {
    if (this.firstTs === 0) this.firstTs = trade.ts;
    this.lastTs = trade.ts;
    this.lastPrice = trade.priceUsd;
    this.totalTrades++;
    this.trades.push(trade);

    const delta = trade.side === 'buy' ? trade.amountUsd : -trade.amountUsd;
    const next = (this.positions.get(trade.wallet) ?? 0) + delta;
    // Nollställda wallets tas bort så att holderCount speglar faktiska innehavare.
    if (next <= 0.01) this.positions.delete(trade.wallet);
    else this.positions.set(trade.wallet, next);

    this.#prune(trade.ts);

    const last = this.holderSeries.at(-1);
    if (!last || trade.ts - last.ts >= 15_000) {
      this.holderSeries.push({ ts: trade.ts, count: this.positions.size });
      if (this.holderSeries.length > 40) this.holderSeries.shift();
    }
  }

  #prune(now) {
    const cutoff = now - this.windowMs;
    let drop = 0;
    while (drop < this.trades.length && this.trades[drop].ts < cutoff) drop++;
    if (drop > 0) this.trades.splice(0, drop);
  }

  get holderCount() {
    return this.positions.size;
  }

  get ageMs() {
    return this.lastTs - this.firstTs;
  }

  /** Andel av köparna i fönstret som handlar från en wallet yngre än 24 h. */
  get freshWalletBuyerRate() {
    const buys = this.trades.filter((t) => t.side === 'buy');
    if (buys.length === 0) return 0;
    return buys.filter((t) => t.walletAgeHours < 24).length / buys.length;
  }

  /**
   * Alla mått som momentumscoringen behöver, beräknade i ett svep.
   * Delas upp i två halvor av fönstret så att vi kan mäta acceleration
   * istället för nivå — nivå är eftersläpande, acceleration är det inte.
   */
  metrics(now = this.lastTs) {
    const window = this.trades.filter((t) => t.ts > now - this.windowMs);
    const half = now - this.windowMs / 2;
    const recent = window.filter((t) => t.ts >= half);
    const earlier = window.filter((t) => t.ts < half);

    const buyers = new Set(window.filter((t) => t.side === 'buy').map((t) => t.wallet));
    const sellers = new Set(window.filter((t) => t.side === 'sell').map((t) => t.wallet));
    const minutes = Math.max(this.windowMs / 60_000, 0.0001);

    const netFlow = (list) =>
      list.reduce((sum, t) => sum + (t.side === 'buy' ? t.amountUsd : -t.amountUsd), 0);

    const buySizes = window.filter((t) => t.side === 'buy').map((t) => t.amountUsd);
    const totalBuyUsd = buySizes.reduce((a, b) => a + b, 0);
    // Andel av köpvolymen som den största enskilda köparen står för.
    // Lågt värde = brett organiskt intresse, högt = en wallet som spelar teater.
    const largestBuyShare = totalBuyUsd > 0 ? Math.max(0, ...buySizes) / totalBuyUsd : 1;

    const holderGrowthPerMin = this.#holderGrowthPerMin();

    return {
      uniqueBuyers: buyers.size,
      uniqueSellers: sellers.size,
      uniqueBuyersPerMin: buyers.size / minutes,
      buyerSellerRatio: sellers.size === 0 ? buyers.size : buyers.size / sellers.size,
      netFlowUsd: netFlow(window),
      netFlowRecent: netFlow(recent),
      netFlowEarlier: netFlow(earlier),
      smartMoneyBuyers: new Set(
        window.filter((t) => t.side === 'buy' && t.smartMoney).map((t) => t.wallet),
      ).size,
      largestBuyShare,
      holderCount: this.positions.size,
      holderGrowthPerMin,
      freshWalletBuyerRate: this.freshWalletBuyerRate,
      tradeCount: window.length,
      totalTrades: this.totalTrades,
      priceUsd: this.lastPrice,
    };
  }

  #holderGrowthPerMin() {
    if (this.holderSeries.length < 2) return 0;
    const first = this.holderSeries[0];
    const last = this.holderSeries.at(-1);
    const minutes = (last.ts - first.ts) / 60_000;
    if (minutes <= 0) return 0;
    return (last.count - first.count) / minutes;
  }
}
