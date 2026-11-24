// Masternode collateral of every coin in the "Coins masternode" tab, taken from each coin's
// official source code (masternode-collateral.json: repository, file, the pattern that reads the
// figure there and the value read when it was last verified).
//
// Three kinds of rule exist in the coins' code:
//  - tiers:     one fixed amount, or one per masternode class (Regular / Evo, Cumulus / Nimbus...);
//  - schedule:  the amount depends on the block height (XLN, Nodestats, Yerbas, FSOCIETY), so the
//               current one is worked out from the coin's current height and changes by itself;
//  - fxtc:      Fixed Trade Coin's formula, which moves a little at every block.
//
// The code is read again once a day from the coin's repository. When the figure there changes, the
// new one replaces the old one on the site (kept in data/masternode-collateral.json) and the admin
// is told by e-mail. If the file can no longer be read the way it was (the code was reorganised),
// the last verified value stays and the admin is told to check it.
const fs = require('fs');
const path = require('path');
const mailer = require('./mailer');
const coinSupply = require('./coin-supply');

const REGISTRY = require('./masternode-collateral.json').coins;
const LIVE_FILE = path.join(__dirname, 'data', 'masternode-collateral.json');
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const GAP_MS = 4000;
const HEIGHT_TTL_MS = 10 * 60 * 1000;

let live = { values: {}, checked: {}, failed: {}, changes: [] };
try { live = Object.assign(live, JSON.parse(fs.readFileSync(LIVE_FILE, 'utf8'))); } catch (e) { /* first run */ }

function save() {
  try {
    const tmp = LIVE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(live, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, LIVE_FILE);
  } catch (e) { console.error('masternode collateral: could not save', e && e.message); }
}

const round2 = (n) => Math.round(n * 100) / 100;

// ---- reading the figure in the source file
function captures(text, pattern, take) {
  const re = new RegExp(pattern, 'gm');
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    out.push(m.slice(1));
    if (take && out.length >= take) break;
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  return out;
}

function extract(spec, source) {
  // commented-out lines are not rules
  let text = String(source).replace(/^\s*\/\/.*$/gm, '');
  if (spec.section) {
    const a = text.indexOf(spec.section);
    if (a < 0) throw new Error('section not found');
    const b = text.indexOf(spec.section_end || '\n}', a);
    text = text.slice(a, b < 0 ? undefined : b);
  }
  const positive = (v) => { const n = Number(v); if (!(n > 0) || !Number.isFinite(n)) throw new Error('not an amount: ' + v); return n; };
  if (spec.rule === 'tiers') {
    const m = captures(text, spec.pattern, spec.names.length);
    if (m.length !== spec.names.length) throw new Error(`expected ${spec.names.length} amounts, found ${m.length}`);
    return { tiers: m.map((c, i) => ({ name: spec.names[i], amount: round2(positive(c[0]) + (spec.add || 0)) })) };
  }
  if (spec.rule === 'schedule_gt' || spec.rule === 'schedule_le') {
    const m = captures(text, spec.pattern);
    if (!m.length) throw new Error('no schedule found');
    const schedule = m.map((c) => [c[0] === 'INT_MAX' ? null : Number(c[0]), positive(c[1])]);
    if (schedule.some((p) => p[0] !== null && !(p[0] >= 0))) throw new Error('bad height in schedule');
    if (spec.rule === 'schedule_gt') schedule.sort((x, y) => x[0] - y[0]);
    else if (schedule[schedule.length - 1][0] !== null) throw new Error('schedule has no last step');
    return { schedule };
  }
  if (spec.rule === 'fxtc') {
    const one = (p) => { const m = captures(text, p, 1); if (!m.length) throw new Error('parameter not found'); return m[0]; };
    const period = one(spec.patterns.period);
    return { min: positive(one(spec.patterns.min)[0]), max: positive(one(spec.patterns.max)[0]), period: positive(period[0]) * positive(period[1]) };
  }
  throw new Error('unknown rule');
}

// ---- current height of the coins whose collateral depends on it
let callRouteRef = null;
const heights = {};
async function heightOf(symbol, spec) {
  if (spec.height === 'supply') return coinSupply.height(symbol);
  if (spec.height && spec.height.route) {
    const hit = heights[symbol];
    if (hit && Date.now() - hit.at < HEIGHT_TTL_MS) return hit.height;
    try {
      const d = await callRouteRef(spec.height.route, {});
      const h = Number(d && d[spec.height.field]);
      if (h > 0) { heights[symbol] = { at: Date.now(), height: h }; return h; }
    } catch (e) { /* keep the previous reading */ }
    return hit ? hit.height : null;
  }
  return null;
}

// ---- what a masternode needs now
async function current(symbol) {
  const spec = REGISTRY[symbol];
  if (!spec) return null;
  const value = live.values[symbol] || spec.value;
  const out = {
    symbol, amount: null, approx: false, tiers: [], next: null, height: null,
    source: 'github.com/' + spec.repo, file: spec.file,
    checked_at: live.checked[symbol] ? new Date(live.checked[symbol]).toISOString() : spec.verified_at || null,
  };
  if (!value) return out;
  if (spec.rule === 'tiers') {
    // classes the project documents but the code does not check yet (extra_tiers) come after the enforced ones
    out.tiers = value.tiers.concat((spec.extra_tiers || []).map((t) => ({ name: t.name, amount: t.amount })));
    out.amount = Math.min(...value.tiers.map((t) => t.amount));
    return out;
  }
  const h = await heightOf(symbol, spec);
  out.height = h;
  if (!(h > 0)) return out;
  if (spec.rule === 'schedule_gt') {
    // amount of the highest step the chain is already past; the next step starts one block after its height
    const past = value.schedule.filter((p) => h > p[0]);
    const ahead = value.schedule.filter((p) => !(h > p[0]));
    if (past.length) out.amount = past[past.length - 1][1];
    if (ahead.length) out.next = { height: ahead[0][0] + 1, amount: ahead[0][1] };
  } else if (spec.rule === 'schedule_le') {
    const i = value.schedule.findIndex((p) => p[0] === null || h <= p[0]);
    if (i >= 0) {
      out.amount = value.schedule[i][1];
      if (value.schedule[i][0] !== null && value.schedule[i + 1]) out.next = { height: value.schedule[i][0] + 1, amount: value.schedule[i + 1][1] };
    }
  } else if (spec.rule === 'fxtc') {
    const scaled = 100 * value.period;
    out.amount = round2(value.max - (value.max - value.min) * (scaled / (h + scaled)));
    out.approx = true;
  }
  if (out.amount != null) out.tiers = [{ name: null, amount: out.amount }];
  return out;
}

// ---- daily check of the source code
async function getSource(spec) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${spec.repo}/HEAD/${spec.file}`, { signal: controller.signal });
    if (!r.ok) throw new Error('status ' + r.status);
    return await r.text();
  } finally { clearTimeout(timer); }
}

function describe(spec, value) {
  if (!value) return '—';
  if (value.tiers) return value.tiers.map((t) => (t.name ? t.name + ' ' : '') + t.amount.toLocaleString('en-US')).join(' / ');
  if (value.schedule) return value.schedule.map((p) => `${p[0] === null ? 'depois' : (spec.rule === 'schedule_gt' ? 'bloco > ' : 'até o bloco ') + p[0].toLocaleString('en-US')}: ${p[1].toLocaleString('en-US')}`).join('; ');
  return `mínimo ${value.min}, máximo ${value.max}, período ${value.period}`;
}

function tell(subject, lines) {
  const html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">' + lines.map((l) => `<p>${l}</p>`).join('') + '</div>';
  return mailer.send({ to: mailer.adminRecipients(), subject, html, text: lines.join('\n').replace(/<[^>]+>/g, '') }).catch((e) => console.error('masternode collateral: mail failed', e && e.message));
}

async function check(symbol) {
  const spec = REGISTRY[symbol];
  if (!spec || !spec.rule) return;
  const link = `https://github.com/${spec.repo}/blob/HEAD/${spec.file}`;
  try {
    const found = extract(spec, await getSource(spec));
    const known = live.values[symbol] || spec.value;
    live.checked[symbol] = Date.now();
    delete live.failed[symbol];
    if (JSON.stringify(found) !== JSON.stringify(known)) {
      live.values[symbol] = found;
      live.changes.push({ symbol, at: new Date().toISOString(), from: known || null, to: found });
      if (live.changes.length > 200) live.changes = live.changes.slice(-200);
      console.log(`masternode collateral: ${symbol} changed in the source code`);
      await tell(`Colateral de masternode alterado: ${symbol}`, [
        `O código oficial de <b>${symbol}</b> passou a exigir outro colateral de masternode. O site já mostra o novo valor.`,
        `Antes: ${describe(spec, known)}`, `Agora: ${describe(spec, found)}`, `Fonte: <a href="${link}">${link}</a>`,
      ]);
    }
    save();
  } catch (e) {
    console.error(`masternode collateral: ${symbol} not read (${String((e && e.message) || e).slice(0, 80)})`);
    // told once, when the reading starts to fail (three days in a row), not every day
    const f = live.failed[symbol] || { since: Date.now(), told: false };
    if (!f.told && Date.now() - f.since > 3 * CHECK_EVERY_MS - 60000) {
      f.told = true;
      await tell(`Colateral de masternode: conferir ${symbol}`, [
        `Não foi possível ler o colateral de <b>${symbol}</b> no código oficial há três dias (o arquivo mudou de lugar ou de formato). O site continua mostrando o último valor conferido: ${describe(spec, live.values[symbol] || spec.value)}.`,
        `Fonte: <a href="${link}">${link}</a>`,
      ]);
    }
    live.failed[symbol] = f;
    save();
  }
}

let running = false;
async function checkAll() {
  if (running) return;
  running = true;
  try {
    for (const symbol of Object.keys(REGISTRY)) {
      if (!REGISTRY[symbol].rule) continue;
      const last = Math.max(live.checked[symbol] || 0, (live.failed[symbol] && live.failed[symbol].last) || 0);
      if (Date.now() - last < CHECK_EVERY_MS) continue;
      if (live.failed[symbol]) live.failed[symbol].last = Date.now();
      await check(symbol);
      if (live.failed[symbol]) { live.failed[symbol].last = Date.now(); save(); }
      await new Promise((r) => setTimeout(r, GAP_MS));
    }
  } finally { running = false; }
}

module.exports = function mountMasternodeCollateral(app, { callRoute }) {
  callRouteRef = callRoute;
  let answer = null;
  app.get('/api/masternode-collateral', async (req, res) => {
    try {
      res.set('Cache-Control', 'public, max-age=300');
      if (answer && Date.now() - answer.at < 5 * 60 * 1000) return res.json(answer.body);
      const data = {};
      for (const symbol of Object.keys(REGISTRY)) data[symbol] = await current(symbol);
      answer = { at: Date.now(), body: { ok: true, updated_at: new Date().toISOString(), data } };
      return res.json(answer.body);
    } catch (e) {
      res.set('Cache-Control', 'no-store');
      res.status(500).json({ ok: false, error: 'collateral data unavailable' });
    }
  });
  setTimeout(() => { checkAll().catch((e) => console.error('masternode collateral check failed', e && e.message)); }, 3 * 60 * 1000).unref();
  setInterval(() => { checkAll().catch((e) => console.error('masternode collateral check failed', e && e.message)); }, 60 * 60 * 1000).unref();
  return { current, checkAll };
};
module.exports.extract = extract;
module.exports.current = current;
