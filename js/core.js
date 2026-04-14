/**
 * core.js — shared logic for the TCG Card Tracker.
 * ES module: all symbols are exported and imported directly.
 * No window.TCG bridge needed.
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

// Fields persisted to CSV — order determines column order in the file.
export const CSV_HEADERS = [
  'name', 'setName', 'finish', 'imageUrl', 'condition',
  'buyCost', 'marketNM', 'priceLow', 'priceMid',
  'link', 'sold', 'tcgplayerId', 'dateAdded', 'lastUpdated',
];

const POKEMON_API = 'https://api.pokemontcg.io/v2/cards';

/* ============================================================
   Price cache  (localStorage, with TTL)
   ============================================================ */

/**
 * How long a cached price entry is considered fresh.
 * After this period the next fetchCardPrices() call will hit the network.
 * Exported so the UI can display it and the user can adjust it if needed.
 */
export const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const CACHE_PREFIX = 'tcg_price_';

/**
 * Read a cached price entry for a card.
 * Returns null when the entry is absent or stale.
 * @param {string} tcgplayerId
 * @returns {{ prices: Object, cachedAt: number } | null}
 */
export function readPriceCache(tcgplayerId) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + tcgplayerId);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
      localStorage.removeItem(CACHE_PREFIX + tcgplayerId);
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

/**
 * Write a price entry to the cache with the current timestamp.
 * @param {string} tcgplayerId
 * @param {Object} prices  — raw prices object from the Pokémon TCG API
 */
export function writePriceCache(tcgplayerId, prices) {
  try {
    localStorage.setItem(
      CACHE_PREFIX + tcgplayerId,
      JSON.stringify({ prices, cachedAt: Date.now() })
    );
  } catch {
    // localStorage quota exceeded or unavailable — silently skip
  }
}

/**
 * Remove every TCG price entry from localStorage.
 */
export function clearPriceCache() {
  try {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(CACHE_PREFIX)) toRemove.push(k);
    }
    toRemove.forEach(k => localStorage.removeItem(k));
  } catch { /* ignore */ }
}

/**
 * Return a summary of what is currently in the price cache.
 * @returns {{ count: number, oldestAgeMs: number | null }}
 */
export function inspectPriceCache() {
  let count = 0;
  let oldestAgeMs = null;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(CACHE_PREFIX)) continue;
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

/* ============================================================
   Card model
   ============================================================ */

let _nextId = 1;

/**
 * Create a card object with sensible defaults.
 * @param {Partial<Card>} overrides
 * @returns {Card}
 */
export function makeCard(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id:            _nextId++,
    name:          '',
    imageUrl:      '',
    setName:       '',
    finish:        'normal',
    condition:     'NM',
    buyCost:       '',
    marketNM:      null,
    priceLow:      null,
    priceMid:      null,
    link:          '',
    sold:          false,
    tcgplayerId:   '',
    lastRefreshed: null,
    dateAdded:     now,
    lastUpdated:   now,
    ...overrides,
  };
}

/** Reset ID counter — used by the test suite between runs. */
export function resetIdCounter() {
  _nextId = 1;
}

/**
 * Bump lastUpdated on a card to now (mutates in place).
 * Call whenever a user-visible field changes.
 * @param {Card} card
 */
export function touchUpdated(card) {
  card.lastUpdated = new Date().toISOString();
}

/* ============================================================
   Price calculations
   ============================================================ */

/**
 * Condition-adjusted price. Uses marketNM, falls back to priceMid, then 0.
 * @param {Card} card
 * @returns {number}
 */
export function adjPrice(card) {
  const base = card.marketNM ?? card.priceMid ?? 0;
  return base * (COND_MULT[card.condition] ?? 1);
}

/**
 * Profit amount and percentage vs buy cost.
 * Returns nulls when inputs are missing.
 * @param {Card} card
 * @returns {{ profit: number|null, pct: number|null }}
 */
export function calcProfit(card) {
  const adj = adjPrice(card);
  const buy = parseFloat(card.buyCost) || 0;
  if (!adj || !buy) return { profit: null, pct: null };
  const profit = adj - buy;
  return { profit, pct: (profit / buy) * 100 };
}

/* ============================================================
   Sorting
   ============================================================ */

/**
 * Sort cards by a column key. Returns a NEW array — never mutates.
 * @param {Card[]} cards
 * @param {string} key
 * @param {'asc'|'desc'} dir
 * @returns {Card[]}
 */
export function sortCards(cards, key, dir) {
  const mul = dir === 'asc' ? 1 : -1;
  return [...cards].sort((a, b) => {
    let av = a[key];
    let bv = b[key];
    if (key === 'adjPrice') { av = adjPrice(a);              bv = adjPrice(b); }
    if (key === 'profit')   { av = calcProfit(a).profit ?? -Infinity; bv = calcProfit(b).profit ?? -Infinity; }
    if (key === 'pct')      { av = calcProfit(a).pct    ?? -Infinity; bv = calcProfit(b).pct    ?? -Infinity; }
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

/** Format a number as USD, or '—'. */
export function fmt(n, decimals = 2) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return '$' + Number(n).toFixed(decimals);
}

/** Format a percentage with leading sign, or '—'. */
export function fmtPct(n) {
  if (n === null || isNaN(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
}

/** Format a Unix-ms timestamp as HH:MM, or 'never'. */
export function fmtTime(ts) {
  if (!ts) return 'never';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Format an ISO date string as "Apr 10, 2:34 PM", or '—'. */
export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
    ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Format a duration in ms as a human-readable age, e.g. "1h 5m ago".
 * @param {number|null} ms
 * @returns {string}
 */
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

/** Escape a string for safe HTML insertion. */
export function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ============================================================
   CSV export / import
   ============================================================ */

/** Serialize cards to CSV text. */
export function exportCSV(cards) {
  const rows = [CSV_HEADERS.join(',')];
  for (const c of cards) {
    rows.push(CSV_HEADERS.map(h => `"${String(c[h] ?? '').replace(/"/g, '""')}"`).join(','));
  }
  return rows.join('\n');
}

/** Generate filename like "tcg-tracker-2025-04-10.csv". */
export function generateFilename() {
  const d   = new Date();
  const y   = d.getFullYear();
  const m   = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `tcg-tracker-${y}-${m}-${day}.csv`;
}

/**
 * Download cards as CSV. Uses showSaveFilePicker when available (Chrome/Edge)
 * for a native Save As dialog; falls back to anchor-download elsewhere.
 */
export async function downloadCSV(cards) {
  const content  = exportCSV(cards);
  const filename = generateFilename();

  if (typeof window !== 'undefined' && window.showSaveFilePicker) {
    try {
      const fh = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'CSV spreadsheet', accept: { 'text/csv': ['.csv'] } }],
      });
      const writable = await fh.createWritable();
      await writable.write(content);
      await writable.close();
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }

  const blob = new Blob([content], { type: 'text/csv' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

/** Parse CSV text into an array of plain row objects. */
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

/** Split a CSV line respecting quoted fields. */
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

/** Convert a parsed CSV row object into a Card. */
export function csvRowToCard(row) {
  const now = new Date().toISOString();
  return makeCard({
    name:        row.name        || '',
    imageUrl:    row.imageUrl    || '',
    setName:     row.setName     || '',
    finish:      row.finish      || 'normal',
    condition:   CONDITIONS.includes(row.condition) ? row.condition : 'NM',
    buyCost:     row.buyCost     || '',
    marketNM:    row.marketNM    ? parseFloat(row.marketNM)  : null,
    priceLow:    row.priceLow    ? parseFloat(row.priceLow)  : null,
    priceMid:    row.priceMid    ? parseFloat(row.priceMid)  : null,
    link:        row.link        || '',
    sold:        row.sold === 'true' || row.sold === '1',
    tcgplayerId: row.tcgplayerId || '',
    dateAdded:   row.dateAdded   || now,
    lastUpdated: row.lastUpdated || now,
  });
}

/* ============================================================
   Pokémon TCG API
   ============================================================ */

/** Search cards by name. */
export async function searchCards(query) {
  const url = `${POKEMON_API}?q=name:"${encodeURIComponent(query)}"` +
              `&pageSize=12&orderBy=-set.releaseDate` +
              `&select=id,name,images,set,number,tcgplayer`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const json = await res.json();
  return json.data || [];
}

/**
 * Fetch prices for a card, using the localStorage cache when fresh.
 * Pass forceRefresh=true to skip the cache (used by the Refresh button).
 * @param {string} tcgplayerId
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<Object|null>}
 */
export async function fetchCardPrices(tcgplayerId, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = readPriceCache(tcgplayerId);
    if (cached) return cached.prices;
  }
  try {
    const res = await fetch(`${POKEMON_API}/${encodeURIComponent(tcgplayerId)}?select=tcgplayer`);
    if (!res.ok) return null;
    const json   = await res.json();
    const prices = json.data?.tcgplayer?.prices || null;
    if (prices) writePriceCache(tcgplayerId, prices);
    return prices;
  } catch {
    return null;
  }
}

/**
 * Resolve a TCGPlayer URL to a Pokémon TCG API card object.
 *
 * Strategy 1 — numeric product ID:
 *   Extract /product/(\d+)/ and query tcgplayer.productId directly.
 *
 * Strategy 2 — slug-based name search (fallback):
 *   Parse the human-readable slug after the product ID, strip the game prefix
 *   and noise words, then try progressively shorter name suffixes until
 *   a search returns a hit.
 *
 * @param {string} url
 * @returns {Promise<Object|null>}
 */
export async function fetchCardByUrl(url) {
  // Strategy 1: product ID
  const productMatch = url.match(/tcgplayer\.com\/product\/(\d+)/i);
  if (productMatch) {
    try {
      const res = await fetch(
        `${POKEMON_API}?q=tcgplayer.productId:${productMatch[1]}` +
        `&select=id,name,images,set,number,tcgplayer`
      );
      if (res.ok) {
        const json = await res.json();
        if (json.data?.[0]) return json.data[0];
      }
    } catch { /* fall through */ }
  }

  // Strategy 2: slug-based name extraction
  try {
    const slug         = url.split('?')[0].split('/').filter(Boolean).pop() || '';
    const withoutGame  = slug.replace(/^(pokemon|magic|yugioh|mtg|one-piece)-/i, '');
    const parts        = withoutGame.split('-').filter(Boolean);

    // Try the last N words, descending, so we match more-specific names first
    for (let take = Math.min(parts.length, 5); take >= 1; take--) {
      const candidate = parts.slice(-take).join(' ');
      if (candidate.length < 3) continue;

      const res = await fetch(
        `${POKEMON_API}?q=name:"${encodeURIComponent(candidate)}"` +
        `&pageSize=4&orderBy=-set.releaseDate` +
        `&select=id,name,images,set,number,tcgplayer`
      );
      if (!res.ok) continue;
      const json = await res.json();
      if (json.data?.length > 0) return json.data[0];
    }
  } catch { /* ignore */ }

  return null;
}

/* ============================================================
   Seed data
   ============================================================ */

export function getSeedCards() {
  const daysAgo = (n) => {
    const t = new Date();
    t.setDate(t.getDate() - n);
    return t.toISOString();
  };
  return [
    makeCard({ name:'Charizard ex',   setName:'Scarlet & Violet — 151', finish:'holofoil', condition:'NM', buyCost:'18.00', marketNM:32.50, priceLow:25.00, priceMid:30.00, imageUrl:'https://images.pokemontcg.io/sv3pt5/6_hires.png',   link:'https://www.tcgplayer.com/product/502558', tcgplayerId:'sv3pt5-6',   sold:false, dateAdded:daysAgo(14), lastUpdated:daysAgo(2)  }),
    makeCard({ name:'Pikachu ex',     setName:'Scarlet & Violet — 151', finish:'holofoil', condition:'NM', buyCost:'8.50',  marketNM:12.00, priceLow:9.00,  priceMid:11.00, imageUrl:'https://images.pokemontcg.io/sv3pt5/25_hires.png',  link:'https://www.tcgplayer.com/product/523170', tcgplayerId:'sv3pt5-25',  sold:false, dateAdded:daysAgo(14), lastUpdated:daysAgo(14) }),
    makeCard({ name:'Mewtwo ex',      setName:'Scarlet & Violet — 151', finish:'holofoil', condition:'LP', buyCost:'22.00', marketNM:28.00, priceLow:22.00, priceMid:26.00, imageUrl:'https://images.pokemontcg.io/sv3pt5/205_hires.png', link:'https://www.tcgplayer.com/product/523206', tcgplayerId:'sv3pt5-205', sold:false, dateAdded:daysAgo(10), lastUpdated:daysAgo(10) }),
    makeCard({ name:'Charizard VSTAR',setName:'Pokémon GO',             finish:'holofoil', condition:'NM', buyCost:'14.00', marketNM:11.50, priceLow:9.00,  priceMid:10.75, imageUrl:'https://images.pokemontcg.io/pgo/10_hires.png',    link:'https://www.tcgplayer.com/product/482767', tcgplayerId:'pgo-10',     sold:false, dateAdded:daysAgo(30), lastUpdated:daysAgo(30) }),
    makeCard({ name:'Rayquaza VMAX',  setName:'Evolving Skies',         finish:'holofoil', condition:'NM', buyCost:'30.00', marketNM:52.00, priceLow:44.00, priceMid:49.00, imageUrl:'https://images.pokemontcg.io/swsh7/218_hires.png',  link:'https://www.tcgplayer.com/product/241600', tcgplayerId:'swsh7-218',  sold:false, dateAdded:daysAgo(60), lastUpdated:daysAgo(5)  }),
    makeCard({ name:'Umbreon VMAX',   setName:'Evolving Skies',         finish:'holofoil', condition:'NM', buyCost:'38.00', marketNM:60.00, priceLow:50.00, priceMid:56.00, imageUrl:'https://images.pokemontcg.io/swsh7/215_hires.png',  link:'https://www.tcgplayer.com/product/241597', tcgplayerId:'swsh7-215',  sold:true,  dateAdded:daysAgo(45), lastUpdated:daysAgo(7)  }),
    makeCard({ name:'Lugia VSTAR',    setName:'Silver Tempest',         finish:'holofoil', condition:'MP', buyCost:'20.00', marketNM:38.00, priceLow:30.00, priceMid:35.00, imageUrl:'https://images.pokemontcg.io/swsh12/227_hires.png', link:'https://www.tcgplayer.com/product/268391', tcgplayerId:'swsh12-227', sold:false, dateAdded:daysAgo(20), lastUpdated:daysAgo(20) }),
    makeCard({ name:'Mew VMAX',       setName:'Fusion Strike',          finish:'holofoil', condition:'NM', buyCost:'16.00', marketNM:22.00, priceLow:17.50, priceMid:20.00, imageUrl:'https://images.pokemontcg.io/swsh8/271_hires.png',  link:'https://www.tcgplayer.com/product/249454', tcgplayerId:'swsh8-271',  sold:false, dateAdded:daysAgo(8),  lastUpdated:daysAgo(8)  }),
  ];
}
