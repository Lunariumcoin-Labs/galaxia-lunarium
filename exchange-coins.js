// Every coin traded on the partner exchanges Qutrade, Gatevia, Cexius and LunariumTrade, placed in the site's tabs by its
// consensus (exchange-coins-meta.json: masternode / stake / mining / token). Prices, change and
// volume come from the same exchange snapshots as the Exchanges pages; nothing is typed by hand.
// Coins that already have their own page (XLN, PIVX, GVIA, S11) are left out, and a coin that is
// not classified yet is not shown rather than shown in the wrong tab.
const path = require('path');
const fs = require('fs');
const coinSupply = require('./coin-supply');
const explorerHealth = require('./explorer-health');

// first address of a coin's explorer link (some coins list two)
const explorerUrl = (x) => { const u = String(x || '').split(',')[0].trim(); return /^https?:\/\//i.test(u) ? u : null; };

const META_FILE = path.join(__dirname, 'exchange-coins-meta.json');
const AUTO_FILE = path.join(__dirname, 'data', 'exchange-coins-auto.json');
const SOURCES = [
  { id: 'qutrade', name: 'Qutrade', url: (b, q) => `https://qutrade.io/en/?market=${b.toLowerCase()}_${q.toLowerCase()}`, ticker: '/api/ticker/qutrade', klines: '/api/klines/qutrade', param: (b, q) => `symbol=${b}_${q}` },
  { id: 'gatevia', name: 'Gatevia', url: (b, q) => `https://gatevia.io/exchange/${b}_${q}`, ticker: '/api/ticker/gatevia', klines: '/api/klines/gatevia', param: (b, q) => `symbol=${b}_${q}` },
  { id: 'cexius', name: 'Cexius', url: (b, q) => `https://cexius.com/trade/${b}-${q}`, ticker: '/api/ticker/cexius', klines: '/api/klines/cexius', param: (b, q) => `market=${b}-${q}` },
  // LunariumTrade: every coin it lists (owner, 2026-11-12). Its big coins with their own page (DOGE, LTC, ETH,
  // SOL...) are on those pages; CHESS there is ChessCoin 0.32% (LunariumTrade's own coin logo).
  { id: 'lunariumtrade', name: 'LunariumTrade', url: (b, q) => `https://lunariumtrade.io/trade/${b}-${q}`, ticker: '/api/ticker/lunarium', klines: '/api/klines/lunarium', param: (b, q) => `pair=${b}/${q}` },
];
const HAS_PAGE = new Set(['XLN', 'XLNFT', 'PIVX', 'GVIA', 'S11', 'MON', 'NS', 'VIVO', 'BTC', 'SOL', 'LTC', 'DOGE', 'BCH', 'DASH', 'ETH', 'BNB']);
// big coins the partner exchanges also trade: their main market is read on Binance as well (owner,
// 2026-10-30; BNB has its own page since v216). MATIC became POL 1:1 (Polygon's migration; the supply the site reads is the POL contract)
// and Binance's MATIC/USDT market stopped trading, so POL/USDT is its market there.
const BINANCE_MARKETS = { MATIC: ['POL', 'POLUSDT'] };
const CACHE_MS = 60 * 1000;
const NEW_HOURS = 24; // how long a coin just listed keeps its "new" notice and badge (owner's decision)

module.exports = function mountExchangeCoins(app, { callRoute, siteIds }) {
  let cache = { at: 0, data: null };
  let inflight = null;

  async function build() {
    let meta = {};
    let excluded = {};
    try { const d = JSON.parse(fs.readFileSync(META_FILE, 'utf8')); meta = d.coins || {}; excluded = d.excluded || {}; } catch (e) { /* no classification file */ }
    // coins listed automatically (exchange-coins-auto.js) and the admin's corrections come on top
    try {
      const auto = JSON.parse(fs.readFileSync(AUTO_FILE, 'utf8'));
      // coins waiting for the admin's classification still get a page and the new-listing notice
      meta = Object.assign({}, meta, auto.pending || {}, auto.coins || {});
      excluded = Object.assign({}, excluded, auto.excluded || {});
    } catch (e) { /* nothing detected yet */ }
    const taken = new Set(siteIds());
    const books = await Promise.all(SOURCES.map((s) => callRoute(`/api/exchange/${s.id}`, {}).then((d) => ({ s, d })).catch(() => ({ s, d: null }))));
    const coins = {};
    books.forEach(({ s, d }) => {
      ((d && d.markets) || []).forEach((m) => {
        const sym = String(m.base || '').toUpperCase();
        const info = meta[sym];
        const cats = info && (info.categories || (info.category ? [info.category] : []));
        if (!cats || (!cats.length && !info.auto) || HAS_PAGE.has(sym) || excluded[sym]) return;
        let id = sym.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (taken.has(id)) id += '-coin'; // e.g. native DOGE next to the site's BEP-20 DOGE page
        const c = coins[sym] || (coins[sym] = {
          id, symbol: sym, name: info.name, category: cats[0] || null, categories: cats, evidence: info.evidence || null,
          // detected automatically: shown as a new listing for NEW_HOURS hours
          listed_at: info.detected_at || null, listed_on: info.exchanges || null,
          is_new: !!(info.detected_at && Date.now() - Date.parse(info.detected_at) < NEW_HOURS * 3600000),
          logo: `/api/logo/${s.id}/${sym}`,
          links: { website: info.website || null, explorer: info.explorer || null, source_code: info.source_code || null },
          markets: [],
        });
        c.markets.push({
          exchange: s.name, exchange_id: s.id, type: 'CEX', pair: `${sym}/${m.quote}`, quote: m.quote,
          url: s.url(sym, m.quote),
          price: m.price, price_usd: m.priceUsdt, change_24h_pct: m.change, volume_24h_usd: m.volumeUsdt,
          bid: m.bid, ask: m.ask, spread_pct: m.spreadPct,
          // single-market ticker and candles exist for USDT pairs (prices in the site's unit)
          ticker: m.quote === 'USDT' ? s.ticker : null,
          klines: m.quote === 'USDT' ? s.klines : null,
          params: m.quote === 'USDT' ? s.param(sym, 'USDT') : null,
        });
      });
    });
    await Promise.all(Object.keys(BINANCE_MARKETS).filter((sym) => coins[sym]).map(async (sym) => {
      const [base, symbol] = BINANCE_MARKETS[sym];
      const t = await callRoute('/api/ticker/binance', { symbol }).catch(() => null);
      if (!t || !t.ok || !(t.price > 0)) return;
      coins[sym].markets.push({
        exchange: 'Binance', exchange_id: 'binance', type: 'CEX', pair: `${base}/USDT`, quote: 'USDT',
        url: `https://www.binance.com/en/trade/${base}_USDT`,
        price: t.price, price_usd: t.price, change_24h_pct: t.change, volume_24h_usd: t.volume,
        bid: t.bid, ask: t.ask, spread_pct: t.bid > 0 && t.ask >= t.bid ? ((t.ask - t.bid) / t.ask) * 100 : null,
        ticker: '/api/ticker/binance', klines: '/api/klines/binance', params: `symbol=${symbol}`,
      });
    }));
    const list = Object.values(coins).map((c) => {
      c.markets.sort((a, b) => (b.volume_24h_usd || 0) - (a.volume_24h_usd || 0));
      // a last price is a market price only when the order book backs it: both sides quoted and the ask
      // at most twice the bid (XMR on Cexius once had 5.28 / 5,260 and no trades -- a last price of 526)
      const booked = (m) => m.price_usd > 0 && m.bid > 0 && m.ask > 0 && m.ask <= m.bid * 2;
      // headline: the most liquid market with a backed price, then any market with a price
      const best = c.markets.find((m) => booked(m) && (m.volume_24h_usd || 0) > 0) || c.markets.find(booked)
        || c.markets.find((m) => m.price_usd > 0 && (m.volume_24h_usd || 0) > 0) || c.markets.find((m) => m.price_usd > 0) || null;
      c.price_confirmed = !!best && booked(best);
      c.price_usd = best ? best.price_usd : null;
      c.price_source = best ? best.exchange : null;
      c.change_24h_pct = best ? best.change_24h_pct : null;
      c.volume_24h_usd = c.markets.reduce((s, m) => s + (m.volume_24h_usd || 0), 0);
      // supply read from the coin's own chain (coin-supply.js); a coin without a verifiable
      // source has no supply and therefore no market cap
      const sup = coinSupply.get(c.symbol);
      c.supply = sup ? sup.supply : null;
      c.supply_source = sup ? sup.source : null;
      c.supply_updated_at = sup ? sup.updated_at : null;
      c.market_cap_usd = sup && c.price_confirmed ? Math.round(sup.supply * c.price_usd * 100) / 100 : null;
      // live status shown next to the explorer link: supply verified, or what is wrong
      const ex = explorerUrl(c.links.explorer);
      c.supply_status = coinSupply.status(c.symbol, ex ? explorerHealth.status(ex) : 'none');
      return c;
    }).sort((a, b) => (b.volume_24h_usd || 0) - (a.volume_24h_usd || 0) || a.symbol.localeCompare(b.symbol));
    explorerHealth.track(list.map((c) => explorerUrl(c.links.explorer)).filter(Boolean));
    return { at: Date.now(), coins: list };
  }
  async function get() {
    if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
    if (!inflight) inflight = build().then((d) => { cache = { at: Date.now(), data: d }; return d; }).finally(() => { inflight = null; });
    if (cache.data) return cache.data; // serve the previous list while refreshing
    return inflight;
  }
  app.locals.getExchangeCoins = get;

  app.get('/api/exchange-coins', async (req, res) => {
    try {
      const d = await get();
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ ok: true, updated_at: new Date(d.at).toISOString(), data: d.coins });
    } catch (e) {
      res.status(502).json({ ok: false, error: 'exchange data temporarily unavailable' });
    }
  });
};
