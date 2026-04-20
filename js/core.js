/**
 * core.js — shared logic for the TCG Card Tracker.
 * ES module; all symbols exported and imported directly.
 */

/* ============================================================
   Constants
   ============================================================ */

export const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'];

export const COND_MULT = {
  NM:  1.00,
  LP:  0.85,
  MP:  0.70,
  HP:  0.50,
  DMG: 0.30,
};

export const FINISH_LABELS = {
  normal:               'Normal',
  holofoil:             'Holofoil',
  reverseHolofoil:      'Rev. Holo',
  firstEditionHolofoil: '1st Ed Holo',
  firstEditionNormal:   '1st Ed Normal',
};

// Fields persisted to CSV — order determines column order.
// notes is added; no other fields removed (full backward compat).
export const CSV_HEADERS = [
  'name', 'setName', 'finish', 'imageUrl', 'condition',
  'buyCost', 'soldPrice', 'marketNM', 'prevMarketNM', 'priceLow', 'priceMid',
  'link', 'sold', 'tcgplayerId', 'notes', 'dateAdded', 'lastUpdated',
];

const POKEMON_API = 'https://api.pokemontcg.io/v2/cards';

/* ============================================================
   TCGPlayer link builder (#1)
   productId is no longer returned by the API, so we build a
   search-results URL from card name + set name instead.
   This lands the user one click away from the correct product.
   ============================================================ */

/**
 * Build a direct TCGPlayer search URL for a card.
 * Falls back to the stored link (e.g. from older imports) if name is empty.
 * @param {string} name
 * @param {string} [setName='']
 * @param {string} [fallbackLink='']
 * @returns {string}
 */
export function buildTCGSearchUrl(name, setName = '', fallbackLink = '') {
  if (!name) return fallbackLink;
  const q = [name, setName].filter(Boolean).join(' ');
  return `https://www.tcgplayer.com/search/pokemon/product?q=${encodeURIComponent(q)}&view=grid`;
}

/* ============================================================
   Price cache (localStorage, TTL = 1 h)
   ============================================================ */

export const CACHE_TTL_MS        = 60 * 60 * 1000;       // 1 hour
export const SEARCH_CACHE_TTL_MS = 6  * 60 * 60 * 1000;  // 6 hours

const PRICE_CACHE_PREFIX  = 'tcg_price_';
const SEARCH_CACHE_PREFIX = 'tcg_search_';

export function readPriceCache(tcgplayerId) {
  try {
    const raw = localStorage.getItem(PRICE_CACHE_PREFIX + tcgplayerId);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
      localStorage.removeItem(PRICE_CACHE_PREFIX + tcgplayerId);
      return null;
    }
    return entry;
  } catch { return null; }
}

export function writePriceCache(tcgplayerId, prices) {
  try {
    localStorage.setItem(
      PRICE_CACHE_PREFIX + tcgplayerId,
      JSON.stringify({ prices, cachedAt: Date.now() })
    );
  } catch { /* quota */ }
}

export function clearPriceCache() {
  try {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PRICE_CACHE_PREFIX) || k?.startsWith(SEARCH_CACHE_PREFIX)) toRemove.push(k);
    }
    toRemove.forEach(k => localStorage.removeItem(k));
  } catch { /* ignore */ }
}

export function inspectPriceCache() {
  let count = 0, oldestAgeMs = null;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(PRICE_CACHE_PREFIX)) continue;
      count++;
      const raw = localStorage.getItem(k);
      if (raw) {
        const { cachedAt } = JSON.parse(raw);
        const age = Date.now() - cachedAt;
        if (oldestAgeMs === null || age > oldestAgeMs) oldestAgeMs = age;
      }
    }
  } catch { /* ignore */ }
  return { count, oldestAgeMs };
}

/* ── Search result cache ───────────────────────────────────── */

export function searchCacheKey(query, setQuery = '', japanese = false) {
  return SEARCH_CACHE_PREFIX +
    [query.toLowerCase().trim(), setQuery.toLowerCase().trim(), japanese ? 'jp' : 'en'].join('|');
}

export function readSearchCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (Date.now() - entry.cachedAt > SEARCH_CACHE_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return entry.results;
  } catch { return null; }
}

export function writeSearchCache(key, results) {
  try {
    localStorage.setItem(key, JSON.stringify({ results, cachedAt: Date.now() }));
  } catch { /* quota */ }
}

/* ============================================================
   Card model
   ============================================================ */

let _nextId = 1;

/**
 * Create a card with sensible defaults.
 * New in this version: notes field.
 * id is always a Number so strict === comparisons in find() work
 * even after JSON round-trips through localStorage.
 */
export function makeCard(overrides = {}) {
  const now = new Date().toISOString();
  const card = {
    id:            _nextId++,
    name:          '',
    imageUrl:      '',
    setName:       '',
    finish:        'normal',
    condition:     'NM',
    buyCost:       '',
    soldPrice:     '',
    marketNM:      null,
    prevMarketNM:  null,
    priceLow:      null,
    priceMid:      null,
    link:          '',
    sold:          false,
    tcgplayerId:   '',
    notes:         '',
    lastRefreshed: null,
    dateAdded:     now,
    lastUpdated:   now,
    ...overrides,
  };
  // Guarantee id is always a number regardless of what overrides contain
  card.id = Number(card.id);
  return card;
}

export function resetIdCounter() { _nextId = 1; }

export function touchUpdated(card) {
  card.lastUpdated = new Date().toISOString();
}

/* ============================================================
   Price calculations
   ============================================================ */

export function adjPrice(card) {
  const base = card.marketNM ?? card.priceMid ?? 0;
  return base * (COND_MULT[card.condition] ?? 1);
}

export function calcProfit(card) {
  const adj = adjPrice(card);
  const buy = parseFloat(card.buyCost) || 0;
  if (!adj || !buy) return { profit: null, pct: null };
  const profit = adj - buy;
  return { profit, pct: (profit / buy) * 100 };
}

export function calcActualProfit(card) {
  const sold = parseFloat(card.soldPrice) || 0;
  const buy  = parseFloat(card.buyCost)   || 0;
  if (!sold || !buy) return { profit: null, pct: null };
  const profit = sold - buy;
  return { profit, pct: (profit / buy) * 100 };
}

export function calcPriceDelta(card) {
  if (card.prevMarketNM == null || card.marketNM == null) return null;
  return card.marketNM - card.prevMarketNM;
}

/* ============================================================
   Sorting
   ============================================================ */

export function sortCards(cards, key, dir) {
  const mul = dir === 'asc' ? 1 : -1;
  return [...cards].sort((a, b) => {
    let av = a[key], bv = b[key];
    if (key === 'adjPrice')     { av = adjPrice(a);                    bv = adjPrice(b); }
    if (key === 'profit')       { av = calcProfit(a).profit       ?? -Infinity; bv = calcProfit(b).profit       ?? -Infinity; }
    if (key === 'pct')          { av = calcProfit(a).pct          ?? -Infinity; bv = calcProfit(b).pct          ?? -Infinity; }
    if (key === 'priceDelta')   { av = calcPriceDelta(a)          ?? -Infinity; bv = calcPriceDelta(b)          ?? -Infinity; }
    if (key === 'actualProfit') { av = calcActualProfit(a).profit ?? -Infinity; bv = calcActualProfit(b).profit ?? -Infinity; }
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    const an = parseFloat(av), bn = parseFloat(bv);
    if (!isNaN(an) && !isNaN(bn)) return (an - bn) * mul;
    if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * mul;
    if (typeof av === 'boolean') return ((av ? 1 : 0) - (bv ? 1 : 0)) * mul;
    return 0;
  });
}

/* ============================================================
   Formatting helpers
   ============================================================ */

export function fmt(n, decimals = 2) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return '$' + n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

export function fmtPct(n) {
  if (n === null || isNaN(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
}

export function fmtTime(ts) {
  if (!ts) return 'never';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
    ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function fmtAge(ms) {
  if (ms === null || ms === undefined) return 'never';
  const secs = Math.floor(ms / 1000);
  if (secs < 60)  return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m ago` : `${hrs}h ago`;
}

export function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ============================================================
   CSV export / import
   ============================================================ */

export function exportCSV(cards) {
  const rows = [CSV_HEADERS.join(',')];
  for (const c of cards) {
    rows.push(CSV_HEADERS.map(h => `"${String(c[h] ?? '').replace(/"/g, '""')}"`).join(','));
  }
  return rows.join('\n');
}

export function generateFilename() {
  const d = new Date();
  return `tcg-tracker-${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}.csv`;
}

export async function downloadCSV(cards) {
  const content  = exportCSV(cards);
  const filename = generateFilename();
  if (typeof window !== 'undefined' && window.showSaveFilePicker) {
    try {
      const fh = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'CSV spreadsheet', accept: { 'text/csv': ['.csv'] } }],
      });
      const w = await fh.createWritable();
      await w.write(content); await w.close();
      return;
    } catch (err) { if (err.name === 'AbortError') return; }
  }
  const blob = new Blob([content], { type: 'text/csv' });
  const a    = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(a.href);
}

export function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const vals = splitCSVLine(line);
    const obj  = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] ?? '').trim(); });
    return obj;
  });
}

export function splitCSVLine(line) {
  const result = [];
  let cur = '', inQuote = false;
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === ',' && !inQuote) { result.push(cur); cur = ''; continue; }
    cur += ch;
  }
  result.push(cur);
  return result;
}

export function csvRowToCard(row) {
  const now = new Date().toISOString();
  return makeCard({
    name:         row.name         || '',
    imageUrl:     row.imageUrl     || '',
    setName:      row.setName      || '',
    finish:       row.finish       || 'normal',
    condition:    CONDITIONS.includes(row.condition) ? row.condition : 'NM',
    buyCost:      row.buyCost      || '',
    soldPrice:    row.soldPrice    || '',
    marketNM:     row.marketNM     ? parseFloat(row.marketNM)     : null,
    prevMarketNM: row.prevMarketNM ? parseFloat(row.prevMarketNM) : null,
    priceLow:     row.priceLow     ? parseFloat(row.priceLow)     : null,
    priceMid:     row.priceMid     ? parseFloat(row.priceMid)     : null,
    link:         row.link         || '',
    sold:         row.sold === 'true' || row.sold === '1',
    tcgplayerId:  row.tcgplayerId  || '',
    notes:        row.notes        || '',
    dateAdded:    row.dateAdded    || now,
    lastUpdated:  row.lastUpdated  || now,
  });
}

/* ============================================================
   Pokémon TCG API
   ============================================================ */

/**
 * Search cards by name with optional set filter and JP mode.
 *
 * Fixes vs previous version:
 *  - JP mode: uses wildcard name:*query* (no language:Japanese — that field
 *    doesn't exist in the API query syntax and caused 404 errors)
 *  - EN mode: tries exact match first; if 0 results auto-retries with
 *    wildcard name:*query* to catch promos, hyphenated names, etc.
 *  - pageSize: 100 (was 50)
 *  - Results cached for SEARCH_CACHE_TTL_MS (6 h)
 *
 * @param {string}  query
 * @param {string}  [setQuery='']
 * @param {boolean} [japanese=false]
 */
export async function searchCards(query, setQuery = '', japanese = false) {
  const cacheKey = searchCacheKey(query, setQuery, japanese);
  const cached   = readSearchCache(cacheKey);
  if (cached) return cached;

  const setFilter = setQuery ? ` set.name:"${setQuery}"` : '';

  // JP mode: wildcard name search (Japanese cards have romanised names in the DB)
  if (japanese) {
    const q   = `name:*${query}*${setFilter}`;
    const url = `${POKEMON_API}?q=${encodeURIComponent(q)}&pageSize=100&orderBy=-set.releaseDate&select=id,name,images,set,number,tcgplayer`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const json = await res.json();
    const data = json.data || [];
    writeSearchCache(cacheKey, data);
    return data;
  }

  // EN mode: exact match first, wildcard fallback if no results
  const exactQ   = `name:"${query}"${setFilter}`;
  const exactUrl = `${POKEMON_API}?q=${encodeURIComponent(exactQ)}&pageSize=100&orderBy=-set.releaseDate&select=id,name,images,set,number,tcgplayer`;
  const res      = await fetch(exactUrl);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const json = await res.json();
  let data   = json.data || [];

  // Auto-retry with wildcard when exact match returns nothing
  if (data.length === 0) {
    const wildQ   = `name:*${query}*${setFilter}`;
    const wildUrl = `${POKEMON_API}?q=${encodeURIComponent(wildQ)}&pageSize=100&orderBy=-set.releaseDate&select=id,name,images,set,number,tcgplayer`;
    try {
      const res2  = await fetch(wildUrl);
      if (res2.ok) {
        const json2 = await res2.json();
        data = json2.data || [];
      }
    } catch { /* fall through with empty */ }
  }

  writeSearchCache(cacheKey, data);
  return data;
}

/**
 * Fetch prices for a single card.
 * forceRefresh=true bypasses the cache (Refresh button).
 */
export async function fetchCardPrices(tcgplayerId, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = readPriceCache(tcgplayerId);
    if (cached) return cached.prices;
  }
  try {
    const res    = await fetch(`${POKEMON_API}/${encodeURIComponent(tcgplayerId)}?select=tcgplayer`);
    if (!res.ok) return null;
    const json   = await res.json();
    const prices = json.data?.tcgplayer?.prices || null;
    if (prices) writePriceCache(tcgplayerId, prices);
    return prices;
  } catch { return null; }
}

/**
 * Resolve a TCGPlayer URL to a Pokémon TCG API card object.
 * Strategy 1: numeric product ID → tcgplayer.productId query.
 * Strategy 2: slug-based name extraction fallback.
 */
export async function fetchCardByUrl(url) {
  const productMatch = url.match(/tcgplayer\.com\/product\/(\d+)/i);
  if (productMatch) {
    try {
      const res = await fetch(
        `${POKEMON_API}?q=tcgplayer.productId:${productMatch[1]}&select=id,name,images,set,number,tcgplayer`
      );
      if (res.ok) {
        const json = await res.json();
        if (json.data?.[0]) return json.data[0];
      }
    } catch { /* fall through */ }
  }
  try {
    const slug        = url.split('?')[0].split('/').filter(Boolean).pop() || '';
    const withoutGame = slug.replace(/^(pokemon|magic|yugioh|mtg|one-piece)-/i, '');
    const parts       = withoutGame.split('-').filter(Boolean);
    for (let take = Math.min(parts.length, 5); take >= 1; take--) {
      const candidate = parts.slice(-take).join(' ');
      if (candidate.length < 3) continue;
      const res = await fetch(
        `${POKEMON_API}?q=name:"${encodeURIComponent(candidate)}"&pageSize=4&orderBy=-set.releaseDate&select=id,name,images,set,number,tcgplayer`
      );
      if (!res.ok) continue;
      const json = await res.json();
      if (json.data?.length > 0) return json.data[0];
    }
  } catch { /* ignore */ }
  return null;
}

/* ============================================================
   Undo history
   ============================================================ */

export const UNDO_MAX_SNAPSHOTS = 5;

export function snapshotCards(cards) {
  return JSON.parse(JSON.stringify(cards));
}

/* ============================================================
   Seed data
   ============================================================ */

export function getSeedCards() {
  const daysAgo = (n) => { const t = new Date(); t.setDate(t.getDate() - n); return t.toISOString(); };
  return [
    makeCard({ name:'Rayquaza VMAX', setName:'Evolving Skies', finish:'holofoil', condition:'NM', buyCost:'30.00', soldPrice:'',      marketNM:52.00, prevMarketNM:48.00, priceLow:44.00, priceMid:49.00, notes:'',                           imageUrl:'https://images.pokemontcg.io/swsh7/218_hires.png',  link:'', tcgplayerId:'swsh7-218',  sold:false, dateAdded:daysAgo(60), lastUpdated:daysAgo(5)  }),
    makeCard({ name:'Umbreon VMAX',  setName:'Evolving Skies', finish:'holofoil', condition:'NM', buyCost:'38.00', soldPrice:'55.00', marketNM:60.00, prevMarketNM:62.00, priceLow:50.00, priceMid:56.00, notes:'Sold on eBay, great buyer',  imageUrl:'https://images.pokemontcg.io/swsh7/215_hires.png',  link:'', tcgplayerId:'swsh7-215',  sold:true,  dateAdded:daysAgo(45), lastUpdated:daysAgo(7)  }),
    makeCard({ name:'Lugia VSTAR',   setName:'Silver Tempest', finish:'holofoil', condition:'MP', buyCost:'20.00', soldPrice:'',      marketNM:38.00, prevMarketNM:null,  priceLow:30.00, priceMid:35.00, notes:'Light play, small crease',  imageUrl:'https://images.pokemontcg.io/swsh12/227_hires.png', link:'', tcgplayerId:'swsh12-227', sold:false, dateAdded:daysAgo(20), lastUpdated:daysAgo(20) }),
    makeCard({ name:'Mew VMAX',      setName:'Fusion Strike',  finish:'holofoil', condition:'NM', buyCost:'16.00', soldPrice:'',      marketNM:22.00, prevMarketNM:20.00, priceLow:17.50, priceMid:20.00, notes:'',                           imageUrl:'https://images.pokemontcg.io/swsh8/271_hires.png',  link:'', tcgplayerId:'swsh8-271',  sold:false, dateAdded:daysAgo(8),  lastUpdated:daysAgo(8)  }),
  ];
}
