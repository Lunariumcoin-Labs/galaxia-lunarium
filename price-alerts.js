// E-mail price alerts for favorite coins (set in "Minha conta"). Every 5 minutes each exchange where
// the coin trades is compared with that exchange's own reference price (taken when the alert was
// saved): a rise of `up`% or a fall of `down`% there sends one e-mail (in the account's language)
// naming the exchange, and its current price becomes the new reference, so the next e-mail needs a
// new move of the same size. At most one e-mail per coin and exchange every 30 min.
const fs = require('fs');
const path = require('path');
const plans = require('./api-plans');
const mailer = require('./mailer');
const tpl = require('./email-template');
const STR = require('./alert-emails-i18n');
const ORDER_STR = require('./emails-i18n');

const ACCOUNTS_FILE = path.join(plans.DATA_DIR, 'accounts.json');
const CHECK_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 30 * 60 * 1000;
// the hosting may run two processes of the site: only the one holding this file checks (and sends)
const LOCK_FILE = path.join(plans.DATA_DIR, 'price-alerts.lock');
const LOCK_STALE_MS = 10 * 60 * 1000; // a process that died while holding it
function takeLock() {
  const mine = JSON.stringify({ pid: process.pid, at: Date.now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(LOCK_FILE, mine, { flag: 'wx' }); return mine; } catch (e) {
      if (e.code !== 'EEXIST') return null;
      let held = null;
      try { held = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch (e2) { /* being written or gone */ }
      if (held && Date.now() - held.at < LOCK_STALE_MS) return null;
      try { fs.unlinkSync(LOCK_FILE); } catch (e3) { /* the other process removed it */ }
    }
  }
  return null;
}
function dropLock(mine) {
  try { if (fs.readFileSync(LOCK_FILE, 'utf8') === mine) fs.unlinkSync(LOCK_FILE); } catch (e) { /* already gone */ }
}

const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? v[k] : m));
function fmtUsd(v) {
  const a = Math.abs(v);
  return a >= 1 ? v.toLocaleString('en-US', { maximumFractionDigits: 4 }) : v.toLocaleString('en-US', { maximumSignificantDigits: 4 });
}
const signed = (pct) => (pct >= 0 ? '+' : '') + pct.toFixed(2);

// hits: [{ exchange, pair, from, to, pct }] -- every exchange that crossed the alert in this check.
// The subject and the headline are the largest move; every exchange is listed below it.
// lang: the language of the page where the alert was saved; older alerts use the account's language
function alertMail(a, coin, hits, alertLang) {
  const lang = STR[alertLang] ? alertLang : (STR[a.lang] ? a.lang : 'pt-BR');
  const S = STR[lang];
  const O = ORDER_STR[lang] || ORDER_STR.en;
  const name = coin.name || coin.symbol;
  const top = hits.slice().sort((x, y) => Math.abs(y.pct) - Math.abs(x.pct))[0];
  const where = top.exchange ? `${name} · ${top.exchange}` : name;
  const v = { coin: where, pct: signed(top.pct), from: fmtUsd(top.from), to: fmtUsd(top.to) };
  const subject = fill(S[top.pct >= 0 ? 0 : 1], Object.assign({}, v, { pct: Math.abs(top.pct).toFixed(2) }));
  const link = `${tpl.SITE}/?coin=${encodeURIComponent(coin.id)}&lang=${encodeURIComponent(lang)}`;
  const color = (pct) => (pct >= 0 ? '#12a660' : '#d93a3a');
  const big = `<p style="margin:6px 0 16px;font-size:26px;font-weight:bold;color:${color(top.pct)}">${tpl.esc(v.pct)}% · US$ ${tpl.esc(v.to)}</p>`;
  const line = (h) => `${h.exchange}${h.pair ? ' ' + h.pair : ''}: ${signed(h.pct)}% · US$ ${fmtUsd(h.from)} → US$ ${fmtUsd(h.to)}`;
  const rows = hits.filter((h) => h.exchange).map((h) =>
    `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">${tpl.esc(h.exchange)}</td><td style="padding:4px 12px 4px 0;color:#6b7090">${tpl.esc(h.pair || '')}</td>` +
    `<td style="padding:4px 12px 4px 0;font-weight:bold;color:${color(h.pct)}">${tpl.esc(signed(h.pct))}%</td><td style="padding:4px 0">US$ ${tpl.esc(fmtUsd(h.from))} → US$ ${tpl.esc(fmtUsd(h.to))}</td></tr>`).join('');
  const table = rows ? `<table style="border-collapse:collapse;font-size:14px;margin:0 0 16px">${rows}</table>` : '';
  const btn = { coin: name };
  const html = tpl.layout(tpl.p(O[25].replace('{name}', a.name)) + big + tpl.p(fill(S[2], v)) + table + tpl.button(link, fill(S[3], btn)) + tpl.small(fill(S[5], v)) + tpl.small(fill(S[4], btn)), O[18], { lang, preheader: subject });
  const text = [O[25].replace('{name}', a.name), fill(S[2], v), hits.filter((h) => h.exchange).map(line).join('\n'), `${fill(S[3], btn)}: ${link}`, fill(S[5], v), fill(S[4], btn), O[18]].filter(Boolean).join('\n\n');
  return mailer.send({ to: a.email, subject, html, text });
}

module.exports = function mountPriceAlerts(app) {
  let running = false;
  async function check() {
    if (running || !app.locals.getPricedCoins) return;
    const lock = takeLock();
    if (!lock) return; // the other process is checking right now
    running = true;
    try {
      const list = plans.readJson(ACCOUNTS_FILE, []);
      if (!list.some((a) => a.alerts && Object.keys(a.alerts).length)) return;
      const coins = await app.locals.getPricedCoins();
      const now = Date.now();
      const work = [];
      list.forEach((a) => {
        if (a.email_verified === false || !a.alerts) return;
        Object.entries(a.alerts).forEach(([id, al]) => {
          const coin = coins[id];
          if (!coin) return;
          const hits = [];
          const init = {};
          (coin.markets || []).forEach((m) => {
            if (!(m.price_usd > 0)) return;
            let base = al.bases && al.bases[m.key];
            if (!(base > 0)) {
              // exchange not followed yet (alert saved before the per-exchange references, or a new
              // market): the exchange that set the saved price keeps it, the others start from now
              base = !al.bases && m.exchange === coin.price_source && al.base > 0 ? al.base : m.price_usd;
              init[m.key] = base;
            }
            const last = al.sent && al.sent[m.key];
            if (last && now - Date.parse(last) < COOLDOWN_MS) return;
            const pct = ((m.price_usd - base) / base) * 100;
            if ((al.up != null && pct >= al.up) || (al.down != null && pct <= -al.down)) hits.push({ key: m.key, exchange: m.exchange, pair: m.pair, from: base, to: m.price_usd, pct });
          });
          if (hits.length || Object.keys(init).length) work.push({ accountId: a.id, id, coin, hits, init });
        });
      });
      if (!work.length) return;
      // record first (fresh read, so a change made meanwhile in the panel is kept), then send
      const fresh = plans.readJson(ACCOUNTS_FILE, []);
      const sent = [];
      work.forEach((w) => {
        const a = fresh.find((x) => x.id === w.accountId);
        const al = a && a.alerts && a.alerts[w.id];
        if (!al) return;
        al.bases = Object.assign({}, w.init, al.bases || {});
        // a hit the other process recorded meanwhile (inside the cooldown) is not sent again
        const hits = w.hits.filter((h) => !(al.sent && al.sent[h.key] && now - Date.parse(al.sent[h.key]) < COOLDOWN_MS));
        if (!hits.length) return;
        w.hits = hits;
        const at = new Date(now).toISOString();
        al.sent = al.sent || {};
        w.hits.forEach((h) => { al.bases[h.key] = h.to; al.sent[h.key] = at; });
        if (w.coin.price_usd > 0) al.base = w.coin.price_usd;
        al.base_at = at;
        al.last_sent_at = at;
        sent.push({ a, w, lang: al.lang });
      });
      plans.writeJsonAtomic(ACCOUNTS_FILE, fresh);
      for (const { a, w, lang } of sent) {
        await alertMail(a, w.coin, w.hits, lang);
        console.log(`price alert ${w.id} ${w.hits.map((h) => `${h.exchange} ${h.pct.toFixed(2)}%`).join(', ')} -> account ${a.id}`);
      }
    } catch (e) {
      console.error('price alerts failed', e && e.message);
    } finally {
      running = false;
      dropLock(lock);
    }
  }
  setInterval(check, CHECK_MS).unref();
  setTimeout(check, 60 * 1000).unref();
  return check;
};
module.exports.alertMail = alertMail;
