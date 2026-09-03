# Runner Lab

Live-terminal för pump.fun. Ser varje ny listning i samma sekund den sker,
följer flödet på de som får riktig aktivitet, och kör on-chain-kontroller
innan du rör dem.

```bash
npm start     # live mot pump.fun
npm run replay  # spelar upp ditt eget arkiv (eller syntetisk ström om det är tomt)
npm test
```

Öppna `http://localhost:4173`. Inga npm-beroenden, ingen API-nyckel, Node ≥ 20.11.

Servern är byggd för att köras publikt: den håller **en** anslutning till
pump.fun och sänder ut till alla besökare över SSE, så besökare kostar en
öppen anslutning var — inte ett API-anrop var. Se [DEPLOY.md](DEPLOY.md).

`npm run export-demo` skriver en självbärande HTML-fil av det terminalen visar
just nu, med åldersgräns, för den som vill dela en ögonblicksbild.

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

## Träffbilden

`data/outcomes.ndjson` bokför varje dom och vad som sedan hände. Utfallsmåttet
är **graduation** — att bonding curve fylls och token migrerar.

Valet är inte godtyckligt. Det är binärt, det observeras på den gratis
`subscribeMigration`-strömmen även för mints vi slutat prenumerera på, och det
är sällsynt nog att bära information. Ett avkastningsmått hade krävt att vi
betalade för att följa varje token i timmar.

Tre regler som gör siffran ärlig:

- **Bara första domen räknas.** En dom som får skrivas över när token redan
  börjat springa mäter efterklokhet, inte träffsäkerhet.
- **Färska domar räknas inte som misslyckade.** En dom är avgjord när den
  graduerat eller passerat sex timmar.
- **Inga siffror utan underlag.** Under 20 avgjorda domar visar panelen `—`.
  En graduationsandel räknad på tre domar är brus.

Talet som avgör allt är **lyftet**: hur mycket oftare KÖP graduerar än flödet
i stort. Ligger det inte tydligt över 1 tillför omdömet ingenting, och då ska
det förenklas — inte kompletteras med fler signaler.

Toppnoteringen bokförs också men mäts bara medan token var spårad, så den är
en undre gräns och märks som sådan.

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
