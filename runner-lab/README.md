# Runner Lab

Live-terminal för pump.fun. Ser varje ny listning i samma sekund den sker,
följer flödet på de som får riktig aktivitet, och kör on-chain-kontroller
innan du rör dem.

```bash
npm start     # live mot pump.fun
npm run replay  # spelar upp ditt eget arkiv (eller syntetisk ström om det är tomt)
npm test
```

Öppna `http://127.0.0.1:4173`. Inga npm-beroenden, ingen API-nyckel, Node ≥ 20.11.

## Datakällor

| Källa | Vad | Kostnad |
|---|---|---|
| `wss://pumpportal.fun/api/data` · `subscribeNewToken` | varje ny listning, med creator-wallet | gratis, ingen nyckel |
| `wss://pumpportal.fun/api/data` · `subscribeMigration` | bonding curve fylld | gratis |
| `wss://pumpportal.fun/api/data` · `subscribeTokenTrade` | trades per mint | mätad — därför bara på kvalificerade mints |
| `api.mainnet-beta.solana.com` | mint/freeze authority, största innehavare | gratis, strypt |

Sätt `SOLANA_RPC_URL` till en egen nod om preflight ofta svarar `okänd` —
publika endpoints stryper hårt.

## Så fungerar kedjan

```
listning ──▶ radar ──▶ kvalificering ──▶ trade-prenumeration + preflight
   │                    (≥ 8 unika köpare                    (authority,
   │                     och nettoinflöde)                     innehavare)
   └──▶ arkiv (alltid, före allt annat)
```

**Kvalificering är inte ett köpråd.** Den svarar på en enda fråga: har den
här token tillräckligt med riktig aktivitet för att vara värd nätverksanrop?
Kontrollerna som avgör risk körs efteråt, och tills de är klara säger radarn
ingenting om säkerhet.

**`okänd` är aldrig `godkänd`.** En kontroll som inte kunde utföras — strypt
RPC, konto som inte går att läsa — visas som okänd och räknas aldrig som
passerad.

**Kvalificering är klibbig, flödet är det inte.** När anropen väl spenderats
på en token spenderas de inte om. Men vänder nettoflödet negativt flaggas
kortet med `flödet vänt`.

## Arkivet

Varje händelse skrivs till `data/events/YYYY-MM-DD.ndjson` **innan** något
annat händer med den, synkront, deduplicerat på signatur.

Det är inte en detalj. Utan arkiv finns ingen framtida backtest, och
`npm run replay` kör uppspelningen genom exakt samma kod som live — annars
divergerar de två och man vet aldrig vilken som validerades.

## Creator-registret

`data/launches.ndjson` växer för varje dygn verktyget körs: vilken wallet som
listade vad, och vad som sedan graduerade.

Det här är den enda delen som inte går att köpa. Publika dataset har det inte
(MELT:s creator-fält är en och samma adress på alla 46 139 rader), och ingen
datatjänst säljer det. Det finns bara om man spelar in strömmen själv.

Uppslagen är punkt-i-tiden-korrekta: en launch räknas varken som lyckad eller
misslyckad förrän den hunnit avgöras, så ett utfall kan aldrig läcka bakåt in
i ett tidigare beslut.

## Vad det inte gör

Lägger inga ordrar och signerar inga transaktioner. Köpknappen öppnar
pump.fun. Det förutsäger inte heller vilken coin som pumpar — de flesta nya
listningar går till noll, och verktygets jobb är att göra det billigare att
se vilka som inte gör det.
