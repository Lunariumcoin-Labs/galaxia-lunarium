// GaláxiaLunarium e-mail layout: table-based with inline styles (what e-mail clients render
// reliably), logo header, white card, one call-to-action button, footer. Text is always escaped.
const SITE = 'https://galaxia.lunariumcoin.com';
const LOGO = SITE + '/galaxialunarium-logo.png';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const p = (s) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#2a2f4a">${esc(s)}</p>`;
const small = (s) => `<p style="margin:0 0 10px;font-size:13px;line-height:1.5;color:#6b7090">${esc(s)}</p>`;
const button = (href, label) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0"><tr><td style="border-radius:10px;background:linear-gradient(135deg,#20df84,#2ecfe6);background-color:#20c98a">
<a href="${esc(href)}" style="display:inline-block;padding:14px 26px;font-size:15px;font-weight:bold;color:#06231a;text-decoration:none;border-radius:10px">${esc(label)}</a></td></tr></table>`;
const linkFallback = (href) => `<p style="margin:0 0 14px;font-size:12px;line-height:1.5;color:#8a8fae;word-break:break-all"><a href="${esc(href)}" style="color:#3b6fd8">${esc(href)}</a></p>`;

function layout(bodyHtml, footer, opts = {}) {
  const dir = opts.lang === 'ar' || opts.lang === 'he' ? 'rtl' : 'ltr';
  const pre = opts.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(opts.preheader)}</div>` : '';
  return `<!doctype html><html lang="${esc(opts.lang || 'pt-BR')}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#eef1f5;font-family:Arial,Helvetica,sans-serif">${pre}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px">
<tr><td style="background:#081012;background-image:linear-gradient(135deg,#081012,#0f2a2c);border-radius:14px 14px 0 0;padding:22px 26px">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="vertical-align:middle"><img src="${LOGO}" width="40" height="40" alt="" style="display:block;border:0"></td>
<td style="vertical-align:middle;padding-left:12px;font-size:20px;font-weight:bold;color:#f4f8f6">Galáxia<span style="color:#2ecfe6">Lunarium</span></td>
</tr></table></td></tr>
<tr><td style="background:#ffffff;border-radius:0 0 14px 14px;padding:28px 26px" dir="${dir}">${bodyHtml}</td></tr>
<tr><td style="padding:18px 8px;text-align:center;font-size:12px;line-height:1.5;color:#8a8fae">${esc(footer)}<br><a href="${SITE}" style="color:#8a8fae">galaxia.lunariumcoin.com</a></td></tr>
</table></td></tr></table></body></html>`;
}

module.exports = { SITE, esc, p, small, button, linkFallback, layout };
