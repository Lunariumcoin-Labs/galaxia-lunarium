// User accounts for the GaláxiaLunarium panel ("Minha conta"): sign-up / sign-in with e-mail and
// password, and a panel listing the account's API keys (plan, usage, expiry) and its orders/tickets.
//
// The e-mail address is confirmed by a link sent to it (valid 48h) before the first sign-in; a
// forgotten password is reset through a one-time link sent by e-mail (valid 1h). Link tokens are
// stored only as SHA-256. Once the address is confirmed, orders placed with that same e-mail are
// linked to the account; other orders/keys are linked by proof (ticket link token or the key itself).
//
// Passwords: scrypt with a per-account salt. Sessions: random token in an HttpOnly, Secure,
// SameSite=Lax cookie; only its SHA-256 is stored (data/sessions.json). Sign-in attempts are rate
// limited per IP and per e-mail. State-changing requests must be same-origin JSON.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const plans = require('./api-plans');

const ACCOUNTS_FILE = path.join(plans.DATA_DIR, 'accounts.json');
const SESSIONS_FILE = path.join(plans.DATA_DIR, 'sessions.json');
const ORDERS_FILE = path.join(plans.DATA_DIR, 'api-orders.json');
const COOKIE = 'glx_session';
const SESSION_DAYS = 30;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const scrypt = (password, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(String(password), salt, 64, { N: 16384, r: 8, p: 1 }, (e, key) => (e ? reject(e) : resolve(key.toString('hex'))));
});
const isEmail = (s) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(s);
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const mailer = require('./mailer');
const tpl = require('./email-template');
const MAIL_STR = require('./account-emails-i18n');
const ORDER_STR = require('./emails-i18n');
const VERIFY_TTL_MS = 48 * 3600 * 1000;
const RESET_TTL_MS = 3600 * 1000;
const validLang = (l) => (Object.prototype.hasOwnProperty.call(MAIL_STR, l) ? l : 'pt-BR');
const newToken = () => crypto.randomBytes(32).toString('base64url');

// ---- account e-mails (in the account's language, GaláxiaLunarium template)
// pageLang: language of the page that asked for the e-mail; without it, the account's language
const pageLangOf = (body) => { const l = String((body || {}).lang || ''); return Object.prototype.hasOwnProperty.call(MAIL_STR, l) ? l : null; };
function accountMail(a, kind, link, pageLang) {
  const lang = validLang(pageLang || a.lang);
  const M = MAIL_STR[lang];
  const O = ORDER_STR[lang] || ORDER_STR.en;
  const hello = O[25].replace('{name}', a.name);
  const t = kind === 'verify' ? { subject: M[0], intro: M[1], cta: M[2], note: M[3] }
    : kind === 'reset' ? { subject: M[4], intro: M[5], cta: M[6], note: M[7] }
      : { subject: M[10], intro: M[11] };
  let body = tpl.p(hello) + tpl.p(t.intro);
  if (link) body += tpl.button(link, t.cta) + tpl.small(t.note) + tpl.small(M[8]) + tpl.small(M[9]) + tpl.linkFallback(link);
  const text = [hello, t.intro, link ? `${t.cta}: ${link}` : '', t.note || '', link ? M[8] : '', O[18]].filter(Boolean).join('\n\n');
  return mailer.send({ to: a.email, subject: t.subject, html: tpl.layout(body, O[18], { lang, preheader: t.intro }), text });
}
const accountLink = (a, param, token, pageLang) => `${tpl.SITE}/?view=conta&lang=${encodeURIComponent(validLang(pageLang || a.lang))}&${param}=${encodeURIComponent(token)}`;
// sets a new confirmation token on the account; returns the function that e-mails it (after saving)
function sendVerification(a, pageLang) {
  const token = newToken();
  a.verify_hash = sha(token);
  a.verify_expires_at = new Date(Date.now() + VERIFY_TTL_MS).toISOString();
  return () => accountMail(a, 'verify', accountLink(a, 'verify', token, pageLang), pageLang);
}
// once the address is proven, orders placed with it (and their keys) join the account
function linkOrdersByEmail(a) {
  const orders = plans.readJson(ORDERS_FILE, []);
  const keyIds = [];
  let changed = false;
  orders.forEach((o) => {
    if (!o.account_id && o.customer && o.customer.email === a.email) { o.account_id = a.id; changed = true; if (o.key_id) keyIds.push(o.key_id); }
  });
  if (changed) plans.writeJsonAtomic(ORDERS_FILE, orders);
  if (keyIds.length) {
    const keys = plans.readKeys();
    keys.forEach((k) => { if (keyIds.includes(k.id) && !k.account_id) k.account_id = a.id; });
    plans.writeKeys(keys);
  }
}

const readAccounts = () => plans.readJson(ACCOUNTS_FILE, []);
const writeAccounts = (list) => plans.writeJsonAtomic(ACCOUNTS_FILE, list);

// ---- sessions (persisted so a restart doesn't sign everyone out)
let sessions = new Map(Object.entries(plans.readJson(SESSIONS_FILE, {})));
function saveSessions() {
  const now = Date.now();
  sessions.forEach((s, k) => { if (Date.parse(s.expires_at) < now) sessions.delete(k); });
  plans.writeJsonAtomic(SESSIONS_FILE, Object.fromEntries(sessions));
}
function readCookie(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
// Account of the signed-in user of this request, or null (used by the orders API too).
function sessionAccount(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const s = sessions.get(sha(token));
  if (!s || Date.parse(s.expires_at) < Date.now()) return null;
  return readAccounts().find((a) => a.id === s.account_id) || null;
}
function startSession(res, account) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(sha(token), { account_id: account.id, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + SESSION_DAYS * 86400000).toISOString() });
  saveSessions();
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`);
}
function endSessions(accountId, exceptHash) {
  sessions.forEach((s, k) => { if (s.account_id === accountId && k !== exceptHash) sessions.delete(k); });
  saveSessions();
}

// ---- abuse protection: failed attempts per IP and per e-mail (15 min window)
const attempts = new Map();
function tooMany(key, max) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  attempts.set(key, list);
  return list.length >= max;
}
function fail(key) { (attempts.get(key) || attempts.set(key, []).get(key)).push(Date.now()); }
setInterval(() => { const now = Date.now(); attempts.forEach((l, k) => { if (!l.some((t) => now - t < 15 * 60 * 1000)) attempts.delete(k); }); }, 10 * 60 * 1000).unref();
const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

const ID_RE = /^[a-z0-9-]{1,40}$/;
const cleanIds = (v) => [...new Set((Array.isArray(v) ? v : []).map(String).filter((x) => ID_RE.test(x)))].slice(0, 100);
const favoritesOf = (a) => ({ coins: (a.favorites && a.favorites.coins) || [], exchanges: (a.favorites && a.favorites.exchanges) || [] });
const alertsOf = (a) => Object.fromEntries(Object.entries(a.alerts || {}).map(([k, v]) => [k, { up: v.up, down: v.down, base: v.base, bases: v.bases || null, base_at: v.base_at, lang: v.lang || null }]));

function publicAccount(a) {
  return { id: a.id, email: a.email, name: a.name, company: a.company || '', created_at: a.created_at, lang: a.lang || null };
}

function mount(app) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (req.method !== 'GET') {
      // same-origin JSON only (blocks cross-site form posts)
      const origin = req.headers.origin;
      if (origin) {
        let host = '';
        try { host = new URL(origin).host; } catch (e) { /* invalid origin */ }
        if (host !== req.headers.host) return res.status(403).json({ ok: false, error: 'cross-origin request refused' });
      }
      if (!/application\/json/.test(String(req.headers['content-type'] || ''))) return res.status(415).json({ ok: false, error: 'JSON body required' });
    }
    next();
  });
  router.use(express.json({ limit: '8kb' }));
  const err = (res, status, error, code) => res.status(status).json({ ok: false, error, code });
  const auth = (req, res, next) => {
    const a = sessionAccount(req);
    if (!a) return err(res, 401, 'not signed in', 'auth');
    req.account = a;
    next();
  };

  router.post('/register', async (req, res) => {
    const ip = clientIp(req);
    if (tooMany('reg:' + ip, 5)) return err(res, 429, 'too many sign-ups from this IP, try again later', 'rate');
    const b = req.body || {};
    const email = clean(b.email, 120).toLowerCase();
    const name = clean(b.name, 80);
    const password = String(b.password || '');
    if (!isEmail(email)) return err(res, 400, 'a valid e-mail is required', 'email');
    if (name.length < 2) return err(res, 400, 'name is required', 'name');
    if (password.length < 8 || password.length > 200) return err(res, 400, 'the password needs at least 8 characters', 'password');
    const list = readAccounts();
    if (list.some((a) => a.email === email)) return err(res, 409, 'this e-mail already has an account', 'exists');
    fail('reg:' + ip); // counts sign-ups per IP
    const salt = crypto.randomBytes(16).toString('hex');
    const account = {
      id: crypto.randomBytes(6).toString('hex'),
      email,
      name,
      company: clean(b.company, 80),
      lang: validLang(String(b.lang || '')),
      pass_salt: salt,
      pass_hash: await scrypt(password, salt),
      email_verified: false,
      created_at: new Date().toISOString(),
    };
    const mail = sendVerification(account);
    list.push(account);
    writeAccounts(list);
    await mail();
    // no session yet: the first sign-in comes from the confirmation link
    res.json({ ok: true, data: { pending_verification: true, email } });
  });

  router.post('/login', async (req, res) => {
    const ip = clientIp(req);
    const b = req.body || {};
    const email = clean(b.email, 120).toLowerCase();
    if (tooMany('ip:' + ip, 20) || tooMany('em:' + email, 8)) return err(res, 429, 'too many attempts, try again in a few minutes', 'rate');
    const list = readAccounts();
    const a = list.find((x) => x.email === email);
    const hash = await scrypt(String(b.password || ''), a ? a.pass_salt : 'no-account-salt');
    if (!a || !crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(a.pass_hash, 'hex'))) {
      fail('ip:' + ip); fail('em:' + email);
      return err(res, 401, 'wrong e-mail or password', 'credentials');
    }
    if (a.email_verified === false) return err(res, 403, 'confirm your e-mail first', 'unverified');
    a.last_login_at = new Date().toISOString();
    if (pageLangOf(b)) a.lang = pageLangOf(b);
    writeAccounts(list);
    startSession(res, a);
    res.json({ ok: true, data: { account: publicAccount(a) } });
  });

  // confirmation link (?verify=...): activates the account and signs in
  router.post('/verify', (req, res) => {
    const ip = clientIp(req);
    if (tooMany('link:' + ip, 20)) return err(res, 429, 'too many attempts, try again in a few minutes', 'rate');
    const h = sha(String((req.body || {}).token || ''));
    const list = readAccounts();
    const a = list.find((x) => x.verify_hash && x.verify_hash === h);
    if (!a || Date.parse(a.verify_expires_at) < Date.now()) { fail('link:' + ip); return err(res, 400, 'invalid or expired link', 'link'); }
    a.email_verified = true;
    a.email_verified_at = new Date().toISOString();
    delete a.verify_hash;
    delete a.verify_expires_at;
    a.last_login_at = a.email_verified_at;
    if (pageLangOf(req.body)) a.lang = pageLangOf(req.body);
    writeAccounts(list);
    linkOrdersByEmail(a);
    startSession(res, a);
    res.json({ ok: true, data: { account: publicAccount(a), verified: true } });
  });

  // new confirmation e-mail; the answer never reveals whether the e-mail has an account
  router.post('/resend', async (req, res) => {
    const ip = clientIp(req);
    const email = clean((req.body || {}).email, 120).toLowerCase();
    if (tooMany('mail:' + ip, 6) || tooMany('mailto:' + email, 3)) return err(res, 429, 'too many attempts, try again in a few minutes', 'rate');
    fail('mail:' + ip); fail('mailto:' + email);
    const list = readAccounts();
    const a = list.find((x) => x.email === email);
    if (a && a.email_verified === false) {
      const mail = sendVerification(a, pageLangOf(req.body));
      writeAccounts(list);
      await mail();
    }
    res.json({ ok: true });
  });

  // forgotten password: a one-time link by e-mail (same answer whether or not the account exists)
  router.post('/forgot', async (req, res) => {
    const ip = clientIp(req);
    const email = clean((req.body || {}).email, 120).toLowerCase();
    if (tooMany('mail:' + ip, 6) || tooMany('mailto:' + email, 3)) return err(res, 429, 'too many attempts, try again in a few minutes', 'rate');
    fail('mail:' + ip); fail('mailto:' + email);
    const list = readAccounts();
    const a = list.find((x) => x.email === email);
    if (a) {
      const token = newToken();
      a.reset_hash = sha(token);
      a.reset_expires_at = new Date(Date.now() + RESET_TTL_MS).toISOString();
      writeAccounts(list);
      const pageLang = pageLangOf(req.body);
      await accountMail(a, 'reset', accountLink(a, 'reset', token, pageLang), pageLang);
    }
    res.json({ ok: true });
  });

  // reset link (?reset=...): new password, other sessions signed out, signed in here
  router.post('/reset', async (req, res) => {
    const ip = clientIp(req);
    if (tooMany('link:' + ip, 20)) return err(res, 429, 'too many attempts, try again in a few minutes', 'rate');
    const b = req.body || {};
    const password = String(b.new_password || '');
    if (password.length < 8 || password.length > 200) return err(res, 400, 'the password needs at least 8 characters', 'password');
    const h = sha(String(b.token || ''));
    const list = readAccounts();
    const a = list.find((x) => x.reset_hash && x.reset_hash === h);
    if (!a || Date.parse(a.reset_expires_at) < Date.now()) { fail('link:' + ip); return err(res, 400, 'invalid or expired link', 'link'); }
    a.pass_salt = crypto.randomBytes(16).toString('hex');
    a.pass_hash = await scrypt(password, a.pass_salt);
    delete a.reset_hash;
    delete a.reset_expires_at;
    // the reset link also proves the address
    if (a.email_verified === false) { a.email_verified = true; a.email_verified_at = new Date().toISOString(); delete a.verify_hash; delete a.verify_expires_at; }
    a.last_login_at = new Date().toISOString();
    if (pageLangOf(b)) a.lang = pageLangOf(b);
    writeAccounts(list);
    linkOrdersByEmail(a);
    endSessions(a.id);
    startSession(res, a);
    res.json({ ok: true, data: { account: publicAccount(a), reset: true } });
  });

  router.post('/logout', (req, res) => {
    const token = readCookie(req, COOKIE);
    if (token) { sessions.delete(sha(token)); saveSessions(); }
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });

  router.post('/password', auth, async (req, res) => {
    const b = req.body || {};
    const list = readAccounts();
    const a = list.find((x) => x.id === req.account.id);
    const hash = await scrypt(String(b.current_password || ''), a.pass_salt);
    if (!crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(a.pass_hash, 'hex'))) return err(res, 401, 'wrong current password', 'credentials');
    const password = String(b.new_password || '');
    if (password.length < 8 || password.length > 200) return err(res, 400, 'the password needs at least 8 characters', 'password');
    a.pass_salt = crypto.randomBytes(16).toString('hex');
    a.pass_hash = await scrypt(password, a.pass_salt);
    writeAccounts(list);
    endSessions(a.id, sha(readCookie(req, COOKIE)));
    accountMail(a, 'changed').catch(() => {}); // security notice
    res.json({ ok: true });
  });

  // panel data: the account's keys (with this month's requests) and orders/tickets
  router.get('/me', auth, (req, res) => {
    const a = req.account;
    const cfg = plans.loadConfig();
    const now = Date.now();
    const keys = plans.readKeys().filter((k) => k.account_id === a.id && !k.hidden_by_user_at).map((k) => {
      const plan = cfg.plans[k.plan] || {};
      const used = plans.getUsage(k.id);
      return {
        id: k.id,
        prefix: k.prefix,
        plan: k.plan,
        plan_name: plan.name || k.plan,
        state: !k.active ? (k.cancelled_by === 'customer' ? 'cancelled' : 'revoked') : (k.expires_at && Date.parse(k.expires_at) < now ? 'expired' : (k.paused ? 'paused' : 'active')),
        created_at: k.created_at,
        expires_at: k.expires_at,
        lifetime: plans.isLifetimeKey(k, cfg),
        coin_audit: k.active && !(k.expires_at && Date.parse(k.expires_at) < now) ? plans.coinAudit(k, cfg) : null,
        per_minute: plan.per_minute || null,
        per_month: plan.per_month || null,
        used_this_month: used,
        remaining_this_month: plan.per_month ? Math.max(0, plan.per_month - used) : null,
      };
    });
    const orders = plans.readJson(ORDERS_FILE, []).filter((o) => o.account_id === a.id && !o.hidden_by_user_at).map((o) => ({
      order_id: o.id,
      ticket: o.ticket || null,
      product: o.product,
      kind: o.kind,
      plan: o.plan || null,
      tier: o.tier || null,
      listing_type: o.listing_type || null,
      listing_name: o.listing && o.listing.name ? o.listing.name : null,
      listing_status: o.listing_status || null,
      status: o.status === 'pending' && Date.parse(o.expires_at) < now ? 'expired' : o.status,
      amount_xln: o.amount_xln,
      price_usd: o.price_usd,
      free: !!o.free,
      included_in_plan: !!o.included_in_plan,
      created_at: o.created_at,
      paid_at: o.paid_at || null,
    })).sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at));
    res.json({ ok: true, data: { account: publicAccount(a), keys, orders, favorites: favoritesOf(a), alerts: alertsOf(a) } });
  });

  // language of the account's e-mails follows the language chosen on the site
  router.post('/lang', auth, (req, res) => {
    const lang = String((req.body || {}).lang || '');
    if (!Object.prototype.hasOwnProperty.call(MAIL_STR, lang)) return err(res, 400, 'unknown language', 'lang');
    const list = readAccounts();
    const a = list.find((x) => x.id === req.account.id);
    if (a.lang !== lang) { a.lang = lang; writeAccounts(list); }
    res.json({ ok: true });
  });

  // favorites (coins/tokens and exchanges), replaced as a whole by the site
  router.post('/favorites', auth, (req, res) => {
    const b = req.body || {};
    const list = readAccounts();
    const a = list.find((x) => x.id === req.account.id);
    a.favorites = { coins: cleanIds(b.coins), exchanges: cleanIds(b.exchanges) };
    // an alert only makes sense for a saved coin
    if (a.alerts) Object.keys(a.alerts).forEach((id) => { if (!a.favorites.coins.includes(id)) delete a.alerts[id]; });
    writeAccounts(list);
    res.json({ ok: true, data: { favorites: favoritesOf(a), alerts: alertsOf(a) } });
  });

  // e-mail price alert for a favorite coin: notify when it rises `up`% or falls `down`% from the
  // reference price (the price when the alert is saved, reset after each notification)
  router.post('/alerts', auth, async (req, res) => {
    const b = req.body || {};
    const coin = String(b.coin || '');
    const pct = (v) => (v === null || v === '' || v === undefined ? null : Number(v));
    const up = pct(b.up);
    const down = pct(b.down);
    if (!ID_RE.test(coin)) return err(res, 400, 'invalid coin', 'coin');
    if ((up !== null && !(up >= 0.5 && up <= 1000)) || (down !== null && !(down >= 0.5 && down <= 99))) return err(res, 400, 'percent out of range', 'percent');
    const list = readAccounts();
    const a = list.find((x) => x.id === req.account.id);
    a.alerts = a.alerts || {};
    if (up === null && down === null) {
      delete a.alerts[coin];
    } else {
      const getCoins = req.app.locals.getPricedCoins;
      let price = null;
      // reference price of every exchange where the coin trades now (key "Exchange|PAIR")
      const bases = {};
      try {
        const all = getCoins ? await getCoins() : null;
        const c = all && all[coin];
        price = c ? c.price_usd : null;
        ((c && c.markets) || []).forEach((m) => { if (m.price_usd > 0) bases[m.key] = m.price_usd; });
      } catch (e) { /* no price yet */ }
      if (!(price > 0)) return err(res, 409, 'this coin has no live price yet', 'price');
      a.favorites = a.favorites || { coins: [], exchanges: [] };
      if (!a.favorites.coins.includes(coin)) a.favorites.coins.push(coin);
      a.alerts[coin] = { up, down, base: price, bases, base_at: new Date().toISOString(), last_sent_at: (a.alerts[coin] && a.alerts[coin].last_sent_at) || null, sent: {} };
      // the alert's e-mail goes out in the language of the page where it was saved
      if (Object.prototype.hasOwnProperty.call(MAIL_STR, String(b.lang || ''))) { a.alerts[coin].lang = String(b.lang); a.lang = String(b.lang); }
    }
    writeAccounts(list);
    res.json({ ok: true, data: { favorites: favoritesOf(a), alerts: alertsOf(a) } });
  });

  // link an order bought while signed out: the ticket link's token proves ownership
  router.post('/claim-order', auth, (req, res) => {
    const b = req.body || {};
    const list = plans.readJson(ORDERS_FILE, []);
    const o = list.find((x) => x.id === String(b.order_id || ''));
    if (!o || !b.token || sha(b.token) !== o.token_hash) return err(res, 404, 'order not found', 'order');
    if (o.account_id && o.account_id !== req.account.id) return err(res, 409, 'this order belongs to another account', 'taken');
    o.account_id = req.account.id;
    plans.writeJsonAtomic(ORDERS_FILE, list);
    if (o.key_id) {
      const keys = plans.readKeys();
      const k = keys.find((x) => x.id === o.key_id);
      if (k && !k.account_id) { k.account_id = req.account.id; plans.writeKeys(keys); }
    }
    res.json({ ok: true });
  });

  // link an existing API key: knowing the key proves ownership
  router.post('/claim-key', auth, (req, res) => {
    const rec = plans.lookupKey(String((req.body || {}).api_key || ''));
    if (!rec) return err(res, 404, 'invalid API key', 'key');
    const keys = plans.readKeys();
    const k = keys.find((x) => x.id === rec.id);
    if (k.account_id && k.account_id !== req.account.id) return err(res, 409, 'this key belongs to another account', 'taken');
    k.account_id = req.account.id;
    plans.writeKeys(keys);
    res.json({ ok: true });
  });

  // replace a key (e.g. leaked): same plan and expiry, the old one stops working immediately
  router.post('/keys/:id/rotate', auth, (req, res) => {
    const keys = plans.readKeys();
    const k = keys.find((x) => x.id === req.params.id && x.account_id === req.account.id);
    if (!k || !k.active) return err(res, 404, 'key not found', 'key');
    const key = plans.generateKey();
    k.hash = plans.hashKey(key);
    k.prefix = key.slice(0, 10);
    k.rotated_at = new Date().toISOString();
    plans.writeKeys(keys);
    res.json({ ok: true, data: { id: k.id, api_key: key } });
  });

  // ---- contract (API key) actions by its owner. Nothing here gives time or money back: a paused
  // key keeps its expiry date, a cancelled one is not refunded.
  const ownKey = (req) => {
    const keys = plans.readKeys();
    return { keys, k: keys.find((x) => x.id === req.params.id && x.account_id === req.account.id && !x.hidden_by_user_at) };
  };
  const stamp = () => new Date().toISOString();
  // pause: the key answers 403 until resumed
  router.post('/keys/:id/pause', auth, (req, res) => {
    const { keys, k } = ownKey(req);
    if (!k || !k.active) return err(res, 404, 'key not found', 'key');
    if (!k.paused) { k.paused = true; k.paused_at = stamp(); plans.writeKeys(keys); }
    res.json({ ok: true });
  });
  router.post('/keys/:id/resume', auth, (req, res) => {
    const { keys, k } = ownKey(req);
    if (!k || !k.active) return err(res, 404, 'key not found', 'key');
    if (k.paused) { delete k.paused; k.resumed_at = stamp(); plans.writeKeys(keys); }
    res.json({ ok: true });
  });
  // cancel: the key stops for good (a renewal starts a new period); asked twice on the page
  router.post('/keys/:id/cancel', auth, (req, res) => {
    const { keys, k } = ownKey(req);
    if (!k) return err(res, 404, 'key not found', 'key');
    if ((req.body || {}).confirm !== true) return err(res, 400, 'confirmation required', 'confirm');
    if (k.active) { k.active = false; delete k.paused; k.cancelled_at = stamp(); k.cancelled_by = 'customer'; plans.writeKeys(keys); }
    res.json({ ok: true });
  });
  // delete from the customer's list: only a contract that no longer works (cancelled or expired).
  // The record itself is kept (admin panel, accounting).
  router.post('/keys/:id/remove', auth, (req, res) => {
    const { keys, k } = ownKey(req);
    if (!k) return err(res, 404, 'key not found', 'key');
    if (k.active && !(k.expires_at && Date.parse(k.expires_at) < Date.now())) return err(res, 409, 'only a cancelled or expired contract can be deleted', 'state');
    k.hidden_by_user_at = stamp();
    plans.writeKeys(keys);
    res.json({ ok: true });
  });
  // delete an expired order (payment window closed without payment) from the customer's list
  router.post('/orders/:id/remove', auth, (req, res) => {
    const list = plans.readJson(ORDERS_FILE, []);
    const o = list.find((x) => x.id === req.params.id && x.account_id === req.account.id && !x.hidden_by_user_at);
    if (!o) return err(res, 404, 'order not found', 'order');
    if (!(o.status === 'expired' || (o.status === 'pending' && Date.parse(o.expires_at) < Date.now()))) return err(res, 409, 'only an expired order can be deleted', 'state');
    o.hidden_by_user_at = stamp();
    plans.writeJsonAtomic(ORDERS_FILE, list);
    res.json({ ok: true });
  });

  app.use('/api/account', router);
}

module.exports = { mount, sessionAccount, accountMail };
