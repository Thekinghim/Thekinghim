/**
 * Rullande fönster per mint.
 *
 * Håller bara det som behövs för hastighetsmått. En ström som följer hundra
 * mints samtidigt får inte läcka minne, så äldre trades kastas i samma svep
 * som nya läggs till.
 */
export class TokenWindow {
  constructor(mint, rollingMs) {
    this.mint = mint;
    this.rollingMs = rollingMs;
    /** @type {{ts:number, side:'buy'|'sell', sol:number, wallet:string}[]} */
    this.trades = [];
    /** @type {Map<string, number>} wallet -> netto SOL */
    this.positions = new Map();
    this.totalTrades = 0;
    this.firstTs = 0;
    this.lastTs = 0;
    this.lastMarketCapSol = 0;
    /** Första köparna i ordning — används för att se om de lämnar. */
    this.firstBuyers = [];
  }

  add(trade) {
    if (!this.firstTs) this.firstTs = trade.ts;
    this.lastTs = trade.ts;
    this.totalTrades++;
    if (trade.marketCapSol > 0) this.lastMarketCapSol = trade.marketCapSol;
    this.trades.push(trade);

    const delta = trade.side === 'buy' ? trade.sol : -trade.sol;
    const next = (this.positions.get(trade.wallet) ?? 0) + delta;
    if (next <= 1e-9) this.positions.delete(trade.wallet);
    else this.positions.set(trade.wallet, next);

    if (trade.side === 'buy' && this.firstBuyers.length < 20 && !this.firstBuyers.includes(trade.wallet)) {
      this.firstBuyers.push(trade.wallet);
    }

    const cutoff = trade.ts - this.rollingMs;
    let drop = 0;
    while (drop < this.trades.length && this.trades[drop].ts < cutoff) drop++;
    if (drop) this.trades.splice(0, drop);
  }

  /**
   * Mått över det rullande fönstret.
   *
   * Ingen komponent använder volym i SOL som signal. Volym är gratis att
   * förfalska — en wallet kan handla med sig själv för avgifternas kostnad.
   * Unika köpare kostar riktiga wallets.
   */
  metrics(now = this.lastTs) {
    const w = this.trades.filter((t) => t.ts > now - this.rollingMs);
    const buys = w.filter((t) => t.side === 'buy');
    const sells = w.filter((t) => t.side === 'sell');
    const buyers = new Set(buys.map((t) => t.wallet));
    const sellers = new Set(sells.map((t) => t.wallet));
    const minutes = this.rollingMs / 60_000;

    const netSol = w.reduce((s, t) => s + (t.side === 'buy' ? t.sol : -t.sol), 0);
    const buySol = buys.reduce((s, t) => s + t.sol, 0);
    const largestBuy = buys.length ? Math.max(...buys.map((t) => t.sol)) : 0;

    return {
      uniqueBuyers: buyers.size,
      uniqueSellers: sellers.size,
      buyersPerMin: buyers.size / minutes,
      txPerSec: w.length / (this.rollingMs / 1000),
      netSol,
      buySol,
      // Andel av köpvolymen som den största enskilda ordern står för.
      // Högt värde = en wallet spelar teater, inte brett intresse.
      largestBuyShare: buySol > 0 ? largestBuy / buySol : 0,
      holders: this.positions.size,
      trades: w.length,
      totalTrades: this.totalTrades,
      marketCapSol: this.lastMarketCapSol,
      ageMs: this.lastTs - this.firstTs,
    };
  }

  /** Hur många av de första köparna som sålt ur hela sin position. */
  earlyBuyersExited() {
    if (this.firstBuyers.length === 0) return 0;
    return this.firstBuyers.filter((w) => !this.positions.has(w)).length;
  }
}
