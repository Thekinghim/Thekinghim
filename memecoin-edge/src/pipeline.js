import { TradeWindow } from './scoring/window.js';
import { scoreMomentum } from './scoring/momentum.js';
import { evaluateSafety } from './safety/engine.js';
import { PaperLedger } from './paper/ledger.js';
import { config as defaultConfig } from './config.js';

/**
 * Kedjan: ny pool → hårda grindar → riskpoäng → momentumpoäng → larm → bokföring.
 *
 * Ordningen är inte godtycklig. Grindarna körs först och är billigast, så en
 * honeypot kostar aldrig mer än några jämförelser. Momentum beräknas bara för
 * det som redan är köpbart — att ranka tokens du ändå inte skulle röra är
 * bortkastad CPU och, värre, bortkastad uppmärksamhet.
 */
export class Pipeline {
  /**
   * @param {typeof defaultConfig} [cfg]
   * @param {{onAlert?: (c: any) => void, onUpdate?: (c: any) => void}} [handlers]
   */
  constructor(cfg = defaultConfig, handlers = {}) {
    this.cfg = cfg;
    this.handlers = handlers;
    /** @type {Map<string, any>} */
    this.tracked = new Map();
    this.ledger = new PaperLedger(cfg);
    this.counters = { seen: 0, gateFailed: 0, riskRejected: 0, alerted: 0 };
    /** @type {Record<string, number>} Vilken grind som fäller mest. */
    this.gateFailures = {};
  }

  /** @param {import('./types.js').TokenMeta} meta */
  onToken(meta, truth = {}) {
    this.counters.seen++;
    this.tracked.set(meta.address, {
      meta,
      truth,
      window: new TradeWindow(meta.address, this.cfg.momentum.windowMs),
      alerted: false,
      resolved: false,
      candidate: null,
    });
  }

  /** @param {import('./types.js').Trade} trade */
  onTrade(trade) {
    const entry = this.tracked.get(trade.token);
    if (!entry) return;

    entry.window.add(trade);
    this.ledger.mark(trade.token, trade.priceUsd, trade.ts);

    const ageMs = trade.ts - entry.meta.createdAt;
    const ageMinutes = ageMs / 60_000;

    // Utanför larmfönstret behöver vi fortfarande prisuppdateringar till
    // bokföringen, men ingen ny scoring.
    if (ageMinutes > this.cfg.alert.maxAgeMinutes) return;
    if (ageMs < this.cfg.alert.minAgeSeconds * 1000) return;
    if (entry.window.totalTrades < this.cfg.alert.minTrades) return;

    const metrics = entry.window.metrics(trade.ts);
    const safety = evaluateSafety(
      entry.meta,
      { freshWalletBuyerRate: metrics.freshWalletBuyerRate, holderCount: metrics.holderCount },
      this.cfg,
    );

    if (!safety.passed) {
      if (!entry.resolved) {
        entry.resolved = true;
        this.counters.gateFailed++;
        for (const g of safety.gates) {
          if (!g.passed) this.gateFailures[g.id] = (this.gateFailures[g.id] ?? 0) + 1;
        }
      }
      // Behåll inte scam-tokens i minnet. De ska aldrig visas igen.
      entry.candidate = null;
      return;
    }

    const momentum = scoreMomentum(metrics, this.cfg);
    /** @type {import('./types.js').Candidate} */
    const candidate = {
      meta: entry.meta,
      safety,
      momentum,
      ageMinutes,
      priceUsd: trade.priceUsd,
      alerted: entry.alerted,
      updatedAt: trade.ts,
      // Vad som gällde när larmet gick, inte vad som gäller nu. Momentum
      // faller alltid tillbaka efter ett larm — visas bara det aktuella
      // värdet ser varje larm i efterhand ut som ett misstag.
      alert: entry.alert ?? null,
      pnlSinceAlert: entry.alerted ? this.ledger.unrealized(entry.meta.address) : null,
    };
    entry.candidate = candidate;
    this.handlers.onUpdate?.(candidate);

    if (entry.alerted) return;

    const riskOk = safety.riskScore <= this.cfg.risk.maxScore;
    const momentumOk = momentum.score >= this.cfg.momentum.minScore;

    if (riskOk && momentumOk) {
      entry.alerted = true;
      entry.alert = {
        ts: trade.ts,
        ageMinutes: Math.round(ageMinutes * 10) / 10,
        momentum: momentum.score,
        risk: safety.riskScore,
        priceUsd: trade.priceUsd,
      };
      candidate.alerted = true;
      candidate.alert = entry.alert;
      this.counters.alerted++;
      this.ledger.open('strategy', entry.meta, trade.priceUsd, trade.ts, entry.truth, {
        risk: safety.riskScore,
        momentum: momentum.score,
      });
      this.handlers.onAlert?.(candidate);
      return;
    }

    // Kontrollgrupp: klarade grindarna men inte tröskeln. Öppnas först när
    // larmfönstret nästan är slut, så att en token som larmar senare inte
    // hamnar i båda grupperna.
    if (ageMinutes > this.cfg.alert.maxAgeMinutes * 0.8) {
      if (!entry.resolved) {
        entry.resolved = true;
        this.counters.riskRejected++;
      }
      this.ledger.open('control', entry.meta, trade.priceUsd, trade.ts, entry.truth, {
        risk: safety.riskScore,
        momentum: momentum.score,
      });
    }
  }

  /** Släpper tokens som är för gamla för att både scoras och bokföras. */
  evict(now) {
    const maxHorizon = Math.max(...this.cfg.paper.horizons);
    const keepMs = maxHorizon + 10 * 60_000;
    for (const [address, entry] of this.tracked) {
      if (now - entry.meta.createdAt > keepMs) this.tracked.delete(address);
    }
  }

  /** Aktuella kandidater, bäst först. */
  candidates(limit = 40) {
    return [...this.tracked.values()]
      .map((e) => e.candidate)
      .filter(Boolean)
      .filter((c) => c.ageMinutes <= this.cfg.alert.maxAgeMinutes)
      .sort((a, b) => {
        if (a.alerted !== b.alerted) return a.alerted ? -1 : 1;
        return b.momentum.score - a.momentum.score;
      })
      .slice(0, limit);
  }

  stats() {
    return {
      counters: this.counters,
      gateFailures: this.gateFailures,
      tracking: this.tracked.size,
      paper: this.ledger.stats(),
    };
  }
}
