(function(){
  function icon(text){var i=document.createElement('i');i.textContent=text;return i}
  function make(id,ico,onClick){var b=document.createElement('button');b.id=id;b.type='button';b.appendChild(icon(ico));b.appendChild(document.createElement('span'));b.onclick=function(){document.querySelectorAll('.nav button').forEach(function(x){x.classList.remove('on')});b.classList.add('on');onClick(b)};return b}
  function patch(){
    var nav=document.querySelector('.nav');var coins=document.getElementById('moedasBtn');if(!nav||!coins)return;
    // Auditoria -- pagina dedicada de transparencia da rede XLN (supply real x regra de emissao do core)
    var dash=document.getElementById('dashboardBtn');
    if(dash && !document.getElementById('auditoriaBtn')) dash.insertAdjacentElement('afterend',make('auditoriaBtn','✓',function(b){
      var title=document.querySelector('#auditoriaView .auditoriaViewTitle');
      if(title)title.textContent=b.querySelector('span').textContent;
      if(window.GalaxiaShowView)window.GalaxiaShowView('auditoria');
      if(window.GalaxiaRenderAuditoria)window.GalaxiaRenderAuditoria();
    }));
    // Mining -- its own list (like Coins), ready for mining coins in the future
    if(!document.getElementById('mineracaoBtn')) coins.insertAdjacentElement('afterend',make('mineracaoBtn','⛏',function(b){
      var title=document.querySelector('#mineracaoView .mineracaoViewTitle');
      if(title)title.textContent=b.querySelector('span').textContent;
      if(window.GalaxiaShowView)window.GalaxiaShowView('mineracao');
    }));
    // XLN stakes -- shown as its own list (like Coins); clicking the coin opens its dashboard
    if(!document.getElementById('stakeBtn')) document.getElementById('mineracaoBtn').insertAdjacentElement('afterend',make('stakeBtn','◈',function(b){
      var title=document.querySelector('#stakeView .stakeViewTitle');
      if(title)title.textContent=b.querySelector('span').textContent;
      if(window.GalaxiaShowView)window.GalaxiaShowView('stake');
    }));
    // Tokens (ex: S11/QTShares) -- lista propria, clicar no token abre o dashboard
    if(!document.getElementById('tokensBtn')) document.getElementById('stakeBtn').insertAdjacentElement('afterend',make('tokensBtn','⬡',function(b){
      var title=document.querySelector('#tokensView .tokensViewTitle');
      if(title)title.textContent=b.querySelector('span').textContent;
      if(window.GalaxiaShowView)window.GalaxiaShowView('tokens');
    }));
  }
  patch();
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',patch);
})();
