# Driftsättning

Servern håller **en** anslutning till pump.fun och sänder ut till alla
besökare över SSE. En instans räcker långt — besökarna kostar en öppen
anslutning var, inte ett API-anrop var.

## Krav

- Node ≥ 20.11. Inga npm-beroenden.
- **En beständig volym monterad på `DATA_DIR`.** Utan den tappas arkivet och
  creator-historiken vid varje omstart, och det är produktens enda del som
  inte går att återskapa.
- En egen Solana-RPC. Publika endpoints stryper, och då fastnar omdömena på
  `VÄNTA` för alla besökare samtidigt.

## Miljövariabler

| Variabel | Standard | Roll |
|---|---|---|
| `PORT` | 4173 | Sätts oftast av plattformen |
| `HOST` | 0.0.0.0 | Måste vara 0.0.0.0 bakom en proxy |
| `DATA_DIR` | `./data/` | Peka på den beständiga volymen |
| `SOLANA_RPC_URL` | publik mainnet | Egen nod rekommenderas starkt |
| `RPC_CONCURRENCY` | 2 | Höj till 8–10 med egen RPC |
| `RPC_MIN_INTERVAL_MS` | 400 | Sänk till ~50 med egen RPC |
| `MAX_CLIENTS` | 400 | Tak för samtidiga SSE-anslutningar |
| `KEEPALIVE_MS` | 20000 | Puls så att proxyn inte stänger tysta anslutningar |
| `MAX_TRACKED` | 120 | Samtidiga trade-prenumerationer hos PumpPortal |

## Docker

```bash
docker build -t runner-lab .
docker run -d --name runner-lab \
  -p 4173:4173 \
  -v runner-data:/app/data \
  -e SOLANA_RPC_URL=https://din-rpc-endpoint \
  -e RPC_CONCURRENCY=8 -e RPC_MIN_INTERVAL_MS=60 \
  runner-lab
```

## Fly.io, Railway, Render

Alla tre kör Dockerfilen som den är. Tre saker att få rätt:

1. **Volym** monterad på `/app/data`, annars börjar creator-registret om varje deploy.
2. **En instans**, inte flera. Skalar man ut håller varje instans sin egen
   pump.fun-anslutning och sitt eget halva arkiv, och besökare ser olika data
   beroende på vilken de landar på. Vill man skala: en ingest-instans som
   skriver, flera läsare mot samma volym.
3. **Ingen scale-to-zero.** Sover instansen slutar den spela in, och det som
   missas går inte att hämta i efterhand.

Hälsoadressen är `/health`.

## Innan det säljs

- Terminalen lägger inga ordrar och hanterar inga nycklar. Köpknappen öppnar
  pump.fun. Vill man handla direkt krävs signering, och då blir nyckelhantering
  produktens största säkerhetsansvar — bygg det inte utan att ha bestämt hur.
- MELT-datan (CC BY-NC 4.0) används bara för validering i `packages/research`.
  Den ingår inte i den här servern och får inte ingå i en såld produkt utan
  tillstånd från författarna.
