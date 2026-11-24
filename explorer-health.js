// Is each coin's block explorer answering? Shown live next to the explorer link on the coin page
// (together with the state of the coin's supply reading, coin-supply.js status()).
//
// The explorers tracked are the ones of the exchange coins (exchange-coins.js calls track()). Each
// is asked for its front page every 6 hours; one that failed is asked again 10 minutes later, and
// only two failures in a row make it "down" (then it is tried every hour until it is back). The
// request only tells whether the site answers: nothing of the answer is kept or shown. Only public
// internet hosts are contacted.
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');
const dns = require('dns').promises;

const FILE = path.join(__dirname, 'data', 'explorer-health.json');
const OK_EVERY_MS = 6 * 3600 * 1000;
const RECHECK_MS = 10 * 60 * 1000;
const DOWN_EVERY_MS = 3600 * 1000;
const LOOP_MS = 5 * 60 * 1000;
const PER_LOOP = 30;

let state = {};
try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { /* first run */ }
const tracked = new Set();

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('explorer health: could not save', e && e.message); }
}

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
}

// status code of the explorer's page (certificates are not checked: many small explorers run with a
// broken one, and nothing is read from the answer)
function statusOf(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { timeout: 12000, rejectUnauthorized: false, headers: { 'User-Agent': 'Mozilla/5.0 (GalaxiaLunarium explorer check)', Accept: 'text/html,*/*' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
      req.destroy();
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function answers(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
    if (!addresses.length || addresses.some(isPrivate)) return false;
    const code = await statusOf(url);
    // a page behind a browser check (403) is an explorer that is up; "not found" / "gone" is not
    return code >= 200 && code < 500 && code !== 404 && code !== 410;
  } catch (e) {
    return false;
  }
}

let running = false;
async function loop() {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    const due = [...tracked].filter((u) => {
      const s = state[u];
      if (!s) return true;
      return now - s.at >= (s.fails === 0 ? OK_EVERY_MS : s.fails === 1 ? RECHECK_MS : DOWN_EVERY_MS);
    }).slice(0, PER_LOOP);
    let next = 0;
    const worker = async () => {
      while (next < due.length) {
        const u = due[next++];
        const up = await answers(u);
        const prev = state[u] || {};
        state[u] = { at: Date.now(), fails: up ? 0 : (prev.fails || 0) + 1, up_at: up ? Date.now() : prev.up_at || null };
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (due.length) {
      Object.keys(state).forEach((u) => { if (!tracked.has(u)) delete state[u]; });
      save();
    }
  } finally { running = false; }
}

// the explorers to follow (replaces the previous list)
function track(urls) {
  const fresh = (urls || []).filter((u) => /^https?:\/\//i.test(String(u || '')));
  const isNew = fresh.some((u) => !tracked.has(u));
  tracked.clear();
  fresh.forEach((u) => tracked.add(u));
  if (isNew) setTimeout(() => { loop().catch(() => {}); }, 5000).unref();
}

// { state: 'up' | 'down' | null, at } -- null while there is no verdict yet (never checked, or one
// failure with no earlier success)
function status(url) {
  const s = state[url];
  if (!s) return null;
  const at = new Date(s.at).toISOString();
  if (s.fails === 0) return { state: 'up', at };
  if (s.fails >= 2) return { state: 'down', at };
  return { state: s.up_at ? 'up' : null, at };
}

setInterval(() => { loop().catch((e) => console.error('explorer health failed', e && e.message)); }, LOOP_MS).unref();

module.exports = { track, status };
