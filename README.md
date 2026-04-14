# TCG Card Tracker

A browser-based Pokémon TCG card tracker with live prices from the
[Pokémon TCG API](https://pokemontcg.io/) (TCGPlayer market data).

## What's new in this version

- **ES module architecture** — `core.js` uses `export`, `tracker.js` and `tests.js`
  use `import`. No more `window.TCG` bridge. The browser resolves the dependency
  graph automatically.
- **Event delegation** — table rows use a single delegated listener on `<tbody>`
  instead of inline `onclick`/`oninput`/`onchange` on every cell.
- **`initUI()` pattern** — all static button listeners are wired in one place at
  the bottom of each file. No intermediate `const` variables — listeners are
  attached inline with `getElementById(...).addEventListener(...)`.
- **localStorage persistence** — the card list survives page refresh automatically.
  Seed data only loads on the very first visit (when storage is empty).
- **Price cache** — `fetchCardPrices()` checks `localStorage` before hitting the
  network. Cache entries expire after 24 hours (configurable via `CACHE_TTL_MS`
  in `core.js`). The Refresh button always bypasses the cache. A cache status
  line and "Clear cache" button appear above the table.
- **Filter bar** — search/filter the visible rows by card name or set without
  leaving the page.
- **Improved URL lookup** — two-strategy approach: numeric product ID first,
  then slug-based name extraction as a fallback.
- **`fmtAge()`** — human-readable cache age display ("1h 5m ago").
- **13 new tests** covering `fmtAge`, price cache read/write/clear/TTL, and the
  updated seed data shape. Total: ~90 tests across 12 groups.

## Project structure

```
tcg-tracker/
├── index.html          Main tracker page
├── tests.html          Test suite page
├── css/
│   ├── style.css       Shared styles (light + dark mode)
│   └── tests.css       Test suite styles
└── js/
    ├── core.js         All shared logic — exported as ES module
    ├── tracker.js      Tracker UI — imports from core.js
    └── tests.js        Test runner — imports from core.js
```

## Running locally

> **You must serve via HTTP.** `type="module"` scripts and `fetch()` calls are
> blocked by browsers from `file://` URLs.

```bash
# Python (nothing to install)
cd tcg-tracker
python3 -m http.server 8080
# Open http://localhost:8080

# Node
cd tcg-tracker
npx serve .

# VS Code: right-click index.html → Open with Live Server
```

## Adding cards

The **+ Add card via search** button opens a two-tab modal:

| Tab | How it works |
|-----|-------------|
| **Search by name** | Type a card name → live results from pokemontcg.io |
| **Paste TCGPlayer URL** | Paste a product URL → tries product-ID lookup first, then slug-based name search as a fallback |

## Price cache

Prices are cached in `localStorage` with a 24-hour TTL so that re-opening the
page or refreshing the list doesn't burn unnecessary API calls.

- The **Refresh prices** button always bypasses the cache and fetches fresh data.
- The **Clear cache** button removes all cached entries so the next refresh hits
  the network for every card.
- A small **●** dot next to a market price means that price came from the cache.
- The cache TTL can be changed by editing `CACHE_TTL_MS` in `js/core.js`.

## localStorage keys

| Key | Contents |
|-----|---------|
| `tcg_tracker_cards` | Full card list (JSON array) |
| `tcg_price_<tcgplayerId>` | `{ prices, cachedAt }` per card |

## Condition price multipliers

| Condition | Multiplier |
|-----------|-----------|
| NM | 100% |
| LP | 85% |
| MP | 70% |
| HP | 50% |
| DMG | 30% |

## CSV format

Exported files are named `tcg-tracker-YYYY-MM-DD.csv`. Columns:

```
name, setName, finish, imageUrl, condition, buyCost,
marketNM, priceLow, priceMid, link, sold, tcgplayerId,
dateAdded, lastUpdated
```

## API key (optional)

Register free at <https://dev.pokemontcg.io> and add your key to the `fetch()`
headers in `js/core.js` (two places: `searchCards` and `fetchCardPrices`):

```js
headers: { 'X-Api-Key': 'YOUR_KEY_HERE' }
```

## Running the tests

Open `http://localhost:8080/tests.html` and click **Run all tests**.

| Group | Tests |
|-------|------:|
| Condition multipliers & adjusted price | 9 |
| Profit & profit % calculation | 9 |
| fmt() and fmtPct() display formatting | 11 |
| fmtAge() | 6 |
| CSV export & import round-trip | 11 |
| makeCard defaults & overrides | 7 |
| Condition list completeness | 5 |
| splitCSVLine edge cases | 3 |
| Date fields — dateAdded & lastUpdated | 10 |
| Sorting — sortCards() | 7 |
| generateFilename() | 4 |
| Seed data — getSeedCards() | 5 |
| Price cache (localStorage) | 5 |
| **Total** | **~92** |
