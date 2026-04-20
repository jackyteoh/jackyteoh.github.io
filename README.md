# TCG Card Tracker

A browser-based Pokémon TCG card tracker with live prices from the
[Pokémon TCG API](https://pokemontcg.io/) (TCGPlayer market data).

## What's new in this version

### Features added
1. **TCGPlayer link** — redirects user now to search landing page with card name + set name, extra click for user to double check but only viable solution atm
2. **Japanese card search optimization** —  CURRENTLY NOT WORKING AS EXPECTED
3. **Larger search results (100)** — `pageSize` bumped from 50 to 100.
4. **Increased search optimization** — attempt to include more cards not shown by search, CURRENTLY NOT WORKING AS EXPECTED
5. **Removed input lag** — was some delay after inputting buy cost field, transitioning to next field, this has been removed.
6. **Notes section added** — added notes section to individual cards in case user wishes to add certain things, where obtained, etc, currently only editable via clicking card image, need to fix
7. **Quick edit** — added quick edit modal popup when user clicks card image.
8. **Progress loading bar during refresh** — added progress bar for the user to see where they are in the price refreshing process.
9. **Duplicate card functionality fixing** — attempt to fix issues arising when duplicating cards, CURRENTLY NOT WORKING AS EXPECTED
10. **Expected Profit Delta** — attempt to add expected profit delta in between refreshes, not showing up as expected in `Expected Profit Summary` window, CURRENTLY NOT WORKING AS EXPECTED
11. **How to modal** — `How to` modal added for the user to explain how to use the application.
12. **Better formatting for Summary windows** — added commas to summary windows to make it look better

### Architecture improvements
- `calcActualProfit(card)` — new exported function for soldPrice-based profit
- `calcPriceDelta(card)` — new exported function for Δ price
- `snapshotCards(cards)` — deep-clone helper for undo
- `searchCacheKey()`, `readSearchCache()`, `writeSearchCache()` — search cache helpers
- `SEARCH_CACHE_TTL_MS` exported constant (6 h)
- `UNDO_MAX_SNAPSHOTS` exported constant (5)
- All new fields (`soldPrice`, `prevMarketNM`) in `CSV_HEADERS` and `makeCard` defaults

### Test suite: 112 tests across 18 groups
New groups: Actual profit, Price delta, Sparse CSV import, Undo snapshots, Search cache.

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
