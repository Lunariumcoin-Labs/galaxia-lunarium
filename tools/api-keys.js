// Manage GaláxiaLunarium public API keys (run on the server, from the app folder).
//
//   node tools/api-keys.js create --plan pro --owner "Exchange X" [--months 1] [--note "paid 80000 XLN, tx ..."]
//   node tools/api-keys.js list
//   node tools/api-keys.js extend <id> --months 1
//   node tools/api-keys.js revoke <id>
//   node tools/api-keys.js usage [YYYY-MM]
//
// The key itself is printed once, on create, and only its SHA-256 hash is stored. The running
// server picks up changes within ~10 seconds, no restart needed.
const plans = require('../api-plans');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function die(msg) { console.error(msg); process.exit(1); }

const cmd = process.argv[2];
const cfg = plans.loadConfig();
const list = plans.readKeys();

if (cmd === 'create') {
  const plan = arg('plan');
  if (!plan || !cfg.plans[plan] || !cfg.plans[plan].requires_key) die('--plan must be one of: ' + Object.keys(cfg.plans).filter((p) => cfg.plans[p].requires_key).join(', '));
  const owner = arg('owner');
  if (!owner) die('--owner is required');
  // without --months the plan decides: a lifetime plan gives a key that does not expire
  const months = arg('months') == null ? undefined : Number(arg('months'));
  if (months !== undefined && !(months > 0)) die('--months must be a positive number');
  const { key, rec } = plans.createKey({ plan, owner, months, note: arg('note', '') });
  console.log(`Key created (id ${rec.id}, plan ${plan}, owner ${owner}, ${rec.expires_at ? 'expires ' + rec.expires_at.slice(0, 10) : 'lifetime'}).`);
  console.log('Give this key to the customer now; it is not stored and cannot be shown again:');
  console.log('\n  ' + key + '\n');
} else if (cmd === 'list') {
  const period = plans.period();
  const usage = plans.readUsageFile()[period] || {};
  if (!list.length) console.log('No keys issued yet.');
  list.forEach((k) => {
    const expired = k.expires_at && Date.parse(k.expires_at) < Date.now();
    const state = !k.active ? 'REVOKED' : expired ? 'EXPIRED' : 'active';
    console.log(`${k.id}  ${k.prefix}…  ${k.plan.padEnd(10)} ${state.padEnd(7)} ${k.expires_at ? 'expires ' + String(k.expires_at).slice(0, 10) : 'lifetime          '}  used ${period}: ${usage[k.id] || 0}  ${k.owner}${k.note ? '  (' + k.note + ')' : ''}`);
  });
} else if (cmd === 'extend') {
  const months = Number(arg('months', '1'));
  if (!(months > 0)) die('--months must be a positive number');
  const k = plans.extendKey(process.argv[3], months);
  if (!k) die('unknown key id');
  console.log(k.expires_at ? `Key ${k.id} (${k.owner}) now expires ${k.expires_at.slice(0, 10)}.` : `Key ${k.id} (${k.owner}) is a lifetime key: nothing to extend.`);
} else if (cmd === 'revoke') {
  const k = list.find((x) => x.id === process.argv[3]);
  if (!k) die('unknown key id');
  k.active = false;
  plans.writeKeys(list);
  console.log(`Key ${k.id} (${k.owner}) revoked.`);
} else if (cmd === 'usage') {
  const period = process.argv[3] || plans.period();
  const usage = plans.readUsageFile()[period] || {};
  list.forEach((k) => console.log(`${k.id}  ${k.owner.padEnd(24)} ${k.plan.padEnd(10)} ${usage[k.id] || 0}`));
} else {
  die('usage: node tools/api-keys.js create|list|extend|revoke|usage (see the header of this file)');
}
