'use strict';

// ============================================================
// Customers: clients, collaborators and leads
// ============================================================

const CUSTOMER_KINDS = {
  client: { label: 'Client', plural: 'Clients' },
  collaborator: { label: 'Collaborator', plural: 'Collaborators' },
  lead: { label: 'Lead', plural: 'Leads' },
};
const CUSTOMER_STATUS = { active: 'Active', paused: 'Paused', former: 'Former' };
const STATUS_ORDER = { active: 0, paused: 1, former: 2 };

const cu = { selectedId: null, query: '', filter: 'all' };

/** Their own photo, else the photo of their linked LinkedIn contact. */
function customerAvatar(c, size = '') {
  const contact = c.contactId ? contactById(c.contactId) : null;
  const src = avatarSrc(c.id, c.avatarVersion) || (contact ? avatarSrc(contact.id, contact.avatarVersion) : null);
  return avatarHtml(c.name, c.id, size, src);
}

function customerTransactions(id) {
  return state.db.transactions.filter((t) => t.customerId === id)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

function customerIncome(id, since = '') {
  return sumBase(state.db.transactions.filter((t) => t.customerId === id && t.type === 'income' && t.date >= since));
}

function matchesCustomerFilter(c) {
  if (cu.filter === 'all') return true;
  if (cu.filter === 'former') return c.status === 'former';
  return c.kind === cu.filter && c.status !== 'former';
}

function customerSearchMatch(c, q) {
  return matchQ(q, c.name, c.company, c.role, c.email, c.phone, countrySearchText(c.country), c.website,
    c.linkedinUrl, c.tags, c.notes);
}

function visibleCustomers() {
  return state.db.customers
    .filter((c) => matchesCustomerFilter(c) && customerSearchMatch(c, cu.query))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name));
}

// ---------- rendering ----------

function renderCustomers() {
  renderCustomerFilters();
  renderCustomerList();
  renderCustomerDetail();
}

function renderCustomerFilters() {
  const all = state.db.customers;
  const count = (f) => all.filter((c) => (f === 'former' ? c.status === 'former' : c.kind === f && c.status !== 'former')).length;
  const chips = [['all', 'All', all.length], ...Object.entries(CUSTOMER_KINDS).map(([k, v]) => [k, v.plural, count(k)]),
    ['former', 'Former', count('former')]];
  $('#cuFilters').innerHTML = chips
    .filter(([k, , n]) => k === 'all' || n || k === cu.filter)
    .map(([k, label, n]) => `<button class="chip ${cu.filter === k ? 'active' : ''}" data-filter="${k}">${esc(label)}${k === 'all' ? '' : ` ${n}`}</button>`)
    .join('');
}

function renderCustomerList() {
  const rows = visibleCustomers();
  const yearAgo = addMonths(today(), -12);
  const list = $('#cuList');
  if (!state.db.customers.length) {
    list.innerHTML = '<li class="list-empty">No customers yet.<br>Press <kbd>Ctrl</kbd> + <kbd>N</kbd> to add your first one.</li>';
    return;
  }
  if (!rows.length) {
    list.innerHTML = `<li class="list-empty">No customers match${cu.query.trim() ? ` “${esc(cu.query.trim())}”` : ' this filter'}.</li>`;
    return;
  }
  const index = buildIndex();
  list.innerHTML = rows.map((c) => {
    const income = customerIncome(c.id, yearAgo).total;
    const sub = [c.role && c.company ? `${c.role} at ${c.company}` : c.company || c.role, c.country].filter(Boolean);
    const badges = [`<span class="badge kind-${c.kind}">${CUSTOMER_KINDS[c.kind].label}</span>`];
    if (c.status !== 'active') badges.push(`<span class="badge muted">${CUSTOMER_STATUS[c.status]}</span>`);
    const contact = c.contactId ? contactById(c.contactId) : null;
    if (contact) {
      const msgs = index.get(contact.id) || [];
      if (contactStatus(msgs) === 'awaiting') badges.push(`<span class="badge awaiting" title="LinkedIn">Awaiting reply · ${ago(msgs[msgs.length - 1].sentAt)}</span>`);
    }
    for (const t of tagsOf(c.tags).slice(0, 3)) badges.push(`<span class="badge tag">${hlq(t, cu.query)}</span>`);
    return `
      <li class="contact ${c.id === cu.selectedId ? 'active' : ''} ${c.status === 'former' ? 'dim' : ''}" data-id="${esc(c.id)}" tabindex="0">
        ${customerAvatar(c)}
        <div class="contact-body">
          <div class="contact-top">
            <span class="contact-name">${hlq(c.name, cu.query)}</span>
            <span class="contact-date" title="Income in the last 12 months">${income ? esc(fmtTotal(income)) : ''}</span>
          </div>
          ${sub.length ? `<div class="contact-sub">${sub.map((x) => hlq(x, cu.query)).join(' · ')}</div>` : ''}
          <div class="contact-meta">${badges.join('')}</div>
        </div>
      </li>`;
  }).join('');
}

function renderCustomerDetail() {
  const el = $('#cuDetail');
  const c = byId('customer', cu.selectedId);
  if (!c) {
    const has = state.db.customers.length > 0;
    el.innerHTML = `
      <div class="thread-empty">
        <div class="empty-icon">${icon('customers', 56)}</div>
        <h2>${has ? 'Select a customer' : 'Your clients and collaborators'}</h2>
        <p>${has ? 'Pick someone from the list, or add a new customer.'
          : 'Keep everyone you work with in one place — contact details, what they paid you, their LinkedIn conversation, tasks and servers you run for them.'}</p>
        <button class="btn primary" data-cu="new">Add a customer</button>
      </div>`;
    return;
  }

  const yearAgo = addMonths(today(), -12);
  const allIncome = customerIncome(c.id);
  const yearIncome = customerIncome(c.id, yearAgo);
  const txs = customerTransactions(c.id);
  const lastPaid = txs.find((t) => t.type === 'income');
  const tasks = state.db.tasks.filter((t) => t.customerId === c.id && t.status !== 'done').sort(compareTasks);
  const assets = state.db.assets.filter((a) => a.customerId === c.id);
  const headline = c.role && c.company ? `${c.role} at ${c.company}` : c.company || c.role;
  const links = [];
  // click copies; the text shown is what gets copied
  const copyLink = (value, what) => `<a class="url-link" data-copy="${esc(value)}" title="Copy ${what}">${esc(value)}</a>`;
  if (c.email) links.push(copyLink(c.email, 'email'));
  if (c.phone) links.push(copyLink(c.phone, 'phone number'));
  if (c.website) links.push(copyLink(fullUrl(c.website), 'website'));
  if (c.linkedinUrl) links.push(copyLink(fullUrl(c.linkedinUrl), 'LinkedIn profile'));

  el.innerHTML = `
    <div class="thread-header">
      ${customerAvatar(c, 'sm')}
      <div class="thread-title">
        <div class="name">${esc(c.name)}</div>
        <div class="sub">${esc([CUSTOMER_KINDS[c.kind].label, c.status !== 'active' ? CUSTOMER_STATUS[c.status] : '', c.company].filter(Boolean).join(' · '))}</div>
      </div>
      <div class="thread-actions">
        <button class="btn ghost small" data-cu="income">+ Income</button>
        <button class="btn ghost small" data-cu="task">+ Task</button>
        <button class="icon-btn" data-cu="edit" title="Edit customer">${icon('edit')}</button>
        <button class="icon-btn" data-cu="delete" title="Delete customer">${icon('trash')}</button>
      </div>
    </div>
    <div class="detail-scroll">
      <div class="profile-card">
        <button type="button" class="avatar-btn" data-cu="photo" title="${c.avatarVersion ? 'Change photo' : 'Add a photo'}">
          ${customerAvatar(c, 'lg')}
          <span class="avatar-btn-overlay">${c.avatarVersion ? 'Change' : 'Add photo'}</span>
        </button>
        <div class="info">
          <div class="name">${esc(c.name)}</div>
          ${headline ? `<div class="headline">${esc(headline)}</div>` : ''}
          <div class="row">
            <span class="badge kind-${c.kind}">${CUSTOMER_KINDS[c.kind].label}</span>
            ${c.status !== 'active' ? `<span class="badge muted">${CUSTOMER_STATUS[c.status]}</span>` : ''}
            ${c.country ? `<span class="pill">${esc(c.country)}</span>` : ''}
            ${c.since ? `<span>Working together since ${esc(fmtDay(c.since, { full: true }))}</span>` : ''}
          </div>
          ${links.length ? `<div class="row links">${links.join('<span class="sep">·</span>')}</div>` : ''}
          ${tagsOf(c.tags).length ? `<div class="row">${tagsOf(c.tags).map((t) => `<span class="badge tag">${esc(t)}</span>`).join('')}</div>` : ''}
        </div>
      </div>

      <div class="boxes">
        <section class="box">
          <div class="box-head"><h3>Money</h3><button type="button" class="link-btn" data-cu="income">+ Add income</button></div>
          <div class="mini-stats">
            <div><span>Last 12 months</span><strong>${esc(fmtTotal(yearIncome.total))}</strong></div>
            <div><span>All time</span><strong>${esc(fmtTotal(allIncome.total))}</strong></div>
            <div><span>Last payment</span><strong>${lastPaid ? esc(fmtDay(lastPaid.date)) : '—'}</strong></div>
          </div>
          ${missingRatesNote([...new Set([...allIncome.missing])])}
          ${txs.length ? `<div class="mini-list">${txs.slice(0, 6).map(txMiniRowHtml).join('')}</div>
            ${txs.length > 6 ? `<button type="button" class="link-btn" data-cu="all-tx">See all ${txs.length} transactions</button>` : ''}`
            : '<div class="box-empty">No payments logged yet.</div>'}
        </section>

        <section class="box">
          <div class="box-head"><h3>Plan</h3><button type="button" class="link-btn" data-cu="task">+ Add task</button></div>
          ${tasks.length ? `<div class="mini-list">${tasks.map(taskMiniRowHtml).join('')}</div>` : '<div class="box-empty">No open tasks.</div>'}
        </section>

        <section class="box">
          <div class="box-head"><h3>Assets</h3><button type="button" class="link-btn" data-cu="asset">+ Add asset</button></div>
          ${assets.length ? `<div class="mini-list">${assets.map(assetMiniRowHtml).join('')}</div>`
            : '<div class="box-empty">Servers, domains or accounts you run for them show up here.</div>'}
        </section>

        ${c.notes ? `<section class="box wide"><div class="box-head"><h3>Notes</h3></div><div class="notes">${esc(c.notes)}</div></section>` : ''}
      </div>
    </div>`;
}

function txMiniRowHtml(t) {
  return `
    <button type="button" class="mini-row" data-tx="${esc(t.id)}">
      <span class="mini-date">${esc(fmtDay(t.date))}</span>
      <span class="mini-text">${esc(t.description || t.category || (t.type === 'income' ? 'Income' : 'Expense'))}</span>
      <span class="amount ${t.type}">${esc(fmtMoney(t.type === 'income' ? t.amount : -t.amount, t.currency, { sign: true }))}</span>
    </button>`;
}

function taskMiniRowHtml(t) {
  const due = t.dueDate ? daysFromToday(t.dueDate) : null;
  return `
    <div class="mini-row task-row" data-task="${esc(t.id)}">
      <button type="button" class="task-check" data-done="${esc(t.id)}" title="Mark as done"></button>
      <span class="mini-text">${esc(t.title)}</span>
      ${t.dueDate ? `<span class="due ${due < 0 ? 'late' : due <= 2 ? 'soon' : ''}">${esc(relDay(t.dueDate))}</span>` : ''}
    </div>`;
}

function assetMiniRowHtml(a) {
  const cat = ASSET_CATEGORIES[a.category];
  return `
    <button type="button" class="mini-row" data-open="asset:${esc(a.id)}">
      <span class="cat-icon sm" style="--cat:${cat.color}">${icon(cat.icon, 14)}</span>
      <span class="mini-text">${esc(a.name)}<small>${esc(cat.label)}</small></span>
      ${a.cost ? `<span class="mini-date">${esc(fmtMoney(a.cost, a.currency || baseCurrency()))}${esc(BILLING[a.billing].per)}</span>` : ''}
    </button>`;
}

// ---------- actions ----------

function selectCustomer(id) {
  cu.selectedId = id;
  renderCustomerList();
  renderCustomerDetail();
  $(`#cuList .contact[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

/** Open a customer from anywhere in the app. */
function showCustomer(id) {
  const c = byId('customer', id);
  if (!c) return;
  cu.selectedId = id;
  if (!matchesCustomerFilter(c) || !customerSearchMatch(c, cu.query)) {
    cu.filter = 'all';
    cu.query = '';
    if ($('#cuSearch')) $('#cuSearch').value = '';
  }
  showView('customers');
  $(`#cuList .contact[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

function customerPresetFromContact(contact) {
  return {
    name: contact.name,
    linkedinUrl: contact.linkedinUrl,
    country: contact.nationality,
    role: contact.headline,
    contactId: contact.id,
    kind: 'lead',
  };
}

function contactOptions(selectedId) {
  const list = [...state.db.contacts].sort((a, b) => a.name.localeCompare(b.name));
  return opt('', '— Not linked —', !selectedId) + list.map((x) => {
    const acct = multiAccount() ? accountById(x.accountId) : null;
    return opt(x.id, `${x.name}${acct ? ` (via ${acct.name})` : ''}`, x.id === selectedId);
  }).join('');
}

/**
 * New or edit. preset fills a new customer (e.g. from a LinkedIn contact).
 * Created from the LinkedIn section, you stay there.
 */
function openCustomerModal(existing = null, preset = {}, { focus = '' } = {}) {
  const c = existing || { kind: 'client', status: 'active', ...preset };
  const id = existing ? existing.id : uid();
  const fromLinkedIn = !existing && app.view === 'linkedin';
  let avatarEditor = null;
  openModal({
    title: existing ? 'Edit customer' : 'New customer',
    body: `
      ${avatarEditorHtml('Photo')}
      <div class="field-row">
        <div class="field">
          <label for="c-kind">Type</label>
          <select id="c-kind">${Object.entries(CUSTOMER_KINDS).map(([k, v]) => opt(k, v.label, c.kind === k)).join('')}</select>
        </div>
        <div class="field">
          <label for="c-status">Status</label>
          <select id="c-status">${Object.entries(CUSTOMER_STATUS).map(([k, v]) => opt(k, v, c.status === k)).join('')}</select>
        </div>
      </div>
      <div class="field">
        <label for="c-name">Name <span class="req">*</span></label>
        <input id="c-name" value="${esc(c.name)}" placeholder="Person or company name">
        <div class="error hidden" id="c-name-err">Please enter a name.</div>
      </div>
      <div class="field-row">
        <div class="field"><label for="c-company">Company</label><input id="c-company" value="${esc(c.company)}"></div>
        <div class="field"><label for="c-role">Role / what they do</label><input id="c-role" value="${esc(c.role)}" placeholder="e.g. CTO, Designer"></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="c-email">Email</label><input id="c-email" type="email" value="${esc(c.email)}" spellcheck="false"></div>
        <div class="field"><label for="c-phone">Phone / WhatsApp / Telegram</label><input id="c-phone" value="${esc(c.phone)}" spellcheck="false"></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="c-country">Country</label>
          <input id="c-country" value="${esc(c.country)}" list="nationalityList" placeholder="Start typing a country" autocomplete="off"></div>
        <div class="field"><label for="c-web">Website</label><input id="c-web" value="${esc(c.website)}" spellcheck="false"></div>
      </div>
      <div class="field">
        <label for="c-url">LinkedIn profile URL</label>
        <input id="c-url" value="${esc(c.linkedinUrl)}" placeholder="https://www.linkedin.com/in/…" spellcheck="false">
      </div>
      <div class="field">
        <label for="c-contact">LinkedIn conversation (from LinkedIn Messages)</label>
        <select id="c-contact">${contactOptions(c.contactId)}</select>
      </div>
      <div class="field-row">
        <div class="field"><label for="c-since">Working together since</label><input id="c-since" type="date" value="${esc(c.since)}"></div>
        <div class="field"><label for="c-tags">Tags (comma separated)</label><input id="c-tags" value="${esc(c.tags)}" placeholder="e.g. React, long-term, agency"></div>
      </div>
      <div class="field">
        <label for="c-notes">Notes</label>
        <textarea id="c-notes" rows="4" placeholder="Rates, agreements, preferences, anything to remember…">${esc(c.notes)}</textarea>
      </div>`,
    okText: existing ? 'Save' : 'Add customer',
    onOpen() {
      const nameInput = $('#c-name');
      const urlInput = $('#c-url');
      const contact = c.contactId ? contactById(c.contactId) : null;
      avatarEditor = setupAvatarEditor({
        seed: id,
        getName: () => nameInput.value.trim(),
        currentSrc: avatarSrc(id, existing?.avatarVersion) || (contact ? avatarSrc(contact.id, contact.avatarVersion) : null),
      });
      let autoName = !c.name;
      nameInput.addEventListener('input', () => { autoName = !nameInput.value.trim(); avatarEditor.redraw(); });
      urlInput.addEventListener('input', () => {
        if (autoName) nameInput.value = nameFromUrl(urlInput.value);
        // link the logged conversation with the same profile
        const n = normalizeUrl(urlInput.value);
        const match = n && state.db.contacts.find((x) => x.linkedinUrl && normalizeUrl(x.linkedinUrl) === n);
        if (match && !$('#c-contact').value) $('#c-contact').value = match.id;
        avatarEditor.redraw();
      });
      if (focus === 'contact') $('#c-contact').focus();
      else nameInput.focus();
    },
    async onOk() {
      const data = {
        kind: $('#c-kind').value,
        status: $('#c-status').value,
        name: $('#c-name').value.trim(),
        company: $('#c-company').value.trim(),
        role: $('#c-role').value.trim(),
        email: $('#c-email').value.trim(),
        phone: $('#c-phone').value.trim(),
        country: countryFromLegacyValue($('#c-country').value.trim()),
        website: $('#c-web').value.trim(),
        linkedinUrl: $('#c-url').value.trim(),
        contactId: $('#c-contact').value || null,
        since: $('#c-since').value,
        tags: tagsOf($('#c-tags').value).join(', '),
        notes: $('#c-notes').value.trim(),
      };
      $('#c-name-err').classList.toggle('hidden', !!data.name);
      if (!data.name) { $('#c-name').focus(); return false; }
      let stored;
      try {
        stored = await saveRec('customer', { ...(existing || {}), id, ...data });
        const v = await applyAvatar(id, avatarEditor.getPending());
        if (v !== undefined) stored.avatarVersion = v;
      } catch {
        return false;
      }
      if (fromLinkedIn) {
        refreshAll();
        toast(`${stored.name} added to customers`, { label: 'Open', fn: () => showCustomer(stored.id) });
      } else {
        cu.selectedId = stored.id;
        if (!existing) {
          cu.filter = 'all';
          cu.query = '';
          $('#cuSearch').value = '';
        }
        if (app.view === 'customers') refreshAll();
        else showCustomer(stored.id);
        toast(existing ? 'Customer updated' : 'Customer added');
      }
      return true;
    },
  });
}

function deleteCustomerDialog(c) {
  const txs = state.db.transactions.filter((t) => t.customerId === c.id).length;
  const tasks = state.db.tasks.filter((t) => t.customerId === c.id).length;
  const assets = state.db.assets.filter((a) => a.customerId === c.id).length;
  const linked = [[txs, 'transaction'], [tasks, 'task'], [assets, 'asset']].filter(([n]) => n).map(([n, w]) => plural(n, w));
  openModal({
    title: 'Delete customer?',
    body: `<p>This removes <strong>${esc(c.name)}</strong>.${linked.length
      ? ` Their ${linked.join(', ')} are kept, just no longer linked to them.` : ''}</p>
      <p class="help">Their LinkedIn conversation is not touched.</p>`,
    okText: 'Delete',
    danger: true,
    async onOk() {
      if (cu.selectedId === c.id) cu.selectedId = null;
      await deleteRec('customer', c, c.name);
      return true;
    },
  });
}

async function completeTask(id) {
  const t = byId('task', id);
  if (!t) return;
  try {
    await saveRec('task', { ...t, status: 'done' });
  } catch {
    return;
  }
  refreshAll();
  toast('Task done', {
    label: 'Undo',
    async fn() {
      await saveRec('task', { ...t });
      refreshAll();
    },
  });
}

function pickCustomerPhoto(c) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/bmp';
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const a = await imageToAvatar(file);
      c.avatarVersion = await dbCall('setAvatar', c.id, 'image/jpeg', a.bytes);
      refreshAll();
      toast('Photo updated');
    } catch (err) {
      if (err.message && !/remote method/.test(err.message)) toast(err.message);
    }
  });
  input.click();
}

// ---------- section ----------

registerView({
  id: 'customers',
  label: 'Customers',
  icon: 'customers',
  mount() {
    $('#view-customers').innerHTML = `
      <div class="layout">
        <section class="card messaging">
          <aside class="sidebar">
            <div class="sidebar-head">
              <h1>Customers</h1>
              <button class="icon-btn" id="cuNew" title="New customer (Ctrl+N)">${icon('plus', 22)}</button>
            </div>
            <div class="search-row">${searchBoxHtml('cuSearch', 'Search name, company, email, country, tags…')}</div>
            <div class="filters" id="cuFilters"></div>
            <ul class="contact-list" id="cuList"></ul>
          </aside>
          <section class="thread" id="cuDetail"></section>
        </section>
      </div>`;
    $('#cuNew').addEventListener('click', () => openCustomerModal());
    bindSearch($('#cuSearch'), (q) => {
      cu.query = q;
      renderCustomerList();
      const rows = visibleCustomers();
      if (q.trim() && rows.length && !rows.some((c) => c.id === cu.selectedId)) selectCustomer(rows[0].id);
    });
    $('#cuFilters').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      cu.filter = chip.dataset.filter;
      renderCustomers();
    });
    $('#cuList').addEventListener('click', (e) => {
      const li = e.target.closest('.contact');
      if (li) selectCustomer(li.dataset.id);
    });
    $('#cuList').addEventListener('keydown', (e) => {
      const li = e.target.closest('.contact');
      if (li && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        selectCustomer(li.dataset.id);
      }
    });
    $('#cuDetail').addEventListener('click', (e) => {
      const c = byId('customer', cu.selectedId);
      const done = e.target.closest('[data-done]');
      if (done) return completeTask(done.dataset.done);
      const link = e.target.closest('[data-href]');
      if (link) return window.api.openExternal(link.dataset.href);
      const cp = e.target.closest('[data-copy]');
      if (cp) return copyText(cp.dataset.copy, 'Copied');
      const tx = e.target.closest('[data-tx]');
      if (tx) return openTransactionModal(byId('transaction', tx.dataset.tx));
      const task = e.target.closest('[data-task]');
      if (task) return openTaskModal(byId('task', task.dataset.task));
      const btn = e.target.closest('[data-cu]');
      if (!btn) return;
      const action = btn.dataset.cu;
      if (action === 'new') return openCustomerModal();
      if (!c) return;
      if (action === 'edit') openCustomerModal(c);
      else if (action === 'delete') deleteCustomerDialog(c);
      else if (action === 'photo') pickCustomerPhoto(c);
      else if (action === 'income') openTransactionModal(null, { type: 'income', customerId: c.id });
      else if (action === 'task') openTaskModal(null, { customerId: c.id });
      else if (action === 'asset') openAssetModal(null, { customerId: c.id });
      else if (action === 'all-tx') showFinanceFor({ customerId: c.id });
    });
  },
  render() {
    if (cu.selectedId && !byId('customer', cu.selectedId)) cu.selectedId = null;
    if (!cu.selectedId) cu.selectedId = visibleCustomers()[0]?.id || null;
    renderCustomers();
  },
  reset() {
    cu.selectedId = null;
  },
  onNew: () => openCustomerModal(),
  focusSearch() {
    $('#cuSearch').focus();
    $('#cuSearch').select();
  },
  badge() {
    return null;
  },
});
