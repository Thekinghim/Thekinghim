/**
 * HTTP-klient med takthållning, timeout och backoff.
 *
 * Alla källor vi använder är gratis och nyckelfria, men de har hårda
 * minuttak. Överskrider du dem får du 429 och blir avstängd en stund —
 * mitt i det fönster där datan är värd något. Takthållaren är därför inte
 * en artighet mot leverantören, den är en förutsättning för att verktyget
 * ska fungera när det behövs.
 */

export class RateLimiter {
  /** @param {number} perMinute Tak enligt leverantörens dokumentation. */
  constructor(perMinute) {
    // Vi siktar på 70 % av taket. Marginalen täcker klockglidning och de
    // extra anrop som en enskild token-uppslagning kan orsaka.
    this.minIntervalMs = 60_000 / (perMinute * 0.7);
    this.nextAllowedAt = 0;
  }

  async take() {
    const now = Date.now();
    const wait = Math.max(0, this.nextAllowedAt - now);
    this.nextAllowedAt = Math.max(now, this.nextAllowedAt) + this.minIntervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

/**
 * @param {string} url
 * @param {{limiter?: RateLimiter, timeoutMs?: number, retries?: number, label?: string}} [opts]
 */
export async function getJson(url, opts = {}) {
  const { limiter, timeoutMs = 10_000, retries = 2, label = 'http' } = opts;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (limiter) await limiter.take();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'memecoin-edge/0.2' },
      });

      if (res.status === 429) {
        // Respektera Retry-After när den finns; annars backa av exponentiellt.
        const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      const last = attempt === retries;
      if (last) throw new Error(`${label}: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
      await new Promise((r) => setTimeout(r, 2 ** attempt * 500));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${label}: slut på försök`);
}
