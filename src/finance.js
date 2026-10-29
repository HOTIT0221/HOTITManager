'use strict';

// ============================================================
// Finance: money in and out. Each amount is kept in its own currency;
// totals are converted to the main currency with the rates from Settings.
// ============================================================

const INCOME_CATEGORIES = ['Project', 'Retainer', 'Hourly work', 'Consulting', 'Salary', 'Commission', 'Refund', 'Other'];
const EXPENSE_CATEGORIES = ['Hosting', 'Domains', 'Software', 'Contractors', 'Marketing', 'Fees', 'Taxes', 'Equipment',
  'Office', 'Education', 'Travel', 'Other'];

const PERIODS = {
  'this-month': 'This month',
  'last-month': 'Last month',
  'last-3': 'Last 3 months',
  'last-12': 'Last 12 months',
  'this-year': 'This year',
  'last-year': 'Last year',
  all: 'All time',
};

const fi = { period: 'last-12', type: 'all', query: '', customerId: '', assetId: '' };

/** [from, to] dates (inclusive) of a period. */
function periodRange(p) {
  const month = `${today().slice(0, 7)}-01`;
  const y = Number(today().slice(0, 4));
  switch (p) {
    case 'this-month': return [month, '9999-12-31'];
    case 'last-month': return [addMonths(month, -1), addDays(month, -1)];
    case 'last-3': return [addMonths(month, -2), '9999-12-31'];
    case 'last-12': return [addMonths(month, -11), '9999-12-31'];
    case 'this-year': return [`${y}-01-01`, '9999-12-31'];
    case 'last-year': return [`${y - 1}-01-01`, `${y - 1}-12-31`];
    default: return ['', '9999-12-31'];
  }
}

function transactionsBetween(from, to, type = '') {
  return state.db.transactions.filter((t) => t.date >= from && t.date <= to && (!type || t.type === type));
}

function txLabel(t) {
  return t.description || t.category || (t.type === 'income' ? 'Income' : 'Expense');
}

function visibleTransactions() {
  const [from, to] = periodRange(fi.period);
  return state.db.transactions
    .filter((t) => t.date >= from && t.date <= to)
    .filter((t) => fi.type === 'all' || t.type === fi.type)
    .filter((t) => (!fi.customerId || t.customerId === fi.customerId) && (!fi.assetId || t.assetId === fi.assetId))
    .filter((t) => matchQ(fi.query, t.description, t.category, t.notes, t.currency, String(t.amount),
      byId('customer', t.customerId)?.name, byId('asset', t.assetId)?.name))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

// ---------- rendering ----------

function renderFinance() {
  $('#fiPeriod').value = fi.period;
  $$('#fiType .chip').forEach((b) => b.classList.toggle('active', b.dataset.type === fi.type));
  const scope = byId('customer', fi.customerId) || byId('asset', fi.assetId);
  $('#fiScope').innerHTML = scope
    ? `<span class="scope-chip">${fi.customerId ? 'Customer' : 'Account'}: <strong>${esc(scope.name)}</strong>
        <button type="button" data-fi="clear-scope" title="Show everything">×</button></span>` : '';

  const rows = visibleTransactions();
  const income = sumBase(rows.filter((t) => t.type === 'income'));
  const expense = sumBase(rows.filter((t) => t.type === 'expense'));
  const net = income.total - expense.total;
  $('#fiKpis').innerHTML = `
    <div class="kpi"><span class="kpi-label">${kpiIcon('cash', 'green')}Income</span><strong class="kpi-value">${esc(fmtTotal(income.total))}</strong>
      <span class="kpi-sub">${plural(rows.filter((t) => t.type === 'income').length, 'payment')}</span></div>
    <div class="kpi"><span class="kpi-label">${kpiIcon('receipt', 'red')}Expenses</span><strong class="kpi-value">${esc(fmtTotal(expense.total))}</strong>
      <span class="kpi-sub">${plural(rows.filter((t) => t.type === 'expense').length, 'expense')}</span></div>
    <div class="kpi"><span class="kpi-label">${kpiIcon('trend', 'blue')}Profit</span><strong class="kpi-value ${net < 0 ? 'neg' : ''}">${esc(fmtTotal(net))}</strong>
      <span class="kpi-sub">${income.total ? `${Math.round((net / income.total) * 100)}% of income` : PERIODS[fi.period]}</span></div>`;
  $('#fiNote').innerHTML = missingRatesNote([...new Set([...income.missing, ...expense.missing])]);

  const table = $('#fiTable');
  if (!state.db.transactions.length) {
    table.innerHTML = `
      <div class="thread-empty">
        <div class="empty-icon">${icon('finance', 56)}</div>
        <h2>Track what comes in and goes out</h2>
        <p>Log client payments and business expenses. Overview turns them into monthly profit and growth.</p>
        <div class="settings-buttons"><button class="btn secondary" data-fi="expense">Add an expense</button>
          <button class="btn primary" data-fi="income">Add income</button></div>
      </div>`;
    return;
  }
  if (!rows.length) {
    table.innerHTML = `<div class="list-empty">No transactions${fi.query.trim() ? ` match “${esc(fi.query.trim())}”` : ''} in this period.</div>`;
    return;
  }

  const months = new Map();
  for (const t of rows) {
    const k = t.date.slice(0, 7);
    if (!months.has(k)) months.set(k, []);
    months.get(k).push(t);
  }
  const base = baseCurrency();
  table.innerHTML = [...months].map(([k, list]) => {
    const inc = sumBase(list.filter((t) => t.type === 'income')).total;
    const exp = sumBase(list.filter((t) => t.type === 'expense')).total;
    return `
      <div class="tx-month">
        <span>${esc(fmtMonth(k))}</span>
        <span class="tx-month-sum">
          ${inc ? `<span class="amount income">+${esc(fmtTotal(inc))}</span>` : ''}
          ${exp ? `<span class="amount expense">−${esc(fmtTotal(exp))}</span>` : ''}
          <span class="tx-net">Net ${esc(fmtTotal(inc - exp))}</span>
        </span>
      </div>
      ${list.map((t) => {
        const cust = byId('customer', t.customerId);
        const asset = byId('asset', t.assetId);
        const sub = [t.category ? `<span class="badge tag">${hlq(t.category, fi.query)}</span>` : '',
          cust ? `<a class="url-link" data-open="customer:${esc(cust.id)}">${hlq(cust.name, fi.query)}</a>` : '',
          asset ? `<a class="url-link" data-open="asset:${esc(asset.id)}">${hlq(asset.name, fi.query)}</a>` : '']
          .filter(Boolean).join('<span class="sep">·</span>');
        const conv = t.currency !== base ? toBase(t.amount, t.currency) : null;
        return `
          <div class="tx-row" data-tx="${esc(t.id)}" tabindex="0">
            <span class="tx-date">${esc(fmtDay(t.date))}</span>
            <span class="tx-main">
              <span class="tx-title">${hlq(txLabel(t), fi.query)}</span>
              ${sub ? `<span class="tx-sub">${sub}</span>` : ''}
            </span>
            <span class="tx-amount">
              <span class="amount ${t.type}">${esc(fmtMoney(t.type === 'income' ? t.amount : -t.amount, t.currency, { sign: true }))}</span>
              ${conv !== null ? `<small>≈ ${esc(fmtTotal(conv))}</small>` : t.currency !== base ? '<small class="warn-text">no rate</small>' : ''}
            </span>
            <button type="button" class="icon-btn tiny tx-del" data-del="${esc(t.id)}" title="Delete">${icon('trash', 16)}</button>
          </div>`;
      }).join('')}`;
  }).join('');
}

/** Finance filtered to one customer or one account/asset (from their detail page). */
function showFinanceFor({ customerId = '', assetId = '' }) {
  fi.customerId = customerId;
  fi.assetId = assetId;
  fi.period = 'all';
  fi.type = 'all';
  fi.query = '';
  if ($('#fiSearch')) $('#fiSearch').value = '';
  showView('finance');
}

function exportCsv() {
  const rows = visibleTransactions();
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [['Date', 'Type', 'Amount', 'Currency', `Amount (${baseCurrency()})`, 'Category', 'Description', 'Customer', 'Account / asset', 'Notes']];
  for (const t of rows.slice().reverse()) {
    const signed = t.type === 'income' ? t.amount : -t.amount;
    const conv = toBase(signed, t.currency);
    lines.push([t.date, t.type, signed, t.currency, conv === null ? '' : Math.round(conv * 100) / 100, t.category,
      t.description, byId('customer', t.customerId)?.name, byId('asset', t.assetId)?.name, t.notes]);
  }
  // BOM so Excel reads accented names correctly
  const blob = new Blob(['﻿' + lines.map((l) => l.map(cell).join(',')).join('\r\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `transactions-${fi.period}-${today()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------- add / edit ----------

function assetOptions(selectedId) {
  const groups = Object.entries(ASSET_CATEGORIES).map(([k, cat]) => {
    const list = state.db.assets.filter((a) => a.category === k && (a.status !== 'closed' || a.id === selectedId));
    if (!list.length) return '';
    return `<optgroup label="${esc(cat.plural)}">${list.sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => opt(a.id, a.name, a.id === selectedId)).join('')}</optgroup>`;
  }).join('');
  return opt('', '— None —', !selectedId) + groups;
}

function categorySuggestions(type) {
  const used = state.db.transactions.filter((t) => t.type === type && t.category).map((t) => t.category);
  return [...new Set([...(type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES), ...used])];
}

/**
 * New or edit. preset fills a new one ({ type, customerId, assetId, amount, … }).
 * extraHtml / afterSave let a caller add a checkbox and act on it (e.g. moving an asset's renewal date).
 */
function openTransactionModal(existing = null, preset = {}, { extraHtml = '', afterSave = null } = {}) {
  const t = existing || {
    type: 'income', date: today(), amount: null, currency: lastCurrency(), category: '', description: '', notes: '', ...preset,
  };
  const id = existing ? existing.id : uid();
  let type = t.type;
  openModal({
    title: existing ? 'Edit transaction' : type === 'income' ? 'Add income' : 'Add expense',
    body: `
      <div class="field">
        <div class="segmented money-type" id="t-type" role="radiogroup">
          <button type="button" data-type="income">Income</button>
          <button type="button" data-type="expense">Expense</button>
        </div>
      </div>
      <div class="field-row">
        <div class="field"><label for="t-amount">Amount <span class="req">*</span></label>
          <div class="money-input">
            <input id="t-amount" inputmode="decimal" value="${t.amount !== null && t.amount !== undefined ? esc(String(t.amount)) : ''}" placeholder="0.00">
            <input id="t-currency" class="currency-input" list="currencyList" value="${esc(t.currency)}" maxlength="6" autocomplete="off">
          </div>
          <div class="error hidden" id="t-amount-err">Please enter an amount above zero.</div>
        </div>
        <div class="field"><label for="t-date">Date <span class="req">*</span></label>
          <input id="t-date" type="date" value="${esc(t.date)}">
          <div class="error hidden" id="t-date-err">Please choose a date.</div></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="t-cat">Category</label>
          <input id="t-cat" list="t-cat-list" value="${esc(t.category)}" autocomplete="off"><datalist id="t-cat-list"></datalist></div>
        <div class="field"><label for="t-desc">Description</label>
          <input id="t-desc" value="${esc(t.description)}" placeholder="e.g. Website redesign — milestone 2"></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="t-customer" id="t-customer-label">Customer</label>
          <select id="t-customer">${customerOptions(t.customerId)}</select></div>
        <div class="field"><label for="t-asset" id="t-asset-label">Account / asset</label>
          <select id="t-asset">${assetOptions(t.assetId)}</select></div>
      </div>
      <div class="field">
        <label for="t-notes">Notes</label>
        <textarea id="t-notes" rows="2" placeholder="Invoice number, fees, anything to remember…">${esc(t.notes)}</textarea>
      </div>
      ${extraHtml ? `<div class="field">${extraHtml}</div>` : ''}`,
    okText: existing ? 'Save' : 'Add',
    onOpen() {
      const setType = (v) => {
        type = v;
        $$('#t-type button').forEach((b) => b.classList.toggle('active', b.dataset.type === v));
        $('#t-cat-list').innerHTML = categorySuggestions(v).map((c) => `<option value="${esc(c)}">`).join('');
        $('#t-customer-label').textContent = v === 'income' ? 'From customer' : 'For customer';
        $('#t-asset-label').textContent = v === 'income' ? 'Paid into (account)' : 'Paid from / for (account or asset)';
        if (!existing) $('#modalTitle').textContent = v === 'income' ? 'Add income' : 'Add expense';
      };
      $('#t-type').addEventListener('click', (e) => {
        const b = e.target.closest('[data-type]');
        if (b) setType(b.dataset.type);
      });
      setType(type);
      $('#t-amount').focus();
    },
    async onOk() {
      const amount = parseAmount($('#t-amount').value);
      const okAmount = amount !== null && amount > 0;
      const date = $('#t-date').value;
      $('#t-amount-err').classList.toggle('hidden', okAmount);
      $('#t-date-err').classList.toggle('hidden', !!date);
      if (!okAmount) { $('#t-amount').focus(); return false; }
      if (!date) { $('#t-date').focus(); return false; }
      const data = {
        type,
        date,
        amount,
        currency: cleanCurrency($('#t-currency').value) || baseCurrency(),
        category: $('#t-cat').value.trim(),
        description: $('#t-desc').value.trim(),
        customerId: $('#t-customer').value || null,
        assetId: $('#t-asset').value || null,
        notes: $('#t-notes').value.trim(),
      };
      try {
        await saveRec('transaction', { ...(existing || {}), id, ...data });
        if (afterSave) await afterSave();
      } catch {
        return false;
      }
      rememberCurrency(data.currency);
      refreshAll();
      const missing = rateOf(data.currency) === null;
      toast(existing ? 'Transaction updated' : `${type === 'income' ? 'Income' : 'Expense'} added${missing ? ` — set a ${data.currency} rate to include it in totals` : ''}`,
        missing ? { label: 'Set rate', fn: () => openSettings({ focusMoney: true }) } : undefined);
      return true;
    },
  });
}

// ---------- section ----------

registerView({
  id: 'finance',
  label: 'Finance',
  icon: 'finance',
  mount() {
    $('#view-finance').innerHTML = `
      <div class="page">
        <div class="page-head">
          <h1>Finance</h1>
          <div class="page-actions">
            <button class="btn ghost small" data-fi="csv" title="Download the transactions shown as a spreadsheet">Export CSV</button>
            <button class="btn secondary" data-fi="expense">− Add expense</button>
            <button class="btn primary" data-fi="income">+ Add income</button>
          </div>
        </div>
        <div class="toolbar">
          <select id="fiPeriod" class="select">${Object.entries(PERIODS).map(([k, v]) => opt(k, v, k === fi.period)).join('')}</select>
          <div class="filters inline" id="fiType">
            <button class="chip" data-type="all">All</button>
            <button class="chip" data-type="income">Income</button>
            <button class="chip" data-type="expense">Expenses</button>
          </div>
          <span id="fiScope"></span>
          <div class="grow">${searchBoxHtml('fiSearch', 'Search description, category, customer…')}</div>
        </div>
        <div class="kpis three" id="fiKpis"></div>
        <div id="fiNote"></div>
        <section class="card ledger" id="fiTable"></section>
      </div>`;
    $('#fiPeriod').addEventListener('change', (e) => { fi.period = e.target.value; renderFinance(); });
    $('#fiType').addEventListener('click', (e) => {
      const b = e.target.closest('[data-type]');
      if (!b) return;
      fi.type = b.dataset.type;
      renderFinance();
    });
    bindSearch($('#fiSearch'), (q) => { fi.query = q; renderFinance(); });
    $('#view-finance').addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        const t = byId('transaction', del.dataset.del);
        if (t) confirmDeleteRec('transaction', t, txLabel(t), { what: 'transaction' });
        return;
      }
      if (e.target.closest('a, [data-open]')) return;
      const row = e.target.closest('[data-tx]');
      if (row) return openTransactionModal(byId('transaction', row.dataset.tx));
      const b = e.target.closest('[data-fi]');
      if (!b) return;
      const action = b.dataset.fi;
      if (action === 'income' || action === 'expense') {
        openTransactionModal(null, { type: action, customerId: fi.customerId || null, assetId: fi.assetId || null });
      } else if (action === 'csv') exportCsv();
      else if (action === 'clear-scope') {
        fi.customerId = '';
        fi.assetId = '';
        renderFinance();
      }
    });
    $('#fiTable').addEventListener('keydown', (e) => {
      const row = e.target.closest('[data-tx]');
      if (row && e.key === 'Enter') openTransactionModal(byId('transaction', row.dataset.tx));
    });
  },
  render() {
    renderFinance();
  },
  onNew: () => openTransactionModal(null, { type: fi.type === 'expense' ? 'expense' : 'income' }),
  focusSearch() {
    $('#fiSearch').focus();
    $('#fiSearch').select();
  },
});
