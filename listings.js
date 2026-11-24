// Listing requests and order notifications.
// - E-mails: the customer gets payment instructions, confirmation and the listing decision in their
//   own language (emails-i18n.js); the team (data/mail.json "admin_to") gets every paid order and
//   every listing request, in Portuguese, with an automatic technical check and a 1-click link.
// - Review: GET /admin/listing/:id?t=<signed> shows the request and the check; approving or rejecting
//   is a POST from that page (so a mail scanner opening the link can never approve anything).
//   Approving a coin/token publishes it at once in data/listed-coins.json (served by
//   /api/listed-coins and shown on the site); an approved exchange is marked approved and its data
//   integration is done by hand.
// - Priority listings have a deadline (48h coin, 10 business days exchange): the team is reminded
//   before it ends and again if it passes.
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const express = require('express');
const plans = require('./api-plans');
const mailer = require('./mailer');
const events = require('./events');
const secret = require('./server-secret');
const STR = require('./emails-i18n');
const { ORDERS_FILE } = require('./api-orders');

const SITE = 'https://galaxia.lunariumcoin.com';
const LISTED_FILE = path.join(plans.DATA_DIR, 'listed-coins.json');
const LOGO_DIR = path.join(plans.DATA_DIR, 'listing-logos');
const FETCH_TIMEOUT_MS = 8000;
const MAX_LOGO_BYTES = 1024 * 1024;

const readOrders = () => plans.readJson(ORDERS_FILE, []);
const readListed = () => plans.readJson(LISTED_FILE, []);
// read-modify-write in one synchronous step, so it never interleaves with the payment watcher
function updateOrder(id, fn) {
  const orders = readOrders();
  const o = orders.find((x) => x.id === id);
  if (!o) return null;
  fn(o);
  plans.writeJsonAtomic(ORDERS_FILE, orders);
  return o;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (v, d) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtDate = (s) => new Date(s).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });

// ---- customer language
const AUDIT_NAME = require('./listing-audit-i18n');
const LIFETIME = require('./lifetime-i18n'); // texts of the one-time plan (see the file's index map)
const auditLang = (lang) => (AUDIT_NAME[lang] ? lang : (String(lang || '').split('-')[0].toLowerCase() === 'pt' ? 'pt-BR' : (AUDIT_NAME[String(lang || '').split('-')[0].toLowerCase()] ? String(lang).split('-')[0].toLowerCase() : 'en')));
function strings(lang) {
  if (STR[lang]) return STR[lang];
  const base = String(lang || '').split('-')[0].toLowerCase();
  if (base === 'pt') return STR['pt-BR'];
  return STR[base] || STR.en;
}
const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? vars[k] : m));

function ticketLink(o) {
  const token = o.token_enc ? secret.decrypt(o.token_enc) : null;
  const lang = encodeURIComponent(o.lang || 'pt-BR');
  return `${SITE}/checkout.html?lang=${lang}#order=${encodeURIComponent(o.id)}` + (token ? `&token=${encodeURIComponent(token)}` : '');
}
const adminLink = (o) => `${SITE}/admin/listing/${o.id}?t=${secret.sign('listing', o.id)}`;
const adminListLink = () => `${SITE}/admin/listings?t=${secret.sign('admin', 'listings')}`;

function productName(o, S) {
  // the priority coin listing is the listing and the audit of the coin
  if (o.kind === 'listing' && o.listing_type !== 'exchange' && o.tier !== 'standard') return `${AUDIT_NAME[auditLang(o.lang)]} (${S[24]})`;
  if (o.kind === 'listing') return `${o.listing_type === 'exchange' ? S[22] : S[21]} (${o.tier === 'standard' ? S[23] : S[24]})`;
  const cfg = plans.loadConfig();
  const p = cfg.plans[o.plan];
  return 'API ' + ((p && p.name) || o.plan);
}
const slaText = (o, S) => (o.listing_type === 'exchange' ? S[20] : S[19]);

// ---- e-mail layout (shared GaláxiaLunarium template)
const { layout, button, p } = require('./email-template');

function customerMail(o, subject, paragraphs, extraHtml, cta) {
  const S = strings(o.lang);
  const name = (o.customer && o.customer.name) || '';
  const html = layout(p(fill(S[25], { name })) + paragraphs.map(p).join('') + (extraHtml || '') + (cta ? button(cta.href, cta.label) : ''), S[18], { lang: o.lang, preheader: subject });
  const text = [fill(S[25], { name }), ...paragraphs, cta ? `${cta.label}: ${cta.href}` : '', '', S[18]].filter((x) => x != null).join('\n\n');
  return mailer.send({ to: o.customer && o.customer.email, subject, html, text });
}

function mailOrderCreated(o) {
  const S = strings(o.lang);
  const amount = nf(o.amount_xln, 4);
  const box = `<div style="background:#f4f5fb;border-radius:8px;padding:14px;margin:14px 0">
<div style="font-size:13px;color:#6b7090">${esc(S[2])}</div><div style="font-size:22px;font-weight:bold">${esc(amount)} XLN</div>
<div style="font-size:13px;color:#6b7090;margin-top:10px">${esc(S[3])}</div><div style="font-family:monospace;font-size:14px;word-break:break-all">${esc(o.pay_to)}</div></div>`;
  return customerMail(o, fill(S[0], { order: o.id, amount }), [fill(S[1], { product: productName(o, S) })], box, { href: ticketLink(o), label: S[16] });
}
function mailRegistered(o) {
  const S = strings(o.lang);
  return customerMail(o, fill(S[4], { ticket: o.ticket }), [fill(S[5], { product: productName(o, S) })], '', { href: ticketLink(o), label: S[16] });
}
function mailPaid(o) {
  const S = strings(o.lang);
  const msg = o.kind === 'listing' ? fill(S[8], { sla: slaText(o, S) }) : S[7];
  const paragraphs = [msg];
  // a new key of a plan that includes the coin listing and audit: say so, it is requested from the ticket
  if (o.kind !== 'listing' && o.includes_audit && !o.renew_key_id) paragraphs.push((LIFETIME[auditLang(o.lang)] || LIFETIME.en)[5]);
  return customerMail(o, fill(S[6], { ticket: o.ticket }), paragraphs, '', { href: ticketLink(o), label: S[16] });
}
function mailDecision(o, listedId) {
  const S = strings(o.lang);
  const name = (o.listing && o.listing.name) || '';
  if (o.listing_status === 'rejected') {
    const extra = o.listing_note ? `<p style="margin:0 0 12px"><b>${esc(S[15])}:</b> ${esc(o.listing_note)}</p>` : '';
    return customerMail(o, fill(S[13], { name }), [fill(S[14], { name })], extra, { href: ticketLink(o), label: S[16] });
  }
  if (o.listing_status === 'listed') {
    const href = listedId ? `${SITE}/?coin=${encodeURIComponent(listedId)}&lang=${encodeURIComponent(o.lang || 'pt-BR')}` : ticketLink(o);
    return customerMail(o, fill(S[9], { name }), [fill(S[10], { name })], '', { href, label: listedId ? S[17] : S[16] });
  }
  return customerMail(o, fill(S[11], { name }), [fill(S[12], { name })], '', { href: ticketLink(o), label: S[16] });
}

// ---- deadlines (priority listings)
function addBusinessDays(from, days) {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d;
}
function deadline(o) {
  if (o.kind !== 'listing' || o.tier === 'standard' || !o.paid_at) return null;
  return o.listing_type === 'exchange' ? addBusinessDays(o.paid_at, 10) : new Date(Date.parse(o.paid_at) + 48 * 3600 * 1000);
}

// ---- outbound checks (only public internet hosts: never the server's own network)
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}
async function safeFetch(url, opts = {}) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocolo não permitido');
  if (u.port && !['80', '443'].includes(u.port)) throw new Error('porta não permitida');
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('endereço não permitido');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(u, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (GalaxiaLunarium listing check)' }, signal: controller.signal, ...opts });
  } finally {
    clearTimeout(timer);
  }
}
async function reachable(url) {
  try {
    const r = await safeFetch(url);
    try { await r.body?.cancel(); } catch (e) { /* body not needed */ }
    if (r.status >= 300 && r.status < 400) return { ok: true, detail: `responde (redireciona, ${r.status})` };
    return { ok: r.status < 400 || r.status === 403, detail: `status ${r.status}${r.status === 403 ? ' (bloqueio anti-robô, abrir manualmente)' : ''}` };
  } catch (e) {
    return { ok: false, detail: 'não respondeu: ' + (e && e.message) };
  }
}
function rasterType(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return null;
}
// Downloads the logo once (raster formats only, never SVG, so it can't carry script).
async function fetchLogo(o) {
  if (!o.listing || !o.listing.logo) return { ok: false, detail: 'nenhum logo informado' };
  try {
    const r = await safeFetch(o.listing.logo);
    if (!r.ok) return { ok: false, detail: `status ${r.status}` };
    const buf = Buffer.from(await r.arrayBuffer());
    const type = rasterType(buf);
    if (!type) return { ok: false, detail: 'formato não aceito (use PNG, JPG, WEBP ou GIF)' };
    if (buf.length > MAX_LOGO_BYTES) return { ok: false, detail: 'arquivo acima de 1 MB' };
    fs.mkdirSync(LOGO_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOGO_DIR, o.id), buf);
    return { ok: true, detail: `${type.split('/')[1].toUpperCase()}, ${Math.round(buf.length / 1024)} KB` };
  } catch (e) {
    return { ok: false, detail: 'não baixou: ' + (e && e.message) };
  }
}

// ---- BSC token contract
function abiString(hex) {
  const h = String(hex || '').replace(/^0x/, '');
  if (h.length >= 192) {
    const len = parseInt(h.slice(64, 128), 16);
    return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8').replace(/\0/g, '');
  }
  return Buffer.from(h.slice(0, 64), 'hex').toString('utf8').replace(/\0/g, ''); // bytes32 symbol
}

// ---- markets: which integrated exchange a link belongs to, and its pair
const QUOTES = 'USDT|USDC|BTC|ETH|BNB|XLN|TRX|USD';
const EXCHANGE_HOSTS = [
  { host: /(^|\.)mexc\.com$/, name: 'MEXC', ticker: '/api/ticker/mexc', param: 'symbol', fmt: (b, q) => b + q },
  { host: /(^|\.)weex\.com$/, name: 'WEEX', ticker: '/api/ticker/weex', param: 'symbol', fmt: (b, q) => b + q },
  { host: /(^|\.)coinex\.com$/, name: 'CoinEx', ticker: '/api/ticker/coinex', param: 'market', fmt: (b, q) => b + q },
  { host: /(^|\.)binance\.com$/, name: 'Binance', ticker: '/api/ticker/binance', param: 'symbol', fmt: (b, q) => b + q },
  { host: /(^|\.)nonkyc\.io$/, name: 'NonKYC', ticker: '/api/ticker/nonkyc', param: 'symbol', fmt: (b, q) => b + '_' + q },
  { host: /(^|\.)gatevia\.io$/, name: 'Gatevia', ticker: '/api/ticker/gatevia', param: 'symbol', fmt: (b, q) => b + '_' + q },
  { host: /(^|\.)qutrade\.io$/, name: 'Qutrade', ticker: '/api/ticker/qutrade', param: 'symbol', fmt: (b, q) => b + '_' + q },
  { host: /(^|\.)lunariumtrade\.io$/, name: 'LunariumTrade', ticker: '/api/ticker/lunarium', param: 'pair', fmt: (b, q) => b + '/' + q },
];
const DEX_HOSTS = /(^|\.)(pancakeswap\.finance|dexscreener\.com|geckoterminal\.com|poocoin\.app|dextools\.io)$/;

function parseMarket(url, symbol) {
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  const host = u.hostname.toLowerCase();
  const text = decodeURIComponent(u.pathname + ' ' + u.search + ' ' + u.hash);
  if (DEX_HOSTS.test(host)) {
    const addr = (text.match(/0x[0-9a-fA-F]{40}/) || [])[0];
    const isPair = /dexscreener|geckoterminal|dextools/.test(host);
    return { exchange: host.includes('pancakeswap') ? 'PancakeSwap' : 'DEX', type: 'DEX', url, ticker: '/api/ticker/geckoterminal', query: addr ? Object.assign({ network: 'bsc' }, isPair ? { pool: addr } : { token: addr }) : null };
  }
  const ex = EXCHANGE_HOSTS.find((e) => e.host.test(host));
  if (!ex) return { exchange: host, type: 'CEX', url, ticker: null, query: null };
  let base = null;
  let quote = null;
  const sym = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const own = sym && text.toUpperCase().match(new RegExp('(?:^|[^A-Z0-9])' + sym + '[-_/]?(' + QUOTES + ')(?![A-Z])'));
  if (own) { base = sym; quote = own[1]; } else {
    // "XXX_USDT" / "XXX-USDT" first; "XXX/USDT" only after (a path like /market/XLN_USDT must not read as MARKET/XLN)
    const up = text.toUpperCase();
    const any = up.match(new RegExp('([A-Z0-9]{2,15})[-_](' + QUOTES + ')(?![A-Z])')) || up.match(new RegExp('([A-Z0-9]{2,15})/(' + QUOTES + ')(?![A-Z])'));
    if (any) { base = any[1]; quote = any[2]; } else if (sym) { base = sym; quote = 'USDT'; }
  }
  if (sym && base !== sym) return { exchange: ex.name, type: 'CEX', url, pair: base + '/' + quote, ticker: ex.ticker, query: null, mismatch: true };
  if (!base) return { exchange: ex.name, type: 'CEX', url, ticker: ex.ticker, query: null };
  return { exchange: ex.name, type: 'CEX', url, pair: base + '/' + quote, ticker: ex.ticker, query: { [ex.param]: ex.fmt(base, quote) } };
}

// ---- automatic technical check (a help for the review, not a verdict)
async function technicalCheck(o, { callRoute, bscEthCall }) {
  const L = o.listing || {};
  const items = [];
  let token = null;
  const add = (label, r) => items.push({ label, ok: r.ok, detail: r.detail });
  add('Site', await reachable(L.website));
  if (o.listing_type === 'exchange') {
    add('Documentação da API', await reachable(L.api_docs));
  } else {
    if (L.explorer) add('Explorer', await reachable(L.explorer));
    if (L.source_code) add('Código-fonte', await reachable(L.source_code));
  }
  add('Logo', await fetchLogo(o));
  if (o.listing_type !== 'exchange') {
    let known = [];
    try { known = JSON.parse(fs.readFileSync(path.join(__dirname, 'public-api-coins.json'), 'utf8')); } catch (e) { /* no registry */ }
    known = known.concat(readListed().filter((c) => c.order_id !== o.id));
    const contract = String(L.contract || '').toLowerCase();
    const same = known.find((c) => contract && String(c.contract || '').toLowerCase() === contract);
    const sameSym = known.filter((c) => String(c.symbol || '').toUpperCase() === String(L.symbol || '').toUpperCase());
    if (same) add('Duplicidade', { ok: false, detail: `este contrato já está listado como ${same.name} (${same.id})` });
    else if (sameSym.length) add('Duplicidade', { ok: null, detail: `já existe moeda com o símbolo ${String(L.symbol).toUpperCase()}: ${sameSym.map((c) => c.name).join(', ')}` });
    else add('Duplicidade', { ok: true, detail: 'moeda ainda não listada' });
  }

  if (o.listing_type !== 'exchange' && L.contract) {
    const isBsc = !L.network || /bsc|bep|binance|bnb/i.test(L.network);
    if (!/^0x[0-9a-fA-F]{40}$/.test(L.contract)) add('Contrato', { ok: false, detail: 'endereço em formato inválido' });
    else if (!isBsc) add('Contrato', { ok: null, detail: `rede "${L.network}" não é verificada automaticamente` });
    else {
      try {
        const [symHex, decHex, supHex] = await Promise.all([bscEthCall(L.contract, '0x95d89b41'), bscEthCall(L.contract, '0x313ce567'), bscEthCall(L.contract, '0x18160ddd')]);
        const sym = abiString(symHex);
        const dec = parseInt(decHex, 16);
        const supply = Number(BigInt(supHex) / 10n ** BigInt(Math.max(0, dec || 0)));
        const match = sym.toUpperCase() === String(L.symbol || '').toUpperCase();
        token = { symbol: sym, decimals: dec, supply };
        add('Contrato BSC', { ok: match, detail: `símbolo ${sym}${match ? '' : ` (diferente do informado: ${L.symbol})`}, ${dec} decimais, supply ${nf(supply, 0)}` });
      } catch (e) {
        add('Contrato BSC', { ok: false, detail: 'contrato não respondeu (não é um token BEP-20?)' });
      }
      try {
        const t = await callRoute('/api/ticker/geckoterminal', { network: 'bsc', token: L.contract });
        add('Pool DEX', t && t.price > 0 ? { ok: true, detail: `preço US$ ${t.price}${t.volume != null ? `, volume 24h US$ ${nf(t.volume, 0)}` : ''}` } : { ok: false, detail: 'nenhum pool com preço encontrado' });
      } catch (e) {
        add('Pool DEX', { ok: false, detail: 'nenhum pool encontrado: ' + (e && e.message) });
      }
    }
  }

  const markets = [];
  const lines = String(L.markets || '').split(/\s+/).filter((s) => /^https?:\/\//i.test(s)).slice(0, 8);
  for (const url of lines) {
    const m = parseMarket(url, L.symbol);
    if (!m) continue;
    if (!m.ticker) {
      const r = await reachable(url);
      add(`Mercado ${m.exchange}`, { ok: r.ok ? null : false, detail: `corretora sem integração, conferir manualmente (${r.detail})` });
      continue;
    }
    if (m.mismatch) { add(`Mercado ${m.exchange} ${m.pair}`, { ok: false, detail: `o link é de outro par (${m.pair}), não de ${String(L.symbol).toUpperCase()}` }); continue; }
    if (!m.query) { add(`Mercado ${m.exchange}`, { ok: null, detail: 'não foi possível identificar o par no link, conferir manualmente' }); continue; }
    try {
      const t = await callRoute(m.ticker, m.query);
      if (t && t.price > 0) {
        add(`Mercado ${m.exchange}${m.pair ? ' ' + m.pair : ''}`, { ok: true, detail: `preço ${t.price}${t.volume != null ? `, volume 24h ${nf(t.volume, 2)}` : ''}` });
        markets.push({ exchange: m.exchange, type: m.type, pair: m.pair || null, url: m.url, ticker: m.ticker, params: new URLSearchParams(m.query).toString() });
      } else add(`Mercado ${m.exchange}${m.pair ? ' ' + m.pair : ''}`, { ok: false, detail: 'mercado sem preço' });
    } catch (e) {
      add(`Mercado ${m.exchange}${m.pair ? ' ' + m.pair : ''}`, { ok: false, detail: 'mercado não encontrado: ' + (e && e.message) });
    }
  }
  if (o.listing_type !== 'exchange' && !lines.length) add('Mercados', { ok: false, detail: 'nenhum link de mercado informado' });
  return { at: new Date().toISOString(), items, markets, token };
}

// ---- admin e-mails (Portuguese)
function checkHtml(check) {
  if (!check) return '<p>Checagem técnica indisponível.</p>';
  const icon = (ok) => (ok === true ? '✅' : ok === false ? '❌' : '⚠️');
  return '<table style="border-collapse:collapse;width:100%;font-size:14px">' + check.items.map((i) =>
    `<tr><td style="padding:4px 8px 4px 0;vertical-align:top">${icon(i.ok)}</td><td style="padding:4px 8px 4px 0;vertical-align:top;white-space:nowrap"><b>${esc(i.label)}</b></td><td style="padding:4px 0">${esc(i.detail)}</td></tr>`).join('') + '</table>';
}
function detailsHtml(o) {
  const c = o.customer || {};
  const L = o.listing || {};
  const row = (k, v) => (v ? `<tr><td style="padding:3px 10px 3px 0;color:#6b7090;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:3px 0;word-break:break-word">${esc(v)}</td></tr>` : '');
  const dl = deadline(o);
  return '<table style="border-collapse:collapse;font-size:14px">' +
    row('Ticket', o.ticket) + row('Tipo', `${o.listing_type === 'exchange' ? 'Exchange' : 'Moeda/token'} — ${o.tier === 'standard' ? 'padrão (grátis)' : 'prioritária'}${o.included_in_plan ? ' — com auditoria, incluída no plano de API (chave ' + o.included_in_plan + ')' : ''}`) +
    (o.amount_xln ? row('Pago', `${nf(o.amount_xln, 4)} XLN (US$ ${nf(o.price_usd, 2)})${o.txid ? ' — tx ' + o.txid : ''}`) : '') +
    (dl ? row('Prazo', fmtDate(dl)) : '') +
    row('Nome', L.name) + row('Símbolo', L.symbol) + row('Site', L.website) + row('Explorer', L.explorer) + row('Código-fonte', L.source_code) +
    row('Rede', L.network) + row('Contrato', L.contract) + row('Documentação API', L.api_docs) + row('Pares', L.pairs) + row('Mercados', L.markets) +
    row('Logo', L.logo) + row('Descrição', L.description) +
    row('Cliente', [c.name, c.company].filter(Boolean).join(' — ')) + row('E-mail', c.email) + row('Contato', c.contact) + row('País', c.country) + row('Carteira XLN', c.wallet) +
    row('Idioma', o.lang) + '</table>';
}
function mailAdminListing(o) {
  const L = o.listing || {};
  const subject = `[Listagem ${o.tier === 'standard' ? 'padrão' : 'PRIORITÁRIA'}] ${L.name || ''}${L.symbol ? ' (' + L.symbol + ')' : ''} — ${o.ticket}`;
  const html = layout(`<p style="margin:0 0 12px"><b>Nova solicitação de listagem</b> de ${o.listing_type === 'exchange' ? 'exchange' : 'moeda/token'}.</p>` +
    detailsHtml(o) + '<h3 style="font-size:16px;margin:20px 0 8px">Checagem técnica automática</h3>' + checkHtml(o.check) +
    button(adminLink(o), 'Revisar e aprovar') + `<p style="font-size:13px"><a href="${esc(adminListLink())}">Ver todas as solicitações pendentes</a></p>`, 'Notificação interna do GaláxiaLunarium.');
  const text = `Nova solicitação de listagem ${o.ticket}: ${L.name || ''} ${L.symbol || ''}\nRevisar e aprovar: ${adminLink(o)}`;
  return mailer.send({ to: mailer.adminRecipients(), subject, html, text });
}
function mailAdminApiPaid(o) {
  const c = o.customer || {};
  const kind = o.change_from ? ` (mudança de ${o.change_from} para ${o.plan})` : o.renew_key_id ? ' (renovação)' : '';
  const subject = `[API] Plano ${o.plan}${kind} pago — ${o.ticket}`;
  const html = layout(`<p style="margin:0 0 12px"><b>Pagamento confirmado</b>. A chave de API foi liberada automaticamente.</p><table style="font-size:14px">` +
    [['Ticket', o.ticket], ['Plano', o.plan + kind], ['Vigência', o.renew_key_id ? 'mais 30 dias' : (o.lifetime ? 'vitalícia (pagamento único)' : '30 dias')],
      ['Auditoria de moeda', o.includes_audit && !o.renew_key_id ? 'incluída no plano — o cliente solicita pelo ticket ou pelo painel (chega como listagem prioritária)' : ''],
      ['Valor', `${nf(o.paid_xln || o.amount_xln, 4)} XLN (US$ ${nf(o.price_usd, 2)})`], ['Transação', o.txid], ['Cliente', [c.name, c.company].filter(Boolean).join(' — ')], ['E-mail', c.email]]
      .filter(([, v]) => v).map(([k, v]) => `<tr><td style="padding:3px 10px 3px 0;color:#6b7090">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('') + '</table>', 'Notificação interna do GaláxiaLunarium.');
  return mailer.send({ to: mailer.adminRecipients(), subject, html, text: `${subject}\nCliente: ${c.name} <${c.email}>\nTx: ${o.txid}` });
}

// ---- publishing an approved coin/token
// Published fields end up in the site's HTML, so they keep no markup-significant characters at all.
const safeText = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f<>&`]/g, ' ').replace(/'/g, '\u2019').replace(/"/g, '\u201d').replace(/\s+/g, ' ').trim().slice(0, max);
function safeUrl(u) {
  try {
    const x = new URL(String(u || ''));
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return null;
    return x.href.replace(/'/g, '%27').replace(/"/g, '%22').replace(/</g, '%3C').replace(/>/g, '%3E');
  } catch (e) {
    return null;
  }
}
const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
function publishCoin(o, takenIds) {
  const L = o.listing || {};
  const listed = readListed();
  const existing = listed.find((c) => c.order_id === o.id);
  const taken = new Set([...takenIds, ...listed.filter((c) => c !== existing).map((c) => c.id)]);
  let id = existing ? existing.id : slug(L.symbol) || slug(L.name) || o.id;
  if (!existing) for (let n = 2; taken.has(id); n++) id = `${slug(L.symbol) || o.id}-${n}`;
  const hasLogo = fs.existsSync(path.join(LOGO_DIR, o.id));
  const coin = {
    id,
    symbol: String(L.symbol || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 15),
    name: safeText(L.name, 60),
    category: L.contract ? 'token' : 'coin',
    network: safeText(L.network, 60) || (L.contract ? 'BSC' : 'native'),
    contract: /^0x[0-9a-fA-F]{40}$/.test(L.contract || '') ? L.contract : null,
    logo: hasLogo ? `/api/listed-logo/${id}` : null,
    description: safeText(L.description, 800) || null,
    supply: o.check && o.check.token && Number.isFinite(o.check.token.supply) ? o.check.token.supply : null,
    links: { website: safeUrl(L.website), explorer: safeUrl(L.explorer), source_code: safeUrl(L.source_code) },
    markets: ((o.check && o.check.markets) || []).map((m) => Object.assign({}, m, { url: safeUrl(m.url) })),
    ticket: o.ticket,
    order_id: o.id,
    tier: o.tier || 'priority',
    listed_at: existing ? existing.listed_at : new Date().toISOString(),
  };
  if (existing) Object.assign(existing, coin); else listed.push(coin);
  plans.writeJsonAtomic(LISTED_FILE, listed);
  return coin;
}

// ---- admin pages
function page(title, body) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>:root{--bg:#0d1030;--card:#171b45;--text:#e8eaff;--muted:#a3a8d6;--accent:#7c6cff;--ok:#2fbf71;--bad:#e5484d}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 Arial,Helvetica,sans-serif}.wrap{max-width:820px;margin:0 auto;padding:24px 16px}
.card{background:var(--card);border-radius:12px;padding:20px;margin-bottom:16px;overflow-wrap:anywhere}h1{font-size:22px;margin:0 0 16px}h2{font-size:17px;margin:0 0 12px}
table{border-collapse:collapse;width:100%}td{padding:5px 8px 5px 0;vertical-align:top;overflow-wrap:anywhere}td:first-child{white-space:nowrap;width:1%;color:var(--muted)}td.k{min-width:90px;overflow-wrap:normal}
a{color:#b3a9ff}.btn{border:0;border-radius:8px;padding:12px 18px;font-weight:bold;font-size:15px;cursor:pointer;color:#fff;margin:6px 8px 6px 0}
.ok{background:var(--ok)}.bad{background:var(--bad)}textarea{width:100%;box-sizing:border-box;min-height:70px;border-radius:8px;border:1px solid #3a3f7a;background:#0d1030;color:var(--text);padding:8px;font:inherit}
.tag{display:inline-block;border-radius:6px;padding:2px 8px;font-size:13px;background:#2a2f66}.muted{color:var(--muted);font-size:13px}</style></head>
<body><div class="wrap">${body}</div></body></html>`;
}
function sendPage(res, status, title, body) {
  res.status(status).set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'" }).type('html').send(page(title, body));
}
const STATUS_PT = { under_review: 'Em análise', approved: 'Aprovada', listed: 'Listada', rejected: 'Recusada' };

module.exports = function mountListings(app, { callRoute, bscEthCall, registryIds }) {
  const deps = { callRoute, bscEthCall };

  async function checkAndNotify(orderId) {
    const o0 = readOrders().find((x) => x.id === orderId);
    if (!o0) return;
    let check = null;
    try { check = await technicalCheck(o0, deps); } catch (e) { console.error('listing check failed', orderId, e && e.message); }
    const o = updateOrder(orderId, (x) => { x.check = check; }) || o0;
    await mailAdminListing(o);
  }

  events.on('order.created', ({ order }) => { mailOrderCreated(order).catch(() => {}); });
  events.on('listing.registered', ({ order }) => {
    mailRegistered(order).catch(() => {});
    checkAndNotify(order.id).catch((e) => console.error('listing notify failed', e && e.message));
  });
  events.on('order.paid', ({ order }) => {
    mailPaid(order).catch(() => {});
    if (order.kind === 'listing') checkAndNotify(order.id).catch((e) => console.error('listing notify failed', e && e.message));
    else mailAdminApiPaid(order).catch(() => {});
  });

  // ---- public: coins listed through approved requests
  app.get('/api/listed-coins', (req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ ok: true, data: readListed().map(({ order_id, ...c }) => c) });
  });
  app.get('/api/listed-logo/:id', (req, res) => {
    const c = readListed().find((x) => x.id === req.params.id);
    const file = c && path.join(LOGO_DIR, c.order_id);
    if (!file || !fs.existsSync(file)) return res.status(404).end();
    const buf = fs.readFileSync(file);
    const type = rasterType(buf);
    if (!type) return res.status(404).end();
    res.set({ 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" }).type(type).send(buf);
  });

  // ---- admin: one request
  const findListing = (id) => readOrders().find((o) => o.id === id && o.kind === 'listing' && (o.status === 'paid' || o.status === 'registered'));
  function reviewPage(o, message) {
    const check = o.check;
    const icon = (ok) => (ok === true ? '✅' : ok === false ? '❌' : '⚠️');
    const checkRows = check ? check.items.map((i) => `<tr><td>${icon(i.ok)}</td><td class="k"><b>${esc(i.label)}</b></td><td>${esc(i.detail)}</td></tr>`).join('') : '<tr><td>Checagem ainda em andamento ou indisponível.</td></tr>';
    const t = secret.sign('listing', o.id);
    const open = o.listing_status === 'under_review';
    const logo = fs.existsSync(path.join(LOGO_DIR, o.id)) ? `<img src="/admin/listing/${esc(o.id)}/logo?t=${esc(t)}" alt="" style="width:48px;height:48px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:10px">` : '';
    const approveLabel = o.listing_type === 'exchange' ? 'Aprovar exchange' : 'Aprovar e listar agora';
    const actions = open ? `<div class="card"><h2>Decisão</h2>
<form method="post" action="/admin/listing/${esc(o.id)}"><input type="hidden" name="t" value="${esc(t)}">
<p class="muted">${o.listing_type === 'exchange' ? 'A exchange fica aprovada; a integração dos dados é feita em seguida.' : 'A moeda aparece no site na hora, com os mercados que passaram na checagem.'} O cliente recebe um e-mail no idioma dele.</p>
<label class="muted" for="note">Observação ou motivo (enviado ao cliente em caso de recusa)</label><textarea id="note" name="note" maxlength="500"></textarea>
<button class="btn ok" name="action" value="approve">${approveLabel}</button><button class="btn bad" name="action" value="reject">Recusar</button>
<button class="btn" style="background:#2a2f66" name="action" value="recheck">Refazer checagem</button></form></div>` : '';
    const dl = deadline(o);
    return `${message ? `<div class="card" style="border-left:4px solid var(--accent)">${esc(message)}</div>` : ''}
<div class="card"><h1>${logo}${esc((o.listing && o.listing.name) || '')} ${o.listing && o.listing.symbol ? `(${esc(o.listing.symbol)})` : ''}</h1>
<p><span class="tag">${esc(STATUS_PT[o.listing_status] || o.listing_status)}</span> <span class="tag">${o.tier === 'standard' ? 'Padrão (grátis)' : 'Prioritária'}</span>${dl ? ` <span class="tag">Prazo ${esc(fmtDate(dl))}</span>` : ''}</p>
${o.listing_note ? `<p class="muted">Observação: ${esc(o.listing_note)}</p>` : ''}${detailsHtml(o).replace(/style="[^"]*"/g, '')}</div>
<div class="card"><h2>Checagem técnica automática</h2><table>${checkRows}</table>${check ? `<p class="muted">Feita em ${esc(fmtDate(check.at))}</p>` : ''}</div>
${actions}<p class="muted"><a href="${esc(adminListLink().replace(SITE, ''))}">Todas as solicitações</a></p>`;
  }

  app.get('/admin/listing/:id', (req, res) => {
    if (!secret.verify('listing', req.params.id, req.query.t)) return sendPage(res, 403, 'Link inválido', '<div class="card">Link inválido ou incompleto.</div>');
    const o = findListing(req.params.id);
    if (!o) return sendPage(res, 404, 'Não encontrada', '<div class="card">Solicitação não encontrada.</div>');
    sendPage(res, 200, 'Listagem ' + o.ticket, reviewPage(o));
  });
  app.get('/admin/listing/:id/logo', (req, res) => {
    if (!secret.verify('listing', req.params.id, req.query.t)) return res.status(403).end();
    const file = path.join(LOGO_DIR, String(req.params.id).replace(/[^a-f0-9]/g, ''));
    if (!fs.existsSync(file)) return res.status(404).end();
    const buf = fs.readFileSync(file);
    const type = rasterType(buf);
    if (!type) return res.status(404).end();
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }).type(type).send(buf);
  });

  app.post('/admin/listing/:id', express.urlencoded({ extended: false, limit: '8kb' }), async (req, res) => {
    const id = req.params.id;
    const body = req.body || {};
    if (!secret.verify('listing', id, body.t)) return sendPage(res, 403, 'Link inválido', '<div class="card">Link inválido.</div>');
    const o = findListing(id);
    if (!o) return sendPage(res, 404, 'Não encontrada', '<div class="card">Solicitação não encontrada.</div>');
    const note = String(body.note || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').trim().slice(0, 500);
    const action = String(body.action || '');

    if (action === 'recheck') {
      let check = null;
      try { check = await technicalCheck(o, deps); } catch (e) { /* shown as unavailable */ }
      const updated = updateOrder(id, (x) => { x.check = check; });
      return sendPage(res, 200, 'Listagem ' + o.ticket, reviewPage(updated, 'Checagem refeita.'));
    }
    if (o.listing_status !== 'under_review') return sendPage(res, 200, 'Listagem ' + o.ticket, reviewPage(o, 'Esta solicitação já foi decidida.'));

    if (action === 'reject') {
      const updated = updateOrder(id, (x) => { x.listing_status = 'rejected'; x.listing_note = note; x.listing_updated_at = new Date().toISOString(); });
      console.log(`listing ${updated.ticket} rejected`);
      await mailDecision(updated);
      return sendPage(res, 200, 'Listagem ' + o.ticket, reviewPage(updated, 'Solicitação recusada. O cliente foi avisado por e-mail.'));
    }
    if (action === 'approve') {
      let coin = null;
      if (o.listing_type !== 'exchange') {
        if (!o.check) { try { const check = await technicalCheck(o, deps); updateOrder(id, (x) => { x.check = check; }); o.check = check; } catch (e) { /* publish without markets */ } }
        coin = publishCoin(o, registryIds());
      }
      const updated = updateOrder(id, (x) => {
        x.listing_status = coin ? 'listed' : 'approved';
        x.listing_note = note;
        x.listing_updated_at = new Date().toISOString();
        if (coin) x.listed_id = coin.id;
      });
      console.log(`listing ${updated.ticket} ${updated.listing_status}${coin ? ' as ' + coin.id : ''}`);
      await mailDecision(updated, coin && coin.id);
      const msg = coin ? `Aprovada e publicada: ${SITE}/?coin=${coin.id}. O cliente foi avisado por e-mail.` : 'Exchange aprovada. O cliente foi avisado por e-mail; falta fazer a integração dos dados.';
      return sendPage(res, 200, 'Listagem ' + o.ticket, reviewPage(updated, msg));
    }
    sendPage(res, 400, 'Ação inválida', '<div class="card">Ação inválida.</div>');
  });

  // ---- admin: all requests
  app.get('/admin/listings', (req, res) => {
    if (!secret.verify('admin', 'listings', req.query.t)) return sendPage(res, 403, 'Link inválido', '<div class="card">Link inválido.</div>');
    const list = readOrders().filter((o) => o.kind === 'listing' && (o.status === 'paid' || o.status === 'registered'))
      .sort((a, b) => (a.listing_status === 'under_review' ? 0 : 1) - (b.listing_status === 'under_review' ? 0 : 1) || String(b.paid_at).localeCompare(String(a.paid_at)));
    const rows = list.map((o) => {
      const dl = deadline(o);
      return `<tr><td><a href="${esc(adminLink(o).replace(SITE, ''))}">${esc(o.ticket)}</a></td><td>${esc((o.listing && o.listing.name) || '')}</td><td>${o.listing_type === 'exchange' ? 'Exchange' : 'Moeda'} · ${o.tier === 'standard' ? 'padrão' : 'prioritária'}</td><td>${esc(STATUS_PT[o.listing_status] || o.listing_status)}</td><td>${dl ? esc(fmtDate(dl)) : '—'}</td></tr>`;
    }).join('');
    sendPage(res, 200, 'Solicitações de listagem', `<div class="card"><h1>Solicitações de listagem</h1><table><tr class="muted"><td>Ticket</td><td>Nome</td><td>Tipo</td><td>Situação</td><td>Prazo</td></tr>${rows || '<tr><td colspan="5">Nenhuma solicitação ainda.</td></tr>'}</table></div>`);
  });

  // ---- deadline reminders for priority listings
  async function remind() {
    const now = Date.now();
    for (const o of readOrders()) {
      if (o.kind !== 'listing' || o.listing_status !== 'under_review') continue;
      const dl = deadline(o);
      if (!dl) continue;
      const left = dl.getTime() - now;
      const warnAt = o.listing_type === 'exchange' ? 2 * 24 * 3600 * 1000 : 12 * 3600 * 1000;
      let kind = null;
      if (left <= 0 && !o.reminded_overdue) kind = 'overdue';
      else if (left > 0 && left <= warnAt && !o.reminded_soon) kind = 'soon';
      if (!kind) continue;
      updateOrder(o.id, (x) => { if (kind === 'overdue') x.reminded_overdue = true; else x.reminded_soon = true; });
      const name = (o.listing && o.listing.name) || '';
      const subject = kind === 'overdue' ? `[ATRASADA] Listagem ${name} — prazo venceu em ${fmtDate(dl)}` : `[Lembrete] Listagem ${name} — prazo termina em ${fmtDate(dl)}`;
      await mailer.send({ to: mailer.adminRecipients(), subject,
        html: layout(`<p style="margin:0 0 12px">${esc(subject)}</p>${detailsHtml(o)}${button(adminLink(o), 'Revisar e aprovar')}`, 'Notificação interna do GaláxiaLunarium.'),
        text: `${subject}\n${adminLink(o)}` });
    }
  }
  setInterval(() => { remind().catch((e) => console.error('listing reminders failed', e && e.message)); }, 30 * 60 * 1000).unref();
};

module.exports.readListed = readListed;
module.exports.technicalCheck = technicalCheck;
module.exports.parseMarket = parseMarket;
