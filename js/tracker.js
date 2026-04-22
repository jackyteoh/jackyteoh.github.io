/**
 * tracker.js — UI logic for index.html.  v9
 *
 * New / fixed this version:
 *  #10  bulkRefresh, bulkUnmarkSold, bulkSetCondition
 *  #12  dateAdded + lastUpdated now use buildTh (sortable), default desc
 *  #13  notes rendered as inline textarea (saves on blur)
 *  #15  duplicateCard: destructures id out before spread (NaN fix)
 *  bonus: filter debounce (150 ms); export filtered view
 */

import {
  CONDITIONS, FINISH_LABELS,
  makeCard, syncNextId, touchUpdated,
  adjPrice, calcProfit, calcActualProfit, calcPriceDelta, sortCards,
  fmt, fmtPct, fmtTime, fmtDate, fmtAge, escHtml,
  exportCSV, downloadCSV, parseCSV, csvRowToCard,
  searchCards, fetchCardPrices, fetchCardByUrl,
  readPriceCache, inspectPriceCache, clearPriceCache, CACHE_TTL_MS,
  snapshotCards, UNDO_MAX_SNAPSHOTS,
  buildTCGSearchUrl, getSeedCards,
} from './core.js';

/* ============================================================
   State
   ============================================================ */

const STORAGE_KEY   = 'tcg_tracker_cards';
const COL_VIS_KEY   = 'tcg_tracker_col_visibility';
const HIDE_SOLD_KEY = 'tcg_tracker_hide_sold';

let cards          = loadCardsFromStorage();
let pendingCSVData = null;
let selectedResult = null;
let refreshing     = false;
let filterQuery    = '';
let filterTimer    = null;   // debounce handle
let hideSold       = loadHideSold();
let selectedIds    = new Set();
let undoStack      = [];
let colPanelOpen   = false;
let popoverCardId  = null;
let lastRefreshProfitDelta = null;

let sortKey        = 'dateAdded';
let sortDir        = 'desc';
let searchJapanese = false;

/* ============================================================
   Column definitions — #12: dateAdded / lastUpdated now sortable
   ============================================================ */

const COLUMNS = [
  { key: 'condition',   label: 'Condition',      width: '84px',  defaultOn: true,  sortable: true  },
  { key: 'buyCost',     label: 'Buy cost',        width: '84px',  defaultOn: true,  sortable: true  },
  { key: 'soldPrice',   label: 'Sold price',      width: '88px',  defaultOn: true,  sortable: true  },
  { key: 'marketNM',    label: 'Market (NM)',     width: '106px', defaultOn: true,  sortable: true  },
  { key: 'priceDelta',  label: 'Δ Price',         width: '84px',  defaultOn: true,  sortable: true  },
  { key: 'priceLow',    label: 'Low',             width: '70px',  defaultOn: true,  sortable: true  },
  { key: 'priceMid',    label: 'Mid',             width: '70px',  defaultOn: true,  sortable: true  },
  { key: 'adjPrice',    label: 'Adj. price',      width: '88px',  defaultOn: true,  sortable: true  },
  { key: 'profit',      label: 'Profit / Actual', width: '106px', defaultOn: true,  sortable: true  },
  { key: 'pct',         label: 'Profit %',        width: '78px',  defaultOn: true,  sortable: true  },
  { key: 'link',        label: 'Link',            width: '80px',  defaultOn: true,  sortable: false },
  { key: 'dateAdded',   label: 'Date added',      width: '110px', defaultOn: true,  sortable: true  }, // #12
  { key: 'lastUpdated', label: 'Last updated',    width: '110px', defaultOn: false, sortable: true  }, // #12
];

function loadColVisibility() {
  try {
    const raw = localStorage.getItem(COL_VIS_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      return COLUMNS.reduce((acc, col) => { acc[col.key] = col.key in saved ? saved[col.key] : col.defaultOn; return acc; }, {});
    }
  } catch { /* corrupt */ }
  return Object.fromEntries(COLUMNS.map(c => [c.key, c.defaultOn]));
}
function saveColVisibility() { try { localStorage.setItem(COL_VIS_KEY, JSON.stringify(colVisibility)); } catch { /* quota */ } }
let colVisibility = loadColVisibility();
function isColVisible(key) { return colVisibility[key] !== false; }

function loadHideSold() { try { return localStorage.getItem(HIDE_SOLD_KEY) === 'true'; } catch { return false; } }
function saveHideSold()  { try { localStorage.setItem(HIDE_SOLD_KEY, String(hideSold)); } catch { /* quota */ } }

/* ============================================================
   Storage
   ============================================================ */

function saveCardsToStorage() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cards)); } catch { /* quota */ } }

function loadCardsFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const result = parsed.map(c => ({ ...c, id: Number(c.id) }));
        syncNextId(result);
        return result;
      }
    }
  } catch { /* corrupt */ }
  const seed = getSeedCards(); syncNextId(seed); return seed;
}

/* ============================================================
   Undo
   ============================================================ */

function pushUndo() { undoStack.push(snapshotCards(cards)); if (undoStack.length > UNDO_MAX_SNAPSHOTS) undoStack.shift(); updateUndoButton(); }

function undo() {
  if (!undoStack.length) return;
  cards = undoStack.pop().map(c => ({ ...c, id: Number(c.id) }));
  syncNextId(cards);
  lastRefreshProfitDelta = null;
  saveCardsToStorage(); selectedIds.clear(); renderTable(); updateUndoButton();
  setStatus('Undo successful.', 'ok');
}
function updateUndoButton() { const btn = document.getElementById('undo-btn'); if (btn) btn.disabled = undoStack.length === 0; }

/* ============================================================
   Summary bar
   ============================================================ */

function updateSummary() {
  let count = 0, cost = 0, market = 0, expProfit = 0, totalSold = 0, actualProfit = 0;
  for (const c of cards) {
    count++; cost += parseFloat(c.buyCost) || 0;
    if (!c.sold) { const m = adjPrice(c); market += m; expProfit += m - (parseFloat(c.buyCost) || 0); }
    else { const sp = parseFloat(c.soldPrice) || 0; if (sp) { totalSold += sp; actualProfit += sp - (parseFloat(c.buyCost) || 0); } }
  }
  document.getElementById('sum-count').textContent  = count;
  document.getElementById('sum-cost').textContent   = fmt(cost);
  document.getElementById('sum-market').textContent = fmt(market);
  const profitEl = document.getElementById('sum-profit');
  profitEl.textContent = fmt(expProfit); profitEl.className = 'metric-value ' + (expProfit >= 0 ? 'pos' : 'neg');
  const deltaEl = document.getElementById('sum-profit-delta');
  if (deltaEl) {
    if (lastRefreshProfitDelta !== null) {
      const sign = lastRefreshProfitDelta >= 0 ? '▲' : '▼';
      deltaEl.textContent   = `${sign} ${fmt(Math.abs(lastRefreshProfitDelta))} since last refresh`;
      deltaEl.className     = 'metric-delta ' + (lastRefreshProfitDelta >= 0 ? 'delta-up' : 'delta-down');
      deltaEl.style.display = 'block';
    } else { deltaEl.style.display = 'none'; }
  }
  const soldEl = document.getElementById('sum-sold');
  if (soldEl) soldEl.textContent = fmt(totalSold);
  const actEl = document.getElementById('sum-actual-profit');
  if (actEl) { actEl.textContent = fmt(actualProfit); actEl.className = 'metric-value ' + (actualProfit >= 0 ? 'pos' : 'neg'); }
}

function updateCacheStatus() {
  const el = document.getElementById('cache-status'); if (!el) return;
  const { count, oldestAgeMs } = inspectPriceCache();
  if (count === 0) { el.textContent = 'Price cache empty'; return; }
  const ttlHours = Math.round(CACHE_TTL_MS / 3600000);
  el.textContent = `${count} price${count !== 1 ? 's' : ''} cached` + (oldestAgeMs !== null ? ` · oldest ${fmtAge(oldestAgeMs)}` : '') + ` · TTL ${ttlHours}h`;
}

/* ============================================================
   Sort helpers
   ============================================================ */

function setSort(key) { sortDir = (sortKey === key && sortDir === 'asc') ? 'desc' : 'asc'; sortKey = key; renderTable(); }
function sortArrow(key) {
  if (sortKey !== key) return '<span class="sort-arrow inactive">↕</span>';
  return `<span class="sort-arrow">${sortDir === 'asc' ? '↑' : '↓'}</span>`;
}

// Frozen column offsets (pixels from each sticky edge)
const STICKY_LEFT  = { checkbox: '0px', image: '36px', name: '90px' };
const STICKY_RIGHT = { actions: '0px', sold: '68px', rowRefresh: '120px' };

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
   Column panel
   ============================================================ */

function toggleColPanel() { colPanelOpen = !colPanelOpen; renderColPanel(); }
function closeColPanel()  { colPanelOpen = false; const p = document.getElementById('col-panel'); if (p) p.style.display = 'none'; }

function renderColPanel() {
  const panel = document.getElementById('col-panel'); if (!panel) return;
  if (!colPanelOpen) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  panel.innerHTML = `
    <div class="col-panel-header"><span>Columns</span><button class="col-panel-reset" id="col-reset-btn">Reset defaults</button></div>
    <div class="col-panel-list">
      ${COLUMNS.map(col => `<label class="col-panel-item"><input type="checkbox" data-col-key="${col.key}" ${isColVisible(col.key) ? 'checked' : ''}>${col.label}</label>`).join('')}
    </div>`;
  panel.querySelectorAll('input[data-col-key]').forEach(cb => {
    cb.addEventListener('change', e => { colVisibility[e.target.dataset.colKey] = e.target.checked; saveColVisibility(); renderTable(); });
  });
  document.getElementById('col-reset-btn').addEventListener('click', () => {
    COLUMNS.forEach(col => { colVisibility[col.key] = col.defaultOn; }); saveColVisibility(); renderColPanel(); renderTable();
  });
}

/* ============================================================
   Bulk select & actions
   ============================================================ */

function updateBulkToolbar() {
  const bar = document.getElementById('bulk-toolbar'), info = document.getElementById('bulk-count');
  if (!bar) return;
  const n = selectedIds.size;
  bar.style.display = n > 0 ? 'flex' : 'none';
  if (info) info.textContent = `${n} selected`;
}

function getDisplayFiltered() {
  const q = filterQuery.toLowerCase();
  let result = q ? cards.filter(c => c.name.toLowerCase().includes(q) || c.setName.toLowerCase().includes(q)) : [...cards];
  if (hideSold) result = result.filter(c => !c.sold);
  return result;
}

function toggleSelectAll(checked) {
  const f = getDisplayFiltered();
  if (checked) f.forEach(c => selectedIds.add(c.id)); else selectedIds.clear();
  renderTable();
}

function bulkMarkSold() {
  if (!selectedIds.size) return; pushUndo();
  for (const id of selectedIds) { const c = cards.find(x => x.id === id); if (c) { c.sold = true; touchUpdated(c); } }
  selectedIds.clear(); saveCardsToStorage(); renderTable(); setStatus('Selected cards marked as sold.', 'ok');
}

function bulkDelete() {
  if (!selectedIds.size) return;
  const n = selectedIds.size;
  if (!confirm(`Delete ${n} selected card${n !== 1 ? 's' : ''}?`)) return;
  pushUndo(); cards = cards.filter(c => !selectedIds.has(c.id));
  selectedIds.clear(); saveCardsToStorage(); renderTable(); setStatus(`Deleted ${n} card${n !== 1 ? 's' : ''}.`, 'ok');
}

/* ── #10: Bulk unmark sold ──────────────────────────────── */
function bulkUnmarkSold() {
  if (!selectedIds.size) return; pushUndo();
  for (const id of selectedIds) { const c = cards.find(x => x.id === id); if (c) { c.sold = false; c.soldPrice = ''; touchUpdated(c); } }
  selectedIds.clear(); saveCardsToStorage(); renderTable(); setStatus('Selected cards unmarked.', 'ok');
}

/* ── #10: Bulk set condition ────────────────────────────── */
function bulkSetCondition(cond) {
  if (!selectedIds.size || !CONDITIONS.includes(cond)) return; pushUndo();
  for (const id of selectedIds) { const c = cards.find(x => x.id === id); if (c) { c.condition = cond; touchUpdated(c); } }
  saveCardsToStorage(); renderTable(); setStatus(`Set condition to ${cond} for ${selectedIds.size} cards.`, 'ok');
  selectedIds.clear(); renderTable();
}

/* ── #10: Bulk refresh ──────────────────────────────────── */
async function bulkRefresh() {
  if (!selectedIds.size || refreshing) return;
  const eligible = cards.filter(c => selectedIds.has(c.id) && c.tcgplayerId);
  if (!eligible.length) { setStatus('No selected cards have API price data.', 'err'); return; }

  const uniqueIds = [...new Set(eligible.map(c => c.tcgplayerId))];
  const idToName  = {}; for (const c of eligible) { if (!idToName[c.tcgplayerId]) idToName[c.tcgplayerId] = c.name; }

  refreshing = true;
  const btn = document.getElementById('bulk-refresh-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⟳ …'; }
  setStatus(`Refreshing ${uniqueIds.length} price${uniqueIds.length !== 1 ? 's' : ''} for selected cards…`, '');

  pushUndo();
  let ok = 0, fail = 0;
  const priceMap = {}, updatedIds = [];

  for (const tcgId of uniqueIds) {
    try {
      const prices = await fetchCardPrices(tcgId, true);
      if (prices) { priceMap[tcgId] = prices; ok++; } else fail++;
    } catch { fail++; }
    await new Promise(r => setTimeout(r, 120));
  }

  for (const card of eligible) {
    const prices = priceMap[card.tcgplayerId]; if (!prices) continue;
    const p = prices[card.finish] || prices[Object.keys(prices)[0]] || {};
    if (p.market !== undefined && p.market !== card.marketNM) card.prevMarketNM = card.marketNM;
    if (p.market !== undefined) card.marketNM = p.market;
    if (p.low    !== undefined) card.priceLow = p.low;
    if (p.mid    !== undefined) card.priceMid = p.mid;
    card.lastRefreshed = Date.now(); touchUpdated(card); updatedIds.push(card.id);
  }

  saveCardsToStorage(); renderTable(updatedIds);
  setStatus(`Bulk refresh: ${ok} price${ok !== 1 ? 's' : ''} fetched → ${updatedIds.length} card${updatedIds.length !== 1 ? 's' : ''} updated` + (fail ? ` · ${fail} failed` : ''), fail && !ok ? 'err' : 'ok');
  if (btn) { btn.disabled = false; btn.textContent = '⟳ Refresh'; }
  refreshing = false; updateCacheStatus();
}

/* ============================================================
   Table rendering
   ============================================================ */

function renderTable(highlightIds = []) {
  const filtered   = getDisplayFiltered();
  const allVisible = filtered.length > 0 && filtered.every(c => selectedIds.has(c.id));

  // Header — #12: dateAdded + lastUpdated now use buildTh (sortable)
  const thead = document.querySelector('#card-table thead tr');
  let hh =
    buildFixedTh(`<input type="checkbox" id="check-all" ${allVisible && selectedIds.size > 0 ? 'checked' : ''}>`, '36px', STICKY_LEFT.checkbox, null, 'text-align:center;') +
    buildFixedTh('Image', '54px', STICKY_LEFT.image) +
    buildTh('Name', 'name', '200px', STICKY_LEFT.name);
  for (const col of COLUMNS) {
    if (!isColVisible(col.key)) continue;
    hh += col.sortable ? buildTh(col.label, col.key, col.width) : buildFixedTh(col.label, col.width);
  }
  hh += buildFixedTh('', '28px', null, STICKY_RIGHT.rowRefresh) +
        buildTh('Sold', 'sold', '52px', null, STICKY_RIGHT.sold) +
        buildFixedTh('', '68px', null, STICKY_RIGHT.actions);
  thead.innerHTML = hh;
  const checkAllEl = document.getElementById('check-all');
  if (checkAllEl) checkAllEl.addEventListener('change', e => toggleSelectAll(e.target.checked));

  const tbody = document.getElementById('card-body');
  tbody.innerHTML = '';

  for (const card of sortCards(filtered, sortKey, sortDir)) {
    const adj        = adjPrice(card);
    const delta      = calcPriceDelta(card);
    const cached     = readPriceCache(card.tcgplayerId);
    const isSelected = selectedIds.has(card.id);
    const highlighted = highlightIds.includes(card.id);
    const hasActual  = card.sold && parseFloat(card.soldPrice) > 0;
    const { profit, pct } = hasActual ? calcActualProfit(card) : calcProfit(card);
    const profitLabel = hasActual ? 'Actual' : 'Expected';

    let deltaBadge = '<span style="color:var(--text-tertiary)">—</span>';
    if (delta !== null) {
      const sign = delta >= 0 ? '▲' : '▼';
      deltaBadge = `<span class="${delta >= 0 ? 'delta-up' : 'delta-down'}">${sign} ${fmt(Math.abs(delta))}</span>`;
    }

    const tr = document.createElement('tr');
    tr.dataset.cardId = card.id;
    if (card.sold)    tr.classList.add('sold');
    if (isSelected)   tr.classList.add('row-selected');
    if (highlighted)  tr.style.background = 'rgba(60,180,80,0.10)';

    const imgContent = card.imageUrl
      ? `<img class="card-img" src="${escHtml(card.imageUrl)}" alt="${escHtml(card.name)}" data-action="open-popover" style="cursor:pointer" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="card-img-placeholder" style="display:none">No image</div>`
      : `<div class="card-img-placeholder" data-action="open-search">Click to search</div>`;

    const finishLabel = FINISH_LABELS[card.finish] || card.finish || '';
    const subtitle    = [finishLabel, card.setName].filter(Boolean).join(' · ');
    const cacheTitle  = cached ? `title="Cached ${fmtAge(Date.now() - cached.cachedAt)}"` : 'title="Not cached"';
    const tcgUrl      = buildTCGSearchUrl(card.name, card.setName, card.link);

    // #13: notes rendered as inline textarea (saves on blur via delegation)
    const notesHtml = `<textarea class="notes-inline" data-field="notes" rows="1" placeholder="Add notes…">${escHtml(card.notes || '')}</textarea>`;

    let rowHtml = `
      <td class="frozen-left" style="left:${STICKY_LEFT.checkbox};text-align:center;width:36px">
        <input type="checkbox" data-action="select-row" ${isSelected ? 'checked' : ''}>
      </td>
      <td class="frozen-left" style="left:${STICKY_LEFT.image};width:54px">${imgContent}</td>
      <td class="frozen-left name-cell" style="left:${STICKY_LEFT.name};width:200px;min-width:200px">
        <input type="text" value="${escHtml(card.name)}" placeholder="Card name" data-field="name">
        ${subtitle ? `<div class="name-subtitle">${escHtml(subtitle)}</div>` : ''}
        ${notesHtml}
        ${card.lastRefreshed ? `<div class="refresh-detail">Refreshed ${fmtTime(card.lastRefreshed)}</div>` : ''}
      </td>`;

    const cells = {
      condition:   `<td><select data-field="condition">${CONDITIONS.map(c => `<option value="${c}"${c === card.condition ? ' selected' : ''}>${c}</option>`).join('')}</select></td>`,
      buyCost:     `<td><input type="number" value="${card.buyCost}" placeholder="0.00" step="0.01" min="0" data-field="buyCost"></td>`,
      soldPrice:   `<td><input type="number" value="${card.soldPrice}" placeholder="—" step="0.01" min="0" data-field="soldPrice" title="Actual sale price"></td>`,
      marketNM:    `<td style="font-size:12px${highlighted ? ';color:var(--text-success)' : ''}" ${cacheTitle}>${fmt(card.marketNM)}${cached ? ' <span class="cache-dot">●</span>' : ''}</td>`,
      priceDelta:  `<td>${deltaBadge}</td>`,
      priceLow:    `<td style="font-size:12px;color:var(--text-secondary)">${fmt(card.priceLow)}</td>`,
      priceMid:    `<td style="font-size:12px;color:var(--text-secondary)">${fmt(card.priceMid)}</td>`,
      adjPrice:    `<td style="font-weight:500">${adj > 0 ? fmt(adj) : '<span style="color:var(--text-tertiary)">—</span>'}</td>`,
      profit:      `<td class="${profit === null ? '' : profit >= 0 ? 'profit-pos' : 'profit-neg'}">${fmt(profit)}<div style="font-size:9px;color:var(--text-tertiary);margin-top:1px">${profitLabel}</div></td>`,
      pct:         `<td class="${pct === null ? '' : pct >= 0 ? 'profit-pos' : 'profit-neg'}">${fmtPct(pct)}</td>`,
      link:        `<td>${tcgUrl ? `<a href="${escHtml(tcgUrl)}" target="_blank" rel="noopener" class="link-open">TCGPlayer ↗</a>` : '<span style="font-size:11px;color:var(--text-tertiary)">—</span>'}</td>`,
      dateAdded:   `<td class="date-cell">${escHtml(fmtDate(card.dateAdded))}</td>`,
      lastUpdated: `<td class="date-cell">${escHtml(fmtDate(card.lastUpdated))}</td>`,
    };
    for (const col of COLUMNS) { if (isColVisible(col.key)) rowHtml += cells[col.key]; }

    const hasApiId = !!card.tcgplayerId;
    rowHtml += `
      <td class="frozen-right" style="right:${STICKY_RIGHT.rowRefresh};width:28px;text-align:center">
        ${hasApiId ? `<button class="row-refresh-btn" data-action="row-refresh" title="Refresh price for this card">⟳</button>` : ''}
      </td>
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

  if (filtered.length === 0) {
    const emptyTr = document.createElement('tr');
    const span = 4 + COLUMNS.filter(c => isColVisible(c.key)).length + 2;
    emptyTr.innerHTML = `<td colspan="${span}" style="text-align:center;padding:2rem;color:var(--text-tertiary)">${filterQuery || hideSold ? 'No cards match the current filter.' : 'No cards yet — add one below.'}</td>`;
    tbody.appendChild(emptyTr);
  }

  updateSummary(); updateCacheStatus(); updateBulkToolbar(); renderColPanel();
  const hsEl = document.getElementById('hide-sold-cb');
  if (hsEl) hsEl.checked = hideSold;
}

/* ============================================================
   Event delegation
   ============================================================ */

function bindTableDelegation() {
  document.querySelector('#card-table thead').addEventListener('click', e => {
    const th = e.target.closest('[data-sort-key]'); if (th) setSort(th.dataset.sortKey);
  });

  const tbody = document.getElementById('card-body');
  const FULL_RERENDER_FIELDS = new Set(['condition', 'sold', 'buyCost', 'soldPrice', 'marketNM']);

  // #13: also handle textarea[data-field="notes"] on blur
  tbody.addEventListener('blur', e => {
    const input = e.target.closest('input[data-field], textarea[data-field]');
    if (!input || input.type === 'checkbox') return;
    const cardId = getRowCardId(input); if (cardId === null) return;
    const field = input.dataset.field, value = input.value;
    const card = cards.find(c => c.id === cardId);
    if (!card || card[field] === value) return;
    pushUndo(); card[field] = value; touchUpdated(card); saveCardsToStorage();
    if (FULL_RERENDER_FIELDS.has(field)) renderTable(); else updateSummary();
  }, true);

  tbody.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const input = e.target.closest('input[data-field]');
    if (!input || input.type === 'checkbox') return;
    input.blur();
  });

  tbody.addEventListener('change', e => {
    const sel = e.target.closest('select[data-field]');
    if (sel) { const id = getRowCardId(sel); if (id !== null) setField(id, sel.dataset.field, sel.value); return; }
    const cb = e.target.closest('input[type="checkbox"][data-field]');
    if (cb)  { const id = getRowCardId(cb);  if (id !== null) setField(id, cb.dataset.field, cb.checked); return; }
    const rowCb = e.target.closest('input[data-action="select-row"]');
    if (rowCb) {
      const id = getRowCardId(rowCb); if (id !== null) {
        if (rowCb.checked) selectedIds.add(id); else selectedIds.delete(id);
        updateBulkToolbar();
        const f = getDisplayFiltered();
        const allChk = document.getElementById('check-all');
        if (allChk) allChk.checked = f.length > 0 && f.every(c => selectedIds.has(c.id));
      }
    }
  });

  tbody.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]'); if (!btn) return;
    if (btn.dataset.action === 'delete')      { if (confirm('Delete this card?')) { const id = getRowCardId(btn); if (id !== null) deleteCard(id); } return; }
    if (btn.dataset.action === 'duplicate')   { const id = getRowCardId(btn); if (id !== null) duplicateCard(id);          return; }
    if (btn.dataset.action === 'open-search') { const id = getRowCardId(btn); openSearchModal(id ?? undefined);             return; }
    if (btn.dataset.action === 'open-popover'){ const id = getRowCardId(btn); if (id !== null) openPopover(id, btn);        return; }
    if (btn.dataset.action === 'row-refresh') { const id = getRowCardId(btn); if (id !== null) refreshSingleCard(id, btn);  return; }
  });
}

function getRowCardId(el) {
  const tr = el.closest('tr[data-card-id]');
  return tr ? Number(tr.dataset.cardId) : null;
}

/* ============================================================
   Field mutation helpers
   ============================================================ */

function setField(id, field, value) {
  const card = cards.find(c => c.id === id); if (!card) return;
  pushUndo(); card[field] = value; touchUpdated(card); saveCardsToStorage(); renderTable();
}

function deleteCard(id) {
  pushUndo(); cards = cards.filter(c => c.id !== id); saveCardsToStorage(); renderTable();
}

/**
 * FIX #15: destructure `id` out before spreading so makeCard receives
 * no id override and safely uses the next _nextId value.
 * Previously `id: undefined` in overrides → Number(undefined) → NaN.
 */
function duplicateCard(id) {
  const original = cards.find(c => c.id === id); if (!original) return;
  pushUndo();
  const { id: _discarded, ...rest } = original;    // FIX #15
  const dupe = makeCard({
    ...rest,
    sold:         false,
    soldPrice:    '',
    prevMarketNM: null,
    dateAdded:    new Date().toISOString(),
    lastUpdated:  new Date().toISOString(),
  });
  const idx = cards.findIndex(c => c.id === id);
  cards.splice(idx + 1, 0, dupe);
  saveCardsToStorage(); renderTable([dupe.id]);
}

/* ============================================================
   Per-row refresh
   ============================================================ */

async function refreshSingleCard(cardId, btnEl) {
  const card = cards.find(c => c.id === cardId); if (!card || !card.tcgplayerId) return;
  btnEl.disabled = true; btnEl.classList.add('spinning');
  try {
    const prices = await fetchCardPrices(card.tcgplayerId, true);
    if (prices) {
      const p = prices[card.finish] || prices[Object.keys(prices)[0]] || {};
      pushUndo();
      if (p.market !== undefined && p.market !== card.marketNM) card.prevMarketNM = card.marketNM;
      if (p.market !== undefined) card.marketNM = p.market;
      if (p.low    !== undefined) card.priceLow = p.low;
      if (p.mid    !== undefined) card.priceMid = p.mid;
      card.lastRefreshed = Date.now(); touchUpdated(card);
      const siblings = cards.filter(c => c.id !== card.id && c.tcgplayerId === card.tcgplayerId);
      for (const sib of siblings) {
        const sp = prices[sib.finish] || prices[Object.keys(prices)[0]] || {};
        if (sp.market !== undefined && sp.market !== sib.marketNM) sib.prevMarketNM = sib.marketNM;
        if (sp.market !== undefined) sib.marketNM = sp.market;
        if (sp.low    !== undefined) sib.priceLow = sp.low;
        if (sp.mid    !== undefined) sib.priceMid = sp.mid;
        sib.lastRefreshed = Date.now(); touchUpdated(sib);
      }
      saveCardsToStorage(); renderTable([card.id, ...siblings.map(s => s.id)]);
      setStatus(`Price updated for ${card.name}.`, 'ok');
    } else { setStatus(`No price data returned for ${card.name}.`, 'err'); }
  } catch (err) { setStatus(`Refresh failed: ${escHtml(err.message)}`, 'err'); }
}

/* ============================================================
   Quick-edit popover
   ============================================================ */

function openPopover(cardId, triggerEl) {
  const card = cards.find(c => c.id === cardId); if (!card) return;
  popoverCardId = cardId;
  const popEl = document.getElementById('card-popover'); if (!popEl) return;

  const finishLabel = FINISH_LABELS[card.finish] || card.finish || '';
  const subtitle    = [finishLabel, card.setName].filter(Boolean).join(' · ');
  const adj = adjPrice(card), { profit } = calcProfit(card);

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
      <div class="popover-field"><label class="popover-label">Condition</label>
        <select id="pop-condition">${CONDITIONS.map(c => `<option value="${c}"${c === card.condition ? ' selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="popover-field"><label class="popover-label">Finish</label>
        <select id="pop-finish">${Object.entries(FINISH_LABELS).map(([k,v]) => `<option value="${k}"${k === card.finish ? ' selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="popover-field"><label class="popover-label">Buy cost</label>
        <input type="number" id="pop-buyCost" value="${card.buyCost}" step="0.01" min="0" placeholder="0.00"></div>
      <div class="popover-field"><label class="popover-label">Market (NM)</label>
        <input type="number" id="pop-marketNM" value="${card.marketNM ?? ''}" step="0.01" min="0" placeholder="—"></div>
    </div>
    <div class="popover-field" style="margin-bottom:0.65rem">
      <label class="popover-label">Notes / memo</label>
      <textarea id="pop-notes" rows="2" placeholder="e.g. Bought at locals, PSA pending…">${escHtml(card.notes || '')}</textarea>
    </div>
    <div class="popover-stats">
      <div class="popover-stat"><div class="popover-stat-label">Adj. price</div><div class="popover-stat-val" id="pop-adj">${fmt(adj)}</div></div>
      <div class="popover-stat"><div class="popover-stat-label">Expected profit</div><div class="popover-stat-val ${profit === null ? '' : profit >= 0 ? 'pos' : 'neg'}" id="pop-profit">${fmt(profit)}</div></div>
    </div>
    <div class="popover-actions">
      <button class="btn btn-sm" id="pop-cancel-btn">Cancel</button>
      <button class="btn btn-sm btn-primary" id="pop-save-btn">Save changes</button>
    </div>`;

  const tableWrap = document.querySelector('.table-wrap');
  const tr = triggerEl.getBoundingClientRect(), wr = tableWrap.getBoundingClientRect();
  popEl.style.top  = (tr.bottom - wr.top + tableWrap.scrollTop + 4) + 'px';
  popEl.style.left = Math.max(4, Math.min(tr.left - wr.left - 4, wr.width - 360)) + 'px';
  popEl.style.display = 'block';
  document.getElementById('popover-backdrop').style.display = 'block';

  function refreshStats() {
    const mkt = parseFloat(document.getElementById('pop-marketNM').value) || 0;
    const buy = document.getElementById('pop-buyCost').value;
    const cond = document.getElementById('pop-condition').value;
    const MULT = { NM:1, LP:.85, MP:.7, HP:.5, DMG:.3 };
    const adjV = mkt * (MULT[cond] || 1);
    const buyNum = parseFloat(buy);
    const profV = (adjV && buy !== '' && !isNaN(buyNum)) ? adjV - buyNum : null;
    document.getElementById('pop-adj').textContent = fmt(adjV);
    const profEl = document.getElementById('pop-profit');
    profEl.textContent = fmt(profV); profEl.className = 'popover-stat-val ' + (profV === null ? '' : profV >= 0 ? 'pos' : 'neg');
  }
  ['pop-condition','pop-buyCost','pop-marketNM'].forEach(id => document.getElementById(id)?.addEventListener('input', refreshStats));
  document.getElementById('popover-close-btn').addEventListener('click', closePopover);
  document.getElementById('pop-cancel-btn').addEventListener('click', closePopover);
  document.getElementById('pop-save-btn').addEventListener('click', savePopover);
}

function closePopover() {
  document.getElementById('card-popover').style.display     = 'none';
  document.getElementById('popover-backdrop').style.display = 'none';
  popoverCardId = null;
}

function savePopover() {
  if (popoverCardId === null) return;
  const card = cards.find(c => c.id === popoverCardId); if (!card) { closePopover(); return; }
  pushUndo();
  card.condition = document.getElementById('pop-condition').value;
  card.finish    = document.getElementById('pop-finish').value;
  card.buyCost   = document.getElementById('pop-buyCost').value;
  const mktVal   = document.getElementById('pop-marketNM').value;
  card.marketNM  = mktVal !== '' ? parseFloat(mktVal) : null;
  card.notes     = document.getElementById('pop-notes').value;
  touchUpdated(card); saveCardsToStorage(); closePopover(); renderTable();
}

/* ============================================================
   Filter bar — debounced (#bonus)
   ============================================================ */

function onFilterInput(e) {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => { filterQuery = e.target.value; renderTable(); }, 150);
}
function clearFilter() { clearTimeout(filterTimer); filterQuery = ''; document.getElementById('filter-input').value = ''; renderTable(); }
function toggleHideSold(checked) { hideSold = checked; saveHideSold(); renderTable(); }

/* ============================================================
   Bulk refresh prices (global)
   ============================================================ */

async function refreshAllPrices() {
  if (refreshing) return;
  const skipSold = document.getElementById('skip-sold-cb')?.checked ?? true;
  const eligible = cards.filter(c => c.tcgplayerId && !(skipSold && c.sold));
  if (!eligible.length) { setStatus(skipSold ? 'No unsold cards with price data.' : 'No cards with price data.', 'err'); return; }

  const uniqueIds = [...new Set(eligible.map(c => c.tcgplayerId))];
  const idToName  = {}; for (const c of eligible) { if (!idToName[c.tcgplayerId]) idToName[c.tcgplayerId] = c.name; }
  const total     = uniqueIds.length;

  refreshing = true;
  const refreshBtn    = document.getElementById('refresh-btn');
  const progressWrap  = document.getElementById('refresh-progress-wrap');
  const progressBar   = document.getElementById('refresh-progress-bar');
  const progressLabel = document.getElementById('refresh-progress-label');
  const progressCount = document.getElementById('refresh-progress-count');
  refreshBtn.disabled = true; refreshBtn.innerHTML = '<span class="spin">&#8635;</span> Refreshing…';
  if (progressWrap)  progressWrap.style.display = 'block';
  if (progressBar)   progressBar.style.width    = '0%';
  if (progressCount) progressCount.textContent  = `0 / ${total}`;
  if (progressLabel) progressLabel.textContent  = 'Fetching prices…';
  setStatus('', '');

  pushUndo();
  let ok = 0, fail = 0; const priceMap = {}, updatedIds = [];

  for (let i = 0; i < uniqueIds.length; i++) {
    const tcgId = uniqueIds[i];
    const pct = Math.round((i / total) * 100);
    if (progressBar)   progressBar.style.width   = pct + '%';
    if (progressCount) progressCount.textContent = `${i + 1} / ${total}`;
    if (progressLabel) progressLabel.textContent = `Fetching: ${idToName[tcgId] || tcgId}`;
    try { const prices = await fetchCardPrices(tcgId, true); if (prices) { priceMap[tcgId] = prices; ok++; } else fail++; } catch { fail++; }
    await new Promise(r => setTimeout(r, 120));
  }
  if (progressBar)   progressBar.style.width   = '100%';
  if (progressCount) progressCount.textContent = `${total} / ${total}`;
  if (progressLabel) progressLabel.textContent = 'Done!';

  let profitDeltaSum = 0, hasDelta = false;
  for (const card of eligible) {
    const prices = priceMap[card.tcgplayerId]; if (!prices) continue;
    const p = prices[card.finish] || prices[Object.keys(prices)[0]] || {};
    const oldMarket = card.marketNM;
    if (p.market !== undefined && p.market !== card.marketNM) card.prevMarketNM = card.marketNM;
    if (p.market !== undefined) card.marketNM = p.market;
    if (p.low    !== undefined) card.priceLow = p.low;
    if (p.mid    !== undefined) card.priceMid = p.mid;
    card.lastRefreshed = Date.now(); touchUpdated(card); updatedIds.push(card.id);
    if (!card.sold && oldMarket !== null && card.marketNM !== null) {
      const mult = { NM:1, LP:.85, MP:.7, HP:.5, DMG:.3 }[card.condition] ?? 1;
      profitDeltaSum += (card.marketNM - oldMarket) * mult; hasDelta = true;
    }
  }
  lastRefreshProfitDelta = hasDelta ? profitDeltaSum : null;
  saveCardsToStorage(); renderTable(updatedIds);

  setTimeout(() => { if (progressWrap) progressWrap.style.display = 'none'; if (progressBar) progressBar.style.width = '0%'; if (progressLabel) progressLabel.textContent = 'Fetching prices…'; if (progressCount) progressCount.textContent = '0 / 0'; }, 800);

  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  setStatus(`Refreshed ${ok} unique price${ok !== 1 ? 's' : ''} → applied to ${updatedIds.length} card${updatedIds.length !== 1 ? 's' : ''}` + (fail ? ` · ${fail} failed` : '') + `  ·  ${time}`, fail && !ok ? 'err' : 'ok');
  refreshBtn.disabled = false;
  refreshBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8a7 7 0 1 0 1.4-4.2"/><polyline points="1,2 1,6 5,6"/></svg> Refresh prices`;
  refreshing = false; updateCacheStatus();
}

function setStatus(html, type = '') {
  const el = document.getElementById('refresh-status-bar');
  el.className = 'refresh-status ' + type; el.innerHTML = html;
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
  document.getElementById('qty-input').value               = '1';
  const cardAdded = document.getElementById('card-added');
  if (cardAdded) { cardAdded.textContent = ''; cardAdded.style.display = 'none'; }
  document.getElementById('search-modal').dataset.editId = editId ?? '';
  document.getElementById('search-modal').style.display  = 'flex';
  switchTab('name');
  setTimeout(() => document.getElementById('search-input').focus(), 80);
}

function closeSearchModal() { document.getElementById('search-modal').style.display = 'none'; selectedResult = null; }

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
  searchBtn.disabled = true; selectedResult = null; document.getElementById('add-selected-btn').disabled = true;
  try {
    const data = await searchCards(q, setQ, searchJapanese);
    if (!data.length) { area.innerHTML = `<div class="no-results">No cards found${searchJapanese ? ' — try the English name' : ''}. Try a different name${setQ ? ' or set' : ''}.</div>`; return; }
    renderSearchResults(data);
  } catch (err) { area.innerHTML = `<div class="no-results">Search failed: ${escHtml(err.message)}</div>`; }
  finally { searchBtn.disabled = false; }
}

function renderSearchResults(data) {
  const area = document.getElementById('search-results-area');
  area.innerHTML = ''; area.className = 'search-results';
  for (const card of data) {
    const prices = card.tcgplayer?.prices || {}, finishKeys = Object.keys(prices), defaultFin = finishKeys[0] || null;
    const div = document.createElement('div');
    div.className = 'result-card';
    div.dataset.cardId = card.id;
    div.dataset.selectedFinish = defaultFin || '';
    const pricePills = finishKeys.map(fk => { const p = prices[fk]; return `<span class="price-pill${fk === defaultFin ? ' selected-type' : ''}" data-finish="${fk}">${FINISH_LABELS[fk]||fk}: ${p.market ? '$'+Number(p.market).toFixed(2) : '—'}</span>`; }).join('');
    const finishBtns = finishKeys.length > 1 ? finishKeys.map(fk => `<button class="finish-btn${fk === defaultFin ? ' active' : ''}" data-finish="${fk}">${FINISH_LABELS[fk]||fk}</button>`).join('') : '';
    div.innerHTML = `
      <img class="result-img" src="${escHtml(card.images?.small||'')}" alt="${escHtml(card.name)}">
      <div class="result-info">
        <div class="result-name">${escHtml(card.name)}</div>
        <div class="result-set">${escHtml(card.set?.name||'')} · #${escHtml(card.number||'')}</div>
        <div class="result-prices">${pricePills||'<span style="font-size:11px;color:var(--text-tertiary)">No price data</span>'}</div>
        ${finishKeys.length===0 ? '<div style="font-size:10px;color:var(--text-tertiary);margin-top:4px">No price data yet — set may be too new</div>' : ''}
        ${finishBtns ? `<div class="finish-picker">${finishBtns}</div>` : ''}
        <button class="quick-add-btn" data-action="quick-add">Quick add</button>
      </div>`;
    div.dataset.cardJson = JSON.stringify({ id:card.id, name:card.name, imageUrl:card.images?.large||card.images?.small||'', setName:card.set?.name||'', tcgplayer:card.tcgplayer||null });
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
  const finish   = div.dataset.selectedFinish || Object.keys(card.tcgplayer?.prices||{})[0] || 'normal';
  const cardData = JSON.parse(div.dataset.cardJson);
  selectedResult = { cardId: card.id, cardData, finish, prices: card.tcgplayer?.prices || {} };
  document.getElementById('add-selected-btn').disabled = false;
}

async function doUrlLookup() {
  const url = document.getElementById('url-input').value.trim();
  const statusEl = document.getElementById('url-status'), lookupBtn = document.getElementById('url-lookup-btn');
  if (!url) return;
  statusEl.innerHTML = '<span style="color:var(--text-secondary)">Looking up card…</span>';
  lookupBtn.disabled = true; selectedResult = null; document.getElementById('add-selected-btn').disabled = true;
  try {
    const card = await fetchCardByUrl(url);
    if (!card) { statusEl.innerHTML = `<span style="color:var(--text-danger)">Could not find a matching card.</span>`; return; }
    renderSearchResults([card]); switchTab('name');
    const resultDiv = document.querySelector('.result-card'); if (resultDiv) selectResultCard(card, resultDiv);
    statusEl.innerHTML = '';
  } catch (err) { statusEl.innerHTML = `<span style="color:var(--text-danger)">Lookup failed: ${escHtml(err.message)}</span>`; }
  finally { lookupBtn.disabled = false; }
}

function resetSearchUI() {
  selectedResult = null;
  const keepResults = document.getElementById('keep-results-cb')?.checked ?? false;
  if (!keepResults) {
    const input = document.getElementById('search-input'); if (input) { input.value = ''; input.focus(); }
    const area = document.getElementById('search-results-area'); if (area) area.innerHTML = '';
  } else { document.getElementById('search-input')?.focus(); }
  const qtyEl = document.getElementById('qty-input'); if (qtyEl) qtyEl.value = '1';
  document.getElementById('add-selected-btn').disabled = true;
}

function showAddSuccess(name, setName, qty) {
  const el = document.getElementById('card-added'), btn = document.getElementById('add-selected-btn'); if (!el) return;
  el.textContent = `✓ ${qty > 1 ? `${qty}× ` : ''}${name}${setName ? ' from '+setName : ''} added!`;
  el.style.display = 'block'; btn.disabled = true;
  setTimeout(() => { el.style.display = 'none'; btn.disabled = false; }, 1500);
}

function addSelectedCard() {
  if (!selectedResult) return;
  const { cardData, finish, prices } = selectedResult;
  const p = prices[finish] || {};
  const editId = parseInt(document.getElementById('search-modal').dataset.editId, 10) || 0;
  const qty    = Math.max(1, Math.min(99, parseInt(document.getElementById('qty-input')?.value||'1', 10)||1));
  const entry  = { name:cardData.name, imageUrl:cardData.imageUrl, setName:cardData.setName, finish, marketNM:p.market??null, priceLow:p.low??null, priceMid:p.mid??null, link:'', condition:'NM', buyCost:'', soldPrice:'', notes:'', sold:false, tcgplayerId:cardData.id };
  pushUndo();
  if (editId) { const idx = cards.findIndex(c => c.id === editId); if (idx >= 0) { cards[idx] = { ...cards[idx], ...entry }; touchUpdated(cards[idx]); } }
  else { for (let i = 0; i < qty; i++) cards.push(makeCard({ ...entry })); }
  saveCardsToStorage(); renderTable(); showAddSuccess(cardData.name, cardData.setName, qty); resetSearchUI();
}

/* ============================================================
   CSV import / export (bonus: export filtered view)
   ============================================================ */

async function triggerImport() {
  if (window.showOpenFilePicker) {
    try {
      const [fh] = await window.showOpenFilePicker({ types:[{ description:'CSV files', accept:{ 'text/csv':['.csv'] } }], multiple:false });
      pendingCSVData = await (await fh.getFile()).text();
      document.getElementById('import-modal').style.display = 'flex'; return;
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
  pushUndo(); const rows = parseCSV(pendingCSVData);
  if (mode === 'replace') cards = [];
  for (const row of rows) cards.push(csvRowToCard(row));
  syncNextId(cards); saveCardsToStorage(); closeImportModal(); renderTable();
}

/** Export filtered view when filter/hide-sold is active, otherwise full list. */
async function handleExportCSV() {
  const filtered  = getDisplayFiltered();
  const isFiltered = filterQuery || hideSold;
  await downloadCSV(isFiltered && filtered.length !== cards.length ? filtered : cards);
}

function handleClearCache() {
  clearPriceCache(); updateCacheStatus();
  setStatus('Price cache cleared — next refresh will fetch from the API.', 'ok');
}

/* ============================================================
   How To modal
   ============================================================ */

function openHowTo()  { document.getElementById('howto-modal').style.display = 'flex'; }
function closeHowTo() { document.getElementById('howto-modal').style.display = 'none'; }

/* ============================================================
   initUI
   ============================================================ */

function initUI() {
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
  document.getElementById('hide-sold-cb').addEventListener('change', e => toggleHideSold(e.target.checked));

  document.addEventListener('click', e => { if (colPanelOpen && !e.target.closest('#col-panel') && !e.target.closest('#col-toggle-btn')) closeColPanel(); });

  document.getElementById('filter-input').addEventListener('input', onFilterInput);
  document.getElementById('filter-clear').addEventListener('click', clearFilter);

  // Bulk actions (#10)
  document.getElementById('bulk-mark-sold').addEventListener('click', bulkMarkSold);
  document.getElementById('bulk-unmark-sold').addEventListener('click', bulkUnmarkSold);
  document.getElementById('bulk-delete').addEventListener('click', bulkDelete);
  document.getElementById('bulk-refresh-btn').addEventListener('click', bulkRefresh);
  document.getElementById('bulk-condition-select').addEventListener('change', e => {
    if (e.target.value) { bulkSetCondition(e.target.value); e.target.value = ''; }
  });

  document.getElementById('close-import-btn').addEventListener('click', closeImportModal);
  document.getElementById('do-import-btn').addEventListener('click', () => doImport('add'));
  document.getElementById('replace-import-btn').addEventListener('click', () => doImport('replace'));

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

  document.getElementById('qty-dec').addEventListener('click', () => { const el = document.getElementById('qty-input'); el.value = Math.max(1, parseInt(el.value||'1',10)-1); });
  document.getElementById('qty-inc').addEventListener('click', () => { const el = document.getElementById('qty-input'); el.value = Math.min(99, parseInt(el.value||'1',10)+1); });

  document.getElementById('popover-backdrop').addEventListener('click', closePopover);
  document.getElementById('file-input').addEventListener('change', handleFileImport);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeSearchModal(); closeImportModal(); closeColPanel(); closePopover(); closeHowTo(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); }
  });

  bindTableDelegation();
  updateUndoButton();
}

renderTable();
initUI();
