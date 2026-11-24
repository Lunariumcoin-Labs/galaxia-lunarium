// XLNFT (Lunarium Finance, BEP-20) audit, read straight from BNB Chain -- nothing is typed by hand.
//
// What is checked, every 20 minutes:
//  - the code at the contract address is still the code compiled from the source published on BscScan
//    (solc 0.8.19, optimizer 200 runs, EVM paris -- compiled and compared byte for byte on 2026-10-15;
//    only the metadata hash at the end differs, as it does for any rebuild). That source has no mint:
//    the 100,000,000 XLNFT were all created by the constructor and the total can only go down
//    (burn / burnFrom). The owner can only transfer or renounce ownership and recover tokens sent to
//    the contract address by mistake (rescueTokens) -- no fee, blacklist, pause or forced transfer;
//  - totalSupply never above the initial supply; burned = initial - totalSupply;
//  - every Transfer since the deployment is replayed into a ledger of balances: the balances must add up
//    to totalSupply and no Transfer may come from address(0) after the constructor's;
//  - the PancakeSwap pool (reserves, price) and its liquidity tokens locked on PinkLock (amount and
//    unlock date read from the locker contract).
//
// Public BSC RPCs only keep logs of the last few thousand blocks (publicnode) or answer 5,000-block
// windows slowly (bloXroute): the ledger is filled once from the deployment and then followed forward.
// One app process at a time writes it (claim file); every process reads it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONTRACT = '0x5a6625b65a917c872ceec781b6c4419f6abc8a48';
const DEPLOY_BLOCK = 123848696; // block of the contract creation (first log: OwnershipTransferred + the 100M mint)
const INITIAL_SUPPLY = 100000000n * 10n ** 18n; // INITIAL_SUPPLY() of the contract
const CODE_SHA256 = 'b574e5482230d419b00f8c2632e00dbb23dd36d6a1c6db1adccf7c72b00e597d'; // sha256 of eth_getCode (hex, lower case)
const PAIR = '0x66a9638e23c6e48c35d8def0fb311a6dc8a77b69'; // PancakeSwap V2 XLNFT/USDT
const PINKLOCK = '0x407993575c91ce7643a4d4ccacc9a98c36ee1bbe'; // PinkLock V2
const DEAD = '0x000000000000000000000000000000000000dead';
const ZERO = '0x0000000000000000000000000000000000000000';
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEPLOYED_AT = '2026-09-24T23:56:28.000Z'; // timestamp of DEPLOY_BLOCK
const SOURCE_URL = 'https://bscscan.com/address/0x5a6625B65a917c872ceEc781B6c4419F6aBc8A48#code';

const READ_RPCS = ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.binance.org', 'https://bsc-dataseed1.defibit.io'];
const RECENT_LOGS_RPC = 'https://bsc-rpc.publicnode.com'; // last ~5,000 blocks only
const OLD_LOGS_RPC = 'https://bsc.rpc.blxrbdn.com'; // older blocks, 5,000-block windows, slow
const WINDOW = 5000;

const DATA = path.join(__dirname, 'data');
const LEDGER_FILE = path.join(DATA, 'xlnft-ledger.json');
const LEDGER_LOCK = path.join(DATA, 'xlnft-ledger.lock');
const STATE_FILE = path.join(DATA, 'xlnft-audit-state.json');
const HISTORY_FILE = path.join(DATA, 'xlnft-audit-history.json');

const hex = (n) => '0x' + n.toString(16);
const word = (s, i) => s.slice(2 + i * 64, 2 + (i + 1) * 64);
const pad = (v) => BigInt(v).toString(16).padStart(64, '0');
const padAddr = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const addrOf = (w) => '0x' + w.slice(24);
const units = (wei) => Number(wei / 10n ** 12n) / 1e6; // 18 decimals, kept to 6
const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);

async function rpc(url, method, params, timeoutMs = 30000) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(method + ': status ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error(method + ': ' + JSON.stringify(j.error).slice(0, 160));
  return j.result;
}
async function read(method, params) {
  let last;
  for (const url of READ_RPCS) {
    try { return await rpc(url, method, params, 15000); } catch (e) { last = e; }
  }
  throw last;
}
const ethCall = (to, data) => read('eth_call', [{ to, data }, 'latest']);
const SEL = {
  totalSupply: '0x18160ddd', balanceOf: '0x70a08231', owner: '0x8da5cb5b', getReserves: '0x0902f1ac', token0: '0x0dfe1681',
  totalLockCountForToken: '0xe3676f88', getLocksForToken: '0x332f26d7',
};
const balanceOf = async (token, who) => BigInt(await ethCall(token, SEL.balanceOf + padAddr(who)));

// ---------------------------------------------------------------- ledger of every Transfer
function emptyLedger(liveFrom) {
  return {
    deployBlock: DEPLOY_BLOCK,
    backfillNext: DEPLOY_BLOCK, // next block of the history still to read
    liveFrom, // first block followed live (the history ends just before it)
    scannedTo: liveFrom - 1, // last block read on the live side
    balances: {},
    transfers: 0,
    mints: [], // Transfer from address(0): the constructor's, and any other would break the rule
    burned: '0',
    daily: {},
    updatedAt: null,
  };
}
function readLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')); } catch (e) { return null; }
}
function writeLedger(l) {
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = LEDGER_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(l));
  fs.renameSync(tmp, LEDGER_FILE);
}
// Adds a batch of Transfer logs. Additions commute, so the history and the live side can be read in
// any order as long as no block is read twice (the two cursors never overlap).
async function applyLogs(l, logs) {
  const transfers = logs.filter((g) => g.topics && g.topics[0] === TOPIC_TRANSFER && g.topics.length === 3);
  if (!transfers.length) return;
  const times = {};
  for (const b of [...new Set(transfers.map((g) => g.blockNumber))]) {
    times[b] = parseInt((await read('eth_getBlockByNumber', [b, false])).timestamp, 16);
  }
  for (const g of transfers) {
    const from = addrOf(g.topics[1].slice(2));
    const to = addrOf(g.topics[2].slice(2));
    const v = BigInt(g.data);
    if (from !== ZERO) l.balances[from] = (BigInt(l.balances[from] || '0') - v).toString();
    if (to !== ZERO) l.balances[to] = (BigInt(l.balances[to] || '0') + v).toString();
    if (from === ZERO) {
      l.mints.push({ block: parseInt(g.blockNumber, 16), to, amount: units(v), tx: g.transactionHash });
      continue;
    }
    if (to === ZERO) l.burned = (BigInt(l.burned) + v).toString();
    l.transfers += 1;
    const d = day(times[g.blockNumber]);
    l.daily[d] = (l.daily[d] || 0) + 1;
  }
  Object.keys(l.balances).forEach((a) => { if (l.balances[a] === '0') delete l.balances[a]; });
}
async function getLogs(url, from, to) {
  return rpc(url, 'eth_getLogs', [{ address: CONTRACT, fromBlock: hex(from), toBlock: hex(to) }]);
}
function claimLedger() {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.closeSync(fs.openSync(LEDGER_LOCK, 'wx'));
    return true;
  } catch (e) {
    try {
      if (Date.now() - fs.statSync(LEDGER_LOCK).mtimeMs < 15 * 60 * 1000) return false; // another process is on it
      fs.utimesSync(LEDGER_LOCK, new Date(), new Date());
      return true;
    } catch (e2) { return false; }
  }
}
const releaseLedger = () => { try { fs.unlinkSync(LEDGER_LOCK); } catch (e) { /* gone */ } };

let ledgerRunning = false;
async function advanceLedger(maxMs = 4 * 60 * 1000) {
  if (ledgerRunning || !claimLedger()) return;
  ledgerRunning = true;
  const started = Date.now();
  try {
    const tip = parseInt(await read('eth_blockNumber', []), 16);
    const l = readLedger() || emptyLedger(tip - 100);
    const touch = () => { try { fs.utimesSync(LEDGER_LOCK, new Date(), new Date()); } catch (e) { /* ok */ } };
    // live side first: recent blocks from the fast node while they are still there
    while (l.scannedTo < tip && Date.now() - started < maxMs) {
      const from = l.scannedTo + 1;
      const to = Math.min(tip, from + WINDOW - 1);
      const url = tip - from < 4000 ? RECENT_LOGS_RPC : OLD_LOGS_RPC;
      await applyLogs(l, await getLogs(url, from, to));
      l.scannedTo = to;
      l.updatedAt = new Date().toISOString();
      writeLedger(l);
      touch();
    }
    // then the history, a few windows per run
    while (l.backfillNext < l.liveFrom && Date.now() - started < maxMs) {
      const from = l.backfillNext;
      const to = Math.min(l.liveFrom - 1, from + WINDOW - 1);
      await applyLogs(l, await getLogs(OLD_LOGS_RPC, from, to));
      l.backfillNext = to + 1;
      l.updatedAt = new Date().toISOString();
      writeLedger(l);
      touch();
    }
  } catch (e) {
    console.error('xlnft ledger: ' + (e && e.message));
  } finally {
    ledgerRunning = false;
    releaseLedger();
  }
}

// ---------------------------------------------------------------- PinkLock locks of the pool's LP token
async function pinkLocks() {
  const count = Number(BigInt(await ethCall(PINKLOCK, SEL.totalLockCountForToken + padAddr(PAIR))));
  if (!count) return [];
  const res = await ethCall(PINKLOCK, SEL.getLocksForToken + padAddr(PAIR) + pad(0) + pad(count - 1));
  // abi: offset, length, then one offset per struct (dynamic: description string)
  const n = Number(BigInt('0x' + word(res, 1)));
  const out = [];
  for (let i = 0; i < n; i++) {
    const base = 2 + Number(BigInt('0x' + word(res, 2 + i))) / 32; // struct start, in words
    const w = (k) => '0x' + word(res, base + k);
    out.push({
      id: Number(BigInt(w(0))),
      token: addrOf(word(res, base + 1)),
      owner: addrOf(word(res, base + 2)),
      amount: BigInt(w(3)),
      lockDate: Number(BigInt(w(4))),
      unlockDate: Number(BigInt(w(5))), // tgeDate: when the whole lock (no vesting cycles here) unlocks
      cycle: Number(BigInt(w(7))),
      unlockedAmount: BigInt(w(9)),
    });
  }
  return out.filter((x) => x.token === PAIR);
}

// ---------------------------------------------------------------- reading
let reading = null;
function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) { return []; }
}
async function sample() {
  await advanceLedger(60 * 1000); // bring the ledger up to the chain first (no-op while another process holds it)
  const [tipHex, code, totalHex, ownerHex, reserves, token0Hex, lpTotalHex, locks] = await Promise.all([
    read('eth_blockNumber', []),
    read('eth_getCode', [CONTRACT, 'latest']),
    ethCall(CONTRACT, SEL.totalSupply),
    ethCall(CONTRACT, SEL.owner),
    ethCall(PAIR, SEL.getReserves),
    ethCall(PAIR, SEL.token0),
    ethCall(PAIR, SEL.totalSupply),
    pinkLocks(),
  ]);
  const height = parseInt(tipHex, 16);
  const total = BigInt(totalHex);
  const owner = addrOf(ownerHex.slice(2));
  const [ownerBal, deadBal, selfBal, pairBal, lpAtLocker, lpBurned] = await Promise.all([
    owner === ZERO ? 0n : balanceOf(CONTRACT, owner),
    balanceOf(CONTRACT, DEAD),
    balanceOf(CONTRACT, CONTRACT),
    balanceOf(CONTRACT, PAIR),
    balanceOf(PAIR, PINKLOCK),
    balanceOf(PAIR, ZERO), // MINIMUM_LIQUIDITY burned by PancakeSwap when the pool was created
  ]);
  const codeSha = crypto.createHash('sha256').update(String(code).toLowerCase()).digest('hex');
  const tokenIs0 = addrOf(token0Hex.slice(2)) === CONTRACT;
  const r0 = BigInt('0x' + word(reserves, 0)), r1 = BigInt('0x' + word(reserves, 1));
  const tokenReserve = tokenIs0 ? r0 : r1, usdtReserve = tokenIs0 ? r1 : r0; // the other side is USDT (18 decimals on BSC)
  const lpTotal = BigInt(lpTotalHex);
  const active = locks.filter((x) => x.amount > x.unlockedAmount);
  const lockedLp = active.reduce((s, x) => s + (x.amount - x.unlockedAmount), 0n);
  const totalSupply = units(total);

  const l = readLedger();
  const ledger = { complete: false, progressPct: 0 };
  if (l) {
    const span = l.liveFrom - l.deployBlock;
    ledger.complete = l.backfillNext >= l.liveFrom;
    ledger.progressPct = span > 0 ? Math.min(100, ((l.backfillNext - l.deployBlock) / span) * 100) : 100;
    ledger.scannedTo = l.scannedTo;
    ledger.updatedAt = l.updatedAt;
    ledger.transfers = l.transfers;
    const now = Date.now();
    const sinceDays = (n) => Object.keys(l.daily).filter((d) => now - Date.parse(d + 'T00:00:00Z') < n * 86400000).reduce((s, d) => s + l.daily[d], 0);
    ledger.transfersToday = l.daily[new Date().toISOString().slice(0, 10)] || 0;
    ledger.transfers7d = sinceDays(7);
    ledger.transfers30d = sinceDays(30);
    if (ledger.complete) {
      const entries = Object.entries(l.balances).map(([a, v]) => [a, BigInt(v)]).filter(([, v]) => v > 0n);
      const sum = entries.reduce((s, [, v]) => s + v, 0n);
      // the ledger is read up to its own last block and the chain now: a difference only counts when the
      // ledger is within a few blocks of the chain (a burn in between is not a divergence)
      ledger.sumMatches = sum === total ? true : (height - l.scannedTo > 50 ? null : false);
      ledger.mintsAfterDeploy = l.mints.filter((m) => m.block !== l.deployBlock).length;
      ledger.burnedByEvents = units(BigInt(l.burned));
      ledger.holders = entries.length;
      const label = (a) => (a === owner ? 'owner' : a === PAIR ? 'pool' : a === CONTRACT ? 'contract' : a === DEAD ? 'burn' : null);
      entries.sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
      ledger.top = entries.slice(0, 10).map(([a, v]) => ({ address: a, label: label(a), balance: units(v), pct: total > 0n ? Number((v * 1000000n) / total) / 10000 : 0 }));
      ledger.top10Pct = ledger.top.reduce((s, x) => s + x.pct, 0);
    }
  }

  const codeMatches = codeSha === CODE_SHA256;
  const ts = new Date().toISOString();
  reading = {
    ts,
    height,
    contract: CONTRACT,
    sourceUrl: SOURCE_URL,
    deployBlock: DEPLOY_BLOCK,
    deployedAt: DEPLOYED_AT,
    codeMatches,
    codeSha256: codeSha,
    compiler: 'solc 0.8.19 · optimizer 200 · EVM paris',
    supply: totalSupply,
    actualSupply: totalSupply,
    expectedSupply: units(INITIAL_SUPPLY),
    maxSupply: units(INITIAL_SUPPLY),
    treasuryMax: null,
    deviation: units(total) - units(INITIAL_SUPPLY),
    burned: units(INITIAL_SUPPLY - total),
    deadBalance: units(deadBal),
    owner,
    ownerRenounced: owner === ZERO,
    ownerBalance: units(ownerBal),
    ownerPct: total > 0n ? Number((ownerBal * 1000000n) / total) / 10000 : 0,
    contractBalance: units(selfBal),
    pool: {
      address: PAIR,
      dex: 'PancakeSwap V2',
      tokenReserve: units(tokenReserve),
      usdtReserve: units(usdtReserve),
      priceUsdt: tokenReserve > 0n ? units(usdtReserve) / units(tokenReserve) : null,
      tokenBalance: units(pairBal),
      lpTotal: units(lpTotal),
      lpLocked: units(lockedLp),
      lpAtLocker: units(lpAtLocker),
      // share of the LP tokens that exist outside address(0) (PancakeSwap burns 1,000 wei there at creation)
      lpLockedPct: lpTotal - lpBurned > 0n ? Number((lockedLp * 1000000n) / (lpTotal - lpBurned)) / 10000 : 0,
      locker: 'PinkLock',
      lockerAddress: PINKLOCK,
      locks: active.map((x) => ({ id: x.id, owner: x.owner, amount: units(x.amount - x.unlockedAmount), lockedAt: new Date(x.lockDate * 1000).toISOString(), unlocksAt: new Date(x.unlockDate * 1000).toISOString() })),
      unlocksAt: active.length ? new Date(Math.min(...active.map((x) => x.unlockDate)) * 1000).toISOString() : null,
    },
    ledger,
    withinRule: codeMatches && total <= INITIAL_SUPPLY && !(ledger.complete && (ledger.mintsAfterDeploy > 0 || ledger.sumMatches === false)),
    masternodesOnline: null,
  };
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ reading }));
    const h = readHistory();
    h.push({ ts, height, supply: totalSupply, holders: ledger.holders != null ? ledger.holders : null });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(h.slice(-5000)));
  } catch (e) { console.error('xlnft audit: could not save', e && e.message); }
  return reading;
}

function latestReading() {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).reading; } catch (e) { /* none yet */ }
  if (!reading) return saved;
  return saved && Date.parse(saved.ts) > Date.parse(reading.ts) ? saved : reading;
}

module.exports = function mountXlnftAudit(app) {
  app.get('/api/network/xlnft-audit', (req, res) => {
    const r = latestReading();
    if (!r) return res.json({ ok: false, error: 'not sampled yet' });
    let history = readHistory();
    // the supply line starts at the deployment, when the constructor created the whole supply
    if (r.ledger && r.ledger.complete && history.length) history = [{ ts: DEPLOYED_AT, height: DEPLOY_BLOCK, supply: r.expectedSupply }].concat(history);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ ok: true, reading: r, history: history.map((p) => Object.assign({}, p, { actualSupply: p.supply, expectedSupply: r.expectedSupply })) });
  });
  const run = () => sample().catch((e) => console.error('xlnft audit sample failed', e && e.message));
  setTimeout(() => { advanceLedger().then(run); }, 20 * 1000).unref();
  setInterval(() => { advanceLedger(); }, 5 * 60 * 1000).unref();
  setInterval(run, 20 * 60 * 1000).unref();
  return { sample, advanceLedger };
};
// for the one-off tool that seeds the ledger from a scan made elsewhere
module.exports.applyLogs = applyLogs;
module.exports.emptyLedger = emptyLedger;
module.exports.DEPLOY_BLOCK = DEPLOY_BLOCK;
