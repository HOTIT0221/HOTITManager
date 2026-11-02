'use strict';

// SQLite storage, using the SQLite engine built into Electron's Node.js (no native modules to compile).
//
// Until version 3.7 this database also held the LinkedIn message tracker (accounts, contacts,
// messages, attachments). That is a separate app now (LinkedIn Tracker): upgrading to schema 9
// empties those tables, after main.js has kept a copy of the database as it was.
//
// A database can be a plain SQLite file, or encrypted with a password (cryptfile.js). An encrypted
// database is decrypted into memory when it is opened, and every change is written back to the
// file encrypted (save(), called by main.js shortly after each change), so the data is never on
// disk unencrypted.

const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const cryptfile = require('./cryptfile');
const { countryFromLegacyValue } = require('./src/countries');

const SCHEMA_VERSION = 9;
const PURGE_DELETED_AFTER_DAYS = 30;

let db = null;
let dbFile = null;
let crypt = null; // { key, header } while an encrypted database is open
let savedChanges = 0; // SQLite's change counter when the encrypted file was last written

let removedLinkedIn = 0; // contacts + messages the upgrade to schema 9 removed from the open database

// ---------- open / migrate ----------

/**
 * onUpgrade(oldVersion) runs before an existing database is upgraded, e.g. to back it up.
 * key: the data key, needed when the file is encrypted.
 */
function open(file, { onUpgrade, key } = {}) {
  close();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (cryptfile.isEncrypted(file)) {
    if (!key) throw new Error('This database is encrypted');
    const { header, plain } = cryptfile.decryptFile(file, key);
    db = new DatabaseSync(':memory:');
    db.deserialize(plain);
    crypt = { key, header };
  } else {
    db = new DatabaseSync(file);
    // Rollback journal (not WAL) keeps everything in one file, which is safer
    // if the database lives in a synced folder such as OneDrive or Dropbox.
    db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
    `);
  }
  dbFile = file;
  savedChanges = 0;
  db.exec('PRAGMA foreign_keys = ON');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (onUpgrade && version > 0 && version < SCHEMA_VERSION) onUpgrade(version);
  removedLinkedIn = migrate();
  if (removedLinkedIn) db.exec('VACUUM'); // once: give the space of the removed messages and images back
  purgeDeleted();
  save(version < SCHEMA_VERSION);
}

/** Closes the database (an encrypted one is saved first; if that fails, it stays open and this throws). */
function close() {
  if (db) {
    save();
    try { db.close(); } catch { /* already closed */ }
  }
  db = null;
  dbFile = null;
  crypt = null;
}

function currentFile() {
  return dbFile;
}

function isOpen() {
  return !!db;
}

/** { key, header } of the open encrypted database, or null when it is a plain SQLite file. */
function encryption() {
  return crypt;
}

function changeCount() {
  return db.prepare('SELECT total_changes() AS n').get().n;
}

/**
 * Write an encrypted database to its file if anything changed since the last save (a plain
 * SQLite file is written by SQLite itself on every change). Returns true if it wrote the file.
 */
function save(force = false) {
  if (!db || !crypt) return false;
  const n = changeCount();
  if (!force && n === savedChanges) return false;
  cryptfile.encryptTo(dbFile, crypt.header, crypt.key, db.serialize());
  savedChanges = n;
  return true;
}

/**
 * Encrypt the open plain database: the encrypted copy is written and checked first, then it
 * replaces the plain file, and the database is reopened from it.
 */
function encryptWith(key, header) {
  if (!db || crypt) throw new Error('The database is already encrypted');
  const file = dbFile;
  const tmp = `${file}.encrypting`;
  cryptfile.encryptTo(tmp, header, key, db.serialize());
  const check = new DatabaseSync(':memory:');
  try {
    check.deserialize(cryptfile.decryptFile(tmp, key).plain);
    if (check.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('The encrypted copy failed its check');
  } finally {
    check.close();
  }
  close();
  try {
    cryptfile.writeFileAtomic(file, fs.readFileSync(tmp));
    fs.unlinkSync(tmp);
  } catch (err) {
    open(file); // still the plain database
    throw err;
  }
  for (const leftover of [`${file}-journal`, `${file}-wal`, `${file}-shm`]) {
    try { fs.unlinkSync(leftover); } catch { /* not there */ }
  }
  open(file, { key });
}

/** Store the data key under a new header (a new password) and rewrite the file. */
function setHeader(header) {
  if (!crypt || header.id !== crypt.header.id) throw new Error('The database is not encrypted');
  crypt = { ...crypt, header };
  save(true);
}

function migrate() {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version < 1) {
    tx(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS contacts (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          linkedin_url  TEXT NOT NULL DEFAULT '',
          nationality   TEXT NOT NULL DEFAULT '',
          headline      TEXT NOT NULL DEFAULT '',
          notes         TEXT NOT NULL DEFAULT '',
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          deleted_at    TEXT
        );
        CREATE TABLE IF NOT EXISTS messages (
          id          TEXT PRIMARY KEY,
          contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
          direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
          text        TEXT NOT NULL,
          sent_at     TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          deleted_at  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id, sent_at);
        -- owner_id is a contact id or an account id (before v5: '__me__' for your own photo)
        CREATE TABLE IF NOT EXISTS avatars (
          owner_id    TEXT PRIMARY KEY,
          mime        TEXT NOT NULL,
          data        BLOB NOT NULL,
          updated_at  TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
          key    TEXT PRIMARY KEY,
          value  TEXT NOT NULL
        );
      `);
      db.exec('PRAGMA user_version = 1');
    });
  }
  if (version < 2) {
    tx(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS attachments (
          id          TEXT PRIMARY KEY,
          message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          position    INTEGER NOT NULL DEFAULT 0,
          name        TEXT NOT NULL DEFAULT '',
          mime        TEXT NOT NULL,
          width       INTEGER NOT NULL DEFAULT 0,
          height      INTEGER NOT NULL DEFAULT 0,
          size        INTEGER NOT NULL DEFAULT 0,
          data        BLOB NOT NULL,
          created_at  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id, position);
      `);
      db.exec('PRAGMA user_version = 2');
    });
  }
  if (version < 3) {
    // the "nationality" column now holds a country name: convert "German" -> "Germany" etc.
    tx(() => {
      const update = db.prepare('UPDATE contacts SET nationality = ? WHERE id = ?');
      for (const r of db.prepare(`SELECT id, nationality FROM contacts WHERE nationality <> ''`).all()) {
        const country = countryFromLegacyValue(r.nationality);
        if (country !== r.nationality) update.run(country, r.id);
      }
      db.exec('PRAGMA user_version = 3');
    });
  }
  if (version < 4) {
    // when the recipient saw a sent message (like LinkedIn's "seen" avatar); NULL = not seen yet
    tx(() => {
      db.exec('ALTER TABLE messages ADD COLUMN seen_at TEXT');
      db.exec('PRAGMA user_version = 4');
    });
  }
  if (version < 5) {
    // several LinkedIn accounts: each contact belongs to one of your accounts.
    // Your existing name and photo become the first account.
    tx(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          linkedin_url  TEXT NOT NULL DEFAULT '',
          position      INTEGER NOT NULL DEFAULT 0,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        );
        ALTER TABLE contacts ADD COLUMN account_id TEXT;
        CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id);
      `);
      const nameRow = db.prepare(`SELECT value FROM settings WHERE key = 'myName'`).get();
      let name = 'Me';
      try { name = (nameRow && JSON.parse(nameRow.value)) || 'Me'; } catch { /* keep default */ }
      const id = crypto.randomUUID();
      const t = now();
      db.prepare('INSERT INTO accounts (id, name, linkedin_url, position, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
        .run(id, str(name, 200), '', t, t);
      db.prepare('UPDATE contacts SET account_id = ?').run(id);
      db.prepare(`UPDATE avatars SET owner_id = ? WHERE owner_id = '__me__'`).run(id);
      db.prepare(`DELETE FROM settings WHERE key = 'myName'`).run();
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('currentAccount', ?)`).run(JSON.stringify(id));
      db.exec('PRAGMA user_version = 5');
    });
  }
  if (version < 6) {
    // IT Business Manager: customers, assets, money in/out, goals and the plan (tasks).
    // Dates without a time are 'YYYY-MM-DD' ('' = not set).
    tx(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS customers (
          id            TEXT PRIMARY KEY,
          kind          TEXT NOT NULL DEFAULT 'client',   -- client | collaborator | lead
          status        TEXT NOT NULL DEFAULT 'active',   -- active | paused | former
          name          TEXT NOT NULL,
          company       TEXT NOT NULL DEFAULT '',
          role          TEXT NOT NULL DEFAULT '',
          email         TEXT NOT NULL DEFAULT '',
          phone         TEXT NOT NULL DEFAULT '',
          country       TEXT NOT NULL DEFAULT '',
          website       TEXT NOT NULL DEFAULT '',
          linkedin_url  TEXT NOT NULL DEFAULT '',
          contact_id    TEXT REFERENCES contacts(id) ON DELETE SET NULL,  -- their LinkedIn conversation
          tags          TEXT NOT NULL DEFAULT '',
          notes         TEXT NOT NULL DEFAULT '',
          since         TEXT NOT NULL DEFAULT '',
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          deleted_at    TEXT
        );
        -- servers, domains, online accounts, payment accounts, bank accounts, software…
        CREATE TABLE IF NOT EXISTS assets (
          id           TEXT PRIMARY KEY,
          category     TEXT NOT NULL DEFAULT 'other',
          name         TEXT NOT NULL,
          provider     TEXT NOT NULL DEFAULT '',
          url          TEXT NOT NULL DEFAULT '',
          login        TEXT NOT NULL DEFAULT '',
          details      TEXT NOT NULL DEFAULT '{}',        -- per-category fields (IP address, IBAN…) as JSON
          secret       BLOB,                               -- password / API key, encrypted by Windows (DPAPI, see vault.js)
          cost         REAL,
          currency     TEXT NOT NULL DEFAULT '',
          billing      TEXT NOT NULL DEFAULT 'none',      -- none | monthly | quarterly | yearly | once
          renews_on    TEXT NOT NULL DEFAULT '',
          balance      REAL,
          status       TEXT NOT NULL DEFAULT 'active',    -- active | inactive | closed
          customer_id  TEXT REFERENCES customers(id) ON DELETE SET NULL,
          notes        TEXT NOT NULL DEFAULT '',
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL,
          deleted_at   TEXT
        );
        CREATE TABLE IF NOT EXISTS transactions (
          id           TEXT PRIMARY KEY,
          type         TEXT NOT NULL CHECK (type IN ('income', 'expense')),
          date         TEXT NOT NULL,
          amount       REAL NOT NULL,
          currency     TEXT NOT NULL,
          category     TEXT NOT NULL DEFAULT '',
          description  TEXT NOT NULL DEFAULT '',
          customer_id  TEXT REFERENCES customers(id) ON DELETE SET NULL,
          asset_id     TEXT REFERENCES assets(id) ON DELETE SET NULL,
          notes        TEXT NOT NULL DEFAULT '',
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL,
          deleted_at   TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
        CREATE TABLE IF NOT EXISTS goals (
          id           TEXT PRIMARY KEY,
          title        TEXT NOT NULL,
          description  TEXT NOT NULL DEFAULT '',
          metric       TEXT NOT NULL DEFAULT 'custom',    -- custom | income | profit | clients | tasks
          target       REAL NOT NULL DEFAULT 0,
          current      REAL NOT NULL DEFAULT 0,           -- progress of a custom goal
          unit         TEXT NOT NULL DEFAULT '',
          start_date   TEXT NOT NULL DEFAULT '',
          due_date     TEXT NOT NULL DEFAULT '',
          status       TEXT NOT NULL DEFAULT 'active',    -- active | achieved | dropped
          position     INTEGER NOT NULL DEFAULT 0,
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL,
          deleted_at   TEXT
        );
        CREATE TABLE IF NOT EXISTS tasks (
          id           TEXT PRIMARY KEY,
          title        TEXT NOT NULL,
          notes        TEXT NOT NULL DEFAULT '',
          status       TEXT NOT NULL DEFAULT 'todo',      -- todo | doing | done
          priority     TEXT NOT NULL DEFAULT 'normal',    -- low | normal | high
          due_date     TEXT NOT NULL DEFAULT '',
          goal_id      TEXT REFERENCES goals(id) ON DELETE SET NULL,
          customer_id  TEXT REFERENCES customers(id) ON DELETE SET NULL,
          done_at      TEXT,
          position     INTEGER NOT NULL DEFAULT 0,
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL,
          deleted_at   TEXT
        );
      `);
      db.exec('PRAGMA user_version = 6');
    });
  }
  if (version < 7) {
    // more than one secret per asset (email accounts: backup codes, 2-step key, security answer);
    // the password / API key stays in assets.secret. Encrypted like it, by Windows (DPAPI).
    tx(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS asset_secrets (
          asset_id    TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
          name        TEXT NOT NULL,
          secret      BLOB NOT NULL,
          updated_at  TEXT NOT NULL,
          PRIMARY KEY (asset_id, name)
        );
      `);
      db.exec('PRAGMA user_version = 7');
    });
  }
  if (version < 8) {
    // Notes: text you use again and again (replies, intros, proposal paragraphs), saved under a title
    tx(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS notes (
          id           TEXT PRIMARY KEY,
          title        TEXT NOT NULL,
          text         TEXT NOT NULL DEFAULT '',
          tag          TEXT NOT NULL DEFAULT '',
          pinned       INTEGER NOT NULL DEFAULT 0,      -- 1: shown at the top
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL,
          deleted_at   TEXT
        );
      `);
      db.exec('PRAGMA user_version = 8');
    });
  }
  let removed = 0;
  if (version < 9) {
    // the LinkedIn message tracker moved to its own app: remove its data (the tables stay, empty,
    // because customers.contact_id still refers to contacts)
    tx(() => {
      removed = db.prepare('SELECT (SELECT COUNT(*) FROM contacts) + (SELECT COUNT(*) FROM messages) AS n').get().n;
      db.exec(`
        UPDATE customers SET contact_id = NULL;
        DELETE FROM attachments;
        DELETE FROM messages;
        DELETE FROM contacts;
        DELETE FROM accounts;
        DELETE FROM avatars WHERE owner_id NOT IN (SELECT id FROM customers);
        DELETE FROM settings WHERE key = 'currentAccount';
      `);
      db.exec('PRAGMA user_version = 9');
    });
  }
  return removed;
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function now() {
  return new Date().toISOString();
}

function str(v, max = 100000) {
  return String(v ?? '').slice(0, max);
}

function purgeDeleted() {
  const cutoff = new Date(Date.now() - PURGE_DELETED_AFTER_DAYS * 86400000).toISOString();
  tx(() => {
    // records that point at a purged one keep existing (their link is cleared by ON DELETE SET NULL)
    for (const table of ['transactions', 'tasks', 'assets', 'goals', 'customers', 'notes']) {
      db.prepare(`DELETE FROM ${table} WHERE deleted_at IS NOT NULL AND deleted_at < ?`).run(cutoff);
    }
    db.prepare('DELETE FROM avatars WHERE owner_id NOT IN (SELECT id FROM customers)').run();
  });
}

// ---------- reading ----------

function getSettings() {
  // baseCurrency: totals are shown in it; fxRates: { EUR: 1.08 } = 1 EUR is worth 1.08 of the base currency
  const settings = { timeZone: '', baseCurrency: 'USD', fxRates: {} };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    try { settings[r.key] = JSON.parse(r.value); } catch { /* skip bad value */ }
  }
  return settings;
}

function loadAll() {
  return {
    settings: getSettings(),
    ...Object.fromEntries(Object.entries(ENTITIES).map(([type, spec]) => [spec.key, listRecords(type)])),
    file: dbFile,
  };
}

function getAvatar(ownerId) {
  const r = db.prepare('SELECT mime, data FROM avatars WHERE owner_id = ?').get(str(ownerId, 200));
  return r ? { mime: r.mime, data: Buffer.from(r.data) } : null;
}

// ---------- business records: customers, assets, transactions, goals, tasks, notes ----------
// Each record type is described by its fields; saving cleans every value to that description,
// so the renderer can send a whole object and get back exactly what was stored.

const text = (max = 100000, required = false) => ({ kind: 'text', max, required });
const oneOf = (...values) => ({ kind: 'enum', values });
const DATE = { kind: 'date' };
const NUM = { kind: 'num' };
const NUM_OR_ZERO = { kind: 'num', fallback: 0 };
const NUM_OR_NULL = { kind: 'num', nullable: true };
const CURRENCY = { kind: 'currency' };
const ref = (table) => ({ kind: 'ref', table });

const ENTITIES = {
  customer: {
    table: 'customers',
    key: 'customers',
    fields: {
      kind: oneOf('client', 'collaborator', 'lead'),
      status: oneOf('active', 'paused', 'former'),
      name: text(500, true),
      company: text(500),
      role: text(500),
      email: text(500),
      phone: text(200),
      country: text(200),
      website: text(2000),
      linkedinUrl: text(2000),
      tags: text(1000),
      notes: text(),
      since: DATE,
    },
  },
  asset: {
    table: 'assets',
    key: 'assets',
    fields: {
      category: oneOf('server', 'domain', 'account', 'github', 'email', 'payment', 'bank', 'software', 'other'),
      name: text(500, true),
      provider: text(500),
      url: text(2000),
      login: text(500),
      details: { kind: 'json' },
      cost: NUM_OR_NULL,
      currency: CURRENCY,
      billing: oneOf('none', 'monthly', 'quarterly', 'yearly', 'once'),
      renewsOn: DATE,
      balance: NUM_OR_NULL,
      status: oneOf('active', 'inactive', 'closed'),
      customerId: ref('customers'),
      notes: text(),
    },
  },
  transaction: {
    table: 'transactions',
    key: 'transactions',
    fields: {
      type: oneOf('income', 'expense'),
      date: { kind: 'date', required: true },
      amount: NUM,
      currency: { kind: 'currency', required: true },
      category: text(200),
      description: text(2000),
      customerId: ref('customers'),
      assetId: ref('assets'),
      notes: text(),
    },
  },
  goal: {
    table: 'goals',
    key: 'goals',
    fields: {
      title: text(500, true),
      description: text(),
      metric: oneOf('custom', 'income', 'profit', 'clients', 'tasks'),
      target: NUM_OR_ZERO,
      current: NUM_OR_ZERO,
      unit: text(50),
      startDate: DATE,
      dueDate: DATE,
      status: oneOf('active', 'achieved', 'dropped'),
      position: NUM_OR_ZERO,
    },
  },
  task: {
    table: 'tasks',
    key: 'tasks',
    fields: {
      title: text(1000, true),
      notes: text(),
      status: oneOf('todo', 'doing', 'done'),
      priority: oneOf('normal', 'high', 'low'),
      dueDate: DATE,
      goalId: ref('goals'),
      customerId: ref('customers'),
      position: NUM_OR_ZERO,
    },
  },
  note: {
    table: 'notes',
    key: 'notes',
    fields: {
      title: text(500, true),
      text: text(),
      tag: text(200),
      pinned: NUM_OR_ZERO,
    },
  },
};

const snake = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (k) => k.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());

function entity(type) {
  if (!Object.hasOwn(ENTITIES, type)) throw new Error(`Unknown record type: ${type}`);
  return ENTITIES[type];
}

/** One value cleaned to its field description (the first enum value is the default). */
function cleanValue(name, f, v) {
  switch (f.kind) {
    case 'text': {
      const s = str(v, f.max).trim();
      if (f.required && !s) throw new Error(`${name} is required`);
      return s;
    }
    case 'enum':
      return f.values.includes(v) ? v : f.values[0];
    case 'date': {
      const s = str(v, 10);
      if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Invalid date for ${name}`);
      if (f.required && !s) throw new Error(`${name} is required`);
      return s;
    }
    case 'num': {
      if (v === null || v === undefined || v === '') {
        if (f.nullable) return null;
        if ('fallback' in f) return f.fallback;
      }
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`Invalid number for ${name}`);
      return Math.round(n * 1e6) / 1e6;
    }
    case 'currency': {
      const s = str(v, 10).trim().toUpperCase();
      if (s && !/^[A-Z0-9]{2,6}$/.test(s)) throw new Error(`Invalid currency “${s}”`);
      if (f.required && !s) throw new Error('Currency is required');
      return s;
    }
    case 'ref': {
      const id = str(v, 200);
      if (!id) return null;
      return db.prepare(`SELECT 1 FROM ${f.table} WHERE id = ?`).get(id) ? id : null;
    }
    case 'json': {
      // a flat object of short strings, e.g. { ip: '1.2.3.4', location: 'Frankfurt' }
      const out = {};
      if (v && typeof v === 'object') {
        for (const [k, val] of Object.entries(v).slice(0, 50)) {
          const s = str(val, 2000).trim();
          if (/^[A-Za-z0-9_]{1,40}$/.test(k) && s) out[k] = s;
        }
      }
      return JSON.stringify(out);
    }
    default:
      throw new Error(`Unknown field kind ${f.kind}`);
  }
}

function cleanRecord(spec, rec) {
  const out = {};
  for (const [name, f] of Object.entries(spec.fields)) out[snake(name)] = cleanValue(name, f, rec[name]);
  return out;
}

function rowToRecord(spec, r) {
  const rec = { id: r.id };
  for (const name of Object.keys(spec.fields)) {
    const v = r[snake(name)];
    if (spec.fields[name].kind === 'json') {
      try { rec[name] = JSON.parse(v || '{}'); } catch { rec[name] = {}; }
    } else {
      rec[name] = v;
    }
  }
  rec.createdAt = r.created_at;
  rec.updatedAt = r.updated_at;
  if (spec.table === 'assets') {
    rec.hasSecret = !!r.has_secret;
    rec.secrets = r.secret_names ? r.secret_names.split(',') : []; // names of the extra secrets saved
  }
  if (spec.table === 'tasks') rec.doneAt = r.done_at || null;
  if (spec.table === 'customers') rec.avatarVersion = r.avatar_updated_at || null;
  return rec;
}

function selectSql(spec) {
  if (spec.table === 'assets') {
    return `SELECT t.*, t.secret IS NOT NULL AS has_secret,
      (SELECT group_concat(s.name) FROM asset_secrets s WHERE s.asset_id = t.id) AS secret_names FROM assets t`;
  }
  if (spec.table === 'customers') {
    return 'SELECT t.*, a.updated_at AS avatar_updated_at FROM customers t LEFT JOIN avatars a ON a.owner_id = t.id';
  }
  return `SELECT t.* FROM ${spec.table} t`;
}

function listRecords(type) {
  const spec = entity(type);
  return db.prepare(`${selectSql(spec)} WHERE t.deleted_at IS NULL ORDER BY t.created_at`).all()
    .map((r) => rowToRecord(spec, r));
}

function getRecord(type, id) {
  const spec = entity(type);
  const r = db.prepare(`${selectSql(spec)} WHERE t.id = ?`).get(str(id, 200));
  return r ? rowToRecord(spec, r) : null;
}

/** Insert or update one record. Returns it as stored. */
function saveRecord(type, rec) {
  const spec = entity(type);
  const id = str(rec && rec.id, 200);
  if (!id) throw new Error('Missing id');
  const values = cleanRecord(spec, rec);
  const t = now();
  const existing = db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(id);
  if (spec.table === 'tasks') {
    // remember when a task was finished (for "done this week" and the plan's history)
    values.done_at = values.status === 'done' ? (existing?.done_at || t) : null;
  }
  const cols = Object.keys(values);
  if (existing) {
    db.prepare(`UPDATE ${spec.table} SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...cols.map((c) => values[c]), t, id);
  } else {
    db.prepare(`INSERT INTO ${spec.table} (id, ${cols.join(', ')}, created_at, updated_at)
      VALUES (?, ${cols.map(() => '?').join(', ')}, ?, ?)`)
      .run(id, ...cols.map((c) => values[c]), str(rec.createdAt, 64) || t, t);
  }
  return getRecord(type, id);
}

/** Hidden for 30 days (undo, backups), then purged. */
function deleteRecord(type, id) {
  db.prepare(`UPDATE ${entity(type).table} SET deleted_at = ? WHERE id = ?`).run(now(), str(id, 200));
  return true;
}

function restoreRecord(type, id) {
  db.prepare(`UPDATE ${entity(type).table} SET deleted_at = NULL WHERE id = ?`).run(str(id, 200));
  return getRecord(type, id);
}

/** Secret names: 'password' (assets.secret) or an extra one such as 'backupCodes' or 'totp'. */
function secretName(name) {
  const n = String(name || 'password');
  if (!/^[a-zA-Z]{1,40}$/.test(n)) throw new Error('Invalid secret name');
  return n;
}

/** encrypted: Buffer made by main.js (database key or Windows DPAPI, see protectSecret), or null to remove. */
function setAssetSecret(id, encrypted, name = 'password') {
  const n = secretName(name);
  const t = now();
  if (n === 'password') {
    db.prepare('UPDATE assets SET secret = ?, updated_at = ? WHERE id = ?').run(encrypted ? Buffer.from(encrypted) : null, t, str(id, 200));
    return !!encrypted;
  }
  if (encrypted) {
    db.prepare(`INSERT INTO asset_secrets (asset_id, name, secret, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (asset_id, name) DO UPDATE SET secret = excluded.secret, updated_at = excluded.updated_at`)
      .run(str(id, 200), n, Buffer.from(encrypted), t);
  } else {
    db.prepare('DELETE FROM asset_secrets WHERE asset_id = ? AND name = ?').run(str(id, 200), n);
  }
  db.prepare('UPDATE assets SET updated_at = ? WHERE id = ?').run(t, str(id, 200));
  return !!encrypted;
}

/** Every saved secret, deleted assets included: [{ assetId, name, secret }]. */
function listAssetSecrets() {
  const row = (r) => ({ assetId: r.asset_id, name: r.name, secret: Buffer.from(r.secret) });
  return [
    ...db.prepare(`SELECT id AS asset_id, 'password' AS name, secret FROM assets WHERE secret IS NOT NULL`).all().map(row),
    ...db.prepare('SELECT asset_id, name, secret FROM asset_secrets').all().map(row),
  ];
}

/** The same secret encrypted another way (e.g. with the database's key): replaces `from` if still saved. */
function reencryptAssetSecret(id, name, from, to) {
  const n = secretName(name);
  if (n === 'password') {
    db.prepare('UPDATE assets SET secret = ? WHERE id = ? AND secret = ?').run(Buffer.from(to), str(id, 200), Buffer.from(from));
  } else {
    db.prepare('UPDATE asset_secrets SET secret = ? WHERE asset_id = ? AND name = ? AND secret = ?')
      .run(Buffer.from(to), str(id, 200), n, Buffer.from(from));
  }
}

function getAssetSecret(id, name = 'password') {
  const n = secretName(name);
  const r = n === 'password'
    ? db.prepare('SELECT secret FROM assets WHERE id = ?').get(str(id, 200))
    : db.prepare('SELECT secret FROM asset_secrets WHERE asset_id = ? AND name = ?').get(str(id, 200), n);
  return r && r.secret ? Buffer.from(r.secret) : null;
}

// ---------- writing: photos + settings ----------

const AVATAR_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/** Returns the new avatar version (a timestamp) used to bust the image cache. */
function setAvatar(ownerId, mime, bytes) {
  if (!AVATAR_MIMES.has(mime)) throw new Error('Unsupported image type');
  const buf = Buffer.from(bytes);
  if (!buf.length || buf.length > MAX_AVATAR_BYTES) throw new Error('Image is too large');
  const t = now();
  db.prepare(`
    INSERT INTO avatars (owner_id, mime, data, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(owner_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at
  `).run(str(ownerId, 200), mime, buf, t);
  return t;
}

function removeAvatar(ownerId) {
  db.prepare('DELETE FROM avatars WHERE owner_id = ?').run(str(ownerId, 200));
  return true;
}

const SETTING_CHECKS = {
  timeZone: (v) => typeof v === 'string' && v.length <= 100,
  baseCurrency: (v) => typeof v === 'string' && /^[A-Z0-9]{2,6}$/.test(v),
  fxRates: (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 300 &&
    Object.entries(v).every(([k, n]) => /^[A-Z0-9]{2,6}$/.test(k) && Number.isFinite(n) && n > 0),
};

function setSetting(key, value) {
  if (!Object.hasOwn(SETTING_CHECKS, key)) throw new Error('Unknown setting');
  if (!SETTING_CHECKS[key](value)) throw new Error('Invalid setting value');
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, JSON.stringify(value));
  return true;
}

/** How many LinkedIn contacts + messages the upgrade to schema 9 removed when the database was opened (once). */
function takeRemovedLinkedIn() {
  const n = removedLinkedIn;
  removedLinkedIn = 0;
  return n;
}

// ---------- backup / import / export ----------

/** Consistent snapshot of the whole database into a new file (encrypted if the database is). */
function snapshotTo(file) {
  if (crypt) {
    cryptfile.encryptTo(file, crypt.header, crypt.key, db.serialize());
    return;
  }
  if (fs.existsSync(file)) fs.unlinkSync(file);
  db.prepare('VACUUM INTO ?').run(file);
}

/**
 * A database backup (.db, already decrypted) as a JSON backup object, so it can be imported like
 * one. The backup is opened in memory and brought up to the current structure; its file is never
 * changed. The open database is set aside meanwhile (this runs synchronously, so nothing else
 * touches it in between).
 */
function databaseToJson(bytes) {
  const saved = { db, dbFile, crypt, savedChanges };
  db = new DatabaseSync(':memory:');
  dbFile = null;
  crypt = null;
  try {
    db.deserialize(bytes);
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('The backup file is damaged');
    if (db.prepare('PRAGMA user_version').get().user_version > SCHEMA_VERSION) {
      throw new Error('This backup was made by a newer version of the app');
    }
    db.exec('PRAGMA foreign_keys = ON');
    migrate();
    return exportJson();
  } finally {
    try { db.close(); } catch { /* ignore */ }
    ({ db, dbFile, crypt, savedChanges } = saved);
  }
}

/** Encrypt a plain database copy (an old backup) in place with the open database's key. */
function encryptCopy(file) {
  if (!crypt || !cryptfile.isPlainSqlite(file)) return false;
  const copy = new DatabaseSync(file, { readOnly: true });
  let plain;
  try {
    plain = copy.serialize();
  } finally {
    copy.close();
  }
  cryptfile.encryptTo(file, crypt.header, crypt.key, plain);
  for (const leftover of [`${file}-journal`, `${file}-wal`, `${file}-shm`]) {
    try { fs.unlinkSync(leftover); } catch { /* not there */ }
  }
  return true;
}

/** Everything (including photos as data URLs) as a portable JSON object. */
function exportJson() {
  const data = loadAll();
  const avatarFor = (id) => {
    const a = getAvatar(id);
    return a ? `data:${a.mime};base64,${a.data.toString('base64')}` : undefined;
  };
  return {
    format: 'it-business-manager',
    version: 4,
    exportedAt: now(),
    settings: {
      timeZone: data.settings.timeZone,
      baseCurrency: data.settings.baseCurrency,
      fxRates: data.settings.fxRates,
    },
    customers: data.customers.map(({ avatarVersion, ...c }) => ({ ...c, avatar: avatarVersion ? avatarFor(c.id) : undefined })),
    // passwords stay encrypted: they can only be read back by the same Windows user
    assets: data.assets.map(({ hasSecret, secrets, ...a }) => {
      const secret = hasSecret ? getAssetSecret(a.id) : null;
      const extra = Object.fromEntries(secrets.map((n) => [n, getAssetSecret(a.id, n)?.toString('base64')]).filter(([, v]) => v));
      return { ...a, secretEnc: secret ? secret.toString('base64') : undefined,
        secretsEnc: secrets.length ? extra : undefined };
    }),
    transactions: data.transactions,
    goals: data.goals,
    tasks: data.tasks,
    notes: data.notes,
  };
}

const RECORD_LISTS = ['customers', 'assets', 'transactions', 'goals', 'tasks', 'notes'];

/** This app's export, or an older one that also held LinkedIn data (only its business records are used). */
function isValidJson(obj) {
  return !!obj && typeof obj === 'object' &&
    (obj.format === 'it-business-manager' || RECORD_LISTS.some((k) => Array.isArray(obj[k])) ||
      (Array.isArray(obj.contacts) && Array.isArray(obj.messages)));
}

function parseDataUrl(url) {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(String(url || ''));
  return m ? { mime: m[1], data: Buffer.from(m[2], 'base64') } : null;
}

/**
 * Load a JSON backup (this app's export of any version). LinkedIn contacts and messages in backups
 * from before version 3.8 are left out: they belong to the separate LinkedIn Tracker app now.
 * mode 'replace' wipes current data first; 'merge' only adds records whose ids are new.
 */
function importJson(obj, mode = 'replace') {
  if (!isValidJson(obj)) throw new Error('Not a valid backup file');
  tx(() => {
    if (mode === 'replace') {
      db.exec(`
        DELETE FROM transactions; DELETE FROM tasks; DELETE FROM assets; DELETE FROM goals; DELETE FROM customers; DELETE FROM notes;
        DELETE FROM avatars; DELETE FROM settings;
      `);
    }
    const t = now();
    const settings = obj.settings || {};

    // records, in an order where everything they link to already exists
    // (backups from the LinkedIn-only versions simply have none)
    for (const type of ['customer', 'goal', 'asset', 'transaction', 'task', 'note']) {
      const spec = ENTITIES[type];
      const list = Array.isArray(obj[spec.key]) ? obj[spec.key] : [];
      for (const rec of list) {
        if (!rec || !rec.id) continue;
        let values;
        try { values = cleanRecord(spec, rec); } catch { continue; } // skip a damaged record
        const cols = Object.keys(values);
        if (type === 'task') {
          cols.push('done_at');
          values.done_at = values.status === 'done' ? (str(rec.doneAt, 64) || t) : null;
        }
        const { changes } = db.prepare(`INSERT OR IGNORE INTO ${spec.table} (id, ${cols.join(', ')}, created_at, updated_at)
          VALUES (?, ${cols.map(() => '?').join(', ')}, ?, ?)`)
          .run(str(rec.id, 200), ...cols.map((c) => values[c]), str(rec.createdAt, 64) || t, str(rec.updatedAt, 64) || t);
        if (!changes) continue;
        if (type === 'customer') {
          const av = parseDataUrl(rec.avatar);
          if (av) setAvatar(rec.id, av.mime, av.data);
        }
        if (type === 'asset' && typeof rec.secretEnc === 'string' && rec.secretEnc) {
          setAssetSecret(rec.id, Buffer.from(rec.secretEnc, 'base64'));
        }
        if (type === 'asset' && rec.secretsEnc && typeof rec.secretsEnc === 'object') {
          for (const [n, v] of Object.entries(rec.secretsEnc)) {
            if (typeof v === 'string' && v && /^[a-zA-Z]{1,40}$/.test(n)) setAssetSecret(rec.id, Buffer.from(v, 'base64'), n);
          }
        }
      }
    }

    if (mode === 'replace') {
      if (typeof settings.timeZone === 'string') setSetting('timeZone', settings.timeZone);
      try {
        if (settings.baseCurrency) setSetting('baseCurrency', settings.baseCurrency);
        if (settings.fxRates) setSetting('fxRates', settings.fxRates);
      } catch { /* keep the defaults */ }
    }
  });
}

/** How many records of each kind a backup holds (shown before importing it). */
function describeJson(obj) {
  const n = (k) => (Array.isArray(obj[k]) ? obj[k].length : 0);
  return {
    customers: n('customers'),
    assets: n('assets'),
    transactions: n('transactions'),
    goals: n('goals'),
    tasks: n('tasks'),
    notes: n('notes'),
  };
}

module.exports = {
  open, close, currentFile, isOpen, encryption, save, encryptWith, setHeader, encryptCopy,
  loadAll, getAvatar, takeRemovedLinkedIn,
  setAvatar, removeAvatar, setSetting,
  saveRecord, deleteRecord, restoreRecord, setAssetSecret, getAssetSecret, listAssetSecrets, reencryptAssetSecret,
  snapshotTo, exportJson, importJson, isValidJson, describeJson, databaseToJson,
};
