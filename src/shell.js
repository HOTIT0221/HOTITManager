'use strict';

// ============================================================
// App shell: the navigation bar, switching between sections, and helpers shared by the
// business sections (money, dates, saving records). The LinkedIn tracker lives in renderer.js;
// each other section registers itself from its own file (overview.js, customers.js, notes.js, …).
// ============================================================

const app = { view: 'overview' };
const VIEWS = [];
const VIEW_ORDER = ['overview', 'customers', 'assets', 'finance', 'goals', 'linkedin', 'notes'];

/** def: { id, label, icon, mount(), render(), onNew(), focusSearch(), badge() -> { n, tone, title } } */
function registerView(def) {
  VIEWS.push(def);
  VIEWS.sort((a, b) => VIEW_ORDER.indexOf(a.id) - VIEW_ORDER.indexOf(b.id));
}

function viewDef(id = app.view) {
  return VIEWS.find((v) => v.id === id) || VIEWS[0];
}

const ICONS = {
  overview: 'M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z',
  customers: 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3Zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3Zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5Zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5Z',
  assets: 'M20 13H4c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h16c.55 0 1-.45 1-1v-6c0-.55-.45-1-1-1ZM7 19c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2ZM20 3H4c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h16c.55 0 1-.45 1-1V4c0-.55-.45-1-1-1ZM7 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2Z',
  finance: 'M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4Z',
  goals: 'M14.4 6 14 4H5v17h2v-7h5.6l.4 2h7V6h-5.6Z',
  linkedin: 'M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2ZM6 9h12v2H6V9Zm8 5H6v-2h8v2Zm4-6H6V6h12v2Z',
  notes: 'M19 3H4.99C3.89 3 3 3.9 3 5l.01 14c0 1.1.89 2 1.99 2h10l6-6V5c0-1.1-.9-2-2-2ZM7 8h10v2H7V8Zm5 6H7v-2h5v2Zm2 5.5V14h5.5L14 19.5Z',
  pin: 'M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3Z',
  server: 'M20 13H4c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h16c.55 0 1-.45 1-1v-6c0-.55-.45-1-1-1ZM7 19c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2ZM20 3H4c-.55 0-1 .45-1 1v6c0 .55.45 1 1 1h16c.55 0 1-.45 1-1V4c0-.55-.45-1-1-1ZM7 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2Z',
  domain: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2Zm6.93 6h-2.95a15.65 15.65 0 0 0-1.38-3.56A8.03 8.03 0 0 1 18.92 8ZM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96ZM4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2 0 .68.06 1.34.14 2H4.26Zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56A7.99 7.99 0 0 1 5.08 16Zm2.95-8H5.08a7.99 7.99 0 0 1 4.33-3.56A15.65 15.65 0 0 0 8.03 8ZM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96ZM14.34 14H9.66c-.09-.66-.16-1.32-.16-2 0-.68.07-1.35.16-2h4.68c.09.65.16 1.32.16 2 0 .68-.07 1.34-.16 2Zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a8.03 8.03 0 0 1-4.33 3.56ZM16.36 14c.08-.66.14-1.32.14-2 0-.68-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38Z',
  account: 'M12.65 10A5.99 5.99 0 0 0 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6a5.99 5.99 0 0 0 5.65-4H17v4h4v-4h2v-4H12.65ZM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2Z',
  payment: 'M20 4H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2Zm0 14H4v-6h16v6Zm0-10H4V6h16v2Z',
  bank: 'M4 10h3v7H4v-7Zm6.5 0h3v7h-3v-7ZM2 19h20v3H2v-3Zm15-9h3v7h-3v-7Zm-5-9L2 6v2h20V6L12 1Z',
  software: 'M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4Zm5.2 0 4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4Z',
  other: 'M12 2 6.5 11h11L12 2Zm5.5 11c-2.49 0-4.5 2.01-4.5 4.5S15.01 22 17.5 22s4.5-2.01 4.5-4.5-2.01-4.5-4.5-4.5ZM3 21.5h8v-8H3v8Z',
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2Z',
  edit: 'M21.13 2.86a3 3 0 0 0-4.17 0l-13 13L2 22l6.19-2L21.13 7a2.93 2.93 0 0 0 0-4.16ZM6.77 18.57l-1.35-1.34L16.64 6 18 7.35Z',
  trash: 'M20 4v1H4V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1h4a1 1 0 0 1 1 1ZM5 6h14v13a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3Zm9 13h1V9h-1Zm-5 0h1V9H9Z',
  search: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5Zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14Z',
  copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1Zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2Zm0 16H8V7h11v14Z',
  eye: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5ZM12 17a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  open: 'M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7ZM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7Z',
  check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17Z',
  // GitHub's mark (Octicons mark-github), drawn on a 16-unit grid
  github: { box: 16, d: 'M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z' },
  mail: 'M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2Zm0 4-8 5-8-5V6l8 5 8-5v2Z',
  cash: 'M19 14V6c0-1.1-.9-2-2-2H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2Zm-9-1c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3Zm13-6v11c0 1.1-.9 2-2 2H4v-2h17V7h2Z',
  receipt: 'M18 17H6v-2h12v2Zm0-4H6v-2h12v2Zm0-4H6V7h12v2ZM3 22l1.5-1.5L6 22l1.5-1.5L9 22l1.5-1.5L12 22l1.5-1.5L15 22l1.5-1.5L18 22l1.5-1.5L21 22V2l-1.5 1.5L18 2l-1.5 1.5L15 2l-1.5 1.5L12 2l-1.5 1.5L9 2 7.5 3.5 6 2 4.5 3.5 3 2v20Z',
  trend: 'M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6h-6Z',
  renew: 'M12 6v3l4-4-4-4v3c-4.42 0-8 3.58-8 8 0 1.57.46 3.03 1.24 4.26L6.7 14.8A5.87 5.87 0 0 1 6 12c0-3.31 2.69-6 6-6Zm6.76 1.74L17.3 9.2c.44.84.7 1.79.7 2.8 0 3.31-2.69 6-6 6v-3l-4 4 4 4v-3c4.42 0 8-3.58 8-8 0-1.57-.46-3.03-1.24-4.26Z',
  wallet: 'M21 18v1c0 1.1-.9 2-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14c1.1 0 2 .9 2 2v1h-9a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h9Zm-9-2h10V8H12v8Zm4-2.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5Z',
};

/** Small tinted icon square shown before a KPI label. */
function kpiIcon(name, tone) {
  return `<span class="kpi-icon ${tone}">${icon(name, 16)}</span>`;
}

function icon(name, size = 20) {
  const { d, box = 24 } = typeof ICONS[name] === 'string' ? { d: ICONS[name] } : ICONS[name];
  return `<svg viewBox="0 0 ${box} ${box}" width="${size}" height="${size}" aria-hidden="true"><path fill="currentColor" d="${d}"/></svg>`;
}

// ---------- navigation ----------

function showView(id) {
  const def = viewDef(id);
  app.view = def.id;
  for (const v of VIEWS) $(`#view-${v.id}`).classList.toggle('hidden', v !== def);
  document.body.dataset.view = def.id; // the LinkedIn account switcher only shows in its own section
  try { localStorage.setItem('view', def.id); } catch { /* not critical */ }
  closeLightbox();
  toggleAccountMenu(false);
  renderRail();
  def.render();
}

function renderRail() {
  $('#rail').innerHTML = VIEWS.map((v) => {
    const b = v.badge ? v.badge() : null;
    return `
      <button type="button" class="rail-item ${v.id === app.view ? 'active' : ''}" data-view="${v.id}"
        title="${esc(v.label)} (Ctrl+Shift+${VIEWS.indexOf(v) + 1})${b && b.title ? ` · ${esc(b.title)}` : ''}">
        ${icon(v.icon, 22)}
        <span>${esc(v.short || v.label)}</span>
        ${b && b.n ? `<i class="rail-badge ${b.tone || ''}">${b.n > 99 ? '99+' : b.n}</i>` : ''}
      </button>`;
  }).join('');
}

/** Re-draw whatever is on screen after data changed (and the badges in the navigation bar). */
function refreshAll() {
  refreshDatalists();
  viewDef().render({ keep: true });
  renderRail();
}

function refreshDatalists() {
  refreshNationalities();
  refreshCurrencyList();
}

// ---------- the LinkedIn tracker as a section ----------

registerView({
  id: 'linkedin',
  label: 'LinkedIn Messages',
  short: 'LinkedIn',
  icon: 'linkedin',
  render({ keep = false } = {}) {
    renderAll({ scroll: keep ? 'keep' : state.query.trim() ? 'hit' : 'bottom' });
    if (!contactById(state.selectedId)) {
      const first = $('#contactList .contact');
      if (first) selectContact(first.dataset.id);
    } else {
      requestAnimationFrame(fitComposer);
    }
  },
  onNew: () => openContactModal(),
  focusSearch,
  badge() {
    const index = buildIndex();
    const n = state.db.contacts.filter((c) => contactStatus(index.get(c.id) || []) === 'awaiting').length;
    return { n, title: `${n} awaiting reply` };
  },
});

/** Open a LinkedIn conversation from another section. */
function openConversation(contactId) {
  showView('linkedin');
  showContact(contactId);
}

// ---------- dates without a time ('YYYY-MM-DD', on the app clock) ----------

function today() {
  return toLocalInput(new Date()).slice(0, 10);
}

function parseDay(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function dayStr(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(s, n) {
  return dayStr(parseDay(s) + n * 86400000);
}

/** Same day n months later, clamped to the month's length (Jan 31 + 1 month = Feb 28/29). */
function addMonths(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return dayStr(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last)));
}

function daysFromToday(s) {
  return Math.round((parseDay(s) - parseDay(today())) / 86400000);
}

const DAY_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const DAY_FMT_SHORT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const MONTH_FMT = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
const MONTH_FMT_SHORT = new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' });

/** "Oct 28" this year, "Oct 28, 2025" otherwise. */
function fmtDay(s, { full = false } = {}) {
  if (!s) return '';
  const fmt = !full && s.slice(0, 4) === today().slice(0, 4) ? DAY_FMT_SHORT : DAY_FMT;
  return fmt.format(parseDay(s));
}

function fmtMonth(key, { short = false } = {}) {
  return (short ? MONTH_FMT_SHORT : MONTH_FMT).format(parseDay(`${key}-01`));
}

function relDay(s) {
  const n = daysFromToday(s);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

/** 'YYYY-MM' keys of the last n months, oldest first, ending with this month. */
function lastMonths(n) {
  const start = addMonths(`${today().slice(0, 7)}-01`, -(n - 1));
  return Array.from({ length: n }, (_v, i) => addMonths(start, i).slice(0, 7));
}

// ---------- money ----------

const COMMON_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY', 'CNY', 'HKD', 'SGD', 'INR', 'KRW', 'AED',
  'SAR', 'TRY', 'PLN', 'UAH', 'CZK', 'SEK', 'NOK', 'DKK', 'HUF', 'RON', 'BRL', 'MXN', 'ARS', 'ZAR', 'NGN', 'EGP',
  'PKR', 'BDT', 'PHP', 'IDR', 'VND', 'THB', 'MYR', 'NZD', 'ILS', 'USDT', 'USDC', 'BTC', 'ETH'];

function baseCurrency() {
  return state.db.settings.baseCurrency || 'USD';
}

/** What 1 unit of `cur` is worth in the main currency, or null when no rate is set. */
function rateOf(cur) {
  const c = String(cur || '').toUpperCase();
  if (!c || c === baseCurrency()) return 1;
  const r = (state.db.settings.fxRates || {})[c];
  return r > 0 ? r : null;
}

function toBase(amount, cur) {
  const r = rateOf(cur);
  return r === null ? null : amount * r;
}

/** Total in the main currency. Currencies without an exchange rate are listed in `missing`. */
function sumBase(list, amountOf = (x) => x.amount, currencyOf = (x) => x.currency) {
  let total = 0;
  const missing = new Set();
  for (const x of list) {
    const v = toBase(amountOf(x), currencyOf(x));
    if (v === null) missing.add(currencyOf(x));
    else total += v;
  }
  return { total, missing: [...missing] };
}

const moneyFormatters = new Map();

function fmtMoney(n, cur = baseCurrency(), { decimals, sign = false, compact = false } = {}) {
  const c = cur || baseCurrency();
  const key = `${c}|${decimals}|${compact}`;
  let f = moneyFormatters.get(key);
  if (!f) {
    const digits = decimals === undefined ? {} : { minimumFractionDigits: decimals, maximumFractionDigits: decimals };
    const opts = { ...digits, ...(compact ? { notation: 'compact', maximumFractionDigits: 1 } : {}) };
    try {
      f = new Intl.NumberFormat(undefined, { style: 'currency', currency: c, ...opts });
    } catch {
      // not an ISO currency (e.g. USDT): "1,250.00 USDT"
      const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 8, ...opts });
      f = { format: (v) => `${nf.format(v)} ${c}` };
    }
    moneyFormatters.set(key, f);
  }
  const s = f.format(Math.abs(n));
  return (n < 0 ? '−' : sign && n > 0 ? '+' : '') + s;
}

/** Whole amounts for big totals, cents for small ones. */
function fmtTotal(n, cur) {
  return fmtMoney(n, cur, { decimals: Math.abs(n) >= 1000 ? 0 : 2 });
}

function missingRatesNote(missing) {
  if (!missing.length) return '';
  return `<div class="note warn">Amounts in ${esc(missing.join(', '))} are not included — set an exchange rate in
    <a href="#" class="url-link" data-open="settings-money">Settings</a>.</div>`;
}

const BILLING = {
  none: { label: 'No recurring cost', per: '' },
  monthly: { label: 'Monthly', per: '/mo', months: 1 },
  quarterly: { label: 'Every 3 months', per: '/qtr', months: 3 },
  yearly: { label: 'Yearly', per: '/yr', months: 12 },
  once: { label: 'One-time', per: ' once' },
};

/** What an asset costs per month in the main currency (null when there is no rate for its currency). */
function monthlyCost(a) {
  const b = BILLING[a.billing];
  if (a.status !== 'active' || !b || !b.months || !(a.cost > 0)) return 0;
  const v = toBase(a.cost, a.currency || baseCurrency());
  return v === null ? null : v / b.months;
}

function refreshCurrencyList() {
  const used = [
    ...state.db.transactions.map((t) => t.currency),
    ...state.db.assets.map((a) => a.currency),
    ...Object.keys(state.db.settings.fxRates || {}),
    baseCurrency(),
  ].filter(Boolean);
  const all = [...new Set([...used, ...COMMON_CURRENCIES])];
  $('#currencyList').innerHTML = all.map((c) => `<option value="${esc(c)}">`).join('');
}

/** The currency a new amount starts in: the one used last, else the main currency. */
function lastCurrency() {
  try {
    return localStorage.getItem('lastCurrency') || baseCurrency();
  } catch {
    return baseCurrency();
  }
}

function rememberCurrency(cur) {
  try { localStorage.setItem('lastCurrency', cur); } catch { /* not critical */ }
}

function cleanCurrency(v) {
  return String(v || '').trim().toUpperCase();
}

function parseAmount(v) {
  // accept "1,250.50", "1 250", "€1250"
  const s = String(v ?? '').replace(/[^\d.,-]/g, '').replace(/,(?=\d{3}(\D|$))/g, '').replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

// ---------- records ----------

const RECORD_KEYS = { customer: 'customers', asset: 'assets', transaction: 'transactions', goal: 'goals', task: 'tasks', note: 'notes' };

function byId(type, id) {
  if (!id) return null;
  return state.db[RECORD_KEYS[type]].find((r) => r.id === id) || null;
}

/** Save a record and keep the in-memory copy in sync. Throws (after a toast) when saving fails. */
async function saveRec(type, rec) {
  const stored = await dbCall('saveRecord', type, rec);
  const list = state.db[RECORD_KEYS[type]];
  const i = list.findIndex((r) => r.id === stored.id);
  if (i >= 0) list[i] = stored;
  else list.push(stored);
  return stored;
}

/** Delete with an Undo button (deleted records are kept for 30 days). */
async function deleteRec(type, rec, label) {
  try {
    await dbCall('deleteRecord', type, rec.id);
  } catch {
    return false;
  }
  const key = RECORD_KEYS[type];
  state.db[key] = state.db[key].filter((r) => r.id !== rec.id);
  refreshAll();
  toast(`Deleted ${label}`, {
    label: 'Undo',
    async fn() {
      const back = await dbCall('restoreRecord', type, rec.id);
      if (back) state.db[key].push(back);
      refreshAll();
    },
  });
  return true;
}

/** Ask first, then delete with Undo. what names the kind of record ("asset"); note is optional HTML. */
function confirmDeleteRec(type, rec, label, { what, note = '', before } = {}) {
  openModal({
    title: `Delete ${what}?`,
    body: `<p>This removes <strong>${esc(label)}</strong>.</p>${note ? `<p class="help">${note}</p>` : ''}`,
    okText: 'Delete',
    danger: true,
    async onOk() {
      before?.();
      await deleteRec(type, rec, label);
      return true;
    },
  });
}

// ---------- small UI helpers ----------

function opt(value, label, selected) {
  return `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(label)}</option>`;
}

function customerOptions(selectedId) {
  const list = [...state.db.customers].sort((a, b) => a.name.localeCompare(b.name));
  return opt('', '— None —', !selectedId) + list.map((c) =>
    opt(c.id, `${c.name}${c.company ? ` (${c.company})` : ''}`, c.id === selectedId)).join('');
}

/** Case-insensitive: does any value contain q? */
function matchQ(q, ...values) {
  const s = q.trim().toLowerCase();
  return !s || values.some((v) => String(v ?? '').toLowerCase().includes(s));
}

/** Escape text and highlight q in it. */
function hlq(text, q) {
  const s = q.trim();
  if (!s) return esc(text);
  return String(text ?? '')
    .split(new RegExp(`(${escRegex(s)})`, 'gi'))
    .map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part)))
    .join('');
}

function tagsOf(s) {
  return String(s || '').split(',').map((t) => t.trim()).filter(Boolean);
}

/** Search box + filter chips header used by list sections. */
function searchBoxHtml(id, placeholder) {
  return `
    <div class="search-box">
      ${icon('search', 16)}
      <input id="${id}" type="search" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">
    </div>`;
}

/** Wire a search input: debounced onChange(query), Esc clears. */
function bindSearch(input, onChange) {
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => onChange(input.value), 120);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.stopPropagation();
      input.value = '';
      onChange('');
    }
  });
}

/** Copy text, with a toast. */
function copyText(text, what = 'Copied') {
  navigator.clipboard.writeText(text).then(() => toast(`${what} to clipboard`));
}

// ---------- settings: main currency + exchange rates ----------

/** Currencies that appear in your data, other than the main one. */
function usedForeignCurrencies(base) {
  const used = new Set([
    ...state.db.transactions.map((t) => t.currency),
    ...state.db.assets.filter((a) => a.cost !== null || a.balance !== null).map((a) => a.currency),
    ...Object.keys(state.db.settings.fxRates || {}),
  ].filter(Boolean));
  used.delete(base);
  return [...used].sort();
}

function ratesRowsHtml(base, rates, extra = []) {
  const list = [...new Set([...usedForeignCurrencies(base), ...extra])].filter((c) => c !== base).sort();
  if (!list.length) return '<div class="help">All your amounts are in the main currency.</div>';
  return list.map((c) => `
    <div class="rate-row">
      <span>1 ${esc(c)} =</span>
      <input type="text" inputmode="decimal" data-rate="${esc(c)}" value="${rates[c] ? esc(String(rates[c])) : ''}"
        placeholder="rate">
      <span>${esc(base)}</span>
      ${rates[c] ? '' : '<span class="rate-missing">not set</span>'}
    </div>`).join('');
}

/**
 * Rates against `from` restated against `to`: 1 X = r from  →  1 X = r / rate(to) to, and `from`
 * itself becomes 1 / rate(to). Null when `to` has no rate, so nothing can be worked out.
 */
function rebaseRates(rates, from, to) {
  const r = rates[to];
  if (!(r > 0)) return null;
  const round = (n) => Number(n.toPrecision(6));
  const out = { [from]: round(1 / r) };
  for (const [c, v] of Object.entries(rates)) if (c !== to && c !== from) out[c] = round(v / r);
  return out;
}

/**
 * The rates editor of Settings. Rates are stated in the main currency, so when the main currency
 * is changed they are restated in the new one (or cleared, when there is no rate to convert with).
 * Returns a function that applies a changed main currency; call it before reading the rates.
 */
function setupRatesEditor() {
  const extra = [];
  let base = baseCurrency();
  let rates = { ...(state.db.settings.fxRates || {}) };
  const draw = () => {
    $('#s-rates').innerHTML = ratesRowsHtml(base, rates, [...extra, ...Object.keys(rates)]);
  };
  // what is typed in the rate inputs (an emptied input removes that rate)
  const takeInputs = () => {
    for (const input of $$('#s-rates [data-rate]')) {
      const n = parseAmount(input.value);
      if (n > 0) rates[input.dataset.rate] = n;
      else delete rates[input.dataset.rate];
    }
  };
  const applyCurrency = () => {
    const next = cleanCurrency($('#s-currency').value);
    if (!/^[A-Z0-9]{2,6}$/.test(next) || next === base) return;
    takeInputs();
    const rebased = rebaseRates(rates, base, next);
    $('#s-rates-note').textContent = rebased
      ? `The rates were converted from ${base} to ${next}. Check them before saving.`
      : `The rates were in ${base}, and there is no ${next} rate to convert them with, so enter them again in ${next}.`;
    $('#s-rates-note').classList.remove('hidden');
    rates = rebased || {};
    base = next;
    draw();
  };
  $('#s-currency').addEventListener('change', applyCurrency);
  $('#s-rate-add').addEventListener('click', () => {
    const c = cleanCurrency($('#s-rate-new').value);
    if (!/^[A-Z0-9]{2,6}$/.test(c)) { $('#s-rate-new').focus(); return; }
    takeInputs();
    extra.push(c);
    $('#s-rate-new').value = '';
    draw();
    $(`[data-rate="${CSS.escape(c)}"]`)?.focus();
  });
  draw();
  return applyCurrency;
}

/** { EUR: 1.08, … } from the rates editor (empty or invalid inputs are left out). */
function readRates() {
  const out = {};
  for (const input of $$('#s-rates [data-rate]')) {
    const n = parseAmount(input.value);
    if (n > 0) out[input.dataset.rate] = n;
  }
  return out;
}

// ---------- events + start ----------

function bindShellEvents() {
  $('#rail').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) showView(b.dataset.view);
  });

  // links such as "set an exchange rate in Settings" or "open in Customers"
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-open]');
    if (!a) return;
    e.preventDefault();
    const [what, id] = a.dataset.open.split(':');
    if (what === 'settings-money') openSettings({ focusMoney: true });
    else if (what === 'conversation') openConversation(id);
    else if (what === 'customer') showCustomer(id);
    else if (what === 'asset') showAsset(id);
    else if (what === 'view') showView(id);
  });

  window.api.onMenu((cmd) => {
    if ($('#modal').open && cmd !== 'focus-search') closeModal();
    if (cmd.startsWith('view:')) showView(cmd.slice(5));
    if (cmd === 'new' && viewDef().onNew) viewDef().onNew();
    if (cmd === 'focus-search' && !$('#modal').open && viewDef().focusSearch) viewDef().focusSearch();
    if (cmd === 'settings') openSettings();
    if (cmd === 'accounts') {
      showView('linkedin');
      openAccountsManager();
    }
    if (cmd === 'shortcuts') showShortcuts();
  });

  window.api.onDataReplaced((data) => {
    const { message, ...db } = data;
    state.db = db;
    applyClock(db.settings.timeZone);
    state.selectedId = null;
    state.drafts = {};
    composerTray.clear();
    closeLightbox();
    for (const v of VIEWS) if (v.reset) v.reset();
    refreshAll();
    if (message) toast(message);
  });

  // keep "today", "in 3 days" and the badges current when the app stays open
  let day = today();
  setInterval(() => {
    if (today() !== day && !$('#modal').open) {
      day = today();
      refreshAll();
    }
  }, 60 * 1000);
}

async function boot() {
  // an encrypted database that this PC doesn't remember the password for: ask for it first
  if ((await window.api.security('state')).status === 'locked') await unlockScreen();
  bindEvents(); // LinkedIn section
  bindShellEvents();
  bindPasswordRequests();
  state.db = await window.api.load();
  applyClock(state.db.settings.timeZone);
  refreshDatalists();
  for (const v of VIEWS) if (v.mount) v.mount();
  let start = 'overview';
  try { start = localStorage.getItem('view') || start; } catch { /* first start */ }
  showView(start);
  maybeOfferEncryption();
}

document.addEventListener('DOMContentLoaded', boot);
