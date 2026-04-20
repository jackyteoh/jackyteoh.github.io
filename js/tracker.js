/**
 * tracker.js — UI logic for index.html.
 */

import {
  CONDITIONS, FINISH_LABELS,
  makeCard, touchUpdated, adjPrice, calcProfit, calcActualProfit, calcPriceDelta, sortCards,
  fmt, fmtPct, fmtTime, fmtDate, fmtAge, escHtml,
  downloadCSV, parseCSV, csvRowToCard,
  searchCards, fetchCardPrices, fetchCardByUrl,
  readPriceCache, inspectPriceCache, clearPriceCache, CACHE_TTL_MS,
  snapshotCards, UNDO_MAX_SNAPSHOTS,
  buildTCGSearchUrl,
  getSeedCards,
} from './core.js';

/* ============================================================
   State
   ============================================================ */

const STORAGE_KEY = 'tcg_tracker_cards';
const COL_VIS_KEY = 'tcg_tracker_col_visibility';

let cards          = loadCardsFromStorage();
let pendingCSVData = null;
let selectedResult = null;
let refreshing     = false;
let filterQuery    = '';
let selectedIds    = new Set();
let undoStack      = [];
let colPanelOpen   = false;

// popover state
let popoverCardId  = null;

// Profit delta since last refresh (sum of adj-price deltas for unsold cards).
// null = no prior refresh data to compare. Set after each successful refresh.
let lastRefreshProfitDelta = null;

let sortKey = 'dateAdded';
let sortDir = 'desc';
let searchJapanese = false;

/* ============================================================
   Column definitions
   ============================================================ */

const COLUMNS = [
  { key: 'condition',   label: 'Condition',      width: '84px',  defaultOn: true  },
  { key: 'buyCost',     label: 'Buy cost',        width: '84px',  defaultOn: true  },
  { key: 'soldPrice',   label: 'Sold price',      width: '88px',  defaultOn: true  },
  { key: 'marketNM',    label: 'Market (NM)',     width: '106px', defaultOn: true  },
  { key: 'priceDelta',  label: 'Δ Price',         width: '84px',  defaultOn: true  },
  { key: 'priceLow',    label: 'Low',             width: '70px',  defaultOn: true  },
  { key: 'priceMid',    label: 'Mid',             width: '70px',  defaultOn: true  },
  { key: 'adjPrice',    label: 'Adj. price',      width: '88px',  defaultOn: true  },
  { key: 'profit',      label: 'Profit / Actual', width: '106px', defaultOn: true  },
  { key: 'pct',         label: 'Profit %',        width: '78px',  defaultOn: true  },
  { key: 'link',        label: 'Link',            width: '80px',  defaultOn: true  },
  { key: 'dateAdded',   label: 'Date added',      width: '110px', defaultOn: true  },
  { key: 'lastUpdated', label: 'Last updated',    width: '110px', defaultOn: false },
];

function loadColVisibility() {
  try {
    const raw = localStorage.getItem(COL_VIS_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
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
   localStorage
   ============================================================ */

function saveCardsToStorage() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cards)); } catch { /* quota */ }
}

function loadCardsFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Ensure all ids are Numbers (fix for cards imported from old CSV/storage)
        return parsed.map(c => ({ ...c, id: Number(c.id) }));
      }
    }
  } catch { /* corrupt */ }
  return getSeedCards();
}

/* ============================================================
   Undo
   ============================================================ */

function pushUndo() {
  undoStack.push(snapshotCards(cards));
  if (undoStack.length > UNDO_MAX_SNAPSHOTS) undoStack.shift();
  updateUndoButton();
}

function undo() {
  if (!undoStack.length) return;
  cards = undoStack.pop();
  // Re-ensure numeric ids after restore
  cards = cards.map(c => ({ ...c, id: Number(c.id) }));
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

  // Profit delta badge — shown only after a refresh that has prior price data to compare
  const deltaEl = document.getElementById('sum-profit-delta');
  if (deltaEl) {
    if (lastRefreshProfitDelta !== null && lastRefreshProfitDelta !== 0) {
      const sign = lastRefreshProfitDelta >= 0 ? '▲' : '▼';
      deltaEl.textContent = `${sign} ${fmt(Math.abs(lastRefreshProfitDelta))} since last refresh`;
      deltaEl.className   = 'metric-delta ' + (lastRefreshProfitDelta >= 0 ? 'delta-up' : 'delta-down');
      deltaEl.style.display = 'block';
    } else {
      deltaEl.style.display = 'none';
    }
  }

  const soldEl = document.getElementById('sum-sold');
  if (soldEl) soldEl.textContent = fmt(totalSold);
  const actEl = document.getElementById('sum-actual-profit');
  if (actEl) { actEl.textContent = fmt(actualProfit); actEl.className = 'metric-value ' + (actualProfit >= 0 ? 'pos' : 'neg'); }
}

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

const STICKY_LEFT  = { checkbox: '0px', image: '36px', name: '90px' };
const STICKY_RIGHT = { actions: '0px', sold: '68px' };

function buildTh(label, key, width, stickyLeft = null, stickyRight = null) {
  const s = stickyLeft  != null ? `position:sticky;left:${stickyLeft};z-index:20;background:var(--bg-secondary);` :
            stickyRight != null ? `position:sticky;right:${stickyRight};z-index:20;background:var(--bg-secondary);` : '';
  return `<th data-sort-key="${key}" style="cursor:pointer;user-select:none;width:${width};${s}">${label} ${sortArrow(key)}</th>`;
}

function buildFixedTh(label, width, stickyLeft = null, stickyRight = null, extra = '') {
  const s = stickyLeft  != null ? `position:sticky;left:${stickyLeft};z-index:20;background:var(--bg-secondary);` :
            stickyRight != null ? `position:sticky;right:${stickyRight};z-index:20;background:var(--bg-secondary);` : '';
  return `<th style="width:${width};${s}${extra}">${label}</th>`;
}

/* ============================================================
   Column visibility panel
   ============================================================ */

function toggleColPanel() { colPanelOpen = !colPanelOpen; renderColPanel(); }

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
  panel.querySelectorAll('input[data-col-key]').forEach(cb => {
    cb.addEventListener('change', e => {
      colVisibility[e.target.dataset.colKey] = e.target.checked;
      saveColVisibility(); renderTable();
    });
  });
  document.getElementById('col-reset-btn').addEventListener('click', () => {
    COLUMNS.forEach(col => { colVisibility[col.key] = col.defaultOn; });
    saveColVisibility(); renderColPanel(); renderTable();
  });
}

/* ============================================================
   Bulk-select
   ============================================================ */

function updateBulkToolbar() {
  const bar = document.getElementById('bulk-toolbar');
  const info = document.getElementById('bulk-count');
  if (!bar) return;
  const n = selectedIds.size;
  bar.style.display = n > 0 ? 'flex' : 'none';
  if (info) info.textContent = `${n} selected`;
}

function toggleSelectAll(checked) {
  const q = filterQuery.toLowerCase();
  const f = q ? cards.filter(c => c.name.toLowerCase().includes(q) || c.setName.toLowerCase().includes(q)) : cards;
  if (checked) f.forEach(c => selectedIds.add(c.id)); else selectedIds.clear();
  renderTable();
}

function bulkMarkSold() {
  if (!selectedIds.size) return;
  pushUndo();
  for (const id of selectedIds) { const c = cards.find(x => x.id === id); if (c) { c.sold = true; touchUpdated(c); } }
  selectedIds.clear(); saveCardsToStorage(); renderTable();
  setStatus('Selected cards marked as sold.', 'ok');
}

function bulkDelete() {
  if (!selectedIds.size) return;
  const n = selectedIds.size;
  if (!confirm(`Delete ${n} selected card${n !== 1 ? 's' : ''}? This cannot be undone without Undo.`)) return;
  pushUndo();
  cards = cards.filter(c => !selectedIds.has(c.id));
  selectedIds.clear(); saveCardsToStorage(); renderTable();
  setStatus(`Deleted ${n} card${n !== 1 ? 's' : ''}.`, 'ok');
}

/* ============================================================
   Table rendering
   ============================================================ */

function renderTable(highlightIds = []) {
  const query      = filterQuery.toLowerCase();
  const filtered   = query ? cards.filter(c => c.name.toLowerCase().includes(query) || c.setName.toLowerCase().includes(query)) : cards;
  const allVisible = filtered.length > 0 && filtered.every(c => selectedIds.has(c.id));

  // Header
  const thead = document.querySelector('#card-table thead tr');
  let hh =
    buildFixedTh(`<input type="checkbox" id="check-all" ${allVisible && selectedIds.size > 0 ? 'checked' : ''}>`, '36px', STICKY_LEFT.checkbox, null, 'text-align:center;') +
    buildFixedTh('Image', '54px', STICKY_LEFT.image) +
    buildTh('Name', 'name', '200px', STICKY_LEFT.name);
  for (const col of COLUMNS) {
    if (!isColVisible(col.key)) continue;
    if (['link','dateAdded','lastUpdated'].includes(col.key)) hh += buildFixedTh(col.label, col.width);
    else hh += buildTh(col.label, col.key, col.width);
  }
  hh += buildTh('Sold', 'sold', '52px', null, STICKY_RIGHT.sold) +
        buildFixedTh('', '68px', null, STICKY_RIGHT.actions);
  thead.innerHTML = hh;
  const checkAllEl = document.getElementById('check-all');
  if (checkAllEl) checkAllEl.addEventListener('change', e => toggleSelectAll(e.target.checked));

  const displayRows = sortCards(filtered, sortKey, sortDir);
  const tbody = document.getElementById('card-body');
  tbody.innerHTML = '';

  for (const card of displayRows) {
    const adj         = adjPrice(card);
    const delta       = calcPriceDelta(card);
    const highlighted = highlightIds.includes(card.id);
    const cached      = readPriceCache(card.tcgplayerId);
    const isSelected  = selectedIds.has(card.id);
    const hasActual   = card.sold && parseFloat(card.soldPrice) > 0;
    const { profit, pct } = hasActual ? calcActualProfit(card) : calcProfit(card);
    const profitLabel = hasActual ? 'Actual' : 'Expected';

    let deltaBadge = '<span style="color:var(--text-tertiary)">—</span>';
    if (delta !== null) {
      const sign = delta >= 0 ? '▲' : '▼';
      deltaBadge = `<span class="${delta >= 0 ? 'delta-up' : 'delta-down'}">${sign} ${fmt(Math.abs(delta))}</span>`;
    }

    const tr = document.createElement('tr');
    tr.dataset.cardId = card.id;
    if (card.sold)   tr.classList.add('sold');
    if (isSelected)  tr.classList.add('row-selected');
    if (highlighted) tr.style.background = 'rgba(60,180,80,0.10)';

    const imgContent = card.imageUrl
      ? `<img class="card-img" src="${escHtml(card.imageUrl)}" alt="${escHtml(card.name)}"
              data-action="open-popover"
              style="cursor:pointer"
              onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
         <div class="card-img-placeholder" style="display:none">No image</div>`
      : `<div class="card-img-placeholder" data-action="open-search">Click to search</div>`;

    const finishLabel = FINISH_LABELS[card.finish] || card.finish || '';
    const subtitle    = [finishLabel, card.setName].filter(Boolean).join(' · ');
    const cacheTitle  = cached ? `title="Cached ${fmtAge(Date.now() - cached.cachedAt)}"` : 'title="Not cached"';
    const tcgUrl      = buildTCGSearchUrl(card.name, card.setName, card.link);

    // Frozen-left
    let rowHtml = `
      <td class="frozen-left" style="left:${STICKY_LEFT.checkbox};text-align:center;width:36px">
        <input type="checkbox" data-action="select-row" ${isSelected ? 'checked' : ''}>
      </td>
      <td class="frozen-left" style="left:${STICKY_LEFT.image};width:54px">${imgContent}</td>
      <td class="frozen-left name-cell" style="left:${STICKY_LEFT.name};width:200px;min-width:200px">
        <input type="text" value="${escHtml(card.name)}" placeholder="Card name" data-field="name">
        ${subtitle ? `<div class="name-subtitle">${escHtml(subtitle)}</div>` : ''}
        ${card.notes ? `<div class="name-notes" title="${escHtml(card.notes)}">${escHtml(card.notes)}</div>` : ''}
        ${card.lastRefreshed ? `<div class="refresh-detail">Refreshed ${fmtTime(card.lastRefreshed)}</div>` : ''}
      </td>`;

    // Middle
    const cells = {
      condition: `<td><select data-field="condition">${CONDITIONS.map(c => `<option value="${c}"${c === card.condition ? ' selected' : ''}>${c}</option>`).join('')}</select></td>`,
      buyCost:   `<td><input type="number" value="${card.buyCost}" placeholder="0.00" step="0.01" min="0" data-field="buyCost"></td>`,
      soldPrice: `<td><input type="number" value="${card.soldPrice}" placeholder="—" step="0.01" min="0" data-field="soldPrice" title="Actual sale price"></td>`,
      marketNM:  `<td style="font-size:12px${highlighted ? ';color:var(--text-success)' : ''}" ${cacheTitle}>${fmt(card.marketNM)}${cached ? ' <span class="cache-dot">●</span>' : ''}</td>`,
      priceDelta:`<td>${deltaBadge}</td>`,
      priceLow:  `<td style="font-size:12px;color:var(--text-secondary)">${fmt(card.priceLow)}</td>`,
      priceMid:  `<td style="font-size:12px;color:var(--text-secondary)">${fmt(card.priceMid)}</td>`,
      adjPrice:  `<td style="font-weight:500">${adj > 0 ? fmt(adj) : '<span style="color:var(--text-tertiary)">—</span>'}</td>`,
      profit:    `<td class="${profit === null ? '' : profit >= 0 ? 'profit-pos' : 'profit-neg'}">${fmt(profit)}<div style="font-size:9px;color:var(--text-tertiary);margin-top:1px">${profitLabel}</div></td>`,
      pct:       `<td class="${pct === null ? '' : pct >= 0 ? 'profit-pos' : 'profit-neg'}">${fmtPct(pct)}</td>`,
      link:      `<td>${tcgUrl ? `<a href="${escHtml(tcgUrl)}" target="_blank" rel="noopener" class="link-open">TCGPlayer ↗</a>` : '<span style="font-size:11px;color:var(--text-tertiary)">—</span>'}</td>`,
      dateAdded:  `<td class="date-cell">${escHtml(fmtDate(card.dateAdded))}</td>`,
      lastUpdated:`<td class="date-cell">${escHtml(fmtDate(card.lastUpdated))}</td>`,
    };
    for (const col of COLUMNS) { if (isColVisible(col.key)) rowHtml += cells[col.key]; }

    // Frozen-right
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
    emptyTr.innerHTML = `<td colspan="${span}" style="text-align:center;padding:2rem;color:var(--text-tertiary)">${query ? `No cards match "${escHtml(filterQuery)}"` : 'No cards yet — add one below.'}</td>`;
    tbody.appendChild(emptyTr);
  }

  updateSummary();
  updateCacheStatus();
  updateBulkToolbar();
  renderColPanel();
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

  // #7 Fix: no full re-render on blur for text/number inputs.
  // We update the card data and save, then only re-render the summary.
  // Full renderTable() only fires for fields that affect visible computed cells.
  const FULL_RERENDER_FIELDS = new Set(['condition', 'sold', 'buyCost', 'soldPrice', 'marketNM']);

  tbody.addEventListener('blur', e => {
    const input = e.target.closest('input[data-field]');
    if (!input || input.type === 'checkbox') return;
    const cardId = getRowCardId(input);
    if (cardId === null) return;
    const field = input.dataset.field;
    const value = input.value;
    const card = cards.find(c => c.id === cardId);
    if (!card || card[field] === value) return; // no change
    pushUndo();
    card[field] = value;
    touchUpdated(card);
    saveCardsToStorage();
    // Only full re-render when other cells are affected by this field change
    if (FULL_RERENDER_FIELDS.has(field)) renderTable();
    else updateSummary(); // just refresh totals
  }, true);

  tbody.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const input = e.target.closest('input[data-field]');
    if (!input || input.type === 'checkbox') return;
    input.blur(); // trigger blur handler above
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
    if (btn.dataset.action === 'open-search') { const id = getRowCardId(btn); openSearchModal(id ?? undefined); return; }
    if (btn.dataset.action === 'open-popover') { const id = getRowCardId(btn); if (id !== null) openPopover(id, btn); return; }
  });
}

// #2 Fix: always coerce to Number so === works even after JSON round-trips
function getRowCardId(el) {
  const tr = el.closest('tr[data-card-id]');
  return tr ? Number(tr.dataset.cardId) : null;
}

/* ============================================================
   Field mutation helpers
   ============================================================ */

// Used for select/checkbox changes that always need a full re-render
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
    ...original,
    id:          undefined,   // makeCard assigns a fresh numeric id
    sold:        false,
    soldPrice:   '',
    dateAdded:   new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  });
  const idx = cards.findIndex(c => c.id === id);
  cards.splice(idx + 1, 0, dupe);
  saveCardsToStorage();
  renderTable([dupe.id]);
}

/* ============================================================
   Quick-edit popover (#8 / #9)
   ============================================================ */

function openPopover(cardId, triggerEl) {
  const card = cards.find(c => c.id === cardId);
  if (!card) return;
  popoverCardId = cardId;

  const popEl = document.getElementById('card-popover');
  if (!popEl) return;

  const finishLabel = FINISH_LABELS[card.finish] || card.finish || '';
  const subtitle    = [finishLabel, card.setName].filter(Boolean).join(' · ');
  const adj         = adjPrice(card);
  const { profit }  = calcProfit(card);

  popEl.innerHTML = `
    <div class="popover-header">
      ${card.imageUrl ? `<img class="popover-img" src="${escHtml(card.imageUrl)}" alt="${escHtml(card.name)}">` : ''}
      <div class="popover-title-block">
        <div class="popover-card-name">${escHtml(card.name)}</div>
        <div class="popover-card-sub">${escHtml(subtitle)}</div>
        ${card.sold ? '<span class="popover-sold-badge">Sold</span>' : ''}
      </div>
      <button class="popover-close" id="popover-close-btn" aria-label="Close">✕</button>
    </div>

    <div class="popover-grid">
      <div class="popover-field">
        <label class="popover-label">Condition</label>
        <select id="pop-condition">
          ${CONDITIONS.map(c => `<option value="${c}"${c === card.condition ? ' selected' : ''}>${c}</option>`).join('')}
        </select>
      </div>
      <div class="popover-field">
        <label class="popover-label">Finish</label>
        <select id="pop-finish">
          ${Object.entries(FINISH_LABELS).map(([k,v]) => `<option value="${k}"${k === card.finish ? ' selected' : ''}>${v}</option>`).join('')}
        </select>
      </div>
      <div class="popover-field">
        <label class="popover-label">Buy cost</label>
        <input type="number" id="pop-buyCost" value="${card.buyCost}" step="0.01" min="0" placeholder="0.00">
      </div>
      <div class="popover-field">
        <label class="popover-label">Market (NM)</label>
        <input type="number" id="pop-marketNM" value="${card.marketNM ?? ''}" step="0.01" min="0" placeholder="—">
      </div>
    </div>

    <div class="popover-field" style="margin-bottom:0.65rem">
      <label class="popover-label">Notes / memo</label>
      <textarea id="pop-notes" rows="2" placeholder="e.g. Bought at locals, PSA pending, trade target…">${escHtml(card.notes || '')}</textarea>
    </div>

    <div class="popover-stats">
      <div class="popover-stat">
        <div class="popover-stat-label">Adj. price</div>
        <div class="popover-stat-val" id="pop-adj">${fmt(adj)}</div>
      </div>
      <div class="popover-stat">
        <div class="popover-stat-label">Expected profit</div>
        <div class="popover-stat-val ${profit === null ? '' : profit >= 0 ? 'pos' : 'neg'}" id="pop-profit">${fmt(profit)}</div>
      </div>
    </div>

    <div class="popover-actions">
      <button class="btn btn-sm" id="pop-cancel-btn">Cancel</button>
      <button class="btn btn-sm btn-primary" id="pop-save-btn">Save changes</button>
    </div>`;

  // Position: below the trigger row
  const tableWrap = document.querySelector('.table-wrap');
  const triggerRect = triggerEl.getBoundingClientRect();
  const wrapRect    = tableWrap.getBoundingClientRect();
  const relTop  = triggerRect.bottom - wrapRect.top + tableWrap.scrollTop + 4;
  const relLeft = Math.max(4, Math.min(triggerRect.left - wrapRect.left - 4, wrapRect.width - 360));
  popEl.style.top     = relTop + 'px';
  popEl.style.left    = relLeft + 'px';
  popEl.style.display = 'block';
  document.getElementById('popover-backdrop').style.display = 'block';

  // Live computed stats
  function refreshStats() {
    const mkt  = parseFloat(document.getElementById('pop-marketNM').value) || 0;
    const buy  = parseFloat(document.getElementById('pop-buyCost').value)  || 0;
    const cond = document.getElementById('pop-condition').value;
    const MULT = { NM:1, LP:.85, MP:.7, HP:.5, DMG:.3 };
    const adjV = mkt * (MULT[cond] || 1);
    const profV = (adjV && buy) ? adjV - buy : null;
    document.getElementById('pop-adj').textContent = fmt(adjV);
    const profEl = document.getElementById('pop-profit');
    profEl.textContent = fmt(profV);
    profEl.className   = 'popover-stat-val ' + (profV === null ? '' : profV >= 0 ? 'pos' : 'neg');
  }

  ['pop-condition','pop-buyCost','pop-marketNM'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', refreshStats);
  });

  document.getElementById('popover-close-btn').addEventListener('click', closePopover);
  document.getElementById('pop-cancel-btn').addEventListener('click', closePopover);
  document.getElementById('pop-save-btn').addEventListener('click', savePopover);
}

function closePopover() {
  document.getElementById('card-popover').style.display       = 'none';
  document.getElementById('popover-backdrop').style.display   = 'none';
  popoverCardId = null;
}

function savePopover() {
  if (popoverCardId === null) return;
  const card = cards.find(c => c.id === popoverCardId);
  if (!card) { closePopover(); return; }

  pushUndo();
  card.condition = document.getElementById('pop-condition').value;
  card.finish    = document.getElementById('pop-finish').value;
  card.buyCost   = document.getElementById('pop-buyCost').value;
  const mktVal   = document.getElementById('pop-marketNM').value;
  card.marketNM  = mktVal !== '' ? parseFloat(mktVal) : null;
  card.notes     = document.getElementById('pop-notes').value;
  touchUpdated(card);
  saveCardsToStorage();
  closePopover();
  renderTable();
}

/* ============================================================
   Filter bar
   ============================================================ */

function onFilterInput(e) { filterQuery = e.target.value; renderTable(); }
function clearFilter()     { filterQuery = ''; document.getElementById('filter-input').value = ''; renderTable(); }

/* ============================================================
   Refresh prices (#4 — skip sold + dedup by tcgplayerId)
   ============================================================ */

async function refreshAllPrices() {
  if (refreshing) return;

  const skipSold = document.getElementById('skip-sold-cb')?.checked ?? true;
  const eligible = cards.filter(c => c.tcgplayerId && !(skipSold && c.sold));
  if (!eligible.length) {
    setStatus(skipSold ? 'No unsold cards with price data to refresh.' : 'No cards with price data to refresh.', 'err');
    return;
  }

  // Deduplicate: only fetch each unique tcgplayerId once
  const uniqueIds = [...new Set(eligible.map(c => c.tcgplayerId))];
  const total = uniqueIds.length;

  refreshing = true;
  const refreshBtn = document.getElementById('refresh-btn');
  refreshBtn.disabled  = true;
  refreshBtn.innerHTML = '<span class="spin">&#8635;</span> Refreshing…';

  // Show and reset progress bar
  const progressWrap  = document.getElementById('refresh-progress-wrap');
  const progressBar   = document.getElementById('refresh-progress-bar');
  const progressLabel = document.getElementById('refresh-progress-label');
  const progressCount = document.getElementById('refresh-progress-count');
  if (progressWrap)  progressWrap.style.display = 'block';
  if (progressBar)   progressBar.style.width    = '0%';
  if (progressCount) progressCount.textContent  = `0 / ${total}`;
  if (progressLabel) progressLabel.textContent  = 'Fetching prices…';

  setStatus('', '');

  pushUndo();
  let ok = 0, fail = 0;
  const priceMap   = {}; // tcgplayerId → prices object
  const updatedIds = [];

  for (let i = 0; i < uniqueIds.length; i++) {
    const tcgId = uniqueIds[i];

    // Update progress before the fetch so the user sees movement immediately
    const pct = Math.round(((i) / total) * 100);
    if (progressBar)   progressBar.style.width   = pct + '%';
    if (progressCount) progressCount.textContent = `${i + 1} / ${total}`;
    // if (progressLabel && i < uniqueIds.length - 1) progressLabel.textContent = `Fetching: ${cardName}`;

    try {
      const prices = await fetchCardPrices(tcgId, true);
      if (prices) { priceMap[tcgId] = prices; ok++; }
      else          fail++;
    } catch { fail++; }
    await new Promise(r => setTimeout(r, 120));
  }

  // Fill bar to 100%
  if (progressBar)   progressBar.style.width   = '100%';
  if (progressCount) progressCount.textContent = `${total} / ${total}`;
  if (progressLabel) progressLabel.textContent = 'Done!';

  // Apply fetched prices to all matching cards, accumulating profit delta
  let profitDeltaSum = 0;
  let hasDeltaData   = false;

  for (const card of eligible) {
    const prices = priceMap[card.tcgplayerId];
    if (!prices) continue;
    const p = prices[card.finish] || prices[Object.keys(prices)[0]] || {};

    // Capture old marketNM for delta before overwriting
    const oldMarket = card.marketNM;

    if (p.market !== undefined && p.market !== card.marketNM) card.prevMarketNM = card.marketNM;
    if (p.market !== undefined) card.marketNM = p.market;
    if (p.low    !== undefined) card.priceLow = p.low;
    if (p.mid    !== undefined) card.priceMid = p.mid;
    card.lastRefreshed = Date.now();
    touchUpdated(card);
    updatedIds.push(card.id);

    // Accumulate profit delta for unsold cards with both old and new prices
    if (!card.sold && oldMarket !== null && card.marketNM !== null) {
      const mult = { NM:1, LP:.85, MP:.7, HP:.5, DMG:.3 }[card.condition] ?? 1;
      profitDeltaSum += (card.marketNM - oldMarket) * mult;
      hasDeltaData = true;
    }
  }

  // Store profit delta for display in summary (null = no data)
  lastRefreshProfitDelta = hasDeltaData ? profitDeltaSum : null;

  saveCardsToStorage();
  renderTable(updatedIds);

  // Hide progress bar after a short delay so the user can see it hit 100%
  setTimeout(() => {
    if (progressWrap)  progressWrap.style.display = 'none';
    if (progressBar)   progressBar.style.width    = '0%';
    if (progressLabel) progressLabel.textContent  = 'Fetching prices…';
    if (progressCount) progressCount.textContent  = '0 / 0';
  }, 800);

  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  setStatus(
    `Refreshed ${ok} unique price${ok !== 1 ? 's' : ''} \u2192 applied to ${updatedIds.length} card${updatedIds.length !== 1 ? 's' : ''}` +
    (fail ? ` · ${fail} failed` : '') + `  ·  ${time}`,
    fail && !ok ? 'err' : 'ok'
  );
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
    if (!data.length) {
      area.innerHTML = `<div class="no-results">No cards found${searchJapanese ? ' (Japanese mode \u2014 try the English name)' : ''}. Try a different name${setQ ? ' or set' : ''}.</div>`;
      return;
    }
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
    div.dataset.cardId = card.id;
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

    // No price data note for new sets
    const noPriceNote = finishKeys.length === 0
      ? '<div style="font-size:10px;color:var(--text-tertiary);margin-top:4px">No price data yet — set may be too new for TCGPlayer</div>'
      : '';

    div.innerHTML = `
      <img class="result-img" src="${escHtml(card.images?.small || '')}" alt="${escHtml(card.name)}">
      <div class="result-info">
        <div class="result-name">${escHtml(card.name)}</div>
        <div class="result-set">${escHtml(card.set?.name || '')} · #${escHtml(card.number || '')}</div>
        <div class="result-prices">${pricePills || '<span style="font-size:11px;color:var(--text-tertiary)">No price data</span>'}</div>
        ${noPriceNote}
        ${finishBtns ? `<div class="finish-picker">${finishBtns}</div>` : ''}
        <button class="quick-add-btn" data-action="quick-add">Quick add</button>
      </div>`;

    div.dataset.cardJson = JSON.stringify({
      id: card.id, name: card.name,
      imageUrl: card.images?.large || card.images?.small || '',
      setName:  card.set?.name || '',
      tcgplayer: card.tcgplayer || null,
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
  selectedResult = { cardId: card.id, cardData, finish, prices: card.tcgplayer?.prices || {} };
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
      statusEl.innerHTML = `<span style="color:var(--text-danger)">Could not find a matching Pokémon card. Make sure it's a TCGPlayer product URL.</span>`;
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
  if (input) { input.value = ''; input.focus(); }
  const area = document.getElementById('search-results-area');
  if (area) area.innerHTML = '';
  document.getElementById('add-selected-btn').disabled = true;
}

function showAddSuccess(name, setName) {
  const el  = document.getElementById('card-added');
  const btn = document.getElementById('add-selected-btn');
  if (!el) return;
  el.textContent   = `✓ ${name}${setName ? ' from ' + setName : ''} added!`;
  el.style.display = 'block';
  btn.disabled = true;
  setTimeout(() => { el.style.display = 'none'; btn.disabled = false; }, 1500);
}

function addSelectedCard() {
  if (!selectedResult) return;
  const { cardData, finish, prices } = selectedResult;
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
    link:        '',           // link column now always uses buildTCGSearchUrl at render time
    condition:   'NM',
    buyCost:     '',
    soldPrice:   '',
    notes:       '',
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
      pendingCSVData = await (await fh.getFile()).text();
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

function handleClearCache() {
  clearPriceCache(); updateCacheStatus();
  setStatus('Price cache cleared — next refresh will fetch from the API.', 'ok');
}

/* ============================================================
   How To modal (#3)
   ============================================================ */

function openHowTo() {
  document.getElementById('howto-modal').style.display = 'flex';
}

function closeHowTo() {
  document.getElementById('howto-modal').style.display = 'none';
}

/* ============================================================
   initUI
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
  document.getElementById('howto-btn').addEventListener('click', openHowTo);
  document.getElementById('howto-close-x').addEventListener('click', closeHowTo);
  document.getElementById('howto-close-footer').addEventListener('click', closeHowTo);

  // Close col panel on outside click
  document.addEventListener('click', e => {
    if (colPanelOpen && !e.target.closest('#col-panel') && !e.target.closest('#col-toggle-btn')) closeColPanel();
  });

  // Filter
  document.getElementById('filter-input').addEventListener('input', onFilterInput);
  document.getElementById('filter-clear').addEventListener('click', clearFilter);

  // Bulk
  document.getElementById('bulk-mark-sold').addEventListener('click', bulkMarkSold);
  document.getElementById('bulk-delete').addEventListener('click', bulkDelete);

  // Import modal
  document.getElementById('close-import-btn').addEventListener('click', closeImportModal);
  document.getElementById('do-import-btn').addEventListener('click', () => doImport('add'));
  document.getElementById('replace-import-btn').addEventListener('click', () => doImport('replace'));

  // Search modal
  document.getElementById('tabBtn-name').addEventListener('click', () => switchTab('name'));
  document.getElementById('tabBtn-url').addEventListener('click', () => switchTab('url'));
  document.getElementById('jp-toggle').addEventListener('change', e => { searchJapanese = e.target.checked; });
  document.getElementById('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  document.getElementById('set-filter-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  document.getElementById('search-btn').addEventListener('click', doSearch);
  document.getElementById('url-input').addEventListener('keydown', e => { if (e.key === 'Enter') doUrlLookup(); });
  document.getElementById('url-lookup-btn').addEventListener('click', doUrlLookup);
  document.getElementById('close-search-btn').addEventListener('click', closeSearchModal);
  document.getElementById('add-selected-btn').addEventListener('click', addSelectedCard);

  // Popover backdrop
  document.getElementById('popover-backdrop').addEventListener('click', closePopover);

  // File input fallback
  document.getElementById('file-input').addEventListener('change', handleFileImport);

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeSearchModal(); closeImportModal(); closeColPanel(); closePopover(); closeHowTo(); }
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
