'use strict';

// ============================================================
// Notes: text you use again and again (replies, intros, proposal paragraphs), saved under a
// title. Copy puts the whole text on the clipboard. Pinned notes stay at the top.
// ============================================================

const nt = { query: '', tag: '' };

function noteTags() {
  return [...new Set(state.db.notes.map((n) => n.tag).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function visibleNotes() {
  return state.db.notes
    .filter((n) => !nt.tag || n.tag === nt.tag)
    .filter((n) => matchQ(nt.query, n.title, n.text, n.tag))
    .sort((a, b) => b.pinned - a.pinned || a.title.localeCompare(b.title));
}

// ---------- rendering ----------

function renderNotes() {
  const tags = noteTags();
  if (nt.tag && !tags.includes(nt.tag)) nt.tag = '';
  $('#ntTags').innerHTML = tags.length
    ? [['', 'All'], ...tags.map((t) => [t, t])].map(([v, label]) =>
      `<button class="chip ${v === nt.tag ? 'active' : ''}" data-tag="${esc(v)}">${esc(label)}</button>`).join('')
    : '';

  const list = visibleNotes();
  if (!state.db.notes.length) {
    $('#ntList').innerHTML = `
      <div class="goal-card empty">
        <strong>Save text you use often</strong>
        <span>e.g. a LinkedIn intro, a reply to “what are your rates?”, your bank details for invoices, or a proposal
          paragraph. Then copy it with one click whenever you need it.</span>
        <button class="btn secondary small" data-nt="new">+ Add note</button>
      </div>`;
    return;
  }
  $('#ntList').innerHTML = list.length
    ? list.map(noteCardHtml).join('')
    : '<div class="list-empty">No notes match your search.</div>';
}

function noteCardHtml(n) {
  return `
    <div class="note-card ${n.pinned ? 'pinned' : ''}" data-note="${esc(n.id)}" tabindex="0" title="Click to edit">
      <div class="note-top">
        <strong class="note-title">${hlq(n.title, nt.query)}</strong>
        <button type="button" class="icon-btn tiny note-pin ${n.pinned ? 'on' : ''}" data-pin="${esc(n.id)}"
          title="${n.pinned ? 'Unpin' : 'Pin to the top'}">${icon('pin', 16)}</button>
      </div>
      ${n.tag ? `<span class="badge tag">${hlq(n.tag, nt.query)}</span>` : ''}
      <div class="note-text">${n.text ? hlq(n.text, nt.query) : '<span class="help">No text yet</span>'}</div>
      <div class="note-foot">
        <span>${esc(plural([...n.text].length, 'character'))}</span>
        <button type="button" class="btn primary small" data-copy="${esc(n.id)}" ${n.text ? '' : 'disabled'}>
          ${icon('copy', 14)} Copy</button>
      </div>
    </div>`;
}

// ---------- dialog ----------

function openNoteModal(existing = null) {
  const n = existing || { title: '', text: '', tag: nt.tag, pinned: 0 };
  const id = existing ? existing.id : uid();
  openModal({
    title: existing ? 'Edit note' : 'New note',
    body: `
      <div class="field-row">
        <div class="field"><label for="n-title">Title <span class="req">*</span></label>
          <input id="n-title" value="${esc(n.title)}" placeholder="e.g. LinkedIn intro">
          <div class="error hidden" id="n-title-err">Please give the note a title.</div></div>
        <div class="field"><label for="n-tag">Tag</label>
          <input id="n-tag" value="${esc(n.tag)}" list="noteTagList" placeholder="e.g. LinkedIn, Email, Proposal">
          <datalist id="noteTagList">${noteTags().map((t) => `<option value="${esc(t)}">`).join('')}</datalist></div>
      </div>
      <div class="field">
        <label for="n-text">Text</label>
        <textarea id="n-text" rows="12" class="note-input" placeholder="The text you want to copy…">${esc(n.text)}</textarea>
      </div>
      <label class="check"><input type="checkbox" id="n-pinned" ${n.pinned ? 'checked' : ''}> Pin to the top</label>
      ${existing ? '<button type="button" class="btn ghost small danger-text" id="n-delete">Delete note</button>' : ''}`,
    okText: existing ? 'Save' : 'Add note',
    onOpen() {
      $('#n-delete')?.addEventListener('click', () => {
        confirmDeleteRec('note', existing, existing.title, { what: 'note' });
      });
      $('#n-title').focus();
    },
    async onOk() {
      const data = {
        title: $('#n-title').value.trim(),
        tag: $('#n-tag').value.trim(),
        text: $('#n-text').value, // kept as typed: spaces and blank lines are part of the text
        pinned: $('#n-pinned').checked ? 1 : 0,
      };
      $('#n-title-err').classList.toggle('hidden', !!data.title);
      if (!data.title) { $('#n-title').focus(); return false; }
      try {
        await saveRec('note', { ...(existing || {}), id, ...data });
      } catch {
        return false;
      }
      refreshAll();
      toast(existing ? 'Note updated' : 'Note added');
      return true;
    },
  });
}

async function toggleNotePin(n) {
  try {
    await saveRec('note', { ...n, pinned: n.pinned ? 0 : 1 });
  } catch {
    return;
  }
  refreshAll();
}

// ---------- section ----------

registerView({
  id: 'notes',
  label: 'Notes',
  icon: 'notes',
  mount() {
    $('#view-notes').innerHTML = `
      <div class="page">
        <div class="page-head">
          <h1>Notes</h1>
          <div class="page-actions">
            <button class="btn primary" data-nt="new">+ Add note</button>
          </div>
        </div>
        <div class="toolbar">
          <div class="filters inline" id="ntTags"></div>
          <div class="grow">${searchBoxHtml('ntSearch', 'Search titles and text…')}</div>
        </div>
        <div class="note-grid" id="ntList"></div>
      </div>`;
    bindSearch($('#ntSearch'), (q) => { nt.query = q; renderNotes(); });
    const view = $('#view-notes');
    view.addEventListener('click', (e) => {
      const tag = e.target.closest('[data-tag]');
      if (tag) {
        nt.tag = tag.dataset.tag;
        renderNotes();
        return;
      }
      if (e.target.closest('[data-nt="new"]')) return openNoteModal();
      const copy = e.target.closest('[data-copy]');
      if (copy) {
        const n = byId('note', copy.dataset.copy);
        if (n) copyText(n.text, `“${n.title}” copied`);
        return;
      }
      const pin = e.target.closest('[data-pin]');
      if (pin) {
        const n = byId('note', pin.dataset.pin);
        if (n) toggleNotePin(n);
        return;
      }
      if (window.getSelection().toString()) return; // selecting part of the text, not opening the note
      const card = e.target.closest('[data-note]');
      if (card) openNoteModal(byId('note', card.dataset.note));
    });
    view.addEventListener('keydown', (e) => {
      const card = e.target.closest('[data-note]');
      if (!card || e.target !== card) return;
      const n = byId('note', card.dataset.note);
      if (e.key === 'Enter') openNoteModal(n);
      if (e.key === 'c' && (e.ctrlKey || e.metaKey) && n.text) {
        e.preventDefault();
        copyText(n.text, `“${n.title}” copied`);
      }
    });
  },
  render() {
    renderNotes();
  },
  reset() {
    nt.tag = '';
  },
  onNew: () => openNoteModal(),
  focusSearch() {
    $('#ntSearch').focus();
    $('#ntSearch').select();
  },
});
