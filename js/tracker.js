/**
 * tracker.js — UI logic for index.html.
 * Imports everything it needs directly from core.js (no window.TCG).
 */

import {
  CONDITIONS, FINISH_LABELS,
  makeCard, touchUpdated, adjPrice, calcProfit, sortCards,
  fmt, fmtPct, fmtTime, fmtDate, fmtAge, escHtml,
  downloadCSV, parseCSV, csvRowToCard,
  searchCards, fetchCardPrices, fetchCardByUrl,
  readPriceCache, inspectPriceCache, clearPriceCache, CACHE_TTL_MS,
  getSeedCards,
} from './core.js';

/* ============================================================
   State
   ============================================================ */

const STORAGE_KEY = 'tcg_tracker_cards';

let cards          = loadCardsFromStorage();
let pendingCSVData = null;
let selectedResult = null;   // { cardId, cardData, finish, prices, tcgUrl }
let refreshing     = false;
let filterQuery    = '';

// Sorting state
let sortKey = 'dateAdded';
let sortDir = 'desc';

/* ============================================================
   localStorage persistence
   ============================================================ */

function saveCardsToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cards));
  } catch { /* quota exceeded — ignore */ }
}

function loadCardsFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch { /* corrupt data — fall through */ }
  return getSeedCards();
}

/* ============================================================
   Summary bar
   ============================================================ */

function updateSummary() {
  let count = 0, cost = 0, market = 0, profit = 0;
  for (const c of cards) {
    count++;
    cost   += parseFloat(c.buyCost) || 0;
    const m = adjPrice(c);
    market += m;
    profit += m - (parseFloat(c.buyCost) || 0);
  }
  document.getElementById('sum-count').textContent  = count;
  document.getElementById('sum-cost').textContent   = fmt(cost);
  document.getElementById('sum-market').textContent = fmt(market);
  const profitEl     = document.getElementById('sum-profit');
  profitEl.textContent = fmt(profit);
  profitEl.className   = 'metric-value ' + (profit >= 0 ? 'pos' : 'neg');
}

/* ============================================================
   Cache status bar
   ============================================================ */

function updateCacheStatus() {
  const el = document.getElementById('cache-status');
  if (!el) return;
  const { count, oldestAgeMs } = inspectPriceCache();
  if (count === 0) {
    el.textContent = 'Price cache empty';
    return;
  }
  const ttlHours = Math.round(CACHE_TTL_MS / 3600000);
  el.textContent = `${count} price${count !== 1 ? 's' : ''} cached` +
    (oldestAgeMs !== null ? ` · oldest ${fmtAge(oldestAgeMs)}` : '') +
    ` · TTL ${ttlHours}h`;
}

/* ============================================================
   Column sort
   ============================================================ */

function setSort(key) {
  sortDir = (sortKey === key && sortDir === 'asc') ? 'desc' : 'asc';
  sortKey = key;
  renderTable();
}

function sortArrow(key) {
  if (sortKey !== key) return '<span class="sort-arrow inactive">↕</span>';
  return `<span class="sort-arrow">${sortDir === 'asc' ? '↑' : '↓'}</span>`;
}

function buildTh(label, key, extraStyle = '') {
  return `<th data-sort-key="${key}" style="cursor:pointer;user-select:none;${extraStyle}">` +
         `${label} ${sortArrow(key)}</th>`;
}

/* ============================================================
   Table rendering
   ============================================================ */

/**
 * Re-render the entire card table.
 * @param {number[]} [highlightIds=[]]  card IDs to briefly highlight after a refresh
 */
function renderTable(highlightIds = []) {
  // ── Header ───────────────────────────────────────────────────────────────
  const thead = document.querySelector('#card-table thead tr');
  thead.innerHTML =
    `<th style="width:54px">Image</th>` +
    buildTh('Name',         'name',        'min-width:140px') +
    buildTh('Finish',       'finish',      'width:90px') +
    buildTh('Condition',    'condition',   'width:84px') +
    buildTh('Buy cost',     'buyCost',     'width:84px') +
    buildTh('Market (NM)',  'marketNM',    'width:100px') +
    buildTh('Low',          'priceLow',    'width:78px') +
    buildTh('Mid',          'priceMid',    'width:78px') +
    buildTh('Adj. price',   'adjPrice',    'width:88px') +
    buildTh('Profit',       'profit',      'width:78px') +
    buildTh('Profit %',     'pct',         'width:68px') +
    `<th style="width:80px">Link</th>` +
    buildTh('Sold',         'sold',        'width:46px') +
    buildTh('Date added',   'dateAdded',   'width:110px') +
    buildTh('Last updated', 'lastUpdated', 'width:110px') +
    `<th style="width:36px"></th>`;

  // ── Filter + sort ─────────────────────────────────────────────────────────
  const query      = filterQuery.toLowerCase();
  const filtered   = query
    ? cards.filter(c =>
        c.name.toLowerCase().includes(query) ||
        c.setName.toLowerCase().includes(query))
    : cards;
  const displayRows = sortCards(filtered, sortKey, sortDir);

  // ── Rows ──────────────────────────────────────────────────────────────────
  const tbody     = document.getElementById('card-body');
  tbody.innerHTML = '';

  for (const card of displayRows) {
    const adj             = adjPrice(card);
    const { profit, pct } = calcProfit(card);
    const highlighted     = highlightIds.includes(card.id);
    const cached          = readPriceCache(card.tcgplayerId);

    const tr = document.createElement('tr');
    tr.dataset.cardId = card.id;
    if (card.sold)    tr.classList.add('sold');
    if (highlighted)  tr.style.background = 'rgba(60,180,80,0.10)';

    // Image cell — uses a data attribute; click handled by delegation
    const imgCell = card.imageUrl
      ? `<img class="card-img"
              src="${escHtml(card.imageUrl)}"
              alt="${escHtml(card.name)}"
              onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
         <div class="card-img-placeholder" style="display:none">No image</div>`
      : `<div class="card-img-placeholder" data-action="open-search">Click to search</div>`;

    // Cache age tooltip on Market (NM) cell
    const cacheTitle = cached
      ? `title="Cached ${fmtAge(Date.now() - cached.cachedAt)}"`
      : 'title="Not cached — will fetch on next refresh"';

    tr.innerHTML = `
      <td>${imgCell}</td>

      <td>
        <input type="text" value="${escHtml(card.name)}" placeholder="Card name"
               data-field="name">
        ${card.setName
          ? `<div style="font-size:10px;color:var(--text-tertiary);margin-top:2px">${escHtml(card.setName)}</div>`
          : ''}
        ${card.lastRefreshed
          ? `<div class="refresh-detail">Price refreshed ${fmtTime(card.lastRefreshed)}</div>`
          : ''}
      </td>

      <td style="font-size:12px;color:var(--text-secondary)">
        ${escHtml(FINISH_LABELS[card.finish] || card.finish || '—')}
      </td>

      <td>
        <select data-field="condition">
          ${CONDITIONS.map(c =>
            `<option value="${c}"${c === card.condition ? ' selected' : ''}>${c}</option>`
          ).join('')}
        </select>
      </td>

      <td>
        <input type="number" value="${card.buyCost}" placeholder="0.00"
               step="0.01" min="0" data-field="buyCost">
      </td>

      <td style="font-size:12px${highlighted ? ';color:var(--text-success)' : ''}" ${cacheTitle}>
        ${fmt(card.marketNM)}${cached ? ' <span class="cache-dot" title="Cached">●</span>' : ''}
      </td>
      <td style="font-size:12px;color:var(--text-secondary)">${fmt(card.priceLow)}</td>
      <td style="font-size:12px;color:var(--text-secondary)">${fmt(card.priceMid)}</td>

      <td style="font-weight:500">
        ${adj > 0 ? fmt(adj) : '<span style="color:var(--text-tertiary)">—</span>'}
      </td>

      <td class="${profit === null ? '' : profit >= 0 ? 'profit-pos' : 'profit-neg'}">
        ${fmt(profit)}
      </td>
      <td class="${pct === null ? '' : pct >= 0 ? 'profit-pos' : 'profit-neg'}">
        ${fmtPct(pct)}
      </td>

      <td>
        ${card.link
          ? `<a href="${escHtml(card.link)}" target="_blank" rel="noopener" class="link-open">TCGPlayer</a>`
          : '<span style="font-size:11px;color:var(--text-tertiary)">—</span>'}
      </td>

      <td style="text-align:center">
        <input type="checkbox" data-field="sold" ${card.sold ? 'checked' : ''}>
      </td>

      <td class="date-cell">${escHtml(fmtDate(card.dateAdded))}</td>
      <td class="date-cell">${escHtml(fmtDate(card.lastUpdated))}</td>

      <td>
        <button class="trash-btn" data-action="delete" title="Delete card">&#x1F5D1;</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  // Empty-state row
  if (displayRows.length === 0) {
    const emptyTr = document.createElement('tr');
    emptyTr.innerHTML =
      `<td colspan="16" style="text-align:center;padding:2rem;color:var(--text-tertiary)">
         ${query ? `No cards match "${escHtml(filterQuery)}"` : 'No cards yet — add one below.'}
       </td>`;
    tbody.appendChild(emptyTr);
  }

  updateSummary();
  updateCacheStatus();
}

/* ============================================================
   Event delegation for the table body
   Handles: sort headers, field edits, checkbox, delete, image placeholder
   ============================================================ */

function bindTableDelegation() {
  // ── Sort headers (on thead) ───────────────────────────────────────────────
  document.querySelector('#card-table thead').addEventListener('click', e => {
    const th = e.target.closest('[data-sort-key]');
    if (th) setSort(th.dataset.sortKey);
  });

  const tbody = document.getElementById('card-body');

  // ── Text / number inputs ─────────────────────────────────────────────────
  tbody.addEventListener('input', e => {
    const input = e.target.closest('input[data-field]');
    if (!input) return;
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        const cardId = getRowCardId(input);
        if (cardId !== null) setField(cardId, input.dataset.field, input.value);
      }
    }, { once: true});

    // Checkbox (sold)
    const cb = e.target.closest('input[type="checkbox"][data-field]');
    if (cb) {
      const cardId = getRowCardId(cb);
      if (cardId !== null) setField(cardId, cb.dataset.field, cb.checked);
    }
  });

  // ── Select (condition dropdown) ───────────────────────────────────────────
  tbody.addEventListener('change', e => {
    const sel = e.target.closest('select[data-field]');
    if (sel) {
      const cardId = getRowCardId(sel);
      if (cardId !== null) setField(cardId, sel.dataset.field, sel.value);
      return;
    }
  });

  // ── Click: delete button & image placeholder ──────────────────────────────
  tbody.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    if (btn.dataset.action === 'delete') {
      if (!confirm("Are you sure you want to delete this card?")) {
        e.preventDefault();
      } else {
        const cardId = getRowCardId(btn);
        if (cardId !== null) deleteCard(cardId);
        return;
      }
    }
    if (btn.dataset.action === 'open-search') {
      const cardId = getRowCardId(btn);
      openSearchModal(cardId ?? undefined);
    }
  });
}

/** Walk up from an element to its <tr> and return the card id stored there. */
function getRowCardId(el) {
  const tr = el.closest('tr[data-card-id]');
  return tr ? parseInt(tr.dataset.cardId, 10) : null;
}

/* ============================================================
   Field mutation helpers
   ============================================================ */

function setField(id, field, value) {
  const card = cards.find(c => c.id === id);
  if (!card) return;
  card[field] = value;
  touchUpdated(card);
  saveCardsToStorage();
  renderTable();
}

function deleteCard(id) {
  cards = cards.filter(c => c.id !== id);
  saveCardsToStorage();
  renderTable();
}

/* ============================================================
   Filter bar
   ============================================================ */

function onFilterInput(e) {
  filterQuery = e.target.value;
  renderTable();
}

function clearFilter() {
  filterQuery = '';
  document.getElementById('filter-input').value = '';
  renderTable();
}

/* ============================================================
   Refresh prices
   ============================================================ */

async function refreshAllPrices() {
  if (refreshing) return;

  const refreshable = cards.filter(c => c.tcgplayerId);
  if (!refreshable.length) {
    setStatus('No cards with API data to refresh. Add cards via search first.', 'err');
    return;
  }

  refreshing = true;
  const refreshBtn = document.getElementById('refresh-btn');
  refreshBtn.disabled = true;
  refreshBtn.innerHTML = '<span class="spin">&#8635;</span> Refreshing…';
  setStatus(
    `<span class="spin" style="display:inline-block;animation:spin 0.85s linear infinite">&#8635;</span>` +
    ` Fetching prices for ${refreshable.length} card${refreshable.length > 1 ? 's' : ''}…`, ''
  );

  let ok = 0, fail = 0, fromCache = 0;
  const updatedIds = [];

  for (const card of refreshable) {
    try {
      // forceRefresh=true so the Refresh button always hits the network
      const prices = await fetchCardPrices(card.tcgplayerId, true);
      if (prices) {
        const p = prices[card.finish] || prices[Object.keys(prices)[0]] || {};
        if (p.market !== undefined) card.marketNM  = p.market;
        if (p.low    !== undefined) card.priceLow  = p.low;
        if (p.mid    !== undefined) card.priceMid  = p.mid;
        card.lastRefreshed = Date.now();
        touchUpdated(card);
        updatedIds.push(card.id);
        ok++;
      } else {
        fail++;
      }
    } catch {
      fail++;
    }
    await new Promise(r => setTimeout(r, 150));
  }

  saveCardsToStorage();
  renderTable(updatedIds);

  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  setStatus(
    `Refreshed ${ok} card${ok !== 1 ? 's' : ''}` +
    (fromCache ? ` (${fromCache} from cache)` : '') +
    (fail ? ` · ${fail} failed` : '') +
    `  ·  ${time}`,
    fail && !ok ? 'err' : 'ok'
  );

  refreshBtn.disabled = false;
  refreshBtn.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
         stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M1 8a7 7 0 1 0 1.4-4.2"/><polyline points="1,2 1,6 5,6"/>
    </svg>
    Refresh prices`;
  refreshing = false;
  updateCacheStatus();
}

function setStatus(html, type = '') {
  const el = document.getElementById('refresh-status-bar');
  el.className = 'refresh-status ' + type;
  el.innerHTML = html;
}

/* ============================================================
   Search modal
   ============================================================ */

function openSearchModal(editId) {
    selectedResult = null;
    document.getElementById('search-input').value            = '';
    document.getElementById('url-input').value               = '';
    document.getElementById('search-results-area').innerHTML = '';
    document.getElementById('url-status').innerHTML          = '';
    document.getElementById('add-selected-btn').disabled     = true;
    document.getElementById('search-modal').dataset.editId   = editId ?? '';
    document.getElementById('search-modal').style.display    = 'flex';
    switchTab('name');
    setTimeout(() => document.getElementById('search-input').focus(), 80);
}

function closeSearchModal() {
  document.getElementById('search-modal').style.display = 'none';
  selectedResult = null;
}

function switchTab(tab) {
  const isName = tab === 'name';
  document.getElementById('tab-name').style.display  = isName ? 'block' : 'none';
  document.getElementById('tab-url').style.display   = isName ? 'none'  : 'block';
  document.getElementById('tabBtn-name').classList.toggle('tab-active',  isName);
  document.getElementById('tabBtn-url').classList.toggle('tab-active',  !isName);
  if (isName) document.getElementById('add-selected-btn').disabled = !selectedResult;
}

/* ── Name search ──────────────────────────────────────────────────────────── */

async function doSearch() {
  const q       = document.getElementById('search-input').value.trim();
  const area    = document.getElementById('search-results-area');
  const searchBtn = document.getElementById('search-btn');
  if (!q) return;

  area.innerHTML       = '<div class="loading-state">Searching…</div>';
  searchBtn.disabled   = true;
  selectedResult       = null;
  document.getElementById('add-selected-btn').disabled = true;

  try {
    const data = await searchCards(q);
    if (!data.length) {
      area.innerHTML = '<div class="no-results">No cards found. Try a different name.</div>';
      return;
    }
    renderSearchResults(data);
  } catch (err) {
    area.innerHTML = `<div class="no-results">Search failed: ${escHtml(err.message)}<br>
      Make sure you are serving via HTTP (not file://).</div>`;
  } finally {
    searchBtn.disabled = false;
  }
}

function renderSearchResults(data) {
  const area = document.getElementById('search-results-area');
  area.innerHTML = '';
  area.className = 'search-results';

  for (const card of data) {
    const prices     = card.tcgplayer?.prices || {};
    const finishKeys = Object.keys(prices);
    const defaultFin = finishKeys[0] || null;

    const div = document.createElement('div');
    div.className              = 'result-card';
    div.dataset.cardId         = card.id;
    div.dataset.selectedFinish = defaultFin || '';

    const pricePills = finishKeys.map(fk => {
      const p = prices[fk];
      return `<span class="price-pill${fk === defaultFin ? ' selected-type' : ''}" data-finish="${fk}">
                ${FINISH_LABELS[fk] || fk}: ${p.market ? '$' + Number(p.market).toFixed(2) : '—'}
              </span>`;
    }).join('');

    const finishBtns = finishKeys.length > 1
      ? finishKeys.map(fk =>
          `<button class="finish-btn${fk === defaultFin ? ' active' : ''}" data-finish="${fk}">
             ${FINISH_LABELS[fk] || fk}
           </button>`).join('')
      : '';

    div.innerHTML = `
      <img class="result-img" src="${escHtml(card.images?.small || '')}" alt="${escHtml(card.name)}">
      <div class="result-info">
        <div class="result-name">${escHtml(card.name)}</div>
        <div class="result-set">${escHtml(card.set?.name || '')} · #${escHtml(card.number || '')}</div>
        <div class="result-prices">
          ${pricePills || '<span style="font-size:11px;color:var(--text-tertiary)">No price data</span>'}
        </div>
        ${finishBtns ? `<div class="finish-picker">${finishBtns}</div>` : ''}
        <button type="button" class="quick-add-btn" id="quick-add-btn">Quick Add</button>
      </div>`;

    div.dataset.cardJson = JSON.stringify({
      id:        card.id,
      name:      card.name,
      imageUrl:  card.images?.large || card.images?.small || '',
      setName:   card.set?.name || '',
      tcgplayer: card.tcgplayer || null,
    });

    // Delegate clicks within the result card
    div.addEventListener('click', e => {
      // Finish pill / button
      const pill = e.target.closest('.price-pill, .finish-btn, .quick-add-btn');
      if (e.target.matches('.quick-add-btn')) { 
        selectResultCard(card, div);
        addSelectedCard();
        return;
      }
      else {
        e.stopPropagation(); 
        selectFinish(card.id, pill.dataset.finish, div); 
        return; 
      }
      // Card selection
      selectResultCard(card, div);
    });

    area.appendChild(div);
  }
}

function selectFinish(cardId, finish, div) {
  div.dataset.selectedFinish = finish;
  div.querySelectorAll('.price-pill').forEach(p =>
    p.classList.toggle('selected-type', p.dataset.finish === finish));
  div.querySelectorAll('.finish-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.finish === finish));
  if (selectedResult?.cardId === cardId) selectedResult.finish = finish;
}

function selectResultCard(card, div) {
  document.querySelectorAll('.result-card').forEach(d => d.classList.remove('selected'));
  div.classList.add('selected');
  const finish   = div.dataset.selectedFinish || Object.keys(card.tcgplayer?.prices || {})[0] || 'normal';
  const cardData = JSON.parse(div.dataset.cardJson);
  selectedResult = {
    cardId: card.id, cardData, finish,
    prices: card.tcgplayer?.prices || {},
    tcgUrl: card.tcgplayer?.url    || '',
  };
  document.getElementById('add-selected-btn').disabled = false;
}

/* ── URL lookup tab ───────────────────────────────────────────────────────── */

async function doUrlLookup() {
  const url      = document.getElementById('url-input').value.trim();
  const statusEl = document.getElementById('url-status');
  const lookupBtn = document.getElementById('url-lookup-btn');
  if (!url) return;

  statusEl.innerHTML  = '<span style="color:var(--text-secondary)">Looking up card…</span>';
  lookupBtn.disabled  = true;
  selectedResult      = null;
  document.getElementById('add-selected-btn').disabled = true;

  try {
    const card = await fetchCardByUrl(url);
    if (!card) {
      statusEl.innerHTML =
        `<span style="color:var(--text-danger)">
           Could not find a matching Pokémon card.<br>
           Tip: make sure it's a TCGPlayer product URL
           (e.g. tcgplayer.com/product/523161/pokemon-…).
           If the URL has no slug after the ID, the name search fallback
           cannot run — try searching by name instead.
         </span>`;
      return;
    }
    // Show result in the name tab and auto-select it
    renderSearchResults([card]);
    switchTab('name');
    const resultDiv = document.querySelector('.result-card');
    if (resultDiv) selectResultCard(card, resultDiv);
    statusEl.innerHTML = '';
  } catch (err) {
    statusEl.innerHTML =
      `<span style="color:var(--text-danger)">Lookup failed: ${escHtml(err.message)}</span>`;
  } finally {
    lookupBtn.disabled = false;
  }
}

/* ── Reset search helper for Adding cards ────────────────────────────────────────────── */
function resetSearchUI() {
  selectedResult = null;

  const input = document.getElementById('search-input');
  input.value = '';
  input.focus();

  const resultsContainer = document.getElementById('search-results');
  if (resultsContainer) resultsContainer.innerHTML = '';
}

/* ── Show add success helper for Adding cards ────────────────────────────────────────────── */
function showAddSuccess(name, setName) {
  const cardAdded = document.getElementById('card-added');
  const btn = document.getElementById('add-selected-btn');

  if (!cardAdded) return;

  cardAdded.textContent = `${name} from ${setName} was added!`;
  cardAdded.style.display = 'block';

  btn.disabled = true;

  // Disable add button for 1 second to prevent accidentally adding multiple
  setTimeout(() => {
    btn.disabled = false;
  }, 1000);
}

/* ── Add selected card to list ────────────────────────────────────────────── */

function addSelectedCard() {
  if (!selectedResult) return;
  const { cardData, finish, prices, tcgUrl } = selectedResult;
  const p      = prices[finish] || {};
  const editId = parseInt(document.getElementById('search-modal').dataset.editId, 10) || 0;

  const entry = {
    name:        cardData.name,
    imageUrl:    cardData.imageUrl,
    setName:     cardData.setName,
    finish,
    marketNM:    p.market ?? null,
    priceLow:    p.low    ?? null,
    priceMid:    p.mid    ?? null,
    link:        tcgUrl   || '',
    condition:   'NM',
    buyCost:     '',
    sold:        false,
    tcgplayerId: cardData.id,
  };

  if (editId) {
    const idx = cards.findIndex(c => c.id === editId);
    if (idx >= 0) { cards[idx] = { ...cards[idx], ...entry }; touchUpdated(cards[idx]); }
  } else {
    cards.push(makeCard(entry));
  }

  saveCardsToStorage();
  // closeSearchModal();
  renderTable();

  showAddSuccess(cardData.name, entry.setName);
  resetSearchUI();
}

/* ============================================================
   CSV import
   ============================================================ */

async function triggerImport() {
  if (window.showOpenFilePicker) {
    try {
      const [fh] = await window.showOpenFilePicker({
        types: [{ description: 'CSV files', accept: { 'text/csv': ['.csv'] } }],
        multiple: false,
      });
      const text = await (await fh.getFile()).text();
      pendingCSVData = text;
      document.getElementById('import-modal').style.display = 'flex';
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  document.getElementById('file-input').click();
}

function handleFileImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = evt => {
    pendingCSVData = evt.target.result;
    document.getElementById('import-modal').style.display = 'flex';
  };
  reader.readAsText(file);
  e.target.value = '';
}

function closeImportModal() {
  document.getElementById('import-modal').style.display = 'none';
  pendingCSVData = null;
}

function doImport(mode) {
  if (!pendingCSVData) return;
  const rows = parseCSV(pendingCSVData);
  if (mode === 'replace') cards = [];
  for (const row of rows) cards.push(csvRowToCard(row));
  saveCardsToStorage();
  closeImportModal();
  renderTable();
}

/* ============================================================
   CSV export
   ============================================================ */

async function handleExportCSV() {
  await downloadCSV(cards);
}

/* ============================================================
   Cache controls
   ============================================================ */

function handleClearCache() {
  clearPriceCache();
  updateCacheStatus();
  setStatus('Price cache cleared — next refresh will fetch all prices from the API.', 'ok');
}

/* ============================================================
   initUI — wire all static buttons (Option A)
   ============================================================ */

function initUI() {
  // ── Main toolbar ────────────────────────────────────────────────────────
  document.getElementById('refresh-btn').addEventListener('click', refreshAllPrices);
  document.getElementById('import-csv').addEventListener('click', triggerImport);
  document.getElementById('export-csv').addEventListener('click', handleExportCSV);
  document.getElementById('add-card-via-search-btn').addEventListener('click', () => openSearchModal());
  document.getElementById('clear-cache-btn').addEventListener('click', handleClearCache);

  // ── Filter bar ───────────────────────────────────────────────────────────
  document.getElementById('filter-input').addEventListener('input', onFilterInput);
  document.getElementById('filter-clear').addEventListener('click', clearFilter);

  // ── Import modal ─────────────────────────────────────────────────────────
  document.getElementById('close-import-btn').addEventListener('click', closeImportModal);
  document.getElementById('do-import-btn').addEventListener('click', () => doImport('add'));
  document.getElementById('replace-import-btn').addEventListener('click', () => doImport('replace'));

  // ── Search modal tabs ─────────────────────────────────────────────────────
  document.getElementById('tabBtn-name').addEventListener('click', () => switchTab('name'));
  document.getElementById('tabBtn-url').addEventListener('click', () => switchTab('url'));

  // ── Name search ───────────────────────────────────────────────────────────
  document.getElementById('search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') doSearch();
  });
  document.getElementById('search-btn').addEventListener('click', doSearch);

  // ── URL lookup ────────────────────────────────────────────────────────────
  document.getElementById('url-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') doUrlLookup();
  });
  document.getElementById('url-lookup-btn').addEventListener('click', doUrlLookup);

  // ── Search modal footer ───────────────────────────────────────────────────
  document.getElementById('close-search-btn').addEventListener('click', closeSearchModal);
  document.getElementById('add-selected-btn').addEventListener('click', addSelectedCard);
  // document.getElementById('quick-add-btn').addEventListener('click', addSelectedCard);

  // ── Hidden file input (CSV import fallback) ───────────────────────────────
  document.getElementById('file-input').addEventListener('change', handleFileImport);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeSearchModal(); closeImportModal(); }
  });

  // ── Table event delegation ────────────────────────────────────────────────
  bindTableDelegation();
}

/* ============================================================
   Boot
   ============================================================ */

renderTable();
initUI();
