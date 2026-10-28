'use strict';

// ============================================================
// Assets: servers, domains, online accounts, payment and bank accounts, software…
// Passwords / API keys are encrypted by Windows in the main process and only decrypted
// on request (Show / Copy); the renderer never keeps them.
// ============================================================

const ASSET_CATEGORIES = {
  server: {
    label: 'Server / VPS', plural: 'Servers', icon: 'server', color: '#1d5bd6',
    provider: 'Hosting provider', providerPh: 'e.g. Hetzner, DigitalOcean, AWS', login: 'SSH / panel user',
    fields: [['ip', 'IP address', 'e.g. 203.0.113.10'], ['location', 'Location', 'e.g. Frankfurt'],
      ['os', 'Operating system', 'e.g. Ubuntu 24.04'], ['specs', 'Plan / specs', 'e.g. 4 vCPU · 8 GB · 160 GB']],
    expense: 'Hosting',
  },
  domain: {
    label: 'Domain', plural: 'Domains', icon: 'domain', color: '#0e7490',
    provider: 'Registrar', providerPh: 'e.g. Namecheap, Cloudflare', login: 'Registrar login',
    fields: [['dns', 'DNS hosted at', 'e.g. Cloudflare'], ['nameservers', 'Nameservers', '']],
    expense: 'Domains',
  },
  account: {
    label: 'Online account', plural: 'Accounts', icon: 'account', color: '#6d4fc2',
    provider: 'Service', providerPh: 'e.g. GitHub, Google Workspace, Upwork', login: 'Username / email',
    fields: [['email', 'Recovery email', ''], ['twofa', '2-step verification', 'e.g. Authenticator on my phone']],
    expense: 'Software',
  },
  payment: {
    label: 'Payment account', plural: 'Payment', icon: 'payment', color: '#15803d', balance: true,
    provider: 'Provider', providerPh: 'e.g. PayPal, Payoneer, Wise, Stripe', login: 'Login email',
    fields: [['accountId', 'Account ID / payment email', ''], ['currencies', 'Currencies held', 'e.g. USD, EUR']],
    expense: 'Fees',
  },
  bank: {
    label: 'Bank account', plural: 'Bank', icon: 'bank', color: '#b45309', balance: true,
    provider: 'Bank', providerPh: 'e.g. Chase, Revolut', login: 'Online banking login',
    fields: [['holder', 'Account holder', ''], ['accountNumber', 'Account number', ''], ['iban', 'IBAN', ''],
      ['swift', 'SWIFT / BIC', ''], ['routing', 'Routing / sort code', ''], ['branch', 'Branch / bank address', '']],
    expense: 'Fees',
  },
  software: {
    label: 'Software / license', plural: 'Software', icon: 'software', color: '#c2410c',
    provider: 'Vendor', providerPh: 'e.g. JetBrains, Adobe, OpenAI', login: 'Login',
    fields: [['licenseKey', 'License key', ''], ['seats', 'Plan / seats', '']],
    expense: 'Software',
  },
  other: {
    label: 'Other', plural: 'Other', icon: 'other', color: '#475569',
    provider: 'Provider', providerPh: '', login: 'Login', fields: [], expense: 'Other',
  },
};
const ASSET_STATUS = { active: 'Active', inactive: 'Not in use', closed: 'Closed / cancelled' };

const as = { selectedId: null, query: '', filter: 'all' };

function assetSub(a) {
  const d = a.details || {};
  return [a.provider, d.ip || d.accountId || d.iban || a.login].filter(Boolean).join(' · ');
}

/** 'late' (renewal date passed), 'soon' (within 14 days) or ''. */
function renewalState(a) {
  if (!a.renewsOn || a.status !== 'active') return '';
  const n = daysFromToday(a.renewsOn);
  return n < 0 ? 'late' : n <= 14 ? 'soon' : '';
}

function assetSearchMatch(a, q) {
  return matchQ(q, a.name, a.provider, a.url, a.login, a.notes, ASSET_CATEGORIES[a.category].label,
    byId('customer', a.customerId)?.name, ...Object.values(a.details || {}));
}

function visibleAssets() {
  return state.db.assets
    .filter((a) => (as.filter === 'all' || a.category === as.filter) && assetSearchMatch(a, as.query))
    .sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) ||
      Object.keys(ASSET_CATEGORIES).indexOf(a.category) - Object.keys(ASSET_CATEGORIES).indexOf(b.category) ||
      a.name.localeCompare(b.name));
}

function catIconHtml(category, size = '') {
  const cat = ASSET_CATEGORIES[category];
  return `<span class="cat-icon ${size}" style="--cat:${cat.color}" title="${esc(cat.label)}">${icon(cat.icon, size === 'lg' ? 30 : size === 'sm' ? 14 : 22)}</span>`;
}

// ---------- rendering ----------

function renderAssets() {
  const all = state.db.assets;
  const chips = [['all', 'All', all.length], ...Object.entries(ASSET_CATEGORIES)
    .map(([k, v]) => [k, v.plural, all.filter((a) => a.category === k).length])];
  $('#asFilters').innerHTML = chips
    .filter(([k, , n]) => k === 'all' || n || k === as.filter)
    .map(([k, label, n]) => `<button class="chip ${as.filter === k ? 'active' : ''}" data-filter="${k}">${esc(label)}${k === 'all' ? '' : ` ${n}`}</button>`)
    .join('');

  // running costs + money held, for the footer
  const monthly = all.map(monthlyCost);
  const costTotal = monthly.filter((v) => v !== null).reduce((s, v) => s + v, 0);
  const balances = sumBase(all.filter((a) => a.balance !== null && a.status !== 'closed'),
    (a) => a.balance, (a) => a.currency || baseCurrency());
  $('#asFoot').innerHTML = all.length ? `
    <div><span>Running costs</span><strong>${esc(fmtTotal(costTotal))}<small>/month</small></strong></div>
    <div><span>Balances</span><strong>${esc(fmtTotal(balances.total))}</strong></div>` : '';

  renderAssetList();
  renderAssetDetail();
}

function renderAssetList() {
  const rows = visibleAssets();
  const list = $('#asList');
  if (!state.db.assets.length) {
    list.innerHTML = '<li class="list-empty">No assets yet.<br>Add your servers, domains, accounts and bank details.</li>';
    return;
  }
  if (!rows.length) {
    list.innerHTML = `<li class="list-empty">Nothing matches${as.query.trim() ? ` “${esc(as.query.trim())}”` : ' this filter'}.</li>`;
    return;
  }
  list.innerHTML = rows.map((a) => {
    const rs = renewalState(a);
    const right = ASSET_CATEGORIES[a.category].balance && a.balance !== null
      ? fmtMoney(a.balance, a.currency || baseCurrency())
      : a.cost ? `${fmtMoney(a.cost, a.currency || baseCurrency())}${BILLING[a.billing].per}` : '';
    const badges = [];
    if (rs) badges.push(`<span class="badge ${rs === 'late' ? 'late' : 'awaiting'}">Renews ${esc(relDay(a.renewsOn))}</span>`);
    if (a.status !== 'active') badges.push(`<span class="badge muted">${esc(ASSET_STATUS[a.status])}</span>`);
    const cust = byId('customer', a.customerId);
    if (cust) badges.push(`<span class="badge tag">${esc(cust.name)}</span>`);
    return `
      <li class="contact ${a.id === as.selectedId ? 'active' : ''} ${a.status === 'active' ? '' : 'dim'}" data-id="${esc(a.id)}" tabindex="0">
        ${catIconHtml(a.category)}
        <div class="contact-body">
          <div class="contact-top">
            <span class="contact-name">${hlq(a.name, as.query)}</span>
            <span class="contact-date">${esc(right)}</span>
          </div>
          <div class="contact-sub">${hlq(assetSub(a), as.query) || esc(ASSET_CATEGORIES[a.category].label)}</div>
          ${badges.length ? `<div class="contact-meta">${badges.join('')}</div>` : ''}
        </div>
      </li>`;
  }).join('');
}

function fieldRowHtml(label, value, { copy = true, href = '', mono = false } = {}) {
  if (!value) return '';
  return `
    <div class="kv">
      <span class="k">${esc(label)}</span>
      <span class="v ${mono ? 'mono' : ''}">${href ? `<a class="url-link" data-href="${esc(href)}">${esc(value)}</a>` : esc(value)}</span>
      ${copy ? `<button type="button" class="icon-btn tiny" data-copy="${esc(value)}" title="Copy">${icon('copy', 15)}</button>` : '<span></span>'}
    </div>`;
}

function renderAssetDetail() {
  const el = $('#asDetail');
  const a = byId('asset', as.selectedId);
  if (!a) {
    const has = state.db.assets.length > 0;
    el.innerHTML = `
      <div class="thread-empty">
        <div class="empty-icon">${icon('assets', 56)}</div>
        <h2>${has ? 'Select an asset' : 'Everything your business runs on'}</h2>
        <p>${has ? 'Pick one from the list, or add a new one.'
          : 'Servers, domains, online accounts, PayPal / Payoneer / Wise and bank accounts — with logins, renewal dates and what they cost. Passwords are encrypted with your Windows account.'}</p>
        <button class="btn primary" data-as="new">Add an asset</button>
      </div>`;
    return;
  }
  const cat = ASSET_CATEGORIES[a.category];
  const d = a.details || {};
  const cur = a.currency || baseCurrency();
  const cust = byId('customer', a.customerId);
  const rs = renewalState(a);
  const txs = state.db.transactions.filter((t) => t.assetId === a.id)
    .sort((x, y) => y.date.localeCompare(x.date) || y.createdAt.localeCompare(x.createdAt));
  const recurring = BILLING[a.billing].months;

  el.innerHTML = `
    <div class="thread-header">
      ${catIconHtml(a.category, 'sm')}
      <div class="thread-title">
        <div class="name">${esc(a.name)}</div>
        <div class="sub">${esc([cat.label, a.provider, a.status !== 'active' ? ASSET_STATUS[a.status] : ''].filter(Boolean).join(' · '))}</div>
      </div>
      <div class="thread-actions">
        ${a.cost ? '<button class="btn ghost small" data-as="pay">Log payment</button>' : ''}
        <button class="icon-btn" data-as="edit" title="Edit">${icon('edit')}</button>
        <button class="icon-btn" data-as="delete" title="Delete">${icon('trash')}</button>
      </div>
    </div>
    <div class="detail-scroll">
      <div class="profile-card">
        ${catIconHtml(a.category, 'lg')}
        <div class="info">
          <div class="name">${esc(a.name)}</div>
          <div class="headline">${esc([cat.label, a.provider].filter(Boolean).join(' at '))}</div>
          <div class="row">
            ${a.status !== 'active' ? `<span class="badge muted">${esc(ASSET_STATUS[a.status])}</span>` : ''}
            ${cust ? `<span>For <a class="url-link" data-open="customer:${esc(cust.id)}">${esc(cust.name)}</a></span>` : ''}
            ${rs ? `<span class="badge ${rs === 'late' ? 'late' : 'awaiting'}">Renews ${esc(relDay(a.renewsOn))}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="boxes">
        <section class="box">
          <div class="box-head"><h3>Access</h3></div>
          <div class="kvs">
            ${fieldRowHtml('Website / panel', a.url, { href: fullUrl(a.url) })}
            ${fieldRowHtml(cat.login, a.login)}
            ${a.hasSecret ? `
              <div class="kv">
                <span class="k">Password / key</span>
                <span class="v mono secret" id="asSecret">••••••••••</span>
                <span class="kv-actions">
                  <button type="button" class="icon-btn tiny" data-as="reveal" title="Show for 20 seconds">${icon('eye', 15)}</button>
                  <button type="button" class="icon-btn tiny" data-as="copy-secret" title="Copy (cleared from the clipboard after 30 s)">${icon('copy', 15)}</button>
                </span>
              </div>` : ''}
            ${cat.fields.map(([key, label]) => fieldRowHtml(label, d[key], { mono: ['ip', 'iban', 'accountNumber', 'swift', 'routing', 'licenseKey', 'nameservers'].includes(key) })).join('')}
          </div>
          ${!a.url && !a.login && !a.hasSecret && !cat.fields.some(([k]) => d[k]) ? '<div class="box-empty">No access details saved.</div>' : ''}
        </section>

        <section class="box">
          <div class="box-head"><h3>${cat.balance ? 'Money' : 'Cost'}</h3></div>
          <div class="mini-stats">
            ${cat.balance ? `<div><span>Balance</span><strong>${a.balance !== null ? esc(fmtMoney(a.balance, cur)) : '—'}</strong>
              <button type="button" class="link-btn" data-as="balance">Update</button></div>` : ''}
            <div><span>Cost</span><strong>${a.cost ? `${esc(fmtMoney(a.cost, cur))}<small>${esc(BILLING[a.billing].per)}</small>` : '—'}</strong></div>
            ${recurring ? `<div><span>Next renewal</span><strong>${a.renewsOn ? esc(fmtDay(a.renewsOn, { full: true })) : '—'}</strong>
              ${a.renewsOn ? `<small class="due ${rs === 'late' ? 'late' : rs ? 'soon' : ''}">${esc(relDay(a.renewsOn))}</small>` : ''}</div>`
              : a.renewsOn ? `<div><span>Expires</span><strong>${esc(fmtDay(a.renewsOn, { full: true }))}</strong></div>` : ''}
          </div>
          ${txs.length ? `<div class="mini-list">${txs.slice(0, 6).map(txMiniRowHtml).join('')}</div>
            ${txs.length > 6 ? `<button type="button" class="link-btn" data-as="all-tx">See all ${txs.length} transactions</button>` : ''}`
            : `<div class="box-empty">${cat.balance ? 'Income and expenses paid through this account show up here.' : 'Payments you log for it show up here.'}</div>`}
        </section>

        ${a.notes ? `<section class="box wide"><div class="box-head"><h3>Notes</h3></div><div class="notes">${esc(a.notes)}</div></section>` : ''}
      </div>
    </div>`;
}

// ---------- actions ----------

function selectAsset(id) {
  as.selectedId = id;
  renderAssetList();
  renderAssetDetail();
  $(`#asList .contact[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

function showAsset(id) {
  const a = byId('asset', id);
  if (!a) return;
  as.selectedId = id;
  if ((as.filter !== 'all' && as.filter !== a.category) || !assetSearchMatch(a, as.query)) {
    as.filter = 'all';
    as.query = '';
    if ($('#asSearch')) $('#asSearch').value = '';
  }
  showView('assets');
  $(`#asList .contact[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

function apiError(err) {
  return String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

let secretTimer = null;
async function revealAssetSecret(a) {
  let value;
  try {
    value = await window.api.revealSecret(a.id);
  } catch (err) {
    toast(apiError(err));
    return;
  }
  const el = $('#asSecret');
  if (!el || value === null) return;
  el.textContent = value;
  el.classList.add('shown');
  clearTimeout(secretTimer);
  secretTimer = setTimeout(() => {
    if ($('#asSecret')) {
      $('#asSecret').textContent = '••••••••••';
      $('#asSecret').classList.remove('shown');
    }
  }, 20000);
}

async function copyAssetSecret(a) {
  try {
    if (await window.api.copySecret(a.id)) toast('Password copied — it is cleared from the clipboard in 30 seconds');
  } catch (err) {
    toast(apiError(err));
  }
}

function detailFieldsHtml(category, details) {
  const fields = ASSET_CATEGORIES[category].fields;
  const rows = [];
  for (let i = 0; i < fields.length; i += 2) {
    rows.push(`<div class="field-row">${fields.slice(i, i + 2).map(([key, label, ph]) => `
      <div class="field"><label for="ad-${key}">${esc(label)}</label>
        <input id="ad-${key}" data-detail="${key}" value="${esc(details[key] || '')}" placeholder="${esc(ph || '')}" spellcheck="false"></div>`).join('')}</div>`);
  }
  return rows.join('');
}

/** New or edit. preset fills a new asset (e.g. { customerId }). */
function openAssetModal(existing = null, preset = {}) {
  const a = existing || {
    category: as.filter !== 'all' ? as.filter : 'server', status: 'active', billing: 'monthly',
    currency: lastCurrency(), details: {}, cost: null, balance: null, ...preset,
  };
  const id = existing ? existing.id : uid();
  let details = { ...(a.details || {}) };
  openModal({
    title: existing ? 'Edit asset' : 'New asset',
    body: `
      <div class="field-row">
        <div class="field">
          <label for="a-cat">Type</label>
          <select id="a-cat">${Object.entries(ASSET_CATEGORIES).map(([k, v]) => opt(k, v.label, a.category === k)).join('')}</select>
        </div>
        <div class="field">
          <label for="a-status">Status</label>
          <select id="a-status">${Object.entries(ASSET_STATUS).map(([k, v]) => opt(k, v, a.status === k)).join('')}</select>
        </div>
      </div>
      <div class="field">
        <label for="a-name">Name <span class="req">*</span></label>
        <input id="a-name" value="${esc(a.name)}" placeholder="e.g. Production server, example.com, Main PayPal">
        <div class="error hidden" id="a-name-err">Please enter a name.</div>
      </div>
      <div class="field-row">
        <div class="field"><label for="a-provider" id="a-provider-label"></label><input id="a-provider" value="${esc(a.provider)}"></div>
        <div class="field"><label for="a-url">Website / control panel</label><input id="a-url" value="${esc(a.url)}" placeholder="https://…" spellcheck="false"></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="a-login" id="a-login-label"></label><input id="a-login" value="${esc(a.login)}" spellcheck="false" autocomplete="off"></div>
        <div class="field">
          <label for="a-secret">Password / API key</label>
          <div class="secret-input">
            <input id="a-secret" type="password" autocomplete="new-password" spellcheck="false"
              placeholder="${existing?.hasSecret ? '•••••••• saved — type to replace' : 'Encrypted with your Windows account'}">
            <button type="button" class="icon-btn tiny" id="a-secret-show" title="Show while typing">${icon('eye', 15)}</button>
          </div>
          ${existing?.hasSecret ? '<label class="check small"><input type="checkbox" id="a-secret-remove"> Remove the saved password</label>' : ''}
        </div>
      </div>
      <div id="a-details">${detailFieldsHtml(a.category, details)}</div>
      <div class="field-row">
        <div class="field"><label for="a-cost">Cost</label>
          <div class="money-input">
            <input id="a-cost" inputmode="decimal" value="${a.cost !== null && a.cost !== undefined ? esc(String(a.cost)) : ''}" placeholder="0.00">
            <input id="a-currency" class="currency-input" list="currencyList" value="${esc(a.currency || lastCurrency())}" maxlength="6" autocomplete="off">
          </div>
          <div class="error hidden" id="a-cost-err">Please enter a number.</div>
        </div>
        <div class="field"><label for="a-billing">Billing</label>
          <select id="a-billing">${Object.entries(BILLING).map(([k, v]) => opt(k, v.label, a.billing === k)).join('')}</select></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="a-renews" id="a-renews-label">Next renewal / expiry date</label><input id="a-renews" type="date" value="${esc(a.renewsOn)}"></div>
        <div class="field" id="a-balance-field"><label for="a-balance">Current balance</label>
          <input id="a-balance" inputmode="decimal" value="${a.balance !== null && a.balance !== undefined ? esc(String(a.balance)) : ''}" placeholder="in the currency above">
          <div class="error hidden" id="a-balance-err">Please enter a number.</div></div>
      </div>
      <div class="field">
        <label for="a-customer">Used for customer</label>
        <select id="a-customer">${customerOptions(a.customerId)}</select>
      </div>
      <div class="field">
        <label for="a-notes">Notes</label>
        <textarea id="a-notes" rows="3" placeholder="Setup notes, what runs on it, recovery codes location…">${esc(a.notes)}</textarea>
      </div>`,
    okText: existing ? 'Save' : 'Add asset',
    onOpen() {
      const update = () => {
        const cat = ASSET_CATEGORIES[$('#a-cat').value];
        $('#a-provider-label').textContent = cat.provider;
        $('#a-provider').placeholder = cat.providerPh;
        $('#a-login-label').textContent = cat.login;
        $('#a-balance-field').classList.toggle('invisible', !cat.balance);
      };
      $('#a-cat').addEventListener('change', () => {
        // keep what was typed in fields the new type shares
        for (const input of $$('#a-details [data-detail]')) details[input.dataset.detail] = input.value;
        $('#a-details').innerHTML = detailFieldsHtml($('#a-cat').value, details);
        update();
      });
      $('#a-secret-show').addEventListener('click', () => {
        const s = $('#a-secret');
        s.type = s.type === 'password' ? 'text' : 'password';
      });
      $('#a-secret-remove')?.addEventListener('change', (e) => { $('#a-secret').disabled = e.target.checked; });
      update();
      $('#a-name').focus();
    },
    async onOk() {
      const cat = ASSET_CATEGORIES[$('#a-cat').value];
      for (const input of $$('#a-details [data-detail]')) details[input.dataset.detail] = input.value.trim();
      // only keep the fields of the chosen type
      details = Object.fromEntries(cat.fields.map(([k]) => [k, details[k] || '']).filter(([, v]) => v));
      const cost = parseAmount($('#a-cost').value);
      const balance = cat.balance ? parseAmount($('#a-balance').value) : null;
      const data = {
        category: $('#a-cat').value,
        status: $('#a-status').value,
        name: $('#a-name').value.trim(),
        provider: $('#a-provider').value.trim(),
        url: $('#a-url').value.trim(),
        login: $('#a-login').value.trim(),
        details,
        cost,
        currency: cleanCurrency($('#a-currency').value) || baseCurrency(),
        billing: $('#a-billing').value,
        renewsOn: $('#a-renews').value,
        balance,
        customerId: $('#a-customer').value || null,
        notes: $('#a-notes').value.trim(),
      };
      $('#a-name-err').classList.toggle('hidden', !!data.name);
      $('#a-cost-err').classList.toggle('hidden', !Number.isNaN(cost));
      $('#a-balance-err').classList.toggle('hidden', !Number.isNaN(balance));
      if (!data.name) { $('#a-name').focus(); return false; }
      if (Number.isNaN(cost)) { $('#a-cost').focus(); return false; }
      if (Number.isNaN(balance)) { $('#a-balance').focus(); return false; }
      const secret = $('#a-secret').value;
      const removeSecret = $('#a-secret-remove')?.checked;
      let stored;
      try {
        stored = await saveRec('asset', { ...(existing || {}), id, ...data });
        if (removeSecret || secret) {
          stored.hasSecret = await dbCall('setAssetSecret', id, removeSecret ? null : secret);
        }
      } catch {
        return false;
      }
      if (cost !== null) rememberCurrency(data.currency);
      as.selectedId = stored.id;
      if (!existing && as.filter !== 'all' && as.filter !== stored.category) as.filter = 'all';
      if (app.view === 'assets') refreshAll();
      else showAsset(stored.id);
      toast(existing ? 'Asset updated' : 'Asset added');
      return true;
    },
  });
}

function updateBalanceDialog(a) {
  const cur = a.currency || baseCurrency();
  openModal({
    title: `Balance of ${a.name}`,
    body: `
      <div class="field">
        <label for="b-amount">Current balance (${esc(cur)})</label>
        <input id="b-amount" inputmode="decimal" value="${a.balance !== null ? esc(String(a.balance)) : ''}">
        <div class="error hidden" id="b-err">Please enter a number.</div>
      </div>`,
    okText: 'Save',
    onOpen() {
      $('#b-amount').focus();
      $('#b-amount').select();
    },
    async onOk() {
      const n = parseAmount($('#b-amount').value);
      $('#b-err').classList.toggle('hidden', !Number.isNaN(n));
      if (Number.isNaN(n)) return false;
      try {
        await saveRec('asset', { ...a, balance: n });
      } catch {
        return false;
      }
      refreshAll();
      toast('Balance updated');
      return true;
    },
  });
}

/** Log what you paid for an asset as an expense, and (for subscriptions) move the renewal date on. */
function logAssetPayment(a) {
  const months = BILLING[a.billing].months;
  const next = months && a.renewsOn ? addMonths(a.renewsOn, months) : '';
  openTransactionModal(null, {
    type: 'expense',
    amount: a.cost,
    currency: a.currency || baseCurrency(),
    category: ASSET_CATEGORIES[a.category].expense,
    description: `${a.name}${a.provider ? ` (${a.provider})` : ''}`,
    assetId: a.id,
    customerId: a.customerId,
    date: a.renewsOn && daysFromToday(a.renewsOn) <= 0 ? a.renewsOn : today(),
  }, {
    extraHtml: next ? `<label class="check"><input type="checkbox" id="t-renew" checked>
      Move the next renewal of ${esc(a.name)} to ${esc(fmtDay(next, { full: true }))}</label>` : '',
    async afterSave() {
      if (next && $('#t-renew')?.checked) await saveRec('asset', { ...byId('asset', a.id), renewsOn: next });
    },
  });
}

// ---------- section ----------

registerView({
  id: 'assets',
  label: 'Assets',
  icon: 'assets',
  mount() {
    $('#view-assets').innerHTML = `
      <div class="layout">
        <section class="card messaging">
          <aside class="sidebar">
            <div class="sidebar-head">
              <h1>Assets</h1>
              <button class="icon-btn" id="asNew" title="New asset (Ctrl+N)">${icon('plus', 22)}</button>
            </div>
            <div class="search-row">${searchBoxHtml('asSearch', 'Search name, provider, IP, login, notes…')}</div>
            <div class="filters" id="asFilters"></div>
            <ul class="contact-list" id="asList"></ul>
            <div class="list-foot" id="asFoot"></div>
          </aside>
          <section class="thread" id="asDetail"></section>
        </section>
      </div>`;
    $('#asNew').addEventListener('click', () => openAssetModal());
    bindSearch($('#asSearch'), (q) => {
      as.query = q;
      renderAssetList();
      const rows = visibleAssets();
      if (q.trim() && rows.length && !rows.some((a) => a.id === as.selectedId)) selectAsset(rows[0].id);
    });
    $('#asFilters').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      as.filter = chip.dataset.filter;
      const rows = visibleAssets();
      if (!rows.some((a) => a.id === as.selectedId)) as.selectedId = rows[0]?.id || null;
      renderAssets();
    });
    $('#asList').addEventListener('click', (e) => {
      const li = e.target.closest('.contact');
      if (li) selectAsset(li.dataset.id);
    });
    $('#asList').addEventListener('keydown', (e) => {
      const li = e.target.closest('.contact');
      if (li && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        selectAsset(li.dataset.id);
      }
    });
    $('#asDetail').addEventListener('click', (e) => {
      const a = byId('asset', as.selectedId);
      const link = e.target.closest('[data-href]');
      if (link) return window.api.openExternal(link.dataset.href);
      const cp = e.target.closest('[data-copy]');
      if (cp) return copyText(cp.dataset.copy, 'Copied');
      const tx = e.target.closest('[data-tx]');
      if (tx) return openTransactionModal(byId('transaction', tx.dataset.tx));
      const btn = e.target.closest('[data-as]');
      if (!btn) return;
      const action = btn.dataset.as;
      if (action === 'new') return openAssetModal();
      if (!a) return;
      if (action === 'edit') openAssetModal(a);
      else if (action === 'delete') {
        if (as.selectedId === a.id) as.selectedId = null;
        deleteRec('asset', a, a.name);
      } else if (action === 'reveal') revealAssetSecret(a);
      else if (action === 'copy-secret') copyAssetSecret(a);
      else if (action === 'balance') updateBalanceDialog(a);
      else if (action === 'pay') logAssetPayment(a);
      else if (action === 'all-tx') showFinanceFor({ assetId: a.id });
    });
  },
  render() {
    if (as.selectedId && !byId('asset', as.selectedId)) as.selectedId = null;
    if (!as.selectedId) as.selectedId = visibleAssets()[0]?.id || null;
    renderAssets();
  },
  reset() {
    as.selectedId = null;
  },
  onNew: () => openAssetModal(),
  focusSearch() {
    $('#asSearch').focus();
    $('#asSearch').select();
  },
  badge() {
    const due = state.db.assets.filter((a) => renewalState(a)).length;
    const late = state.db.assets.some((a) => renewalState(a) === 'late');
    return { n: due, tone: late ? 'late' : 'soon', title: `${plural(due, 'renewal')} due within 14 days` };
  },
});
