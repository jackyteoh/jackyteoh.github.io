/**
 * tests.js — unit test suite for tests.html.
 * Imports directly from core.js via ES module syntax.
 */

import {
  CONDITIONS, COND_MULT,
  makeCard, resetIdCounter, touchUpdated,
  adjPrice, calcProfit, calcActualProfit, calcPriceDelta, sortCards,
  fmt, fmtPct, fmtDate, fmtAge,
  exportCSV, parseCSV, splitCSVLine, csvRowToCard,
  generateFilename, getSeedCards,
  readPriceCache, writePriceCache, clearPriceCache, CACHE_TTL_MS,
  snapshotCards, UNDO_MAX_SNAPSHOTS,
  searchCacheKey, readSearchCache, writeSearchCache, SEARCH_CACHE_TTL_MS,
} from './core.js';

/* ============================================================
   Micro assertion library
   ============================================================ */

function assert(cond, msg)        { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg)   { if (a !== b) throw new Error(`${msg || 'Expected equal'} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
function assertClose(a, b, e=0.001, msg) { if (Math.abs(a-b) > e) throw new Error(`${msg || 'Expected ~equal'} — got ${a}, expected ${b} (±${e})`); }
function assertNull(v, msg)        { if (v !== null) throw new Error(`${msg || 'Expected null'} — got ${JSON.stringify(v)}`); }

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

  /* ── Profit & profit % ──────────────────────────────────────── */
  {
    name: 'Profit & profit % calculation',
    tests: [
      {
        name: 'Positive profit: market > buy cost',
        fn: () => { const { profit, pct } = calcProfit(makeCard({ marketNM:20, buyCost:'10', condition:'NM' })); assertClose(profit, 10); assertClose(pct, 100); },
      },
      { name: 'Negative profit: market < buy cost', fn: () => assertClose(calcProfit(makeCard({ marketNM:5, buyCost:'10', condition:'NM' })).profit, -5) },
      { name: 'Null profit when buyCost empty',      fn: () => assertNull(calcProfit(makeCard({ marketNM:20, buyCost:'' })).profit) },
      { name: 'Null profit when buyCost zero',       fn: () => assertNull(calcProfit(makeCard({ marketNM:20, buyCost:'0' })).profit) },
      { name: 'Null profit when no price data',      fn: () => assertNull(calcProfit(makeCard({ marketNM:null, priceMid:null, buyCost:'10' })).profit) },
      { name: 'Profit % 50% when buy=10, market=15', fn: () => assertClose(calcProfit(makeCard({ marketNM:15, buyCost:'10', condition:'NM' })).pct, 50) },
      { name: 'LP condition factored into profit',   fn: () => assertClose(calcProfit(makeCard({ marketNM:10, buyCost:'6', condition:'LP' })).profit, 2.5, 0.01) },
      { name: 'Breakeven: profit=0',                 fn: () => assertClose(calcProfit(makeCard({ marketNM:10, buyCost:'10', condition:'NM' })).profit, 0) },
      { name: 'pct is null when profit is null',     fn: () => assertNull(calcProfit(makeCard({ marketNM:null, buyCost:'10' })).pct) },
    ],
  },

  /* ── Actual profit (soldPrice) ──────────────────────────────── */
  {
    name: 'Actual profit — calcActualProfit()',
    tests: [
      {
        name: 'soldPrice > buyCost → positive actual profit',
        fn: () => {
          const { profit, pct } = calcActualProfit(makeCard({ buyCost:'10', soldPrice:'15' }));
          assertClose(profit, 5); assertClose(pct, 50);
        },
      },
      {
        name: 'soldPrice < buyCost → negative actual profit',
        fn: () => assertClose(calcActualProfit(makeCard({ buyCost:'20', soldPrice:'15' })).profit, -5),
      },
      { name: 'Null when soldPrice is empty',  fn: () => assertNull(calcActualProfit(makeCard({ buyCost:'10', soldPrice:'' })).profit) },
      { name: 'Null when soldPrice is zero',   fn: () => assertNull(calcActualProfit(makeCard({ buyCost:'10', soldPrice:'0' })).profit) },
      { name: 'Null when buyCost is empty',    fn: () => assertNull(calcActualProfit(makeCard({ buyCost:'', soldPrice:'15' })).profit) },
      {
        name: 'soldPrice survives CSV round-trip',
        fn: () => {
          const card = makeCard({ soldPrice:'42.50' });
          const rows = parseCSV(exportCSV([card]));
          assertEqual(rows[0].soldPrice, '42.50');
        },
      },
      {
        name: 'soldPrice defaults to empty string in makeCard',
        fn: () => assertEqual(makeCard().soldPrice, ''),
      },
    ],
  },

  /* ── Price delta ────────────────────────────────────────────── */
  {
    name: 'Price delta — calcPriceDelta()',
    tests: [
      {
        name: 'Returns positive delta when price increased',
        fn: () => assertClose(calcPriceDelta(makeCard({ marketNM:52, prevMarketNM:48 })), 4),
      },
      {
        name: 'Returns negative delta when price decreased',
        fn: () => assertClose(calcPriceDelta(makeCard({ marketNM:45, prevMarketNM:50 })), -5),
      },
      {
        name: 'Returns 0 when price unchanged',
        fn: () => assertClose(calcPriceDelta(makeCard({ marketNM:20, prevMarketNM:20 })), 0),
      },
      {
        name: 'Returns null when prevMarketNM is null',
        fn: () => assertNull(calcPriceDelta(makeCard({ marketNM:20, prevMarketNM:null }))),
      },
      {
        name: 'Returns null when marketNM is null',
        fn: () => assertNull(calcPriceDelta(makeCard({ marketNM:null, prevMarketNM:20 }))),
      },
      {
        name: 'prevMarketNM survives CSV round-trip',
        fn: () => {
          const card = makeCard({ marketNM:55, prevMarketNM:50 });
          const rows = parseCSV(exportCSV([card]));
          assertClose(parseFloat(rows[0].prevMarketNM), 50);
        },
      },
    ],
  },

  /* ── fmt() and fmtPct() ─────────────────────────────────────── */
  {
    name: 'fmt() and fmtPct() display formatting',
    tests: [
      { name: 'fmt: positive number',         fn: () => assertEqual(fmt(3.5),      '$3.50') },
      { name: 'fmt: zero',                    fn: () => assertEqual(fmt(0),         '$0.00') },
      { name: 'fmt: null → —',                fn: () => assertEqual(fmt(null),      '—')     },
      { name: 'fmt: undefined → —',           fn: () => assertEqual(fmt(undefined), '—')     },
      { name: 'fmt: NaN → —',                 fn: () => assertEqual(fmt(NaN),       '—')     },
      { name: 'fmt: custom decimals (0)',      fn: () => assertEqual(fmt(1.5, 0),    '$2')    },
      { name: 'fmtPct: positive → + sign',    fn: () => assertEqual(fmtPct(50),     '+50.0%') },
      { name: 'fmtPct: negative → no + sign', fn: () => assertEqual(fmtPct(-20),    '-20.0%') },
      { name: 'fmtPct: null → —',             fn: () => assertEqual(fmtPct(null),   '—')     },
      { name: 'fmtPct: NaN → —',              fn: () => assertEqual(fmtPct(NaN),    '—')     },
    ],
  },

  /* ── fmtAge() ───────────────────────────────────────────────── */
  {
    name: 'fmtAge()',
    tests: [
      { name: 'Under 60s → seconds',    fn: () => assertEqual(fmtAge(30_000),     '30s ago')    },
      { name: 'Exactly 60s → 1m ago',   fn: () => assertEqual(fmtAge(60_000),     '1m ago')     },
      { name: '90 min → 1h 30m ago',    fn: () => assertEqual(fmtAge(90*60_000),  '1h 30m ago') },
      { name: 'Exactly 2h → 2h ago',    fn: () => assertEqual(fmtAge(2*3600_000), '2h ago')     },
      { name: 'null → "never"',          fn: () => assertEqual(fmtAge(null),       'never')      },
      { name: 'undefined → "never"',    fn: () => assertEqual(fmtAge(undefined),  'never')      },
    ],
  },

  /* ── CSV round-trip ─────────────────────────────────────────── */
  {
    name: 'CSV export & import round-trip',
    tests: [
      {
        name: 'Header contains expected columns',
        fn: () => {
          const header = exportCSV([]).split('\n')[0];
          ['name','condition','buyCost','soldPrice','marketNM','prevMarketNM','tcgplayerId','sold','finish','dateAdded','lastUpdated']
            .forEach(col => assert(header.includes(col), `Missing header: ${col}`));
        },
      },
      {
        name: 'Single card round-trips correctly',
        fn: () => {
          const card = makeCard({ name:'Charizard', condition:'LP', buyCost:'25', soldPrice:'30', finish:'holofoil', tcgplayerId:'xy1-1' });
          const rows = parseCSV(exportCSV([card]));
          assertEqual(rows.length, 1);
          assertEqual(rows[0].name, 'Charizard'); assertEqual(rows[0].condition, 'LP');
          assertEqual(rows[0].buyCost, '25');     assertEqual(rows[0].soldPrice, '30');
        },
      },
      { name: 'sold=true survives',  fn: () => { const r=parseCSV(exportCSV([makeCard({sold:true})]));  assertEqual(r[0].sold,'true');  } },
      { name: 'sold=false survives', fn: () => { const r=parseCSV(exportCSV([makeCard({sold:false})])); assertEqual(r[0].sold,'false'); } },
      {
        name: 'Name with commas survives',
        fn: () => assertEqual(parseCSV(exportCSV([makeCard({name:'Pikachu, base set'})]))[0].name, 'Pikachu, base set'),
      },
      {
        name: 'Multiple cards all export',
        fn: () => {
          const rows = parseCSV(exportCSV([makeCard({name:'A'}), makeCard({name:'B'}), makeCard({name:'C'})]));
          assertEqual(rows.length, 3); assertEqual(rows[2].name, 'C');
        },
      },
      { name: 'Header-only CSV returns []', fn: () => assertEqual(parseCSV(exportCSV([])).length, 0) },
      {
        name: 'csvRowToCard restores condition',
        fn: () => assertEqual(csvRowToCard(parseCSV(exportCSV([makeCard({condition:'MP'})]))[0]).condition, 'MP'),
      },
      {
        name: 'csvRowToCard defaults invalid condition to NM',
        fn: () => assertEqual(csvRowToCard({ condition:'INVALID' }).condition, 'NM'),
      },
    ],
  },

  /* ── Sparse CSV import ───────────────────────────────────────── */
  {
    name: 'Sparse CSV import — missing columns use safe defaults',
    tests: [
      {
        name: 'name-only CSV produces a valid card',
        fn: () => {
          const csv  = 'name\n"Charizard"';
          const rows = parseCSV(csv);
          const card = csvRowToCard(rows[0]);
          assertEqual(card.name, 'Charizard');
          assertEqual(card.condition, 'NM');      // default
          assertEqual(card.finish, 'normal');     // default
          assertEqual(card.sold, false);          // default
          assertNull(card.marketNM);              // default
          assertEqual(card.soldPrice, '');        // default
        },
      },
      {
        name: 'name + buyCost CSV populates both correctly',
        fn: () => {
          const csv  = 'name,buyCost\n"Pikachu","12.50"';
          const card = csvRowToCard(parseCSV(csv)[0]);
          assertEqual(card.name, 'Pikachu');
          assertEqual(card.buyCost, '12.50');
          assertNull(card.marketNM);
        },
      },
      {
        name: 'sold column read as boolean from "true" string',
        fn: () => {
          const csv  = 'name,sold\n"Mewtwo","true"';
          const card = csvRowToCard(parseCSV(csv)[0]);
          assertEqual(card.sold, true);
        },
      },
    ],
  },

  /* ── makeCard defaults ───────────────────────────────────────── */
  {
    name: 'makeCard defaults & overrides',
    tests: [
      { name: 'Default condition is NM',        fn: () => assertEqual(makeCard().condition,   'NM')    },
      { name: 'Default finish is normal',        fn: () => assertEqual(makeCard().finish,      'normal') },
      { name: 'Default sold is false',           fn: () => assertEqual(makeCard().sold,        false)   },
      { name: 'Default marketNM is null',        fn: () => assertNull(makeCard().marketNM)             },
      { name: 'Default prevMarketNM is null',    fn: () => assertNull(makeCard().prevMarketNM)         },
      { name: 'Default soldPrice is empty',      fn: () => assertEqual(makeCard().soldPrice,   '')      },
      { name: 'Default tcgplayerId is empty',    fn: () => assertEqual(makeCard().tcgplayerId, '')      },
      {
        name: 'Override fields applied',
        fn: () => { const c = makeCard({ name:'Mewtwo', buyCost:'50', condition:'HP' }); assertEqual(c.name,'Mewtwo'); assertEqual(c.condition,'HP'); },
      },
      { name: 'Each call gets a unique id', fn: () => assert(makeCard().id !== makeCard().id) },
    ],
  },

  /* ── Condition list ──────────────────────────────────────────── */
  {
    name: 'Condition list completeness',
    tests: [
      { name: 'All 5 conditions in COND_MULT',    fn: () => ['NM','LP','MP','HP','DMG'].forEach(c => assert(COND_MULT[c] !== undefined, `Missing: ${c}`)) },
      { name: 'NM multiplier is exactly 1.0',     fn: () => assertEqual(COND_MULT.NM, 1.0) },
      { name: 'All multipliers between 0 and 1',  fn: () => Object.values(COND_MULT).forEach(v => assert(v > 0 && v <= 1, `Out of range: ${v}`)) },
      { name: 'Multipliers strictly decreasing',  fn: () => { const v=['NM','LP','MP','HP','DMG'].map(c=>COND_MULT[c]); for(let i=1;i<v.length;i++) assert(v[i]<v[i-1]); } },
      { name: 'CONDITIONS array has 5 entries',   fn: () => { assertEqual(CONDITIONS.length, 5); ['NM','LP','MP','HP','DMG'].forEach(c => assert(CONDITIONS.includes(c))); } },
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
      { name: 'Both fields survive CSV round-trip',     fn: () => { const iso='2024-06-01T12:00:00.000Z'; const rows=parseCSV(exportCSV([makeCard({dateAdded:iso,lastUpdated:iso})])); assertEqual(rows[0].dateAdded, iso); } },
      { name: 'fmtDate: null → —',                     fn: () => assertEqual(fmtDate(null), '—') },
      { name: 'fmtDate: invalid → —',                  fn: () => assertEqual(fmtDate('not-a-date'), '—') },
      { name: 'fmtDate: valid ISO → non-empty string',  fn: () => { const r=fmtDate('2024-04-10T14:30:00.000Z'); assert(r.length>3 && r!=='—'); } },
    ],
  },

  /* ── Sorting ─────────────────────────────────────────────────── */
  {
    name: 'Sorting — sortCards()',
    tests: [
      {
        name: 'Name ascending A→Z',
        fn: () => { const sorted=sortCards([makeCard({name:'Z'}),makeCard({name:'A'})],'name','asc'); assertEqual(sorted[0].name,'A'); },
      },
      {
        name: 'buyCost numeric ascending',
        fn: () => { const sorted=sortCards([makeCard({buyCost:'30'}),makeCard({buyCost:'5'})],'buyCost','asc'); assertEqual(sorted[0].buyCost,'5'); },
      },
      {
        name: 'Null values sort last in both directions',
        fn: () => {
          const a=makeCard({marketNM:20}), b=makeCard({marketNM:null}), c=makeCard({marketNM:5});
          const asc=sortCards([b,a,c],'marketNM','asc');
          assertNull(asc[asc.length-1].marketNM);
        },
      },
      {
        name: 'Does not mutate original array',
        fn: () => { const input=[makeCard({name:'B'}),makeCard({name:'A'})]; sortCards(input,'name','asc'); assertEqual(input[0].name,'B'); },
      },
      {
        name: 'priceDelta sorting — higher delta first',
        fn: () => {
          const a=makeCard({marketNM:52, prevMarketNM:48}); // delta=+4
          const b=makeCard({marketNM:45, prevMarketNM:50}); // delta=-5
          const sorted=sortCards([b,a],'priceDelta','desc');
          assertClose(sorted[0].marketNM-sorted[0].prevMarketNM, 4, 0.01);
        },
      },
    ],
  },

  /* ── Undo snapshot ───────────────────────────────────────────── */
  {
    name: 'Undo — snapshotCards()',
    tests: [
      {
        name: 'snapshotCards returns a deep clone (not same reference)',
        fn: () => {
          const cards    = [makeCard({ name:'Original' })];
          const snapshot = snapshotCards(cards);
          cards[0].name  = 'Modified';
          assertEqual(snapshot[0].name, 'Original');
        },
      },
      {
        name: 'snapshotCards preserves all fields',
        fn: () => {
          const card = makeCard({ name:'Pikachu', buyCost:'10', soldPrice:'15', marketNM:20, prevMarketNM:18, sold:true });
          const snap = snapshotCards([card])[0];
          assertEqual(snap.name,         'Pikachu');
          assertEqual(snap.soldPrice,    '15');
          assertClose(snap.prevMarketNM, 18);
          assertEqual(snap.sold,         true);
        },
      },
      {
        name: 'UNDO_MAX_SNAPSHOTS is a positive integer',
        fn: () => { assert(Number.isInteger(UNDO_MAX_SNAPSHOTS) && UNDO_MAX_SNAPSHOTS > 0); },
      },
      {
        name: 'Snapshot of empty array is an empty array',
        fn: () => { const snap = snapshotCards([]); assertEqual(snap.length, 0); },
      },
    ],
  },

  /* ── generateFilename ───────────────────────────────────────── */
  {
    name: 'generateFilename()',
    tests: [
      { name: 'Ends with .csv',            fn: () => assert(generateFilename().endsWith('.csv'))           },
      { name: 'Starts with tcg-tracker-',  fn: () => assert(generateFilename().startsWith('tcg-tracker-')) },
      { name: "Contains today's year",     fn: () => assert(generateFilename().includes(String(new Date().getFullYear()))) },
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
        fn: () => {
          writePriceCache('card-a', { normal:{ market:5 } });
          writePriceCache('card-b', { holofoil:{ market:20 } });
          clearPriceCache();
          assertNull(readPriceCache('card-a')); assertNull(readPriceCache('card-b'));
        },
      },
      { name: 'CACHE_TTL_MS is a positive number', fn: () => assert(typeof CACHE_TTL_MS === 'number' && CACHE_TTL_MS > 0) },
    ],
  },

  /* ── Search cache ────────────────────────────────────────────── */
  {
    name: 'Search cache (localStorage)',
    tests: [
      {
        name: 'searchCacheKey is deterministic',
        fn: () => assertEqual(searchCacheKey('Charizard','Evolving Skies',false), searchCacheKey('charizard','evolving skies',false)),
      },
      {
        name: 'JP flag produces a different key',
        fn: () => { const en=searchCacheKey('Pikachu','',false); const jp=searchCacheKey('Pikachu','',true); assert(en !== jp); },
      },
      {
        name: 'writeSearchCache then readSearchCache returns results',
        fn: () => {
          clearPriceCache(); // also clears search cache entries
          const key     = searchCacheKey('mew-test');
          const results = [{ id:'test-1', name:'Mew' }];
          writeSearchCache(key, results);
          const cached = readSearchCache(key);
          assert(cached !== null); assertEqual(JSON.stringify(cached), JSON.stringify(results));
          clearPriceCache();
        },
      },
      {
        name: 'readSearchCache returns null for unknown key',
        fn: () => assertNull(readSearchCache('tcg_search_nonexistent|||||')),
      },
      { name: 'SEARCH_CACHE_TTL_MS is a positive number', fn: () => assert(typeof SEARCH_CACHE_TTL_MS === 'number' && SEARCH_CACHE_TTL_MS > 0) },
      { name: 'SEARCH_CACHE_TTL_MS ≤ 24 h (reasonable TTL)', fn: () => assert(SEARCH_CACHE_TTL_MS <= 24 * 3600 * 1000) },
    ],
  },

  /* ── Seed data ───────────────────────────────────────────────── */
  {
    name: 'Seed data — getSeedCards()',
    tests: [
      { name: 'Returns a non-empty array',         fn: () => { const s=getSeedCards(); assert(Array.isArray(s) && s.length>0); } },
      { name: 'Every card has a non-empty name',   fn: () => getSeedCards().forEach((c,i) => assert(c.name.length>0, `Card ${i} has empty name`)) },
      { name: 'Every card has a valid condition',  fn: () => getSeedCards().forEach(c => assert(CONDITIONS.includes(c.condition))) },
      { name: 'Every card has a valid dateAdded',  fn: () => getSeedCards().forEach(c => assert(!isNaN(new Date(c.dateAdded)))) },
      { name: 'soldPrice field exists on all cards',fn: () => getSeedCards().forEach(c => assert('soldPrice' in c, `Missing soldPrice on ${c.name}`)) },
      { name: 'prevMarketNM field exists on all',  fn: () => getSeedCards().forEach(c => assert('prevMarketNM' in c, `Missing prevMarketNM on ${c.name}`)) },
    ],
  },

];

/* ============================================================
   Test runner
   ============================================================ */

let logLines = [];

function log(msg) {
  logLines.push(msg);
  const el = document.getElementById('log-area');
  if (el) { el.textContent = logLines.join('\n'); el.scrollTop = el.scrollHeight; }
}

function toggleLog() {
  const el = document.getElementById('log-area');
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

async function runAll() {
  logLines = [];
  resetIdCounter();
  const runBtn = document.getElementById('run-btn');
  runBtn.disabled    = true;
  runBtn.textContent = 'Running…';

  const t0         = performance.now();
  let totalPass    = 0, totalFail = 0;
  const totalTests = TEST_GROUPS.reduce((s, g) => s + g.tests.length, 0);
  let done         = 0;
  const groupResults = [];

  for (const group of TEST_GROUPS) {
    const gResults = [];
    for (const test of group.tests) {
      const start = performance.now();
      let status = 'pass', err = null;
      try   { await test.fn(); }
      catch (e) { status = 'fail'; err = e.message; }
      const dur = performance.now() - start;
      gResults.push({ name: test.name, status, err, dur });
      if (status === 'pass') { totalPass++; log(`PASS  ${group.name} > ${test.name}`); }
      else                   { totalFail++; log(`FAIL  ${group.name} > ${test.name}\n      ${err}`); }
      done++;
      document.getElementById('progress').style.width = (done / totalTests * 100) + '%';
      await new Promise(r => setTimeout(r, 8));
    }
    groupResults.push({ group, results: gResults });
  }

  const elapsed = performance.now() - t0;
  document.getElementById('m-total').textContent = totalTests;
  document.getElementById('m-pass').textContent  = totalPass;
  document.getElementById('m-fail').textContent  = totalFail;
  document.getElementById('m-dur').textContent   = elapsed.toFixed(0) + 'ms';

  const area = document.getElementById('results-area');
  area.innerHTML = '';

  for (const { group, results } of groupResults) {
    const groupFail = results.filter(r => r.status === 'fail').length;
    const allPass   = groupFail === 0;
    const div       = document.createElement('div');
    div.className   = 'group';
    div.innerHTML   = `
      <div class="group-header">
        <span>${escHtml(group.name)}</span>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="group-badge ${allPass ? 'badge-pass' : 'badge-fail'}">
            ${allPass ? 'All passed' : groupFail + ' failed'} · ${results.length} tests
          </span>
          <span class="group-chevron">▼</span>
        </div>
      </div>
      <div class="test-list">
        ${results.map(r => `
          <div class="test-row ${r.status}">
            <span class="test-icon">${r.status === 'pass' ? '✓' : '✗'}</span>
            <div class="test-name">
              ${escHtml(r.name)}
              ${r.err ? `<div class="test-err">${escHtml(r.err)}</div>` : ''}
              <div class="test-detail">${r.dur.toFixed(1)} ms</div>
            </div>
          </div>`).join('')}
      </div>`;

    div.querySelector('.group-header').addEventListener('click', function () {
      const list = this.nextElementSibling;
      const collapsed = list.style.display === 'none';
      list.style.display = collapsed ? 'flex' : 'none';
      this.classList.toggle('collapsed', !collapsed);
    });
    area.appendChild(div);
  }

  runBtn.disabled  = false;
  runBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><polygon points="3,2 13,8 3,14"/></svg> Run all tests`;
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function initUI() {
  document.getElementById('test-toggle-log-btn').addEventListener('click', toggleLog);
  document.getElementById('run-btn').addEventListener('click', runAll);
}

initUI();
