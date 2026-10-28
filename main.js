'use strict';

const {
  app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol, clipboard, ClipboardItem, nativeImage, nativeTheme,
} = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./db');
const vault = require('./vault');
const cryptfile = require('./cryptfile');
const totp = require('./totp');

const APP_NAME = 'IT Business Manager'; // internal name: data folder and startup entry, don't change
const DISPLAY_NAME = 'HOTIT Manager'; // the name shown to the user
const LEGACY_APP_NAME = 'LinkedIn Message Tracker'; // this app's name before version 3

/**
 * The app used to be called "LinkedIn Message Tracker" and kept its data in a folder of that name.
 * On the first start under the new name, copy that folder's contents over (the old folder is left
 * untouched as an extra safety copy).
 */
function migrateLegacyUserDir() {
  const dir = app.getPath('userData');
  const legacy = path.join(app.getPath('appData'), LEGACY_APP_NAME);
  if (path.resolve(dir) === path.resolve(legacy) || !fs.existsSync(legacy)) return;
  if (['tracker.db', 'config.json'].some((f) => fs.existsSync(path.join(dir, f)))) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['tracker.db', 'config.json', 'window.json', 'data.json', 'backups', 'Local Storage']) {
      const from = path.join(legacy, name);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, name), { recursive: true, errorOnExist: false });
    }
    fs.writeFileSync(path.join(legacy, 'MOVED - see IT Business Manager folder.txt'),
      `This app is now called ${APP_NAME}. Its data was copied to:\r\n${dir}\r\n\r\n` +
      'This folder is an old copy and is no longer used. You can delete it once you have checked your data.\r\n', 'utf8');
  } catch (err) {
    console.error('Could not copy the old data folder:', err);
  }
}
migrateLegacyUserDir();

const USER_DIR = app.getPath('userData');
const CONFIG_FILE = path.join(USER_DIR, 'config.json');
const DEFAULT_DB_FILE = path.join(USER_DIR, 'tracker.db');
const LEGACY_JSON_FILE = path.join(USER_DIR, 'data.json');
const BACKUP_DIR = path.join(USER_DIR, 'backups');
const WINDOW_FILE = path.join(USER_DIR, 'window.json');
const KEYS_FILE = path.join(USER_DIR, 'keys.json');
const MAX_DAILY_BACKUPS = 30;

let win = null;

// Images are served from the database through avatar://img/<ownerId> and attachment://file/<id>
protocol.registerSchemesAsPrivileged([
  { scheme: 'avatar', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'attachment', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// ---------- config + database ----------

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

// Before an older database is upgraded to a new structure, keep a copy of it as it was.
const DB_OPEN_OPTIONS = {
  onUpgrade(oldVersion) {
    try {
      snapshotBefore(`upgrade-from-v${oldVersion}`);
    } catch (err) {
      console.error('Pre-upgrade backup failed:', err);
    }
  },
};

function configuredDbFile() {
  return readConfig().dbPath || DEFAULT_DB_FILE;
}

/**
 * Open the configured database. An encrypted one opens straight away if this PC remembers its key;
 * otherwise it stays locked until the password is entered on the lock screen (security:unlock).
 */
async function openDatabase() {
  const cfg = readConfig();
  let file = configuredDbFile();
  try {
    if (await openFile(file)) afterOpen();
  } catch (err) {
    if (cryptfile.isEncrypted(file)) return; // the lock screen shows the problem
    dialog.showErrorBox('Could not open database',
      `${file}\n\n${err.message}\n\nFalling back to the default location.`);
    file = DEFAULT_DB_FILE;
    writeConfig({ ...cfg, dbPath: undefined });
    if (await openFile(file)) afterOpen();
  }
}

/** Open a database file if possible without asking for a password. Returns false if it needs one. */
async function openFile(file) {
  if (!cryptfile.isEncrypted(file)) {
    store.open(file, DB_OPEN_OPTIONS);
    return true;
  }
  const { id } = cryptfile.readHeader(file);
  const open = store.encryption();
  const key = open && open.header.id === id ? open.key : await recallKey(id);
  if (!key) return false;
  store.open(file, { ...DB_OPEN_OPTIONS, key });
  return true;
}

function afterOpen() {
  migrateLegacyJson();
  runBackups();
}

// ---------- encryption keys remembered on this PC ----------
//
// "Remember on this PC" keeps the database's data key in keys.json, itself encrypted with Windows
// DPAPI for your Windows account (vault.js). The app then opens without asking for the password,
// while a copy of the database file alone (or the backups) stays unreadable elsewhere.

function readKeys() {
  try {
    return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeKeys(keys) {
  fs.mkdirSync(USER_DIR, { recursive: true });
  cryptfile.writeFileAtomic(KEYS_FILE, JSON.stringify(keys, null, 2));
}

async function recallKey(id) {
  const saved = readKeys()[id];
  if (!saved) return null;
  try {
    const key = Buffer.from(await vault.unprotect(Buffer.from(saved, 'base64')), 'base64');
    return key.length === 32 ? key : null;
  } catch {
    return null; // saved by another Windows user: ask for the password instead
  }
}

async function rememberKey(id, key) {
  const enc = await vault.protect(key.toString('base64'));
  writeKeys({ ...readKeys(), [id]: enc.toString('base64') });
}

function forgetKey(id) {
  const keys = readKeys();
  if (!(id in keys)) return;
  delete keys[id];
  writeKeys(keys);
}

function securityState() {
  const enc = store.encryption();
  if (!store.isOpen()) return { status: 'locked', file: configuredDbFile() };
  return {
    status: enc ? 'encrypted' : 'plain',
    file: store.currentFile(),
    remembered: !!(enc && readKeys()[enc.header.id]),
  };
}

const MIN_PASSWORD = 8;

function checkNewPassword(password) {
  if (typeof password !== 'string' || [...password].length < MIN_PASSWORD) {
    throw new Error(`Please use a password of at least ${MIN_PASSWORD} characters.`);
  }
}

/** Old backups (and the default database file if another location is in use) are encrypted too. */
function encryptPlainCopies() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.db$/i.test(e.name)) files.push(p);
    }
  };
  if (fs.existsSync(BACKUP_DIR)) walk(BACKUP_DIR);
  if (path.resolve(DEFAULT_DB_FILE) !== path.resolve(store.currentFile())) files.push(DEFAULT_DB_FILE);
  let done = 0;
  const failed = [];
  for (const f of files) {
    try {
      if (fs.existsSync(f) && store.encryptCopy(f)) done++;
    } catch (err) {
      failed.push(`${f}: ${err.message}`);
    }
  }
  return { done, failed };
}

const SECURITY_OPS = {
  state: () => securityState(),

  /** Lock screen: open the configured encrypted database with its password. */
  async unlock(password, remember) {
    if (store.isOpen()) return { ok: true };
    const file = configuredDbFile();
    let key;
    try {
      key = await cryptfile.unlock(cryptfile.readHeader(file), password);
    } catch (err) {
      return { ok: false, error: err.code === 'WRONG_PASSWORD' ? 'That password is not right.' : err.message };
    }
    try {
      store.open(file, { ...DB_OPEN_OPTIONS, key });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const { id } = store.encryption().header;
    try {
      if (remember) await rememberKey(id, key);
      else forgetKey(id);
    } catch (err) {
      console.error('Could not remember the key:', err);
    }
    afterOpen();
    return { ok: true };
  },

  /** Lock screen: use a different database file instead. */
  async pickFile() {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Open a database',
      properties: ['openFile'],
      filters: [{ name: 'HOTIT Manager database', extensions: ['db'] }],
    });
    if (canceled || !filePaths.length) return securityState();
    writeConfig({ ...readConfig(), dbPath: filePaths[0] });
    try {
      if (await openFile(filePaths[0])) afterOpen();
    } catch (err) {
      if (!cryptfile.isEncrypted(filePaths[0])) dialog.showErrorBox('Could not open database', `${filePaths[0]}\n\n${err.message}`);
    }
    return securityState();
  },

  async encrypt(password, remember) {
    checkNewPassword(password);
    if (store.encryption()) throw new Error('The database is already encrypted.');
    // (no plain backup is made first: that would leave an unencrypted copy behind; instead the
    // encrypted copy is checked before it replaces the plain file, see store.encryptWith)
    const { key, header } = await cryptfile.create(password);
    store.encryptWith(key, header);
    if (remember) await rememberKey(header.id, key);
    const copies = encryptPlainCopies();
    return { ...securityState(), copies };
  },

  async changePassword(current, next) {
    checkNewPassword(next);
    const enc = store.encryption();
    if (!enc) throw new Error('The database is not encrypted.');
    try {
      await cryptfile.unlock(enc.header, current);
    } catch {
      return { ok: false, error: 'Your current password is not right.' };
    }
    store.setHeader(await cryptfile.rewrap(enc.header, enc.key, next));
    return { ok: true, ...securityState() };
  },

  async setRemember(remember) {
    const enc = store.encryption();
    if (!enc) return securityState();
    if (remember) await rememberKey(enc.header.id, enc.key);
    else forgetKey(enc.header.id);
    return securityState();
  },
};

// ---------- saving an encrypted database ----------

let saveTimer = null;
let saveErrorShown = false;

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    store.save();
    saveErrorShown = false;
  } catch (err) {
    console.error('Save failed:', err);
    scheduleSave(5000); // try again: the file may be briefly locked by a sync tool
    if (!saveErrorShown && win) {
      saveErrorShown = true;
      dialog.showMessageBox(win, {
        type: 'error',
        message: 'Your changes could not be saved to the database file.',
        detail: `${store.currentFile()}\n\n${err.message}\n\nThe app keeps trying. Keep it open until this is fixed (for example, check the drive is connected and has free space).`,
      });
    }
  }
}

function scheduleSave(delay = 250) {
  if (!saveTimer) saveTimer = setTimeout(saveNow, delay);
}

/** One-time import of data saved by version 1.0 (data.json). */
function migrateLegacyJson() {
  if (!fs.existsSync(LEGACY_JSON_FILE) || store.counts().contacts > 0) return;
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_JSON_FILE, 'utf8'));
    if (!store.isValidJson(legacy)) return;
    store.importJson(legacy, 'replace');
    fs.renameSync(LEGACY_JSON_FILE, `${LEGACY_JSON_FILE}.migrated-${Date.now()}`);
  } catch (err) {
    dialog.showErrorBox('Could not migrate old data', `${LEGACY_JSON_FILE}\n\n${err.message}`);
  }
}

/** Daily snapshots (last 30 kept) plus one per month kept forever. */
function runBackups() {
  if (!store.isOpen()) return; // still locked
  try {
    const daily = path.join(BACKUP_DIR, 'daily');
    const monthly = path.join(BACKUP_DIR, 'monthly');
    fs.mkdirSync(daily, { recursive: true });
    fs.mkdirSync(monthly, { recursive: true });
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dayFile = path.join(daily, `tracker-${today}.db`);
    const monthFile = path.join(monthly, `tracker-${today.slice(0, 7)}.db`);
    if (!fs.existsSync(dayFile)) store.snapshotTo(dayFile);
    if (!fs.existsSync(monthFile)) fs.copyFileSync(dayFile, monthFile);
    const old = fs.readdirSync(daily).filter((f) => /^tracker-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - MAX_DAILY_BACKUPS))) fs.unlinkSync(path.join(daily, f));
  } catch (err) {
    console.error('Backup failed:', err);
  }
}

function snapshotBefore(reason) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, `before-${reason}-${Date.now()}.db`);
  store.snapshotTo(file);
  return file;
}

// ---------- window ----------

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(WINDOW_FILE, 'utf8'));
  } catch {
    return { width: 1280, height: 820 };
  }
}

function saveWindowState() {
  if (!win) return;
  try {
    const state = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    fs.writeFileSync(WINDOW_FILE, JSON.stringify(state), 'utf8');
  } catch {
    // ignore
  }
}

function createWindow() {
  const state = loadWindowState();
  win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width || 1280,
    height: state.height || 820,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d1117' : '#f5f7fb',
    title: DISPLAY_NAME,
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  if (state.maximized) win.maximize();
  // launched by Windows at sign-in with "start minimized": sit in the taskbar instead of popping up
  win.once('ready-to-show', () => (process.argv.includes(MINIMIZED_ARG) ? win.minimize() : win.show()));
  win.on('close', saveWindowState);
  win.on('session-end', saveNow); // Windows is shutting down or signing out
  win.on('closed', () => { win = null; });

  // Never navigate the app window away; send links to the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // Right-click spelling suggestions + copy/paste.
  win.webContents.on('context-menu', (_e, params) => {
    const items = params.dictionarySuggestions.map((s) => ({
      label: s,
      click: () => win.webContents.replaceMisspelling(s),
    }));
    if (items.length) items.push({ type: 'separator' });
    if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    else if (params.selectionText) items.push({ role: 'copy' });
    if (items.length) Menu.buildFromTemplate(items).popup();
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

function openExternal(url) {
  try {
    const u = new URL(url);
    if (['http:', 'https:', 'mailto:'].includes(u.protocol)) shell.openExternal(u.toString());
  } catch {
    // ignore invalid urls
  }
}

function reloadRendererData(message) {
  if (win) win.webContents.send('data:replaced', { ...store.loadAll(), message });
}

// ---------- import / export / move ----------

async function exportBackup() {
  const day = new Date().toISOString().slice(0, 10);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export backup',
    defaultPath: path.join(app.getPath('documents'), `hotit-manager-${day}.db`),
    filters: [{ name: 'HOTIT Manager backup', extensions: ['db'] }],
  });
  if (canceled || !filePath) return;
  // a copy of the whole database (encrypted when the database is); restore it with Import backup
  const file = /\.db$/i.test(filePath) ? filePath : `${filePath}.db`;
  store.snapshotTo(file);
  dialog.showMessageBox(win, {
    type: 'info',
    message: 'Backup exported',
    detail: store.encryption() ? `${file}\n\nThis copy is encrypted with your current password.` : file,
  });
}

async function importBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Import backup',
    defaultPath: BACKUP_DIR,
    properties: ['openFile'],
    filters: [
      { name: 'HOTIT Manager backup (.db)', extensions: ['db'] },
      { name: 'Older JSON backup (.json)', extensions: ['json'] }, // made by versions up to 3.1.1
    ],
  });
  if (canceled || !filePaths.length) return;
  let obj = null;
  let problem = '';
  try {
    obj = await readBackupFile(filePaths[0]);
    if (obj === null) return; // password prompt cancelled
  } catch (err) {
    problem = err instanceof SyntaxError ? '' : err.message;
  }
  if (!store.isValidJson(obj)) {
    dialog.showMessageBox(win, { type: 'error', message: 'That file is not a valid backup of this app.', detail: problem });
    return;
  }
  const n = store.describeJson(obj);
  const parts = [
    [n.customers, 'customer'], [n.assets, 'asset'], [n.transactions, 'transaction'], [n.goals, 'goal'],
    [n.tasks, 'task'], [n.contacts, 'LinkedIn contact'], [n.messages, 'message'],
  ].filter(([c]) => c).map(([c, w]) => `${c} ${w}${c === 1 ? '' : 's'}`);
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Merge into my data', 'Replace my data', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: 'How should this backup be imported?',
    detail: `The backup has ${parts.join(', ') || 'no records'}.\n\n` +
      'Merge adds anything that is not already here. Replace deletes your current data first.\n' +
      'Either way, a copy of your current database is saved to the backups folder first.',
  });
  if (response === 2) return;
  snapshotBefore('import');
  store.importJson(obj, response === 0 ? 'merge' : 'replace');
  saveNow();
  reloadRendererData('Backup imported');
}

/**
 * A backup as a JSON backup object: a JSON export, or a database copy (.db, such as the automatic
 * daily backups), plain or encrypted. Returns null if its password was asked for and not given.
 */
async function readBackupFile(file) {
  if (cryptfile.isEncrypted(file)) {
    const header = cryptfile.readHeader(file);
    const open = store.encryption();
    // backups of this database share its key, even after a password change
    let key = open && open.header.id === header.id ? open.key : await recallKey(header.id);
    let error = '';
    while (!key) {
      const password = await askPassword(path.basename(file), error);
      if (password === null) return null;
      try {
        key = await cryptfile.unlock(header, password);
      } catch {
        error = 'That password is not right.';
      }
    }
    return store.databaseToJson(cryptfile.decryptFile(file, key).plain);
  }
  if (cryptfile.isPlainSqlite(file)) return store.databaseToJson(fs.readFileSync(file));
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// The password for an encrypted backup is typed in the app window (Electron has no password dialog).
const passwordRequests = new Map();
let lastPasswordRequest = 0;

function askPassword(fileName, error) {
  return new Promise((resolve) => {
    const id = ++lastPasswordRequest;
    passwordRequests.set(id, resolve);
    win.webContents.send('ask-password', { id, fileName, error });
  });
}

ipcMain.on('ask-password:reply', (_e, id, password) => {
  const resolve = passwordRequests.get(id);
  if (!resolve) return;
  passwordRequests.delete(id);
  resolve(typeof password === 'string' ? password : null);
});

async function moveDatabase() {
  const current = store.currentFile();
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Choose where to keep your database',
    defaultPath: path.join(app.getPath('documents'), `${DISPLAY_NAME}.db`),
    buttonLabel: 'Use this location',
    filters: [{ name: 'HOTIT Manager database', extensions: ['db'] }],
    properties: ['showOverwriteConfirmation'],
  });
  if (canceled || !filePath || path.resolve(filePath) === path.resolve(current)) return;

  let mode = 'copy';
  if (fs.existsSync(filePath)) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Open the existing database', 'Overwrite it with my current data', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: 'A file already exists there.',
      detail: filePath,
    });
    if (response === 2) return;
    mode = response === 0 ? 'open' : 'copy';
  }
  const currentKey = store.encryption() && store.encryption().key;
  try {
    if (mode === 'copy') {
      const tmp = `${filePath}.tmp`;
      store.snapshotTo(tmp);
      fs.renameSync(tmp, filePath);
    }
    if (!(await openFile(filePath))) {
      // an encrypted database this PC doesn't have the key for: ask for its password
      store.close();
      writeConfig({ ...readConfig(), dbPath: filePath });
      win.webContents.reload();
      return;
    }
    writeConfig({ ...readConfig(), dbPath: filePath });
  } catch (err) {
    store.open(current, { ...DB_OPEN_OPTIONS, key: currentKey });
    dialog.showErrorBox('Could not use that location', err.message);
    return;
  }
  reloadRendererData(mode === 'open' ? 'Opened database' : 'Database moved');
}

// ---------- menu ----------

// the app's sections, in the order of the navigation bar (Ctrl+Shift+1…6)
const VIEWS = [
  ['overview', 'Overview'], ['customers', 'Customers'], ['assets', 'Assets'],
  ['finance', 'Finance'], ['goals', 'Goals && Plans'], ['linkedin', 'LinkedIn Messages'],
];

function buildMenu() {
  const send = (cmd) => () => win && win.webContents.send('menu', cmd);
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New…', accelerator: 'CmdOrCtrl+N', click: send('new') },
        { label: 'Find', accelerator: 'CmdOrCtrl+F', click: send('focus-search') },
        { type: 'separator' },
        { label: 'Manage LinkedIn accounts…', click: send('accounts') },
        { type: 'separator' },
        { label: 'Export backup…', click: exportBackup },
        { label: 'Import backup…', click: importBackup },
        { label: 'Change database location…', click: moveDatabase },
        { label: 'Open data folder', click: () => shell.showItemInFolder(store.currentFile()) },
        { label: 'Open backups folder', click: () => { fs.mkdirSync(BACKUP_DIR, { recursive: true }); shell.openPath(BACKUP_DIR); } },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('settings') },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Go',
      submenu: VIEWS.map(([id, label], i) => ({ label, accelerator: `CmdOrCtrl+Shift+${i + 1}`, click: send(`view:${id}`) })),
    },
    {
      label: 'View',
      submenu: [
        { role: 'zoomIn', accelerator: 'CmdOrCtrl+=' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [{ label: 'Keyboard shortcuts', click: send('shortcuts') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- ipc ----------

const DB_OPS = {
  createAccount: store.createAccount,
  updateAccount: store.updateAccount,
  deleteAccount: store.deleteAccount,
  createContact: store.createContact,
  updateContact: store.updateContact,
  deleteContact: store.deleteContact,
  restoreContact: store.restoreContact,
  createMessage: store.createMessage,
  updateMessage: store.updateMessage,
  deleteMessage: store.deleteMessage,
  restoreMessage: store.restoreMessage,
  setMessageSeen: store.setMessageSeen,
  setAvatar: store.setAvatar,
  removeAvatar: store.removeAvatar,
  setSetting: store.setSetting,
  saveRecord: store.saveRecord,
  deleteRecord: store.deleteRecord,
  restoreRecord: store.restoreRecord,
  // passwords / API keys, backup codes, 2-step keys: encrypted for your Windows account (DPAPI)
  // before they reach the database. name: 'password' (default) or e.g. 'backupCodes', 'totp'.
  setAssetSecret: async (id, plain, name = 'password') => {
    let value = plain ? String(plain).slice(0, 20000) : null;
    if (value && name === 'totp') {
      value = value.trim();
      if (!totp.parse(value)) {
        throw new Error("that 2-step key isn't valid. Paste the setup key (letters A–Z and digits 2–7) or the otpauth:// link.");
      }
    }
    return store.setAssetSecret(id, value ? await vault.protect(value) : null, name);
  },
};

async function revealSecret(id, name = 'password') {
  const enc = store.getAssetSecret(id, name);
  return enc ? vault.unprotect(enc) : null;
}

/** The current 2-step code of an asset: { code, remaining, period } or null. */
async function currentCode(id) {
  const key = await revealSecret(id, 'totp');
  return key ? totp.code(key) : null;
}

let clipboardClearTimer = null;

ipcMain.handle('data:load', () => store.loadAll());
ipcMain.handle('db', async (_e, op, ...args) => {
  if (!Object.hasOwn(DB_OPS, op)) throw new Error(`Unknown operation: ${op}`);
  try {
    return await DB_OPS[op](...args);
  } finally {
    scheduleSave();
  }
});
ipcMain.handle('security', (_e, op, ...args) => {
  if (!Object.hasOwn(SECURITY_OPS, op)) throw new Error(`Unknown operation: ${op}`);
  return SECURITY_OPS[op](...args);
});
ipcMain.handle('open:external', (_e, url) => openExternal(url));
ipcMain.handle('open:data-folder', () => shell.showItemInFolder(store.currentFile()));
ipcMain.handle('open:backups-folder', () => { fs.mkdirSync(BACKUP_DIR, { recursive: true }); shell.openPath(BACKUP_DIR); });
ipcMain.handle('backup:export', () => exportBackup());
ipcMain.handle('backup:import', () => importBackup());
ipcMain.handle('db:move', () => moveDatabase());
// the theme chosen in Settings → Appearance; remembered here too, so the window opens in its colors
ipcMain.handle('theme:set', (_e, theme) => {
  if (!['light', 'dark', 'system'].includes(theme)) return;
  nativeTheme.themeSource = theme;
  const cfg = readConfig();
  if (cfg.theme !== theme) writeConfig({ ...cfg, theme });
});
ipcMain.handle('secret:reveal', (_e, id, name) => revealSecret(id, name));
ipcMain.handle('secret:code', (_e, id) => currentCode(id));
// copy a password (for a 2-step key: its current code), and clear it from the clipboard after
// 30 seconds unless something else was copied
ipcMain.handle('secret:copy', async (_e, id, name) => {
  const value = name === 'totp' ? (await currentCode(id))?.code ?? null : await revealSecret(id, name);
  if (value === null) return false;
  await clipboard.writeText(value); // (the clipboard API is asynchronous in this Electron version)
  clearTimeout(clipboardClearTimer);
  clipboardClearTimer = setTimeout(async () => {
    if ((await clipboard.readText()) === value) clipboard.clear();
  }, 30000);
  return true;
});

// ---------- start with Windows ----------

const MINIMIZED_ARG = '--minimized';
const STARTUP_ENTRY_NAME = APP_NAME; // name shown in Windows Settings → Apps → Startup

/** The exe Windows should launch. The portable build runs from a temp copy, so use the original file. */
function startupExePath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function getStartup() {
  if (!app.isPackaged) return { supported: false, enabled: false, minimized: false };
  // Electron's openAtLogin only matches its default entry name, so look the entry up by our name.
  // `enabled` is false when the user switched it off in Windows Settings / Task Manager.
  const { launchItems = [] } = app.getLoginItemSettings({ path: startupExePath(), name: STARTUP_ENTRY_NAME });
  const item = launchItems.find((i) => i.name === STARTUP_ENTRY_NAME);
  return {
    supported: true,
    enabled: !!item && item.enabled !== false,
    minimized: !!readConfig().startMinimized, // Windows doesn't report the arguments back reliably
  };
}

/** A startup entry made under the app's old name moves to the new name (keeping on/off and minimized). */
function migrateStartupEntry() {
  if (!app.isPackaged) return;
  const { launchItems = [] } = app.getLoginItemSettings({ path: startupExePath(), name: LEGACY_APP_NAME });
  const old = launchItems.find((i) => i.name === LEGACY_APP_NAME);
  if (!old) return;
  app.setLoginItemSettings({ openAtLogin: false, path: startupExePath(), name: LEGACY_APP_NAME });
  if (old.enabled === false) return;
  app.setLoginItemSettings({
    openAtLogin: true,
    path: startupExePath(),
    args: readConfig().startMinimized ? [MINIMIZED_ARG] : [],
    name: STARTUP_ENTRY_NAME,
  });
}

ipcMain.handle('startup:get', () => getStartup());
ipcMain.handle('startup:set', (_e, { enabled, minimized }) => {
  if (!app.isPackaged) return getStartup();
  // Windows keeps one startup entry per name, so this replaces any previous setting
  app.setLoginItemSettings({
    openAtLogin: !!enabled,
    path: startupExePath(),
    args: minimized ? [MINIMIZED_ARG] : [],
    name: STARTUP_ENTRY_NAME,
  });
  writeConfig({ ...readConfig(), startMinimized: !!(enabled && minimized) });
  return getStartup();
});

const EXT_FOR_MIME = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

ipcMain.handle('attachment:save', async (_e, id) => {
  const a = store.getAttachment(id);
  if (!a) return false;
  const ext = EXT_FOR_MIME[a.mime] || 'img';
  const base = (a.name || 'image').replace(/[\\/:*?"<>|]+/g, '_').replace(/\.[a-z0-9]{2,5}$/i, '');
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save image',
    defaultPath: path.join(app.getPath('downloads'), `${base}.${ext}`),
    filters: [{ name: 'Image', extensions: [ext] }],
  });
  if (canceled || !filePath) return false;
  fs.writeFileSync(filePath, a.data);
  return true;
});

ipcMain.handle('attachment:copy', async (_e, id) => {
  const a = store.getAttachment(id);
  if (!a) return false;
  // Clipboard images are PNG; convert JPEGs. (nativeImage cannot decode webp/gif.)
  const png = a.mime === 'image/png' ? a.data : nativeImage.createFromBuffer(a.data).toPNG();
  if (!png.length) return false;
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
  return true;
});

// ---------- lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.jamesdavidclarke.lmessagetracker');
    const { theme } = readConfig();
    if (['light', 'dark', 'system'].includes(theme)) nativeTheme.themeSource = theme;
    await openDatabase();
    try {
      migrateStartupEntry();
    } catch (err) {
      console.error('Could not move the startup entry:', err);
    }
    protocol.handle('avatar', (req) => {
      const ownerId = decodeURIComponent(new URL(req.url).pathname.slice(1));
      const a = store.getAvatar(ownerId);
      if (!a) return new Response(null, { status: 404 });
      return new Response(a.data, { headers: { 'content-type': a.mime, 'cache-control': 'max-age=31536000' } });
    });
    protocol.handle('attachment', (req) => {
      const id = decodeURIComponent(new URL(req.url).pathname.slice(1));
      const a = store.getAttachment(id);
      if (!a) return new Response(null, { status: 404 });
      return new Response(a.data, { headers: { 'content-type': a.mime, 'cache-control': 'max-age=31536000' } });
    });
    buildMenu();
    createWindow();
    // keep making daily backups if the app is left open for days
    setInterval(runBackups, 6 * 60 * 60 * 1000);
    // safety net for changes made outside the 'db' calls (imports, upgrades): save them too
    setInterval(saveNow, 5000);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    try {
      store.close();
    } catch (err) {
      dialog.showErrorBox('Your last changes could not be saved', `${store.currentFile()}\n\n${err.message}`);
    }
  });
}
