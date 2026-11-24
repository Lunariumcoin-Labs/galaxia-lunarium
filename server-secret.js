// Server-side secret (data/secret.key, 32 random bytes created on first use, never leaves the
// server). Used to sign admin action links (HMAC) and to keep ticket-link tokens encrypted at rest
// (AES-256-GCM) so notification e-mails can include the customer's ticket link.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const plans = require('./api-plans');

const FILE = path.join(plans.DATA_DIR, 'secret.key');
let key = null;
function secret() {
  if (key) return key;
  try {
    key = Buffer.from(fs.readFileSync(FILE, 'utf8').trim(), 'hex');
  } catch (e) {
    key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, key.toString('hex'), { mode: 0o600 });
  }
  return key;
}

const sign = (purpose, value) => crypto.createHmac('sha256', secret()).update(purpose + ':' + value).digest('base64url');
function verify(purpose, value, sig) {
  const expected = Buffer.from(sign(purpose, value));
  const given = Buffer.from(String(sig || ''));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', secret(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}
function decrypt(blob) {
  try {
    const [iv, tag, enc] = String(blob).split('.').map((s) => Buffer.from(s, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', secret(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

module.exports = { sign, verify, encrypt, decrypt };
