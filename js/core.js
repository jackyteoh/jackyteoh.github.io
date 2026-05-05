/**
 * core.js — TCG Card Tracker  v11
 *
 * New this version:
 *  - language: 'en' | 'jp' field on card model + CSV
 *  - searchJPCards()          — TCGdex JP/EN language endpoints
 *  - fetchJPCardPrices()      — TCGdex → TCGPlayer USD prices
 *  - extractTCGdexTCGPlayerPrice() — safely pull USD from TCGdex pricing block
 *  - parseTCGdexId()          — detect "tcgdex:" prefix for routing
 *  - tcgdexVariantToFinish()  — map TCGdex variant flags → our finish keys
 *  - finishToTCGdexVariant()  — reverse map for price lookup
 *
 * All English card logic (pokemontcg.io) unchanged.
 */

export const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'];

export const COND_MULT = { NM: 1.00, LP: 0.85, MP: 0.70, HP: 0.50, DMG: 0.30 };

export const FINISH_LABELS = {
  normal:               'Normal',
  holofoil:             'Holofoil',
  reverseHolofoil:      'Rev. Holo',
  firstEditionHolofoil: '1st Ed Holo',
  firstEditionNormal:   '1st Ed Normal',
};

// 'language' column added between 'notes' and 'dateAdded'.
// Old CSVs without it import cleanly — csvRowToCard defaults to 'en'.
export const CSV_HEADERS = [
  'name', 'setName', 'finish', 'imageUrl', 'condition',
  'buyCost', 'soldPrice', 'marketNM', 'prevMarketNM', 'priceLow', 'priceMid',
  'link', 'sold', 'tcgplayerId', 'notes', 'language', 'dateAdded', 'lastUpdated',
];

const POKEMON_API = 'https://api.pokemontcg.io/v2/cards';
const TCGDEX_API  = 'https://api.tcgdex.net/v2';

/**
 * Paste your Cloudflare Worker URL here after deploying proxy/worker.js.
 * Leave empty to fall back to TCGdex (free, less complete).
 * Example: 'https://tcg-tracker-proxy.yourname.workers.dev'
 */
export const PROXY_BASE_URL = '';

/** Returns true when a proxy URL is configured. */
export function proxyConfigured() { return typeof PROXY_BASE_URL === 'string' && PROXY_BASE_URL.trim().length > 0; }

/* ── TCGPlayer link builder ──────────────────────────────── */
export function buildTCGSearchUrl(name, setName = '', fallbackLink = '') {
  if (!name) return fallbackLink;
  const q = [name, setName].filter(Boolean).join(' ');
  return `https://www.tcgplayer.com/search/pokemon/product?q=${encodeURIComponent(q)}&view=grid`;
}

/* ── Cache helpers ───────────────────────────────────────── */
export const CACHE_TTL_MS        = 60 * 60 * 1000;
export const SEARCH_CACHE_TTL_MS = 6  * 60 * 60 * 1000;
export const PRICE_CACHE_PREFIX  = 'tcg_price_';
const        SEARCH_CACHE_PREFIX = 'tcg_search_';

export function readPriceCache(key) {
  try {
    const raw = localStorage.getItem(PRICE_CACHE_PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
      localStorage.removeItem(PRICE_CACHE_PREFIX + key); return null;
    }
    return entry;
  } catch { return null; }
}
export function writePriceCache(key, prices) {
  try { localStorage.setItem(PRICE_CACHE_PREFIX + key, JSON.stringify({ prices, cachedAt: Date.now() })); } catch { /* quota */ }
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
      const k = localStorage.key(i); if (!k?.startsWith(PRICE_CACHE_PREFIX)) continue; count++;
      const raw = localStorage.getItem(k);
      if (raw) { const { cachedAt } = JSON.parse(raw); const age = Date.now() - cachedAt; if (oldestAgeMs === null || age > oldestAgeMs) oldestAgeMs = age; }
    }
  } catch { /* ignore */ }
  return { count, oldestAgeMs };
}
export function searchCacheKey(query, setQuery = '', japanese = false) {
  return SEARCH_CACHE_PREFIX + [query.toLowerCase().trim(), setQuery.toLowerCase().trim(), japanese ? 'jp' : 'en'].join('|');
}
export function readSearchCache(key) {
  try {
    const raw = localStorage.getItem(key); if (!raw) return null;
    const entry = JSON.parse(raw);
    if (Date.now() - entry.cachedAt > SEARCH_CACHE_TTL_MS) { localStorage.removeItem(key); return null; }
    return entry.results;
  } catch { return null; }
}
export function writeSearchCache(key, results) {
  try { localStorage.setItem(key, JSON.stringify({ results, cachedAt: Date.now() })); } catch { /* quota */ }
}

/* ── Card model ──────────────────────────────────────────── */
let _nextId = 1;

export function syncNextId(cards) {
  if (!cards || cards.length === 0) return;
  const maxId = Math.max(...cards.map(c => Number(c.id) || 0));
  if (maxId >= _nextId) _nextId = maxId + 1;
}

export function makeCard(overrides = {}) {
  const now = new Date().toISOString();
  const card = {
    id: _nextId++, name: '', imageUrl: '', setName: '', finish: 'normal',
    condition: 'NM', buyCost: '', soldPrice: '',
    marketNM: null, prevMarketNM: null, priceLow: null, priceMid: null,
    link: '', sold: false, tcgplayerId: '',
    notes: '', language: 'en',  // NEW: 'en' | 'jp'
    lastRefreshed: null, dateAdded: now, lastUpdated: now,
    ...overrides,
  };
  card.id = Number(card.id);
  return card;
}
export function resetIdCounter() { _nextId = 1; }
export function touchUpdated(card) { card.lastUpdated = new Date().toISOString(); }

/* ── Price calculations ──────────────────────────────────── */
export function adjPrice(card) {
  const base = card.marketNM ?? card.priceMid ?? 0;
  return base * (COND_MULT[card.condition] ?? 1);
}
export function calcProfit(card) {
  const adj = adjPrice(card);
  if (!adj) return { profit: null, pct: null };
  const buyCostStr = String(card.buyCost ?? '').trim();
  if (buyCostStr === '') return { profit: null, pct: null };
  const buy = parseFloat(buyCostStr);
  if (isNaN(buy)) return { profit: null, pct: null };
  const profit = adj - buy;
  return { profit, pct: buy > 0 ? (profit / buy) * 100 : null };
}
export function calcActualProfit(card) {
  const soldStr = String(card.soldPrice ?? '').trim();
  const buyStr  = String(card.buyCost   ?? '').trim();
  if (soldStr === '' || buyStr === '') return { profit: null, pct: null };
  const sold = parseFloat(soldStr), buy = parseFloat(buyStr);
  if (isNaN(sold) || isNaN(buy) || sold === 0) return { profit: null, pct: null };
  const profit = sold - buy;
  return { profit, pct: buy > 0 ? (profit / buy) * 100 : null };
}
export function calcPriceDelta(card) {
  if (card.prevMarketNM == null || card.marketNM == null) return null;
  return card.marketNM - card.prevMarketNM;
}

/* ── Sorting ─────────────────────────────────────────────── */
function isISODate(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v); }
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
    if (isISODate(av) && isISODate(bv)) return (new Date(av).getTime() - new Date(bv).getTime()) * mul;
    const an = parseFloat(av), bn = parseFloat(bv);
    if (!isNaN(an) && !isNaN(bn)) return (an - bn) * mul;
    if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * mul;
    if (typeof av === 'boolean') return ((av ? 1 : 0) - (bv ? 1 : 0)) * mul;
    return 0;
  });
}

/* ── Formatting ──────────────────────────────────────────── */
export function fmt(n, decimals = 2) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
export function fmtPct(n) { if (n === null || isNaN(n)) return '—'; return (n >= 0 ? '+' : '') + n.toFixed(1) + '%'; }
export function fmtTime(ts) { if (!ts) return 'never'; return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
export function fmtDate(iso) {
  if (!iso) return '—'; const d = new Date(iso); if (isNaN(d)) return '—';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
export function fmtAge(ms) {
  if (ms === null || ms === undefined) return 'never';
  const secs = Math.floor(ms / 1000); if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60); if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60), rem = mins % 60;
  return rem > 0 ? `${hrs}h ${rem}m ago` : `${hrs}h ago`;
}
export function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ── CSV ─────────────────────────────────────────────────── */
export function exportCSV(cards) {
  const rows = [CSV_HEADERS.join(',')];
  for (const c of cards) rows.push(CSV_HEADERS.map(h => `"${String(c[h] ?? '').replace(/"/g, '""')}"`).join(','));
  return rows.join('\n');
}
export function generateFilename() {
  const d = new Date();
  return `tcg-tracker-${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}.csv`;
}
export async function downloadCSV(cards) {
  const content = exportCSV(cards), filename = generateFilename();
  if (typeof window !== 'undefined' && window.showSaveFilePicker) {
    try {
      const fh = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: 'CSV spreadsheet', accept: { 'text/csv': ['.csv'] } }] });
      const w = await fh.createWritable(); await w.write(content); await w.close(); return;
    } catch (err) { if (err.name === 'AbortError') return; }
  }
  const blob = new Blob([content], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(a.href);
}
export function parseCSV(text) {
  const lines = text.trim().split('\n'); if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => { const vals = splitCSVLine(line); const obj = {}; headers.forEach((h, i) => { obj[h] = (vals[i] ?? '').trim(); }); return obj; });
}
export function splitCSVLine(line) {
  const result = []; let cur = '', inQuote = false;
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === ',' && !inQuote) { result.push(cur); cur = ''; continue; }
    cur += ch;
  }
  result.push(cur); return result;
}
export function csvRowToCard(row) {
  const now = new Date().toISOString();
  return makeCard({
    name: row.name || '', imageUrl: row.imageUrl || '', setName: row.setName || '',
    finish: row.finish || 'normal',
    condition: CONDITIONS.includes(row.condition) ? row.condition : 'NM',
    buyCost: row.buyCost || '', soldPrice: row.soldPrice || '',
    marketNM:     row.marketNM     ? parseFloat(row.marketNM)     : null,
    prevMarketNM: row.prevMarketNM ? parseFloat(row.prevMarketNM) : null,
    priceLow:     row.priceLow     ? parseFloat(row.priceLow)     : null,
    priceMid:     row.priceMid     ? parseFloat(row.priceMid)     : null,
    link: row.link || '', sold: row.sold === 'true' || row.sold === '1',
    tcgplayerId: row.tcgplayerId || '', notes: row.notes || '',
    language: row.language === 'jp' ? 'jp' : 'en',
    dateAdded: row.dateAdded || now, lastUpdated: row.lastUpdated || now,
  });
}

/* ============================================================
   English card search — pokemontcg.io  (UNCHANGED)
   ============================================================ */

const PROMO_SUFFIXES = [
  'special illustration rare', 'illustration rare',
  'black star promo', 'alternate art', 'rainbow rare',
  'secret rare', 'hyper rare', 'gold rare',
  'full art', 'alt art', 'promo',
];
export function stripPromoSuffix(query) {
  const sorted = [...PROMO_SUFFIXES].sort((a, b) => b.length - a.length);
  let q = query.trim(); const lower = q.toLowerCase();
  for (const suffix of sorted) {
    if (lower.endsWith(' ' + suffix)) { q = q.slice(0, q.length - suffix.length - 1).trimEnd(); break; }
  }
  return q;
}

/** Search pokemontcg.io. promoOnly adds rarity:Promo filter (Promo is a rarity, not a subtype). */
export async function searchCards(query, setQuery = '', promoOnly = false) {
  const cleaned  = stripPromoSuffix(query);
  const cacheKey = searchCacheKey(cleaned, setQuery, promoOnly);
  const cached   = readSearchCache(cacheKey);
  if (cached) return cached;

  const setFilter   = setQuery  ? ` set.name:"${setQuery}"` : '';
  const promoFilter = promoOnly ? ' rarity:Promo'            : '';
  const base        = `${POKEMON_API}?pageSize=100&orderBy=-set.releaseDate&select=id,name,images,set,number,tcgplayer`;

  const exactRes = await fetch(`${base}&q=${encodeURIComponent(`name:"${cleaned}"${setFilter}${promoFilter}`)}`);
  if (!exactRes.ok) throw new Error(`API error ${exactRes.status}`);
  let data = (await exactRes.json()).data || [];

  if (data.length === 0 || promoOnly) {
    try {
      const wildRes = await fetch(`${base}&q=${encodeURIComponent(`name:*${cleaned}*${setFilter}${promoFilter}`)}`);
      if (wildRes.ok) {
        const wildData = (await wildRes.json()).data || [];
        if (promoOnly || data.length === 0) data = wildData;
      }
    } catch { /* fall through */ }
  }

  writeSearchCache(cacheKey, data);
  return data;
}

/** Fetch prices for an English card via pokemontcg.io. */
export async function fetchCardPrices(tcgplayerId, forceRefresh = false) {
  if (!forceRefresh) { const cached = readPriceCache(tcgplayerId); if (cached) return cached.prices; }
  try {
    const res = await fetch(`${POKEMON_API}/${encodeURIComponent(tcgplayerId)}?select=tcgplayer`);
    if (!res.ok) return null;
    const prices = (await res.json()).data?.tcgplayer?.prices || null;
    if (prices) writePriceCache(tcgplayerId, prices);
    return prices;
  } catch { return null; }
}

export async function fetchCardByUrl(url) {
  const productMatch = url.match(/tcgplayer\.com\/product\/(\d+)/i);
  if (productMatch) {
    try {
      const res = await fetch(`${POKEMON_API}?q=tcgplayer.productId:${productMatch[1]}&select=id,name,images,set,number,tcgplayer`);
      if (res.ok) { const j = await res.json(); if (j.data?.[0]) return j.data[0]; }
    } catch { /* fall through */ }
  }
  try {
    const slug = url.split('?')[0].split('/').filter(Boolean).pop() || '';
    const parts = slug.replace(/^(pokemon|magic|yugioh|mtg|one-piece)-/i, '').split('-').filter(Boolean);
    for (let take = Math.min(parts.length, 5); take >= 1; take--) {
      const candidate = parts.slice(-take).join(' ');
      if (candidate.length < 3) continue;
      const res = await fetch(`${POKEMON_API}?q=name:"${encodeURIComponent(candidate)}"&pageSize=4&orderBy=-set.releaseDate&select=id,name,images,set,number,tcgplayer`);
      if (!res.ok) continue;
      const json = await res.json();
      if (json.data?.length > 0) return json.data[0];
    }
  } catch { /* ignore */ }
  return null;
}

/* ============================================================
   TCGdex — Japanese card search + TCGPlayer USD price fetch
   https://api.tcgdex.net   (free, no API key required)

   TCGdex is a multilingual Pokémon TCG database that includes
   Japanese sets absent from pokemontcg.io.

   Pricing: TCGdex aggregates from TCGPlayer (USD) and Cardmarket (EUR).
   We extract ONLY TCGPlayer USD pricing for currency consistency.
   Cards with no TCGPlayer listing (true JP-only releases) will have
   null prices and can still be tracked with a manually entered buy cost.

   ID storage: "tcgdex:<setId>-<localId>" in the tcgplayerId field,
   e.g. "tcgdex:sv6a-1". The "tcgdex:" prefix lets the refresh router
   call fetchJPCardPrices instead of fetchCardPrices.
   ============================================================ */

/**
 * Detect a JP card and return its raw TCGdex ID, or null for EN cards.
 * @param {string} tcgplayerId
 * @returns {string|null}
 */
export function parseTCGdexId(tcgplayerId) {
  if (typeof tcgplayerId === 'string' && tcgplayerId.startsWith('tcgdex:')) {
    return tcgplayerId.slice(7);
  }
  return null;
}

/**
 * Map TCGdex variant flags to our FINISH_LABELS key.
 * @param {object} variants — e.g. { holo: true, reverse: false, ... }
 */
export function tcgdexVariantToFinish(variants = {}) {
  if (variants.firstEdition && variants.holo) return 'firstEditionHolofoil';
  if (variants.firstEdition) return 'firstEditionNormal';
  if (variants.holo)         return 'holofoil';
  if (variants.reverse)      return 'reverseHolofoil';
  return 'normal';
}

/**
 * Map our finish key to the TCGdex pricing variant name.
 * @param {string} finish
 */
export function finishToTCGdexVariant(finish) {
  return { holofoil: 'holo', reverseHolofoil: 'reverse', firstEditionHolofoil: 'holo', firstEditionNormal: 'normal', normal: 'normal' }[finish] || 'normal';
}

/**
 * Extract TCGPlayer USD prices from a full TCGdex card object.
 * Tries the finish-matched variant first, then any variant with data.
 * Returns null when the card has no TCGPlayer listing at all.
 *
 * @param {object} cardFull  — full card from /v2/en/cards/:id
 * @param {string} finish    — our finish key
 * @returns {{market: number, low: number|null, mid: number|null}|null}
 */
export function extractTCGdexTCGPlayerPrice(cardFull, finish = 'normal') {
  const tcp = cardFull?.pricing?.tcgplayer;
  if (!tcp) return null;
  const preferred  = finishToTCGdexVariant(finish);
  const candidates = [preferred, 'holo', 'normal', 'reverse', 'firstEdition'].filter((v, i, a) => a.indexOf(v) === i);
  for (const v of candidates) {
    const p = tcp[v];
    if (p?.marketPrice != null) {
      return { market: p.marketPrice, low: p.lowPrice ?? null, mid: p.midPrice ?? null };
    }
  }
  return null;
}

/** Normalise a TCGdex list-endpoint card into our standard search result shape. */
function normaliseTCGdexCard(c) {
  const setId    = c.set?.id || c.setId || '';
  const localId  = c.localId || c.number || '';
  const tcgdexId = `${setId}-${localId}`;
  return {
    id:     `tcgdex:${tcgdexId}`,
    name:   c.name || '',
    number: localId,
    images: {
      small: c.image ? `${c.image}/low.webp`  : '',
      large: c.image ? `${c.image}/high.webp` : '',
    },
    set: { id: setId, name: c.set?.name || setId },
    tcgplayer:     null,            // populated after card is added
    _tcgdexFinish: tcgdexVariantToFinish(c.variants || {}),
    _tcgdexId:     tcgdexId,
  };
}

/**
 * Search Japanese cards via TCGdex.
 *
 * Strategy:
 *  1. Hit the Japanese-language endpoint so names are in Japanese.
 *  2. If 0 results, fall back to English endpoint (some older sets
 *     are only indexed under EN names in TCGdex).
 *  Results cached for SEARCH_CACHE_TTL_MS under the 'jp' cache slot.
 *
 * @param {string} query     — name in English or Japanese
 * @param {string} [setQuery]
 */
/**
 * Search Japanese cards.
 *
 * Routing:
 *  - If PROXY_BASE_URL is set → JustTCG via Cloudflare Worker proxy
 *    (comprehensive data, real pricing, full JP set coverage)
 *  - Otherwise → TCGdex fallback (free, no key, partial JP coverage)
 *
 * Both paths return the same normalised card shape so the rest of the
 * app doesn't need to know which source was used.
 */
export async function searchJPCards(query, setQuery = '') {
  const cleaned  = stripPromoSuffix(query);
  const cacheKey = searchCacheKey(cleaned, setQuery, true);
  const cached   = readSearchCache(cacheKey);
  if (cached) return cached;

  // ── Path A: JustTCG proxy ──────────────────────────────────────
  if (proxyConfigured()) {
    try {
      const params = new URLSearchParams({ q: cleaned });
      if (setQuery) params.set('set', setQuery);
      const res = await fetch(`${PROXY_BASE_URL.trim()}/jp/search?${params}`);
      if (res.ok) {
        const json = await res.json();
        const data = (json.cards || []).map(normaliseJustTCGCard);
        writeSearchCache(cacheKey, data);
        return data;
      }
    } catch { /* fall through to TCGdex */ }
  }

  // ── Path B: TCGdex fallback ────────────────────────────────────
  const nameFilter = `name=like:${encodeURIComponent(cleaned)}`;
  const setFilter  = setQuery ? `&set.name=like:${encodeURIComponent(setQuery)}` : '';
  const pagination = `&sort:field=localId&sort:order=DESC&pagination:page=1&pagination:itemsPerPage=80`;

  let raw = [];
  try {
    const res = await fetch(`${TCGDEX_API}/ja/cards?${nameFilter}${setFilter}${pagination}`);
    if (res.ok) { const j = await res.json(); raw = Array.isArray(j) ? j : []; }
  } catch { /* network error */ }

  if (raw.length === 0) {
    try {
      const res = await fetch(`${TCGDEX_API}/en/cards?${nameFilter}${setFilter}${pagination}`);
      if (res.ok) { const j = await res.json(); raw = Array.isArray(j) ? j : []; }
    } catch { /* network error */ }
  }

  const data = raw.map(normaliseTCGdexCard);
  writeSearchCache(cacheKey, data);
  return data;
}

/**
 * Fetch available JP sets from the proxy (JustTCG).
 * Returns [] when proxy is not configured.
 * @returns {Promise<Array<{id, name, releaseDate, cardCount}>>}
 */
export async function fetchJPSets() {
  if (!proxyConfigured()) return [];
  try {
    const res = await fetch(`${PROXY_BASE_URL.trim()}/jp/sets`);
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

/**
 * Fetch TCGPlayer USD prices for a JP card via TCGdex.
 * Always uses the English endpoint (pricing is only on EN card objects).
 * Caches the full card object for 1 hour.
 *
 * @param {string}  tcgdexId      — raw ID, e.g. "sv6a-1" (no "tcgdex:" prefix)
 * @param {string}  [finish]
 * @param {boolean} [forceRefresh]
 * @returns {Promise<{market, low, mid}|null>}
 */
/**
 * Fetch TCGPlayer USD prices for a JP card.
 *
 * Routing:
 *  - Proxy configured → JustTCG via Worker (best coverage + real pricing)
 *    tcgdexId may be a JustTCG card id (stored in tcgplayerId after search)
 *  - No proxy → TCGdex English endpoint (partial coverage)
 *
 * @param {string}  cardId        raw id (no "tcgdex:" prefix)
 * @param {string}  [finish]      our finish key → mapped to printing
 * @param {boolean} [forceRefresh]
 * @returns {Promise<{market, low, mid}|null>}
 */
export async function fetchJPCardPrices(cardId, finish = 'normal', forceRefresh = false) {
  const storageKey = PRICE_CACHE_PREFIX + 'jp:' + cardId;

  if (!forceRefresh) {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const entry = JSON.parse(raw);
        if (Date.now() - entry.cachedAt <= CACHE_TTL_MS) return entry.prices;
        localStorage.removeItem(storageKey);
      }
    } catch { /* corrupt */ }
  }

  // ── Path A: JustTCG proxy ──────────────────────────────────────
  if (proxyConfigured()) {
    try {
      const printing = finishToJustTCGPrinting(finish);
      const params   = new URLSearchParams({ id: cardId, printing, condition: 'NM' });
      const res      = await fetch(`${PROXY_BASE_URL.trim()}/jp/prices?${params}`);
      if (res.ok) {
        const data   = await res.json();
        const prices = { market: data.market, low: data.low, mid: data.mid };
        try { localStorage.setItem(storageKey, JSON.stringify({ prices, cachedAt: Date.now() })); } catch { /* quota */ }
        return prices.market != null ? prices : null;
      }
    } catch { /* fall through to TCGdex */ }
  }

  // ── Path B: TCGdex fallback ────────────────────────────────────
  try {
    const res = await fetch(`${TCGDEX_API}/en/cards/${encodeURIComponent(cardId)}`);
    if (!res.ok) return null;
    const cardFull = await res.json();
    const prices   = extractTCGdexTCGPlayerPrice(cardFull, finish);
    if (prices) {
      try { localStorage.setItem(storageKey, JSON.stringify({ prices, cachedAt: Date.now() })); } catch { /* quota */ }
    }
    return prices;
  } catch { return null; }
}

/**
 * Map our finish keys to JustTCG printing names.
 * JustTCG uses: "Holofoil", "Reverse Holofoil", "Normal", "1st Edition Holofoil", etc.
 */
export function finishToJustTCGPrinting(finish) {
  return {
    holofoil:             'Holofoil',
    reverseHolofoil:      'Reverse Holofoil',
    firstEditionHolofoil: '1st Edition Holofoil',
    firstEditionNormal:   '1st Edition Normal',
    normal:               'Normal',
  }[finish] || 'Normal';
}

/**
 * Normalise a JustTCG card (from proxy /jp/search) into our standard search result shape.
 * Shape matches normaliseTCGdexCard output so renderSearchResults works unchanged.
 */
function normaliseJustTCGCard(c) {
  return {
    // Store JustTCG card id with the tcgdex: prefix so the refresh router knows
    id:     `tcgdex:${c.id}`,
    name:   c.name    || '',
    number: c.number  || '',
    images: {
      small: c.imageUrl || '',
      large: c.imageUrl || '',
    },
    set: { id: c.setId || '', name: c.setName || '' },
    tcgplayer:      null,
    _tcgdexFinish:  'normal',   // JustTCG doesn't expose variant flags at search level
    _tcgdexId:      c.id,
    _printings:     c.printings || [],      // available printing types for this card
    _marketPreview: c.marketPreview || null, // best NM price for display
    _source:        'justtcg',
  };
}

/* ── Undo ────────────────────────────────────────────────── */
export const UNDO_MAX_SNAPSHOTS = 5;
export function snapshotCards(cards) { return JSON.parse(JSON.stringify(cards)); }

/* ── Seed data ───────────────────────────────────────────── */
export function getSeedCards() {
  const daysAgo = n => { const t = new Date(); t.setDate(t.getDate() - n); return t.toISOString(); };
  return [
    makeCard({ name:'Rayquaza VMAX', setName:'Evolving Skies', finish:'holofoil', condition:'NM', buyCost:'30.00', soldPrice:'',      marketNM:52.00, prevMarketNM:48.00, priceLow:44.00, priceMid:49.00, notes:'',                          language:'en', imageUrl:'https://images.pokemontcg.io/swsh7/218_hires.png',  link:'', tcgplayerId:'swsh7-218',  sold:false, dateAdded:daysAgo(60), lastUpdated:daysAgo(5)  }),
    makeCard({ name:'Umbreon VMAX',  setName:'Evolving Skies', finish:'holofoil', condition:'NM', buyCost:'38.00', soldPrice:'55.00', marketNM:60.00, prevMarketNM:62.00, priceLow:50.00, priceMid:56.00, notes:'Sold on eBay, great buyer', language:'en', imageUrl:'https://images.pokemontcg.io/swsh7/215_hires.png',  link:'', tcgplayerId:'swsh7-215',  sold:true,  dateAdded:daysAgo(45), lastUpdated:daysAgo(7)  }),
    makeCard({ name:'Lugia VSTAR',   setName:'Silver Tempest', finish:'holofoil', condition:'MP', buyCost:'20.00', soldPrice:'',      marketNM:38.00, prevMarketNM:null,  priceLow:30.00, priceMid:35.00, notes:'Light play, small crease', language:'en', imageUrl:'https://images.pokemontcg.io/swsh12/227_hires.png', link:'', tcgplayerId:'swsh12-227', sold:false, dateAdded:daysAgo(20), lastUpdated:daysAgo(20) }),
    makeCard({ name:'Mew VMAX',      setName:'Fusion Strike',  finish:'holofoil', condition:'NM', buyCost:'16.00', soldPrice:'',      marketNM:22.00, prevMarketNM:20.00, priceLow:17.50, priceMid:20.00, notes:'',                          language:'en', imageUrl:'https://images.pokemontcg.io/swsh8/271_hires.png',  link:'', tcgplayerId:'swsh8-271',  sold:false, dateAdded:daysAgo(8),  lastUpdated:daysAgo(8)  }),
  ];
}
