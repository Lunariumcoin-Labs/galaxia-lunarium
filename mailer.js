// Outgoing e-mail through the Hostinger Mail API ("Agentic mail"):
//   POST https://api.mail.hostinger.com/api/v1/mailboxes/{mailboxResourceId}/send
// with a Bearer API token. Settings live only on the server, in data/mail.json:
//   { "token": "...", "mailbox_id": "AC...", "from_name": "GaláxiaLunarium", "admin_to": ["you@..."] }
// Without that file, e-mail is simply disabled (logged). A message that fails to send is kept in
// data/mail-outbox.json and retried every 10 minutes, up to 6 attempts.
const fs = require('fs');
const path = require('path');
const plans = require('./api-plans');

const CONFIG_FILE = path.join(plans.DATA_DIR, 'mail.json');
const OUTBOX_FILE = path.join(plans.DATA_DIR, 'mail-outbox.json');
const API = 'https://api.mail.hostinger.com/api/v1';
const MAX_ATTEMPTS = 6;

function config() {
  const c = plans.readJson(CONFIG_FILE, null);
  return c && c.token && c.mailbox_id ? c : null;
}
function enabled() { return !!config(); }
function adminRecipients() { const c = config(); return c && Array.isArray(c.admin_to) ? c.admin_to : []; }

async function deliver(msg) {
  const c = config();
  if (!c) throw new Error('mail not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(`${API}/mailboxes/${encodeURIComponent(c.mailbox_id)}/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ to: msg.to, displayName: c.from_name || 'GaláxiaLunarium', subject: msg.subject, text: msg.text, html: msg.html }),
      signal: controller.signal,
    });
    if (!r.ok) throw new Error('mail api status ' + r.status + ' ' + (await r.text()).slice(0, 200));
  } finally {
    clearTimeout(timer);
  }
}

// Sends now; on failure queues for retry. Never throws (a notification must not break an order).
async function send(msg) {
  const to = (Array.isArray(msg.to) ? msg.to : [msg.to]).filter(Boolean);
  if (!to.length) return false;
  const shown = String(msg.subject || '').replace(/\d{6,}/g, '******');
  if (!enabled()) { console.log(`mail disabled, not sent: "${shown}" -> ${to.join(', ')}`); return false; }
  const m = { to, subject: msg.subject, text: msg.text, html: msg.html };
  try {
    await deliver(m);
    console.log(`mail sent: "${shown}" -> ${to.length} recipient(s)`);
    return true;
  } catch (e) {
    console.error('mail send failed, queued for retry:', e && e.message);
    const box = plans.readJson(OUTBOX_FILE, []);
    box.push(Object.assign(m, { attempts: 1, last_error: String(e && e.message).slice(0, 200), queued_at: new Date().toISOString() }));
    plans.writeJsonAtomic(OUTBOX_FILE, box);
    return false;
  }
}

async function retryOutbox() {
  const box = plans.readJson(OUTBOX_FILE, []);
  if (!box.length || !enabled()) return;
  const keep = [];
  for (const m of box) {
    try {
      await deliver(m);
      console.log(`mail sent on retry: "${String(m.subject || '').replace(/\d{6,}/g, '******')}"`);
    } catch (e) {
      m.attempts += 1;
      m.last_error = String(e && e.message).slice(0, 200);
      if (m.attempts < MAX_ATTEMPTS) keep.push(m); else console.error(`mail dropped after ${m.attempts} attempts: "${m.subject}"`);
    }
  }
  plans.writeJsonAtomic(OUTBOX_FILE, keep);
}
setInterval(() => { retryOutbox().catch(() => {}); }, 10 * 60 * 1000).unref();

module.exports = { send, enabled, adminRecipients, CONFIG_FILE };
