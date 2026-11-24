const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
// hardening first: file permissions, security headers, guarded static files and query parameters
require('./security')(app);
const PORT = process.env.PORT || 3001;

const VISITORS_FILE = path.join(__dirname, 'data', 'visitors.json');
const AUDIT_HISTORY_FILE = path.join(__dirname, 'data', 'xln-audit-history.json');
const AUDIT_RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // full 20min-resolution kept for the last 7 days

function readVisitorCount() {
  try {
    const raw = fs.readFileSync(VISITORS_FILE, 'utf8');
    const n = JSON.parse(raw).count;
    return Number.isFinite(n) ? n : 0;
  } catch (e) {
    return 0;
  }
}

function writeVisitorCount(count) {
  try {
    fs.mkdirSync(path.dirname(VISITORS_FILE), { recursive: true });
    fs.writeFileSync(VISITORS_FILE, JSON.stringify({ count }));
  } catch (e) {
    console.error('failed to persist visitor count', e);
  }
}

// ---- XLN network audit: real supply vs. the protocol's own emission rule -----------------------
// Mirrors EXACTLY the emission rule in the LunariumCoin core (src/masternode.cpp: GetBlockValue,
// src/chainparams.cpp: nXLNCoinSupplyMintHeight/nXLNCoinSupply). If that rule ever changes in the
// core, it must be copied here too. Ported from the standalone xln-radar tool's emission.mjs.
const XLN_MINT_HEIGHT = 1270000;
const XLN_MINT_AMOUNT = 47000000;
const XLN_RANGE_SEGMENTS = [
  [1, 14400, 1],
  [14400, 621701, 12],
  [621701, 2724101, 10],
  [2724101, 4826501, 5],
  [4826501, 6928901, 2],
  [6928901, Infinity, 1],
];
function xlnExpectedSupply(H) {
  let total = 0;
  if (H >= 1) total += 51000000;
  for (const [lo, hi, val] of XLN_RANGE_SEGMENTS) {
    if (H <= lo) break;
    const upper = Math.min(H, hi);
    const count = Math.max(0, upper - lo);
    total += count * val;
  }
  if (H >= XLN_MINT_HEIGHT) total += XLN_MINT_AMOUNT;
  return total;
}

function readAuditHistory() {
  try {
    return JSON.parse(fs.readFileSync(AUDIT_HISTORY_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}
// Keeps the history file bounded forever while still covering years: samples inside the last 7
// days stay at full 20min resolution, anything older is collapsed to one sample per calendar day
// (the day's first sample). So the chart can show a real multi-year trend as time passes instead
// of just the most recent ~10 days, without the file growing without bound.
function compactAuditHistory(history) {
  const cutoff = Date.now() - AUDIT_RECENT_WINDOW_MS;
  const recent = [];
  const olderByDay = new Map();
  for (const p of history) {
    const t = new Date(p.ts).getTime();
    if (t >= cutoff) {
      recent.push(p);
    } else {
      const dayKey = new Date(p.ts).toISOString().slice(0, 10);
      if (!olderByDay.has(dayKey)) olderByDay.set(dayKey, p);
    }
  }
  return Array.from(olderByDay.values()).concat(recent).sort((a, b) => new Date(a.ts) - new Date(b.ts));
}
function writeAuditHistory(history) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_HISTORY_FILE), { recursive: true });
    fs.writeFileSync(AUDIT_HISTORY_FILE, JSON.stringify(compactAuditHistory(history)));
  } catch (e) {
    console.error('failed to persist xln audit history', e);
  }
}

let xlnAuditCache = null;
async function sampleXlnAudit() {
  try {
    // explorerxln.com API v1 (the Lunarium explorer): stats of the indexed chain and the node's peers
    // (full address here: this first runs at startup, before XLN_EXPLORER is defined further down)
    const stats = await fetchJson('https://explorerxln.com/api/v1/stats');
    if (stats.synced === false) throw new Error('explorer still syncing');
    const peerData = await fetchJson('https://explorerxln.com/api/v1/peers').catch(() => null);
    const peers = (peerData && Array.isArray(peerData.list)) ? peerData.list : [];
    const mn = stats.masternodes || {};
    const summary = {
      connections: stats.connections, difficulty: stats.difficulty,
      masternodeCountOnline: mn.enabled, masternodeCountOffline: mn.total != null && mn.enabled != null ? mn.total - mn.enabled : null,
    };

    const height = Number(stats.height);
    const actualSupply = Number(stats.supply);
    if (!(height > 0) || !(actualSupply > 0)) throw new Error('no explorer reading');
    const expectedSupply = xlnExpectedSupply(height);
    const deviationXLN = actualSupply - expectedSupply;
    const deviationPct = expectedSupply > 0 ? (deviationXLN / expectedSupply) * 100 : 0;

    const peerVersions = {};
    (Array.isArray(peers) ? peers : []).forEach((p) => {
      const raw = (p && (p.subver || p.version)) || ''; // "/LunariumCoin Core:4.0.0/"
      const m = raw.match(/(\d+\.\d+\.\d+)/);
      const v = m ? m[1] : 'outra';
      peerVersions[v] = (peerVersions[v] || 0) + 1;
    });

    xlnAuditCache = {
      ts: new Date().toISOString(),
      height,
      actualSupply,
      expectedSupply,
      deviationXLN,
      deviationPct,
      withinRule: deviationXLN <= 500,
      connections: Number(summary.connections ?? 0),
      difficulty: Number(summary.difficulty ?? 0),
      masternodesOnline: Number(summary.masternodeCountOnline ?? 0),
      masternodesOffline: Number(summary.masternodeCountOffline ?? 0),
      peerVersions,
      peerCount: Array.isArray(peers) ? peers.length : 0,
    };

    const history = readAuditHistory();
    history.push({ ts: xlnAuditCache.ts, height, actualSupply, expectedSupply, difficulty: xlnAuditCache.difficulty });
    writeAuditHistory(history);
  } catch (e) {
    console.error('xln audit sample failed', e && e.message);
  }
}

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/account') && !req.path.startsWith('/admin')) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const UPSTREAM_TIMEOUT_MS = 8000;

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
    if (!r.ok) throw new Error('upstream status ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

sampleXlnAudit();
setInterval(sampleXlnAudit, 20 * 60 * 1000);

// ---- Rewards generated in the last 24h / 30 days per audited coin (Auditoria page). Neither
// explorer exposes working reward totals, so: the number of blocks in each window is read from the
// chain (block timestamps), each block's masternode/stake split follows the coin's consensus rule,
// and a sample of real coinstake transactions spread over both windows is checked against that
// split (reported as matched/sampled). Recomputed once every 24h and persisted per coin, so a
// restart doesn't trigger a new scan of the explorer.
const REWARDS_REFRESH_MS = 24 * 60 * 60 * 1000;
const REWARDS_SAMPLES_PER_WINDOW = 6;
const XLN_EXPLORER = 'https://explorerxln.com';
const PIVX_EXPLORER = 'https://explorer.pivx.org';

// XLN rule: src/masternode.cpp GetBlockValue / GetMasternodePayment (75% of the block value).
function xlnBlockValue(h) {
  if (h > 6928901) return 1;
  if (h > 4826501) return 2;
  if (h > 2724101) return 5;
  if (h > 621701) return 10;
  if (h > 14400) return 12;
  if (h > 1) return 1;
  return 0;
}
function xlnMasternodePayment(h) {
  return h > 250 ? xlnBlockValue(h) * 0.75 : 0;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
    if (!r.ok) throw new Error('upstream status ' + r.status);
    return (await r.text()).trim();
  } finally {
    clearTimeout(timer);
  }
}

async function xlnBlock(h) {
  const blk = await fetchJson(`${XLN_EXPLORER}/api/v1/block/${h}`);
  if (Number(blk.height) !== Number(h) || !/^[0-9a-f]{64}$/.test(blk.hash || '')) throw new Error('bad block ' + h);
  return blk;
}

// Real split of one XLN block's coinstake: outputs back to the staker's own address minus the
// staked input = stake reward; every other output = masternode payment.
async function xlnBlockSplit(h) {
  const blk = await xlnBlock(h);
  const cs = (blk.txs || []).find((t) => t.kind === 'coinstake');
  if (!cs || !cs.txid) return null;
  // the explorer gives each input with its address and value, so the staked coins need no second lookup
  const tx = await fetchJson(`${XLN_EXPLORER}/api/v1/tx/${cs.txid}`);
  const inputs = (tx.inputs || []).filter((i) => i && i.address);
  if (!inputs.length) return null;
  const stakerAddrs = new Set(inputs.map((i) => i.address));
  const spent = inputs.reduce((s, i) => s + (Number(i.value) || 0), 0);
  let toStaker = 0;
  let toOthers = 0;
  (tx.outputs || []).forEach((o) => {
    if (!o || !o.address) return; // the empty first output of a coinstake
    if (stakerAddrs.has(o.address)) toStaker += Number(o.value) || 0; else toOthers += Number(o.value) || 0;
  });
  return { stake: toStaker - spent, masternode: toOthers };
}

// PIVX (explorer.pivx.org, Blockbook API, values in satoshis). Current PIVX rule: 10 PIV per
// block, 6 to the masternode and 4 to the staker -- the sampled coinstakes confirm it per window.
function pivxBlock(h) {
  return fetchJson(`${PIVX_EXPLORER}/api/v2/block/${h}`);
}
async function pivxBlockSplit(h) {
  const blk = await pivxBlock(h);
  const cs = blk.txs && blk.txs[1];
  if (!cs || !cs.vin || !cs.vin[0] || !cs.vin[0].addresses) return null;
  const stakerAddrs = new Set(cs.vin[0].addresses);
  const inSat = cs.vin.reduce((s, v) => s + Number(v.value || 0), 0);
  let toStaker = 0;
  let toOthers = 0;
  cs.vout.forEach((v) => {
    const sat = Number(v.value || 0);
    if ((v.addresses || []).some((a) => stakerAddrs.has(a))) toStaker += sat; else toOthers += sat;
  });
  return { stake: (toStaker - inSat) / 1e8, masternode: toOthers / 1e8 };
}

// MoneyByte (moneybyte-explorer.org, Iquidus API). Rule from MoneyByte/MoneyByteBlockchain
// src/main.cpp: STATIC_POS_REWARD = 2.3 * COIN (229,999,999 satoshis once truncated to an integer)
// per block since the fork at height 50,000, 70% of it to the masternode (GetMasternodePayment) and
// the rest to the staker. The foundation fee (8,760 MON every 43,800 blocks, fDevFee) is paid in the
// coinbase and is not a staking/masternode reward.
const MON_EXPLORER = 'https://moneybyte-explorer.org';
const MON_BLOCK_VALUE = 2.29999999;
const MON_MN_PAYMENT = 1.60999999;
const MON_MN_COLLATERAL = 50000;
async function monBlock(h) {
  const hash = (await fetchText(`${MON_EXPLORER}/api/getblockhash?index=${h}`)).replace(/"/g, '');
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('bad block hash for ' + h);
  return fetchJsonRetry(`${MON_EXPLORER}/api/getblock?hash=${hash}`);
}
// Real split of one block's coinstake: outputs back to the staker's own address minus the staked
// input = stake reward; every other output = masternode payment.
async function monBlockSplit(h) {
  const blk = await monBlock(h);
  const txid = blk.tx && blk.tx[1];
  if (!txid || !/proof-of-stake/.test(String(blk.flags))) return null;
  const tx = await fetchJsonRetry(`${MON_EXPLORER}/api/getrawtransaction?txid=${txid}&decrypt=1`);
  const vin = tx.vin && tx.vin[0];
  if (!vin || !vin.txid) return null;
  const prev = await fetchJsonRetry(`${MON_EXPLORER}/api/getrawtransaction?txid=${vin.txid}&decrypt=1`);
  const spent = prev.vout && prev.vout[vin.vout];
  if (!spent) return null;
  const stakerAddrs = new Set((spent.scriptPubKey && spent.scriptPubKey.addresses) || []);
  let toStaker = 0;
  let toOthers = 0;
  (tx.vout || []).forEach((o) => {
    const addrs = (o.scriptPubKey && o.scriptPubKey.addresses) || [];
    if (addrs.some((a) => stakerAddrs.has(a))) toStaker += Number(o.value) || 0; else toOthers += Number(o.value) || 0;
  });
  return { stake: toStaker - Number(spent.value), masternode: toOthers };
}
async function monMasternodes() {
  const list = await fetchJson(`${MON_EXPLORER}/api/masternodelist`);
  const states = Object.values(list && typeof list === 'object' ? list : {});
  if (!states.length) throw new Error('empty masternode list');
  return { enabled: states.filter((v) => v === 'ENABLED').length, total: states.length };
}

// Nodestats (explorer.nodestats.info, eIquidus API). Rule from NODESTATS-NS/nodestats
// src/masternode.cpp: CMasternode::GetBlockValue pays 4,000 NS in each of the first 250 blocks, then
// a fixed reward per height range, 2.5 NS per block since block 1,000,001 (no end height and no
// total limit: nMaxMoneyOut only bounds each single amount). GetMasternodePayment sends 90% of the
// block value to the masternode after block 250; the staker keeps the rest. Since block 1,000,001 a
// masternode needs 100,000 NS (GetMasternodeNodeCollateral). Coins sent to the burn address of
// src/chainparams.cpp (consensus.mBurnAddresses) can never be spent.
const NS_EXPLORER = 'https://explorer.nodestats.info';
const NS_BURN_ADDRESS = 'NSbURNodeStatsxxxxxxxxxxxxxxuKRQfp';
const NS_MN_COLLATERAL = 100000;
const NS_BLOCK_VALUE_SEGMENTS = [
  [1, 250, 4000], [251, 10000, 22.5], [10001, 30000, 25], [30001, 50000, 30], [50001, 70000, 35],
  [70001, 90000, 40], [90001, 110000, 45], [110001, 130000, 50], [130001, 150000, 55], [150001, 175000, 60],
  [175001, 200000, 65], [200001, 225000, 70], [225001, 250000, 75], [250001, 300000, 80], [300001, 400000, 40],
  [400001, 500000, 20], [500001, 685000, 10], [685001, 685001, 15], [685002, 750000, 10], [750001, 1000000, 5],
  [1000001, Infinity, 2.5],
];
function nsBlockValue(h) {
  for (const [lo, hi, v] of NS_BLOCK_VALUE_SEGMENTS) if (h >= lo && h <= hi) return v;
  return 0;
}
function nsMasternodePayment(h) {
  return h > 250 ? nsBlockValue(h) * 0.9 : 0;
}
async function nsBlock(h) {
  const hash = (await fetchText(`${NS_EXPLORER}/api/getblockhash?index=${h}`)).replace(/"/g, '');
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('bad block hash for ' + h);
  return fetchJsonRetry(`${NS_EXPLORER}/api/getblock?hash=${hash}`);
}
// Real split of one block's coinstake: outputs back to the staker's own address minus the staked
// input = stake reward; every other output = masternode payment.
async function nsBlockSplit(h) {
  const blk = await nsBlock(h);
  const txid = blk.tx && blk.tx[1];
  if (!txid) return null;
  const tx = await fetchJsonRetry(`${NS_EXPLORER}/api/getrawtransaction?txid=${txid}&decrypt=1`);
  const marker = tx.vout && tx.vout[0];
  if (!marker || Number(marker.value) !== 0) return null; // not a coinstake
  const vin = tx.vin && tx.vin[0];
  if (!vin || !vin.txid) return null;
  const prev = await fetchJsonRetry(`${NS_EXPLORER}/api/getrawtransaction?txid=${vin.txid}&decrypt=1`);
  const spent = prev.vout && prev.vout[vin.vout];
  if (!spent) return null;
  const stakerAddrs = new Set((spent.scriptPubKey && spent.scriptPubKey.addresses) || []);
  let toStaker = 0;
  let toOthers = 0;
  (tx.vout || []).forEach((o) => {
    const addrs = (o.scriptPubKey && o.scriptPubKey.addresses) || [];
    if (addrs.some((a) => stakerAddrs.has(a))) toStaker += Number(o.value) || 0; else toOthers += Number(o.value) || 0;
  });
  return { stake: toStaker - Number(spent.value), masternode: toOthers };
}
async function nsMasternodes() {
  const c = await fetchJson(`${NS_EXPLORER}/api/getmasternodecount`);
  const total = Number(c && c.total);
  if (!(total > 0)) throw new Error('bad nodestats masternode count');
  return { enabled: Number(c.enabled) || 0, total };
}

const REWARD_COINS = {
  xln: {
    file: path.join(__dirname, 'data', 'xln-rewards.json'),
    tipHeight: async () => Number((await fetchJson(`${XLN_EXPLORER}/api/v1/stats`)).height),
    blockTime: async (h) => Number((await xlnBlock(h)).time),
    split: xlnBlockSplit,
    blockValue: xlnBlockValue,
    masternodePayment: xlnMasternodePayment,
    // count unique collaterals (txhash:outidx) among the ENABLED ones -- the old explorer's list could
    // repeat a masternode; the Lunarium explorer's /api/v1/masternodes count.enabled agrees
    activeMasternodes: async () => {
      const d = await fetchJson(`${XLN_EXPLORER}/api/v1/masternodes`);
      const list = d && Array.isArray(d.list) ? d.list : [];
      return new Set(list.filter((m) => m.status === 'ENABLED').map((m) => `${m.txhash}:${m.outidx}`)).size;
    },
  },
  pivx: {
    file: path.join(__dirname, 'data', 'pivx-rewards.json'),
    tipHeight: async () => Number((await fetchJson(`${PIVX_EXPLORER}/api/v2`)).backend.blocks),
    blockTime: async (h) => Number((await pivxBlock(h)).time),
    split: pivxBlockSplit,
    blockValue: () => 10,
    masternodePayment: () => 6,
    activeMasternodes: async () => Number((await fetchJson(`${PIVX_EXPLORER}/api/v2/mncount`)).enabled),
  },
  mon: {
    file: path.join(__dirname, 'data', 'mon-rewards.json'),
    tipHeight: async () => Number(await fetchText(`${MON_EXPLORER}/api/getblockcount`)),
    blockTime: async (h) => Number((await monBlock(h)).time),
    split: monBlockSplit,
    blockValue: () => MON_BLOCK_VALUE,
    masternodePayment: () => MON_MN_PAYMENT,
    activeMasternodes: async () => (await monMasternodes()).enabled,
  },
  ns: {
    file: path.join(__dirname, 'data', 'ns-rewards.json'),
    tipHeight: async () => Number(await fetchText(`${NS_EXPLORER}/api/getblockcount`)),
    blockTime: async (h) => Number((await nsBlock(h)).time),
    split: nsBlockSplit,
    blockValue: nsBlockValue,
    masternodePayment: nsMasternodePayment,
    activeMasternodes: async () => (await nsMasternodes()).enabled,
  },
};

// Lowest height whose block time is >= since (block times only ever move forward in practice).
async function heightAt(coin, since, tipHeight, times) {
  const timeOf = async (h) => {
    if (!times.has(h)) times.set(h, await coin.blockTime(h));
    return times.get(h);
  };
  let lo = Math.max(1, tipHeight - Math.ceil((tipHeight * 2) / 3));
  let hi = tipHeight;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await timeOf(mid)) >= since) hi = mid; else lo = mid + 1;
  }
  return lo;
}

function windowRewards(coin, fromHeight, toHeight, fromTime, toTime) {
  let total = 0;
  let masternode = 0;
  for (let h = fromHeight; h <= toHeight; h++) {
    total += coin.blockValue(h);
    masternode += coin.masternodePayment(h);
  }
  return { fromHeight, toHeight, fromTime, toTime, blocks: toHeight - fromHeight + 1, total, masternode, stake: total - masternode };
}

const rewardsCache = {};
const rewardsRunning = {};
Object.keys(REWARD_COINS).forEach((id) => {
  try { rewardsCache[id] = JSON.parse(fs.readFileSync(REWARD_COINS[id].file, 'utf8')); } catch (e) { /* first run */ }
});

async function computeRewards(id) {
  if (rewardsRunning[id]) return;
  rewardsRunning[id] = true;
  const coin = REWARD_COINS[id];
  try {
    const tipHeight = await coin.tipHeight();
    const tipTime = await coin.blockTime(tipHeight);
    const times = new Map([[tipHeight, tipTime]]);
    const from1 = await heightAt(coin, tipTime - 86400, tipHeight, times);
    const from30 = await heightAt(coin, tipTime - 30 * 86400, tipHeight, times);
    const d1 = windowRewards(coin, from1, tipHeight, times.get(from1), tipTime);
    const d30 = windowRewards(coin, from30, tipHeight, times.get(from30), tipTime);

    const heights = [];
    const step1 = Math.max(1, Math.floor((tipHeight - from1) / REWARDS_SAMPLES_PER_WINDOW));
    for (let i = 0; i < REWARDS_SAMPLES_PER_WINDOW; i++) heights.push(tipHeight - i * step1);
    const step30 = Math.max(1, Math.floor((from1 - from30) / REWARDS_SAMPLES_PER_WINDOW));
    for (let i = 1; i <= REWARDS_SAMPLES_PER_WINDOW; i++) heights.push(from1 - i * step30);
    let sampled = 0;
    let matched = 0;
    for (const h of heights) {
      const split = await coin.split(h).catch(() => null);
      if (!split) continue;
      sampled += 1;
      const expMn = coin.masternodePayment(h);
      const expStake = coin.blockValue(h) - expMn;
      if (Math.abs(split.masternode - expMn) < 1e-6 && Math.abs(split.stake - expStake) < 1e-6) matched += 1;
    }

    rewardsCache[id] = {
      ok: true,
      updatedAt: new Date().toISOString(),
      height: tipHeight,
      blockValue: coin.blockValue(tipHeight),
      masternodeSharePct: (coin.masternodePayment(tipHeight) / coin.blockValue(tipHeight)) * 100,
      activeMasternodes: await coin.activeMasternodes().catch(() => null),
      d1,
      d30,
      verification: { sampled, matched },
    };
    fs.mkdirSync(path.dirname(coin.file), { recursive: true });
    fs.writeFileSync(coin.file, JSON.stringify(rewardsCache[id]));
  } catch (e) {
    console.error(id + ' rewards computation failed', e && e.message);
  } finally {
    rewardsRunning[id] = false;
  }
}

function refreshRewardsIfDue() {
  Object.keys(REWARD_COINS).forEach((id) => {
    const c = rewardsCache[id];
    const age = c ? Date.now() - new Date(c.updatedAt).getTime() : Infinity;
    if (age >= REWARDS_REFRESH_MS) computeRewards(id);
  });
}
refreshRewardsIfDue();
setInterval(refreshRewardsIfDue, 60 * 60 * 1000);

// The candle chart expects times in seconds; Binance/MEXC/WEEX/CoinEx report milliseconds.
function sendCloses(res, closes, candles) {
  res.json({
    ok: true,
    closes: closes.filter((v) => typeof v === 'number' && !isNaN(v)),
    candles: (candles || [])
      .filter((c) => c && [c.o, c.h, c.l, c.c].every((v) => typeof v === 'number' && !isNaN(v)))
      .map((c) => (c.t > 1e12 ? { ...c, t: Math.floor(c.t / 1000) } : c)),
  });
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sendError(res, err) {
  console.error(err);
  res.status(502).json({ ok: false, error: String(err && err.message || err) });
}

// Timeframe presets: how each chart-timeframe tab (1H/24H/7D/30D/1Y) maps to
// each exchange's own resolution/period/interval params plus a candle count.
// Note: Qutrade's own TradingView-UDF endpoint only accepts resolution 15, 60 or 1D
// (confirmed by probing it directly) -- every other value returns a plain-text error.
// candleLimit is the candle count that actually spans the tab's period at the binance/mexc/weex/
// coinex interval (e.g. 30D at 4h = 180 candles).
const TF_PRESETS = {
  '1H': { gateviaPeriod: '1', qutradeRes: '15', spanSec: 3600, lunariumInterval: '1m', limit: 60, gtTimeframe: 'minute', gtAggregate: 1, gtLimit: 60, binanceInterval: '1m', mexcInterval: '1m', weexInterval: '1m', coinexPeriod: '1min', candleLimit: 60 },
  '24H': { gateviaPeriod: '15', qutradeRes: '15', spanSec: 86400, lunariumInterval: '15m', limit: 96, gtTimeframe: 'minute', gtAggregate: 15, gtLimit: 96, binanceInterval: '15m', mexcInterval: '15m', weexInterval: '15m', coinexPeriod: '15min', candleLimit: 96 },
  '7D': { gateviaPeriod: '60', qutradeRes: '60', spanSec: 7 * 86400, lunariumInterval: '1h', limit: 168, gtTimeframe: 'hour', gtAggregate: 1, gtLimit: 168, binanceInterval: '1h', mexcInterval: '60m', weexInterval: '1h', coinexPeriod: '1hour', candleLimit: 168 },
  '30D': { gateviaPeriod: '240', qutradeRes: '1D', spanSec: 30 * 86400, lunariumInterval: '4h', limit: 30, gtTimeframe: 'hour', gtAggregate: 4, gtLimit: 180, binanceInterval: '4h', mexcInterval: '4h', weexInterval: '4h', coinexPeriod: '4hour', candleLimit: 180 },
  '1Y': { gateviaPeriod: '1440', qutradeRes: '1D', spanSec: 365 * 86400, lunariumInterval: '1d', limit: 365, gtTimeframe: 'day', gtAggregate: 1, gtLimit: 365, binanceInterval: '1d', mexcInterval: '1d', weexInterval: '1d', coinexPeriod: '1day', candleLimit: 365 },
};
function tfPreset(tf) { return TF_PRESETS[tf] || TF_PRESETS['7D']; }

// Gatevia: k-line array of [time, open, high, low, close, volume], ascending
app.get('/api/klines/gatevia', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'XLN_USDT';
    const tf = tfPreset(req.query.tf);
    const period = req.query.period || tf.gateviaPeriod;
    const limit = Number(req.query.limit) || tf.limit;
    const data = await fetchJson(`https://api.gatevia.io/public/markets/${symbol}/k-line?period=${period}`);
    const last = data.slice(-limit);
    const closes = last.map((c) => parseFloat(c[4]));
    const candles = last.map((c) => ({ t: c[0], o: parseFloat(c[1]), h: parseFloat(c[2]), l: parseFloat(c[3]), c: parseFloat(c[4]), v: safeNum(c[5]) }));
    sendCloses(res, closes, candles);
  } catch (e) { sendError(res, e); }
});

// Qutrade: TradingView UDF history {t:[],c:[],...}, ascending
app.get('/api/klines/qutrade', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'XLN_USDT';
    const tf = tfPreset(req.query.tf);
    const resolution = req.query.resolution || tf.qutradeRes;
    const limit = Number(req.query.limit) || tf.limit;
    const now = Math.floor(Date.now() / 1000);
    const from = now - tf.spanSec;
    const data = await fetchJson(`https://qutrade.io/api/spot/tradingview/history?symbol=${symbol}&resolution=${resolution}&from=${from}&to=${now}&countback=${limit}`);
    const closes = (data.c || []).slice(-limit).map(Number);
    const n = closes.length;
    const opens = (data.o || []).slice(-limit).map(Number);
    const highs = (data.h || []).slice(-limit).map(Number);
    const lows = (data.l || []).slice(-limit).map(Number);
    const times = (data.t || []).slice(-limit).map(Number);
    const vols = (data.v || []).slice(-limit).map(Number);
    const candles = [];
    for (let i = 0; i < n; i++) {
      candles.push({ t: times[i], o: opens[i], h: highs[i], l: lows[i], c: closes[i], v: safeNum(vols[i]) });
    }
    sendCloses(res, closes, candles);
  } catch (e) { sendError(res, e); }
});

// GeckoTerminal: free public DEX aggregator (PancakeSwap/Biswap/etc pools on BSC).
// Used for tokens whose real trading activity lives on DEXs rather than CEXs.
// Callers pass either ?pool=<address> or ?token=<address>; with token, the token's most liquid pool
// is looked up (cached 10min, including "no pool yet"), so a token whose pool doesn't exist yet goes
// live on its own once the pool is created.
const GT_POOL_TTL_MS = 10 * 60 * 1000;
const gtPoolCache = new Map();
async function resolveGtPool(network, token, maxAgeMs = GT_POOL_TTL_MS) {
  const key = network + ':' + String(token).toLowerCase();
  const hit = gtPoolCache.get(key);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.pool;
  let pool = null;
  try {
    const data = await fetchJson(`https://api.geckoterminal.com/api/v2/networks/${network}/tokens/${token}/pools?page=1`);
    const pools = (Array.isArray(data.data) ? data.data : [])
      .map((p) => ({
        address: p.attributes && p.attributes.address,
        name: p.attributes && p.attributes.name,
        dex: p.relationships && p.relationships.dex && p.relationships.dex.data && p.relationships.dex.data.id,
        baseIsToken: ((p.relationships && p.relationships.base_token && p.relationships.base_token.data && p.relationships.base_token.data.id) || '').toLowerCase() === (network + '_' + token).toLowerCase(),
        reserveUsd: num(p.attributes && p.attributes.reserve_in_usd) || 0,
        attributes: p.attributes || {},
      }))
      .filter((p) => p.address)
      .sort((a, b) => b.reserveUsd - a.reserveUsd);
    pool = pools[0] || null;
  } catch (e) {
    // GeckoTerminal answers 404 for a token it has never seen trade -- that just means no pool yet.
    if (!/status 404/.test(String(e && e.message))) {
      if (hit) return hit.pool;
      throw e;
    }
  }
  gtPoolCache.set(key, { at: Date.now(), pool });
  return pool;
}
async function gtPoolFromQuery(query, network) {
  if (query.pool) return { address: query.pool, baseIsToken: true };
  if (query.token) return resolveGtPool(network, query.token);
  return null;
}

// DEX data APIs are rate limited per IP (GeckoTerminal ~30 req/min) and shared by every visitor and
// the public API: identical requests within a short window reuse one upstream answer (in-flight
// requests are shared too).
const dexResponseCache = new Map();
function cachedFetchJson(url, ttlMs) {
  const hit = dexResponseCache.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
  const promise = fetchJson(url);
  dexResponseCache.set(url, { at: Date.now(), promise });
  promise.catch(() => dexResponseCache.delete(url));
  if (dexResponseCache.size > 500) dexResponseCache.delete(dexResponseCache.keys().next().value);
  return promise;
}

app.get('/api/klines/geckoterminal', async (req, res) => {
  try {
    const network = req.query.network || 'bsc';
    const p = await gtPoolFromQuery(req.query, network);
    if (!p) return res.json({ ok: false, error: 'no pool yet' });
    const pool = p.address;
    const tf = tfPreset(req.query.tf);
    const timeframe = req.query.timeframe || tf.gtTimeframe;
    const aggregate = req.query.aggregate || tf.gtAggregate;
    const limit = Number(req.query.limit) || tf.gtLimit;
    const side = p.baseIsToken ? '' : '&token=quote';
    const data = await cachedFetchJson(`https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${limit}${side}`, 60 * 1000);
    const list = (data.data && data.data.attributes && data.data.attributes.ohlcv_list) || [];
    const ascending = list.slice().reverse();
    const closes = ascending.map((c) => c[4]);
    const candles = ascending.map((c) => ({ t: c[0], o: c[1], h: c[2], l: c[3], c: c[4], v: safeNum(c[5]) }));
    sendCloses(res, closes, candles);
  } catch (e) { sendError(res, e); }
});

// Pool ticker: DexScreener first (much higher rate limit, same on-chain pool), GeckoTerminal as the
// fallback. Candles stay on GeckoTerminal -- DexScreener has no OHLC API.
// Binance Web3 (Binance Wallet): Binance's own front end for trading on-chain tokens. The feed of its
// token page (web3.binance.com/token/bsc/<contract>) gives the price it quotes, the 24h change, the
// pool liquidity and the volume traded through Binance Wallet in 24h (volume24hBinance) -- a part of
// the token's on-chain volume, not volume on top of it. It publishes no candles: the token's candles
// are the pool's (the PancakeSwap line).
const BINANCE_WEB3_INFO = 'https://web3.binance.com/bapi/defi/v4/public/wallet-direct/buw/wallet/market/token/dynamic/info';
app.get('/api/ticker/binanceweb3', async (req, res) => {
  try {
    const token = String(req.query.token || '').toLowerCase();
    const chain = String(req.query.chain || '56');
    if (!/^0x[0-9a-f]{40}$/.test(token) || !/^[0-9]{1,6}$/.test(chain)) return res.status(400).json({ ok: false, error: 'token must be a contract address' });
    const d = await fetchJson(`${BINANCE_WEB3_INFO}?chainId=${chain}&contractAddress=${token}`);
    const x = d && d.data;
    const price = x ? num(x.price) : null;
    if (!(price > 0)) return res.status(404).json({ ok: false, error: 'token not on Binance Web3' });
    res.json({
      ok: true,
      price,
      bid: null,
      ask: null,
      change: num(x.percentChange24h),
      // traded through Binance Wallet only (the pool's whole volume is on the PancakeSwap market)
      volume: num(x.volume24hBinance),
      trades: num(x.count24hBinance),
      liquidity: num(x.liquidity),
    });
  } catch (e) { sendError(res, e); }
});
app.get('/api/klines/binanceweb3', (req, res) => { res.json({ ok: true, closes: [], candles: [] }); });
// MEXC DEX (MEXC's on-chain trading page, mexc.com/dex/onchain/bsc/<contract>): it swaps through the
// token's PancakeSwap pool, and its own API answers only to a browser (Akamai blocks servers). So the
// price and 24h change here are the pool's, read like the PancakeSwap line; the volume traded through
// MEXC cannot be verified and stays empty (the pool's whole volume is on the PancakeSwap market).
// Only the tokens confirmed on MEXC DEX are followed.
const MEXC_DEX_TOKENS = ['0x5a6625b65a917c872ceec781b6c4419f6abc8a48']; // XLNFT (page sent by the owner, 2026-10-26)
async function mexcDexTicker(token) {
  const d = await callRoute('/api/ticker/geckoterminal', { token, network: 'bsc' });
  if (!d || !d.ok || !(d.price > 0)) return null;
  return { price: d.price, change: d.change != null ? d.change : null, liquidity: d.liquidity != null ? d.liquidity : null };
}
app.get('/api/ticker/mexcdex', async (req, res) => {
  try {
    const token = String(req.query.token || '').toLowerCase();
    if (!MEXC_DEX_TOKENS.includes(token)) return res.status(404).json({ ok: false, error: 'token not followed on MEXC DEX' });
    const t = await mexcDexTicker(token);
    if (!t) return res.status(404).json({ ok: false, error: 'no pool price' });
    res.json({ ok: true, price: t.price, bid: null, ask: null, change: t.change, volume: null, liquidity: t.liquidity, pool_price: true });
  } catch (e) { sendError(res, e); }
});
app.get('/api/klines/mexcdex', (req, res) => { res.json({ ok: true, closes: [], candles: [] }); });
// Bitget Onchain (Bitget's on-chain trading page, bitget.com/on-chain/bnb/<contract>): it swaps through the
// token's PancakeSwap pool. The ticker its own page reads (POST v1/mix/onchain/ticker, {params:[{chain, address}]})
// gives the price Bitget quotes and the 24h change as a fraction (-0.0094 = -0.94%). Its 24h volume is Bitget's
// count of the token's on-chain volume, not volume traded through Bitget, so it is left out (the pool's whole
// volume is on the PancakeSwap market). Only the tokens confirmed on Bitget Onchain are followed.
const BITGET_ONCHAIN_TOKENS = ['0x5a6625b65a917c872ceec781b6c4419f6abc8a48']; // XLNFT (page sent by the owner, 2026-11-09)
app.get('/api/ticker/bitgetonchain', async (req, res) => {
  try {
    const token = String(req.query.token || '').toLowerCase();
    if (!BITGET_ONCHAIN_TOKENS.includes(token)) return res.status(404).json({ ok: false, error: 'token not followed on Bitget Onchain' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let d;
    try {
      const r = await fetch('https://www.bitget.com/v1/mix/onchain/ticker', {
        method: 'POST',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: [{ chain: 'bnb', address: token }] }),
        signal: controller.signal,
      });
      if (!r.ok) throw new Error('upstream status ' + r.status);
      d = await r.json();
    } finally {
      clearTimeout(timer);
    }
    const x = d && Array.isArray(d.data) ? d.data.find((t) => String(t.cA || '').toLowerCase() === token) : null;
    const price = x ? num(x.p) : null;
    if (!(price > 0)) return res.status(404).json({ ok: false, error: 'token not on Bitget Onchain' });
    const c = num(x.c);
    res.json({ ok: true, price, bid: null, ask: null, change: c != null ? Math.round(c * 10000) / 100 : null, volume: null });
  } catch (e) { sendError(res, e); }
});
app.get('/api/klines/bitgetonchain', (req, res) => { res.json({ ok: true, closes: [], candles: [] }); });
// GeckoTerminal (CoinGecko's on-chain charts) and CoinMarketCap DEX: not exchanges, the token's PancakeSwap
// pool seen through them (owner's requests, 2026-10-27). Reference lines: the pool's price and 24h change, read
// like the PancakeSwap line; no volume (the pool's whole volume is on the PancakeSwap market).
const GT_REF_POOLS = ['0x66a9638e23c6e48c35d8def0fb311a6dc8a77b69']; // XLNFT/USDT
app.get('/api/ticker/gtref', async (req, res) => {
  try {
    const pool = String(req.query.pool || '').toLowerCase();
    if (!GT_REF_POOLS.includes(pool)) return res.status(404).json({ ok: false, error: 'pool not followed' });
    const d = await callRoute('/api/ticker/geckoterminal', { pool, network: 'bsc' });
    if (!d || !d.ok || !(d.price > 0)) return res.status(404).json({ ok: false, error: 'no pool price' });
    res.json({ ok: true, price: d.price, bid: null, ask: null, change: d.change != null ? d.change : null, volume: null, liquidity: d.liquidity != null ? d.liquidity : null, pool_price: true });
  } catch (e) { sendError(res, e); }
});
app.get('/api/klines/gtref', (req, res) => { res.json({ ok: true, closes: [], candles: [] }); });

app.get('/api/ticker/geckoterminal', async (req, res) => {
  try {
    const network = req.query.network || 'bsc';
    const p = await gtPoolFromQuery(req.query, network);
    if (!p) return res.json({ ok: false, error: 'no pool yet' });
    try {
      const ds = await cachedFetchJson(`https://api.dexscreener.com/latest/dex/pairs/${network}/${p.address}`, 30 * 1000);
      const pair = ds && Array.isArray(ds.pairs) ? ds.pairs[0] : null;
      if (pair && pair.priceUsd != null && p.baseIsToken) {
        return res.json({
          ok: true,
          price: num(pair.priceUsd),
          change: num(pair.priceChange && pair.priceChange.h24),
          volume: num(pair.volume && pair.volume.h24),
          liquidity: num(pair.liquidity && pair.liquidity.usd),
        });
      }
    } catch (e) { /* fall through to GeckoTerminal */ }
    const data = await cachedFetchJson(`https://api.geckoterminal.com/api/v2/networks/${network}/pools/${p.address}`, 30 * 1000);
    const a = data.data && data.data.attributes;
    const change = a && a.price_change_percentage && a.price_change_percentage.h24;
    const volume = a && a.volume_usd && a.volume_usd.h24;
    const priceField = p.baseIsToken ? 'base_token_price_usd' : 'quote_token_price_usd';
    res.json({
      ok: true,
      price: a && a[priceField] != null ? parseFloat(a[priceField]) : null,
      change: change != null ? parseFloat(change) : null,
      volume: volume != null ? parseFloat(volume) : null,
    });
  } catch (e) { sendError(res, e); }
});

// Binance: public spot ticker/klines. Used as the reference market for tokens
// that are officially 1:1 pegged/wrapped versions of a coin natively traded there
// (e.g. Binance-Peg tokens), never as a stand-in for a DEX-only token's own price.
app.get('/api/ticker/binance', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'ADAUSDT';
    const data = await fetchJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
    res.json({
      ok: true,
      price: data.lastPrice != null ? parseFloat(data.lastPrice) : null,
      bid: data.bidPrice != null ? parseFloat(data.bidPrice) : null,
      ask: data.askPrice != null ? parseFloat(data.askPrice) : null,
      change: data.priceChangePercent != null ? parseFloat(data.priceChangePercent) : null,
      volume: data.quoteVolume != null ? safeNum(data.quoteVolume) : null,
    });
  } catch (e) { sendError(res, e); }
});

app.get('/api/klines/binance', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'ADAUSDT';
    const tf = tfPreset(req.query.tf);
    const interval = req.query.interval || tf.binanceInterval;
    const limit = Number(req.query.limit) || tf.candleLimit;
    const data = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    const closes = data.map((c) => parseFloat(c[4]));
    const candles = data.map((c) => ({ t: c[0], o: parseFloat(c[1]), h: parseFloat(c[2]), l: parseFloat(c[3]), c: parseFloat(c[4]), v: safeNum(c[5]) }));
    sendCloses(res, closes, candles);
  } catch (e) { sendError(res, e); }
});

// 24h change straight from open vs. last: MEXC/WEEX report priceChangePercent as a ratio (1.27 =
// +127%), so recomputing it avoids depending on each exchange's own unit.
function pctChange(open, last) {
  const o = num(open);
  const l = num(last);
  return o > 0 && l != null ? ((l - o) / o) * 100 : null;
}

// MEXC: klines array of [openTime,open,high,low,close,volume,...], ascending
app.get('/api/klines/mexc', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'PIVXUSDT';
    const tf = tfPreset(req.query.tf);
    const data = await fetchJson(`https://api.mexc.com/api/v3/klines?symbol=${symbol}&interval=${tf.mexcInterval}&limit=${tf.candleLimit}`);
    const closes = data.map((c) => parseFloat(c[4]));
    const candles = data.map((c) => ({ t: c[0], o: parseFloat(c[1]), h: parseFloat(c[2]), l: parseFloat(c[3]), c: parseFloat(c[4]), v: safeNum(c[5]) }));
    sendCloses(res, closes, candles);
  } catch (e) { sendError(res, e); }
});

app.get('/api/ticker/mexc', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'PIVXUSDT';
    const t = await fetchJson(`https://api.mexc.com/api/v3/ticker/24hr?symbol=${symbol}`);
    res.json({ ok: true, price: num(t.lastPrice), bid: num(t.bidPrice), ask: num(t.askPrice), change: pctChange(t.openPrice, t.lastPrice), volume: num(t.quoteVolume) });
  } catch (e) { sendError(res, e); }
});

// WEEX: klines array of [openTime,open,high,low,close,volume,...], DESCENDING (newest first); it
// ignores `limit` and always returns ~300 candles, so the series is cut here.
app.get('/api/klines/weex', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'PIVXUSDT';
    const tf = tfPreset(req.query.tf);
    const data = await fetchJson(`https://api-spot.weex.com/api/v3/market/klines?symbol=${symbol}&interval=${tf.weexInterval}`);
    const ordered = data.slice().reverse().slice(-tf.candleLimit);
    const closes = ordered.map((c) => parseFloat(c[4]));
    const candles = ordered.map((c) => ({ t: c[0], o: parseFloat(c[1]), h: parseFloat(c[2]), l: parseFloat(c[3]), c: parseFloat(c[4]), v: safeNum(c[5]) }));
    sendCloses(res, closes, candles);
  } catch (e) { sendError(res, e); }
});

app.get('/api/ticker/weex', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'PIVXUSDT';
    const t = await fetchJson(`https://api-spot.weex.com/api/v3/market/ticker/24hr?symbol=${symbol}`);
    res.json({ ok: true, price: num(t.lastPrice), bid: num(t.bidPrice), ask: num(t.askPrice), change: pctChange(t.openPrice, t.lastPrice), volume: num(t.quoteVolume) });
  } catch (e) { sendError(res, e); }
});

// Nonkyc.io candles (api.nonkyc.io, TradingView-style "bars", ascending, time in ms). Resolutions
// it serves: 5, 15, 30, 60, 240 and 1440 minutes (1 is empty, so the 1H view uses 5-minute bars).
const NONKYC_TF = { '1H': [5, 12], '24H': [15, 96], '7D': [60, 168], '30D': [240, 180], '1Y': [1440, 365] };
app.get('/api/klines/nonkyc', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || 'PIVX_USDT').replace(/[^A-Za-z0-9_]/g, '');
    const [resolution, count] = NONKYC_TF[req.query.tf] || NONKYC_TF['7D'];
    const to = Math.floor(Date.now() / 1000);
    const from = to - resolution * 60 * count;
    const data = await fetchJson(`https://api.nonkyc.io/api/v2/market/candles?symbol=${symbol}&resolution=${resolution}&from=${from}&to=${to}&countBack=${count}&firstDataRequest=1`);
    const bars = (Array.isArray(data.bars) ? data.bars : []).slice(-count);
    const candles = bars.map((b) => ({ t: b.time, o: num(b.open), h: num(b.high), l: num(b.low), c: num(b.close), v: safeNum(b.volume) }));
    sendCloses(res, candles.map((c) => c.c), candles);
  } catch (e) { sendError(res, e); }
});

const CEXIUS_TF = { '1H': ['1m', 60], '24H': ['15m', 96], '7D': ['1h', 168], '30D': ['4h', 180], '1Y': ['1d', 365] };
app.get('/api/klines/cexius', async (req, res) => {
  try {
    const market = String(req.query.market || 'XCB-USDT').replace(/[^A-Za-z0-9-]/g, '');
    const [period, limit] = CEXIUS_TF[req.query.tf] || CEXIUS_TF['7D'];
    const data = await fetchJson(`${CEXIUS_API}/markets/${market}/k-line?period=${period}&limit=${limit}`);
    const candles = (Array.isArray(data) ? data : []).map((c) => ({ t: Number(c.timestamp), o: num(c.open), h: num(c.high), l: num(c.low), c: num(c.close), v: safeNum(c.volume) })).sort((a, b) => a.t - b.t);
    sendCloses(res, candles.map((c) => c.c), candles);
  } catch (e) { sendError(res, e); }
});
app.get('/api/ticker/cexius', async (req, res) => {
  try {
    const market = String(req.query.market || 'XCB-USDT').replace(/[^A-Za-z0-9-]/g, '');
    const d = await fetchJson(`${CEXIUS_API}/markets/${market}/tickers`);
    const t = (d && d.ticker) || d || {};
    // Cexius answers a market it does not have with an empty ticker (no base currency, all zeros)
    if (!(t.base || t.base_unit)) return res.status(404).json({ ok: false, error: 'market not listed on Cexius' });
    const pos = (v) => { const n = num(v); return n > 0 ? n : null; };
    const last = pos(t.last);
    const volume = num(t.quote_volume);
    // A pair with no trade in the last 24h has no current price: its last trade can be far off the
    // market, so it is reported apart, flagged `stale` (same rule as the other exchanges' tickers).
    const traded = volume > 0;
    let lastTradeAt = null;
    if (!traded && last != null) {
      try {
        const tr = await fetchJson(`${CEXIUS_API}/markets/${market}/trades?limit=1`);
        const one = Array.isArray(tr) ? tr[0] : null;
        const at = one ? (one.created_at ? Date.parse(one.created_at) : Number(one.timestamp) * 1000) : NaN;
        if (at > 0) lastTradeAt = new Date(at).toISOString();
      } catch (e) { /* the date of the last trade is optional */ }
    }
    res.json({
      ok: true,
      price: traded ? last : null,
      bid: pos(t.bid),
      ask: pos(t.ask),
      change: traded ? num(String(t.price_change_percent || '').replace(/[+%]/g, '')) : null,
      volume,
      stale: !traded && last != null,
      last_price: last,
      last_trade_at: lastTradeAt,
    });
  } catch (e) { sendError(res, e); }
});

app.get('/api/ticker/nonkyc', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'PIVX_USDT';
    const t = await fetchJson(`https://nonkyc.io/api/v2/market/getbysymbol/${symbol}`);
    res.json({ ok: true, price: num(t.lastPrice), bid: num(t.bestBid), ask: num(t.bestAsk), change: pctChange(t.yesterdayPrice, t.lastPrice), volume: num(t.volumeSecondary) });
  } catch (e) { sendError(res, e); }
});

// NestEx: every coin trades against USDT. Tickers from its CoinGecko-format feed (cached 30s, one
// call serves every coin), candles from its TradingView feed (symbol = the coin's ticker).
let nestexTickers = null;
async function getNestexTickers() {
  if (nestexTickers && Date.now() - nestexTickers.at < 30 * 1000) return nestexTickers.list;
  const list = await fetchJson('https://trade.nestex.one/api/cg/tickers');
  if (!Array.isArray(list)) throw new Error('bad nestex tickers');
  nestexTickers = { at: Date.now(), list };
  return list;
}
app.get('/api/ticker/nestex', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || 'MON_USDT').toUpperCase().replace(/[^A-Z0-9_]/g, '');
    const t = (await getNestexTickers()).find((x) => x.ticker_id === symbol);
    if (!t) return res.json({ ok: true, price: null, bid: null, ask: null, change: null, volume: null });
    const volume = safeNum(t.target_volume);
    res.json({ ok: true, price: num(t.last_price), bid: num(t.bid), ask: num(t.ask), change: pctChange(t.oldltp24h, t.last_price), volume, liquidity: num(t.liquidity) });
  } catch (e) { sendError(res, e); }
});
const NESTEX_TF = { '1H': ['5', 300, 12], '24H': ['15', 900, 96], '7D': ['60', 3600, 168], '30D': ['240', 14400, 180], '1Y': ['D', 86400, 365] };
app.get('/api/klines/nestex', async (req, res) => {
  try {
    const coin = String(req.query.symbol || 'MON_USDT').toUpperCase().replace(/[^A-Z0-9_]/g, '').split('_')[0];
    const [resolution, sec, count] = NESTEX_TF[req.query.tf] || NESTEX_TF['7D'];
    const to = Math.floor(Date.now() / 1000);
    const d = await fetchJson(`https://tvdata.nestex.one/history?symbol=${coin}&resolution=${resolution}&from=${to - sec * count}&to=${to}&countback=${count}`);
    const candles = (d && d.s === 'ok' && Array.isArray(d.t) ? d.t : []).map((t, i) => ({ t: Number(t), o: num(d.o[i]), h: num(d.h[i]), l: num(d.l[i]), c: num(d.c[i]), v: safeNum(d.v && d.v[i]) })).slice(-count);
    sendCloses(res, candles.map((c) => c.c), candles);
  } catch (e) { sendError(res, e); }
});

// StakeCube: market list (cached 60s) for last price / 24h volume, order book for bid/ask and the
// trade list for the time of the last trade. A market with no trade in 24h has no current price:
// its last trade is reported apart, flagged `stale` (same rule as the LunariumTrade ticker).
let stakecubeMarkets = null;
async function getStakecubeMarkets() {
  if (stakecubeMarkets && Date.now() - stakecubeMarkets.at < 60 * 1000) return stakecubeMarkets.map;
  const d = await fetchJson('https://stakecube.io/api/v2/exchange/spot/markets');
  if (!d || !d.success || !d.result) throw new Error('bad stakecube markets');
  stakecubeMarkets = { at: Date.now(), map: d.result };
  return d.result;
}
app.get('/api/ticker/stakecube', async (req, res) => {
  try {
    const market = String(req.query.market || 'MON_USDT').toUpperCase().replace(/[^A-Z0-9_]/g, '');
    const m = (await getStakecubeMarkets())[market];
    if (!m) return res.json({ ok: true, price: null, bid: null, ask: null, change: null, volume: null });
    const [book, trades] = await Promise.all([
      fetchJson(`https://stakecube.io/api/v2/exchange/spot/orderbook?market=${market}`).catch(() => null),
      fetchJson(`https://stakecube.io/api/v2/exchange/spot/trades?market=${market}&limit=1`).catch(() => null),
    ]);
    const prices = (side) => ((book && book.result && book.result[side]) || []).map((o) => num(o.price)).filter((v) => v > 0);
    const bids = prices('bids');
    const asks = prices('asks');
    const lastTrade = trades && Array.isArray(trades.result) && trades.result[0] ? Number(trades.result[0].time) * 1000 : null;
    const traded = lastTrade != null && Date.now() - lastTrade < 24 * 3600 * 1000;
    const last = num(m.lastPrice);
    res.json({
      ok: true,
      halted: m.state !== 'ACTIVE' || undefined,
      price: traded ? last : null,
      bid: bids.length ? Math.max(...bids) : null,
      ask: asks.length ? Math.min(...asks) : null,
      change: traded ? num(m.change24h) : null,
      volume: safeNum(m.volumeBase24h),
      stale: !traded && last != null,
      last_price: last,
      last_trade_at: lastTrade ? new Date(lastTrade).toISOString() : null,
    });
  } catch (e) { sendError(res, e); }
});
const STAKECUBE_TF = { '1H': ['5m', 12], '24H': ['15m', 96], '7D': ['1h', 168], '30D': ['4h', 180], '1Y': ['1d', 365] };
app.get('/api/klines/stakecube', async (req, res) => {
  try {
    const market = String(req.query.market || 'MON_USDT').toUpperCase().replace(/[^A-Z0-9_]/g, '');
    const [interval, count] = STAKECUBE_TF[req.query.tf] || STAKECUBE_TF['7D'];
    const d = await fetchJson(`https://stakecube.io/api/v2/exchange/spot/ohlcData?market=${market}&interval=${interval}`);
    const lines = (d && d.data && Array.isArray(d.data.lines) ? d.data.lines : []).slice(-count);
    // candles without volume only repeat the last trade: a market that did not trade has no line
    const candles = lines.map((c) => ({ t: Number(c[0]), o: num(c[1]), h: num(c[2]), l: num(c[3]), c: num(c[4]), v: safeNum(c[5]) })).filter((c) => c.v > 0);
    sendCloses(res, candles.map((c) => c.c), candles);
  } catch (e) { sendError(res, e); }
});

// CoinEx v2: kline objects {created_at(ms),open,high,low,close,volume,value}, ascending
app.get('/api/klines/coinex', async (req, res) => {
  try {
    const market = req.query.market || 'PIVXUSDT';
    const tf = tfPreset(req.query.tf);
    const data = await fetchJson(`https://api.coinex.com/v2/spot/kline?market=${market}&period=${tf.coinexPeriod}&limit=${tf.candleLimit}`);
    const list = Array.isArray(data.data) ? data.data : [];
    const closes = list.map((c) => parseFloat(c.close));
    const candles = list.map((c) => ({ t: c.created_at, o: parseFloat(c.open), h: parseFloat(c.high), l: parseFloat(c.low), c: parseFloat(c.close), v: safeNum(c.volume) }));
    sendCloses(res, closes, candles);
  } catch (e) { sendError(res, e); }
});

app.get('/api/ticker/coinex', async (req, res) => {
  try {
    const market = req.query.market || 'PIVXUSDT';
    const [ticker, depth] = await Promise.all([
      fetchJson(`https://api.coinex.com/v2/spot/ticker?market=${market}`),
      fetchJson(`https://api.coinex.com/v2/spot/depth?market=${market}&limit=5&interval=0`).catch(() => null),
    ]);
    const t = (ticker.data && ticker.data[0]) || {};
    const book = (depth && depth.data && depth.data.depth) || {};
    if (ticker.code !== 0 || !ticker.data || !ticker.data[0]) {
      return res.json({ ok: true, halted: true, price: num(book.last), bid: null, ask: null, change: null, volume: 0 });
    }
    res.json({
      ok: true,
      price: num(t.last),
      bid: book.bids && book.bids[0] ? num(book.bids[0][0]) : null,
      ask: book.asks && book.asks[0] ? num(book.asks[0][0]) : null,
      change: pctChange(t.open, t.last),
      volume: num(t.value),
    });
  } catch (e) { sendError(res, e); }
});

// LunariumTrade: candles array of {time,open,high,low,close,volume}, ascending
app.get('/api/klines/lunarium', async (req, res) => {
  try {
    const pair = req.query.pair || 'XLN/USDT';
    const tf = tfPreset(req.query.tf);
    const interval = req.query.interval || tf.lunariumInterval;
    const limit = req.query.limit || tf.limit;
    const data = await fetchJson(`https://lunariumtrade.io/api/markets/${encodeURIComponent(pair)}/candles?interval=${interval}&limit=${limit}`);
    const closes = data.map((c) => parseFloat(c.close));
    const candles = data.map((c) => ({ t: c.time, o: parseFloat(c.open), h: parseFloat(c.high), l: parseFloat(c.low), c: parseFloat(c.close), v: safeNum(c.volume) }));
    sendCloses(res, closes, candles);
  } catch (e) { sendError(res, e); }
});

// ---- Exchange pages (CoinGecko-style): every pair an exchange trades, with spread, ±2% order-book
// depth, volume converted to USDT and each pair's share of the exchange's volume. Everything comes
// from the exchange's own public API -- nothing is estimated. Served stale-while-revalidate: a
// request always gets the last snapshot instantly and triggers a background rebuild once it is older
// than the exchange's TTL. Gatevia/LunariumTrade need per-pair requests and Gatevia rate-limits
// (429), so they refresh far less often than Qutrade, which serves everything in two calls.
const EXCHANGE_TTL_MS = { qutrade: 60 * 1000, gatevia: 5 * 60 * 1000, lunariumtrade: 60 * 1000, cexius: 5 * 60 * 1000, mexc: 2 * 60 * 1000, binanceweb3: 5 * 60 * 1000, mexcdex: 2 * 60 * 1000, nonkyc: 5 * 60 * 1000 };
const exchangeCache = {};
const exchangeInflight = {};

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Per-pair endpoints (order books, trades) occasionally answer a burst with a transient 400/5xx.
async function fetchJsonRetry(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchJson(url);
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      try { await fn(item); } catch (e) { /* one pair failing must not sink the whole exchange */ }
    }
  });
  await Promise.all(workers);
}

// Order-book depth within ±2% of the mid price, in quote currency (same definition CoinGecko uses).
function bookDepth(bids, asks, bid, ask) {
  // no order book published (or not fetched): depth unknown, never zero
  if (!(bid > 0 && ask > 0 && ask >= bid) || (!bids && !asks)) return { plus2: null, minus2: null };
  const mid = (bid + ask) / 2;
  let plus2 = 0;
  let minus2 = 0;
  (asks || []).forEach(([p, q]) => { p = num(p); q = num(q); if (p > 0 && q > 0 && p <= mid * 1.02) plus2 += p * q; });
  (bids || []).forEach(([p, q]) => { p = num(p); q = num(q); if (p > 0 && q > 0 && p >= mid * 0.98) minus2 += p * q; });
  return { plus2, minus2 };
}

// Non-USDT quotes (BTC, DOGE, LTC, ...) are converted with that same exchange's own QUOTE/USDT
// price. Quotes with no USDT market there are left unconverted (and excluded from USDT totals)
// rather than guessed.
function finalizeExchange(rows) {
  const rate = { USDT: 1 };
  rows.forEach((r) => {
    const p = r.price > 0 ? r.price : (r.bid > 0 && r.ask > 0 ? (r.bid + r.ask) / 2 : null);
    if (r.quote === 'USDT' && p) rate[r.base] = p;
  });
  const unpriced = new Set();
  const markets = rows.map((r) => {
    const toUsdt = rate[r.quote];
    if (toUsdt == null) unpriced.add(r.quote);
    const conv = (v) => (v != null && toUsdt != null ? v * toUsdt : null);
    const depth = bookDepth(r.bids, r.asks, r.bid, r.ask);
    return {
      base: r.base,
      quote: r.quote,
      price: r.price,
      priceUsdt: conv(r.price),
      high: r.high,
      low: r.low,
      bid: r.bid,
      ask: r.ask,
      change: r.change,
      spreadPct: r.bid > 0 && r.ask > 0 && r.ask >= r.bid ? ((r.ask - r.bid) / r.ask) * 100 : null,
      depthPlus2: conv(depth.plus2),
      depthMinus2: conv(depth.minus2),
      volume: r.volume,
      volumeUsdt: conv(r.volume),
      trades: r.trades,
      updatedAt: r.updatedAt,
      // when the exchange created the market, where its API tells (exchange-listings.js)
      listedAt: r.listedAt || null,
      // a token market: its contract (Binance Web3 links each token's own page)
      contract: r.contract || undefined,
    };
  });
  const totalVolumeUsdt = markets.reduce((s, m) => s + (m.volumeUsdt || 0), 0);
  markets.forEach((m) => {
    m.volumePct = totalVolumeUsdt > 0 && m.volumeUsdt != null ? (m.volumeUsdt / totalVolumeUsdt) * 100 : null;
  });
  markets.sort((a, b) => (b.volumeUsdt || 0) - (a.volumeUsdt || 0) || (b.depthPlus2 || 0) - (a.depthPlus2 || 0));

  const byQuote = {};
  markets.forEach((m) => {
    const q = byQuote[m.quote] || (byQuote[m.quote] = { quote: m.quote, pairs: 0, activePairs: 0, volumeUsdt: 0, priced: rate[m.quote] != null });
    q.pairs += 1;
    if (m.volume > 0) q.activePairs += 1;
    q.volumeUsdt += m.volumeUsdt || 0;
  });
  const active = markets.filter((m) => m.volume > 0);
  let spreadWeight = 0;
  let spreadSum = 0;
  active.forEach((m) => {
    if (m.spreadPct != null && m.volumeUsdt > 0) { spreadWeight += m.volumeUsdt; spreadSum += m.spreadPct * m.volumeUsdt; }
  });
  return {
    ok: true,
    updatedAt: Date.now(),
    totalVolumeUsdt,
    pairsTotal: markets.length,
    pairsActive: active.length,
    trades24h: markets.some((m) => m.trades != null) ? markets.reduce((s, m) => s + (m.trades || 0), 0) : null,
    avgSpreadPct: spreadWeight > 0 ? spreadSum / spreadWeight : null,
    depthPlus2Usdt: markets.some((m) => m.depthPlus2 != null) ? markets.reduce((s, m) => s + (m.depthPlus2 || 0), 0) : null,
    depthMinus2Usdt: markets.some((m) => m.depthMinus2 != null) ? markets.reduce((s, m) => s + (m.depthMinus2 || 0), 0) : null,
    quoteMarkets: Object.values(byQuote).sort((a, b) => b.volumeUsdt - a.volumeUsdt || b.pairs - a.pairs),
    unpricedQuotes: Array.from(unpriced),
    markets,
  };
}

// Cexius (cexius.com/api/v2): one call for every ticker, order books only where ±2% depth can be
// non-zero (same rule as Gatevia). Coin icons come from its currency list.
const CEXIUS_API = 'https://cexius.com/api/v2';
const cexiusIcons = {};
// MEXC (mexc.com/api-docs/spot-v3): base/quote of every symbol from exchangeInfo (1.5 MB, kept 6 hours)
const mexcSymbols = { at: 0, map: null };
const EXCHANGE_BUILDERS = {
  // Binance Web3 (Binance Wallet) has no market list: its page shows the BNB Chain tokens the site follows
  // (public-api-coins.json, USDT itself left out), each read from the feed of Binance's own token page --
  // price, 24h change, and the volume traded through Binance Wallet (part of the pools' volume).
  async binanceweb3() {
    let registry = [];
    try { registry = JSON.parse(fs.readFileSync(path.join(__dirname, 'public-api-coins.json'), 'utf8')); } catch (e) { /* no registry */ }
    const tokens = registry.filter((c) => c.contract && /bep-?20|bnb|bsc/i.test(String(c.network || '')) && String(c.symbol).toUpperCase() !== 'USDT');
    const rows = [];
    await mapLimit(tokens, 3, async (c) => {
      const d = await fetchJsonRetry(`https://web3.binance.com/bapi/defi/v4/public/wallet-direct/buw/wallet/market/token/dynamic/info?chainId=56&contractAddress=${String(c.contract).toLowerCase()}`).catch(() => null);
      const x = d && d.data;
      const price = x ? num(x.price) : null;
      if (!(price > 0)) return; // not on Binance Web3
      rows.push({
        symbol: String(c.contract).toLowerCase(),
        base: String(c.symbol).toUpperCase(),
        quote: 'USDT',
        price,
        high: null,
        low: null,
        bid: null,
        ask: null,
        change: num(x.percentChange24h),
        volume: safeNum(x.volume24hBinance),
        trades: x.count24hBinance != null ? Number(x.count24hBinance) || 0 : null,
        updatedAt: Date.now(),
        contract: String(c.contract),
      });
    });
    return rows;
  },
  // MEXC DEX: the tokens confirmed there (MEXC_DEX_TOKENS), priced by their PancakeSwap pool; no volume
  // (what MEXC routes into the pool cannot be verified)
  async mexcdex() {
    let registry = [];
    try { registry = JSON.parse(fs.readFileSync(path.join(__dirname, 'public-api-coins.json'), 'utf8')); } catch (e) { /* no registry */ }
    const rows = [];
    for (const token of MEXC_DEX_TOKENS) {
      const c = registry.find((x) => String(x.contract || '').toLowerCase() === token);
      const t = c ? await mexcDexTicker(token).catch(() => null) : null;
      if (!t) continue;
      rows.push({ symbol: token, base: String(c.symbol).toUpperCase(), quote: 'USDT', price: t.price, high: null, low: null, bid: null, ask: null,
        change: t.change, volume: null, trades: null, updatedAt: Date.now(), contract: String(c.contract) });
    }
    return rows;
  },
  // MEXC: one call for every 24h ticker, best bid/ask included. With ~1,900 markets no order book is read
  // per market, so the ±2% depth stays unknown. priceChangePercent is a fraction (-0.1492 = -14.92%).
  async mexc() {
    if (!mexcSymbols.map || Date.now() - mexcSymbols.at > 6 * 3600 * 1000) {
      try {
        const info = await fetchJson('https://api.mexc.com/api/v3/exchangeInfo');
        const map = {};
        ((info && info.symbols) || []).forEach((s) => {
          if (String(s.status) === '1' && s.isSpotTradingAllowed !== false && s.baseAsset && s.quoteAsset) map[s.symbol] = [String(s.baseAsset).toUpperCase(), String(s.quoteAsset).toUpperCase()];
        });
        if (Object.keys(map).length) Object.assign(mexcSymbols, { at: Date.now(), map });
      } catch (e) {
        if (!mexcSymbols.map) throw e; // the previous list is kept when a refresh fails
      }
    }
    const list = await fetchJson('https://api.mexc.com/api/v3/ticker/24hr');
    const pos = (v) => { const n = num(v); return n > 0 ? n : null; };
    return (Array.isArray(list) ? list : []).map((t) => {
      const bq = mexcSymbols.map[t.symbol];
      if (!bq) return null; // halted or unknown symbol
      const last = pos(t.lastPrice);
      const pct = num(t.priceChangePercent);
      return {
        symbol: t.symbol,
        base: bq[0],
        quote: bq[1],
        price: last,
        high: pos(t.highPrice),
        low: pos(t.lowPrice),
        bid: pos(t.bidPrice),
        ask: pos(t.askPrice),
        change: last != null && pct != null ? Math.round(pct * 1000000) / 10000 : null,
        volume: safeNum(t.quoteVolume),
        trades: null,
        updatedAt: Number(t.closeTime) || null,
      };
    }).filter(Boolean);
  },
  async cexius() {
    const [tickers, overview] = await Promise.all([
      fetchJson(`${CEXIUS_API}/markets/tickers`),
      fetchJson(`${CEXIUS_API}/markets/overview`).catch(() => null),
    ]);
    ((overview && overview.currencies) || []).forEach((c) => { if (c.id && c.icon_url) cexiusIcons[String(c.id).toUpperCase()] = c.icon_url; });
    // a market or a coin the exchange has switched off (delisting) is not listed here either
    const offMarkets = new Set(((overview && overview.markets) || []).filter((m) => m.enabled === false || m.enable_trading === false).map((m) => String(m.id)));
    const offCoins = new Set(((overview && overview.currencies) || []).filter((c) => c.enabled === false).map((c) => String(c.id).toUpperCase()));
    // the date Cexius created each market: the listing date of its coin
    const createdAt = {};
    ((overview && overview.markets) || []).forEach((m) => { if (m.id && m.created_at) createdAt[String(m.id)] = m.created_at; });
    // a pair that has never traded reports "0" for its prices: that is no price
    const pos = (v) => { const n = num(v); return n > 0 ? n : null; };
    const rows = Object.values(tickers || {}).map((x) => x && x.ticker).filter(Boolean).map((t) => ({
      symbol: t.market,
      base: String(t.base || t.base_unit || '').toUpperCase(),
      quote: String(t.quote || t.quote_unit || '').toUpperCase(),
      price: pos(t.last),
      high: pos(t.high),
      low: pos(t.low),
      bid: pos(t.bid),
      ask: pos(t.ask),
      change: pos(t.last) != null ? num(String(t.price_change_percent || '').replace(/[+%]/g, '')) : null,
      volume: num(t.quote_volume),
      trades: null,
      updatedAt: t.timestamp ? Number(t.timestamp) * 1000 : null,
      listedAt: createdAt[String(t.market)] || null,
    })).filter((r) => r.base && r.quote && !offMarkets.has(String(r.symbol)) && !offCoins.has(r.base) && !offCoins.has(r.quote));
    await mapLimit(rows, 3, async (r) => {
      if (r.bid > 0 && r.ask > 0 && r.ask <= ((r.bid + r.ask) / 2) * 1.02) {
        const book = await fetchJsonRetry(`${CEXIUS_API}/markets/${encodeURIComponent(r.symbol)}/orderbook`).catch(() => null);
        if (book) { r.bids = (book.bids || []).map((l) => [l[0], l[1]]); r.asks = (book.asks || []).map((l) => [l[0], l[1]]); }
      } else if (r.bid > 0 && r.ask > 0) {
        r.bids = [];
        r.asks = [];
      }
    });
    return rows;
  },
  // NonKYC: CoinGecko-style /tickers (quote-currency volume per market); no order books in bulk
  async nonkyc() {
    const list = await fetchJson('https://api.nonkyc.io/api/v2/tickers');
    return (Array.isArray(list) ? list : []).map((m) => ({
      base: String(m.base_currency || '').toUpperCase(),
      quote: String(m.target_currency || '').toUpperCase(),
      price: num(m.last_price),
      high: num(m.high),
      low: num(m.low),
      bid: num(m.bid),
      ask: num(m.ask),
      change: num(String(m.change_percent || '').replace('+', '')),
      volume: num(m.target_volume),
      trades: null,
      updatedAt: Date.now(),
    })).filter((r) => r.base && r.quote);
  },
  async qutrade() {
    const [data, depth] = await Promise.all([
      fetchJson('https://qutrade.io/api/v1/market_data/'),
      fetchJson('https://qutrade.io/api/v1/market_depth/').catch(() => ({})),
    ]);
    const list = data.list || {};
    const books = (depth && depth.list) || {};
    return Object.keys(list).map((key) => {
      const m = list[key];
      const cut = key.lastIndexOf('_');
      const book = books[key] || {};
      return {
        base: key.slice(0, cut).toUpperCase(),
        quote: key.slice(cut + 1).toUpperCase(),
        price: num(m.price),
        high: num(m.high),
        low: num(m.low),
        bid: num(m.bid),
        ask: num(m.ask),
        change: num(m.trend),
        volume: num(m.asset_2_volume),
        trades: m.trades != null ? Number(m.trades) : null,
        updatedAt: m.timestamp ? Number(m.timestamp) * 1000 : null,
        bids: book.bids,
        asks: book.asks,
      };
    });
  },

  async gatevia() {
    const [quotes, tickers] = await Promise.all([
      fetchJson('https://api.gatevia.io/public/markets/quotes'),
      fetchJson('https://api.gatevia.io/public/markets/tickers').catch(() => ({})),
    ]);
    const rows = quotes.map((q) => {
      const t = (tickers[q.symbol] && tickers[q.symbol].ticker) || {};
      const last = num(q.last);
      return {
        symbol: q.symbol,
        base: String(q.base_unit || '').toUpperCase(),
        quote: String(q.quote_unit || '').toUpperCase(),
        price: last != null ? last : (num(t.last) > 0 ? num(t.last) : null),
        // Gatevia reports high/low as "0" when a pair had no trades in 24h; that isn't a price.
        high: num(t.high) > 0 ? num(t.high) : null,
        low: num(t.low) > 0 ? num(t.low) : null,
        bid: num(q.bid),
        ask: num(q.ask),
        change: null,
        volume: num(t.quote_volume),
        trades: null,
        updatedAt: q.last_ts ? q.last_ts * 1000 : null,
      };
    });
    await mapLimit(rows, 3, async (r) => {
      // The best ask sits exactly as far above the mid price as the best bid sits below it, so with
      // a spread wider than ~4% no order can fall inside ±2% and depth is 0 without asking --
      // on Gatevia that spares most per-pair book requests (and its rate limit).
      if (r.bid > 0 && r.ask > 0 && r.ask <= ((r.bid + r.ask) / 2) * 1.02) {
        const book = await fetchJsonRetry(`https://api.gatevia.io/public/markets/${r.symbol}/depth`);
        r.bids = book.bids;
        r.asks = book.asks;
      } else if (r.bid > 0 && r.ask > 0) {
        r.bids = []; // spread wider than ±2%: depth inside ±2% is known to be zero
        r.asks = [];
      }
      // Gatevia's ticker has no 24h change field: derived from its hourly candles, only for pairs
      // that actually traded (open of the oldest candle inside the last 24h vs. current price).
      if (r.volume > 0 && r.price > 0) {
        const klines = await fetchJsonRetry(`https://api.gatevia.io/public/markets/${r.symbol}/k-line?period=60`);
        if (Array.isArray(klines) && klines.length) {
          const dayAgo = Math.floor(Date.now() / 1000) - 86400;
          const past = klines.find((c) => c[0] >= dayAgo) || klines[0];
          const open = num(past[1]);
          if (open > 0) r.change = ((r.price - open) / open) * 100;
        }
      }
    });
    return rows;
  },

  // LunariumTrade: the 24h figures (last price, volume, high/low, change) are the ones the exchange
  // publishes in its documented public API (ltSummary). The order book (bid/ask, depth) and the
  // trade history (trades in 24h, time of the last trade) are read per pair; should the summary not
  // answer, the 24h figures are derived from that trade history instead (and from the hourly
  // candles when the capped trade list does not reach back 24 hours). The pair list is every pair
  // of the summary (USDT, XLN and XLNFT quotes); without the summary, the USDT pairs of the coin
  // pages. A pair whose endpoints fail is skipped.
  async lunariumtrade() {
    const known = ['XLN/USDT', 'S11/USDT', 'ADA/USDT', 'ASTER/USDT', 'BTCB/USDT', 'CAKE/USDT', 'DOGE/USDT', 'ETH/USDT', 'FORM/USDT', 'LTC/USDT', 'XRP/USDT'];
    const summary = await ltSummary().catch(() => null);
    const listed = summary ? Object.keys(summary).filter((k) => /^[A-Z0-9]+_[A-Z0-9]+$/.test(k)).map((k) => k.replace('_', '/')) : [];
    const pairs = listed.length ? listed : known;
    const rows = [];
    await mapLimit(pairs, 2, async (pair) => {
      const base = `https://lunariumtrade.io/api/markets/${encodeURIComponent(pair)}`;
      const info = summary && summary[pair.replace('/', '_')];
      // a pair with no order has no book to read, and one that never traded has no history
      const hasBook = !info || num(info.highest_bid) > 0 || num(info.lowest_ask) > 0;
      const hasTrades = !info || num(info.last_price) > 0;
      const [book, trades] = await Promise.all([
        hasBook ? fetchJsonRetry(`${base}/orderbook`) : { bids: [], asks: [] },
        hasTrades ? fetchJsonRetry(`${base}/trades?limit=500`) : [],
      ]);
      const list = (Array.isArray(trades) ? trades : [])
        .map((t) => ({ price: num(t.price), amount: num(t.amount), at: Date.parse(String(t.created_at).replace(' ', 'T') + 'Z') }))
        .filter((t) => t.price > 0 && t.amount > 0 && Number.isFinite(t.at))
        .sort((a, b) => b.at - a.at);
      const dayAgo = Date.now() - 86400 * 1000;
      const day = list.filter((t) => t.at >= dayAgo);
      const bids = (book.bids || []).map((l) => num(l[0])).filter((p) => p > 0);
      const asks = (book.asks || []).map((l) => num(l[0])).filter((p) => p > 0);
      const [b, q] = pair.split('/');
      let last = list[0] ? list[0].price : null;
      let high = day.length ? Math.max(...day.map((t) => t.price)) : null;
      let low = day.length ? Math.min(...day.map((t) => t.price)) : null;
      let volume = day.reduce((s, t) => s + t.price * t.amount, 0);
      let change = null;
      const official = summary && summary[pair.replace('/', '_')];
      if (official) {
        if (num(official.last_price) > 0) last = num(official.last_price);
        volume = num(official.quote_volume) || 0;
        high = num(official.highest_price_24h) > 0 ? num(official.highest_price_24h) : null;
        low = num(official.lowest_price_24h) > 0 ? num(official.lowest_price_24h) : null;
        if (volume > 0) change = num(official.price_change_percent_24h);
      } else if (day.length) {
        const before = list.find((t) => t.at < dayAgo);
        let ref = before ? before.price : null;
        if (!before) {
          const candles = await fetchJsonRetry(`${base}/candles?interval=1h&limit=500`).catch(() => null);
          const cut = Math.floor(dayAgo / 1000);
          const past = (Array.isArray(candles) ? candles : [])
            .filter((c) => c.time + 3600 <= cut && num(c.close) > 0)
            .sort((x, y) => x.time - y.time)
            .pop();
          if (past) ref = num(past.close);
        }
        if (ref > 0) change = ((last - ref) / ref) * 100;
      }
      rows.push({
        base: b,
        quote: q,
        price: last,
        high,
        low,
        bid: bids.length ? Math.max(...bids) : null,
        ask: asks.length ? Math.min(...asks) : null,
        change,
        volume,
        // the summary is the reference for "traded in 24h"; the trade list gives the count
        trades: official ? (volume > 0 ? Math.max(day.length, 1) : 0) : day.length,
        updatedAt: list[0] ? list[0].at : null,
        bids: book.bids,
        asks: book.asks,
      });
    });
    return rows;
  },
};

// LunariumTrade's documented public API (https://lunariumtrade.io/api-docs.html): /api/cmc/summary
// is the 24h overview of every pair, keyed "BASE_QUOTE" -- last_price, highest_bid, lowest_ask,
// quote_volume, price_change_percent_24h, highest/lowest_price_24h. One answer serves every pair,
// so it is kept for 20 seconds.
const ltSummaryState = { at: 0, data: null, inflight: null };
function ltSummary() {
  if (ltSummaryState.data && Date.now() - ltSummaryState.at < 20 * 1000) return Promise.resolve(ltSummaryState.data);
  if (!ltSummaryState.inflight) {
    ltSummaryState.inflight = fetchJson('https://lunariumtrade.io/api/cmc/summary')
      .then((d) => {
        if (!d || typeof d !== 'object' || Array.isArray(d) || d.error) throw new Error('lunariumtrade summary unavailable');
        ltSummaryState.at = Date.now();
        ltSummaryState.data = d;
        return d;
      })
      .finally(() => { ltSummaryState.inflight = null; });
  }
  return ltSummaryState.inflight;
}

function refreshExchange(id) {
  if (!exchangeInflight[id]) {
    exchangeInflight[id] = EXCHANGE_BUILDERS[id]()
      .then(finalizeExchange)
      .then((data) => { exchangeCache[id] = { at: Date.now(), data }; return data; })
      .finally(() => { delete exchangeInflight[id]; });
  }
  return exchangeInflight[id];
}

// the hourly automated-volume check of the exchange (exchange-volume-check.js), when there is one
function withVolumeCheck(id, data) {
  const v = app.locals.volumeCheck ? app.locals.volumeCheck(id) : null;
  return v ? Object.assign({}, data, { volumeCheck: v }) : data;
}
app.get('/api/exchange/:id', async (req, res) => {
  const id = req.params.id;
  if (!Object.prototype.hasOwnProperty.call(EXCHANGE_BUILDERS, id)) return res.status(404).json({ ok: false, error: 'unknown exchange' });
  const cached = exchangeCache[id];
  if (cached) {
    if (Date.now() - cached.at >= EXCHANGE_TTL_MS[id]) {
      refreshExchange(id).catch((e) => console.error('exchange refresh failed', id, e && e.message));
    }
    return res.json(withVolumeCheck(id, cached.data));
  }
  try {
    res.json(withVolumeCheck(id, await refreshExchange(id)));
  } catch (e) {
    sendError(res, e);
  }
});

Object.keys(EXCHANGE_BUILDERS).forEach((id) => {
  refreshExchange(id).catch((e) => console.error('exchange warm-up failed', id, e && e.message));
});

// ---- Coin logos for the exchange pages, taken from each exchange's own asset folder (so an
// obscure or duplicated ticker always gets the logo that exchange itself shows). The originals run
// up to ~250KB each, so data/logos/<exchange>/<SYMBOL>.png holds pre-shrunk 64px copies; an asset
// listed later is fetched from the exchange once, stored as-is and served from disk afterwards.
// Only raster formats are accepted (no SVG), so a logo can never carry script.
const LOGO_DIR = path.join(__dirname, 'data', 'logos');
let mexcIcons = {};
try { mexcIcons = JSON.parse(fs.readFileSync(path.join(__dirname, 'mexc-icons.json'), 'utf8')); } catch (e) { /* no list: MEXC coins show their initials */ }
const LOGO_SOURCES = {
  qutrade: (s) => `https://qutrade.io/images/asset/${s.toLowerCase()}.png`,
  gatevia: (s) => `https://gatevia.io/images_coins/${s}.png`,
  cexius: (s) => cexiusIcons[s] || `https://img.cexius.com/cexius/icons/${s.toLowerCase()}.png`,
  // LunariumTrade's own coin icons (the baseLogo of its /api/markets/tickers)
  lunariumtrade: (s) => `https://lunariumtrade.io/assets/coins/${s.toLowerCase()}.png`,
  // MEXC's own icons: symbol -> file id from its website (mexc-icons.json, tools/update-mexc-icons.js)
  mexc: (s) => (mexcIcons[s] ? `https://public.mocortech.com/coin/${mexcIcons[s]}.png` : null),
};

function rasterType(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return null;
}

app.get('/api/logo/:ex/:sym', async (req, res) => {
  const ex = req.params.ex;
  const sym = String(req.params.sym).toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(LOGO_SOURCES, ex) || !/^[A-Z0-9()]{1,24}$/.test(sym)) return res.status(404).end(); // MEXC has symbols like GOLD(XAUT)
  const dir = path.join(LOGO_DIR, ex);
  const small = path.join(dir, `${sym}.png`);
  const original = path.join(dir, `${sym}.orig`);
  const missing = path.join(dir, `${sym}.missing`);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'public, max-age=604800');
  if (fs.existsSync(small)) return res.type('image/png').sendFile(small);
  if (fs.existsSync(original)) {
    const buf = fs.readFileSync(original);
    return res.type(rasterType(buf) || 'image/png').send(buf);
  }
  const notFound = () => { res.set('Cache-Control', 'public, max-age=3600'); res.status(404).end(); };
  if (fs.existsSync(missing) && Date.now() - fs.statSync(missing).mtimeMs < 24 * 3600 * 1000) return notFound();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const src = LOGO_SOURCES[ex](sym);
    if (!src) throw new Error('no logo published');
    const r = await fetch(src, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
    const buf = Buffer.from(await r.arrayBuffer());
    const type = rasterType(buf);
    if (!r.ok || !type || buf.length > 1024 * 1024) throw new Error('no usable logo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(original, buf);
    res.type(type).send(buf);
  } catch (e) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(missing, ''); } catch (err) { /* cache miss marker is best-effort */ }
    notFound();
  } finally {
    clearTimeout(timer);
  }
});

// Gatevia ticker: /public/markets/quotes for bid/ask/last, /public/markets/tickers for real 24h volume.
app.get('/api/ticker/gatevia', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'XLN_USDT';
    const [quotes, tickers, klines] = await Promise.all([
      fetchJson('https://api.gatevia.io/public/markets/quotes'),
      fetchJson('https://api.gatevia.io/public/markets/tickers'),
      fetchJson(`https://api.gatevia.io/public/markets/${symbol}/k-line?period=60`).catch(() => null),
    ]);
    const q = Array.isArray(quotes) ? quotes.find((x) => x.symbol === symbol) : null;
    const t = tickers && tickers[symbol] && tickers[symbol].ticker;
    const price = q && q.last != null ? parseFloat(q.last) : null;
    // Gatevia's ticker endpoint has no 24h change field, so it is derived from
    // the k-line series: open price of the oldest candle within the last 24h vs current price.
    let change = null;
    if (Array.isArray(klines) && klines.length && price != null) {
      const dayAgo = Math.floor(Date.now() / 1000) - 86400;
      const past = klines.find((c) => c[0] >= dayAgo) || klines[0];
      const openPast = parseFloat(past[1]);
      if (openPast > 0) change = ((price - openPast) / openPast) * 100;
    }
    const volume = t && t.quote_volume != null ? safeNum(t.quote_volume) : null;
    // A pair with no trade in the last 24h (volume exactly zero) has no current price: its last
    // trade can be far off the market (BTC/USDT sat at 120,000 with an empty day), so it is
    // reported apart, flagged `stale` -- the same rule as the LunariumTrade and StakeCube tickers.
    const traded = volume !== 0;
    res.json({
      ok: true,
      price: traded ? price : null,
      bid: q && q.bid != null ? parseFloat(q.bid) : null,
      ask: q && q.ask != null ? parseFloat(q.ask) : null,
      volume,
      change: traded ? change : null,
      stale: !traded && price != null,
      last_price: price,
      last_trade_at: q && q.last_ts ? new Date(q.last_ts * 1000).toISOString() : null,
    });
  } catch (e) { sendError(res, e); }
});

// LunariumTrade ticker: the exchange's documented public API (/api/cmc/summary, see ltSummary) --
// last price, best bid/ask, 24h volume and 24h change exactly as the exchange publishes them. A pair
// missing from it falls back to the figures the LunariumTrade exchange page derives from the pair's
// own order book and trade history (cached 5 min). A pair with no trade in the last 24h has no
// current price: its last trade (which can be far off the market) is reported apart, flagged `stale`.
app.get('/api/ticker/lunarium', async (req, res) => {
  try {
    const pair = req.query.pair || 'XLN/USDT';
    const summary = await ltSummary().catch(() => null);
    const t = summary ? summary[pair.toUpperCase().replace('/', '_')] : null;
    const lastPrice = t && num(t.last_price) > 0 ? num(t.last_price) : null;
    const [base, quote] = pair.toUpperCase().split('/');
    const cached = exchangeCache.lunariumtrade;
    if (cached && Date.now() - cached.at >= EXCHANGE_TTL_MS.lunariumtrade) {
      refreshExchange('lunariumtrade').catch((e) => console.error('exchange refresh failed', 'lunariumtrade', e && e.message));
    }
    const ex = cached ? cached.data : await refreshExchange('lunariumtrade').catch((e) => { if (!t) throw e; return null; });
    const m = ex && Array.isArray(ex.markets) ? ex.markets.find((x) => x.base === base && x.quote === quote) : null;
    if (!t) {
      const traded = !!m && m.trades > 0;
      return res.json({
        ok: true,
        price: traded ? m.price : null,
        bid: m ? m.bid : null,
        ask: m ? m.ask : null,
        change: traded ? m.change : null,
        volume: m ? (m.volumeUsdt != null ? m.volumeUsdt : m.volume) : null,
        stale: !!m && !traded && m.price != null,
        last_price: m ? m.price : null,
        last_trade_at: m && m.updatedAt ? new Date(m.updatedAt).toISOString() : null,
      });
    }
    // the summary's volume covers the last 24h: none means no trade in 24h
    const volume = safeNum(t.quote_volume);
    const traded = lastPrice != null && volume > 0;
    res.json({
      ok: true,
      price: traded ? lastPrice : null,
      bid: num(t.highest_bid) > 0 ? num(t.highest_bid) : null,
      ask: num(t.lowest_ask) > 0 ? num(t.lowest_ask) : null,
      change: traded ? num(t.price_change_percent_24h) : null,
      volume,
      stale: !traded && lastPrice != null,
      last_price: lastPrice,
      last_trade_at: m && m.updatedAt ? new Date(m.updatedAt).toISOString() : null,
    });
  } catch (e) { sendError(res, e); }
});

// A LunariumTrade pair quoted in another coin (XLN/XLNFT), live from the exchange's official API and
// in the pair's own units -- no USDT value is made up for it. LunariumTrade keeps two separate order
// books between the same two coins (XLN_XLNFT and XLNFT_XLN), so both are read, in the direction the
// page asks for (pair=XLN/XLNFT: how many XLNFT one XLN gives; invert=1 reads it the other way round):
//  - best bid / ask: the best offers of either book (an ask of the other book, inverted, is a bid here);
//  - price and 24h change: those of the book whose last trade is the most recent (from its trade list);
//  - 24h volume: both books added up, in each coin.
// A book with no trade in the last 24h (official summary volume 0) gives no price; with none traded in
// 24h the last trade is reported apart, flagged `stale`.
const ltLastTrade = {}; // "BASE/QUOTE" -> { at, data }
async function ltLastTradeAt(pair) {
  const hit = ltLastTrade[pair];
  if (hit && Date.now() - hit.at < 20 * 1000) return hit.data;
  const list = await fetchJson(`https://lunariumtrade.io/api/markets/${encodeURIComponent(pair)}/trades?limit=1`).catch(() => null);
  const t = Array.isArray(list) && list[0] ? Date.parse(String(list[0].created_at).replace(' ', 'T') + 'Z') : NaN;
  const data = Number.isFinite(t) ? t : null;
  ltLastTrade[pair] = { at: Date.now(), data };
  return data;
}
app.get('/api/ticker/lunariumcross', async (req, res) => {
  try {
    const pair = String(req.query.pair || '').toUpperCase();
    if (!/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/.test(pair)) return res.status(400).json({ ok: false, error: 'pair must be BASE/QUOTE' });
    const [a, b] = pair.split('/');
    // the direction shown: X priced in Y
    const [X, Y] = req.query.invert === '1' ? [b, a] : [a, b];
    const summary = await ltSummary();
    const pos = (v) => { const n = num(v); return n > 0 ? n : null; };
    const inv = (v) => (v > 0 ? 1 / v : null);
    const books = [];
    for (const [base, quote] of [[X, Y], [Y, X]]) {
      const t = summary[`${base}_${quote}`];
      if (!t) continue;
      const flip = base !== X; // this book is quoted the other way round
      const last = pos(t.last_price), bid = pos(t.highest_bid), ask = pos(t.lowest_ask);
      const baseVol = safeNum(t.base_volume), quoteVol = safeNum(t.quote_volume);
      const traded = last != null && quoteVol > 0; // the summary covers the last 24h
      const change = traded ? num(t.price_change_percent_24h) : null;
      books.push({
        pair: `${base}/${quote}`,
        last: flip ? inv(last) : last,
        bid: flip ? inv(ask) : bid,
        ask: flip ? inv(bid) : ask,
        volX: flip ? quoteVol : baseVol,
        volY: flip ? baseVol : quoteVol,
        traded,
        change: change == null ? null : (flip ? (change > -100 ? (1 / (1 + change / 100) - 1) * 100 : null) : change),
        lastAt: last != null ? await ltLastTradeAt(`${base}/${quote}`) : null,
      });
    }
    if (!books.length) return res.status(404).json({ ok: false, error: 'pair not listed on LunariumTrade' });
    const newest = (list) => list.slice().sort((p, q) => (q.lastAt || 0) - (p.lastAt || 0))[0] || null;
    const live = newest(books.filter((k) => k.traded));
    const latest = newest(books.filter((k) => k.last != null));
    const bids = books.map((k) => k.bid).filter((v) => v > 0);
    const asks = books.map((k) => k.ask).filter((v) => v > 0);
    res.json({
      ok: true,
      cross: true,
      price: null, // no USDT price: the pair is shown in its own units
      base: X,
      quote: Y,
      pair_price: live ? live.last : null,
      pair_bid: bids.length ? Math.max(...bids) : null,
      pair_ask: asks.length ? Math.min(...asks) : null,
      change: live ? live.change : null,
      base_volume: books.reduce((t, k) => t + k.volX, 0),
      quote_volume: books.reduce((t, k) => t + k.volY, 0),
      stale: !live && !!latest,
      last_pair_price: latest ? latest.last : null,
      last_trade_at: latest && latest.lastAt ? new Date(latest.lastAt).toISOString() : null,
      traded_pair: (live || latest || books[0]).pair,
      books: books.map((k) => k.pair),
    });
  } catch (e) { sendError(res, e); }
});
app.get('/api/klines/lunariumcross', (req, res) => { res.json({ ok: true, closes: [], candles: [] }); });

// Qutrade ticker: official /api/v1/market_data/ — price/ask/bid, 24h trend (%) and quote volume
app.get('/api/ticker/qutrade', async (req, res) => {
  try {
    const pair = (req.query.symbol || 'XLN_USDT').toLowerCase();
    const data = await fetchJson(`https://qutrade.io/api/v1/market_data/?pair=${pair}`);
    const m = data.list && data.list[pair];
    res.json({
      ok: true,
      price: m && m.price != null ? parseFloat(m.price) : null,
      bid: m && m.bid != null ? parseFloat(m.bid) : null,
      ask: m && m.ask != null ? parseFloat(m.ask) : null,
      change: m && m.trend != null ? parseFloat(m.trend) : null,
      volume: m && m.asset_2_volume != null ? safeNum(m.asset_2_volume) : null,
    });
  } catch (e) { sendError(res, e); }
});

// A Qutrade pair quoted in another coin (XLNFT/XLN), live from Qutrade's official market data and in
// the pair's own units, with no USDT value -- the same answer as the LunariumTrade cross ticker
// above. invert=1 reads the market the other way round (price, bid and ask inverted, volumes swapped).
app.get('/api/ticker/qutradecross', async (req, res) => {
  try {
    const pair = String(req.query.pair || '').toUpperCase();
    if (!/^[A-Z0-9]{2,12}\/[A-Z0-9]{2,12}$/.test(pair)) return res.status(400).json({ ok: false, error: 'pair must be BASE/QUOTE' });
    const [base, quote] = pair.split('/');
    const key = `${base}_${quote}`.toLowerCase();
    const data = await fetchJson(`https://qutrade.io/api/v1/market_data/?pair=${key}`);
    const m = data && data.list && data.list[key];
    if (!m) return res.status(404).json({ ok: false, error: 'pair not listed on Qutrade' });
    const pos = (v) => { const n = num(v); return n > 0 ? n : null; };
    const inv = (v) => (v > 0 ? 1 / v : null);
    const invert = req.query.invert === '1';
    const last = pos(m.price);
    const bid = pos(m.bid);
    const ask = pos(m.ask);
    const baseVolume = safeNum(m.asset_1_volume);
    const quoteVolume = safeNum(m.asset_2_volume);
    const traded = last != null && (quoteVolume > 0 || num(m.trades) > 0); // Qutrade's figures cover 24h
    const change = traded ? num(m.trend) : null;
    res.json({
      ok: true,
      cross: true,
      price: null, // no USDT price: the pair is shown in its own units
      base: invert ? quote : base,
      quote: invert ? base : quote,
      pair_price: traded ? (invert ? inv(last) : last) : null,
      pair_bid: invert ? inv(ask) : bid,
      pair_ask: invert ? inv(bid) : ask,
      change: change == null ? null : (invert ? (change > -100 ? (1 / (1 + change / 100) - 1) * 100 : null) : change),
      base_volume: invert ? quoteVolume : baseVolume,
      quote_volume: invert ? baseVolume : quoteVolume,
      stale: !traded && last != null,
      last_pair_price: invert ? inv(last) : last,
      last_trade_at: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : null,
      traded_pair: pair,
    });
  } catch (e) { sendError(res, e); }
});
app.get('/api/klines/qutradecross', (req, res) => { res.json({ ok: true, closes: [], candles: [] }); });

// XLN network stats: the official Lunarium explorer (explorerxln.com API v1)
app.get('/api/network/xln', async (req, res) => {
  try {
    const s = await fetchJson(`${XLN_EXPLORER}/api/v1/stats`);
    const mn = s.masternodes || {};
    res.json({
      ok: true,
      blockCount: s.height != null ? Number(s.height) : null,
      difficulty: s.difficulty != null ? parseFloat(s.difficulty) : null,
      connections: s.connections != null ? Number(s.connections) : null,
      supply: s.supply != null ? parseFloat(s.supply) : null,
      masternodesOnline: mn.enabled != null ? Number(mn.enabled) : null,
      masternodesOffline: mn.total != null && mn.enabled != null ? Number(mn.total) - Number(mn.enabled) : null,
    });
  } catch (e) { sendError(res, e); }
});

// GVIA network stats: same eIquidus explorer software as XLN, pure PoW (no masternodes, has hashrate instead)
app.get('/api/network/gvia', async (req, res) => {
  try {
    const s = await fetchJson('https://explorer.gatevia.io/ext/getsummary');
    res.json({
      ok: true,
      blockCount: s.blockcount != null ? Number(s.blockcount) : null,
      difficulty: s.difficulty != null ? parseFloat(s.difficulty) : null,
      connections: s.connections != null ? Number(s.connections) : null,
      supply: s.supply != null ? parseFloat(s.supply) : null,
      hashrate: s.hashrate != null ? parseFloat(s.hashrate) : null,
    });
  } catch (e) { sendError(res, e); }
});

// PIVX network: the official explorer (explorer.pivx.org, Blockbook-compatible) for height,
// difficulty, core version, masternode counts, block times and the latest block's reward split;
// chainz.cryptoid.info for circulating supply and connected nodes. Cached 5 min (cryptoid's free
// API is rate limited). Masternode ROI and locked supply are derived, not quoted: a masternode
// needs 10,000 PIV collateral and each block pays one masternode.
const PIVX_MN_COLLATERAL = 10000;
const PIVX_NETWORK_TTL_MS = 5 * 60 * 1000;
let pivxNetworkCache = null;

async function buildPivxNetwork() {
  const [info, mn, supply, nodes] = await Promise.all([
    fetchJson('https://explorer.pivx.org/api/v2'),
    fetchJson('https://explorer.pivx.org/api/v2/mncount'),
    fetchJson('https://chainz.cryptoid.info/pivx/api.dws?q=circulating'),
    fetchJson('https://chainz.cryptoid.info/pivx/api.dws?q=nodes').catch(() => null),
  ]);
  const height = Number(info.backend.blocks);
  const [tip, dayAgo] = await Promise.all([
    fetchJsonRetry(`https://explorer.pivx.org/api/v2/block/${height}`),
    fetchJsonRetry(`https://explorer.pivx.org/api/v2/block/${height - 1440}`),
  ]);
  // Coinstake (2nd tx): outputs back to the staker's own addresses minus its input = staking
  // reward; every other output is the masternode payment. Values are in satoshis (1e-8 PIV).
  let stakeReward = null;
  let masternodeReward = null;
  const coinstake = tip.txs && tip.txs[1];
  if (coinstake && coinstake.vin && coinstake.vin[0] && coinstake.vin[0].addresses) {
    const stakerAddrs = new Set(coinstake.vin[0].addresses);
    const inSat = coinstake.vin.reduce((s, v) => s + Number(v.value || 0), 0);
    let toStaker = 0;
    let toOthers = 0;
    coinstake.vout.forEach((v) => {
      const sat = Number(v.value || 0);
      if ((v.addresses || []).some((a) => stakerAddrs.has(a))) toStaker += sat; else toOthers += sat;
    });
    stakeReward = (toStaker - inSat) / 1e8;
    masternodeReward = toOthers / 1e8;
  }
  const avgBlockTime = (tip.time - dayAgo.time) / 1440;
  const circulating = num(supply);
  const enabled = Number(mn.enabled);
  const blocksPerYear = avgBlockTime > 0 ? (365 * 86400) / avgBlockTime : null;
  const peerVersions = {};
  (Array.isArray(nodes) ? nodes : []).forEach((g) => {
    const m = String(g.subver || '').match(/(\d+\.\d+\.\d+)/);
    const v = m ? m[1] : 'other';
    peerVersions[v] = (peerVersions[v] || 0) + (g.nodes || []).length;
  });
  const coreMatch = String(info.backend.subversion || '').match(/(\d+\.\d+\.\d+)/);
  return {
    ok: true,
    blockCount: height,
    difficulty: num(info.backend.difficulty),
    supply: circulating,
    connections: Object.values(peerVersions).reduce((s, n) => s + n, 0) || null,
    peerVersions,
    coreVersion: coreMatch ? coreMatch[1] : null,
    masternodesOnline: enabled,
    masternodesTotal: Number(mn.total),
    masternodesStable: Number(mn.stable),
    masternodesIpv4: Number(mn.ipv4),
    masternodesIpv6: Number(mn.ipv6),
    masternodesOnion: Number(mn.onion),
    avgBlockTime,
    stakeReward,
    masternodeReward,
    masternodeRoiPct: masternodeReward != null && blocksPerYear && enabled > 0 ? ((masternodeReward * blocksPerYear) / enabled / PIVX_MN_COLLATERAL) * 100 : null,
    lockedPct: circulating > 0 ? ((enabled * PIVX_MN_COLLATERAL) / circulating) * 100 : null,
  };
}

async function getPivxNetwork() {
  if (pivxNetworkCache && Date.now() - pivxNetworkCache.at < PIVX_NETWORK_TTL_MS) return pivxNetworkCache.data;
  try {
    const data = await buildPivxNetwork();
    pivxNetworkCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    if (pivxNetworkCache) return pivxNetworkCache.data;
    throw e;
  }
}

app.get('/api/network/pivx', async (req, res) => {
  try {
    res.json(await getPivxNetwork());
  } catch (e) {
    sendError(res, e);
  }
});
// ---- PIVX Auditoria: latest reading + difficulty/supply history sampled every 20min (same
// retention as XLN's). On first run the history is backfilled from the chain itself -- one block
// per day for the last 30 days and one every 4h for the last 7 -- so the difficulty chart starts
// with real data instead of empty.
const PIVX_AUDIT_FILE = path.join(__dirname, 'data', 'pivx-audit-history.json');

// PIVX emission cap, straight from PIVX-Project/PIVX consensus code:
//  - GetBlockValue (src/validation.cpp): 60,001 premine at block 1, then the height schedule below.
//  - GetTotalBudget (src/budget/budgetmanager.cpp): each superblock (every nBudgetCycleBlocks =
//    43,200 blocks) may mint up to GetBlockValue(h) * 43,200 for the treasury -- 20% of that before
//    the V5.5 upgrade (height 3,715,200), 100% after.
// The cap is the maximum the protocol allows; real supply sits below it because PoS fees are burned
// and treasury budget that isn't approved/paid is never minted.
const PIVX_BLOCK_VALUE_SEGMENTS = [
  [2, 86400, 250], [86401, 151200, 225], [151201, 302400, 45], [302401, 345600, 40.5],
  [345601, 388800, 36], [388801, 432000, 31.5], [432001, 475200, 27], [475201, 518400, 22.5],
  [518401, 561600, 18], [561601, 604800, 13.5], [604801, 648000, 9], [648001, 1153160, 4.5],
  [1153161, 3715200, 5], [3715201, Infinity, 10],
];
const PIVX_BUDGET_CYCLE = 43200;
const PIVX_V5_5_HEIGHT = 3715200;
function pivxBlockValue(h) {
  if (h === 1) return 60001;
  for (const [lo, hi, v] of PIVX_BLOCK_VALUE_SEGMENTS) if (h >= lo && h <= hi) return v;
  return 0;
}
function pivxEmissionCap(H) {
  let blocks = H >= 1 ? 60001 : 0;
  for (const [lo, hi, v] of PIVX_BLOCK_VALUE_SEGMENTS) {
    if (H < lo) break;
    blocks += (Math.min(H, hi) - lo + 1) * v;
  }
  let treasury = 0;
  for (let sb = PIVX_BUDGET_CYCLE; sb <= H; sb += PIVX_BUDGET_CYCLE) {
    treasury += (sb <= PIVX_V5_5_HEIGHT ? pivxBlockValue(sb) / 5 : pivxBlockValue(sb)) * PIVX_BUDGET_CYCLE;
  }
  return { blocks, treasury, cap: blocks + treasury };
}
let pivxAuditReading = null;

function readPivxAuditHistory() {
  try { return JSON.parse(fs.readFileSync(PIVX_AUDIT_FILE, 'utf8')); } catch (e) { return []; }
}
function writePivxAuditHistory(history) {
  try {
    fs.mkdirSync(path.dirname(PIVX_AUDIT_FILE), { recursive: true });
    fs.writeFileSync(PIVX_AUDIT_FILE, JSON.stringify(compactAuditHistory(history)));
  } catch (e) {
    console.error('failed to persist pivx audit history', e);
  }
}

async function samplePivxAudit() {
  try {
    const net = await getPivxNetwork();
    const ts = new Date().toISOString();
    const cap = pivxEmissionCap(net.blockCount);
    const deviation = net.supply - cap.cap;
    pivxAuditReading = {
      ts,
      height: net.blockCount,
      supply: net.supply,
      actualSupply: net.supply,
      expectedSupply: cap.cap,
      blockEmission: cap.blocks,
      treasuryMax: cap.treasury,
      deviation,
      deviationPct: cap.cap > 0 ? (deviation / cap.cap) * 100 : 0,
      withinRule: net.supply > 0 && net.supply <= cap.cap,
      difficulty: net.difficulty,
      masternodesOnline: net.masternodesOnline,
      masternodesOffline: Math.max(0, (net.masternodesTotal || 0) - (net.masternodesOnline || 0)),
      lockedPct: net.lockedPct,
      avgBlockTime: net.avgBlockTime,
      coreVersion: net.coreVersion,
      peerVersions: net.peerVersions,
      peerCount: net.connections,
    };
    const history = readPivxAuditHistory();
    history.push({ ts, height: net.blockCount, supply: net.supply, difficulty: net.difficulty });
    writePivxAuditHistory(history);
  } catch (e) {
    console.error('pivx audit sample failed', e && e.message);
  }
}

async function backfillPivxAuditHistory() {
  const existing = readPivxAuditHistory();
  if (existing.length >= 20) return;
  try {
    const tip = Number((await fetchJson(`${PIVX_EXPLORER}/api/v2`)).backend.blocks);
    const perDay = Math.round(86400 / 61.6);
    const heights = [];
    for (let d = 30; d >= 8; d--) heights.push(tip - d * perDay);
    for (let k = 42; k >= 1; k--) heights.push(tip - Math.round((k * perDay) / 6));
    const points = [];
    await mapLimit(heights, 2, async (h) => {
      const b = await fetchJsonRetry(`${PIVX_EXPLORER}/api/v2/block/${h}`);
      const difficulty = num(b.difficulty);
      if (difficulty != null && b.time) points.push({ ts: new Date(b.time * 1000).toISOString(), height: b.height, difficulty });
    });
    writePivxAuditHistory(existing.concat(points).sort((a, b) => new Date(a.ts) - new Date(b.ts)));
  } catch (e) {
    console.error('pivx audit backfill failed', e && e.message);
  }
}

// ---- XLNFT (Lunarium Finance, BEP-20). Supply is read from the contract itself over public BSC
// RPC (fixed 100M at deploy; the contract has burn() but no mint, so anything below 100M was
// burned). Market data comes from the token's most liquid DEX pool via GeckoTerminal once one exists.
const XLNFT_CONTRACT = '0x5a6625B65a917c872ceEc781B6c4419F6aBc8A48';
const XLNFT_INITIAL_SUPPLY = 100000000;
const BSC_RPCS = ['https://bsc-dataseed.binance.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-rpc.publicnode.com'];
const XLNFT_TTL_MS = 60 * 1000;
let xlnftCache = null;

async function bscEthCall(to, data) {
  let lastErr;
  for (const rpc of BSC_RPCS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const r = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
        signal: controller.signal,
      });
      if (!r.ok) throw new Error('rpc status ' + r.status);
      const j = await r.json();
      if (j.error || typeof j.result !== 'string') throw new Error('rpc error ' + JSON.stringify(j.error));
      return j.result;
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function buildXlnftNetwork() {
  // One GeckoTerminal call per refresh: the token's pool listing already carries price/liquidity/
  // volume (their free API is rate limited). On failure the last known pool is reused.
  const [supplyHex, pool] = await Promise.all([
    bscEthCall(XLNFT_CONTRACT, '0x18160ddd'), // totalSupply()
    resolveGtPool('bsc', XLNFT_CONTRACT, XLNFT_TTL_MS).catch(() => null),
  ]);
  const totalSupply = Number(BigInt(supplyHex) / 10n ** 12n) / 1e6; // 18 decimals, kept to 6
  const out = {
    ok: true,
    supply: totalSupply,
    totalSupply,
    burned: Math.max(0, XLNFT_INITIAL_SUPPLY - totalSupply),
    hasPool: false,
  };
  if (pool) {
    const a = pool.attributes;
    if (a) {
      const price = num(pool.baseIsToken ? a.base_token_price_usd : a.quote_token_price_usd);
      Object.assign(out, {
        hasPool: true,
        poolAddress: pool.address,
        poolName: pool.name,
        dex: pool.dex,
        priceUsd: price,
        liquidityUsd: num(a.reserve_in_usd),
        volume24h: num(a.volume_usd && a.volume_usd.h24),
        change24h: num(a.price_change_percentage && a.price_change_percentage.h24),
        fdvUsd: price != null ? price * totalSupply : null,
      });
    }
  }
  return out;
}

app.get('/api/network/xlnft', async (req, res) => {
  if (xlnftCache && Date.now() - xlnftCache.at < XLNFT_TTL_MS) return res.json(xlnftCache.data);
  try {
    const data = await buildXlnftNetwork();
    xlnftCache = { at: Date.now(), data };
    res.json(data);
  } catch (e) {
    if (xlnftCache) return res.json(xlnftCache.data);
    sendError(res, e);
  }
});

// Supply of any BEP-20 token read from the chain (never typed by hand): totalSupply minus what sits
// in the burn addresses (0x…dEaD and 0x0). Cached 10 min per token; a failed read keeps the last one.
const SUPPLY_TTL_MS = 10 * 60 * 1000;
const supplyCache = new Map();
const BURN_ADDRESSES = ['000000000000000000000000000000000000dead', '0000000000000000000000000000000000000000'];
async function tokenSupply(contract) {
  const key = String(contract).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(key)) throw new Error('invalid contract');
  const hit = supplyCache.get(key);
  if (hit && Date.now() - hit.at < SUPPLY_TTL_MS) return hit.data;
  try {
    const [totalHex, decHex, ...burnHex] = await Promise.all([
      bscEthCall(key, '0x18160ddd'),
      bscEthCall(key, '0x313ce567'),
      ...BURN_ADDRESSES.map((a) => bscEthCall(key, '0x70a08231' + a.padStart(64, '0'))),
    ]);
    const decimals = Number(BigInt(decHex));
    const total = BigInt(totalHex);
    const burned = burnHex.reduce((s, h) => s + BigInt(h), 0n);
    const toNum = (v) => (decimals > 4 ? Number(v / 10n ** BigInt(decimals - 4)) / 1e4 : Number(v) / 10 ** decimals);
    const data = { ok: true, contract: key, decimals, total_supply: toNum(total), burned: toNum(burned), supply: toNum(total - burned), source: 'BNB Chain', at: new Date().toISOString() };
    if (supplyCache.size > 300) supplyCache.clear();
    supplyCache.set(key, { at: Date.now(), data });
    return data;
  } catch (e) {
    if (hit) return hit.data;
    throw e;
  }
}
app.get('/api/token-supply', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(await tokenSupply(String(req.query.token || '')));
  } catch (e) { sendError(res, e); }
});

app.get('/api/network/pivx-audit', (req, res) => {
  if (!pivxAuditReading) return res.json({ ok: false, error: 'not sampled yet' });
  // Supply points get the cap for their height; backfilled (difficulty-only) points have no supply.
  const history = readPivxAuditHistory().map((p) => (p.supply != null
    ? Object.assign({}, p, { actualSupply: p.supply, expectedSupply: pivxEmissionCap(p.height).cap })
    : p));
  res.json({ ok: true, reading: pivxAuditReading, history });
});

backfillPivxAuditHistory().then(samplePivxAudit);
setInterval(samplePivxAudit, 20 * 60 * 1000);


// ---- MoneyByte network: the project's own explorer (Iquidus API over the node's RPC) for height,
// supply, PoS difficulty, wallet version, peers and the masternode list; block times and the latest
// block's reward split are read from the blocks themselves. Cached 5 min. Masternode ROI and locked
// supply are derived: a masternode needs 50,000 MON (GetMNCollateral, src/main.h).
const MON_NETWORK_TTL_MS = 5 * 60 * 1000;
let monNetworkCache = null;
async function buildMonNetwork() {
  const [info, mn, peers] = await Promise.all([
    fetchJson(`${MON_EXPLORER}/api/getinfo`),
    monMasternodes(),
    fetchJson(`${MON_EXPLORER}/api/getpeerinfo`).catch(() => null),
  ]);
  const height = Number(info.blocks);
  if (!(height > 0)) throw new Error('bad moneybyte height');
  const [tip, dayAgo] = await Promise.all([monBlock(height), monBlock(height - 720)]);
  const split = await monBlockSplit(height).catch(() => null);
  const avgBlockTime = (tip.time - dayAgo.time) / 720;
  const supply = num(info.moneysupply);
  const blocksPerYear = avgBlockTime > 0 ? (365 * 86400) / avgBlockTime : null;
  const masternodeReward = split ? split.masternode : null;
  const peerVersions = {};
  (Array.isArray(peers) ? peers : []).forEach((p) => {
    const m = String((p && p.subver) || '').match(/(\d+(?:\.\d+){2,3})/);
    const v = m ? m[1] : 'other';
    peerVersions[v] = (peerVersions[v] || 0) + 1;
  });
  const core = String(info.version || '').match(/(\d+(?:\.\d+){2,3})/);
  return {
    ok: true,
    blockCount: height,
    difficulty: info.difficulty ? num(info.difficulty['proof-of-stake']) : null,
    supply,
    connections: Array.isArray(peers) ? peers.length : num(info.connections),
    peerVersions,
    coreVersion: core ? core[1] : null,
    masternodesOnline: mn.enabled,
    masternodesTotal: mn.total,
    avgBlockTime,
    stakeReward: split ? split.stake : null,
    masternodeReward,
    masternodeRoiPct: masternodeReward != null && blocksPerYear && mn.enabled > 0 ? ((masternodeReward * blocksPerYear) / mn.enabled / MON_MN_COLLATERAL) * 100 : null,
    lockedPct: supply > 0 ? ((mn.enabled * MON_MN_COLLATERAL) / supply) * 100 : null,
  };
}
async function getMonNetwork() {
  if (monNetworkCache && Date.now() - monNetworkCache.at < MON_NETWORK_TTL_MS) return monNetworkCache.data;
  try {
    const data = await buildMonNetwork();
    monNetworkCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    if (monNetworkCache) return monNetworkCache.data;
    throw e;
  }
}
app.get('/api/network/mon', async (req, res) => {
  try {
    res.json(await getMonNetwork());
  } catch (e) {
    sendError(res, e);
  }
});

// ---- MoneyByte Auditoria: supply vs the emission cap, straight from the consensus code
// (MoneyByte/MoneyByteBlockchain src/main.cpp):
//  - GetProofOfWorkReward / GetProofOfStakeReward: 5,000,000 MON created at block 2; up to block
//    49,999 PoW and PoS blocks shared the chain with different rewards per height range (the cap takes
//    the higher of the two for each height); from block 50,000 every block pays STATIC_POS_REWARD
//    (2.29999999 MON; PoW ended at block 50,200 paying 1 MON, below that).
//  - fDevFee / nDevFee: 8,760 MON to the foundation address every 43,800 blocks.
// MAX_MONEY (src/main.h) is 32,220,000 MON. The cap is the most the protocol allows at a height; the
// real supply sits below it by what the early PoW/PoS mix left unminted (checked against the chain:
// the gap has been constant since block 50,201).
const MON_AUDIT_FILE = path.join(__dirname, 'data', 'mon-audit-history.json');
const MON_PREMINE = 5000000;
const MON_BLOCK_VALUE_SEGMENTS = [
  [1, 1, 1], [3, 199, 1], [200, 9999, 2.5], [10000, 19999, 2], [20000, 29999, 1.5], [30000, 39999, 2], [40000, 49999, 2.5], [50000, Infinity, MON_BLOCK_VALUE],
];
const MON_FOUNDATION_CYCLE = 43800;
const MON_FOUNDATION_FEE = 8760;
function monEmissionCap(H) {
  let blocks = H >= 2 ? MON_PREMINE : 0;
  for (const [lo, hi, v] of MON_BLOCK_VALUE_SEGMENTS) {
    if (H < lo) break;
    blocks += (Math.min(H, hi) - lo + 1) * v;
  }
  const treasury = Math.floor(H / MON_FOUNDATION_CYCLE) * MON_FOUNDATION_FEE;
  return { blocks, treasury, cap: blocks + treasury };
}
let monAuditReading = null;
function readMonAuditHistory() {
  try { return JSON.parse(fs.readFileSync(MON_AUDIT_FILE, 'utf8')); } catch (e) { return []; }
}
function writeMonAuditHistory(history) {
  try {
    fs.mkdirSync(path.dirname(MON_AUDIT_FILE), { recursive: true });
    fs.writeFileSync(MON_AUDIT_FILE, JSON.stringify(compactAuditHistory(history)));
  } catch (e) {
    console.error('failed to persist mon audit history', e);
  }
}
async function sampleMonAudit() {
  try {
    const net = await getMonNetwork();
    const ts = new Date().toISOString();
    const cap = monEmissionCap(net.blockCount);
    const deviation = net.supply - cap.cap;
    monAuditReading = {
      ts,
      height: net.blockCount,
      supply: net.supply,
      actualSupply: net.supply,
      expectedSupply: cap.cap,
      blockEmission: cap.blocks,
      treasuryMax: cap.treasury,
      maxSupply: 32220000,
      deviation,
      deviationPct: cap.cap > 0 ? (deviation / cap.cap) * 100 : 0,
      withinRule: net.supply > 0 && net.supply <= cap.cap,
      difficulty: net.difficulty,
      masternodesOnline: net.masternodesOnline,
      masternodesOffline: Math.max(0, (net.masternodesTotal || 0) - (net.masternodesOnline || 0)),
      lockedPct: net.lockedPct,
      avgBlockTime: net.avgBlockTime,
      coreVersion: net.coreVersion,
      peerVersions: net.peerVersions,
      peerCount: net.connections,
    };
    const history = readMonAuditHistory();
    history.push({ ts, height: net.blockCount, supply: net.supply, difficulty: net.difficulty });
    writeMonAuditHistory(history);
  } catch (e) {
    console.error('mon audit sample failed', e && e.message);
  }
}
// First run: the history is backfilled from the chain itself (each block carries the supply and the
// difficulty at its height) -- one block per day for the last 30 days, one every 4h for the last 7.
async function backfillMonAuditHistory() {
  const existing = readMonAuditHistory();
  if (existing.length >= 20) return;
  try {
    const tip = Number(await fetchText(`${MON_EXPLORER}/api/getblockcount`));
    const perDay = 720;
    const heights = [];
    for (let d = 30; d >= 8; d--) heights.push(tip - d * perDay);
    for (let k = 42; k >= 1; k--) heights.push(tip - Math.round((k * perDay) / 6));
    const points = [];
    await mapLimit(heights, 2, async (h) => {
      const b = await monBlock(h);
      const difficulty = num(b.difficulty);
      const supply = num(b.moneysupply);
      if (/proof-of-stake/.test(String(b.flags)) && difficulty != null && supply != null && b.time) points.push({ ts: new Date(b.time * 1000).toISOString(), height: Number(b.height), supply, difficulty });
    });
    writeMonAuditHistory(existing.concat(points).sort((a, b) => new Date(a.ts) - new Date(b.ts)));
  } catch (e) {
    console.error('mon audit backfill failed', e && e.message);
  }
}
app.get('/api/network/mon-audit', (req, res) => {
  if (!monAuditReading) return res.json({ ok: false, error: 'not sampled yet' });
  const history = readMonAuditHistory().map((p) => (p.supply != null
    ? Object.assign({}, p, { actualSupply: p.supply, expectedSupply: monEmissionCap(p.height).cap })
    : p));
  res.json({ ok: true, reading: monAuditReading, history });
});
backfillMonAuditHistory().then(sampleMonAudit);
setInterval(sampleMonAudit, 20 * 60 * 1000);

// ---- Nodestats network: the project's own explorer (explorer.nodestats.info) for height, PoS
// difficulty, masternodes, peers and the balance of the burn address; block times and the latest
// block's reward split are read from the blocks themselves. Cached 5 min. The supply is the sum of
// the blocks (coinexplorer.net, read by the audit below) when there is a reading from the last 2 hours,
// otherwise the explorer's own figure; circulating = that total minus the burned coins.
const NS_NETWORK_TTL_MS = 5 * 60 * 1000;
let nsNetworkCache = null;
let nsChainSupply = null; // { height, supply, at } -- latest block-by-block total
async function buildNsNetwork() {
  const [sum, mn, peers, burnText] = await Promise.all([
    fetchJson(`${NS_EXPLORER}/ext/getsummary`),
    nsMasternodes(),
    fetchJson(`${NS_EXPLORER}/ext/getnetworkpeers`).catch(() => null),
    fetchText(`${NS_EXPLORER}/ext/getbalance/${NS_BURN_ADDRESS}`),
  ]);
  const height = Number(sum.blockcount);
  if (!(height > 0)) throw new Error('bad nodestats height');
  const burned = num(String(burnText).replace(/"/g, ''));
  if (burned == null) throw new Error('bad nodestats burn balance');
  const [tip, dayAgo] = await Promise.all([nsBlock(height), nsBlock(height - 1440)]);
  const split = await nsBlockSplit(height).catch(() => null);
  const avgBlockTime = (tip.time - dayAgo.time) / 1440;
  const officialSupply = num(sum.supply);
  const chain = nsChainSupply && Date.now() - nsChainSupply.at < 2 * 3600 * 1000 ? nsChainSupply : null;
  const totalSupply = chain ? chain.supply : officialSupply;
  const supply = totalSupply != null ? totalSupply - burned : null;
  const blocksPerYear = avgBlockTime > 0 ? (365 * 86400) / avgBlockTime : null;
  const masternodeReward = split ? split.masternode : null;
  const peerList = Array.isArray(peers) ? peers : [];
  const peerVersions = {};
  peerList.forEach((p) => {
    const m = String((p && p.version) || '').match(/(\d+(?:\.\d+){2,3})/);
    const v = m ? m[1] : 'other';
    peerVersions[v] = (peerVersions[v] || 0) + 1;
  });
  const coreVersion = Object.keys(peerVersions).filter((v) => v !== 'other').sort((a, b) => peerVersions[b] - peerVersions[a])[0] || null;
  return {
    ok: true,
    blockCount: height,
    difficulty: num(sum.difficulty),
    supply,
    totalSupply,
    supplySource: chain ? 'coinexplorer.net' : 'explorer.nodestats.info',
    officialSupply,
    burned,
    burnAddress: NS_BURN_ADDRESS,
    connections: num(sum.connections),
    peerCount: peerList.length,
    peerVersions,
    coreVersion,
    masternodesOnline: mn.enabled,
    masternodesTotal: mn.total,
    avgBlockTime,
    blockReward: nsBlockValue(height + 1),
    stakeReward: split ? split.stake : null,
    masternodeReward,
    masternodeRoiPct: masternodeReward != null && blocksPerYear && mn.enabled > 0 ? ((masternodeReward * blocksPerYear) / mn.enabled / NS_MN_COLLATERAL) * 100 : null,
    lockedPct: supply > 0 ? ((mn.enabled * NS_MN_COLLATERAL) / supply) * 100 : null,
  };
}
async function getNsNetwork() {
  if (nsNetworkCache && Date.now() - nsNetworkCache.at < NS_NETWORK_TTL_MS) return nsNetworkCache.data;
  try {
    const data = await buildNsNetwork();
    nsNetworkCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    if (nsNetworkCache) return nsNetworkCache.data;
    throw e;
  }
}
app.get('/api/network/ns', async (req, res) => {
  try {
    res.json(await getNsNetwork());
  } catch (e) {
    sendError(res, e);
  }
});

// ---- Nodestats Auditoria: supply vs the emission cap of CMasternode::GetBlockValue.
// The node's running supply counter (what explorer.nodestats.info shows) is not the sum of the
// blocks: on 2026-10-15 it was ~1,120 NS above it, and above the cap. The audit therefore reads the
// supply coinexplorer.net computes block by block (supplyOnBlock) -- checked at heights 250, 1,000,
// 300,000, 685,001, 1,000,001, 2,000,000 and 2,900,000: always at or below the cap, the gap growing
// only by the fees of stake blocks, which the code destroys. coinexplorer.net limits its API to about
// one call every few seconds, so its calls go one at a time, 8 s apart.
const NS_AUDIT_FILE = path.join(__dirname, 'data', 'ns-audit-history.json');
const NS_AUDIT_STATE_FILE = path.join(__dirname, 'data', 'ns-audit-state.json');
const NS_AUDIT_BACKFILL_LOCK = path.join(__dirname, 'data', 'ns-audit-backfill.lock');
const NS_CHAIN_API = 'https://www.coinexplorer.net/api/v1/NS';
function nsEmissionCap(H) {
  let cap = 0;
  for (const [lo, hi, v] of NS_BLOCK_VALUE_SEGMENTS) {
    if (H < lo) break;
    cap += (Math.min(H, hi) - lo + 1) * v;
  }
  return cap;
}
let nsChainQueue = Promise.resolve();
function nsChainBlock(height) {
  const run = nsChainQueue.then(async () => {
    try {
      const d = await fetchJson(height ? `${NS_CHAIN_API}/block?height=${height}` : `${NS_CHAIN_API}/block/latest`);
      const b = d && d.success && d.result;
      const supply = b ? num(b.supplyOnBlock) : null;
      if (!b || !(supply > 0) || !(Number(b.height) > 0)) throw new Error('coinexplorer: ' + ((d && d.error) || 'no block'));
      return { height: Number(b.height), supply, difficulty: num(b.difficulty), time: Date.parse(String(b.time).replace(' ', 'T') + 'Z') };
    } finally {
      await new Promise((r) => setTimeout(r, 8000));
    }
  });
  nsChainQueue = run.catch(() => {});
  return run;
}
let nsAuditReading = null;
function readNsAuditHistory() {
  try { return JSON.parse(fs.readFileSync(NS_AUDIT_FILE, 'utf8')); } catch (e) { return []; }
}
function writeNsAuditHistory(history) {
  try {
    fs.mkdirSync(path.dirname(NS_AUDIT_FILE), { recursive: true });
    fs.writeFileSync(NS_AUDIT_FILE, JSON.stringify(compactAuditHistory(history)));
  } catch (e) {
    console.error('failed to persist ns audit history', e);
  }
}
// The hosting runs more than one app process: the last reading is kept on disk too, so a process
// whose own sample failed still answers with the latest one (its age shows if sampling stopped).
function latestNsAuditReading() {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(NS_AUDIT_STATE_FILE, 'utf8')).reading; } catch (e) { /* none yet */ }
  if (!nsAuditReading) return saved;
  return saved && Date.parse(saved.ts) > Date.parse(nsAuditReading.ts) ? saved : nsAuditReading;
}
async function sampleNsAudit() {
  try {
    const chain = await nsChainBlock();
    nsChainSupply = { height: chain.height, supply: chain.supply, at: Date.now() };
    nsNetworkCache = null;
    const net = await getNsNetwork();
    const ts = new Date().toISOString();
    const cap = nsEmissionCap(chain.height);
    const deviation = chain.supply - cap;
    // the explorer's figure against the cap at its own height, minus the same for the sum of the blocks
    const officialOffset = net.officialSupply != null ? (net.officialSupply - nsEmissionCap(net.blockCount)) - deviation : null;
    nsAuditReading = {
      ts,
      height: chain.height,
      supply: chain.supply,
      actualSupply: chain.supply,
      expectedSupply: cap,
      blockEmission: cap,
      treasuryMax: null,
      maxSupply: null,
      deviation,
      deviationPct: cap > 0 ? (deviation / cap) * 100 : 0,
      withinRule: chain.supply > 0 && chain.supply <= cap + 1e-8,
      burned: net.burned,
      circulating: chain.supply - net.burned,
      officialSupply: net.officialSupply,
      officialHeight: net.blockCount,
      officialOffset,
      blockReward: nsBlockValue(chain.height + 1),
      difficulty: chain.difficulty != null ? chain.difficulty : net.difficulty,
      masternodesOnline: net.masternodesOnline,
      masternodesOffline: Math.max(0, (net.masternodesTotal || 0) - (net.masternodesOnline || 0)),
      lockedPct: net.lockedPct,
      avgBlockTime: net.avgBlockTime,
      coreVersion: net.coreVersion,
      peerVersions: net.peerVersions,
      peerCount: net.peerCount,
    };
    try {
      fs.mkdirSync(path.dirname(NS_AUDIT_STATE_FILE), { recursive: true });
      fs.writeFileSync(NS_AUDIT_STATE_FILE, JSON.stringify({ reading: nsAuditReading }));
    } catch (e) { console.error('failed to persist ns audit reading', e && e.message); }
    const history = readNsAuditHistory();
    history.push({ ts, height: chain.height, supply: chain.supply, difficulty: nsAuditReading.difficulty });
    writeNsAuditHistory(history);
  } catch (e) {
    console.error('ns audit sample failed', e && e.message);
  }
}
// First run: the history is backfilled from the chain (one block per day for the last 30 days, one
// every 4h for the last 7), each with the supply and difficulty at its height. Only one process does
// it (claim file), since coinexplorer.net limits how often it may be called.
async function backfillNsAuditHistory() {
  if (readNsAuditHistory().length >= 20) return;
  try {
    const fd = fs.openSync(NS_AUDIT_BACKFILL_LOCK, 'wx');
    fs.closeSync(fd);
  } catch (e) {
    try { if (Date.now() - fs.statSync(NS_AUDIT_BACKFILL_LOCK).mtimeMs < 3600 * 1000) return; } catch (e2) { return; }
    try { fs.utimesSync(NS_AUDIT_BACKFILL_LOCK, new Date(), new Date()); } catch (e3) { return; }
  }
  try {
    const tip = Number(await fetchText(`${NS_EXPLORER}/api/getblockcount`));
    if (!(tip > 0)) throw new Error('bad nodestats height');
    const perDay = 1440;
    const heights = [];
    for (let d = 30; d >= 8; d--) heights.push(tip - d * perDay);
    for (let k = 42; k >= 1; k--) heights.push(tip - Math.round((k * perDay) / 6));
    const points = [];
    for (const h of heights) {
      const b = await nsChainBlock(h).catch(() => null);
      if (b && b.time > 0) points.push({ ts: new Date(b.time).toISOString(), height: b.height, supply: b.supply, difficulty: b.difficulty });
    }
    writeNsAuditHistory(readNsAuditHistory().concat(points).sort((a, b) => new Date(a.ts) - new Date(b.ts)));
  } catch (e) {
    console.error('ns audit backfill failed', e && e.message);
  }
}
app.get('/api/network/ns-audit', (req, res) => {
  const reading = latestNsAuditReading();
  if (!reading) return res.json({ ok: false, error: 'not sampled yet' });
  const history = readNsAuditHistory().map((p) => (p.supply != null
    ? Object.assign({}, p, { actualSupply: p.supply, expectedSupply: nsEmissionCap(p.height) })
    : p));
  res.json({ ok: true, reading, history });
});
sampleNsAudit().then(backfillNsAuditHistory);
setInterval(sampleNsAudit, 20 * 60 * 1000);

app.get('/api/network/:coin-rewards', (req, res) => {
  const c = Object.prototype.hasOwnProperty.call(REWARD_COINS, req.params.coin) ? rewardsCache[req.params.coin] : null;
  if (!c) return res.json({ ok: false, error: 'not computed yet' });
  res.json(c);
});

// XLN network audit: latest reading (compliance check + peer versions) plus history for the
// supply-vs-cap chart. Sampled every 20min by sampleXlnAudit() above, not on every request, since
// the underlying explorer data barely moves and we want a stable point-in-time series for the chart.
app.get('/api/network/xln-audit', (req, res) => {
  if (!xlnAuditCache) return res.json({ ok: false, error: 'not sampled yet' });
  res.json({ ok: true, reading: xlnAuditCache, history: readAuditHistory() });
});

// Visitor counter shown next to the search field. Persisted to disk so it
// survives Passenger restarts. The frontend increments once per browser
// (guarded by localStorage) and just reads the count on every other load.
app.get('/api/visitors', (req, res) => {
  res.json({ ok: true, count: readVisitorCount() });
});

app.get('/api/visitors/increment', (req, res) => {
  const count = readVisitorCount() + 1;
  writeVisitorCount(count);
  res.json({ ok: true, count });
});

// FX rates for the sidebar currency converter (BRL/EUR/etc against USD).
// Cached in memory for 1h since exchange rates barely move and the upstream
// free API shouldn't be hit on every page load / poll.
let fxCache = { at: 0, rates: null };
const FX_CACHE_MS = 60 * 60 * 1000;
app.get('/api/fx', async (req, res) => {
  try {
    if (!fxCache.rates || Date.now() - fxCache.at > FX_CACHE_MS) {
      const data = await fetchJson('https://open.er-api.com/v6/latest/USD');
      if (!data || data.result !== 'success' || !data.rates) throw new Error('fx provider error');
      fxCache = { at: Date.now(), rates: data.rates };
    }
    res.json({ ok: true, base: 'USD', rates: fxCache.rates });
  } catch (e) { sendError(res, e); }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Runs one of this app's own GET routes in-process and resolves with its JSON body (rejects on an
// error status). Lets the public API reuse every route above without an HTTP round trip -- under
// Passenger the app has no reachable local port anyway.
function callRoute(routePath, query = {}) {
  return new Promise((resolve, reject) => {
    const layer = app._router.stack.find((l) => l.route && l.route.methods.get && l.match(routePath));
    if (!layer) return reject(new Error('no route ' + routePath));
    const req = { method: 'GET', url: routePath, path: routePath, query, params: Object.assign({}, layer.params), headers: {}, get: () => undefined };
    let status = 200;
    const res = {
      status(code) { status = code; return res; },
      json(body) {
        if (status >= 400) reject(new Error((body && body.error) || 'status ' + status));
        else resolve(body);
        return res;
      },
      set() { return res; },
      header() { return res; },
      type() { return res; },
      send(body) { if (status >= 400) reject(new Error('status ' + status)); else resolve(body); return res; },
      end() { reject(new Error('empty response')); return res; },
    };
    Promise.resolve(layer.route.stack[0].handle(req, res, (err) => reject(err || new Error('not handled')))).catch(reject);
  });
}

require('./public-api')(app, { callRoute, mapLimit, fetchJson, tokenSupply });
require('./api-accounts').mount(app);
require('./price-alerts')(app);
require('./data-backup')();
require('./listings')(app, { callRoute, bscEthCall, registryIds: () => JSON.parse(fs.readFileSync(path.join(__dirname, 'public-api-coins.json'), 'utf8')).map((c) => c.id) });

require('./major-exchanges')(app, { fetchJson, tfPreset, sendCloses, sendError, num, safeNum, pctChange });
require('./major-audits')(app, { fetchJson, compactAuditHistory });
// XLNFT token audit, read straight from BNB Chain (contract, transfers, PancakeSwap pool, PinkLock)
require('./token-audit-xlnft')(app);
require('./coin-supply')();
require('./exchange-coins')(app, { callRoute, siteIds: () => JSON.parse(fs.readFileSync(path.join(__dirname, 'public-api-coins.json'), 'utf8')).map((c) => c.id) });
require('./exchange-coins-auto')(app, { callRoute });
require('./exchange-listings')(app, { callRoute });
// hourly check of each exchange's trades for automated volume (drives the "volume not verifiable" notice)
require('./exchange-volume-check')(app, { fetchJson, callRoute, mapLimit });
require('./masternode-collateral')(app, { callRoute });
// e-mails the owner when an audited coin's data source, an audit or a site certificate breaks (and when it is back)
require('./health-monitor')(app, { callRoute });
// private admin panel: registered last, so its /:slug route never shadows another route
require('./admin-panel')(app);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});
