// Visitor counter, the same model as the Lunarium explorer's (explorerxln.com, server/visits.mjs; owner,
// 2026-11-25: "replace this visitor counter ... with the same visitor counter model the explorer has").
// No cookies and no stored IPs: only the COUNTRY is derived from the IP (country.is, ipwho.is),
// with an in-memory cache keyed by a salted hash that changes on every restart.
//
// The browser counts a visitor only after a real tap/click/key press or 10 s with the page visible, and
// only once per browser (localStorage) -- see public/galaxialunarium-visitors.js.
//
// The hosting can run two processes of the site at once, so everything that must add up (totals, days,
// countries, who is online now, the live feed) lives in one file, data/visits.json, changed under a lock
// file (read-modify-write, synchronous, a few milliseconds).
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const FILE = path.join(DATA, 'visits.json');
const LOCK = path.join(DATA, 'visits.lock');
const ONLINE_WINDOW = 90; // seconds without a signal before leaving "online now"
const KEEP_DAYS = 400;
const BOT_UA = /bot|crawl|spider|slurp|curl|wget|python|httpclient|okhttp|java\/|go-http|axios|node-fetch|headless|lighthouse|monitor|uptime|preview|facebookexternalhit|whatsapp|telegrambot/i;

const salt = crypto.randomBytes(16).toString('hex'); // the hashes below identify no one
const hash = (s, n) => crypto.createHash('sha256').update(salt + s).digest('hex').slice(0, n);
const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const empty = () => ({ total: 0, views: 0, days: {}, countries: {}, online: {}, events: [] });

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Object.assign(empty(), s);
  } catch (e) { return empty(); }
}
// runs fn(state) with the file locked; fn returns true when it changed the state
function withState(fn) {
  let fd = null;
  for (let i = 0; i < 200 && fd === null; i++) {
    try { fd = fs.openSync(LOCK, 'wx'); } catch (e) {
      if (e.code !== 'EEXIST') break;
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 10000) fs.unlinkSync(LOCK); } catch (e2) { /* gone */ }
      const until = Date.now() + 5;
      while (Date.now() < until) { /* the other process holds it for a few ms */ }
    }
  }
  try {
    const s = readState();
    if (fn(s)) {
      fs.mkdirSync(DATA, { recursive: true });
      const tmp = FILE + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(s));
      fs.renameSync(tmp, FILE);
    }
    return s;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); fs.unlinkSync(LOCK); } catch (e) { /* already gone */ } }
  }
}

const geoCache = new Map(); // hash(ip) -> { cc, at }
async function countryOf(ip) {
  if (!ip || /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd|fe80|unknown)/i.test(ip)) return null;
  const key = hash(ip, 20);
  const c = geoCache.get(key);
  if (c && Date.now() - c.at < 7 * 86400000) return c.cc;
  let cc = null;
  try {
    const r = await fetch(`https://api.country.is/${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(2500) });
    const j = await r.json();
    if (/^[A-Z]{2}$/.test((j && j.country) || '')) cc = j.country;
  } catch (e) { /* try the next source */ }
  if (!cc) {
    try {
      const r = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country_code`, { signal: AbortSignal.timeout(2500) });
      const j = await r.json();
      if (j && j.success && /^[A-Z]{2}$/.test(j.country_code || '')) cc = j.country_code;
    } catch (e) { /* no country */ }
  }
  if (cc) {
    geoCache.set(key, { cc, at: Date.now() });
    if (geoCache.size > 20000) geoCache.clear();
  }
  return cc;
}

function sweep(s, now) {
  let changed = false;
  for (const sid of Object.keys(s.online)) if (now - s.online[sid][0] > ONLINE_WINDOW) { delete s.online[sid]; changed = true; }
  return changed;
}

function snapshot(s) {
  const now = Math.floor(Date.now() / 1000);
  const series = [];
  for (let i = 6; i >= 0; i--) series.push((s.days[dayKey(Date.now() - i * 86400000)] || {}).u || 0);
  const occ = {};
  let online = 0;
  Object.values(s.online).forEach(([t, cc]) => {
    if (now - t > ONLINE_WINDOW) return;
    online++;
    if (cc) occ[cc] = (occ[cc] || 0) + 1;
  });
  const countries = Object.entries(s.countries).map(([cc, x]) => ({ cc, u: x.u || 0, v: x.v || 0 }))
    .sort((a, b) => b.u - a.u || b.v - a.v);
  return {
    ok: true,
    total: s.total,
    views: s.views,
    today: (s.days[dayKey()] || {}).u || 0,
    online,
    series,
    countries: countries.slice(0, 30),
    ncountries: countries.length,
    live: s.events.slice(-10).reverse().map(([cc, ts]) => ({ cc, ts, age: now - ts })),
    occ,
  };
}

module.exports = function mountVisits(app) {
  const perIp = new Map(); // per-origin record limit (memory only, by hash)
  const perNet = new Map(); // new-visitor limit per network range (memory only, by hash)
  let cache = { at: 0, snap: null };
  const read = () => {
    if (Date.now() - cache.at < 2000 && cache.snap) return cache.snap;
    cache = { at: Date.now(), snap: snapshot(readState()) };
    return cache.snap;
  };

  // a = "hit" (a visit, after the browser's checks), "view" (screen change), "beat" (still here), "read"
  async function handle({ a, sid, isNew, ip, ua }) {
    sid = String(sid || '').replace(/[^a-z0-9]/gi, '').slice(0, 32);
    if (BOT_UA.test(ua || '') || !ua || !sid || !['hit', 'view', 'beat'].includes(a)) return read();

    // at most 40 records per minute per origin
    const now = Date.now();
    const k = hash(ip, 16);
    let lim = perIp.get(k);
    if (!lim || now - lim.start > 60000) { lim = { start: now, n: 0 }; perIp.set(k, lim); }
    if (++lim.n > 40) return read();
    if (perIp.size > 50000) perIp.clear();

    // at most 30 NEW visitors per hour from one network range (IPv4 /16, IPv6 /48): bots rotating IPs stop here
    if (a === 'hit' && isNew) {
      const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip || '');
      const net = v4 ? `${v4[1]}.${v4[2]}` : String(ip || '').split(':').slice(0, 3).join(':');
      const nk = hash('net' + net, 16);
      let nl = perNet.get(nk);
      if (!nl || now - nl.start > 3600000) { nl = { start: now, n: 0 }; perNet.set(nk, nl); }
      if (++nl.n > 30) return read();
      if (perNet.size > 50000) perNet.clear();
    }

    const cc = a === 'hit' ? await countryOf(ip) : null;
    const t = Math.floor(now / 1000);
    const s = withState((st) => {
      sweep(st, t);
      const cur = st.online[sid];
      if (a === 'hit' || a === 'view') {
        const c = a === 'hit' ? cc : (cur && cur[1]) || null;
        const u = a === 'hit' && isNew ? 1 : 0;
        st.views += 1;
        st.total += u;
        const d = st.days[dayKey(now)] || (st.days[dayKey(now)] = { u: 0, v: 0 });
        d.u += u; d.v += 1;
        if (c) {
          const x = st.countries[c] || (st.countries[c] = { u: 0, v: 0 });
          x.u += u; x.v += 1;
          if (a === 'hit') { st.events.push([c, t]); if (st.events.length > 40) st.events = st.events.slice(-40); }
        }
        st.online[sid] = [t, c || (cur && cur[1]) || null];
      } else {
        st.online[sid] = [t, (cur && cur[1]) || null];
      }
      const oldest = dayKey(now - KEEP_DAYS * 86400000);
      Object.keys(st.days).forEach((dk) => { if (dk < oldest) delete st.days[dk]; });
      const ids = Object.keys(st.online);
      if (ids.length > 20000) ids.slice(0, ids.length - 20000).forEach((id) => delete st.online[id]);
      return true;
    });
    cache = { at: Date.now(), snap: snapshot(s) };
    return cache.snap;
  }

  const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  app.post('/api/visits', express.json({ limit: '1kb' }), async (req, res) => {
    const b = req.body || {};
    res.set('Cache-Control', 'no-store');
    try {
      res.json(await handle({ a: String(b.a || 'read'), sid: b.sid, isNew: String(b.new) === '1', ip: clientIp(req), ua: req.get('user-agent') }));
    } catch (e) {
      console.error('visits failed', e && e.message);
      res.status(500).json({ ok: false });
    }
  });
  app.get('/api/visits', (req, res) => { res.set('Cache-Control', 'no-store'); res.json(read()); });
  // the old counter's routes (cached pages may still call them): they read the new total and add nothing
  const legacy = (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ ok: true, count: read().total }); };
  app.get('/api/visitors', legacy);
  app.get('/api/visitors/increment', legacy);

  return { read };
};
