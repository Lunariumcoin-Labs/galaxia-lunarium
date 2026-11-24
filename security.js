// Hardening applied to every response and request, mounted before anything else:
//  - files the app writes (accounts, keys, orders, sessions) are created readable by the owner only;
//  - security headers (HTTPS only, no MIME sniffing, no framing by other sites, lean referrer);
//  - nothing that looks like a backup or a hidden file is ever served from public/;
//  - query parameters of /api are plain short text: they are placed in the exchanges' API addresses,
//    so no path tricks or odd characters go through.
const SAFE_VALUE = /^[\p{L}\p{N}_\-/.,:@+ ]{0,120}$/u;

module.exports = function mountSecurity(app) {
  process.umask(0o077);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'Strict-Transport-Security': 'max-age=15552000',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'geolocation=(), camera=(), microphone=(), payment=(), usb=()',
      // no other site may show these pages inside a frame (clickjacking). The hosting replaces the
      // Content-Security-Policy header with its own, so X-Frame-Options is what reaches the browser.
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "frame-ancestors 'self' https://lunariumcoin.com https://www.lunariumcoin.com; base-uri 'self'; object-src 'none'; form-action 'self'",
    });
    let p = req.path;
    try { p = decodeURIComponent(p); } catch (e) { return res.status(400).end(); }
    if (/\.livebackup-|\.bak$|\.tmp$|~$/i.test(p) || /\/\.(?!well-known\/)/.test(p)) return res.status(404).end();
    next();
  });

  app.use('/api', (req, res, next) => {
    for (const k of Object.keys(req.query)) {
      const v = req.query[k];
      if (typeof v !== 'string' || !SAFE_VALUE.test(v) || v.includes('..')) {
        return res.status(400).json({ ok: false, error: 'invalid parameter: ' + String(k).slice(0, 40) });
      }
    }
    next();
  });
};
