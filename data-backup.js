// Automatic backup of data/ (accounts, API keys, orders, sessions, listings, admin access, the
// signing key) to a folder outside the application: ~/galaxia-backups/data/<YYYY-MM-DD>/.
// A copy is taken a minute after start and every 6 hours; each day keeps its latest good copy and
// 30 days are kept. A JSON file that does not parse (a half-written or damaged file) is never
// copied over a good backup. Active only where ~/galaxia-backups exists (the server), so a
// developer machine is left alone.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const EVERY_MS = 6 * 60 * 60 * 1000;
const KEEP_DAYS = 30;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function homeDir() {
  const m = __dirname.match(/^(\/home\/[^/]+)\//);
  return (m && m[1]) || process.env.HOME || os.homedir();
}
const ROOT = path.join(homeDir(), 'galaxia-backups');
const DEST = path.join(ROOT, 'data');

function copyTree(from, to) {
  let copied = 0;
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  fs.readdirSync(from, { withFileTypes: true }).forEach((e) => {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    // data/logos is only a cache of the exchanges' coin logos (downloaded again when needed)
    if (e.isDirectory()) { if (!(from === DATA_DIR && e.name === 'logos')) copied += copyTree(src, dst); return; }
    if (!e.isFile() || /\.tmp$|\.claim$/.test(e.name)) return;
    const st = fs.statSync(src);
    if (st.size > MAX_FILE_BYTES) return;
    const buf = fs.readFileSync(src);
    if (/\.json$/.test(e.name)) { try { JSON.parse(buf.toString('utf8')); } catch (err) { console.error('backup skipped (invalid JSON): ' + e.name); return; } }
    const tmp = dst + '.tmp';
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.renameSync(tmp, dst);
    copied += 1;
  });
  return copied;
}

function prune() {
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  fs.readdirSync(DEST).forEach((name) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) return;
    if (Date.parse(name + 'T00:00:00Z') < cutoff) fs.rmSync(path.join(DEST, name), { recursive: true, force: true });
  });
}

function backup() {
  if (!fs.existsSync(ROOT) || !fs.existsSync(DATA_DIR)) return null;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const n = copyTree(DATA_DIR, path.join(DEST, day));
    prune();
    console.log(`data backup: ${n} files -> galaxia-backups/data/${day}`);
    return n;
  } catch (e) {
    console.error('data backup failed', e && e.message);
    return null;
  }
}

module.exports = function mountDataBackup() {
  setTimeout(backup, 60 * 1000).unref();
  setInterval(backup, EVERY_MS).unref();
  return backup;
};
module.exports.backup = backup;
