import { fetchRecent, fetchTokens } from './sources/jupiter.js';
import { fetchBoostedTokens, fetchTokenProfiles, fetchPairs } from './sources/dexscreener.js';
import { decide, decisionConfig } from './edge/decision.js';
import { attentionGap } from './edge/attention.js';
import { buildCalibration, priorFor, bucketFor } from './edge/calibration.js';
import { Journal } from './journal.js';
import { liveConfig } from './config.js';

/**
 * Live-motorn: hämtar riktig data, fattar beslut, bokför utfall.
 *
 * Tre oberoende takter, för att de tre datamängderna ändras olika snabbt och
 * har olika minuttak:
 *   tokens        — var 6:e sekund, det är här signalen finns
 *   uppmärksamhet — var 25:e sekund, boosts och profiler ändras långsamt
 *   prismärkning  — var 30:e sekund, bara för öppna journalpositioner
 */
export class LiveEngine {
  /**
   * @param {{onDecision?: (d: any) => void, onBuy?: (d: any) => void, onError?: (e: Error, source: string) => void}} handlers
   */
  constructor(handlers = {}, cfg = liveConfig) {
    this.cfg = cfg;
    this.handlers = handlers;
    this.journal = new Journal(cfg.journal);
    this.calibration = buildCalibration(this.journal.closed());

    /** @type {Map<string, any>} adress → senaste beslut */
    this.decisions = new Map();
    /** @type {Map<string, number>} adress → boostbelopp i USD */
    this.boosts = new Map();
    /** @type {Map<string, number>} adress → antal profil-/sociala länkar */
    this.profiles = new Map();
    /** @type {Map<string, any>} adress → pardata från DexScreener */
    this.pairs = new Map();

    this.counters = { polls: 0, tokensSeen: 0, gateFailed: 0, exitLiquidity: 0, watch: 0, buy: 0, errors: 0 };
    this.lastError = null;
    this.timers = [];
  }

  start() {
    const run = (fn, intervalMs, label) => {
      const tick = async () => {
        try {
          await fn.call(this);
        } catch (err) {
          this.counters.errors++;
          this.lastError = `${label}: ${err.message}`;
          this.handlers.onError?.(err, label);
        }
      };
      tick();
      this.timers.push(setInterval(tick, intervalMs));
    };

    // Uppmärksamhetsdatan hämtas först: utan den blir varje token felaktigt
    // klassad som "ingen har sett den här".
    run(this.refreshAttention, this.cfg.pollAttentionMs, 'attention');
    run(this.pollTokens, this.cfg.pollTokensMs, 'tokens');
    run(this.markOpenPositions, this.cfg.pollMarksMs, 'marks');
    run(this.recalibrate, this.cfg.recalibrateMs, 'calibration');
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  async refreshAttention() {
    const [boosts, profiles] = await Promise.all([fetchBoostedTokens(), fetchTokenProfiles()]);
    this.boosts = boosts;
    this.profiles = profiles;
  }

  async pollTokens() {
    const tokens = await fetchRecent();
    this.counters.polls++;
    if (tokens.length === 0) return;

    // Pardata för de tokens vi faktiskt kan tänka oss att handla. Ett anrop
    // täcker 30 mints, så det kostar nästan ingenting att ta med alla.
    const addresses = tokens.map((t) => t.address);
    try {
      const pairs = await fetchPairs(addresses);
      for (const [address, pair] of pairs) this.pairs.set(address, pair);
    } catch (err) {
      // Pardata är en förstärkning, inte ett krav. Jupiter bär beslutet.
      this.lastError = `pairs: ${err.message}`;
    }

    for (const token of tokens) {
      this.counters.tokensSeen++;
      const decision = this.evaluate(token);
      this.decisions.set(token.address, decision);
      this.handlers.onDecision?.(decision);

      if (decision.verdict === 'AVOID') {
        if (decision.edge.quadrant === 'exit_liquidity') this.counters.exitLiquidity++;
        else this.counters.gateFailed++;
        continue;
      }

      const price = token.priceUsd ?? this.pairs.get(token.address)?.priceUsd ?? null;
      const bucket = bucketFor(decision.edge.gap);

      if (decision.verdict === 'BUY') {
        this.counters.buy++;
        if (this.journal.open('strategy', decision, price, bucket)) {
          this.handlers.onBuy?.(decision);
        }
      } else {
        this.counters.watch++;
        // Stickprov till kontrollgruppen. Deterministiskt på adressen så att
        // samma token alltid hamnar i eller utanför urvalet.
        if (hashUnit(token.address) < this.cfg.controlSampleRate) {
          this.journal.open('control', decision, price, bucket);
        }
      }
    }
  }

  /** @param {*} token */
  evaluate(token) {
    const pair = this.pairs.get(token.address);
    const context = {
      boostUsd: this.boosts.get(token.address) ?? pair?.boostsActive ?? 0,
      socialCount: this.profiles.get(token.address) ?? pair?.socialCount ?? 0,
      volume1h: Number(pair?.volume?.h1 ?? 0),
      liquidityUsd: pair?.liquidityUsd ?? token.liquidityUsd ?? 0,
      pair,
    };
    // Priorn beror på gapet, så det räknas fram först. Rena beräkningar,
    // inga anrop — decide() räknar om det internt och behåller därmed hela
    // beslutslogiken på ett ställe.
    const { gap } = attentionGap(token, context);
    return decide(token, context, priorFor(gap, this.calibration), decisionConfig);
  }

  async markOpenPositions() {
    const open = this.journal.openAddresses();
    if (open.length === 0) return;

    // Jupiter tar 100 mints per anrop; vi håller oss till 60 för marginal.
    for (let i = 0; i < open.length; i += 60) {
      const batch = open.slice(i, i + 60);
      const tokens = await fetchTokens(batch);
      for (const token of tokens) {
        if (token.priceUsd) this.journal.mark(token.address, token.priceUsd);
      }
    }
  }

  async recalibrate() {
    this.calibration = buildCalibration(this.journal.closed());
  }

  /** Aktuella beslut, mest handlingsbara först. */
  board(limit = 40) {
    const rank = { BUY: 0, WATCH: 1, SKIP: 2, AVOID: 3 };
    return [...this.decisions.values()]
      .sort((a, b) => (rank[a.verdict] - rank[b.verdict]) || b.edge.gap - a.edge.gap)
      .slice(0, limit)
      .map(serialize);
  }

  stats() {
    return {
      counters: this.counters,
      lastError: this.lastError,
      calibration: this.calibration,
      journal: this.journal.stats(),
      openPositions: this.journal.openAddresses().length,
    };
  }
}

/** Tar bort `raw` innan beslut skickas över nätet — den är stor och onödig. */
function serialize(d) {
  return {
    verdict: d.verdict,
    headline: d.headline,
    reasons: d.reasons,
    plan: d.plan,
    edge: d.edge,
    safety: { passed: d.safety.passed, failed: d.safety.failed },
    reputation: d.reputation,
    token: {
      address: d.token.address,
      symbol: d.token.symbol,
      name: d.token.name,
      priceUsd: d.token.priceUsd,
      liquidityUsd: d.token.liquidityUsd,
      holderCount: d.token.holderCount,
      organicScore: d.token.organicScore,
      createdAt: d.token.createdAt,
    },
  };
}

/** Stabil 0–1 ur en sträng, för deterministiskt stickprov. */
function hashUnit(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}
