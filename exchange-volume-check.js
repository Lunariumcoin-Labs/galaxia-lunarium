// Automated-volume check of an exchange (owner, 2026-10-20). The notice "volume not verifiable" on an
// exchange page is not a fixed flag: every hour the trades of the last 24h of each market with volume
// are read from the exchange's own API, and a market counts as automated when it has at least
// MIN_TRADES trades and its typical (median) trade is worth less than MAX_MEDIAN_USD. The notice shows
// while such markets make up at least SHARE_PCT % of the exchange's 24h volume, and goes away by itself
// when the pattern ends. A check that cannot run keeps its last result for STALE_MS, then nothing is
// shown (no notice without a recent reading).
//
// Every exchange of the site is checked (owner, 2026-10-20: the rule holds for the current exchanges and
// for every new one, while it reports such data, until it fixes it). A NEW EXCHANGE NEEDS AN ENTRY IN
// SOURCES below: its trade list (median trade) or, when it publishes none, its 24h trade count
// (average trade = volume / trades). The hosting runs more than one app process: the result is also kept
// in data/exchange-volume-check.json and the newest one is answered.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'exchange-volume-check.json');
const CHECK_MS = 60 * 60 * 1000;
const STALE_MS = 6 * 3600 * 1000;
const MIN_TRADES = 100;
const MAX_MEDIAN_USD = 10;
const SHARE_PCT = 50;
// the trade lists of at most this many markets (the largest by 24h volume) are read per exchange; the rest
// count as not automated
const MAX_MARKETS = 60;

module.exports = function mountExchangeVolumeCheck(app, { fetchJson, callRoute, mapLimit }) {
  // per exchange: trades(m) = the market's recent trades [{ quoteValue, at (ms) }] (typical trade = median),
  // or stats(m) = { count, typicalUsd } from the exchange snapshot when no trade list is published
  const list = (d) => (Array.isArray(d) ? d : []);
  const SOURCES = {
    cexius: {
      trades: async (m) => list(await fetchJson(`https://cexius.com/api/v2/markets/${encodeURIComponent(m.base + '-' + m.quote)}/trades?limit=1000`))
        .map((t) => ({ quoteValue: Number(t.quote_volume) || Number(t.price) * Number(t.amount), at: Date.parse(t.created_at) })),
    },
    gatevia: {
      trades: async (m) => list(await fetchJson(`https://api.gatevia.io/public/markets/${encodeURIComponent(m.base + '_' + m.quote)}/trades?limit=1000`))
        .map((t) => ({ quoteValue: Number(t.price) * Number(t.amount), at: Number(t.ts) * 1000 })),
    },
    lunariumtrade: {
      trades: async (m) => list(await fetchJson(`https://lunariumtrade.io/api/markets/${encodeURIComponent(m.base + '/' + m.quote)}/trades?limit=500`))
        .map((t) => ({ quoteValue: Number(t.price) * Number(t.amount), at: Date.parse(String(t.created_at).replace(' ', 'T') + 'Z') })),
    },
    mexc: {
      trades: async (m) => list(await fetchJson(`https://api.mexc.com/api/v3/trades?symbol=${encodeURIComponent(m.base + m.quote)}&limit=1000`))
        .map((t) => ({ quoteValue: Number(t.quoteQty) || Number(t.price) * Number(t.qty), at: Number(t.time) })),
    },
    // Qutrade publishes no trade list, only each market's number of trades in 24h: average trade
    qutrade: {
      stats: (m) => ({ count: Number(m.trades) || 0, typicalUsd: m.trades > 0 ? m.volumeUsdt / m.trades : null }),
    },
  };
  // { count, typicalUsd, capped }: capped = the trade list returned only its newest page, all of it from
  // the last 24h, so the real count is higher (shown as "1,000+"; MEXC answers about 200 at most)
  const typical = async (id, m) => {
    const src = SOURCES[id];
    if (src.stats) return Object.assign({ capped: false }, src.stats(m));
    const usdPerQuote = m.priceUsdt / m.price;
    const dayAgo = Date.now() - 86400 * 1000;
    const all = await src.trades(m);
    const recent = all.filter((t) => t.at >= dayAgo);
    const values = recent.filter((t) => t.quoteValue > 0).map((t) => t.quoteValue * usdPerQuote).sort((a, b) => a - b);
    return { count: values.length, typicalUsd: values.length ? values[Math.floor(values.length / 2)] : null, capped: all.length >= MIN_TRADES && recent.length === all.length };
  };

  let results = {};
  let resultsMtime = 0;
  function load() {
    try {
      const mtime = fs.statSync(FILE).mtimeMs;
      if (mtime === resultsMtime) return;
      const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      Object.keys(d || {}).forEach((id) => {
        if (!results[id] || Date.parse(d[id].checkedAt) > Date.parse(results[id].checkedAt)) results[id] = d[id];
      });
      resultsMtime = mtime;
    } catch (e) { /* no check yet */ }
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(results));
      fs.renameSync(tmp, FILE);
      resultsMtime = fs.statSync(FILE).mtimeMs;
    } catch (e) { console.error('volume check: could not save', e && e.message); }
  }

  async function check(id) {
    const ex = await callRoute(`/api/exchange/${id}`, {});
    const markets = ((ex && ex.markets) || []).filter((m) => m.volumeUsdt > 0 && m.price > 0 && m.priceUsdt > 0);
    const total = markets.reduce((s, m) => s + m.volumeUsdt, 0);
    if (!(total > 0)) return null;
    let autoVolume = 0;
    let checked = 0;
    const autoMarkets = [];
    const pool = SOURCES[id].stats ? markets : markets.slice().sort((a, b) => b.volumeUsdt - a.volumeUsdt).slice(0, MAX_MARKETS);
    await mapLimit(pool, 2, async (m) => {
      const t = await typical(id, m);
      checked += 1;
      if (t.count < MIN_TRADES || t.typicalUsd == null) return;
      if (t.typicalUsd < MAX_MEDIAN_USD) {
        autoVolume += m.volumeUsdt;
        autoMarkets.push({ pair: `${m.base}/${m.quote}`, base: m.base, volumeUsd: Math.round(m.volumeUsdt * 100) / 100, trades: t.count, tradesCapped: !!t.capped, typicalUsd: Math.round(t.typicalUsd * 100) / 100 });
      }
    });
    if (checked < pool.length) return null; // a market could not be read: no verdict this round
    const sharePct = (autoVolume / total) * 100;
    return {
      automated: sharePct >= SHARE_PCT,
      sharePct: Math.round(sharePct * 10) / 10,
      marketsChecked: checked,
      marketsWithVolume: markets.length,
      automatedMarkets: autoMarkets.length,
      // the markets that fit the pattern, largest first, with their share of the exchange's 24h volume
      markets: autoMarkets.sort((a, b) => b.volumeUsd - a.volumeUsd).map((x) => Object.assign(x, { sharePct: Math.round((x.volumeUsd / total) * 1000) / 10 })),
      typicalKind: SOURCES[id].stats ? 'average' : 'median',
      rule: `markets with >= ${MIN_TRADES} trades in 24h and a typical trade (${SOURCES[id].stats ? 'average' : 'median'}) under US$ ${MAX_MEDIAN_USD}; notice at >= ${SHARE_PCT}% of the 24h volume`,
      checkedAt: new Date().toISOString(),
    };
  }

  let running = false;
  async function runAll() {
    if (running) return;
    running = true;
    try {
      load();
      for (const id of Object.keys(SOURCES)) {
        try {
          const r = await check(id);
          if (r) {
            if (!results[id] || results[id].automated !== r.automated) console.log(`volume check ${id}: automated=${r.automated} (${r.sharePct}% of the 24h volume)`);
            results[id] = r;
          }
        } catch (e) { console.error('volume check failed', id, e && e.message); }
      }
      save();
    } finally { running = false; }
  }

  // the latest result for an exchange, or null (no recent check)
  app.locals.volumeCheck = (id) => {
    load();
    const r = results[id];
    return r && Date.now() - Date.parse(r.checkedAt) < STALE_MS ? r : null;
  };

  setTimeout(() => { runAll(); }, 2 * 60 * 1000).unref();
  setInterval(runAll, CHECK_MS).unref();
  return { runAll, check };
};
