import { saturate, clamp } from '../util/stats.js';

/**
 * Attention gap — verktygets faktiska tes.
 *
 * Påståendet: traktion är publik och gratis att mäta, medan uppmärksamhet
 * till stor del är *köpt* och därför också mätbar. En token där riktiga
 * köpare strömmar in men ingen ännu har betalat för synlighet befinner sig
 * före marknadsföringsvågen. En token som trendar med köpta boosts men utan
 * organiska köpare är exit-likviditet.
 *
 * Det här är inte en prognos om pris. Det är ett påstående om ordningsföljd:
 * organiska köpare kommer före boosts och sociala länkar, och de flesta
 * verktyg rankar på precis det som kommer sist. Vi rankar på differensen.
 *
 * Ingen komponent bygger på volym i USD. Jupiters `numOrganicBuyers` och
 * `buyOrganicVolume` är redan wash-justerade, och det är hela poängen med
 * att använda dem istället för råa siffror.
 */

/** Ankarvärden för normalisering. Samlade här för att gå att kalibrera. */
export const ANCHORS = {
  organicBuyers5m: 45, // 45 organiska köpare på 5 min = full poäng
  netBuyers5m: 35,
  holderGrowthPct5m: 12, // +12 % innehavare på 5 min är mycket starkt
  organicInflowUsd5m: 25_000,
  boostUsd: 300, // ~$300 i boosts = tydligt betald synlighet
  socialLinks: 4,
  volumeToLiquidity1h: 4,
  holderCount: 3_000,
  ageMinutes: 240,
};

/**
 * Hur mycket riktigt köptryck token har just nu, 0–100.
 * @param {ReturnType<typeof import('../sources/jupiter.js').normalizeToken>} t
 */
export function tractionScore(t) {
  const s5 = t.stats5m ?? {};
  const s1h = t.stats1h ?? {};

  // Andel av köpen som Jupiter bedömer som organiska. Låg andel betyder att
  // aktiviteten till stor del är bottar som handlar med sig själva.
  const organicShare =
    s5.numBuys > 0 && s5.numOrganicBuyers !== null
      ? clamp(s5.numOrganicBuyers / s5.numBuys, 0, 1)
      : null;

  // Accelererar det just nu? 5-minutersstakten mot timmens genomsnittstakt.
  // En token som redan toppat har hög timsiffra och fallande 5-minuterssiffra.
  const rate5m = s5.numOrganicBuyers ?? 0;
  const rate1hPer5m = (s1h.numOrganicBuyers ?? 0) / 12;
  const acceleration = rate1hPer5m > 0.5 ? rate5m / rate1hPer5m : rate5m > 3 ? 2 : 0;

  const holderGrowthPct =
    t.holderCount > 0 && s5.holderChange !== null ? (s5.holderChange / t.holderCount) * 100 : null;

  const organicInflow = (s5.buyOrganicVolume ?? 0) - (s5.sellOrganicVolume ?? 0);

  const components = [
    {
      id: 'organicBuyers',
      weight: 28,
      value: saturate(s5.numOrganicBuyers ?? 0, ANCHORS.organicBuyers5m),
      detail: `${fmt(s5.numOrganicBuyers)} organiska köpare / 5 min`,
    },
    {
      id: 'organicShare',
      weight: 16,
      value: organicShare ?? 0,
      detail:
        organicShare === null
          ? 'organisk andel okänd'
          : `${Math.round(organicShare * 100)} % av köpen är organiska`,
    },
    {
      id: 'acceleration',
      weight: 20,
      value: saturate(acceleration, 2.5),
      detail: `köptakt ×${acceleration.toFixed(2)} mot timmens snitt`,
    },
    {
      id: 'netBuyers',
      weight: 14,
      value: saturate(s5.numNetBuyers ?? 0, ANCHORS.netBuyers5m),
      detail: `${fmt(s5.numNetBuyers)} fler köpare än säljare / 5 min`,
    },
    {
      id: 'holderGrowth',
      weight: 14,
      value: saturate(holderGrowthPct ?? 0, ANCHORS.holderGrowthPct5m),
      detail:
        holderGrowthPct === null
          ? 'innehavartillväxt okänd'
          : `+${holderGrowthPct.toFixed(1)} % innehavare / 5 min`,
    },
    {
      id: 'organicInflow',
      weight: 8,
      value: organicInflow > 0 ? saturate(organicInflow, ANCHORS.organicInflowUsd5m) : 0,
      detail:
        organicInflow > 0
          ? `+$${Math.round(organicInflow).toLocaleString('sv-SE')} organiskt nettoinflöde / 5 min`
          : 'organiskt nettoutflöde',
    },
  ];

  return build(components);
}

/**
 * Hur mycket uppmärksamhet token redan fått, 0–100.
 * Högt värde är inte dåligt i sig — det betyder bara att du är sen.
 * @param {*} t
 * @param {{boostUsd?: number, socialCount?: number, volume1h?: number, liquidityUsd?: number}} attention
 */
export function attentionScore(t, attention = {}) {
  const boostUsd = attention.boostUsd ?? 0;
  const socialCount = attention.socialCount ?? 0;
  const liquidity = attention.liquidityUsd ?? t.liquidityUsd ?? 0;
  const volume1h = attention.volume1h ?? 0;
  const churn = liquidity > 0 ? volume1h / liquidity : 0;
  const ageMinutes = t.createdAt ? (Date.now() - t.createdAt) / 60_000 : null;

  const components = [
    {
      id: 'paidBoosts',
      weight: 34,
      value: saturate(boostUsd, ANCHORS.boostUsd),
      detail: boostUsd > 0 ? `$${Math.round(boostUsd)} i betalda boosts` : 'inga betalda boosts',
    },
    {
      id: 'socialPresence',
      weight: 22,
      value: saturate(socialCount, ANCHORS.socialLinks),
      detail: socialCount > 0 ? `${socialCount} sociala länkar/profil ifylld` : 'ingen profil ännu',
    },
    {
      id: 'churn',
      weight: 18,
      value: saturate(churn, ANCHORS.volumeToLiquidity1h),
      detail: `omsättning ×${churn.toFixed(1)} av likviditeten / h`,
    },
    {
      id: 'distribution',
      weight: 16,
      value: saturate(t.holderCount ?? 0, ANCHORS.holderCount),
      detail: `${fmt(t.holderCount)} innehavare`,
    },
    {
      id: 'age',
      weight: 10,
      value: ageMinutes === null ? 0.5 : saturate(ageMinutes, ANCHORS.ageMinutes),
      detail: ageMinutes === null ? 'ålder okänd' : `${formatAge(ageMinutes)} gammal`,
    },
  ];

  return build(components);
}

/**
 * Gapet, och vilken av fyra rutor token hamnar i.
 *
 * Rutorna är det som gör signalen läsbar. `exit_liquidity` är den viktigaste:
 * det är kombinationen som varje trendinglista i branschen visar överst.
 */
export function attentionGap(t, attention = {}) {
  const traction = tractionScore(t);
  const noise = attentionScore(t, attention);
  const gap = clamp(traction.score - noise.score, -100, 100);

  const quadrant =
    traction.score >= 55 && noise.score < 40
      ? 'early'
      : traction.score >= 55
        ? 'crowded'
        : noise.score >= 45
          ? 'exit_liquidity'
          : 'quiet';

  return {
    gap: Math.round(gap * 10) / 10,
    traction,
    attention: noise,
    quadrant,
    quadrantLabel: {
      early: 'Tidig — traktion före uppmärksamhet',
      crowded: 'Sen — traktionen finns men alla ser den redan',
      exit_liquidity: 'Exit-likviditet — betald synlighet utan organiska köpare',
      quiet: 'Tyst — inget händer',
    }[quadrant],
  };
}

function build(components) {
  const total = components.reduce((sum, c) => sum + c.value * c.weight, 0);
  const max = components.reduce((sum, c) => sum + c.weight, 0);
  return {
    score: Math.round((total / max) * 1000) / 10,
    factors: components.map((c) => ({
      id: c.id,
      points: Math.round(c.value * c.weight * 10) / 10,
      detail: c.detail,
    })),
  };
}

const fmt = (v) => (v === null || v === undefined ? '?' : Math.round(v).toLocaleString('sv-SE'));

function formatAge(minutes) {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)} h`;
  return `${(minutes / 1440).toFixed(1)} dygn`;
}
