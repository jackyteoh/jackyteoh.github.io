# TCG Card Tracker

A browser-based Pokémon TCG card tracker with live prices from the
[Pokémon TCG API](https://pokemontcg.io/) (TCGPlayer market data).

## What's new in this version

### Features added
1. **Duplicate entry bug** — fix: fixed the duplicate entry bug where it was not its unique id and you couldn't perform actions on it. This now works as expected
2. **Sorting by Date added** —  fix: modified how date added is stored and added sorting feature so you can have it ascending/descending
3. **Japanese/Promo searching** — fix: CURRENTLY NOT WORKING AS EXPECTED, STILL NEED TO FIX.
4. **Excluding sold cards from market price summary** — fix: removing the sold card's market price from summary as it's not in your current inventory anymore
5. **Profit delta in summary window** — fix: added expected profit delta indicator in expected profit summary window, to see if your expected profit increases/decreases since last refresh
6. **Single & Multi refresh** — feat: added option to refresh one singular row or multiple rows in case one/mulitple fail on fetch all. Also if you just want to check a certain card(s).
7. **Qty when adding** — feat: added Qty field for the user when adding multiple cards to optimize UX
8. **Keep results toggle** — feat: added Keep Results checkbox during search ex: if user is searching for multiple cards from the same set, they won't have to keep resetting search
9. **Hide sold toggle** — feat: added a hide sold button to hide sold entries from the view, unclogging user view
10. **In-line note editing** — fix: originally adding/editing notes was only in the quick-edit window, now you can do it in-line.
11. **Multi unmark sold, condition** — fix: extended the multi select functionality to work for setting conditions and also unchecking sold
12. **Buy cost 0** — fix: allows buy cost to be set to 0

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
