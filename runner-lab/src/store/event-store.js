import fs from 'node:fs';
import path from 'node:path';

/**
 * Append-only händelselager.
 *
 * PLAN.md: "archive raw stream data continuously. Without an archive there is
 * no future backtest, and this is the most common irrecoverable mistake in
 * this category of project."
 *
 * Därför skrivs varje inkommande händelse ned i sin råa form innan något
 * annat händer med den. Filen roteras per dygn så att en enskild fil inte
 * blir ohanterlig, och dedupliceras på signatur eftersom en återanslutning
 * kan leverera om händelser vi redan sett.
 */
export class EventStore {
  /** @param {{dir: string}} cfg */
  constructor(cfg) {
    this.dir = path.join(cfg.dir, 'events');
    fs.mkdirSync(this.dir, { recursive: true });
    /** @type {Set<string>} */
    this.seen = new Set();
    this.written = 0;
    this.duplicates = 0;
    this.fd = null;
    this.fdDay = null;
  }

  /**
   * Synkron fildeskriptor, inte en write stream.
   *
   * En stream flushar asynkront, så en hård avstängning kan tappa de sista
   * händelserna — och arkivet finns just för att inget ska tappas. Skrivningen
   * kostar mikrosekunder vid den här händelsetakten.
   */
  #fdFor(ts) {
    const day = new Date(ts).toISOString().slice(0, 10);
    if (this.fdDay !== day) {
      if (this.fd !== null) fs.closeSync(this.fd);
      this.fd = fs.openSync(path.join(this.dir, `${day}.ndjson`), 'a');
      this.fdDay = day;
    }
    return this.fd;
  }

  /**
   * @param {string} kind
   * @param {*} raw Händelsen exakt som den kom in.
   * @returns {boolean} false om den var en dubblett.
   */
  append(kind, raw) {
    // Signatur finns på pump.fun-händelser och är den naturliga nyckeln.
    // Saknas den faller vi tillbaka på mint + typ + tidsstämpel.
    const key = raw?.signature ?? `${kind}:${raw?.mint}:${raw?.timestamp ?? Date.now()}`;
    if (this.seen.has(key)) {
      this.duplicates++;
      return false;
    }
    this.seen.add(key);
    // Håll dedup-mängden bunden. En ström på tusentals händelser i timmen
    // fyller annars minnet på ett dygn.
    if (this.seen.size > 400_000) {
      this.seen = new Set([...this.seen].slice(-200_000));
    }

    const ts = Date.now();
    fs.writeSync(this.#fdFor(ts), `${JSON.stringify({ ts, kind, raw })}\n`);
    this.written++;
    return true;
  }

  /** Läser tillbaka arkivet i tidsordning. Grunden för replay och backtest. */
  *replay() {
    const files = fs.existsSync(this.dir)
      ? fs.readdirSync(this.dir).filter((f) => f.endsWith('.ndjson')).sort()
      : [];
    for (const file of files) {
      const text = fs.readFileSync(path.join(this.dir, file), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          yield JSON.parse(line);
        } catch {
          // En trasig sista rad efter en hård avstängning ska inte stoppa replay.
        }
      }
    }
  }

  stats() {
    return { written: this.written, duplicates: this.duplicates, tracked: this.seen.size };
  }

  close() {
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
    this.fdDay = null;
  }
}
