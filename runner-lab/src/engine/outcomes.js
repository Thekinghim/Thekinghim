import fs from 'node:fs';
import path from 'node:path';

/**
 * Utfallsbok: vad omdömet faktiskt var värt.
 *
 * Varje token som får ett omdöme bokförs, och sedan mäts vad som hände.
 * Utan den här filen är KÖP en åsikt; med den är det ett påstående med en
 * siffra bakom, och det är den enda formen som går att sälja.
 *
 * Utfallsmåttet är **graduation** — att bonding curve fylls och token
 * migrerar. Valet är inte godtyckligt:
 *
 *   - Det är binärt. Ingen tolkning behövs.
 *   - Det observeras på `subscribeMigration`, som är gratis och gäller alla
 *     mints, även de vi slutat prenumerera på. Ett avkastningsmått hade
 *     krävt att vi betalade för att följa varje token i timmar.
 *   - Det är sällsynt nog att bära information. Skräp graduerar nästan
 *     aldrig; det som springer gör det praktiskt taget alltid.
 *
 * Toppnoteringen bokförs också, men bara så länge token var spårad. Den är
 * därför en undre gräns, inte ett facit, och märks som sådan.
 */

/** Hur länge en dom får vänta på utfall innan den räknas som avgjord. */
const SETTLE_MS = 6 * 3600_000;

export class OutcomeLedger {
  /** @param {{dir: string}} cfg */
  constructor(cfg) {
    this.dir = cfg.dir;
    this.file = path.join(cfg.dir, 'outcomes.ndjson');
    /** @type {Map<string, any>} */
    this.rows = new Map();
    fs.mkdirSync(cfg.dir, { recursive: true });
    this.#load();
  }

  #load() {
    if (!fs.existsSync(this.file)) return;
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        // Filen är en logg; sista raden för en mint gäller.
        this.rows.set(row.mint, row);
      } catch {
        // En trasig rad efter en hård avstängning ska inte ta ner boken.
      }
    }
  }

  #append(row) {
    fs.appendFileSync(this.file, `${JSON.stringify(row)}\n`);
  }

  /**
   * Bokför en dom. Bara den **första** domen per token räknas.
   *
   * Skälet är att ett omdöme som får ändra sig i efterhand alltid ser bra ut:
   * skriver man över VÄNTA med KÖP när token redan börjat springa mäter man
   * sin egen efterklokhet. Domen som bokförs är den som fanns när den hade
   * kunnat handlas på.
   *
   * @param {*} row Rad från Radar.board().
   */
  grade(row) {
    if (this.rows.has(row.mint)) return false;
    const verdict = row.verdict?.verdict;
    if (!verdict) return false;

    const entry = {
      mint: row.mint,
      symbol: row.symbol ?? '',
      creator: row.creator ?? null,
      verdict,
      reason: row.verdict.reason ?? '',
      gradedAt: Date.now(),
      ageAtGradeSec: row.ageSec,
      mcapAtGrade: row.metrics?.marketCapSol || row.launchMarketCapSol || 0,
      curveAtGrade: row.curveProgress,
      buyersAtGrade: row.metrics?.uniqueBuyers ?? 0,
      peakMcap: row.metrics?.marketCapSol || row.launchMarketCapSol || 0,
      // Toppen mäts bara så länge token var spårad, så den är en undre gräns.
      peakIsLowerBound: true,
      graduated: false,
      graduatedAt: null,
    };
    this.rows.set(row.mint, entry);
    this.#append(entry);
    return true;
  }

  /** Uppdaterar toppnoteringen medan token fortfarande följs. */
  mark(mint, marketCapSol) {
    const row = this.rows.get(mint);
    if (!row || !(marketCapSol > row.peakMcap)) return;
    row.peakMcap = marketCapSol;
    // Skrivs inte till disk vid varje tick — bara när token avgörs eller
    // processen stängs. En topp som skrivs tusen gånger är tusen skrivningar.
    row.dirty = true;
  }

  recordGraduation(mint, ts = Date.now()) {
    const row = this.rows.get(mint);
    if (!row || row.graduated) return false;
    row.graduated = true;
    row.graduatedAt = ts;
    row.dirty = false;
    this.#append(row);
    return true;
  }

  /** Skriver ned toppnoteringar som ändrats. Körs på egen takt. */
  flush() {
    for (const row of this.rows.values()) {
      if (!row.dirty) continue;
      row.dirty = false;
      this.#append(row);
    }
  }

  /**
   * Träffbilden per omdöme.
   *
   * En dom räknas som avgjord när den antingen graduerat eller passerat
   * fönstret. Odömda tomma rader räknas inte — annars ser färska domar ut
   * som misslyckanden bara för att de är färska.
   */
  stats(now = Date.now()) {
    const classes = { 'KÖP': null, 'VÄNTA': null, 'SKIPPA': null };

    for (const key of Object.keys(classes)) {
      const all = [...this.rows.values()].filter((r) => r.verdict === key);
      const settled = all.filter((r) => r.graduated || now - r.gradedAt >= SETTLE_MS);
      const graduated = settled.filter((r) => r.graduated);
      const multiples = settled
        .map((r) => (r.mcapAtGrade > 0 ? r.peakMcap / r.mcapAtGrade : null))
        .filter((x) => x !== null && Number.isFinite(x));

      classes[key] = {
        graded: all.length,
        settled: settled.length,
        pending: all.length - settled.length,
        graduated: graduated.length,
        graduationRate: settled.length ? graduated.length / settled.length : null,
        medianPeakMultiple: median(multiples),
        p75PeakMultiple: percentile(multiples, 75),
      };
    }

    const allSettled = [...this.rows.values()].filter((r) => r.graduated || now - r.gradedAt >= SETTLE_MS);
    const base = allSettled.length
      ? allSettled.filter((r) => r.graduated).length / allSettled.length
      : null;

    return {
      classes,
      baseGraduationRate: base,
      totalGraded: this.rows.size,
      settleHours: SETTLE_MS / 3600_000,
      /**
       * Lyftet är hela poängen: hur mycket bättre KÖP graduerar än flödet i
       * stort. Är det inte tydligt över 1 tillför omdömet ingenting.
       */
      lift: base && classes['KÖP'].graduationRate !== null
        ? classes['KÖP'].graduationRate / base
        : null,
    };
  }

  recent(limit = 40) {
    return [...this.rows.values()]
      .sort((a, b) => b.gradedAt - a.gradedAt)
      .slice(0, limit)
      .map(({ dirty, ...r }) => r);
  }
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
