// "New coin listed" per exchange: a coin that an exchange has just listed is announced on that
// exchange's page for 24 hours (owner's rule), whether the site already knew the coin or not -- XLN
// listed on Cexius is a new listing of Cexius. After the 24 hours it simply stays in the exchange's
// market list and in its own tab (masternode, stake, mining, token).
//
// When the exchange publishes the date it created the market (Cexius: created_at), that date is the
// listing date. Otherwise the listing date is the moment the coin is first seen in the exchange's
// markets; the coins that were already there the first time an exchange is read are not new.
// What was seen is kept in data/exchange-listings.json.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'exchange-listings.json');
const REGISTRY = path.join(__dirname, 'public-api-coins.json');
const EXCHANGES = [['lunariumtrade', 'LunariumTrade'], ['qutrade', 'Qutrade'], ['gatevia', 'Gatevia'], ['cexius', 'Cexius']];
const NEW_HOURS = 24;
const SCAN_MS = 5 * 60 * 1000;

let state = { seen: {} };
let stateMtime = 0;
// The hosting runs more than one app process: what another process saved is picked up here
// (a listing date already known on either side is kept).
function loadState() {
  try {
    const mtime = fs.statSync(FILE).mtimeMs;
    if (mtime === stateMtime) return;
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!d || !d.seen) return;
    Object.keys(d.seen).forEach((id) => {
      const mine = state.seen[id] || (state.seen[id] = {});
      Object.keys(d.seen[id]).forEach((sym) => { if (!(sym in mine) || (mine[sym] == null && d.seen[id][sym])) mine[sym] = d.seen[id][sym]; });
    });
    stateMtime = mtime;
  } catch (e) { /* first run */ }
}
loadState();
function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
    stateMtime = fs.statSync(FILE).mtimeMs;
  } catch (e) { console.error('exchange listings: could not save', e && e.message); }
}

module.exports = function mountExchangeListings(app, { callRoute }) {
  const snapshots = {}; // exchange id -> markets of its last good snapshot

  let running = false;
  async function scan() {
    if (running) return;
    running = true;
    let changed = false;
    try {
      loadState();
      for (const [id] of EXCHANGES) {
        let d = null;
        try { d = await callRoute(`/api/exchange/${id}`, {}); } catch (e) { /* exchange unavailable this round */ }
        const markets = (d && d.markets) || [];
        if (!markets.length) continue; // an empty answer says nothing about what is listed
        snapshots[id] = markets;
        const first = !state.seen[id];
        const seen = state.seen[id] || (state.seen[id] = {});
        const dated = {};
        markets.forEach((m) => {
          const s = String(m.base || '').toUpperCase();
          if (!s) return;
          const t = m.listedAt ? Date.parse(m.listedAt) : NaN;
          if (!(s in dated)) dated[s] = 0;
          if (t > 0 && (!dated[s] || t < dated[s])) dated[s] = t; // the coin's first market on the exchange
        });
        Object.keys(dated).forEach((s) => {
          if (dated[s] > 0) {
            const iso = new Date(dated[s]).toISOString();
            if (seen[s] !== iso) { seen[s] = iso; changed = true; }
          } else if (!(s in seen)) {
            seen[s] = first ? null : new Date().toISOString();
            changed = true;
            if (!first) console.log(`new listing on ${id}: ${s}`);
          }
        });
      }
      if (changed) save();
    } finally { running = false; }
  }

  function siteCoins() {
    try { return JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); } catch (e) { return []; }
  }

  async function recent() {
    const since = Date.now() - NEW_HOURS * 3600 * 1000;
    loadState();
    // this process may not have scanned yet: the markets of an exchange with a recent listing are read now
    for (const [id] of EXCHANGES) {
      const seen = state.seen[id] || {};
      if (snapshots[id] || !Object.keys(seen).some((sym) => seen[sym] && Date.parse(seen[sym]) >= since)) continue;
      try { const d = await callRoute(`/api/exchange/${id}`, {}); if (d && d.markets && d.markets.length) snapshots[id] = d.markets; } catch (e) { /* shown on the next answer */ }
    }
    let exchangeCoins = [];
    try { exchangeCoins = ((await app.locals.getExchangeCoins()) || {}).coins || []; } catch (e) { /* names and pages are optional */ }
    const registry = siteCoins();
    const out = [];
    EXCHANGES.forEach(([id, label]) => {
      const seen = state.seen[id] || {};
      Object.keys(seen).forEach((sym) => {
        const at = seen[sym] ? Date.parse(seen[sym]) : NaN;
        if (!(at >= since)) return;
        const markets = (snapshots[id] || []).filter((m) => String(m.base || '').toUpperCase() === sym);
        if (!markets.length) return; // not listed there any more
        // the coin's page: an exchange coin, or a coin with its own page on the site (XLN, BTC...)
        const ex = exchangeCoins.find((c) => c.symbol === sym);
        // a native coin first (a BEP-20 copy of a coin is not that coin), then a token with its own page (XLNFT)
        const own = ex ? null : (registry.find((c) => String(c.symbol).toUpperCase() === sym && !c.contract) || registry.find((c) => String(c.symbol).toUpperCase() === sym));
        const best = markets.slice().sort((a, b) => (b.volumeUsdt || 0) - (a.volumeUsdt || 0))[0];
        out.push({
          exchange_id: id,
          exchange: label,
          symbol: sym,
          name: ex ? ex.name : (own ? own.name : sym),
          coin_id: ex ? ex.id : (own ? own.id : null),
          logo: ex ? ex.logo : (own ? '/' + own.logo : `/api/logo/${id}/${sym}`),
          listed_at: new Date(at).toISOString(),
          pairs: markets.map((m) => `${sym}/${m.quote}`),
          price_usd: best && best.priceUsdt > 0 ? best.priceUsdt : null,
          change_24h_pct: best && best.price > 0 && best.change != null ? best.change : null,
          volume_24h_usd: markets.reduce((t, m) => t + (m.volumeUsdt || 0), 0),
        });
      });
    });
    return out.sort((a, b) => String(b.listed_at).localeCompare(String(a.listed_at)));
  }

  app.get('/api/exchange-listings', async (req, res) => {
    try {
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ ok: true, hours: NEW_HOURS, data: await recent() });
    } catch (e) {
      res.status(502).json({ ok: false, error: 'exchange data temporarily unavailable' });
    }
  });

  setTimeout(() => { scan().catch((e) => console.error('exchange listings scan failed', e && e.message)); }, 30 * 1000).unref();
  setInterval(() => { scan().catch((e) => console.error('exchange listings scan failed', e && e.message)); }, SCAN_MS).unref();
  return { scan, recent };
};
