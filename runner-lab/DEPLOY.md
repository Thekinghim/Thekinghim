# Driftsättning

Servern håller **en** anslutning till pump.fun och sänder ut till alla besökare
över SSE. En besökare kostar en öppen anslutning, inte ett API-anrop — därför
räcker en liten instans långt.

---

## Snabbaste vägen: Fly.io

Ungefär tio minuter. Kostar några dollar i månaden.

### 1. Skaffa en Solana-RPC

Publika endpoints stryper efter några anrop, och då fastnar omdömet på `VÄNTA`
för alla besökare samtidigt. Gratisnivån hos [Helius](https://helius.dev) eller
[QuickNode](https://quicknode.com) räcker gott. Kopiera din HTTPS-URL.

### 2. Installera flyctl och logga in

```bash
curl -L https://fly.io/install.sh | sh     # macOS/Linux
fly auth signup                             # eller: fly auth login
```

### 3. Skapa appen

```bash
cd runner-lab
fly launch --no-deploy --copy-config --name runner-lab-DITTNAMN
```

`--no-deploy` är viktigt: volymen måste finnas innan första starten.
Svara **nej** på frågor om Postgres och Redis — verktyget behöver ingen databas.

### 4. Skapa volymen

```bash
fly volumes create runner_data --size 3 --region arn --yes
```

3 GB rymmer flera månaders arkiv. Använd samma region som i `fly.toml`.

### 5. Lägg in din RPC

```bash
fly secrets set SOLANA_RPC_URL="https://din-rpc-url"
fly secrets set RPC_CONCURRENCY=8 RPC_MIN_INTERVAL_MS=60
```

De två sista höjer takten eftersom en egen RPC tål mycket mer än en publik.

### 6. Deploya

```bash
fly deploy
fly open
```

Adressen blir `https://runner-lab-DITTNAMN.fly.dev`. Den är live direkt — vem
som helst kan öppna den.

### 7. Kontrollera att den faktiskt spelar in

```bash
fly logs
curl https://runner-lab-DITTNAMN.fly.dev/health
```

`/health` ska visa `"state":"live"` och ett `launches` som växer. Gör den inte
det når servern inte pump.fun, och då är allt annat meningslöst.

---

## Alternativ: Railway

Enklare gränssnitt, men volymen kostar extra.

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Välj repot, sätt **Root Directory** till `runner-lab`
3. **Variables**: `SOLANA_RPC_URL`, `RPC_CONCURRENCY=8`, `RPC_MIN_INTERVAL_MS=60`
4. **Volumes** → montera på `/app/data`
5. **Settings → Networking → Generate Domain**

Railway sätter `PORT` själv. Rör den inte.

---

## Egen VPS

```bash
git clone <ditt-repo> && cd runner-lab
docker build -t runner-lab .
docker run -d --name runner-lab --restart unless-stopped \
  -p 4173:4173 -v runner-data:/app/data \
  -e SOLANA_RPC_URL="https://din-rpc-url" \
  -e RPC_CONCURRENCY=8 -e RPC_MIN_INTERVAL_MS=60 \
  runner-lab
```

Sätt en reverse proxy framför för HTTPS. Med nginx behövs två rader, annars
buffras SSE-strömmen och sidan ser död ut:

```nginx
location / {
    proxy_pass http://127.0.0.1:4173;
    proxy_http_version 1.1;
    proxy_buffering off;      # utan denna kommer inga uppdateringar fram
    proxy_read_timeout 1h;    # utan denna kapas strömmen efter en minut
}
```

---

## Tre saker som går sönder om man missar dem

**Volym.** Utan beständig lagring på `DATA_DIR` börjar creator-registret om vid
varje deploy. Det är produktens enda del som inte går att köpa eller återskapa —
den byggs av att du spelat in strömmen längre än någon annan.

**En instans.** Skalar du ut håller varje instans sin egen pump.fun-anslutning
och sitt eget halva arkiv, och två besökare ser olika data beroende på vilken de
landar på. Behöver du skala: en instans som spelar in, flera som läser samma volym.

**Ingen scale-to-zero.** Renders gratisnivå och Fly utan `auto_stop_machines = "off"`
söver instansen när ingen tittar. Då slutar den spela in, och en missad timme går
inte att hämta i efterhand.

---

## Miljövariabler

| Variabel | Standard | Roll |
|---|---|---|
| `PORT` | 4173 | Sätts av plattformen |
| `HOST` | 0.0.0.0 | Måste vara 0.0.0.0 bakom proxy |
| `DATA_DIR` | `./data/` | Peka på volymen |
| `SOLANA_RPC_URL` | publik mainnet | Egen nod starkt rekommenderad |
| `RPC_CONCURRENCY` | 2 | 8–10 med egen RPC |
| `RPC_MIN_INTERVAL_MS` | 400 | ~60 med egen RPC |
| `MAX_CLIENTS` | 400 | Tak för samtidiga besökare |
| `KEEPALIVE_MS` | 20000 | Puls så att proxyn inte stänger SSE |
| `MAX_TRACKED` | 120 | Samtidiga trade-prenumerationer |
| `WINDOW_MINUTES` | 30 | Hur länge ett mynt syns i radarn |
| `MIN_BUYERS` | 8 | Tröskel för kvalificering |

---

## Innan du säljer den

Terminalen lägger inga ordrar och hanterar inga nycklar — köpknappen öppnar
pump.fun. Vill du handla direkt i verktyget krävs transaktionssignering, och då
blir nyckelhantering produktens största säkerhetsansvar. Bygg inte det utan att
först ha bestämt hur nycklar lagras och vem som bär risken.

MELT-datan i `packages/research` är CC BY-NC 4.0 och används bara för validering.
Den ingår inte i den här servern och får inte ingå i en såld produkt utan
tillstånd från författarna.
