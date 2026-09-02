import { readMintAuthorities, readTopHolders } from './rpc.js';
import { config } from '../config.js';

/**
 * Preflight-kö.
 *
 * Kontrollerna kostar RPC-anrop och en publik nod tål inte många per sekund,
 * så bara kvalificerade kandidater ställs i kö. Resultatet har tre lägen —
 * `pass`, `fail` och `unknown` — och `unknown` behandlas aldrig som `pass`.
 * En kontroll som inte kunde utföras är inte en godkänd kontroll.
 */
export class PreflightQueue {
  constructor(handlers = {}) {
    this.handlers = handlers;
    /** @type {any[]} */
    this.queue = [];
    this.running = 0;
    this.done = 0;
    this.failed = 0;
    this.unknown = 0;
  }

  enqueue(entry) {
    if (entry.preflight) return false;
    entry.preflight = { state: 'queued', checks: {} };
    this.queue.push(entry);
    this.#pump();
    return true;
  }

  #pump() {
    while (this.running < config.rpc.concurrency && this.queue.length > 0) {
      const entry = this.queue.shift();
      this.running++;
      this.#run(entry).finally(() => {
        this.running--;
        this.#pump();
      });
    }
  }

  async #run(entry) {
    entry.preflight = { state: 'running', checks: {} };
    this.handlers.onUpdate?.(entry);

    const [authorities, holders] = await Promise.all([
      readMintAuthorities(entry.mint),
      // Bonding-curve-kontot är inte en innehavare i den mening vi menar.
      readTopHolders(entry.mint, entry.bondingCurve ? [entry.bondingCurve] : []),
    ]);

    const checks = {};

    if (authorities.unknown) {
      checks.authority = { state: 'unknown', detail: authorities.reason };
    } else if (authorities.mintAuthorityActive || authorities.freezeAuthorityActive) {
      const which = [
        authorities.mintAuthorityActive && 'mint',
        authorities.freezeAuthorityActive && 'freeze',
      ].filter(Boolean).join(' + ');
      checks.authority = { state: 'fail', detail: `${which} authority aktiv` };
    } else {
      checks.authority = { state: 'pass', detail: 'mint och freeze återkallade' };
    }

    if (holders.unknown) {
      checks.holders = { state: 'unknown', detail: holders.reason };
    } else if (holders.topHolderPct > 60) {
      checks.holders = { state: 'fail', detail: `topp 10 äger ${holders.topHolderPct.toFixed(0)} %` };
    } else {
      checks.holders = { state: 'pass', detail: `topp 10 äger ${holders.topHolderPct.toFixed(0)} %` };
    }

    entry.holders = holders.unknown ? null : holders;

    const states = Object.values(checks).map((c) => c.state);
    const state = states.includes('fail') ? 'fail' : states.includes('unknown') ? 'unknown' : 'pass';

    entry.preflight = { state, checks, at: Date.now() };
    this.done++;
    if (state === 'fail') this.failed++;
    if (state === 'unknown') this.unknown++;
    this.handlers.onUpdate?.(entry);
  }

  stats() {
    return {
      queued: this.queue.length,
      running: this.running,
      done: this.done,
      failed: this.failed,
      unknown: this.unknown,
    };
  }
}
