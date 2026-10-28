'use strict';

// ============================================================================
// Database encryption: the lock screen shown at start, the "Encrypt your database" and
// "Change password" dialogs, and the Security part of Settings. The work itself happens in the
// main process (window.api.security → main.js / cryptfile.js).
// ============================================================================

const MIN_PASSWORD = 8;

/** Shows the lock screen and resolves once the database is open. */
function unlockScreen() {
  return new Promise((resolve) => {
    const lock = $('#lock');
    const pw = $('#lockPassword');
    const err = $('#lockError');
    const btn = $('#lockOpen');
    const showFile = (st) => {
      $('#lockFile').textContent = st.file;
      $('#lockFile').title = st.file;
    };
    const done = () => {
      lock.classList.add('hidden');
      pw.value = '';
      resolve();
    };
    lock.classList.remove('hidden');
    window.api.security('state').then(showFile);
    pw.focus();

    $('#lockForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      if (!pw.value) {
        pw.focus();
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Opening…';
      err.textContent = '';
      try {
        const r = await window.api.security('unlock', pw.value, $('#lockRemember').checked);
        if (r.ok) {
          done();
          return;
        }
        err.textContent = r.error;
        pw.select();
      } finally {
        btn.disabled = false;
        btn.textContent = 'Open';
      }
    });
    $('#lockPick').addEventListener('click', async () => {
      const st = await window.api.security('pickFile');
      if (st.status !== 'locked') {
        done();
        return;
      }
      showFile(st);
      err.textContent = '';
      pw.value = '';
      pw.focus();
    });
  });
}

/** Two "new password" inputs + checks, shared by the encrypt and change-password dialogs. */
function newPasswordFieldsHtml(label = 'Password') {
  return `
    <div class="field">
      <label for="pw-new">${esc(label)}</label>
      <input type="password" id="pw-new" autocomplete="new-password" spellcheck="false">
      <div class="help">At least ${MIN_PASSWORD} characters. A few unrelated words make a strong password that is easy to remember.</div>
    </div>
    <div class="field">
      <label for="pw-again">Type it again</label>
      <input type="password" id="pw-again" autocomplete="new-password" spellcheck="false">
    </div>`;
}

/** The new password, or null (with a message) if it is too short or the two don't match. */
function readNewPassword() {
  const pw = $('#pw-new').value;
  if ([...pw].length < MIN_PASSWORD) {
    $('#pw-new').focus();
    toast(`Please use at least ${MIN_PASSWORD} characters.`);
    return null;
  }
  if ($('#pw-again').value !== pw) {
    $('#pw-again').select();
    toast('The two passwords are not the same.');
    return null;
  }
  return pw;
}

const FORGET_WARNING = `<div class="note warn"><strong>If you forget this password, your data is lost.</strong> It can’t be reset or
  recovered by anyone. Write it down and keep it somewhere safe.</div>`;

function openEncryptDialog() {
  openModal({
    title: 'Encrypt your database',
    body: `
      <p class="modal-text">Everything in the database (customers, assets, finances, goals, LinkedIn messages and images) is
        encrypted with your password. A copy of the file can't be read without it. Your existing automatic backups are
        encrypted too.</p>
      ${newPasswordFieldsHtml()}
      <div class="field">
        <label class="check"><input type="checkbox" id="pw-remember" checked> Remember on this PC, so the app opens without asking</label>
        <div class="help">Remembered for your Windows account only. Without it you type the password each time the app starts.</div>
      </div>
      ${FORGET_WARNING}
      <label class="check"><input type="checkbox" id="pw-ack"> I have written the password down</label>`,
    okText: 'Encrypt',
    onOpen() {
      $('#pw-new').focus();
    },
    async onOk() {
      const pw = readNewPassword();
      if (!pw) return false;
      if (!$('#pw-ack').checked) {
        $('#pw-ack').focus();
        toast('Please write the password down first.');
        return false;
      }
      $('#modalOk').textContent = 'Encrypting…';
      try {
        const r = await window.api.security('encrypt', pw, $('#pw-remember').checked);
        const failed = r.copies.failed.length;
        toast(failed
          ? `Database encrypted. ${failed} old backup${failed === 1 ? '' : 's'} could not be encrypted (see the backups folder).`
          : 'Database encrypted');
        if (failed) console.error('Backups not encrypted:', r.copies.failed);
        return true;
      } catch (err) {
        toast(errorText(err));
        $('#modalOk').textContent = 'Encrypt';
        return false;
      }
    },
  });
}

function openChangePasswordDialog() {
  openModal({
    title: 'Change password',
    body: `
      <div class="field">
        <label for="pw-current">Current password</label>
        <input type="password" id="pw-current" autocomplete="current-password" spellcheck="false">
      </div>
      ${newPasswordFieldsHtml('New password')}
      <div class="help">Backups made before now still open with the old password (and on this PC, if it remembers the password).</div>
      ${FORGET_WARNING}`,
    okText: 'Change password',
    onOpen() {
      $('#pw-current').focus();
    },
    async onOk() {
      const pw = readNewPassword();
      if (!pw) return false;
      try {
        const r = await window.api.security('changePassword', $('#pw-current').value, pw);
        if (!r.ok) {
          $('#pw-current').select();
          toast(r.error);
          return false;
        }
      } catch (err) {
        toast(errorText(err));
        return false;
      }
      toast('Password changed');
      return true;
    },
  });
}

/** Error text from the main process without Electron's "Error invoking remote method…" prefix. */
function errorText(err) {
  return String(err && err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** The Security part of Settings. */
function securityFieldHtml() {
  return `
    <div class="field" id="s-security">
      <label>Security</label>
      <div class="security-state" id="s-sec-state">…</div>
      <div class="settings-buttons" id="s-sec-buttons"></div>
    </div>`;
}

function setupSecurityField() {
  const draw = (st) => {
    const box = $('#s-sec-state');
    if (!box) return; // dialog closed
    if (st.status === 'plain') {
      box.innerHTML = `<span class="sec-badge off">Not encrypted</span>
        <span class="help">Anyone who gets a copy of the database file can read it.</span>`;
      $('#s-sec-buttons').innerHTML = '<button type="button" class="btn secondary small" id="s-encrypt">Encrypt with a password…</button>';
      $('#s-encrypt').addEventListener('click', () => {
        closeModal();
        openEncryptDialog();
      });
      return;
    }
    box.innerHTML = `<span class="sec-badge on">Encrypted</span>
      <span class="help">The database file and its backups can only be opened with your password.</span>
      <label class="check"><input type="checkbox" id="s-remember" ${st.remembered ? 'checked' : ''}>
        Remember the password on this PC</label>`;
    $('#s-sec-buttons').innerHTML = '<button type="button" class="btn secondary small" id="s-password">Change password…</button>';
    $('#s-password').addEventListener('click', () => {
      closeModal();
      openChangePasswordDialog();
    });
    $('#s-remember').addEventListener('change', async (e) => {
      try {
        draw(await window.api.security('setRemember', e.target.checked));
        toast(e.target.checked ? 'This PC remembers the password' : 'The app will ask for the password when it starts');
      } catch (err) {
        e.target.checked = !e.target.checked;
        toast(errorText(err));
      }
    });
  };
  window.api.security('state').then(draw);
}

/** The main process asks for the password of an encrypted backup being imported. */
function bindPasswordRequests() {
  window.api.onAskPassword(({ fileName, error }, reply) => {
    let answered = false;
    const answer = (password) => {
      if (answered) return;
      answered = true;
      reply(password);
    };
    openModal({
      title: 'Password for this backup',
      body: `
        <p class="modal-text"><strong>${esc(fileName)}</strong> is encrypted with a password this PC doesn't remember.
          Enter the password that was in use when the backup was made.</p>
        <div class="field">
          <label for="pw-backup">Password</label>
          <input type="password" id="pw-backup" spellcheck="false">
          ${error ? `<div class="error">${esc(error)}</div>` : ''}
        </div>`,
      okText: 'Open backup',
      onOpen() {
        $('#pw-backup').focus();
        modalCleanup.push(() => answer(null)); // closed without OK
      },
      onOk() {
        if (!$('#pw-backup').value) {
          $('#pw-backup').focus();
          return false;
        }
        answer($('#pw-backup').value);
        return true;
      },
    });
  });
}

/** Once, after the update that added encryption: suggest encrypting a plain database. */
async function maybeOfferEncryption() {
  try {
    if (localStorage.getItem('encryptOffered')) return;
    localStorage.setItem('encryptOffered', '1');
  } catch {
    return;
  }
  if ((await window.api.security('state')).status !== 'plain' || $('#modal').open) return;
  openModal({
    title: 'Protect your data with a password?',
    body: `<p class="modal-text">Your database is not encrypted, so anyone who gets a copy of the file can read your customers,
      finances, bank details and messages. You can encrypt it with a password now, or later in Settings → Security.</p>`,
    okText: 'Set a password…',
    onOk() {
      setTimeout(openEncryptDialog);
      return true;
    },
  });
}
