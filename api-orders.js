// Self-service checkout paid in XLN and confirmed on chain -- no manual step for API plans.
//
// Products (api-plans.js products()): paid API plans (the key is issued automatically) and listing
// requests for a coin or an exchange (paid, then reviewed by the team; status tracked on the ticket).
//
// 1. POST /api/v1/orders with the customer's registration (and the listing details for a listing)
//    creates an order. The XLN amount is the product's USD price at the current XLN price (same rule
//    as /plans) plus a unique 4-decimal fraction, because an XLN transaction carries no memo: the
//    fraction is what ties a payment to its order. The amount is locked for `order_ttl_minutes`.
// 2. Every minute, while any order is open, the payment address is read from the XLN explorer
//    (explorerxln.com API v1: address history + each transaction's outputs for exact values and
//    confirmations). A transaction paying at least the order amount with the same fraction, sent
//    after the order was created, is attached to it.
// 3. After `confirmations` blocks the order is paid: a ticket number is issued (GLX-YYYY-NNNNNN,
//    the reference of the service contract), and the API key is created (or the renewed key
//    extended by a month) or the listing request enters review. A lifetime plan (paid once) always
//    gets a new key, with no expiry. A plan that includes the coin audit gives its key one priority
//    coin listing and audit: that request is made here too, with the key instead of a payment. The buyer reads it all with the
//    order token (GET /api/v1/orders/:id), which is also the ticket's private link.
//
// Orders live in data/api-orders.json (registration data included; never served without the
// token). Only a hash of each order token is stored. A new key's plaintext stays in its order for
// 7 days so the buyer can still retrieve it, then it is erased. tools/orders.js manages the
// listing review.
const crypto = require('crypto');
const path = require('path');
const plans = require('./api-plans');
const accounts = require('./api-accounts');
const events = require('./events');
const secret = require('./server-secret');

const EXPLORER = 'https://explorerxln.com';
const ORDERS_FILE = path.join(plans.DATA_DIR, 'api-orders.json');
const SCAN_MS = 60 * 1000;
const LATE_PAYMENT_MS = 24 * 3600 * 1000; // a payment for an expired order is still honoured for a day
const KEY_RETENTION_MS = 7 * 24 * 3600 * 1000;
const ORDERS_PER_IP_PER_HOUR = 10;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const frac4 = (v) => Math.round(v * 1e4) % 10000;

// ---- input validation
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanMultiline = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0009\u000b-\u001f\u007f<>]/g, ' ').trim().slice(0, max);
const isEmail = (s) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(s);
const isUrl = (s) => /^https?:\/\/[^\s]{3,200}$/i.test(s);
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function isXlnAddress(a) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{25,40}$/.test(a)) return false;
  let n = 0n;
  for (const ch of a) n = n * 58n + BigInt(B58.indexOf(ch));
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const b = Buffer.from(hex, 'hex');
  if (b.length !== 25 || b[0] !== 48) return false; // XLN P2PKH addresses: version byte 48 ("L...")
  const d = crypto.createHash('sha256').update(crypto.createHash('sha256').update(b.slice(0, 21)).digest()).digest();
  return d.slice(0, 4).equals(b.slice(21));
}

// Required fields per listing type ([field, validator, max length, required]).
const LISTING_FIELDS = {
  coin: [
    ['name', 'text', 60, true], ['symbol', 'text', 15, true], ['website', 'url', 200, true], ['explorer', 'url', 200, false],
    ['source_code', 'url', 200, false], ['network', 'text', 60, false], ['contract', 'text', 100, false],
    ['markets', 'multi', 800, true], ['logo', 'url', 200, false], ['description', 'multi', 800, false],
  ],
  exchange: [
    ['name', 'text', 60, true], ['website', 'url', 200, true], ['api_docs', 'url', 200, true], ['pairs', 'text', 12, false],
    ['markets', 'multi', 800, false], ['logo', 'url', 200, false], ['description', 'multi', 800, false],
  ],
};

module.exports = function mountOrders(app, { fetchJson, getPrices, fail }) {
  const readOrders = () => plans.readJson(ORDERS_FILE, []);
  const writeOrders = (list) => plans.writeJsonAtomic(ORDERS_FILE, list);

  function isOpen(o) {
    if (o.status === 'confirming') return true;
    if (o.status !== 'pending' && o.status !== 'expired') return false;
    return Date.now() < Date.parse(o.expires_at) + (o.status === 'expired' ? LATE_PAYMENT_MS : 0);
  }

  function publicView(o, isOwner) {
    const cfg = plans.loadConfig();
    const out = {
      order_id: o.id,
      status: o.status,
      product: o.product || o.plan,
      kind: o.kind || 'api',
      plan: o.plan || null,
      listing_type: o.listing_type || null,
      tier: o.tier || (o.kind === 'listing' ? 'priority' : null),
      sla: o.sla || null,
      free: !!o.free,
      included_in_plan: !!o.included_in_plan,
      lifetime: !!o.lifetime,
      includes_audit: !!o.includes_audit,
      renewal: !!o.renew_key_id,
      plan_change_from: o.change_from || null,
      amount_xln: o.amount_xln,
      pay_to: o.pay_to,
      price_usd: o.price_usd,
      xln_price_usd: o.xln_price_usd,
      created_at: o.created_at,
      expires_at: o.expires_at,
      confirmations: o.confirmations || 0,
      confirmations_required: cfg.payment.confirmations,
      txid: o.txid || null,
      paid_xln: o.paid_xln || null,
      paid_at: o.paid_at || null,
      ticket: o.ticket || null,
      key_expires_at: o.key_expires_at || null,
      listing_status: o.listing_status || null,
      listing_note: o.listing_note || null,
      refund_txid: o.refund_txid || null,
      refund_if_rejected: o.kind === 'listing' ? cfg.refund_if_rejected : null,
    };
    if (isOwner) {
      // the coin listing and audit of the plan: still to be requested, or already requested
      if (o.includes_audit && o.status === 'paid' && o.key_id) {
        const k = plans.readKeys().find((x) => x.id === o.key_id);
        out.coin_audit = k && k.active ? plans.coinAudit(k, cfg) : null;
      }
      out.customer = o.customer || null;
      out.listing = o.listing || null;
      if (o.status === 'paid' && o.kind !== 'listing') out.api_key = o.api_key || null;
    }
    return out;
  }

  // ---- create an order
  const orderHits = new Map();
  app.post('/api/v1/orders', require('express').json({ limit: '16kb' }), async (req, res) => {
    const cfg = plans.loadConfig();
    if (!cfg.payment.xln_address) return fail(res, 503, 'automatic payments are not configured yet');
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = fwd || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const recent = (orderHits.get(ip) || []).filter((t) => now - t < 3600 * 1000);
    if (recent.length >= ORDERS_PER_IP_PER_HOUR) return fail(res, 429, 'too many orders from this IP, try again later');

    const body = req.body || {};
    const catalog = plans.products(cfg);
    const productId = String(body.product || body.plan || '');
    const product = catalog[productId];
    if (!product) return fail(res, 400, 'product must be one of: ' + Object.keys(catalog).join(', '));
    const usdExact = plans.productUsd(product, cfg);
    if (!product.free && !(usdExact > 0)) return fail(res, 400, 'this product is not available yet');
    if (body.accept_terms !== true) return fail(res, 400, 'the service terms must be accepted');

    // registration
    const c = body.customer || {};
    const customer = {
      name: clean(c.name, 80),
      email: clean(c.email, 120).toLowerCase(),
      company: clean(c.company, 80),
      contact: clean(c.contact, 80),
      country: clean(c.country, 60),
      wallet: clean(c.wallet, 40),
    };
    if (customer.name.length < 2) return fail(res, 400, 'name is required');
    if (!isEmail(customer.email)) return fail(res, 400, 'a valid e-mail is required');
    if (customer.wallet && !isXlnAddress(customer.wallet)) return fail(res, 400, 'the XLN wallet address is invalid');
    if (product.kind === 'listing' && cfg.refund_if_rejected && !customer.wallet) return fail(res, 400, 'an XLN wallet is required for a possible refund');

    // listing details
    let listing = null;
    if (product.kind === 'listing') {
      listing = {};
      const src = body.listing || {};
      for (const [field, type, max, required] of LISTING_FIELDS[product.listing_type]) {
        const v = type === 'multi' ? cleanMultiline(src[field], max) : clean(src[field], max);
        if (required && !v) return fail(res, 400, `listing field "${field}" is required`);
        if (v && type === 'url' && !isUrl(v)) return fail(res, 400, `listing field "${field}" must be an http(s) URL`);
        listing[field] = v;
      }
    }

    let renewKeyId = null;
    let changeFrom = null; // current plan of the key, when this order changes it to another plan
    if (product.kind === 'api' && body.renew_key) {
      const rec = plans.lookupKey(String(body.renew_key));
      if (!rec) return fail(res, 400, 'the key to renew is invalid');
      renewKeyId = rec.id;
      changeFrom = rec.plan;
    } else if (product.kind === 'api' && body.renew_key_id) {
      // renewal started from the account panel: the key must belong to the signed-in account
      const me = accounts.sessionAccount(req);
      const rec = me && plans.readKeys().find((k) => k.id === String(body.renew_key_id) && k.account_id === me.id);
      if (!rec) return fail(res, 400, 'the key to renew is invalid');
      renewKeyId = rec.id;
      changeFrom = rec.plan;
    }
    // A lifetime plan is always issued as a new key, and a lifetime key is never renewed or moved
    // to another plan: in both cases the order simply gets its own key.
    if (renewKeyId && (product.lifetime || plans.isLifetimeKey(plans.readKeys().find((k) => k.id === renewKeyId), cfg))) {
      renewKeyId = null;
      changeFrom = null;
    }

    // Priority coin listing and audit included in a plan: asked with the key (or, signed in, with
    // the id of a key of the account) instead of a payment. Each key has one.
    let creditKey = null;
    if (product.kind === 'listing' && product.listing_type === 'coin' && product.tier === 'priority' && (body.plan_key || body.plan_key_id)) {
      let rec = null;
      if (body.plan_key) rec = plans.lookupKey(String(body.plan_key));
      else {
        const me = accounts.sessionAccount(req);
        rec = (me && plans.readKeys().find((k) => k.id === String(body.plan_key_id) && k.account_id === me.id && k.active)) || null;
      }
      if (!rec || (rec.expires_at && Date.parse(rec.expires_at) < now) || plans.coinAudit(rec, cfg) !== 'available') return fail(res, 400, 'this key has no coin audit to use');
      creditKey = rec;
    }

    // bought while signed in: the order (and its key) belongs to that account
    const owner = accounts.sessionAccount(req);
    // language of the customer's e-mails
    const lang = /^[a-zA-Z]{2}(-[a-zA-Z]{2})?$/.test(String(body.lang || '')) ? String(body.lang) : 'pt-BR';

    // free standard listing, or the priority coin listing and audit included in a plan: no payment --
    // the ticket is issued now and the request joins the queue (with the priority deadline, if included)
    if (product.free || creditKey) {
      const orders = readOrders();
      const token = crypto.randomBytes(24).toString('base64url');
      const order = {
        id: crypto.randomBytes(6).toString('hex'),
        token_hash: sha(token),
        product: productId,
        kind: product.kind,
        plan: null,
        listing_type: product.listing_type,
        tier: creditKey ? 'priority' : 'standard',
        sla: creditKey ? product.sla || null : null,
        free: true,
        customer,
        listing,
        amount_xln: 0,
        price_usd: 0,
        created_at: new Date(now).toISOString(),
        paid_at: new Date(now).toISOString(),
        status: 'registered',
        ticket: nextTicket(orders),
        listing_status: 'under_review',
        lang,
        token_enc: secret.encrypt(token),
      };
      if (owner) order.account_id = owner.id;
      if (creditKey) {
        order.included_in_plan = creditKey.id;
        if (!order.account_id && creditKey.account_id) order.account_id = creditKey.account_id;
        // the key's audit is used by this request
        const keys = plans.readKeys();
        const k = keys.find((x) => x.id === creditKey.id);
        if (!k || k.audit_order_id) return fail(res, 400, 'this key has no coin audit to use');
        k.audit_order_id = order.id;
        plans.writeKeys(keys);
      }
      orders.push(order);
      writeOrders(orders);
      recent.push(now);
      orderHits.set(ip, recent);
      events.emit('listing.registered', { order });
      console.log(`listing request ${order.id} registered (${order.ticket}): ${productId}${creditKey ? ' (included in the plan of key ' + creditKey.id + ')' : ''}`);
      res.set('Cache-Control', 'no-store');
      return res.json({ ok: true, data: Object.assign(publicView(order, true), { token }) });
    }

    const { xln } = await getPrices();
    const base = plans.xlnForUsd(usdExact, xln, cfg);
    const orders = readOrders();
    const taken = new Set(orders.filter(isOpen).map((o) => frac4(o.amount_xln)));
    let f = 0;
    for (let i = 0; i < 50 && (!f || taken.has(f)); i++) f = 1 + crypto.randomInt(9999);
    if (taken.has(f)) return fail(res, 503, 'too many open orders right now, try again in a few minutes');

    const token = crypto.randomBytes(24).toString('base64url');
    const order = {
      id: crypto.randomBytes(6).toString('hex'),
      token_hash: sha(token),
      product: productId,
      kind: product.kind,
      plan: product.kind === 'api' ? product.plan : null,
      listing_type: product.listing_type || null,
      tier: product.tier || null,
      sla: product.sla || null,
      lifetime: product.kind === 'api' && !!product.lifetime,
      includes_audit: product.kind === 'api' && !!product.includes_audit,
      renew_key_id: renewKeyId,
      change_from: renewKeyId && changeFrom !== product.plan ? changeFrom : null,
      customer,
      listing,
      amount_xln: Math.round((base + f / 1e4) * 1e4) / 1e4,
      price_usd: Math.round(usdExact * 100) / 100,
      xln_price_usd: xln || cfg.anchor.price_usd,
      pay_to: cfg.payment.xln_address,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + cfg.payment.order_ttl_minutes * 60 * 1000).toISOString(),
      status: 'pending',
      lang,
      token_enc: secret.encrypt(token),
    };
    if (owner) order.account_id = owner.id;
    orders.push(order);
    writeOrders(orders);
    recent.push(now);
    orderHits.set(ip, recent);
    events.emit('order.created', { order });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, data: Object.assign(publicView(order, true), { token }) });
    scanSoon();
  });

  // ---- order / ticket (registration, key and listing details only with the order token)
  app.get('/api/v1/orders/:id', (req, res) => {
    const token = req.get('x-order-token') || req.query.token;
    const o = readOrders().find((x) => x.id === String(req.params.id));
    const byToken = o && token && sha(token) === o.token_hash;
    const byOwner = o && o.account_id && (accounts.sessionAccount(req) || {}).id === o.account_id;
    if (!byToken && !byOwner) return fail(res, 404, 'order not found');
    if (o.status === 'pending' && Date.now() > Date.parse(o.expires_at)) o.status = 'expired';
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, data: publicView(o, true) });
  });

  // ---- chain watcher
  const rawCache = new Map(); // txid -> raw tx, kept once deeply confirmed
  async function rawTx(txid, required) {
    const hit = rawCache.get(txid);
    if (hit && (hit.confirmations || 0) >= required) return hit;
    const raw = await fetchJson(`${EXPLORER}/api/v1/tx/${txid}`);
    rawCache.set(txid, raw);
    if (rawCache.size > 500) rawCache.delete(rawCache.keys().next().value);
    return raw;
  }
  // the explorer writes every address with the current prefix (L); `addrs` also holds the configured form
  const paidTo = (raw, addrs) => (raw.outputs || []).reduce((s, v) => s + (v && addrs.has(v.address) ? Number(v.value) || 0 : 0), 0);
  // the payment address as the explorer writes it (a legacy X address is shown as L); null = no history yet
  async function addressForms(addr) {
    const a = await fetchJson(`${EXPLORER}/api/v1/address/${addr}`).catch((e) => {
      if (/status 404/.test(String(e && e.message))) return null;
      throw e;
    });
    return a ? new Set([addr, a.address, a.legacy].filter(Boolean)) : null;
  }

  function nextTicket(orders) {
    const year = new Date().getUTCFullYear();
    const prefix = `GLX-${year}-`;
    const seq = orders.filter((o) => o.ticket && o.ticket.startsWith(prefix)).length + 1;
    return prefix + String(seq).padStart(6, '0');
  }

  // The watcher works on a snapshot while it awaits the explorer, and other writers (new orders, free
  // listings, account linking) may change the file meanwhile: only the fields the watcher changed are
  // written, on top of a fresh read, and tickets are numbered at that moment so they never repeat.
  const TICKET_PENDING = '__pending__';
  function mergeWrite(snapshot, orders) {
    const fresh = readOrders();
    const index = new Map(fresh.map((o, i) => [o.id, i]));
    const paid = [];
    orders.forEach((o, i) => {
      const before = snapshot[i];
      const at = index.get(o.id);
      if (at == null) return;
      const target = fresh[at];
      new Set([...Object.keys(before), ...Object.keys(o)]).forEach((k) => {
        if (JSON.stringify(before[k]) === JSON.stringify(o[k])) return;
        if (o[k] === undefined) delete target[k]; else target[k] = o[k];
      });
      if (target.ticket === TICKET_PENDING) {
        target.ticket = nextTicket(fresh);
        console.log(`order ${target.id} paid (${target.ticket}): ${target.product} ${target.amount_xln} XLN tx ${target.txid}`);
        paid.push(target);
      }
    });
    writeOrders(fresh);
    paid.forEach((order) => events.emit('order.paid', { order }));
  }

  function complete(o) {
    o.ticket = TICKET_PENDING;
    o.status = 'paid';
    o.paid_at = new Date().toISOString();
    const owner = (o.customer && (o.customer.company || o.customer.name)) || ('order ' + o.id);
    if (o.kind === 'listing') {
      o.listing_status = 'under_review';
    } else if (o.renew_key_id) {
      const k = plans.extendKey(o.renew_key_id, 1, o.plan);
      o.key_id = o.renew_key_id;
      o.key_expires_at = k ? k.expires_at : null;
    } else {
      // no `months`: one month, or no expiry for a lifetime plan
      const { key, rec } = plans.createKey({ plan: o.plan, owner, account_id: o.account_id, note: `order ${o.id}, ${o.amount_xln} XLN, tx ${o.txid}` });
      o.key_id = rec.id;
      o.api_key = key;
      o.key_expires_at = rec.expires_at;
    }
  }

  let scanning = false;
  async function scan() {
    if (scanning) return;
    const cfg = plans.loadConfig();
    const addr = cfg.payment.xln_address;
    if (!addr) return;
    scanning = true;
    try {
      const orders = readOrders();
      const snapshot = JSON.parse(JSON.stringify(orders));
      let changed = false;
      // housekeeping: expire unpaid orders, erase delivered key plaintext after the retention window
      orders.forEach((o) => {
        if (o.status === 'pending' && Date.now() > Date.parse(o.expires_at)) { o.status = 'expired'; changed = true; }
        if (o.api_key && o.paid_at && Date.now() - Date.parse(o.paid_at) > KEY_RETENTION_MS) { delete o.api_key; changed = true; }
      });
      const open = orders.filter(isOpen);
      if (open.length) {
        const required = cfg.payment.confirmations;
        const used = new Set(orders.filter((o) => o.txid).map((o) => o.txid));
        const waiting = open.filter((o) => !o.txid);
        if (waiting.length) {
          const since = Math.min(...waiting.map((o) => Date.parse(o.created_at))) - 5 * 60 * 1000;
          // an address that never received anything is "not found" (404) on the explorer
          const forms = await addressForms(addr);
          const page = forms ? await fetchJson(`${EXPLORER}/api/v1/address/${addr}/txs?offset=0&limit=50`) : null;
          const history = page && Array.isArray(page.txs) ? page.txs : [];
          for (const h of history) {
            if (!h || !h.txid || used.has(h.txid) || Number(h.time) * 1000 < since) continue;
            const raw = await rawTx(h.txid, required);
            const value = paidTo(raw, forms);
            if (!(value > 0)) continue;
            const txTime = (Number(raw.time || h.time) || 0) * 1000;
            const match = waiting.find((o) => !o.txid && frac4(value) === frac4(o.amount_xln) && value + 1e-8 >= o.amount_xln && txTime >= Date.parse(o.created_at) - 2 * 60 * 1000);
            if (match) {
              match.txid = h.txid;
              match.paid_xln = value;
              match.status = 'confirming';
              used.add(h.txid);
              changed = true;
            }
          }
        }
        for (const o of orders.filter((x) => x.status === 'confirming')) {
          const raw = await rawTx(o.txid, required);
          const conf = Number(raw.confirmations) || 0;
          if (conf !== o.confirmations) { o.confirmations = conf; changed = true; }
          if (conf >= required) { complete(o); changed = true; }
        }
      }
      if (changed) mergeWrite(snapshot, orders);
    } catch (e) {
      console.error('order scan failed', e && e.message);
    } finally {
      scanning = false;
    }
  }
  let soon = null;
  function scanSoon() { if (!soon) soon = setTimeout(() => { soon = null; scan(); }, 5000); }
  setInterval(scan, SCAN_MS).unref();
  setTimeout(scan, 20 * 1000).unref();

  return { scan };
};

module.exports.ORDERS_FILE = ORDERS_FILE;
module.exports.isXlnAddress = isXlnAddress;
