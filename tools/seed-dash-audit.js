// Usage (from the backend folder): node tools/seed-dash-audit.js
// Builds the Dash audit's first state on this machine -- the history total, the last 30 days of block
// sums and the fees of every Platform withdrawal in them -- with the same code the site runs
// (major-audits.js), without the other audits. Its data/dash-audit-*.json files are then copied to the
// server, so the server never has to make those heavy blockchair queries itself.
process.env.GALAXIA_AUDIT_NO_SCHEDULE = '1';
const express = require('express');

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: controller.signal });
    if (!r.ok) throw new Error('upstream status ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}
// same rule as server.js: every reading of the last 7 days, then one per day
function compactAuditHistory(history) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = [];
  const olderByDay = new Map();
  for (const p of history) {
    if (new Date(p.ts).getTime() >= cutoff) recent.push(p);
    else {
      const day = new Date(p.ts).toISOString().slice(0, 10);
      if (!olderByDay.has(day)) olderByDay.set(day, p);
    }
  }
  return Array.from(olderByDay.values()).concat(recent).sort((a, b) => new Date(a.ts) - new Date(b.ts));
}

(async () => {
  const audits = require('../major-audits')(express(), { fetchJson, compactAuditHistory });
  for (let attempt = 1; attempt <= 6; attempt++) {
    console.log(new Date().toISOString(), 'attempt', attempt);
    if (await audits.sampleDash()) { console.log('done'); process.exit(0); }
    await new Promise((ok) => setTimeout(ok, 10 * 60 * 1000));
  }
  console.log('failed');
  process.exit(1);
})();
