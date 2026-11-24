// Spot tickers and candles of the large exchanges used by the pages of the major coins (Bitcoin,
// Solana): OKX, Bybit and Coinbase. Binance already has its routes in server.js. Each route answers in the site's common shape: ticker = { ok, price, bid,
// ask, change (24h, %), volume (24h, in the quote currency) }; candles through sendCloses.
// Everything comes from the exchange's own public API, with no key.
module.exports = function mountMajorExchanges(app, { fetchJson, tfPreset, sendCloses, sendError, num, safeNum, pctChange }) {
  // pair as the exchange writes it; nothing but letters, digits, "-" and "_" goes into the address
  const sym = (v, fallback) => String(v || fallback).toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
  const tfKey = (tf) => (['1H', '24H', '7D', '30D', '1Y'].includes(tf) ? tf : '7D');
  const pct = (ratio) => (num(ratio) != null ? num(ratio) * 100 : null);
  const candle = (t, o, h, l, c, v) => ({ t: Number(t), o: parseFloat(o), h: parseFloat(h), l: parseFloat(l), c: parseFloat(c), v: safeNum(v) });
  const send = (res, candles) => {
    candles.sort((a, b) => a.t - b.t);
    sendCloses(res, candles.map((c) => c.c), candles);
  };

  // ---- OKX: candles newest first [ts, o, h, l, c, vol, ...], at most 300 per request
  const OKX_BAR = { '1H': '1m', '24H': '15m', '7D': '1H', '30D': '4H', '1Y': '1Dutc' };
  app.get('/api/ticker/okx', async (req, res) => {
    try {
      const d = await fetchJson(`https://www.okx.com/api/v5/market/ticker?instId=${sym(req.query.symbol, 'BTC-USDT')}`);
      const t = (d && d.data && d.data[0]) || {};
      res.json({ ok: true, price: num(t.last), bid: num(t.bidPx), ask: num(t.askPx), change: pctChange(t.open24h, t.last), volume: num(t.volCcy24h) });
    } catch (e) { sendError(res, e); }
  });
  app.get('/api/klines/okx', async (req, res) => {
    try {
      const tf = tfKey(req.query.tf);
      const want = tfPreset(tf).candleLimit;
      const base = `https://www.okx.com/api/v5/market/candles?instId=${sym(req.query.symbol, 'BTC-USDT')}&bar=${OKX_BAR[tf]}`;
      let rows = ((await fetchJson(`${base}&limit=${Math.min(want, 300)}`)).data) || [];
      if (want > 300 && rows.length === 300) {
        const more = ((await fetchJson(`${base}&limit=${want - 300}&after=${rows[rows.length - 1][0]}`)).data) || [];
        rows = rows.concat(more);
      }
      send(res, rows.map((c) => candle(c[0], c[1], c[2], c[3], c[4], c[5])));
    } catch (e) { sendError(res, e); }
  });

  // ---- Bybit: list newest first [start, open, high, low, close, volume, turnover]
  const BYBIT_INT = { '1H': '1', '24H': '15', '7D': '60', '30D': '240', '1Y': 'D' };
  app.get('/api/ticker/bybit', async (req, res) => {
    try {
      const d = await fetchJson(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${sym(req.query.symbol, 'BTCUSDT')}`);
      const t = (d && d.result && d.result.list && d.result.list[0]) || {};
      res.json({ ok: true, price: num(t.lastPrice), bid: num(t.bid1Price), ask: num(t.ask1Price), change: pct(t.price24hPcnt), volume: num(t.turnover24h) });
    } catch (e) { sendError(res, e); }
  });
  app.get('/api/klines/bybit', async (req, res) => {
    try {
      const tf = tfKey(req.query.tf);
      const d = await fetchJson(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym(req.query.symbol, 'BTCUSDT')}&interval=${BYBIT_INT[tf]}&limit=${tfPreset(tf).candleLimit}`);
      send(res, (((d && d.result && d.result.list) || [])).map((c) => candle(c[0], c[1], c[2], c[3], c[4], c[5])));
    } catch (e) { sendError(res, e); }
  });

  // ---- Coinbase (pairs in USD): candles newest first [time, low, high, open, close, volume], at
  // most 300 per request and no 4-hour size, so the 30D view uses 6-hour candles
  const CB_GRAN = { '1H': [60, 60], '24H': [900, 96], '7D': [3600, 168], '30D': [21600, 120], '1Y': [86400, 365] };
  app.get('/api/ticker/coinbase', async (req, res) => {
    try {
      const p = sym(req.query.symbol, 'BTC-USD');
      // The "open" of Coinbase's stats is the open of the hour that began 24h ago, so it can sit up
      // to an hour away from the other exchanges' rolling 24h. The open of the first 1-minute
      // candle inside the last 24 hours is the same measure as theirs; the stats' open is the fallback.
      const dayAgo = Math.floor(Date.now() / 1000) - 86400;
      const iso = (sec) => new Date(sec * 1000).toISOString();
      const [t, s, past] = await Promise.all([
        fetchJson(`https://api.exchange.coinbase.com/products/${p}/ticker`),
        fetchJson(`https://api.exchange.coinbase.com/products/${p}/stats`),
        fetchJson(`https://api.exchange.coinbase.com/products/${p}/candles?granularity=60&start=${iso(dayAgo - 60)}&end=${iso(dayAgo + 240)}`).catch(() => null),
      ]);
      const candles = Array.isArray(past) ? past.filter((c) => Array.isArray(c) && c[0] >= dayAgo).sort((a, b) => a[0] - b[0]) : [];
      const open24h = candles.length && num(candles[0][3]) > 0 ? num(candles[0][3]) : num(s.open);
      const last = num(t.price) != null ? num(t.price) : num(s.last);
      // Coinbase reports the 24h volume in the coin: valued at the last price
      const volume = num(s.volume) != null && last != null ? num(s.volume) * last : null;
      res.json({ ok: true, price: last, bid: num(t.bid), ask: num(t.ask), change: pctChange(open24h, last), volume });
    } catch (e) { sendError(res, e); }
  });
  app.get('/api/klines/coinbase', async (req, res) => {
    try {
      const [gran, want] = CB_GRAN[tfKey(req.query.tf)];
      const p = sym(req.query.symbol, 'BTC-USD');
      const rows = [];
      let end = Math.floor(Date.now() / 1000);
      for (let left = want; left > 0; left -= 300) {
        const n = Math.min(left, 300);
        const start = end - n * gran;
        const part = await fetchJson(`https://api.exchange.coinbase.com/products/${p}/candles?granularity=${gran}&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`);
        if (Array.isArray(part)) rows.push(...part);
        end = start;
      }
      send(res, rows.map((c) => candle(c[0], c[3], c[2], c[1], c[4], c[5])));
    } catch (e) { sendError(res, e); }
  });
};
