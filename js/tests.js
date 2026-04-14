/**
 * tests.js — unit test suite for tests.html.
 * Imports directly from core.js via ES module syntax.
 */

import {
  CONDITIONS, COND_MULT, FINISH_LABELS,
  makeCard, resetIdCounter, touchUpdated,
  adjPrice, calcProfit, sortCards,
  fmt, fmtPct, fmtDate, fmtAge,
  exportCSV, parseCSV, splitCSVLine, csvRowToCard,
  generateFilename, getSeedCards,
  readPriceCache, writePriceCache, clearPriceCache, CACHE_TTL_MS,
} from './core.js';

/* ============================================================
   Micro assertion library
   ============================================================ */

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(
      `${msg || 'Expected equal'} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`
    );
  }
}

function assertClose(actual, expected, eps = 0.001, msg) {
  if (Math.abs(actual - expected) > eps) {
    throw new Error(
      `${msg || 'Expected ~equal'} — got ${actual}, expected ${expected} (±${eps})`
    );
  }
}

function assertNull(val, msg) {
  if (val !== null) throw new Error(`${msg || 'Expected null'} — got ${JSON.stringify(val)}`);
}

/* ============================================================
   Test groups
   ============================================================ */

const TEST_GROUPS = [

  {
    name: 'Condition multipliers & adjusted price',
    tests: [
      { name: 'NM uses 1.0×',  fn: () => assertClose(adjPrice(makeCard({ marketNM:10, condition:'NM'  })), 10)  },
      { name: 'LP uses 0.85×', fn: () => assertClose(adjPrice(makeCard({ marketNM:10, condition:'LP'  })), 8.5) },
      { name: 'MP uses 0.70×', fn: () => assertClose(adjPrice(makeCard({ marketNM:10, condition:'MP'  })), 7.0) },
      { name: 'HP uses 0.50×', fn: () => assertClose(adjPrice(makeCard({ marketNM:10, condition:'HP'  })), 5.0) },
      { name: 'DMG uses 0.30×',fn: () => assertClose(adjPrice(makeCard({ marketNM:10, condition:'DMG' })), 3.0) },
      {
        name: 'Falls back to priceMid when marketNM is null',
        fn: () => assertClose(adjPrice(makeCard({ marketNM:null, priceMid:8, condition:'NM' })), 8),
      },
      {
        name: 'Returns 0 when all prices are null',
        fn: () => assertClose(adjPrice(makeCard({ marketNM:null, priceMid:null, condition:'NM' })), 0),
      },
      {
        name: 'Condition multiplier applied on priceMid fallback',
        fn: () => assertClose(adjPrice(makeCard({ marketNM:null, priceMid:10, condition:'LP' })), 8.5),
      },
      {
        name: 'marketNM takes priority over priceMid',
        fn: () => assertClose(adjPrice(makeCard({ marketNM:20, priceMid:5, condition:'NM' })), 20),
      },
    ],
  },

  {
    name: 'Profit & profit % calculation',
    tests: [
      {
        name: 'Positive profit: market > buy cost',
        fn: () => {
          const { profit, pct } = calcProfit(makeCard({ marketNM:20, buyCost:'10', condition:'NM' }));
          assertClose(profit, 10); assertClose(pct, 100);
        },
      },
      {
        name: 'Negative profit: market < buy cost',
        fn: () => assertClose(calcProfit(makeCard({ marketNM:5, buyCost:'10', condition:'NM' })).profit, -5),
      },
      { name: 'Null profit when buyCost is empty', fn: () => assertNull(calcProfit(makeCard({ marketNM:20, buyCost:'' })).profit) },
      { name: 'Null profit when buyCost is zero',  fn: () => assertNull(calcProfit(makeCard({ marketNM:20, buyCost:'0' })).profit) },
      { name: 'Null profit when no price data',    fn: () => assertNull(calcProfit(makeCard({ marketNM:null, priceMid:null, buyCost:'10' })).profit) },
      {
        name: 'Profit % is 50% when buy=10, market=15 NM',
        fn: () => assertClose(calcProfit(makeCard({ marketNM:15, buyCost:'10', condition:'NM' })).pct, 50),
      },
      {
        name: 'Condition multiplier factored into profit (LP)',
        fn: () => assertClose(calcProfit(makeCard({ marketNM:10, buyCost:'6', condition:'LP' })).profit, 2.5, 0.01),
      },
      {
        name: 'Breakeven: profit=0',
        fn: () => assertClose(calcProfit(makeCard({ marketNM:10, buyCost:'10', condition:'NM' })).profit, 0),
      },
      { name: 'pct is null when profit is null', fn: () => assertNull(calcProfit(makeCard({ marketNM:null, buyCost:'10' })).pct) },
    ],
  },

  {
    name: 'fmt() and fmtPct() display formatting',
    tests: [
      { name: 'fmt: positive number',          fn: () => assertEqual(fmt(3.5),       '$3.50') },
      { name: 'fmt: zero',                     fn: () => assertEqual(fmt(0),          '$0.00') },
      { name: 'fmt: null → —',                 fn: () => assertEqual(fmt(null),       '—')    },
      { name: 'fmt: undefined → —',            fn: () => assertEqual(fmt(undefined),  '—')    },
      { name: 'fmt: NaN → —',                  fn: () => assertEqual(fmt(NaN),        '—')    },
      { name: 'fmt: custom decimals (0)',       fn: () => assertEqual(fmt(1.5, 0),     '$2')   },
      { name: 'fmtPct: positive → + sign',     fn: () => assertEqual(fmtPct(50),      '+50.0%') },
      { name: 'fmtPct: negative → no + sign',  fn: () => assertEqual(fmtPct(-20),     '-20.0%') },
      { name: 'fmtPct: null → —',              fn: () => assertEqual(fmtPct(null),    '—')    },
      { name: 'fmtPct: NaN → —',               fn: () => assertEqual(fmtPct(NaN),     '—')    },
      { name: 'fmt: large number',             fn: () => assertEqual(fmt(1234.5),    '$1234.50') },
    ],
  },

  {
    name: 'fmtAge()',
    tests: [
      { name: 'Under 60s shows seconds',      fn: () => assertEqual(fmtAge(30_000),      '30s ago') },
      { name: 'Exactly 60s shows 1m ago',     fn: () => assertEqual(fmtAge(60_000),      '1m ago') },
      { name: '90 min shows 1h 30m ago',      fn: () => assertEqual(fmtAge(90*60_000),   '1h 30m ago') },
      { name: 'Exactly 2h shows 2h ago',      fn: () => assertEqual(fmtAge(2*3600_000),  '2h ago') },
      { name: 'null returns "never"',          fn: () => assertEqual(fmtAge(null),        'never') },
      { name: 'undefined returns "never"',    fn: () => assertEqual(fmtAge(undefined),   'never') },
    ],
  },

  {
    name: 'CSV export & import round-trip',
    tests: [
      {
        name: 'Exported header contains expected columns',
        fn: () => {
          const header = exportCSV([]).split('\n')[0];
          ['name','condition','buyCost','marketNM','tcgplayerId','sold','finish','dateAdded','lastUpdated']
            .forEach(col => assert(header.includes(col), `Missing header: ${col}`));
        },
      },
      {
        name: 'Single card round-trips correctly',
        fn: () => {
          const card = makeCard({ name:'Charizard', condition:'LP', buyCost:'25', finish:'holofoil', tcgplayerId:'xy1-1' });
          const rows = parseCSV(exportCSV([card]));
          assertEqual(rows.length, 1);
          assertEqual(rows[0].name,        'Charizard');
          assertEqual(rows[0].condition,   'LP');
          assertEqual(rows[0].buyCost,     '25');
          assertEqual(rows[0].finish,      'holofoil');
          assertEqual(rows[0].tcgplayerId, 'xy1-1');
        },
      },
      {
        name: 'Numeric price fields survive round-trip',
        fn: () => {
          const card = makeCard({ marketNM:12.50, priceLow:10.00, priceMid:11.25 });
          const rows = parseCSV(exportCSV([card]));
          assertClose(parseFloat(rows[0].marketNM), 12.50);
          assertClose(parseFloat(rows[0].priceMid), 11.25);
        },
      },
      { name: 'sold=true survives',  fn: () => { const r = parseCSV(exportCSV([makeCard({ sold:true })]));  assertEqual(r[0].sold,'true');  } },
      { name: 'sold=false survives', fn: () => { const r = parseCSV(exportCSV([makeCard({ sold:false })])); assertEqual(r[0].sold,'false'); } },
      {
        name: 'Name with commas survives',
        fn: () => {
          const rows = parseCSV(exportCSV([makeCard({ name:'Pikachu, base set' })]));
          assertEqual(rows[0].name, 'Pikachu, base set');
        },
      },
      {
        name: 'Name with double-quotes survives',
        fn: () => {
          const rows = parseCSV(exportCSV([makeCard({ name:'Pikachu "the great"' })]));
          assertEqual(rows[0].name, 'Pikachu "the great"');
        },
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

  {
    name: 'makeCard defaults & overrides',
    tests: [
      { name: 'Default condition is NM',      fn: () => assertEqual(makeCard().condition,   'NM')    },
      { name: 'Default finish is normal',     fn: () => assertEqual(makeCard().finish,      'normal') },
      { name: 'Default sold is false',        fn: () => assertEqual(makeCard().sold,        false)   },
      { name: 'Default marketNM is null',     fn: () => assertNull(makeCard().marketNM)             },
      { name: 'Default tcgplayerId is empty', fn: () => assertEqual(makeCard().tcgplayerId, '')      },
      {
        name: 'Override fields applied',
        fn: () => {
          const c = makeCard({ name:'Mewtwo', buyCost:'50', condition:'HP' });
          assertEqual(c.name, 'Mewtwo'); assertEqual(c.buyCost, '50'); assertEqual(c.condition, 'HP');
        },
      },
      { name: 'Each call gets a unique id', fn: () => assert(makeCard().id !== makeCard().id) },
    ],
  },

  {
    name: 'Condition list completeness',
    tests: [
      { name: 'All 5 conditions in COND_MULT',      fn: () => ['NM','LP','MP','HP','DMG'].forEach(c => assert(COND_MULT[c] !== undefined, `Missing: ${c}`)) },
      { name: 'NM multiplier is exactly 1.0',       fn: () => assertEqual(COND_MULT.NM, 1.0) },
      { name: 'All multipliers between 0 and 1',    fn: () => Object.values(COND_MULT).forEach(v => assert(v > 0 && v <= 1, `Out of range: ${v}`)) },
      { name: 'Multipliers strictly decreasing',    fn: () => { const v = ['NM','LP','MP','HP','DMG'].map(c => COND_MULT[c]); for(let i=1;i<v.length;i++) assert(v[i]<v[i-1]); } },
      { name: 'CONDITIONS array has 5 entries',     fn: () => { assertEqual(CONDITIONS.length, 5); ['NM','LP','MP','HP','DMG'].forEach(c => assert(CONDITIONS.includes(c))); } },
    ],
  },

  {
    name: 'splitCSVLine edge cases',
    tests: [
      { name: 'Splits unquoted fields',              fn: () => { const r = splitCSVLine('a,b,c'); assertEqual(r.length,3); assertEqual(r[1],'b'); } },
      { name: 'Quoted field with comma inside',      fn: () => { const r = splitCSVLine('"hello, world",foo'); assertEqual(r[0],'hello, world'); } },
      { name: 'Empty fields',                        fn: () => assertEqual(splitCSVLine('a,,c')[1], '') },
    ],
  },

  {
    name: 'Date fields — dateAdded & lastUpdated',
    tests: [
      { name: 'makeCard sets dateAdded to a valid ISO string',   fn: () => { const c=makeCard(); assert(!isNaN(new Date(c.dateAdded))); } },
      { name: 'makeCard sets lastUpdated to a valid ISO string', fn: () => assert(!isNaN(new Date(makeCard().lastUpdated))) },
      { name: 'dateAdded override preserved',                    fn: () => { const iso='2024-01-15T10:00:00.000Z'; assertEqual(makeCard({dateAdded:iso}).dateAdded, iso); } },
      {
        name: 'touchUpdated bumps lastUpdated',
        fn: () => { const c=makeCard({lastUpdated:'2020-01-01T00:00:00.000Z'}); touchUpdated(c); assert(c.lastUpdated>'2020-01-01T00:00:00.000Z'); },
      },
      {
        name: 'dateAdded and lastUpdated survive CSV round-trip',
        fn: () => {
          const iso='2024-06-01T12:00:00.000Z';
          const rows=parseCSV(exportCSV([makeCard({dateAdded:iso,lastUpdated:iso})]));
          assertEqual(rows[0].dateAdded, iso); assertEqual(rows[0].lastUpdated, iso);
        },
      },
      { name: 'csvRowToCard preserves dateAdded', fn: () => { const iso='2023-11-20T08:30:00.000Z'; assertEqual(csvRowToCard({dateAdded:iso}).dateAdded, iso); } },
      { name: 'fmtDate: null → —',                fn: () => assertEqual(fmtDate(null),        '—') },
      { name: 'fmtDate: empty string → —',        fn: () => assertEqual(fmtDate(''),          '—') },
      { name: 'fmtDate: invalid string → —',      fn: () => assertEqual(fmtDate('not-a-date'),'—') },
      {
        name: 'fmtDate: valid ISO → non-trivial string',
        fn: () => { const r=fmtDate('2024-04-10T14:30:00.000Z'); assert(r.length>3 && r!=='—'); },
      },
    ],
  },

  {
    name: 'Sorting — sortCards()',
    tests: [
      {
        name: 'Name ascending (A → Z)',
        fn: () => {
          const sorted = sortCards([makeCard({name:'Z'}),makeCard({name:'A'}),makeCard({name:'M'})], 'name', 'asc');
          assertEqual(sorted[0].name,'A'); assertEqual(sorted[2].name,'Z');
        },
      },
      {
        name: 'Name descending (Z → A)',
        fn: () => assertEqual(sortCards([makeCard({name:'A'}),makeCard({name:'Z'})], 'name','desc')[0].name, 'Z'),
      },
      {
        name: 'buyCost numeric ascending',
        fn: () => {
          const sorted = sortCards([makeCard({buyCost:'30'}),makeCard({buyCost:'5'}),makeCard({buyCost:'12'})], 'buyCost','asc');
          assertEqual(sorted[0].buyCost,'5'); assertEqual(sorted[2].buyCost,'30');
        },
      },
      {
        name: 'Null values sort last in both directions',
        fn: () => {
          const a=makeCard({marketNM:20}), b=makeCard({marketNM:null}), c=makeCard({marketNM:5});
          const asc=sortCards([b,a,c],'marketNM','asc'), desc=sortCards([b,a,c],'marketNM','desc');
          assertNull(asc[asc.length-1].marketNM); assertNull(desc[desc.length-1].marketNM);
        },
      },
      {
        name: 'Does not mutate original array',
        fn: () => {
          const input=[makeCard({name:'B'}),makeCard({name:'A'})];
          const sorted=sortCards(input,'name','asc');
          assertEqual(input[0].name,'B'); assertEqual(sorted[0].name,'A');
        },
      },
      {
        name: 'dateAdded ISO ascending (older first)',
        fn: () => {
          const older=makeCard({dateAdded:'2023-01-01T00:00:00.000Z'});
          const newer=makeCard({dateAdded:'2024-06-01T00:00:00.000Z'});
          assertEqual(sortCards([newer,older],'dateAdded','asc')[0].dateAdded, '2023-01-01T00:00:00.000Z');
        },
      },
      {
        name: 'Sold boolean ascending (false before true)',
        fn: () => {
          const sorted=sortCards([makeCard({sold:true}),makeCard({sold:false})],'sold','asc');
          assertEqual(sorted[0].sold, false);
        },
      },
    ],
  },

  {
    name: 'generateFilename()',
    tests: [
      { name: 'Ends with .csv',            fn: () => assert(generateFilename().endsWith('.csv'))          },
      { name: 'Starts with tcg-tracker-',  fn: () => assert(generateFilename().startsWith('tcg-tracker-')) },
      { name: "Contains today's year",     fn: () => assert(generateFilename().includes(String(new Date().getFullYear()))) },
      { name: 'Matches YYYY-MM-DD pattern',fn: () => assert(/tcg-tracker-\d{4}-\d{2}-\d{2}\.csv/.test(generateFilename())) },
    ],
  },

  {
    name: 'Seed data — getSeedCards()',
    tests: [
      { name: 'Returns a non-empty array',           fn: () => { const s=getSeedCards(); assert(Array.isArray(s) && s.length>0); } },
      { name: 'Every card has a non-empty name',     fn: () => getSeedCards().forEach((c,i) => assert(c.name.length>0, `Card ${i} has empty name`)) },
      { name: 'Every card has a valid condition',    fn: () => getSeedCards().forEach(c => assert(CONDITIONS.includes(c.condition), `Invalid condition: ${c.condition}`)) },
      { name: 'Every card has a valid dateAdded',    fn: () => getSeedCards().forEach(c => assert(!isNaN(new Date(c.dateAdded)), `Invalid dateAdded on ${c.name}`)) },
      { name: 'At least one card is marked sold',   fn: () => assert(getSeedCards().some(c => c.sold===true)) },
    ],
  },

  {
    name: 'Price cache (localStorage)',
    tests: [
      {
        name: 'writePriceCache then readPriceCache returns the prices',
        fn: () => {
          clearPriceCache();
          const prices = { normal: { market:10, low:8, mid:9 } };
          writePriceCache('test-card-1', prices);
          const cached = readPriceCache('test-card-1');
          assert(cached !== null, 'Cache should contain the entry');
          assertEqual(JSON.stringify(cached.prices), JSON.stringify(prices));
          clearPriceCache();
        },
      },
      {
        name: 'readPriceCache returns null for unknown key',
        fn: () => assertNull(readPriceCache('does-not-exist-xyz')),
      },
      {
        name: 'clearPriceCache removes all entries',
        fn: () => {
          writePriceCache('card-a', { normal:{ market:5 } });
          writePriceCache('card-b', { holofoil:{ market:20 } });
          clearPriceCache();
          assertNull(readPriceCache('card-a'));
          assertNull(readPriceCache('card-b'));
        },
      },
      {
        name: 'cachedAt timestamp is recent',
        fn: () => {
          clearPriceCache();
          const before = Date.now();
          writePriceCache('ts-test', { normal:{ market:1 } });
          const entry = readPriceCache('ts-test');
          assert(entry !== null, 'Entry should exist');
          assert(entry.cachedAt >= before, 'cachedAt should be >= time before write');
          assert(entry.cachedAt <= Date.now(), 'cachedAt should be <= now');
          clearPriceCache();
        },
      },
      {
        name: 'CACHE_TTL_MS is a positive number',
        fn: () => { assert(typeof CACHE_TTL_MS === 'number' && CACHE_TTL_MS > 0); },
      },
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
  let totalPass    = 0;
  let totalFail    = 0;
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
      await new Promise(r => setTimeout(r, 10));
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

    // Group collapse toggle — delegated on the group-header
    div.querySelector('.group-header').addEventListener('click', function () {
      const list        = this.nextElementSibling;
      const isCollapsed = list.style.display === 'none';
      list.style.display = isCollapsed ? 'flex' : 'none';
      this.classList.toggle('collapsed', !isCollapsed);
    });

    area.appendChild(div);
  }

  runBtn.disabled  = false;
  runBtn.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><polygon points="3,2 13,8 3,14"/></svg>
    Run all tests`;
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ============================================================
   initUI — wire test-page buttons (Option A, same pattern as tracker.js)
   ============================================================ */

function initUI() {
  document.getElementById('test-toggle-log-btn').addEventListener('click', toggleLog);
  document.getElementById('run-btn').addEventListener('click', runAll);
}

initUI();
