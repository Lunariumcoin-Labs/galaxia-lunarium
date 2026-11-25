// Site-wide footer with the LunariumCoin and community links (owner, 2026-11-25: "pode colocar os links no galaxia
// também", like the explorer's footer). It is appended to <main>, so it shows under every screen. The language follows
// #languageSelect, which the rest of the site uses; language detection changes it without an event, hence the poll.
(function(){
var T = {
  en: ['Community', 'Cryptocurrency aggregator by Lunarium Labs'],
  'pt-BR': ['Comunidade', 'Agregador de criptomoedas da Lunarium Labs'],
  es: ['Comunidad', 'Agregador de criptomonedas de Lunarium Labs'],
  de: ['Community', 'Krypto-Aggregator von Lunarium Labs'],
  fr: ['Communauté', 'Agrégateur de cryptomonnaies de Lunarium Labs'],
  it: ['Community', 'Aggregatore di criptovalute di Lunarium Labs'],
  nl: ['Community', 'Crypto-aggregator van Lunarium Labs'],
  pl: ['Społeczność', 'Agregator kryptowalut od Lunarium Labs'],
  ru: ['Сообщество', 'Агрегатор криптовалют от Lunarium Labs'],
  uk: ['Спільнота', 'Агрегатор криптовалют від Lunarium Labs'],
  tr: ['Topluluk', 'Lunarium Labs kripto para toplayıcısı'],
  ar: ['المجتمع', 'مجمّع العملات المشفرة من Lunarium Labs'],
  he: ['קהילה', 'אגרגטור מטבעות קריפטו של Lunarium Labs'],
  hi: ['समुदाय', 'Lunarium Labs का क्रिप्टोकरेंसी एग्रीगेटर'],
  zh: ['社区', 'Lunarium Labs 加密货币聚合器'],
  'zh-TW': ['社群', 'Lunarium Labs 加密貨幣聚合器'],
  ja: ['コミュニティ', 'Lunarium Labs の暗号資産アグリゲーター'],
  ko: ['커뮤니티', 'Lunarium Labs의 암호화폐 애그리게이터'],
  vi: ['Cộng đồng', 'Trình tổng hợp tiền mã hóa của Lunarium Labs'],
  th: ['ชุมชน', 'ตัวรวบรวมคริปโทเคอร์เรนซีของ Lunarium Labs'],
  id: ['Komunitas', 'Agregator kripto dari Lunarium Labs'],
  bg: ['Общност', 'Агрегатор на криптовалути от Lunarium Labs'],
  cs: ['Komunita', 'Agregátor kryptoměn od Lunarium Labs'],
  sk: ['Komunita', 'Agregátor kryptomien od Lunarium Labs'],
  sl: ['Skupnost', 'Agregator kriptovalut Lunarium Labs'],
  hr: ['Zajednica', 'Agregator kriptovaluta tvrtke Lunarium Labs'],
  hu: ['Közösség', 'A Lunarium Labs kriptovaluta-aggregátora'],
  ro: ['Comunitate', 'Agregator de criptomonede de la Lunarium Labs'],
  el: ['Κοινότητα', 'Συγκεντρωτής κρυπτονομισμάτων της Lunarium Labs'],
  lt: ['Bendruomenė', 'Lunarium Labs kriptovaliutų agregatorius'],
  da: ['Fællesskab', 'Kryptoaggregator fra Lunarium Labs'],
  sv: ['Gemenskap', 'Kryptoaggregator från Lunarium Labs'],
  no: ['Fellesskap', 'Kryptoaggregator fra Lunarium Labs'],
  fi: ['Yhteisö', 'Lunarium Labsin kryptovaluuttakokoaja']
};
var LINKS = {
  lunarium: [['lunariumcoin.com', 'https://lunariumcoin.com/'], ['Explorer XLN', 'https://explorerxln.com/'], ['GitHub', 'https://github.com/Lunariumcoin-Labs']],
  community: [['Telegram', 'https://t.me/+ctL9XBvKQW42ZGUx'], ['Discord', 'https://discord.gg/wbZ3PVVA7Q'], ['X (Twitter)', 'https://twitter.com/lunariumcoin/']]
};
var CSS = '.gxFoot{margin:34px 0 0;border-top:1px solid var(--line);padding:26px 26px 30px;display:grid;grid-template-columns:1.6fr 1fr 1fr;gap:24px;font-size:13.5px;color:var(--mut)}'
  + '.gxFoot h4{margin:0 0 10px;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);font-weight:700}'
  + '.gxFoot a{display:block;color:var(--mut);padding:3px 0;text-decoration:none}.gxFoot a:hover{color:var(--cyan)}'
  + '.gxfBrand{display:flex;gap:12px;align-items:center}.gxfBrand img{width:38px;height:38px;border-radius:50%;flex:none}'
  + '.gxfBrand strong{display:block;color:var(--text);font-size:15px}.gxfBrand span{font-size:12.5px;color:var(--dim)}'
  + '@media(max-width:820px){.gxFoot{grid-template-columns:1fr 1fr;padding:22px 16px 26px}.gxfBrandCol{grid-column:1/-1}}';

function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function links(list){ return list.map(function(l){ return '<a href="' + esc(l[1]) + '" target=_blank rel=noopener>' + esc(l[0]) + '</a>'; }).join(''); }
function lang(){ var s = document.getElementById('languageSelect'); var v = s && s.value; return T[v] ? v : 'en'; }

var shown = null;
function paint(foot){
  var l = lang();
  if(l === shown) return;
  shown = l;
  var t = T[l];
  foot.innerHTML = '<div class=gxfBrandCol><div class=gxfBrand><img src=galaxialunarium-logo.png alt=""><div><strong>GaláxiaLunarium</strong><span>' + esc(t[1]) + '</span></div></div></div>'
    + '<div><h4>LunariumCoin</h4>' + links(LINKS.lunarium) + '</div>'
    + '<div><h4>' + esc(t[0]) + '</h4>' + links(LINKS.community) + '</div>';
}

function init(){
  var main = document.querySelector('.app > main') || document.querySelector('main');
  if(!main || document.querySelector('.gxFoot')) return;
  var st = document.createElement('style');
  st.textContent = CSS;
  document.head.appendChild(st);
  var foot = document.createElement('footer');
  foot.className = 'gxFoot';
  main.appendChild(foot);
  paint(foot);
  var sel = document.getElementById('languageSelect');
  if(sel) sel.addEventListener('change', function(){ paint(foot); });
  setInterval(function(){ paint(foot); }, 1000);
}
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
