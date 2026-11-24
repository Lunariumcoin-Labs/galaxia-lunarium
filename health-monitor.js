// Watches what the audited coins and the site depend on, and e-mails the owner (the admin recipients
// of data/mail.json) when something goes wrong -- and again when it is back. Owner's request
// (2026-10-14), after the HTTPS certificate of explorerxln.com expired and the XLN audit stopped
// without anyone being told.
//
// Every 5 minutes: the network and audit readings of the audited coins, and XLN's price. A check has
// to fail twice in a row (10 minutes) before the e-mail, so a short hiccup does not alarm anyone; while
// it stays broken a reminder goes once a day. An audit reading outside its rule is reported the same
// way. Every 6 hours: the HTTPS certificates of the Lunarium sites -- an alert when one has expired or
// cannot be verified, and a warning 14, 7, 3 and 1 days before it expires. Every hour: the PHP version
// served by the Lunarium PHP sites (e-mail when the hosting moves them to, or away from, a fixed release).
//
// The hosting runs more than one app process: one run at a time (a lock file), and the incidents live
// in data/health-monitor.json, so no e-mail is sent twice.
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const plans = require('./api-plans');
const mailer = require('./mailer');
const tpl = require('./email-template');

const STATE_FILE = path.join(plans.DATA_DIR, 'health-monitor.json');
const LOCK_FILE = path.join(plans.DATA_DIR, 'health-monitor.lock');
const EVERY_MS = 5 * 60 * 1000;
const CERT_EVERY_MS = 6 * 3600 * 1000;
const REMIND_MS = 24 * 3600 * 1000;
const AUDIT_MAX_AGE_MS = 2 * 3600 * 1000;
const CERT_WARN_DAYS = [14, 7, 3, 1];
const SITE = tpl.SITE;

const CHECKS = [
  { id: 'net-xln', name: 'Rede da XLN (explorerxln.com)', route: '/api/network/xln', kind: 'network', page: SITE + '/?coin=xln' },
  { id: 'audit-xln', name: 'Auditoria da XLN', route: '/api/network/xln-audit', kind: 'audit', page: SITE + '/?view=auditoria&audit=xln' },
  { id: 'price-xln', name: 'Preço da XLN', route: '/api/v1/coins/xln', kind: 'price', page: SITE + '/?coin=xln' },
  { id: 'net-pivx', name: 'Rede da PIVX', route: '/api/network/pivx', kind: 'network', page: SITE + '/?coin=pivx' },
  { id: 'audit-pivx', name: 'Auditoria da PIVX', route: '/api/network/pivx-audit', kind: 'audit', page: SITE + '/?view=auditoria&audit=pivx' },
  { id: 'net-mon', name: 'Rede da MON', route: '/api/network/mon', kind: 'network', page: SITE + '/?coin=mon' },
  { id: 'audit-mon', name: 'Auditoria da MON', route: '/api/network/mon-audit', kind: 'audit', page: SITE + '/?view=auditoria&audit=mon' },
  { id: 'net-ns', name: 'Rede da NS (explorer.nodestats.info)', route: '/api/network/ns', kind: 'network', page: SITE + '/?coin=ns' },
  { id: 'audit-ns', name: 'Auditoria da NS (explorer.nodestats.info + coinexplorer.net)', route: '/api/network/ns-audit', kind: 'audit', page: SITE + '/?view=auditoria&audit=ns' },
  { id: 'audit-btc', name: 'Auditoria do Bitcoin', route: '/api/network/btc-audit', kind: 'audit', page: SITE + '/?view=auditoria&audit=btc' },
  { id: 'audit-sol', name: 'Auditoria da Solana', route: '/api/network/sol-audit', kind: 'audit', page: SITE + '/?view=auditoria&audit=sol' },
  { id: 'audit-ltc', name: 'Auditoria do Litecoin (blockchair.com)', route: '/api/network/ltc-audit', kind: 'audit', page: SITE + '/?view=auditoria&audit=ltc-coin' },
  { id: 'audit-doge', name: 'Auditoria do Dogecoin (blockchair.com)', route: '/api/network/doge-audit', kind: 'audit', page: SITE + '/?view=auditoria&audit=doge-coin' },
  { id: 'audit-bch', name: 'Auditoria do Bitcoin Cash (blockchair.com + nó rest.bch.actorforth.org)', route: '/api/network/bch-audit', kind: 'audit', page: SITE + '/?view=auditoria&audit=bch' },
  { id: 'audit-dash', name: 'Auditoria do Dash (chainz.cryptoid.info + blockchair.com)', route: '/api/network/dash-audit', kind: 'audit', page: SITE + '/?view=auditoria&audit=dash' },
  { id: 'audit-eth', name: 'Auditoria do Ethereum (ultrasound.money + nós ethereum-rpc / beacon publicnode)', route: '/api/network/eth-audit', kind: 'audit', page: SITE + '/?view=auditoria&audit=eth-coin' },
  { id: 'audit-bnb', name: 'Auditoria do BNB (bnbburn.info + nós bsc-dataseed da BNB Chain)', route: '/api/network/bnb-audit', kind: 'audit', page: SITE + '/?view=auditoria&audit=bnb' },
  { id: 'net-xlnft', name: 'Token XLNFT (BNB Chain)', route: '/api/network/xlnft', kind: 'network', page: SITE + '/?coin=xlnft' },
  { id: 'audit-xlnft', name: 'Auditoria do token XLNFT (BNB Chain)', route: '/api/network/xlnft-audit', kind: 'audit', page: SITE + '/?view=auditoria&audit=xlnft' },
];
const CERT_HOSTS = ['explorerxln.com', 'galaxia.lunariumcoin.com', 'lunariumcoin.com', 'lunariumtrade.io', 'xln-swap-xlnft.explorerxln.com'];
// PHP version served by the Lunarium sites that run on PHP (Hostinger manages the PHP binaries). Owner's
// request (2026-10-21), after the PHP advisory of CVE-2026-109618 / CVE-2026-109619 (remote code execution):
// an e-mail when the hosting moves a site to a fixed release, and an alert if it ever falls back. Read from
// the X-Powered-By header, every hour. The first reading is only recorded (the owner already knows).
const PHP_EVERY_MS = 3600 * 1000;
const PHP_SITES = [
  { id: 'lunariumcoin', name: 'lunariumcoin.com (hospedagem de masternodes, API do APK, bot do Discord)', url: 'https://lunariumcoin.com/host-lab/' },
  { id: 'lunariumtrade', name: 'LunariumTrade (lunariumtrade.io)', url: 'https://lunariumtrade.io/' },
];
// first fixed release of each supported branch; older branches get no fix from the PHP project
const PHP_FIXED = { '8.5': 12, '8.4': 27, '8.3': 36, '8.2': 35 };
const PHP_CVES = 'CVE-2026-109618 e CVE-2026-109619';
function phpFixed(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const fixedPatch = PHP_FIXED[`${major}.${minor}`];
  if (fixedPatch != null) return patch >= fixedPatch;
  // a branch newer than 8.5 came after the fix; 8.1 and older get no fix
  return major > 8 || (major === 8 && minor > 5);
}
async function phpVersion(url) {
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'GalaxiaLunarium health monitor' } });
    const m = String(r.headers.get('x-powered-by') || '').match(/PHP\/([0-9][0-9.]*)/i);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

const readState = () => plans.readJson(STATE_FILE, { checks: {}, certs: {}, certs_at: 0, php: {}, php_at: 0 });
const writeState = (s) => { try { plans.writeJsonAtomic(STATE_FILE, s); } catch (e) { console.error('health monitor: could not save', e && e.message); } };

// one process at a time; a lock older than 4 minutes belongs to a run that died
function takeLock() {
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
    return true;
  } catch (e) {
    try {
      if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > 4 * 60 * 1000) { fs.writeFileSync(LOCK_FILE, String(process.pid)); return true; }
    } catch (err) { /* gone meanwhile */ }
    return false;
  }
}
const dropLock = () => { try { fs.unlinkSync(LOCK_FILE); } catch (e) { /* already gone */ } };

const fmt = (t) => new Date(t).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });

// { ok, problem, detail } for one check
async function evaluate(check, callRoute) {
  let d;
  try { d = await callRoute(check.route, {}); } catch (e) { return { ok: false, problem: 'não responde', detail: String((e && e.message) || e) }; }
  if (!d || d.ok === false) return { ok: false, problem: check.kind === 'audit' ? 'sem leitura' : 'fonte de dados fora do ar', detail: String((d && d.error) || 'sem resposta') };
  if (check.kind === 'audit') {
    const r = d.reading || {};
    const age = Date.now() - Date.parse(r.ts || '');
    if (!(age >= 0) || age > AUDIT_MAX_AGE_MS) return { ok: false, problem: 'leitura parada', detail: 'última leitura em ' + (r.ts ? fmt(r.ts) : '—') };
    if (r.withinRule === false) return { ok: false, problem: 'divergência detectada', detail: 'a leitura de ' + fmt(r.ts) + ' está fora da regra do código oficial (desvio ' + r.deviation + ')', divergence: true };
  }
  if (check.kind === 'price') {
    const x = d.data || {};
    if (!(x.price_usd > 0)) return { ok: false, problem: 'sem preço', detail: 'nenhum mercado ao vivo: ' + ((x.markets || []).map((m) => m.exchange + ' ' + m.pair + ' ' + m.status).join(', ') || '—') };
  }
  return { ok: true };
}

// the HTTPS certificate of a host: { ok, expired, days, valid_to, error }
function certificate(host) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: 15000 }, () => {
      const c = socket.getPeerCertificate();
      const validTo = c && c.valid_to ? Date.parse(c.valid_to) : NaN;
      const days = validTo > 0 ? Math.floor((validTo - Date.now()) / 86400000) : null;
      resolve({ ok: socket.authorized && days != null && days >= 0, expired: validTo > 0 && validTo < Date.now(), days, valid_to: validTo > 0 ? new Date(validTo).toISOString() : null, error: socket.authorized ? null : String(socket.authorizationError || 'não verificado') });
      socket.end();
    });
    socket.on('timeout', () => { socket.destroy(); resolve({ ok: false, error: 'tempo esgotado' }); });
    socket.on('error', (e) => resolve({ ok: false, error: String((e && e.message) || e) }));
  });
}

function mail(subject, intro, rows, page, tone) {
  const color = tone === 'ok' ? '#2fbf71' : tone === 'warn' ? '#d29922' : '#e5484d';
  const table = '<table style="border-collapse:collapse;font-size:14px;margin:6px 0 4px">' + rows.filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<tr><td style="padding:3px 12px 3px 0;color:#6b7090;white-space:nowrap;vertical-align:top">${tpl.esc(k)}</td><td style="padding:3px 0;word-break:break-word">${tpl.esc(v)}</td></tr>`).join('') + '</table>';
  const html = tpl.layout(`<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${color};font-weight:bold">${tpl.esc(intro)}</p>` + table + (page ? tpl.button(page, 'Abrir no GaláxiaLunarium') : ''),
    'Alerta automático do GaláxiaLunarium (monitor do servidor).', { lang: 'pt-BR', preheader: subject });
  const text = [intro, ...rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${v}`), page || ''].join('\n');
  return mailer.send({ to: mailer.adminRecipients(), subject, html, text }).catch((e) => { console.error('health monitor: e-mail failed', e && e.message); return false; });
}

module.exports = function mountHealthMonitor(app, { callRoute }) {
  async function run() {
    if (!takeLock()) return;
    try {
      const state = readState();
      const now = Date.now();
      for (const check of CHECKS) {
        const r = await evaluate(check, callRoute);
        const s = state.checks[check.id] || (state.checks[check.id] = { fails: 0 });
        if (r.ok) {
          if (s.notified_at) {
            await mail(`[Resolvido] ${check.name} voltou ao normal`, `${check.name} voltou a funcionar.`,
              [['Problema', s.problem], ['Desde', s.since ? fmt(s.since) : null], ['Resolvido em', fmt(now)]], check.page, 'ok');
            console.log(`health monitor: ${check.id} recovered`);
          }
          state.checks[check.id] = { fails: 0, last_ok: now };
          continue;
        }
        s.fails = (s.fails || 0) + 1;
        if (!s.since) s.since = now;
        s.problem = r.problem;
        s.detail = r.detail;
        const due = s.fails >= 2 && (!s.notified_at || now - s.notified_at >= REMIND_MS);
        if (due) {
          const again = !!s.notified_at;
          await mail(`[${r.divergence ? 'Divergência' : 'Alerta'}] ${check.name}: ${r.problem}${again ? ' (continua)' : ''}`,
            `${check.name}: ${r.problem}.${again ? ' O problema continua.' : ''}`,
            [['O que aconteceu', r.problem], ['Detalhe', r.detail], ['Desde', fmt(s.since)], ['Verificação', check.route],
              ['O que fica afetado', check.kind === 'audit' ? 'a auditoria desta moeda no site' : check.kind === 'price' ? 'o preço da moeda no site e na API' : 'os dados de rede desta moeda (bloco, supply, masternodes) no site e na auditoria']],
            check.page, r.divergence ? 'bad' : 'bad');
          s.notified_at = now;
          console.log(`health monitor: ${check.id} alert sent (${r.problem})`);
        }
      }
      // HTTPS certificates, every 6 hours
      if (now - (state.certs_at || 0) >= CERT_EVERY_MS) {
        state.certs_at = now;
        for (const host of CERT_HOSTS) {
          const c = await certificate(host);
          const s = state.certs[host] || (state.certs[host] = {});
          const page = 'https://' + host + '/';
          if (!c.ok && (c.expired || c.error)) {
            if (!s.notified_at || now - s.notified_at >= REMIND_MS) {
              await mail(`[Alerta] Certificado HTTPS de ${host} ${c.expired ? 'expirou' : 'com problema'}`,
                `O certificado HTTPS de ${host} ${c.expired ? 'expirou' : 'não pôde ser verificado'}: navegadores e o GaláxiaLunarium não conseguem acessar o site com segurança.`,
                [['Domínio', host], ['Válido até', c.valid_to ? fmt(c.valid_to) : '—'], ['Erro', c.error], ['O que fazer', 'renovar o certificado HTTPS no servidor desse domínio']], page, 'bad');
              s.notified_at = now;
            }
            s.broken = true;
            continue;
          }
          if (s.broken) {
            await mail(`[Resolvido] Certificado HTTPS de ${host} renovado`, `O certificado HTTPS de ${host} está válido de novo.`,
              [['Válido até', c.valid_to ? fmt(c.valid_to) : '—']], page, 'ok');
            state.certs[host] = {};
            continue;
          }
          // warnings before it expires: once per threshold
          const step = CERT_WARN_DAYS.filter((d) => c.days != null && c.days <= d).pop();
          if (step != null && s.warned_days !== step) {
            await mail(`[Aviso] Certificado HTTPS de ${host} vence em ${c.days} dia(s)`, `O certificado HTTPS de ${host} vence em ${c.days} dia(s). Renove antes para o site não sair do ar.`,
              [['Domínio', host], ['Válido até', fmt(c.valid_to)]], page, 'warn');
            s.warned_days = step;
          } else if (step == null && s.warned_days) delete s.warned_days;
        }
      }
      // PHP version of the Lunarium PHP sites, every hour
      if (now - (state.php_at || 0) >= PHP_EVERY_MS) {
        state.php_at = now;
        state.php = state.php || {};
        for (const site of PHP_SITES) {
          const v = await phpVersion(site.url);
          if (!v) continue; // no reading this time: nothing changes
          const fixed = phpFixed(v);
          const prev = state.php[site.id];
          state.php[site.id] = { version: v, fixed, checked_at: now, since: prev && prev.fixed === fixed ? prev.since : now };
          if (!prev || prev.fixed === fixed) continue;
          if (fixed) {
            await mail(`[Resolvido] PHP atualizado em ${site.name}`, `A hospedagem atualizou o PHP de ${site.name} para a versão ${v}, que corrige as falhas ${PHP_CVES}.`,
              [['Versão anterior', prev.version], ['Versão agora', v], ['Verificado em', fmt(now)], ['Endereço', site.url]], site.url, 'ok');
          } else {
            await mail(`[Alerta] PHP vulnerável em ${site.name}`, `${site.name} está rodando PHP ${v}, versão sem a correção das falhas ${PHP_CVES} (execução remota de código).`,
              [['Versão anterior', prev.version], ['Versão agora', v], ['Versões corrigidas', '8.5.12, 8.4.27, 8.3.36 ou 8.2.35 (ou mais novas)'], ['O que fazer', 'pedir à hospedagem a atualização do PHP']], site.url, 'bad');
          }
          console.log(`health monitor: php ${site.id} ${prev.version} -> ${v} (fixed=${fixed})`);
        }
      }
      writeState(state);
    } catch (e) {
      console.error('health monitor failed', e && e.message);
    } finally {
      dropLock();
    }
  }
  setTimeout(() => { run().catch(() => {}); }, 2 * 60 * 1000).unref();
  setInterval(() => { run().catch(() => {}); }, EVERY_MS).unref();
  return { run };
};
