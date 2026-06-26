/**
 * tracker.tests.mjs — Node/jsdom integration tests for tracker.js (v19).
 *
 * WHY THIS FILE IS SEPARATE FROM tests.js / tests.html
 * -----------------------------------------------------
 * tests.js/tests.html only ever exercised core.js and catalogue.js (see
 * their import list) — tracker.js itself had ZERO automated coverage
 * through v16, v17, and v18, flagged as overdue tech debt in each of
 * those sessions' handoffs. tracker.js isn't import-friendly the way
 * core.js/catalogue.js are: it has no exports, it wires up the entire DOM
 * and fires network/IndexedDB side effects at module-load time (see the
 * bottom of tracker.js — `renderTable(); initUI();` run synchronously on
 * import, plus a background catalogue load and pre-warm fetches). Testing
 * it means building a real DOM matching index.html, seeding localStorage
 * BEFORE importing it, then importing it for real and reading the
 * resulting DOM back — a heavier, Node+jsdom-only harness that doesn't
 * fit tests.html's browser-only assumptions. Hence its own file.
 *
 * SCOPE
 * -----
 * Deliberately focused on the v16-v19 logic that was flagged as untested
 * (summary math, default sort, new refresh buttons) rather than attempting
 * exhaustive coverage of all ~70 functions in tracker.js. Expand this file
 * incrementally as more tracker.js logic changes, per the standing
 * "always add tests for fixes/changes" instruction in the handoff file.
 *
 * HOW TO RUN
 * ----------
 *   npm install fake-indexeddb jsdom --no-save   (if not already present)
 *   node js/tracker.tests.mjs
 * Each test imports a FRESH copy of tracker.js via a cache-busting query
 * string, because tracker.js runs module-level side effects on import and
 * Node's ESM cache would otherwise reuse the first import's already-booted
 * state for every subsequent test.
 */

import 'fake-indexeddb/auto';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const failNames = [];

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(`${msg || 'Expected equal'} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }

/**
 * Boots a fresh tracker.js instance against a fresh DOM + fresh localStorage
 * seeded with the given cards. Returns the jsdom `window` so the test can
 * inspect the resulting DOM. Each call gets an isolated jsdom + a
 * cache-busted import of tracker.js, so tests never see each other's state.
 */
async function bootTracker(seedCards, { mockFetch } = {}) {
  const dom = new JSDOM(indexHtml, { url: 'http://localhost/', runScripts: undefined });
  global.window = dom.window;
  global.document = dom.window.document;
  global.localStorage = dom.window.localStorage;
  global.fetch = mockFetch || (async () => { throw new Error('network disabled in test'); });
  global.localStorage.setItem('tcg_tracker_cards', JSON.stringify(seedCards));

  // Cache-bust so each test imports a genuinely fresh module instance —
  // tracker.js has module-level state (e.g. `cards`, `sortDir`) and
  // top-level side effects that only run once per distinct import URL.
  const modUrl = `../js/tracker.js?t=${Date.now()}_${Math.random()}`;
  await import(modUrl);

  return dom.window;
}

async function test(name, fn) {
  try {
    await fn();
    pass++;
  } catch (e) {
    fail++;
    failNames.push(`${name} -- ${e.message}`);
  }
}

function makeSeedCard(overrides) {
  return {
    id: overrides.id, name: overrides.name || 'Test Card', tcgplayerId: overrides.tcgplayerId ?? null,
    language: 'en', finish: 'normal', condition: 'NM', buyCost: overrides.buyCost ?? '0',
    marketNM: overrides.marketNM ?? null, priceLow: null, priceMid: null,
    sold: overrides.sold ?? false, soldPrice: overrides.soldPrice ?? '',
    dateAdded: overrides.dateAdded, lastUpdated: overrides.dateAdded, lastRefreshed: null,
    prevMarketNM: null, notes: '', qty: 1,
  };
}

/* ============================================================
   v16 regression: Available/Total cards + Current/Lifetime invested
   ============================================================ */
await test('Summary: "Available / Total cards" reflects unsold vs all cards', async () => {
  const seed = [
    makeSeedCard({ id: 1, buyCost: '10', sold: false, dateAdded: '2024-01-01T00:00:00.000Z' }),
    makeSeedCard({ id: 2, buyCost: '20', sold: true,  dateAdded: '2024-01-02T00:00:00.000Z' }),
    makeSeedCard({ id: 3, buyCost: '30', sold: false, dateAdded: '2024-01-03T00:00:00.000Z' }),
  ];
  const win = await bootTracker(seed);
  const text = win.document.getElementById('sum-count').textContent.trim();
  assertEqual(text, '2 / 3', 'Available (unsold) / Total should be 2 / 3');
});

await test('Summary: "Current / Lifetime invested" splits unsold-only cost from total cost', async () => {
  const seed = [
    makeSeedCard({ id: 1, buyCost: '10.00', sold: false, dateAdded: '2024-01-01T00:00:00.000Z' }),
    makeSeedCard({ id: 2, buyCost: '20.00', sold: true,  dateAdded: '2024-01-02T00:00:00.000Z' }),
    makeSeedCard({ id: 3, buyCost: '30.00', sold: false, dateAdded: '2024-01-03T00:00:00.000Z' }),
  ];
  const win = await bootTracker(seed);
  const text = win.document.getElementById('sum-cost').textContent.trim();
  // current (unsold: 10+30=40) / lifetime (all: 10+20+30=60)
  assertEqual(text, '$40.00 / $60.00', 'Current/lifetime invested should split unsold-only vs all cards');
});

await test('Summary: all-sold collection shows $0.00 current invested but correct lifetime', async () => {
  const seed = [
    makeSeedCard({ id: 1, buyCost: '15.00', sold: true, dateAdded: '2024-01-01T00:00:00.000Z' }),
  ];
  const win = await bootTracker(seed);
  assertEqual(win.document.getElementById('sum-cost').textContent.trim(), '$0.00 / $15.00');
  assertEqual(win.document.getElementById('sum-count').textContent.trim(), '0 / 1');
});

/* ============================================================
   v16 regression: default sort is oldest-first (ascending dateAdded)
   ============================================================ */
await test('Default table sort is oldest-added-first (ascending), not newest-first', async () => {
  const seed = [
    makeSeedCard({ id: 1, name: 'Third Added',  dateAdded: '2024-03-01T00:00:00.000Z' }),
    makeSeedCard({ id: 2, name: 'First Added',  dateAdded: '2024-01-01T00:00:00.000Z' }),
    makeSeedCard({ id: 3, name: 'Second Added', dateAdded: '2024-02-01T00:00:00.000Z' }),
  ];
  const win = await bootTracker(seed);
  const rows = [...win.document.querySelectorAll('#card-body tr[data-card-id]')];
  const orderedIds = rows.map(r => r.dataset.cardId);
  assertEqual(orderedIds.join(','), '2,3,1', 'Rows should render oldest dateAdded first: id 2 (Jan), 3 (Feb), 1 (Mar)');
});

/* ============================================================
   v19 (this session): Refresh missing / Retry failed button wiring
   ============================================================ */
await test('"Retry failed" button is hidden on initial load (nothing has failed yet)', async () => {
  const win = await bootTracker([]);
  const btn = win.document.getElementById('retry-failed-btn');
  assert(btn, 'retry-failed-btn should exist in the DOM');
  assertEqual(btn.style.display, 'none', 'Retry-failed button should start hidden until a refresh actually fails something');
});

await test('"Refresh missing" button exists and is always visible (not conditionally hidden)', async () => {
  const win = await bootTracker([]);
  const btn = win.document.getElementById('refresh-missing-btn');
  assert(btn, 'refresh-missing-btn should exist in the DOM');
  assert(btn.style.display !== 'none', 'Refresh-missing should be visible by default, unlike retry-failed');
});

await test('Clicking "Refresh missing" with no eligible cards shows the empty-state message, does not throw', async () => {
  // No cards have a tcgplayerId, so the missing-price filter has nothing
  // eligible to refresh — this exercises the opts.emptyMsg path added in
  // refreshAllPrices()'s filterFn refactor without needing a real network
  // price-fetch round trip.
  const seed = [makeSeedCard({ id: 1, tcgplayerId: null, marketNM: null, dateAdded: '2024-01-01T00:00:00.000Z' })];
  const win = await bootTracker(seed, { mockFetch: async () => ({ ok: false, status: 599 }) });
  let threw = false;
  try {
    win.document.getElementById('refresh-missing-btn').dispatchEvent(new win.Event('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 10)); // let the async handler settle
  } catch { threw = true; }
  assert(!threw, 'Clicking Refresh missing with zero eligible cards must not throw');
  const statusText = win.document.getElementById('refresh-status-bar').textContent;
  assert(statusText.toLowerCase().includes('no cards'), `Expected an empty-state status message, got: "${statusText}"`);
});

/* ============================================================
   v19: Rebuild-catalogue button + window.tcgDebug surface
   ============================================================ */
await test('"Rebuild search index" button exists and is wired up', async () => {
  const win = await bootTracker([]);
  const btn = win.document.getElementById('rebuild-catalogue-btn');
  assert(btn, 'rebuild-catalogue-btn should exist in the DOM');
  assert(!btn.disabled, 'Should start enabled');
});

await test('Clicking "Rebuild search index" disables the button, then re-enables it once the reload settles', async () => {
  const setsIndex = [{ id: 'rebuildset', name: 'Rebuild Set', releaseDate: '2020/01/01' }];
  const mockFetch = async (url) => {
    if (url.includes('sets/en.json')) return { ok: true, json: async () => setsIndex };
    if (url.includes('rebuildset.json')) return { ok: true, json: async () => [{ id: 'rebuildset-1', name: 'Rebuild Card', number: '1', images: {} }] };
    return { ok: false, status: 404 };
  };
  const win = await bootTracker([], { mockFetch });
  const btn = win.document.getElementById('rebuild-catalogue-btn');
  btn.dispatchEvent(new win.Event('click', { bubbles: true }));
  // Should disable synchronously/near-immediately while the rebuild runs.
  await new Promise(r => setTimeout(r, 5));
  assert(btn.disabled, 'Button should be disabled while a rebuild is in progress');
  // Give the (small, mocked) reload time to finish.
  await new Promise(r => setTimeout(r, 200));
  assert(!btn.disabled, 'Button should re-enable once the rebuild settles');
});

await test('window.tcgDebug exposes status/catalogue/searches/testLocal helpers', async () => {
  const win = await bootTracker([]);
  assert(typeof win.tcgDebug === 'object', 'tcgDebug should be exposed on window');
  assert(typeof win.tcgDebug.status === 'function', 'tcgDebug.status should be a function');
  assert(typeof win.tcgDebug.catalogue === 'function', 'tcgDebug.catalogue should be a function');
  assert(typeof win.tcgDebug.searches === 'function', 'tcgDebug.searches should be a function');
  assert(typeof win.tcgDebug.testLocal === 'function', 'tcgDebug.testLocal should be a function');
});

console.log(`PASS: ${pass}  FAIL: ${fail}`);
for (const f of failNames) console.log('FAILED:', f);
process.exitCode = fail > 0 ? 1 : 0;
