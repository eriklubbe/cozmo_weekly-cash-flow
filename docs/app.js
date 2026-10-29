'use strict';

/* ════════════════════════════════════════════════════════════
   Weekly cash flow forecast — all state lives in localStorage.
   Dates are ISO strings (YYYY-MM-DD) handled in UTC.
   ════════════════════════════════════════════════════════════ */

// Company settings from config.js; the fallbacks keep the app working without it.
const CFG = { company: 'Cash flow', wordmark: 'Cash flow', logo: '', badge: '', repo: '', storageKey: 'cashflow',
  creditFacility: 'Credit facility', bank: 'Bank', ...(window.APP_CONFIG || {}) };
const STORE_KEY = `${CFG.storageKey}-v1`;
const TAB_KEY = `${CFG.storageKey}-tab`;
const DAY = 86400000;

// ── Date helpers ────────────────────────────────────────────
const toISO = d => d.toISOString().slice(0, 10);
const fromISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const todayISO = () => { const n = new Date(); return toISO(new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()))); };
const addDays = (iso, n) => toISO(new Date(fromISO(iso).getTime() + n * DAY));
const weekday = iso => (fromISO(iso).getUTCDay() + 6) % 7; // Monday = 0
const mondayOf = iso => addDays(iso, -weekday(iso));
const daysBetween = (a, b) => Math.round((fromISO(b) - fromISO(a)) / DAY);
const daysInMonth = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const fmtDate = iso => { if (!iso) return '—'; const d = fromISO(iso); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
const fmtDateY = iso => { if (!iso) return '—'; const d = fromISO(iso); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const ordinal = n => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');

// ── Formatting ──────────────────────────────────────────────
let fmt0, fmt2;
function setCurrency(c) {
  fmt0 = new Intl.NumberFormat('en-GB', { style: 'currency', currency: c, maximumFractionDigits: 0, minimumFractionDigits: 0 });
  fmt2 = new Intl.NumberFormat('en-GB', { style: 'currency', currency: c });
}
const money = (v, dp) => { const f = dp ? fmt2 : fmt0; if (Math.abs(v) < (dp ? 0.005 : 0.5)) v = 0; return v < 0 ? `(${f.format(-v)})` : f.format(v); };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const round2 = n => Math.round(n * 100) / 100;

// ── State ───────────────────────────────────────────────────
function defaultState() {
  return {
    settings: { openingBalance: 0, balanceDate: todayISO(), startDate: mondayOf(todayISO()), weeks: 13, currency: 'GBP', minAmount: 0 },
    items: [],           // invoices and bills: {id,type:'in'|'out',contact,invoiceNumber,amount,dueDate,expectedDate?,excluded?,source:'xero'|'manual'}
    recurring: [],       // {id,name,direction,amount,frequency,dayOfMonth,dayOfWeek,startDate,endDate,category,active}
    recurOverrides: {},  // "recurringId|originalDate" -> {date?, skip?}
    forecasts: [],       // estimates typed into the 13 week view, one amount per week: {id,name,type,weeks:{mondayISO: amount}}
    rules: [],           // payment timing per contact: {id,type,contact,months,days}
    suppliers: [],       // bank details: {id,name,accountName?,accountType,sortCode,accountNo,addedAt,changedAt?}
    lastImport: {},      // {in: iso, out: iso}
  };
}

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s) return normalise(s);
  } catch (e) { /* fall through */ }
  return defaultState();
}
function normalise(s) {
  const d = defaultState();
  return { ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) } };
}

let state = load();
const undoStack = [];

/** Cache in this browser, and queue a commit when the shared file is connected. */
function save(change) {
  try { if (!teamCfg) localStorage.setItem(STORE_KEY, JSON.stringify(state)); } // no copy left behind on computers signed in by password
  catch (e) { if (sync.mode === 'local') toast('Could not save in this browser — download a backup.'); }
  if (change !== undefined) scheduleSave(change);
}

/** Apply a change with undo support. */
function mutate(fn, message) {
  if (isReadOnly()) { toast(readOnlyReason()); return; }
  const snapshot = JSON.stringify(state);
  fn();
  undoStack.push(snapshot);
  if (undoStack.length > 50) undoStack.shift();
  save(message || 'Update');
  render();
  if (message) toast(message, true);
}
function undo() {
  if (isReadOnly()) { toast(readOnlyReason()); return; }
  const prev = undoStack.pop();
  if (!prev) return;
  state = normalise(JSON.parse(prev));
  setCurrency(state.settings.currency);
  save('Undo');
  render();
  toast('Undone');
}

// ── Toast ───────────────────────────────────────────────────
let toastTimer;
function toast(msg, withUndo) {
  const el = document.getElementById('toast');
  el.innerHTML = `<span>${esc(msg)}</span>` + (withUndo ? '<button class="link" data-act="undo">Undo</button>' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

// ════════════════════════════════════════════════════════════
//  Forecast engine
// ════════════════════════════════════════════════════════════

function getWeeks() {
  const s = state.settings;
  const start = mondayOf(s.startDate || todayISO());
  const n = Math.max(1, Math.min(52, Number(s.weeks) || 13));
  return Array.from({ length: n }, (_, i) => { const a = addDays(start, i * 7); return { i, start: a, end: addDays(a, 6) }; });
}

/** Dates on which a recurring payment falls between from and to (inclusive). */
function occurrences(r, from, to) {
  const out = [];
  const start = r.startDate || from;
  const end = r.endDate && r.endDate < to ? r.endDate : to;
  if (r.frequency === 'weekly' || r.frequency === 'fortnightly') {
    const step = r.frequency === 'weekly' ? 7 : 14;
    let d = addDays(start, ((Number(r.dayOfWeek) || 0) - weekday(start) + 7) % 7);
    while (d <= end) { if (d >= from) out.push(d); d = addDays(d, step); }
  } else {
    const stepM = { monthly: 1, quarterly: 3, annually: 12 }[r.frequency] || 1;
    const s = fromISO(start);
    let y = s.getUTCFullYear(), m = s.getUTCMonth();
    const dom = Math.max(1, Math.min(31, Number(r.dayOfMonth) || 1));
    const on = () => toISO(new Date(Date.UTC(y, m, Math.min(dom, daysInMonth(y, m)))));
    // The cycle anchors on the first payment day on or after the start date.
    if (on() < start) { m += 1; if (m > 11) { m = 0; y++; } }
    for (let d = on(); d <= end; d = on()) {
      if (d >= from) out.push(d);
      m += stepM; while (m > 11) { m -= 12; y++; }
    }
  }
  return out;
}

function freqLabel(r) {
  const dom = Number(r.dayOfMonth) >= 31 ? 'last day' : ordinal(Number(r.dayOfMonth));
  switch (r.frequency) {
    case 'weekly': return `Weekly on ${DOW[Number(r.dayOfWeek) || 0]}`;
    case 'fortnightly': return `Fortnightly on ${DOW[Number(r.dayOfWeek) || 0]}`;
    case 'quarterly': return `Quarterly on the ${dom}`;
    case 'annually': return `Annually on the ${dom}`;
    default: return `Monthly on the ${dom}`;
  }
}

// ── Payment timing rules ────────────────────────────────────
/** Add whole months (day clamped to the month's length), then days. */
function shiftDate(iso, months, days) {
  const d = fromISO(iso);
  const m = d.getUTCMonth() + (Number(months) || 0);
  const y = d.getUTCFullYear() + Math.floor(m / 12), m0 = ((m % 12) + 12) % 12;
  return addDays(toISO(new Date(Date.UTC(y, m0, Math.min(d.getUTCDate(), daysInMonth(y, m0))))), Number(days) || 0);
}
const ruleFor = it => (state.rules || []).find(r => r.type === it.type && r.contact.trim().toLowerCase() === (it.contact || '').trim().toLowerCase());
function ruleLabel(r) {
  const part = (n, unit) => (n ? `${n > 0 ? '+' : '−'}${Math.abs(n)} ${unit}${Math.abs(n) === 1 ? '' : 's'}` : '');
  return [part(Number(r.months), 'month'), part(Number(r.days), 'day')].filter(Boolean).join(' ') || 'no shift';
}
/** When an invoice is expected before anyone moves it: its due date, shifted by any rule for the contact. */
function plannedDate(it) {
  const r = it.dueDate && ruleFor(it);
  return r ? shiftDate(it.dueDate, r.months, r.days) : it.dueDate;
}

/** Imported invoices and bills smaller than the minimum (either sign) are left out of the forecast. */
const belowMinimum = it => it.source === 'xero' && Math.abs(Number(it.amount) || 0) < (Number(state.settings.minAmount) || 0); // only imported ones

/** Every cash movement in (or moved into) the forecast window, tagged with its week. */
function buildEvents(weeks) {
  const start = weeks[0].start, end = weeks[weeks.length - 1].end;
  const ev = [];
  for (const it of state.items) {
    if (it.excluded || it.financed || belowMinimum(it)) continue; // financed = paid with the credit facility
    const planned = plannedDate(it);
    const rule = ruleFor(it);
    ev.push({
      key: 'i:' + it.id, kind: 'item', id: it.id, type: it.type,
      row: it.contact || '(no contact)', ref: it.invoiceNumber || '—',
      recurring: !!it.directDebit, dd: !!it.directDebit, // scheduled collections sit with the recurring payments
      amount: Number(it.amount) || 0, date: it.expectedDate || planned || start, origDate: planned, dueDate: it.dueDate,
      rule: rule ? ruleLabel(rule) : '', moved: !!it.expectedDate && it.expectedDate !== planned, source: it.source,
      parked: !!it.parked, // put back to overdue from This week: not being paid yet
    });
  }
  for (const r of state.recurring) {
    if (r.active === false) continue;
    for (const d of occurrences(r, start, end)) {
      const k = r.id + '|' + d;
      const ov = state.recurOverrides[k] || {};
      if (ov.skip) continue;
      ev.push({
        key: 'r:' + k, kind: 'recur', rid: r.id, okey: k, type: r.direction || 'out',
        row: r.name, recurring: true, dd: !!r.directDebit, ref: freqLabel(r),
        amount: ov.amount != null ? Number(ov.amount) : Number(r.amount) || 0, edited: ov.amount != null,
        date: ov.date || d, origDate: d, moved: !!ov.date && ov.date !== d,
      });
    }
  }
  for (const f of state.forecasts || []) {
    for (const [ws, amt] of Object.entries(f.weeks || {})) {
      const v = Number(amt) || 0;
      if (!v || ws < start) continue; // weeks already gone; ones after the window land in Later
      ev.push({
        key: 'f:' + f.id + '|' + ws, kind: 'forecast', fid: f.id, type: f.type || 'in',
        row: f.name, forecast: true, ref: 'Forecast', amount: v, date: ws, origDate: ws,
      });
    }
  }
  // Overdue = due before the weekend ahead of week 1; that weekend's items count in week 1.
  const cutoff = overdueCutoff(weeks);
  for (const e of ev) {
    const off = daysBetween(start, e.date);
    e.overdue = e.date < cutoff || !!e.parked;
    e.week = e.overdue ? weeks.length + 1 : off < 0 ? 0 : Math.min(Math.floor(off / 7), weeks.length);
  }
  return ev;
}

/** Column indexes per row: 0..n-1 = weeks, n = Later, n+1 = Overdue (not counted in cash). */
const overdueCutoff = weeks => addDays(weeks[0].start, -2); // the Saturday before week 1

const rowKey = e => `${e.type}|${e.forecast ? 'f' : e.recurring ? 'r' : 'c'}|${e.row}`;

function buildForecast() {
  const weeks = getWeeks();
  const n = weeks.length;
  const events = buildEvents(weeks);
  const rows = new Map();
  const newRow = (rk, e) => ({ key: rk, type: e.type, name: e.row, recurring: !!e.recurring, dd: !!e.dd, forecast: !!e.forecast, fid: e.fid,
    cells: Array.from({ length: n + 2 }, () => []), total: 0 });
  for (const f of state.forecasts || []) { // forecast lines show even with no amounts yet, so there is somewhere to type
    const e = { type: f.type || 'in', row: f.name, forecast: true, fid: f.id };
    rows.set(rowKey(e), newRow(rowKey(e), e));
  }
  for (const e of events) {
    const rk = rowKey(e);
    let r = rows.get(rk);
    if (!r) { r = newRow(rk, e); rows.set(rk, r); }
    r.cells[e.week].push(e);
    if (e.week < n) r.total += e.amount;
  }
  const cin = Array(n + 2).fill(0), cout = Array(n + 2).fill(0);
  for (const e of events) (e.type === 'in' ? cin : cout)[e.week] += e.amount;
  const open = [], close = [];
  let bal = Number(state.settings.openingBalance) || 0;
  for (let i = 0; i < n; i++) { open[i] = bal; bal += cin[i] - cout[i]; close[i] = bal; }
  return { weeks, n, od: n + 1, cutoff: overdueCutoff(weeks), events, rows, cin, cout, open, close };
}

// ════════════════════════════════════════════════════════════
//  Overview tab
// ════════════════════════════════════════════════════════════

let F = null;                 // current forecast
const eventIndex = new Map(); // key -> event
let popoverAt = null;         // {rk, w}

function cellSum(evs) { return evs.reduce((a, e) => a + e.amount, 0); }

function refreshForecast() {
  F = buildForecast();
  eventIndex.clear();
  for (const e of F.events) eventIndex.set(e.key, e);
}

function renderOverview() {
  refreshForecast();
  const { weeks, n, od, cutoff, rows, cin, cout, open, close } = F;

  const s = state.settings;
  document.getElementById('ov-sub').innerHTML =
    `${weeks.length} weeks from ${fmtDateY(weeks[0].start)} · opening cash ${money(Number(s.openingBalance) || 0)} as at ${fmtDateY(s.balanceDate)}` +
    (() => { const small = state.items.filter(i => !i.excluded && belowMinimum(i)).length; return small ? ` · ${small} item${small === 1 ? '' : 's'} under ${money(Number(s.minAmount))} ignored` : ''; })() +
    `<span class="legend small"><span><i style="background:var(--honey-deep)"></i>moved or amount changed</span></span>`;

  const empty = rows.size === 0;
  document.getElementById('ov-empty').hidden = !empty;
  document.querySelector('.grid-wrap').hidden = empty;
  document.getElementById('btn-undo').disabled = undoStack.length === 0;

  // KPIs
  const totIn = cin.slice(0, n).reduce((a, b) => a + b, 0);
  const totOut = cout.slice(0, n).reduce((a, b) => a + b, 0);
  let lowI = 0; close.forEach((v, i) => { if (v < close[lowI]) lowI = i; });

  document.getElementById('kpis').innerHTML = [
    kpi('Opening cash', money(open[0]), `Week of ${fmtDate(weeks[0].start)}`, true),
    overdueKpi(`Cash in · ${n} wks`, totIn, cin[od], 'Receivables + recurring'),
    overdueKpi(`Cash out · ${n} wks`, totOut, cout[od], 'Bills + recurring'),
    kpi('Lowest closing cash', `<span class="${close[lowI] < 0 ? 'neg' : ''}">${money(close[lowI])}</span>`, `Week ${lowI + 1} · ${fmtDate(weeks[lowI].start)}`),
    kpi(`Closing cash · wk ${n}`, `<span class="${close[n - 1] < 0 ? 'neg' : ''}">${money(close[n - 1])}</span>`, `Net ${money(totIn - totOut)}`),
  ].join('');

  renderClosingChart();

  // Table
  const negCls = v => (v < 0 ? ' neg' : '');
  let h = '<thead><tr><th class="rowhead">Week commencing</th>' +
    `<th class="num od" data-week="${od}" title="Due before ${fmtDateY(cutoff)}. Not counted in the cash balances — drag items into the week you expect them.">Overdue<small>before ${fmtDate(cutoff)}</small></th>`;
  weeks.forEach(w => { h += `<th class="num" data-week="${w.i}">Wk ${w.i + 1}<small>${fmtDate(w.start)}</small></th>`; });
  h += `<th class="num later" title="Due after the forecast window">Later<small>after ${fmtDate(weeks[n - 1].end)}</small></th><th class="num total">Total<small>${n} weeks</small></th></tr></thead>`;

  // Cash in / Cash out amounts open the biggest contributors behind them.
  const sumAttr = (cls, col, v) => (cls === 'in' || cls === 'out') && v ? ` sum" data-sum="${cls}" data-col="${col}" title="Click for the top 10` : '';
  const sumRow = (label, arr, cls, fmtCls, totalVal, odVal) =>
    `<tr class="${cls}"><td class="rowhead">${label}</td>` +
    `<td class="num od${odVal ? fmtCls(odVal) : ''}${sumAttr(cls, od, odVal)}">${odVal ? money(odVal) : ''}</td>` +
    arr.map((v, i) => cls === 'open' && i === 0 ? openingCell(v) : `<td class="num${fmtCls(v)}${sumAttr(cls, i, v)}">${money(v)}</td>`).join('') +
    `<td class="num later"></td><td class="num total${totalVal == null ? '' : fmtCls(totalVal)}${sumAttr(cls, 'total', totalVal)}">${totalVal == null ? '' : money(totalVal)}</td></tr>`;

  const net = weeks.map((_, i) => cin[i] - cout[i]);
  h += '<tbody class="summary">';
  h += sumRow('Cash at start of week', open, 'open', negCls, null);
  h += sumRow('Cash in', cin.slice(0, n), 'in', () => ' pos-in', totIn, cin[od]);
  h += sumRow('Cash out', cout.slice(0, n).map(v => -v), 'out', v => (v ? ' neg' : ''), -totOut, -cout[od]);
  h += sumRow('Net in / (out)', net, 'net', negCls, totIn - totOut);
  h += sumRow('Cash at end of week', close, 'close', negCls, null);
  h += '</tbody>';

  const span = n + 4;
  const byTotal = (a, b) => b.total - a.total || a.name.localeCompare(b.name);
  const list = [...rows.values()];
  const section = (title) => `<tr class="section"><td class="rowhead">${title}</td><td colspan="${span - 1}"></td></tr>`;
  const sub = (title) => `<tr class="subsection"><td class="rowhead">${title}</td><td colspan="${span - 1}"></td></tr>`;
  const forecastRowHtml = r => {
    const f = state.forecasts.find(x => x.id === r.fid) || { weeks: {} };
    let t = `<tr data-row="${esc(r.key)}" class="forecast"><td class="rowhead" title="${esc(r.name)} — type the amount expected each week">${esc(r.name)}${isReadOnly() ? '' : `<button class="link danger del-forecast" type="button" data-fid="${esc(r.fid)}" title="Remove this line and its amounts">×</button>`}</td><td class="num od"></td>`;
    weeks.forEach(w => {
      const v = Number(f.weeks[w.start]) || 0;
      t += `<td class="num est" data-week="${w.i}"><input class="est" type="text" inputmode="decimal" autocomplete="off" size="8" data-fid="${esc(r.fid)}" data-ws="${w.start}"` +
        ` value="${v ? esc(money(v)) : ''}" placeholder="–" title="${esc(r.name)}, week of ${fmtDate(w.start)} — type the amount expected" ${isReadOnly() ? 'disabled' : ''}></td>`;
    });
    const later = cellSum(r.cells[n]), sign = r.type === 'out' ? -1 : 1;
    t += `<td class="num later"${later ? ` title="${r.cells[n].map(e => `${fmtDate(e.date)}: ${money(e.amount)}`).join(', ')} — lengthen the forecast on Data & import to edit these"` : ''}>${later ? money(sign * later) : ''}</td>` +
      `<td class="num total">${money(sign * r.total)}</td></tr>`;
    return t;
  };
  const rowHtml = r => {
    if (r.forecast) return forecastRowHtml(r);
    const rule = !r.recurring && ruleFor({ type: r.type, contact: r.name });
    let t = `<tr data-row="${esc(r.key)}"><td class="rowhead" title="${esc(r.name)}${rule ? ` — due dates shifted ${ruleLabel(rule)}` : ''}">${esc(r.name)}${r.recurring ? `<span class="tag">${r.dd ? 'direct debit' : 'recurring'}</span>` : ''}${rule ? `<span class="tag">${ruleLabel(rule)}</span>` : ''}</td>`;
    [od, ...r.cells.keys()].slice(0, n + 2).forEach(i => {
      const evs = r.cells[i];
      const later = i === n ? ' later' : i === od ? ' od' : '';
      if (!evs.length) { t += `<td class="cell num${later}" data-week="${i}"></td>`; return; }
      const marks = evs.some(e => e.moved || e.edited) ? '<span class="mark moved"></span>' : '';
      const sign = r.type === 'out' ? -1 : 1;
      t += `<td class="cell has num${later}" data-week="${i}" ${!isReadOnly() ? 'draggable="true"' : ''} title="${evs.length} item${evs.length > 1 ? 's' : ''} — click for detail">${marks}${money(sign * cellSum(evs))}</td>`;
    });
    t += `<td class="num total">${money((r.type === 'out' ? -1 : 1) * r.total)}</td></tr>`;
    return t;
  };
  const subtotal = (label, arr, total, sign) =>
    `<tr class="subtotal"><td class="rowhead">${label}</td><td class="num od">${arr[od] ? money(sign * arr[od]) : ''}</td>` + arr.slice(0, n).map(v => `<td class="num">${money(sign * v)}</td>`).join('') +
    `<td class="num later">${money(sign * arr[n])}</td><td class="num total">${money(sign * total)}</td></tr>`;

  const insF = list.filter(r => r.type === 'in' && r.forecast).sort((a, b) => a.name.localeCompare(b.name));
  const ins = list.filter(r => r.type === 'in' && !r.recurring && !r.forecast).sort(byTotal);
  const insR = list.filter(r => r.type === 'in' && r.recurring).sort(byTotal);
  const outsF = list.filter(r => r.type === 'out' && r.forecast).sort((a, b) => a.name.localeCompare(b.name));
  const outs = list.filter(r => r.type === 'out' && !r.recurring && !r.forecast).sort(byTotal);
  const outsR = list.filter(r => r.type === 'out' && r.recurring).sort(byTotal);

  h += '<tbody>';
  h += section('Cash in');
  // Forecast lines: typed per week; the last row adds a new line.
  const addLine = type => isReadOnly() ? '' : `<tr class="forecast add"><td class="rowhead"><input class="add-forecast" data-type="${type}" type="text" autocomplete="off"` +
    ` placeholder="+ Add a line" title="Type a name and press Enter — e.g. ${type === 'in' ? 'Shopify' : 'Meta ads'}"></td><td colspan="${span - 1}"></td></tr>`;
  h += sub('Sales forecast') + insF.map(rowHtml).join('') + addLine('in');
  if (ins.length) { if (insR.length || insF.length) h += sub('Customers'); h += ins.map(rowHtml).join(''); }
  if (insR.length) { h += sub('Recurring receipts'); h += insR.map(rowHtml).join(''); }
  if (!ins.length && !insR.length && !insF.length) h += `<tr><td class="rowhead muted">No receivables</td><td colspan="${span - 1}"></td></tr>`;
  h += subtotal('Total cash in', cin, totIn, 1);
  h += section('Cash out');
  h += sub('Planned payments') + outsF.map(rowHtml).join('') + addLine('out');
  if (outs.length) { h += sub('Suppliers & bills'); h += outs.map(rowHtml).join(''); }
  if (outsR.length) { h += sub('Recurring payments & direct debits'); h += outsR.map(rowHtml).join(''); }
  if (!outs.length && !outsR.length && !outsF.length) h += `<tr><td class="rowhead muted">No payables</td><td colspan="${span - 1}"></td></tr>`;
  h += subtotal('Total cash out', cout, totOut, -1);
  h += '</tbody>';

  document.getElementById('grid').innerHTML = h;

  // Keep an open drill-down in sync after a change.
  if (popoverAt && popoverAt.sum) openTopPopover(popoverAt.sum, popoverAt.w);
  else if (popoverAt) {
    const r = rows.get(popoverAt.rk);
    if (r && r.cells[popoverAt.w] && r.cells[popoverAt.w].length) openPopover(popoverAt.rk, popoverAt.w);
    else closePopover();
  }
}

// ── Cash at end of week chart ───────────────────────────────
const moneyShort = v => { const a = Math.abs(v), s = a >= 1e6 ? `${+(a / 1e6).toFixed(1)}m` : a >= 1e3 ? `${Math.round(a / 1e3)}k` : String(Math.round(a)); return `${v < 0 ? '−' : ''}${fmt0.format(0).replace(/[\d.,\s]/g, '')}${s}`; };

/** Round axis steps covering lo..hi. */
function niceTicks(lo, hi, count) {
  const raw = (hi - lo || Math.abs(hi) || 1) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const t = [];
  for (let v = Math.floor(lo / step) * step; v < hi + step * 0.999; v += step) t.push(Math.round(v * 100) / 100);
  return t;
}

let chartWidth = 0;
function renderClosingChart() {
  const card = document.getElementById('ov-chart-card');
  card.hidden = F.rows.size === 0;
  if (card.hidden) return;
  const box = document.getElementById('ov-chart');
  chartWidth = box.clientWidth || chartWidth || 900;
  const { weeks, n, close } = F;
  let lowI = 0; close.forEach((v, i) => { if (v < close[lowI]) lowI = i; });
  document.getElementById('ov-chart-sub').textContent =
    `Lowest ${money(close[lowI])} in week ${lowI + 1}${close[lowI] < 0 ? ' — overdrawn' : ''} · hover a week for detail`;
  box.innerHTML = closingChartSVG(chartWidth) + '<div class="chart-tip" hidden></div>';
}

function closingChartSVG(width) {
  const { weeks, n, close } = F;
  const W = Math.max(320, Math.round(width)), narrow = W < 640;
  const H = narrow ? 200 : 230, pad = { top: 26, right: 18, bottom: 38, left: 58 };
  const ticks = niceTicks(Math.min(0, ...close), Math.max(0, ...close), narrow ? 3 : 4);
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const pw = W - pad.left - pad.right, ph = H - pad.top - pad.bottom;
  const x = i => pad.left + (n > 1 ? (i * pw) / (n - 1) : pw / 2);
  const y = v => pad.top + ((hi - v) / (hi - lo || 1)) * ph;
  let lowI = 0; close.forEach((v, i) => { if (v < close[lowI]) lowI = i; });

  let svg = `<svg viewBox="0 0 ${W} ${H}" class="linechart" role="img" aria-label="Cash at end of week: ${close.map((v, i) => `week ${i + 1} ${money(v)}`).join(', ')}">`;
  for (const t of ticks) {
    svg += `<line class="${t === 0 ? 'zero' : 'gridline'}" x1="${pad.left}" x2="${W - pad.right}" y1="${y(t)}" y2="${y(t)}"/>` +
      `<text class="ytick" x="${pad.left - 8}" y="${y(t) + 4}">${moneyShort(t)}</text>`;
  }
  const every = Math.ceil(n / Math.max(2, Math.floor(pw / 64)));
  weeks.forEach((w, i) => {
    if (i % every && i !== n - 1) return;
    svg += `<text class="xtick" x="${x(i)}" y="${H - pad.bottom + 18}">Wk ${i + 1}</text>` +
      (narrow ? '' : `<text class="xtick sub" x="${x(i)}" y="${H - pad.bottom + 32}">${fmtDate(w.start)}</text>`);
  });
  if (lo < 0) svg += `<rect class="below" x="${pad.left}" y="${y(0)}" width="${pw}" height="${y(lo) - y(0)}"/>`;
  svg += `<line class="xh" x1="0" x2="0" y1="${pad.top}" y2="${H - pad.bottom}" visibility="hidden"/>`;
  svg += `<path class="line" d="${close.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')}"/>`;
  close.forEach((v, i) => { svg += `<circle class="dot${v < 0 ? ' neg' : ''}" data-i="${i}" cx="${x(i)}" cy="${y(v)}" r="4"/>`; });
  // Direct labels: the low point and the last week only.
  const label = (i, cls) => `<text class="vlabel${close[i] < 0 ? ' neg' : ''} ${cls}" x="${x(i)}" y="${y(close[i]) - 10}">${money(close[i])}</text>`;
  svg += label(lowI, 'low') + (lowI !== n - 1 ? label(n - 1, 'end') : '');
  // Hover / focus targets: one column per week, wider than the dot.
  const slot = n > 1 ? pw / (n - 1) : pw;
  weeks.forEach((w, i) => {
    svg += `<rect class="hit" data-i="${i}" tabindex="0" x="${x(i) - slot / 2}" y="${pad.top - 16}" width="${slot}" height="${ph + 16}"><title>Week ${i + 1}: ${money(close[i])}</title></rect>`;
  });
  return svg + '</svg>';
}

function showChartTip(i) {
  const box = document.getElementById('ov-chart');
  const svg = box.querySelector('svg'), tip = box.querySelector('.chart-tip');
  if (!svg || !tip) return;
  const dot = svg.querySelector(`circle.dot[data-i="${i}"]`), xh = svg.querySelector('.xh');
  svg.querySelectorAll('circle.dot.on').forEach(d => d.classList.remove('on'));
  if (i == null || !dot) { tip.hidden = true; xh.setAttribute('visibility', 'hidden'); return; }
  dot.classList.add('on');
  xh.setAttribute('x1', dot.getAttribute('cx')); xh.setAttribute('x2', dot.getAttribute('cx'));
  xh.setAttribute('visibility', 'visible');
  const w = F.weeks[i], v = F.close[i];
  tip.innerHTML = `<div class="t">Week ${i + 1} · w/c ${fmtDate(w.start)}</div>` +
    `<div class="v${v < 0 ? ' neg' : ''}">${money(v)}</div>` +
    `<div class="r"><span>Start</span><span>${money(F.open[i])}</span></div>` +
    `<div class="r"><span>Cash in</span><span class="pos-in">${money(F.cin[i])}</span></div>` +
    `<div class="r"><span>Cash out</span><span class="neg">${money(-F.cout[i])}</span></div>`;
  tip.hidden = false;
  // Place beside the point, flipping left near the right edge.
  const scale = svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
  const px = Number(dot.getAttribute('cx')) * scale, py = Number(dot.getAttribute('cy')) * scale;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  tip.style.left = `${px + 14 + tw > box.clientWidth ? px - tw - 14 : px + 14}px`;
  tip.style.top = `${Math.max(0, Math.min(py - th / 2, box.clientHeight - th))}px`;
}

/** Week 1's opening cash is typed straight into the grid. */
function openingCell(v) {
  return `<td class="num opening${v < 0 ? ' neg' : ''}"><input id="opening-input" type="text" inputmode="decimal" autocomplete="off" size="9"` +
    ` value="${esc(money(v, true))}" title="Cash in the bank at the start of week 1 — type to update" ${isReadOnly() ? 'disabled' : ''}></td>`;
}
function setOpeningCash(input) {
  const v = parseAmount(input.value);
  if (isNaN(v)) { toast('Type an amount, e.g. 42500'); input.value = money(Number(state.settings.openingBalance) || 0, true); return; }
  if (round2(v) === round2(Number(state.settings.openingBalance) || 0)) { input.value = money(v, true); return; }
  mutate(() => { state.settings.openingBalance = round2(v); state.settings.balanceDate = todayISO(); }, `Opening cash set to ${money(round2(v), true)}`);
}

/** Forecast lines (e.g. expected sales): one amount per week, typed straight into the grid. */
const forecastAmount = input => Number((state.forecasts.find(f => f.id === input.dataset.fid)?.weeks || {})[input.dataset.ws]) || 0;
function setForecastAmount(input) {
  const f = state.forecasts.find(x => x.id === input.dataset.fid);
  if (!f) return;
  const ws = input.dataset.ws;
  const v = input.value.trim() === '' ? 0 : parseAmount(input.value);
  if (isNaN(v)) { toast('Type an amount, e.g. 100000'); input.value = forecastAmount(input) ? money(forecastAmount(input)) : ''; return; }
  const amount = round2(Math.abs(v));
  if (amount === forecastAmount(input)) return;
  mutate(() => {
    f.weeks = f.weeks || {};
    if (amount) f.weeks[ws] = amount; else delete f.weeks[ws];
  }, `${f.name}, week of ${fmtDate(ws)}: ${amount ? money(amount) : 'cleared'}`);
}

function addForecastLine(name, type) {
  if (state.forecasts.some(f => f.type === type && f.name.toLowerCase() === name.toLowerCase())) { toast(`${name} is already there`); return; }
  mutate(() => { state.forecasts.push({ id: uid(), name, type, weeks: {} }); }, `Added ${name} — type the amount for each week`);
}

/** Cash in / out including overdue; the tile fills like a battery with the overdue share. */
function overdueKpi(label, total, overdue, plain) {
  if (!overdue) return kpi(label, money(total), plain);
  const all = total + overdue;
  const pct = all > 0 ? Math.max(0, Math.min(100, (overdue / all) * 100)) : 0;
  return `<div class="kpi battery" style="--fill:${pct.toFixed(1)}%" title="${Math.round(pct)}% of this is overdue — due before week 1 and not counted in the weekly cash balances">` +
    `<div class="label">${label} + overdue</div><div class="value">${money(all)}</div>` +
    `<div class="sub">includes ${money(overdue)} overdue · ${Math.round(pct)}%</div></div>`;
}

function kpi(label, value, sub, accent) {
  return `<div class="kpi${accent ? ' accent' : ''}"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
}

// ── Drill-down popover ──────────────────────────────────────
function cellEl(rk, w) {
  const tr = [...document.querySelectorAll('#grid tr[data-row]')].find(t => t.dataset.row === rk);
  return tr && tr.querySelector(`td.cell[data-week="${w}"]`);
}

function openPopover(rk, w) {
  const r = F.rows.get(rk);
  const anchor = cellEl(rk, w);
  if (!r || !anchor) return closePopover();
  popoverAt = { rk, w };
  document.querySelectorAll('#grid td.open').forEach(td => td.classList.remove('open'));
  anchor.classList.add('open');

  const evs = [...r.cells[w]].sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));
  const sign = r.type === 'out' ? -1 : 1;
  const wk = colLabel(w);
  const canDrag = !isReadOnly();
  let h = `<header><div><div class="t">${esc(r.name)}</div><div class="s">${wk} · ${evs.length} item${evs.length > 1 ? 's' : ''}${canDrag ? ' · drag a row onto another week' : ''}</div></div><button class="x" data-act="close" aria-label="Close">×</button></header>`;
  h += `<div class="body"><table><thead><tr><th></th><th>${r.recurring ? 'Schedule' : 'Invoice'}</th><th>Due</th><th>Expected</th><th class="num">Amount</th><th></th></tr></thead><tbody>`;
  for (const e of evs) {
    const badges = (e.overdue && w !== F.od ? '<span class="badge overdue">overdue</span>' : '') + (e.moved ? '<span class="badge moved">moved</span>' : '') +
      (e.edited ? '<span class="badge moved">amount changed</span>' : '');
    const acts = [];
    if (e.edited) acts.push(`<button class="link" data-act="reset-amount" data-key="${esc(e.key)}" title="Back to the standard amount">Reset amount</button>`);
    if (e.moved) acts.push(`<button class="link" data-act="reset" data-key="${esc(e.key)}" title="Back to due date">Reset</button>`);
    if (e.kind === 'recur') acts.push(`<button class="link" data-act="skip" data-key="${esc(e.key)}" title="Leave this payment out">Skip</button>`);
    else if (e.source === 'manual') acts.push(`<button class="link danger" data-act="delete" data-key="${esc(e.key)}">Delete</button>`);
    else acts.push(`<button class="link" data-act="exclude" data-key="${esc(e.key)}" title="Leave out of the forecast (e.g. disputed)">Exclude</button>`);
    h += `<tr data-key="${esc(e.key)}">` +
      `<td class="grip" ${canDrag ? 'draggable="true" title="Drag onto another week"' : ''}>${canDrag ? '⠿' : ''}</td>` +
      `<td>${esc(e.ref)}${badges}</td>` +
      `<td>${fmtDate(e.dueDate || e.origDate)}${e.rule ? `<span class="badge rule" title="Timing rule for ${esc(e.row)}">${e.rule}</span>` : ''}</td>` +
      `<td><input type="date" value="${e.date}" data-key="${esc(e.key)}" data-act="date" ${isReadOnly() ? 'disabled' : ''}></td>` +
      `<td class="num">${amountEditable(e)
        ? `<input class="amt" type="text" inputmode="decimal" size="9" value="${esc(money(e.amount, true))}" data-key="${esc(e.key)}" data-act="amount" title="Type a new amount for this one">`
        : money(sign * e.amount, true)}</td>` +
      `<td class="num">${acts.join('')}</td></tr>`;
  }
  h += `</tbody><tfoot><tr><td></td><td colspan="3">Total</td><td class="num">${money(sign * cellSum(evs), true)}</td><td></td></tr></tfoot></table></div>`;

  showPopover(h, anchor);
}

function colLabel(w) {
  return w < F.n ? `Week ${w + 1} · w/c ${fmtDate(F.weeks[w].start)}`
    : w === F.od ? `Overdue · due before ${fmtDate(F.cutoff)}, not counted in cash`
    : `Later · after ${fmtDate(F.weeks[F.n - 1].end)}`;
}

/** The ten contacts and recurring payments contributing most to a Cash in / Cash out cell. */
function openTopPopover(type, col) {
  const all = col === 'total';
  const w = all ? null : Number(col);
  const anchor = document.querySelector(`#grid td.sum[data-sum="${type}"][data-col="${col}"]`);
  const evs = F.events.filter(e => e.type === type && (all ? e.week < F.n : e.week === w));
  if (!anchor || !evs.length) return closePopover();
  popoverAt = { sum: type, w: col };
  document.querySelectorAll('#grid td.open').forEach(td => td.classList.remove('open'));
  anchor.classList.add('open');

  const groups = new Map();
  for (const e of evs) {
    const rk = rowKey(e);
    const g = groups.get(rk) || { rk, name: e.row, recurring: !!e.recurring, dd: !!e.dd, amount: 0, count: 0 };
    g.amount += e.amount;
    g.count++;
    groups.set(rk, g);
  }
  const list = [...groups.values()].sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
  const top = list.slice(0, 10), rest = list.slice(10);
  const total = cellSum(evs);
  const sign = type === 'out' ? -1 : 1;
  const share = v => (total > 0 ? Math.max(0, Math.min(100, (v / total) * 100)) : 0);
  const when = all ? `${F.n} weeks · ${fmtDate(F.weeks[0].start)} – ${fmtDate(F.weeks[F.n - 1].end)}` : colLabel(w);

  let h = `<header><div><div class="t">${type === 'in' ? 'Where the cash comes from' : 'Where the cash goes'}</div>` +
    `<div class="s">${when} · top ${top.length} of ${list.length}${all ? '' : ' · click a name for its invoices'}</div></div><button class="x" data-act="close" aria-label="Close">×</button></header>`;
  h += `<div class="body tall"><table class="top"><thead><tr><th>#</th><th>${type === 'in' ? 'From' : 'To'}</th><th class="num">Items</th><th class="num">Amount</th><th class="num">Share</th></tr></thead><tbody>`;
  top.forEach((g, i) => {
    h += `<tr${all ? '' : ` class="pick" data-rk="${esc(g.rk)}" data-w="${w}"`}><td class="muted">${i + 1}</td>` +
      `<td>${esc(g.name)}${g.recurring ? `<span class="badge rule">${g.dd ? 'direct debit' : 'recurring'}</span>` : ''}</td>` +
      `<td class="num">${g.count}</td><td class="num">${money(sign * g.amount, true)}</td>` +
      `<td class="num share"><span class="bar" style="width:${share(g.amount).toFixed(1)}%"></span>${Math.round(share(g.amount))}%</td></tr>`;
  });
  if (rest.length) {
    const r = cellSum(rest);
    h += `<tr><td></td><td class="muted">${rest.length} other${rest.length === 1 ? '' : 's'}</td><td class="num">${rest.reduce((a, g) => a + g.count, 0)}</td>` +
      `<td class="num">${money(sign * r, true)}</td><td class="num share"><span class="bar" style="width:${share(r).toFixed(1)}%"></span>${Math.round(share(r))}%</td></tr>`;
  }
  h += `</tbody><tfoot><tr><td></td><td>Total</td><td class="num">${evs.length}</td><td class="num">${money(sign * total, true)}</td><td></td></tr></tfoot></table></div>`;
  showPopover(h, anchor);
}

/** Open a row's drill-down from the top 10, scrolling its cell into view first. */
function drillInto(rk, w) {
  const wrap = document.querySelector('.grid-wrap');
  const cell = cellEl(rk, w);
  if (!cell) return;
  const before = [wrap.scrollTop, wrap.scrollLeft];
  cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (wrap.scrollTop === before[0] && wrap.scrollLeft === before[1]) openPopover(rk, w);
  else setTimeout(() => openPopover(rk, w), 80); // after the scroll has closed the top 10
}

function showPopover(h, anchor) {
  const pop = document.getElementById('popover');
  pop.innerHTML = h;
  pop.hidden = false;
  pop.classList.remove('dragging');
  // Position under the cell, kept inside the viewport.
  const rect = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = rect.left + window.scrollX + rect.width / 2 - pw / 2;
  left = Math.max(window.scrollX + 8, Math.min(left, window.scrollX + document.documentElement.clientWidth - pw - 8));
  let top = rect.bottom + window.scrollY + 6;
  if (rect.bottom + ph + 12 > window.innerHeight && rect.top - ph - 6 > 0) top = rect.top + window.scrollY - ph - 6;
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}

function closePopover() {
  popoverAt = null;
  document.getElementById('popover').hidden = true;
  document.querySelectorAll('#grid td.open').forEach(td => td.classList.remove('open'));
}

// ── Changing amounts ────────────────────────────────────────
/** Recurring payments and items added here can be edited; Xero invoices keep Xero's amount. */
const amountEditable = e => !isReadOnly() && (e.kind === 'recur' || e.source === 'manual');

function setEventAmount(e, amount) {
  if (e.kind === 'item') {
    const it = state.items.find(x => x.id === e.id);
    if (it) it.amount = amount;
    return;
  }
  const r = state.recurring.find(x => x.id === e.rid);
  const ov = state.recurOverrides[e.okey] || {};
  if (amount == null || (r && round2(amount) === round2(Number(r.amount)))) delete ov.amount; else ov.amount = amount;
  if (Object.keys(ov).length) state.recurOverrides[e.okey] = ov; else delete state.recurOverrides[e.okey];
}

// ── Moving cash between weeks ───────────────────────────────
function setEventDate(e, iso) {
  if (e.kind === 'item') {
    const it = state.items.find(x => x.id === e.id);
    if (!it) return;
    if (iso === plannedDate(it)) delete it.expectedDate; else it.expectedDate = iso;
    delete it.parked; // given a date again, so no longer held back
  } else {
    const ov = state.recurOverrides[e.okey] || {};
    if (iso === e.origDate) delete ov.date; else ov.date = iso;
    if (Object.keys(ov).length) state.recurOverrides[e.okey] = ov; else delete state.recurOverrides[e.okey];
  }
}

function moveToWeek(keys, w) {
  const target = F.weeks[w];
  if (!target) return;
  const evs = keys.map(k => eventIndex.get(k)).filter(e => e && (e.week !== w || e.overdue));
  if (!evs.length) return;
  mutate(() => {
    // Keep the same day of the week; overdue items land on the Monday.
    for (const e of evs) setEventDate(e, addDays(target.start, e.overdue ? 0 : weekday(e.date)));
  }, `Moved ${evs.length === 1 ? (evs[0].kind === 'recur' ? evs[0].row : evs[0].ref) : evs.length + ' items'} to week ${w + 1}`);
}

function wireGrid() {
  const grid = document.getElementById('grid');
  const pop = document.getElementById('popover');
  let dragKeys = null;

  grid.addEventListener('click', ev => {
    const del = ev.target.closest('button.del-forecast');
    if (del) {
      const f = state.forecasts.find(x => x.id === del.dataset.fid);
      if (f && confirm(`Remove ${f.name} and all its weekly amounts?`)) mutate(() => { state.forecasts = state.forecasts.filter(x => x !== f); }, `Removed ${f.name}`);
      return;
    }
    const sum = ev.target.closest('td.sum');
    if (sum) {
      const { sum: type, col } = sum.dataset;
      if (popoverAt && popoverAt.sum === type && String(popoverAt.w) === col) closePopover();
      else openTopPopover(type, col);
      ev.stopPropagation();
      return;
    }
    const td = ev.target.closest('td.cell.has');
    if (!td) return;
    const rk = td.parentElement.dataset.row, w = Number(td.dataset.week);
    if (popoverAt && popoverAt.rk === rk && popoverAt.w === w) closePopover();
    else openPopover(rk, w);
    ev.stopPropagation();
  });

  grid.addEventListener('focusin', ev => {
    if (ev.target.id === 'opening-input') { ev.target.value = String(Number(state.settings.openingBalance) || 0); ev.target.select(); }
    if (ev.target.matches('input.est')) { const v = forecastAmount(ev.target); ev.target.value = v ? String(v) : ''; ev.target.select(); }
  });
  grid.addEventListener('change', ev => {
    if (ev.target.id === 'opening-input') setOpeningCash(ev.target);
    if (ev.target.matches('input.est')) setForecastAmount(ev.target);
  });
  grid.addEventListener('focusout', ev => { // left unchanged: show it formatted again
    if (ev.target.matches('input.est')) { const v = forecastAmount(ev.target); ev.target.value = v ? money(v) : ''; }
  });
  grid.addEventListener('focusout', ev => { if (ev.target.id === 'opening-input' && !/[£,]/.test(ev.target.value)) setOpeningCash(ev.target); });
  grid.addEventListener('keydown', ev => {
    if (ev.target.matches('input.add-forecast')) {
      if (ev.key === 'Enter' && ev.target.value.trim()) addForecastLine(ev.target.value.trim(), ev.target.dataset.type);
      if (ev.key === 'Escape') { ev.target.value = ''; ev.target.blur(); }
      return;
    }
    if (ev.target.matches('input.est')) {
      if (ev.key === 'Enter') ev.target.blur();
      if (ev.key === 'Escape') { const v = forecastAmount(ev.target); ev.target.value = v ? String(v) : ''; ev.target.blur(); }
      return;
    }
    if (ev.target.id !== 'opening-input') return;
    if (ev.key === 'Enter') ev.target.blur();
    if (ev.key === 'Escape') { ev.target.value = money(Number(state.settings.openingBalance) || 0, true); ev.target.blur(); }
  });

  grid.addEventListener('dragstart', ev => {
    const td = ev.target.closest('td.cell.has');
    if (!td) return;
    const r = F.rows.get(td.parentElement.dataset.row);
    dragKeys = r.cells[Number(td.dataset.week)].map(e => e.key);
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', dragKeys.join(','));
    closePopover();
  });

  pop.addEventListener('dragstart', ev => {
    const tr = ev.target.closest('tr[data-key]');
    if (!tr) return;
    dragKeys = [tr.dataset.key];
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', tr.dataset.key);
    setTimeout(() => pop.classList.add('dragging'), 0); // let the grid underneath receive the drop
  });

  const clearTargets = () => document.querySelectorAll('.drop-target').forEach(x => x.classList.remove('drop-target'));
  const dropWeek = ev => {
    const el = ev.target.closest('#grid [data-week]');
    if (!el) return null;
    const w = Number(el.dataset.week);
    return w < F.n ? w : null;
  };

  grid.addEventListener('dragover', ev => {
    if (!dragKeys) return;
    const w = dropWeek(ev);
    clearTargets();
    if (w == null) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    const el = ev.target.closest('[data-week]');
    el.classList.add('drop-target');
    const th = grid.querySelector(`thead th[data-week="${w}"]`);
    if (th) th.classList.add('drop-target');
  });
  grid.addEventListener('dragleave', ev => { if (!grid.contains(ev.relatedTarget)) clearTargets(); });
  grid.addEventListener('drop', ev => {
    const w = dropWeek(ev);
    clearTargets();
    if (w == null || !dragKeys) return;
    ev.preventDefault();
    const keys = dragKeys;
    dragKeys = null;
    moveToWeek(keys, w);
  });
  document.addEventListener('dragend', () => { dragKeys = null; clearTargets(); pop.classList.remove('dragging'); });

  // Popover actions
  pop.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-act]');
    const pick = ev.target.closest('tr.pick[data-rk]');
    if (!b && pick) { ev.stopPropagation(); drillInto(pick.dataset.rk, Number(pick.dataset.w)); return; }
    if (!b) return;
    ev.stopPropagation();
    const e = eventIndex.get(b.dataset.key);
    switch (b.dataset.act) {
      case 'close': return closePopover();
      case 'reset-amount': return mutate(() => setEventAmount(e, null), `${e.row} on ${fmtDate(e.date)} back to ${money(Number(state.recurring.find(x => x.id === e.rid)?.amount) || 0, true)}`);
      case 'reset': return mutate(() => setEventDate(e, e.origDate), `${e.ref} back to ${e.rule ? 'its rule date' : 'its due date'}`);
      case 'skip': return mutate(() => { state.recurOverrides[e.okey] = { ...(state.recurOverrides[e.okey] || {}), skip: true }; }, `Skipped ${e.row} on ${fmtDate(e.origDate)}`);
      case 'exclude': return mutate(() => { const it = state.items.find(x => x.id === e.id); if (it) it.excluded = true; }, `Excluded ${e.ref} — restore it on Data & import`);
      case 'delete': return mutate(() => { state.items = state.items.filter(x => x.id !== e.id); }, `Deleted ${e.ref}`);
    }
  });
  pop.addEventListener('change', ev => {
    const amt = ev.target.closest('input[data-act="amount"]');
    if (amt) {
      const e = eventIndex.get(amt.dataset.key);
      const v = parseAmount(amt.value);
      if (isNaN(v)) { toast('Type an amount, e.g. 2000'); amt.value = money(e.amount, true); return; }
      const label = e.kind === 'recur' ? `${e.row} on ${fmtDate(e.date)}` : e.ref;
      mutate(() => setEventAmount(e, round2(Math.abs(v))), `${label} set to ${money(round2(Math.abs(v)), true)}`);
      return;
    }
    const inp = ev.target.closest('input[data-act="date"]');
    if (!inp || !inp.value) return;
    const e = eventIndex.get(inp.dataset.key);
    mutate(() => setEventDate(e, inp.value), `${e.kind === 'recur' ? e.row : e.ref} moved to ${fmtDate(inp.value)}`);
  });
  pop.addEventListener('click', ev => ev.stopPropagation());
  pop.addEventListener('keydown', ev => { if (ev.key === 'Enter' && ev.target.matches('input.amt')) ev.target.blur(); });
  pop.addEventListener('focusin', ev => { if (ev.target.matches('input.amt')) { ev.target.value = String(eventIndex.get(ev.target.dataset.key)?.amount ?? ''); ev.target.select(); } });
  document.addEventListener('click', () => { if (popoverAt) closePopover(); });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') closePopover();
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'z' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { ev.preventDefault(); undo(); }
  });
  window.addEventListener('resize', () => { if (popoverAt) popoverAt.sum ? openTopPopover(popoverAt.sum, popoverAt.w) : openPopover(popoverAt.rk, popoverAt.w); });
  let bridgeWidth = 0;
  window.addEventListener('resize', () => {
    const w = document.getElementById('tw-bridge').clientWidth;
    if (currentTab() === 'thisweek' && w && Math.abs(w - bridgeWidth) > 24) { bridgeWidth = w; renderThisWeek(); }
  });
  document.querySelector('.grid-wrap').addEventListener('scroll', () => { if (popoverAt) closePopover(); });

  const chart = document.getElementById('ov-chart');
  const chartHit = ev => { const r = ev.target.closest('rect.hit'); return r ? Number(r.dataset.i) : null; };
  chart.addEventListener('mouseover', ev => showChartTip(chartHit(ev)));
  chart.addEventListener('focusin', ev => showChartTip(chartHit(ev)));
  chart.addEventListener('mouseleave', () => showChartTip(null));
  chart.addEventListener('focusout', () => showChartTip(null));
  window.addEventListener('resize', () => {
    const w = chart.clientWidth;
    if (currentTab() === 'overview' && w && Math.abs(w - chartWidth) > 24) renderClosingChart();
  });
}

function exportGridCSV() {
  const { weeks, n, od, rows, cin, cout, open, close } = F;
  const q = v => `"${String(v).replace(/"/g, '""')}"`;
  const num = v => (Math.round(v * 100) / 100).toFixed(2);
  const lines = [['', `Overdue (before ${F.cutoff})`, ...weeks.map(w => `Wk ${w.i + 1} (${w.start})`), 'Later'].map(q).join(',')];
  const add = (label, odVal, arr) => lines.push([q(label), odVal == null ? '' : num(odVal), ...arr.map(num)].join(','));
  add('Cash at start of week', null, open);
  add('Cash in', cin[od], cin.slice(0, n));
  add('Cash out', -cout[od], cout.slice(0, n).map(v => -v));
  add('Net in / (out)', null, weeks.map((_, i) => cin[i] - cout[i]));
  add('Cash at end of week', null, close);
  lines.push('');
  for (const type of ['in', 'out']) {
    lines.push(q(type === 'in' ? 'CASH IN' : 'CASH OUT'));
    [...rows.values()].filter(r => r.type === type).sort((a, b) => b.total - a.total)
      .forEach(r => { const sign = type === 'out' ? -1 : 1; add(r.name + (r.recurring ? ' (recurring)' : ''), sign * cellSum(r.cells[od]), r.cells.slice(0, n + 1).map(c => sign * cellSum(c))); });
  }
  download(`cash-flow-forecast-${weeks[0].start}.csv`, lines.join('\n'), 'text/csv');
}

// ════════════════════════════════════════════════════════════
//  This week tab — the Friday payment run
//  Cash now − bills to pay this week − direct debits due by the
//  end of next week = what is left. Bills can be pulled in from
//  the overdue list, discarded to next week, or paid with the credit facility
//  (the credit facility), which takes them out of the cash figures.
// ════════════════════════════════════════════════════════════

function thisWeekRange() {
  const today = todayISO();
  const start = mondayOf(today);
  return { today, start, end: addDays(start, 6), ddEnd: addDays(start, 13) };
}

function payRunLists() {
  refreshForecast();
  const { today, start, end, ddEnd } = thisWeekRange();
  const out = F.events.filter(e => e.type === 'out' && !e.forecast); // planned payments are estimates, not bills to pay
  const starred = (a, b) => isImportant(b) - isImportant(a); // important first
  const byDate = (a, b) => starred(a, b) || a.date.localeCompare(b.date) || a.row.localeCompare(b.row);
  return {
    toPay: out.filter(e => !e.dd && !e.parked && e.date >= start && e.date <= end) // one supplier's bills together
      .sort((a, b) => starred(a, b) || a.row.localeCompare(b.row) || a.date.localeCompare(b.date)),
    dds: out.filter(e => e.dd && e.date > today && e.date <= ddEnd).sort(byDate),
    overdue: out.filter(e => e.kind === 'item' && !e.dd && (e.date < start || e.parked)).sort((a, b) => starred(a, b) || a.row.localeCompare(b.row) || a.date.localeCompare(b.date)),
    triffin: state.items.filter(i => i.type === 'out' && i.financed && i.financed.date >= start && i.financed.date <= end)
      .sort((a, b) => a.contact.localeCompare(b.contact)),
  };
}

/** Important bills (starred on This week) sort to the top of their list. */
function isImportant(e) {
  if (e.kind === 'item') return !!(state.items.find(x => x.id === e.id) || {}).important;
  if (e.kind === 'recur') return !!(state.recurOverrides[e.okey] || {}).important;
  return false;
}
function toggleImportant(e) {
  const on = !isImportant(e);
  mutate(() => {
    if (e.kind === 'item') {
      const it = state.items.find(x => x.id === e.id);
      if (it) { if (on) it.important = true; else delete it.important; }
    } else {
      const ov = state.recurOverrides[e.okey] || {};
      if (on) ov.important = true; else delete ov.important;
      if (Object.keys(ov).length) state.recurOverrides[e.okey] = ov; else delete state.recurOverrides[e.okey];
    }
  }, `${e.kind === 'recur' ? e.row : `${e.row} ${e.ref}`} ${on ? 'marked important' : 'no longer important'}`);
}

/**
 * Cash bridge: cash now, down by this week's payments, down by the direct debits,
 * to what is left. Bars float between the running totals; the ends start at zero.
 */
function bridgeSVG(steps, width) {
  const W = Math.max(320, Math.min(900, Math.round(width) || 760)), narrow = W < 560; // drawn at real size so text stays legible
  const H = narrow ? 210 : 230, top = 28, bottom = 44, left = 4, right = 4;
  let run = 0;
  const bars = steps.map(st => {
    const from = st.total ? 0 : run;
    const to = st.total ? st.value : run - st.value;
    run = to;
    return { ...st, from, to };
  });
  const vals = bars.flatMap(b => [b.from, b.to]).concat(0);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const y = v => top + (hi - v) / span * (H - top - bottom);
  const slot = (W - left - right) / bars.length;
  const bw = Math.min(110, slot * (narrow ? 0.62 : 0.5));
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="bridge" role="img" aria-label="Cash bridge: ${bars.map(b => `${b.label} ${money(b.total ? b.to : -b.value)}`).join(', ')}">`;
  svg += `<line class="zero" x1="${left}" x2="${W - right}" y1="${y(0)}" y2="${y(0)}"/>`;
  bars.forEach((b, i) => {
    const cx = left + slot * i + slot / 2, x = cx - bw / 2;
    const y1 = y(Math.max(b.from, b.to)), y2 = y(Math.min(b.from, b.to));
    const h = Math.max(1, y2 - y1);
    if (i < bars.length - 1) { // connector to the next bar at the running total
      const nx = left + slot * (i + 1) + slot / 2 - bw / 2;
      svg += `<line class="link" x1="${x + bw}" x2="${nx}" y1="${y(b.to)}" y2="${y(b.to)}"/>`;
    }
    svg += `<g class="bar ${b.cls}" tabindex="0"><title>${esc(b.tip)}</title>` +
      `<rect class="hit" x="${cx - slot / 2}" y="${top - 20}" width="${slot}" height="${H - top - bottom + 40}"/>` +
      `<rect class="fill" x="${x}" y="${y1}" width="${bw}" height="${h}" rx="4"/>` +
      `<text class="val" x="${cx}" y="${y1 - 8}">${b.cls === 'short' ? money(-b.to) : b.total ? money(b.to) : money(-b.value)}</text>` +
      `<text class="lbl" x="${cx}" y="${H - bottom + 20}">${esc(narrow && b.shortLabel ? b.shortLabel : b.label)}</text>` +
      (narrow ? '' : `<text class="sub" x="${cx}" y="${H - bottom + 36}">${esc(b.sub)}</text>`) + '</g>';
  });
  return svg + '</svg>';
}

function renderThisWeek() {
  const { today, start, end, ddEnd } = thisWeekRange();
  const L = payRunLists();
  const tw = state.thisWeek || {};
  const cash = Number(tw.cash) || 0;
  const sum = list => list.reduce((a, e) => a + (Number(e.amount) || 0), 0);
  const toPay = sum(L.toPay), dds = sum(L.dds), triffin = sum(L.triffin);
  const after = cash - toPay, headroom = after - dds;
  const stale = tw.date && tw.date < start;

  document.getElementById('tw-undo').disabled = undoStack.length === 0;
  document.getElementById('tw-sub').textContent =
    `Week of ${fmtDateY(start)} – ${fmtDate(end)} · direct debits counted to ${fmtDateY(ddEnd)}`;
  const bridgeBox = document.getElementById('tw-bridge');
  bridgeBox.innerHTML = bridgeSVG([
    { label: 'Cash in bank now', shortLabel: 'Cash now', sub: tw.date ? `as at ${fmtDate(tw.date)}` : 'not entered yet', value: cash, total: true, cls: 'total',
      tip: `Cash in bank now: ${money(cash, true)}` },
    { label: 'To pay this week', shortLabel: 'To pay', sub: `${L.toPay.length} payment${L.toPay.length === 1 ? '' : 's'}`, value: toPay, cls: 'down',
      tip: `To pay this week: ${money(toPay, true)}\n` + L.toPay.slice(0, 12).map(e => `${e.row} ${money(e.amount)}`).join('\n') + (L.toPay.length > 12 ? `\n+ ${L.toPay.length - 12} more` : '') },
    { label: 'Direct debits', sub: `to ${fmtDate(ddEnd)}`, value: dds, cls: 'down',
      tip: `Direct debits to ${fmtDate(ddEnd)}: ${money(dds, true)}\n` + L.dds.map(e => `${fmtDate(e.date)} ${e.row} ${money(e.amount)}`).join('\n') },
    { label: headroom < 0 ? 'Short by' : 'Left', sub: 'after all of it', value: headroom, total: true, cls: headroom < 0 ? 'short' : 'left',
      tip: `${headroom < 0 ? 'Short by' : 'Left'}: ${money(Math.abs(headroom), true)}` },
  ], bridgeBox.clientWidth - 32);
  document.getElementById('tw-kpis').innerHTML =
    `<div class="kpi accent tw-cash"><div class="label">Cash in bank now</div>` +
    `<input id="tw-cash" type="text" inputmode="decimal" autocomplete="off" value="${esc(money(cash, true))}" ${isReadOnly() ? 'disabled' : ''}>` +
    `<div class="sub">${tw.date ? `entered ${fmtDate(tw.date)}${stale ? ' — last week, update it' : ''}` : 'type today’s balance'}</div></div>` +
    kpi('To pay this week', money(-toPay), `${L.toPay.length} payment${L.toPay.length === 1 ? '' : 's'}`) +
    kpi('Cash after payments', `<span class="${after < 0 ? 'neg' : ''}">${money(after)}</span>`, 'cash now − to pay') +
    kpi('Direct debits to cover', money(-dds), `${fmtDate(addDays(today, 1))} – ${fmtDate(ddEnd)} · leave this in the bank`) +
    kpi(headroom < 0 ? 'Short by' : 'Headroom', `<span class="${headroom < 0 ? 'neg' : 'pos'}">${money(Math.abs(headroom))}</span>`,
      headroom < 0 ? `discard or move bills to ${CFG.creditFacility}` : 'left after payments and direct debits');

  const rowsHtml = (list, zone, actions) => list.length
    ? '<tbody>' + list.map(e => {
      const late = e.date < start ? Math.max(0, daysBetween(e.dueDate || e.origDate || e.date, today)) : 0;
      return `<tr draggable="${!isReadOnly() && zone !== 'dd'}" data-key="${esc(e.key)}" data-zone="${zone}">` +
        `<td class="grip">${zone === 'dd' ? '' : '⠿'}</td>` +
        `<td class="star-cell">${zone === 'topay' || zone === 'overdue'
          ? `<button class="star${isImportant(e) ? ' on' : ''}" data-act="star" data-key="${esc(e.key)}" title="${isImportant(e) ? 'Important — click to unmark' : 'Mark as important'}" ${isReadOnly() ? 'disabled' : ''}>${isImportant(e) ? '★' : '☆'}</button>` : ''}</td>` +
        `<td><b>${esc(e.row)}</b><div class="small muted">${esc(e.ref)}</div>${zone === 'topay' && e.kind === 'item' ? `<div class="small">${bankLine(e.row)}</div>` : ''}</td>` +
        `<td class="small">${fmtDate(e.dueDate || e.origDate || e.date)}${late ? ` <span class="pill out">${late}d late</span>` : ''}${e.rule ? ` <span class="pill neutral" title="Timing rule for ${esc(e.row)}">${e.rule}</span>` : ''}${e.moved && zone === 'topay' && e.dueDate && e.dueDate < start ? ' <span class="pill neutral">from overdue</span>' : ''}${e.parked && zone === 'overdue' ? ' <span class="pill neutral" title="Due this week but not being paid now">held back</span>' : ''}</td>` +
        `<td class="num">${money(e.amount, true)}</td><td class="num nowrap">${isReadOnly() ? '' : actions(e)}</td></tr>`;
    }).join('') + '</tbody>'
    : `<tbody><tr><td class="muted small empty-zone">${{ topay: 'Nothing due this week — drag overdue bills here to pay them.', triffin: `Drag bills here to pay them with ${CFG.creditFacility}.`, overdue: 'No overdue bills.', dd: 'No direct debits due.' }[zone]}</td></tr></tbody>`;
  const foot = (total, cols = 6) => `<tfoot><tr><td></td><td colspan="${cols - 3}">Total</td><td class="num">${money(total, true)}</td><td></td></tr></tfoot>`;

  document.getElementById('tw-topay').innerHTML = rowsHtml(L.toPay, 'topay', e =>
    (e.kind === 'item' ? `<button class="link" data-act="triffin" data-key="${esc(e.key)}">${esc(CFG.creditFacility)} →</button>` : '') +
    `<button class="link danger" data-act="discard" data-key="${esc(e.key)}" title="Not paying this week — moves it to next week">Discard</button>`) + (L.toPay.length ? foot(toPay) : '');
  document.getElementById('tw-triffin').innerHTML = rowsHtml(L.triffin.map(i => ({
    key: 'f:' + i.id, row: i.contact, ref: i.invoiceNumber || '—', amount: Number(i.amount) || 0, date: i.expectedDate || plannedDate(i), dueDate: i.dueDate,
  })), 'triffin', e => `<button class="link" data-act="untriffin" data-key="${esc(e.key)}" title="Back to To pay">← Back</button>`) + (L.triffin.length ? foot(triffin) : '');
  document.getElementById('tw-dd').innerHTML = rowsHtml(L.dds, 'dd', () => '') + (L.dds.length ? foot(dds) : '');
  document.getElementById('tw-overdue').innerHTML = rowsHtml(L.overdue, 'overdue', e =>
    `<button class="link" data-act="pay" data-key="${esc(e.key)}">Pay →</button>` +
    `<button class="link danger" data-act="drop" data-key="${esc(e.key)}" title="Leave out of the forecast (e.g. disputed or already paid) — restore it on Data &amp; import">Discard</button>`) + (L.overdue.length ? foot(sum(L.overdue)) : '');
  document.getElementById('tw-suppliers').innerHTML = [...new Set(state.items.filter(i => i.type === 'out').map(i => i.contact))].sort()
    .map(c => `<option value="${esc(c)}">`).join('');
  document.getElementById('tw-add').hidden = isReadOnly();
  document.getElementById('tw-dd-title').textContent = `Direct debits · ${fmtDate(addDays(today, 1))} – ${fmtDate(ddEnd)}`;
  document.getElementById('tw-triffin-total').textContent = triffin ? `${money(triffin, true)} this week` : '';
}

/** Move a payment between the lists. Keys: event keys from the forecast, or "f:<itemId>" for the credit facility list. */
function payRunMove(key, zone) {
  const { today, start } = thisWeekRange();
  if (key.startsWith('f:')) {
    const it = state.items.find(x => x.id === key.slice(2));
    if (!it) return;
    if (zone === 'triffin') return;
    return mutate(() => {
      delete it.financed;
      delete it.parked;
      if (zone === 'topay' && (it.expectedDate || plannedDate(it)) < start) it.expectedDate = today;
      if (zone === 'overdue') { delete it.expectedDate; if (!(plannedDate(it) < start)) it.parked = true; }
    }, `${it.invoiceNumber || it.contact} taken off ${CFG.creditFacility}`);
  }
  const e = eventIndex.get(key);
  if (!e) return;
  const label = e.kind === 'recur' ? e.row : `${e.row} ${e.ref}`;
  const item = e.kind === 'item' && state.items.find(x => x.id === e.id);
  if (zone === 'topay') {
    const inWeek = e.date >= start && e.date <= addDays(start, 6);
    if (inWeek && !e.parked) return;
    return mutate(() => { if (item) delete item.parked; if (!inWeek) setEventDate(e, today); }, `${label} added to this week’s payments`);
  }
  if (zone === 'triffin') {
    if (e.kind !== 'item') { toast(`Only bills can be paid with ${CFG.creditFacility}.`); return; }
    return mutate(() => { if (item) { item.financed = { by: CFG.creditFacility, date: today }; delete item.parked; } },
      `${label} paid with ${CFG.creditFacility} — out of the cash figures`);
  }
  if (zone === 'overdue') {
    if (!item) { toast('Only bills can go to the overdue list — use Discard to move this to next week.'); return; }
    if (e.parked || (e.origDate < start && e.date < start)) return; // already there
    return mutate(() => {
      delete item.expectedDate;
      if (!(e.origDate < start)) item.parked = true; // due this week: parked as overdue, out of the cash figures
    }, `${label} moved to overdue — not being paid this week`);
  }
}

/**
 * Bulk payment file for the bank (CFG.bank): one row per bill in To pay this week, in the
 * bank's template (Name, Account Type, Reference, Sort Code, Account no, Amount).
 * Bills without bank details, and credit notes, are left out and listed.
 */
function downloadBulkPayment() {
  const { toPay } = payRunLists();
  const rows = [], noBank = [], credits = [];
  for (const e of toPay) {
    const b = bankFor(e.row);
    if (!(e.amount > 0)) { credits.push(e); continue; }
    if (!b) { noBank.push(e); continue; }
    const ref = (e.kind === 'item' && e.ref !== '—' ? e.ref : e.row).replace(/[^A-Za-z0-9 \-./&]/g, '').trim().slice(0, 18); // UK payment refs: 18 chars
    const amt = Math.round(e.amount * 100) / 100;
    rows.push([b.accountName || b.name, b.accountType || 'Business', ref, digits(b.sortCode), digits(b.accountNo),
      Number.isInteger(amt) ? String(amt) : amt.toFixed(2)]); // as the template: 25000, 652.94
  }
  if (!rows.length) { toast(noBank.length ? 'None of this week’s bills have bank details yet — add them on the Bank details tab.' : 'Nothing to pay this week.'); return; }
  const cell = v => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = [['Name', 'Account Type', 'Reference', 'Sort Code', 'Account no', 'Amount'], ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
  download(`${CFG.bank.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-bulk-payment-${todayISO()}.csv`, csv, 'text/csv');
  const total = rows.reduce((a, r) => a + Number(r[5]), 0);
  const left = [noBank.length && `${noBank.length} without bank details (${[...new Set(noBank.map(e => e.row))].slice(0, 4).join(', ')}${new Set(noBank.map(e => e.row)).size > 4 ? '…' : ''})`,
    credits.length && `${credits.length} credit note${credits.length === 1 ? '' : 's'}`].filter(Boolean);
  toast(`${rows.length} payment${rows.length === 1 ? '' : 's'}, ${money(total, true)}${left.length ? ` — left out: ${left.join('; ')}` : ''}`);
}

function payRunDiscard(key) {
  const e = eventIndex.get(key);
  if (!e) return;
  const next = addDays(e.date < todayISO() ? todayISO() : e.date, 7);
  mutate(() => setEventDate(e, next), `${e.kind === 'recur' ? e.row : `${e.row} ${e.ref}`} moved to ${fmtDate(next)}`);
}

function setThisWeekCash(input) {
  const v = parseAmount(input.value);
  const cur = Number((state.thisWeek || {}).cash) || 0;
  if (isNaN(v)) { toast('Type an amount, e.g. 18500'); input.value = money(cur, true); return; }
  if (round2(v) === round2(cur) && (state.thisWeek || {}).date === todayISO()) { input.value = money(v, true); return; }
  mutate(() => { state.thisWeek = { cash: round2(v), date: todayISO() }; }, `Cash in bank set to ${money(round2(v), true)}`);
}

function wireThisWeek() {
  const panel = document.getElementById('tab-thisweek');
  document.getElementById('tw-add').addEventListener('submit', ev => {
    ev.preventDefault();
    const f = ev.target;
    const amount = parseAmount(f.amount.value);
    if (isNaN(amount) || !amount) { toast('Type an amount, e.g. 450'); f.amount.focus(); return; }
    const it = { id: uid(), source: 'manual', type: 'out', contact: f.contact.value.trim(), invoiceNumber: f.ref.value.trim(),
      amount: round2(Math.abs(amount)), dueDate: todayISO() };
    if (!it.contact) return;
    mutate(() => state.items.push(it), `Added ${it.contact} ${money(it.amount, true)} to this week’s payments`);
    f.reset();
    f.contact.focus();
  });
  let dragKey = null;
  panel.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    const k = b.dataset.key;
    if (b.dataset.act === 'pay') payRunMove(k, 'topay');
    if (b.dataset.act === 'triffin') payRunMove(k, 'triffin');
    if (b.dataset.act === 'untriffin') payRunMove(k, 'topay');
    if (b.dataset.act === 'discard') payRunDiscard(k);
    if (b.dataset.act === 'bulk-csv') downloadBulkPayment();
    if (b.dataset.act === 'star') { const e = eventIndex.get(k); if (e) toggleImportant(e); }
    if (b.dataset.act === 'drop') {
      const e = eventIndex.get(k);
      if (e && e.kind === 'item') mutate(() => { const it = state.items.find(x => x.id === e.id); if (it) it.excluded = true; },
        `${e.row} ${e.ref} discarded — restore it on Data & import`);
    }
  });
  panel.addEventListener('dragstart', ev => {
    const tr = ev.target.closest && ev.target.closest('tr[data-key]');
    if (!tr || tr.dataset.zone === 'dd') return;
    dragKey = tr.dataset.key;
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', dragKey);
  });
  const zoneOf = ev => ev.target.closest && ev.target.closest('.dropzone');
  panel.addEventListener('dragover', ev => {
    const z = zoneOf(ev);
    panel.querySelectorAll('.dropzone.over').forEach(x => x !== z && x.classList.remove('over'));
    if (!z || !dragKey) return;
    ev.preventDefault();
    z.classList.add('over');
  });
  panel.addEventListener('drop', ev => {
    const z = zoneOf(ev);
    panel.querySelectorAll('.dropzone.over').forEach(x => x.classList.remove('over'));
    if (!z || !dragKey) return;
    ev.preventDefault();
    const k = dragKey;
    dragKey = null;
    payRunMove(k, z.dataset.zone);
  });
  panel.addEventListener('dragend', () => { dragKey = null; panel.querySelectorAll('.dropzone.over').forEach(x => x.classList.remove('over')); });

  panel.addEventListener('focusin', ev => { if (ev.target.id === 'tw-cash') { ev.target.value = String(Number((state.thisWeek || {}).cash) || 0); ev.target.select(); } });
  panel.addEventListener('change', ev => { if (ev.target.id === 'tw-cash') setThisWeekCash(ev.target); });
  panel.addEventListener('focusout', ev => { if (ev.target.id === 'tw-cash' && !/[£,]/.test(ev.target.value)) setThisWeekCash(ev.target); });
  panel.addEventListener('keydown', ev => {
    if (ev.target.id !== 'tw-cash') return;
    if (ev.key === 'Enter') ev.target.blur();
    if (ev.key === 'Escape') { ev.target.value = money(Number((state.thisWeek || {}).cash) || 0, true); ev.target.blur(); }
  });
}

// ════════════════════════════════════════════════════════════
//  Bank details tab — supplier sort codes and account numbers
// ════════════════════════════════════════════════════════════

const CHANGE_WARN_DAYS = 30; // details changed this recently get a "check with the supplier" flag

const digits = v => String(v || '').replace(/\D/g, '');
const fmtSortCode = v => digits(v).replace(/^(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3');
const bankFor = name => (state.suppliers || []).find(s => s.name.trim().toLowerCase() === String(name || '').trim().toLowerCase());
const recentlyChanged = s => s && s.changedAt && daysBetween(s.changedAt, todayISO()) <= CHANGE_WARN_DAYS;

/** Small line for This week's To pay rows. */
function bankLine(name) {
  const s = bankFor(name);
  if (!s) return '<span class="bank-missing">no bank details</span>';
  return `<span class="bank-inline">${esc(fmtSortCode(s.sortCode))} · ${esc(s.accountNo)}</span>` +
    (recentlyChanged(s) ? ' <span class="pill out" title="Bank details changed on ' + fmtDate(s.changedAt) + ' — confirm with the supplier before paying">changed</span>' : '');
}

function renderBank() {
  const list = [...(state.suppliers || [])].sort((a, b) => a.name.localeCompare(b.name));
  const q = document.getElementById('bank-filter').value.trim().toLowerCase();
  const shown = list.filter(s => !q || `${s.name} ${s.sortCode} ${s.accountNo}`.toLowerCase().includes(q));
  const t = document.getElementById('bank-table');
  t.innerHTML = shown.length
    ? '<thead><tr><th>Supplier</th><th>Account type</th><th>Sort code</th><th>Account no</th><th>Last changed</th><th></th></tr></thead><tbody>' +
      shown.map(s => `<tr${recentlyChanged(s) ? ' class="bank-changed"' : ''}><td><b>${esc(s.name)}</b>${s.accountName && s.accountName !== s.name ? `<div class="small muted">Account name: ${esc(s.accountName)}</div>` : ''}</td><td>${esc(s.accountType || 'Business')}</td>` +
        `<td class="mono">${esc(fmtSortCode(s.sortCode))} <button class="copy" data-copy="${esc(digits(s.sortCode))}" title="Copy sort code">⧉</button></td>` +
        `<td class="mono">${esc(s.accountNo)} <button class="copy" data-copy="${esc(s.accountNo)}" title="Copy account number">⧉</button></td>` +
        `<td class="small">${recentlyChanged(s) ? `<span class="pill out" title="Confirm the new details with the supplier by phone before paying">changed ${fmtDate(s.changedAt)} — check with supplier</span>` : esc(fmtDate(s.changedAt || s.addedAt))}</td>` +
        `<td class="num nowrap">${isReadOnly() ? '' : `<button class="link" data-act="edit" data-id="${s.id}">Edit</button><button class="link danger" data-act="del" data-id="${s.id}">Delete</button>`}</td></tr>`).join('') +
      '</tbody>'
    : `<tbody><tr><td class="muted">${list.length ? 'Nothing matches.' : 'No bank details yet — add a supplier on the left.'}</td></tr></tbody>`;
  document.getElementById('bank-count').textContent = list.length ? `· ${list.length}` : '';

  // Suppliers with open bills but no details yet, most money first
  const owed = new Map();
  for (const it of state.items) {
    if (it.type !== 'out' || it.excluded || it.financed || it.directDebit || bankFor(it.contact)) continue;
    owed.set(it.contact, (owed.get(it.contact) || 0) + (Number(it.amount) || 0));
  }
  const missing = [...owed.entries()].sort((a, b) => b[1] - a[1]);
  document.getElementById('bank-missing').innerHTML = missing.length
    ? `<p class="small muted">Suppliers with open bills and no bank details — click one to add it:</p><div class="chips">` +
      missing.map(([n, amt]) => `<button class="chip" type="button" data-name="${esc(n)}" title="${money(amt, true)} open">${esc(n)}</button>`).join('') + '</div>'
    : '';
  document.getElementById('bank-suppliers').innerHTML = [...new Set(state.items.filter(i => i.type === 'out').map(i => i.contact))].sort()
    .map(c => `<option value="${esc(c)}">`).join('');
  document.getElementById('bank-form').querySelectorAll('input, select, button').forEach(el => { el.disabled = isReadOnly(); });
}

function resetBankForm() {
  const f = document.getElementById('bank-form');
  f.reset();
  f.id.value = '';
  document.getElementById('bank-form-title').textContent = 'Add bank details';
  document.getElementById('bank-submit').textContent = 'Save';
  document.getElementById('bank-cancel').hidden = true;
}

function wireBank() {
  const f = document.getElementById('bank-form');
  f.addEventListener('submit', ev => {
    ev.preventDefault();
    const name = f.name.value.trim(), accountType = f.accountType.value, accountName = f.accountName.value.trim();
    const sortCode = digits(f.sortCode.value), accountNo = digits(f.accountNo.value);
    if (!name) return;
    if (sortCode.length !== 6) { toast('A sort code has 6 digits, e.g. 12-34-56'); f.sortCode.focus(); return; }
    if (accountNo.length !== 8) { toast('A UK account number has 8 digits'); f.accountNo.focus(); return; }
    const existing = state.suppliers.find(s => s.id === f.id.value) || bankFor(name);
    if (existing && !f.id.value && !confirm(`${existing.name} already has bank details. Replace them?`)) return;
    const changed = existing && (existing.sortCode !== sortCode || existing.accountNo !== accountNo);
    mutate(() => {
      if (existing) {
        Object.assign(existing, { name, accountName, accountType, sortCode, accountNo });
        if (changed) existing.changedAt = todayISO();
      } else {
        state.suppliers.push({ id: uid(), name, accountName, accountType, sortCode, accountNo, addedAt: todayISO() });
      }
    }, existing ? (changed ? `Bank details for ${name} changed — check them with the supplier` : `Saved ${name}`) : `Added bank details for ${name}`);
    resetBankForm();
  });
  f.sortCode.addEventListener('blur', () => { if (digits(f.sortCode.value).length === 6) f.sortCode.value = fmtSortCode(f.sortCode.value); });
  document.getElementById('bank-cancel').addEventListener('click', resetBankForm);
  document.getElementById('bank-filter').addEventListener('input', renderBank);
  document.getElementById('tab-bank').addEventListener('click', ev => {
    const copy = ev.target.closest('button.copy');
    if (copy) {
      const done = () => toast(`Copied ${copy.dataset.copy}`);
      if (navigator.clipboard) navigator.clipboard.writeText(copy.dataset.copy).then(done, () => toast('Could not copy — select the number instead'));
      return;
    }
    const chip = ev.target.closest('button.chip');
    if (chip) { resetBankForm(); f.name.value = chip.dataset.name; f.sortCode.focus(); return; }
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    const s = state.suppliers.find(x => x.id === b.dataset.id);
    if (!s) return;
    if (b.dataset.act === 'edit') {
      f.id.value = s.id; f.name.value = s.name; f.accountName.value = s.accountName || ''; f.accountType.value = s.accountType || 'Business';
      f.sortCode.value = fmtSortCode(s.sortCode); f.accountNo.value = s.accountNo;
      document.getElementById('bank-form-title').textContent = `Edit ${s.name}`;
      document.getElementById('bank-submit').textContent = 'Save changes';
      document.getElementById('bank-cancel').hidden = false;
      f.sortCode.focus();
    }
    if (b.dataset.act === 'del' && confirm(`Delete the bank details for ${s.name}?`)) {
      mutate(() => { state.suppliers = state.suppliers.filter(x => x.id !== s.id); }, `Deleted bank details for ${s.name}`);
    }
  });
}

// ════════════════════════════════════════════════════════════
//  Recurring tab
// ════════════════════════════════════════════════════════════

function monthlyEquivalent(r) {
  const a = Number(r.amount) || 0;
  return { weekly: a * 52 / 12, fortnightly: a * 26 / 12, monthly: a, quarterly: a / 3, annually: a / 12 }[r.frequency] ?? a;
}

function renderRecurring() {
  const t = document.getElementById('rec-table');
  const today = todayISO();
  const rows = [...state.recurring].sort((a, b) => (a.direction || 'out').localeCompare(b.direction || 'out') || a.name.localeCompare(b.name));
  if (!rows.length) {
    t.innerHTML = '<tbody><tr><td class="muted">No recurring payments yet. Add rent, payroll, loan repayments, subscriptions and other direct debits on the left.</td></tr></tbody>';
  } else {
    let h = '<thead><tr><th>Name</th><th>Category</th><th>Schedule</th><th class="num">Amount</th><th>Next</th><th>Period</th><th></th></tr></thead><tbody>';
    let mOut = 0, mIn = 0;
    for (const r of rows) {
      const next = occurrences(r, today, addDays(today, 800)).find(d => !(state.recurOverrides[r.id + '|' + d] || {}).skip);
      const skipped = Object.keys(state.recurOverrides).filter(k => k.startsWith(r.id + '|') && state.recurOverrides[k].skip);
      if (r.active !== false) { if ((r.direction || 'out') === 'out') mOut += monthlyEquivalent(r); else mIn += monthlyEquivalent(r); }
      h += `<tr class="${r.active === false ? 'paused' : ''}">` +
        `<td><b>${esc(r.name)}</b> <span class="pill ${r.direction === 'in' ? 'in' : 'out'}">${r.direction === 'in' ? 'in' : 'out'}</span>${r.directDebit ? ' <span class="pill neutral">direct debit</span>' : ''}${r.active === false ? ' <span class="pill neutral">paused</span>' : ''}</td>` +
        `<td>${esc(r.category || '')}</td>` +
        `<td>${freqLabel(r)}</td>` +
        `<td class="num">${money(Number(r.amount) || 0, true)}</td>` +
        `<td>${r.active === false ? '—' : next ? fmtDateY(next) : 'Ended'}</td>` +
        `<td class="small muted">${r.startDate ? 'from ' + fmtDateY(r.startDate) : ''}${r.endDate ? '<br>to ' + fmtDateY(r.endDate) : ''}</td>` +
        `<td class="num" style="white-space:nowrap">` +
        (skipped.length ? `<button class="link" data-act="unskip" data-id="${r.id}" title="${skipped.map(k => fmtDate(k.split('|')[1])).join(', ')}">Restore ${skipped.length} skipped</button>` : '') +
        `<button class="link" data-act="edit" data-id="${r.id}">Edit</button>` +
        `<button class="link" data-act="toggle" data-id="${r.id}">${r.active === false ? 'Resume' : 'Pause'}</button>` +
        `<button class="link danger" data-act="del" data-id="${r.id}">Delete</button></td></tr>`;
    }
    h += `</tbody><tfoot><tr><td colspan="3">Monthly equivalent (active)</td><td class="num">${money(mOut - mIn, true)}</td><td colspan="3" class="small muted">${money(mOut, true)} out${mIn ? ` · ${money(mIn, true)} in` : ''}</td></tr></tfoot>`;
    t.innerHTML = h;
  }
  const cats = [...new Set(state.recurring.map(r => r.category).filter(Boolean))];
  document.getElementById('cat-list').innerHTML = cats.map(c => `<option value="${esc(c)}">`).join('');
}

function syncFreqFields(form) {
  const f = form.frequency.value;
  const weekly = f === 'weekly' || f === 'fortnightly';
  form.querySelector('[data-for="dom"]').hidden = weekly;
  form.querySelector('[data-for="dow"]').hidden = !weekly;
}

function resetRecForm() {
  const form = document.getElementById('rec-form');
  form.reset();
  form.id.value = '';
  form.startDate.value = todayISO();
  document.getElementById('rec-form-title').textContent = 'Add a recurring payment';
  document.getElementById('rec-submit').textContent = 'Add payment';
  document.getElementById('rec-cancel').hidden = true;
  syncFreqFields(form);
}

function wireRecurring() {
  const form = document.getElementById('rec-form');
  form.frequency.addEventListener('change', () => syncFreqFields(form));
  form.addEventListener('submit', ev => {
    ev.preventDefault();
    const r = {
      id: form.id.value || uid(),
      name: form.name.value.trim(),
      direction: form.direction.value,
      amount: round2(Number(form.amount.value) || 0),
      frequency: form.frequency.value,
      dayOfMonth: Math.max(1, Math.min(31, Number(form.dayOfMonth.value) || 1)),
      dayOfWeek: Number(form.dayOfWeek.value) || 0,
      startDate: form.startDate.value || todayISO(),
      endDate: form.endDate.value || '',
      category: form.category.value.trim(),
      directDebit: form.directDebit.checked,
    };
    if (!r.name) return;
    const existing = state.recurring.find(x => x.id === r.id);
    mutate(() => {
      if (existing) Object.assign(existing, r);
      else state.recurring.push({ ...r, active: true });
    }, existing ? `Updated ${r.name}` : `Added ${r.name}`);
    resetRecForm();
  });
  document.getElementById('rec-cancel').addEventListener('click', resetRecForm);
  document.getElementById('rec-table').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    const r = state.recurring.find(x => x.id === b.dataset.id);
    if (!r) return;
    if (b.dataset.act === 'edit') {
      form.id.value = r.id; form.name.value = r.name; form.direction.value = r.direction || 'out';
      form.amount.value = r.amount; form.frequency.value = r.frequency; form.dayOfMonth.value = r.dayOfMonth || 1;
      form.dayOfWeek.value = r.dayOfWeek || 0; form.startDate.value = r.startDate || ''; form.endDate.value = r.endDate || '';
      form.category.value = r.category || '';
      form.directDebit.checked = !!r.directDebit;
      document.getElementById('rec-form-title').textContent = `Edit ${r.name}`;
      document.getElementById('rec-submit').textContent = 'Save changes';
      document.getElementById('rec-cancel').hidden = false;
      syncFreqFields(form);
      form.name.focus();
    } else if (b.dataset.act === 'toggle') {
      mutate(() => { r.active = r.active === false; }, `${r.name} ${r.active === false ? 'resumed' : 'paused'}`);
    } else if (b.dataset.act === 'del') {
      if (!confirm(`Delete ${r.name}?`)) return;
      mutate(() => {
        state.recurring = state.recurring.filter(x => x.id !== r.id);
        for (const k of Object.keys(state.recurOverrides)) if (k.startsWith(r.id + '|')) delete state.recurOverrides[k];
      }, `Deleted ${r.name}`);
    } else if (b.dataset.act === 'unskip') {
      mutate(() => {
        for (const k of Object.keys(state.recurOverrides)) if (k.startsWith(r.id + '|')) { delete state.recurOverrides[k].skip; if (!Object.keys(state.recurOverrides[k]).length) delete state.recurOverrides[k]; }
      }, `Restored skipped ${r.name} payments`);
    }
  });
  resetRecForm();
}

// ════════════════════════════════════════════════════════════
//  Data tab: settings, Xero import, items list, backup
// ════════════════════════════════════════════════════════════

function renderData() {
  const s = state.settings;
  const f = document.getElementById('settings-form');
  f.openingBalance.value = s.openingBalance;
  f.balanceDate.value = s.balanceDate || '';
  f.startDate.value = s.startDate || '';
  f.weeks.value = s.weeks;
  f.currency.value = s.currency;
  f.minAmount.value = Number(s.minAmount) || 0;
  const li = state.lastImport || {};
  document.getElementById('last-import').textContent =
    `Last import — receivables: ${li.in ? fmtDateY(li.in) : 'never'} · payables: ${li.out ? fmtDateY(li.out) : 'never'}`;
  renderItems();
  renderRules();
  document.getElementById('contact-list').innerHTML = [...new Set(state.items.map(i => i.contact))].sort().map(c => `<option value="${esc(c)}">`).join('');
}

function renderRules() {
  const t = document.getElementById('rules-table');
  const rules = state.rules || [];
  t.innerHTML = rules.length
    ? '<thead><tr><th></th><th>Customer / supplier</th><th>Expected</th><th class="num">Invoices</th><th></th></tr></thead><tbody>' +
      rules.map(r => {
        const n = state.items.filter(i => !i.excluded && ruleFor(i) === r).length;
        return `<tr><td><span class="pill ${r.type}">${r.type}</span></td><td>${esc(r.contact)}</td><td>Due date ${ruleLabel(r)}</td>` +
          `<td class="num">${n}${n ? '' : ' <span class="muted small">(no match)</span>'}</td>` +
          `<td class="num"><button class="link danger" type="button" data-act="del-rule" data-id="${r.id}">Remove</button></td></tr>`;
      }).join('') + '</tbody>'
    : '<tbody><tr><td class="muted">No rules yet.</td></tr></tbody>';
  const names = [...new Set(state.items.map(i => i.contact))].sort();
  document.getElementById('rule-contacts').innerHTML = names.map(c => `<option value="${esc(c)}">`).join('');
}

function renderItems() {
  const q = document.getElementById('items-filter').value.trim().toLowerCase();
  const tf = document.getElementById('items-type').value;
  let items = state.items.filter(i =>
    (tf === '' || (tf === 'excluded' ? i.excluded : i.type === tf)) &&
    (!q || `${i.contact} ${i.invoiceNumber}`.toLowerCase().includes(q)));
  items = items.sort((a, b) => a.type.localeCompare(b.type) || (a.expectedDate || a.dueDate || '').localeCompare(b.expectedDate || b.dueDate || ''));
  document.getElementById('items-count').textContent = `· ${state.items.length}`;
  const t = document.getElementById('items-table');
  if (!items.length) { t.innerHTML = `<tbody><tr><td class="muted">${state.items.length ? 'Nothing matches.' : 'No invoices or bills yet — import a Xero CSV above.'}</td></tr></tbody>`; return; }
  let h = '<thead><tr><th></th><th>Contact</th><th>Invoice</th><th>Due</th><th>Expected</th><th class="num">Amount</th><th>Source</th><th></th></tr></thead><tbody>';
  for (const i of items.slice(0, 1000)) {
    h += `<tr class="${i.excluded ? 'excluded' : ''}"><td><span class="pill ${i.type}">${i.type === 'in' ? 'in' : 'out'}</span></td>` +
      `<td>${esc(i.contact)}</td><td>${esc(i.invoiceNumber)}</td><td>${fmtDateY(i.dueDate)}</td>` +
      `<td>${i.expectedDate ? fmtDateY(i.expectedDate) : plannedDate(i) !== i.dueDate ? `${fmtDateY(plannedDate(i))} <span class="muted small">(rule)</span>` : ''}</td><td class="num">${money(i.amount, true)}</td>` +
      `<td><span class="pill neutral">${i.source === 'xero' ? 'Xero' : 'Manual'}</span>${!i.excluded && belowMinimum(i) ? ' <span class="pill neutral" title="Below the minimum amount in Forecast settings">ignored: small</span>' : ''}${i.financed ? ` <span class="pill neutral" title="Paid with ${esc(i.financed.by)} on ${fmtDate(i.financed.date)} — out of the cash figures">${esc(i.financed.by)}</span>` : ''}</td><td class="num" style="white-space:nowrap">` +
      (i.expectedDate ? `<button class="link" data-act="reset" data-id="${i.id}">Reset date</button>` : '') +
 (i.financed ? `<button class="link" data-act="unfinance" data-id="${i.id}" title="Not paid with ${esc(i.financed.by)} after all">Undo ${esc(i.financed.by)}</button>` : '') +
      (i.excluded ? `<button class="link" data-act="include" data-id="${i.id}">Include</button>` : `<button class="link" data-act="exclude" data-id="${i.id}">Exclude</button>`) +
      (i.source === 'manual' ? `<button class="link danger" data-act="delete" data-id="${i.id}">Delete</button>` : '') +
      '</td></tr>';
  }
  h += '</tbody>';
  if (items.length > 1000) h += `<tfoot><tr><td colspan="8" class="muted">Showing the first 1,000 of ${items.length} — use the filter.</td></tr></tfoot>`;
  t.innerHTML = h;
}

// ── CSV parsing ─────────────────────────────────────────────
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseDate(s, fmt) {
  s = (s || '').trim();
  if (!s) return null;
  const mk = (y, m, d) => (m >= 0 && m < 12 && d >= 1 && d <= 31 ? toISO(new Date(Date.UTC(y < 100 ? 2000 + y : y, m, d))) : null);
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return mk(+m[1], +m[2] - 1, +m[3]);
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/))) return fmt === 'mdy' ? mk(+m[3], +m[1] - 1, +m[2]) : mk(+m[3], +m[2] - 1, +m[1]);
  if ((m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3})[A-Za-z]*[\s,-]+(\d{2,4})/))) return mk(+m[3], MONTHS[m[2].toLowerCase()] ?? -1, +m[1]);
  if ((m = s.match(/^([A-Za-z]{3})[A-Za-z]*\s+(\d{1,2}),?\s+(\d{4})/))) return mk(+m[3], MONTHS[m[1].toLowerCase()] ?? -1, +m[2]);
  return null;
}
function parseAmount(s) {
  s = String(s ?? '').trim();
  if (!s) return NaN;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s) || /-$/.test(s);
  const n = parseFloat(s.replace(/[^0-9.]/g, ''));
  return isNaN(n) ? NaN : neg ? -n : n;
}

const normH = h => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
const FIELDS = {
  contact: { label: 'Contact', required: true, names: ['contactname', 'contact', 'customer', 'customername', 'supplier', 'suppliername', 'name', 'to', 'from'] },
  number: { label: 'Invoice number', names: ['invoicenumber', 'invoiceno', 'billnumber', 'number', 'invoice', 'invoicereference', 'documentnumber', 'reference', 'ref'] },
  due: { label: 'Due date', required: true, names: ['duedate', 'due', 'paymentduedate', 'datedue'] },
  date: { label: 'Invoice date', names: ['invoicedate', 'date', 'issuedate', 'billdate'] },
  amount: { label: 'Amount due', required: true, names: ['invoiceamountdue', 'amountdue', 'balancedue', 'outstanding', 'balance', 'due', 'total', 'invoicetotal', 'amount', 'gross'] },
  status: { label: 'Status', names: ['status', 'invoicestatus'] },
  type: { label: 'Type', names: ['type', 'invoicetype'] },
};

function detectHeader(rows) {
  const all = Object.values(FIELDS).flatMap(f => f.names);
  let best = 0, bestScore = -1;
  rows.slice(0, 20).forEach((r, i) => {
    const score = r.filter(c => all.includes(normH(c))).length;
    if (score > bestScore) { best = i; bestScore = score; }
  });
  return best;
}

function guessMapping(header) {
  const n = header.map(normH);
  const used = new Set();
  const map = {};
  // Amount and due both like the bare "Due" column; resolve the more specific names first.
  for (const key of ['contact', 'number', 'date', 'status', 'type', 'due', 'amount']) {
    const idx = FIELDS[key].names.map(nm => n.findIndex((h, i) => h === nm && !used.has(i))).find(i => i >= 0);
    if (idx !== undefined && idx >= 0) { map[key] = idx; used.add(idx); }
    else map[key] = -1;
  }
  return map;
}

/**
 * Xero's Aged Receivables / Payables Detail lists invoices under a row holding only the
 * contact name, followed by a "Total <contact>" row. Turn that into one row per invoice
 * with a Contact column. Returns null for ordinary flat exports.
 */
function flattenGrouped(rows, hi) {
  const header = rows[hi];
  if (header.map(normH).some(h => FIELDS.contact.names.includes(h))) return null;
  const data = [];
  let contact = '';
  for (const r of rows.slice(hi + 1)) {
    const first = String(r[0] ?? '').trim();
    const filled = r.filter(c => String(c ?? '').trim() !== '').length;
    if (filled === 1 && first) { contact = first; continue; }
    if (!contact || /^(total|percentage of total)/i.test(first)) continue;
    data.push([contact, ...r]);
  }
  return data.length ? { header: ['Contact', ...header], data } : null;
}

/** Excel files are read with SheetJS, loaded only when needed. Dates come back as YYYY-MM-DD. */
let xlsxLoader = null;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  xlsxLoader = xlsxLoader || new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => { xlsxLoader = null; reject(new Error('Could not load the Excel reader — check the connection, or export as CSV.')); };
    document.head.appendChild(s);
  });
  return xlsxLoader;
}
async function readSpreadsheet(file) {
  const XLSX = await loadXLSX();
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, dateNF: 'yyyy-mm-dd', defval: '' })
    .map(r => r.map(c => String(c)))
    .filter(r => r.some(c => c.trim() !== ''));
}

let pendingImport = null; // {header, data, map}

function typeFromValue(v) {
  const s = normH(v);
  if (!s) return null;
  if (s.includes('accpay') || s.includes('bill') || s.includes('payable') || s.includes('purchase')) return { type: 'out', credit: s.includes('credit') };
  if (s.includes('accrec') || s.includes('sale') || s.includes('receivable') || s.includes('invoice')) return { type: 'in', credit: s.includes('credit') };
  return null;
}

/** Turn the raw rows into deduplicated invoices using the current mapping. */
function interpretImport() {
  const { data, map } = pendingImport;
  const typeSel = document.getElementById('imp-type').value;
  const dfmt = document.getElementById('imp-datefmt').value;
  const includeDrafts = document.getElementById('imp-drafts')?.checked;
  const get = (row, k) => (map[k] >= 0 ? (row[map[k]] ?? '').trim() : '');
  const seen = new Map();
  const skipped = { status: 0, zero: 0, invalid: 0, noType: 0 };
  data.forEach((row, idx) => {
    const contact = get(row, 'contact');
    if (!contact || /^total/i.test(contact)) { skipped.invalid++; return; }
    const status = normH(get(row, 'status'));
    if (/paid|void|deleted/.test(status) || (status === 'draft' && !includeDrafts)) { skipped.status++; return; }
    let type = typeSel, credit = false;
    if (typeSel === 'auto') { const t = typeFromValue(get(row, 'type')); if (!t) { skipped.noType++; return; } type = t.type; credit = t.credit; }
    else if (map.type >= 0) credit = normH(get(row, 'type')).includes('credit');
    let amount = parseAmount(get(row, 'amount'));
    if (isNaN(amount)) { skipped.invalid++; return; }
    if (credit && amount > 0) amount = -amount;
    const number = get(row, 'number');
    const key = `${type}|${contact.toLowerCase()}|${number || '#' + idx}`;
    if (seen.has(key)) return; // Xero repeats the invoice on every line item
    if (Math.abs(amount) < 0.005) { skipped.zero++; seen.set(key, null); return; }
    const due = parseDate(get(row, 'due'), dfmt) || parseDate(get(row, 'date'), dfmt);
    if (!due) { skipped.invalid++; return; }
    seen.set(key, { type, contact, invoiceNumber: number, amount: round2(amount), dueDate: due });
  });
  return { items: [...seen.values()].filter(Boolean), skipped };
}

function renderImportPreview() {
  const box = document.getElementById('imp-preview');
  if (!pendingImport) { box.innerHTML = ''; return; }
  const { header, map } = pendingImport;
  const opts = sel => `<option value="-1">—</option>` + header.map((h, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(h || `Column ${i + 1}`)}</option>`).join('');
  const { items, skipped } = interpretImport();
  const tin = items.filter(i => i.type === 'in'), tout = items.filter(i => i.type === 'out');
  const missing = Object.entries(FIELDS).filter(([k, f]) => f.required && map[k] < 0).map(([, f]) => f.label);
  const sk = [skipped.status && `${skipped.status} paid/void/draft`, skipped.zero && `${skipped.zero} fully paid`, skipped.invalid && `${skipped.invalid} unreadable/total rows`, skipped.noType && `${skipped.noType} with unknown type`].filter(Boolean);
  let h = `<div class="preview"><div class="map">` +
    Object.entries(FIELDS).map(([k, f]) => `<label>${f.label}${f.required ? ' *' : ''}<select data-map="${k}">${opts(map[k])}</select></label>`).join('') +
    `</div>` +
    `<label style="flex-direction:row;align-items:center;gap:6px;margin:10px 0 0"><input type="checkbox" id="imp-drafts" ${document.getElementById('imp-drafts')?.checked ? 'checked' : ''}> Include draft invoices / bills</label>`;
  if (items.length) {
    h += `<table class="list"><thead><tr><th></th><th>Contact</th><th>Invoice</th><th>Due</th><th class="num">Amount</th></tr></thead><tbody>` +
      items.slice(0, 5).map(i => `<tr><td><span class="pill ${i.type}">${i.type}</span></td><td>${esc(i.contact)}</td><td>${esc(i.invoiceNumber)}</td><td>${fmtDateY(i.dueDate)}</td><td class="num">${money(i.amount, true)}</td></tr>`).join('') +
      `</tbody></table>`;
  }
  h += `<p class="small"><b>${tin.length ? `${tin.length} receivables (${money(tin.reduce((a, i) => a + i.amount, 0), true)})` : ''}${tin.length && tout.length ? ' · ' : ''}${tout.length ? `${tout.length} payables (${money(tout.reduce((a, i) => a + i.amount, 0), true)})` : ''}${!items.length ? 'Nothing to import yet' : ''}</b>` +
    `${sk.length ? ` · skipped ${sk.join(', ')}` : ''}</p>` +
    (missing.length ? `<p class="small neg">Choose a column for: ${missing.join(', ')}</p>` : '') +
    `<div class="actions"><button class="btn primary" id="imp-go" ${missing.length || !items.length ? 'disabled' : ''}>Import</button><button class="btn" id="imp-cancel">Cancel</button></div></div>`;
  box.innerHTML = h;
}

function doImport() {
  const { items } = interpretImport();
  const types = [...new Set(items.map(i => i.type))];
  const k = i => `${i.type}|${i.contact.toLowerCase()}|${(i.invoiceNumber || '').toLowerCase()}`;
  const prior = new Map(state.items.filter(i => i.source === 'xero').map(i => [k(i), i]));
  let kept = 0;
  const fresh = items.map(i => {
    const p = i.invoiceNumber ? prior.get(k(i)) : null;
    const it = { id: p ? p.id : uid(), source: 'xero', ...i };
    if (p && p.expectedDate && p.expectedDate !== i.dueDate) { it.expectedDate = p.expectedDate; kept++; }
    if (p && p.excluded) it.excluded = true;
    if (p && p.important) it.important = true;
    if (p && p.parked) it.parked = true;
    if (p && p.financed) it.financed = p.financed; // paid with the credit facility
    return it;
  });
  const removed = state.items.filter(i => i.source === 'xero' && types.includes(i.type) && !fresh.some(f => f.id === i.id)).length;
  mutate(() => {
    state.items = state.items.filter(i => !(i.source === 'xero' && types.includes(i.type))).concat(fresh);
    types.forEach(t => { state.lastImport[t] = todayISO(); });
  }, `Imported ${fresh.length} item${fresh.length === 1 ? '' : 's'}${kept ? ` · kept ${kept} moved date${kept === 1 ? '' : 's'}` : ''}${removed ? ` · ${removed} no longer outstanding removed` : ''}`);
  pendingImport = null;
  document.getElementById('imp-file').value = '';
  renderImportPreview();
}

function wireData() {
  document.getElementById('rule-form').addEventListener('submit', ev => {
    ev.preventDefault();
    const f = ev.target;
    const rule = { id: uid(), type: f.type.value, contact: f.contact.value.trim(), months: Math.trunc(Number(f.months.value) || 0), days: Math.trunc(Number(f.days.value) || 0) };
    if (!rule.contact) return;
    if (!rule.months && !rule.days) { toast('Enter a number of months or days to shift by.'); return; }
    mutate(() => {
      state.rules = (state.rules || []).filter(r => !(r.type === rule.type && r.contact.toLowerCase() === rule.contact.toLowerCase()));
      state.rules.push(rule);
    }, `Rule added: ${rule.contact} ${ruleLabel(rule)}`);
    f.reset();
  });
  document.getElementById('rules-table').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-act="del-rule"]');
    if (!b) return;
    const r = state.rules.find(x => x.id === b.dataset.id);
    if (r) mutate(() => { state.rules = state.rules.filter(x => x.id !== r.id); }, `Rule removed: ${r.contact}`);
  });

  document.getElementById('settings-form').addEventListener('submit', ev => {
    ev.preventDefault();
    const f = ev.target;
    mutate(() => {
      Object.assign(state.settings, {
        openingBalance: round2(Number(f.openingBalance.value) || 0),
        balanceDate: f.balanceDate.value || todayISO(),
        startDate: mondayOf(f.startDate.value || todayISO()),
        weeks: Math.max(4, Math.min(52, Number(f.weeks.value) || 13)),
        currency: f.currency.value,
        minAmount: Math.max(0, Number(f.minAmount.value) || 0),
      });
      setCurrency(state.settings.currency);
    }, 'Settings saved');
  });

  document.getElementById('imp-file').addEventListener('change', async ev => {
    const file = ev.target.files[0];
    if (!file) return;
    let rows;
    try { rows = /\.xlsx?$/i.test(file.name) ? await readSpreadsheet(file) : parseCSV(await file.text()); }
    catch (e) { toast(e.message); ev.target.value = ''; return; }
    if (rows.length < 2) { toast('That file has no rows to import.'); return; }
    const hi = detectHeader(rows);
    const grouped = flattenGrouped(rows, hi);
    const header = grouped ? grouped.header : rows[hi];
    pendingImport = { header, data: grouped ? grouped.data : rows.slice(hi + 1), map: guessMapping(header) };
    // Pick the direction from the file when it says so (Type column, else the report title or file name).
    const title = `${file.name} ${rows.slice(0, hi).flat().join(' ')}`;
    if (pendingImport.map.type >= 0) {
      const types = new Set(pendingImport.data.map(r => typeFromValue(r[pendingImport.map.type])?.type).filter(Boolean));
      if (types.size > 1) document.getElementById('imp-type').value = 'auto';
      else if (types.size === 1) document.getElementById('imp-type').value = [...types][0];
    } else if (/payable|bill|supplier|purchase/i.test(title)) document.getElementById('imp-type').value = 'out';
    else if (/receivable|invoice|sales|customer/i.test(title)) document.getElementById('imp-type').value = 'in';
    renderImportPreview();
  });
  ['imp-type', 'imp-datefmt'].forEach(id => document.getElementById(id).addEventListener('change', renderImportPreview));
  document.getElementById('imp-preview').addEventListener('change', ev => {
    const sel = ev.target.closest('select[data-map]');
    if (sel) pendingImport.map[sel.dataset.map] = Number(sel.value);
    renderImportPreview();
  });
  document.getElementById('imp-preview').addEventListener('click', ev => {
    if (ev.target.id === 'imp-go') doImport();
    if (ev.target.id === 'imp-cancel') { pendingImport = null; document.getElementById('imp-file').value = ''; renderImportPreview(); }
  });

  document.getElementById('items-filter').addEventListener('input', renderItems);
  document.getElementById('items-type').addEventListener('change', renderItems);
  document.getElementById('items-table').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    const it = state.items.find(x => x.id === b.dataset.id);
    if (!it) return;
    const label = it.invoiceNumber || it.contact;
    if (b.dataset.act === 'reset') mutate(() => { delete it.expectedDate; }, `${label} back to its due date`);
    if (b.dataset.act === 'exclude') mutate(() => { it.excluded = true; }, `Excluded ${label}`);
    if (b.dataset.act === 'unfinance') mutate(() => { delete it.financed; }, `${label} back in the cash figures`);
    if (b.dataset.act === 'include') mutate(() => { delete it.excluded; }, `Included ${label}`);
    if (b.dataset.act === 'delete') mutate(() => { state.items = state.items.filter(x => x.id !== it.id); }, `Deleted ${label}`);
  });

  document.getElementById('btn-backup').addEventListener('click', () =>
    download(`${CFG.storageKey}-backup-${todayISO()}.json`, JSON.stringify(state, null, 2), 'application/json'));
  document.getElementById('restore-file').addEventListener('change', async ev => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const s = JSON.parse(await file.text());
      if (!s || !Array.isArray(s.items) || !Array.isArray(s.recurring)) throw new Error('bad');
      mutate(() => { state = normalise(s); setCurrency(state.settings.currency); }, 'Backup restored');
    } catch (e) { toast('That file is not a cash flow backup.'); }
    ev.target.value = '';
  });
  document.getElementById('btn-sample').addEventListener('click', () => {
    if ((state.items.length || state.recurring.length) && !confirm('Replace the current data with sample data?')) return;
    mutate(() => { state = sampleState(); setCurrency(state.settings.currency); }, 'Sample data loaded');
  });
  document.getElementById('btn-clear').addEventListener('click', () => {
    if (!confirm('Delete all invoices, bills, recurring payments and settings from this browser?')) return;
    mutate(() => { state = defaultState(); setCurrency(state.settings.currency); }, 'Cleared');
  });
}

function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

// ── One-off items ───────────────────────────────────────────
function wireItemDialog() {
  const dlg = document.getElementById('item-dialog');
  const form = document.getElementById('item-form');
  document.getElementById('btn-add-item').addEventListener('click', () => {
    form.reset();
    form.dueDate.value = todayISO();
    dlg.showModal();
  });
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') return;
    const it = {
      id: uid(), source: 'manual', type: form.type.value, contact: form.contact.value.trim(),
      invoiceNumber: form.invoiceNumber.value.trim(), amount: round2(Number(form.amount.value) || 0), dueDate: form.dueDate.value,
    };
    if (!it.contact || !it.dueDate) return;
    mutate(() => state.items.push(it), `Added ${it.contact}`);
  });
}

// ── Sample data (demo only) ─────────────────────────────────
function sampleState() {
  const s = defaultState();
  const w0 = s.settings.startDate;
  const d = n => addDays(w0, n);
  s.settings.openingBalance = 42500;
  let inv = 1040, bill = 300;
  const add = (type, contact, amount, day) => s.items.push({
    id: uid(), source: 'xero', type, contact, amount,
    invoiceNumber: type === 'in' ? `INV-${inv++}` : `BILL-${bill++}`, dueDate: d(day),
  });
  [['Sample Retailer A', [[4200, -9], [3150, 3], [2875, 17], [5100, 31]]],
   ['Sample Retailer B', [[1890, 1], [2240, 15], [1980, 29]]],
   ['Sample Farm Shop', [[640, -3], [420, 10], [515, 24]]],
   ['Sample Deli Group', [[1275, 6], [1310, 20], [990, 41]]],
   ['Sample Online Marketplace', [[3620, 2], [3410, 16], [3880, 30], [4050, 44]]],
  ].forEach(([c, xs]) => xs.forEach(([a, day]) => add('in', c, a, day)));
  [['Sample Packaging Ltd', [[6800, 4], [2150, 25]]],
   ['Sample Materials Ltd', [[9400, 11]]],
   ['Sample Wholesaler', [[3200, -5], [4100, 18], [3900, 46]]],
   ['Sample Logistics', [[740, 2], [810, 16], [795, 30], [820, 44]]],
   ['Sample Design Studio', [[1500, 22]]],
  ].forEach(([c, xs]) => xs.forEach(([a, day]) => add('out', c, a, day)));
  const r = (name, amount, frequency, extra, category) => s.recurring.push({
    id: uid(), name, amount, frequency, direction: 'out', dayOfMonth: 1, dayOfWeek: 0, startDate: w0, endDate: '', category, active: true, ...extra,
  });
  r('Payroll', 14200, 'monthly', { dayOfMonth: 28 }, 'Payroll');
  r('Warehouse rent', 2400, 'monthly', { dayOfMonth: 1 }, 'Rent');
  r('Bank loan repayment', 1150, 'monthly', { dayOfMonth: 15 }, 'Loan');
  r('Software subscriptions', 380, 'monthly', { dayOfMonth: 5 }, 'Software');
  r('Pension contributions', 960, 'monthly', { dayOfMonth: 19 }, 'Payroll');
  r('VAT payment', 7800, 'quarterly', { dayOfMonth: 7, startDate: d(30) }, 'Tax');
  return s;
}

// ════════════════════════════════════════════════════════════
//  Shared storage: a JSON file in the GitHub repo
//  Every change is committed (batched a moment after the last
//  edit), so everyone with access sees the same forecast and
//  the commit history shows who changed what.
//  Password access: the owner's GitHub token is saved in
//  docs/access.js, encrypted with a password (AES-GCM, key from
//  PBKDF2). Anyone with the link and the password can open the
//  app; the data file itself stays plain JSON in the repo.
// ════════════════════════════════════════════════════════════

const GH_KEY = `${CFG.storageKey}-github`;
const PW_KEY = `${CFG.storageKey}-pass`;
const GH_DEFAULTS = { repo: CFG.repo, branch: 'main', path: 'data/cashflow.json', token: '' };
const ACCESS_PATH = 'docs/access.js';
const SAVE_DELAY = 1500;
const KDF_ITERATIONS = 600000;
const MIN_PASSWORD = 10;

const sync = {
  mode: 'local',     // 'local' = this browser only, 'github' = shared file
  canWrite: true,    // false when the token can only read
  loadFailed: false, // could not read the shared file; editing paused until it can
  sha: null,         // version of the file we last read or wrote
  pending: [],       // change descriptions not yet committed
  saving: false,
  timer: null,
  lastSaved: null,
  error: '',
  conflict: false,
};
let sec = null;      // {password, key, salt, iterations} while signed in with the password
let teamCfg = null;  // repo settings + token from docs/access.js, once unlocked

// ── Config ──────────────────────────────────────────────────
function ghConfig() {
  try { return { ...GH_DEFAULTS, ...JSON.parse(localStorage.getItem(GH_KEY) || '{}') }; }
  catch (e) { return { ...GH_DEFAULTS }; }
}
function setGhConfig(c) {
  try { localStorage.setItem(GH_KEY, JSON.stringify(c)); } catch (e) { /* ignore */ }
}
/** Your own token wins; otherwise the password sign-in. */
function activeConfig() {
  const own = ghConfig();
  return own.token ? own : teamCfg || own;
}
const teamAccess = () => window.APP_ACCESS || null;

function storedPassword() {
  try { return sessionStorage.getItem(PW_KEY) || localStorage.getItem(PW_KEY); } catch (e) { return null; }
}
function storePassword(pw, remember) {
  try {
    sessionStorage.setItem(PW_KEY, pw);
    if (remember) localStorage.setItem(PW_KEY, pw); else localStorage.removeItem(PW_KEY);
  } catch (e) { /* ignore */ }
}
function forgetPassword() {
  try { sessionStorage.removeItem(PW_KEY); localStorage.removeItem(PW_KEY); } catch (e) { /* ignore */ }
}

function isReadOnly() {
  return sync.mode === 'github' && (!sync.canWrite || sync.loadFailed || sync.conflict);
}
function readOnlyReason() {
  if (sync.conflict) return 'Someone else saved changes — choose which version to keep first.';
  if (sync.loadFailed) return sync.error || 'Cannot reach GitHub, so changes are paused.';
  return 'View only — this GitHub token cannot save changes.';
}

// ── Encoding & encryption ───────────────────────────────────
const bytesToB64 = bytes => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const b64ToBytes = b64 => Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0));
const b64encode = str => bytesToB64(new TextEncoder().encode(str));
const b64decode = b64 => new TextDecoder().decode(b64ToBytes(b64));

async function deriveKey(password, saltB64, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64ToBytes(saltB64), iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function newSecret(password) {
  const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
  return { password, salt, iterations: KDF_ITERATIONS, key: await deriveKey(password, salt, KDF_ITERATIONS) };
}
/** Key for a given salt, re-deriving from the password if the salt changed. */
async function keyFor(saltB64, iterations) {
  if (sec.salt !== saltB64 || sec.iterations !== iterations) {
    sec = { ...sec, salt: saltB64, iterations, key: await deriveKey(sec.password, saltB64, iterations) };
  }
  return sec.key;
}
async function encrypt(text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sec.key, new TextEncoder().encode(text));
  return { iv: bytesToB64(iv), data: bytesToB64(new Uint8Array(ct)) };
}
async function decrypt(key, ivB64, dataB64) {
  try {
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(ivB64) }, key, b64ToBytes(dataB64)));
  } catch (e) {
    const err = new Error('Wrong password.');
    err.wrongPassword = true;
    throw err;
  }
}
/** What goes in the repo: readable JSON, pretty-printed so the git diff is readable. */
const payload = () => JSON.stringify(state, null, 2) + '\n';

// ── GitHub API ──────────────────────────────────────────────
async function ghFetch(cfg, url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}
const contentsUrl = (cfg, path) => `https://api.github.com/repos/${cfg.repo}/contents/${(path || cfg.path).split('/').map(encodeURIComponent).join('/')}`;

function ghError(r) {
  const msg = r.status === 401 ? 'The GitHub token is invalid or has expired.'
    : r.status === 403 ? 'This token is not allowed to do that on the repository.'
    : r.status === 404 ? 'Repository not found — check the name and that the token can access it.'
    : (r.json && r.json.message) || `GitHub error ${r.status}`;
  const e = new Error(msg);
  e.status = r.status;
  return e;
}

/** Read the shared file: {state, sha}, or {missing: true} if it does not exist yet. */
async function ghRead(cfg) {
  const r = await ghFetch(cfg, `${contentsUrl(cfg)}?ref=${encodeURIComponent(cfg.branch)}`);
  if (r.status === 404) return { missing: true };
  if (!r.ok) throw ghError(r);
  return { state: normalise(JSON.parse(b64decode(r.json.content))), sha: r.json.sha };
}

/** sha of any file in the repo, or null if it does not exist. */
async function ghSha(cfg, path) {
  const r = await ghFetch(cfg, `${contentsUrl(cfg, path)}?ref=${encodeURIComponent(cfg.branch)}`);
  if (r.status === 404) return null;
  if (!r.ok) throw ghError(r);
  return r.json.sha;
}

function applyRemote(r) {
  state = r.state;
  sync.sha = r.sha;
  sync.pending = [];
  sync.conflict = false;
  undoStack.length = 0;
  setCurrency(state.settings.currency);
  save();
}

// ── Saving ──────────────────────────────────────────────────
function scheduleSave(change) {
  if (sync.mode !== 'github') return;
  sync.pending.push(change);
  clearTimeout(sync.timer);
  sync.timer = setTimeout(flush, SAVE_DELAY);
  renderSync();
}

async function flush() {
  if (sync.mode !== 'github' || sync.saving || !sync.pending.length || sync.conflict) return;
  sync.saving = true;
  renderSync();
  const cfg = activeConfig();
  const changes = sync.pending.splice(0);
  const message = changes.length === 1
    ? `Cash flow: ${changes[0]}`
    : `Cash flow: ${changes.length} changes\n\n${changes.map(c => '- ' + c).join('\n')}`;
  let retry = false;
  try {
    const r = await ghFetch(cfg, contentsUrl(cfg), {
      method: 'PUT',
      body: JSON.stringify({ message, content: b64encode(payload()), branch: cfg.branch, ...(sync.sha ? { sha: sync.sha } : {}) }),
    });
    if (r.ok) {
      sync.sha = r.json.content.sha;
      sync.lastSaved = new Date();
      sync.error = '';
    } else {
      sync.pending.unshift(...changes);
      if (r.status === 409 || r.status === 422) sync.conflict = true; // the file changed since we read it
      else if (r.status === 401 || r.status === 403) { sync.canWrite = false; sync.error = ghError(r).message + ' Your last change was not saved.'; }
      else { sync.error = ghError(r).message; retry = true; }
    }
  } catch (e) {
    sync.pending.unshift(...changes);
    sync.error = 'Could not reach GitHub — retrying.';
    retry = true;
  }
  sync.saving = false;
  render();
  if (retry) setTimeout(flush, 15000);
  else if (sync.pending.length && !sync.conflict && sync.canWrite) flush(); // edits made while saving
}

/** Pick up changes other people have saved. Only when nothing local is waiting to be saved. */
async function refreshFromRemote() {
  if (sync.mode !== 'github' || sync.saving || sync.pending.length || sync.conflict || isLocked()) return;
  try {
    const r = await ghRead(activeConfig());
    const wasFailed = sync.loadFailed;
    sync.loadFailed = false;
    sync.error = '';
    if (!r.missing && r.sha !== sync.sha) {
      if (sync.saving || sync.pending.length) return; // an edit started while we were fetching
      applyRemote(r);
      render();
      if (!wasFailed) toast('Updated with the latest saved changes');
    } else if (wasFailed) render();
  } catch (e) { /* keep showing what we have */ }
}

async function resolveConflict(keepMine) {
  try {
    const r = await ghRead(activeConfig());
    if (keepMine) {
      sync.sha = r.missing ? null : r.sha;
      sync.conflict = false;
      flush();
    } else {
      if (!r.missing) applyRemote(r);
      sync.conflict = false;
      toast('Loaded the latest version from GitHub');
    }
  } catch (e) { toast(e.message); }
  render();
}

// ── Start-up, sign-in and lock ──────────────────────────────
const isLocked = () => !document.getElementById('lock').hidden;

function showLock(message) {
  const el = document.getElementById('lock');
  el.hidden = false;
  document.body.classList.add('locked');
  document.getElementById('lock-msg').textContent = message || '';
  const f = document.getElementById('lock-form');
  f.password.value = '';
  setTimeout(() => f.password.focus(), 0);
}
function hideLock() {
  document.getElementById('lock').hidden = true;
  document.body.classList.remove('locked');
}

/** Sign in with the password: decrypt the token in docs/access.js, then read the shared file. */
async function unlock(password) {
  const access = teamAccess();
  if (!access) throw new Error('Password access is not set up.');
  sec = { password, salt: null, iterations: 0, key: null };
  const token = await decrypt(await keyFor(access.salt, access.iterations), access.iv, access.token); // wrong password throws
  teamCfg = { repo: access.repo, branch: access.branch, path: access.path, token };
  const r = await ghRead(teamCfg);
  Object.assign(sync, { mode: 'github', canWrite: true, loadFailed: false, conflict: false, error: '' });
  if (r.missing) sync.sha = null;
  else applyRemote(r);
}

async function initStorage() {
  const own = ghConfig();
  if (!own.token && !teamAccess()) { sync.mode = 'local'; render(); return; }
  sync.mode = 'github';
  sync.loadFailed = true; // until the first read succeeds
  renderSync('Loading from GitHub…');
  if (!own.token) {
    // Opened from the link: the password unlocks the token.
    const pw = storedPassword();
    if (pw) {
      try { await unlock(pw); render(); return; }
      catch (e) { sec = null; teamCfg = null; if (e.wrongPassword) forgetPassword(); }
    }
    showLock();
    render();
    return;
  }
  try {
    const r = await ghRead(own);
    sync.loadFailed = false;
    sync.error = '';
    if (r.missing) sync.sha = null; // first change will create the file
    else applyRemote(r);
  } catch (e) {
    sync.error = e.status ? e.message : 'Could not reach GitHub — showing the copy saved in this browser.';
  }
  render();
}

async function lock(message) {
  if (sync.pending.length && !sync.conflict) { clearTimeout(sync.timer); await flush(); }
  forgetPassword();
  sec = null;
  teamCfg = null;
  state = defaultState();
  undoStack.length = 0;
  Object.assign(sync, { sha: null, pending: [], conflict: false, error: '', loadFailed: true });
  closePopover();
  render();
  showLock(message);
}

// ── Connect / disconnect your own token ─────────────────────
async function connectGitHub(cfg) {
  const status = document.getElementById('gh-status');
  status.textContent = 'Connecting…';
  try {
    const repo = await ghFetch(cfg, `https://api.github.com/repos/${cfg.repo}`);
    if (!repo.ok) throw ghError(repo);
    const r = await ghRead(cfg);
    if (r.missing) {
      const what = `${state.items.length} invoices/bills and ${state.recurring.length} recurring payments`;
      if (!confirm(`There is no shared forecast in ${cfg.repo} yet.\n\nUpload the data in this browser (${what}) as ${cfg.path}?`)) { status.textContent = ''; return; }
      setGhConfig(cfg);
      Object.assign(sync, { mode: 'github', canWrite: true, loadFailed: false, sha: null, conflict: false, error: '' });
      scheduleSave('Share forecast');
      clearTimeout(sync.timer);
      await flush();
    } else {
      const hasLocal = state.items.length || state.recurring.length;
      if (hasLocal && JSON.stringify(state) !== JSON.stringify(r.state) &&
        !confirm('Load the shared forecast from GitHub?\n\nIt replaces the data currently in this browser. Cancel and download a backup first if you want to keep it.')) { status.textContent = ''; return; }
      setGhConfig(cfg);
      Object.assign(sync, { mode: 'github', canWrite: true, loadFailed: false, conflict: false, error: '' });
      applyRemote(r);
      toast('Connected — showing the shared forecast');
    }
  } catch (e) {
    status.textContent = e.message;
    return;
  }
  render();
}

function disconnectGitHub() {
  if (teamCfg && !ghConfig().token) return lock();
  if (sync.pending.length && !confirm('Some changes have not been saved to GitHub yet. Disconnect anyway?')) return;
  setGhConfig({ ...ghConfig(), token: '' });
  clearTimeout(sync.timer);
  if (teamAccess()) return lock();
  Object.assign(sync, { mode: 'local', canWrite: true, loadFailed: false, sha: null, pending: [], conflict: false, error: '' });
  toast('Disconnected — changes now stay in this browser only');
  render();
}

// ── Password access ─────────────────────────────────────
/** Save the token, encrypted with a new password, as docs/access.js. */
async function setPassword(password) {
  const cfg = activeConfig();
  const status = document.getElementById('pw-status');
  status.textContent = 'Saving…';
  sec = await newSecret(password);
  const { iv, data } = await encrypt(cfg.token);
  const access = { repo: cfg.repo, branch: cfg.branch, path: cfg.path, kdf: 'PBKDF2-SHA256', iterations: sec.iterations, salt: sec.salt, iv, token: data };
  const js = `// Password access for the cash flow app, written by the app.\n// The GitHub token inside is encrypted with the password.\nwindow.APP_ACCESS = ${JSON.stringify(access, null, 2)};\n`;
  const sha = await ghSha(cfg, ACCESS_PATH);
  const r = await ghFetch(cfg, contentsUrl(cfg, ACCESS_PATH), { method: 'PUT', body: JSON.stringify({ message: 'Cash flow: set password access', content: b64encode(js), branch: cfg.branch, ...(sha ? { sha } : {}) }) });
  if (!r.ok) { status.textContent = 'The password could not be saved: ' + ghError(r).message; return; }
  window.APP_ACCESS = access;
  if (teamCfg) storePassword(password, false); // signed in with the old password: keep this session going
  if (ghConfig().token) sec = null; // the owner signs in with their token, not the password
  document.getElementById('pw-form').reset();
  status.textContent = '';
  toast('Password saved — share the link and the password');
  render();
}

async function removePasswordAccess() {
  if (!confirm('Turn off password access? People who sign in with the password will no longer be able to open the forecast.')) return;
  const cfg = activeConfig();
  const sha = await ghSha(cfg, ACCESS_PATH);
  if (sha) {
    const r = await ghFetch(cfg, contentsUrl(cfg, ACCESS_PATH), { method: 'DELETE', body: JSON.stringify({ message: 'Cash flow: remove password access', sha, branch: cfg.branch }) });
    if (!r.ok) { toast('Could not remove it: ' + ghError(r).message); return; }
  }
  window.APP_ACCESS = null;
  toast('Password access turned off');
  render();
}

// ── Rendering & wiring ──────────────────────────────────────
/** Status chip in the top bar, conflict banner, and the connection cards. */
function renderSync(loading) {
  const chip = document.getElementById('sync-status');
  let text, cls = '';
  if (loading) { text = loading; }
  else if (sync.mode === 'local') { text = 'This browser only'; cls = 'muted'; }
  else if (isLocked()) { text = 'Locked'; cls = 'muted'; }
  else if (sync.conflict) { text = 'Newer version on GitHub'; cls = 'warn'; }
  else if (sync.loadFailed) { text = 'Offline — view only'; cls = 'warn'; }
  else if (!sync.canWrite) { text = 'View only'; cls = 'muted'; }
  else if (sync.saving) { text = 'Saving to GitHub…'; }
  else if (sync.error) { text = 'Not saved yet'; cls = 'warn'; }
  else if (sync.pending.length) { text = 'Unsaved changes…'; }
  else { text = sync.lastSaved ? `Saved to GitHub ${sync.lastSaved.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : 'Synced with GitHub'; cls = 'ok'; }
  if (teamCfg && !ghConfig().token && !isLocked()) text = '🔒 ' + text;
  const cfg = activeConfig();
  chip.textContent = text;
  chip.className = 'sync-chip ' + cls;
  chip.title = sync.error || (sync.mode === 'github' ? `${cfg.repo} · ${cfg.path}` : 'Connect to GitHub on Data & import to share this forecast');
  document.getElementById('sync-banner').hidden = !sync.conflict;
  document.getElementById('btn-lock').hidden = !(sync.mode === 'github' && teamCfg && !ghConfig().token && !isLocked());
  document.body.classList.toggle('readonly', isReadOnly());

  const f = document.getElementById('gh-form');
  const connected = sync.mode === 'github';
  const viaTeam = connected && !!teamCfg && !ghConfig().token;
  f.repo.value = cfg.repo; f.branch.value = cfg.branch; f.path.value = cfg.path;
  f.token.value = connected ? '••••••••' : '';
  ['repo', 'branch', 'path', 'token'].forEach(n => { f[n].disabled = connected; });
  document.getElementById('gh-connect').hidden = connected;
  document.getElementById('gh-disconnect').hidden = !connected;
  document.getElementById('gh-disconnect').textContent = viaTeam ? 'Sign out' : 'Disconnect';
  document.getElementById('gh-status').textContent = !connected
    ? 'Not connected — the forecast is saved in this browser only.'
    : sync.error || (viaTeam ? 'Signed in with the password. ' : '') +
      (sync.canWrite ? `Every change is committed to ${cfg.path} on ${cfg.branch}.` : 'Connected read-only.');

  const pw = document.getElementById('pw-card');
  pw.hidden = !(connected && sync.canWrite && !sync.loadFailed);
  document.getElementById('pw-state').textContent = teamAccess()
    ? 'Password access is on: anyone with the link and the password can open and edit the forecast. Set a new password below to change it.'
    : 'Password access is off: opening the forecast needs a GitHub token. Set a password to let people in with just the link and the password.';
  document.getElementById('pw-remove').hidden = !(teamAccess() && ghConfig().token);
}

function wireSync() {
  document.getElementById('gh-form').addEventListener('submit', ev => {
    ev.preventDefault();
    const f = ev.target;
    const cfg = { repo: f.repo.value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, ''), branch: f.branch.value.trim() || 'main', path: f.path.value.trim().replace(/^\//, '') || GH_DEFAULTS.path, token: f.token.value.trim() };
    if (!cfg.token) { document.getElementById('gh-status').textContent = 'Paste a GitHub token first.'; return; }
    connectGitHub(cfg);
  });
  document.getElementById('gh-disconnect').addEventListener('click', disconnectGitHub);
  document.getElementById('sync-status').addEventListener('click', () => { if (!isLocked()) showTab('data'); });
  document.getElementById('btn-lock').addEventListener('click', () => lock());
  document.getElementById('sync-banner').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-act]');
    if (b) resolveConflict(b.dataset.act === 'keep-mine');
  });

  document.getElementById('lock-form').addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = ev.target;
    const msg = document.getElementById('lock-msg');
    const btn = f.querySelector('button');
    btn.disabled = true;
    msg.textContent = 'Unlocking…';
    try {
      await unlock(f.password.value);
      storePassword(f.password.value, f.remember.checked);
      hideLock();
      render();
    } catch (e) {
      sec = null; teamCfg = null;
      msg.textContent = e.wrongPassword ? 'Wrong password.' : e.status ? e.message : 'Could not reach GitHub — check the connection and try again.';
    }
    btn.disabled = false;
  });

  document.getElementById('pw-form').addEventListener('submit', ev => {
    ev.preventDefault();
    const f = ev.target;
    const status = document.getElementById('pw-status');
    if (f.pw1.value.length < MIN_PASSWORD) { status.textContent = `Use at least ${MIN_PASSWORD} characters — a short phrase is best.`; return; }
    if (f.pw1.value !== f.pw2.value) { status.textContent = 'The two passwords do not match.'; return; }
    setPassword(f.pw1.value).catch(e => { status.textContent = e.message; });
  });
  document.getElementById('pw-remove').addEventListener('click', () => removePasswordAccess().catch(e => toast(e.message)));

  // Check for other people's changes when the tab regains focus, and every minute while visible.
  window.addEventListener('focus', refreshFromRemote);
  setInterval(() => { if (document.visibilityState === 'visible') refreshFromRemote(); }, 60000);
  window.addEventListener('beforeunload', ev => {
    if (sync.mode === 'github' && (sync.pending.length || sync.saving)) { flush(); ev.preventDefault(); ev.returnValue = ''; }
  });
}

// ════════════════════════════════════════════════════════════
//  Tabs & boot
// ════════════════════════════════════════════════════════════

function currentTab() {
  try { return localStorage.getItem(TAB_KEY) || 'thisweek'; } catch (e) { return 'thisweek'; }
}
function showTab(name) {
  try { localStorage.setItem(TAB_KEY, name); } catch (e) { /* ignore */ }
  closePopover();
  render();
}

function render() {
  const tab = currentTab();
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach(p => { p.hidden = p.id !== 'tab-' + tab; });
  if (tab === 'thisweek') renderThisWeek();
  if (tab === 'overview') renderOverview();
  if (tab === 'recurring') renderRecurring();
  if (tab === 'bank') renderBank();
  if (tab === 'data') renderData();
  renderSync();
}

/** Put the company's name, logo and wording from config.js into the page. */
function applyConfig() {
  document.title = `Weekly Cash Flow · ${CFG.company}`;
  document.querySelectorAll('[data-cfg]').forEach(el => { el.textContent = CFG[el.dataset.cfg]; });
  document.querySelectorAll('[data-cfg-title]').forEach(el => { el.title = el.title.replace('{bank}', CFG.bank).replace('{company}', CFG.company); });
  const logo = document.getElementById('logo'), word = document.getElementById('wordmark');
  word.textContent = CFG.wordmark || CFG.company;
  if (CFG.logo) { logo.src = CFG.logo; logo.alt = CFG.company; } else { logo.hidden = true; word.hidden = false; }
  document.querySelector('.brand').title = CFG.company;
  const badge = document.querySelector('.lock-badge');
  if (CFG.badge) badge.src = CFG.badge;
  else { // no emblem: the company wordmark heads the password screen instead
    const w = document.createElement('span');
    w.className = 'wordmark'; w.textContent = CFG.wordmark || CFG.company;
    badge.replaceWith(w);
  }
  if (CFG.badge) { const icon = document.createElement('link'); icon.rel = 'icon'; icon.href = CFG.badge; document.head.appendChild(icon); }
}

function boot() {
  applyConfig();
  setCurrency(state.settings.currency);
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.goto)));
  document.getElementById('btn-undo').addEventListener('click', undo);
  document.getElementById('tw-undo').addEventListener('click', undo);
  document.getElementById('btn-export-grid').addEventListener('click', exportGridCSV);
  document.getElementById('toast').addEventListener('click', ev => { if (ev.target.dataset.act === 'undo') undo(); });
  wireGrid();
  wireThisWeek();
  wireRecurring();
  wireBank();
  wireData();
  wireItemDialog();
  wireSync();
  render();
  initStorage();
}

boot();
