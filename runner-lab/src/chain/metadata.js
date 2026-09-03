/**
 * Hämtar tokenens metadata (bild, beskrivning, socials) från dess URI.
 *
 * Det här är den enskilt största anledningen att man annars måste öppna
 * pump.fun: bilden, beskrivningen och länkarna finns inte i strömmen, bara
 * en URI till dem. Vi hämtar den på servern — dels för att slippa CORS,
 * dels för att kunna cacha så att hundra kort inte gör hundra hämtningar.
 *
 * IPFS-gateways är opålitliga. Vi provar flera i tur och ordning och ger upp
 * tyst; en token utan bild är inte ett fel, den ska bara ritas utan bild.
 */
const GATEWAYS = [
  (cid) => `https://ipfs.io/ipfs/${cid}`,
  (cid) => `https://cloudflare-ipfs.com/ipfs/${cid}`,
  (cid) => `https://gateway.pinata.cloud/ipfs/${cid}`,
];

/** @type {Map<string, any>} mint -> metadata (eller null om vi gett upp) */
const cache = new Map();
const inflight = new Map();

const cidOf = (uri) => {
  const m = /\/ipfs\/([A-Za-z0-9]+)/.exec(uri ?? '');
  return m ? m[1] : null;
};

async function tryFetch(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * @param {string} mint
 * @param {string|null} uri
 * @returns {Promise<{image:string|null, description:string, twitter:string|null,
 *   telegram:string|null, website:string|null} | null>}
 */
export async function fetchTokenMetadata(mint, uri) {
  if (cache.has(mint)) return cache.get(mint);
  if (inflight.has(mint)) return inflight.get(mint);
  if (!uri) {
    cache.set(mint, null);
    return null;
  }

  const job = (async () => {
    const cid = cidOf(uri);
    const urls = cid ? GATEWAYS.map((g) => g(cid)) : [uri];

    for (const url of urls) {
      try {
        const json = await tryFetch(url);
        const image = json.image ?? json.imageUrl ?? null;
        const imageCid = cidOf(image);
        const meta = {
          // Normalisera bild-URL:en till en gateway som svarar, annars
          // renderar klienten en trasig bild och det ser ut som en bugg.
          image: imageCid ? GATEWAYS[0](imageCid) : image,
          description: String(json.description ?? '').slice(0, 400),
          twitter: json.twitter ?? null,
          telegram: json.telegram ?? null,
          website: json.website ?? null,
        };
        cache.set(mint, meta);
        return meta;
      } catch {
        // Nästa gateway.
      }
    }
    cache.set(mint, null);
    return null;
  })();

  inflight.set(mint, job);
  try {
    return await job;
  } finally {
    inflight.delete(mint);
  }
}

export const metadataStats = () => ({ cached: cache.size, inflight: inflight.size });
