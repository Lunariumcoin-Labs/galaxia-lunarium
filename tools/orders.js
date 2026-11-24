// Orders, tickets and listing reviews (run on the server, from the app folder).
//
//   node tools/orders.js list [--status paid|pending|confirming|expired] [--kind api|listing]
//   node tools/orders.js show <order id | ticket>
//   node tools/orders.js listing <order id | ticket> approved|listed|rejected [--note "..."] [--refund-tx <txid>]
//
// Listing statuses: under_review (set automatically on payment) -> approved -> listed, or rejected
// (with the refund transaction when the refund policy applies). The buyer sees the status and the
// note on the ticket page.
const plans = require('../api-plans');
const { ORDERS_FILE } = require('../api-orders');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function die(msg) { console.error(msg); process.exit(1); }

const orders = plans.readJson(ORDERS_FILE, []);
const find = (ref) => orders.find((o) => o.id === ref || o.ticket === ref);
const cmd = process.argv[2];

if (cmd === 'list') {
  const status = arg('status');
  const kind = arg('kind');
  const list = orders.filter((o) => (!status || o.status === status) && (!kind || (o.kind || 'api') === kind));
  if (!list.length) console.log('No orders.');
  list.forEach((o) => {
    const who = o.customer ? `${o.customer.name} <${o.customer.email}>` : '';
    const what = o.kind === 'listing' ? `listing ${o.listing_type}: ${o.listing && o.listing.name} [${o.listing_status || '-'}]` : `api ${o.plan}${o.renew_key_id ? ' (renewal)' : ''}`;
    console.log(`${o.id}  ${(o.ticket || '-').padEnd(16)} ${o.status.padEnd(10)} ${String(o.amount_xln).padEnd(14)} ${o.created_at.slice(0, 16)}  ${what}  ${who}`);
  });
} else if (cmd === 'show') {
  const o = find(process.argv[3]);
  if (!o) die('unknown order');
  const { token_hash, api_key, ...safe } = o;
  console.log(JSON.stringify(safe, null, 2));
} else if (cmd === 'listing') {
  const o = find(process.argv[3]);
  if (!o) die('unknown order');
  if (o.kind !== 'listing') die('not a listing order');
  if (o.status !== 'paid' && o.status !== 'registered') die('order is not paid');
  const st = process.argv[4];
  if (!['approved', 'listed', 'rejected', 'under_review'].includes(st)) die('status must be approved, listed, rejected or under_review');
  o.listing_status = st;
  o.listing_note = arg('note', o.listing_note || '');
  if (arg('refund-tx')) o.refund_txid = arg('refund-tx');
  o.listing_updated_at = new Date().toISOString();
  plans.writeJsonAtomic(ORDERS_FILE, orders);
  console.log(`${o.ticket}: listing ${st}${o.listing_note ? ' - ' + o.listing_note : ''}${o.refund_txid ? ' (refund tx ' + o.refund_txid + ')' : ''}`);
} else {
  die('usage: node tools/orders.js list|show|listing (see the header of this file)');
}
