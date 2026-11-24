// Private admin panel (run on the server, from the app folder).
//
//   node tools/admin.js setup     creates the panel address if needed and e-mails a one-time link
//                                 (valid 30 min) to mail.json "admin_to" to create the password
//   node tools/admin.js where     prints the panel address
//   node tools/admin.js signout   ends every admin session
//
// The password itself never passes through this tool or the terminal.
const admin = require('../admin-panel');
const plans = require('../api-plans');
const path = require('path');

const cmd = process.argv[2];
const FILE = path.join(plans.DATA_DIR, 'admin.json');
(async () => {
  if (cmd === 'setup') {
    const r = await admin.sendSetupLink();
    console.log(r.sent ? `setup link e-mailed to ${r.recipients} admin recipient(s)` : 'could not e-mail the setup link (check data/mail.json)');
    console.log('panel: https://galaxia.lunariumcoin.com/' + r.slug);
  } else if (cmd === 'where') {
    console.log('panel: https://galaxia.lunariumcoin.com/' + admin.ensureSlug());
  } else if (cmd === 'signout') {
    const a = plans.readJson(FILE, {});
    a.sessions = [];
    plans.writeJsonAtomic(FILE, a);
    console.log('all admin sessions ended');
  } else {
    console.error('usage: node tools/admin.js setup|where|signout');
    process.exit(1);
  }
  process.exit(0);
})();
