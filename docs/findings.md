# Findings

## Fas 0 — baslinjen reproducerad (2026-09-02)

Verifierad med `packages/research/melt_repro/verify_baseline.py` mot
`git-disl/melt` @ `0732bcf`.

| Påstående i CLAUDE.md | Publicerat | Uppmätt | Status |
|---|---|---|---|
| Andel high-risk | 84,1 % | 84,1 % (34 890 / 41 470) | Exakt |
| Andel low-risk | 4,5 % | 4,5 % (1 878) | Exakt |
| Under 20 % av migrationspris | 60,3 % | 60,3 % | Exakt |
| Bästa modell (MLP), AUPRC | 0,573 | 0,573976 | Inom ±0,03 |

AUPRC räknades om från grunden ur prediktionsfilerna mot `label.csv` och
matchar filnamnens värden till ~1e-7 för samtliga sex modeller. Det bekräftar
att vi tolkar deras uppgift rätt — särskilt klasspolariteten.

### Klasspolariteten är inverterad

I `dataset.load_dataset` sätts etiketten till `0 if "high" else 1`. Den
**positiva klassen i AUPRC är alltså icke-högrisk**. Ska man rankaraliknande
"efter risk" sorterar man på *stigande* sannolikhet. Det här är den enskilt
lättaste platsen att vända en hel analys upp och ned på.

### Splitten är kronologisk

Sortering på `mint_ts`, första 70 % till träning, sista 30 % till test, och
bara träningsdelen shufflas. Ingen läckage bakåt i tiden. Prefiltret är
`time_span_valid >= 60` och `holder_num >= 100`, vilket matchar PLAN.md.

### Fettsvansen, mätt

`return_ratio` över hela datasetet:

```
median  −0,6844      p25  −0,8651      p75  −0,2061
träff    19,7 %      medel  +1759,94
```

Medelvärdet är **+176 000 %** medan medianen är −68 %. En handfull tokens
dominerar hela medelvärdet. Det här är inte en teoretisk varning — det är
CLAUDE.md:s regel 3 demonstrerad på den faktiska datan, och skälet till att
inget resultat i det här projektet får rapporteras som ett naket medelvärde.

## Blockerare

**Google Drive är inte nåbart från körmiljön** (`drive.google.com` → ingen
anslutning). MELT distribuerar `feature.pkl` och rå-transaktionerna där.
Utan dem går det inte att:

- träna om modellerna (Fas 0, uppgift 3)
- köra urvalssimuleringen med riktiga migrationspriser (Fas 0, uppgift 4)
- bygga entitetsupplösning (Fas 1) — den kräver transaktionsnivå

Det som **går** utan dem är verifieringen ovan, som använder de labels och
prediktioner som ligger i repot.

Nästa steg kräver att `feature.pkl` (och för Fas 1 även `pre_migration_tx.zip`
och `bundle.zip`) hämtas på en maskin med Drive-åtkomst och läggs under
`data/melt/`.

## Licensblockerare för kommersiell användning

MELT släpps under **CC BY-NC 4.0** — icke-kommersiellt. Repots LICENSE säger
uttryckligen: *"Commercial use requires separate permission from the authors."*

Konsekvens för en produkt som ska säljas:

- MELT får användas för att **validera** hypoteserna. Det är forskning.
- Ingen modell tränad på MELT, och inget MELT-härlett dataset, får ingå i
  eller driva en betald produkt utan skriftligt tillstånd från författarna.
- Produkten måste därför köra på egen insamlad data. Arkiveringskravet i
  PLAN.md ("archive raw stream data continuously") är inte bara en
  backtest-fråga — det är vad som gör produkten säljbar överhuvudtaget.

Det är en ren separation och den kostar ingenting så länge den görs från
början: forskningen bevisar att signalen finns, produkten står på egen data.

## Creator-recidivism går inte att testa på publik MELT-data (2026-09-02)

`memecoin_list.jsonl` har ett `creator`-fält, men det är **en enda konstant
adress** (`39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg`) på alla 46 139 rader.
Det är inte token-skaparen. Den riktiga deployern finns bara i
launchtransaktionen, alltså i `pre_migration_tx.zip` på Drive.

Konsekvens: H1 kan inte ens golv-testas på det publika datasetet. Ett första
försök gav skenbart meningsfulla siffror innan konstanten upptäcktes — de
siffrorna är kasserade.

**Men samma fält finns gratis i realtid.** PumpPortals `subscribeNewToken`
(`wss://pumpportal.fun/api/data`, ingen nyckel) levererar creator-walleten på
varje launch. Det gör creator-historik till något man bygger själv genom att
spela in strömmen, inte något man hämtar. Implementerat i
`packages/entity/creators.js`, med graduation som utfallsmått eftersom det är
binärt, sällsynt och syns i samma gratisström.

Det här är också produktens enda beståndsdel en konkurrent inte kan
replikera på en eftermiddag, och skälet till att PLAN.md:s arkiveringskrav
gäller från första commiten.

## Socials vid launch — ingen användbar signal (2026-09-02)

| socials | n | high-risk | median return |
|---|---|---|---|
| 0 | 6 171 | 72,4 % | −52,2 % |
| 1 | 7 986 | 78,6 % | −69,6 % |
| 2 | 8 188 | 83,1 % | −74,8 % |
| 3 | 4 651 | 77,8 % | −58,2 % |

Inget monotont samband, och medianen är djupt negativ i varje hink. Negativt
resultat, redovisat.

**Rättelse:** en första körning visade 88,1 % high-risk för "0 socials" och såg
ut som en signal. Den siffran kom av att tokens *utan metadata* räknades som
"inga socials". Saknat värde behandlat som noll — exakt det fel `normalizeToken`
i den andra kodbasen finns för att undvika. Tabellen ovan är beräknad enbart på
de 26 996 tokens där metadata faktiskt finns.

## Runners är ofta högrisk

Bland de 200 största avkastningarna i datasetet är **86 klassade `high`**. Ett
rent riskfilter hade alltså sållat bort 43 % av de största vinnarna.

Det är den viktigaste produktinsikten hittills: MELT:s modell förutsäger
*risk*, inte *avkastning*, och de två är inte varandras motsatser. Ett verktyg
som säljs på att "hitta runners" kan inte bara vara ett rugfilter.
