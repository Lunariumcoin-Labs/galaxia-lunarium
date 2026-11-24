// Supply of the coins that come from the partner exchanges (exchange-coins.js), read from each
// coin's own chain through a public explorer, so their market cap is price x a real supply.
// The sources are listed in coin-supply-sources.json; a coin without a verifiable source has no
// supply here and shows no market cap.
//
// One coin is read at a time, slowly (the explorers are small servers and chainz.cryptoid.info
// limits requests), every 12 hours -- supply changes by a few blocks' worth in that time. Readings
// are kept in data/coin-supply.json so a restart does not ask everything again. A reading that
// could not be renewed for 7 days is dropped. An explorer whose last block is older than 48 hours
// is not following the chain any more and is not used.
const fs = require('fs');
const path = require('path');
const https = require('https');

const FILE = path.join(__dirname, 'data', 'coin-supply.json');
const SOURCES = require('./coin-supply-sources.json').sources;
// coins looked at and left without a source, with the reason (a status code, see status())
const NOTES = require('./coin-supply-sources.json').notes || {};
const REFRESH_MS = 12 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_CHAIN_S = 48 * 60 * 60;
const GAP_MS = { chainz: 25 * 1000, iquidus: 3000, blockchair: 5000, number: 3000, coinexplorer: 2000, firo: 3000, vqr: 3000, blockbook: 3000, txoutset: 3000, bep20: 3000, erc20: 3000, evm_token: 3000, waves: 3000, waves_asset: 3000, xmr_explorer: 3000, karbo: 3000, ethereum: 3000, tronscan: 5000, taler: 3000, binance_bnb: 3000, solana: 3000, steem: 3000, json_field: 3000, btc_emission: 3000, local_audit: 1000 };
const PLAIN_NUMBER = /^"?(\d+(?:\.\d+)?)"?$/;

let state = {};
try { state = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { /* first run */ }
const tried = {};
const lastError = {}; // symbol -> { message, at } of a reading that failed (cleared by the next good one)

function save() {
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('coin supply: could not save', e && e.message); }
}

async function getText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json,text/plain,*/*' }, signal: controller.signal });
    if (!r.ok) throw new Error('status ' + r.status);
    return (await r.text()).trim();
  } finally { clearTimeout(timer); }
}

// For the two explorers whose HTTPS certificate cannot be verified (Omega: expired on 2026-07-31;
// Sorachan: the server does not send its intermediate certificate). Only a public supply figure
// is read this way, nothing is sent; a source asks for it with "unverified_tls": true.
function getTextUnverified(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { rejectUnauthorized: false, timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json,text/plain,*/*' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('status ' + res.statusCode)); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(new Error('answer too large')); });
      res.on('end', () => resolve(body.trim()));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// BEP-20 token: total supply of the contract minus what sits in the burn addresses, read from BNB
// Chain (the same rule as the site's own token pages, server.js tokenSupply)
const BSC_RPCS = ['https://bsc-dataseed.binance.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-rpc.publicnode.com'];
const BURN_ADDRESSES = ['000000000000000000000000000000000000dead', '0000000000000000000000000000000000000000'];
const ETH_RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://cloudflare-eth.com'];
const EVM_CHAINS = {
  bsc: { name: 'BNB Chain', rpcs: BSC_RPCS },
  ethereum: { name: 'Ethereum', rpcs: ETH_RPCS },
  polygon: { name: 'Polygon', rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com', 'https://rpc.ankr.com/polygon'] },
};
function bscCall(to, data) { return evmCall(BSC_RPCS, to, data); }
async function postJson(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }, body: JSON.stringify(body), signal: controller.signal });
    if (!r.ok) throw new Error('status ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}
async function evmCall(rpcs, to, data) {
  let lastErr;
  for (const rpc of rpcs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const r = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }), signal: controller.signal });
      const j = await r.json();
      if (j && typeof j.result === 'string' && /^0x[0-9a-f]+$/i.test(j.result)) return j.result;
      lastErr = new Error('no result');
    } catch (e) { lastErr = e; } finally { clearTimeout(timer); }
  }
  throw lastErr || new Error('chain unavailable');
}

function plainNumber(text) {
  const m = PLAIN_NUMBER.exec(text);
  const n = m ? Number(m[1]) : NaN;
  if (!(n > 0) || !Number.isFinite(n)) throw new Error('not a supply figure');
  return n;
}

// height and time of the explorer's last block, when its API tells; null when it does not
async function iquidusLastBlock(base, get) {
  try {
    const height = plainNumber(await get(base + '/api/getblockcount'));
    const hash = (await get(`${base}/api/getblockhash?index=${height}`)).replace(/"/g, '');
    if (!/^[0-9a-f]{64}$/i.test(hash)) return null;
    const block = JSON.parse(await get(`${base}/api/getblock?hash=${hash}`));
    return block && block.time > 0 ? { height, time: block.time } : null;
  } catch (e) { return null; }
}

// Firo: the explorers disagree on its supply (on 2026-10-05, at the same block: chainz 14.76M,
// firoblocks.app 19.10M) because its private pools are not visible to them. So its supply here is
// the emission of the official code (firoorg/firo: GetBlockSubsidyWithMTPFlag in validation.cpp and
// the mainnet chainparams) at the current block of the official explorer: 50 FIRO per block until
// 117,563, 25 until 302,437, 12.5 until 486,220, 6.25 until 1,798,654 (21,000,000 FIRO), then 1.
function firoEmission(height) {
  const segments = [[1, 117563, 50], [117564, 302437, 25], [302438, 486220, 12.5], [486221, 1798654, 6.25]];
  let total = 0;
  for (const [from, to, reward] of segments) {
    if (height < from) break;
    total += (Math.min(height, to) - from + 1) * reward;
  }
  if (height > 1798654) total += height - 1798654;
  return total;
}

const READERS = {
  async chainz(src) {
    return { supply: plainNumber(await getText(`https://chainz.cryptoid.info/${src.id}/api.dws?q=circulating`)), source: 'chainz.cryptoid.info' };
  },
  async iquidus(src) {
    const get = src.unverified_tls ? getTextUnverified : getText;
    const supply = plainNumber(await get(src.url + '/ext/getmoneysupply'));
    const last = await iquidusLastBlock(src.url, get);
    if (last && Date.now() / 1000 - last.time > STALE_CHAIN_S) throw new Error('explorer stopped at ' + new Date(last.time * 1000).toISOString());
    // a chain that forked: the explorer counts only once it is past the fork block (min_height)
    if (src.min_height && !(last && last.height >= src.min_height)) throw new Error('explorer below block ' + src.min_height);
    return { supply, source: new URL(src.url).host, height: last ? last.height : null };
  },
  async blockchair(src) {
    const d = JSON.parse(await getText(`https://api.blockchair.com/${src.id}/stats`));
    // an index that counts more blocks than the chain's height also counts their coins: not used
    // (Dogecoin on 2026-10-26: 6,573,827 blocks at height 6,431,787, orphaned blocks kept in its
    // table, and a supply of 172.2 billion where the official rule allows 156.7 billion)
    if (!d || !d.data || Number(d.data.blocks) - 1 !== Number(d.data.best_block_height)) throw new Error('source not in step with the chain');
    const units = Number(d.data.circulation);
    if (!(units > 0)) throw new Error('no circulation');
    return { supply: units / Math.pow(10, src.decimals), source: 'blockchair.com' };
  },
  // coinexplorer.net asks for at most one request per second
  async coinexplorer(src) {
    const base = 'https://www.coinexplorer.net/api/v1/' + src.id;
    const supply = plainNumber(await getText(base + '/circulationSupply'));
    await new Promise((r) => setTimeout(r, 1500));
    const latest = JSON.parse(await getText(base + '/block/latest'));
    const time = latest && latest.result ? Date.parse(String(latest.result.time).replace(' ', 'T') + 'Z') : NaN;
    if (!(time > 0)) throw new Error('no block time');
    if (Date.now() - time > STALE_CHAIN_S * 1000) throw new Error('explorer stopped at ' + new Date(time).toISOString());
    return { supply, source: 'coinexplorer.net' };
  },
  // the VQR explorer's own API (masternode.vqr.quest/apiinfo.php): info has the node's money
  // supply and the height; the block of that height has the time
  async vqr(src) {
    const info = JSON.parse(await getText(src.url + '/api.php?action=info'));
    const supply = Number(info && info.moneysupply);
    const height = Number(info && info.blocks);
    if (!(supply > 0) || !(height > 0) || info.initialblockdownload) throw new Error('not a supply figure');
    const blocks = JSON.parse(await getText(src.url + '/api.php?action=block&index=' + height));
    const block = blocks && blocks[height];
    if (!block || !(block.time > 0)) throw new Error('no block time');
    if (Date.now() / 1000 - block.time > STALE_CHAIN_S) throw new Error('explorer stopped at ' + new Date(block.time * 1000).toISOString());
    return { supply, source: new URL(src.url).host };
  },
  // Blockbook of a PIVX-family coin: the status page carries the node's money supply
  async blockbook(src) {
    const d = JSON.parse(await getText(src.url + '/api/v2'));
    const supply = Number(d && d.backend && d.backend.moneysupply);
    const time = Date.parse(d && d.blockbook ? d.blockbook.lastBlockTime : '');
    if (!(supply > 0) || !d.blockbook.inSync) throw new Error('not a supply figure');
    if (!(time > 0) || Date.now() - time > STALE_CHAIN_S * 1000) throw new Error('explorer stopped at ' + (time > 0 ? new Date(time).toISOString() : 'unknown time'));
    return { supply, source: new URL(src.url).host };
  },
  // an explorer API that publishes the node's gettxoutsetinfo (CS Coin): every unspent output on
  // the chain, plus the shielded pools the node monitors
  async txoutset(src) {
    const d = JSON.parse(await getText(src.url + '/network'));
    const set = d && d.txoutsetinfo;
    const pools = (d && d.chaininfo && d.chaininfo.valuePools) || [];
    const shielded = pools.reduce((t, p) => t + (p && p.monitored && p.chainValue > 0 ? p.chainValue : 0), 0);
    const supply = Number(set && set.total_amount) + shielded;
    // the explorer keeps this reading for a few blocks; one far behind the chain tip is not used
    const behind = d.chaininfo.blocks - set.height;
    if (!(supply > 0) || !(set.height > 0) || !(behind >= 0 && behind <= 60)) throw new Error('not a supply figure');
    const blocks = JSON.parse(await getText(src.url + '/blocks/latest?limit=1'));
    const block = Array.isArray(blocks) ? blocks[0] : null;
    if (!block || !(block.time > 0)) throw new Error('no block time');
    if (Date.now() / 1000 - block.time > STALE_CHAIN_S) throw new Error('explorer stopped at ' + new Date(block.time * 1000).toISOString());
    return { supply, source: new URL(src.url).host };
  },
  async bep20(src) {
    const contract = String(src.contract).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(contract)) throw new Error('invalid contract');
    const [totalHex, decHex, ...burnHex] = await Promise.all([
      bscCall(contract, '0x18160ddd'),
      bscCall(contract, '0x313ce567'),
      ...BURN_ADDRESSES.map((a) => bscCall(contract, '0x70a08231' + a.padStart(64, '0'))),
    ]);
    const decimals = Number(BigInt(decHex));
    const units = BigInt(totalHex) - burnHex.reduce((s, h) => s + BigInt(h), 0n);
    const supply = decimals > 4 ? Number(units / 10n ** BigInt(decimals - 4)) / 1e4 : Number(units) / 10 ** decimals;
    if (!(supply > 0)) throw new Error('not a supply figure');
    return { supply, source: 'BNB Chain' };
  },
  // ERC-20 on Ethereum: total supply of the contract (POL, Polygon's native token, is issued there)
  async erc20(src) {
    const contract = String(src.contract).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(contract)) throw new Error('invalid contract');
    const [totalHex, decHex] = await Promise.all([evmCall(ETH_RPCS, contract, '0x18160ddd'), evmCall(ETH_RPCS, contract, '0x313ce567')]);
    const decimals = Number(BigInt(decHex));
    const supply = Number(BigInt(totalHex) / 10n ** BigInt(Math.max(decimals - 4, 0))) / 1e4;
    if (!(supply > 0)) throw new Error('not a supply figure');
    return { supply, source: 'Ethereum' };
  },
  // A token on BNB Chain, Ethereum or Polygon (src.chain): total supply of the contract minus what
  // sits in the burn addresses -- the same rule as bep20 above, for any of the three chains.
  async evm_token(src) {
    const chain = EVM_CHAINS[src.chain];
    const contract = String(src.contract).toLowerCase();
    if (!chain || !/^0x[0-9a-f]{40}$/.test(contract)) throw new Error('invalid chain or contract');
    const [totalHex, decHex, ...burnHex] = await Promise.all([
      evmCall(chain.rpcs, contract, '0x18160ddd'),
      evmCall(chain.rpcs, contract, '0x313ce567'),
      // some contracts refuse a balance query for the zero address: nothing burned there then
      ...BURN_ADDRESSES.map((a) => evmCall(chain.rpcs, contract, '0x70a08231' + a.padStart(64, '0')).catch(() => '0x0')),
    ]);
    const decimals = Number(BigInt(decHex));
    const units = BigInt(totalHex) - burnHex.reduce((s, h) => s + BigInt(h), 0n);
    const supply = decimals > 4 ? Number(units / 10n ** BigInt(decimals - 4)) / 1e4 : Number(units) / 10 ** decimals;
    if (!(supply > 0)) throw new Error('not a supply figure');
    return { supply, source: chain.name };
  },
  // An asset issued on Waves: the quantity the node reports for it
  async waves_asset(src) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(src.id))) throw new Error('invalid asset id');
    const d = JSON.parse(await getText('https://nodes.wavesnodes.com/assets/details/' + src.id));
    const supply = Number(d && d.quantity) / 10 ** Number(d && d.decimals);
    if (!(supply > 0)) throw new Error('not a supply figure');
    const head = JSON.parse(await getText('https://nodes.wavesnodes.com/blocks/headers/last'));
    if (!(head && head.timestamp > 0) || Date.now() - head.timestamp > STALE_CHAIN_S * 1000) throw new Error('node stopped');
    return { supply, source: 'nodes.wavesnodes.com' };
  },
  // A Monero-family coin whose explorer runs the emission monitor (/api/emission): the coins
  // created up to the block it names, in atomic units (src.decimals from the coin's code: COIN in
  // cryptonote_config.h). The monitor must be at the chain tip and that block recent.
  async xmr_explorer(src) {
    const e = JSON.parse(await getText(src.url + '/api/emission'));
    const units = e && e.status === 'success' && e.data ? Number(e.data.coinbase) : NaN;
    const height = e && e.data ? Number(e.data.blk_no) : NaN;
    if (!(units > 0) || !(height > 1) || !(src.decimals >= 0)) throw new Error('not a supply figure');
    const b = JSON.parse(await getText(`${src.url}/api/block/${height - 1}`));
    const time = Number(b && b.data && b.data.timestamp);
    const tip = Number(b && b.data && b.data.current_height);
    if (!(time > 0) || !(tip > 0) || tip - height > 30) throw new Error('emission monitor behind the chain');
    if (Date.now() / 1000 - time > STALE_CHAIN_S) throw new Error('explorer stopped at ' + new Date(time * 1000).toISOString());
    return { supply: units / 10 ** src.decimals, source: new URL(src.url).host, height };
  },
  // Karbo: its official node (the one its explorer uses, explorer.karbo.org/config.js) reports the
  // coins generated so far, already in KRB; the header of the last block gives the time
  async karbo(src) {
    const info = JSON.parse(await getText(src.url + '/getinfo'));
    const supply = Number(info && info.already_generated_coins);
    if (!info || info.status !== 'OK' || !(supply > 0)) throw new Error('not a supply figure');
    const head = await postJson(src.url + '/json_rpc', { jsonrpc: '2.0', id: '1', method: 'getlastblockheader', params: {} });
    const time = Number(head && head.result && head.result.block_header && head.result.block_header.timestamp);
    if (!(time > 0)) throw new Error('no block time');
    if (Date.now() / 1000 - time > STALE_CHAIN_S) throw new Error('node stopped at ' + new Date(time * 1000).toISOString());
    return { supply, source: new URL(src.url).host, height: Number(info.height) || null };
  },
  // Waves: the node reports every WAVES in existence; the last block header gives the time
  async waves() {
    const d = JSON.parse(await getText('https://nodes.wavesnodes.com/blockchain/rewards'));
    const supply = Number(d && d.totalWavesAmount) / 1e8;
    if (!(supply > 0)) throw new Error('not a supply figure');
    const head = JSON.parse(await getText('https://nodes.wavesnodes.com/blocks/headers/last'));
    if (!(head && head.timestamp > 0) || Date.now() - head.timestamp > STALE_CHAIN_S * 1000) throw new Error('node stopped');
    return { supply, source: 'nodes.wavesnodes.com' };
  },
  // Ether: balances of the execution layer plus the validators' balances, less the deposits that
  // are counted on both sides (the figures ultrasound.money publishes from the chain)
  async ethereum() {
    const d = JSON.parse(await getText('https://ultrasound.money/api/v2/fees/supply-parts'));
    const wei = BigInt(d.executionBalancesSum) + (BigInt(d.beaconBalancesSum) - BigInt(d.beaconDepositsSum)) * 1000000000n;
    const supply = Number(wei / 100000000000000n) / 1e4;
    if (!(supply > 100e6 && supply < 200e6)) throw new Error('not a supply figure');
    return { supply, source: 'ultrasound.money' };
  },
  // TRON: circulating supply published by Tronscan (issued at genesis plus rewards, less what was burned)
  async tronscan() {
    const d = JSON.parse(await getText('https://apilist.tronscanapi.com/api/funds'));
    const supply = Number(d && d.circulationSupply);
    if (!(supply > 0)) throw new Error(d && d.Error ? 'rate limited' : 'not a supply figure');
    return { supply, source: 'tronscan.org' };
  },
  // Taler: its explorer shows the supply rounded ("19.66M") in the header of the page; the block
  // of the height shown there gives the time
  async taler(src) {
    const html = await getText(src.url + '/_partial/header-stats');
    const m = /data-t="Supply">Supply<\/div>\s*<div class="stat-value">([\d.]+)([KMB])<\/div>/.exec(html);
    const h = /data-t="Height">Height<\/div>\s*<div class="stat-value">([\d,]+)<\/div>/.exec(html);
    if (!m || !h) throw new Error('page layout changed');
    const supply = Number(m[1]) * { K: 1e3, M: 1e6, B: 1e9 }[m[2]];
    const height = Number(h[1].replace(/,/g, ''));
    const block = await getText(src.url + '/blocks/' + height);
    const t = /datetime="([^"]+)"/.exec(block);
    const time = t ? Date.parse(t[1]) : NaN;
    if (!(supply > 0) || !(time > 0)) throw new Error('not a supply figure');
    if (Date.now() - time > STALE_CHAIN_S * 1000) throw new Error('explorer stopped at ' + new Date(time).toISOString());
    return { supply, source: new URL(src.url).host, height };
  },
  // BNB: circulating supply shown on Binance's own BNB page (binance.com/price/bnb), read from the
  // feed that page uses. Binance issues BNB and burns it every quarter, so this is the issuer's
  // figure. (The "cs" field of Binance's product list is NOT used: it is years out of date. The
  // spot REST and WebSocket APIs carry no supply at all.)
  async binance_bnb() {
    const from = Math.floor(Date.now() / 1000) - 3600;
    const d = JSON.parse(await getText('https://www.binance.com/bapi/composite/v1/public/promo/cmc/cryptocurrency/quotes/historical?id=1839&time_start=' + from + '&interval=5m&count=6'));
    const body = d && d.data && d.data.body && d.data.body.data;
    const quotes = (body && body.symbol === 'BNB' && Array.isArray(body.quotes)) ? body.quotes : [];
    const last = quotes.length ? quotes[quotes.length - 1].quote.USD : null;
    const supply = Number(last && last.circulating_supply);
    const time = Date.parse(last ? last.timestamp : '');
    if (!(supply > 50e6 && supply < 200e6)) throw new Error('not a supply figure');
    if (!(time > 0) || Date.now() - time > STALE_CHAIN_S * 1000) throw new Error('feed stopped');
    return { supply, source: 'binance.com' };
  },
  // Solana: circulating supply reported by the network's own RPC (getSupply, non-circulating accounts left out)
  async solana() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    let d;
    try {
      const r = await fetch('https://api.mainnet-beta.solana.com', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSupply', params: [{ excludeNonCirculatingAccountsList: true }] }), signal: controller.signal });
      if (!r.ok) throw new Error('status ' + r.status);
      d = await r.json();
    } finally { clearTimeout(timer); }
    const supply = Number(d && d.result && d.result.value && d.result.value.circulating) / 1e9;
    if (!(supply > 100e6 && supply < 2e9)) throw new Error('not a supply figure');
    return { supply, source: 'api.mainnet-beta.solana.com' };
  },
  async firo() {
    const d = JSON.parse(await getText('https://explorer.firo.org/insight-api-zcoin/blocks?limit=1'));
    const block = d && d.blocks && d.blocks[0];
    if (!block || !(block.height > 0) || !(block.time > 0)) throw new Error('no block');
    if (Date.now() / 1000 - block.time > STALE_CHAIN_S) throw new Error('explorer stopped at ' + new Date(block.time * 1000).toISOString());
    return { supply: firoEmission(block.height), source: 'github.com/firoorg/firo' };
  },
  // A Steem-family chain (Blurt, Serey): its own RPC node reports current_supply, every coin in
  // existence (liquid and staked); the head block time shows the node is following the chain
  async steem(src) {
    const d = await postJson(src.url, { jsonrpc: '2.0', id: 1, method: 'call', params: ['database_api', 'get_dynamic_global_properties', []] });
    const p = d && d.result;
    const supply = parseFloat(String(p && p.current_supply));
    const time = Date.parse(String(p && p.time) + 'Z');
    if (!(supply > 0)) throw new Error('not a supply figure');
    if (!(time > 0) || Date.now() - time > STALE_CHAIN_S * 1000) throw new Error('node stopped at ' + (time > 0 ? new Date(time).toISOString() : 'unknown time'));
    return { supply, source: new URL(src.url).host, height: Number(p.head_block_number) || null };
  },
  // An explorer that publishes the supply as one field of a JSON answer (996-Coin: the sum of every
  // balance on its chain, the "Total supply" of its Supply & Richlist page)
  async json_field(src) {
    const d = JSON.parse(await getText(src.url));
    const supply = Number(d && d[src.field]);
    if (!(supply > 0) || !Number.isFinite(supply)) throw new Error('not a supply figure');
    return { supply, source: new URL(src.url).host };
  },
  // A Bitcoin-family coin that kept Bitcoin's emission (Bitcoin Gold: GetBlockSubsidy in
  // BTCGPU/src/validation.cpp, 50 coins halved every 210,000 blocks): emission of that code at the
  // current height of a Blockbook explorer that is in sync (the genesis coinbase cannot be spent)
  async btc_emission(src) {
    const d = JSON.parse(await getText(src.url + '/api/v2'));
    const height = Number(d && d.backend && d.backend.blocks);
    const time = Date.parse(d && d.blockbook ? d.blockbook.lastBlockTime : '');
    if (!(height > 0) || !d.blockbook.inSync) throw new Error('explorer not in sync');
    if (!(time > 0) || Date.now() - time > STALE_CHAIN_S * 1000) throw new Error('explorer stopped at ' + (time > 0 ? new Date(time).toISOString() : 'unknown time'));
    let supply = 0;
    for (let h = 0, reward = 50; h <= height && reward > 0; h += 210000, reward /= 2) supply += (Math.min(height, h + 209999) - Math.max(h, 1) + 1) * reward;
    return { supply, source: src.code || new URL(src.url).host, height };
  },
  // the supply an audit of this site keeps (major-audits.js), when the explorer's own summary cannot be
  // used (Bitcoin Cash: blockchair's summary counts orphaned blocks; the audit sums the blocks one by one)
  async local_audit(src) {
    const r = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', path.basename(src.file)), 'utf8'));
    const supply = Number(r && r.supply);
    if (!(supply > 0) || !(Date.now() - Date.parse(r.ts) < 24 * 3600 * 1000)) throw new Error('audit reading missing or old');
    return { supply, source: src.name || 'GaláxiaLunarium', height: Number(r.height) || null };
  },
  async number(src) {
    return { supply: plainNumber(await getText(src.url)), source: src.name || new URL(src.url).host };
  },
};

let running = false;
async function refresh() {
  if (running) return;
  running = true;
  try {
    const due = Object.keys(SOURCES).filter((sym) => {
      const last = Math.max(state[sym] ? state[sym].at : 0, tried[sym] || 0);
      return Date.now() - last >= (state[sym] && Date.now() - state[sym].at < REFRESH_MS ? REFRESH_MS : RETRY_MS);
    });
    // the slow source (chainz) last, so the others are not kept waiting behind it
    due.sort((a, b) => (GAP_MS[SOURCES[a].type] || 0) - (GAP_MS[SOURCES[b].type] || 0));
    for (const sym of due) {
      const src = SOURCES[sym];
      tried[sym] = Date.now();
      try {
        const r = await READERS[src.type](src);
        state[sym] = { supply: r.supply, source: r.source, at: Date.now() };
        // chain height at that reading, where the explorer tells (used by masternode-collateral.js)
        if (r.height > 0) state[sym].height = r.height;
        delete lastError[sym];
        save();
      } catch (e) {
        lastError[sym] = { message: String((e && e.message) || e), at: Date.now() };
        console.error(`coin supply: ${sym} not read (${String((e && e.message) || e).slice(0, 80)})`);
      }
      await new Promise((r) => setTimeout(r, GAP_MS[src.type] || 3000));
    }
  } finally { running = false; }
}

// { supply, source, updated_at } of a coin, or null when there is no current reading
function get(symbol) {
  const s = state[String(symbol || '').toUpperCase()];
  if (!s || !SOURCES[String(symbol).toUpperCase()] || !(s.supply > 0) || Date.now() - s.at > MAX_AGE_MS) return null;
  return { supply: s.supply, source: s.source, updated_at: new Date(s.at).toISOString(), height: s.height || null };
}

// Why a coin has, or has not, a verified supply -- shown live next to its explorer link.
// `explorer` is the verdict of explorer-health.js for the coin's explorer ({ state: 'up'|'down'|null, at }),
// or 'none' when the coin has no explorer link. Codes: ok, stale (the source stopped following the
// chain), read_failed, explorer_down, no_supply (the explorer answers but publishes no supply the
// site can verify), supply_invalid, not_circulating, no_explorer. null = nothing known yet.
function status(symbol, explorer) {
  const sym = String(symbol || '').toUpperCase();
  const ok = get(sym);
  if (ok) return { code: 'ok', source: ok.source, checked_at: ok.updated_at };
  if (SOURCES[sym]) {
    const e = lastError[sym];
    if (!e) return null; // not read yet since the server started
    return { code: /stopped at|below block|behind the chain|node stopped|feed stopped/.test(e.message) ? 'stale' : 'read_failed', checked_at: new Date(e.at).toISOString() };
  }
  if (explorer === 'none') return { code: NOTES[sym] || 'no_explorer' };
  if (explorer && explorer.state === 'down') return { code: 'explorer_down', checked_at: explorer.at };
  if (NOTES[sym]) return { code: NOTES[sym] };
  if (explorer && explorer.state === 'up') return { code: 'no_supply', checked_at: explorer.at };
  return null;
}

// Current chain height of a coin whose explorer tells it (Iquidus getblockcount), asked at most
// once an hour; the height stored with the last supply reading is the fallback.
const heightCache = {};
async function height(symbol) {
  const sym = String(symbol || '').toUpperCase();
  const src = SOURCES[sym];
  const stored = (state[sym] && state[sym].height) || null;
  if (!src || src.type !== 'iquidus') return stored;
  const hit = heightCache[sym];
  if (hit && Date.now() - hit.at < (hit.ok ? 60 : 10) * 60 * 1000) return hit.height;
  try {
    const get = src.unverified_tls ? getTextUnverified : getText;
    const h = plainNumber(await get(src.url + '/api/getblockcount'));
    heightCache[sym] = { at: Date.now(), height: h, ok: true };
    return h;
  } catch (e) {
    heightCache[sym] = { at: Date.now(), height: hit ? hit.height : stored, ok: false };
    return heightCache[sym].height;
  }
}

module.exports = function mountCoinSupply() {
  setTimeout(() => { refresh().catch((e) => console.error('coin supply refresh failed', e && e.message)); }, 45 * 1000).unref();
  setInterval(() => { refresh().catch((e) => console.error('coin supply refresh failed', e && e.message)); }, 30 * 60 * 1000).unref();
  return { get, refresh };
};
module.exports.get = get;
module.exports.status = status;
module.exports.height = height;
module.exports.refresh = refresh;
