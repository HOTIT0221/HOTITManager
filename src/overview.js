'use strict';

// ============================================================
// Overview: this month at a glance, 12-month growth, what's coming up,
// goals, LinkedIn replies you're waiting for and your top clients.
// ============================================================

// chart series colours (validated for colour-blind separation; values are also in the tooltip and Finance)
const SERIES = { income: '#1d5bd6', expense: '#22a06b' };

function kpiHtml({ label, value, sub = '', tone = '', go = '', ico = null }) {
  return `
    <button type="button" class="kpi" ${go ? `data-open="view:${go}"` : ''}>
      <span class="kpi-label">${ico ? kpiIcon(...ico) : ''}${esc(label)}</span>
      <strong class="kpi-value ${tone}">${value}</strong>
      <span class="kpi-sub">${sub}</span>
    </button>`;
}

function deltaHtml(now, before) {
  if (!before) return '';
  const pct = Math.round(((now - before) / Math.abs(before)) * 100);
  if (!pct) return '<span class="delta">same as last month</span>';
  return `<span class="delta ${pct > 0 ? 'up' : 'down'}">${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs last month</span>`;
}

function monthTotals(key) {
  const from = `${key}-01`;
  const to = addDays(addMonths(from, 1), -1);
  const income = sumBase(transactionsBetween(from, to, 'income'));
  const expense = sumBase(transactionsBetween(from, to, 'expense'));
  return { key, income: income.total, expense: expense.total, net: income.total - expense.total, missing: [...income.missing, ...expense.missing] };
}

function renderOverview() {
  const el = $('#ovBody');
  const d = state.db;
  const empty = !d.customers.length && !d.assets.length && !d.transactions.length && !d.goals.length && !d.tasks.length;
  $('#ovDate').textContent = DAY_FMT.format(parseDay(today()));

  const months = lastMonths(12).map(monthTotals);
  const cur = months[11];
  const prev = months[10];
  const year = today().slice(0, 4);
  const ytd = sumBase(transactionsBetween(`${year}-01-01`, '9999-12-31', 'income')).total -
    sumBase(transactionsBetween(`${year}-01-01`, '9999-12-31', 'expense')).total;
  const clients = d.customers.filter((c) => c.kind === 'client' && c.status === 'active').length;
  const collaborators = d.customers.filter((c) => c.kind === 'collaborator' && c.status === 'active').length;
  const leads = d.customers.filter((c) => c.kind === 'lead' && c.status === 'active').length;
  const newThisMonth = d.customers.filter((c) => c.createdAt.slice(0, 7) === cur.key).length;
  const running = d.assets.map(monthlyCost);
  const runningTotal = running.filter((v) => v !== null).reduce((s, v) => s + v, 0);
  const paidAssets = d.assets.filter((a) => monthlyCost(a)).length;
  const balances = sumBase(d.assets.filter((a) => a.balance !== null && a.status !== 'closed'), (a) => a.balance, (a) => a.currency || baseCurrency());
  const missing = [...new Set([...months.flatMap((m) => m.missing), ...balances.missing])];

  const kpis = [
    kpiHtml({ label: `Income · ${fmtMonth(cur.key, { short: true })}`, value: esc(fmtTotal(cur.income)), sub: deltaHtml(cur.income, prev.income) || `Last month ${esc(fmtTotal(prev.income))}`, go: 'finance', ico: ['cash', 'green'] }),
    kpiHtml({ label: `Expenses · ${fmtMonth(cur.key, { short: true })}`, value: esc(fmtTotal(cur.expense)), sub: `Last month ${esc(fmtTotal(prev.expense))}`, go: 'finance', ico: ['receipt', 'red'] }),
    kpiHtml({ label: `Profit · ${fmtMonth(cur.key, { short: true })}`, value: esc(fmtTotal(cur.net)), tone: cur.net < 0 ? 'neg' : '', sub: `This year ${esc(fmtTotal(ytd))}`, go: 'finance', ico: ['trend', 'blue'] }),
    kpiHtml({ label: 'Active clients', value: String(clients), sub: [collaborators && plural(collaborators, 'collaborator'), leads && plural(leads, 'lead'), newThisMonth && `${newThisMonth} new this month`].filter(Boolean).join(' · ') || 'Add them in Customers', go: 'customers', ico: ['customers', 'blue'] }),
    kpiHtml({ label: 'Running costs', value: `${esc(fmtTotal(runningTotal))}<small>/mo</small>`, sub: paidAssets ? `${plural(paidAssets, 'paid asset')} · ${esc(fmtTotal(runningTotal * 12))}/yr` : 'Servers, domains, subscriptions', go: 'assets', ico: ['renew', 'purple'] }),
    kpiHtml({ label: 'Balances', value: esc(fmtTotal(balances.total)), sub: 'Bank and payment accounts', go: 'assets', ico: ['wallet', 'teal'] }),
  ];

  el.innerHTML = `
    ${empty ? onboardingHtml() : ''}
    <div class="kpis">${kpis.join('')}</div>
    ${missingRatesNote(missing)}
    <div class="ov-grid">
      <section class="card box span2">
        <div class="box-head">
          <h3>Growth · last 12 months</h3>
          <div class="legend">
            <span><i style="background:${SERIES.income}"></i>Income</span>
            <span><i style="background:${SERIES.expense}"></i>Expenses</span>
          </div>
        </div>
        <div class="chart" id="ovChart"></div>
        <div class="chart-foot">
          <span>12-month income <strong>${esc(fmtTotal(months.reduce((s, m) => s + m.income, 0)))}</strong></span>
          <span>Expenses <strong>${esc(fmtTotal(months.reduce((s, m) => s + m.expense, 0)))}</strong></span>
          <span>Profit <strong>${esc(fmtTotal(months.reduce((s, m) => s + m.net, 0)))}</strong></span>
          <span>Avg. per month <strong>${esc(fmtTotal(months.reduce((s, m) => s + m.net, 0) / 12))}</strong></span>
        </div>
      </section>
      <section class="card box">
        <div class="box-head"><h3>Coming up</h3></div>
        ${comingUpHtml()}
      </section>
      <section class="card box">
        <div class="box-head"><h3>Goals</h3><button type="button" class="link-btn" data-open="view:goals">All goals</button></div>
        ${goalsSummaryHtml()}
      </section>
      <section class="card box">
        <div class="box-head"><h3>LinkedIn · awaiting reply</h3><button type="button" class="link-btn" data-open="view:linkedin">Open</button></div>
        ${awaitingHtml()}
      </section>
      <section class="card box">
        <div class="box-head"><h3>Top clients · 12 months</h3><button type="button" class="link-btn" data-open="view:customers">Customers</button></div>
        ${topClientsHtml()}
      </section>
    </div>`;
  drawGrowthChart($('#ovChart'), months);
}

function onboardingHtml() {
  return `
    <section class="card onboarding">
      <h2>Welcome to HOTIT Manager</h2>
      <p>Your LinkedIn message log is in <a class="url-link" data-open="view:linkedin">LinkedIn</a>, as before. Start filling in the rest:</p>
      <div class="settings-buttons">
        <button class="btn secondary small" data-ov="customer">+ Add a client</button>
        <button class="btn secondary small" data-ov="asset">+ Add a server or account</button>
        <button class="btn secondary small" data-ov="income">+ Log income</button>
        <button class="btn secondary small" data-ov="goal">+ Set a goal</button>
        <button class="btn ghost small" data-open="settings-money">Choose your currency</button>
      </div>
    </section>`;
}

function comingUpHtml() {
  const items = [];
  for (const a of state.db.assets) {
    if (a.status !== 'active' || !a.renewsOn) continue;
    const n = daysFromToday(a.renewsOn);
    if (n <= 30) {
      items.push({ date: a.renewsOn, n, open: `asset:${a.id}`, icon: ASSET_CATEGORIES[a.category].icon,
        text: `${a.name} renews${a.cost ? ` · ${fmtMoney(a.cost, a.currency || baseCurrency())}` : ''}` });
    }
  }
  for (const t of state.db.tasks) {
    if (t.status === 'done' || !t.dueDate) continue;
    const n = daysFromToday(t.dueDate);
    if (n <= 7) items.push({ date: t.dueDate, n, task: t.id, icon: 'check', text: t.title });
  }
  for (const g of state.db.goals) {
    if (g.status !== 'active' || !g.dueDate) continue;
    const n = daysFromToday(g.dueDate);
    if (n <= 30) items.push({ date: g.dueDate, n, open: 'view:goals', icon: 'goals', text: `Goal: ${g.title} · ${Math.round(goalProgress(g).pct)}%` });
  }
  if (!items.length) return '<div class="box-empty">Nothing due in the next days. Renewals, task and goal deadlines show up here.</div>';
  items.sort((a, b) => a.date.localeCompare(b.date));
  return `<div class="mini-list">${items.slice(0, 8).map((i) => `
    <button type="button" class="mini-row" ${i.task ? `data-task="${esc(i.task)}"` : `data-open="${esc(i.open)}"`}>
      <span class="mini-icon">${icon(i.icon, 16)}</span>
      <span class="mini-text">${esc(i.text)}</span>
      <span class="due ${i.n < 0 ? 'late' : i.n <= 3 ? 'soon' : ''}">${esc(relDay(i.date))}</span>
    </button>`).join('')}</div>
    ${items.length > 8 ? `<div class="box-more">and ${items.length - 8} more</div>` : ''}`;
}

function goalsSummaryHtml() {
  const goals = state.db.goals.filter((g) => g.status === 'active')
    .sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  if (!goals.length) return '<div class="box-empty">No active goals.</div><button type="button" class="btn secondary small" data-ov="goal">+ Set a goal</button>';
  return goals.slice(0, 5).map((g) => {
    const p = goalProgress(g);
    return `
      <button type="button" class="goal-mini" data-open="view:goals">
        <span class="goal-mini-top"><strong>${esc(g.title)}</strong><span>${Math.round(p.pct)}%</span></span>
        <span class="progress"><span style="width:${p.pct.toFixed(1)}%"></span></span>
        <small>${esc(p.text)}${g.dueDate ? ` · due ${esc(fmtDay(g.dueDate))}` : ''}</small>
      </button>`;
  }).join('');
}

function awaitingHtml() {
  const index = buildIndex();
  const rows = state.db.contacts
    .map((c) => ({ c, msgs: index.get(c.id) || [] }))
    .filter((r) => contactStatus(r.msgs) === 'awaiting')
    .map((r) => ({ ...r, last: r.msgs[r.msgs.length - 1] }))
    .sort((a, b) => a.last.sentAt.localeCompare(b.last.sentAt));
  if (!rows.length) return '<div class="box-empty">Nobody owes you a reply.</div>';
  return `<div class="mini-list">${rows.slice(0, 6).map(({ c, last }) => `
    <button type="button" class="mini-row" data-open="conversation:${esc(c.id)}">
      ${contactAvatar(c, 'xs')}
      <span class="mini-text">${esc(c.name)}<small>${last.seenAt ? 'Seen, no reply' : 'Not seen yet'}</small></span>
      <span class="mini-date">${esc(ago(last.sentAt))}</span>
    </button>`).join('')}</div>
    ${rows.length > 6 ? `<div class="box-more">and ${rows.length - 6} more</div>` : ''}`;
}

function topClientsHtml() {
  const since = addMonths(today(), -12);
  const rows = state.db.customers
    .map((c) => ({ c, total: customerIncome(c.id, since).total }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);
  if (!rows.length) return '<div class="box-empty">Link income to a customer to see who brings in the most.</div>';
  const max = rows[0].total;
  return `<div class="mini-list">${rows.map(({ c, total }) => `
    <button type="button" class="mini-row top-client" data-open="customer:${esc(c.id)}">
      ${customerAvatar(c, 'xs')}
      <span class="mini-text">${esc(c.name)}<span class="bar"><span style="width:${((total / max) * 100).toFixed(1)}%"></span></span></span>
      <span class="mini-date">${esc(fmtTotal(total))}</span>
    </button>`).join('')}</div>`;
}

// ---------- growth chart: income vs expenses per month (grouped bars, one money axis) ----------

/** A rounded-top bar anchored to the baseline. */
function barPath(x, y, w, h, r = 4) {
  if (h <= 0) return '';
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/** Round the top of the axis up to 1, 2, 2.5 or 5 × a power of ten. */
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

function drawGrowthChart(el, months) {
  if (!months.some((m) => m.income || m.expense)) {
    el.innerHTML = '<div class="chart-empty">Log income and expenses in <a class="url-link" data-open="view:finance">Finance</a> to see how your business grows month by month.</div>';
    return;
  }
  const W = Math.max(320, el.clientWidth);
  const H = 240;
  const pad = { l: 56, r: 8, t: 10, b: 26 };
  const pw = W - pad.l - pad.r;
  const ph = H - pad.t - pad.b;
  const max = niceMax(Math.max(...months.flatMap((m) => [m.income, m.expense])));
  const y = (v) => pad.t + ph - (v / max) * ph;
  const gw = pw / months.length;
  const bw = Math.max(4, Math.min(12, (gw - 16) / 2));
  const tickFmt = (v) => fmtMoney(v, baseCurrency(), { compact: true });

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = max * f;
    return `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" class="${f ? 'grid' : 'axis'}"/>
      <text x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end" class="tick">${esc(tickFmt(v))}</text>`;
  }).join('');

  const bars = months.map((m, i) => {
    const cx = pad.l + gw * i + gw / 2;
    const xi = cx - bw - 1; // 2px gap between the pair
    const xe = cx + 1;
    const isNow = i === months.length - 1;
    return `
      <path d="${barPath(xi, y(m.income), bw, pad.t + ph - y(m.income))}" fill="${SERIES.income}"/>
      <path d="${barPath(xe, y(m.expense), bw, pad.t + ph - y(m.expense))}" fill="${SERIES.expense}"/>
      <text x="${cx}" y="${H - 8}" text-anchor="middle" class="tick ${isNow ? 'now' : ''}">${esc(fmtMonth(m.key, { short: true }))}</text>
      <rect x="${pad.l + gw * i}" y="${pad.t}" width="${gw}" height="${ph}" class="hit" data-i="${i}"/>`;
  }).join('');

  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img"
    aria-label="Income and expenses per month for the last 12 months">${grid}${bars}</svg>`;

  // hover: highlight the month and show its numbers
  const tip = $('#chartTip');
  const svg = $('svg', el);
  svg.addEventListener('mousemove', (e) => {
    const hit = e.target.closest('.hit');
    $$('.hit.on', svg).forEach((h) => h !== hit && h.classList.remove('on'));
    if (!hit) { tip.classList.add('hidden'); return; }
    hit.classList.add('on');
    const m = months[Number(hit.dataset.i)];
    tip.innerHTML = `
      <strong>${esc(fmtMonth(m.key))}</strong>
      <span><i style="background:${SERIES.income}"></i>Income <b>${esc(fmtTotal(m.income))}</b></span>
      <span><i style="background:${SERIES.expense}"></i>Expenses <b>${esc(fmtTotal(m.expense))}</b></span>
      <span class="tip-net">Profit <b>${esc(fmtTotal(m.net))}</b></span>`;
    tip.classList.remove('hidden');
    const r = hit.getBoundingClientRect();
    const tw = tip.offsetWidth;
    let left = r.right + 8;
    if (left + tw > window.innerWidth - 8) left = r.left - tw - 8;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, e.clientY - tip.offsetHeight / 2)}px`;
  });
  svg.addEventListener('mouseleave', () => {
    tip.classList.add('hidden');
    $$('.hit.on', svg).forEach((h) => h.classList.remove('on'));
  });
  svg.addEventListener('click', () => {
    tip.classList.add('hidden');
    showView('finance');
  });
}

// ---------- section ----------

registerView({
  id: 'overview',
  label: 'Overview',
  icon: 'overview',
  mount() {
    $('#view-overview').innerHTML = `
      <div class="page">
        <div class="page-head">
          <h1>Overview</h1>
          <span class="page-date" id="ovDate"></span>
          <div class="page-actions">
            <button class="btn ghost small" data-ov="task">+ Task</button>
            <button class="btn secondary small" data-ov="expense">− Expense</button>
            <button class="btn primary small" data-ov="income">+ Income</button>
          </div>
        </div>
        <div id="ovBody"></div>
      </div>`;
    $('#view-overview').addEventListener('click', (e) => {
      const task = e.target.closest('[data-task]');
      if (task) return openTaskModal(byId('task', task.dataset.task));
      const b = e.target.closest('[data-ov]');
      if (!b) return;
      const action = b.dataset.ov;
      if (action === 'income' || action === 'expense') openTransactionModal(null, { type: action });
      else if (action === 'task') openTaskModal();
      else if (action === 'customer') openCustomerModal();
      else if (action === 'asset') openAssetModal();
      else if (action === 'goal') openGoalModal();
    });
    let timer = null;
    window.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (app.view === 'overview') renderOverview(); }, 150);
    });
  },
  render() {
    renderOverview();
  },
  onNew: () => openTransactionModal(null, { type: 'income' }),
  focusSearch() {},
});
