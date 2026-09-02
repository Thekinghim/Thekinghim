# memecoin-edge

En scanner som letar tidig traktion i nya memecoins **och** filtrerar bort de
tokens som är byggda för att ta dina pengar. Kör utan API-nycklar mot en
simulerad launch-ström, och mot Solana eller EVM när du kopplar på en RPC.

```bash
npm start          # dashboard på http://127.0.0.1:8787 (simulerad data)
npm run backtest   # kör filtret mot 400 launches med känt facit
npm test
```

---

## Var edgen faktiskt sitter

Den intuitiva idén är att bygga en modell som förutsäger vilken memecoin som
pumpar. Den idén är fel, och det är värt att säga tydligt innan man skriver
kod: du konkurrerar mot bottar som sitter i samma datacenter som validatorn
och agerar på millisekunder. Du kommer inte vinna på att gissa bättre.

Det finns tre ställen där en ensam person faktiskt kan ha ett övertag, och det
här projektet är byggt kring dem:

**1. Filtrering slår prediktion.** Ungefär hälften av alla nya pooler är
konstruerade bedrägerier — honeypots, dragna pooler, bundlade launches. Att
undvika dem kräver ingen prognos, bara kontroller som går att göra
deterministiskt on-chain. Det är den enda delen av problemet där du kan ha
*rätt* istället för att ha tur. `src/safety/` gör det jobbet, och i backtestet
är det den delen som står för nästan hela skillnaden i utfall.

**2. Signaler som kostar pengar att förfalska.** Volym är gratis att fejka —
en wallet kan wash-tradea fram vilken kurva som helst för avgifternas
kostnad. Unika köpare, innehavartillväxt och accelererande nettoinflöde kostar
riktiga wallets och riktigt kapital. Därför tittar `src/scoring/momentum.js`
inte på volym i USD över huvud taget. Det finns ett test som verifierar exakt
det: 200 wash-affärer från en enda wallet ska inte ge momentum.

**3. Att mäta dig själv.** Nästan alla verktyg i den här genren visar en lista
och slutar där. Utan facit vet du aldrig om listan är bättre än slumpen.
`src/paper/ledger.js` bokför varje larm mot **en kontrollgrupp** — tokens som
klarade grindarna men inte tröskeln. Skillnaden mellan grupperna *är* din edge,
mätt. Är den liten ska du förenkla systemet, inte lägga till fler signaler.

---

## Kedjan

```
ny pool  ─▶  hårda grindar  ─▶  riskpoäng  ─▶  momentumpoäng  ─▶  larm  ─▶  bokföring
             (binärt avslag)    (0–100)        (0–100)                     (mot kontrollgrupp)
```

Ordningen är inte godtycklig. Grindarna är billigast och körs först, så en
honeypot kostar aldrig mer än några jämförelser. Momentum beräknas bara för
det som redan är köpbart — att ranka tokens du ändå inte skulle röra är
bortkastad CPU och, värre, bortkastad uppmärksamhet.

### Lager 1 — hårda grindar (`src/safety/rules.js`)

Varje regel svarar på samma fråga: *kan utgivaren ta mina pengar utan att sälja
på marknaden?* Är svaret ja finns inget pris som gör positionen vettig. Därför
är det här binära avslag, inte poängavdrag.

| Grind | Fäller när |
|---|---|
| `mint_authority` | Mint authority aktiv — supply kan spädas ut när som helst |
| `freeze_authority` | Freeze authority aktiv — din wallet kan frysas så att du inte kan sälja |
| `lp_locked` | Under 50 % av LP bränd/låst — poolen kan dras |
| `sell_simulation` | Simulerad sälj går inte igenom — honeypot |
| `tax` | Köp- eller säljskatt över 10 % |
| `immutable` | Uppgraderbar proxy eller muterbar metadata — reglerna kan bytas efter köp |
| `liquidity_floor` | Likviditet under $8 000 — du blir exit-likviditeten |
| `deployer_history` | Deployern kopplad till tidigare rugs |

**Fail closed.** En kontroll som inte kan utföras räknas som underkänd. Kan vi
inte bevisa att en token är säker behandlas den som osäker. Det kostar missade
chanser och sparar kapital, och i den asymmetrin ligger hela strategins
hållbarhet.

### Lager 2 — mjuk risk

Saker som inte är bedrägeri i sig men gör utfallet ensidigt: topp-10-koncentration,
dev-innehav, andel supply köpt i listningsblocket (bundlad launch), andel köpare
med wallets yngre än 24 timmar, tunn likviditet, få innehavare. Summeras till
0–100. Över 45 → inget larm.

Det är det här lagret som fångar `bundle_dump` i backtestet: den arketypen
klarar alla hårda grindar och stoppas ändå, varje gång.

### Lager 3 — momentum (`src/scoring/momentum.js`)

| Komponent | Vikt | Varför |
|---|---|---|
| Unika köpare per minut | 30 | Kostar riktiga wallets att förfalska |
| Nettoinflödets acceleration | 20 | Senaste halvan av fönstret mot den tidigare — ett flöde som planar ut är slutet, inte början |
| Köpare/säljare-kvot | 15 | Vem som lämnar säger mer än hur mycket som handlas |
| Innehavartillväxt per minut | 15 | Verklig spridning, inte omflyttning |
| Wallets från PnL-listan | 15 | Följ kapital som har rätt oftare än du |
| Köparspridning | 5 | Många små distinkta köpare slår en wallet som spelar teater |

Larmfönstret är **45 sekunder till 30 minuter** efter listning. Tidigare finns
inte tillräckligt underlag; senare är informationen inte längre asymmetrisk —
då syns token i alla andra scanners också.

---

## Vad backtestet säger

```
$ npm run backtest

Tratten
  Upptäckta pooler            400
  Fällda av hårda grindar     163
  Under risk-/momentumtröskel  64
  Larm                         99

Larm per arketyp
  ok     runner          27 /  28   (96,4 %)
  ok     organic_fade    71 /  79   (89,9 %)
  ok     slow_bleed       1 / 102   ( 1,0 %)
  FÄLLA  lp_pull          0 /  61   ( 0,0 %)
  FÄLLA  honeypot         0 /  50   ( 0,0 %)
  FÄLLA  mint_rug         0 /  37   ( 0,0 %)
  FÄLLA  bundle_dump      0 /  43   ( 0,0 %)

  Andel fällor i flödet   47,8 %
  Andel fällor i larmen    0,0 %

STRATEGI  n=99                    KONTROLL  n=64
  5m   träff 52,5 %  median  +1,9 %    5m   träff  0,0 %  median -10,5 %
  15m  träff 27,3 %  median -28,1 %    15m  träff  0,0 %  median -31,3 %
  1h   träff 27,3 %  median -43,4 %    1h   träff  0,0 %  median -70,5 %
```

Två saker är värda att stanna vid.

**Medianen är negativ även för larmen.** Vid 1 h träffar 27 % — tre av fyra
larm går back, medianen är −43 %, och medelvärdet ligger ändå runt noll för att
några få runners bär hela fördelningen. Det är den verkliga formen på det här
spelet, och den har direkta konsekvenser: positionsstorleken måste tåla en lång
rad förluster, och en strategi som tar hem vinster tidigt kapar exakt den svans
som betalar för allt annat. Ett verktyg som visar dig 60 % träffsäkerhet har
antingen glömt kostnaderna eller bara mätt en tjurmarknad.

**Skillnaden mot kontrollgruppen är stor.** Kontrollgruppen — som klarade alla
hårda grindar — träffar 0 % och tappar 70 % av medianpositionen på en timme.
Det är där filtrets värde syns.

> Siffrorna kommer från en simulator, inte från marknaden. De visar att kedjan
> hänger ihop och att lagren gör det de ska mot kända arketyper. De säger
> **ingenting** om avkastning mot riktig data. Ett backtest mot en simulator du
> själv skrivit mäter i bästa fall din egen modell.

Alla siffror är netto efter 3,5 % rundturskostnad (swapavgift, prioritetsavgift,
slippage åt båda håll). Utan den posten visar backtestet systematiskt en edge
som inte finns — på tunna pooler är kostnaden ofta större än medianavkastningen.
Skruva med `ROUND_TRIP_COST_PCT`.

---

## Koppla på riktig data

```bash
# Solana — pump.fun, PumpSwap, Raydium
SOURCE=solana SOLANA_WS_URL=wss://... SOLANA_RPC_URL=https://... npm start

# EVM — valfri Uniswap V2-kompatibel factory
SOURCE=evm EVM_WS_URL=wss://... EVM_RPC_URL=https://... npm start
```

Publika endpoints stryper `logsSubscribe` och är oanvändbara här — du behöver
Helius, Triton, QuickNode eller en egen nod.

Vad adaptrarna gör själva, utan tredjepartstjänst:

- **Solana** — läser mint-kontot och avgör om mint- och freeze-authority är
  återkallade (de två viktigaste kontrollerna), samt innehavarkoncentration
  från de största token-kontona med LP och burn-adress borträknade.
- **EVM** — härleder `PairCreated`-topicen med egen keccak256
  (`src/util/keccak.js`, verifierad mot testvektorer), läser `owner()` och
  upptäcker uppgraderbara proxies via EIP-1967-sloten. `simulateSell()`
  gör en riktig `eth_call` med state override för honeypot-test.

Vad de **inte** kan göra själva: LP-lås hos tredjepartslåsare, skatter, och
dev-wallethistorik. De fälten lämnas i sitt osäkra läge, vilket betyder att
grindarna fäller tills du kopplar in en datakälla. Det är avsiktligt — koppla
in din leverantör i `handleNewPool` respektive `handleNewPair`, och behåll
fail-closed.

---

## Filer

```
src/
  config.js            Alla trösklar på ett ställe
  pipeline.js          Kedjan: pool → grindar → risk → momentum → larm → bok
  backtest.js          Kör filtret mot facit
  safety/rules.js      De hårda grindarna och riskfaktorerna
  scoring/window.js    Rullande handelsfönster per token
  scoring/momentum.js  Momentumpoäng
  paper/ledger.js      Bokföring mot kontrollgrupp
  ingest/mock.js       Launch-simulator med sju arketyper och facit
  ingest/solana.js     logsSubscribe + mint-authority-kontroll
  ingest/evm.js        PairCreated + proxy- och ägarkontroll
  util/keccak.js       Keccak-256 (Node saknar den inbyggd)
web/                   Dashboard, SSE, noll beroenden
```

Inga npm-beroenden. Node ≥ 20.11.

---

## Vad det här inte är

Det är inte ett handelssystem, och det finns ingen orderläggning i koden.
Larmen har ingen exekveringshastighet — ser du ett larm i webbläsaren har en
bot sett samma sak tidigare. Det som går att bygga bort med den här koden är
den kategori förluster som kommer av att köpa något som var konstruerat för att
inte gå att sälja. Den kategori som kommer av att gissa fel på vad marknaden
vill ha finns kvar, och backtestets median på −43 % är den ärligaste siffran i
hela repot.

Memecoin-handel är negativ-summa efter avgifter för de flesta deltagare.
Riskera inget du inte kan förlora.
