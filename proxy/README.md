# TCG Tracker Proxy — Cloudflare Worker

This Worker sits between the browser tracker and the JustTCG API, keeping
your API key safely server-side while enabling full Japanese card search
and pricing.

---

## One-time setup (~5 minutes, all free)

### Option A — Cloudflare Dashboard (easiest)

1. Sign up at https://dash.cloudflare.com (free, no credit card needed)
2. Go to **Workers & Pages → Create application → Create Worker**
3. Give it a name, e.g. `tcg-tracker-proxy`
4. Click **Edit code**, paste the contents of `worker.js`, click **Deploy**
5. Go to **Settings → Variables and Secrets → Add secret**:
   - Name:  `JUSTTCG_API_KEY`
   - Value: your JustTCG API key (get one free at https://justtcg.com/dashboard/plans)
6. Copy your Worker URL — it looks like:
   `https://tcg-tracker-proxy.yourname.workers.dev`

### Option B — Wrangler CLI

```bash
npm install -g wrangler
wrangler login
cd proxy/
wrangler deploy
wrangler secret put JUSTTCG_API_KEY   # paste your key when prompted
```

---

## Connect the tracker to your proxy

Open `tcg-tracker/js/core.js` and find this line near the top:

```js
const PROXY_BASE_URL = '';   // ← paste your Worker URL here
```

Change it to your Worker URL:

```js
const PROXY_BASE_URL = 'https://tcg-tracker-proxy.yourname.workers.dev';
```

Save, reload the tracker. Japanese card search will now use JustTCG
for comprehensive data and real pricing.

---

## What the proxy handles

| Route | Description |
|---|---|
| `GET /jp/search?q=Charizard` | Search JP cards by name |
| `GET /jp/search?q=Charizard&set=sv6a` | Filter by set ID |
| `GET /jp/prices?id=<cardId>&printing=Holo` | Fetch NM TCGPlayer prices |
| `GET /jp/sets` | List all JP sets |
| `GET /en/sets` | List EN sets (for promo browsing) |
| `GET /health` | Proxy health check |

---

## Free tier limits

- **Cloudflare Workers free**: 100,000 requests/day — more than enough for personal use
- **JustTCG free tier**: check https://justtcg.com/dashboard/plans for current limits

---

## Security

- The `JUSTTCG_API_KEY` secret is stored in Cloudflare's encrypted secrets
  store and never appears in your browser, source code, or network requests
- The proxy sends `Access-Control-Allow-Origin: *` — tighten this to your
  hosted domain once you deploy the tracker publicly
