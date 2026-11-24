// MEXC's own coin icons for its exchange page (owner, 2026-10-22: "on the MEXC site every coin has its logo,
// fix it properly").
//
// MEXC serves both the symbol -> icon list (www.mexc.com/api/platform/spot/market/symbols, field `icon`)
// and the images (www.mexc.com/api/platform/file/download/<icon>) to real browsers only (Akamai); the
// public CDN (public.mocortech.com/coin/<icon>.png) has only part of them. So this runs on the owner's
// Windows PC with Edge in headless mode:
//   1. reads the list -> backend/mexc-icons.json (symbol -> icon id; the server's fallback source);
//   2. shows the icons in a grid on a local page, takes a transparent screenshot per batch and cuts each
//      icon out at 64x64 -> backend/mexc-logos/<SYMBOL>.png (an icon that did not load is skipped).
//
// Usage (Windows, from the backend folder):  node tools/update-mexc-icons.js
// then copy mexc-logos/*.png to data/logos/mexc/ on the server (the logo route serves <SYMBOL>.png first)
// and deploy mexc-icons.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
if (!EDGE) { console.error('Microsoft Edge not found'); process.exit(1); }
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mexc-icons-'));
const win = (p) => p.replace(/\//g, '\\');
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
// Edge hands the work to child processes: PowerShell's Start-Process -Wait waits for all of them
// (Node's own spawn returns too early and Edge then writes nothing)
function edge(args, stdoutFile) {
  const ps = `$p = Start-Process -FilePath ${q(win(EDGE))} -ArgumentList @(${args.map(q).join(',')}) -Wait -PassThru -NoNewWindow${stdoutFile ? ' -RedirectStandardOutput ' + q(stdoutFile) : ''} -RedirectStandardError ${q(path.join(work, 'edge-err.txt'))}; exit $p.ExitCode`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', timeout: 180000 });
}

// ---- 1. the symbol -> icon list
const dump = path.join(work, 'symbols.html');
edge(['--headless=new', '--disable-gpu', `--user-data-dir=${path.join(work, 'profile')}`, '--virtual-time-budget=15000', '--dump-dom', 'https://www.mexc.com/api/platform/spot/market/symbols'], dump);
const html = fs.existsSync(dump) ? fs.readFileSync(dump, 'utf8') : '';
const start = html.indexOf('<pre>');
const end = html.lastIndexOf('</pre>');
if (start < 0 || end < 0) { console.error('MEXC did not answer with the symbol list'); process.exit(1); }
const raw = html.slice(start + 5, end).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const data = JSON.parse(raw).data || {};
const map = {};
Object.keys(data).forEach((quote) => (data[quote] || []).forEach((s) => {
  const sym = String(s.currency || '').toUpperCase();
  const icon = String(s.icon || '');
  if (/^[A-Z0-9()]{1,24}$/.test(sym) && /^F[0-9A-Za-z]{20,40}$/.test(icon) && !map[sym]) map[sym] = icon;
}));
if (Object.keys(map).length < 500) { console.error('too few icons (' + Object.keys(map).length + '): not saved'); process.exit(1); }
fs.writeFileSync(path.join(__dirname, '..', 'mexc-icons.json'), JSON.stringify(map));
console.log(`saved ${Object.keys(map).length} MEXC icon ids to mexc-icons.json`);

// ---- 2. the images: one transparent screenshot per batch of 100, cut into 64x64 PNGs; an image that
// fails to load is removed (no broken-image icon in the shot) and tried again in the next round
const OUT = path.join(__dirname, '..', 'mexc-logos');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const SIZE = 64;
const COLS = 20;
let saved = 0;
const BATCH = 100;
for (let round = 1; round <= 3; round++) {
const syms = Object.keys(map).sort().filter((s) => !fs.existsSync(path.join(OUT, s + '.png')));
if (!syms.length) break;
for (let b = 0; b < syms.length; b += BATCH) {
  const batch = syms.slice(b, b + BATCH);
  const rows = Math.ceil(batch.length / COLS);
  const page = path.join(work, `grid-${round}-${b}.html`);
  const shot = path.join(work, `grid-${round}-${b}.png`);
  fs.writeFileSync(page, '<!doctype html><html><head><meta charset=utf-8><style>html,body{margin:0;background:transparent}' +
    `body{display:grid;grid-template-columns:repeat(${COLS},${SIZE}px);grid-auto-rows:${SIZE}px}div{width:${SIZE}px;height:${SIZE}px;display:flex;align-items:center;justify-content:center}` +
    `img{width:${SIZE}px;height:${SIZE}px;object-fit:contain}</style></head><body>` +
    batch.map((s) => `<div><img src="https://www.mexc.com/api/platform/file/download/${map[s]}" onerror="this.remove()"></div>`).join('') + '</body></html>');
  edge(['--headless=new', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000', `--window-size=${COLS * SIZE},${rows * SIZE}`,
    '--virtual-time-budget=60000', `--user-data-dir=${path.join(work, 'profile')}`, `--screenshot=${shot}`, 'file:///' + page.replace(/\\/g, '/')]);
  if (!fs.existsSync(shot)) { console.error(`batch ${b}: no screenshot`); continue; }
  const listFile = path.join(work, `grid-${round}-${b}.txt`);
  fs.writeFileSync(listFile, batch.map((s, i) => `${s} ${(i % COLS) * SIZE} ${Math.floor(i / COLS) * SIZE}`).join('\n'));
  // cut each cell; a cell with no visible pixel (icon did not load) is skipped
  const cut = `Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Bitmap]::FromFile(${q(shot)}); $n = 0
foreach ($line in Get-Content ${q(listFile)}) {
  $p = $line.Split(' '); $x = [int]$p[1]; $y = [int]$p[2]
  $cell = $src.Clone((New-Object System.Drawing.Rectangle $x, $y, ${SIZE}, ${SIZE}), [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $seen = 0; for ($i = 4; $i -lt ${SIZE}; $i += 6) { for ($j = 4; $j -lt ${SIZE}; $j += 6) { if ($cell.GetPixel($i, $j).A -gt 20) { $seen++ } } }
  if ($seen -ge 3) { $cell.Save((Join-Path ${q(OUT)} ($p[0] + '.png')), [System.Drawing.Imaging.ImageFormat]::Png); $n++ }
  $cell.Dispose()
}
$src.Dispose(); Write-Output $n`;
  const n = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cut], { timeout: 300000 }).toString().trim().split(/\s+/).pop()) || 0;
  saved += n;
  console.log(`round ${round}, batch ${b / BATCH + 1}: ${n}/${batch.length} icons`);
}
}
try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* temp files */ }
console.log(`saved ${saved} MEXC logos to ${OUT}`);
