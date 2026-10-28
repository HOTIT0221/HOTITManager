'use strict';

// ============================================================
// Goals & Plans: goals with progress (counted from your data where possible)
// and the plan — a To do / In progress / Done board of tasks.
// ============================================================

const GOAL_METRICS = {
  income: { label: 'Income', help: 'Income received between the start and due date', money: true },
  profit: { label: 'Profit', help: 'Income minus expenses between the start and due date', money: true },
  clients: { label: 'Active clients', help: 'Number of clients with status Active' },
  tasks: { label: 'Tasks done', help: 'Progress = tasks linked to this goal that are done' },
  custom: { label: 'Something else', help: 'You update the progress yourself' },
};
const GOAL_STATUS = { active: 'Active', achieved: 'Achieved', dropped: 'Dropped' };
const TASK_STATUS = { todo: 'To do', doing: 'In progress', done: 'Done' };
const TASK_PRIORITY = { high: 'High', normal: 'Normal', low: 'Low' };
const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };

const go = { showClosedGoals: false, goalFilter: '', showOldDone: false };

/** { value, target, pct, text } — how far a goal is. */
function goalProgress(g) {
  const from = g.startDate || '';
  const to = g.dueDate || '9999-12-31';
  let value = g.current;
  let target = g.target;
  let missing = [];
  if (g.metric === 'income' || g.metric === 'profit') {
    const inc = sumBase(transactionsBetween(from, to, 'income'));
    const exp = g.metric === 'profit' ? sumBase(transactionsBetween(from, to, 'expense')) : { total: 0, missing: [] };
    value = inc.total - exp.total;
    missing = [...new Set([...inc.missing, ...exp.missing])];
  } else if (g.metric === 'clients') {
    value = state.db.customers.filter((c) => c.kind === 'client' && c.status === 'active').length;
  } else if (g.metric === 'tasks') {
    const tasks = state.db.tasks.filter((t) => t.goalId === g.id);
    value = tasks.filter((t) => t.status === 'done').length;
    target = tasks.length;
  }
  const pct = target > 0 ? Math.max(0, Math.min(100, (value / target) * 100)) : 0;
  const fmt = (n) => (GOAL_METRICS[g.metric].money ? fmtTotal(n) : new Intl.NumberFormat().format(n));
  let text = `${fmt(value)} of ${fmt(target)}${g.metric === 'custom' && g.unit ? ` ${g.unit}` : ''}`;
  if (g.metric === 'tasks') text = target ? `${value} of ${plural(target, 'task')} done` : 'No tasks linked yet';
  return { value, target, pct, text, missing };
}

function compareTasks(a, b) {
  return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
    (a.dueDate || '9999').localeCompare(b.dueDate || '9999') ||
    a.createdAt.localeCompare(b.createdAt);
}

// ---------- rendering ----------

function renderGoals() {
  const goals = state.db.goals
    .filter((g) => go.showClosedGoals || g.status === 'active')
    .sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) ||
      (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || a.createdAt.localeCompare(b.createdAt));
  const closed = state.db.goals.filter((g) => g.status !== 'active').length;
  $('#goClosedToggle').classList.toggle('hidden', !closed);
  $('#goClosedToggle').textContent = go.showClosedGoals ? 'Hide achieved & dropped' : `Show achieved & dropped (${closed})`;

  $('#goGoals').innerHTML = goals.length ? goals.map(goalCardHtml).join('') : `
    <div class="goal-card empty">
      <strong>Set your first goal</strong>
      <span>e.g. “$10,000 income this quarter”, “5 active clients”, or “Launch the new website”.</span>
      <button class="btn secondary small" data-go="new-goal">+ Add goal</button>
    </div>`;

  // goal filter for the board
  const active = state.db.goals.filter((g) => g.status === 'active' || g.id === go.goalFilter);
  if (go.goalFilter && !byId('goal', go.goalFilter)) go.goalFilter = '';
  $('#goBoardFilter').innerHTML = opt('', 'All tasks', !go.goalFilter) +
    active.map((g) => opt(g.id, `Goal: ${g.title}`, g.id === go.goalFilter)).join('');
  renderBoard();
}

function goalCardHtml(g) {
  const p = goalProgress(g);
  const reached = p.target > 0 && p.value >= p.target;
  const dueIn = g.dueDate ? daysFromToday(g.dueDate) : null;
  const due = g.dueDate
    ? `<span class="due ${g.status === 'active' && dueIn < 0 ? 'late' : g.status === 'active' && dueIn <= 14 ? 'soon' : ''}">
        Due ${esc(fmtDay(g.dueDate))}${g.status === 'active' ? ` · ${dueIn < 0 ? `${-dueIn} days late` : dueIn === 0 ? 'today' : `${dueIn} days left`}` : ''}</span>`
    : '';
  const tasks = state.db.tasks.filter((t) => t.goalId === g.id);
  const open = tasks.filter((t) => t.status !== 'done').length;
  return `
    <div class="goal-card ${g.status}" data-goal="${esc(g.id)}" tabindex="0">
      <div class="goal-top">
        <strong class="goal-title">${esc(g.title)}</strong>
        ${g.status !== 'active' ? `<span class="badge ${g.status === 'achieved' ? 'replied' : 'muted'}">${GOAL_STATUS[g.status]}</span>`
          : reached ? '<span class="badge replied">Target reached</span>' : ''}
      </div>
      <div class="goal-metric">${esc(GOAL_METRICS[g.metric].label)}${g.startDate ? ` · since ${esc(fmtDay(g.startDate))}` : ''}</div>
      <div class="progress" role="progressbar" aria-valuenow="${Math.round(p.pct)}" aria-valuemin="0" aria-valuemax="100">
        <span style="width:${p.pct.toFixed(1)}%"></span>
      </div>
      <div class="goal-nums"><span>${esc(p.text)}</span><strong>${Math.round(p.pct)}%</strong></div>
      ${p.missing.length ? `<div class="warn-text small">Not counted: ${esc(p.missing.join(', '))} (no rate)</div>` : ''}
      <div class="goal-foot">
        ${due}
        ${tasks.length ? `<span>${open ? `${plural(open, 'open task')}` : 'All tasks done'}</span>` : ''}
        <span class="goal-actions">
          ${g.metric === 'custom' && g.status === 'active' ? '<button type="button" class="link-btn" data-go="progress">Update</button>' : ''}
          ${reached && g.status === 'active' ? '<button type="button" class="link-btn" data-go="achieved">Mark achieved</button>' : ''}
          <button type="button" class="link-btn" data-go="add-task">+ Task</button>
        </span>
      </div>
    </div>`;
}

function renderBoard() {
  const tasks = state.db.tasks.filter((t) => !go.goalFilter || t.goalId === go.goalFilter);
  const cutoff = addDays(today(), -14);
  $('#goBoard').innerHTML = Object.entries(TASK_STATUS).map(([status, label]) => {
    let list = tasks.filter((t) => t.status === status);
    let hidden = 0;
    if (status === 'done') {
      list.sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));
      if (!go.showOldDone) {
        const recent = list.filter((t) => (t.doneAt || '').slice(0, 10) >= cutoff);
        hidden = list.length - recent.length;
        list = recent;
      }
    } else {
      list.sort(compareTasks);
    }
    return `
      <div class="column" data-status="${status}">
        <div class="column-head"><span>${label}</span><span class="count">${tasks.filter((t) => t.status === status).length}</span></div>
        <div class="column-body">
          ${list.map(taskCardHtml).join('')}
          ${status !== 'done' ? `<button type="button" class="add-card" data-go="add:${status}">+ Add task</button>` : ''}
          ${hidden ? `<button type="button" class="link-btn" data-go="old-done">Show ${hidden} older</button>` : ''}
          ${status === 'done' && go.showOldDone ? '<button type="button" class="link-btn" data-go="old-done">Show only the last 2 weeks</button>' : ''}
        </div>
      </div>`;
  }).join('');
}

function taskCardHtml(t) {
  const goal = byId('goal', t.goalId);
  const cust = byId('customer', t.customerId);
  const dueIn = t.dueDate ? daysFromToday(t.dueDate) : null;
  const done = t.status === 'done';
  return `
    <div class="task-card prio-${t.priority} ${done ? 'done' : ''}" draggable="true" data-task="${esc(t.id)}" tabindex="0">
      <button type="button" class="task-check ${done ? 'checked' : ''}" data-check="${esc(t.id)}"
        title="${done ? 'Mark as not done' : 'Mark as done'}">${done ? icon('check', 14) : ''}</button>
      <div class="task-body">
        <div class="task-title">${esc(t.title)}</div>
        <div class="task-meta">
          ${t.priority === 'high' ? '<span class="badge late">High</span>' : ''}
          ${t.dueDate && !done ? `<span class="due ${dueIn < 0 ? 'late' : dueIn <= 2 ? 'soon' : ''}">${esc(dueIn < 0 || dueIn > 6 ? fmtDay(t.dueDate) : relDay(t.dueDate))}</span>` : ''}
          ${done && t.doneAt ? `<span>Done ${esc(fmtDay(t.doneAt.slice(0, 10)))}</span>` : ''}
          ${goal && !go.goalFilter ? `<span class="badge tag" title="Goal">${esc(goal.title)}</span>` : ''}
          ${cust ? `<span class="badge kind-${cust.kind}" title="Customer">${esc(cust.name)}</span>` : ''}
        </div>
      </div>
    </div>`;
}

// ---------- dialogs ----------

function openGoalModal(existing = null) {
  const g = existing || {
    metric: 'income', status: 'active', target: 0, current: 0, unit: '',
    startDate: `${today().slice(0, 7)}-01`, dueDate: '', title: '', description: '',
  };
  const id = existing ? existing.id : uid();
  openModal({
    title: existing ? 'Edit goal' : 'New goal',
    body: `
      <div class="field">
        <label for="g-title">Goal <span class="req">*</span></label>
        <input id="g-title" value="${esc(g.title)}" placeholder="e.g. Reach $10k monthly income">
        <div class="error hidden" id="g-title-err">Please name your goal.</div>
      </div>
      <div class="field">
        <label for="g-metric">Measure progress by</label>
        <select id="g-metric">${Object.entries(GOAL_METRICS).map(([k, v]) => opt(k, v.label, g.metric === k)).join('')}</select>
        <div class="help" id="g-metric-help"></div>
      </div>
      <div class="field-row">
        <div class="field" id="g-target-field"><label for="g-target" id="g-target-label">Target</label>
          <input id="g-target" inputmode="decimal" value="${g.target ? esc(String(g.target)) : ''}">
          <div class="error hidden" id="g-target-err">Please enter a target above zero.</div></div>
        <div class="field" id="g-current-field"><label for="g-current">Progress so far</label>
          <input id="g-current" inputmode="decimal" value="${esc(String(g.current || 0))}"></div>
        <div class="field" id="g-unit-field"><label for="g-unit">Unit</label>
          <input id="g-unit" value="${esc(g.unit)}" placeholder="e.g. projects, %"></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="g-start">Start</label><input id="g-start" type="date" value="${esc(g.startDate)}"></div>
        <div class="field"><label for="g-due">Due</label><input id="g-due" type="date" value="${esc(g.dueDate)}"></div>
        ${existing ? `<div class="field"><label for="g-status">Status</label>
          <select id="g-status">${Object.entries(GOAL_STATUS).map(([k, v]) => opt(k, v, g.status === k)).join('')}</select></div>` : ''}
      </div>
      <div class="field">
        <label for="g-desc">Why / how</label>
        <textarea id="g-desc" rows="3" placeholder="What reaching it means, and the plan to get there…">${esc(g.description)}</textarea>
      </div>
      ${existing ? '<button type="button" class="btn ghost small danger-text" id="g-delete">Delete goal</button>' : ''}`,
    okText: existing ? 'Save' : 'Add goal',
    onOpen() {
      const update = () => {
        const m = $('#g-metric').value;
        $('#g-metric-help').textContent = GOAL_METRICS[m].help;
        $('#g-target-field').classList.toggle('hidden', m === 'tasks');
        $('#g-current-field').classList.toggle('hidden', m !== 'custom');
        $('#g-unit-field').classList.toggle('hidden', m !== 'custom');
        $('#g-target-label').textContent = GOAL_METRICS[m].money ? `Target (${baseCurrency()})` : 'Target';
      };
      $('#g-metric').addEventListener('change', update);
      update();
      $('#g-delete')?.addEventListener('click', () => {
        closeModal();
        deleteRec('goal', existing, existing.title);
      });
      $('#g-title').focus();
    },
    async onOk() {
      const metric = $('#g-metric').value;
      const target = metric === 'tasks' ? 0 : parseAmount($('#g-target').value);
      const data = {
        title: $('#g-title').value.trim(),
        metric,
        target,
        current: metric === 'custom' ? parseAmount($('#g-current').value) || 0 : g.current || 0,
        unit: metric === 'custom' ? $('#g-unit').value.trim() : '',
        startDate: $('#g-start').value,
        dueDate: $('#g-due').value,
        status: existing ? $('#g-status').value : 'active',
        description: $('#g-desc').value.trim(),
        position: g.position || 0,
      };
      const badTarget = metric !== 'tasks' && !(target > 0);
      $('#g-title-err').classList.toggle('hidden', !!data.title);
      $('#g-target-err').classList.toggle('hidden', !badTarget);
      if (!data.title) { $('#g-title').focus(); return false; }
      if (badTarget) { $('#g-target').focus(); return false; }
      try {
        await saveRec('goal', { ...(existing || {}), id, ...data });
      } catch {
        return false;
      }
      refreshAll();
      toast(existing ? 'Goal updated' : 'Goal added');
      return true;
    },
  });
}

function updateProgressDialog(g) {
  openModal({
    title: g.title,
    body: `
      <div class="field">
        <label for="p-current">Progress so far${g.unit ? ` (${esc(g.unit)})` : ''} — target ${esc(new Intl.NumberFormat().format(g.target))}</label>
        <input id="p-current" inputmode="decimal" value="${esc(String(g.current))}">
      </div>`,
    okText: 'Save',
    onOpen() {
      $('#p-current').focus();
      $('#p-current').select();
    },
    async onOk() {
      const n = parseAmount($('#p-current').value);
      if (n === null || Number.isNaN(n)) { $('#p-current').focus(); return false; }
      try {
        await saveRec('goal', { ...g, current: n });
      } catch {
        return false;
      }
      refreshAll();
      return true;
    },
  });
}

function goalOptions(selectedId) {
  const list = state.db.goals.filter((g) => g.status === 'active' || g.id === selectedId);
  return opt('', '— None —', !selectedId) + list.map((g) => opt(g.id, g.title, g.id === selectedId)).join('');
}

/** New or edit. preset fills a new task ({ status, goalId, customerId }). */
function openTaskModal(existing = null, preset = {}) {
  const t = existing || { title: '', status: 'todo', priority: 'normal', dueDate: '', notes: '', goalId: go.goalFilter || null, ...preset };
  const id = existing ? existing.id : uid();
  openModal({
    title: existing ? 'Edit task' : 'New task',
    body: `
      <div class="field">
        <label for="k-title">Task <span class="req">*</span></label>
        <input id="k-title" value="${esc(t.title)}" placeholder="e.g. Send proposal to Acme">
        <div class="error hidden" id="k-title-err">Please describe the task.</div>
      </div>
      <div class="field-row">
        <div class="field"><label for="k-status">Status</label>
          <select id="k-status">${Object.entries(TASK_STATUS).map(([k, v]) => opt(k, v, t.status === k)).join('')}</select></div>
        <div class="field"><label for="k-prio">Priority</label>
          <select id="k-prio">${Object.entries(TASK_PRIORITY).map(([k, v]) => opt(k, v, t.priority === k)).join('')}</select></div>
        <div class="field"><label for="k-due">Due</label><input id="k-due" type="date" value="${esc(t.dueDate)}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="k-goal">Goal</label><select id="k-goal">${goalOptions(t.goalId)}</select></div>
        <div class="field"><label for="k-customer">Customer</label><select id="k-customer">${customerOptions(t.customerId)}</select></div>
      </div>
      <div class="field">
        <label for="k-notes">Notes</label>
        <textarea id="k-notes" rows="3">${esc(t.notes)}</textarea>
      </div>
      ${existing ? '<button type="button" class="btn ghost small danger-text" id="k-delete">Delete task</button>' : ''}`,
    okText: existing ? 'Save' : 'Add task',
    onOpen() {
      $('#k-delete')?.addEventListener('click', () => {
        closeModal();
        deleteRec('task', existing, existing.title);
      });
      $('#k-title').focus();
    },
    async onOk() {
      const data = {
        title: $('#k-title').value.trim(),
        status: $('#k-status').value,
        priority: $('#k-prio').value,
        dueDate: $('#k-due').value,
        goalId: $('#k-goal').value || null,
        customerId: $('#k-customer').value || null,
        notes: $('#k-notes').value.trim(),
        position: t.position || 0,
      };
      $('#k-title-err').classList.toggle('hidden', !!data.title);
      if (!data.title) { $('#k-title').focus(); return false; }
      try {
        await saveRec('task', { ...(existing || {}), id, ...data });
      } catch {
        return false;
      }
      refreshAll();
      toast(existing ? 'Task updated' : 'Task added');
      return true;
    },
  });
}

async function setTaskStatus(id, status) {
  const t = byId('task', id);
  if (!t || t.status === status) return;
  try {
    await saveRec('task', { ...t, status });
  } catch {
    return;
  }
  refreshAll();
}

// ---------- section ----------

registerView({
  id: 'goals',
  label: 'Goals & Plans',
  short: 'Goals',
  icon: 'goals',
  mount() {
    $('#view-goals').innerHTML = `
      <div class="page">
        <div class="page-head">
          <h1>Goals &amp; Plans</h1>
          <div class="page-actions">
            <button class="btn secondary" data-go="new-goal">+ Add goal</button>
            <button class="btn primary" data-go="add:todo">+ Add task</button>
          </div>
        </div>
        <div class="section-head">
          <h2>Goals</h2>
          <button type="button" class="link-btn" id="goClosedToggle"></button>
        </div>
        <div class="goal-grid" id="goGoals"></div>
        <div class="section-head">
          <h2>Plan</h2>
          <select id="goBoardFilter" class="select"></select>
          <span class="help">Drag tasks between columns, or tick them off.</span>
        </div>
        <div class="board" id="goBoard"></div>
      </div>`;
    const view = $('#view-goals');
    $('#goClosedToggle').addEventListener('click', () => { go.showClosedGoals = !go.showClosedGoals; renderGoals(); });
    $('#goBoardFilter').addEventListener('change', (e) => { go.goalFilter = e.target.value; renderBoard(); });
    view.addEventListener('click', (e) => {
      const check = e.target.closest('[data-check]');
      if (check) {
        const t = byId('task', check.dataset.check);
        if (t) setTaskStatus(t.id, t.status === 'done' ? 'todo' : 'done');
        return;
      }
      const b = e.target.closest('[data-go]');
      const card = e.target.closest('[data-goal]');
      const goal = card ? byId('goal', card.dataset.goal) : null;
      if (b) {
        const [action, arg] = b.dataset.go.split(':');
        if (action === 'new-goal') openGoalModal();
        else if (action === 'add') openTaskModal(null, { status: arg || 'todo' });
        else if (action === 'old-done') { go.showOldDone = !go.showOldDone; renderBoard(); }
        else if (action === 'progress' && goal) updateProgressDialog(goal);
        else if (action === 'add-task' && goal) openTaskModal(null, { goalId: goal.id });
        else if (action === 'achieved' && goal) {
          saveRec('goal', { ...goal, status: 'achieved' }).then(() => { refreshAll(); toast('Goal achieved — well done!'); }).catch(() => {});
        }
        return;
      }
      if (goal) return openGoalModal(goal);
      const task = e.target.closest('[data-task]');
      if (task) openTaskModal(byId('task', task.dataset.task));
    });
    view.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const card = e.target.closest('[data-goal]');
      if (card && e.target === card) openGoalModal(byId('goal', card.dataset.goal));
      const task = e.target.closest('[data-task]');
      if (task && e.target === task) openTaskModal(byId('task', task.dataset.task));
    });

    // drag tasks between columns
    const board = $('#goBoard');
    board.addEventListener('dragstart', (e) => {
      const card = e.target.closest('[data-task]');
      if (!card) return;
      e.dataTransfer.setData('text/x-task', card.dataset.task);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    board.addEventListener('dragend', () => $$('.task-card.dragging, .column.drop', board).forEach((x) => x.classList.remove('dragging', 'drop')));
    board.addEventListener('dragover', (e) => {
      const col = e.target.closest('.column');
      if (!col || ![...e.dataTransfer.types].includes('text/x-task')) return;
      e.preventDefault();
      $$('.column.drop', board).forEach((x) => x !== col && x.classList.remove('drop'));
      col.classList.add('drop');
    });
    board.addEventListener('drop', (e) => {
      const col = e.target.closest('.column');
      const id = e.dataTransfer.getData('text/x-task');
      if (!col || !id) return;
      e.preventDefault();
      e.stopPropagation(); // the window-wide drop guard would otherwise swallow it
      setTaskStatus(id, col.dataset.status);
    });
  },
  render() {
    renderGoals();
  },
  onNew: () => openTaskModal(),
  focusSearch() {},
  badge() {
    const late = state.db.tasks.filter((t) => t.status !== 'done' && t.dueDate && daysFromToday(t.dueDate) < 0).length;
    const dueToday = state.db.tasks.filter((t) => t.status !== 'done' && t.dueDate && daysFromToday(t.dueDate) === 0).length;
    return { n: late + dueToday, tone: late ? 'late' : 'soon', title: `${late} overdue, ${dueToday} due today` };
  },
});
