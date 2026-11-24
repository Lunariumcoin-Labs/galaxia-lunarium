// Usage: node backend/tools/build-api-registry.js
// Builds backend/public-api-coins.json from the site's COINS object so the public API lists exactly
// the coins/markets the site shows. Re-run after adding a coin to galaxialunarium-coins-data.js.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const J = path.join(ROOT, 'galaxialunarium-coins-data.js');
const H = path.join(ROOT, 'galaxialunarium-preview.html');
const OUT = path.join(__dirname, '..', 'public-api-coins.json');
const src = fs.readFileSync(J, 'utf8');
const html = fs.readFileSync(H, 'utf8');
const start = src.indexOf('var COINS = {');
const end = src.indexOf('\n};', start);
if (start < 0 || end < 0) throw new Error('COINS markers');
const I18N = new Proxy({}, { get: (t, k) => ({ en: '@' + String(k) }) });
const ctx = { I18N };
vm.runInNewContext(src.slice(start, end + 3).replace('var COINS', 'this.COINS'), ctx);
const COINS = ctx.COINS;

// category from the list each coin sits in on the site
function listOf(viewId) {
  const i = html.indexOf('<div id=' + viewId + ' class=moedasView>');
  if (i < 0) return [];
  const j = html.indexOf('</table>', i);
  return Array.from(html.slice(i, j).matchAll(/data-coin=([a-z0-9-]+)/g)).map((m) => m[1]);
}
const cat = {};
listOf('moedasView').forEach((id) => { cat[id] = 'masternode'; });
listOf('mineracaoView').forEach((id) => { cat[id] = cat[id] || 'pow'; });
listOf('stakeView').forEach((id) => { cat[id] = cat[id] || 'stake'; });
listOf('tokensView').forEach((id) => { cat[id] = cat[id] || 'token'; });

const text = (v) => (v && typeof v === 'object' ? v.en : v);
const out = Object.keys(COINS).map((id) => {
  const c = COINS[id];
  const exByName = {};
  (c.exchanges || []).forEach((e) => { exByName[e.name] = e; });
  const allLinks = [].concat(c.bottomStats || [], c.officialLinks || []);
  const contractLink = allLinks.map((l) => l.linkUrl || l.url || '').find((u) => /bscscan\.com\/(token|address)\/0x[0-9a-fA-F]{40}/.test(u));
  const contract = contractLink ? contractLink.match(/0x[0-9a-fA-F]{40}/)[0] : null;
  const networkKpi = (c.kpis || []).find((k) => /kpiNetwork/.test(text(k.label) || ''));
  const links = {};
  (c.officialLinks || []).forEach((l) => {
    const label = String(text(l.label) || '').replace(/^@/, '');
    let key = label;
    if (/officialWebsite/i.test(label)) key = 'website';
    else if (/explorer/i.test(label)) key = 'explorer';
    else if (/github/i.test(label)) key = 'source_code';
    else if (/bscscan/i.test(label)) key = 'contract';
    else key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (!links[key]) links[key] = l.url;
  });
  return {
    id,
    symbol: c.ticker,
    name: c.name,
    category: cat[id] || 'token',
    official_lunarium: !!c.isOfficial || id === 'xlnft',
    network: contract ? 'BNB Smart Chain (BEP-20)' : (networkKpi ? text(networkKpi.value) : 'native'),
    contract,
    logo: c.icon,
    network_api: c.networkApi || null,
    links,
    markets: (c.chartLines || []).filter((l) => l.proxyPath).map((l) => {
      const e = exByName[l.name] || {};
      const market = {
        // a second market of the same exchange (a pair quoted in another coin) carries the exchange's name apart
        exchange: l.exchange || l.name,
        type: e.type || 'CEX',
        pair: e.pair || (c.ticker + '/USDT'),
        url: e.url || null,
        ticker: l.proxyPath.replace('/klines/', '/ticker/'),
        klines: l.proxyPath,
        params: l.proxyParams || '',
      };
      // announced by the exchange, not open yet: the API lists it only once its ticker answers
      if (l.whenListed) market.when_listed = true;
      // quoted in another coin, converted to USDT: never the coin's headline price
      if (l.cross) market.cross = true;
      return market;
    }),
  };
});
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(out.map((c) => `${c.id} [${c.category}] ${c.markets.map((m) => m.exchange).join(',')} ${c.contract || ''}`).join('\n'));
