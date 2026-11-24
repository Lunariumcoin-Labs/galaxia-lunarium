// GaláxiaLunarium public API (v1) -- read-only, JSON, no key, CORS open, rate limited per IP.
//
// Every figure comes from the same internal routes the site itself uses (exchange tickers/klines,
// explorers, the audit samplers and the partner-exchange builders); nothing here talks to an
// upstream directly. Coin/market data is served from a snapshot refreshed at most once a minute and
// only while someone is asking (stale-while-revalidate), so public traffic never multiplies the
// load on the exchanges' own APIs.
//
// The coin list is public-api-coins.json, generated from the site's COINS object
// (galaxialunarium-coins-data.js) -- regenerate it after adding a coin to the site.
const fs = require('fs');
const path = require('path');
const plans = require('./api-plans');
const coinSupply = require('./coin-supply');

const API_VERSION = '1.1.0';
const SITE = 'https://galaxia.lunariumcoin.com';
const SNAPSHOT_TTL_MS = 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RANGES = ['1H', '24H', '7D', '30D', '1Y'];

// Partner exchanges have a full market list (all their pairs); the others are only known through
// the markets GaláxiaLunarium tracks on them.
const EXCHANGES = {
  lunariumtrade: { name: 'LunariumTrade', type: 'CEX', url: 'https://lunariumtrade.io/', partner: true, official_lunarium: true },
  qutrade: { name: 'Qutrade', type: 'CEX', url: 'https://qutrade.io/', partner: true },
  gatevia: { name: 'Gatevia', type: 'CEX', url: 'https://gatevia.io/', partner: true },
  cexius: { name: 'Cexius', type: 'CEX', url: 'https://cexius.com/', partner: true },
  mexc: { name: 'MEXC', type: 'CEX', url: 'https://www.mexc.com/', partner: true },
  weex: { name: 'WEEX', type: 'CEX', url: 'https://www.weex.com/' },
  coinex: { name: 'CoinEx', type: 'CEX', url: 'https://www.coinex.com/' },
  nonkyc: { name: 'Nonkyc.io', type: 'CEX', url: 'https://nonkyc.io/' },
  nestex: { name: 'NestEx', type: 'CEX', url: 'https://trade.nestex.one/' },
  stakecube: { name: 'StakeCube', type: 'CEX', url: 'https://stakecube.net/' },
  binance: { name: 'Binance', type: 'CEX', url: 'https://www.binance.com/' },
  coinbase: { name: 'Coinbase', type: 'CEX', url: 'https://www.coinbase.com/' },
  okx: { name: 'OKX', type: 'CEX', url: 'https://www.okx.com/' },
  bybit: { name: 'Bybit', type: 'CEX', url: 'https://www.bybit.com/' },
  pancakeswap: { name: 'PancakeSwap', type: 'DEX', url: 'https://pancakeswap.finance/' },
  binanceweb3: { name: 'Binance Web3', type: 'DEX', url: 'https://web3.binance.com/?ref=DZPI0SI1', partner: true },
  mexcdex: { name: 'MEXC DEX', type: 'DEX', url: 'https://www.mexc.com/dex' },
  bitgetonchain: { name: 'Bitget Onchain', type: 'DEX', url: 'https://www.bitget.com/on-chain' },
  geckoterminal: { name: 'GeckoTerminal', type: 'DEX', url: 'https://www.geckoterminal.com/' },
  coinmarketcapdex: { name: 'CoinMarketCap DEX', type: 'DEX', url: 'https://dex.coinmarketcap.com/' },
};
const EXCHANGE_ID_BY_NAME = {};
Object.keys(EXCHANGES).forEach((id) => { EXCHANGE_ID_BY_NAME[EXCHANGES[id].name.toLowerCase()] = id; });
// For a BNB Chain token, Binance lists the native asset, not the token: a 1:1 peg reference price,
// so its volume is not the token's volume and is left out of totals. For a native coin (Bitcoin,
// Solana) the Binance market is the coin's own market and counts like any other.
const REFERENCE_EXCHANGES = new Set(['binance']);
// A front end that trades a token on a pool already listed as its own market (Binance Web3 on the
// PancakeSwap pool, MEXC DEX and Bitget Onchain on the same pool): its volume is part of that pool's volume, so it is shown but never added to the
// totals, and it does not set the headline price.
const ROUTED_VENUES = new Set(['binanceweb3', 'mexcdex', 'bitgetonchain', 'geckoterminal', 'coinmarketcapdex']);
const AUDITED = new Set(['xln', 'pivx', 'mon', 'ns', 'btc', 'sol', 'xlnft', 'ltc-coin', 'doge-coin', 'bch', 'dash', 'eth-coin', 'bnb']);
// audited coins that also have the masternode / staking rewards breakdown
const REWARDED = new Set(['xln', 'pivx', 'mon', 'ns']);
const NOT_CIRCULATING = new Set(['aster', 'chesstoken']); // chesstoken: 100M minted on BNB Chain, circulating share not verifiable

function loadRegistry() {
  const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'public-api-coins.json'), 'utf8'));
  list.forEach((c) => c.markets.forEach((m) => {
    m.exchangeId = EXCHANGE_ID_BY_NAME[m.exchange.toLowerCase()] || m.exchange.toLowerCase().replace(/[^a-z0-9]/g, '');
    m.query = Object.fromEntries(new URLSearchParams(m.params));
  }));
  return list;
}

function round(v, digits) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

module.exports = function mountPublicApi(app, { callRoute, mapLimit, fetchJson, tokenSupply }) {
  const REGISTRY = loadRegistry();
  const BY_ID = {};
  REGISTRY.forEach((c) => { BY_ID[c.id] = c; });
  // coins approved through listing requests (listings.js) join the API as soon as they are listed
  function addListed() {
    let listed = [];
    try { listed = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'listed-coins.json'), 'utf8')); } catch (e) { return; }
    listed.forEach((c) => {
      if (!c || !c.id || BY_ID[c.id]) return;
      const coin = { id: c.id, symbol: c.symbol, name: c.name, category: c.category, official_lunarium: false, network: c.network, contract: c.contract, logo: c.logo ? String(c.logo).replace(/^\//, '') : null, links: Object.fromEntries(Object.entries(c.links || {}).filter(([, v]) => v)), markets: [] };
      (c.markets || []).forEach((m) => coin.markets.push(Object.assign({}, m, {
        exchangeId: EXCHANGE_ID_BY_NAME[String(m.exchange).toLowerCase()] || String(m.exchange).toLowerCase().replace(/[^a-z0-9]/g, ''),
        query: Object.fromEntries(new URLSearchParams(m.params || '')),
      })));
      REGISTRY.push(coin);
      BY_ID[coin.id] = coin;
    });
  }
  addListed();
  setInterval(addListed, 60 * 1000).unref();

  // ---- helpers
  const iso = (t) => new Date(t).toISOString();
  function send(res, data, meta) {
    res.json({ ok: true, data, meta: Object.assign({ api_version: API_VERSION, docs: SITE + '/?view=documentacao#api' }, meta || {}) });
  }
  function fail(res, status, error) {
    res.status(status).json({ ok: false, error });
  }

  // ---- CORS for the X-API-Key header (browsers preflight it). Responses are never stored by shared
  // caches: the hosting CDN otherwise replays a cached copy to other clients, skipping the key
  // check, the plan limits and the monthly quota. Market data is already cached server-side (60s).
  app.use('/api/v1', (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('Access-Control-Allow-Headers', 'X-API-Key, Content-Type');
    res.set('Access-Control-Expose-Headers', 'X-API-Plan, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-Quota-Limit, X-Quota-Remaining, Retry-After');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // ---- plans: per-minute window per API key (paid plans) or per IP (free), plus a monthly quota
  // per key
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    hits.forEach((v, k) => { if (now - v.start > RATE_WINDOW_MS) hits.delete(k); });
  }, RATE_WINDOW_MS).unref();
  app.use('/api/v1', (req, res, next) => {
    const cfg = plans.loadConfig();
    const raw = req.get('x-api-key') || req.query.api_key;
    let rec = null;
    let bucket;
    if (raw) {
      rec = plans.lookupKey(raw);
      if (!rec) return fail(res, 401, 'invalid API key');
      if (rec.expires_at && Date.parse(rec.expires_at) < Date.now()) return fail(res, 403, 'API key expired on ' + rec.expires_at.slice(0, 10));
      if (rec.paused) return fail(res, 403, 'API key paused by its owner; resume it in My account');
      bucket = 'k:' + rec.id;
    } else {
      const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      bucket = 'ip:' + (fwd || req.socket.remoteAddress || 'unknown');
    }
    const planId = rec && cfg.plans[rec.plan] ? rec.plan : 'free';
    const plan = cfg.plans[planId];
    const now = Date.now();
    let h = hits.get(bucket);
    if (!h || now - h.start > RATE_WINDOW_MS) { h = { start: now, count: 0 }; hits.set(bucket, h); }
    h.count += 1;
    const reset = Math.ceil((h.start + RATE_WINDOW_MS - now) / 1000);
    res.set('X-API-Plan', planId);
    res.set('X-RateLimit-Limit', String(plan.per_minute));
    res.set('X-RateLimit-Remaining', String(Math.max(0, plan.per_minute - h.count)));
    res.set('X-RateLimit-Reset', String(reset));
    if (h.count > plan.per_minute) {
      res.set('Retry-After', String(reset));
      return fail(res, 429, `rate limit exceeded: ${plan.per_minute} requests per minute` + (rec ? '' : ' per IP; see GET /api/v1/plans for higher limits'));
    }
    if (rec) {
      if (plan.per_month && plans.getUsage(rec.id) >= plan.per_month) {
        return fail(res, 429, `monthly quota of ${plan.per_month} requests reached; it resets on the 1st (UTC)`);
      }
      const used = plans.addUsage(rec.id);
      if (plan.per_month) {
        res.set('X-Quota-Limit', String(plan.per_month));
        res.set('X-Quota-Remaining', String(Math.max(0, plan.per_month - used)));
      }
    }
    req.apiKey = rec;
    next();
  });

  // coins whose headline price is the highest price among their live exchanges (see buildSnapshot)
  const HIGHEST_PRICE = new Set(['xln']);

  // ---- coin/market snapshot
  let snapshot = null;
  let inflight = null;

  // Last good ticker per market: a market whose exchange fails one round (timeouts, rate limits)
  // keeps its previous reading for up to LAST_GOOD_MAX_MS, with its own timestamp.
  const LAST_GOOD_MAX_MS = 15 * 60 * 1000;
  const lastGood = new Map();

  async function buildSnapshot() {
    const jobs = [];
    REGISTRY.forEach((c) => c.markets.forEach((m) => jobs.push({ c, m })));
    const tickers = new Map();
    const fetchOne = async ({ c, m }) => {
      const key = c.id + '|' + m.exchange + '|' + m.pair; // an exchange can have two markets of a coin
      try {
        const t = await callRoute(m.ticker, m.query);
        if (t && t.ok) { t.at = Date.now(); lastGood.set(key, t); }
        tickers.set(key, t);
      } catch (e) {
        const prev = lastGood.get(key);
        tickers.set(key, prev && Date.now() - prev.at < LAST_GOOD_MAX_MS ? prev : { ok: false, error: String((e && e.message) || e) });
      }
    };
    await mapLimit(jobs, 4, fetchOne);
    const networks = {};
    // BEP-20 tokens without a network endpoint: supply read from the contract (server.js tokenSupply)
    const supplies = {};
    if (tokenSupply) {
      await mapLimit(REGISTRY.filter((c) => c.contract && /^0x[0-9a-fA-F]{40}$/.test(c.contract)), 3, async (c) => {
        try { supplies[c.id] = await tokenSupply(c.contract); } catch (e) { /* supply simply unknown this round */ }
      });
    }
    await mapLimit(REGISTRY.filter((c) => c.network_api), 2, async (c) => {
      try { networks[c.id] = await callRoute(c.network_api, {}); } catch (e) { /* coin simply has no network block this round */ }
    });

    const coins = {};
    REGISTRY.forEach((c) => {
      const markets = c.markets.map((m) => {
        const t = tickers.get(c.id + '|' + m.exchange + '|' + m.pair) || {};
        // a market announced by the exchange but not open yet: it is not listed until its ticker answers
        if (m.when_listed && !t.ok) return null;
        // a pair quoted in another coin has no USDT price: it is live when it traded in the last 24h
        const live = t.ok && !t.halted && (m.cross ? t.pair_price != null && !t.stale : t.price != null);
        // inactive = the market exists but had no trade in 24h (last trade reported apart, never used as price)
        // (a market that answers with no price at all has not traded yet: inactive too)
        const status = t.halted ? 'paused' : (live ? 'live' : (t.ok && (t.stale || t.price == null) ? 'inactive' : 'unavailable'));
        return {
          exchange: m.exchange,
          exchange_id: m.exchangeId,
          type: m.type,
          pair: m.pair,
          url: m.url,
          status,
          reference_only: (REFERENCE_EXCHANGES.has(m.exchangeId) && !!c.contract) || ROUTED_VENUES.has(m.exchangeId) || !!m.cross,
          routed_through_pool: ROUTED_VENUES.has(m.exchangeId) || undefined,
          // a pair quoted in another coin, in its own units (no USDT value: price_usd and the USD volume
          // stay null, and it is left out of the headline price and of the totals)
          cross_pair: m.cross || undefined,
          pair_price: m.cross && t.ok ? t.pair_price ?? null : undefined,
          pair_quote: m.cross && t.ok ? t.quote ?? null : undefined,
          pair_bid: m.cross && t.ok ? t.pair_bid ?? null : undefined,
          pair_ask: m.cross && t.ok ? t.pair_ask ?? null : undefined,
          pair_volume_base: m.cross && t.ok ? t.base_volume ?? null : undefined,
          pair_volume_quote: m.cross && t.ok ? t.quote_volume ?? null : undefined,
          traded_pair: m.cross && t.ok ? t.traded_pair ?? null : undefined,
          price_usd: t.ok ? t.price : null,
          bid: t.ok ? t.bid ?? null : null,
          ask: t.ok ? t.ask ?? null : null,
          spread_pct: t.ok && t.bid > 0 && t.ask >= t.bid ? round(((t.ask - t.bid) / t.ask) * 100, 4) : null,
          change_24h_pct: t.ok && t.change != null ? round(t.change, 4) : null,
          volume_24h_usd: t.ok && t.volume != null ? round(t.volume, 2) : null,
          liquidity_usd: t.ok && t.liquidity != null ? round(t.liquidity, 2) : null,
          last_trade_price_usd: t.ok && t.stale ? t.last_price : undefined,
          last_trade_at: t.ok && t.stale ? t.last_trade_at : undefined,
          updated_at: t.ok && t.at ? iso(t.at) : null,
        };
      }).filter(Boolean);
      const liveMarkets = markets.filter((m) => m.status === 'live');
      // Headline price: the most liquid live market (same rule as the site), so one thin book
      // can't set the price. XLN is the exception, by its owner's decision: the highest price
      // among its live exchanges, whichever exchange that is.
      const mostLiquid = liveMarkets.filter((m) => !ROUTED_VENUES.has(m.exchange_id) && !m.cross_pair).sort((a, b) => (b.volume_24h_usd || 0) - (a.volume_24h_usd || 0))[0] || null;
      const highest = HIGHEST_PRICE.has(c.id)
        ? liveMarkets.filter((m) => m.price_usd > 0 && !m.reference_only && !m.cross_pair).sort((a, b) => b.price_usd - a.price_usd)[0] || null
        : null;
      const best = highest || mostLiquid;
      const volume = markets.filter((m) => m.status === 'live' && !m.reference_only).reduce((s, m) => s + (m.volume_24h_usd || 0), 0);
      const net = networks[c.id] && networks[c.id].ok ? networks[c.id] : null;
      const chain = supplies[c.id] || null;
      // a native coin without a network endpoint here: supply read from its explorer (coin-supply.js)
      const explorer = !c.network_api && !c.contract ? coinSupply.get(c.symbol) : null;
      const supply = net && net.supply != null ? net.supply : (chain ? chain.supply : (explorer ? explorer.supply : null));
      // tokens with locked/vesting allocations: the on-chain supply is not the circulating one, so no market cap
      const circulating = supply != null && !NOT_CIRCULATING.has(c.id);
      coins[c.id] = {
        id: c.id,
        symbol: c.symbol,
        name: c.name,
        category: c.category,
        official_lunarium: c.official_lunarium,
        network: c.network,
        contract: c.contract,
        logo: SITE + '/' + c.logo,
        page: SITE + '/?coin=' + c.id,
        price_usd: best ? best.price_usd : null,
        price_source: best ? best.exchange : null,
        change_24h_pct: best ? best.change_24h_pct : null,
        volume_24h_usd: round(volume, 2),
        supply: supply != null ? round(supply, 8) : null,
        supply_source: net && net.supply != null ? 'network' : (chain ? 'contract' : (explorer ? 'explorer' : null)),
        // where an 'explorer' supply was read (shown as the source on the coin page)
        supply_origin: !(net && net.supply != null) && !chain && explorer ? explorer.source : null,
        // 'ok' when the supply was read; otherwise why not (codes of coin-supply.js status())
        supply_status: supply != null ? (circulating ? 'ok' : 'not_circulating') : (!c.network_api && !c.contract ? ((coinSupply.status(c.symbol, null) || {}).code || 'no_supply') : 'read_failed'),
        market_cap_usd: circulating && best ? round(supply * best.price_usd, 2) : null,
        markets_total: markets.length,
        markets_live: liveMarkets.length,
        has_network_stats: !!c.network_api,
        has_audit: AUDITED.has(c.id),
        links: c.links,
        markets,
      };
    });
    return { at: Date.now(), coins };
  }

  function refreshSnapshot() {
    if (!inflight) {
      inflight = buildSnapshot()
        .then((s) => { snapshot = s; return s; })
        .finally(() => { inflight = null; });
    }
    return inflight;
  }
  async function getSnapshot() {
    if (snapshot) {
      if (Date.now() - snapshot.at > SNAPSHOT_TTL_MS) refreshSnapshot().catch((e) => console.error('public api snapshot failed', e && e.message));
      return snapshot;
    }
    return refreshSnapshot();
  }
  // shared with the price-alert checker (price-alerts.js)
  app.locals.getCoinSnapshot = getSnapshot;
  // every coin the site shows, with its live price: the listed coins (snapshot) plus the coins of
  // the partner exchanges (used by the price alerts)
  // Each coin comes with its live markets (key "Exchange|PAIR"), so an alert can follow every
  // exchange on its own. The snapshot is refreshed first when it is older than a minute: an alert
  // must never be measured against an old price.
  app.locals.getPricedCoins = async () => {
    const fresh = snapshot && Date.now() - snapshot.at <= SNAPSHOT_TTL_MS ? snapshot : await refreshSnapshot();
    const ex = await exchangeCoins();
    const out = {};
    Object.values(ex).forEach((c) => {
      const priced = (c.markets || []).filter((m) => m.price_usd > 0);
      // prices of pairs quoted in another coin move with that coin too: USDT pairs when there are any
      const usdt = priced.filter((m) => m.quote === 'USDT');
      out[c.id] = {
        id: c.id, symbol: c.symbol, name: c.name, price_usd: c.price_usd > 0 ? c.price_usd : null, price_source: c.price_source || null,
        markets: (usdt.length ? usdt : priced).map((m) => ({ key: m.exchange + '|' + m.pair, exchange: m.exchange, pair: m.pair, price_usd: m.price_usd })),
      };
    });
    Object.keys(fresh.coins).forEach((id) => {
      const c = fresh.coins[id];
      out[id] = {
        id: c.id, symbol: c.symbol, name: c.name, price_usd: c.price_usd, price_source: c.price_source,
        markets: (c.markets || []).filter((m) => m.status === 'live' && m.price_usd > 0).map((m) => ({ key: m.exchange + '|' + m.pair, exchange: m.exchange, pair: m.pair, price_usd: m.price_usd })),
      };
    });
    return out;
  };
  // warm up once shortly after start so the first caller doesn't wait for a full round
  setTimeout(() => { refreshSnapshot().catch((e) => console.error('public api warm-up failed', e && e.message)); }, 15000).unref();

  const summary = (c) => {
    const { markets, links, ...rest } = c;
    return rest;
  };

  // ---- routes
  app.get('/api/v1', (req, res) => {
    send(res, {
      name: 'GaláxiaLunarium Public API',
      version: API_VERSION,
      base_url: SITE + '/api/v1',
      auth: 'optional: send an API key in the X-API-Key header for a paid plan (see /plans)',
      rate_limit: `free: ${plans.loadConfig().plans.free.per_minute} requests per minute per IP; paid plans: see GET /api/v1/plans`,
      refresh: 'market data refreshed at most every 60 seconds',
      attribution: 'Data by GaláxiaLunarium (galaxia.lunariumcoin.com)',
      endpoints: [
        'GET /api/v1/coins',
        'GET /api/v1/coins/{id}',
        'GET /api/v1/coins/{id}/markets',
        'GET /api/v1/coins/{id}/ohlcv?range=1H|24H|7D|30D|1Y&exchange={exchange_id}',
        'GET /api/v1/coins/{id}/network',
        'GET /api/v1/coins/{id}/audit?history=true|false',
        'GET /api/v1/coins/{id}/rewards',
        'GET /api/v1/exchanges',
        'GET /api/v1/exchanges/{id}',
        'GET /api/v1/fx',
        'GET /api/v1/plans',
        'GET /api/v1/account (X-API-Key)',
        'GET /api/v1/openapi.json',
      ],
      coin_ids: REGISTRY.map((c) => c.id),
      exchange_ids: Object.keys(EXCHANGES),
    });
  });

  app.get('/api/v1/coins', async (req, res) => {
    try {
      const s = await getSnapshot();
      let list = REGISTRY.map((c) => summary(s.coins[c.id]));
      if (req.query.category) list = list.filter((c) => c.category === String(req.query.category));
      send(res, list, { updated_at: iso(s.at), count: list.length });
    } catch (e) { fail(res, 502, 'data temporarily unavailable'); }
  });

  function coinOr404(req, res) {
    const c = BY_ID[String(req.params.id).toLowerCase()];
    if (!c) fail(res, 404, 'unknown coin id; see GET /api/v1/coins');
    return c;
  }

  app.get('/api/v1/coins/:id', async (req, res) => {
    const c = coinOr404(req, res); if (!c) return;
    try {
      const s = await getSnapshot();
      if (!s.coins[c.id]) return fail(res, 503, 'this coin was just listed; its data will be available within a minute');
      send(res, s.coins[c.id], { updated_at: iso(s.at) });
    } catch (e) { fail(res, 502, 'data temporarily unavailable'); }
  });

  app.get('/api/v1/coins/:id/markets', async (req, res) => {
    const c = coinOr404(req, res); if (!c) return;
    try {
      const s = await getSnapshot();
      send(res, s.coins[c.id].markets, { updated_at: iso(s.at), coin: c.id });
    } catch (e) { fail(res, 502, 'data temporarily unavailable'); }
  });

  app.get('/api/v1/coins/:id/ohlcv', async (req, res) => {
    const c = coinOr404(req, res); if (!c) return;
    const range = String(req.query.range || '7D').toUpperCase();
    if (!RANGES.includes(range)) return fail(res, 400, 'range must be one of ' + RANGES.join(', '));
    let market;
    if (req.query.exchange) {
      market = c.markets.find((m) => m.exchangeId === String(req.query.exchange).toLowerCase());
      if (!market) return fail(res, 404, `no ${c.id} market on that exchange; available: ${c.markets.map((m) => m.exchangeId).join(', ')}`);
    } else {
      // default: the market currently setting the price
      const s = snapshot && snapshot.coins[c.id];
      market = (s && c.markets.find((m) => m.exchange === s.price_source)) || c.markets[0];
    }
    if (!market) return fail(res, 404, 'coin has no market');
    try {
      const d = await callRoute(market.klines, Object.assign({}, market.query, { tf: range }));
      if (!d || !d.ok) return fail(res, 404, d && d.error ? String(d.error) : 'no candles for this market yet');
      const candles = (d.candles || []).map((k) => ({ time: k.t, open: k.o, high: k.h, low: k.l, close: k.c, volume: k.v }));
      send(res, candles.length ? candles : (d.closes || []).map((close) => ({ close })), {
        coin: c.id, exchange: market.exchange, exchange_id: market.exchangeId, pair: market.pair, range,
        format: candles.length ? 'ohlcv (time = unix seconds, volume in base asset)' : 'closes only (this exchange publishes no candles)',
      });
    } catch (e) { fail(res, 502, 'candles temporarily unavailable'); }
  });

  // ---- Synthetic pairs: a reference price for a pair no exchange trades directly, built from two
  // real markets (base USD price ÷ quote USD price), or base × exchange rate for a fiat quote.
  // Never a tradable market; only as reliable as the weaker leg.
  const SYN_FIATS = ['USD', 'BRL', 'EUR', 'GBP', 'JPY', 'CNY', 'RUB', 'INR', 'TRY', 'ARS', 'MXN', 'CAD', 'AUD', 'CHF', 'KRW', 'IDR', 'VND', 'PLN', 'UAH', 'NGN',
    // the local currency of every language of the site is available as a quote
    'BGN', 'CZK', 'DKK', 'HUF', 'ILS', 'NOK', 'RON', 'SEK', 'THB', 'TWD'];
  const SYN_EXAMPLES = [['xln', 'btcb'], ['xln', 'pivx'], ['xln', 'BRL'], ['pivx', 'btcb']];
  let fxRates = { at: 0, rates: null };
  async function getFx() {
    if (fxRates.rates && Date.now() - fxRates.at < 10 * 60 * 1000) return fxRates.rates;
    const d = await callRoute('/api/fx', {});
    if (d && d.ok && d.rates) fxRates = { at: Date.now(), rates: d.rates };
    return fxRates.rates;
  }
  // coins traded on the partner exchanges that have no page of their own (exchange-coins.js): same
  // snapshot as the site's tabs, keyed by id
  async function exchangeCoins() {
    const get = app.locals.getExchangeCoins;
    if (!get) return {};
    try {
      const d = await get();
      const map = {};
      ((d && d.coins) || []).forEach((c) => { map[c.id] = c; });
      return map;
    } catch (e) { return {}; }
  }
  // a leg: a listed coin (by id), a coin of a partner exchange (by id) or a fiat currency (by code)
  function synLeg(raw, ex) {
    const v = String(raw || '').trim();
    if (BY_ID[v.toLowerCase()]) return { kind: 'coin', id: v.toLowerCase() };
    if (ex && ex[v.toLowerCase()]) return { kind: 'coin', id: v.toLowerCase(), ex: ex[v.toLowerCase()] };
    if (SYN_FIATS.includes(v.toUpperCase())) return { kind: 'fiat', code: v.toUpperCase() };
    return null;
  }
  async function synQuote(base, quote) {
    const s = await getSnapshot();
    const fx = (base.kind === 'fiat' || quote.kind === 'fiat') ? await getFx() : null;
    const legInfo = async (l) => {
      if (l.kind === 'fiat') {
        const rate = l.code === 'USD' ? 1 : (fx && fx[l.code]);
        return { kind: 'fiat', code: l.code, symbol: l.code, usd_per_unit: rate ? 1 / rate : null, change_24h_pct: 0, source: l.code === 'USD' ? null : 'open.er-api.com', volume_24h_usd: null };
      }
      if (l.ex) {
        const e = l.ex;
        return {
          kind: 'coin', id: l.id, symbol: e.symbol, name: e.name,
          usd_per_unit: e.price_usd > 0 ? e.price_usd : null, change_24h_pct: e.change_24h_pct != null ? e.change_24h_pct : null,
          source: e.price_source || null, volume_24h_usd: e.volume_24h_usd != null ? round(e.volume_24h_usd, 2) : null,
          markets_live: (e.markets || []).filter((m) => m.price_usd > 0).length,
        };
      }
      const c = s.coins[l.id];
      return {
        kind: 'coin', id: l.id, symbol: c ? c.symbol : l.id.toUpperCase(), name: c ? c.name : null,
        usd_per_unit: c && c.price_usd > 0 ? c.price_usd : null, change_24h_pct: c ? c.change_24h_pct : null,
        source: c ? c.price_source : null, volume_24h_usd: c ? c.volume_24h_usd : null, markets_live: c ? c.markets_live : 0,
      };
    };
    const [b, q] = [await legInfo(base), await legInfo(quote)];
    const price = b.usd_per_unit && q.usd_per_unit ? b.usd_per_unit / q.usd_per_unit : null;
    const change = b.change_24h_pct != null && q.change_24h_pct != null ? ((1 + b.change_24h_pct / 100) / (1 + q.change_24h_pct / 100) - 1) * 100 : null;
    const coinVols = [b, q].filter((l) => l.kind === 'coin').map((l) => l.volume_24h_usd || 0);
    return {
      pair: `${b.symbol}/${q.symbol}`,
      price: price != null ? Number(price.toPrecision(8)) : null,
      inverse_price: price ? Number((1 / price).toPrecision(8)) : null,
      change_24h_pct: change != null ? round(change, 4) : null,
      weakest_leg_volume_24h_usd: coinVols.length ? round(Math.min(...coinVols), 2) : null,
      legs: { base: b, quote: q },
      formula: q.kind === 'fiat' ? `${b.symbol}/USD × USD/${q.symbol}` : `(${b.symbol}/USD) ÷ (${q.symbol}/USD)`,
      tradable: false,
      updated_at: iso(s.at),
    };
  }
  // candles of one coin leg: the market that sets its price (same rule as /coins/:id/ohlcv)
  async function legCandles(id, range, ex) {
    if (ex) {
      // a USDT market of the coin (the one that sets its price first); other quotes have no candles in USD
      const usdt = (ex.markets || []).filter((m) => m.klines && m.params);
      const m = usdt.find((x) => x.exchange === ex.price_source) || usdt[0];
      const clean = (d) => (d && d.ok && d.candles ? d.candles : []).filter((k) => k.t > 0 && k.c > 0).sort((x, y) => x.t - y.t);
      if (m) {
        const direct = clean(await callRoute(m.klines, Object.assign(Object.fromEntries(new URLSearchParams(m.params)), { tf: range })));
        if (direct.length > 1) return direct;
      }
      // no USDT candles: the coin's most liquid market against another coin (COIN/Q) times Q/USDT on
      // the same exchange -- two real markets, like every synthetic price
      const alt = (ex.markets || []).find((x) => x.exchange_id && x.quote && x.quote !== 'USDT' && x.price_usd > 0);
      if (!alt) return [];
      const route = `/api/klines/${alt.exchange_id}`;
      const [pair, quoteUsd] = await Promise.all([
        callRoute(route, { symbol: `${ex.symbol}_${alt.quote}`, tf: range }).then(clean).catch(() => []),
        callRoute(route, { symbol: `${alt.quote}_USDT`, tf: range }).then(clean).catch(() => []),
      ]);
      return combine(pair, quoteUsd, true);
    }
    const c = BY_ID[id];
    const sc = snapshot && snapshot.coins[id];
    const market = (sc && c.markets.find((m) => m.exchange === sc.price_source)) || c.markets[0];
    if (!market) return [];
    const d = await callRoute(market.klines, Object.assign({}, market.query, { tf: range }));
    return (d && d.ok && d.candles ? d.candles : []).filter((k) => k.t > 0 && k.c > 0).sort((x, y) => x.t - y.t);
  }
  const spacing = (k) => {
    const gaps = [];
    for (let i = 1; i < k.length; i++) gaps.push(k[i].t - k[i - 1].t);
    gaps.sort((x, y) => x - y);
    return gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  };
  // groups candles into buckets of `size` seconds (open of the first, close of the last)
  function bucketize(k, size) {
    const m = new Map();
    k.forEach((x) => {
      const t = Math.floor(x.t / size) * size;
      const cur = m.get(t);
      if (!cur) m.set(t, { t, o: x.o, h: x.h, l: x.l, c: x.c });
      else { cur.h = Math.max(cur.h, x.h); cur.l = Math.min(cur.l, x.l); cur.c = x.c; }
    });
    return m;
  }
  // two candle series joined at the same times: a ÷ b (a pair) or a × b (a cross through another coin)
  function combine(a, b, multiply) {
    if (!a.length || !b.length) return [];
    const size = Math.max(spacing(a), spacing(b), 60);
    const A = bucketize(a, size);
    const B = bucketize(b, size);
    const times = [...new Set([...A.keys(), ...B.keys()])].sort((x, y) => x - y);
    const op = multiply ? (x, y) => x * y : (x, y) => x / y;
    let lastA = null;
    let lastB = null;
    const out = [];
    times.forEach((t) => {
      // a side with no trade in this bucket keeps its last close (flat candle)
      const ca = A.get(t) || (lastA && { t, o: lastA.c, h: lastA.c, l: lastA.c, c: lastA.c });
      const cb = B.get(t) || (lastB && { t, o: lastB.c, h: lastB.c, l: lastB.c, c: lastB.c });
      if (A.get(t)) lastA = A.get(t);
      if (B.get(t)) lastB = B.get(t);
      if (!ca || !cb) return;
      const o = op(ca.o, cb.o);
      const c = op(ca.c, cb.c);
      out.push({ t, o, c, h: Math.max(o, c, op(ca.h, cb.c)), l: Math.min(o, c, op(ca.l, cb.c)) });
    });
    return out;
  }
  async function synCandles(base, quote, range) {
    const fx = (base.kind === 'fiat' || quote.kind === 'fiat') ? await getFx() : null;
    const usdPer = (l) => (l.code === 'USD' ? 1 : fx && fx[l.code] ? 1 / fx[l.code] : null);
    const [a, b] = await Promise.all([base, quote].map((l) => (l.kind === 'coin' ? legCandles(l.id, range, l.ex) : Promise.resolve(null))));
    if (a === null && b === null) return [];
    // one side is a fiat currency: scale the other side's candles by the exchange rate
    if (a === null || b === null) {
      const k = a || b;
      const f = a === null ? usdPer(base) : usdPer(quote);
      if (!f) return [];
      return a === null ? k.map((x) => ({ t: x.t, o: f / x.o, h: f / x.l, l: f / x.h, c: f / x.c })) : k.map((x) => ({ t: x.t, o: x.o / f, h: x.h / f, l: x.l / f, c: x.c / f }));
    }
    return combine(a, b, false);
  }
  async function synLegs(req, res) {
    const ex = await exchangeCoins();
    const base = synLeg(req.query.base, ex);
    const quote = synLeg(req.query.quote, ex);
    if (!base || !quote) { fail(res, 400, 'base and quote must be a coin id (see /api/v1/synthetic/assets) or one of ' + SYN_FIATS.join(', ')); return null; }
    if ((base.id || base.code) === (quote.id || quote.code)) { fail(res, 400, 'base and quote must be different'); return null; }
    if (base.kind === 'fiat' && quote.kind === 'fiat') { fail(res, 400, 'at least one side must be a coin or token'); return null; }
    return { base, quote };
  }
  app.get('/api/v1/synthetic', async (req, res) => {
    const legs = await synLegs(req, res); if (!legs) return;
    try {
      send(res, await synQuote(legs.base, legs.quote), { note: 'reference price computed from two real markets; not a tradable market' });
    } catch (e) { fail(res, 502, 'data temporarily unavailable'); }
  });
  app.get('/api/v1/synthetic/ohlcv', async (req, res) => {
    const legs = await synLegs(req, res); if (!legs) return;
    const range = String(req.query.range || '7D').toUpperCase();
    if (!RANGES.includes(range)) return fail(res, 400, 'range must be one of ' + RANGES.join(', '));
    try {
      await getSnapshot();
      const k = await synCandles(legs.base, legs.quote, range);
      const p = (v) => Number(v.toPrecision(8));
      send(res, k.map((x) => ({ time: x.t, open: p(x.o), high: p(x.h), low: p(x.l), close: p(x.c) })), { range, format: 'ohlc (time = unix seconds); each side\'s candles divided at the same time' });
    } catch (e) { fail(res, 502, 'candles temporarily unavailable'); }
  });
  app.get('/api/v1/synthetic/assets', async (req, res) => {
    const ex = await exchangeCoins();
    send(res, {
      coins: REGISTRY.map((c) => ({ id: c.id, symbol: c.symbol, name: c.name }))
        .concat(Object.values(ex).filter((c) => !BY_ID[c.id]).map((c) => ({ id: c.id, symbol: c.symbol, name: c.name, traded_on: [...new Set((c.markets || []).map((m) => m.exchange))] }))),
      fiats: SYN_FIATS,
      examples: SYN_EXAMPLES.map(([b, q]) => ({ base: b, quote: q })),
    });
  });

  app.get('/api/v1/coins/:id/network', async (req, res) => {
    const c = coinOr404(req, res); if (!c) return;
    if (!c.network_api) return fail(res, 404, 'no network statistics for this coin');
    try {
      const { ok, ...data } = await callRoute(c.network_api, {});
      send(res, data, { coin: c.id, updated_at: iso(Date.now()) });
    } catch (e) { fail(res, 502, 'network data temporarily unavailable'); }
  });

  app.get('/api/v1/coins/:id/audit', async (req, res) => {
    const c = coinOr404(req, res); if (!c) return;
    if (!AUDITED.has(c.id)) return fail(res, 404, 'no audit for this coin; audited: ' + Array.from(AUDITED).join(', '));
    try {
      const d = await callRoute(`/api/network/${c.id}-audit`, {});
      if (!d || !d.ok) return fail(res, 503, 'audit not sampled yet, try again shortly');
      const withHistory = String(req.query.history || 'true') !== 'false';
      send(res, { reading: d.reading, history: withHistory ? d.history : undefined }, {
        coin: c.id, updated_at: d.reading && d.reading.ts, sampling: 'every 20 minutes',
        method: SITE + '/?view=auditoria&audit=' + c.id,
      });
    } catch (e) { fail(res, 502, 'audit temporarily unavailable'); }
  });

  app.get('/api/v1/coins/:id/rewards', async (req, res) => {
    const c = coinOr404(req, res); if (!c) return;
    if (!REWARDED.has(c.id)) return fail(res, 404, 'no rewards data for this coin; available: ' + Array.from(REWARDED).join(', '));
    try {
      const { ok, ...data } = await callRoute(`/api/network/${c.id}-rewards`, {});
      if (!ok) return fail(res, 503, 'rewards not computed yet, try again shortly');
      send(res, data, { coin: c.id, refresh: 'every 24 hours' });
    } catch (e) { fail(res, 502, 'rewards temporarily unavailable'); }
  });

  function trackedMarkets(s, exchangeId) {
    const out = [];
    REGISTRY.forEach((c) => {
      (s.coins[c.id] ? s.coins[c.id].markets : []).forEach((m) => {
        if (m.exchange_id === exchangeId) out.push(Object.assign({ coin_id: c.id, symbol: c.symbol }, m));
      });
    });
    return out;
  }

  async function exchangeSummary(id, s) {
    const e = EXCHANGES[id];
    const base = { id, name: e.name, type: e.type, url: e.url, partner: !!e.partner, official_lunarium: !!e.official_lunarium, page: e.partner ? SITE + '/?view=exchanges&exchange=' + id : null };
    const tracked = trackedMarkets(s, id);
    if (e.partner) {
      try {
        const d = await callRoute('/api/exchange/:id'.replace(':id', id), {});
        return Object.assign(base, {
          scope: 'all markets on the exchange',
          volume_24h_usd: round(d.totalVolumeUsdt, 2),
          pairs_total: d.pairsTotal,
          pairs_active_24h: d.pairsActive,
          trades_24h: d.trades24h,
          avg_spread_pct: round(d.avgSpreadPct, 4),
          depth_plus_2pct_usd: round(d.depthPlus2Usdt, 2),
          depth_minus_2pct_usd: round(d.depthMinus2Usdt, 2),
          quote_markets: d.quoteMarkets,
          updated_at: d.updatedAt ? iso(d.updatedAt) : null,
          _markets: d.markets,
        });
      } catch (err) { /* fall back to tracked markets below */ }
    }
    return Object.assign(base, {
      scope: 'markets tracked by GaláxiaLunarium',
      volume_24h_usd: round(tracked.filter((m) => m.status === 'live' && !m.reference_only).reduce((sum, m) => sum + (m.volume_24h_usd || 0), 0), 2),
      pairs_total: tracked.length,
      pairs_active_24h: tracked.filter((m) => m.status === 'live' && m.volume_24h_usd > 0).length,
      updated_at: iso(s.at),
      _tracked: tracked,
    });
  }

  app.get('/api/v1/exchanges', async (req, res) => {
    try {
      const s = await getSnapshot();
      const list = await Promise.all(Object.keys(EXCHANGES).map((id) => exchangeSummary(id, s)));
      send(res, list.map(({ _markets, _tracked, ...rest }) => rest), { count: list.length });
    } catch (e) { fail(res, 502, 'data temporarily unavailable'); }
  });

  app.get('/api/v1/exchanges/:id', async (req, res) => {
    const id = String(req.params.id).toLowerCase();
    if (!EXCHANGES[id]) return fail(res, 404, 'unknown exchange id; see GET /api/v1/exchanges');
    try {
      const s = await getSnapshot();
      const { _markets, _tracked, ...ex } = await exchangeSummary(id, s);
      const markets = _markets
        ? _markets.map((m) => ({
          pair: m.base + '/' + m.quote, base: m.base, quote: m.quote,
          price: m.price, price_usd: round(m.priceUsdt, 10), high_24h: m.high, low_24h: m.low,
          bid: m.bid, ask: m.ask, spread_pct: round(m.spreadPct, 4), change_24h_pct: round(m.change, 4),
          volume_24h_quote: m.volume, volume_24h_usd: round(m.volumeUsdt, 2), volume_share_pct: round(m.volumePct, 4),
          depth_plus_2pct_usd: round(m.depthPlus2, 2), depth_minus_2pct_usd: round(m.depthMinus2, 2),
          trades_24h: m.trades, last_trade_at: m.updatedAt ? iso(m.updatedAt) : null,
        }))
        : _tracked;
      send(res, Object.assign(ex, { markets }), { updated_at: ex.updated_at });
    } catch (e) { fail(res, 502, 'exchange data temporarily unavailable'); }
  });

  app.get('/api/v1/fx', async (req, res) => {
    try {
      const { ok, ...data } = await callRoute('/api/fx', {});
      send(res, data, { base: 'USD' });
    } catch (e) { fail(res, 502, 'fx rates temporarily unavailable'); }
  });

  // Plans with the live payment amounts: the USD price is fixed; the XLN amount is that USD at the
  // current XLN market price, rounded up to a whole coin (payment is always in XLN).
  app.get('/api/v1/plans', async (req, res) => {
    const cfg = plans.loadConfig();
    let s = null;
    try { s = await getSnapshot(); } catch (e) { /* amounts fall back to the anchor */ }
    const xln = s && s.coins.xln ? s.coins.xln.price_usd : null;
    const xlnft = s && s.coins.xlnft ? s.coins.xlnft.price_usd : null;
    const list = Object.keys(cfg.plans).map((id) => {
      const p = cfg.plans[id];
      const usdExact = plans.productUsd(p, cfg);
      return {
        id,
        name: p.name,
        requires_key: !!p.requires_key,
        per_minute: p.per_minute,
        per_month: p.per_month,
        // 'monthly' or 'one_time' (paid once, the key does not expire); null for the free plan
        billing: p.requires_key ? (p.lifetime ? 'one_time' : 'monthly') : null,
        lifetime: !!p.lifetime,
        includes_coin_audit: !!p.includes_audit,
        price_usd: plans.planPriceUsd(p, cfg),
        price_xln: plans.xlnForUsd(usdExact, xln, cfg),
        // monthly plans only (kept for older clients)
        price_usd_month: p.lifetime ? null : plans.planPriceUsd(p, cfg),
        price_xln_month: p.lifetime ? null : plans.xlnForUsd(usdExact, xln, cfg),
      };
    });
    const listings = Object.values(plans.products(cfg)).filter((p) => p.kind === 'listing').map((p) => {
      const usdExact = plans.productUsd(p, cfg);
      return {
        id: p.id,
        type: p.listing_type,
        tier: p.tier,
        name: p.name,
        free: !!p.free,
        available: !!p.free || usdExact > 0,
        price_usd: p.free ? 0 : (usdExact > 0 ? plans.planPriceUsd(p, cfg) : null),
        price_xln: p.free ? 0 : (usdExact > 0 ? plans.xlnForUsd(usdExact, xln, cfg) : null),
        review_deadline: p.sla || null,
        refundable: false,
      };
    });
    res.json({
      ok: true,
      data: {
        plans: list,
        listings,
        listing_rules: (cfg.standard_listing ? 'Standard listing is free and follows the review queue, with no guaranteed deadline. ' : '') +
          'Priority listing is paid and guarantees the review deadline, not approval. The priority coin listing includes the audit of the coin (supply, emission and rewards checked on the blockchain against the official source code) when it has public source code and a working block explorer. An exchange listed on GaláxiaLunarium gets every coin it trades listed for free' +
          (cfg.refund_if_rejected ? '; a rejected request is refunded in XLN to the wallet given at registration.' : '. Payments are non-refundable.'),
        pricing: 'Every price is a fixed USD amount paid only in XLN at the market price when the order is created: when XLN rises, fewer XLN are charged. ' +
          'A plan with billing "one_time" is paid once and its key does not expire; the others are paid per month. ' +
          'A plan with includes_coin_audit gives each key one priority coin listing and audit at no extra cost (order listing_coin with "plan_key").',
        anchor: cfg.anchor,
        xln_price_usd: xln,
        payment_currencies: ['XLN'],
        xlnft_payment: xlnft > 0 ? 'coming soon' : 'available once XLNFT has a market price',
        checkout: {
          enabled: !!cfg.payment.xln_address,
          method: 'POST /api/v1/orders {"product":"<plan id or listing_coin|listing_exchange>","customer":{...},"accept_terms":true} then GET /api/v1/orders/{id} with X-Order-Token',
          pay_to: cfg.payment.xln_address || null,
          confirmations: cfg.payment.confirmations,
          order_ttl_minutes: cfg.payment.order_ttl_minutes,
        },
      },
      meta: { api_version: API_VERSION, updated_at: s ? iso(s.at) : null },
    });
  });

  app.get('/api/v1/account', (req, res) => {
    const rec = req.apiKey;
    if (!rec) return fail(res, 401, 'send your API key in the X-API-Key header');
    const cfg = plans.loadConfig();
    const plan = cfg.plans[rec.plan] || cfg.plans.free;
    const used = plans.getUsage(rec.id);
    res.set('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      data: {
        plan: rec.plan,
        plan_name: plan.name,
        owner: rec.owner,
        key_prefix: rec.prefix,
        created_at: rec.created_at,
        expires_at: rec.expires_at || null,
        lifetime: plans.isLifetimeKey(rec, cfg),
        coin_audit: plans.coinAudit(rec, cfg),
        per_minute: plan.per_minute,
        per_month: plan.per_month,
        period: plans.period(),
        used_this_month: used,
        remaining_this_month: plan.per_month ? Math.max(0, plan.per_month - used) : null,
      },
      meta: { api_version: API_VERSION },
    });
  });

  require('./api-orders')(app, {
    fetchJson,
    fail,
    getPrices: async () => {
      try {
        const s = await getSnapshot();
        return { xln: s.coins.xln ? s.coins.xln.price_usd : null, xlnft: s.coins.xlnft ? s.coins.xlnft.price_usd : null };
      } catch (e) { return { xln: null, xlnft: null }; }
    },
  });

  app.get('/api/v1/openapi.json', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(openApiSpec(REGISTRY.map((c) => c.id), Object.keys(EXCHANGES)));
  });

  app.use('/api/v1', (req, res) => fail(res, 404, 'unknown endpoint; see GET /api/v1'));
};

function openApiSpec(coinIds, exchangeIds) {
  const envelope = (dataSchema) => ({
    type: 'object',
    properties: { ok: { type: 'boolean' }, data: dataSchema, meta: { type: 'object' } },
  });
  const ok = (description, dataSchema) => ({ 200: { description, content: { 'application/json': { schema: envelope(dataSchema || { type: 'object' }) } } } });
  const coinParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', enum: coinIds } };
  const market = {
    type: 'object',
    properties: {
      exchange: { type: 'string' }, exchange_id: { type: 'string' }, type: { type: 'string', enum: ['CEX', 'DEX'] }, pair: { type: 'string' },
      url: { type: 'string' }, status: { type: 'string', enum: ['live', 'paused', 'inactive', 'unavailable'], description: 'inactive: no trade in 24h (see last_trade_*)' }, reference_only: { type: 'boolean' },
      last_trade_price_usd: { type: 'number', description: 'inactive markets only' }, last_trade_at: { type: 'string', format: 'date-time', description: 'inactive markets only' },
      price_usd: { type: 'number', nullable: true }, bid: { type: 'number', nullable: true }, ask: { type: 'number', nullable: true },
      spread_pct: { type: 'number', nullable: true }, change_24h_pct: { type: 'number', nullable: true }, volume_24h_usd: { type: 'number', nullable: true },
      liquidity_usd: { type: 'number', nullable: true, description: 'DEX pools only' }, updated_at: { type: 'string', format: 'date-time', nullable: true },
    },
  };
  const coin = {
    type: 'object',
    properties: {
      id: { type: 'string' }, symbol: { type: 'string' }, name: { type: 'string' }, category: { type: 'string', enum: ['masternode', 'pow', 'stake', 'token'] },
      official_lunarium: { type: 'boolean' }, network: { type: 'string' }, contract: { type: 'string', nullable: true }, logo: { type: 'string' }, page: { type: 'string' },
      price_usd: { type: 'number', nullable: true }, price_source: { type: 'string', nullable: true }, change_24h_pct: { type: 'number', nullable: true },
      volume_24h_usd: { type: 'number' }, supply: { type: 'number', nullable: true }, market_cap_usd: { type: 'number', nullable: true },
      markets_total: { type: 'integer' }, markets_live: { type: 'integer' }, has_network_stats: { type: 'boolean' }, has_audit: { type: 'boolean' },
    },
  };
  return {
    openapi: '3.0.3',
    info: {
      title: 'GaláxiaLunarium Public API', version: API_VERSION,
      description: 'Read-only market, network and audit data for every coin and exchange tracked by GaláxiaLunarium. ' +
        `Free without a key (${plans.loadConfig().plans.free.per_minute} requests per minute per IP); paid plans use an API key in the X-API-Key header ` +
        'for higher per-minute limits and a monthly quota (see /plans). Market data refreshes at most every 60 seconds. ' +
        'Binance markets are 1:1 peg reference prices for BNB Chain tokens and are excluded from volume totals.',
    },
    servers: [{ url: SITE + '/api/v1' }],
    components: { securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } } },
    security: [{}, { apiKey: [] }],
    paths: {
      '/plans': { get: { summary: 'API plans with limits and current price in USD, XLN (and XLNFT once it has a market)', responses: ok('Plans') } },
      '/orders': { post: { summary: 'Create an order (API plan or listing request) paid in XLN: unique amount, confirmed automatically on chain, ticket issued on payment', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['product', 'customer', 'accept_terms'], properties: {
        product: { type: 'string', enum: Object.keys(plans.products(plans.loadConfig())) },
        customer: { type: 'object', required: ['name', 'email'], properties: { name: { type: 'string' }, email: { type: 'string' }, company: { type: 'string' }, contact: { type: 'string' }, country: { type: 'string' }, wallet: { type: 'string', description: 'XLN address (required for listings: refund if rejected)' } } },
        listing: { type: 'object', description: 'coin: name, symbol, website, explorer, source_code, network, contract, markets, logo, description; exchange: name, website, api_docs, pairs, markets, logo, description' },
        renew_key: { type: 'string', description: 'API plans: existing key to extend by one month' },
        accept_terms: { type: 'boolean' },
      } } } } }, responses: ok('Order with amount_xln, pay_to and a one-time token') } },
      '/orders/{id}': { get: { summary: 'Order status; once paid and confirmed, includes the new api_key', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'X-Order-Token', in: 'header', required: true, schema: { type: 'string' } }], responses: ok('Order') } },
      '/account': { get: { summary: 'Plan, expiry and this month\'s usage of the API key sent in X-API-Key', security: [{ apiKey: [] }], responses: ok('Account') } },
      '/coins': { get: { summary: 'All coins with price, 24h change, volume, supply and market cap', parameters: [{ name: 'category', in: 'query', schema: { type: 'string', enum: ['masternode', 'pow', 'stake', 'token'] } }], responses: ok('Coin list', { type: 'array', items: coin }) } },
      '/coins/{id}': { get: { summary: 'One coin, including links and every tracked market', parameters: [coinParam], responses: ok('Coin', coin) } },
      '/coins/{id}/markets': { get: { summary: 'Tracked markets of a coin (price, bid/ask, spread, change, volume, status)', parameters: [coinParam], responses: ok('Markets', { type: 'array', items: market }) } },
      '/coins/{id}/ohlcv': { get: { summary: 'Candles for a coin market', parameters: [coinParam, { name: 'range', in: 'query', schema: { type: 'string', enum: RANGES, default: '7D' } }, { name: 'exchange', in: 'query', schema: { type: 'string', enum: exchangeIds }, description: 'Defaults to the market currently setting the price' }], responses: ok('Candles', { type: 'array', items: { type: 'object', properties: { time: { type: 'integer' }, open: { type: 'number' }, high: { type: 'number' }, low: { type: 'number' }, close: { type: 'number' }, volume: { type: 'number' } } } }) } },
      '/coins/{id}/network': { get: { summary: 'Blockchain statistics (height, difficulty, supply, masternodes, ...) where available', parameters: [coinParam], responses: ok('Network stats') } },
      '/coins/{id}/audit': { get: { summary: 'Supply vs emission-cap audit, sampled every 20 minutes (xln, pivx, mon, btc, sol)', parameters: [coinParam, { name: 'history', in: 'query', schema: { type: 'boolean', default: true } }], responses: ok('Audit reading and history') } },
      '/coins/{id}/rewards': { get: { summary: 'Masternode and staking rewards generated in the last 24h and 30 days (xln, pivx, mon)', parameters: [coinParam], responses: ok('Rewards') } },
      '/exchanges': { get: { summary: 'Exchanges with 24h volume, pairs, spread and depth', responses: ok('Exchange list', { type: 'array', items: { type: 'object' } }) } },
      '/exchanges/{id}': { get: { summary: 'One exchange with all its markets (partner exchanges) or the markets tracked on it', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', enum: exchangeIds } }], responses: ok('Exchange') } },
      '/fx': { get: { summary: 'Fiat exchange rates against USD used by the site converter', responses: ok('Rates') } },
      '/synthetic': { get: { summary: 'Synthetic pair: reference price of a pair no exchange trades directly, from two real markets (not tradable)', parameters: [{ name: 'base', in: 'query', required: true, schema: { type: 'string' }, description: 'Coin id (see /coins) or fiat code (USD, BRL, EUR...)' }, { name: 'quote', in: 'query', required: true, schema: { type: 'string' }, description: 'Coin id or fiat code' }], responses: ok('Price, inverse price, 24h change, both legs with source and volume') } },
      '/synthetic/ohlcv': { get: { summary: 'Candles of a synthetic pair (both sides divided candle by candle at the same time)', parameters: [{ name: 'base', in: 'query', required: true, schema: { type: 'string' } }, { name: 'quote', in: 'query', required: true, schema: { type: 'string' } }, { name: 'range', in: 'query', schema: { type: 'string', enum: RANGES, default: '7D' } }], responses: ok('Candles') } },
      '/synthetic/assets': { get: { summary: 'Assets usable in synthetic pairs, and example pairs', responses: ok('Coins, fiat currencies and examples') } },
    },
  };
}
