// Private administration panel. Not linked anywhere: it lives at a random path kept only on the
// server (data/admin.json), and every other path keeps answering 404.
// Access = password (set by the owner through a one-time link sent by e-mail; stored as scrypt)
//        + a 6-digit code e-mailed to the admin address (mail.json "admin_to") at every sign-in.
// Session: HttpOnly, Secure, SameSite=Strict cookie scoped to the panel path, 12 hours.
// The panel only reads data; it changes nothing in accounts, keys or orders.
//   node tools/admin.js setup   -> creates the path if needed and e-mails a setup link (30 min)
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const plans = require('./api-plans');
const mailer = require('./mailer');
const tpl = require('./email-template');

const ADMIN_FILE = path.join(plans.DATA_DIR, 'admin.json');
const ACCOUNTS_FILE = path.join(plans.DATA_DIR, 'accounts.json');
const SESSIONS_FILE = path.join(plans.DATA_DIR, 'sessions.json');
const ORDERS_FILE = path.join(plans.DATA_DIR, 'api-orders.json');
const LISTED_FILE = path.join(plans.DATA_DIR, 'listed-coins.json');
const OUTBOX_FILE = path.join(plans.DATA_DIR, 'mail-outbox.json');
const COOKIE = 'glx_admin';
const SESSION_MS = 12 * 3600 * 1000;
const CODE_MS = 10 * 60 * 1000;
const SETUP_MS = 30 * 60 * 1000;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const scrypt = (pw, salt) => new Promise((resolve, reject) => crypto.scrypt(String(pw), salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? reject(e) : resolve(k.toString('hex')))));
const esc = tpl.esc;
const readAdmin = () => plans.readJson(ADMIN_FILE, {});
const writeAdmin = (a) => plans.writeJsonAtomic(ADMIN_FILE, a);
const eq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ---- used by tools/admin.js
function ensureSlug() {
  const a = readAdmin();
  if (!a.slug) { a.slug = 'gx-' + crypto.randomBytes(9).toString('base64url').replace(/[^a-zA-Z0-9]/g, 'x'); writeAdmin(a); }
  return a.slug;
}
async function sendSetupLink() {
  const slug = ensureSlug();
  const token = crypto.randomBytes(32).toString('base64url');
  const a = readAdmin();
  a.setup_hash = sha(token);
  a.setup_expires_at = new Date(Date.now() + SETUP_MS).toISOString();
  writeAdmin(a);
  const link = `${tpl.SITE}/${slug}/setup?t=${token}`;
  const ok = await mailer.send({
    to: mailer.adminRecipients(),
    subject: 'Painel administrativo — criar senha',
    html: tpl.layout(tpl.p('Use o botão abaixo para criar a senha do painel administrativo do GaláxiaLunarium.') + tpl.button(link, 'Criar senha do painel') + tpl.small('O link vale 30 minutos e funciona uma vez. Se você não pediu, ignore este e-mail.') + tpl.linkFallback(link), 'Notificação interna do GaláxiaLunarium.', { lang: 'pt-BR' }),
    text: `Crie a senha do painel administrativo (link válido por 30 minutos): ${link}`,
  });
  return { slug, sent: ok, recipients: mailer.adminRecipients().length };
}

// ---- page shell
function page(title, body, opts = {}) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>
:root{--bg:#081012;--panel:#111c21;--panel2:#0c1519;--line:#24363c;--text:#eef5f3;--mut:#93a8ab;--green:#20df84;--cyan:#2ecfe6;--amber:#f4b72f;--red:#ff5b5b;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 "Segoe UI",system-ui,sans-serif}
.wrap{max-width:1240px;margin:0 auto;padding:20px 16px 48px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:18px}
h1{font-size:20px;margin:0}h1 span{color:var(--cyan)}h2{font-size:16px;margin:0 0 12px}
nav.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px}nav.tabs a{color:var(--mut);text-decoration:none;padding:8px 12px;border:1px solid var(--line);border-radius:8px}nav.tabs a.on{color:var(--text);border-color:var(--green);background:rgba(32,223,132,.08)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:18px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px}.kpi label{display:block;color:var(--mut);font-size:12px}.kpi b{font-size:22px;font-variant-numeric:tabular-nums}.kpi small{display:block;color:var(--mut)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:top}th{color:var(--mut);font-weight:600;position:sticky;top:0;background:var(--panel)}td.num{text-align:right;font-variant-numeric:tabular-nums}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line)}.ok{color:var(--green);border-color:rgba(32,223,132,.4)}.warn{color:var(--amber);border-color:rgba(244,183,47,.4)}.bad{color:var(--red);border-color:rgba(255,91,91,.4)}.mut{color:var(--mut)}
form.inline{display:inline}input[type=search],input[type=password],input[type=text]{background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:9px 12px;font:inherit}
button,.btn{background:var(--green);color:#04210f;border:0;border-radius:8px;padding:9px 14px;font-weight:700;cursor:pointer;font:inherit;font-weight:700}.ghost{background:transparent;color:var(--text);border:1px solid var(--line)}
.login{max-width:380px;margin:12vh auto;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:24px;display:grid;gap:12px}
.err{color:var(--red)}a{color:var(--cyan)}
</style></head><body>${body}</body></html>`;
}
function send(res, status, title, body) {
  res.status(status).set({
    'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  }).type('html').send(page(title, body));
}

const fmtDate = (s) => (s ? new Date(s).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : '—');
const nf = (v, d = 0) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }));

module.exports = function mountAdmin(app) {
  const notFound = (req, res) => res.status(404).type('text').send('Not Found');
  // the panel path is read on every request, so `tools/admin.js setup` works without a restart
  const slugOf = (req) => { const s = readAdmin().slug; return s && req.params.slug === s ? s : null; };

  // ---- abuse protection
  const hits = new Map();
  const tooMany = (key, max, ms) => {
    const now = Date.now();
    const l = (hits.get(key) || []).filter((t) => now - t < ms);
    hits.set(key, l);
    return l.length >= max;
  };
  const hit = (key) => { (hits.get(key) || hits.set(key, []).get(key)).push(Date.now()); };
  const ip = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  const sameOrigin = (req) => { const o = req.headers.origin; if (!o) return true; try { return new URL(o).host === req.headers.host; } catch (e) { return false; } };

  // ---- sessions (kept in admin.json as hashes)
  function readCookie(req) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return null;
  }
  function signedIn(req) {
    const t = readCookie(req);
    if (!t) return false;
    const a = readAdmin();
    return (a.sessions || []).some((s) => s.hash === sha(t) && Date.parse(s.expires_at) > Date.now());
  }
  function startSession(res, slug) {
    const t = crypto.randomBytes(32).toString('base64url');
    const a = readAdmin();
    a.sessions = (a.sessions || []).filter((s) => Date.parse(s.expires_at) > Date.now()).slice(-9);
    a.sessions.push({ hash: sha(t), expires_at: new Date(Date.now() + SESSION_MS).toISOString() });
    a.last_login_at = new Date().toISOString();
    writeAdmin(a);
    res.setHeader('Set-Cookie', `${COOKIE}=${t}; Path=/${slug}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`);
  }
  const form = express.urlencoded({ extended: false, limit: '4kb' });

  // ---- setup (one-time link)
  app.get('/:slug/setup', (req, res) => {
    const slug = slugOf(req); if (!slug) return notFound(req, res);
    const a = readAdmin();
    if (!a.setup_hash || Date.parse(a.setup_expires_at) < Date.now() || !eq(a.setup_hash, sha(req.query.t || ''))) return notFound(req, res);
    send(res, 200, 'Criar senha', `<form class=login method=post action="/${esc(slug)}/setup"><h1>Galáxia<span>Lunarium</span></h1><p class=mut>Crie a senha do painel administrativo (mínimo 12 caracteres).</p>
<input type=hidden name=t value="${esc(req.query.t)}"><input type=password name=pw minlength=12 maxlength=200 autocomplete=new-password placeholder="Nova senha" required><input type=password name=pw2 minlength=12 maxlength=200 autocomplete=new-password placeholder="Repita a senha" required><button>Salvar senha</button></form>`);
  });
  app.post('/:slug/setup', form, async (req, res) => {
    const slug = slugOf(req); if (!slug || !sameOrigin(req)) return notFound(req, res);
    const a = readAdmin();
    const b = req.body || {};
    if (!a.setup_hash || Date.parse(a.setup_expires_at) < Date.now() || !eq(a.setup_hash, sha(b.t || ''))) return notFound(req, res);
    const pw = String(b.pw || '');
    if (pw.length < 12 || pw.length > 200 || pw !== String(b.pw2 || '')) return send(res, 400, 'Criar senha', `<div class=login><p class=err>As senhas precisam ser iguais e ter pelo menos 12 caracteres.</p><a href="/${esc(slug)}/setup?t=${esc(b.t)}">Voltar</a></div>`);
    a.pass_salt = crypto.randomBytes(16).toString('hex');
    a.pass_hash = await scrypt(pw, a.pass_salt);
    delete a.setup_hash; delete a.setup_expires_at;
    a.sessions = [];
    writeAdmin(a);
    send(res, 200, 'Senha criada', `<div class=login><h1>Senha criada</h1><p class=mut>Agora entre com a senha. A cada entrada, um código chega no e-mail de administrador.</p><a class=btn href="/${esc(slug)}">Entrar</a></div>`);
  });

  // ---- sign in: password, then e-mailed code
  const loginForm = (slug, msg) => `<form class=login method=post action="/${esc(slug)}/login"><h1>Galáxia<span>Lunarium</span></h1>${msg ? `<p class=err>${esc(msg)}</p>` : ''}<input type=password name=pw autocomplete=current-password placeholder="Senha" required autofocus><button>Entrar</button></form>`;
  app.post('/:slug/login', form, async (req, res) => {
    const slug = slugOf(req); if (!slug || !sameOrigin(req)) return notFound(req, res);
    const a = readAdmin();
    if (!a.pass_hash) return notFound(req, res);
    if (tooMany('pw:' + ip(req), 5, 15 * 60 * 1000) || tooMany('pw:all', 20, 3600 * 1000)) return send(res, 429, 'Aguarde', loginForm(slug, 'Muitas tentativas. Tente de novo mais tarde.'));
    const h = await scrypt(String((req.body || {}).pw || ''), a.pass_salt);
    if (!eq(h, a.pass_hash)) { hit('pw:' + ip(req)); hit('pw:all'); return send(res, 401, 'Entrar', loginForm(slug, 'Senha incorreta.')); }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const pending = crypto.randomBytes(24).toString('base64url');
    a.code = { hash: sha(pending + ':' + code), pending: sha(pending), expires_at: new Date(Date.now() + CODE_MS).toISOString(), tries: 0 };
    writeAdmin(a);
    await mailer.send({
      to: mailer.adminRecipients(),
      subject: `Código de acesso ao painel: ${code}`,
      html: tpl.layout(tpl.p('Seu código de acesso ao painel administrativo:') + `<p style="font-size:30px;font-weight:bold;letter-spacing:6px;margin:10px 0 16px">${code}</p>` + tpl.small(`Vale 10 minutos. Pedido feito do IP ${ip(req)} em ${fmtDate(new Date())}. Se não foi você, troque a senha.`), 'Notificação interna do GaláxiaLunarium.', { lang: 'pt-BR' }),
      text: `Código de acesso ao painel: ${code} (vale 10 minutos).`,
    });
    send(res, 200, 'Código', `<form class=login method=post action="/${esc(slug)}/code"><h1>Galáxia<span>Lunarium</span></h1><p class=mut>Enviamos um código de 6 dígitos para o e-mail de administrador.</p><input type=hidden name=p value="${esc(pending)}"><input type=text name=code inputmode=numeric pattern="[0-9]{6}" maxlength=6 autocomplete=one-time-code placeholder="000000" required autofocus><button>Confirmar</button></form>`);
  });
  app.post('/:slug/code', form, (req, res) => {
    const slug = slugOf(req); if (!slug || !sameOrigin(req)) return notFound(req, res);
    const a = readAdmin();
    const b = req.body || {};
    const c = a.code;
    const fail = (msg) => send(res, 401, 'Entrar', loginForm(slug, msg));
    if (!c || Date.parse(c.expires_at) < Date.now() || !eq(c.pending, sha(b.p || ''))) return fail('Código expirado. Entre de novo.');
    if (!eq(c.hash, sha(String(b.p) + ':' + String(b.code || '').trim()))) {
      c.tries += 1;
      if (c.tries >= 5) delete a.code;
      writeAdmin(a);
      hit('pw:' + ip(req));
      return c.tries >= 5 ? fail('Muitas tentativas. Entre de novo.') : send(res, 401, 'Código', `<form class=login method=post action="/${esc(slug)}/code"><p class=err>Código incorreto.</p><input type=hidden name=p value="${esc(b.p)}"><input type=text name=code inputmode=numeric pattern="[0-9]{6}" maxlength=6 autocomplete=one-time-code required autofocus><button>Confirmar</button></form>`);
    }
    delete a.code;
    writeAdmin(a);
    startSession(res, slug);
    res.redirect(303, `/${slug}`);
  });
  app.post('/:slug/logout', form, (req, res) => {
    const slug = slugOf(req); if (!slug || !sameOrigin(req)) return notFound(req, res);
    const t = readCookie(req);
    const a = readAdmin();
    a.sessions = (a.sessions || []).filter((s) => s.hash !== sha(t || ''));
    writeAdmin(a);
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/${slug}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    res.redirect(303, `/${slug}`);
  });

  // ---- the panel
  app.get('/:slug', (req, res, next) => {
    const slug = slugOf(req); if (!slug) return next();
    const a = readAdmin();
    if (!a.pass_hash) return notFound(req, res);
    if (!signedIn(req)) return send(res, 200, 'Entrar', loginForm(slug));
    const tab = ['visao', 'usuarios', 'chaves', 'pedidos', 'listagens'].includes(req.query.tab) ? req.query.tab : 'visao';
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 100);
    send(res, 200, 'Painel', renderPanel(slug, tab, q));
  });

  function load() {
    const cfg = plans.loadConfig();
    const accounts = plans.readJson(ACCOUNTS_FILE, []);
    const keys = plans.readKeys();
    const orders = plans.readJson(ORDERS_FILE, []);
    const sessions = plans.readJson(SESSIONS_FILE, {});
    const listed = plans.readJson(LISTED_FILE, []);
    const outbox = plans.readJson(OUTBOX_FILE, []);
    const byAccount = new Map(accounts.map((x) => [x.id, x]));
    return { cfg, accounts, keys, orders, sessions, listed, outbox, byAccount };
  }
  const keyState = (k) => (!k.active ? (k.cancelled_by === 'customer' ? 'cancelada pelo cliente' : 'revogada') : (k.expires_at && Date.parse(k.expires_at) < Date.now() ? 'vencida' : (k.paused ? 'pausada' : 'ativa')));
  const statePill = (s) => `<span class="pill ${['ativa', 'paid', 'pago', 'listed', 'approved', 'listada', 'aprovada'].includes(s) ? 'ok' : ['revogada', 'cancelada pelo cliente', 'vencida', 'rejected', 'expired', 'expirado', 'recusada'].includes(s) ? 'bad' : 'warn'}">${esc(s)}</span>`;
  const match = (q, ...fields) => !q || fields.some((f) => String(f || '').toLowerCase().includes(q));

  function renderPanel(slug, tab, q) {
    const d = load();
    const now = Date.now();
    const monthStart = new Date(new Date().toISOString().slice(0, 7) + '-01T00:00:00Z').getTime();
    const paid = d.orders.filter((o) => o.status === 'paid');
    const sum = (list, f) => list.reduce((s, o) => s + (Number(o[f]) || 0), 0);
    const paidMonth = paid.filter((o) => Date.parse(o.paid_at) >= monthStart);
    const activeKeys = d.keys.filter((k) => keyState(k) === 'ativa');
    const keysByPlan = {};
    activeKeys.forEach((k) => { keysByPlan[k.plan] = (keysByPlan[k.plan] || 0) + 1; });
    const verified = d.accounts.filter((x) => x.email_verified !== false).length;
    const pendingListings = d.orders.filter((o) => o.kind === 'listing' && o.listing_status === 'under_review');
    const openOrders = d.orders.filter((o) => (o.status === 'pending' && Date.parse(o.expires_at) > now) || o.status === 'confirming');
    const activeSessions = Object.values(d.sessions).filter((s) => Date.parse(s.expires_at) > now).length;
    const tabs = [['visao', 'Visão geral'], ['usuarios', `Usuários (${d.accounts.length})`], ['chaves', `Chaves de API (${d.keys.length})`], ['pedidos', `Pedidos (${d.orders.length})`], ['listagens', `Listagens (${d.orders.filter((o) => o.kind === 'listing').length})`]];
    let body = `<div class=wrap><header><h1>Galáxia<span>Lunarium</span> · Administração</h1><form class=inline method=post action="/${esc(slug)}/logout"><button class=ghost>Sair</button></form></header>
<nav class=tabs>${tabs.map(([id, label]) => `<a href="/${esc(slug)}?tab=${id}" class="${id === tab ? 'on' : ''}">${esc(label)}</a>`).join('')}</nav>`;
    const searchBox = (placeholder) => `<form method=get action="/${esc(slug)}" style="margin-bottom:12px"><input type=hidden name=tab value="${esc(tab)}"><input type=search name=q value="${esc(q)}" placeholder="${esc(placeholder)}" style="width:min(420px,100%)"> <button class=ghost>Buscar</button></form>`;

    if (tab === 'visao') {
      body += `<div class=grid>
<div class=kpi><label>Usuários cadastrados</label><b>${nf(d.accounts.length)}</b><small>${nf(verified)} com e-mail confirmado · ${nf(d.accounts.length - verified)} aguardando</small></div>
<div class=kpi><label>Sessões abertas no site</label><b>${nf(activeSessions)}</b><small>contas logadas agora (até 30 dias)</small></div>
<div class=kpi><label>Chaves de API ativas</label><b>${nf(activeKeys.length)}</b><small>${Object.entries(keysByPlan).map(([p, n]) => `${esc(p)}: ${n}`).join(' · ') || 'nenhuma'}</small></div>
<div class=kpi><label>Recebido este mês</label><b>${nf(sum(paidMonth, 'paid_xln') || sum(paidMonth, 'amount_xln'))} XLN</b><small>≈ US$ ${nf(sum(paidMonth, 'price_usd'), 2)} · ${paidMonth.length} pagamento(s)</small></div>
<div class=kpi><label>Recebido no total</label><b>${nf(sum(paid, 'paid_xln') || sum(paid, 'amount_xln'))} XLN</b><small>≈ US$ ${nf(sum(paid, 'price_usd'), 2)} · ${paid.length} pagamento(s)</small></div>
<div class=kpi><label>Pedidos aguardando pagamento</label><b>${nf(openOrders.length)}</b><small>dentro do prazo de 60 min ou confirmando</small></div>
<div class=kpi><label>Listagens em análise</label><b>${nf(pendingListings.length)}</b><small>${nf(d.listed.length)} moeda(s) publicadas pela listagem</small></div>
<div class=kpi><label>E-mails com falha na fila</label><b class="${d.outbox.length ? 'warn' : ''}">${nf(d.outbox.length)}</b><small>reenvio automático a cada 10 min</small></div>
</div>`;
      const recent = d.orders.slice().sort((x, y) => String(y.created_at).localeCompare(String(x.created_at))).slice(0, 10);
      body += `<div class=card><h2>Últimos pedidos</h2>${ordersTable(recent, d)}</div>`;
      const newest = d.accounts.slice().sort((x, y) => String(y.created_at).localeCompare(String(x.created_at))).slice(0, 10);
      body += `<div class=card><h2>Últimos cadastros</h2>${usersTable(newest, d)}</div>`;
    } else if (tab === 'usuarios') {
      const list = d.accounts.filter((x) => match(q, x.name, x.email, x.company)).sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
      body += `<div class=card>${searchBox('Nome, e-mail ou empresa')}${usersTable(list, d)}</div>`;
    } else if (tab === 'chaves') {
      const list = d.keys.filter((k) => { const acc = d.byAccount.get(k.account_id); return match(q, k.prefix, k.plan, k.owner, acc && acc.email); })
        .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
      body += `<div class=card>${searchBox('Prefixo, plano, dono ou e-mail')}<div class=tw><table><tr><th>Chave</th><th>Plano</th><th>Situação</th><th>Conta</th><th>Dono / nota</th><th class=num>Uso no mês</th><th>Criada</th><th>Vence</th></tr>${list.map((k) => {
        const acc = d.byAccount.get(k.account_id);
        const plan = d.cfg.plans[k.plan] || {};
        const used = plans.getUsage(k.id);
        return `<tr><td><code>${esc(k.prefix)}…</code></td><td>${esc(plan.name || k.plan)}</td><td>${statePill(keyState(k))}</td><td>${acc ? esc(acc.email) : '<span class=mut>sem conta</span>'}</td><td>${esc(k.owner || '')}<div class=mut>${esc(k.note || '')}</div></td><td class=num>${nf(used)}${plan.per_month ? ' / ' + nf(plan.per_month) : ''}</td><td>${fmtDate(k.created_at)}</td><td>${k.expires_at ? fmtDate(k.expires_at) : (plan.lifetime ? 'vitalícia' : '—')}${plan.includes_audit ? `<div class=mut>auditoria: ${k.audit_order_id ? 'solicitada' : 'a solicitar'}</div>` : ''}</td></tr>`;
      }).join('') || '<tr><td colspan=8 class=mut>Nenhuma chave.</td></tr>'}</table></div></div>`;
    } else if (tab === 'pedidos') {
      const list = d.orders.filter((o) => match(q, o.ticket, o.id, o.product, o.customer && o.customer.email, o.customer && o.customer.name, o.txid))
        .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
      body += `<div class=card>${searchBox('Ticket, e-mail, nome, produto ou transação')}${ordersTable(list, d)}</div>`;
    } else {
      const list = d.orders.filter((o) => o.kind === 'listing' && match(q, o.ticket, o.listing && o.listing.name, o.listing && o.listing.symbol, o.customer && o.customer.email))
        .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
      const secret = require('./server-secret');
      body += `<div class=card>${searchBox('Ticket, moeda, símbolo ou e-mail')}<div class=tw><table><tr><th>Ticket</th><th>Pedido</th><th>Tipo</th><th>Situação</th><th>Cliente</th><th>Data</th><th></th></tr>${list.map((o) => `<tr><td>${esc(o.ticket || '—')}</td><td>${esc((o.listing && o.listing.name) || '')} ${o.listing && o.listing.symbol ? '(' + esc(o.listing.symbol) + ')' : ''}</td><td>${o.listing_type === 'exchange' ? 'Exchange' : 'Moeda'} · ${o.tier === 'standard' ? 'padrão' : 'prioritária'}</td><td>${statePill(({ under_review: 'em análise', approved: 'aprovada', listed: 'listada', rejected: 'recusada' })[o.listing_status] || o.listing_status || o.status)}</td><td>${esc(o.customer && o.customer.email || '')}</td><td>${fmtDate(o.created_at)}</td><td>${o.status === 'paid' || o.status === 'registered' ? `<a href="/admin/listing/${esc(o.id)}?t=${esc(secret.sign('listing', o.id))}">Revisar</a>` : ''}</td></tr>`).join('') || '<tr><td colspan=7 class=mut>Nenhuma solicitação.</td></tr>'}</table></div></div>`;
    }
    body += `<p class=mut style="font-size:12px">Somente leitura · dados de ${fmtDate(new Date())} · sessão de administrador expira em 12 h.</p></div>`;
    return body;
  }

  function usersTable(list, d) {
    return `<div class=tw><table><tr><th>Nome</th><th>E-mail</th><th>E-mail confirmado</th><th>Empresa</th><th>Idioma</th><th>Chaves (plano)</th><th class=num>Pedidos</th><th class=num>Favoritos</th><th class=num>Alertas</th><th>Cadastro</th><th>Último acesso</th></tr>${list.map((x) => {
      const keys = d.keys.filter((k) => k.account_id === x.id);
      const orders = d.orders.filter((o) => o.account_id === x.id);
      const favs = x.favorites ? (x.favorites.coins || []).length + (x.favorites.exchanges || []).length : 0;
      return `<tr><td>${esc(x.name)}</td><td>${esc(x.email)}</td><td>${x.email_verified === false ? '<span class="pill warn">aguardando</span>' : '<span class="pill ok">sim</span>'}</td><td>${esc(x.company || '')}</td><td>${esc(x.lang || '')}</td><td>${keys.map((k) => `${esc(k.plan)} ${statePill(keyState(k))}`).join('<br>') || '<span class=mut>—</span>'}</td><td class=num>${orders.length}</td><td class=num>${favs}</td><td class=num>${Object.keys(x.alerts || {}).length}</td><td>${fmtDate(x.created_at)}</td><td>${fmtDate(x.last_login_at)}</td></tr>`;
    }).join('') || '<tr><td colspan=11 class=mut>Nenhum usuário.</td></tr>'}</table></div>`;
  }
  function ordersTable(list, d) {
    const label = { pending: 'aguardando', confirming: 'confirmando', paid: 'pago', expired: 'expirado', registered: 'registrado' };
    return `<div class=tw><table><tr><th>Ticket</th><th>Produto</th><th>Situação</th><th>Cliente</th><th class=num>XLN</th><th class=num>US$</th><th>Transação</th><th>Criado</th><th>Pago</th></tr>${list.map((o) => {
      const st = o.status === 'pending' && Date.parse(o.expires_at) < Date.now() ? 'expired' : o.status;
      const product = o.kind === 'listing' ? `Listagem ${o.listing_type === 'exchange' ? 'exchange' : 'moeda'} (${o.tier === 'standard' ? 'padrão' : 'prioritária'})` : `API ${o.plan}${o.change_from ? ` (de ${o.change_from})` : o.renew_key_id ? ' (renovação)' : ''}`;
      return `<tr><td>${esc(o.ticket || '—')}<div class=mut>${esc(o.id)}</div></td><td>${esc(product)}</td><td>${statePill(label[st] || st)}</td><td>${esc(o.customer && o.customer.name || '')}<div class=mut>${esc(o.customer && o.customer.email || '')}</div></td><td class=num>${o.included_in_plan ? 'no plano' : o.free ? 'grátis' : nf(o.paid_xln || o.amount_xln, 4)}</td><td class=num>${nf(o.price_usd, 2)}</td><td>${o.txid ? `<a href="https://explorerxln.com/tx/${esc(o.txid)}" target=_blank rel=noopener>${esc(o.txid.slice(0, 10))}…</a>` : '—'}</td><td>${fmtDate(o.created_at)}</td><td>${fmtDate(o.paid_at)}</td></tr>`;
    }).join('') || '<tr><td colspan=9 class=mut>Nenhum pedido.</td></tr>'}</table></div>`;
  }
};
module.exports.sendSetupLink = sendSetupLink;
module.exports.ensureSlug = ensureSlug;
