// Public API plans, API keys and monthly usage.
//
// Plans: Free (no key, limited per IP) and paid plans reached with an API key. Paid plans are priced
// in USD, fixed at the value of `anchor_xln` XLN at the anchor date/price below; the amount of XLN
// charged follows the market (XLN up -> fewer XLN). XLNFT becomes a payment option once it has a
// market price. Everything here can be overridden without a deploy by data/api-plans.json.
//
// Keys are issued with tools/api-keys.js and stored only as SHA-256 hashes in data/api-keys.json
// (reloaded automatically when the file changes). Monthly request counts per key live in
// data/api-usage.json, flushed every minute.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const KEYS_FILE = path.join(DATA_DIR, 'api-keys.json');
const USAGE_FILE = path.join(DATA_DIR, 'api-usage.json');
const CONFIG_FILE = path.join(DATA_DIR, 'api-plans.json');

const DEFAULT_CONFIG = {
  // Self-service checkout (api-orders.js): orders are paid in XLN to this address and detected on
  // chain. Empty = checkout disabled.
  payment: { xln_address: 'LbFfJhe8JA4CT58Mg2dz5CzHHnh4q8Ne9e', confirmations: 6, order_ttl_minutes: 60 },
  anchor: { symbol: 'XLN', price_usd: 0.0003599, date: '2026-09-30', source: 'Qutrade (most liquid XLN market that day)' },
  // API plans: price set in USD, always paid in XLN at the market rate when the order is created.
  // The price is per month, except for a plan marked `lifetime`: that one is paid once and its key
  // does not expire. `includes_audit` gives each key of the plan one priority coin listing and audit.
  plans: {
    free: { name: 'Free', per_minute: 30, per_month: null, price_usd: 0, requires_key: false },
    basic: { name: 'Basic', per_minute: 300, per_month: 100000, price_usd: 17.5, requires_key: true, lifetime: true, includes_audit: true },
    analyst: { name: 'Analyst', per_minute: 500, per_month: 500000, price_usd: 64.5, requires_key: true },
    lite: { name: 'Lite', per_minute: 500, per_month: 2000000, price_usd: 249.5, requires_key: true },
    pro: { name: 'Pro', per_minute: 1000, per_month: 5000000, price_usd: 499.5, requires_key: true },
  },
  // Listing requests, reviewed by the team. Standard listing is free and follows the queue with no
  // deadline; priority listing is paid (anchor_xln XLN valued at the anchor price, so the XLN amount
  // follows the market) and guarantees the review deadline (sla), not approval. An exchange listed on
  // the site gets every coin it trades listed for free. anchor_xln null = priority not on sale.
  listings: {
    coin: { name: 'Coin listing', anchor_xln: 20000, sla: '48h' },
    exchange: { name: 'Exchange listing', anchor_xln: 500000, sla: '10 business days' },
  },
  standard_listing: true,
  refund_if_rejected: false,
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ---- config (re-read at most every 30s)
let configCache = { at: 0, cfg: DEFAULT_CONFIG };
function loadConfig() {
  if (Date.now() - configCache.at < 30000) return configCache.cfg;
  const o = readJson(CONFIG_FILE, {});
  const cfg = {
    payment: Object.assign({}, DEFAULT_CONFIG.payment, o.payment || {}),
    anchor: Object.assign({}, DEFAULT_CONFIG.anchor, o.anchor || {}),
    plans: o.plans || DEFAULT_CONFIG.plans,
    listings: Object.assign({}, DEFAULT_CONFIG.listings, o.listings || {}),
    refund_if_rejected: o.refund_if_rejected != null ? !!o.refund_if_rejected : DEFAULT_CONFIG.refund_if_rejected,
    standard_listing: o.standard_listing != null ? !!o.standard_listing : DEFAULT_CONFIG.standard_listing,
  };
  configCache = { at: Date.now(), cfg };
  return cfg;
}
// Exact USD price: plans carry price_usd; items priced as an XLN amount (anchor_xln) are valued at
// the anchor XLN price, so their USD value stays fixed while the XLN amount follows the market.
function productUsd(p, cfg) {
  if (p.price_usd != null) return Number(p.price_usd) || 0;
  return (p.anchor_xln || 0) * cfg.anchor.price_usd;
}
function planPriceUsd(plan, cfg) {
  return Math.round(productUsd(plan, cfg) * 100) / 100;
}
// XLN amount for a USD price at the live XLN price (rounded up to a whole coin); without a live
// price, the anchor price is used.
function xlnForUsd(usd, xlnPrice, cfg) {
  const price = xlnPrice > 0 ? xlnPrice : cfg.anchor.price_usd;
  return usd > 0 ? Math.ceil(usd / price - 1e-9) : 0;
}
// Everything that can be bought: paid API plans (kind 'api') and listing requests (kind 'listing').
function products(cfg) {
  const out = {};
  Object.keys(cfg.plans).forEach((id) => {
    const p = cfg.plans[id];
    if (p.requires_key) out[id] = { id, kind: 'api', name: p.name, plan: id, price_usd: p.price_usd, anchor_xln: p.anchor_xln, lifetime: !!p.lifetime, includes_audit: !!p.includes_audit };
  });
  Object.keys(cfg.listings).forEach((t) => {
    const l = cfg.listings[t];
    if (cfg.standard_listing) {
      out['listing_' + t + '_standard'] = { id: 'listing_' + t + '_standard', kind: 'listing', listing_type: t, tier: 'standard', name: 'Standard ' + l.name.toLowerCase(), price_usd: 0, free: true };
    }
    out['listing_' + t] = { id: 'listing_' + t, kind: 'listing', listing_type: t, tier: 'priority', name: 'Priority ' + l.name.toLowerCase() + (t === 'coin' ? ' and audit' : ''), anchor_xln: l.anchor_xln, sla: l.sla };
  });
  return out;
}

// ---- keys (file checked for changes at most every 10s)
const hashKey = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');
const generateKey = () => 'glx_' + crypto.randomBytes(24).toString('base64url');
let keysCache = { checkedAt: 0, mtime: -1, byHash: new Map() };
function keysIndex() {
  if (Date.now() - keysCache.checkedAt < 10000) return keysCache.byHash;
  keysCache.checkedAt = Date.now();
  let mtime = 0;
  try { mtime = fs.statSync(KEYS_FILE).mtimeMs; } catch (e) { /* no keys issued yet */ }
  if (mtime !== keysCache.mtime) {
    const list = mtime ? readJson(KEYS_FILE, []) : [];
    keysCache.byHash = new Map(list.map((k) => [k.hash, k]));
    keysCache.mtime = mtime;
  }
  return keysCache.byHash;
}
function lookupKey(raw) {
  if (!raw || !/^glx_[A-Za-z0-9_-]{20,64}$/.test(String(raw))) return null;
  const rec = keysIndex().get(hashKey(raw));
  return rec && rec.active ? rec : null;
}
function readKeys() { return readJson(KEYS_FILE, []); }
function writeKeys(list) { writeJsonAtomic(KEYS_FILE, list); keysCache.checkedAt = 0; }

function addMonths(date, n) {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d;
}
// A key of a lifetime plan has no expiry date.
function isLifetimeKey(k, cfg) {
  return !!k && !k.expires_at && !!((cfg || loadConfig()).plans[k.plan] || {}).lifetime;
}
// The coin listing and audit a plan includes, per key: 'available', 'requested' (already used) or null.
function coinAudit(k, cfg) {
  if (!k || !((cfg || loadConfig()).plans[k.plan] || {}).includes_audit) return null;
  return k.audit_order_id ? 'requested' : 'available';
}
// Issues a new key (returned once, stored hashed) -- used by the CLI and the automatic checkout.
// Without `months`, the plan decides: no expiry for a lifetime plan, one month otherwise.
function createKey({ plan, owner, months, note = '', account_id = null }) {
  const lifetime = months == null && !!(loadConfig().plans[plan] || {}).lifetime;
  const key = generateKey();
  const rec = {
    id: crypto.randomBytes(4).toString('hex'),
    prefix: key.slice(0, 10),
    hash: hashKey(key),
    plan,
    owner,
    note,
    created_at: new Date().toISOString(),
    expires_at: lifetime ? null : addMonths(Date.now(), months == null ? 1 : months).toISOString(),
    active: true,
  };
  if (account_id) rec.account_id = account_id;
  const list = readKeys();
  list.push(rec);
  writeKeys(list);
  return { key, rec };
}
// Adds months to a key (counting from its current expiry if still valid), optionally changing plan.
// On a plan change the new plan starts now, and the time left on the old plan is converted at the
// price ratio (time left x old price / new price): an upgrade gets fewer, a downgrade more days.
function extendKey(id, months = 1, plan) {
  const list = readKeys();
  const k = list.find((x) => x.id === id);
  if (!k) return null;
  if (isLifetimeKey(k)) return k; // nothing to extend
  const now = Date.now();
  const left = k.expires_at && Date.parse(k.expires_at) > now ? Date.parse(k.expires_at) - now : 0;
  let from = now + left;
  if (plan && plan !== k.plan) {
    const cfg = loadConfig();
    const oldUsd = cfg.plans[k.plan] ? planPriceUsd(cfg.plans[k.plan], cfg) : 0;
    const newUsd = cfg.plans[plan] ? planPriceUsd(cfg.plans[plan], cfg) : 0;
    const credit = oldUsd > 0 && newUsd > 0 ? Math.round(left * (oldUsd / newUsd)) : 0;
    from = now + credit;
    k.plan_history = (k.plan_history || []).concat({ from: k.plan, to: plan, at: new Date(now).toISOString(), credit_days: Math.round((credit / 86400000) * 10) / 10 });
    k.plan = plan;
  }
  k.expires_at = addMonths(from, months).toISOString();
  k.active = true;
  writeKeys(list);
  return k;
}

// ---- monthly usage per key
const period = () => new Date().toISOString().slice(0, 7);
let usage = readJson(USAGE_FILE, {});
let dirty = false;
function addUsage(id) {
  const p = period();
  if (!usage[p]) usage[p] = {};
  usage[p][id] = (usage[p][id] || 0) + 1;
  dirty = true;
  return usage[p][id];
}
function getUsage(id, p) {
  return ((usage[p || period()] || {})[id]) || 0;
}
function flushUsage() {
  if (!dirty) return;
  try {
    const months = Object.keys(usage).sort();
    months.slice(0, Math.max(0, months.length - 13)).forEach((m) => { delete usage[m]; });
    writeJsonAtomic(USAGE_FILE, usage);
    dirty = false;
  } catch (e) {
    console.error('failed to persist api usage', e && e.message);
  }
}
setInterval(flushUsage, 60 * 1000).unref();
// Save the last minute of counts on shutdown. A signal listener replaces Node's default exit, so
// exit explicitly afterwards.
['SIGTERM', 'SIGINT'].forEach((sig) => process.once(sig, () => { flushUsage(); process.exit(0); }));

module.exports = {
  KEYS_FILE, USAGE_FILE, CONFIG_FILE, DEFAULT_CONFIG,
  loadConfig, planPriceUsd, productUsd, xlnForUsd, products, hashKey, generateKey, lookupKey, readKeys, writeKeys, createKey, extendKey, isLifetimeKey, coinAudit, addUsage, getUsage, period,
  readJson, writeJsonAtomic, DATA_DIR,
  readUsageFile: () => readJson(USAGE_FILE, {}),
};
