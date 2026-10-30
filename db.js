'use strict';

// SQLite storage, using the SQLite engine built into Electron's Node.js (no native modules to compile).
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

const SCHEMA_VERSION = 8;
const PURGE_DELETED_AFTER_DAYS = 30;

let db = null;
let dbFile = null;
let crypt = null; // { key, header } while an encrypted database is open
let savedChanges = 0; // SQLite's change counter when the encrypted file was last written

const CONTACT_COLS = `id, account_id, name, linkedin_url, nationality, headline, notes, created_at, updated_at`;

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
  migrate();
  ensureAccount();
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
}

/** There is always at least one account (e.g. after importing an old backup into an empty database). */
function ensureAccount() {
  if (db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n) return;
  const id = crypto.randomUUID();
  const t = now();
  db.prepare('INSERT INTO accounts (id, name, linkedin_url, position, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
    .run(id, 'Me', '', t, t);
  db.prepare('UPDATE contacts SET account_id = ? WHERE account_id IS NULL').run(id);
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
    for (const table of ['messages', 'transactions', 'tasks', 'assets', 'goals', 'customers', 'contacts', 'notes']) {
      db.prepare(`DELETE FROM ${table} WHERE deleted_at IS NOT NULL AND deleted_at < ?`).run(cutoff);
    }
    db.prepare(`
      DELETE FROM avatars
      WHERE owner_id NOT IN (SELECT id FROM contacts) AND owner_id NOT IN (SELECT id FROM accounts)
        AND owner_id NOT IN (SELECT id FROM customers)
    `).run();
  });
}

// ---------- reading ----------

function rowToAccount(r) {
  return {
    id: r.id,
    name: r.name,
    linkedinUrl: r.linkedin_url,
    position: r.position,
    createdAt: r.created_at,
    avatarVersion: r.avatar_updated_at || null,
  };
}

function rowToContact(r) {
  return {
    id: r.id,
    accountId: r.account_id,
    name: r.name,
    linkedinUrl: r.linkedin_url,
    nationality: r.nationality,
    headline: r.headline,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    avatarVersion: r.avatar_updated_at || null,
  };
}

function rowToMessage(r) {
  return {
    id: r.id,
    contactId: r.contact_id,
    direction: r.direction,
    text: r.text,
    sentAt: r.sent_at,
    seenAt: r.seen_at || null,
    createdAt: r.created_at,
  };
}

/** Only sent messages can be "seen"; anything else is stored as NULL. */
function seenValue(m) {
  if (m.direction !== 'out' || !m.seenAt) return null;
  const d = new Date(m.seenAt);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid seen time');
  return d.toISOString();
}

function getSettings() {
  // currentAccount: id of the LinkedIn account being viewed, '' = all accounts
  // baseCurrency: totals are shown in it; fxRates: { EUR: 1.08 } = 1 EUR is worth 1.08 of the base currency
  const settings = { timeZone: '', currentAccount: '', baseCurrency: 'USD', fxRates: {} };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    try { settings[r.key] = JSON.parse(r.value); } catch { /* skip bad value */ }
  }
  return settings;
}

function listAccounts() {
  return db.prepare(`
    SELECT ac.*, a.updated_at AS avatar_updated_at
    FROM accounts ac LEFT JOIN avatars a ON a.owner_id = ac.id
    ORDER BY ac.position, ac.created_at
  `).all().map(rowToAccount);
}

function loadAll() {
  const contacts = db.prepare(`
    SELECT c.${CONTACT_COLS.split(', ').join(', c.')}, a.updated_at AS avatar_updated_at
    FROM contacts c LEFT JOIN avatars a ON a.owner_id = c.id
    WHERE c.deleted_at IS NULL
  `).all().map(rowToContact);
  const messages = db.prepare(`
    SELECT m.* FROM messages m JOIN contacts c ON c.id = m.contact_id
    WHERE m.deleted_at IS NULL AND c.deleted_at IS NULL
    ORDER BY m.sent_at, m.created_at
  `).all().map(rowToMessage);

  // attachment metadata only; the image bytes are served through attachment://
  const byMessage = new Map();
  for (const a of db.prepare(`
    SELECT id, message_id, name, mime, width, height, size FROM attachments ORDER BY message_id, position
  `).all()) {
    if (!byMessage.has(a.message_id)) byMessage.set(a.message_id, []);
    byMessage.get(a.message_id).push(rowToAttachment(a));
  }
  for (const m of messages) m.attachments = byMessage.get(m.id) || [];

  return {
    settings: getSettings(),
    accounts: listAccounts(),
    contacts,
    messages,
    ...Object.fromEntries(Object.entries(ENTITIES).map(([type, spec]) => [spec.key, listRecords(type)])),
    file: dbFile,
  };
}

function rowToAttachment(a) {
  return { id: a.id, name: a.name, mime: a.mime, width: a.width, height: a.height, size: a.size };
}

function getAttachment(id) {
  const r = db.prepare('SELECT name, mime, data FROM attachments WHERE id = ?').get(str(id, 200));
  return r ? { name: r.name, mime: r.mime, data: Buffer.from(r.data) } : null;
}

function getAvatar(ownerId) {
  const r = db.prepare('SELECT mime, data FROM avatars WHERE owner_id = ?').get(str(ownerId, 200));
  return r ? { mime: r.mime, data: Buffer.from(r.data) } : null;
}

function counts() {
  return db.prepare(`
    SELECT (SELECT COUNT(*) FROM contacts WHERE deleted_at IS NULL) AS contacts,
           (SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL) AS messages
  `).get();
}

function accountExists(id) {
  return !!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(str(id, 200));
}

function requireAccount(id) {
  if (!accountExists(id)) throw new Error('Unknown account');
  return str(id, 200);
}

// ---------- writing: accounts ----------

function createAccount(a) {
  const name = str(a.name, 200).trim();
  if (!name) throw new Error('Account name is required');
  const t = now();
  const pos = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM accounts').get().p;
  db.prepare('INSERT INTO accounts (id, name, linkedin_url, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(str(a.id, 200), name, str(a.linkedinUrl, 2000), pos, t, t);
  return true;
}

function updateAccount(a) {
  const name = str(a.name, 200).trim();
  if (!name) throw new Error('Account name is required');
  db.prepare('UPDATE accounts SET name = ?, linkedin_url = ?, updated_at = ? WHERE id = ?')
    .run(name, str(a.linkedinUrl, 2000), now(), requireAccount(a.id));
  return true;
}

/**
 * Remove an account. Its contacts (including recently deleted ones) move to `moveTo`;
 * with deleteContacts they are moved and then deleted (recoverable for 30 days / from backups).
 */
function deleteAccount(id, moveTo, deleteContacts = false) {
  return tx(() => {
    requireAccount(id);
    if (db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n < 2) throw new Error("The last account can't be deleted");
    if (moveTo === id) throw new Error('Choose a different account');
    requireAccount(moveTo);
    if (deleteContacts) {
      db.prepare('UPDATE contacts SET deleted_at = ? WHERE account_id = ? AND deleted_at IS NULL').run(now(), id);
    }
    db.prepare('UPDATE contacts SET account_id = ?, updated_at = ? WHERE account_id = ?').run(moveTo, now(), id);
    db.prepare('DELETE FROM avatars WHERE owner_id = ?').run(id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    const cur = getSettings().currentAccount;
    if (cur === id) setSetting('currentAccount', moveTo);
    return true;
  });
}

// ---------- writing: contacts ----------

function createContact(c) {
  const t = now();
  db.prepare(`
    INSERT INTO contacts (${CONTACT_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(str(c.id, 200), requireAccount(c.accountId), str(c.name, 500), str(c.linkedinUrl, 2000),
    str(c.nationality, 200), str(c.headline, 1000), str(c.notes), str(c.createdAt) || t, t);
  return true;
}

function updateContact(c) {
  db.prepare(`
    UPDATE contacts SET account_id = ?, name = ?, linkedin_url = ?, nationality = ?, headline = ?, notes = ?, updated_at = ?
    WHERE id = ?
  `).run(requireAccount(c.accountId), str(c.name, 500), str(c.linkedinUrl, 2000), str(c.nationality, 200),
    str(c.headline, 1000), str(c.notes), now(), str(c.id, 200));
  return true;
}

function deleteContact(id) {
  db.prepare('UPDATE contacts SET deleted_at = ? WHERE id = ?').run(now(), str(id, 200));
  return true;
}

function restoreContact(id) {
  db.prepare('UPDATE contacts SET deleted_at = NULL WHERE id = ?').run(str(id, 200));
  return true;
}

// ---------- writing: messages ----------

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function insertAttachment(messageId, a, position) {
  if (!IMAGE_MIMES.has(a.mime)) throw new Error('Unsupported image type');
  const buf = Buffer.from(a.bytes);
  if (!buf.length || buf.length > MAX_ATTACHMENT_BYTES) throw new Error('Image is too large (max 20 MB)');
  db.prepare(`
    INSERT INTO attachments (id, message_id, position, name, mime, width, height, size, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(str(a.id, 200), str(messageId, 200), position, str(a.name, 300), a.mime,
    Math.round(Number(a.width) || 0), Math.round(Number(a.height) || 0), buf.length, buf, now());
}

function attachmentList(messageId) {
  return db.prepare(`SELECT id, name, mime, width, height, size FROM attachments WHERE message_id = ? ORDER BY position`)
    .all(str(messageId, 200)).map(rowToAttachment);
}

/** attachments: [{ id, name, mime, width, height, bytes }]. Returns the stored attachment metadata. */
function createMessage(m, attachments = []) {
  if (m.direction !== 'in' && m.direction !== 'out') throw new Error('Invalid direction');
  return tx(() => {
    const t = now();
    db.prepare(`
      INSERT INTO messages (id, contact_id, direction, text, sent_at, seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(str(m.id, 200), str(m.contactId, 200), m.direction, str(m.text, 1000000), str(m.sentAt, 64),
      seenValue(m), str(m.createdAt, 64) || t, t);
    attachments.forEach((a, i) => insertAttachment(m.id, a, i));
    db.prepare('UPDATE contacts SET updated_at = ? WHERE id = ?').run(t, str(m.contactId, 200));
    return attachmentList(m.id);
  });
}

/** changes: { add: [new attachments], remove: [attachment ids] }. Returns the stored attachment metadata. */
function updateMessage(m, changes = {}) {
  if (m.direction !== 'in' && m.direction !== 'out') throw new Error('Invalid direction');
  return tx(() => {
    db.prepare(`UPDATE messages SET direction = ?, text = ?, sent_at = ?, seen_at = ?, updated_at = ? WHERE id = ?`)
      .run(m.direction, str(m.text, 1000000), str(m.sentAt, 64), seenValue(m), now(), str(m.id, 200));
    for (const id of changes.remove || []) {
      db.prepare('DELETE FROM attachments WHERE id = ? AND message_id = ?').run(str(id, 200), str(m.id, 200));
    }
    let pos = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM attachments WHERE message_id = ?')
      .get(str(m.id, 200)).p;
    for (const a of changes.add || []) insertAttachment(m.id, a, pos++);
    return attachmentList(m.id);
  });
}

function deleteMessage(id) {
  db.prepare('UPDATE messages SET deleted_at = ? WHERE id = ?').run(now(), str(id, 200));
  return true;
}

function restoreMessage(id) {
  db.prepare('UPDATE messages SET deleted_at = NULL WHERE id = ?').run(str(id, 200));
  return true;
}

/** Mark a sent message as seen at `seenAt` (ISO string), or not seen (null). */
function setMessageSeen(id, seenAt) {
  const value = seenValue({ direction: 'out', seenAt });
  db.prepare(`UPDATE messages SET seen_at = ?, updated_at = ? WHERE id = ? AND direction = 'out'`)
    .run(value, now(), str(id, 200));
  return value;
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
      contactId: ref('contacts'),
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
  currentAccount: (v) => typeof v === 'string' && v.length <= 100,
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
    ensureAccount();
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
    accounts: data.accounts.map(({ avatarVersion, ...a }) => ({ ...a, avatar: avatarVersion ? avatarFor(a.id) : undefined })),
    contacts: data.contacts.map(({ avatarVersion, ...c }) => ({ ...c, avatar: avatarVersion ? avatarFor(c.id) : undefined })),
    messages: data.messages.map((m) => ({
      ...m,
      attachments: m.attachments.map((a) => {
        const full = getAttachment(a.id);
        return { ...a, data: `data:${full.mime};base64,${full.data.toString('base64')}` };
      }),
    })),
  };
}

function isValidJson(obj) {
  return obj && typeof obj === 'object' && Array.isArray(obj.contacts) && Array.isArray(obj.messages);
}

function parseDataUrl(url) {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(String(url || ''));
  return m ? { mime: m[1], data: Buffer.from(m[2], 'base64') } : null;
}

/**
 * Load a JSON backup (this app's export of any version, or the old data.json format).
 * mode 'replace' wipes current data first; 'merge' only adds records whose ids are new.
 * Backups from before multiple accounts had one implicit account (settings.myName / myAvatar).
 */
function importJson(obj, mode = 'replace') {
  if (!isValidJson(obj)) throw new Error('Not a valid backup file');
  tx(() => {
    if (mode === 'replace') {
      db.exec(`
        DELETE FROM transactions; DELETE FROM tasks; DELETE FROM assets; DELETE FROM goals; DELETE FROM customers; DELETE FROM notes;
        DELETE FROM attachments; DELETE FROM messages; DELETE FROM contacts;
        DELETE FROM avatars; DELETE FROM accounts; DELETE FROM settings;
      `);
    }
    const t = now();
    const settings = obj.settings || {};

    // accounts
    const insAccount = db.prepare(`
      INSERT OR IGNORE INTO accounts (id, name, linkedin_url, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    `);
    let pos = db.prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM accounts').get().p;
    for (const a of Array.isArray(obj.accounts) ? obj.accounts : []) {
      if (!a || !a.id || !a.name) continue;
      const { changes } = insAccount.run(str(a.id, 200), str(a.name, 200), str(a.linkedinUrl, 2000), pos++,
        str(a.createdAt) || t, t);
      const av = parseDataUrl(a.avatar);
      if (changes && av) setAvatar(a.id, av.mime, av.data);
    }
    // an old single-account backup: its contacts belong to an account made from settings.myName,
    // or (when merging) to your first account
    let fallback = db.prepare('SELECT id FROM accounts ORDER BY position, created_at LIMIT 1').get()?.id;
    if (!Array.isArray(obj.accounts) && (mode === 'replace' || !fallback)) {
      fallback = crypto.randomUUID();
      insAccount.run(fallback, str(settings.myName || 'Me', 200), '', pos++, t, t);
      const me = parseDataUrl(settings.myAvatar);
      if (me) setAvatar(fallback, me.mime, me.data);
    }
    if (!fallback) {
      fallback = crypto.randomUUID();
      insAccount.run(fallback, 'Me', '', pos++, t, t);
    }

    // contacts + messages
    const insContact = db.prepare(`
      INSERT OR IGNORE INTO contacts (${CONTACT_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insMsg = db.prepare(`
      INSERT OR IGNORE INTO messages (id, contact_id, direction, text, sent_at, seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const ids = new Set();
    for (const c of obj.contacts) {
      if (!c || !c.id || !c.name) continue;
      const accountId = c.accountId && accountExists(c.accountId) ? c.accountId : fallback;
      insContact.run(str(c.id, 200), accountId, str(c.name, 500), str(c.linkedinUrl, 2000),
        str(countryFromLegacyValue(c.nationality), 200), str(c.headline, 1000), str(c.notes),
        str(c.createdAt) || t, str(c.updatedAt) || t);
      ids.add(String(c.id));
      const av = parseDataUrl(c.avatar);
      if (av && (mode === 'replace' || !getAvatar(c.id))) setAvatar(c.id, av.mime, av.data);
    }
    for (const m of obj.messages) {
      if (!m || !m.id || !ids.has(String(m.contactId)) || (m.direction !== 'in' && m.direction !== 'out')) continue;
      let seen = null;
      try { seen = seenValue(m); } catch { /* ignore a bad seen time in old files */ }
      const { changes } = insMsg.run(str(m.id, 200), str(m.contactId, 200), m.direction, str(m.text, 1000000),
        str(m.sentAt, 64), seen, str(m.createdAt, 64) || t, t);
      if (!changes || !Array.isArray(m.attachments)) continue;
      m.attachments.forEach((a, i) => {
        const img = a && parseDataUrl(a.data);
        if (img) insertAttachment(m.id, { ...a, mime: img.mime, bytes: img.data }, i);
      });
    }

    // business records, in an order where everything they link to already exists
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
      setSetting('currentAccount', '');
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
    contacts: n('contacts'),
    messages: n('messages'),
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
  loadAll, counts, getAvatar, getAttachment,
  createAccount, updateAccount, deleteAccount,
  createContact, updateContact, deleteContact, restoreContact,
  createMessage, updateMessage, deleteMessage, restoreMessage, setMessageSeen,
  setAvatar, removeAvatar, setSetting,
  saveRecord, deleteRecord, restoreRecord, setAssetSecret, getAssetSecret, listAssetSecrets, reencryptAssetSecret,
  snapshotTo, exportJson, importJson, isValidJson, describeJson, databaseToJson,
};
