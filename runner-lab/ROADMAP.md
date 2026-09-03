# Vad som återstår

Statusen nedan är kontrollerad mot koden, inte uppskattad. Sådant jag inte
kunnat verifiera är märkt så.

---

## P0 — Löst 2026-09-03

Tre saker gjorde terminalen svår eller omöjlig att använda live. Alla tre är
åtgärdade och verifierade.

### 1. Flödet går inte att scrolla

`render()` skriver om hela `#lanes` med `innerHTML` vid varje serveruppdatering,
alltså varje sekund. Scrollcontainern förstörs och återskapas.

**Verifierat:** scrollposition 400 → 0 vid omritning.

I replay märks det inte eftersom uppdateringarna tar slut. Live betyder det att
du inte kan scrolla ner i listan över huvud taget — du kastas till toppen varje
sekund. Samma sak gäller hovring, textmarkering och `fresh`-animationen som
spelas om för varje rad hela tiden.

**Löst.** Renderingen är inkrementell: en nod per mint, och innehållet skrivs om
bara när radens signatur ändrats. Signaturen utesluter åldern, som tickar
separat, så en rad som bara blir äldre rörs inte alls.

Verifierat: listan är samma DOM-nod efter uppdateringar, och raden mitt i vyn
står kvar. `scrollTop` ändras fortfarande — det är webbläsarens scroll-ankring
som kompenserar när rader läggs till ovanför, vilket är önskat beteende.

Kolumnen fryses dessutom medan pekaren är i den, med en synlig `pausad`-markering.
En lista som sorterar om under markören går inte att klicka i.

### 2. CA-sökrutan slår inte upp något

`/api/lookup` finns i servern och gör riktiga on-chain-kontroller. **UI:t
anropar den aldrig** — sökrutan filtrerar bara raderna som redan finns i radarn.

**Verifierat:** noll referenser till `api/lookup` i `web/app.js`.

Klistrar du in en adress som inte råkar ligga i fönstret visas noll rader och
inget händer. Det är den funktion du bad om allra först.

**Löst.** Ser söksträngen ut som en Solana-adress och inte matchar något i radarn
anropas `/api/lookup`, och resultatet visas i lådan med authority- och
innehavarkontroll.

### 3. Mobil är obrukbar

Tre kolumner utan brytpunkt för smala skärmar. Två `max-width`-regler finns i
hela stilmallen.

**Löst.** Under 1000 px visas en kolumn i taget med flikar som bär antalet, och
lådan täcker skärmen. Verifierat på iPhone 13: ingen sidledsscroll.

---

## P1 — Saknas för att det ska kännas som en terminal

### 4. Inget larm när KÖP fyrar

Det finns varken ljud eller avisering. En terminal man måste titta på hela tiden
är ingen terminal — den är en webbsida.

Ljud, webbnotis, och senare Telegram-utskick. Ljud kräver en användargest först,
så det behöver en av/på-knapp som också fungerar som den gesten.

### 5. Inga inställningar

Trösklarna (`MIN_BUYERS`, dev-tak, topp-10-tak) sitter i serverns miljövariabler.
Besökaren kan inte ändra något, och du kan inte ändra utan att deploya.

Lägg dem i klienten, sparade i `localStorage`, med serverns värden som utgångsläge.
Då kan olika användare köra olika strikt utan att det påverkar varandra.

### 6. Creator-sidan saknas

Registret finns i `data/launches.ndjson` men syns bara som en rad i lådan. Att
klicka en dev och se hens tidigare listningar och hur de gick är den mest
övertygande vyn i hela produkten — och den enda ingen konkurrent kan kopiera.

Kräver en endpoint `/api/creator?wallet=…` och en vy.

### 7. Filter per kolumn

Just nu bara sortering. Behövs: minsta market cap, högsta dev-andel, bara
kvalificerade, dölj SKIPPA.

---

## P2 — Saknas för att kunna säljas

**Bygg inget av det här förrän lyftet finns.** Punkt 10 avgör om produkten är
värd att sälja över huvud taget, och de andra två är bortkastade om svaret är nej.

### 8. Ingen landningssida

Besökare hamnar direkt i terminalen utan att veta vad de tittar på. Det behövs
en sida före: vad verktyget gör, vad KÖP betyder, och träffbilden som bevis.

### 9. Ingen inloggning eller betalning

Ingen användarhantering, ingen betalvägg, inga nivåer. Terminalen är helt öppen.

### 10. Publik track record — **den viktigaste punkten**

Träffbilden finns i gränssnittet men bara som sex tal. För att sälja behövs en
egen sida: varje dom, vad den byggde på, och vad som hände. Verifierbart mot
kedjan.

Det är skillnaden mellan "lita på mig" och "här är siffrorna".

---

## P3 — Edgen

### 11. Bundle-detektion (H1 i din PLAN.md)

Slå ihop wallets som köpte i samma block som listningen och räkna om
topp-10-andelen. Publicerad forskning visar 24 procentenheters skillnad mellan
hög- och lågriskstokens efter klustring, mot 6 före.

RugCheck och DexScreener visar den råa siffran. Ingen visar deltat. Datan finns
redan i strömmen — köparna i första blocket är de vi ser först.

### 12. Smart money

Wallets som återkommande köper tidigt i tokens som sedan graduerar. Beräknas ur
den egna inspelningen, blir bättre för varje dygn, och går inte att köpa.

---

## Ordning

```
P0.1 scroll ──▶ P0.2 CA-sök ──▶ P0.3 mobil ──▶ P1.4 larm ──▶ P1.6 creator-sida
                                                                    │
                                     lyftet mäts (24–48 h) ─────────┤
                                                                    ▼
                                              P2.10 track record ──▶ P2.8 landning ──▶ P2.9 betalning
```

P3 kan byggas parallellt när som helst — den beror inte på de andra.

---

## Vad som redan är klart

Live på Fly med volym och automatisk deploy. pump.fun-strömmen med
återanslutning och puls. Arkiv som skrivs före all bearbetning. Radar med
rullande fönster och tre livskolumner. On-chain-preflight där okänt aldrig blir
godkänt. Omdöme KÖP/VÄNTA/SKIPPA. Utfallsbok som mäter domarna mot graduation.
Creator-register. 23 tester.
