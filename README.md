# HOTIT Manager

A private Windows desktop app for running a small IT business. It started out as LinkedIn Message
Tracker; since version 3.8 the LinkedIn message log is a separate app, **LinkedIn Tracker**.

| Section | What it holds |
|---|---|
| **Overview** | This month's income, expenses and profit, active clients, running costs, balances, a 12-month growth chart, what's coming up (renewals, task and goal deadlines), goals, top clients |
| **Customers** | Clients, collaborators and leads: contact details, country, tags, notes, photo, what they paid you, tasks and assets (click an email, phone, website or profile link to copy it) |
| **Assets** | Servers/VPS, domains, online accounts, GitHub accounts, email accounts, payment accounts (PayPal, Payoneer, Wise…), bank accounts, software licenses: logins, encrypted passwords / API keys, cost, renewal dates, balances. Email, GitHub and online accounts also keep encrypted backup codes, app passwords, security answers, GitHub access tokens and a 2-step setup key — the app shows the current 6-digit code (`totp.js`) |
| **Finance** | Income and expenses in any currency, by month, with period filters, search and CSV export |
| **Goals & Plans** | Goals measured from your data (income, profit, active clients, tasks done) or by hand, and a To do / In progress / Done task board |
| **Notes** | Text you use again and again (intros, replies, bank details, proposal paragraphs) saved under a title, with a tag; one click copies it. Pinned notes stay at the top |

**Settings → Appearance** switches between a light and a dark theme (or follows Windows) and can put a color or a picture of your own behind the pages; it is saved per PC.

`Ctrl+Shift+1…6` switches sections, `Ctrl+N` adds something to the current section, `Ctrl+F` searches it.

## Use it

- **Install:** run `dist\IT Business Manager Setup 3.8.0.exe` (installs over earlier versions), or
- **No install:** run `dist\ITBusinessManager-Portable-3.8.0.exe`.

## Your data

Everything lives in one SQLite database, by default `%APPDATA%\IT Business Manager\tracker.db`.
Every change is written immediately.

- On the first start after the rename, the old `%APPDATA%\LinkedIn Message Tracker` folder is copied
  to the new one. The old folder is left untouched (it gets a `MOVED…txt` note) and can be deleted
  once you have checked your data.
- **LinkedIn messages (version 3.8):** the first start of 3.8 keeps a copy of the database as it was
  (`backups\before-upgrade-from-v8-….db`), then removes the LinkedIn contacts, messages and images and
  compacts the file. LinkedIn Tracker imports them from that copy (or from any older backup).
- **File → Export backup…** saves a copy of the whole database (`.db`, encrypted when the database is).
  **Import backup…** restores or merges such a copy, a daily/monthly backup, or a JSON export from versions up to 3.1.1
  (LinkedIn contacts and messages in older backups are left out).
- **Settings → Change location…** moves the database, e.g. into a OneDrive/Dropbox folder.
- Automatic backups in `%APPDATA%\IT Business Manager\backups`: daily (last 30) and monthly (kept forever),
  plus a copy before each database upgrade or import.
- Deleted records are kept hidden for 30 days (with Undo) before being purged.
- Amounts keep their own currency; totals use the main currency and the exchange rates in Settings.
- **Encryption (Settings → Security):** the whole database can be encrypted with a password
  (`cryptfile.js`: AES-256-GCM, key derived with scrypt). The file is decrypted into memory when the
  app opens and written back encrypted after every change; backups and exported copies are
  encrypted too. "Remember on this PC" keeps the key in `keys.json`, protected with DPAPI for your
  Windows account. **A forgotten password can't be recovered.**
- Passwords / API keys, backup codes and 2-step keys on assets are encrypted once more on their own:
  - **encrypted database:** with a key derived from the database's key (`cryptfile.js`), so **the app,
    the database file and its password are enough to get all your data back on any PC**. Secrets
    saved earlier for your Windows account are moved to the database key the next time the app
    opens on the PC that saved them; secrets in an imported backup are converted too.
  - **plain database:** with Windows DPAPI for your Windows user account (`vault.js`): only that
    account on this PC can read them. Encrypt the database to make them portable.

## Develop

```
npm install
npm start        # run the app
npm run dist     # build installer + portable exe into dist/
```

If you run these from a VS Code terminal and Electron starts as plain Node, clear `ELECTRON_RUN_AS_NODE` first.
