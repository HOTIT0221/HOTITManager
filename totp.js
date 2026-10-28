'use strict';

// 2-step verification codes (TOTP, RFC 6238): the 6-digit codes an authenticator app shows,
// worked out from the setup key a service gives you when you turn 2-step verification on.

const crypto = require('crypto');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * The setup key as typed or pasted: base32 ("JBSW Y3DP EHPK 3PXP") or an otpauth:// link
 * from the QR code. Returns { key, digits, period, algorithm } or null if it isn't one.
 */
function parse(text) {
  let s = String(text || '').trim();
  let digits = 6;
  let period = 30;
  let algorithm = 'sha1';
  if (/^otpauth:\/\//i.test(s)) {
    let url;
    try {
      url = new URL(s);
    } catch {
      return null;
    }
    s = url.searchParams.get('secret') || '';
    digits = Number(url.searchParams.get('digits') || 6);
    period = Number(url.searchParams.get('period') || 30);
    algorithm = (url.searchParams.get('algorithm') || 'SHA1').toLowerCase();
  }
  s = s.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (!s || /[^A-Z2-7]/.test(s)) return null;
  if (![6, 7, 8].includes(digits) || !(period >= 10 && period <= 300) || !['sha1', 'sha256', 'sha512'].includes(algorithm)) return null;
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    value = ((value << 5) | BASE32.indexOf(ch)) & 0x1fff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bytes.length < 10) return null; // shorter than any real service uses (80 bits)
  return { key: Buffer.from(bytes), digits, period, algorithm };
}

/** The code for the current time: { code, remaining (seconds it stays valid), period } or null. */
function code(text, now = Date.now()) {
  const p = parse(text);
  if (!p) return null;
  const seconds = Math.floor(now / 1000);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(seconds / p.period)));
  const h = crypto.createHmac(p.algorithm, p.key).update(counter).digest();
  const o = h[h.length - 1] & 0x0f;
  const n = (h.readUInt32BE(o) & 0x7fffffff) % 10 ** p.digits;
  return { code: String(n).padStart(p.digits, '0'), remaining: p.period - (seconds % p.period), period: p.period };
}

module.exports = { parse, code };
