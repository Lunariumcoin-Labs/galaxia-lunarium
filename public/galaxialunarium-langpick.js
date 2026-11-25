// Language picker with flags, like the Lunarium explorer's (owner, 2026-11-25: "can you put the little flags
// in the language selector"). A native <select> cannot show images and flag emoji do not render on Windows, so the
// visible picker is a button + list with the flag-icons images in flags/. The original #languageSelect stays in
// the page, hidden: it remains the source of truth that the rest of the site reads and listens to (a choice
// here sets its value and fires its change event).
(function(){
var FLAG = { en:'us', ru:'ru', de:'de', pl:'pl', es:'es', vi:'vn', fr:'fr', 'pt-BR':'br', ar:'sa', bg:'bg', cs:'cz', da:'dk', el:'gr', fi:'fi', he:'il', hi:'in', hr:'hr', hu:'hu', id:'id', it:'it', ja:'jp', ko:'kr', lt:'lt', nl:'nl', no:'no', ro:'ro', sk:'sk', sl:'si', sv:'se', th:'th', tr:'tr', uk:'ua', zh:'cn', 'zh-TW':'tw' };
var CHEV = '<svg class=lpChev viewBox="0 0 24 24" width=14 height=14 aria-hidden=true><path d="M6 9l6 6 6-6" fill=none stroke=currentColor stroke-width=2 stroke-linecap=round /></svg>';
function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function flag(code){ var c = FLAG[code]; return c ? '<img class=lpFlag src="flags/' + c + '.svg" alt="" width=22 height=16>' : '<span class=lpFlag>🌐</span>'; }

function init(){
  var sel = document.getElementById('languageSelect');
  if(!sel || document.querySelector('.langPick')) return;
  var wrap = document.createElement('div');
  wrap.className = 'langPick';
  wrap.innerHTML = '<button type=button class=lpBtn aria-haspopup=listbox aria-expanded=false></button><ul class=lpMenu role=listbox hidden></ul>';
  sel.parentNode.insertBefore(wrap, sel.nextSibling);
  sel.classList.add('lpNative');
  sel.setAttribute('aria-hidden', 'true');
  sel.tabIndex = -1;
  var btn = wrap.querySelector('.lpBtn'), menu = wrap.querySelector('.lpMenu');
  var label = function(o){ return (o && o.textContent || '').trim(); };
  var shown = null;
  function paint(){
    var o = sel.options[sel.selectedIndex], text = label(o) || sel.value;
    var sig = sel.value + '|' + text;
    if(sig === shown) return;
    shown = sig;
    btn.innerHTML = flag(sel.value) + '<span class=lpLabel>' + esc(text) + '</span>' + CHEV;
    btn.title = text;
  }
  function build(){
    menu.innerHTML = Array.prototype.map.call(sel.options, function(o){
      return '<li role=option tabindex=-1 data-lang="' + esc(o.value) + '" aria-selected="' + (o.value === sel.value) + '">' + flag(o.value) + '<span>' + esc(label(o)) + '</span></li>';
    }).join('');
  }
  function toggle(open){
    if(open == null) open = menu.hidden;
    if(open){
      build();
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      var cur = menu.querySelector('[aria-selected="true"]') || menu.firstElementChild;
      if(cur){ cur.scrollIntoView({ block: 'nearest' }); cur.focus({ preventScroll: true }); }
    }else{
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
  }
  function choose(code){
    toggle(false);
    btn.focus();
    if(code === sel.value) return;
    sel.value = code;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    paint();
  }
  btn.addEventListener('click', function(){ toggle(); });
  menu.addEventListener('click', function(e){ var li = e.target.closest('[data-lang]'); if(li) choose(li.getAttribute('data-lang')); });
  document.addEventListener('click', function(e){ if(!menu.hidden && !wrap.contains(e.target)) toggle(false); });
  wrap.addEventListener('keydown', function(e){
    if(menu.hidden){ if(e.key === 'ArrowDown' && e.target === btn){ e.preventDefault(); toggle(true); } return; }
    var items = Array.prototype.slice.call(menu.children), i = items.indexOf(document.activeElement);
    if(e.key === 'Escape'){ e.preventDefault(); toggle(false); btn.focus(); }
    else if(e.key === 'ArrowDown'){ e.preventDefault(); (items[i + 1] || items[0]).focus(); }
    else if(e.key === 'ArrowUp'){ e.preventDefault(); (items[i - 1] || items[items.length - 1]).focus(); }
    else if(e.key === 'Home'){ e.preventDefault(); items[0].focus(); }
    else if(e.key === 'End'){ e.preventDefault(); items[items.length - 1].focus(); }
    else if((e.key === 'Enter' || e.key === ' ') && i >= 0){ e.preventDefault(); choose(items[i].getAttribute('data-lang')); }
    else if(e.key === 'Tab') toggle(false);
  });
  sel.addEventListener('change', paint);
  // the site also sets the language by itself (browser language, ?lang=) without a change event
  setInterval(paint, 500);
  paint();
}
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
