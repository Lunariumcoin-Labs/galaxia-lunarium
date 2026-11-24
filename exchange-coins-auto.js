// New coins on Qutrade / Gatevia / Cexius / LunariumTrade: detected from the exchange markets, identified from each
// exchange's own coin-information pages, classified from the coin's official source code, listed
// automatically and reported to the admin by e-mail (with a signed link to fix or exclude it).
// Decisions live in data/exchange-coins-auto.json, read on top of exchange-coins-meta.json, so a
// deploy never loses them. A coin that cannot be classified with evidence is not listed: the
// e-mail asks the admin to choose its tabs.
const fs = require('fs');
const path = require('path');
const express = require('express');
const plans = require('./api-plans');
const mailer = require('./mailer');
const secret = require('./server-secret');
const tpl = require('./email-template');

const AUTO_FILE = path.join(plans.DATA_DIR, 'exchange-coins-auto.json');
const META_FILE = path.join(__dirname, 'exchange-coins-meta.json');
const CHECK_MS = 24 * 3600 * 1000; // once a day
const STABLE = new Set(['USDT', 'USDC', 'USDB', 'DAI', 'BUSD']);
const HAS_PAGE = new Set(['XLN', 'XLNFT', 'PIVX', 'GVIA', 'S11', 'MON', 'NS', 'VIVO', 'BTC', 'SOL', 'LTC', 'DOGE', 'BCH', 'DASH', 'ETH', 'BNB']);
const TABS = ['masternode', 'stake', 'mining', 'token'];
const TAB_PT = { masternode: 'Masternode', stake: 'Stake', mining: 'Mineração', token: 'Token' };
const UA = { 'User-Agent': 'Mozilla/5.0 (GalaxiaLunarium listing check)' };
const esc = tpl.esc;

const readAuto = () => plans.readJson(AUTO_FILE, { coins: {}, excluded: {}, pending: {} });
const writeAuto = (a) => plans.writeJsonAtomic(AUTO_FILE, a);
const readMeta = () => plans.readJson(META_FILE, { coins: {}, excluded: {} });
// tickers with their own site page (public-api-coins.json): LunariumTrade's BEP-20 tokens already listed there
function siteTickers() {
  try { return new Set(JSON.parse(fs.readFileSync(path.join(__dirname, 'public-api-coins.json'), 'utf8')).map((c) => String(c.symbol || '').toUpperCase())); } catch (e) { return new Set(); }
}

async function getText(url, headers) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { headers: Object.assign({}, UA, headers || {}), signal: ctl.signal, redirect: 'follow' });
    return r.ok ? await r.text() : null;
  } catch (e) { return null; } finally { clearTimeout(t); }
}

// ---- what each exchange publishes about its coins
async function qutradeInfo() {
  const html = await getText('https://qutrade.io/new_design_5/coins/list.php?lang=en', { Referer: 'https://qutrade.io/en/?coins' });
  const out = {};
  if (!html) return out;
  html.split('<tr class="tr">').slice(1).forEach((r) => {
    const sym = (r.match(/<links>([^<]+)<\/links>/) || [])[1];
    if (!sym) return;
    const chains = [...r.matchAll(/<lp>\s*([A-Z0-9]+ \( [^)]* \))\s*<\/lp>/g)].map((m) => m[1]);
    out[sym.trim().toUpperCase()] = {
      name: ((r.match(/<db>([^<]+)<\/db>/) || [])[1] || '').trim(),
      site: (r.match(/<a href="(https?:[^"]+)" target="_blank">\s*<db><lp>/) || [])[1] || null,
      explorer: (r.match(/<a target='_blank' href='([^']+)'>/) || [])[1] || null,
      chains,
      native: chains.some((c) => /\( native \)/.test(c)),
      // current block height of the exchange's node ("213 148")
      height: Number(((r.match(/<\/lp><\/a>\s*<db>([0-9 ]+)<\/db>/) || [])[1] || '').replace(/\s/g, '')) || null,
    };
  });
  return out;
}
async function gateviaInfo() {
  const out = {};
  const names = {};
  try { JSON.parse(await getText('https://api.gatevia.io/public/currencies') || '[]').forEach((c) => { names[String(c.code).toUpperCase()] = c.name; }); } catch (e) { /* names are optional */ }
  for (const [list, ep] of [['PoW', 'coin_info_ajax'], ['PoS', 'coin_info_pos_ajax'], ['PoS + PoW', 'coin_info_pos_pow_ajax']]) {
    for (let page = 1; page <= 10; page++) {
      const html = await getText(`https://gatevia.io/userdash/${ep}?page=${page}&search=`, { 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://gatevia.io/dashboard/coin_info' });
      const rows = html ? html.split('<tr>').slice(2) : [];
      let n = 0;
      rows.forEach((r) => {
        const sym = (r.match(/<span class="fw-bold">([^<]+)<\/span>/) || [])[1];
        if (!sym) return;
        n++;
        const s = sym.trim().toUpperCase();
        const tds = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, ' ').trim());
        if (!out[s]) out[s] = { list, height: Number(tds[2]) || null, explorer: (r.match(/<a href="([^"]+)"[^>]*title="Explorer"/) || [])[1] || null, desc: (r.match(/href="(\/dashboard\/coin_info_desc\/\?id=\d+)"/) || [])[1] || null };
      });
      if (!n) break;
    }
  }
  Object.keys(names).forEach((s) => { out[s] = Object.assign(out[s] || {}, { name: names[s] }); });
  return out;
}

// Cexius publishes each asset's official links in its API (cexius.com/api-docs: GET /assets).
async function cexiusInfo() {
  const out = {};
  try {
    const d = JSON.parse((await getText('https://cexius.com/api/v2/assets')) || '{}');
    (Array.isArray(d) ? d : (d.result || [])).forEach((a) => {
      const s = String((a && a.id) || '').toUpperCase();
      if (!s) return;
      const link = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : null);
      out[s] = { name: a.name || (a.currency && a.currency.name) || s, site: link(a.website_url), explorer: link(a.explorer_url), github: link(a.github_url) };
    });
  } catch (e) { /* the catalogue is optional: the coin then waits for the admin */ }
  return out;
}
// A token on Cexius: every network it is deposited on is a token standard of another chain
// (GET /currencies/{id}/networks: ERC20, BEP20, TRC20...); a native coin has its own network.
async function cexiusTokenNetworks(sym) {
  try {
    const d = JSON.parse((await getText(`https://cexius.com/api/v2/currencies/${encodeURIComponent(sym)}/networks`)) || '{}');
    const nets = (d.networks || []).map((n) => String(n.network_id || n.title || '').toUpperCase()).filter(Boolean);
    return nets.length && nets.every((n) => /^(ERC|BEP|TRC|SPL|ARC|KRC|PRC)-?\d+$/.test(n)) ? nets : null;
  } catch (e) { return null; }
}

// ---- official source code (read through raw.githubusercontent.com / github.com: no API quota)
const raw = (repo, file) => getText(`https://raw.githubusercontent.com/${repo}/HEAD/${file}`);
async function exists(repo, file) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  try { return (await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/${file}`, { method: 'HEAD', headers: UA, signal: ctl.signal })).ok; } catch (e) { return false; } finally { clearTimeout(t); }
}
const MN_RE = /masternode|smartnode|servicenode|systemnode|zelnode|fluxnode|\bznode|deterministicmn|\bevo\/|\bllmq\/|active[a-z]{2,12}node\.(h|cpp)/gi;
// stake files as they appear in a build list; "kernel/..." (libbitcoinkernel) and "disktxpos" are not stake
const POS_RE = /(?:^|\s)kernel\.(?:cpp|h)\b|pos\/kernel\.(?:cpp|h)|stakeinput|stakemodifier|(?:^|\s)pos\.(?:cpp|h)\b|(?:^|\s)staking\/|wallet\/stake/gm;
const MN_FILES = ['src/activemasternode.cpp', 'src/masternode.cpp', 'src/masternode/activemasternode.cpp', 'src/masternode/masternode.cpp', 'src/active/masternode.cpp', 'src/evo/deterministicmns.cpp', 'src/smartnode/activesmartnode.cpp', 'src/fluxnode/activefluxnode.cpp', 'src/zelnode/activezelnode.cpp'];
const POS_FILES = ['src/kernel.cpp', 'src/pos/kernel.cpp', 'src/stakeinput.cpp', 'src/pos.cpp'];
async function analyzeRepo(repo) {
  const [mk, mku, cp, main, val] = await Promise.all([raw(repo, 'src/Makefile.am'), raw(repo, 'src/makefile.unix'), raw(repo, 'src/chainparams.cpp'), raw(repo, 'src/main.cpp'), raw(repo, 'src/validation.cpp')]);
  const build = (mk || '') + '\n' + (mku || '');
  if (!cp && !(main && build.trim())) return null; // not a node repository
  const code = (main || '') + (val || '');
  const [mnProbe, posProbe] = await Promise.all([Promise.all(MN_FILES.map((f) => exists(repo, f))), Promise.all(POS_FILES.map((f) => exists(repo, f)))]);
  const mn = [...new Set([...(build.match(MN_RE) || []).map((x) => x.toLowerCase()), ...MN_FILES.filter((f, i) => mnProbe[i])])];
  const pos = [...new Set([...(build.match(POS_RE) || []).map((x) => x.trim()), ...POS_FILES.filter((f, i) => posProbe[i])])];
  const posInCode = /CheckProofOfStake|IsProofOfStake\(\)/.test(code);
  const lp = ((cp || '') + code).match(/(nLastPOWBlock|nLastPoWBlock|nLastPowBlock|LAST_POW_BLOCK|height_last_PoW|nLastPOWHeight)\s*=?\s*([0-9]+)/);
  return { repo, url: `https://github.com/${repo}`, masternode: mn.length > 0, masternode_terms: mn.slice(0, 4), stake: pos.length > 0 || posInCode, stake_terms: pos.slice(0, 4), last_pow_block: lp ? Number(lp[2]) : null };
}
const NOT_NODE = /miner|pool|explorer|electrum|website|\bweb\b|seeder|docs?$|android|ios|mobile|faucet|bootstrap|installer|\.github|paper|sentinel|insight|api|swap|dex|bridge|nft|market/i;
const words = (s) => String(s || '').toLowerCase().replace(/coin|core|[^a-z0-9]/g, '');
// candidate node repositories, best first: [{ repo, direct, named }]
async function findRepos(links, site, name, sym) {
  const found = new Set();
  const add = (text) => (String(text || '').match(/github\.com\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?/g) || []).forEach((l) => found.add(l.replace(/\.git$/, '')));
  (links || []).forEach(add);
  let host = '';
  try { host = new URL(site).hostname; } catch (e) { /* no site */ }
  if (site && !/(^|\.)(qutrade\.io|gatevia\.io|cexius\.com)$/i.test(host)) add(await getText(site));
  const cands = [];
  for (const l of [...found].slice(0, 6)) {
    const m = l.match(/github\.com\/([^/]+)(?:\/([^/]+))?/);
    if (!m || /^(orgs|sponsors|topics|features)$/i.test(m[1])) continue;
    if (m[2] && !/^(releases|wiki|issues)$/.test(m[2])) cands.push({ repo: `${m[1]}/${m[2]}`, direct: true });
    else {
      // organisation link: its public repositories (page HTML, no API)
      const html = (await getText(`https://github.com/orgs/${m[1]}/repositories`)) || (await getText(`https://github.com/${m[1]}?tab=repositories`)) || '';
      const re = new RegExp(`href="/(${m[1]}/[A-Za-z0-9_.-]+)"`, 'gi');
      [...new Set([...html.matchAll(re)].map((x) => x[1]))].slice(0, 30).forEach((r) => cands.push({ repo: r, direct: false }));
    }
  }
  const n = words(name);
  const y = words(sym);
  const seen = new Set();
  return cands.filter((c) => !seen.has(c.repo.toLowerCase()) && seen.add(c.repo.toLowerCase())).map((c) => {
    const r = words(c.repo.split('/')[1]);
    const named = !!(n && r.includes(n)) || r === y;
    const score = (NOT_NODE.test(c.repo.split('/')[1]) ? -5 : 0) + (named ? 3 : 0) + (c.direct ? 1 : 0);
    return Object.assign(c, { named, score });
  }).filter((c) => c.score > -3).sort((p, q) => q.score - p.score).slice(0, 6);
}

// consensus of well-known networks that are not Bitcoin-style repositories
const KNOWN = {
  BTC: ['mining'], LTC: ['mining'], DOGE: ['mining'], BCH: ['mining'], XMR: ['mining'], ZEC: ['mining'], ETC: ['mining'], KAS: ['mining'], RVN: ['mining'], DGB: ['mining'],
  ETH: ['stake'], BNB: ['stake'], SOL: ['stake'], ADA: ['stake'], TRX: ['stake'], DOT: ['stake'], AVAX: ['stake'], ATOM: ['stake'], MATIC: ['stake'], POL: ['stake'], TON: ['stake'], WAVES: ['stake'], XTZ: ['stake'], NEAR: ['stake'], ALGO: ['stake'],
  DASH: ['masternode', 'mining'],
};

// ---- classify one new coin. `confident` decides whether it goes to the tabs without the admin.
async function classify(sym, where, info) {
  const q = info.qutrade[sym];
  const g = info.gatevia[sym];
  const x = (info.cexius || {})[sym];
  const rec = { symbol: sym, exchanges: where, name: (q && q.name) || (g && g.name) || (x && x.name) || sym, website: (q && q.site) || (x && x.site) || null, explorer: (q && q.explorer) || (g && g.explorer) || (x && x.explorer) || null, categories: [], evidence: {}, confident: false };
  if (q && q.chains.length && !q.native) {
    rec.categories = ['token'];
    rec.evidence = { rule: `Qutrade: token em ${q.chains.join(', ')}` };
    rec.confident = true;
    return rec;
  }
  // only on LunariumTrade: it trades BNB Chain (Web3) tokens and publishes no coin networks without a login.
  // A well-known network there is its BEP-20 (Binance-Peg) version; any other coin waits for the admin,
  // with Token as the suggestion (it still gets its page and the new-listing notice meanwhile).
  if (!q && !g && !x && where.length === 1 && where[0] === 'LunariumTrade') {
    rec.categories = ['token'];
    rec.confident = !!KNOWN[sym];
    rec.evidence = { rule: KNOWN[sym]
      ? 'LunariumTrade: versão BEP-20 (BNB Chain) de uma rede conhecida -- a corretora negocia tokens Web3 da BSC'
      : 'LunariumTrade não publica a rede da moeda: confirme se é token BEP-20 (aba Token) ou moeda nativa' };
    return rec;
  }
  if (KNOWN[sym] && (!q || q.native)) {
    rec.categories = KNOWN[sym].slice();
    rec.evidence = { rule: 'rede conhecida: consenso público do projeto' };
    rec.confident = true;
    return rec;
  }
  // only on Cexius: its networks say whether it is a token of another chain
  if (x && !q && !g) {
    const nets = await cexiusTokenNetworks(sym);
    if (nets) {
      rec.categories = ['token'];
      rec.evidence = { rule: `Cexius: token em ${nets.join(', ')}` };
      rec.confident = true;
      return rec;
    }
  }
  let links = [];
  if (g && g.desc) links = ((await getText('https://gatevia.io' + g.desc)) || '').match(/https?:\/\/github\.com\/[^"'<> )]+/g) || [];
  if (x && x.github) links.push(x.github);
  let analysis = null;
  let picked = null;
  for (const c of await findRepos(links, rec.website, rec.name, sym)) {
    analysis = await analyzeRepo(c.repo);
    if (analysis) { picked = c; break; }
  }
  const cats = [];
  if (analysis) {
    if (analysis.masternode) cats.push('masternode');
    if (analysis.stake) cats.push('stake');
    // mining: no stake code; or a hybrid whose proof-of-work has not ended yet (cutoff block above the
    // current height), or with no cutoff in the code while the exchange lists it as PoS + PoW
    const height = (q && q.height) || (g && g.height) || null;
    const powActive = analysis.last_pow_block != null ? (height != null && analysis.last_pow_block > height) : !!(g && g.list === 'PoS + PoW');
    if (!analysis.stake || powActive) cats.push('mining');
    analysis.chain_height = height;
    rec.source_code = analysis.url;
    rec.evidence = Object.assign({}, analysis, g && g.list ? { gatevia_list: g.list } : {});
    const agrees = !g || !g.list || (g.list === 'PoW' ? !analysis.stake : analysis.stake);
    // sure enough to publish alone: the repository is the coin's own (linked directly or named after it)
    // and it does not contradict the exchange's PoW / PoS list
    rec.confident = (picked.direct || picked.named) && agrees;
    if (!agrees) rec.evidence.warning = `o código não bate com a lista da Gatevia (${g.list})`;
    if (analysis.stake && analysis.last_pow_block == null && !cats.includes('mining')) rec.evidence.note = 'stake sem bloco final de mineração no código: confirme se também é minerável';
    // the code ends mining at a block, but no exchange told us the current height: the admin confirms
    if (analysis.stake && analysis.last_pow_block != null && height == null) {
      rec.confident = false;
      rec.evidence.note = `mineração termina no bloco ${analysis.last_pow_block} segundo o código, mas a altura atual da rede é desconhecida: confirme se ainda é minerável`;
    }
  } else if (g && g.list) {
    if (/PoS/.test(g.list)) cats.push('stake');
    if (/PoW/.test(g.list)) cats.push('mining');
    rec.evidence = { rule: `lista oficial da Gatevia: ${g.list} (código-fonte não encontrado)`, gatevia_list: g.list };
    rec.confident = false; // masternodes cannot be ruled out without the code
  }
  rec.categories = TABS.filter((t) => cats.includes(t));
  return rec;
}

const adminLink = (sym) => `${tpl.SITE}/admin/exchange-coin/${encodeURIComponent(sym)}?t=${secret.sign('excoin', sym)}`;
function notify(rec, listed) {
  const tabs = rec.categories.map((c) => TAB_PT[c]).join(' + ') || '—';
  const ev = rec.evidence || {};
  const rows = [['Moeda', `${rec.name} (${rec.symbol})`], ['Exchange', rec.exchanges.join(', ')], ['Abas', listed ? tabs : (rec.categories.length ? `sugestão: ${tabs} (aguardando sua confirmação)` : 'não classificada')], ['Site oficial', rec.website], ['Explorer', rec.explorer],
    ['Atenção', ev.warning || ev.note],
    ['Código-fonte', rec.source_code], ['Masternode no código', ev.repo ? (ev.masternode ? 'sim: ' + (ev.masternode_terms || []).join(', ') : 'não') : null],
    ['Stake no código', ev.repo ? (ev.stake ? 'sim' + (ev.stake_terms && ev.stake_terms.length ? ': ' + ev.stake_terms.join(', ') : '') : 'não') : null],
    ['Fim da mineração (bloco)', ev.last_pow_block], ['Lista da Gatevia', ev.gatevia_list], ['Regra', ev.rule]]
    .filter(([, v]) => v != null && v !== '').map(([k, v]) => `<tr><td style="padding:3px 10px 3px 0;color:#6b7090;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:3px 0;word-break:break-word">${esc(v)}</td></tr>`).join('');
  const subject = listed ? `[Nova moeda] ${rec.name} (${rec.symbol}) listada em ${tabs}` : `[Nova moeda] ${rec.name} (${rec.symbol}) precisa de classificação`;
  const intro = listed
    ? `A ${rec.exchanges.join(' e ')} listou uma moeda nova e ela já foi publicada no GaláxiaLunarium nas abas: ${tabs}.`
    : `A ${rec.exchanges.join(' e ')} listou uma moeda nova. Ela já tem página e aparece como "Nova moeda listada" na aba Exchanges, mas não foi possível classificá-la com segurança: escolha as abas (masternode, stake, mineração, token) no link abaixo.`;
  const html = tpl.layout(tpl.p(intro) + `<table style="border-collapse:collapse;font-size:14px">${rows}</table>` + tpl.button(adminLink(rec.symbol), listed ? 'Conferir ou corrigir' : 'Classificar agora') +
    (listed ? tpl.small(`Página da moeda: ${tpl.SITE}/?coin=${rec.symbol.toLowerCase()}`) : ''), 'Notificação interna do GaláxiaLunarium.', { lang: 'pt-BR' });
  return mailer.send({ to: mailer.adminRecipients(), subject, html, text: `${subject}\n${intro}\n${adminLink(rec.symbol)}` });
}

module.exports = function mountExchangeCoinsAuto(app, { callRoute }) {
  let running = false;
  async function check() {
    if (running) return [];
    running = true;
    const done = [];
    try {
      const meta = readMeta();
      const auto = readAuto();
      const known = new Set([...Object.keys(meta.coins || {}), ...Object.keys(meta.excluded || {}), ...Object.keys(auto.coins), ...Object.keys(auto.excluded), ...Object.keys(auto.pending), ...STABLE, ...HAS_PAGE]);
      const seen = {};
      const onSite = siteTickers();
      for (const [ex, label] of [['qutrade', 'Qutrade'], ['gatevia', 'Gatevia'], ['cexius', 'Cexius'], ['lunariumtrade', 'LunariumTrade']]) {
        let d = null;
        try { d = await callRoute(`/api/exchange/${ex}`, {}); } catch (e) { /* exchange unavailable this round */ }
        ((d && d.markets) || []).forEach((m) => {
          const s = String(m.base || '').toUpperCase();
          if (!s || known.has(s) || (ex === 'lunariumtrade' && onSite.has(s))) return;
          (seen[s] = seen[s] || new Set()).add(label);
        });
      }
      const fresh = Object.keys(seen);
      if (!fresh.length) return done;
      const info = { qutrade: await qutradeInfo(), gatevia: await gateviaInfo(), cexius: await cexiusInfo() };
      // a new exchange brings many coins at once: up to 15 a day
      for (const sym of fresh.slice(0, 15)) {
        // one process handles a coin: the hosting can keep two app processes alive for a moment
        // after a restart, and each would otherwise publish it and send its own e-mail
        const claim = path.join(plans.DATA_DIR, `exchange-coin-${sym.replace(/[^A-Z0-9]/g, '')}.claim`);
        try { fs.writeFileSync(claim, String(process.pid), { flag: 'wx' }); } catch (e) { continue; }
        setTimeout(() => { try { fs.unlinkSync(claim); } catch (e) { /* already gone */ } }, 10 * 60 * 1000).unref();
        if (readAuto().coins[sym] || readAuto().pending[sym] || readAuto().excluded[sym]) continue;
        const rec = await classify(sym, [...seen[sym]], info);
        // tabs only with evidence we are sure of; otherwise the coin still gets its page and the
        // "new listing" notice, and the tabs wait for the admin (the suggestion is kept)
        const listed = rec.confident && rec.categories.length > 0;
        const a = readAuto();
        const entry = { name: rec.name, categories: listed ? rec.categories : [], category: listed ? rec.categories[0] : null, suggested: rec.categories, website: rec.website, explorer: rec.explorer, source_code: rec.source_code || null, evidence: rec.evidence, exchanges: rec.exchanges, detected_at: new Date().toISOString(), auto: true };
        if (listed) a.coins[sym] = entry; else a.pending[sym] = entry;
        writeAuto(a);
        console.log(`new exchange coin ${sym}: ${listed ? 'listed in ' + rec.categories.join('+') : 'needs classification'}`);
        await notify(rec, listed);
        done.push(rec);
      }
    } catch (e) {
      console.error('exchange coin detection failed', e && e.message);
    } finally {
      running = false;
    }
    return done;
  }
  setInterval(check, CHECK_MS).unref();
  setTimeout(check, 3 * 60 * 1000).unref();

  // ---- admin: fix or exclude one coin (signed link from the e-mail; changes only by POST)
  const page = (title, body) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>body{margin:0;background:#081012;color:#eef5f3;font:15px/1.5 "Segoe UI",system-ui,sans-serif}.wrap{max-width:640px;margin:0 auto;padding:24px 16px}.card{background:#111c21;border:1px solid #24363c;border-radius:12px;padding:20px;margin-bottom:16px;overflow-wrap:anywhere}
h1{font-size:20px;margin:0 0 12px}label{display:block;margin:8px 0}input[type=text]{width:100%;box-sizing:border-box;background:#0c1519;color:#eef5f3;border:1px solid #24363c;border-radius:8px;padding:9px 12px;font:inherit}
button{border:0;border-radius:8px;padding:11px 16px;font-weight:700;font:inherit;font-weight:700;cursor:pointer;margin:8px 8px 0 0}.ok{background:#20df84;color:#04210f}.bad{background:#ff5b5b;color:#fff}.mut{color:#93a8ab;font-size:13px}a{color:#2ecfe6}td{padding:3px 10px 3px 0;vertical-align:top}</style></head><body><div class="wrap">${body}</div></body></html>`;
  const send = (res, status, title, body) => res.status(status).set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" }).type('html').send(page(title, body));
  const SYM_RE = /^[A-Z0-9]{1,15}$/;
  function current(sym) {
    const a = readAuto();
    const meta = readMeta();
    return a.coins[sym] || a.pending[sym] || (meta.coins || {})[sym] || null;
  }
  function form(sym, msg) {
    const a = readAuto();
    const c = current(sym);
    if (!c && !a.excluded[sym]) return null;
    const cats = (c && c.categories && c.categories.length ? c.categories : (c && c.suggested)) || [];
    const ev = (c && c.evidence) || {};
    const t = secret.sign('excoin', sym);
    const live = (c && c.categories) || [];
    const state = a.excluded[sym] ? 'Excluída (não aparece no site)' : live.length ? 'Publicada nas abas: ' + live.map((x) => TAB_PT[x]).join(' + ') : 'Aguardando a sua classificação (as abas marcadas abaixo são só a sugestão)';
    return `${msg ? `<div class="card" style="border-left:4px solid #20df84">${esc(msg)}</div>` : ''}<div class="card"><h1>${esc((c && c.name) || sym)} (${esc(sym)})</h1><p>${esc(state)}</p>
<table>${[['Exchange', c && c.exchanges && c.exchanges.join(', ')], ['Site', c && c.website], ['Explorer', c && c.explorer], ['Código-fonte', c && c.source_code], ['Masternode no código', ev.repo ? (ev.masternode ? 'sim' : 'não') : null], ['Stake no código', ev.repo ? (ev.stake ? 'sim' : 'não') : null], ['Lista da Gatevia', ev.gatevia_list], ['Regra', ev.rule]]
    .filter(([, v]) => v).map(([k, v]) => `<tr><td class="mut">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table></div>
<div class="card"><form method="post" action="/admin/exchange-coin/${esc(sym)}"><input type="hidden" name="t" value="${esc(t)}">
<label class="mut" for="name">Nome</label><input id="name" type="text" name="name" maxlength="60" value="${esc((c && c.name) || sym)}">
<p class="mut" style="margin:14px 0 4px">Abas em que a moeda aparece:</p>
${TABS.map((x) => `<label><input type="checkbox" name="cat" value="${x}"${cats.includes(x) ? ' checked' : ''}> ${TAB_PT[x]}</label>`).join('')}
<button class="ok" name="action" value="save">Salvar e publicar</button><button class="bad" name="action" value="exclude">Excluir (falsa / não listar)</button></form>
<p class="mut">A mudança aparece no site em 1 a 2 minutos.</p></div>`;
  }
  app.get('/admin/exchange-coin/:sym', (req, res) => {
    const sym = String(req.params.sym).toUpperCase();
    if (!SYM_RE.test(sym) || !secret.verify('excoin', sym, req.query.t)) return send(res, 403, 'Link inválido', '<div class="card">Link inválido.</div>');
    const body = form(sym);
    if (!body) return send(res, 404, 'Não encontrada', '<div class="card">Moeda não encontrada.</div>');
    send(res, 200, 'Moeda ' + sym, body);
  });
  app.post('/admin/exchange-coin/:sym', express.urlencoded({ extended: true, limit: '4kb' }), (req, res) => {
    const sym = String(req.params.sym).toUpperCase();
    const b = req.body || {};
    if (!SYM_RE.test(sym) || !secret.verify('excoin', sym, b.t)) return send(res, 403, 'Link inválido', '<div class="card">Link inválido.</div>');
    const base = current(sym);
    if (!base && !readAuto().excluded[sym]) return send(res, 404, 'Não encontrada', '<div class="card">Moeda não encontrada.</div>');
    const a = readAuto();
    if (b.action === 'exclude') {
      delete a.coins[sym]; delete a.pending[sym];
      a.excluded[sym] = `excluded by the admin on ${new Date().toISOString().slice(0, 10)}`;
      writeAuto(a);
      return send(res, 200, 'Moeda ' + sym, form(sym, 'Moeda excluída: não aparece mais no site.'));
    }
    const cats = TABS.filter((x) => [].concat(b.cat || []).includes(x));
    if (!cats.length) return send(res, 400, 'Moeda ' + sym, form(sym, 'Escolha pelo menos uma aba, ou use Excluir.'));
    const name = String(b.name || '').replace(/[\u0000-\u001f\u007f<>&"'`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || sym;
    delete a.pending[sym]; delete a.excluded[sym];
    a.coins[sym] = Object.assign({}, base || {}, { name, categories: cats, category: cats[0], reviewed_at: new Date().toISOString(), evidence: Object.assign({}, (base && base.evidence) || {}, { admin: 'abas confirmadas pelo administrador' }) });
    writeAuto(a);
    send(res, 200, 'Moeda ' + sym, form(sym, 'Salvo. Abas: ' + cats.map((x) => TAB_PT[x]).join(' + ') + '.'));
  });

  return { check, classify, qutradeInfo, gateviaInfo, cexiusInfo };
};
module.exports.AUTO_FILE = AUTO_FILE;
