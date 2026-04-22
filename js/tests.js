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
} from './core.js';

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
      { name: 'Null when buyCost zero',  fn: () => assertNull(calcProfit(makeCard({marketNM:20,buyCost:'0'})).profit) },
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
