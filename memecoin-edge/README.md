# memecoin-edge

Beslutsstöd för nya Solana-memecoins. Kör mot **riktig data utan API-nyckel**,
fattar ett beslut per token med storlek, ogiltighetsvillkor och utgångsplan,
och för journal över sina egna utfall så att du kan se om det faktiskt
fungerar.

```bash
npm run doctor    # kollar att varje datakälla svarar och att fälten finns kvar
npm start         # live mot Jupiter + DexScreener, dashboard på :8787
npm run preview   # samma beslutslogik mot inspelad data, utan nät
npm test
```

---

## Var edgen sitter

> **Traktion är publik. Uppmärksamhet är köpt. Edgen är gapet mellan dem.**

Den intuitiva idén — bygg en modell som förutsäger vilken coin som pumpar — är
fel. Du konkurrerar mot bottar i samma datacenter som validatorn och du kommer
inte gissa bättre än dem. Men du behöver inte det, för det finns ett gap som
inte handlar om hastighet alls.

En memecoin får uppmärksamhet i en förutsägbar ordning: först kommer riktiga
köpare, sedan fylls den sociala profilen i, sedan betalas boosts, sedan
trending, sedan Telegram-kanalerna. **De flesta verktyg rankar på det som
kommer sist.** Öppnar du en trendinglista tittar du per definition på tokens
där uppmärksamheten redan är betald och de tidiga köparna sitter med vinsten
de ska sälja till dig.

Verktyget mäter båda sidorna separat och rankar på differensen:

- **Traktion** — `numOrganicBuyers`, `numNetBuyers`, `holderChange` från
  Jupiters Token API. Jupiter har redan wash-justerat siffrorna, vilket är
  den enskilt viktigaste anledningen till att det här går att bygga utan
  datalicens. Ingen komponent tittar på volym i USD.
- **Uppmärksamhet** — betalda boosts och ifylld profil från DexScreener,
  plus omsättning mot likviditet, antal innehavare och ålder.

Det ger fyra rutor, och tre av dem är avslag:

| | Låg uppmärksamhet | Hög uppmärksamhet |
|---|---|---|
| **Hög traktion** | **TIDIG — köp** | Sen: du köper vågen, inte starten |
| **Låg traktion** | Tyst: inget händer | **EXIT-LIKVIDITET — aktivt avslag** |

Rutan nere till höger är den viktigaste. Någon har betalat för att du ska se
den token och de organiska köparna uteblir. Det är exakt vad varje
trendinglista visar överst, och verktyget avvisar den kategorin explicit
istället för att bara ge den låg poäng.

### Vad som gör det till en edge och inte bara en åsikt

1. **Den kräver ingen hastighet.** Du frontrunnar inte bottar, du frontrunnar
   marknadsföringen. Fönstret är minuter till timmar, inte millisekunder.
2. **Den mäter något andra inte mäter.** Boost-endpointen är publik och
   gratis, men används nästan alltid för att *hitta* tokens. Vi använder den
   för att sortera bort dem.
3. **Den blir bättre över tid.** `src/edge/calibration.js` lär sig vilka av
   *dina* signalintervall som historiskt betalade, ur din egen journal. Ingen
   kan sälja dig den datan — den är en funktion av dina trösklar.
4. **Den mäter sig själv.** Varje beslut bokförs mot en kontrollgrupp med
   riktiga priser. Efter ett par veckor vet du om det fungerar, istället för
   att lita på någon som påstår det.

---

## Beslutet

En rankad lista är inte ett svar på "vad ska jag köpa". Varje köp bär därför
en komplett plan:

```
KÖP  $EARLY                                        gap +52
Tidig traktion före uppmärksamhet

organisk traktion  69          uppmärksamhet  17
34 organiska köpare/5 min · köptakt ×3.45 mot timmens snitt
inga betalda boosts · ingen profil ännu

STORLEK    $35   konviktion medel
ENTRY      Dela i två delar. Halva nu, halva om 20 organiska
           köpare/5 min håller i sig nästa avläsning.
OGILTIG    Organiska köpare / 5 min faller under 12
           Likviditeten faller under $14 959
           Topp-innehavare stiger över 33 %
           Boosts dyker upp innan priset rört sig
EXIT       50 % vid 2× · 25 % vid 4× · 25 % trailing · hård stop −35 %
           Ur efter 45 min om gapet fallit under 10 och du inte är i vinst
```

**Utgångsstegen är inte pynt.** Med en träffprocent runt 25–30 och en
fettsvansad fördelning är utgångsregeln värd mer än ingångsregeln. Den som
tar hem vinsten vid +30 % kapar exakt den svans som betalar för alla
förluster. Stegen är byggda för att göra tvärtom: säkra insatsen vid 2×, låt
en fjärdedel ligga kvar.

Positionsstorleken tar aldrig mer än 0,5 % av poolens djup, oavsett vad
konviktionen säger. På tunna memecoin-pooler flyttar din egen sälj annars
priset mer än tesen någonsin var värd.

---

## Grindarna

Före all poängsättning körs hårda, binära avslag mot verklig Jupiter-data:

| Grind | Fäller när |
|---|---|
| `mint_authority` | Mint authority ej återkallad |
| `freeze_authority` | Freeze authority ej återkallad — din wallet kan frysas |
| `token_program` | Token-2022 utan verifiering — transfer hooks kan blockera sälj |
| `holder_concentration` | Topp-innehavare äger över 45 % |
| `holder_data` | **Innehavarfördelningen saknas i datan** |
| `lp_locked` | Under 50 % av LP bränd |
| `liquidity_floor` | Likviditet under $12 000 |
| `holder_floor` | Färre än 60 innehavare |
| `stats_data` | **Femminutersstatistik saknas** |

De två fetstilta är principen: **"vi vet inte" är ett giltigt skäl att inte
handla**, och i praktiken den vanligaste orsaken till avslag. En kontroll som
inte kan utföras räknas som underkänd. Det kostar missade chanser och sparar
kapital.

En stark historik i kalibreringen kan höja konviktionen men aldrig öppna en
stängd grind. Det finns ett test som verifierar exakt det.

---

## Datakällorna

Alla gratis, ingen nyckel, ingen registrering.

| Källa | Vad den ger | Tak |
|---|---|---|
| `lite-api.jup.ag/tokens/v2/recent` | Nya tokens, mint/freeze-authority, topp-innehavare, innehavarantal, `organicScore`, 5m/1h organiska köpare | 60/min |
| `api.dexscreener.com/token-boosts/*` | Vem som betalar för synlighet | 60/min |
| `api.dexscreener.com/token-profiles/latest/v1` | Vem som fyllt i sin profil | 60/min |
| `api.dexscreener.com/latest/dex/tokens/*` | Likviditet, ålder, omsättning | 300/min |

Takthållaren i `src/sources/http.js` siktar på 70 % av varje tak. Det är inte
artighet — blir du 429:ad är du avstängd i just det fönster där datan är värd
något.

Kör `npm run doctor` först. Den kontrollerar inte bara att API:erna svarar
utan att fälten vi förlitar oss på finns kvar i svaret. Ett API som byter
fältnamn ger annars ett verktyg som ser ut att fungera men tyst betygsätter
allt till noll.

---

## Journalen är beviset

`data/journal.ndjson` skrivs vid varje beslut och överlever omstarter. Varje
köp bokförs mot en **kontrollgrupp**: tokens som klarade grindarna men fick
BEVAKA eller SKIP. Utan den gruppen mäter du bara hur marknaden gick.

Avkastningen redovisas netto efter 3,5 % rundturskostnad (swapavgift,
prioritetsavgift, slippage åt båda håll). Utan den posten visar varje sådant
här verktyg systematiskt en edge som inte finns — på tunna pooler är kostnaden
ofta större än medianavkastningen.

Förvänta dig den här formen när du börjar samla data:

```
KÖP      n=34    träff 29 %   median −22 %   medel +34 %
KONTROLL n=21    träff 11 %   median −34 %   medel −29 %
```

Tre av fyra köp går back. Medelvärdet är positivt bara för att några få
vinnare bär hela fördelningen. **Det är den verkliga formen på det här
spelet** — ser du ett verktyg som visar 60 % träffsäkerhet har det antingen
glömt kostnaderna eller bara mätt en tjurmarknad.

Skillnaden mot kontrollgruppen är edgen. Är den liten ska du förenkla, inte
lägga till fler signaler.

## Frivilligt: lägre latens med egen RPC

Det här behövs **inte**. Grundläget kör mot riktig data utan nyckel, och
gapet du jagar är minuter brett — inte millisekunder. Men vill du se pooler
i samma sekund de skapas istället för när Jupiter indexerat dem finns två
adaptrar som prenumererar direkt på kedjan:

```bash
SOURCE=solana SOLANA_WS_URL=wss://... SOLANA_RPC_URL=https://... npm start
SOURCE=evm    EVM_WS_URL=wss://...    EVM_RPC_URL=https://...    npm start
```

Publika endpoints stryper `logsSubscribe`, så det kräver Helius, Triton,
QuickNode eller egen nod. Vad adaptrarna gör själva:

- **Solana** — läser mint-kontot för mint- och freeze-authority, och
  innehavarkoncentration från de största token-kontona med LP och
  burn-adress borträknade.
- **EVM** — härleder `PairCreated`-topicen med egen keccak256
  (`src/util/keccak.js`, verifierad mot testvektorer), läser `owner()` och
  upptäcker uppgraderbara proxies via EIP-1967-sloten. `simulateSell()` gör
  en riktig `eth_call` med state override för honeypot-test.

Vägde jag in det i planeringen? Nej. Hastighet är den dimension där du
garanterat förlorar, och hela tesen bygger på att inte tävla där.

---

## Simulatorn

`npm run backtest` kör en separat kodväg: en launch-simulator med sju
arketyper och känt facit, mot rug-filtret i `src/safety/`. Den finns för att
verifiera att grindlogiken fångar de fällor den ska — 0 av 191 fällor tog sig
igenom i senaste körningen.

Den säger **ingenting** om avkastning. Ett backtest mot en simulator du själv
skrivit mäter i bästa fall din egen modell. Live-journalen är det som räknas.

---

## Filer

```
src/
  sources/jupiter.js      Token API v2 — säkerhet + wash-justerad traktion
  sources/dexscreener.js  Boosts och profiler = uppmärksamhetssignalen
  sources/http.js         Takthållning, timeout, backoff
  edge/attention.js       Attention gap-modellen och de fyra rutorna
  edge/gates.js           Hårda grindar mot verklig data, fail closed
  edge/decision.js        Beslut: storlek, entry, ogiltighet, utgång
  edge/calibration.js     Lär av din egen journal
  live.js                 Tre takter mot tre API:er
  journal.js              Framåtriktad bokföring, överlever omstart
  doctor.js               Kontrollerar att fälten finns kvar
  preview.js              Riktig beslutslogik mot inspelad data
  backtest.js             Rug-filtret mot känt facit
web/                      Beslutstavla, kvadrantvy, SSE
```

Inga npm-beroenden. Node ≥ 20.11.

---

## Vad det här inte är

Det är inte ett handelssystem — det lägger inga ordrar. Det är inte heller en
prognos: gapet säger att du är *tidig*, inte att token kommer gå upp. De
flesta tidiga tokens går ned ändå, vilket journalen kommer visa dig svart på
vitt.

Det verktyget faktiskt gör är tre saker: sorterar bort det som är byggt för
att inte gå att sälja, sorterar bort det någon betalat för att du ska köpa,
och tvingar fram en utgångsplan innan du går in. Om det räcker för att göra
spelet lönsamt för dig vet varken jag eller du förrän journalen har ett par
hundra rader.

Memecoin-handel är negativ-summa efter avgifter för de flesta deltagare.
Riskera inget du inte kan förlora.
