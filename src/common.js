'use strict';

// Helpers every section shares: dialogs, toasts, photos, the app clock and Settings.
// The navigation and start-up live in shell.js.

// ============================================================
// State
// ============================================================

const state = {
  db: { settings: {} }, // everything from the database (window.api.load())
};

// Country list comes from countries.js (COUNTRIES). Lookup by name, for search and suggestions.
const COUNTRY_BY_NAME = new Map(COUNTRIES.map((c) => [c.name.toLowerCase(), c]));

/** Text to search for a stored country: its name plus nationality and other names ("Germany|German|Deutschland"). */
function countrySearchText(value) {
  const c = COUNTRY_BY_NAME.get(String(value || '').toLowerCase());
  return c ? [c.name, c.demonym, ...c.aliases].join('|') : String(value || '');
}

const AVATAR_COLORS = ['#1d5bd6', '#15803d', '#b45309', '#9a5b4c', '#6d4fc2', '#c2410c', '#0e7490', '#475569', '#a16207', '#9333ea'];

// ============================================================
// Helpers
// ============================================================

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function uid() {
  return crypto.randomUUID();
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fullUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

/** "https://www.linkedin.com/in/john-smith-4a2b91/" -> "John Smith" */
function nameFromUrl(u) {
  const m = String(u || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return '';
  let slug = m[1];
  try { slug = decodeURIComponent(slug); } catch { /* ignore */ }
  const parts = slug.split('-').filter(Boolean);
  while (parts.length > 1 && /\d/.test(parts[parts.length - 1])) parts.pop();
  if (parts.some((p) => /\d/.test(p))) return '';
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

function initials(name) {
  // first letter of the first and last word, ignoring brackets/punctuation: "James (Recruiting)" -> "JR"
  const words = String(name || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) || [];
  if (!words.length) return '?';
  const first = [...words[0]][0];
  const last = words.length > 1 ? [...words[words.length - 1]][0] : '';
  return (first + last).toUpperCase();
}

function avatarColor(seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function avatarHtml(name, seed, size = '', src = null) {
  const inner = src ? `<img src="${esc(src)}" alt="" draggable="false">` : esc(initials(name));
  return `<div class="avatar ${size}" style="background:${avatarColor(seed)}">${inner}</div>`;
}

function avatarSrc(ownerId, version) {
  return version ? `avatar://img/${encodeURIComponent(ownerId)}?v=${encodeURIComponent(version)}` : null;
}

/** Square-crop an image (biased toward the top, where faces usually are) and encode as JPEG. */
async function imageToAvatar(blob) {
  if (!blob || !/^image\//.test(blob.type)) throw new Error('Please choose an image file.');
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    throw new Error('That image could not be read.');
  }
  const SIZE = 320;
  const s = Math.min(bmp.width, bmp.height);
  const sx = (bmp.width - s) / 2;
  const sy = (bmp.height - s) * 0.3;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, sx, sy, s, s, 0, 0, SIZE, SIZE);
  bmp.close();
  const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  return { bytes: new Uint8Array(await out.arrayBuffer()), url: URL.createObjectURL(out) };
}

/**
 * Wires up the photo picker inside a dialog. Returns getPending():
 * undefined = unchanged, 'remove' = delete photo, { bytes } = new photo.
 */
function setupAvatarEditor({ seed, getName, currentSrc }) {
  let pending;
  let previewUrl = currentSrc;
  const box = $('#av-preview');
  const removeBtn = $('#av-remove');
  const draw = () => {
    box.innerHTML = avatarHtml(getName() || '?', seed, 'xl', previewUrl);
    removeBtn.classList.toggle('hidden', !previewUrl);
  };
  const use = async (blob) => {
    try {
      const a = await imageToAvatar(blob);
      pending = { bytes: a.bytes };
      previewUrl = a.url;
      draw();
    } catch (err) {
      toast(err.message);
    }
  };
  const onPaste = (e) => {
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (file) {
      e.preventDefault();
      use(file);
    }
  };

  $('#av-pick').addEventListener('click', () => $('#av-file').click());
  box.addEventListener('click', () => $('#av-file').click());
  $('#av-file').addEventListener('change', (e) => {
    if (e.target.files[0]) use(e.target.files[0]);
    e.target.value = '';
  });
  removeBtn.addEventListener('click', () => {
    pending = 'remove';
    previewUrl = null;
    draw();
  });
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drag'); });
  box.addEventListener('dragleave', () => box.classList.remove('drag'));
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('drag');
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
    if (file) use(file);
  });
  document.addEventListener('paste', onPaste);
  modalCleanup.push(() => document.removeEventListener('paste', onPaste));
  draw();

  return { getPending: () => pending, redraw: draw };
}

function avatarEditorHtml(label = 'Profile photo') {
  return `
    <div class="field avatar-edit">
      <div class="avatar-drop" id="av-preview" title="Click, drop or paste a photo"></div>
      <div class="avatar-edit-side">
        <label>${esc(label)}</label>
        <div class="avatar-edit-actions">
          <button type="button" class="btn secondary small" id="av-pick">Upload photo</button>
          <button type="button" class="btn ghost small hidden" id="av-remove">Remove</button>
        </div>
        <div class="help">Or drag an image here, or right-click a profile photo on LinkedIn → <em>Copy image</em>, then press <kbd>Ctrl</kbd> + <kbd>V</kbd>.</div>
      </div>
      <input type="file" id="av-file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden>
    </div>`;
}

/** Save a pending photo change. Returns the new version, null if removed, undefined if unchanged. */
async function applyAvatar(ownerId, pending) {
  if (pending === 'remove') {
    await dbCall('removeAvatar', ownerId);
    return null;
  }
  if (pending && pending.bytes) return dbCall('setAvatar', ownerId, 'image/jpeg', pending.bytes);
  return undefined;
}

function pad(n) { return String(n).padStart(2, '0'); }

// ---------- app clock ----------
// Messages are stored as exact moments (UTC). How they are shown, and what "Now" means, follows the
// app's clock setting: the computer's time zone (''), an offset from the computer ('rel:-180' =
// 3 hours behind), or a named time zone such as 'America/New_York'.

const clock = { setting: '', zone: undefined, shiftMs: 0 };
let formatters = {};

function applyClock(setting) {
  setting = setting || '';
  clock.setting = '';
  clock.zone = undefined;
  clock.shiftMs = 0;
  if (setting.startsWith('rel:')) {
    const minutes = Number(setting.slice(4));
    if (Number.isFinite(minutes)) {
      clock.setting = setting;
      clock.shiftMs = minutes * 60000;
    }
  } else if (setting) {
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: setting });
      clock.setting = setting;
      clock.zone = setting;
    } catch {
      // unknown zone: fall back to computer time
    }
  }
  const make = (opts) => new Intl.DateTimeFormat(undefined, { ...opts, timeZone: clock.zone });
  formatters = {
    time: make({ hour: 'numeric', minute: '2-digit' }),
    weekday: make({ weekday: 'short' }),
    weekdayLong: make({ weekday: 'long' }),
    monthDay: make({ month: 'short', day: 'numeric' }),
    fullDate: make({ month: 'short', day: 'numeric', year: 'numeric' }),
    longDate: make({ weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }),
    parts: make({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
  };
}
applyClock('');

/** The moment to hand to a formatter (moved by the offset when the clock is "N hours from computer"). */
function shifted(date) {
  return new Date(new Date(date).getTime() + clock.shiftMs);
}

const fmtTime = (d) => formatters.time.format(shifted(d));
const fmtLongDate = (d) => formatters.longDate.format(shifted(d));

/** Year/month/day/hour/minute of a moment, as shown on the app clock. */
function wallParts(date) {
  const p = {};
  for (const { type, value } of formatters.parts.formatToParts(shifted(date))) p[type] = Number(value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour % 24, mi: p.minute };
}

/** Value for a datetime-local input, in app-clock time. */
function toLocalInput(date) {
  const w = wallParts(date);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`;
}

/** Inverse of toLocalInput: app-clock wall time -> Date. Returns an invalid Date for bad input. */
function fromLocalInput(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value || '');
  if (!m) return new Date(NaN);
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (!clock.zone) return new Date(new Date(y, mo - 1, d, h, mi).getTime() - clock.shiftMs);
  // named zone: guess, measure how far the zone's wall clock is off, correct (twice for DST edges)
  const target = Date.UTC(y, mo - 1, d, h, mi);
  let t = target;
  for (let i = 0; i < 2; i++) {
    const w = wallParts(t);
    t += target - Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi);
  }
  return new Date(t);
}

/** Whole calendar days from b to a, on the app clock. */
function dayDiff(a, b) {
  const wa = wallParts(a);
  const wb = wallParts(b);
  return Math.round((Date.UTC(wa.y, wa.m - 1, wa.d) - Date.UTC(wb.y, wb.m - 1, wb.d)) / 86400000);
}

function sameYear(a, b) {
  return wallParts(a).y === wallParts(b).y;
}

/** Minutes the app clock is ahead (+) or behind (-) the computer clock right now. */
function clockDifferenceMinutes(at = new Date()) {
  const w = wallParts(at);
  const appWall = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi);
  const pcWall = Date.UTC(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes());
  return Math.round((appWall - pcWall) / 60000);
}

function describeMinutes(min) {
  if (!min) return 'same as computer';
  const h = Math.floor(Math.abs(min) / 60);
  const m = Math.abs(min) % 60;
  const amount = `${h ? `${h} hour${h === 1 ? '' : 's'}` : ''}${h && m ? ' ' : ''}${m ? `${m} min` : ''}`;
  return `${amount} ${min < 0 ? 'behind' : 'ahead of'} computer`;
}

/** Short tag shown next to "Date & time" when the app clock differs from the computer. */
function clockTag() {
  if (!clock.setting) return '';
  const diff = clockDifferenceMinutes();
  if (clock.zone) return `${clock.zone.split('/').pop().replace(/_/g, ' ')}${diff ? ` · ${describeMinutes(diff)}` : ''}`;
  return describeMinutes(diff);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ============================================================
// Data access
// ============================================================

/** Write to the database. On failure, reload from disk so the screen never shows unsaved data. */
async function dbCall(op, ...args) {
  try {
    return await window.api.db(op, ...args);
  } catch (err) {
    const msg = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    toast(`Could not save: ${msg}`);
    state.db = await window.api.load();
    refreshAll();
    throw err;
  }
}

function refreshNationalities() {
  // every country, plus any custom values already used; the label lets "German" or "USA" find the country
  const used = state.db.customers.map((c) => c.country).filter(Boolean);
  const all = [...new Set([...COUNTRIES.map((c) => c.name), ...used])].sort((a, b) => a.localeCompare(b));
  $('#nationalityList').innerHTML = all.map((name) => {
    const c = COUNTRY_BY_NAME.get(name.toLowerCase());
    const label = c ? [c.demonym, ...c.aliases].filter((x) => x && x !== name).join(', ') : '';
    return label ? `<option value="${esc(name)}" label="${esc(label)}">` : `<option value="${esc(name)}">`;
  }).join('');
}

// ============================================================
// Settings
// ============================================================

function openSettings({ focusClock = false, focusMoney = false } = {}) {
  let startup = null; // { supported, enabled, minimized } from the main process
  let readAppearance = null;
  let applyCurrency = null; // restates the exchange rates when the main currency was changed
  const s = state.db.settings;
  openModal({
    title: 'Settings',
    body: `
      ${appearanceFieldHtml()}
      <div class="field">
        <label for="s-clock">App clock (used by “today”, due dates and renewals)</label>
        <select id="s-clock">${clockOptionsHtml(clock.setting)}</select>
        <div class="clock-preview" id="s-clock-preview"></div>
      </div>
      <div class="field" id="s-money">
        <label for="s-currency">Main currency (totals, charts and goals are shown in it)</label>
        <input id="s-currency" class="currency-input" list="currencyList" value="${esc(baseCurrency())}" maxlength="6"
          autocomplete="off" spellcheck="false">
      </div>
      <div class="field">
        <label>Exchange rates</label>
        <div class="rates" id="s-rates"></div>
        <div class="help warn hidden" id="s-rates-note"></div>
        <div class="rate-add">
          <input id="s-rate-new" class="currency-input" list="currencyList" placeholder="e.g. EUR" maxlength="6" autocomplete="off">
          <button type="button" class="btn ghost small" id="s-rate-add">Add currency</button>
        </div>
        <div class="help">Amounts in other currencies are converted with these rates for totals and charts.
          Each amount is still stored in its own currency, so you can update a rate at any time.</div>
      </div>
      <div class="field startup-field">
        <label>Windows startup</label>
        <label class="check"><input type="checkbox" id="s-startup" disabled> Run automatically when Windows starts</label>
        <label class="check sub"><input type="checkbox" id="s-startup-min" disabled> Start minimized to the taskbar</label>
        <div class="help" id="s-startup-help"></div>
      </div>
      <div class="field">
        <label>Database</label>
        <div class="db-path" title="${esc(state.db.file || '')}">${esc(state.db.file || '')}</div>
        <div class="settings-buttons">
          <button type="button" class="btn secondary small" id="s-move">Change location…</button>
          <button type="button" class="btn ghost small" id="s-folder">Show in folder</button>
        </div>
        <div class="help">Every change is saved to this database file immediately. To keep it safe even if this PC breaks,
          move it into a folder that syncs to the cloud (OneDrive, Dropbox, Google Drive).</div>
      </div>
      ${securityFieldHtml()}
      <div class="field">
        <label>Backups</label>
        <div class="settings-buttons">
          <button type="button" class="btn secondary small" id="s-export">Export backup…</button>
          <button type="button" class="btn secondary small" id="s-import">Import backup…</button>
          <button type="button" class="btn ghost small" id="s-backups">Open backups folder</button>
        </div>
        <div class="help">A copy is made automatically every day (last 30 kept) and every month (kept forever).
          Deleted records can be recovered from these copies.</div>
      </div>`,
    okText: 'Save',
    onOpen() {
      readAppearance = setupAppearanceField();
      applyCurrency = setupRatesEditor();
      const preview = () => { $('#s-clock-preview').innerHTML = clockPreviewHtml($('#s-clock').value); };
      $('#s-clock').addEventListener('change', preview);
      preview();
      const timer = setInterval(preview, 15000);
      modalCleanup.push(() => clearInterval(timer));
      window.api.getStartup().then((st) => {
        startup = st;
        const on = $('#s-startup');
        const min = $('#s-startup-min');
        if (!on) return; // dialog already closed
        on.checked = st.enabled;
        min.checked = st.minimized;
        on.disabled = !st.supported;
        min.disabled = !st.supported || !st.enabled;
        on.addEventListener('change', () => { min.disabled = !on.checked; });
        $('#s-startup-help').textContent = st.supported
          ? 'The app opens when you sign in to Windows. You can also turn this off in Windows Settings → Apps → Startup.'
          : 'Available in the installed or portable app (not when running from source).';
      });
      $('#s-move').addEventListener('click', () => { closeModal(); window.api.moveDatabase(); });
      $('#s-folder').addEventListener('click', () => window.api.openDataFolder());
      $('#s-export').addEventListener('click', () => window.api.exportBackup());
      $('#s-import').addEventListener('click', () => { closeModal(); window.api.importBackup(); });
      $('#s-backups').addEventListener('click', () => window.api.openBackupsFolder());
      setupSecurityField();
      if (focusClock) $('#s-clock').focus();
      if (focusMoney) {
        $('#s-money').scrollIntoView({ block: 'start' });
        $('#s-currency').focus();
      }
    },
    async onOk() {
      const timeZone = $('#s-clock').value;
      if (startup && startup.supported) {
        const enabled = $('#s-startup').checked;
        const minimized = enabled && $('#s-startup-min').checked;
        if (enabled !== startup.enabled || minimized !== startup.minimized) {
          const now = await window.api.setStartup({ enabled, minimized });
          if (now.enabled !== enabled) toast('Windows did not accept the startup setting.');
        }
      }
      const currency = cleanCurrency($('#s-currency').value);
      if (!/^[A-Z0-9]{2,6}$/.test(currency)) {
        $('#s-currency').focus();
        toast('Please enter a currency code such as USD or EUR.');
        return false;
      }
      applyCurrency(); // (in case Save was pressed straight after typing it)
      const rates = readRates();
      delete rates[currency];
      try {
        await dbCall('setSetting', 'timeZone', timeZone);
        await dbCall('setSetting', 'baseCurrency', currency);
        await dbCall('setSetting', 'fxRates', rates);
      } catch {
        return false;
      }
      try {
        saveAppearance(readAppearance());
      } catch {
        toast('That background picture is too large to keep. Choose a smaller one.');
        return false;
      }
      const clockChanged = timeZone !== clock.setting;
      Object.assign(s, { timeZone, baseCurrency: currency, fxRates: rates });
      applyClock(timeZone);
      refreshAll();
      if (clockChanged) toast(timeZone ? `App clock: ${clockTag()}` : 'App clock now follows your computer');
      return true;
    },
  });
}

function utcOffsetLabel(zone, at = new Date()) {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(at).find((p) => p.type === 'timeZoneName').value; // "GMT-05:00" or "GMT"
    return name === 'GMT' ? 'UTC±00:00' : name.replace('GMT', 'UTC').replace('-', '−');
  } catch {
    return '';
  }
}

function offsetMinutesOf(zone, at = new Date()) {
  const m = /([+−])(\d{2}):(\d{2})/.exec(utcOffsetLabel(zone, at));
  return m ? (m[1] === '−' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

function clockOptionsHtml(current) {
  const opt = (value, label) => `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`;
  const pcZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const relative = [];
  for (let min = -12 * 60; min <= 12 * 60; min += 30) {
    if (min) relative.push(opt(`rel:${min}`, describeMinutes(min).replace('computer', 'my computer')));
  }

  let zones = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = [pcZone, 'UTC'];
  }
  if (current && !current.startsWith('rel:') && !zones.includes(current)) zones.push(current);
  const named = zones
    .map((z) => ({ z, off: offsetMinutesOf(z), label: utcOffsetLabel(z) }))
    .sort((a, b) => a.off - b.off || a.z.localeCompare(b.z))
    .map(({ z, label }) => opt(z, `(${label}) ${z.replace(/_/g, ' ')}`));

  return `
    ${opt('', `My computer's time (${pcZone.replace(/_/g, ' ')})`)}
    <optgroup label="Hours from my computer's time">${relative.join('')}</optgroup>
    <optgroup label="A time zone (follows daylight saving)">${named.join('')}</optgroup>`;
}

/** "App time now: … · Computer: …" for a setting that has not been saved yet. */
function clockPreviewHtml(setting) {
  const saved = clock.setting;
  applyClock(setting);
  const now = new Date();
  const app = `${fmtLongDate(now)} ${fmtTime(now)}`;
  const diff = clockDifferenceMinutes(now);
  applyClock(saved);
  const pc = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(now);
  return `App time now: <strong>${esc(app)}</strong><br>Computer time: ${esc(pc)}` +
    (diff ? ` <span class="clock-tag">${esc(describeMinutes(diff))}</span>` : '');
}

function showShortcuts() {
  const rows = [
    ['Ctrl + Shift + 1 … 6', 'Go to Overview, Customers, Assets, Finance, Goals & Plans, Notes'],
    ['Ctrl + N', 'New customer / asset / transaction / task / note (in the section you are in)'],
    ['Ctrl + F', 'Search'],
    ['Esc', 'Clear search / close dialog'],
    ['Ctrl + Enter', 'Save dialog'],
    ['Ctrl + = / Ctrl + −', 'Zoom in / out'],
  ];
  openModal({
    title: 'Keyboard shortcuts',
    body: `<table class="kbd-table">${rows.map(([k, v]) =>
      `<tr><td>${k.split(' / ').map((p) => p.split(' + ').map((x) => `<kbd>${esc(x)}</kbd>`).join(' + ')).join(' / ')}</td><td>${esc(v)}</td></tr>`).join('')}</table>`,
    okText: 'Close',
    hideCancel: true,
    onOk: () => true,
  });
}

// ============================================================
// Modal + toast
// ============================================================

let modalOk = null;
let modalCleanup = [];

function openModal({ title, body, okText = 'Save', danger = false, hideCancel = false, onOpen, onOk }) {
  runModalCleanup();
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  const ok = $('#modalOk');
  ok.textContent = okText;
  ok.className = `btn ${danger ? 'danger' : 'primary'}`;
  $('#modalCancel').classList.toggle('hidden', hideCancel);
  modalOk = onOk;
  $('#modal').showModal();
  if (onOpen) onOpen();
  else ok.focus();
}

function closeModal() {
  modalOk = null;
  if ($('#modal').open) $('#modal').close();
  runModalCleanup();
}

function runModalCleanup() {
  for (const fn of modalCleanup.splice(0)) fn();
}

let toastTimer = null;
function toast(text, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(text)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) {
    $('button', el).addEventListener('click', () => {
      el.classList.remove('show');
      action.fn();
    });
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 7000 : 2500);
}

// ============================================================
// Events
// ============================================================

function bindCommonEvents() {
  $('#btnSettings').addEventListener('click', () => openSettings());

  // modal
  let modalBusy = false;
  $('#modalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (modalBusy) return;
    modalBusy = true;
    $('#modalOk').disabled = true;
    try {
      if (modalOk && (await modalOk()) === false) return;
      closeModal();
    } finally {
      modalBusy = false;
      $('#modalOk').disabled = false;
    }
  });
  $('#modalCancel').addEventListener('click', closeModal);
  $('#modalClose').addEventListener('click', closeModal);
  $('#modal').addEventListener('close', () => {
    // (this event arrives a moment after closing: if another dialog was opened since, leave it alone)
    if ($('#modal').open) return;
    modalOk = null;
    runModalCleanup();
  });

  // stop a dropped file from replacing the whole window
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());
  // Ctrl+Enter saves even from a textarea in a dialog
  $('#modal').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      $('#modalForm').requestSubmit();
    }
  });
}
