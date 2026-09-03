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

  /**
   * @param {*} entry
   * @param {{full?: boolean}} opts `full` lägger till innehavarkontrollen.
   *
   * Authority-kontrollen körs på **varje** listning. Den är ett enda
   * RPC-anrop och är den viktigaste kontrollen som finns — utan den kan
   * omdömet aldrig bli något annat än VÄNTA, och ett verktyg där allt står
   * på VÄNTA är oanvändbart.
   *
   * Innehavarkontrollen kostar ett anrop till och säger inget vettigt förrän
   * det finns innehavare att fördela, så den körs först vid kvalificering.
   */
  enqueue(entry, opts = {}) {
    const full = opts.full === true;
    if (entry.preflight && !(full && !entry.preflightFull)) return false;
    entry.preflightFull = full;
    entry.preflight = { state: 'queued', checks: entry.preflight?.checks ?? {} };
    this.queue.push({ entry, full });
    this.#pump();
    return true;
  }

  #pump() {
    while (this.running < config.rpc.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      this.running++;
      this.#run(job.entry, job.full).finally(() => {
        this.running--;
        this.#pump();
      });
    }
  }

  async #run(entry, full) {
    entry.preflight = { state: 'running', checks: entry.preflight?.checks ?? {} };
    this.handlers.onUpdate?.(entry);

    const [authorities, holders] = await Promise.all([
      readMintAuthorities(entry.mint),
      // Bonding-curve-kontot är inte en innehavare i den mening vi menar.
      full ? readTopHolders(entry.mint, entry.bondingCurve ? [entry.bondingCurve] : []) : null,
    ]);

    const checks = { ...entry.preflight.checks };

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

    if (holders) {
      if (holders.unknown) {
        checks.holders = { state: 'unknown', detail: holders.reason };
      } else if (holders.topHolderPct > 60) {
        checks.holders = { state: 'fail', detail: `topp 10 äger ${holders.topHolderPct.toFixed(0)} %` };
      } else {
        checks.holders = { state: 'pass', detail: `topp 10 äger ${holders.topHolderPct.toFixed(0)} %` };
      }
      entry.holders = holders.unknown ? null : holders;
    }

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
