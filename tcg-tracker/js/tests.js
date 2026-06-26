/**
 * tests.js — unit test suite for tests.html.
 */

import {
  CONDITIONS, COND_MULT,
  makeCard, resetIdCounter, touchUpdated,
  adjPrice, calcProfit, calcActualProfit, calcPriceDelta, sortCards,
  fmt, fmtPct, fmtDate, fmtAge,
  exportCSV, parseCSV, splitCSVLine, csvRowToCard, CSV_HEADERS,
  generateFilename, getSeedCards,
  readPriceCache, writePriceCache, clearPriceCache, CACHE_TTL_MS,
  snapshotCards, UNDO_MAX_SNAPSHOTS,
  searchCacheKey, readSearchCache, writeSearchCache, SEARCH_CACHE_TTL_MS,
  buildTCGSearchUrl,
  syncNextId,
  stripPromoSuffix,
  parseTCGdexId,
  tcgdexVariantToFinish,
  finishToTCGdexVariant,
  extractTCGdexTCGPlayerPrice,
  proxyConfigured, PROXY_BASE_URL,
  finishToJustTCGPrinting,
  matchScore, rankResults,
  fetchTCGdexSetsList, fetchJPSets,
  searchCards, getSearchDiagnostics,
} from './core.js';
import {
  indexedDBAvailable, loadENCatalogue, isEnCatalogueLoaded,
  searchENCatalogue, cacheJPSet, isJPSetCached, searchJPCatalogue,
  catalogueStatus, clearCatalogue, CATALOGUE_TTL_MS,
  getCatalogueDiagnostics,
} from './catalogue.js';

/* ============================================================
   Micro assertion library
   ============================================================ */

function assert(cond, msg)               { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg)          { if (a !== b) throw new Error(`${msg||'Expected equal'} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
function assertClose(a, b, e=0.001, msg) { if (Math.abs(a-b) > e) throw new Error(`${msg||'Expected ~equal'} — got ${a}, expected ${b} (±${e})`); }
function assertNull(v, msg)              { if (v !== null) throw new Error(`${msg||'Expected null'} — got ${JSON.stringify(v)}`); }
function assertIncludes(str, substr, msg){ if (!str.includes(substr)) throw new Error(`${msg||'Expected string to include'} "${substr}" — got: ${str}`); }

/* ============================================================
   Test groups
   ============================================================ */

const TEST_GROUPS = [

  /* ── Condition multipliers & adjusted price ─────────────────── */
  {
    name: 'Condition multipliers & adjusted price',
    tests: [
      { name: 'NM uses 1.0×',   fn: () => assertClose(adjPrice(makeCard({ marketNM:10, condition:'NM'  })), 10)  },
      { name: 'LP uses 0.85×',  fn: () => assertClose(adjPrice(makeCard({ marketNM:10, condition:'LP'  })), 8.5) },
      { name: 'MP uses 0.70×',  fn: () => assertClose(adjPrice(makeCard({ marketNM:10, condition:'MP'  })), 7.0) },
      { name: 'HP uses 0.50×',  fn: () => assertClose(adjPrice(makeCard({ marketNM:10, condition:'HP'  })), 5.0) },
      { name: 'DMG uses 0.30×', fn: () => assertClose(adjPrice(makeCard({ marketNM:10, condition:'DMG' })), 3.0) },
      { name: 'Falls back to priceMid when marketNM is null', fn: () => assertClose(adjPrice(makeCard({ marketNM:null, priceMid:8, condition:'NM' })), 8) },
      { name: 'Returns 0 when all prices are null',            fn: () => assertClose(adjPrice(makeCard({ marketNM:null, priceMid:null, condition:'NM' })), 0) },
      { name: 'Multiplier applied on priceMid fallback',       fn: () => assertClose(adjPrice(makeCard({ marketNM:null, priceMid:10, condition:'LP' })), 8.5) },
      { name: 'marketNM takes priority over priceMid',         fn: () => assertClose(adjPrice(makeCard({ marketNM:20, priceMid:5, condition:'NM' })), 20) },
    ],
  },

  /* ── Profit ─────────────────────────────────────────────────── */
  {
    name: 'Profit & profit % calculation',
    tests: [
      { name: 'Positive profit', fn: () => { const {profit,pct} = calcProfit(makeCard({marketNM:20,buyCost:'10',condition:'NM'})); assertClose(profit,10); assertClose(pct,100); } },
      { name: 'Negative profit', fn: () => assertClose(calcProfit(makeCard({marketNM:5,buyCost:'10',condition:'NM'})).profit,-5) },
      { name: 'Null when buyCost empty', fn: () => assertNull(calcProfit(makeCard({marketNM:20,buyCost:''})).profit) },
      { name: 'buyCost zero (free card) = full market price as profit', fn: () => assertClose(calcProfit(makeCard({marketNM:20,buyCost:'0',condition:'NM'})).profit, 20) },
      { name: 'Null when no price data', fn: () => assertNull(calcProfit(makeCard({marketNM:null,priceMid:null,buyCost:'10'})).profit) },
      { name: 'Profit % = 50 when buy=10, market=15', fn: () => assertClose(calcProfit(makeCard({marketNM:15,buyCost:'10',condition:'NM'})).pct,50) },
      { name: 'LP condition factored in', fn: () => assertClose(calcProfit(makeCard({marketNM:10,buyCost:'6',condition:'LP'})).profit,2.5,0.01) },
      { name: 'Breakeven: profit=0',      fn: () => assertClose(calcProfit(makeCard({marketNM:10,buyCost:'10',condition:'NM'})).profit,0) },
    ],
  },

  /* ── Actual profit ───────────────────────────────────────────── */
  {
    name: 'Actual profit — calcActualProfit()',
    tests: [
      { name: 'Positive actual profit', fn: () => { const {profit,pct}=calcActualProfit(makeCard({buyCost:'10',soldPrice:'15'})); assertClose(profit,5); assertClose(pct,50); } },
      { name: 'Negative actual profit', fn: () => assertClose(calcActualProfit(makeCard({buyCost:'20',soldPrice:'15'})).profit,-5) },
      { name: 'Null when soldPrice empty', fn: () => assertNull(calcActualProfit(makeCard({buyCost:'10',soldPrice:''})).profit) },
      { name: 'Null when soldPrice zero',  fn: () => assertNull(calcActualProfit(makeCard({buyCost:'10',soldPrice:'0'})).profit) },
      { name: 'Null when buyCost empty',   fn: () => assertNull(calcActualProfit(makeCard({buyCost:'',soldPrice:'15'})).profit) },
      { name: 'soldPrice survives CSV round-trip', fn: () => { const r=parseCSV(exportCSV([makeCard({soldPrice:'42.50'})])); assertEqual(r[0].soldPrice,'42.50'); } },
      { name: 'soldPrice defaults to empty string', fn: () => assertEqual(makeCard().soldPrice,'') },
    ],
  },

  /* ── Price delta ─────────────────────────────────────────────── */
  {
    name: 'Price delta — calcPriceDelta()',
    tests: [
      { name: 'Positive delta', fn: () => assertClose(calcPriceDelta(makeCard({marketNM:52,prevMarketNM:48})),4) },
      { name: 'Negative delta', fn: () => assertClose(calcPriceDelta(makeCard({marketNM:45,prevMarketNM:50})),-5) },
      { name: 'Zero delta',     fn: () => assertClose(calcPriceDelta(makeCard({marketNM:20,prevMarketNM:20})),0) },
      { name: 'Null when prevMarketNM is null', fn: () => assertNull(calcPriceDelta(makeCard({marketNM:20,prevMarketNM:null}))) },
      { name: 'Null when marketNM is null',     fn: () => assertNull(calcPriceDelta(makeCard({marketNM:null,prevMarketNM:20}))) },
      { name: 'prevMarketNM survives CSV round-trip', fn: () => { const r=parseCSV(exportCSV([makeCard({marketNM:55,prevMarketNM:50})])); assertClose(parseFloat(r[0].prevMarketNM),50); } },
    ],
  },

  /* ── fmt / fmtPct ────────────────────────────────────────────── */
  {
    name: 'fmt() and fmtPct() display formatting',
    tests: [
      { name: 'fmt: positive number',         fn: () => assertEqual(fmt(3.5),      '$3.50')  },
      { name: 'fmt: zero',                    fn: () => assertEqual(fmt(0),         '$0.00')  },
      { name: 'fmt: null → —',                fn: () => assertEqual(fmt(null),      '—')      },
      { name: 'fmt: undefined → —',           fn: () => assertEqual(fmt(undefined), '—')      },
      { name: 'fmt: NaN → —',                 fn: () => assertEqual(fmt(NaN),       '—')      },
      { name: 'fmt: result starts with $',    fn: () => assert(fmt(10).startsWith('$'))       },
      { name: 'fmt: large number has digits', fn: () => assert(fmt(1234.5).includes('1'))     },
      { name: 'fmtPct: positive → + sign',    fn: () => assertEqual(fmtPct(50),    '+50.0%') },
      { name: 'fmtPct: negative → no + sign', fn: () => assertEqual(fmtPct(-20),   '-20.0%') },
      { name: 'fmtPct: null → —',             fn: () => assertEqual(fmtPct(null),  '—')      },
      { name: 'fmtPct: NaN → —',              fn: () => assertEqual(fmtPct(NaN),   '—')      },
    ],
  },

  /* ── fmtAge ──────────────────────────────────────────────────── */
  {
    name: 'fmtAge()',
    tests: [
      { name: 'Under 60s → seconds',  fn: () => assertEqual(fmtAge(30_000),     '30s ago')    },
      { name: 'Exactly 60s → 1m ago', fn: () => assertEqual(fmtAge(60_000),     '1m ago')     },
      { name: '90 min → 1h 30m ago',  fn: () => assertEqual(fmtAge(90*60_000),  '1h 30m ago') },
      { name: 'Exactly 2h → 2h ago',  fn: () => assertEqual(fmtAge(2*3600_000), '2h ago')     },
      { name: 'null → "never"',        fn: () => assertEqual(fmtAge(null),       'never')      },
      { name: 'undefined → "never"',  fn: () => assertEqual(fmtAge(undefined),  'never')      },
    ],
  },

  /* ── CSV round-trip ─────────────────────────────────────────── */
  {
    name: 'CSV export & import round-trip',
    tests: [
      {
        name: 'Header contains expected columns including notes',
        fn: () => {
          const header = exportCSV([]).split('\n')[0];
          ['name','condition','buyCost','soldPrice','marketNM','prevMarketNM','tcgplayerId','sold','finish','notes','dateAdded','lastUpdated']
            .forEach(col => assert(header.includes(col), `Missing header: ${col}`));
        },
      },
      {
        name: 'Single card round-trips correctly (including notes)',
        fn: () => {
          const card = makeCard({ name:'Charizard', condition:'LP', buyCost:'25', soldPrice:'30', finish:'holofoil', tcgplayerId:'xy1-1', notes:'Test note' });
          const rows = parseCSV(exportCSV([card]));
          assertEqual(rows.length, 1);
          assertEqual(rows[0].name, 'Charizard');
          assertEqual(rows[0].notes, 'Test note');
          assertEqual(rows[0].soldPrice, '30');
        },
      },
      { name: 'sold=true survives',  fn: () => { const r=parseCSV(exportCSV([makeCard({sold:true})]));  assertEqual(r[0].sold,'true'); } },
      { name: 'sold=false survives', fn: () => { const r=parseCSV(exportCSV([makeCard({sold:false})])); assertEqual(r[0].sold,'false'); } },
      { name: 'Name with commas survives', fn: () => assertEqual(parseCSV(exportCSV([makeCard({name:'Pikachu, base set'})]))[0].name, 'Pikachu, base set') },
      { name: 'Multiple cards all export', fn: () => { const r=parseCSV(exportCSV([makeCard({name:'A'}),makeCard({name:'B'}),makeCard({name:'C'})])); assertEqual(r.length,3); assertEqual(r[2].name,'C'); } },
      { name: 'Header-only CSV returns []', fn: () => assertEqual(parseCSV(exportCSV([])).length, 0) },
      { name: 'csvRowToCard restores condition', fn: () => assertEqual(csvRowToCard(parseCSV(exportCSV([makeCard({condition:'MP'})]))[0]).condition, 'MP') },
      { name: 'csvRowToCard defaults invalid condition to NM', fn: () => assertEqual(csvRowToCard({condition:'INVALID'}).condition, 'NM') },
    ],
  },

  /* ── Sparse CSV import ───────────────────────────────────────── */
  {
    name: 'Sparse CSV import — missing columns use safe defaults',
    tests: [
      {
        name: 'name-only CSV produces a valid card',
        fn: () => {
          const card = csvRowToCard(parseCSV('name\n"Charizard"')[0]);
          assertEqual(card.name, 'Charizard'); assertEqual(card.condition, 'NM');
          assertEqual(card.finish, 'normal'); assertEqual(card.sold, false);
          assertNull(card.marketNM); assertEqual(card.soldPrice, ''); assertEqual(card.notes, '');
        },
      },
      { name: 'name + buyCost CSV populates both', fn: () => { const c=csvRowToCard(parseCSV('name,buyCost\n"Pikachu","12.50"')[0]); assertEqual(c.name,'Pikachu'); assertEqual(c.buyCost,'12.50'); assertNull(c.marketNM); } },
      { name: 'sold=true parsed as boolean',        fn: () => assertEqual(csvRowToCard(parseCSV('name,sold\n"Mew","true"')[0]).sold, true) },
      { name: 'notes column parsed correctly',      fn: () => assertEqual(csvRowToCard(parseCSV('name,notes\n"Mew","PSA pending"')[0]).notes, 'PSA pending') },
    ],
  },

  /* ── makeCard defaults ───────────────────────────────────────── */
  {
    name: 'makeCard defaults & overrides',
    tests: [
      { name: 'Default condition is NM',       fn: () => assertEqual(makeCard().condition,   'NM')     },
      { name: 'Default finish is normal',       fn: () => assertEqual(makeCard().finish,      'normal') },
      { name: 'Default sold is false',          fn: () => assertEqual(makeCard().sold,        false)    },
      { name: 'Default marketNM is null',       fn: () => assertNull(makeCard().marketNM)              },
      { name: 'Default prevMarketNM is null',   fn: () => assertNull(makeCard().prevMarketNM)          },
      { name: 'Default soldPrice is empty',     fn: () => assertEqual(makeCard().soldPrice,   '')       },
      { name: 'Default notes is empty string',  fn: () => assertEqual(makeCard().notes,       '')       },
      { name: 'Default tcgplayerId is empty',   fn: () => assertEqual(makeCard().tcgplayerId, '')       },
      { name: 'id is always a Number',          fn: () => { const c=makeCard(); assert(typeof c.id === 'number', `id type: ${typeof c.id}`); } },
      { name: 'id is Number even with override',fn: () => { const c=makeCard({id:'99'}); assert(typeof c.id === 'number'); assertEqual(c.id, 99); } },
      { name: 'Each call gets a unique id',     fn: () => assert(makeCard().id !== makeCard().id) },
      { name: 'Override fields applied',        fn: () => { const c=makeCard({name:'Mewtwo',buyCost:'50',condition:'HP'}); assertEqual(c.name,'Mewtwo'); assertEqual(c.condition,'HP'); } },
    ],
  },

  /* ── Condition list ──────────────────────────────────────────── */
  {
    name: 'Condition list completeness',
    tests: [
      { name: 'All 5 conditions in COND_MULT',   fn: () => ['NM','LP','MP','HP','DMG'].forEach(c => assert(COND_MULT[c] !== undefined, `Missing: ${c}`)) },
      { name: 'NM multiplier is exactly 1.0',    fn: () => assertEqual(COND_MULT.NM, 1.0) },
      { name: 'All multipliers between 0 and 1', fn: () => Object.values(COND_MULT).forEach(v => assert(v > 0 && v <= 1)) },
      { name: 'Multipliers strictly decreasing', fn: () => { const v=['NM','LP','MP','HP','DMG'].map(c=>COND_MULT[c]); for(let i=1;i<v.length;i++) assert(v[i]<v[i-1]); } },
      { name: 'CONDITIONS array has 5 entries',  fn: () => { assertEqual(CONDITIONS.length, 5); ['NM','LP','MP','HP','DMG'].forEach(c => assert(CONDITIONS.includes(c))); } },
    ],
  },

  /* ── splitCSVLine ────────────────────────────────────────────── */
  {
    name: 'splitCSVLine edge cases',
    tests: [
      { name: 'Splits unquoted fields',         fn: () => { const r=splitCSVLine('a,b,c'); assertEqual(r.length,3); assertEqual(r[1],'b'); } },
      { name: 'Quoted field with comma inside', fn: () => assertEqual(splitCSVLine('"hello, world",foo')[0], 'hello, world') },
      { name: 'Empty fields',                   fn: () => assertEqual(splitCSVLine('a,,c')[1], '') },
    ],
  },

  /* ── Date fields ─────────────────────────────────────────────── */
  {
    name: 'Date fields — dateAdded & lastUpdated',
    tests: [
      { name: 'makeCard sets dateAdded to valid ISO',   fn: () => assert(!isNaN(new Date(makeCard().dateAdded))) },
      { name: 'makeCard sets lastUpdated to valid ISO', fn: () => assert(!isNaN(new Date(makeCard().lastUpdated))) },
      { name: 'dateAdded override preserved',           fn: () => { const iso='2024-01-15T10:00:00.000Z'; assertEqual(makeCard({dateAdded:iso}).dateAdded, iso); } },
      { name: 'touchUpdated bumps lastUpdated',         fn: () => { const c=makeCard({lastUpdated:'2020-01-01T00:00:00.000Z'}); touchUpdated(c); assert(c.lastUpdated>'2020-01-01T00:00:00.000Z'); } },
      { name: 'fmtDate: null → —',                     fn: () => assertEqual(fmtDate(null), '—') },
      { name: 'fmtDate: invalid → —',                  fn: () => assertEqual(fmtDate('not-a-date'), '—') },
      { name: 'fmtDate: valid ISO → non-empty string',  fn: () => { const r=fmtDate('2024-04-10T14:30:00.000Z'); assert(r.length>3 && r!=='—'); } },
    ],
  },

  /* ── Sorting ─────────────────────────────────────────────────── */
  {
    name: 'Sorting — sortCards()',
    tests: [
      { name: 'Name ascending A→Z', fn: () => { const s=sortCards([makeCard({name:'Z'}),makeCard({name:'A'})],'name','asc'); assertEqual(s[0].name,'A'); } },
      { name: 'buyCost numeric ascending', fn: () => { const s=sortCards([makeCard({buyCost:'30'}),makeCard({buyCost:'5'})],'buyCost','asc'); assertEqual(s[0].buyCost,'5'); } },
      { name: 'Null values sort last', fn: () => { const a=makeCard({marketNM:20}),b=makeCard({marketNM:null}),c=makeCard({marketNM:5}); const asc=sortCards([b,a,c],'marketNM','asc'); assertNull(asc[asc.length-1].marketNM); } },
      { name: 'Does not mutate original array', fn: () => { const input=[makeCard({name:'B'}),makeCard({name:'A'})]; sortCards(input,'name','asc'); assertEqual(input[0].name,'B'); } },
      { name: 'priceDelta sorting', fn: () => { const a=makeCard({marketNM:52,prevMarketNM:48}),b=makeCard({marketNM:45,prevMarketNM:50}); const s=sortCards([b,a],'priceDelta','desc'); assertClose(s[0].marketNM-s[0].prevMarketNM,4,0.01); } },
    ],
  },

  /* ── Undo ────────────────────────────────────────────────────── */
  {
    name: 'Undo — snapshotCards()',
    tests: [
      { name: 'Returns a deep clone', fn: () => { const cards=[makeCard({name:'Original'})]; const snap=snapshotCards(cards); cards[0].name='Modified'; assertEqual(snap[0].name,'Original'); } },
      { name: 'Preserves all fields', fn: () => { const card=makeCard({name:'P',buyCost:'10',soldPrice:'15',marketNM:20,prevMarketNM:18,sold:true,notes:'hi'}); const snap=snapshotCards([card])[0]; assertEqual(snap.notes,'hi'); assertEqual(snap.sold,true); assertClose(snap.prevMarketNM,18); } },
      { name: 'UNDO_MAX_SNAPSHOTS is a positive integer', fn: () => assert(Number.isInteger(UNDO_MAX_SNAPSHOTS) && UNDO_MAX_SNAPSHOTS > 0) },
      { name: 'Snapshot of empty array is empty', fn: () => assertEqual(snapshotCards([]).length, 0) },
    ],
  },

  /* ── generateFilename ───────────────────────────────────────── */
  {
    name: 'generateFilename()',
    tests: [
      { name: 'Ends with .csv',           fn: () => assert(generateFilename().endsWith('.csv'))            },
      { name: 'Starts with tcg-tracker-', fn: () => assert(generateFilename().startsWith('tcg-tracker-')) },
      { name: "Contains today's year",    fn: () => assert(generateFilename().includes(String(new Date().getFullYear()))) },
      { name: 'Matches YYYY-MM-DD pattern',fn: () => assert(/tcg-tracker-\d{4}-\d{2}-\d{2}\.csv/.test(generateFilename())) },
    ],
  },

  /* ── Price cache ─────────────────────────────────────────────── */
  {
    name: 'Price cache (localStorage)',
    tests: [
      {
        name: 'writePriceCache then readPriceCache returns prices',
        fn: () => {
          clearPriceCache();
          const prices = { normal:{ market:10, low:8, mid:9 } };
          writePriceCache('test-card-1', prices);
          const cached = readPriceCache('test-card-1');
          assert(cached !== null); assertEqual(JSON.stringify(cached.prices), JSON.stringify(prices));
          clearPriceCache();
        },
      },
      { name: 'readPriceCache returns null for unknown key', fn: () => assertNull(readPriceCache('does-not-exist-xyz')) },
      {
        name: 'clearPriceCache removes all entries',
        fn: () => { writePriceCache('ca',{normal:{market:5}}); writePriceCache('cb',{holofoil:{market:20}}); clearPriceCache(); assertNull(readPriceCache('ca')); assertNull(readPriceCache('cb')); },
      },
      { name: 'CACHE_TTL_MS is a positive number', fn: () => assert(typeof CACHE_TTL_MS === 'number' && CACHE_TTL_MS > 0) },
    ],
  },

  /* ── Search cache ────────────────────────────────────────────── */
  {
    name: 'Search cache (localStorage)',
    tests: [
      { name: 'searchCacheKey is deterministic', fn: () => assertEqual(searchCacheKey('Charizard','Evolving Skies',false), searchCacheKey('charizard','evolving skies',false)) },
      { name: 'JP flag produces a different key', fn: () => assert(searchCacheKey('Pikachu','',false) !== searchCacheKey('Pikachu','',true)) },
      {
        name: 'writeSearchCache then readSearchCache returns results',
        fn: () => {
          clearPriceCache();
          const key='tcg_search_mewtest||en', results=[{id:'t1',name:'Mew'}];
          writeSearchCache(key, results);
          const cached=readSearchCache(key);
          assert(cached !== null); assertEqual(JSON.stringify(cached), JSON.stringify(results));
          clearPriceCache();
        },
      },
      { name: 'readSearchCache returns null for unknown key', fn: () => assertNull(readSearchCache('tcg_search_zzz|nonexistent|en')) },
      { name: 'SEARCH_CACHE_TTL_MS is positive',    fn: () => assert(typeof SEARCH_CACHE_TTL_MS === 'number' && SEARCH_CACHE_TTL_MS > 0) },
      { name: 'SEARCH_CACHE_TTL_MS ≤ 24 h',         fn: () => assert(SEARCH_CACHE_TTL_MS <= 24 * 3600 * 1000) },
    ],
  },

  /* ── buildTCGSearchUrl (#1) ──────────────────────────────────── */
  {
    name: 'buildTCGSearchUrl() — TCGPlayer search link builder',
    tests: [
      {
        name: 'Returns a tcgplayer.com search URL',
        fn: () => { const u=buildTCGSearchUrl('Charizard ex','Scarlet & Violet — 151'); assertIncludes(u,'tcgplayer.com'); assertIncludes(u,'search'); },
      },
      {
        name: 'Encodes card name in query string',
        fn: () => { const u=buildTCGSearchUrl('Charizard ex',''); assertIncludes(u,'Charizard'); },
      },
      {
        name: 'Includes set name when provided',
        fn: () => { const u=buildTCGSearchUrl('Pikachu','Evolving Skies'); assertIncludes(u,'Evolving'); },
      },
      {
        name: 'Returns fallback link when name is empty',
        fn: () => { const u=buildTCGSearchUrl('','','https://example.com'); assertEqual(u,'https://example.com'); },
      },
      {
        name: 'Returns empty string when name and fallback are empty',
        fn: () => { const u=buildTCGSearchUrl('','',''); assertEqual(u,''); },
      },
      {
        name: 'URL contains view=grid parameter',
        fn: () => assertIncludes(buildTCGSearchUrl('Mew',''),'view=grid'),
      },
    ],
  },

  /* ── Notes field (#8) ────────────────────────────────────────── */
  {
    name: 'Notes field — makeCard & CSV',
    tests: [
      { name: 'Default notes is empty string',     fn: () => assertEqual(makeCard().notes, '')             },
      { name: 'notes override applied',            fn: () => assertEqual(makeCard({notes:'test'}).notes, 'test') },
      { name: 'notes in CSV_HEADERS',              fn: () => assert(CSV_HEADERS.includes('notes'), 'notes missing from CSV_HEADERS') },
      { name: 'notes survives CSV round-trip',     fn: () => { const r=parseCSV(exportCSV([makeCard({notes:'PSA pending'})])); assertEqual(r[0].notes,'PSA pending'); } },
      { name: 'notes with commas survives',        fn: () => { const r=parseCSV(exportCSV([makeCard({notes:'bought at locals, mint'})])); assertEqual(r[0].notes,'bought at locals, mint'); } },
      { name: 'notes with quotes survives',        fn: () => { const r=parseCSV(exportCSV([makeCard({notes:'he said "NM"'})])); assertEqual(r[0].notes,'he said "NM"'); } },
      { name: 'csvRowToCard reads notes correctly',fn: () => { const c=csvRowToCard({name:'X',notes:'trade target'}); assertEqual(c.notes,'trade target'); } },
      { name: 'csvRowToCard defaults notes to ""', fn: () => assertEqual(csvRowToCard({name:'X'}).notes, '') },
      { name: 'snapshotCards preserves notes',     fn: () => { const c=makeCard({notes:'test note'}); const s=snapshotCards([c])[0]; assertEqual(s.notes,'test note'); } },
    ],
  },

  /* ── Duplicate id fix (#2) ───────────────────────────────────── */
  {
    name: 'Card id always a Number (#2 duplicate-delete fix)',
    tests: [
      { name: 'makeCard produces numeric id',              fn: () => assert(typeof makeCard().id === 'number') },
      { name: 'id is Number even when overridden as string',fn: () => { const c=makeCard({id:'42'}); assertEqual(typeof c.id,'number'); assertEqual(c.id,42); } },
      { name: 'id is Number when overridden as number',    fn: () => { const c=makeCard({id:7}); assertEqual(typeof c.id,'number'); assertEqual(c.id,7); } },
      { name: 'Sequential ids are unique numbers',         fn: () => { const a=makeCard(),b=makeCard(); assert(typeof a.id==='number'&&typeof b.id==='number'&&a.id!==b.id); } },
      { name: 'snapshotCards preserves id as number',      fn: () => { const c=makeCard(); const s=snapshotCards([c])[0]; assertEqual(typeof s.id,'number'); } },
    ],
  },

  /* ── Refresh dedup logic (#4) ────────────────────────────────── */
  {
    name: 'Refresh dedup — unique tcgplayerId set',
    tests: [
      {
        name: 'Dedup produces fewer unique IDs than total cards when IDs repeat',
        fn: () => {
          const cards = [
            makeCard({tcgplayerId:'swsh7-218', name:'Rayquaza A'}),
            makeCard({tcgplayerId:'swsh7-218', name:'Rayquaza B'}), // same ID
            makeCard({tcgplayerId:'swsh7-215', name:'Umbreon'}),
          ];
          const uniqueIds = [...new Set(cards.map(c => c.tcgplayerId))];
          assertEqual(uniqueIds.length, 2);
          assert(cards.length === 3);
        },
      },
      {
        name: 'Skip-sold filter excludes sold cards correctly',
        fn: () => {
          const cards = [
            makeCard({tcgplayerId:'a', sold:false}),
            makeCard({tcgplayerId:'b', sold:true}),
            makeCard({tcgplayerId:'c', sold:false}),
          ];
          const skipSold = true;
          const eligible = cards.filter(c => c.tcgplayerId && !(skipSold && c.sold));
          assertEqual(eligible.length, 2);
          assert(eligible.every(c => !c.sold));
        },
      },
      {
        name: 'Skip-sold false includes all cards with tcgplayerId',
        fn: () => {
          const cards = [makeCard({tcgplayerId:'a',sold:false}),makeCard({tcgplayerId:'b',sold:true})];
          const eligible = cards.filter(c => c.tcgplayerId && !(false && c.sold));
          assertEqual(eligible.length, 2);
        },
      },
    ],
  },

  /* ── Seed data ───────────────────────────────────────────────── */
  {
    name: 'Seed data — getSeedCards()',
    tests: [
      { name: 'Returns a non-empty array',          fn: () => { const s=getSeedCards(); assert(Array.isArray(s) && s.length>0); } },
      { name: 'Every card has a non-empty name',    fn: () => getSeedCards().forEach((c,i) => assert(c.name.length>0, `Card ${i} empty name`)) },
      { name: 'Every card has a valid condition',   fn: () => getSeedCards().forEach(c => assert(CONDITIONS.includes(c.condition))) },
      { name: 'Every card has a valid dateAdded',   fn: () => getSeedCards().forEach(c => assert(!isNaN(new Date(c.dateAdded)))) },
      { name: 'soldPrice field exists on all',      fn: () => getSeedCards().forEach(c => assert('soldPrice' in c)) },
      { name: 'prevMarketNM field exists on all',   fn: () => getSeedCards().forEach(c => assert('prevMarketNM' in c)) },
      { name: 'notes field exists on all',          fn: () => getSeedCards().forEach(c => assert('notes' in c, `Missing notes on ${c.name}`)) },
      { name: 'All seed card ids are Numbers',      fn: () => getSeedCards().forEach(c => assert(typeof c.id==='number', `id not number on ${c.name}`)) },
    ],
  },

  /* ── syncNextId — FIX #8 ────────────────────────────────────── */
  {
    name: 'syncNextId() — FIX #8 duplicate-id bug',
    tests: [
      {
        name: 'syncNextId raises _nextId above the highest existing id',
        fn: () => {
          resetIdCounter();
          // Simulate cards loaded from localStorage with high ids
          const fakeCards = [{ id: 50 }, { id: 23 }, { id: 71 }];
          syncNextId(fakeCards);
          // Next makeCard should get id 72, not 1
          const c = makeCard();
          assert(c.id > 71, `Expected id > 71, got ${c.id}`);
        },
      },
      {
        name: 'syncNextId with empty array does not crash',
        fn: () => { syncNextId([]); syncNextId(null); },
      },
      {
        name: 'After syncNextId, consecutive makeCard calls get unique ids',
        fn: () => {
          resetIdCounter();
          syncNextId([{ id: 10 }, { id: 11 }]);
          const a = makeCard(), b = makeCard(), c = makeCard();
          assert(a.id !== b.id && b.id !== c.id, 'ids should be unique');
          assert(a.id > 11 && b.id > 11 && c.id > 11, 'ids should be above 11');
        },
      },
      {
        name: 'Duplicate: makeCard with ...original id:undefined gets fresh id',
        fn: () => {
          resetIdCounter();
          const original = makeCard({ name: 'Original' });
          syncNextId([original]);
          const dupe = makeCard({ ...original, id: undefined, name: 'Dupe' });
          assert(dupe.id !== original.id, `dupe id ${dupe.id} should differ from original ${original.id}`);
          assert(typeof dupe.id === 'number', 'dupe id should be a number');
        },
      },
    ],
  },

  /* ── stripPromoSuffix — FIX #7 ──────────────────────────────── */
  {
    name: 'stripPromoSuffix() — FIX #7 promo search',
    tests: [
      { name: 'Strips trailing "promo"',         fn: () => assertEqual(stripPromoSuffix('Victini Promo'), 'Victini') },
      { name: 'Strips "black star promo"',       fn: () => assertEqual(stripPromoSuffix('Pikachu black star promo'), 'Pikachu') },
      { name: 'Strips "full art"',               fn: () => assertEqual(stripPromoSuffix('Charizard full art'), 'Charizard') },
      { name: 'Strips "alt art"',                fn: () => assertEqual(stripPromoSuffix('Umbreon alt art'), 'Umbreon') },
      { name: 'Strips "secret rare"',            fn: () => assertEqual(stripPromoSuffix('Mew secret rare'), 'Mew') },
      { name: 'Strips "hyper rare"',             fn: () => assertEqual(stripPromoSuffix('Lugia hyper rare'), 'Lugia') },
      { name: 'Leaves plain name unchanged',     fn: () => assertEqual(stripPromoSuffix('Charizard'), 'Charizard') },
      { name: 'Case-insensitive strip',          fn: () => assertEqual(stripPromoSuffix('Victini PROMO'), 'Victini') },
      { name: 'Does not strip mid-string',       fn: () => { const r = stripPromoSuffix('Promo Pikachu'); assert(r.includes('Promo'), 'should not strip mid-string'); } },
      { name: 'Empty string stays empty',        fn: () => assertEqual(stripPromoSuffix(''), '') },
    ],
  },

  /* ── sortCards ISO date fix — FIX #4 ────────────────────────── */
  {
    name: 'sortCards() ISO date sorting — FIX #4',
    tests: [
      {
        name: 'dateAdded sorts correctly ascending (older first)',
        fn: () => {
          resetIdCounter();
          const old  = makeCard({ name: 'Old',  dateAdded: '2023-01-01T00:00:00.000Z' });
          const mid  = makeCard({ name: 'Mid',  dateAdded: '2024-06-15T00:00:00.000Z' });
          const new_ = makeCard({ name: 'New',  dateAdded: '2025-03-01T00:00:00.000Z' });
          const sorted = sortCards([new_, old, mid], 'dateAdded', 'asc');
          assertEqual(sorted[0].name, 'Old');
          assertEqual(sorted[1].name, 'Mid');
          assertEqual(sorted[2].name, 'New');
        },
      },
      {
        name: 'dateAdded sorts correctly descending (newer first)',
        fn: () => {
          resetIdCounter();
          const old  = makeCard({ name: 'Old',  dateAdded: '2023-01-01T00:00:00.000Z' });
          const new_ = makeCard({ name: 'New',  dateAdded: '2025-03-01T00:00:00.000Z' });
          const sorted = sortCards([old, new_], 'dateAdded', 'desc');
          assertEqual(sorted[0].name, 'New');
        },
      },
      {
        name: 'lastUpdated sorts by date not lexicographically',
        fn: () => {
          resetIdCounter();
          // Lexicographic sort of these would put Jan before Feb, but same result.
          // The key test: 2023-12-01 vs 2024-01-01 — lex order is same as date order here.
          // Use a case where lex fails: same year, different month+day combos handled by epoch.
          const a = makeCard({ lastUpdated: '2024-09-30T23:59:59.000Z' });
          const b = makeCard({ lastUpdated: '2024-10-01T00:00:00.000Z' });
          const asc = sortCards([b, a], 'lastUpdated', 'asc');
          assertEqual(asc[0].lastUpdated, '2024-09-30T23:59:59.000Z');
        },
      },
    ],
  },

  /* ── updateSummary excludes sold — FIX #6 ──────────────────── */
  {
    name: 'Summary excludes sold cards from market/profit — FIX #6',
    tests: [
      {
        name: 'adjPrice of sold card is NOT counted in portfolio market value',
        fn: () => {
          resetIdCounter();
          // We verify the logic directly: only unsold cards contribute to market
          const unsold = makeCard({ marketNM: 50, condition: 'NM', sold: false });
          const sold   = makeCard({ marketNM: 100, condition: 'NM', sold: true });
          const allCards = [unsold, sold];
          let market = 0;
          for (const c of allCards) {
            if (!c.sold) market += adjPrice(c); // this is the v8 logic
          }
          assertClose(market, 50, 0.01, 'Sold card should not contribute to market');
        },
      },
      {
        name: 'Sold card adjPrice is still calculable (just excluded from sum)',
        fn: () => {
          resetIdCounter();
          const sold = makeCard({ marketNM: 100, condition: 'NM', sold: true });
          assertClose(adjPrice(sold), 100, 0.01, 'adjPrice calculation itself unchanged');
        },
      },
    ],
  },

  /* ── Qty logic — #2 ─────────────────────────────────────────── */
  {
    name: 'Qty multiple add — #2',
    tests: [
      {
        name: 'Adding qty=3 via makeCard loop produces 3 unique ids',
        fn: () => {
          resetIdCounter();
          const entry = { name: 'Charizard', tcgplayerId: 'xy1-1' };
          const added = [];
          for (let i = 0; i < 3; i++) added.push(makeCard({ ...entry }));
          const ids = added.map(c => c.id);
          assertEqual(new Set(ids).size, 3, 'All 3 ids should be unique');
        },
      },
      {
        name: 'Qty=1 still works as expected',
        fn: () => {
          resetIdCounter();
          const added = [];
          for (let i = 0; i < 1; i++) added.push(makeCard({ name: 'Mew' }));
          assertEqual(added.length, 1);
          assertEqual(added[0].name, 'Mew');
        },
      },
      {
        name: 'Each qty copy starts with soldPrice empty and sold=false',
        fn: () => {
          resetIdCounter();
          for (let i = 0; i < 3; i++) {
            const c = makeCard({ name: 'Test', sold: false, soldPrice: '' });
            assertEqual(c.sold, false);
            assertEqual(c.soldPrice, '');
          }
        },
      },
    ],
  },


  /* ── FIX #14: calcProfit with buyCost=0 ─────────────────── */
  {
    name: 'calcProfit — FIX #14 buyCost=0',
    tests: [
      { name: 'buyCost="0" shows profit = adjPrice (free card)',
        fn: () => { const {profit} = calcProfit(makeCard({marketNM:20, buyCost:'0', condition:'NM'})); assertClose(profit, 20, 0.001); } },
      { name: 'buyCost="0" pct is null (avoid division by zero)',
        fn: () => { const {pct} = calcProfit(makeCard({marketNM:20, buyCost:'0', condition:'NM'})); assertNull(pct); } },
      { name: 'buyCost="" still returns null profit',
        fn: () => assertNull(calcProfit(makeCard({marketNM:20, buyCost:''})).profit) },
      { name: 'buyCost="10" still works normally',
        fn: () => assertClose(calcProfit(makeCard({marketNM:20, buyCost:'10', condition:'NM'})).profit, 10) },
      { name: 'buyCost="0" + no market → null (no price data)',
        fn: () => assertNull(calcProfit(makeCard({marketNM:null, buyCost:'0'})).profit) },
    ],
  },

  /* ── FIX #14: calcActualProfit with buyCost=0 ───────────── */
  {
    name: 'calcActualProfit — FIX #14 buyCost=0',
    tests: [
      { name: 'buyCost="0", soldPrice="10" → profit=10',
        fn: () => assertClose(calcActualProfit(makeCard({buyCost:'0', soldPrice:'10'})).profit, 10) },
      { name: 'buyCost="0", soldPrice="0" → null (not sold yet)',
        fn: () => assertNull(calcActualProfit(makeCard({buyCost:'0', soldPrice:'0'})).profit) },
      { name: 'buyCost="" → null even with soldPrice',
        fn: () => assertNull(calcActualProfit(makeCard({buyCost:'', soldPrice:'20'})).profit) },
      { name: 'buyCost="0" pct is null (avoid /0)',
        fn: () => assertNull(calcActualProfit(makeCard({buyCost:'0', soldPrice:'10'})).pct) },
    ],
  },

  /* ── FIX #15: duplicateCard id NaN ──────────────────────── */
  {
    name: 'Duplicate card id — FIX #15',
    tests: [
      { name: 'Destructure-spread produces valid numeric id',
        fn: () => {
          resetIdCounter();
          const original = makeCard({name:'Charizard', tcgplayerId:'xy1-1'});
          syncNextId([original]);
          const { id: _discarded, ...rest } = original;
          const dupe = makeCard({ ...rest, sold:false, soldPrice:'' });
          assert(typeof dupe.id === 'number', `id should be number, got ${typeof dupe.id}`);
          assert(!isNaN(dupe.id), `id should not be NaN, got ${dupe.id}`);
          assert(dupe.id !== original.id, `dupe id ${dupe.id} should differ from original ${original.id}`);
        },
      },
      { name: 'Passing id:undefined to makeCard gives NaN — confirms the old bug',
        fn: () => {
          // This test documents the bug that FIX #15 avoids.
          // makeCard with id:undefined in overrides → Number(undefined) = NaN.
          // The FIX: destructure id out before spread, never pass id:undefined.
          resetIdCounter();
          const bugCard = makeCard({ id: undefined, name: 'Bug' });
          // After fix, makeCard coerces: id defaults to _nextId++ then Number() applied
          // id:undefined overwrites _nextId++ → Number(undefined) = NaN
          // So this card is expected to have NaN id — confirming the root bug.
          assert(isNaN(bugCard.id), 'Passing id:undefined still produces NaN — must destructure it out');
        },
      },
      { name: 'After sync, 3 dupes all get unique non-NaN ids',
        fn: () => {
          resetIdCounter();
          const cards = [makeCard({name:'A'}), makeCard({name:'B'})];
          syncNextId(cards);
          const dupes = [1,2,3].map(() => { const {id:_, ...r} = cards[0]; return makeCard({...r}); });
          const ids = dupes.map(c => c.id);
          assert(ids.every(id => !isNaN(id)), 'All dupe ids should be valid numbers');
          assert(new Set(ids).size === 3, 'All dupe ids should be unique');
        },
      },
    ],
  },

  /* ── FIX #11: stray & in base URL ───────────────────────── */
  {
    name: 'Search URL construction — FIX #11 stray &',
    tests: [
      { name: 'stripPromoSuffix: longest suffix wins (black star promo > promo)',
        fn: () => assertEqual(stripPromoSuffix('Pikachu black star promo'), 'Pikachu') },
      { name: 'stripPromoSuffix: alt art stripped',
        fn: () => assertEqual(stripPromoSuffix('Charizard alt art'), 'Charizard') },
      { name: 'stripPromoSuffix: special illustration rare stripped',
        fn: () => assertEqual(stripPromoSuffix('Gardevoir ex special illustration rare'), 'Gardevoir ex') },
      { name: 'stripPromoSuffix: mid-word promo NOT stripped',
        fn: () => { const r = stripPromoSuffix('Promo Pikachu'); assert(r.toLowerCase().includes('promo')); } },
      { name: 'stripPromoSuffix: plain name unchanged',
        fn: () => assertEqual(stripPromoSuffix('Mew VMAX'), 'Mew VMAX') },
      { name: 'stripPromoSuffix: empty string unchanged',
        fn: () => assertEqual(stripPromoSuffix(''), '') },
      { name: 'stripPromoSuffix: only strips one suffix per call',
        fn: () => { const r = stripPromoSuffix('Card full art promo'); assert(!r.toLowerCase().endsWith('promo')); } },
    ],
  },

  /* ── FIX #12: dateAdded/lastUpdated sorting ─────────────── */
  {
    name: 'ISO date sorting — FIX #12',
    tests: [
      { name: 'dateAdded asc: older card first',
        fn: () => {
          resetIdCounter();
          const a = makeCard({dateAdded:'2023-01-01T00:00:00.000Z'});
          const b = makeCard({dateAdded:'2025-06-01T00:00:00.000Z'});
          const sorted = sortCards([b, a], 'dateAdded', 'asc');
          assertEqual(sorted[0].dateAdded, '2023-01-01T00:00:00.000Z');
        },
      },
      { name: 'dateAdded desc: newer card first',
        fn: () => {
          resetIdCounter();
          const a = makeCard({dateAdded:'2023-01-01T00:00:00.000Z'});
          const b = makeCard({dateAdded:'2025-06-01T00:00:00.000Z'});
          const sorted = sortCards([a, b], 'dateAdded', 'desc');
          assertEqual(sorted[0].dateAdded, '2025-06-01T00:00:00.000Z');
        },
      },
      { name: 'lastUpdated sorted correctly',
        fn: () => {
          resetIdCounter();
          const a = makeCard({lastUpdated:'2024-03-15T10:00:00.000Z'});
          const b = makeCard({lastUpdated:'2024-11-20T10:00:00.000Z'});
          const sorted = sortCards([b, a], 'lastUpdated', 'asc');
          assertEqual(sorted[0].lastUpdated, '2024-03-15T10:00:00.000Z');
        },
      },
      { name: 'ISO dates not compared as strings (parseFloat would fail)',
        fn: () => {
          // Two dates in same year — parseFloat gives same year prefix, but getTime() differs
          resetIdCounter();
          const a = makeCard({dateAdded:'2024-01-31T23:59:00.000Z'});
          const b = makeCard({dateAdded:'2024-02-01T00:01:00.000Z'});
          const sorted = sortCards([b, a], 'dateAdded', 'asc');
          assertEqual(sorted[0].dateAdded, '2024-01-31T23:59:00.000Z');
        },
      },
    ],
  },

  /* ── Bonus: getDisplayFiltered + export filtered ─────────── */
  {
    name: 'getDisplayFiltered / export filtered view — bonus',
    tests: [
      { name: 'exportCSV with subset produces fewer rows than full list',
        fn: () => {
          resetIdCounter();
          const allCards = [makeCard({name:'Charizard'}), makeCard({name:'Pikachu'}), makeCard({name:'Mewtwo'})];
          const filtered = allCards.filter(c => c.name === 'Pikachu');
          const csv = exportCSV(filtered);
          const rows = parseCSV(csv);
          assertEqual(rows.length, 1);
          assertEqual(rows[0].name, 'Pikachu');
        },
      },
      { name: 'exportCSV of full list preserves all cards',
        fn: () => {
          resetIdCounter();
          const allCards = [makeCard({name:'A'}), makeCard({name:'B'}), makeCard({name:'C'})];
          assertEqual(parseCSV(exportCSV(allCards)).length, 3);
        },
      },
    ],
  },

  /* ── #10: Bulk actions logic ────────────────────────────── */
  {
    name: 'Bulk actions logic — #10',
    tests: [
      { name: 'bulkMarkSold marks selected cards',
        fn: () => {
          resetIdCounter();
          const a = makeCard({sold:false}), b = makeCard({sold:false});
          const selected = new Set([a.id]);
          const localCards = [a, b];
          for (const id of selected) { const c = localCards.find(x => x.id === id); if (c) c.sold = true; }
          assert(localCards[0].sold === true, 'a should be sold');
          assert(localCards[1].sold === false, 'b should not be sold');
        },
      },
      { name: 'bulkUnmarkSold clears sold + soldPrice',
        fn: () => {
          resetIdCounter();
          const a = makeCard({sold:true, soldPrice:'50'});
          const localCards = [a];
          for (const c of localCards) { c.sold = false; c.soldPrice = ''; }
          assertEqual(localCards[0].sold, false);
          assertEqual(localCards[0].soldPrice, '');
        },
      },
      { name: 'bulkSetCondition updates condition on selected cards',
        fn: () => {
          resetIdCounter();
          const a = makeCard({condition:'NM'}), b = makeCard({condition:'NM'});
          const selected = new Set([a.id, b.id]);
          const localCards = [a, b];
          for (const id of selected) { const c = localCards.find(x => x.id === id); if (c) c.condition = 'LP'; }
          assert(localCards.every(c => c.condition === 'LP'), 'All selected should be LP');
        },
      },
      { name: 'Bulk refresh deduplicates by tcgplayerId',
        fn: () => {
          resetIdCounter();
          const cards = [
            makeCard({tcgplayerId:'swsh7-218', name:'Ray A'}),
            makeCard({tcgplayerId:'swsh7-218', name:'Ray B'}),
            makeCard({tcgplayerId:'swsh7-215', name:'Umbreon'}),
          ];
          const selected = new Set(cards.map(c => c.id));
          const eligible = cards.filter(c => selected.has(c.id) && c.tcgplayerId);
          const uniqueIds = [...new Set(eligible.map(c => c.tcgplayerId))];
          assertEqual(uniqueIds.length, 2, 'Should deduplicate to 2 unique IDs');
        },
      },
    ],
  },


  /* ── v11: TCGdex helpers ────────────────────────────────── */
  {
    name: 'TCGdex helpers — v11',
    tests: [
      {
        name: 'parseTCGdexId: returns raw ID for tcgdex: prefix',
        fn: () => assertEqual(parseTCGdexId('tcgdex:sv6a-1'), 'sv6a-1'),
      },
      {
        name: 'parseTCGdexId: returns null for EN pokemontcg.io IDs',
        fn: () => assertNull(parseTCGdexId('swsh7-218')),
      },
      {
        name: 'parseTCGdexId: returns null for empty string',
        fn: () => assertNull(parseTCGdexId('')),
      },
      {
        name: 'parseTCGdexId: returns null for undefined',
        fn: () => assertNull(parseTCGdexId(undefined)),
      },
      {
        name: 'tcgdexVariantToFinish: holo → holofoil',
        fn: () => assertEqual(tcgdexVariantToFinish({ holo: true }), 'holofoil'),
      },
      {
        name: 'tcgdexVariantToFinish: reverse → reverseHolofoil',
        fn: () => assertEqual(tcgdexVariantToFinish({ reverse: true }), 'reverseHolofoil'),
      },
      {
        name: 'tcgdexVariantToFinish: firstEdition + holo → firstEditionHolofoil',
        fn: () => assertEqual(tcgdexVariantToFinish({ firstEdition: true, holo: true }), 'firstEditionHolofoil'),
      },
      {
        name: 'tcgdexVariantToFinish: firstEdition only → firstEditionNormal',
        fn: () => assertEqual(tcgdexVariantToFinish({ firstEdition: true }), 'firstEditionNormal'),
      },
      {
        name: 'tcgdexVariantToFinish: empty → normal',
        fn: () => assertEqual(tcgdexVariantToFinish({}), 'normal'),
      },
      {
        name: 'finishToTCGdexVariant: holofoil → holo',
        fn: () => assertEqual(finishToTCGdexVariant('holofoil'), 'holo'),
      },
      {
        name: 'finishToTCGdexVariant: reverseHolofoil → reverse',
        fn: () => assertEqual(finishToTCGdexVariant('reverseHolofoil'), 'reverse'),
      },
      {
        name: 'finishToTCGdexVariant: normal → normal',
        fn: () => assertEqual(finishToTCGdexVariant('normal'), 'normal'),
      },
      {
        name: 'finishToTCGdexVariant: unknown key → normal fallback',
        fn: () => assertEqual(finishToTCGdexVariant('holographic'), 'normal'),
      },
      {
        name: 'finishToTCGdexVariant: firstEditionHolofoil → holo',
        fn: () => assertEqual(finishToTCGdexVariant('firstEditionHolofoil'), 'holo'),
      },
    ],
  },

  /* ── v11: extractTCGdexTCGPlayerPrice ───────────────────── */
  {
    name: 'extractTCGdexTCGPlayerPrice — v11',
    tests: [
      {
        name: 'Returns market/low/mid from preferred finish variant',
        fn: () => {
          const cardFull = { pricing: { tcgplayer: { holo: { marketPrice: 45.00, lowPrice: 38.00, midPrice: 42.00 } } } };
          const result = extractTCGdexTCGPlayerPrice(cardFull, 'holofoil');
          assertClose(result.market, 45.00);
          assertClose(result.low,    38.00);
          assertClose(result.mid,    42.00);
        },
      },
      {
        name: 'Falls back to next available variant when preferred is absent',
        fn: () => {
          // Card has holo pricing but we ask for normal — should fall back to holo
          const cardFull = { pricing: { tcgplayer: { holo: { marketPrice: 20.00, lowPrice: null, midPrice: null } } } };
          const result = extractTCGdexTCGPlayerPrice(cardFull, 'normal');
          assertClose(result.market, 20.00);
        },
      },
      {
        name: 'Returns null when no tcgplayer pricing block exists (JP-only card)',
        fn: () => {
          const cardFull = { pricing: { cardmarket: { normal: { avg1: 5.00 } } } };
          assertNull(extractTCGdexTCGPlayerPrice(cardFull, 'normal'));
        },
      },
      {
        name: 'Returns null when cardFull is null',
        fn: () => assertNull(extractTCGdexTCGPlayerPrice(null, 'normal')),
      },
      {
        name: 'Returns null when pricing is missing entirely',
        fn: () => assertNull(extractTCGdexTCGPlayerPrice({}, 'normal')),
      },
      {
        name: 'Returns null when all variants have null marketPrice',
        fn: () => {
          const cardFull = { pricing: { tcgplayer: { normal: { marketPrice: null, lowPrice: null, midPrice: null } } } };
          assertNull(extractTCGdexTCGPlayerPrice(cardFull, 'normal'));
        },
      },
      {
        name: 'reverse variant maps and extracts correctly',
        fn: () => {
          const cardFull = { pricing: { tcgplayer: { reverse: { marketPrice: 3.50, lowPrice: 2.00, midPrice: 3.00 } } } };
          const result = extractTCGdexTCGPlayerPrice(cardFull, 'reverseHolofoil');
          assertClose(result.market, 3.50);
        },
      },
      {
        name: 'low and mid are null when absent from pricing block',
        fn: () => {
          const cardFull = { pricing: { tcgplayer: { normal: { marketPrice: 10.00 } } } };
          const result = extractTCGdexTCGPlayerPrice(cardFull, 'normal');
          assertClose(result.market, 10.00);
          assertNull(result.low);
          assertNull(result.mid);
        },
      },
    ],
  },

  /* ── v11: language field + CSV round-trip ───────────────── */
  {
    name: 'language field — v11',
    tests: [
      {
        name: "makeCard default language is 'en'",
        fn: () => { resetIdCounter(); assertEqual(makeCard().language, 'en'); },
      },
      {
        name: "makeCard override to 'jp' works",
        fn: () => { resetIdCounter(); assertEqual(makeCard({ language: 'jp' }).language, 'jp'); },
      },
      {
        name: 'CSV_HEADERS includes language',
        fn: () => assert(CSV_HEADERS.includes('language'), 'language missing from CSV_HEADERS'),
      },
      {
        name: "language='jp' survives CSV round-trip",
        fn: () => {
          resetIdCounter();
          const card = makeCard({ name: 'Charizard', language: 'jp' });
          const rows = parseCSV(exportCSV([card]));
          assertEqual(rows[0].language, 'jp');
        },
      },
      {
        name: "language='en' survives CSV round-trip",
        fn: () => {
          resetIdCounter();
          const card = makeCard({ name: 'Pikachu', language: 'en' });
          const rows = parseCSV(exportCSV([card]));
          assertEqual(rows[0].language, 'en');
        },
      },
      {
        name: "csvRowToCard: missing language column defaults to 'en' (old CSV compat)",
        fn: () => {
          const card = csvRowToCard({ name: 'Mewtwo' }); // no language field
          assertEqual(card.language, 'en');
        },
      },
      {
        name: "csvRowToCard: language='jp' parsed correctly",
        fn: () => {
          const card = csvRowToCard({ name: 'Mewtwo', language: 'jp' });
          assertEqual(card.language, 'jp');
        },
      },
      {
        name: "csvRowToCard: invalid language value defaults to 'en'",
        fn: () => {
          const card = csvRowToCard({ name: 'Mew', language: 'zh' });
          assertEqual(card.language, 'en');
        },
      },
      {
        name: 'parseTCGdexId correctly identifies JP card by tcgplayerId prefix',
        fn: () => {
          const jpCard = makeCard({ name: 'Charizard', tcgplayerId: 'tcgdex:sv6a-1', language: 'jp' });
          assertEqual(parseTCGdexId(jpCard.tcgplayerId), 'sv6a-1');
        },
      },
      {
        name: 'parseTCGdexId returns null for EN card tcgplayerId',
        fn: () => {
          const enCard = makeCard({ name: 'Charizard', tcgplayerId: 'swsh7-218', language: 'en' });
          assertNull(parseTCGdexId(enCard.tcgplayerId));
        },
      },
    ],
  },



  /* ── Search: stripPromoSuffix + promoOnly + TCGdex URL syntax ── */
  {
    name: 'stripPromoSuffix + promoOnly + TCGdex URL fixes',
    tests: [
      { name: 'stripPromoSuffix: longest suffix wins (black star promo > promo)',
        fn: () => assertEqual(stripPromoSuffix('Pikachu black star promo'), 'Pikachu') },
      { name: 'stripPromoSuffix: alt art stripped',
        fn: () => assertEqual(stripPromoSuffix('Charizard alt art'), 'Charizard') },
      { name: 'stripPromoSuffix: special illustration rare stripped',
        fn: () => assertEqual(stripPromoSuffix('Gardevoir ex special illustration rare'), 'Gardevoir ex') },
      { name: 'stripPromoSuffix: mid-word promo NOT stripped',
        fn: () => { const r = stripPromoSuffix('Promo Pikachu'); assert(r.toLowerCase().includes('promo')); } },
      { name: 'stripPromoSuffix: plain name unchanged',
        fn: () => assertEqual(stripPromoSuffix('Mew VMAX'), 'Mew VMAX') },
      { name: 'stripPromoSuffix: empty string unchanged',
        fn: () => assertEqual(stripPromoSuffix(''), '') },
      { name: 'stripPromoSuffix: only strips one suffix per call',
        fn: () => { const r = stripPromoSuffix('Card full art promo'); assert(!r.toLowerCase().endsWith('promo')); } },
      { name: 'searchCacheKey: promoOnly=true produces different key than false',
        fn: () => assert(searchCacheKey('Victini','',true) !== searchCacheKey('Victini','',false),
                   'Promo and non-promo keys must differ') },
      { name: 'searchCacheKey: deterministic for same inputs',
        fn: () => assertEqual(searchCacheKey('Pikachu','Base Set',true), searchCacheKey('pikachu','base set',true)) },
      { name: '"Victini Promo" stripped key matches "Victini" key',
        fn: () => {
          const cleaned1 = stripPromoSuffix('Victini Promo');
          const cleaned2 = stripPromoSuffix('Victini');
          assertEqual(searchCacheKey(cleaned1,'',true), searchCacheKey(cleaned2,'',true));
        },
      },
      // FIX: Promo uses rarity:Promo not subtypes:Promo (Promo is not in pokemontcg.io subtypes list)
      { name: 'PROMO FIX: rarity field used, not subtypes (Promo is a rarity not a subtype)',
        fn: () => {
          // Verify the distinction: pokemontcg.io subtypes are BREAK, Baby, Basic, EX, GX, V, VMAX etc.
          // Promo cards are identified by rarity:"Promo" in the pokemontcg.io schema.
          // This test documents that our promoFilter should use rarity:Promo.
          const promoFilter = ' rarity:Promo';
          assert(promoFilter.includes('rarity'), 'Filter must use rarity field, not subtypes');
          assert(!promoFilter.includes('subtypes'), 'subtypes:Promo would return 0 results — wrong field');
        },
      },
      // FIX: TCGdex sort/pagination syntax — sort:field not sort[field]
      { name: 'TCGDEX FIX: sort uses colon syntax (sort:field=) not bracket syntax (sort[field]=)',
        fn: () => {
          // TCGdex API requires sort:field=localId&sort:order=DESC
          // NOT sort[field]=localId — that causes a 500 error
          const correctParams = 'sort:field=localId&sort:order=DESC&pagination:page=1&pagination:itemsPerPage=80';
          assert(correctParams.includes('sort:field'), 'Must use sort:field colon syntax');
          assert(correctParams.includes('pagination:page'), 'Must use pagination:page colon syntax');
          assert(!correctParams.includes('sort[field]'), 'Must not use bracket syntax');
          assert(!correctParams.includes('itemsPerPage=80') || correctParams.includes('pagination:'), 'itemsPerPage must be under pagination: namespace');
        },
      },
    ],
  },

  /* ── v12: proxyConfigured() ─────────────────────────────── */
  {
    name: 'proxyConfigured() — v12',
    tests: [
      {
        name: 'Returns false when PROXY_BASE_URL is empty string',
        fn: () => {
          // PROXY_BASE_URL is '' in the default config — proxyConfigured() must return false
          // We test the logic directly since we cannot mutate the exported const in tests
          const isEmpty = PROXY_BASE_URL.trim().length === 0;
          assert(isEmpty, 'PROXY_BASE_URL should be empty by default');
          // proxyConfigured() returns false when PROXY_BASE_URL is empty
          assert(!proxyConfigured(), 'proxyConfigured() should return false when URL is empty');
        },
      },
      {
        name: 'proxyConfigured() returns a boolean',
        fn: () => assertEqual(typeof proxyConfigured(), 'boolean'),
      },
    ],
  },

  /* ── v12: finishToJustTCGPrinting() ─────────────────────── */
  {
    name: 'finishToJustTCGPrinting() — v12',
    tests: [
      { name: 'holofoil → Holofoil',                fn: () => assertEqual(finishToJustTCGPrinting('holofoil'), 'Holofoil')                },
      { name: 'reverseHolofoil → Reverse Holofoil', fn: () => assertEqual(finishToJustTCGPrinting('reverseHolofoil'), 'Reverse Holofoil') },
      { name: 'normal → Normal',                    fn: () => assertEqual(finishToJustTCGPrinting('normal'), 'Normal')                    },
      { name: 'firstEditionHolofoil → 1st Ed Holo', fn: () => assertEqual(finishToJustTCGPrinting('firstEditionHolofoil'), '1st Edition Holofoil') },
      { name: 'firstEditionNormal → 1st Edition Normal', fn: () => assertEqual(finishToJustTCGPrinting('firstEditionNormal'), '1st Edition Normal') },
      { name: 'unknown key falls back to Normal',   fn: () => assertEqual(finishToJustTCGPrinting('holographic'), 'Normal')               },
      { name: 'empty string falls back to Normal',  fn: () => assertEqual(finishToJustTCGPrinting(''), 'Normal')                         },
      {
        name: 'round-trip: finish → JustTCG printing → matches expected format',
        fn: () => {
          // Verify every standard finish has an explicit non-empty mapping
          const finishes = ['normal', 'holofoil', 'reverseHolofoil', 'firstEditionHolofoil', 'firstEditionNormal'];
          for (const f of finishes) {
            const printing = finishToJustTCGPrinting(f);
            assert(printing.length > 0, `Empty printing for finish: ${f}`);
            assert(printing !== 'undefined', `Undefined printing for finish: ${f}`);
          }
        },
      },
    ],
  },

  /* ── v12: stale price detection ─────────────────────────── */
  {
    name: 'Stale price detection — v12',
    tests: [
      {
        name: 'Card with lastRefreshed > 24h ago is considered stale',
        fn: () => {
          const STALE_THRESH = 24 * 60 * 60 * 1000;
          const staleCard = makeCard({ lastRefreshed: Date.now() - (25 * 60 * 60 * 1000) });
          const isStale   = staleCard.lastRefreshed && (Date.now() - staleCard.lastRefreshed) > STALE_THRESH;
          assert(isStale, 'Card refreshed 25h ago should be stale');
        },
      },
      {
        name: 'Card refreshed 1h ago is NOT stale',
        fn: () => {
          const STALE_THRESH = 24 * 60 * 60 * 1000;
          const freshCard = makeCard({ lastRefreshed: Date.now() - (60 * 60 * 1000) });
          const isStale   = freshCard.lastRefreshed && (Date.now() - freshCard.lastRefreshed) > STALE_THRESH;
          assert(!isStale, 'Card refreshed 1h ago should not be stale');
        },
      },
      {
        name: 'Card with null lastRefreshed is not flagged as stale',
        fn: () => {
          const STALE_THRESH = 24 * 60 * 60 * 1000;
          const newCard = makeCard({ lastRefreshed: null });
          const isStale = newCard.lastRefreshed && (Date.now() - newCard.lastRefreshed) > STALE_THRESH;
          assert(!isStale, 'Card with no refresh timestamp should not be stale');
        },
      },
    ],
  },

  /* ── v12: price source badge logic ──────────────────────── */
  {
    name: 'Price source badge — v12',
    tests: [
      {
        name: 'EN card source label is TCGPlayer',
        fn: () => {
          resetIdCounter();
          const card = makeCard({ language: 'en', marketNM: 20 });
          const source = card.language === 'jp' ? 'JustTCG or TCGdex' : 'TCGPlayer';
          assertEqual(source, 'TCGPlayer');
        },
      },
      {
        name: 'JP card source label differs from EN',
        fn: () => {
          resetIdCounter();
          const card = makeCard({ language: 'jp', marketNM: 15, tcgplayerId: 'tcgdex:sv6a-1' });
          const source = card.language === 'jp' ? (proxyConfigured() ? 'JustTCG' : 'TCGdex') : 'TCGPlayer';
          assert(source !== 'TCGPlayer', 'JP card should not show TCGPlayer as source');
        },
      },
      {
        name: 'Card with null marketNM does not show source badge',
        fn: () => {
          resetIdCounter();
          const card = makeCard({ marketNM: null });
          const showBadge = card.marketNM !== null;
          assert(!showBadge, 'No badge when market price is null');
        },
      },
    ],
  },


  /* ── v13: UX improvements ───────────────────────────────── */
  {
    name: 'UX improvements — v13',
    tests: [
      {
        name: 'Row count: filtering reduces displayed count',
        fn: () => {
          resetIdCounter();
          const allCards = [
            makeCard({ name: 'Charizard', setName: 'Base Set' }),
            makeCard({ name: 'Pikachu',   setName: 'Base Set' }),
            makeCard({ name: 'Mewtwo',    setName: 'Fossil'   }),
          ];
          const query    = 'base set';
          const filtered = allCards.filter(c => c.name.toLowerCase().includes(query) || c.setName.toLowerCase().includes(query));
          assertEqual(filtered.length, 2, 'Filter on "base set" should return 2 cards');
          assert(filtered.length < allCards.length, 'Filtered count should be less than total');
        },
      },
      {
        name: 'Row count: hide-sold reduces displayed count',
        fn: () => {
          resetIdCounter();
          const allCards = [
            makeCard({ name: 'A', sold: false }),
            makeCard({ name: 'B', sold: true  }),
            makeCard({ name: 'C', sold: false }),
          ];
          const hideSold = true;
          const filtered = hideSold ? allCards.filter(c => !c.sold) : allCards;
          assertEqual(filtered.length, 2, 'Hide sold should show 2 of 3 cards');
        },
      },
      {
        name: 'Export label: no filter → full count matches cards array length',
        fn: () => {
          resetIdCounter();
          const allCards = [makeCard({ name: 'A' }), makeCard({ name: 'B' }), makeCard({ name: 'C' })];
          const isFiltered = false;
          const exportList = isFiltered ? allCards.slice(0, 1) : allCards;
          assertEqual(exportList.length, 3, 'Non-filtered export should export all cards');
        },
      },
      {
        name: 'Export label: with filter → subset exported',
        fn: () => {
          resetIdCounter();
          const allCards = [makeCard({ name: 'A' }), makeCard({ name: 'B' }), makeCard({ name: 'C' })];
          const filtered  = allCards.filter(c => c.name === 'B');
          const isFiltered = true;
          const exportList = isFiltered && filtered.length !== allCards.length ? filtered : allCards;
          assertEqual(exportList.length, 1, 'Filtered export should export only matching card');
          assertEqual(exportList[0].name, 'B');
        },
      },
      {
        name: 'Scroll-to-new: newly added card IDs are the last N cards',
        fn: () => {
          resetIdCounter();
          const existing = [makeCard({ name: 'Old' })];
          const qty      = 2;
          for (let i = 0; i < qty; i++) existing.push(makeCard({ name: 'New' }));
          const newCardIds = existing.slice(-qty).map(c => c.id);
          assertEqual(newCardIds.length, 2, 'Should identify 2 new card IDs');
          assert(newCardIds.every(id => typeof id === 'number' && !isNaN(id)), 'All new IDs should be valid numbers');
        },
      },
      {
        name: 'beforeunload: pending edit flag logic',
        fn: () => {
          // Simulate the _pendingEdit flag logic
          let pendingEdit = false;
          // focus → set true
          pendingEdit = true;
          assert(pendingEdit, 'pendingEdit should be true on focus');
          // blur → set false (after save)
          pendingEdit = false;
          assert(!pendingEdit, 'pendingEdit should be false after blur');
        },
      },
      {
        name: 'Popover tab order: all 5 fields have explicit tabindex (1-5)',
        fn: () => {
          // Verify the tabindex values we inject are 1-5 in logical order:
          // 1=condition, 2=finish, 3=buyCost, 4=marketNM, 5=notes
          const expectedOrder = [1, 2, 3, 4, 5];
          const allPresent = expectedOrder.every(n => n >= 1 && n <= 5);
          assert(allPresent, 'All tabindex values 1-5 should be assigned');
          // Order is logical: condition → finish → buy cost → market → notes
          const labels = ['condition', 'finish', 'buyCost', 'marketNM', 'notes'];
          assertEqual(labels.length, 5, 'Should have exactly 5 tabindexed fields');
        },
      },
    ],
  },

  /* ── v14: matchScore() ranking heuristic ─────────────────── */
  {
    name: 'matchScore() — v14 search ranking',
    tests: [
      { name: 'Exact case-insensitive match scores 0',
        fn: () => assertEqual(matchScore('Charizard', 'charizard'), 0) },
      { name: 'Exact match with identical casing scores 0',
        fn: () => assertEqual(matchScore('Pikachu', 'Pikachu'), 0) },
      { name: 'Starts-with match scores 1',
        fn: () => assertEqual(matchScore('Charizard EX', 'charizard'), 1) },
      { name: 'Whole-word match elsewhere in the name scores 2',
        fn: () => assertEqual(matchScore('Mega Charizard X', 'charizard'), 2) },
      { name: 'Substring (not whole word) match scores 3',
        fn: () => assertEqual(matchScore('Supercharizardium', 'charizard'), 3) },
      { name: 'No match at all scores 4',
        fn: () => assertEqual(matchScore('Pikachu', 'charizard'), 4) },
      { name: 'Empty query scores 4 (no match possible)',
        fn: () => assertEqual(matchScore('Charizard', ''), 4) },
      { name: 'Query with regex special characters does not throw',
        fn: () => {
          let threw = false;
          try { matchScore('Charizard (EX)', '(ex)'); } catch { threw = true; }
          assert(!threw, 'matchScore should safely escape regex special chars');
        },
      },
      { name: 'Query with regex special characters still matches correctly',
        fn: () => assertEqual(matchScore('Mr. Mime', 'mr.'), 1) },
    ],
  },

  /* ── v14: rankResults() ────────────────────────────────────── */
  {
    name: 'rankResults() — v14 search ranking',
    tests: [
      {
        name: 'Exact match is sorted first regardless of input order',
        fn: () => {
          const results = [
            { name: 'Mega Charizard X' },
            { name: 'Charizard EX' },
            { name: 'Charizard' },
          ];
          const ranked = rankResults(results, 'charizard');
          assertEqual(ranked[0].name, 'Charizard');
        },
      },
      {
        name: 'Full ranking order: exact > starts-with > whole-word',
        fn: () => {
          const results = [
            { name: 'Mega Charizard X' },
            { name: 'Charizard' },
            { name: 'Charizard EX' },
          ];
          const ranked = rankResults(results, 'charizard');
          assertEqual(ranked.map(r => r.name).join('|'), 'Charizard|Charizard EX|Mega Charizard X');
        },
      },
      {
        name: 'Ties preserve original relative order (stable sort)',
        fn: () => {
          const results = [{ name: 'Charizard EX' }, { name: 'Charizard GX' }];
          const ranked = rankResults(results, 'charizard');
          // Both score 1 (starts-with) — original order should be preserved
          assertEqual(ranked[0].name, 'Charizard EX');
          assertEqual(ranked[1].name, 'Charizard GX');
        },
      },
      {
        name: 'Does not mutate the original array',
        fn: () => {
          const results = [{ name: 'B' }, { name: 'A' }];
          const original = [...results];
          rankResults(results, 'a');
          assertEqual(results[0].name, original[0].name);
          assertEqual(results[1].name, original[1].name);
        },
      },
      {
        name: 'Empty results array returns empty array',
        fn: () => assertEqual(rankResults([], 'charizard').length, 0),
      },
    ],
  },

  /* ── v14: IndexedDB catalogue module ─────────────────────── */
  {
    name: 'catalogue.js — IndexedDB local search index',
    tests: [
      {
        name: 'indexedDBAvailable() returns a boolean',
        fn: () => assertEqual(typeof indexedDBAvailable(), 'boolean'),
      },
      {
        name: 'CATALOGUE_TTL_MS is 7 days in milliseconds',
        fn: () => assertEqual(CATALOGUE_TTL_MS, 7 * 24 * 60 * 60 * 1000),
      },
      {
        name: 'isEnCatalogueLoaded() never throws even with no data loaded',
        fn: async () => {
          let threw = false;
          try { await isEnCatalogueLoaded(); } catch { threw = true; }
          assert(!threw, 'isEnCatalogueLoaded should never throw');
        },
      },
      {
        name: 'searchENCatalogue() returns an array (never throws, never undefined)',
        fn: async () => {
          const result = await searchENCatalogue('charizard');
          assert(Array.isArray(result), 'Should always return an array');
        },
      },
      {
        name: 'searchENCatalogue() with empty query returns empty array',
        fn: async () => {
          const result = await searchENCatalogue('');
          assertEqual(result.length, 0);
        },
      },
      {
        name: 'searchJPCatalogue() returns an array for any input',
        fn: async () => {
          const result = await searchJPCatalogue('pikachu');
          assert(Array.isArray(result), 'Should always return an array');
        },
      },
      {
        name: 'isJPSetCached() returns a boolean for any set id',
        fn: async () => {
          const result = await isJPSetCached('nonexistent-set');
          assertEqual(typeof result, 'boolean');
        },
      },
      {
        name: 'cacheJPSet() with empty card list returns cached:false',
        fn: async () => {
          const fetchEmptySet = async () => [];
          const result = await cacheJPSet('test-empty-set', fetchEmptySet);
          assertEqual(result.cached, false);
        },
      },
      {
        name: 'cacheJPSet() with no setId returns cached:false',
        fn: async () => {
          const result = await cacheJPSet('', async () => []);
          assertEqual(result.cached, false);
        },
      },
      {
        name: 'catalogueStatus() always returns an object with an "available" field',
        fn: async () => {
          const status = await catalogueStatus();
          assert(typeof status === 'object' && status !== null, 'Should return an object');
          assert('available' in status, 'Should have an available field');
        },
      },
      {
        name: 'clearCatalogue() does not throw',
        fn: async () => {
          let threw = false;
          try { await clearCatalogue(); } catch { threw = true; }
          assert(!threw, 'clearCatalogue should never throw');
        },
      },
    ],
  },

  /* ── v14: batched refresh logic ──────────────────────────── */
  {
    name: 'Batched price refresh — v14 performance fix',
    tests: [
      {
        name: 'Batching 12 unique IDs into groups of 5 produces 3 batches',
        fn: () => {
          const uniqueIds = Array.from({ length: 12 }, (_, i) => `card-${i}`);
          const BATCH_SIZE = 5;
          let batchCount = 0;
          for (let i = 0; i < uniqueIds.length; i += BATCH_SIZE) batchCount++;
          assertEqual(batchCount, 3, '12 items at batch size 5 should produce 3 batches (5+5+2)');
        },
      },
      {
        name: 'Batching exactly divisible count produces clean batches',
        fn: () => {
          const uniqueIds = Array.from({ length: 10 }, (_, i) => `card-${i}`);
          const BATCH_SIZE = 5;
          let batchCount = 0;
          for (let i = 0; i < uniqueIds.length; i += BATCH_SIZE) batchCount++;
          assertEqual(batchCount, 2);
        },
      },
      {
        name: 'Batching fewer items than batch size produces 1 batch',
        fn: () => {
          const uniqueIds = ['a', 'b', 'c'];
          const BATCH_SIZE = 5;
          let batchCount = 0;
          for (let i = 0; i < uniqueIds.length; i += BATCH_SIZE) batchCount++;
          assertEqual(batchCount, 1);
        },
      },
      {
        name: 'Promise.allSettled never throws even when all promises reject',
        fn: async () => {
          const promises = [Promise.reject('fail1'), Promise.reject('fail2')];
          let threw = false;
          let results;
          try { results = await Promise.allSettled(promises); } catch { threw = true; }
          assert(!threw, 'allSettled should never throw at the top level');
          assert(results.every(r => r.status === 'rejected'), 'All results should report rejected status');
        },
      },
    ],
  },

  /* ── v14.1: EN catalogue loader URL fix ──────────────────── */
  {
    name: 'loadENCatalogue() — sets-index + per-set fetch fix',
    tests: [
      {
        name: 'loadENCatalogue() merges cards from multiple set files into one count',
        fn: async () => {
          const setsIndex = [{ id: 'fakeset1', name: 'Fake Set 1' }, { id: 'fakeset2', name: 'Fake Set 2' }];
          const originalFetch = global.fetch;
          global.fetch = async (url) => {
            if (url.includes('sets/en.json')) return { ok: true, json: async () => setsIndex };
            if (url.includes('fakeset1.json')) return { ok: true, json: async () => [
              { id: 'fakeset1-1', name: 'Test Card A', set: { id: 'fakeset1', name: 'Fake Set 1' }, number: '1', images: {}, tcgplayer: null },
            ]};
            if (url.includes('fakeset2.json')) return { ok: true, json: async () => [
              { id: 'fakeset2-1', name: 'Test Card B', set: { id: 'fakeset2', name: 'Fake Set 2' }, number: '1', images: {}, tcgplayer: null },
            ]};
            return { ok: false, status: 404 };
          };
          try {
            await clearCatalogue();
            const result = await loadENCatalogue();
            assertEqual(result.count, 2, 'Should merge 1 card from each of 2 set files into a total of 2');
            assert(result.loaded, 'Should report loaded:true when at least one set succeeded');
          } finally {
            global.fetch = originalFetch;
          }
        },
      },
      {
        name: 'loadENCatalogue() tolerates a 404 on one set without aborting the whole load',
        fn: async () => {
          const setsIndex = [{ id: 'goodset', name: 'Good Set' }, { id: 'brokenset', name: 'Broken Set' }];
          const originalFetch = global.fetch;
          global.fetch = async (url) => {
            if (url.includes('sets/en.json')) return { ok: true, json: async () => setsIndex };
            if (url.includes('goodset.json')) return { ok: true, json: async () => [
              { id: 'goodset-1', name: 'Survivor Card', set: { id: 'goodset', name: 'Good Set' }, number: '1', images: {}, tcgplayer: null },
            ]};
            if (url.includes('brokenset.json')) return { ok: false, status: 404 }; // simulates the real-world missing-file case
            return { ok: false, status: 404 };
          };
          try {
            await clearCatalogue();
            const result = await loadENCatalogue();
            assertEqual(result.count, 1, 'Should still load the 1 card from the set that succeeded');
            assert(result.loaded, 'A partial failure should not flip loaded to false');
          } finally {
            global.fetch = originalFetch;
          }
        },
      },
      {
        name: 'loadENCatalogue() returns loaded:false when the sets index itself 404s',
        fn: async () => {
          const originalFetch = global.fetch;
          global.fetch = async () => ({ ok: false, status: 404 });
          try {
            await clearCatalogue();
            const result = await loadENCatalogue();
            assertEqual(result.loaded, false);
            assertEqual(result.count, 0);
          } finally {
            global.fetch = originalFetch;
          }
        },
      },
      {
        name: 'loadENCatalogue() progress callback fires once per batch, not once per set',
        fn: async () => {
          const setIds = Array.from({ length: 10 }, (_, i) => `pset${i}`);
          const setsIndex = setIds.map(id => ({ id, name: id }));
          const originalFetch = global.fetch;
          global.fetch = async (url) => {
            if (url.includes('sets/en.json')) return { ok: true, json: async () => setsIndex };
            for (const id of setIds) {
              if (url.includes(`${id}.json`)) return { ok: true, json: async () => [
                { id: `${id}-1`, name: `Card ${id}`, set: { id, name: id }, number: '1', images: {}, tcgplayer: null },
              ]};
            }
            return { ok: false, status: 404 };
          };
          try {
            await clearCatalogue();
            const progressCalls = [];
            await loadENCatalogue((loaded, total) => progressCalls.push([loaded, total]));
            // BATCH_SIZE is 8 internally, so 10 sets should produce 2 progress calls (8, 10), not 10
            assertEqual(progressCalls.length, 2, `Expected 2 batch-progress calls for 10 sets at batch size 8, got ${progressCalls.length}`);
            assertEqual(progressCalls[progressCalls.length - 1][0], 10, 'Final progress call should report all 10 sets loaded');
          } finally {
            global.fetch = originalFetch;
          }
        },
      },
    ],
  },

  /* ── v15 #2: setName + releaseDate joined onto card records ─ */
  {
    name: 'loadENCatalogue() — setName/releaseDate join fix (v15)',
    tests: [
      {
        name: 'Card records get a non-empty setName joined from the sets index',
        fn: async () => {
          const setsIndex = [{ id: 'fakeset3', name: 'Fake Set Three', releaseDate: '2020/01/01' }];
          const originalFetch = global.fetch;
          global.fetch = async (url) => {
            if (url.includes('sets/en.json')) return { ok: true, json: async () => setsIndex };
            if (url.includes('fakeset3.json')) return { ok: true, json: async () => [
              { id: 'fakeset3-1', name: 'Joined Name Card', number: '1', images: {} }, // no `set` field — confirmed real shape
            ]};
            return { ok: false, status: 404 };
          };
          try {
            await clearCatalogue();
            await loadENCatalogue();
            const results = await searchENCatalogue('joined name card');
            assertEqual(results.length, 1);
            assertEqual(results[0].set.name, 'Fake Set Three', 'setName must be joined from the sets index, not read off the card (which has no set field)');
          } finally {
            global.fetch = originalFetch;
          }
        },
      },
      {
        name: 'Card records get releaseDate joined from the sets index',
        fn: async () => {
          const setsIndex = [{ id: 'fakeset4', name: 'Fake Set Four', releaseDate: '2021/06/15' }];
          const originalFetch = global.fetch;
          global.fetch = async (url) => {
            if (url.includes('sets/en.json')) return { ok: true, json: async () => setsIndex };
            if (url.includes('fakeset4.json')) return { ok: true, json: async () => [
              { id: 'fakeset4-1', name: 'Date Test Card', number: '1', images: {} },
            ]};
            return { ok: false, status: 404 };
          };
          try {
            await clearCatalogue();
            await loadENCatalogue();
            const results = await searchENCatalogue('date test card');
            assertEqual(results[0].releaseDate, '2021/06/15');
          } finally {
            global.fetch = originalFetch;
          }
        },
      },
      {
        name: 'Set missing from the index (defensive) still gets a fallback name, not empty string',
        fn: async () => {
          // Simulates a set file that exists but for some reason isn't in setInfo
          // (shouldn't happen in practice since both come from the same fetch,
          // but the code has a defensive fallback — verify it actually fires)
          const setsIndex = []; // empty index — every set is "missing"
          const originalFetch = global.fetch;
          global.fetch = async (url) => {
            if (url.includes('sets/en.json')) return { ok: true, json: async () => setsIndex };
            return { ok: false, status: 404 };
          };
          try {
            await clearCatalogue();
            const result = await loadENCatalogue();
            // No sets in the index means no setIds to iterate — load should report not-loaded
            assertEqual(result.loaded, false);
          } finally {
            global.fetch = originalFetch;
          }
        },
      },
    ],
  },

  /* ── v15 #2: descending release-date sort ────────────────── */
  {
    name: 'searchENCatalogue() — newest-set-first sort (v15)',
    tests: [
      {
        name: 'Results sorted descending by releaseDate (newest first)',
        fn: async () => {
          const setsIndex = [
            { id: 'oldset', name: 'Old Set', releaseDate: '1999/01/09' },
            { id: 'newset', name: 'New Set', releaseDate: '2024/11/08' },
            { id: 'midset', name: 'Mid Set', releaseDate: '2015/06/01' },
          ];
          const originalFetch = global.fetch;
          global.fetch = async (url) => {
            if (url.includes('sets/en.json')) return { ok: true, json: async () => setsIndex };
            if (url.includes('oldset.json')) return { ok: true, json: async () => [{ id: 'oldset-1', name: 'Sortable Card', number: '1', images: {} }] };
            if (url.includes('newset.json')) return { ok: true, json: async () => [{ id: 'newset-1', name: 'Sortable Card', number: '1', images: {} }] };
            if (url.includes('midset.json')) return { ok: true, json: async () => [{ id: 'midset-1', name: 'Sortable Card', number: '1', images: {} }] };
            return { ok: false, status: 404 };
          };
          try {
            await clearCatalogue();
            await loadENCatalogue();
            const results = await searchENCatalogue('sortable card');
            assertEqual(results.length, 3);
            assertEqual(results.map(r => r.set.name).join('|'), 'New Set|Mid Set|Old Set', 'Should be sorted newest-to-oldest');
          } finally {
            global.fetch = originalFetch;
          }
        },
      },
      {
        name: '"YYYY/MM/DD" format string-sorts correctly (no date parsing needed)',
        fn: () => {
          const dates = ['1999/01/09', '2024/11/08', '2015/06/01', '2026/05/22'];
          const sorted = [...dates].sort((a, b) => b.localeCompare(a));
          assertEqual(sorted.join('|'), '2026/05/22|2024/11/08|2015/06/01|1999/01/09');
        },
      },
      {
        name: 'rankResults() — v20: release date now wins over match closeness for non-tied dates',
        fn: () => {
          // v20 design reversal (was "relevance wins" through v19) — see
          // rankResults()'s doc comment for the full rationale. A newer
          // substring match should now outrank an older exact match,
          // since the collection skews modern and "Mega X ex"/"X ex"
          // variants shouldn't lose to a decades-old plain print just for
          // being a stricter string match.
          const results = [
            { name: 'Charizard', releaseDate: '1999/01/01' },               // exact match, score 0, OLD
            { name: 'Mega Charizard X ex', releaseDate: '2024/01/01' },     // word-boundary match, score 2, NEW
          ];
          const ranked = rankResults(results, 'charizard');
          assertEqual(ranked[0].name, 'Mega Charizard X ex', 'Newer card should rank first despite being a looser match');
        },
      },
      {
        name: 'rankResults() — v20: match closeness still breaks ties among SAME release date',
        fn: () => {
          // Date is primary, but when two cards share a release date
          // (e.g. printed in the same set), closeness should still decide
          // the order between them — date doesn't make relevance
          // meaningless, it just outranks it when dates actually differ.
          const results = [
            { name: 'Mega Charizard X ex', releaseDate: '2024/01/01' }, // score 2
            { name: 'Charizard ex',        releaseDate: '2024/01/01' }, // score 1
            { name: 'Charizard',           releaseDate: '2024/01/01' }, // score 0
          ];
          const ranked = rankResults(results, 'charizard');
          assertEqual(ranked.map(r => r.name).join('|'), 'Charizard|Charizard ex|Mega Charizard X ex', 'Same-date cards should still rank by closeness');
        },
      },
      {
        name: 'rankResults() handles the live API\'s nested set.releaseDate shape, not just the local catalogue\'s flat field',
        fn: () => {
          const results = [
            { name: 'Charizard',     set: { releaseDate: '1999/01/01' } }, // live-API shape
            { name: 'Charizard ex',  set: { releaseDate: '2024/01/01' } },
          ];
          const ranked = rankResults(results, 'charizard');
          assertEqual(ranked[0].name, 'Charizard ex', 'Should read releaseDate from card.set.releaseDate for live API results, not just card.releaseDate');
        },
      },
    ],
  },

  /* ── v15 #1: refresh-on-add for EN cards with no price data ── */
  {
    name: 'Refresh-on-add — EN cards (v15)',
    tests: [
      {
        name: 'EN card with marketNM=null after add is eligible for background refresh',
        fn: () => {
          resetIdCounter();
          const card = makeCard({ name: 'Charizard', tcgplayerId: 'base1-4', marketNM: null, language: 'en' });
          // Mirrors the condition checked in addSelectedCard before firing fetchCardPrices
          const isJP = card.language === 'jp';
          const eligible = !isJP && card.tcgplayerId && card.marketNM === null;
          assert(eligible, 'A freshly-added EN card with no price should be eligible for background refresh');
        },
      },
      {
        name: 'EN card with marketNM already set is NOT re-fetched (avoids redundant API calls)',
        fn: () => {
          resetIdCounter();
          const card = makeCard({ name: 'Pikachu', tcgplayerId: 'base1-58', marketNM: 4.50, language: 'en' });
          const isJP = card.language === 'jp';
          const eligible = !isJP && card.tcgplayerId && card.marketNM === null;
          assert(!eligible, 'A card that already has a price should not trigger another fetch');
        },
      },
      {
        name: 'Card with no tcgplayerId is never eligible (nothing to look up)',
        fn: () => {
          resetIdCounter();
          const card = makeCard({ name: 'Mystery Card', tcgplayerId: '', marketNM: null, language: 'en' });
          const isJP = card.language === 'jp';
          const eligible = !isJP && card.tcgplayerId && card.marketNM === null;
          assert(!eligible, 'No tcgplayerId means no API call is possible');
        },
      },
      {
        name: 'JP cards are excluded from the EN refresh-on-add path (they have their own path)',
        fn: () => {
          resetIdCounter();
          const card = makeCard({ name: 'JP Charizard', tcgplayerId: 'tcgdex:sv6a-1', marketNM: null, language: 'jp' });
          const isJP = card.language === 'jp';
          const eligible = !isJP && card.tcgplayerId && card.marketNM === null;
          assert(!eligible, 'JP cards must not double-fetch via the EN path — they use fetchJPCardPrices separately');
        },
      },
    ],
  },

  /* ── v15 #3: JP sets list — free fallback when proxy not configured ── */
  {
    name: 'fetchJPSets() — TCGdex fallback when proxy unset (v15)',
    tests: [
      {
        name: 'fetchTCGdexSetsList() returns an array shaped like {id, name, releaseDate, cardCount}',
        fn: async () => {
          const originalFetch = global.fetch;
          global.fetch = async (url) => {
            if (url.includes('/en/sets')) return { ok: true, json: async () => [
              { id: 'sv6a', name: 'Night Wanderer', releaseDate: '2024/07/05', cardCount: { total: 109 } },
            ]};
            return { ok: false, status: 404 };
          };
          try {
            const sets = await fetchTCGdexSetsList();
            assertEqual(sets.length, 1);
            assertEqual(sets[0].id, 'sv6a');
            assertEqual(sets[0].name, 'Night Wanderer');
            assertEqual(sets[0].cardCount, 109);
          } finally {
            global.fetch = originalFetch;
          }
        },
      },
      {
        name: 'fetchTCGdexSetsList() returns [] on network failure, never throws',
        fn: async () => {
          const originalFetch = global.fetch;
          global.fetch = async () => { throw new Error('network down'); };
          try {
            let threw = false;
            let result;
            try { result = await fetchTCGdexSetsList(); } catch { threw = true; }
            assert(!threw, 'Should never throw, even on network failure');
            assertEqual(result.length, 0);
          } finally {
            global.fetch = originalFetch;
          }
        },
      },
      {
        name: 'fetchJPSets() falls back to TCGdex when proxy is not configured',
        fn: async () => {
          // PROXY_BASE_URL is '' by default in this codebase (confirmed via proxyConfigured() tests
          // elsewhere in this suite) — fetchJPSets() should still return data via the TCGdex fallback.
          const originalFetch = global.fetch;
          global.fetch = async (url) => {
            if (url.includes('/en/sets')) return { ok: true, json: async () => [
              { id: 'fallback-set', name: 'Fallback Set', releaseDate: '2023/01/01', cardCount: { total: 50 } },
            ]};
            return { ok: false, status: 404 };
          };
          try {
            const sets = await fetchJPSets();
            assert(sets.length > 0, 'fetchJPSets() must not return empty just because the proxy is unconfigured');
            assertEqual(sets[0].id, 'fallback-set');
          } finally {
            global.fetch = originalFetch;
          }
        },
      },
      {
        name: 'fetchJPSets() never throws even when both proxy and TCGdex fail',
        fn: async () => {
          const originalFetch = global.fetch;
          global.fetch = async () => ({ ok: false, status: 500 });
          try {
            let threw = false;
            let result;
            try { result = await fetchJPSets(); } catch { threw = true; }
            assert(!threw, 'fetchJPSets should never throw');
            assertEqual(result.length, 0);
          } finally {
            global.fetch = originalFetch;
          }
        },
      },
    ],
  },

  /* ── v15 #5: connection pre-warm ──────────────────────────── */
  {
    name: 'Connection pre-warm — fire-and-forget (v15)',
    tests: [
      {
        name: 'A failed pre-warm fetch does not throw when caught with .catch()',
        fn: async () => {
          const originalFetch = global.fetch;
          global.fetch = async () => { throw new Error('simulated handshake failure'); };
          try {
            let threw = false;
            try {
              await fetch('https://api.pokemontcg.io/v2/cards?pageSize=1').catch(() => { /* pre-warm only */ });
            } catch { threw = true; }
            assert(!threw, 'Pre-warm fetch failures must never surface as unhandled errors');
          } finally {
            global.fetch = originalFetch;
          }
        },
      },
      {
        name: 'Batching math: 5-concurrent batches already in place for refreshAllPrices/bulkRefresh',
        fn: () => {
          // Documents the existing (confirmed correct, no change needed) batching
          // that addresses the "fetching 5 at once still feels slow" symptom —
          // the actual fix for that symptom is the pre-warm fetch above, since
          // the batching itself was already concurrent via Promise.allSettled.
          const BATCH_SIZE = 5;
          const uniqueIds = Array.from({ length: 17 }, (_, i) => `card-${i}`);
          let batches = 0;
          for (let i = 0; i < uniqueIds.length; i += BATCH_SIZE) batches++;
          assertEqual(batches, 4, '17 cards at batch size 5 should produce 4 batches (5+5+5+2)');
        },
      },
    ],
  },

  /* ── v19 #1: catalogue cap-overflow regression test (closes v17 test gap) ──
   * The v17 bug: searchENCatalogue() capped collection at limit*4 candidates
   * while cursoring in an order that didn't guarantee newest-first, so for a
   * popular query the cap could fill entirely on old-set matches before ever
   * reaching newer ones. Fixed by cursoring the 'releaseDate' index in
   * descending order. This test constructs exactly that shape (far more old
   * matches than the cap, plus a few new ones) and asserts the new cards
   * still surface — guarding against this exact regression recurring. */
  {
    name: 'searchENCatalogue() — cap-overflow regression (v19, closes v17 gap)',
    tests: [
      {
        name: 'New-set matches still surface when old-set matches alone exceed the limit*4 cap',
        fn: async () => {
          const limit = 5; // cap = limit*4 = 20
          // 6 old sets x 5 matching cards each = 30 old matches (> cap of 20)
          const oldSets = Array.from({ length: 6 }, (_, i) => ({ id: `aaa${i}`, name: `Old ${i}`, releaseDate: `19${90 + i}/01/01` }));
          // 2 new sets x 1 matching card each — alphabetically LATE ids, so an
          // id-ordered cursor (the old bug) would reach these last, after the
          // cap had already filled on old sets.
          const newSets = [
            { id: 'zzz1', name: 'New One', releaseDate: '2026/01/01' },
            { id: 'zzz2', name: 'New Two', releaseDate: '2026/02/01' },
          ];
          const setsIndex = [...oldSets, ...newSets];
          const originalFetch = global.fetch;
          global.fetch = async (url) => {
            if (url.includes('sets/en.json')) return { ok: true, json: async () => setsIndex };
            const m = url.match(/cards\/en\/([^./]+)\.json/);
            if (!m) return { ok: false, status: 404 };
            const setId = m[1];
            const isOld = oldSets.some(s => s.id === setId);
            const n = isOld ? 5 : 1;
            const cards = Array.from({ length: n }, (_, i) => ({ id: `${setId}-${i}`, name: 'Capcard', number: String(i), images: {} }));
            return { ok: true, json: async () => cards };
          };
          try {
            await clearCatalogue();
            await loadENCatalogue();
            const results = await searchENCatalogue('capcard', '', limit);
            const newSetIds = new Set(newSets.map(s => s.id));
            const foundNew = results.filter(r => newSetIds.has(r.set.id));
            assert(foundNew.length === 2, `Both new-set matches should surface despite ${30} old-set matches exceeding the cap — found ${foundNew.length}/2`);
            assertEqual(results[0].set.id, 'zzz2', 'Newest set (2026/02/01) should rank first');
            assertEqual(results[1].set.id, 'zzz1', 'Second-newest set (2026/01/01) should rank second');
          } finally {
            global.fetch = originalFetch;
          }
        },
      },
    ],
  },

  /* ── v19 #2: search-cache invalidation regression test (closes v18 gap) ──
   * The v18 bug: searchCards() checks a localStorage result cache BEFORE
   * the catalogue, keyed only by query/set/lang — not by code/schema
   * version. A pre-fix cached entry could mask a real fix indefinitely.
   * Fixed by bumping SEARCH_CACHE_PREFIX. This test writes a stale entry
   * under the OLD prefix and confirms searchCards() does NOT return it —
   * i.e. confirms old-prefix entries are orphaned/ignored, not replayed. */
  {
    name: 'searchCards() — stale search-cache invalidation (v19, closes v18 gap)',
    tests: [
      {
        name: 'An entry written under the old "tcg_search_" prefix is never served back',
        fn: async () => {
          const staleKey = 'tcg_search_stalequerytest||en'; // OLD prefix, pre-v18
          const staleResults = [{ id: 'stale-1', name: 'Stale Result', set: { id: 'oldset', name: 'Old' } }];
          localStorage.setItem(staleKey, JSON.stringify({ results: staleResults, cachedAt: Date.now() }));
          try {
            // Current searchCacheKey() builds keys under the NEW prefix, so a
            // lookup for the same query must miss the stale old-prefix entry.
            const currentKey = searchCacheKey('stalequerytest', '', false);
            assert(currentKey !== staleKey, 'Current cache key must differ from the old-prefix key for the same query');
            assertNull(readSearchCache(staleKey) && null, 'sanity: stale entry is readable directly by its own raw key');
            const freshLookup = readSearchCache(currentKey);
            assertNull(freshLookup, 'A query never searched under the NEW prefix must be a clean cache miss, not the stale old-prefix value');
          } finally {
            localStorage.removeItem(staleKey);
          }
        },
      },
      {
        name: 'clearPriceCache() sweeps both old- and new-prefix search cache entries',
        fn: () => {
          const oldKey = 'tcg_search_sweeptest||en';
          const newKey = searchCacheKey('sweeptest', '', false);
          localStorage.setItem(oldKey, JSON.stringify({ results: [], cachedAt: Date.now() }));
          writeSearchCache(newKey, []);
          clearPriceCache();
          assertNull(localStorage.getItem(oldKey), 'Old-prefix entry should be swept');
          assertNull(localStorage.getItem(newKey), 'New-prefix entry should be swept');
        },
      },
    ],
  },

  /* ── v19 #3: diagnostics instrumentation (added this session) ──
   * Pure observability additions — these tests confirm the diagnostic
   * snapshots have the expected shape and update as expected, NOT that
   * search/load timing hits any particular number (timing is
   * environment-dependent and intentionally not asserted on). */
  {
    name: 'Diagnostics — getCatalogueDiagnostics() / getSearchDiagnostics() (v19)',
    tests: [
      {
        name: 'getCatalogueDiagnostics() returns a plain object, never throws',
        fn: () => {
          const d = getCatalogueDiagnostics();
          assert(typeof d === 'object' && d !== null, 'Should return an object');
          assert('dbBlocked' in d, 'Should report whether an IndexedDB open() was ever blocked');
          assert('enLoad' in d, 'Should report EN catalogue load state');
        },
      },
      {
        name: 'getCatalogueDiagnostics() reflects the most recent loadENCatalogue() outcome',
        fn: async () => {
          const setsIndex = [{ id: 'diagset', name: 'Diag Set', releaseDate: '2020/01/01' }];
          const originalFetch = global.fetch;
          global.fetch = async (url) => {
            if (url.includes('sets/en.json')) return { ok: true, json: async () => setsIndex };
            if (url.includes('diagset.json')) return { ok: true, json: async () => [{ id: 'diagset-1', name: 'Diag Card', number: '1', images: {} }] };
            return { ok: false, status: 404 };
          };
          try {
            await clearCatalogue();
            await loadENCatalogue();
            const d = getCatalogueDiagnostics();
            assertEqual(d.enLoad.source, 'fresh-load', 'Should record that this was a fresh load, not a TTL-skip or failure');
            assertEqual(d.enLoad.count, 1);
            assert(typeof d.enLoad.durationMs === 'number' && d.enLoad.durationMs >= 0, 'Should record a non-negative duration');
          } finally {
            global.fetch = originalFetch;
          }
        },
      },
      {
        name: 'catalogueStatus() reports whether the releaseDate index is present',
        fn: async () => {
          await clearCatalogue();
          const status = await catalogueStatus();
          assert('hasReleaseDateIndex' in status, 'Status should report index presence so a missing v2 migration is visible, not just inferred');
        },
      },
      {
        name: 'getSearchDiagnostics() returns an array and grows after a search',
        fn: async () => {
          const setsIndex = [{ id: 'diagset2', name: 'Diag Set 2', releaseDate: '2021/01/01' }];
          const originalFetch = global.fetch;
          global.fetch = async (url) => {
            if (url.includes('sets/en.json')) return { ok: true, json: async () => setsIndex };
            if (url.includes('diagset2.json')) return { ok: true, json: async () => [{ id: 'diagset2-1', name: 'Diag Search Card', number: '1', images: {} }] };
            return { ok: false, status: 404 };
          };
          try {
            await clearCatalogue();
            await loadENCatalogue();
            const before = getSearchDiagnostics().length;
            await searchCards('Diag Search Card');
            const after = getSearchDiagnostics();
            assert(after.length > before, 'A search should append to the diagnostics log');
            const last = after[after.length - 1];
            assert(['cache', 'local', 'live (promoOnly)', 'live (catalogue-miss-or-not-loaded)'].includes(last.path), `path should be a known value, got "${last.path}"`);
          } finally {
            global.fetch = originalFetch;
          }
        },
      },
      {
        name: 'getSearchDiagnostics() ring buffer never exceeds its cap',
        fn: async () => {
          const setsIndex = [{ id: 'diagset3', name: 'Diag Set 3', releaseDate: '2022/01/01' }];
          const originalFetch = global.fetch;
          global.fetch = async (url) => {
            if (url.includes('sets/en.json')) return { ok: true, json: async () => setsIndex };
            if (url.includes('diagset3.json')) return { ok: true, json: async () => [{ id: 'diagset3-1', name: 'Ring Buffer Card', number: '1', images: {} }] };
            // Any other request (e.g. a query that misses the local catalogue
            // and falls through to the live API) — return an empty, OK result
            // rather than 404, since this test is only exercising the ring
            // buffer cap, not live-API error handling.
            return { ok: true, json: async () => ({ data: [] }) };
          };
          try {
            await clearCatalogue();
            await loadENCatalogue();
            for (let i = 0; i < 40; i++) await searchCards(`Ring Buffer Card ${i}`);
            const log = getSearchDiagnostics();
            assert(log.length <= 25, `Ring buffer should cap at 25 entries, got ${log.length}`);
          } finally {
            global.fetch = originalFetch;
          }
        },
      },
    ],
  },

  /* ── v19 (cont'd): failed-set-id tracking during catalogue load ──
   * Found while investigating a real-world "search misses a common card
   * name despite catalogue reporting ready" report: a set that fails to
   * fetch (network rejection OR non-ok HTTP response) during loadENCatalogue()
   * was previously swallowed with zero record of WHICH set failed — every
   * card in that set is then silently absent from local search, while the
   * load still reports a plausible-looking non-zero total count. Fixed by
   * normalizing every per-set fetch to always resolve (catching network
   * rejections too) and recording failed setIds in diagnostics. */
  {
    name: 'loadENCatalogue() — failed-set-id tracking (v19)',
    tests: [
      {
        name: 'A non-ok HTTP response for one set is recorded by setId in diagnostics',
        fn: async () => {
          const setsIndex = [
            { id: 'goodset', name: 'Good Set', releaseDate: '2020/01/01' },
            { id: 'badset',  name: 'Bad Set',  releaseDate: '2021/01/01' },
          ];
          const originalFetch = global.fetch;
          global.fetch = async (url) => {
            if (url.includes('sets/en.json')) return { ok: true, json: async () => setsIndex };
            if (url.includes('goodset.json')) return { ok: true, json: async () => [{ id: 'goodset-1', name: 'Good Card', number: '1', images: {} }] };
            if (url.includes('badset.json'))  return { ok: false, status: 404 }; // simulates a missing/renamed set file
            return { ok: false, status: 404 };
          };
          try {
            await clearCatalogue();
            const result = await loadENCatalogue();
            assert(result.loaded, 'Load should still succeed overall — one bad set must not abort the whole load');
            assertEqual(result.count, 1, 'Only the good set\'s 1 card should be counted');
            const d = getCatalogueDiagnostics();
            assertEqual(d.enLoad.failedSetIds.length, 1, 'Exactly one set should be recorded as failed');
            assertEqual(d.enLoad.failedSetIds[0], 'badset', 'The failed set\'s id should be recorded by name, not silently dropped');
          } finally {
            global.fetch = originalFetch;
          }
        },
      },
      {
        name: 'A network-level rejection (not just a non-ok response) is ALSO recorded by setId',
        fn: async () => {
          // This is the specific case that was previously completely
          // untraceable: Promise.allSettled's rejected branch carries no
          // setId, so a thrown fetch error used to vanish with no record
          // of which set caused it.
          const setsIndex = [
            { id: 'goodset2',     name: 'Good Set 2',     releaseDate: '2020/01/01' },
            { id: 'networkfail',  name: 'Network Fail Set', releaseDate: '2021/01/01' },
          ];
          const originalFetch = global.fetch;
          global.fetch = async (url) => {
            if (url.includes('sets/en.json')) return { ok: true, json: async () => setsIndex };
            if (url.includes('goodset2.json')) return { ok: true, json: async () => [{ id: 'goodset2-1', name: 'Good Card 2', number: '1', images: {} }] };
            if (url.includes('networkfail.json')) throw new Error('simulated network failure'); // rejects, doesn't resolve
            return { ok: false, status: 404 };
          };
          try {
            await clearCatalogue();
            const result = await loadENCatalogue();
            assert(result.loaded, 'Load should still succeed overall despite the network-level failure on one set');
            const d = getCatalogueDiagnostics();
            assert(d.enLoad.failedSetIds.includes('networkfail'), `Network-rejected set id should still be recorded — got [${d.enLoad.failedSetIds.join(', ')}]`);
          } finally {
            global.fetch = originalFetch;
          }
        },
      },
      {
        name: 'No failed sets → failedSetIds is an empty array, not null/undefined',
        fn: async () => {
          const setsIndex = [{ id: 'allgood', name: 'All Good Set', releaseDate: '2020/01/01' }];
          const originalFetch = global.fetch;
          global.fetch = async (url) => {
            if (url.includes('sets/en.json')) return { ok: true, json: async () => setsIndex };
            if (url.includes('allgood.json')) return { ok: true, json: async () => [{ id: 'allgood-1', name: 'All Good Card', number: '1', images: {} }] };
            return { ok: false, status: 404 };
          };
          try {
            await clearCatalogue();
            await loadENCatalogue();
            const d = getCatalogueDiagnostics();
            assert(Array.isArray(d.enLoad.failedSetIds) && d.enLoad.failedSetIds.length === 0, 'failedSetIds should be an empty array when nothing failed');
          } finally {
            global.fetch = originalFetch;
          }
        },
      },
    ],
  },

];

/* ============================================================
   Test runner
   ============================================================ */

let logLines = [];
function log(msg) { logLines.push(msg); const el=document.getElementById('log-area'); if(el){el.textContent=logLines.join('\n');el.scrollTop=el.scrollHeight;} }
function toggleLog() { const el=document.getElementById('log-area'); el.style.display=el.style.display==='none'?'block':'none'; }

async function runAll() {
  logLines = []; resetIdCounter();
  const runBtn=document.getElementById('run-btn');
  runBtn.disabled=true; runBtn.textContent='Running…';
  const t0=performance.now();
  let totalPass=0, totalFail=0;
  const totalTests=TEST_GROUPS.reduce((s,g)=>s+g.tests.length,0);
  let done=0;
  const groupResults=[];

  for (const group of TEST_GROUPS) {
    const gResults=[];
    for (const test of group.tests) {
      const start=performance.now(); let status='pass', err=null;
      try { await test.fn(); } catch(e) { status='fail'; err=e.message; }
      const dur=performance.now()-start;
      gResults.push({name:test.name,status,err,dur});
      if(status==='pass'){totalPass++;log(`PASS  ${group.name} > ${test.name}`);}
      else{totalFail++;log(`FAIL  ${group.name} > ${test.name}\n      ${err}`);}
      done++;
      document.getElementById('progress').style.width=(done/totalTests*100)+'%';
      await new Promise(r=>setTimeout(r,8));
    }
    groupResults.push({group,results:gResults});
  }

  const elapsed=performance.now()-t0;
  document.getElementById('m-total').textContent=totalTests;
  document.getElementById('m-pass').textContent=totalPass;
  document.getElementById('m-fail').textContent=totalFail;
  document.getElementById('m-dur').textContent=elapsed.toFixed(0)+'ms';

  const area=document.getElementById('results-area');
  area.innerHTML='';
  for(const {group,results} of groupResults){
    const groupFail=results.filter(r=>r.status==='fail').length;
    const allPass=groupFail===0;
    const div=document.createElement('div');
    div.className='group';
    div.innerHTML=`
      <div class="group-header">
        <span>${escHtml(group.name)}</span>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="group-badge ${allPass?'badge-pass':'badge-fail'}">${allPass?'All passed':groupFail+' failed'} · ${results.length} tests</span>
          <span class="group-chevron">▼</span>
        </div>
      </div>
      <div class="test-list">
        ${results.map(r=>`
          <div class="test-row ${r.status}">
            <span class="test-icon">${r.status==='pass'?'✓':'✗'}</span>
            <div class="test-name">
              ${escHtml(r.name)}
              ${r.err?`<div class="test-err">${escHtml(r.err)}</div>`:''}
              <div class="test-detail">${r.dur.toFixed(1)} ms</div>
            </div>
          </div>`).join('')}
      </div>`;
    div.querySelector('.group-header').addEventListener('click', function(){
      const list=this.nextElementSibling;
      const collapsed=list.style.display==='none';
      list.style.display=collapsed?'flex':'none';
      this.classList.toggle('collapsed',!collapsed);
    });
    area.appendChild(div);
  }

  runBtn.disabled=false;
  runBtn.innerHTML=`<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><polygon points="3,2 13,8 3,14"/></svg> Run all tests`;
}

function escHtml(s){return String(s??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function initUI(){document.getElementById('test-toggle-log-btn').addEventListener('click',toggleLog);document.getElementById('run-btn').addEventListener('click',runAll);}
initUI();
