'use strict';

// Passwords / API keys are encrypted with Windows DPAPI for the current Windows user (the same
// protection Windows uses for saved Wi-Fi and browser passwords). Each value is protected on its
// own, so a copy of the database or a JSON backup keeps working for this Windows account, but the
// values can't be read by other users or on another PC. DPAPI is reached through the PowerShell
// that ships with Windows, so no native module is needed.

const { execFile } = require('child_process');

// extra input that must match to decrypt: another program calling DPAPI for this user can't
// simply unprotect the values without knowing it
const ENTROPY = 'IT Business Manager secret v1';

function dpapi(method, input) {
  const script = [
    'Add-Type -AssemblyName System.Security',
    `$e = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
    '$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    `$out = [Security.Cryptography.ProtectedData]::${method}($in, $e, 'CurrentUser')`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('; ');
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(Buffer.from(stdout.trim(), 'base64'));
      });
    // the value goes in through stdin, never on a command line
    child.stdin.end(input.toString('base64'));
  });
}

/** Encrypt text for the current Windows user. */
async function protect(text) {
  const out = await dpapi('Protect', Buffer.from(String(text), 'utf8'));
  if (!out.length) throw new Error('Windows could not encrypt the password');
  return out;
}

/** Decrypt a value made by protect(). */
async function unprotect(blob) {
  try {
    return (await dpapi('Unprotect', Buffer.from(blob))).toString('utf8');
  } catch {
    throw new Error('This password was saved by another Windows user or on another PC, so it can’t be read here.');
  }
}

/**
 * Many values in one PowerShell call (starting PowerShell takes most of the time).
 * method 'Protect' | 'Unprotect'; returns a Buffer per input, or null where that one failed.
 */
function dpapiMany(method, inputs) {
  if (!inputs.length) return Promise.resolve([]);
  const script = [
    'Add-Type -AssemblyName System.Security',
    `$e = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}')`,
    "foreach ($l in ([Console]::In.ReadToEnd() -split '\\n')) { $l = $l.Trim(); if (-not $l) { continue }; " +
      `try { $out = [Security.Cryptography.ProtectedData]::${method}([Convert]::FromBase64String($l), $e, 'CurrentUser'); ` +
      '[Console]::Out.WriteLine([Convert]::ToBase64String($out)) } catch { [Console]::Out.WriteLine(\'-\') } }',
  ].join('; ');
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        const lines = stdout.split(/\r?\n/);
        resolve(inputs.map((_v, i) => (lines[i] && lines[i] !== '-' ? Buffer.from(lines[i], 'base64') : null)));
      });
    child.stdin.end(inputs.map((v) => Buffer.from(v).toString('base64')).join('\n'));
  });
}

/** protect() for many texts at once: an encrypted Buffer (or null) per text. */
function protectMany(texts) {
  return dpapiMany('Protect', texts.map((t) => Buffer.from(String(t), 'utf8')));
}

/** unprotect() for many values at once: the text, or null where it can't be read here. */
async function unprotectMany(blobs) {
  return (await dpapiMany('Unprotect', blobs)).map((b) => (b ? b.toString('utf8') : null));
}

module.exports = { protect, unprotect, protectMany, unprotectMany };
