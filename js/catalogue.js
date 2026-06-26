/**
 * catalogue.js — IndexedDB-backed local card catalogue.
 *
 * PURPOSE
 * -------
 * Live API search pays network latency on every keystroke-triggered query.
 * This module background-loads a full card catalogue once per session
 * (or once per CATALOGUE_TTL_MS), stores it in IndexedDB, and serves all
 * subsequent searches from that local index — typically under 1ms instead
 * of 200-600ms per query.
 *
 * SCOPE
 * -----
 *  - EN catalogue: pokemontcg-data GitHub JSON (~4-6MB), loaded once in full.
 *    This is small enough to fetch entirely on first visit.
 *  - JP catalogue: TCGdex's full card list is much larger (~15MB across all
 *    languages), so instead of loading it all upfront we load JP SETS only
 *    (tiny — a few KB) and fetch a set's cards on demand when the user picks
 *    it from the set browser or searches within it. Once a set is fetched
 *    it's cached in IndexedDB permanently (until TTL expiry) so repeat
 *    searches within that set are instant too.
 *
 * FALLBACK
 * --------
 * If IndexedDB is unavailable (private browsing in some browsers, very old
 * browsers) or the catalogue hasn't finished loading yet, callers should
 * fall back to the live API search in core.js. This module never throws —
 * every function returns a safe empty/null value on failure so the caller
 * can always fall through.
 *
 * STORAGE LAYOUT (IndexedDB database "tcg_catalogue", version 2)
 * -----------------------------------------------------------------
 *  Object store "en_cards"     — keyPath "id",   indexed on "nameLower", "releaseDate"
 *  Object store "jp_set_cards" — keyPath "id",   indexed on "nameLower", "setId"
 *  Object store "meta"         — keyPath "key"   (catalogue load timestamps)
 */

const DB_NAME    = 'tcg_catalogue';
const DB_VERSION = 2; // v2: added 'releaseDate' index on en_cards (search-order fix)
const EN_STORE   = 'en_cards';
const JP_STORE   = 'jp_set_cards';
const META_STORE = 'meta';

export const CATALOGUE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// pokemon-tcg-data has NO single file with every card — cards are split
// one-file-per-set under cards/en/{setId}.json. The sets index below lists
// every set id; loadENCatalogue() fetches that first, then fetches each
// set's card file in throttled concurrent batches and merges the results.
const EN_SETS_INDEX_URL = 'https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master/sets/en.json';
const EN_SET_CARDS_URL  = (setId) => `https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master/cards/en/${setId}.json`;

let _dbPromise = null;
let _enLoadPromise = null;

/* ============================================================
   Diagnostics (v19) — instrumentation for tracking down catalogue
   load / search-routing slowness without guesswork.
   -----------------------------------------------------------------
   Pure observability: nothing here changes behavior or timing, it only
   records what happened so it can be inspected via getCatalogueDiagnostics()
   or window.tcgDebug in the console. See "Why this exists" in the v19
   handoff section for the concrete bugs this is meant to catch:
     1. searches silently falling back to the live API because the
        catalogue hadn't finished loading yet
     2. an IndexedDB open() blocked indefinitely by another tab/connection
        (no onblocked handler existed before this — now logged, not fixed)
   ============================================================ */
const MAX_LOG_ENTRIES = 25;

const _diag = {
  dbOpenRequestedAt: null,
  dbOpenResolvedAt:  null,
  dbOpenMs:          null,
  dbBlocked:         false,   // set true if onblocked ever fires
  dbBlockedAt:       null,
  dbBlockedStillOpen: false,  // true while a blocked request has not yet resolved
  enLoad: {
    startedAt:    null,
    finishedAt:   null,
    durationMs:   null,
    source:       null,  // 'ttl-skip' | 'fresh-load' | 'failed-no-sets' | 'failed-fetch' | 'failed-empty'
    loadedSets:   null,
    totalSets:    null,
    count:        null,
    failedSetIds: [], // v19: set ids whose card-file fetch failed (network or non-ok) — every card in these is silently absent locally
  },
  searchLog: [], // ring buffer of recent searchENCatalogue() calls
};

function _pushSearchLog(entry) {
  _diag.searchLog.push({ ts: Date.now(), ...entry });
  if (_diag.searchLog.length > MAX_LOG_ENTRIES) _diag.searchLog.shift();
}

/**
 * Snapshot of internal catalogue-loading/search diagnostics. Safe to call
 * any time, never throws. Intended for console inspection
 * (`window.tcgDebug.catalogue()`) when search speed looks wrong and you
 * need to know WHY (still loading? blocked? index missing?) instead of
 * guessing.
 */
export function getCatalogueDiagnostics() {
  return JSON.parse(JSON.stringify(_diag)); // plain snapshot, no shared refs
}

/* ============================================================
   IndexedDB low-level helpers
   ============================================================ */

/** Returns true if IndexedDB is available in this environment. */
export function indexedDBAvailable() {
  return typeof indexedDB !== 'undefined';
}

function openDB() {
  if (_dbPromise) return _dbPromise;
  if (!indexedDBAvailable()) { _dbPromise = Promise.resolve(null); return _dbPromise; }

  _diag.dbOpenRequestedAt = Date.now();
  _dbPromise = new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch { resolve(null); return; }

    // Diagnostic only — fires if another tab/connection is holding an
    // older-version connection open to this database, which prevents the
    // version-upgrade transaction from ever starting. Logged so this is
    // visible instead of silently looking like "search got slow" with no
    // clue why. Does not close the other connection or otherwise change
    // behavior — that would be a real fix, not instrumentation.
    req.onblocked = () => {
      _diag.dbBlocked = true;
      _diag.dbBlockedAt = Date.now();
      _diag.dbBlockedStillOpen = true;
      console.warn(
        '[tcg-diag] IndexedDB open() BLOCKED — another tab/connection (e.g. ' +
        'tests.html left open, or a stale tab of this app) is holding an ' +
        'older-version connection to "tcg_catalogue" open. The catalogue ' +
        'cannot load or be queried until that other connection closes. ' +
        'Close other tabs of this app and reload.'
      );
    };

    req.onupgradeneeded = (event) => {
      const db = req.result;
      let enStore;
      if (!db.objectStoreNames.contains(EN_STORE)) {
        enStore = db.createObjectStore(EN_STORE, { keyPath: 'id' });
        enStore.createIndex('nameLower', 'nameLower', { unique: false });
      } else {
        // Upgrading an existing v1 store — reuse it via the versionchange transaction.
        enStore = req.transaction.objectStore(EN_STORE);
      }
      // v2: index on releaseDate so search can cursor newest-first directly,
      // instead of capping an id-ordered (alphabetical, NOT chronological)
      // cursor early and sorting whatever happened to get collected.
      if (!enStore.indexNames.contains('releaseDate')) {
        enStore.createIndex('releaseDate', 'releaseDate', { unique: false });
      }
      if (!db.objectStoreNames.contains(JP_STORE)) {
        const store = db.createObjectStore(JP_STORE, { keyPath: 'id' });
        store.createIndex('nameLower', 'nameLower', { unique: false });
        store.createIndex('setId', 'setId', { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      _diag.dbOpenResolvedAt = Date.now();
      _diag.dbOpenMs = _diag.dbOpenResolvedAt - _diag.dbOpenRequestedAt;
      _diag.dbBlockedStillOpen = false;
      if (_diag.dbBlocked) {
        console.info(`[tcg-diag] IndexedDB open() unblocked after ${_diag.dbOpenMs}ms (was blocked at ${new Date(_diag.dbBlockedAt).toLocaleTimeString()}).`);
      }
      resolve(req.result);
    };
    req.onerror = () => {
      _diag.dbOpenResolvedAt = Date.now();
      _diag.dbOpenMs = _diag.dbOpenResolvedAt - _diag.dbOpenRequestedAt;
      console.warn('[tcg-diag] IndexedDB open() failed — falling back to live API search for this session.', req.error);
      resolve(null); // never throw — caller falls back to live API
    };
  });
  return _dbPromise;
}

function withStore(storeName, mode, fn) {
  return openDB().then(db => {
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx    = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const result = fn(store);
        tx.oncomplete = () => resolve(result?.result ?? result ?? null);
        tx.onerror    = () => resolve(null);
      } catch { resolve(null); }
    });
  }).catch(() => null);
}

async function getMeta(key) {
  const db = await openDB();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const tx = db.transaction(META_STORE, 'readonly');
      const req = tx.objectStore(META_STORE).get(key);
      req.onsuccess = () => resolve(req.result?.value ?? null);
      req.onerror   = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function setMeta(key, value) {
  const db = await openDB();
  if (!db) return;
  return new Promise(resolve => {
    try {
      const tx = db.transaction(META_STORE, 'readwrite');
      tx.objectStore(META_STORE).put({ key, value });
      tx.oncomplete = () => resolve();
      tx.onerror    = () => resolve();
    } catch { resolve(); }
  });
}

async function bulkPut(storeName, records) {
  const db = await openDB();
  if (!db || !records.length) return;
  return new Promise(resolve => {
    try {
      const tx    = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      for (const r of records) store.put(r);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => resolve();
    } catch { resolve(); }
  });
}

async function clearStore(storeName) {
  const db = await openDB();
  if (!db) return;
  return new Promise(resolve => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror    = () => resolve();
    } catch { resolve(); }
  });
}

/* ============================================================
   EN catalogue — full load, background, TTL-refreshed
   ============================================================ */

/**
 * Kick off the background EN catalogue load. Safe to call multiple times —
 * subsequent calls return the same in-flight or completed promise.
 * Does nothing (resolves immediately) if IndexedDB isn't available or the
 * catalogue was loaded within CATALOGUE_TTL_MS.
 *
 * IMPLEMENTATION NOTE: pokemon-tcg-data has no single file containing every
 * card — cards are split one-file-per-set under cards/en/{setId}.json
 * (e.g. base1.json, swsh7.json, basep.json). We first fetch the small sets
 * index (sets/en.json, a few KB listing every set id), then fetch each
 * set's card file. Set files are fetched in small concurrent batches with
 * a short delay between batches so we don't fire 150+ simultaneous
 * requests at raw.githubusercontent.com — GitHub's CDN will rate-limit or
 * the browser will throttle concurrent connections to the same origin
 * regardless, so batching avoids both. Cards are written to IndexedDB
 * incrementally as each batch resolves, so a failure partway through still
 * leaves whatever loaded successfully usable for search, and a page reload
 * resumes-from-scratch but doesn't lose the partial progress that was
 * already committed to the DB before the failure.
 *
 * Individual set fetch failures are tolerated and skipped — a single 404
 * or network blip on one set's file does not abort the whole load.
 *
 * FIX (confirmed via direct inspection of the real files): per-card JSON
 * objects have NO `set` field and NO `releaseDate` — those only exist on
 * the SET object in sets/en.json. Previously this function read `c.set?.name`
 * off the card itself, which is always undefined, silently producing
 * `setName: ''` on every single record. We now build a setId -> {name,
 * releaseDate} lookup from the sets index fetched in Stage 1, and stamp
 * both fields onto every card record in Stage 2. This also makes
 * descending-by-newest-set sorting possible (see searchENCatalogue below).
 *
 * @param {Function} [onProgress] optional (loadedSets, totalSets) => void
 * @returns {Promise<{loaded: boolean, count: number}>}
 */
export async function loadENCatalogue(onProgress) {
  if (_enLoadPromise) return _enLoadPromise;
  if (!indexedDBAvailable()) return { loaded: false, count: 0 };

  _diag.enLoad.startedAt  = Date.now();
  _diag.enLoad.finishedAt = null;
  _diag.enLoad.durationMs = null;
  _diag.enLoad.source     = null;
  _diag.enLoad.loadedSets = null;
  _diag.enLoad.totalSets  = null;
  _diag.enLoad.count      = null;
  _diag.enLoad.failedSetIds = [];

  const finish = (source, count) => {
    _diag.enLoad.finishedAt = Date.now();
    _diag.enLoad.durationMs = _diag.enLoad.finishedAt - _diag.enLoad.startedAt;
    _diag.enLoad.source     = source;
    _diag.enLoad.count      = count;
    const failedNote = _diag.enLoad.failedSetIds.length ? ` failedSets=${_diag.enLoad.failedSetIds.length}` : '';
    console.info(`[tcg-diag] EN catalogue load: source=${source} count=${count} duration=${_diag.enLoad.durationMs}ms${failedNote}`);
  };

  _enLoadPromise = (async () => {
    const lastLoaded = await getMeta('en_loaded_at');
    if (lastLoaded && (Date.now() - lastLoaded) < CATALOGUE_TTL_MS) {
      const count = await getMeta('en_count');
      if (count) { finish('ttl-skip', count); return { loaded: true, count }; }
      // lastLoaded was set but count is 0/missing — treat as not actually loaded
    }

    // ── Stage 1: fetch the sets index, keep a setId -> {name, releaseDate} map ──
    let setIds = [];
    const setInfo = {}; // setId -> { name, releaseDate }
    try {
      const res = await fetch(EN_SETS_INDEX_URL);
      if (!res.ok) { finish('failed-fetch', 0); return { loaded: false, count: 0 }; }
      const setsJson = await res.json();
      if (!Array.isArray(setsJson)) { finish('failed-fetch', 0); return { loaded: false, count: 0 }; }
      for (const s of setsJson) {
        if (!s.id) continue;
        setIds.push(s.id);
        setInfo[s.id] = { name: s.name || s.id, releaseDate: s.releaseDate || '' };
      }
    } catch {
      finish('failed-fetch', 0);
      return { loaded: false, count: 0 };
    }
    if (setIds.length === 0) { finish('failed-no-sets', 0); return { loaded: false, count: 0 }; }
    _diag.enLoad.totalSets = setIds.length;

    // ── Stage 2: fetch each set's card file, stamp set name + release date ──
    await clearStore(EN_STORE);
    const BATCH_SIZE = 8;
    let totalCount = 0;
    const failedSetIds = [];

    for (let i = 0; i < setIds.length; i += BATCH_SIZE) {
      const batch = setIds.slice(i, i + BATCH_SIZE);
      // Every promise here is made to resolve (never reject) via the trailing
      // .catch, so we always have {setId, data} to inspect — including for
      // genuine network failures, not just non-ok HTTP responses. Previously
      // (pre-v19) a rejected fetch lost its setId entirely once it hit
      // Promise.allSettled's rejected branch, making a partially-failed
      // load completely silent and undiagnosable — it would still report a
      // plausible-looking total count with no way to tell which set(s) of
      // cards were quietly missing from the local index.
      const batchResults = await Promise.all(
        batch.map(setId => fetch(EN_SET_CARDS_URL(setId))
          .then(r => r.ok ? r.json() : null)
          .then(data => ({ setId, data }))
          .catch(() => ({ setId, data: null }))
        )
      );

      const records = [];
      for (const { setId, data } of batchResults) {
        if (!Array.isArray(data)) { failedSetIds.push(setId); continue; }
        const info = setInfo[setId] || { name: setId, releaseDate: '' };
        for (const c of data) {
          records.push({
            id:          c.id,
            name:        c.name || '',
            nameLower:   (c.name || '').toLowerCase(),
            setName:     info.name,
            setId,
            releaseDate: info.releaseDate, // "YYYY/MM/DD" — used for newest-first sort
            number:      c.number || '',
            images:      c.images || {},
            tcgplayer:   c.tcgplayer || null, // confirmed absent on every card, kept for forward-compat
          });
        }
      }
      if (records.length) {
        await bulkPut(EN_STORE, records);
        totalCount += records.length;
        await setMeta('en_count', totalCount); // commit progress incrementally
      }
      _diag.enLoad.loadedSets = Math.min(i + BATCH_SIZE, setIds.length);
      _diag.enLoad.failedSetIds = failedSetIds.slice();
      if (typeof onProgress === 'function') {
        onProgress(Math.min(i + BATCH_SIZE, setIds.length), setIds.length);
      }
      // Small throttle between batches to stay polite to the CDN
      if (i + BATCH_SIZE < setIds.length) await new Promise(r => setTimeout(r, 150));
    }

    if (failedSetIds.length) {
      console.warn(`[tcg-diag] EN catalogue load: ${failedSetIds.length} set(s) failed to fetch and were skipped — every card in these sets is silently missing from local search: ${failedSetIds.join(', ')}`);
    }

    if (totalCount === 0) { finish('failed-empty', 0); return { loaded: false, count: 0 }; }
    await setMeta('en_loaded_at', Date.now());
    await setMeta('en_count', totalCount);
    finish('fresh-load', totalCount);
    return { loaded: true, count: totalCount };
  })();

  return _enLoadPromise;
}

/** Async check: has the EN catalogue actually loaded data into IndexedDB? */
export async function isEnCatalogueLoaded() {
  if (!indexedDBAvailable()) return false;
  const count = await getMeta('en_count');
  return !!count && count > 0;
}

/**
 * Search the local EN catalogue by name substring. Returns [] if the
 * catalogue isn't loaded yet — caller should fall back to live API search.
 *
 * Walks the 'releaseDate' index in REVERSE ('prev') so the cursor itself
 * visits newest-set cards first. This matters because we cap collection
 * at limit*4 candidates for performance — with the old id-keyed cursor
 * (alphabetical by card id, NOT chronological) that cap could fill up
 * entirely on old-set matches before ever reaching newer sets, so the
 * post-hoc sort had nothing newer to promote. Cursoring the date index
 * descending makes the early-exit cap correct by construction: whatever
 * gets collected first is already the newest-available matches.
 * core.js's rankResults() is applied on top of this by the caller. Through
 * v19, rankResults() treated this newest-first order as a mere tiebreaker
 * behind match closeness; as of v20 it's the other way around — release
 * date is now the PRIMARY sort key there, with closeness only breaking
 * ties among same-date cards (see rankResults()'s doc comment in core.js
 * for the rationale). Either way, the ordering this function produces is
 * what rankResults() starts from, so getting it right here still matters.
 *
 * @param {string} query
 * @param {string} [setQuery]
 * @param {number} [limit]
 * @returns {Promise<Array>}
 */
export async function searchENCatalogue(query, setQuery = '', limit = 100) {
  const startedAt = Date.now();
  const db = await openDB();
  if (!db) {
    _pushSearchLog({ query, setQuery, limit, dbAvailable: false, hasIndex: null, collected: 0, ms: Date.now() - startedAt });
    return [];
  }
  const q = query.toLowerCase().trim();
  if (!q) return [];

  let hasIndexUsed = null;
  const results = await new Promise(resolve => {
    try {
      const tx       = db.transaction(EN_STORE, 'readonly');
      const store     = tx.objectStore(EN_STORE);
      const collected = [];
      // Index-based cursor in descending releaseDate order. Falls back to
      // the plain (id-ordered) cursor only if the index is somehow missing
      // — e.g. an upgrade race — so search still works, just without the
      // newest-first guarantee, rather than throwing.
      const hasIndex  = store.indexNames.contains('releaseDate');
      hasIndexUsed = hasIndex;
      if (!hasIndex) {
        console.warn('[tcg-diag] searchENCatalogue: "releaseDate" index missing on en_cards — falling back to unordered cursor + post-sort. This should not happen post-migration; if you see this repeatedly, the v2 upgrade may not have completed.');
      }
      const cursorReq = hasIndex ? store.index('releaseDate').openCursor(null, 'prev') : store.openCursor();
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor || collected.length >= limit * 4) {
          // Collected enough raw candidates (over-fetch a bit; caller ranks/truncates)
          resolve(collected);
          return;
        }
        const rec = cursor.value;
        const nameMatches = rec.nameLower.includes(q);
        const setMatches  = !setQuery || (rec.setName || '').toLowerCase().includes(setQuery.toLowerCase());
        if (nameMatches && setMatches) {
          collected.push({
            id: rec.id, name: rec.name,
            images: rec.images, set: { id: rec.setId, name: rec.setName },
            number: rec.number, tcgplayer: rec.tcgplayer,
            releaseDate: rec.releaseDate || '', // "YYYY/MM/DD" — string-sortable as-is
          });
        }
        cursor.continue();
      };
      cursorReq.onerror = () => resolve(collected);
    } catch (err) {
      console.warn('[tcg-diag] searchENCatalogue: cursor threw, returning empty (caller will fall back to live API).', err);
      resolve([]);
    }
  });

  // Belt-and-suspenders: re-assert newest-first in case the index path was
  // unavailable and we fell back to the unordered cursor above.
  const sorted = results.sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
  _pushSearchLog({ query, setQuery, limit, dbAvailable: true, hasIndex: hasIndexUsed, collected: sorted.length, ms: Date.now() - startedAt });
  return sorted;
}

/* ============================================================
   JP sets index — small, loaded once; per-set cards loaded on demand
   ============================================================ */

/**
 * Returns true if a given JP set's cards have already been cached locally.
 */
export async function isJPSetCached(setId) {
  const cachedSets = await getMeta('jp_cached_sets') || [];
  return cachedSets.includes(setId);
}

/**
 * Fetch and cache all cards for a single JP set into IndexedDB.
 * Call this when the user opens a set from the JP set browser, or before
 * searching within a specific set — subsequent searches in that set are
 * then served locally.
 *
 * @param {string} setId — TCGdex set id, e.g. "sv6a"
 * @param {Function} fetchSetCardsFn — async (setId) => Array<rawCard>
 *   (passed in from core.js to avoid a circular import on TCGDEX_API)
 */
export async function cacheJPSet(setId, fetchSetCardsFn) {
  if (!indexedDBAvailable() || !setId) return { cached: false, count: 0 };
  if (await isJPSetCached(setId)) return { cached: true, count: 0 }; // already have it

  try {
    const rawCards = await fetchSetCardsFn(setId);
    if (!Array.isArray(rawCards) || rawCards.length === 0) return { cached: false, count: 0 };

    const records = rawCards.map(c => ({
      id:        `tcgdex:${setId}-${c.localId || c.id}`,
      name:      c.name || '',
      nameLower: (c.name || '').toLowerCase(),
      setId,
      setName:   c.set?.name || setId,
      number:    c.localId || c.number || '',
      image:     c.image || '',
      variants:  c.variants || {},
    }));

    await bulkPut(JP_STORE, records);
    const cachedSets = await getMeta('jp_cached_sets') || [];
    if (!cachedSets.includes(setId)) cachedSets.push(setId);
    await setMeta('jp_cached_sets', cachedSets);
    return { cached: true, count: records.length };
  } catch {
    return { cached: false, count: 0 };
  }
}

/**
 * Search locally-cached JP sets by name substring. Only searches sets that
 * have already been cached via cacheJPSet — returns [] for everything else,
 * so callers should fall back to live JustTCG/TCGdex search for uncached sets.
 *
 * @param {string} query
 * @param {string} [setId] — restrict to one set, or search all cached sets
 */
export async function searchJPCatalogue(query, setId = '') {
  const db = await openDB();
  if (!db) return [];
  const q = query.toLowerCase().trim();
  if (!q) return [];

  return new Promise(resolve => {
    try {
      const tx     = db.transaction(JP_STORE, 'readonly');
      const store  = tx.objectStore(JP_STORE);
      const results = [];
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) { resolve(results); return; }
        const rec = cursor.value;
        const nameMatches = rec.nameLower.includes(q);
        const setMatches  = !setId || rec.setId === setId;
        if (nameMatches && setMatches) {
          results.push({
            id: rec.id, name: rec.name,
            images: { small: rec.image ? `${rec.image}/low.webp` : '', large: rec.image ? `${rec.image}/high.webp` : '' },
            set: { id: rec.setId, name: rec.setName },
            number: rec.number,
            _tcgdexFinish: rec.variants?.holo ? 'holofoil' : 'normal',
            _tcgdexId: `${rec.setId}-${rec.number}`,
          });
        }
        cursor.continue();
      };
      cursorReq.onerror = () => resolve(results);
    } catch { resolve([]); }
  });
}

/* ============================================================
   Diagnostics — for the How-To modal / settings UI
   ============================================================ */

/** Returns a small status object the UI can display, e.g. "18,402 EN cards cached, refreshed 3 days ago". */
export async function catalogueStatus() {
  if (!indexedDBAvailable()) return { available: false };
  const enCount  = await getMeta('en_count')      || 0;
  const enLoaded = await getMeta('en_loaded_at')  || null;
  const jpSets   = await getMeta('jp_cached_sets') || [];
  let hasReleaseDateIndex = null;
  try {
    const db = await openDB();
    if (db) {
      const tx = db.transaction(EN_STORE, 'readonly');
      hasReleaseDateIndex = tx.objectStore(EN_STORE).indexNames.contains('releaseDate');
    }
  } catch { /* leave null — diagnostic only, never throw */ }
  return {
    available: true,
    enCount,
    enLoadedAt: enLoaded,
    enAgeMs: enLoaded ? Date.now() - enLoaded : null,
    jpSetsCached: jpSets.length,
    hasReleaseDateIndex,        // v19: confirms the v2 index migration actually landed
    diagnostics: getCatalogueDiagnostics(), // v19: full load/search/block timing — see getCatalogueDiagnostics()
  };
}

/** Force a full catalogue reset — useful for a "Rebuild catalogue" button. */
export async function clearCatalogue() {
  await clearStore(EN_STORE);
  await clearStore(JP_STORE);
  await clearStore(META_STORE);
  _enLoadPromise = null;
}
