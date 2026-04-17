/**
 * tracker.js — UI logic for index.html.
 * Imports everything from core.js via ES module syntax.
 */

import {
  CONDITIONS, FINISH_LABELS,
  makeCard, touchUpdated, adjPrice, calcProfit, calcActualProfit, calcPriceDelta, sortCards,
  fmt, fmtPct, fmtTime, fmtDate, fmtAge, escHtml,
  downloadCSV, parseCSV, csvRowToCard,
  searchCards, fetchCardPrices, fetchCardByUrl,
  readPriceCache, inspectPriceCache, clearPriceCache, CACHE_TTL_MS,
  snapshotCards, UNDO_MAX_SNAPSHOTS,
  getSeedCards,
} from './core.js';

/* ============================================================
   State
   ============================================================ */

const STORAGE_KEY      = 'tcg_tracker_cards';
const COL_VIS_KEY      = 'tcg_tracker_col_visibility';

let cards          = loadCardsFromStorage();
let pendingCSVData = null;
let selectedResult = null;
let refreshing     = false;
let filterQuery    = '';
let selectedIds    = new Set();
let undoStack      = [];
let colPanelOpen   = false;

// Sorting
let sortKey = 'dateAdded';
let sortDir = 'desc';

// Search modal state
let searchJapanese = false;

/* ============================================================
   Column definitions
   All hideable columns are listed here. The frozen columns
   (checkbox, image, name on left; sold, actions on right)
   are always rendered and never appear in this list.
   ============================================================ */

const COLUMNS = [
  { key: 'condition',    label: 'Condition',      width: '84px',  defaultOn: true  },
  { key: 'buyCost',      label: 'Buy cost',        width: '84px',  defaultOn: true  },
  { key: 'soldPrice',    label: 'Sold price',      width: '88px',  defaultOn: true  },
  { key: 'marketNM',     label: 'Market (NM)',     width: '106px', defaultOn: true  },
  { key: 'priceDelta',   label: 'Δ Price',         width: '84px',  defaultOn: true  },
  { key: 'priceLow',     label: 'Low',             width: '70px',  defaultOn: true  },
  { key: 'priceMid',     label: 'Mid',             width: '70px',  defaultOn: true  },
  { key: 'adjPrice',     label: 'Adj. price',      width: '88px',  defaultOn: true  },
  { key: 'profit',       label: 'Profit / Actual', width: '106px', defaultOn: true  },
  { key: 'pct',          label: 'Profit %',        width: '78px',  defaultOn: true  },
  { key: 'link',         label: 'Link',            width: '80px',  defaultOn: true  },
  { key: 'dateAdded',    label: 'Date added',      width: '110px', defaultOn: true  },
  { key: 'lastUpdated',  label: 'Last updated',    width: '110px', defaultOn: false },
];

/** Load which columns are visible from localStorage (or use defaults). */
function loadColVisibility() {
  try {
    const raw = localStorage.getItem(COL_VIS_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      // Merge saved state with any new columns added since last save
      return COLUMNS.reduce((acc, col) => {
        acc[col.key] = col.key in saved ? saved[col.key] : col.defaultOn;
        return acc;
      }, {});
    }
  } catch { /* corrupt */ }
  return Object.fromEntries(COLUMNS.map(c => [c.key, c.defaultOn]));
}

function saveColVisibility() {
  try { localStorage.setItem(COL_VIS_KEY, JSON.stringify(colVisibility)); } catch { /* quota */ }
}

let colVisibility = loadColVisibility();

function isColVisible(key) { return colVisibility[key] !== false; }

/* ============================================================
   localStorage persistence
   ============================================================ */

function saveCardsToStorage() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cards)); } catch { /* quota */ }
}

function loadCardsFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch { /* corrupt */ }
  return getSeedCards();
}

/* ============================================================
   Undo stack
   ============================================================ */

function pushUndo() {
  undoStack.push(snapshotCards(cards));
  if (undoStack.length > UNDO_MAX_SNAPSHOTS) undoStack.shift();
  updateUndoButton();
}

function undo() {
  if (!undoStack.length) return;
  cards = undoStack.pop();
  saveCardsToStorage();
  selectedIds.clear();
  renderTable();
  updateUndoButton();
  setStatus('Undo successful.', 'ok');
}

function updateUndoButton() {
  const btn = document.getElementById('undo-btn');
  if (btn) btn.disabled = undoStack.length === 0;
}

/* ============================================================
   Summary bar
   ============================================================ */

function updateSummary() {
  let count = 0, cost = 0, market = 0, expProfit = 0, totalSold = 0, actualProfit = 0;
  for (const c of cards) {
    count++;
    cost += parseFloat(c.buyCost) || 0;
    const m = adjPrice(c);
    market    += m;
    expProfit += m - (parseFloat(c.buyCost) || 0);
    if (c.sold) {
      const sp = parseFloat(c.soldPrice) || 0;
      if (sp) { totalSold += sp; actualProfit += sp - (parseFloat(c.buyCost) || 0); }
    }
  }
  document.getElementById('sum-count').textContent  = count;
  document.getElementById('sum-cost').textContent   = fmt(cost);
  document.getElementById('sum-market').textContent = fmt(market);
  const profitEl = document.getElementById('sum-profit');
  profitEl.textContent = fmt(expProfit);
  profitEl.className   = 'metric-value ' + (expProfit >= 0 ? 'pos' : 'neg');
  const soldEl = document.getElementById('sum-sold');
  if (soldEl) soldEl.textContent = fmt(totalSold);
  const actEl = document.getElementById('sum-actual-profit');
  if (actEl) { actEl.textContent = fmt(actualProfit); actEl.className = 'metric-value ' + (actualProfit >= 0 ? 'pos' : 'neg'); }
}

/* ============================================================
   Cache status bar
   ============================================================ */

function updateCacheStatus() {
  const el = document.getElementById('cache-status');
  if (!el) return;
  const { count, oldestAgeMs } = inspectPriceCache();
  if (count === 0) { el.textContent = 'Price cache empty'; return; }
  const ttlHours = Math.round(CACHE_TTL_MS / 3600000);
  el.textContent = `${count} price${count !== 1 ? 's' : ''} cached` +
    (oldestAgeMs !== null ? ` · oldest ${fmtAge(oldestAgeMs)}` : '') + ` · TTL ${ttlHours}h`;
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

/* Build a sortable <th> with sticky support.
   stickyLeft / stickyRight are pixel strings e.g. "0px" or null. */
function buildTh(label, key, width, stickyLeft = null, stickyRight = null) {
  const sticky = stickyLeft  !== null ? `position:sticky;left:${stickyLeft};z-index:20;background:var(--bg-secondary);` :
                 stickyRight !== null ? `position:sticky;right:${stickyRight};z-index:20;background:var(--bg-secondary);` : '';
  return `<th data-sort-key="${key}" style="cursor:pointer;user-select:none;width:${width};${sticky}">` +
         `${label} ${sortArrow(key)}</th>`;
}

/* Build a non-sortable <th>. */
function buildFixedTh(label, width, stickyLeft = null, stickyRight = null, extra = '') {
  const sticky = stickyLeft  !== null ? `position:sticky;left:${stickyLeft};z-index:20;background:var(--bg-secondary);` :
                 stickyRight !== null ? `position:sticky;right:${stickyRight};z-index:20;background:var(--bg-secondary);` : '';
  return `<th style="width:${width};${sticky}${extra}">${label}</th>`;
}

/* ============================================================
   Column visibility panel
   ============================================================ */

function toggleColPanel() {
  colPanelOpen = !colPanelOpen;
  renderColPanel();
}

function closeColPanel() {
  colPanelOpen = false;
  const panel = document.getElementById('col-panel');
  if (panel) panel.style.display = 'none';
}

function renderColPanel() {
  const panel = document.getElementById('col-panel');
  if (!panel) return;

  if (!colPanelOpen) { panel.style.display = 'none'; return; }

  panel.style.display = 'block';
  panel.innerHTML = `
    <div class="col-panel-header">
      <span>Columns</span>
      <button class="col-panel-reset" id="col-reset-btn">Reset defaults</button>
    </div>
    <div class="col-panel-list">
      ${COLUMNS.map(col => `
        <label class="col-panel-item">
          <input type="checkbox" data-col-key="${col.key}" ${isColVisible(col.key) ? 'checked' : ''}>
          ${col.label}
        </label>`).join('')}
    </div>`;

  // Wire checkboxes
  panel.querySelectorAll('input[data-col-key]').forEach(cb => {
    cb.addEventListener('change', e => {
      colVisibility[e.target.dataset.colKey] = e.target.checked;
      saveColVisibility();
      renderTable();
    });
  });

  // Reset button
  document.getElementById('col-reset-btn').addEventListener('click', () => {
    COLUMNS.forEach(col => { colVisibility[col.key] = col.defaultOn; });
    saveColVisibility();
    renderColPanel(); // re-render panel checkboxes
    renderTable();
  });
}

/* ============================================================
   Bulk-select helpers
   ============================================================ */

function updateBulkToolbar() {
  const bar  = document.getElementById('bulk-toolbar');
  const info = document.getElementById('bulk-count');
  if (!bar) return;
  const n = selectedIds.size;
  bar.style.display = n > 0 ? 'flex' : 'none';
  if (info) info.textContent = `${n} selected`;
}

function toggleSelectAll(checked) {
  const query    = filterQuery.toLowerCase();
  const filtered = query ? cards.filter(c => c.name.toLowerCase().includes(query) || c.setName.toLowerCase().includes(query)) : cards;
  if (checked) filtered.forEach(c => selectedIds.add(c.id));
  else         selectedIds.clear();
  renderTable();
}

function bulkMarkSold() {
  if (!selectedIds.size) return;
  pushUndo();
  for (const id of selectedIds) {
    const card = cards.find(c => c.id === id);
    if (card) { card.sold = true; touchUpdated(card); }
  }
  selectedIds.clear();
  saveCardsToStorage();
  renderTable();
  setStatus('Selected cards marked as sold.', 'ok');
}

function bulkDelete() {
  if (!selectedIds.size) return;
  const n = selectedIds.size;
  if (!confirm(`Delete ${n} selected card${n !== 1 ? 's' : ''}? This cannot be undone without Undo.`)) return;
  pushUndo();
  cards = cards.filter(c => !selectedIds.has(c.id));
  selectedIds.clear();
  saveCardsToStorage();
  renderTable();
  setStatus(`Deleted ${n} card${n !== 1 ? 's' : ''}.`, 'ok');
}

/* ============================================================
   Table rendering

   Column layout:
   LEFT FROZEN  │ SCROLLABLE MIDDLE        │ RIGHT FROZEN
   ─────────────┼──────────────────────────┼──────────────────────
   ☐  Img  Name │ Cond  Buy  Sold  Mkt … │ Sold☐  ⧉  🗑
   ============================================================ */

// Cumulative left offsets for the three frozen-left columns
const STICKY_LEFT = {
  checkbox: '0px',
  image:    '36px',
  name:     '90px',   // 36 + 54
};
// Right offsets for frozen-right columns
const STICKY_RIGHT = {
  actions: '0px',
  sold:    '68px',   // width of the actions cell
};

function renderTable(highlightIds = []) {
  // ── Check-all state ─────────────────────────────────────────────────────────
  const query    = filterQuery.toLowerCase();
  const filtered = query ? cards.filter(c => c.name.toLowerCase().includes(query) || c.setName.toLowerCase().includes(query)) : cards;
  const allVisible = filtered.length > 0 && filtered.every(c => selectedIds.has(c.id));

  // ── Build header row ─────────────────────────────────────────────────────────
  const thead = document.querySelector('#card-table thead tr');

  // Fixed left: checkbox + image + name (always visible)
  let headerHtml =
    buildFixedTh(`<input type="checkbox" id="check-all" ${allVisible && selectedIds.size > 0 ? 'checked' : ''}>`,
                 '36px', STICKY_LEFT.checkbox, null, 'text-align:center;') +
    buildFixedTh('Image', '54px', STICKY_LEFT.image) +
    buildTh('Name', 'name', '180px', STICKY_LEFT.name);

  // Hideable middle columns
  for (const col of COLUMNS) {
    if (!isColVisible(col.key)) continue;
    if (col.key === 'link' || col.key === 'dateAdded' || col.key === 'lastUpdated') {
      headerHtml += buildFixedTh(col.label, col.width);
    } else {
      headerHtml += buildTh(col.label, col.key, col.width);
    }
  }

  // Fixed right: sold checkbox + actions (always visible)
  headerHtml +=
    buildTh('Sold', 'sold', '52px', null, STICKY_RIGHT.sold) +
    buildFixedTh('', '68px', null, STICKY_RIGHT.actions);

  thead.innerHTML = headerHtml;

  // Re-attach check-all listener (header is rebuilt every render)
  const checkAllEl = document.getElementById('check-all');
  if (checkAllEl) checkAllEl.addEventListener('change', e => toggleSelectAll(e.target.checked));

  // ── Filter + sort ────────────────────────────────────────────────────────────
  const displayRows = sortCards(filtered, sortKey, sortDir);

  // ── Rows ─────────────────────────────────────────────────────────────────────
  const tbody = document.getElementById('card-body');
  tbody.innerHTML = '';

  for (const card of displayRows) {
    const adj         = adjPrice(card);
    const delta       = calcPriceDelta(card);
    const highlighted = highlightIds.includes(card.id);
    const cached      = readPriceCache(card.tcgplayerId);
    const isSelected  = selectedIds.has(card.id);

    const hasActual       = card.sold && parseFloat(card.soldPrice) > 0;
    const { profit, pct } = hasActual ? calcActualProfit(card) : calcProfit(card);
    const profitLabel     = hasActual ? 'Actual' : 'Expected';

    let deltaBadge = '<span style="color:var(--text-tertiary)">—</span>';
    if (delta !== null) {
      const sign = delta >= 0 ? '▲' : '▼';
      const cls  = delta >= 0 ? 'delta-up' : 'delta-down';
      deltaBadge = `<span class="${cls}">${sign} ${fmt(Math.abs(delta))}</span>`;
    }

    const tr = document.createElement('tr');
    tr.dataset.cardId = card.id;
    if (card.sold)   tr.classList.add('sold');
    if (isSelected)  tr.classList.add('row-selected');
    if (highlighted) tr.style.background = 'rgba(60,180,80,0.10)';

    // Image cell content
    const imgContent = card.imageUrl
      ? `<img class="card-img" src="${escHtml(card.imageUrl)}" alt="${escHtml(card.name)}"
              onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
         <div class="card-img-placeholder" style="display:none">No image</div>`
      : `<div class="card-img-placeholder" data-action="open-search">Click to search</div>`;

    // Finish label folded into Name cell as a subtitle line
    const finishLabel = FINISH_LABELS[card.finish] || card.finish || '';
    const subtitle    = [finishLabel, card.setName].filter(Boolean).join(' · ');

    const cacheTitle = cached
      ? `title="Cached ${fmtAge(Date.now() - cached.cachedAt)}"`
      : 'title="Not cached — will fetch on next refresh"';

    // Build direct TCGPlayer URL from productId, falling back to stored link
    const tcgLink = card.tcgplayerId
      ? `https://www.tcgplayer.com/product/${card.tcgplayerId.replace(/^[a-z]+-/i, '')}`.replace(
          // tcgplayerId is like "sv3pt5-6" — but TCGPlayer product IDs are numeric.
          // Use the stored link if we have it; otherwise skip.
          /tcgplayer\.com\/product\/[^0-9].*/,
          ''
        )
      : '';
    // The stored card.link is the direct product URL we built at add-time.
    // Use it as-is — it's already the clean direct URL.
    const directLink = card.link || tcgLink || '';

    // ── Frozen-left cells ──────────────────────────────────────────────────────
    let rowHtml = `
      <td class="frozen-left" style="left:${STICKY_LEFT.checkbox};text-align:center;width:36px">
        <input type="checkbox" data-action="select-row" ${isSelected ? 'checked' : ''}>
      </td>
      <td class="frozen-left" style="left:${STICKY_LEFT.image};width:54px">${imgContent}</td>
      <td class="frozen-left" style="left:${STICKY_LEFT.name};width:180px;min-width:180px">
        <input type="text" value="${escHtml(card.name)}" placeholder="Card name" data-field="name">
        ${subtitle ? `<div class="name-subtitle">${escHtml(subtitle)}</div>` : ''}
        ${card.lastRefreshed ? `<div class="refresh-detail">Refreshed ${fmtTime(card.lastRefreshed)}</div>` : ''}
      </td>`;

    // ── Hideable middle cells ──────────────────────────────────────────────────
    const colCells = {
      condition: `<td>
        <select data-field="condition">
          ${CONDITIONS.map(c => `<option value="${c}"${c === card.condition ? ' selected' : ''}>${c}</option>`).join('')}
        </select></td>`,

      buyCost: `<td><input type="number" value="${card.buyCost}" placeholder="0.00" step="0.01" min="0" data-field="buyCost"></td>`,

      soldPrice: `<td><input type="number" value="${card.soldPrice}" placeholder="—" step="0.01" min="0" data-field="soldPrice"
                        title="Actual sale price"></td>`,

      marketNM: `<td style="font-size:12px${highlighted ? ';color:var(--text-success)' : ''}" ${cacheTitle}>
        ${fmt(card.marketNM)}${cached ? ' <span class="cache-dot">●</span>' : ''}</td>`,

      priceDelta: `<td>${deltaBadge}</td>`,

      priceLow: `<td style="font-size:12px;color:var(--text-secondary)">${fmt(card.priceLow)}</td>`,

      priceMid: `<td style="font-size:12px;color:var(--text-secondary)">${fmt(card.priceMid)}</td>`,

      adjPrice: `<td style="font-weight:500">${adj > 0 ? fmt(adj) : '<span style="color:var(--text-tertiary)">—</span>'}</td>`,

      profit: `<td class="${profit === null ? '' : profit >= 0 ? 'profit-pos' : 'profit-neg'}">
        ${fmt(profit)}
        <div style="font-size:9px;color:var(--text-tertiary);margin-top:1px">${profitLabel}</div>
      </td>`,

      pct: `<td class="${pct === null ? '' : pct >= 0 ? 'profit-pos' : 'profit-neg'}">${fmtPct(pct)}</td>`,

      link: `<td>${directLink
        ? `<a href="${escHtml(directLink)}" target="_blank" rel="noopener" class="link-open">TCGPlayer</a>`
        : '<span style="font-size:11px;color:var(--text-tertiary)">—</span>'}</td>`,

      dateAdded:   `<td class="date-cell">${escHtml(fmtDate(card.dateAdded))}</td>`,
      lastUpdated: `<td class="date-cell">${escHtml(fmtDate(card.lastUpdated))}</td>`,
    };

    for (const col of COLUMNS) {
      if (isColVisible(col.key)) rowHtml += colCells[col.key];
    }

    // ── Frozen-right cells ─────────────────────────────────────────────────────
    rowHtml += `
      <td class="frozen-right" style="right:${STICKY_RIGHT.sold};width:52px;text-align:center">
        <input type="checkbox" data-field="sold" ${card.sold ? 'checked' : ''}>
      </td>
      <td class="frozen-right" style="right:${STICKY_RIGHT.actions};width:68px;white-space:nowrap">
        <button class="icon-btn" data-action="duplicate" title="Duplicate card">⧉</button>
        <button class="trash-btn" data-action="delete" title="Delete card">&#x1F5D1;</button>
      </td>`;

    tr.innerHTML = rowHtml;
    tbody.appendChild(tr);
  }

  if (displayRows.length === 0) {
    const emptyTr = document.createElement('tr');
    const span = 3 + COLUMNS.filter(c => isColVisible(c.key)).length + 2;
    emptyTr.innerHTML = `<td colspan="${span}" style="text-align:center;padding:2rem;color:var(--text-tertiary)">
      ${query ? `No cards match "${escHtml(filterQuery)}"` : 'No cards yet — add one below.'}
    </td>`;
    tbody.appendChild(emptyTr);
  }

  updateSummary();
  updateCacheStatus();
  updateBulkToolbar();
  renderColPanel(); // keep panel in sync if open
}

/* ============================================================
   Event delegation
   ============================================================ */

function bindTableDelegation() {
  document.querySelector('#card-table thead').addEventListener('click', e => {
    const th = e.target.closest('[data-sort-key]');
    if (th) setSort(th.dataset.sortKey);
  });

  const tbody = document.getElementById('card-body');

  tbody.addEventListener('blur', e => {
    const input = e.target.closest('input[data-field]');
    if (!input || input.type === 'checkbox') return;
    const cardId = getRowCardId(input);
    if (cardId !== null) setField(cardId, input.dataset.field, input.value);
  }, true);

  tbody.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const input = e.target.closest('input[data-field]');
    if (!input || input.type === 'checkbox') return;
    const cardId = getRowCardId(input);
    if (cardId !== null) setField(cardId, input.dataset.field, input.value);
  });

  tbody.addEventListener('change', e => {
    const sel = e.target.closest('select[data-field]');
    if (sel) { const id = getRowCardId(sel); if (id !== null) setField(id, sel.dataset.field, sel.value); return; }
    const cb = e.target.closest('input[type="checkbox"][data-field]');
    if (cb)  { const id = getRowCardId(cb);  if (id !== null) setField(id, cb.dataset.field,  cb.checked);  return; }
    const rowCb = e.target.closest('input[data-action="select-row"]');
    if (rowCb) {
      const id = getRowCardId(rowCb);
      if (id !== null) {
        if (rowCb.checked) selectedIds.add(id); else selectedIds.delete(id);
        updateBulkToolbar();
        const q = filterQuery.toLowerCase();
        const f = q ? cards.filter(c => c.name.toLowerCase().includes(q) || c.setName.toLowerCase().includes(q)) : cards;
        const allChk = document.getElementById('check-all');
        if (allChk) allChk.checked = f.length > 0 && f.every(c => selectedIds.has(c.id));
      }
    }
  });

  tbody.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'delete') {
      if (confirm('Delete this card?')) { const id = getRowCardId(btn); if (id !== null) deleteCard(id); }
      return;
    }
    if (btn.dataset.action === 'duplicate') { const id = getRowCardId(btn); if (id !== null) duplicateCard(id); return; }
    if (btn.dataset.action === 'open-search') { const id = getRowCardId(btn); openSearchModal(id ?? undefined); }
  });
}

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
  pushUndo();
  card[field] = value;
  touchUpdated(card);
  saveCardsToStorage();
  renderTable();
}

function deleteCard(id) {
  pushUndo();
  cards = cards.filter(c => c.id !== id);
  saveCardsToStorage();
  renderTable();
}

function duplicateCard(id) {
  const original = cards.find(c => c.id === id);
  if (!original) return;
  pushUndo();
  const dupe = makeCard({
    ...original, id: undefined, sold: false, soldPrice: '',
    dateAdded: new Date().toISOString(), lastUpdated: new Date().toISOString(),
  });
  const idx = cards.findIndex(c => c.id === id);
  cards.splice(idx + 1, 0, dupe);
  saveCardsToStorage();
  renderTable([dupe.id]);
}

/* ============================================================
   Filter bar
   ============================================================ */

function onFilterInput(e) { filterQuery = e.target.value; renderTable(); }
function clearFilter()     { filterQuery = ''; document.getElementById('filter-input').value = ''; renderTable(); }

/* ============================================================
   Refresh prices
   ============================================================ */

async function refreshAllPrices() {
  if (refreshing) return;
  const refreshable = cards.filter(c => c.tcgplayerId);
  if (!refreshable.length) { setStatus('No cards with API data to refresh.', 'err'); return; }

  refreshing = true;
  const refreshBtn = document.getElementById('refresh-btn');
  refreshBtn.disabled  = true;
  refreshBtn.innerHTML = '<span class="spin">&#8635;</span> Refreshing…';
  setStatus(`<span class="spin" style="display:inline-block;animation:spin 0.85s linear infinite">&#8635;</span> Fetching prices for ${refreshable.length} card${refreshable.length > 1 ? 's' : ''}…`, '');

  pushUndo();
  let ok = 0, fail = 0;
  const updatedIds = [];

  for (const card of refreshable) {
    try {
      const prices = await fetchCardPrices(card.tcgplayerId, true);
      if (prices) {
        const p = prices[card.finish] || prices[Object.keys(prices)[0]] || {};
        if (p.market !== undefined && p.market !== card.marketNM) card.prevMarketNM = card.marketNM;
        if (p.market !== undefined) card.marketNM = p.market;
        if (p.low    !== undefined) card.priceLow = p.low;
        if (p.mid    !== undefined) card.priceMid = p.mid;
        card.lastRefreshed = Date.now();
        touchUpdated(card);
        updatedIds.push(card.id);
        ok++;
      } else { fail++; }
    } catch { fail++; }
    await new Promise(r => setTimeout(r, 150));
  }

  saveCardsToStorage();
  renderTable(updatedIds);
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  setStatus(`Refreshed ${ok} card${ok !== 1 ? 's' : ''}` + (fail ? ` · ${fail} failed` : '') + `  ·  ${time}`, fail && !ok ? 'err' : 'ok');
  refreshBtn.disabled  = false;
  refreshBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8a7 7 0 1 0 1.4-4.2"/><polyline points="1,2 1,6 5,6"/></svg> Refresh prices`;
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
  selectedResult = null; searchJapanese = false;
  document.getElementById('search-input').value            = '';
  document.getElementById('set-filter-input').value        = '';
  document.getElementById('url-input').value               = '';
  document.getElementById('search-results-area').innerHTML = '';
  document.getElementById('url-status').innerHTML          = '';
  document.getElementById('add-selected-btn').disabled     = true;
  document.getElementById('jp-toggle').checked             = false;
  const cardAdded = document.getElementById('card-added');
  if (cardAdded) { cardAdded.textContent = ''; cardAdded.style.display = 'none'; }
  document.getElementById('search-modal').dataset.editId = editId ?? '';
  document.getElementById('search-modal').style.display  = 'flex';
  switchTab('name');
  setTimeout(() => document.getElementById('search-input').focus(), 80);
}

function closeSearchModal() {
  document.getElementById('search-modal').style.display = 'none';
  selectedResult = null;
}

function switchTab(tab) {
  const isName = tab === 'name';
  document.getElementById('tab-name').style.display = isName ? 'block' : 'none';
  document.getElementById('tab-url').style.display  = isName ? 'none'  : 'block';
  document.getElementById('tabBtn-name').classList.toggle('tab-active',  isName);
  document.getElementById('tabBtn-url').classList.toggle('tab-active',  !isName);
  if (isName) document.getElementById('add-selected-btn').disabled = !selectedResult;
}

async function doSearch() {
  const q         = document.getElementById('search-input').value.trim();
  const setQ      = document.getElementById('set-filter-input').value.trim();
  const area      = document.getElementById('search-results-area');
  const searchBtn = document.getElementById('search-btn');
  if (!q) return;
  area.innerHTML = '<div class="loading-state">Searching…</div>';
  searchBtn.disabled = true; selectedResult = null;
  document.getElementById('add-selected-btn').disabled = true;
  try {
    const data = await searchCards(q, setQ, searchJapanese);
    if (!data.length) { area.innerHTML = `<div class="no-results">No cards found. Try a different name${setQ ? ' or set' : ''}.</div>`; return; }
    renderSearchResults(data);
  } catch (err) {
    area.innerHTML = `<div class="no-results">Search failed: ${escHtml(err.message)}<br>Make sure you are serving via HTTP (not file://).</div>`;
  } finally { searchBtn.disabled = false; }
}

function renderSearchResults(data) {
  const area = document.getElementById('search-results-area');
  area.innerHTML = ''; area.className = 'search-results';

  for (const card of data) {
    const prices     = card.tcgplayer?.prices || {};
    const finishKeys = Object.keys(prices);
    const defaultFin = finishKeys[0] || null;
    const div = document.createElement('div');
    div.className = 'result-card';
    div.dataset.cardId         = card.id;
    div.dataset.selectedFinish = defaultFin || '';

    const pricePills = finishKeys.map(fk => {
      const p = prices[fk];
      return `<span class="price-pill${fk === defaultFin ? ' selected-type' : ''}" data-finish="${fk}">
                ${FINISH_LABELS[fk] || fk}: ${p.market ? '$' + Number(p.market).toFixed(2) : '—'}
              </span>`;
    }).join('');

    const finishBtns = finishKeys.length > 1
      ? finishKeys.map(fk => `<button class="finish-btn${fk === defaultFin ? ' active' : ''}" data-finish="${fk}">${FINISH_LABELS[fk] || fk}</button>`).join('')
      : '';

    div.innerHTML = `
      <img class="result-img" src="${escHtml(card.images?.small || '')}" alt="${escHtml(card.name)}">
      <div class="result-info">
        <div class="result-name">${escHtml(card.name)}</div>
        <div class="result-set">${escHtml(card.set?.name || '')} · #${escHtml(card.number || '')}</div>
        <div class="result-prices">${pricePills || '<span style="font-size:11px;color:var(--text-tertiary)">No price data</span>'}</div>
        ${finishBtns ? `<div class="finish-picker">${finishBtns}</div>` : ''}
        <button class="quick-add-btn" data-action="quick-add">Quick Add</button>
      </div>`;

    // Build direct TCGPlayer product URL from productId
    const productId = card.tcgplayer?.productId;
    const directUrl = productId
      ? `https://www.tcgplayer.com/product/${productId}`
      : (card.tcgplayer?.url || '');

    div.dataset.cardJson = JSON.stringify({
      id: card.id, name: card.name,
      imageUrl: card.images?.large || card.images?.small || '',
      setName:  card.set?.name || '',
      tcgplayer: card.tcgplayer || null,
      directUrl,
    });

    div.addEventListener('click', e => {
      if (e.target.closest('[data-action="quick-add"]')) { selectResultCard(card, div); addSelectedCard(); return; }
      const pill = e.target.closest('.price-pill, .finish-btn');
      if (pill) { e.stopPropagation(); selectFinish(card.id, pill.dataset.finish, div); return; }
      selectResultCard(card, div);
    });
    area.appendChild(div);
  }
}

function selectFinish(cardId, finish, div) {
  div.dataset.selectedFinish = finish;
  div.querySelectorAll('.price-pill').forEach(p => p.classList.toggle('selected-type', p.dataset.finish === finish));
  div.querySelectorAll('.finish-btn').forEach(b => b.classList.toggle('active', b.dataset.finish === finish));
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
    directUrl: cardData.directUrl || '',
  };
  document.getElementById('add-selected-btn').disabled = false;
}

async function doUrlLookup() {
  const url       = document.getElementById('url-input').value.trim();
  const statusEl  = document.getElementById('url-status');
  const lookupBtn = document.getElementById('url-lookup-btn');
  if (!url) return;
  statusEl.innerHTML = '<span style="color:var(--text-secondary)">Looking up card…</span>';
  lookupBtn.disabled = true; selectedResult = null;
  document.getElementById('add-selected-btn').disabled = true;
  try {
    const card = await fetchCardByUrl(url);
    if (!card) {
      statusEl.innerHTML = `<span style="color:var(--text-danger)">Could not find a matching Pokémon card.<br>Make sure it's a TCGPlayer product URL.</span>`;
      return;
    }
    renderSearchResults([card]);
    switchTab('name');
    const resultDiv = document.querySelector('.result-card');
    if (resultDiv) selectResultCard(card, resultDiv);
    statusEl.innerHTML = '';
  } catch (err) {
    statusEl.innerHTML = `<span style="color:var(--text-danger)">Lookup failed: ${escHtml(err.message)}</span>`;
  } finally { lookupBtn.disabled = false; }
}

function resetSearchUI() {
  selectedResult = null;
  const input = document.getElementById('search-input');
  const setName = document.getElementById('set-filter-input');
  if (setName) { setName.value = ''; }
  if (input) { input.value = ''; input.focus(); }
  const area = document.getElementById('search-results-area');
  if (area) area.innerHTML = '';
  document.getElementById('add-selected-btn').disabled = true;
}

function showAddSuccess(name, setName) {
  const el  = document.getElementById('card-added');
  const btn = document.getElementById('add-selected-btn');
  if (!el) return;
  el.textContent = `✓ ${name} from ${setName} was added to the list!`;
  el.style.display = 'block';
  btn.disabled = true;
  setTimeout(() => { btn.disabled = false; }, 1500);
}

function addSelectedCard() {
  if (!selectedResult) return;
  const { cardData, finish, prices, directUrl } = selectedResult;
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
    link:        directUrl || '',   // store the direct TCGPlayer product URL
    condition:   'NM',
    buyCost:     '',
    soldPrice:   '',
    sold:        false,
    tcgplayerId: cardData.id,
  };

  pushUndo();
  if (editId) {
    const idx = cards.findIndex(c => c.id === editId);
    if (idx >= 0) { cards[idx] = { ...cards[idx], ...entry }; touchUpdated(cards[idx]); }
  } else {
    cards.push(makeCard(entry));
  }
  saveCardsToStorage();
  renderTable();
  showAddSuccess(cardData.name, cardData.setName);
  resetSearchUI();
}

/* ============================================================
   CSV import / export
   ============================================================ */

async function triggerImport() {
  if (window.showOpenFilePicker) {
    try {
      const [fh] = await window.showOpenFilePicker({ types: [{ description: 'CSV files', accept: { 'text/csv': ['.csv'] } }], multiple: false });
      const text = await (await fh.getFile()).text();
      pendingCSVData = text;
      document.getElementById('import-modal').style.display = 'flex';
      return;
    } catch (err) { if (err.name === 'AbortError') return; }
  }
  document.getElementById('file-input').click();
}

function handleFileImport(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = evt => { pendingCSVData = evt.target.result; document.getElementById('import-modal').style.display = 'flex'; };
  reader.readAsText(file); e.target.value = '';
}

function closeImportModal() { document.getElementById('import-modal').style.display = 'none'; pendingCSVData = null; }

function doImport(mode) {
  if (!pendingCSVData) return;
  pushUndo();
  const rows = parseCSV(pendingCSVData);
  if (mode === 'replace') cards = [];
  for (const row of rows) cards.push(csvRowToCard(row));
  saveCardsToStorage(); closeImportModal(); renderTable();
}

async function handleExportCSV() { await downloadCSV(cards); }

/* ============================================================
   Cache controls
   ============================================================ */

function handleClearCache() {
  clearPriceCache(); updateCacheStatus();
  setStatus('Price cache cleared — next refresh will fetch from the API.', 'ok');
}

/* ============================================================
   initUI — wire all static buttons (Option A)
   ============================================================ */

function initUI() {
  // Toolbar
  document.getElementById('refresh-btn').addEventListener('click', refreshAllPrices);
  document.getElementById('undo-btn').addEventListener('click', undo);
  document.getElementById('import-csv').addEventListener('click', triggerImport);
  document.getElementById('export-csv').addEventListener('click', handleExportCSV);
  document.getElementById('add-card-via-search-btn').addEventListener('click', () => openSearchModal());
  document.getElementById('clear-cache-btn').addEventListener('click', handleClearCache);
  document.getElementById('col-toggle-btn').addEventListener('click', e => { e.stopPropagation(); toggleColPanel(); });

  // Close col panel when clicking outside
  document.addEventListener('click', e => {
    if (colPanelOpen && !e.target.closest('#col-panel') && !e.target.closest('#col-toggle-btn')) {
      closeColPanel();
    }
  });

  // Filter bar
  document.getElementById('filter-input').addEventListener('input', onFilterInput);
  document.getElementById('filter-clear').addEventListener('click', clearFilter);

  // Bulk toolbar
  document.getElementById('bulk-mark-sold').addEventListener('click', bulkMarkSold);
  document.getElementById('bulk-delete').addEventListener('click', bulkDelete);

  // Import modal
  document.getElementById('close-import-btn').addEventListener('click', closeImportModal);
  document.getElementById('do-import-btn').addEventListener('click', () => doImport('add'));
  document.getElementById('replace-import-btn').addEventListener('click', () => doImport('replace'));

  // Search modal tabs
  document.getElementById('tabBtn-name').addEventListener('click', () => switchTab('name'));
  document.getElementById('tabBtn-url').addEventListener('click', () => switchTab('url'));

  // JP toggle
  document.getElementById('jp-toggle').addEventListener('change', e => { searchJapanese = e.target.checked; });

  // Name search
  document.getElementById('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  document.getElementById('set-filter-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  document.getElementById('search-btn').addEventListener('click', doSearch);

  // URL lookup
  document.getElementById('url-input').addEventListener('keydown', e => { if (e.key === 'Enter') doUrlLookup(); });
  document.getElementById('url-lookup-btn').addEventListener('click', doUrlLookup);

  // Search modal footer
  document.getElementById('close-search-btn').addEventListener('click', closeSearchModal);
  document.getElementById('add-selected-btn').addEventListener('click', addSelectedCard);

  // File input fallback
  document.getElementById('file-input').addEventListener('change', handleFileImport);

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeSearchModal(); closeImportModal(); closeColPanel(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
  });

  bindTableDelegation();
  updateUndoButton();
}

/* ============================================================
   Boot
   ============================================================ */

renderTable();
initUI();
