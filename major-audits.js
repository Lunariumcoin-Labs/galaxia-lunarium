// Supply audits of Bitcoin and Solana (Auditoria tab), sampled every 20 minutes like the other
// audited coins. Each compares what the chain reports with the most its official code allows.
//
// Bitcoin -- the rule is GetBlockSubsidy (bitcoin/bitcoin, src/validation.cpp): 50 BTC per block,
// halved every 210,000 blocks (integer satoshis, shifted right once per halving). The cap at a
// height is the sum of every block's subsidy up to it. The supply is the total of coins created so
// far as blockchair.com reads it from the chain; it sits a constant 28.95844904 BTC below the cap
// (rewards miners never claimed). The difficulty history starts with one block per day of the last
// 30 days read from mempool.space; supply readings exist only from the first check on.
//
// Ethereum -- see its section: the consensus layer's most per epoch, minus the ether burned, from the
// first check on.
//
// BNB -- see its section: no block reward, so supply + BNB burned never grows; blocks checked one by one.
//
// Solana -- there is no fixed maximum. The official code (Inflation in the Solana SDK) creates new
// SOL at each epoch boundary: capitalization x inflation rate x the epoch's length in years, the
// rate being initial x (1 - taper)^years with a terminal floor (the network reports 8%, 15%, 1.5%).
// So the cap here starts at the total supply of the first check and grows at every epoch boundary
// by the most the rate allows; the real supply must stay at or below it (fees burned and rewards not
// paid only pull it further down). The rate itself is checked too: within the governor's bounds and
// never higher than at an earlier check (the schedule only goes down). The rewards actually created at
// each epoch boundary are read from the network's EpochRewards account and compared with the same rule;
// stake, validators and node software versions complete the picture.
const fs = require('fs');
const path = require('path');

const EVERY_MS = 20 * 60 * 1000;
const DATA = path.join(__dirname, 'data');
const BTC_FILE = path.join(DATA, 'btc-audit-history.json');
const SOL_FILE = path.join(DATA, 'sol-audit-history.json');
const SOL_STATE_FILE = path.join(DATA, 'sol-audit-state.json');
// last good reading of each audit, shown again right after a restart (with its own time)
const BTC_LAST_FILE = path.join(DATA, 'btc-audit-last.json');
const SOL_LAST_FILE = path.join(DATA, 'sol-audit-last.json');
const RETRY_MS = 2 * 60 * 1000;

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; } };

module.exports = function mountMajorAudits(app, { fetchJson, compactAuditHistory }) {
  const keep = (file, reading) => { try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(file, JSON.stringify(reading)); } catch (e) { /* the reading still serves from memory */ } };
  const writeHistory = (file, history) => {
    try {
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(compactAuditHistory(history)));
    } catch (e) { console.error('failed to persist audit history', path.basename(file), e && e.message); }
  };

  // ------------------------------------------------------------------ Bitcoin
  const BTC_HALVING = 210000;
  const SATS = 100000000;
  function btcSubsidySats(height) {
    const halvings = Math.floor(height / BTC_HALVING);
    return halvings >= 64 ? 0n : 5000000000n >> BigInt(halvings);
  }
  function btcCap(height) {
    let total = 0n;
    for (let start = 0; start <= height; start += BTC_HALVING) {
      const subsidy = btcSubsidySats(start);
      if (subsidy === 0n) break;
      total += subsidy * BigInt(Math.min(height, start + BTC_HALVING - 1) - start + 1);
    }
    return Number(total) / SATS;
  }
  // ---- mining: what the last 24 hours and 30 days of blocks created, block by block.
  // The site keeps its own list of the main chain's blocks of the last 30 days, read from
  // mempool.space's block list: height, time, what the miner received (subsidy + fees), the fees and
  // the transactions. The new coins of a block are "received - fees", and that may never be more than
  // the subsidy the code allows at its height. The explorer's ready-made sums are not used: its
  // servers keep separate databases, and one of them was seen adding an orphaned block to a 30-day
  // sum (exactly one subsidy too many, for one height fewer than it had rows).
  const MEMPOOL = 'https://mempool.space/api';
  const BTC_BLOCKS_FILE = path.join(DATA, 'btc-blocks.json');
  const BTC_MONTH = 30 * 86400;
  const BTC_FRESH = 6;             // the newest blocks may still be settling in the explorer
  const BTC_PAGES_PER_RUN = 20;    // the explorer lists 15 blocks per request
  function btcSubsidyRange(from, to) {
    let total = 0n;
    for (let h = from; h <= to;) {
      const end = Math.min(to, (Math.floor(h / BTC_HALVING) + 1) * BTC_HALVING - 1);
      total += btcSubsidySats(h) * BigInt(end - h + 1);
      h = end + 1;
    }
    return Number(total) / SATS;
  }
  const btcBlocks = new Map();     // height -> [time, received (sat), fees (sat), transactions]
  (readJson(BTC_BLOCKS_FILE, []) || []).forEach((r) => { if (Array.isArray(r) && r.length === 5) btcBlocks.set(r[0], r.slice(1)); });
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const btcOver = (h, b) => b[1] - b[2] > Number(btcSubsidySats(h));
  async function btcPage(height) {
    const list = await fetchJson(`${MEMPOOL}/v1/blocks/${height}`);
    if (!Array.isArray(list) || !list.length) throw new Error('no block list at ' + height);
    list.forEach((blk) => {
      const x = blk.extras || {};
      // orphaned blocks and blocks the explorer has not finished reading are left out
      if (blk.stale || x.reward == null || x.totalFees == null) return;
      const h = Number(blk.height), time = Number(blk.timestamp), received = Number(x.reward), fees = Number(x.totalFees);
      if (!(h >= 0) || !(time > 0) || !(received >= 0) || !(fees >= 0)) return;
      btcBlocks.set(h, [time, received, fees, Number(blk.tx_count) || 0]);
    });
  }
  // newest block of the list (the explorer can be a block or two behind its own tip for a moment)
  function btcTop(tip) {
    let top = tip;
    while (top > tip - 3 && !btcBlocks.has(top)) top--;
    return top;
  }
  // Brings the list up to date; true when it reaches back 30 days without a hole. One run reads a
  // limited number of pages, so the first fill after an installation takes a few runs.
  async function btcSyncRun(tip) {
    const cutoff = Math.floor(Date.now() / 1000) - BTC_MONTH;
    await btcPage(tip);            // the newest blocks are read again on every check
    let pages = 1;
    let complete = false;
    for (let h = btcTop(tip); h > 0;) {
      const known = btcBlocks.get(h);
      if (known) { if (known[0] < cutoff) { complete = true; break; } h--; continue; }
      if (pages >= BTC_PAGES_PER_RUN) break;
      await pause(500);
      await btcPage(h);
      pages++;
      if (!btcBlocks.has(h)) break; // the explorer does not have this block ready
    }
    // a settled block that looks above the rule is read once more before anything is said about it
    let again = 0;
    for (const [h, known] of btcBlocks) {
      if (again >= 2) break;
      if (h <= tip - BTC_FRESH && btcOver(h, known)) {
        again++;
        await pause(500);
        await btcPage(Math.min(tip, h + 7)).catch(() => {});
      }
    }
    for (const [h, known] of btcBlocks) { if (known[0] < cutoff - 2 * 86400) btcBlocks.delete(h); }
    keep(BTC_BLOCKS_FILE, Array.from(btcBlocks, ([h, known]) => [h].concat(known)).sort((x, y) => x[0] - y[0]));
    return complete;
  }
  let btcSyncing = null;
  function btcSync(tip) {
    if (!btcSyncing) btcSyncing = btcSyncRun(tip).finally(() => { btcSyncing = null; });
    return btcSyncing;
  }
  // The window is every block of the list, from the newest back to the first one older than the
  // period. A block above the rule among the newest ones is the explorer still settling its fees
  // (seen: a few thousand satoshis for some minutes) -- the window is not used then and the previous
  // one stays. An older block above the rule is read again for two hours before it is shown as it is.
  const btcOverSince = {};
  function btcLedgerWindow(tip, seconds) {
    const cutoff = Math.floor(Date.now() / 1000) - seconds;
    const top = btcTop(tip);
    let received = 0, fees = 0, txs = 0, from = null, over = false;
    for (let h = top; h > 0; h--) {
      const known = btcBlocks.get(h);
      if (!known) throw new Error('block list not complete yet (missing ' + h + ')');
      if (known[0] < cutoff) break;
      if (btcOver(h, known)) {
        if (h > tip - BTC_FRESH) throw new Error('block ' + h + ' not settled in the explorer yet');
        btcOverSince[h] = btcOverSince[h] || Date.now();
        if (Date.now() - btcOverSince[h] < 2 * 3600 * 1000) throw new Error('block ' + h + ' above the rule, being read again');
        over = true;
      } else delete btcOverSince[h];
      received += known[1]; fees += known[2]; txs += known[3]; from = h;
    }
    if (from === null) throw new Error('no blocks in the window');
    const blocks = top - from + 1;
    const minted = (received - fees) / SATS;
    const byRule = btcSubsidyRange(from, top);
    return {
      blocks, fromHeight: from, toHeight: top,
      minted, byRule, fees: fees / SATS, total: received / SATS, txs,
      avgBlockSec: seconds / blocks,
      withinRule: !over && minted <= byRule + 1e-8,
    };
  }
  // While the list does not reach back 30 days yet (first fill, or after a long stop) it keeps being
  // filled between the regular checks, and the 30-day window is published as soon as it is whole.
  let btcFillTimer = null;
  let btcFillFails = 0;
  function continueBtcFill(delay) {
    if (btcFillTimer) return;
    btcFillTimer = setTimeout(async () => {
      btcFillTimer = null;
      try {
        const tip = Number(await fetchJson(`${MEMPOOL}/blocks/tip/height`));
        if (!(tip > 0)) throw new Error('no tip');
        const complete = await btcSync(tip);
        btcFillFails = 0;
        if (!complete) { continueBtcFill(); return; }
        if (btcReading && btcReading.mining) {
          const d30 = btcLedgerWindow(tip, BTC_MONTH);
          btcReading.mining.d30 = d30;
          if (!d30.withinRule) btcReading.withinRule = false;
          keep(BTC_LAST_FILE, btcReading);
        }
      } catch (e) {
        console.error('btc block list fill failed', e && e.message);
        if (++btcFillFails < 10) continueBtcFill(2 * 60 * 1000);
      }
    }, delay || 20 * 1000);
    if (btcFillTimer.unref) btcFillTimer.unref();
  }
  async function btcMining(height) {
    const tip = Number(await fetchJson(`${MEMPOOL}/blocks/tip/height`));
    if (!(tip > 0)) throw new Error('no tip');
    const complete = await btcSync(tip);
    // a window that cannot be read now keeps the one of the last good reading
    const last = btcReading && btcReading.mining;
    const windowOr = (seconds, previous, name) => {
      try { return btcLedgerWindow(tip, seconds); } catch (e) { console.error('btc ' + name + ' mining window not read', e && e.message); return previous || null; }
    };
    const d1 = windowOr(86400, last && last.d1, '24h');
    if (!d1) throw new Error('no 24h window yet');
    const d30 = windowOr(BTC_MONTH, last && last.d30, '30-day');
    if (!complete) continueBtcFill();
    else if (!d30 || d30.toHeight < tip - 3) continueBtcFill(2 * 60 * 1000);
    const out = { d1, d30, adjustment: null, halving: null, pools: null, poolsBlocks: null };
    try {
      const a = await fetchJson(`${MEMPOOL}/v1/difficulty-adjustment`);
      out.adjustment = { changePct: Number(a.difficultyChange), remainingBlocks: Number(a.remainingBlocks), nextHeight: Number(a.nextRetargetHeight), estimatedAt: new Date(Number(a.estimatedRetargetDate)).toISOString(), progressPct: Number(a.progressPercent) };
    } catch (e) { console.error('btc difficulty adjustment failed', e && e.message); }
    const nextHalving = (Math.floor(height / BTC_HALVING) + 1) * BTC_HALVING;
    const pace = out.d30 ? out.d30.avgBlockSec : d1.avgBlockSec;
    out.halving = { height: nextHalving, remainingBlocks: nextHalving - height, estimatedAt: new Date(Date.now() + (nextHalving - height) * pace * 1000).toISOString(), subsidyNow: Number(btcSubsidySats(height)) / SATS, subsidyNext: Number(btcSubsidySats(nextHalving)) / SATS };
    try {
      const pl = await fetchJson(`${MEMPOOL}/v1/mining/pools/24h`);
      const list = (pl.pools || []).filter((x) => x.blockCount > 0).sort((x, y) => y.blockCount - x.blockCount);
      const pools = {};
      list.slice(0, 8).forEach((x) => { pools[String(x.name).replace(/[<>&"']/g, '').slice(0, 30)] = x.blockCount; });
      const rest = list.slice(8).reduce((t, x) => t + x.blockCount, 0);
      if (rest > 0) pools['…'] = rest;
      out.pools = pools;
      out.poolsBlocks = list.reduce((t, x) => t + x.blockCount, 0);
    } catch (e) { console.error('btc pools failed', e && e.message); }
    return out;
  }

  let btcReading = readJson(BTC_LAST_FILE, null);
  async function sampleBtc() {
    try {
      // blockchair answers from several servers that are not always in step: one was seen counting
      // two blocks (and their rewards) more than the chain tip. The supply is compared with the cap
      // of the same height, so only an answer whose block count matches its best height is used.
      let d = null;
      for (let attempt = 0; attempt < 5 && !d; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 3000));
        const got = ((await fetchJson('https://api.blockchair.com/bitcoin/stats')) || {}).data || {};
        if (Number(got.blocks) - 1 === Number(got.best_block_height)) d = got;
      }
      if (!d) throw new Error('source not in step with the chain');
      const height = Number(d.best_block_height);
      const supply = Number(d.circulation) / SATS;
      const seen = Date.parse(String(d.best_block_time || '').replace(' ', 'T') + 'Z');
      if (!(height > 0) || !(supply > 0)) throw new Error('no reading');
      // a source that stopped following the chain is not audited against
      if (!(seen > 0) || Date.now() - seen > 6 * 3600 * 1000) throw new Error('source behind the chain');
      const ts = new Date().toISOString();
      const cap = btcCap(height);
      const deviation = supply - cap;
      const nextHalving = (Math.floor(height / BTC_HALVING) + 1) * BTC_HALVING;
      // mining figures are independent of the supply audit: when they cannot be read, the last ones stay
      const mining = await btcMining(height).catch((e) => { console.error('btc mining reading failed', e && e.message); return btcReading ? btcReading.mining : null; });
      const minedWithinRule = !mining || ((!mining.d1 || mining.d1.withinRule) && (!mining.d30 || mining.d30.withinRule));
      btcReading = {
        ts,
        height,
        supply,
        actualSupply: supply,
        expectedSupply: cap,
        deviation,
        deviationPct: cap > 0 ? (deviation / cap) * 100 : 0,
        withinRule: supply <= cap && minedWithinRule,
        supplyWithinCap: supply <= cap,
        maxSupply: 20999999.9769,
        blockSubsidy: Number(btcSubsidySats(height)) / SATS,
        nextHalvingHeight: nextHalving,
        nextSubsidy: Number(btcSubsidySats(nextHalving)) / SATS,
        difficulty: Number(d.difficulty) || null,
        hashrate: Number(d.hashrate_24h) || null,
        mining,
        masternodesOnline: null,
        masternodesOffline: null,
      };
      const history = readJson(BTC_FILE, []);
      history.push({ ts, height, supply, difficulty: btcReading.difficulty });
      writeHistory(BTC_FILE, history);
      keep(BTC_LAST_FILE, btcReading);
      return true;
    } catch (e) {
      console.error('btc audit sample failed', e && e.message);
      return false;
    }
  }
  async function backfillBtcDifficulty() {
    const existing = readJson(BTC_FILE, []);
    if (existing.length >= 20) return;
    try {
      const tip = Number(await fetchJson('https://mempool.space/api/blocks/tip/height'));
      if (!(tip > 0)) throw new Error('no tip');
      const points = [];
      for (let day = 30; day >= 1; day--) {
        const list = await fetchJson(`https://mempool.space/api/v1/blocks/${tip - day * 144}`);
        const b = Array.isArray(list) ? list[0] : null;
        if (b && b.timestamp > 0 && Number(b.difficulty) > 0) points.push({ ts: new Date(b.timestamp * 1000).toISOString(), height: Number(b.height), difficulty: Number(b.difficulty) });
        await new Promise((r) => setTimeout(r, 300));
      }
      writeHistory(BTC_FILE, existing.concat(points).sort((a, b) => new Date(a.ts) - new Date(b.ts)));
    } catch (e) {
      console.error('btc audit backfill failed', e && e.message);
    }
  }
  app.get('/api/network/btc-audit', (req, res) => {
    if (!btcReading) return res.json({ ok: false, error: 'not sampled yet' });
    const history = readJson(BTC_FILE, []).map((p) => (p.supply != null
      ? Object.assign({}, p, { actualSupply: p.supply, expectedSupply: btcCap(p.height) })
      : p));
    res.json({ ok: true, reading: btcReading, history });
  });

  // ------------------------------------------------------------------ Solana
  // A "slot year" is how the network turns an epoch into a fraction of a year when it creates the
  // epoch's rewards: seconds per year (365.242199 days) / seconds per slot. Mainnet counts 250 ms
  // per slot: the rewards of epoch 1049 (78,605.85 SOL, read from the EpochRewards account on
  // 2026-10-06) equal rate x supply x 432,000 / this number to the sixth digit.
  const SLOTS_PER_YEAR = (365.242199 * 24 * 60 * 60) / 0.25;
  const LAMPORTS = 1e9;
  const EPOCH_REWARDS = 'SysvarEpochRewards1111111111111111111111111';
  const NODES_EVERY_MS = 6 * 60 * 60 * 1000;
  async function solRpc(method, params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const r = await fetch('https://api.mainnet-beta.solana.com', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] }), signal: controller.signal,
      });
      if (!r.ok) throw new Error('status ' + r.status);
      const d = await r.json();
      if (!d || d.result == null) throw new Error((d && d.error && d.error.message) || 'no result');
      return d.result;
    } finally { clearTimeout(timer); }
  }

  // Stake: every validator with its active stake (getVoteAccounts). "Delinquent" = stopped voting.
  async function solStake(total, rate) {
    const v = await solRpc('getVoteAccounts');
    const sum = (list) => (list || []).reduce((t, x) => t + Number(x.activatedStake || 0), 0) / LAMPORTS;
    const active = sum(v.current);
    const delinquent = sum(v.delinquent);
    if (!(active > 0)) throw new Error('no stake reading');
    return {
      validatorsActive: v.current.length,
      validatorsDelinquent: (v.delinquent || []).length,
      activeStake: active,
      delinquentStake: delinquent,
      stakedPct: ((active + delinquent) / total) * 100,
      // what the epoch's new SOL adds to the stake that earns it, per year, before each validator's commission
      yieldPct: (rate * total / active) * 100,
    };
  }

  // Rewards created at the last epoch boundary: the network keeps the figure in the EpochRewards
  // account (u64 distribution start, u64 partitions, 32-byte blockhash, u128 points, u64 total
  // rewards, u64 distributed rewards, bool active).
  async function solEpochRewards() {
    const acc = await solRpc('getAccountInfo', [EPOCH_REWARDS, { encoding: 'base64' }]);
    const data = Buffer.from(acc.value.data[0], 'base64');
    if (data.length < 81) throw new Error('unexpected EpochRewards layout');
    return {
      total: Number(data.readBigUInt64LE(64)) / LAMPORTS,
      distributed: Number(data.readBigUInt64LE(72)) / LAMPORTS,
      distributing: data[80] === 1,
    };
  }

  // Software of the nodes in the network's gossip (getClusterNodes), asked a few times a day.
  let solNodes = null;
  async function solNodeVersions() {
    if (solNodes && Date.now() - solNodes.at < NODES_EVERY_MS) return solNodes;
    const nodes = await solRpc('getClusterNodes');
    const count = {};
    nodes.forEach((n) => { const v = String(n.version || 'unknown').replace(/[^0-9A-Za-z.+-]/g, '').slice(0, 24) || 'unknown'; count[v] = (count[v] || 0) + 1; });
    const sorted = Object.keys(count).sort((x, y) => count[y] - count[x]);
    const versions = {};
    sorted.slice(0, 8).forEach((v) => { versions[v] = count[v]; });
    const rest = sorted.slice(8).reduce((t, v) => t + count[v], 0);
    if (rest > 0) versions['…'] = rest;
    solNodes = { at: Date.now(), versions, total: nodes.length };
    return solNodes;
  }

  let solReading = readJson(SOL_LAST_FILE, null);
  async function sampleSol() {
    try {
      const supplyRes = await solRpc('getSupply', [{ excludeNonCirculatingAccountsList: true }]);
      const info = await solRpc('getEpochInfo');
      const rate = await solRpc('getInflationRate');
      const gov = await solRpc('getInflationGovernor');
      const total = Number(supplyRes.value.total) / LAMPORTS;
      const circulating = Number(supplyRes.value.circulating) / LAMPORTS;
      if (!(total > 0) || !(info.epoch >= 0) || !(rate.total > 0) || !(gov.initial > 0)) throw new Error('no reading');
      const epochYears = info.slotsInEpoch / SLOTS_PER_YEAR;

      const state = readJson(SOL_STATE_FILE, {});
      if (!state.anchor) {
        // Rewards of the epoch that just ended are paid out over the first blocks of the new one:
        // the starting point is taken once that is over, so the supply can only go down until the next epoch.
        if (info.slotIndex < 10000) return false;
        state.anchor = { ts: new Date().toISOString(), epoch: info.epoch, supply: total };
        state.capEpoch = info.epoch;
        state.cap = total;
        state.lastRate = rate.total;
        state.highestRate = rate.total;
      }
      // every epoch boundary crossed since the last check raises the cap by the most the rate allowed
      // (cap and rate of the epoch before; 0.1% of slack on the step for rounding in the network's own sum)
      while (state.capEpoch < info.epoch) {
        state.cap *= 1 + state.lastRate * epochYears * 1.001;
        state.capEpoch += 1;
      }
      state.lastRate = rate.total;
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(SOL_STATE_FILE, JSON.stringify(state));

      // the three extra readings are independent: one failing leaves the others (and the supply audit) standing
      const stake = await solStake(total, rate.total).catch((e) => { console.error('sol stake reading failed', e && e.message); return solReading ? solReading.stake : null; });
      const nodes = await solNodeVersions().catch((e) => { console.error('sol node versions failed', e && e.message); return solNodes; });
      let epochRewards = solReading ? solReading.epochRewards : null;
      try {
        const er = await solEpochRewards();
        if (!er.distributing && er.total > 0) {
          // supply before the payout = supply now - what was paid (fees burned since are a few SOL in 635 million)
          const before = total - er.total;
          const maxByRule = rate.total * before * epochYears;
          epochRewards = {
            epoch: info.epoch - 1,
            total: er.total,
            distributed: er.distributed,
            maxByRule,
            pctOfRule: maxByRule > 0 ? (er.total / maxByRule) * 100 : null,
            withinRule: er.total <= maxByRule * 1.001,
          };
        }
      } catch (e) { console.error('sol epoch rewards reading failed', e && e.message); }

      const rateNotRising = rate.total <= (state.highestRate || rate.total) * (1 + 1e-9);
      const rateInBounds = rate.total <= gov.initial * (1 + 1e-9) && rate.total >= gov.terminal * (1 - 1e-9);
      const supplyWithinCap = total <= state.cap * (1 + 1e-12);
      const ts = new Date().toISOString();
      const deviation = total - state.cap;
      solReading = {
        ts,
        height: info.blockHeight,
        slot: info.absoluteSlot,
        epoch: info.epoch,
        epochProgressPct: (info.slotIndex / info.slotsInEpoch) * 100,
        supply: total,
        actualSupply: total,
        expectedSupply: state.cap,
        circulatingSupply: circulating,
        deviation,
        deviationPct: state.cap > 0 ? (deviation / state.cap) * 100 : 0,
        withinRule: supplyWithinCap && rateInBounds && rateNotRising && (!epochRewards || epochRewards.withinRule),
        supplyWithinCap,
        inflationRate: rate.total,
        inflationInitial: gov.initial,
        inflationTerminal: gov.terminal,
        inflationTaper: gov.taper,
        rateInBounds,
        rateNotRising,
        anchorTs: state.anchor.ts,
        anchorEpoch: state.anchor.epoch,
        anchorSupply: state.anchor.supply,
        stake,
        epochRewards,
        peerVersions: nodes ? nodes.versions : null,
        peerCount: nodes ? nodes.total : null,
        masternodesOnline: null,
        masternodesOffline: null,
      };
      const history = readJson(SOL_FILE, []);
      history.push({ ts, height: info.blockHeight, epoch: info.epoch, supply: total, cap: state.cap, rate: rate.total, staked: stake ? stake.activeStake : undefined });
      writeHistory(SOL_FILE, history);
      keep(SOL_LAST_FILE, solReading);
      return true;
    } catch (e) {
      console.error('sol audit sample failed', e && e.message);
      return false;
    }
  }
  app.get('/api/network/sol-audit', (req, res) => {
    if (!solReading) return res.json({ ok: false, error: 'not sampled yet' });
    const history = readJson(SOL_FILE, []).map((p) => Object.assign({}, p, { actualSupply: p.supply, expectedSupply: p.cap }));
    res.json({ ok: true, reading: solReading, history });
  });

  // ------------------------------------------------------------------ Litecoin
  // The rule is Litecoin Core's GetBlockSubsidy (litecoin-project/litecoin, src/validation.cpp): 50 LTC
  // per block, halved every 840,000 blocks (nSubsidyHalvingInterval, src/chainparams.cpp), so never more
  // than 84,000,000 LTC (MAX_MONEY, src/amount.h). The supply is blockchair.com's count of the coins the
  // chain has created, used only when its block count matches its best height (as for Bitcoin).
  // Coins created in 24 hours / 30 days are the growth of that supply between this audit's own
  // readings, against what the rule allows for the same blocks. A block's "reward minus fees" cannot be
  // used: the fees of MWEB transactions (MimbleWimble extension blocks) are paid to the miner but are
  // not in the explorer's fee total (seen 2026-10-26: 34 of 100 blocks up to 0.00009 LTC "above" 6.25).
  // So the 24-hour window exists 24 hours after the first reading, the 30-day one after 30 days.
  const LTC_HALVING = 840000;
  const LTC_RETARGET = 2016; // nPowTargetTimespan / nPowTargetSpacing = 3.5 days / 2.5 minutes
  const LTC_FILE = path.join(DATA, 'ltc-audit-history.json');
  const LTC_LAST_FILE = path.join(DATA, 'ltc-audit-last.json');
  const BLOCKCHAIR_LTC = 'https://api.blockchair.com/litecoin';
  function ltcSubsidySats(height) {
    const halvings = Math.floor(height / LTC_HALVING);
    return halvings >= 64 ? 0n : 5000000000n >> BigInt(halvings);
  }
  function ltcCap(height) {
    let total = 0n;
    for (let start = 0; start <= height; start += LTC_HALVING) {
      const subsidy = ltcSubsidySats(start);
      if (subsidy === 0n) break;
      total += subsidy * BigInt(Math.min(height, start + LTC_HALVING - 1) - start + 1);
    }
    return Number(total) / SATS;
  }
  const LTC_MAX = ltcCap(64 * LTC_HALVING);
  // blocks by pool in the last 24 hours (blockchair's miner of each block); an aggregate query costs
  // more of blockchair's daily allowance, so it is asked at most every 6 hours
  let ltcPools = null;
  async function ltcPoolList() {
    if (ltcPools && Date.now() - ltcPools.at < 6 * 3600 * 1000) return ltcPools;
    const since = new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const d = await fetchJson(`${BLOCKCHAIR_LTC}/blocks?a=${encodeURIComponent('guessed_miner,count()')}&q=${encodeURIComponent('time(' + since + '..)')}`);
    const list = ((d && d.data) || []).map((x) => ({ name: String(x.guessed_miner || 'Unknown'), n: Number(x['count()']) || 0 }))
      .filter((x) => x.n > 0).sort((x, y) => y.n - x.n);
    if (!list.length) throw new Error('no pool list');
    const pools = {};
    list.slice(0, 8).forEach((x) => { pools[x.name.replace(/[<>&"']/g, '').slice(0, 30)] = x.n; });
    const rest = list.slice(8).reduce((t, x) => t + x.n, 0);
    if (rest > 0) pools['…'] = rest;
    ltcPools = { at: Date.now(), pools, blocks: list.reduce((t, x) => t + x.n, 0) };
    return ltcPools;
  }
  // The supply grows by the subsidy AND by the MWEB fees of each block: fees paid inside the
  // MimbleWimble extension go to the miner in the block's coinbase, so coins that already existed in
  // MWEB start to count in the visible supply (2026-10-27: a 24-hour growth 0.00921668 LTC above the
  // subsidy of its 621 blocks, while those blocks paid 0.00921669 LTC of MWEB fees). Those fees are each
  // block's reward minus its visible fees minus its subsidy, summed here over the window's blocks (one
  // aggregate query; it costs blockchair allowance, so a window is refreshed every 6 hours / 1 day).
  async function ltcMwebFees(from, to) {
    const r = await fetchJson(`${BLOCKCHAIR_LTC}/blocks?a=${encodeURIComponent('sum(reward),sum(fee_total),count(),min(id),max(id)')}&q=${encodeURIComponent('id(' + from + '..' + to + ')')}`).then((x) => (x && x.data && x.data[0]) || null);
    if (!r || Number(r['count()']) !== to - from + 1 || Number(r['min(id)']) !== from || Number(r['max(id)']) !== to) throw new Error('blocks ' + from + '-' + to + ' not one row per height');
    return (Number(r['sum(reward)']) - Number(r['sum(fee_total)'])) / SATS - (ltcCap(to) - ltcCap(from - 1));
  }
  async function ltcWindowWithMweb(now, seconds, slack) {
    const w = ltcWindow(now, seconds, slack);
    if (!w) return null;
    const mweb = await ltcMwebFees(w.fromHeight, w.toHeight);
    const growth = w.minted;
    const minted = growth - mweb;
    // floating-point rounding on supplies of ~78 million: 0.000001 LTC of tolerance
    return Object.assign(w, { growth, mweb, minted, withinRule: minted <= w.byRule + 1e-6, at: Date.now() });
  }
  // growth of the supply between the reading closest to the start of the window and now
  function ltcWindow(now, seconds, slack) {
    const target = Date.parse(now.ts) - seconds * 1000;
    let then = null;
    readJson(LTC_FILE, []).forEach((p) => {
      const off = Math.abs(Date.parse(p.ts) - target);
      if (p.supply > 0 && p.height > 0 && off <= slack && (!then || off < Math.abs(Date.parse(then.ts) - target))) then = p;
    });
    if (!then || !(now.height > then.height)) return null;
    const blocks = now.height - then.height;
    const minted = now.supply - then.supply;
    const byRule = ltcCap(now.height) - ltcCap(then.height);
    const span = now.blockTime && then.blockTime ? now.blockTime - then.blockTime : Date.parse(now.ts) - Date.parse(then.ts);
    return {
      blocks, fromHeight: then.height + 1, toHeight: now.height,
      minted, byRule, fees: null, total: null, txs: null,
      avgBlockSec: span / 1000 / blocks,
      // the difference of two supplies of ~78 million carries floating-point rounding: 0.000001 LTC of tolerance
      withinRule: minted <= byRule + 1e-6,
    };
  }
  let ltcReading = readJson(LTC_LAST_FILE, null);
  async function sampleLtc() {
    try {
      let d = null;
      for (let attempt = 0; attempt < 5 && !d; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 3000));
        const got = ((await fetchJson(`${BLOCKCHAIR_LTC}/stats`)) || {}).data || {};
        if (Number(got.blocks) - 1 === Number(got.best_block_height)) d = got;
      }
      if (!d) throw new Error('source not in step with the chain');
      const height = Number(d.best_block_height);
      const supply = Number(d.circulation) / SATS;
      const blockTime = Date.parse(String(d.best_block_time || '').replace(' ', 'T') + 'Z');
      if (!(height > 0) || !(supply > 0)) throw new Error('no reading');
      if (!(blockTime > 0) || Date.now() - blockTime > 6 * 3600 * 1000) throw new Error('source behind the chain');
      const ts = new Date().toISOString();
      const cap = ltcCap(height);
      const deviation = supply - cap;
      const now = { ts, height, supply, blockTime };
      const nextHalving = (Math.floor(height / LTC_HALVING) + 1) * LTC_HALVING;
      // a window is read again only when old enough (or never had its MWEB fees); a failed read keeps the last one
      const lastMining = ltcReading && ltcReading.mining;
      const refresh = async (w, every, seconds, slack, name) => {
        if (w && w.at && w.mweb != null && Date.now() - w.at < every) return w;
        try { return (await ltcWindowWithMweb(now, seconds, slack)) || null; } catch (e) { console.error('ltc ' + name + ' window not read', e && e.message); return w && w.mweb != null ? w : null; }
      };
      const d1 = await refresh(lastMining && lastMining.d1, 6 * 3600 * 1000, 86400, 3600 * 1000, '24h');
      const d30 = await refresh(lastMining && lastMining.d30, 24 * 3600 * 1000, 30 * 86400, 13 * 3600 * 1000, '30-day');
      const pace = d30 ? d30.avgBlockSec : (d1 ? d1.avgBlockSec : 150);
      const mining = { d1, d30, adjustment: null, halving: null, pools: null, poolsBlocks: null };
      const nextRetarget = (Math.floor(height / LTC_RETARGET) + 1) * LTC_RETARGET;
      const nextDifficulty = Number(d.next_difficulty_estimate);
      const retargetAt = Date.parse(String(d.next_retarget_time_estimate || '').replace(' ', 'T') + 'Z');
      if (Number(d.difficulty) > 0 && nextDifficulty > 0) {
        mining.adjustment = {
          changePct: (nextDifficulty / Number(d.difficulty) - 1) * 100,
          remainingBlocks: nextRetarget - height,
          nextHeight: nextRetarget,
          estimatedAt: new Date(retargetAt > 0 ? retargetAt : Date.now() + (nextRetarget - height) * pace * 1000).toISOString(),
          progressPct: ((height % LTC_RETARGET) / LTC_RETARGET) * 100,
        };
      }
      mining.halving = { height: nextHalving, remainingBlocks: nextHalving - height, estimatedAt: new Date(Date.now() + (nextHalving - height) * pace * 1000).toISOString(), subsidyNow: Number(ltcSubsidySats(height)) / SATS, subsidyNext: Number(ltcSubsidySats(nextHalving)) / SATS };
      try {
        const pl = await ltcPoolList();
        mining.pools = pl.pools;
        mining.poolsBlocks = pl.blocks;
      } catch (e) {
        console.error('ltc pools failed', e && e.message);
        if (ltcReading && ltcReading.mining) { mining.pools = ltcReading.mining.pools; mining.poolsBlocks = ltcReading.mining.poolsBlocks; }
      }
      const minedWithinRule = (!d1 || d1.withinRule) && (!d30 || d30.withinRule);
      ltcReading = {
        ts,
        height,
        supply,
        actualSupply: supply,
        expectedSupply: cap,
        deviation,
        deviationPct: cap > 0 ? (deviation / cap) * 100 : 0,
        withinRule: supply <= cap && minedWithinRule,
        supplyWithinCap: supply <= cap,
        maxSupply: LTC_MAX,
        blockSubsidy: Number(ltcSubsidySats(height)) / SATS,
        nextHalvingHeight: nextHalving,
        nextSubsidy: Number(ltcSubsidySats(nextHalving)) / SATS,
        difficulty: Number(d.difficulty) || null,
        hashrate: Number(d.hashrate_24h) || null,
        mining,
        masternodesOnline: null,
        masternodesOffline: null,
      };
      const history = readJson(LTC_FILE, []);
      history.push({ ts, height, supply, difficulty: ltcReading.difficulty, blockTime });
      writeHistory(LTC_FILE, history);
      keep(LTC_LAST_FILE, ltcReading);
      return true;
    } catch (e) {
      console.error('ltc audit sample failed', e && e.message);
      return false;
    }
  }
  // the difficulty chart starts with one point per day of the last 30 days (a single aggregate query)
  async function backfillLtcDifficulty() {
    const existing = readJson(LTC_FILE, []);
    if (existing.length >= 20) return;
    try {
      const since = new Date(Date.now() - 31 * 86400 * 1000).toISOString().slice(0, 10);
      const d = await fetchJson(`${BLOCKCHAIR_LTC}/blocks?a=${encodeURIComponent('date,avg(difficulty),max(id)')}&q=${encodeURIComponent('time(' + since + '..)')}`);
      const today = new Date().toISOString().slice(0, 10);
      const points = ((d && d.data) || []).filter((x) => x.date < today && Number(x['avg(difficulty)']) > 0)
        .map((x) => ({ ts: new Date(x.date + 'T23:59:00Z').toISOString(), height: Number(x['max(id)']), difficulty: Number(x['avg(difficulty)']) }));
      writeHistory(LTC_FILE, existing.concat(points).sort((a, b) => new Date(a.ts) - new Date(b.ts)));
    } catch (e) {
      console.error('ltc audit backfill failed', e && e.message);
    }
  }
  app.get('/api/network/ltc-audit', (req, res) => {
    if (!ltcReading) return res.json({ ok: false, error: 'not sampled yet' });
    const history = readJson(LTC_FILE, []).map((p) => (p.supply != null
      ? Object.assign({}, p, { actualSupply: p.supply, expectedSupply: ltcCap(p.height) })
      : p));
    res.json({ ok: true, reading: ltcReading, history });
  });

  // ------------------------------------------------------------------ Dogecoin
  // The rule is GetDogecoinBlockSubsidy (dogecoin/dogecoin, src/dogecoin.cpp) with the mainnet
  // parameters of src/chainparams.cpp (nSubsidyHalvingInterval = 100,000; fSimplifiedRewards from block
  // 145,000):
  //   blocks 0 - 144,999: 1 + a random number drawn from the previous block's hash, at most 1,000,000
  //     DOGE (500,000 from block 100,000) -- these rewards are fixed history, so the audit takes what the
  //     chain created in them (blockchair's sum over exactly those 145,000 blocks, read once) and checks
  //     it against the most the draw could give (122.5 billion);
  //   blocks 145,000 - 599,999: 500,000 DOGE halved every 100,000 blocks (250,000 ... 15,625);
  //   from block 600,000: 10,000 DOGE per block, forever (no maximum supply).
  // The cap at a height is that early total plus the fixed rewards up to it. The supply is blockchair's
  // count of the coins on the chain, used only when its block count matches its height: its servers are
  // not all alike, and one was seen on 2026-10-26 counting 142,040 orphaned blocks (172.2 billion).
  // Coins mined in 24 hours / 30 days come from blockchair's block table (reward minus fees, block by
  // block), used only when the window has one row per height; those queries cost blockchair allowance,
  // so the 24-hour window is read every 6 hours and the 30-day one once a day.
  const DOGE_FILE = path.join(DATA, 'doge-audit-history.json');
  const DOGE_LAST_FILE = path.join(DATA, 'doge-audit-last.json');
  const DOGE_STATE_FILE = path.join(DATA, 'doge-audit-state.json');
  const BLOCKCHAIR_DOGE = 'https://api.blockchair.com/dogecoin';
  const DOGE_RANDOM_END = 145000;
  const DOGE_RANDOM_MAX = 100000 * 1000000 + (DOGE_RANDOM_END - 100000) * 500000;
  const DOGE_COIN = 100000000n;
  function dogeSubsidySats(height) {
    if (height < 600000) return (500000n * DOGE_COIN) >> BigInt(Math.floor(height / 100000));
    return 10000n * DOGE_COIN;
  }
  // fixed rewards of blocks 145,000 .. height
  function dogeFixedSum(height) {
    let total = 0n;
    for (let h = DOGE_RANDOM_END; h <= height;) {
      const end = h < 600000 ? Math.min(height, (Math.floor(h / 100000) + 1) * 100000 - 1) : height;
      total += dogeSubsidySats(h) * BigInt(end - h + 1);
      h = end + 1;
    }
    return Number(total) / SATS;
  }
  const dogeQuery = (a, q) => fetchJson(`${BLOCKCHAIR_DOGE}/blocks?a=${encodeURIComponent(a)}&q=${encodeURIComponent(q)}`).then((d) => (d && d.data && d.data[0]) || null);
  // what the chain created in the random-reward era, read once and kept
  async function dogeEarly() {
    const state = readJson(DOGE_STATE_FILE, {});
    if (state.early && state.early.total > 0) return state.early;
    const r = await dogeQuery('sum(reward),sum(fee_total),count(),min(id),max(id)', 'id(..' + (DOGE_RANDOM_END - 1) + ')');
    if (!r || Number(r['count()']) !== DOGE_RANDOM_END || Number(r['min(id)']) !== 0 || Number(r['max(id)']) !== DOGE_RANDOM_END - 1) throw new Error('early blocks not one row per height');
    const total = (Number(r['sum(reward)']) - Number(r['sum(fee_total)'])) / SATS;
    if (!(total > 0) || total > DOGE_RANDOM_MAX) throw new Error('early total outside the draw limits');
    state.early = { total, blocks: DOGE_RANDOM_END, maxByDraw: DOGE_RANDOM_MAX, at: new Date().toISOString() };
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(DOGE_STATE_FILE, JSON.stringify(state));
    return state.early;
  }
  const dogeCap = (early, height) => early + dogeFixedSum(height);
  // a window of the block table: one row per height, every block's new coins against the rule
  async function dogeWindow(seconds) {
    const since = new Date(Date.now() - seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const r = await dogeQuery('sum(reward),sum(fee_total),sum(transaction_count),count(),min(id),max(id)', 'time(' + since + '..)');
    const blocks = Number(r && r['count()']), from = Number(r && r['min(id)']), to = Number(r && r['max(id)']);
    if (!(blocks > 0) || to - from + 1 !== blocks) throw new Error('window not one row per height (orphaned blocks in the table)');
    const total = Number(r['sum(reward)']) / SATS, fees = Number(r['sum(fee_total)']) / SATS;
    const minted = total - fees;
    const byRule = dogeFixedSum(to) - dogeFixedSum(from - 1);
    // sums of this size carry floating-point rounding of a few hundred-millionths: 0.000001 DOGE of tolerance
    return { blocks, fromHeight: from, toHeight: to, minted, byRule, fees, total, txs: Number(r['sum(transaction_count)']) || 0, avgBlockSec: seconds / blocks, withinRule: minted <= byRule + 1e-6, at: Date.now() };
  }
  let dogePools = null;
  async function dogePoolList() {
    // merged mining: blockchair names no pool for Dogecoin, so the list is asked once a day only
    if (dogePools && Date.now() - dogePools.at < (dogePools.pools ? 6 : 24) * 3600 * 1000) return dogePools;
    const since = new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const d = await fetchJson(`${BLOCKCHAIR_DOGE}/blocks?a=${encodeURIComponent('guessed_miner,count()')}&q=${encodeURIComponent('time(' + since + '..)')}`);
    const list = ((d && d.data) || []).map((x) => ({ name: String(x.guessed_miner || 'Unknown'), n: Number(x['count()']) || 0 }))
      .filter((x) => x.n > 0).sort((x, y) => y.n - x.n);
    if (!list.length) throw new Error('no pool list');
    // merged mining (AuxPoW): the explorer may name no pool at all -- nothing to show then
    if (list.every((x) => x.name === 'Unknown')) { dogePools = { at: Date.now(), pools: null, blocks: null }; return dogePools; }
    const pools = {};
    list.slice(0, 8).forEach((x) => { pools[x.name.replace(/[<>&"']/g, '').slice(0, 30)] = x.n; });
    const rest = list.slice(8).reduce((t, x) => t + x.n, 0);
    if (rest > 0) pools['…'] = rest;
    dogePools = { at: Date.now(), pools, blocks: list.reduce((t, x) => t + x.n, 0) };
    return dogePools;
  }
  let dogeReading = readJson(DOGE_LAST_FILE, null);
  async function sampleDoge() {
    try {
      let d = null;
      for (let attempt = 0; attempt < 5 && !d; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 3000));
        const got = ((await fetchJson(`${BLOCKCHAIR_DOGE}/stats`)) || {}).data || {};
        if (Number(got.blocks) - 1 === Number(got.best_block_height)) d = got;
      }
      if (!d) throw new Error('source not in step with the chain');
      const height = Number(d.best_block_height);
      const supply = Number(d.circulation) / SATS;
      const blockTime = Date.parse(String(d.best_block_time || '').replace(' ', 'T') + 'Z');
      if (!(height > 0) || !(supply > 0)) throw new Error('no reading');
      if (!(blockTime > 0) || Date.now() - blockTime > 6 * 3600 * 1000) throw new Error('source behind the chain');
      const early = await dogeEarly();
      const cap = dogeCap(early.total, height);
      const ts = new Date().toISOString();
      const deviation = supply - cap;
      // the windows are read again only when old enough; a failed read keeps the last one
      const last = dogeReading && dogeReading.mining;
      const refresh = async (w, every, seconds, name) => {
        if (w && w.at && Date.now() - w.at < every) return w;
        try { return await dogeWindow(seconds); } catch (e) { console.error('doge ' + name + ' window not read', e && e.message); return w || null; }
      };
      const d1 = await refresh(last && last.d1, 6 * 3600 * 1000, 86400, '24h');
      const d30 = await refresh(last && last.d30, 24 * 3600 * 1000, 30 * 86400, '30-day');
      const mining = { d1, d30, adjustment: null, halving: null, pools: null, poolsBlocks: null };
      try {
        const pl = await dogePoolList();
        mining.pools = pl.pools;
        mining.poolsBlocks = pl.blocks;
      } catch (e) {
        console.error('doge pools failed', e && e.message);
        if (last) { mining.pools = last.pools; mining.poolsBlocks = last.poolsBlocks; }
      }
      const minedWithinRule = (!d1 || d1.withinRule) && (!d30 || d30.withinRule);
      dogeReading = {
        ts,
        height,
        supply,
        actualSupply: supply,
        expectedSupply: cap,
        deviation,
        deviationPct: cap > 0 ? (deviation / cap) * 100 : 0,
        withinRule: supply <= cap && minedWithinRule && early.total <= early.maxByDraw,
        supplyWithinCap: supply <= cap,
        maxSupply: null,
        earlyEra: early,
        blockSubsidy: Number(dogeSubsidySats(height)) / SATS,
        nextHalvingHeight: null,
        nextSubsidy: null,
        difficulty: Number(d.difficulty) || null,
        hashrate: Number(d.hashrate_24h) || null,
        mining,
        masternodesOnline: null,
        masternodesOffline: null,
      };
      const history = readJson(DOGE_FILE, []);
      history.push({ ts, height, supply, difficulty: dogeReading.difficulty });
      writeHistory(DOGE_FILE, history);
      keep(DOGE_LAST_FILE, dogeReading);
      return true;
    } catch (e) {
      console.error('doge audit sample failed', e && e.message);
      return false;
    }
  }
  async function backfillDogeDifficulty() {
    const existing = readJson(DOGE_FILE, []);
    if (existing.length >= 20) return;
    try {
      const since = new Date(Date.now() - 31 * 86400 * 1000).toISOString().slice(0, 10);
      const d = await fetchJson(`${BLOCKCHAIR_DOGE}/blocks?a=${encodeURIComponent('date,avg(difficulty),max(id)')}&q=${encodeURIComponent('time(' + since + '..)')}`);
      const today = new Date().toISOString().slice(0, 10);
      const points = ((d && d.data) || []).filter((x) => x.date < today && Number(x['avg(difficulty)']) > 0)
        .map((x) => ({ ts: new Date(x.date + 'T23:59:00Z').toISOString(), height: Number(x['max(id)']), difficulty: Number(x['avg(difficulty)']) }));
      writeHistory(DOGE_FILE, existing.concat(points).sort((a, b) => new Date(a.ts) - new Date(b.ts)));
    } catch (e) {
      console.error('doge audit backfill failed', e && e.message);
    }
  }
  app.get('/api/network/doge-audit', (req, res) => {
    if (!dogeReading) return res.json({ ok: false, error: 'not sampled yet' });
    const early = dogeReading.earlyEra ? dogeReading.earlyEra.total : null;
    const history = readJson(DOGE_FILE, []).map((p) => (p.supply != null && early != null
      ? Object.assign({}, p, { actualSupply: p.supply, expectedSupply: dogeCap(early, p.height) })
      : p));
    res.json({ ok: true, reading: dogeReading, history });
  });

  // ------------------------------------------------------------------ Bitcoin Cash
  // The rule is Bitcoin Cash Node's GetBlockSubsidy (gitlab.com/bitcoin-cash-node, src/validation.cpp):
  // Bitcoin's own -- 50 BCH per block halved every 210,000 blocks, at most 21 million (MAX_MONEY) -- so
  // the cap is btcCap(). Difficulty is set again at every block (ASERT): there is no "next adjustment".
  // blockchair's summary figure for Bitcoin Cash is not used: on 2026-10-28 it counted 12 blocks more
  // than the chain's height and a supply 271.8 BCH above the cap. Its block table is right (one row per
  // height), so the supply here is the coins every block created -- reward minus fees, summed block by
  // block: once from the genesis block (two aggregate queries), then the new blocks every 6 hours (one
  // query; these cost blockchair allowance). The 24-hour and 30-day windows are made of those 6-hour
  // sums. Height, block times and the network hash rate come from a Bitcoin Cash Node instance
  // (rest.bch.actorforth.org).
  const BCH_FILE = path.join(DATA, 'bch-audit-history.json');
  const BCH_LAST_FILE = path.join(DATA, 'bch-audit-last.json');
  const BCH_STATE_FILE = path.join(DATA, 'bch-audit-state.json');
  const BLOCKCHAIR_BCH = 'https://api.blockchair.com/bitcoin-cash';
  const BCH_NODE = 'https://rest.bch.actorforth.org/v2';
  const BCH_STEP_MS = 6 * 3600 * 1000;
  // blockchair's servers do not all hold the same table: one answer can count orphaned blocks (more
  // rows than heights) and the next one not, so a range is asked up to three times
  async function bchSum(from, to) {
    let r = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((ok) => setTimeout(ok, 15000));
      r = await fetchJson(`${BLOCKCHAIR_BCH}/blocks?a=${encodeURIComponent('sum(reward),sum(fee_total),sum(transaction_count),count(),min(id),max(id)')}&q=${encodeURIComponent('id(' + from + '..' + to + ')')}`).then((x) => (x && x.data && x.data[0]) || null);
      if (r && Number(r['count()']) === to - from + 1 && Number(r['min(id)']) === from && Number(r['max(id)']) === to) break;
      r = null;
    }
    if (!r) throw new Error('blocks ' + from + '-' + to + ' not one row per height');
    const reward = Number(r['sum(reward)']) / SATS, fees = Number(r['sum(fee_total)']) / SATS;
    return { created: reward - fees, fees, txs: Number(r['sum(transaction_count)']) || 0 };
  }
  const bchBlockTime = async (height) => {
    const b = await fetchJson(`${BCH_NODE}/block/detailsByHeight/${height}`);
    const t = Number(b && b.time) * 1000;
    if (!(t > 0) || Number(b.height) !== height) throw new Error('no block ' + height + ' from the node');
    return t;
  };
  // brings the block-by-block sum up to the node's tip (at most every 6 hours); segments older than
  // 31 days are folded into the running total
  async function bchAdvance(tip) {
    const state = readJson(BCH_STATE_FILE, {});
    if (!state.base) {
      // first run: the last 24 hours and the 29 days before them are the first two steps (both windows
      // exist from the first reading); everything older is one running total
      const iso = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
      const span = async (fromMs, toMs) => {
        const r = await fetchJson(`${BLOCKCHAIR_BCH}/blocks?a=${encodeURIComponent('min(id),max(id)')}&q=${encodeURIComponent('time(' + iso(fromMs) + '..' + (toMs ? iso(toMs) : '') + ')')}`).then((x) => (x && x.data && x.data[0]) || null);
        if (!r || !(Number(r['max(id)']) >= Number(r['min(id)']))) throw new Error('no block span');
        return [Number(r['min(id)']), Number(r['max(id)'])];
      };
      const [a0] = await span(Date.now() - 30 * 86400 * 1000, Date.now() - 86400 * 1000);
      const [b0] = await span(Date.now() - 86400 * 1000, null);
      if (!(a0 > 500000 && b0 > a0 && tip >= b0)) throw new Error('unexpected block spans');
      const old1 = await bchSum(0, 499999);
      const old2 = await bchSum(500000, a0 - 1);
      const sa = await bchSum(a0, b0 - 1);
      const sb = await bchSum(b0, tip);
      const tA0 = await bchBlockTime(a0 - 1), tB0 = await bchBlockTime(b0 - 1), tTip = await bchBlockTime(tip);
      state.base = { to: a0 - 1, created: old1.created + old2.created, time: tA0, at: Date.now() };
      state.segments = [
        { from: a0, to: b0 - 1, created: sa.created, fees: sa.fees, txs: sa.txs, tFrom: tA0, tTo: tB0, at: Date.now() },
        { from: b0, to: tip, created: sb.created, fees: sb.fees, txs: sb.txs, tFrom: tB0, tTo: tTip, at: Date.now() },
      ];
    }
    const segs = state.segments || (state.segments = []);
    const last = segs.length ? segs[segs.length - 1] : null;
    const doneTo = last ? last.to : state.base.to;
    const doneAt = last ? last.at : state.base.at || 0;
    if (tip > doneTo && Date.now() - doneAt >= BCH_STEP_MS) {
      const s = await bchSum(doneTo + 1, tip);
      segs.push({ from: doneTo + 1, to: tip, created: s.created, fees: s.fees, txs: s.txs, tFrom: last ? last.tTo : state.base.time, tTo: await bchBlockTime(tip), at: Date.now() });
    }
    while (segs.length && segs[0].tTo < Date.now() - 31 * 86400 * 1000) {
      const old = segs.shift();
      state.base = { to: old.to, created: state.base.created + old.created, time: old.tTo, at: state.base.at };
    }
    if (!state.base.at) state.base.at = Date.now();
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(BCH_STATE_FILE, JSON.stringify(state));
    return state;
  }
  // the newest steps whose span is closest to the period (steps are about 6 hours long)
  function bchWindow(state, seconds) {
    const segs = state.segments || [];
    if (!segs.length) return null;
    const end = segs[segs.length - 1].tTo;
    let i = segs.length - 1;
    for (let k = segs.length - 1; k >= 0; k--) {
      if (Math.abs(end - segs[k].tFrom - seconds * 1000) < Math.abs(end - segs[i].tFrom - seconds * 1000)) i = k;
    }
    const span = end - segs[i].tFrom;
    if (Math.abs(span - seconds * 1000) > Math.max(6 * 3600 * 1000, seconds * 100)) return null; // not that much history
    const use = segs.slice(i);
    const created = use.reduce((t, s) => t + s.created, 0), fees = use.reduce((t, s) => t + s.fees, 0);
    const from = use[0].from, to = use[use.length - 1].to, blocks = to - from + 1;
    const byRule = btcSubsidyRange(from, to);
    return { blocks, fromHeight: from, toHeight: to, minted: created, byRule, fees, total: created + fees, txs: use.reduce((t, s) => t + s.txs, 0), avgBlockSec: span / 1000 / blocks, withinRule: created <= byRule + 1e-6 };
  }
  let bchPools = null;
  async function bchPoolList() {
    if (bchPools && Date.now() - bchPools.at < BCH_STEP_MS) return bchPools;
    const since = new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const d = await fetchJson(`${BLOCKCHAIR_BCH}/blocks?a=${encodeURIComponent('guessed_miner,count()')}&q=${encodeURIComponent('time(' + since + '..)')}`);
    const list = ((d && d.data) || []).map((x) => ({ name: String(x.guessed_miner || 'Unknown'), n: Number(x['count()']) || 0 }))
      .filter((x) => x.n > 0).sort((x, y) => y.n - x.n);
    if (!list.length) throw new Error('no pool list');
    if (list.every((x) => x.name === 'Unknown')) { bchPools = { at: Date.now(), pools: null, blocks: null }; return bchPools; }
    const pools = {};
    list.slice(0, 8).forEach((x) => { pools[x.name.replace(/[<>&"']/g, '').slice(0, 30)] = x.n; });
    const rest = list.slice(8).reduce((t, x) => t + x.n, 0);
    if (rest > 0) pools['…'] = rest;
    bchPools = { at: Date.now(), pools, blocks: list.reduce((t, x) => t + x.n, 0) };
    return bchPools;
  }
  let bchReading = readJson(BCH_LAST_FILE, null);
  async function sampleBch() {
    try {
      const info = await fetchJson(`${BCH_NODE}/blockchain/getBlockchainInfo`);
      const tip = Number(info && info.blocks);
      if (!(tip > 0) || info.initialblockdownload || Number(info.headers) !== tip) throw new Error('node not in sync');
      const state = await bchAdvance(tip);
      const segs = state.segments || [];
      const height = segs.length ? segs[segs.length - 1].to : state.base.to;
      const lastBlockAt = segs.length ? segs[segs.length - 1].tTo : state.base.time;
      // a sum that could not be brought forward for half a day is not an audit of the chain any more
      if (!(lastBlockAt > 0) || Date.now() - lastBlockAt > 12 * 3600 * 1000) throw new Error('block sums behind the chain');
      const supply = state.base.created + segs.reduce((t, s) => t + s.created, 0);
      const cap = btcCap(height);
      const ts = new Date().toISOString();
      const deviation = supply - cap;
      const mining = { d1: bchWindow(state, 86400), d30: bchWindow(state, 30 * 86400), adjustment: null, halving: null, pools: null, poolsBlocks: null };
      const nextHalving = (Math.floor(height / BTC_HALVING) + 1) * BTC_HALVING;
      const pace = mining.d30 ? mining.d30.avgBlockSec : (mining.d1 ? mining.d1.avgBlockSec : 600);
      mining.halving = { height: nextHalving, remainingBlocks: nextHalving - height, estimatedAt: new Date(Date.now() + (nextHalving - height) * pace * 1000).toISOString(), subsidyNow: Number(btcSubsidySats(height)) / SATS, subsidyNext: Number(btcSubsidySats(nextHalving)) / SATS };
      try {
        const pl = await bchPoolList();
        mining.pools = pl.pools;
        mining.poolsBlocks = pl.blocks;
      } catch (e) {
        console.error('bch pools failed', e && e.message);
        if (bchReading && bchReading.mining) { mining.pools = bchReading.mining.pools; mining.poolsBlocks = bchReading.mining.poolsBlocks; }
      }
      let hashrate = null;
      try { hashrate = Number((await fetchJson(`${BCH_NODE}/mining/getMiningInfo`)).networkhashps) || null; } catch (e) { console.error('bch hash rate failed', e && e.message); }
      const minedWithinRule = (!mining.d1 || mining.d1.withinRule) && (!mining.d30 || mining.d30.withinRule);
      bchReading = {
        ts,
        height,
        supply,
        actualSupply: supply,
        expectedSupply: cap,
        deviation,
        deviationPct: cap > 0 ? (deviation / cap) * 100 : 0,
        withinRule: supply <= cap + 1e-6 && minedWithinRule,
        supplyWithinCap: supply <= cap + 1e-6,
        maxSupply: 20999999.9769,
        blockSubsidy: Number(btcSubsidySats(height)) / SATS,
        nextHalvingHeight: nextHalving,
        nextSubsidy: Number(btcSubsidySats(nextHalving)) / SATS,
        difficulty: Number(info.difficulty) || null,
        hashrate,
        mining,
        masternodesOnline: null,
        masternodesOffline: null,
      };
      const history = readJson(BCH_FILE, []);
      const prev = history.length ? history[history.length - 1] : null;
      // the sum moves every 6 hours: a point is kept when the height moved (the chart has one per step)
      if (!prev || prev.height !== height) {
        history.push({ ts, height, supply, difficulty: bchReading.difficulty });
        writeHistory(BCH_FILE, history);
      }
      keep(BCH_LAST_FILE, bchReading);
      return true;
    } catch (e) {
      console.error('bch audit sample failed', e && e.message);
      return false;
    }
  }
  async function backfillBchDifficulty() {
    const existing = readJson(BCH_FILE, []);
    if (existing.length >= 20) return;
    try {
      const since = new Date(Date.now() - 31 * 86400 * 1000).toISOString().slice(0, 10);
      const d = await fetchJson(`${BLOCKCHAIR_BCH}/blocks?a=${encodeURIComponent('date,avg(difficulty),max(id)')}&q=${encodeURIComponent('time(' + since + '..)')}`);
      const today = new Date().toISOString().slice(0, 10);
      const points = ((d && d.data) || []).filter((x) => x.date < today && Number(x['avg(difficulty)']) > 0)
        .map((x) => ({ ts: new Date(x.date + 'T23:59:00Z').toISOString(), height: Number(x['max(id)']), difficulty: Number(x['avg(difficulty)']) }));
      writeHistory(BCH_FILE, existing.concat(points).sort((a, b) => new Date(a.ts) - new Date(b.ts)));
    } catch (e) {
      console.error('bch audit backfill failed', e && e.message);
    }
  }
  app.get('/api/network/bch-audit', (req, res) => {
    if (!bchReading) return res.json({ ok: false, error: 'not sampled yet' });
    const history = readJson(BCH_FILE, []).map((p) => (p.supply != null
      ? Object.assign({}, p, { actualSupply: p.supply, expectedSupply: btcCap(p.height) })
      : p));
    res.json({ ok: true, reading: bchReading, history });
  });

  // ------------------------------------------------------------------ Dash
  // The rule is Dash Core's GetBlockSubsidyHelper (dashpay/dash, src/validation.cpp) with the mainnet
  // values of src/chainparams.cpp: a base of 5 DASH (it depended on the previous block's difficulty, but
  // the difficulty never went below 3,400 after block 478,514, where the formula gives the 5 DASH floor;
  // since V20 it is fixed at 5), minus 1/14 at every 210,240 blocks (integer satoshis, one step per
  // period passed). From block 328,009 a part goes to the treasury (1/10, 1/5 from V20 at 1,987,776):
  // regular blocks may create the rest, and a superblock (every 16,616 blocks from 614,820) may pay up
  // to that part x 16,616 (CSuperblock::GetPaymentsLimit, src/governance/classes.cpp) -- unused
  // treasury is never created.
  // Blocks up to 614,819 (difficulty-based rewards, then the 12.0 budget system) are fixed history: the
  // cap takes what the chain created in them (blockchair's block table, one row per height, read once
  // and kept). The supply is chainz.cryptoid.info's count at the same node height.
  // Coins created in the windows come from blockchair's block table (reward minus fees, one row per
  // height) minus the fees of Platform withdrawals (asset unlock transactions, type 9): those fees are
  // coins that already existed in the credit pool, paid to the miner, and blockchair counts no fee for
  // them (seen 2026-10-28: 16 withdrawals of 190 satoshis = the 3,040 satoshis a day "above" the rule).
  // Each fee is read from the node's decoded transaction (blockchair raw endpoint) and kept.
  const DASH_FILE = path.join(DATA, 'dash-audit-history.json');
  const DASH_LAST_FILE = path.join(DATA, 'dash-audit-last.json');
  const DASH_STATE_FILE = path.join(DATA, 'dash-audit-state.json');
  const BLOCKCHAIR_DASH = 'https://api.blockchair.com/dash';
  const CHAINZ_DASH = 'https://chainz.cryptoid.info/dash/api.dws?q=';
  const DASH = { period: 210240, cycle: 16616, sbStart: 614820, v20: 1987776, budgetStart: 328008, ruleFrom: 614820 };
  function dashSubsidySats(height) {
    let n = 500000000n;
    for (let i = 0, k = Math.floor((height - 1) / DASH.period); i < k; i++) n -= n / 14n;
    return n;
  }
  const dashTreasurySats = (height, s) => (height - 1 > DASH.budgetStart ? s / (height >= DASH.v20 ? 5n : 10n) : 0n);
  // the most blocks from..to may create: every block's share plus each superblock's payment limit
  function dashRuleSum(from, to) {
    let total = 0n;
    for (let h = from; h <= to;) {
      // a stretch where the subsidy and the treasury share do not change
      let end = Math.min(to, (Math.floor((h - 1) / DASH.period) + 1) * DASH.period);
      if (h < DASH.v20 && end >= DASH.v20) end = DASH.v20 - 1;
      const s = dashSubsidySats(h), p = dashTreasurySats(h, s);
      const first = Math.max(h, DASH.sbStart);
      const superblocks = end >= first ? Math.floor(end / DASH.cycle) - Math.floor((first - 1) / DASH.cycle) : 0;
      total += (s - p) * BigInt(end - h + 1) + p * BigInt(DASH.cycle) * BigInt(superblocks);
      h = end + 1;
    }
    return Number(total) / SATS;
  }
  const dashCap = (early, height) => early + dashRuleSum(DASH.ruleFrom, height);
  async function dashAggregate(q) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((ok) => setTimeout(ok, 15000));
      const r = await fetchJson(`${BLOCKCHAIR_DASH}/blocks?a=${encodeURIComponent('sum(reward),sum(fee_total),sum(transaction_count),count(),min(id),max(id)')}&q=${encodeURIComponent(q)}`).then((x) => (x && x.data && x.data[0]) || null);
      if (r && Number(r['count()']) === Number(r['max(id)']) - Number(r['min(id)']) + 1) return r;
    }
    throw new Error('blocks ' + q + ' not one row per height');
  }
  // fees of the Platform withdrawals of blocks from..to, from the node's decoded transactions (kept by hash)
  async function dashUnlockFees(state, from, to) {
    const known = state.unlocks || (state.unlocks = {});
    let total = 0, offset = 0;
    for (;;) {
      const page = await fetchJson(`${BLOCKCHAIR_DASH}/transactions?q=${encodeURIComponent('block_id(' + from + '..' + to + '),type(subtxtopup)')}&limit=100&offset=${offset}`);
      const list = (page && page.data) || [];
      for (const t of list) {
        const hash = String(t.hash || '');
        if (!/^[0-9a-f]{64}$/.test(hash)) continue;
        if (!known[hash]) {
          const raw = await fetchJson(`${BLOCKCHAIR_DASH}/raw/transaction/${hash}`);
          const tx = raw && raw.data && raw.data[hash] && raw.data[hash].decoded_raw_transaction;
          const fee = Number(tx && tx.assetUnlockTx && tx.assetUnlockTx.fee);
          if (!tx || tx.type !== 9 || !(fee >= 0)) throw new Error('withdrawal ' + hash + ' not decoded');
          known[hash] = [Number(t.block_id), fee];
          await new Promise((ok) => setTimeout(ok, 2500));
        }
        total += known[hash][1];
      }
      if (list.length < 100) break;
      offset += 100;
    }
    return total / SATS;
  }
  async function dashSegment(state, from, to, tFrom, tTo) {
    const r = await dashAggregate('id(' + from + '..' + to + ')');
    if (Number(r['min(id)']) !== from || Number(r['max(id)']) !== to) throw new Error('blocks ' + from + '-' + to + ' incomplete');
    const fees = Number(r['sum(fee_total)']) / SATS;
    const unlockFees = await dashUnlockFees(state, from, to);
    return { from, to, created: Number(r['sum(reward)']) / SATS - fees - unlockFees, fees, unlockFees, txs: Number(r['sum(transaction_count)']) || 0, tFrom, tTo, at: Date.now() };
  }
  const dashBlockTime = async (height) => {
    const d = await fetchJson(`${BLOCKCHAIR_DASH}/blocks?q=${encodeURIComponent('id(' + height + ')')}&limit=1`);
    const b = d && d.data && d.data[0];
    const t = b ? Date.parse(String(b.time).replace(' ', 'T') + 'Z') : NaN;
    if (!(t > 0) || Number(b.id) !== height) throw new Error('no block ' + height);
    return t;
  };
  async function dashAdvance(tip) {
    const state = readJson(DASH_STATE_FILE, {});
    if (!state.early || !state.segments) {
      // first run (normally seeded): the history total, then the 29 days before the last 24 hours and the last 24 hours
      // in two ranges: a shorter range is more often answered by a server without orphaned blocks
      let early = 0;
      for (const [a, b] of [[0, 478599], [478600, DASH.ruleFrom - 1]]) {
        const e = await dashAggregate('id(' + a + '..' + b + ')');
        if (Number(e['min(id)']) !== a || Number(e['max(id)']) !== b) throw new Error('history blocks incomplete');
        early += (Number(e['sum(reward)']) - Number(e['sum(fee_total)'])) / SATS;
      }
      state.early = { total: early, to: DASH.ruleFrom - 1, at: new Date().toISOString() };
      const span = async (fromMs, toMs) => {
        const iso = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
        const r = await dashAggregate('time(' + iso(fromMs) + '..' + (toMs ? iso(toMs) : '') + ')');
        return Number(r['min(id)']);
      };
      const a0 = await span(Date.now() - 30 * 86400 * 1000, Date.now() - 86400 * 1000);
      const b0 = await span(Date.now() - 86400 * 1000, null);
      if (!(a0 > DASH.ruleFrom && b0 > a0 && tip >= b0)) throw new Error('unexpected block spans');
      const tA = await dashBlockTime(a0 - 1), tB = await dashBlockTime(b0 - 1), tT = await dashBlockTime(tip);
      state.segments = [await dashSegment(state, a0, b0 - 1, tA, tB), await dashSegment(state, b0, tip, tB, tT)];
    }
    const segs = state.segments;
    const last = segs[segs.length - 1];
    if (tip > last.to && Date.now() - last.at >= 6 * 3600 * 1000) {
      segs.push(await dashSegment(state, last.to + 1, tip, last.tTo, await dashBlockTime(tip)));
    }
    while (segs.length > 2 && segs[0].tTo < Date.now() - 31 * 86400 * 1000) segs.shift();
    // withdrawal fees older than the kept steps are not needed any more
    const oldest = segs[0].from;
    Object.keys(state.unlocks || {}).forEach((h) => { if (state.unlocks[h][0] < oldest) delete state.unlocks[h]; });
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(DASH_STATE_FILE, JSON.stringify(state));
    return state;
  }
  function dashWindow(state, seconds) {
    const segs = state.segments || [];
    if (!segs.length) return null;
    const end = segs[segs.length - 1].tTo;
    let i = segs.length - 1;
    for (let k = segs.length - 1; k >= 0; k--) {
      if (Math.abs(end - segs[k].tFrom - seconds * 1000) < Math.abs(end - segs[i].tFrom - seconds * 1000)) i = k;
    }
    const span = end - segs[i].tFrom;
    if (Math.abs(span - seconds * 1000) > Math.max(6 * 3600 * 1000, seconds * 100)) return null;
    const use = segs.slice(i);
    const sum = (k) => use.reduce((t, s) => t + s[k], 0);
    const created = sum('created'), fees = sum('fees');
    const from = use[0].from, to = use[use.length - 1].to, blocks = to - from + 1;
    const byRule = dashRuleSum(from, to);
    const superblocks = Math.floor(to / DASH.cycle) - Math.floor((from - 1) / DASH.cycle);
    return { blocks, fromHeight: from, toHeight: to, minted: created, byRule, fees, total: created + fees, txs: sum('txs'), unlockFees: sum('unlockFees'), superblocks, avgBlockSec: span / 1000 / blocks, withinRule: created <= byRule + 1e-6 };
  }
  let dashPools = null;
  async function dashPoolList() {
    if (dashPools && Date.now() - dashPools.at < (dashPools.pools ? 6 : 24) * 3600 * 1000) return dashPools;
    const since = new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const d = await fetchJson(`${BLOCKCHAIR_DASH}/blocks?a=${encodeURIComponent('guessed_miner,count()')}&q=${encodeURIComponent('time(' + since + '..)')}`);
    const list = ((d && d.data) || []).map((x) => ({ name: String(x.guessed_miner || 'Unknown'), n: Number(x['count()']) || 0 }))
      .filter((x) => x.n > 0).sort((x, y) => y.n - x.n);
    if (!list.length) throw new Error('no pool list');
    if (list.every((x) => x.name === 'Unknown')) { dashPools = { at: Date.now(), pools: null, blocks: null }; return dashPools; }
    const pools = {};
    list.slice(0, 8).forEach((x) => { pools[x.name.replace(/[<>&"']/g, '').slice(0, 30)] = x.n; });
    const rest = list.slice(8).reduce((t, x) => t + x.n, 0);
    if (rest > 0) pools['…'] = rest;
    dashPools = { at: Date.now(), pools, blocks: list.reduce((t, x) => t + x.n, 0) };
    return dashPools;
  }
  let dashReading = readJson(DASH_LAST_FILE, null);
  async function sampleDash() {
    try {
      // chainz answers a challenge to quick requests: one call, a pause, the next one
      const chainz = async (q) => { const t = await (await fetch(CHAINZ_DASH + q, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text(); await new Promise((ok) => setTimeout(ok, 12000)); return t.trim(); };
      const h1 = Number(await chainz('getblockcount'));
      const supply = Number(await chainz('totalcoins'));
      const h2 = Number(await chainz('getblockcount'));
      const difficulty = Number(await chainz('getdifficulty'));
      if (!(h1 > 0) || h2 !== h1 || !(supply > 0)) throw new Error('chainz reading not in step (' + h1 + '/' + h2 + ')');
      const height = h1;
      const state = await dashAdvance(height);
      const segs = state.segments;
      if (Date.now() - segs[segs.length - 1].tTo > 12 * 3600 * 1000) throw new Error('block sums behind the chain');
      const cap = dashCap(state.early.total, height);
      const ts = new Date().toISOString();
      const deviation = supply - cap;
      const mining = { d1: dashWindow(state, 86400), d30: dashWindow(state, 30 * 86400), adjustment: null, halving: null, pools: null, poolsBlocks: null };
      try {
        const pl = await dashPoolList();
        mining.pools = pl.pools;
        mining.poolsBlocks = pl.blocks;
      } catch (e) {
        console.error('dash pools failed', e && e.message);
        if (dashReading && dashReading.mining) { mining.pools = dashReading.mining.pools; mining.poolsBlocks = dashReading.mining.poolsBlocks; }
      }
      const minedWithinRule = (!mining.d1 || mining.d1.withinRule) && (!mining.d30 || mining.d30.withinRule);
      const subsidy = dashSubsidySats(height + 1);
      dashReading = {
        ts,
        height,
        supply,
        actualSupply: supply,
        expectedSupply: cap,
        deviation,
        deviationPct: cap > 0 ? (deviation / cap) * 100 : 0,
        withinRule: supply <= cap + 1e-6 && minedWithinRule,
        supplyWithinCap: supply <= cap + 1e-6,
        maxSupply: null,
        earlyEra: state.early,
        blockSubsidy: Number(subsidy) / SATS,
        treasuryShare: Number(dashTreasurySats(height + 1, subsidy)) / SATS,
        nextHalvingHeight: null,
        nextSubsidy: null,
        difficulty: difficulty > 0 ? difficulty : null,
        // the network hash rate the difficulty implies at the 150-second target (difficulty x 2^32 / spacing)
        hashrate: difficulty > 0 ? (difficulty * 4294967296) / 150 : null,
        mining,
        masternodesOnline: null,
        masternodesOffline: null,
      };
      const history = readJson(DASH_FILE, []);
      history.push({ ts, height, supply, difficulty: dashReading.difficulty });
      writeHistory(DASH_FILE, history);
      keep(DASH_LAST_FILE, dashReading);
      return true;
    } catch (e) {
      console.error('dash audit sample failed', e && e.message);
      return false;
    }
  }
  async function backfillDashDifficulty() {
    const existing = readJson(DASH_FILE, []);
    if (existing.length >= 20) return;
    try {
      const since = new Date(Date.now() - 31 * 86400 * 1000).toISOString().slice(0, 10);
      const d = await fetchJson(`${BLOCKCHAIR_DASH}/blocks?a=${encodeURIComponent('date,avg(difficulty),max(id)')}&q=${encodeURIComponent('time(' + since + '..)')}`);
      const today = new Date().toISOString().slice(0, 10);
      const points = ((d && d.data) || []).filter((x) => x.date < today && Number(x['avg(difficulty)']) > 0)
        .map((x) => ({ ts: new Date(x.date + 'T23:59:00Z').toISOString(), height: Number(x['max(id)']), difficulty: Number(x['avg(difficulty)']) }));
      writeHistory(DASH_FILE, existing.concat(points).sort((a, b) => new Date(a.ts) - new Date(b.ts)));
    } catch (e) {
      console.error('dash audit backfill failed', e && e.message);
    }
  }
  app.get('/api/network/dash-audit', (req, res) => {
    if (!dashReading) return res.json({ ok: false, error: 'not sampled yet' });
    const early = dashReading.earlyEra ? dashReading.earlyEra.total : null;
    const history = readJson(DASH_FILE, []).map((p) => (p.supply != null && early != null
      ? Object.assign({}, p, { actualSupply: p.supply, expectedSupply: dashCap(early, p.height) })
      : p));
    res.json({ ok: true, reading: dashReading, history });
  });

  // ------------------------------------------------------------------ Ethereum
  // Since the Merge (block 15,537,394, 2022-09-15) no block creates ether on the execution layer; the
  // only new ether is the consensus layer's rewards, and the protocol burns the base fee of every block
  // (EIP-1559) and the blob fee (EIP-4844). The consensus specs (Altair, get_base_reward_per_increment)
  // fix the most the rewards can add in one epoch: the base rewards of every active validator,
  // 64 x sqrt(total active stake) Gwei, all duties done perfectly. That maximum is recovered from the
  // sync committee: each member's reward is that total x 2/64 / 32 slots / 512 members (integer
  // divisions), so (reward + 1) x 524,288 Gwei is never below it.
  // As for Solana there is no fixed maximum: the cap starts at the supply of the first check and grows
  // by that maximum for every slot since (1/32 of an epoch's) minus the ether burned, block by block,
  // plus two epochs of slack (attestation rewards are paid in a lump at each epoch boundary).
  // The supply (ultrasound.money: balances of every account plus validator balances, less the deposits
  // still counted in the deposit contract) and the burn of each block (base fee x gas used + blob
  // base fee x blob gas used, from an Ethereum node) are compared over 24 hours and 30 days as well:
  // new ether = supply change + ether burned, never above the rule's maximum for the same slots.
  const ETH_FILE = path.join(DATA, 'eth-audit-history.json');
  const ETH_LAST_FILE = path.join(DATA, 'eth-audit-last.json');
  const ETH_STATE_FILE = path.join(DATA, 'eth-audit-state.json');
  const ETH_SUPPLY_PARTS = 'https://ultrasound.money/api/v2/fees/supply-parts';
  const ETH_RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'];
  const ETH_BEACON = 'https://ethereum-beacon-api.publicnode.com';
  const ETH_GENESIS_TIME = 1606824023; // beacon chain genesis; 12 s per slot, 32 slots per epoch
  const GWEI = 1000000000n;
  const WEI_PER_ETH = 1000000000000000000n;
  const ethNum = (wei) => Number(wei / 1000000000n) / 1e9; // wei -> ether (Gwei precision)
  async function ethPost(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error('upstream status ' + r.status);
    return r.json();
  }
  // JSON-RPC batch on the first node that answers every call (public nodes limit bursts)
  async function ethRpc(calls) {
    let last = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
      try {
        const res = await ethPost(ETH_RPCS[attempt % ETH_RPCS.length], calls.map((c, id) => Object.assign({ jsonrpc: '2.0', id }, c)));
        if (Array.isArray(res) && res.length === calls.length && res.every((x) => x && x.result != null)) return res.sort((a, b) => a.id - b.id).map((x) => x.result);
        last = new Error('incomplete answer');
      } catch (e) { last = e; }
    }
    throw last;
  }
  // ether burned by blocks from..to (inclusive): base fee and blob fee, with each block's number and hash
  async function ethBurnBlocks(from, to) {
    const out = [];
    for (let start = from; start <= to; start += 1024) {
      const end = Math.min(to, start + 1023);
      // the blob base fee of each block comes from the node itself (its formula changed with each fork)
      const fh = (await ethRpc([{ method: 'eth_feeHistory', params: ['0x' + (end - start + 1).toString(16), '0x' + end.toString(16), []] }]))[0];
      const oldest = parseInt(fh.oldestBlock, 16);
      if (oldest !== start || !Array.isArray(fh.baseFeePerBlobGas)) throw new Error('fee history does not match');
      for (let b = start; b <= end; b += 20) {
        const ids = [];
        for (let h = b; h <= Math.min(end, b + 19); h++) ids.push(h);
        const blocks = await ethRpc(ids.map((h) => ({ method: 'eth_getBlockByNumber', params: ['0x' + h.toString(16), false] })));
        blocks.forEach((B, i) => {
          const h = parseInt(B.number, 16);
          if (h !== ids[i]) throw new Error('wrong block');
          if (BigInt(fh.baseFeePerGas[h - oldest]) !== BigInt(B.baseFeePerGas)) throw new Error('fee history disagrees with block ' + h);
          const blobGas = BigInt(B.blobGasUsed || '0x0');
          const burn = BigInt(B.baseFeePerGas) * BigInt(B.gasUsed) + (blobGas > 0n ? blobGas * BigInt(fh.baseFeePerBlobGas[h - oldest]) : 0n);
          out.push({ n: h, hash: B.hash, parent: B.parentHash, time: parseInt(B.timestamp, 16), burn: String(burn) });
        });
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    for (let i = 1; i < out.length; i++) if (out[i].parent !== out[i - 1].hash) throw new Error('blocks changed while being read');
    return out;
  }
  // the most one epoch's rewards can be, in Gwei (from the sync committee rewards of the newest block)
  async function ethEpochMax() {
    const d = await ethPost(ETH_BEACON + '/eth/v1/beacon/rewards/sync_committee/head', []);
    const rewards = ((d && d.data) || []).map((x) => BigInt(x.reward));
    if (rewards.length !== 512) throw new Error('no sync committee rewards');
    const participant = rewards.reduce((m, v) => (v > m ? v : m), 0n);
    if (!(participant > 0n)) throw new Error('no sync committee rewards');
    return (participant + 1n) * 524288n;
  }
  // new ether, burn and supply change between the reading closest to the start of the window and now
  function ethWindow(now, seconds, slack) {
    const target = Date.parse(now.ts) - seconds * 1000;
    let then = null;
    readJson(ETH_FILE, []).forEach((p) => {
      const off = Math.abs(Date.parse(p.ts) - target);
      if (p.supplyWei && p.cumBurnWei && off <= slack && (!then || off < Math.abs(Date.parse(then.ts) - target))) then = p;
    });
    if (!then || !(now.block > then.block)) return null;
    const net = BigInt(now.supplyWei) - BigInt(then.supplyWei);
    const burned = BigInt(now.cumBurnWei) - BigInt(then.cumBurnWei);
    const issued = net + burned;
    const epochMax = BigInt(now.epochMax) > BigInt(then.epochMax) ? BigInt(now.epochMax) : BigInt(then.epochMax);
    const maxWei = (BigInt(now.cumMaxGwei) - BigInt(then.cumMaxGwei) + 2n * epochMax) * GWEI;
    const blocks = now.block - then.block;
    return {
      blocks, fromHeight: then.block + 1, toHeight: now.block,
      epochs: (now.slot - then.slot) / 32,
      minted: ethNum(issued), byRule: ethNum(maxWei), burned: ethNum(burned), net: ethNum(net),
      fees: null, total: null, txs: null,
      avgBlockSec: (now.blockTime - then.blockTime) / blocks,
      withinRule: issued <= maxWei,
    };
  }
  let ethReading = readJson(ETH_LAST_FILE, null);
  async function sampleEth() {
    try {
      const parts = await fetchJson(ETH_SUPPLY_PARTS);
      const block = Number(parts.blockNumber);
      const slot = Number(parts.slot);
      const supplyWei = BigInt(parts.executionBalancesSum) + (BigInt(parts.beaconBalancesSum) - BigInt(parts.beaconDepositsSum)) * GWEI;
      const supply = ethNum(supplyWei);
      if (!(block > 0) || !(slot > 0) || !(supply > 100e6 && supply < 200e6)) throw new Error('no reading');
      if (Date.now() / 1000 - (ETH_GENESIS_TIME + slot * 12) > 3600) throw new Error('source behind the chain');
      const epochMax = await ethEpochMax();
      const state = readJson(ETH_STATE_FILE, {});
      const ts = new Date().toISOString();
      let blockTime;
      if (!state.anchor) {
        const [B] = await ethRpc([{ method: 'eth_getBlockByNumber', params: ['0x' + block.toString(16), false] }]);
        blockTime = parseInt(B.timestamp, 16);
        Object.assign(state, { anchor: { ts, block, slot, supplyWei: String(supplyWei) }, block, slot, cumBurnWei: '0', cumMaxGwei: '0', epochMax: String(epochMax), recent: [{ n: block, hash: B.hash, burn: '0' }] });
      } else {
        if (block < state.block || slot < state.slot) throw new Error('source went back');
        let cumBurn = BigInt(state.cumBurnWei);
        let recent = state.recent || [];
        let from = state.block + 1;
        if (block >= from) {
          let fresh = await ethBurnBlocks(from, block);
          // a block the last reading counted was replaced (reorg): take its burn back and read again from the fork
          if (fresh.length && recent.length && fresh[0].parent !== recent[recent.length - 1].hash) {
            const [P] = await ethRpc([{ method: 'eth_getBlockByNumber', params: ['0x' + (from - 1).toString(16), false] }]);
            let fork = recent.length - 1;
            while (fork >= 0 && recent[fork].hash !== P.hash) {
              const [C] = await ethRpc([{ method: 'eth_getBlockByNumber', params: ['0x' + recent[fork].n.toString(16), false] }]);
              if (C.hash === recent[fork].hash) break;
              cumBurn -= BigInt(recent[fork].burn);
              fork--;
            }
            if (fork < 0) throw new Error('reorg deeper than the blocks kept');
            recent = recent.slice(0, fork + 1);
            fresh = await ethBurnBlocks(recent[fork].n + 1, block);
          }
          fresh.forEach((b) => { cumBurn += BigInt(b.burn); });
          recent = recent.concat(fresh.map((b) => ({ n: b.n, hash: b.hash, burn: b.burn }))).slice(-64);
          blockTime = fresh.length ? fresh[fresh.length - 1].time : state.blockTime;
        } else blockTime = state.blockTime;
        // each slot since the last reading may add 1/32 of an epoch's maximum, at the higher of the two maxima
        const prevMax = BigInt(state.epochMax);
        const stepMax = epochMax > prevMax ? epochMax : prevMax;
        const cumMax = BigInt(state.cumMaxGwei) + (BigInt(slot - state.slot) * stepMax + 31n) / 32n;
        Object.assign(state, { block, slot, cumBurnWei: String(cumBurn), cumMaxGwei: String(cumMax), epochMax: String(epochMax), recent });
      }
      state.blockTime = blockTime;
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(ETH_STATE_FILE, JSON.stringify(state));

      const capWei = BigInt(state.anchor.supplyWei) + (BigInt(state.cumMaxGwei) + 2n * epochMax) * GWEI - BigInt(state.cumBurnWei);
      const cap = ethNum(capWei);
      const now = { ts, block, slot, blockTime, supplyWei: String(supplyWei), cumBurnWei: state.cumBurnWei, cumMaxGwei: state.cumMaxGwei, epochMax: String(epochMax) };
      const d1 = ethWindow(now, 86400, 3600 * 1000);
      const d30 = ethWindow(now, 30 * 86400, 13 * 3600 * 1000);
      // yearly change of the supply: the last 24 hours, or since the first reading until then
      const base = d1 || ethWindow(now, (Date.now() - Date.parse(state.anchor.ts)) / 1000, 30 * 60 * 1000);
      const inflationRate = base && base.blocks > 100 ? (base.net / supply) * (365.25 * 86400) / (base.avgBlockSec * base.blocks) : null;
      const supplyWithinCap = supplyWei <= capWei;
      const deviation = supply - cap;
      ethReading = {
        ts,
        height: block,
        slot,
        epoch: Math.floor(slot / 32),
        supply,
        actualSupply: supply,
        expectedSupply: cap,
        deviation,
        deviationPct: cap > 0 ? (deviation / cap) * 100 : 0,
        withinRule: supplyWithinCap && (!d1 || d1.withinRule) && (!d30 || d30.withinRule),
        supplyWithinCap,
        maxSupply: null,
        anchorTs: state.anchor.ts,
        anchorBlock: state.anchor.block,
        anchorSupply: ethNum(BigInt(state.anchor.supplyWei)),
        burnedSinceAnchor: ethNum(BigInt(state.cumBurnWei)),
        inflationRate,
        stake: {
          // 64 x sqrt(total active stake) Gwei per epoch, so the stake behind the maximum (to ~0.01%)
          activeStake: Math.pow(Number(epochMax) / 64, 2) / 1e9,
          maxPerEpoch: Number(epochMax) / 1e9,
          maxPerDay: (Number(epochMax) * 225) / 1e9,
        },
        blockSubsidy: null,
        difficulty: null,
        hashrate: null,
        mining: { d1, d30, adjustment: null, halving: null, pools: null, poolsBlocks: null },
        masternodesOnline: null,
        masternodesOffline: null,
      };
      const history = readJson(ETH_FILE, []);
      history.push(Object.assign({ supply, cap }, now));
      writeHistory(ETH_FILE, history);
      keep(ETH_LAST_FILE, ethReading);
      return true;
    } catch (e) {
      console.error('eth audit sample failed', e && e.message);
      return false;
    }
  }
  app.get('/api/network/eth-audit', (req, res) => {
    if (!ethReading) return res.json({ ok: false, error: 'not sampled yet' });
    const history = readJson(ETH_FILE, []).map((p) => ({ ts: p.ts, height: p.block, slot: p.slot, supply: p.supply, actualSupply: p.supply, expectedSupply: p.cap }));
    res.json({ ok: true, reading: ethReading, history });
  });

  // ------------------------------------------------------------------ BNB
  // BNB Smart Chain has no block reward (bnb-chain/bsc, consensus/parlia/parlia.go, distributeIncoming):
  // each block only moves the fees its transactions paid, collected at the system address, to the
  // validator through BSCValidatorSet.deposit (bnb-chain/bsc-genesis-contract), which sends
  // burnRatio / BLOCK_FEES_RATIO_SCALE of them (BEP-95, 10% when this was written) to 0x...dEaD. The
  // BNB Foundation's quarterly Auto-Burn goes to the same address. So no BNB is ever created and the
  // supply only falls.
  // The supply is the figure of BNB Chain's burn tracker (bnbburn.info, by NodeReal; bnbchain.org links
  // it for burn data): BNB on BSC less what sits at 0x...dEaD and at the zero address. supply + those two
  // balances, read from a BSC node at one block, must stay equal to its value at the first check (a rise
  // is BNB created); the tracker's own figure for 0x...dEaD must match the node's, or it is behind and the
  // reading waits. Measured on 2026-11-17 over 12 minutes: 149,757,429.07 +/- 0.05 BNB, including a 1.57 BNB
  // claim of old Beacon Chain BNB from TokenHub (0x...1004), which the tracker already counts as supply.
  // Every check also reads the latest 20 blocks and confirms, block by block, deposit = the block's fees
  // (gas used x effective gas price + blob gas x blob gas price) and the burn = burnRatio of it (180 blocks
  // in a row matched exactly on 2026-11-17). Public BSC nodes keep the state of about the last 100 blocks
  // only, hence the short sample. The quarterly burns the tracker lists are matched with their own
  // transactions on the chain.
  const BNB_FILE = path.join(DATA, 'bnb-audit-history.json');
  const BNB_LAST_FILE = path.join(DATA, 'bnb-audit-last.json');
  const BNB_STATE_FILE = path.join(DATA, 'bnb-audit-state.json');
  const BNB_TRACKER = 'https://www.bnbburn.info/api/';
  const BNB_RPCS = ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.bnbchain.org', 'https://bsc-dataseed1.defibit.io'];
  const BNB_DEAD = '0x000000000000000000000000000000000000dead';
  const BNB_ZERO = '0x0000000000000000000000000000000000000000';
  const BNB_VALIDATOR_SET = '0x0000000000000000000000000000000000001000';
  const BNB_SYSTEM = '0xfffffffffffffffffffffffffffffffffffffffe'; // where a block's fees gather (consensus.SystemAddress)
  const BNB_DEPOSIT = '0xf340fa01'; // deposit(address)
  const BNB_SAMPLE_BLOCKS = 20;
  const BNB_TOL_WEI = 1000000000000000000n; // 1 BNB: the tracker rounds to 0.01 and lags a few seconds
  const WEI_PER_BNB = 1000000000000000000n;
  const bnbNum = (wei) => Number(wei / 1000000000n) / 1e9; // wei -> BNB (Gwei precision)
  const bnbWei = (v) => { // a decimal BNB figure of the tracker -> wei
    const s = String(v);
    if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('not a BNB figure: ' + s);
    const [i, f = ''] = s.split('.');
    return BigInt(i) * WEI_PER_BNB + BigInt((f + '000000000000000000').slice(0, 18));
  };
  const hex =(n) => '0x' + n.toString(16);
  async function bnbRpc(calls) {
    let last = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
      try {
        const r = await fetch(BNB_RPCS[attempt % BNB_RPCS.length], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(calls.map((c, id) => Object.assign({ jsonrpc: '2.0', id }, c))), signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw new Error('upstream status ' + r.status);
        const res = await r.json();
        if (Array.isArray(res) && res.length === calls.length && res.every((x) => x && x.result != null)) return res.sort((a, b) => a.id - b.id).map((x) => x.result);
        last = new Error('incomplete answer');
      } catch (e) { last = e; }
    }
    throw last;
  }
  // blocks from..to: what the block paid the validator (deposit), its fees, and what reached 0x...dEaD
  async function bnbCheckBlocks(from, to, ratio, scale) {
    let checked = 0, ok = 0;
    const bad = [];
    for (let start = from; start <= to; start += 5) {
      const ids = [];
      for (let n = start; n <= Math.min(to, start + 4); n++) ids.push(n);
      const res = await bnbRpc(ids.flatMap((n) => [
        { method: 'eth_getBlockByNumber', params: [hex(n), true] },
        { method: 'eth_getBlockReceipts', params: [hex(n)] },
        { method: 'eth_getBalance', params: [BNB_DEAD, hex(n - 1)] },
        { method: 'eth_getBalance', params: [BNB_DEAD, hex(n)] },
      ]));
      ids.forEach((n, k) => {
        const [B, R, d0, d1] = res.slice(k * 4, k * 4 + 4);
        if (parseInt(B.number, 16) !== n || !Array.isArray(R) || R.length !== B.transactions.length) throw new Error('block ' + n + ' incomplete');
        let fees = 0n, deposit = 0n, deposits = 0, direct = 0n, toDead = 0n;
        B.transactions.forEach((t, i) => {
          const rc = R[i];
          if (rc.transactionHash !== t.hash) throw new Error('receipts out of order in block ' + n);
          fees += BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice) + (rc.blobGasUsed ? BigInt(rc.blobGasUsed) * BigInt(rc.blobGasPrice || '0x0') : 0n);
          const dest = String(t.to || '').toLowerCase();
          if (dest === BNB_VALIDATOR_SET && String(t.input).startsWith(BNB_DEPOSIT)) { deposit += BigInt(t.value); deposits++; }
          if (dest === BNB_SYSTEM) direct += BigInt(t.value);
          if (dest === BNB_DEAD && rc.status === '0x1') toDead += BigInt(t.value);
        });
        const burn = deposit * ratio / scale;
        const burnedHere = BigInt(d1) - BigInt(d0);
        checked++;
        // one deposit at most, equal to the fees (plus BNB sent straight to the system address), and at
        // least the contract's share of it reaching 0x...dEaD (other transfers there only add to it)
        if (deposits <= 1 && deposit === fees + direct && burnedHere >= burn + toDead) ok++;
        else bad.push({ block: n, fees: String(fees), deposit: String(deposit), burned: String(burnedHere), expectedBurn: String(burn) });
      });
    }
    return { from, to, checked, ok, bad: bad.slice(0, 5) };
  }
  // the latest quarterly burns the tracker lists, matched with their transactions (kept once confirmed)
  async function bnbQuarterly(state) {
    const q = await fetchJson(BNB_TRACKER + 'getQuarterBurns');
    const quarters = (q && Array.isArray(q.quarters)) ? q.quarters.slice().sort((a, b) => b.rank - a.rank) : [];
    const next = quarters.find((x) => !x.burnDate && !x.txLink);
    const done = quarters.filter((x) => x.burnDate && /\/tx\/0x[0-9a-fA-F]{64}$/.test(x.txLink || '')).slice(0, 4);
    state.burnTx = state.burnTx || {};
    const out = [];
    for (const x of done) {
      const tx = x.txLink.split('/tx/')[1].toLowerCase();
      let v = state.burnTx[tx];
      if (!v) {
        const [T, Rc] = await bnbRpc([{ method: 'eth_getTransactionByHash', params: [tx] }, { method: 'eth_getTransactionReceipt', params: [tx] }]);
        v = { to: String(T.to || '').toLowerCase(), valueWei: String(BigInt(T.value)), status: Rc.status, block: parseInt(T.blockNumber, 16) };
        state.burnTx[tx] = v;
      }
      const onChain = bnbNum(BigInt(v.valueWei));
      const amount = Number(x.amount);
      out.push({ name: x.name, rank: x.rank, date: x.burnDate, amount, tx, block: v.block, onChain,
        matches: v.to === BNB_DEAD && v.status === '0x1' && Math.abs(onChain - amount) <= 0.001 });
    }
    return { quarterly: out, nextBurn: next ? { name: next.name, amount: Number(next.amount) } : null };
  }
  // supply change, burn and BNB created between the reading closest to the start of the window and now
  function bnbWindow(now, seconds, slack) {
    const target = Date.parse(now.ts) - seconds * 1000;
    let then = null;
    readJson(BNB_FILE, []).forEach((p) => {
      const off = Math.abs(Date.parse(p.ts) - target);
      if (p.supplyWei && p.burnedWei && off <= slack && (!then || off < Math.abs(Date.parse(then.ts) - target))) then = p;
    });
    if (!then || !(now.block > then.block)) return null;
    const net = BigInt(now.supplyWei) - BigInt(then.supplyWei);
    const burned = BigInt(now.burnedWei) - BigInt(then.burnedWei);
    const created = net + burned;
    const blocks = now.block - then.block;
    return {
      blocks, fromHeight: then.block + 1, toHeight: now.block,
      // inside the tolerance the change is the tracker's rounding, not BNB: shown as zero
      minted: created > BNB_TOL_WEI || -created > BNB_TOL_WEI ? bnbNum(created) : 0,
      createdExact: bnbNum(created),
      byRule: 0, burned: bnbNum(burned), net: bnbNum(net),
      fees: null, total: null, txs: null,
      avgBlockSec: (now.blockTime - then.blockTime) / blocks,
      withinRule: created <= BNB_TOL_WEI,
    };
  }
  let bnbReading = readJson(BNB_LAST_FILE, null);
  async function sampleBnb() {
    try {
      const [sup, brk] = await Promise.all([fetchJson(BNB_TRACKER + 'getBnbSupply'), fetchJson(BNB_TRACKER + 'getBurnBreakdown')]);
      if (!sup || Number(sup.bcSupply) !== 0) throw new Error('tracker counts a Beacon Chain supply again');
      const supplyWei = bnbWei(sup.bscSupply);
      const supply = bnbNum(supplyWei);
      if (!(supply > 50e6 && supply < 200e6)) throw new Error('not a supply figure');
      const tip = parseInt((await bnbRpc([{ method: 'eth_blockNumber', params: [] }]))[0], 16);
      const block = tip - 3;
      const [B, deadHex, zeroHex, ratioHex, scaleHex, valsHex] = await bnbRpc([
        { method: 'eth_getBlockByNumber', params: [hex(block), false] },
        { method: 'eth_getBalance', params: [BNB_DEAD, hex(block)] },
        { method: 'eth_getBalance', params: [BNB_ZERO, hex(block)] },
        { method: 'eth_call', params: [{ to: BNB_VALIDATOR_SET, data: '0x5192c82c' }, hex(block)] }, // burnRatio()
        { method: 'eth_call', params: [{ to: BNB_VALIDATOR_SET, data: '0x820dcaa8' }, hex(block)] }, // BLOCK_FEES_RATIO_SCALE()
        { method: 'eth_call', params: [{ to: BNB_VALIDATOR_SET, data: '0xb7ab4db5' }, hex(block)] }, // getValidators()
      ]);
      const blockTime = parseInt(B.timestamp, 16);
      if (Date.now() / 1000 - blockTime > 600) throw new Error('node behind the chain');
      const deadWei = BigInt(deadHex), zeroWei = BigInt(zeroHex);
      // the tracker's own 0x...dEaD figure must be the node's: otherwise it has not caught up (a quarterly burn)
      const trackerDead = bnbWei(brk.deadAccountBalance);
      const lag = deadWei - trackerDead;
      if (lag > BNB_TOL_WEI || -lag > BNB_TOL_WEI) throw new Error('tracker behind the chain (0x...dEaD differs by ' + bnbNum(lag) + ' BNB)');
      const ratio = BigInt(ratioHex), scale = BigInt(scaleHex);
      if (!(scale > 0n) || ratio > scale) throw new Error('burn ratio unreadable');
      const validators = Number(BigInt('0x' + String(valsHex).slice(66, 130)));
      const burnedWei = deadWei + zeroWei;
      const totalWei = supplyWei + burnedWei;

      const state = readJson(BNB_STATE_FILE, {});
      const ts = new Date().toISOString();
      if (!state.anchor) state.anchor = { ts, block, totalWei: String(totalWei), supplyWei: String(supplyWei), burnedWei: String(burnedWei) };
      // a sample of the latest blocks: what each one paid its validator and burned
      const blocks = await bnbCheckBlocks(tip - 3 - BNB_SAMPLE_BLOCKS, tip - 4, ratio, scale);
      state.blocksChecked = (state.blocksChecked || 0) + blocks.checked;
      state.blocksOk = (state.blocksOk || 0) + blocks.ok;
      let burns = { quarterly: state.quarterly || [], nextBurn: state.nextBurn || null };
      try { burns = await bnbQuarterly(state); state.quarterly = burns.quarterly; state.nextBurn = burns.nextBurn; } catch (e) { /* kept from the last check */ }
      fs.mkdirSync(DATA, { recursive: true });
      fs.writeFileSync(BNB_STATE_FILE, JSON.stringify(state));

      const capWei = BigInt(state.anchor.totalWei) - burnedWei;
      const cap = bnbNum(capWei);
      const supplyWithinCap = supplyWei <= capWei + BNB_TOL_WEI;
      const blocksOk = blocks.ok === blocks.checked;
      const now = { ts, block, blockTime, supplyWei: String(supplyWei), burnedWei: String(burnedWei) };
      const d1 = bnbWindow(now, 86400, 3600 * 1000);
      const d30 = bnbWindow(now, 30 * 86400, 13 * 3600 * 1000);
      const base = d1 || bnbWindow(now, (Date.now() - Date.parse(state.anchor.ts)) / 1000, 30 * 60 * 1000);
      const span = base ? base.avgBlockSec * base.blocks : 0;
      const inflationRate = base && span > 3600 ? (base.net / supply) * (365.25 * 86400) / span : null;
      const deviation = supply - cap;
      bnbReading = {
        ts,
        height: block,
        supply,
        actualSupply: supply,
        expectedSupply: cap,
        deviation,
        deviationPct: cap > 0 ? (deviation / cap) * 100 : 0,
        withinRule: supplyWithinCap && blocksOk && (!d1 || d1.withinRule) && (!d30 || d30.withinRule),
        supplyWithinCap,
        maxSupply: null,
        anchorTs: state.anchor.ts,
        anchorBlock: state.anchor.block,
        anchorTotal: bnbNum(BigInt(state.anchor.totalWei)),
        inflationRate,
        bnb: {
          burnRatioPct: Number(ratio * 10000n / scale) / 100,
          validators,
          deadBalance: bnbNum(deadWei),
          zeroBalance: bnbNum(zeroWei),
          burnedTotal: bnbNum(burnedWei),
          realTimeBurnTotal: Number(brk.realTimeBurn) || null,
          autoBurnTotal: Number(brk.autoBurn) || null,
          blocks,
          blocksChecked: state.blocksChecked,
          blocksOk: state.blocksOk,
          quarterly: burns.quarterly,
          nextBurn: burns.nextBurn,
        },
        blockSubsidy: 0,
        difficulty: null,
        hashrate: null,
        mining: { d1, d30, adjustment: null, halving: null, pools: null, poolsBlocks: null },
        masternodesOnline: null,
        masternodesOffline: null,
      };
      if (!blocksOk) console.error('bnb audit: blocks out of the rule', JSON.stringify(blocks.bad));
      const history = readJson(BNB_FILE, []);
      history.push(Object.assign({ supply, cap }, now));
      writeHistory(BNB_FILE, history);
      keep(BNB_LAST_FILE, bnbReading);
      return true;
    } catch (e) {
      console.error('bnb audit sample failed', e && e.message);
      return false;
    }
  }
  app.get('/api/network/bnb-audit', (req, res) => {
    if (!bnbReading) return res.json({ ok: false, error: 'not sampled yet' });
    const history = readJson(BNB_FILE, []).map((p) => ({ ts: p.ts, height: p.block, supply: p.supply, actualSupply: p.supply, expectedSupply: p.cap }));
    res.json({ ok: true, reading: bnbReading, history });
  });

  const withRetry = (sample) => async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((r) => { const t = setTimeout(r, RETRY_MS); if (t.unref) t.unref(); });
      if (await sample()) return;
    }
  };
  // a one-off script (tools/seed-dash-audit.js) uses the readers without the schedule
  if (process.env.GALAXIA_AUDIT_NO_SCHEDULE) return { btcCap, ltcCap, dogeFixedSum, dashRuleSum, sampleBtc, sampleSol, sampleLtc, sampleDoge, sampleDash, sampleBch, sampleEth, sampleBnb };
  const runBtc = withRetry(sampleBtc);
  const runSol = withRetry(sampleSol);
  setTimeout(() => { backfillBtcDifficulty().then(runBtc); }, 20 * 1000).unref();
  const runLtc = withRetry(sampleLtc);
  setTimeout(runSol, 40 * 1000).unref();
  setTimeout(() => { backfillLtcDifficulty().then(runLtc); }, 60 * 1000).unref();
  setInterval(runBtc, EVERY_MS).unref();
  setInterval(runSol, EVERY_MS).unref();
  setInterval(runLtc, EVERY_MS).unref();
  const runDash = withRetry(sampleDash);
  setTimeout(() => { backfillDashDifficulty().then(runDash); }, 120 * 1000).unref();
  setInterval(runDash, EVERY_MS).unref();
  const runBch = withRetry(sampleBch);
  setTimeout(() => { backfillBchDifficulty().then(runBch); }, 100 * 1000).unref();
  setInterval(runBch, EVERY_MS).unref();
  const runDoge = withRetry(sampleDoge);
  setTimeout(() => { backfillDogeDifficulty().then(runDoge); }, 80 * 1000).unref();
  setInterval(runDoge, EVERY_MS).unref();
  const runEth = withRetry(sampleEth);
  setTimeout(runEth, 140 * 1000).unref();
  setInterval(runEth, EVERY_MS).unref();
  const runBnb = withRetry(sampleBnb);
  setTimeout(runBnb, 160 * 1000).unref();
  setInterval(runBnb, EVERY_MS).unref();
  return { btcCap, ltcCap, dogeFixedSum, dashRuleSum, sampleBtc, sampleSol, sampleLtc, sampleDoge };
};
