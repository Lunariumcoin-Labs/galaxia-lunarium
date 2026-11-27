// Phone layout (up to 820 px), like the Lunarium explorer's (owner, 2026-11-27: "the galáxia experience on
// phones is bad, that top menu just sitting there, and the side menu cannot be reached"):
// - a slim sticky bar: menu button, logo, search button (the search field opens under it on demand);
// - the side menu becomes a drawer that slides in (it used to be hidden on phones, with no way to reach it);
// - the header's other items (visitors, language, Plano Pro, documentation, Lunarium Labs, theme) move into the
//   drawer on phones and back to the header on wider screens. They are moved, not copied, so every handler
//   attached to them keeps working.
(function(){
var mq = window.matchMedia('(max-width: 820px)');
var ICON_SEARCH = '<svg viewBox="0 0 24 24" width=20 height=20 aria-hidden=true><path d="M10.5 3a7.5 7.5 0 0 1 5.9 12.1l4.2 4.2-1.4 1.4-4.2-4.2A7.5 7.5 0 1 1 10.5 3zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z" fill="currentColor"/></svg>';

function init(){
  var top = document.querySelector('.top'), side = document.querySelector('.side'), nav = side && side.querySelector('.nav');
  if(!top || !side || !nav || document.querySelector('.mBar')) return;
  side.id = side.id || 'sideNav';

  var bar = document.createElement('div');
  bar.className = 'mBar';
  bar.innerHTML =
    '<button type=button class=mIconBtn id=mMenuBtn aria-label="Menu" aria-expanded=false aria-controls="' + side.id + '"><span></span><span></span><span></span></button>' +
    '<button type=button class=mBrand id=mBrand><img src=galaxialunarium-logo.png alt="" width=32 height=32><b>Galáxia<span>Lunarium</span></b></button>' +
    '<button type=button class=mIconBtn id=mSearchBtn aria-label="Search" aria-expanded=false>' + ICON_SEARCH + '</button>';
  top.insertBefore(bar, top.firstChild);

  var extras = document.createElement('div');
  extras.className = 'mExtras';
  nav.parentNode.insertBefore(extras, nav.nextSibling);
  // the shade goes next to the drawer, inside .app: the theme gives .app its own stacking layer, so a shade
  // on <body> would sit above the drawer and swallow every tap
  var backdrop = document.createElement('div');
  backdrop.className = 'mBackdrop';
  side.parentNode.insertBefore(backdrop, side);

  var menuBtn = bar.querySelector('#mMenuBtn'), searchBtn = bar.querySelector('#mSearchBtn');
  function open(){ document.body.classList.add('navOpen'); menuBtn.setAttribute('aria-expanded', 'true'); var on = side.querySelector('.nav button.on') || side.querySelector('.nav button'); if(on) on.focus({ preventScroll: true }); }
  function close(){ if(!document.body.classList.contains('navOpen')) return; document.body.classList.remove('navOpen'); menuBtn.setAttribute('aria-expanded', 'false'); }
  menuBtn.addEventListener('click', function(){ if(document.body.classList.contains('navOpen')) close(); else open(); });
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', function(e){ if(e.key === 'Escape' && document.body.classList.contains('navOpen')){ close(); menuBtn.focus(); } });
  // choosing a screen closes the drawer (the language list and the theme button keep it open)
  side.addEventListener('click', function(e){
    if(!mq.matches || e.target.closest('.langPick') || e.target.closest('#themeBtn')) return;
    if(e.target.closest('.nav button, #visitorBadge, .mExtras .btn')) setTimeout(close, 0);
  });
  bar.querySelector('#mBrand').addEventListener('click', function(){ var d = document.getElementById('dashboardBtn'); if(d) d.click(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  searchBtn.addEventListener('click', function(){
    var openNow = !top.classList.contains('mSearchOpen');
    top.classList.toggle('mSearchOpen', openNow);
    searchBtn.setAttribute('aria-expanded', String(openNow));
    if(openNow){ var inp = top.querySelector('.search input'); if(inp) inp.focus(); }
  });

  // move the header's items between the header and the drawer
  var moved = [];
  function place(){
    if(mq.matches){
      if(moved.length) return;
      Array.prototype.slice.call(top.children).forEach(function(n){
        if(n === bar || n.classList.contains('search')) return;
        var mark = document.createComment('m');
        top.insertBefore(mark, n);
        moved.push([n, mark]);
        extras.appendChild(n);
      });
    }else{
      moved.forEach(function(p){ p[1].parentNode.insertBefore(p[0], p[1]); p[1].parentNode.removeChild(p[1]); });
      moved = [];
      close();
      top.classList.remove('mSearchOpen');
    }
  }
  if(mq.addEventListener) mq.addEventListener('change', place); else mq.addListener(place);
  place();
}
// after langpick.js (it puts its picker next to the language select): this file loads after it
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
