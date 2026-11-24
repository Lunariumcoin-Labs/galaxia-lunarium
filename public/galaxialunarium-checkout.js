// GaláxiaLunarium checkout window (checkout.html?product=<plan id>|listing_coin|listing_exchange).
// 1. Registration (+ listing details) and acceptance of the contract terms -> POST /api/v1/orders.
// 2. Payment: unique XLN amount, address, QR and countdown; the server confirms it on chain.
// 3. Ticket: contract data, API key (or listing review status), printable / savable as PDF.
// A plan paid once (lifetime) shows no period and no renewal; when it includes the coin listing and
// audit, the ticket offers the request, which is then made with the key instead of a payment.
// The order link (#order=..&token=..) is the private access to the ticket; the hash never reaches
// the server logs.
(function(){
  var params = new URLSearchParams(location.search);
  function detectLang(){
    var q = params.get('lang');
    if(q && CK_I18N[q]) return q;
    try{ var s = localStorage.getItem('galaxia_lang'); if(s && CK_I18N[s]) return s; }catch(e){}
    return 'pt-BR';
  }
  var lang = detectLang();
  var T = CK_I18N[lang];
  var P = PLAN_I18N[lang].concat(PLAN_I18N_CHECKOUT[lang]); // 0-24 plans, 25-41 payment
  var C2 = CK2_I18N[lang] || CK2_I18N.en; // listing tiers
  var CA = CK_AUDIT_I18N[lang] || CK_AUDIT_I18N.en; // priority coin listing: listing and audit
  var PC = PLANCHG_I18N[lang] || PLANCHG_I18N.en; // plan change
  var LF = LIFETIME_I18N[lang] || LIFETIME_I18N.en; // plan paid once: lifetime key, coin audit included
  var planName = function(id){ return String(id || '').replace(/^./, function(c){ return c.toUpperCase(); }); };
  function slaText(s){ return s === '48h' ? C2[8] : (/10 business/.test(s || '') ? C2[9] : (s || '')); }
  document.documentElement.lang = lang;
  document.documentElement.dir = (lang === 'ar' || lang === 'he') ? 'rtl' : 'ltr';
  document.title = 'GaláxiaLunarium · ' + T[0];

  var app = document.getElementById('app');
  var product = params.get('product');
  var plansData = null;
  var poll = null, tick = null;
  var EXPLORER_TX = 'https://explorerxln.com/tx/';

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); }
  function nf(v, d){ return Number(v).toLocaleString(lang, { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
  function fmtDate(s){ return new Date(s).toLocaleDateString(lang, { year:'numeric', month:'long', day:'numeric' }); }
  function fmtDateTime(s){ return new Date(s).toLocaleString(lang); }
  function stopTimers(){ if(poll){ clearInterval(poll); poll = null; } if(tick){ clearInterval(tick); tick = null; } }
  // #order=<id>&token=<token> (ticket link) or just #order=<id> for the signed-in owner (account panel)
  function readHash(){
    var h = new URLSearchParams(location.hash.slice(1));
    return h.get('order') ? { id: h.get('order'), token: h.get('token') || '' } : null;
  }
  var me = null; // signed-in account (GaláxiaLunarium panel), if any
  var meKeys = []; // its API keys

  function setHash(o){
    history.replaceState(null, '', location.pathname + '?lang=' + encodeURIComponent(lang) + '#order=' + encodeURIComponent(o.id) + '&token=' + encodeURIComponent(o.token));
  }
  function steps(active){
    return '<ol class=steps>' + [T[1], T[2], T[3]].map(function(s, i){
      return '<li class="' + (i < active ? 'done' : i === active ? 'on' : '') + '"><span>' + (i + 1) + '</span>' + esc(s) + '</li>';
    }).join('') + '</ol>';
  }
  function copyRow(value, big){
    return '<div class=row><code' + (big ? ' class=big' : '') + '>' + esc(value) + '</code><button type=button class="btn ghost copy noPrint" data-copy="' + esc(value) + '">' + esc(P[36]) + '</button></div>';
  }
  function wireCopy(){
    Array.prototype.forEach.call(app.querySelectorAll('.copy'), function(b){
      b.onclick = function(){
        var v = b.getAttribute('data-copy');
        if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(function(){
          b.textContent = P[37]; setTimeout(function(){ b.textContent = P[36]; }, 1500);
        }, function(){});
      };
    });
  }
  function loadQr(cb){
    if(window.QRCode) return cb();
    var s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    s.onload = cb;
    document.head.appendChild(s);
  }

  // ---- product catalogue (live prices from /api/v1/plans)
  function info(id){
    if(!plansData) return null;
    var p = plansData.plans.filter(function(x){ return x.id === id && x.requires_key; })[0];
    if(p){
      var life = !!p.lifetime;
      var limits = function(s){ return s.replace('{min}', nf(p.per_minute)).replace('{month}', nf(p.per_month)); };
      return { id: id, kind:'api', name:'API ' + p.name, xln: p.price_xln != null ? p.price_xln : p.price_xln_month, usd: p.price_usd != null ? p.price_usd : p.price_usd_month,
        per: life ? '' : P[23], lifetime: life, audit: !!p.includes_coin_audit, available: true,
        desc: life ? (p.includes_coin_audit ? limits(LF[3]) : nf(p.per_minute) + ' ' + P[3] + ' · ' + nf(p.per_month) + ' ' + P[4] + ' · ' + LF[1]) : limits(T[32]) };
    }
    var l = (plansData.listings || []).filter(function(x){ return x.id === id; })[0];
    if(l){
      var std = l.tier === 'standard';
      return { id: id, kind:'listing', type: l.type, tier: l.tier, free: !!l.free, sla: l.review_deadline, xln: l.price_xln, usd: l.price_usd, per:'', available: l.available,
        name: l.type === 'exchange' ? (std ? C2[1] : C2[3]) : (std ? C2[0] : CA[0]),
        desc: std ? C2[4] : (l.type === 'exchange' ? T[34] : T[33]) + ' ' + C2[5].replace('{sla}', slaText(l.review_deadline)) + (l.type === 'exchange' ? '' : ' ' + CA[1]) };
    }
    return null;
  }
  function priceHtml(p){
    if(p.included) return '<div class=price>' + esc(LF[7]) + '</div>';
    if(p.free) return '<div class=price>' + esc(C2[10]) + '</div>';
    if(!p.available) return '<div class=price>' + esc(P[38]) + '</div>';
    return '<div class=price>' + nf(p.xln) + ' XLN<small>' + esc(p.per) + '</small></div><div class=mut style="font-size:13px;text-align:end">≈ US$ ' + nf(p.usd, 2) + (p.lifetime ? ' · ' + esc(LF[0]) : '') + '</div>';
  }
  // opt.lifetime: plan paid once; opt.included: listing and audit included in a plan (nothing is paid)
  function termsList(kind, tier, sla, opt){
    opt = opt || {};
    var items = [];
    if(tier !== 'standard' && !opt.included) items.push(T[36]);
    if(kind === 'api') items.push(opt.lifetime ? LF[4] : T[37]);
    else if(tier === 'standard') items.push(C2[7]);
    else {
      items.push(T[38]);
      items.push(C2[5].replace('{sla}', slaText(sla)));
      if(!opt.included) items.push(plansData && plansData.listing_rules && /refunded/.test(plansData.listing_rules) ? T[39] : C2[6]);
    }
    items.push(T[40]);
    return '<ol>' + items.map(function(x){ return '<li>' + esc(x) + '</li>'; }).join('') + '</ol>';
  }

  // ---- step 0: no product chosen
  function renderChooser(){
    var ids = plansData.plans.filter(function(x){ return x.requires_key; }).map(function(x){ return x.id; }).concat((plansData.listings || []).map(function(x){ return x.id; }));
    app.innerHTML = '<div class=card><h1>' + esc(T[0]) + '</h1><p class="mut mini">' + esc(P[1]) + '</p><div class=choose>' +
      ids.map(function(id){
        var p = info(id);
        if(!p) return '';
        return '<a href="checkout.html?product=' + id + '&lang=' + encodeURIComponent(lang) + '"><b>' + esc(p.name) + '</b>' +
          (p.free ? esc(C2[10]) : p.available ? nf(p.xln) + ' XLN' + esc(p.per) + (p.lifetime ? ' · ' + esc(LF[0]) : '') : esc(P[38])) + '</a>';
      }).join('') + '</div></div>';
  }

  // ---- step 1: registration
  function fld(id, label, o){
    o = o || {};
    var input = o.multi
      ? '<textarea id="' + id + '" rows=3 maxlength=' + (o.max || 800) + '></textarea>'
      : '<input id="' + id + '" type="' + (o.type || 'text') + '" maxlength=' + (o.max || 120) + (o.ph ? ' placeholder="' + esc(o.ph) + '"' : '') + ' autocomplete="' + (o.ac || 'off') + '">';
    return '<label class="fld' + (o.full ? ' full' : '') + '"><span>' + esc(label) + (o.req ? ' *' : '') + '</span>' + input + '</label>';
  }
  var LISTING_FORM = {
    coin: [['name', 15, { req:1, max:60 }], ['symbol', 16, { req:1, max:15 }], ['website', 17, { req:1, type:'url', ph:'https://' }], ['explorer', 18, { type:'url', ph:'https://' }],
      ['source_code', 19, { type:'url', ph:'https://github.com/…' }], ['network', 20, { max:60 }], ['contract', 21, { max:100 }], ['logo', 23, { type:'url', ph:'https://' }],
      ['markets', 22, { req:1, multi:1, full:1 }], ['description', 24, { multi:1, full:1 }]],
    exchange: [['name', 26, { req:1, max:60 }], ['website', 17, { req:1, type:'url', ph:'https://' }], ['api_docs', 27, { req:1, type:'url', ph:'https://' }], ['pairs', 28, { max:12 }],
      ['logo', 23, { type:'url', ph:'https://' }], ['markets', 29, { multi:1, full:1 }], ['description', 24, { multi:1, full:1 }]]
  };

  function renderRegistration(p){
    stopTimers();
    var savedKey = '';
    try{ savedKey = localStorage.getItem('galaxia_api_key') || ''; }catch(e){}
    var needWallet = p.kind === 'listing' && !p.included && /refunded/.test(plansData.listing_rules || '');
    var html = '<div class=card>' + steps(0) +
      '<div class=prod><div><h1>' + esc(p.name) + '</h1><p class="mut mini" style="max-width:520px">' + esc(p.desc) + '</p></div><div>' + priceHtml(p) + '</div></div>';
    if(!p.available){ app.innerHTML = html + '<p class=err>' + esc(T[62]) + '</p></div>'; return; }
    html += '<h2>' + esc(T[1]) + '</h2><div class=grid>' +
      fld('c_name', T[4], { req:1, max:80, ac:'name' }) + fld('c_email', T[5], { req:1, type:'email', ac:'email' }) +
      fld('c_company', T[6], { max:80, ac:'organization' }) + fld('c_contact', T[7], { max:80 }) +
      fld('c_country', T[8], { max:60, ac:'country-name' }) + (needWallet ? fld('c_wallet', T[9], { req: 1, max:40, ph:'L…' }) : '') + '</div>';
    if(p.kind === 'listing'){
      html += '<h2>' + esc(p.type === 'coin' ? T[14] : T[25]) + '</h2><div class=grid>' +
        LISTING_FORM[p.type].map(function(f){ return fld('l_' + f[0], T[f[1]], f[2]); }).join('') + '</div>';
    }
    var renewId = params.get('renew');
    var changeFrom = params.get('from');
    if(p.lifetime){
      // paid once: always a new key, nothing to renew or change
    }else if(p.kind === 'api' && renewId && changeFrom && changeFrom !== p.id){
      // plan change started from the account panel
      html += '<label class=check><input type=checkbox id=renew checked><span>' + esc(PC[5].replace('{plan}', planName(changeFrom))) + '</span></label><p class="mut mini">' + esc(PC[4]) + '</p>';
    }else if(p.kind === 'api' && (renewId || savedKey)) html += '<label class=check><input type=checkbox id=renew checked><span>' + esc(P[27]) + '</span></label>';
    html += '<p class="mut mini">' + esc(T[10]) + '</p>' +
      '<div class=terms><b>' + esc(T[35]) + '</b>' + termsList(p.kind, p.tier, p.sla, { lifetime: p.lifetime, included: p.included }) + '</div>' +
      '<label class=check><input type=checkbox id=accept><span>' + esc(T[11]) + '</span></label>' +
      '<p class=err id=err></p><div class=actions><button type=button class=btn id=go>' + esc(p.free || p.included ? C2[11] : T[12]) + '</button>' +
      '<a class="btn ghost" href="/" style="text-decoration:none">' + esc(T[63]) + '</a></div></div>';
    app.innerHTML = html;
    if(me){ // prefill the registration from the signed-in account
      var pre = { c_name: me.name, c_email: me.email, c_company: me.company };
      Object.keys(pre).forEach(function(id){ var el = document.getElementById(id); if(el && pre[id]) el.value = pre[id]; });
    }
    var val = function(id){ var el = document.getElementById(id); return el ? el.value.trim() : ''; };
    document.getElementById('go').onclick = function(){
      var err = document.getElementById('err');
      var body = {
        product: p.id,
        lang: lang,
        accept_terms: document.getElementById('accept').checked,
        customer: { name: val('c_name'), email: val('c_email'), company: val('c_company'), contact: val('c_contact'), country: val('c_country'), wallet: val('c_wallet') }
      };
      var missing = !body.customer.name || !body.customer.email || (needWallet && !body.customer.wallet);
      if(p.kind === 'listing'){
        body.listing = {};
        LISTING_FORM[p.type].forEach(function(f){ body.listing[f[0]] = val('l_' + f[0]); if(f[2].req && !body.listing[f[0]]) missing = true; });
      }
      if(missing){ err.textContent = T[58]; return; }
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.customer.email)){ err.textContent = T[59]; return; }
      if(!body.accept_terms){ err.textContent = T[60]; return; }
      var renew = document.getElementById('renew');
      if(renew && renew.checked){ if(renewId) body.renew_key_id = renewId; else body.renew_key = savedKey; }
      // listing and audit included in the plan: asked with the key, no payment
      if(p.included && p.credit){ if(p.credit.id) body.plan_key_id = p.credit.id; else body.plan_key = p.credit.key; }
      var btn = this;
      btn.disabled = true;
      err.textContent = '';
      fetch('/api/v1/orders', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(body) })
        .then(function(r){ return r.json(); })
        .then(function(d){
          if(!d || !d.ok){ err.textContent = serverError(d && d.error); btn.disabled = false; return; }
          var ref = { id: d.data.order_id, token: d.data.token };
          setHash(ref);
          renderOrder(d.data, ref);
        })
        .catch(function(e){ err.textContent = String(e); btn.disabled = false; });
    };
  }
  function serverError(msg){
    msg = String(msg || '');
    if(/e-mail/.test(msg)) return T[59];
    if(/wallet address is invalid/.test(msg)) return T[61];
    if(/terms/.test(msg)) return T[60];
    if(/not available/.test(msg) || /no coin audit to use/.test(msg)) return T[62];
    if(/required|listing field/.test(msg)) return T[58] + ' (' + msg + ')';
    return msg;
  }

  // ---- steps 2 and 3: payment and ticket
  function productName(o){
    if(o.kind === 'listing'){
      var std = o.tier === 'standard';
      return o.listing_type === 'exchange' ? (std ? C2[1] : C2[3]) : (std ? C2[0] : CA[0]);
    }
    var pl = plansData && plansData.plans.filter(function(x){ return x.id === o.plan; })[0];
    return 'API ' + (pl ? pl.name : String(o.plan || '').replace(/^./, function(ch){ return ch.toUpperCase(); }));
  }
  function renderOrder(o, ref){
    if(o.status === 'paid' || o.status === 'registered') return renderTicket(o, ref);
    var open = o.status === 'pending' || o.status === 'confirming';
    var html = '<div class=card>' + steps(1) +
      '<div class=prod><div><h1>' + esc(productName(o)) + '</h1><p class="mut mini">' + esc(T[66]) + ' #' + esc(o.order_id) + '</p></div>' +
      '<div class=price>' + nf(o.amount_xln, 4) + ' XLN<div class=mut style="font-size:13px;font-weight:600">≈ US$ ' + nf(o.price_usd, 2) + '</div></div></div>';
    if(o.status === 'expired'){
      html += '<p class=err>' + esc(P[35]) + '</p><div class=actions><a class=btn style="text-decoration:none" href="checkout.html?product=' + encodeURIComponent(o.product) + '&lang=' + encodeURIComponent(lang) + '">' + esc(P[40]) + '</a></div></div>';
      app.innerHTML = html;
      stopTimers();
      return;
    }
    html += '<span class=lbl>' + esc(P[29]) + '</span>' + copyRow(Number(o.amount_xln).toFixed(4), true) +
      '<span class=lbl>' + esc(P[30]) + '</span>' + copyRow(o.pay_to) +
      '<div class=qr id=qr></div>' +
      '<p class=mini>' + esc(P[31]) + '</p>' +
      '<p class=status>' + esc(o.status === 'confirming' ? P[33].replace('{n}', o.confirmations).replace('{t}', o.confirmations_required) : P[32]) +
      (o.status === 'pending' ? ' · ' + esc(P[15]) + ' <span id=left></span>' : '') + '</p>' +
      '<p class="mut mini">' + esc(T[57]) + '</p></div>';
    app.innerHTML = html;
    wireCopy();
    loadQr(function(){ var q = document.getElementById('qr'); if(q && window.QRCode) new QRCode(q, { text: o.pay_to, width: 150, height: 150 }); });
    if(tick) clearInterval(tick);
    var ends = Date.parse(o.expires_at);
    var t = function(){
      var el = document.getElementById('left');
      if(!el) return;
      var s = Math.max(0, Math.round((ends - Date.now()) / 1000));
      el.textContent = Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
    };
    t();
    tick = setInterval(t, 1000);
    if(open && !poll) startPolling(ref, 15000);
  }

  function statusBadge(s){
    var map = { under_review: [T[51], 'var(--amber)'], approved: [T[52], 'var(--cyan)'], listed: [T[53], 'var(--green)'], rejected: [T[54], 'var(--red)'] };
    var m = map[s] || [s, 'var(--mut)'];
    return '<span class=badge style="color:' + m[1] + ';border-color:' + m[1] + '">' + esc(m[0]) + '</span>';
  }
  function renderTicket(o, ref){
    if(tick){ clearInterval(tick); tick = null; }
    var c = o.customer || {};
    if(o.api_key){ try{ if(localStorage.getItem('galaxia_api_key') !== o.api_key) localStorage.setItem('galaxia_api_key', o.api_key); }catch(e){} }
    var cust = [c.name, c.company, c.email, c.contact, c.country].filter(Boolean).map(esc).join('<br>') + (c.wallet ? '<br><span class=mut>XLN: ' + esc(c.wallet) + '</span>' : '');
    var html = '<div class=card>' + '<div class=noPrint>' + steps(2) + '</div>' +
      '<div class=tkHead><img src="galaxialunarium-logo.png" alt=""><div class=who><b>GaláxiaLunarium</b><span class=mut>' + esc(T[42]) + '</span></div>' +
      '<div class=tkNo><span class=mut>' + esc(T[41]) + '</span><b>' + esc(o.ticket || '—') + '</b></div></div>' +
      '<div class=tkGrid>' +
        '<div><label>' + esc(T[43]) + '</label>' + esc(fmtDateTime(o.paid_at)) + '</div>' +
        '<div><label>' + esc(T[66]) + '</label>#' + esc(o.order_id) + '</div>' +
        '<div><label>' + esc(T[45]) + '</label>' + esc(productName(o)) + '</div>' +
        '<div><label>' + esc(T[46]) + '</label>' + (o.included_in_plan ? esc(LF[7]) : o.free ? esc(C2[10]) : nf(o.paid_xln || o.amount_xln, 4) + ' XLN <span class=mut>(≈ US$ ' + nf(o.price_usd, 2) + ')</span>') + '</div>' +
        '<div><label>' + esc(T[44]) + '</label>' + cust + '</div>' +
        (o.txid ? '<div><label>' + esc(T[47]) + '</label><a href="' + EXPLORER_TX + encodeURIComponent(o.txid) + '" target=_blank rel=noopener>' + esc(String(o.txid).slice(0, 16)) + '…</a></div>' : '') +
        (o.kind === 'listing'
          ? '<div><label>' + esc(T[50]) + '</label>' + statusBadge(o.listing_status) + (o.listing_note ? '<br>' + esc(o.listing_note) : '') +
            (o.refund_txid ? '<br>' + esc(T[55]) + ': <a href="' + EXPLORER_TX + encodeURIComponent(o.refund_txid) + '" target=_blank rel=noopener>' + esc(o.refund_txid.slice(0, 16)) + '…</a>' : '') + '</div>'
          : '<div><label>' + esc(T[48]) + '</label>' + (o.lifetime && !o.renewal ? esc(LF[1]) + ' · ' + esc(LF[0]) : esc(fmtDate(o.paid_at)) + ' ' + esc(T[49]) + ' ' + esc(o.key_expires_at ? fmtDate(o.key_expires_at) : '—')) + '</div>') +
      '</div>';
    if(o.kind === 'listing'){
      if(o.listing_status === 'under_review') html += '<p class=ok style="margin-top:16px">' + esc(T[64]) + '</p>';
      if(o.listing){
        var form = LISTING_FORM[o.listing_type] || [];
        html += '<div class=tkGrid style="margin-top:8px">' + form.filter(function(f){ return o.listing[f[0]]; }).map(function(f){
          return '<div><label>' + esc(T[f[1]]) + '</label>' + esc(o.listing[f[0]]).replace(/\n/g, '<br>') + '</div>';
        }).join('') + '</div>';
      }
    }else if(o.renewal && o.plan_change_from){
      html += '<p class=ok style="margin-top:16px">' + esc(PC[6].replace('{plan}', planName(o.plan)).replace('{date}', o.key_expires_at ? fmtDate(o.key_expires_at) : '—')) + '</p>';
    }else if(o.renewal){
      html += '<p class=ok style="margin-top:16px">' + esc(P[39].replace('{date}', o.key_expires_at ? fmtDate(o.key_expires_at) : '—')) + '</p>';
    }else{
      html += '<span class=lbl>' + esc(T[65]) + '</span>' + (o.api_key ? copyRow(o.api_key, true) : '<p class=mut>—</p>') + '<p class=ok>' + esc(P[34]) + '</p>';
      // the plan includes the listing and audit of the customer's coin: requested from here, once
      if(o.includes_audit){
        html += '<p class=ok style="margin-top:12px">' + esc(LF[5]) + '</p>' + (o.coin_audit === 'available'
          ? '<div class="actions noPrint"><a class=btn style="text-decoration:none" href="checkout.html?product=listing_coin&lang=' + encodeURIComponent(lang) + '">' + esc(LF[6]) + '</a></div>' : '');
      }
    }
    html += '<div class=terms><b>' + esc(T[35]) + '</b>' + termsList(o.kind, o.tier, o.sla, { lifetime: o.lifetime && !o.renewal, included: o.included_in_plan }) + '</div>' +
      '<p class="mut mini noPrint">' + esc(T[57]) + '</p>' +
      '<div class="actions noPrint"><button type=button class=btn id=print>' + esc(T[56]) + '</button><a class="btn ghost" href="/" style="text-decoration:none">' + esc(T[63]) + '</a></div></div>';
    app.innerHTML = html;
    wireCopy();
    document.getElementById('print').onclick = function(){ window.print(); };
    // listing review status can change later; keep the ticket fresh while it is open
    stopTimers();
    if(o.kind === 'listing' && (o.listing_status === 'under_review' || o.listing_status === 'approved')) startPolling(ref, 60000);
  }

  function fetchOrder(ref){
    return fetch('/api/v1/orders/' + encodeURIComponent(ref.id), { headers: ref.token ? { 'X-Order-Token': ref.token } : {}, credentials: 'same-origin' })
      .then(function(r){ return r.json(); })
      .then(function(d){ return d && d.ok ? d.data : null; });
  }
  function startPolling(ref, ms){
    if(poll) clearInterval(poll);
    poll = setInterval(function(){ fetchOrder(ref).then(function(o){ if(o) renderOrder(o, ref); }).catch(function(){}); }, ms);
  }

  // ---- boot
  var meReq = fetch('/api/account/me', { credentials: 'same-origin' }).then(function(r){ return r.json(); }).then(function(d){ me = d && d.ok ? d.data.account : null; meKeys = (d && d.ok && d.data.keys) || []; }).catch(function(){});
  // A key whose plan includes the coin listing and audit, not used yet: a key of the signed-in
  // account (the one named in the link, if any) or the key kept in this browser.
  function findAuditCredit(){
    var wanted = params.get('plan_key_id');
    var own = meKeys.filter(function(k){ return k.state === 'active' && k.coin_audit === 'available' && (!wanted || k.id === wanted); })[0];
    if(own) return Promise.resolve({ id: own.id });
    var saved = '';
    try{ saved = localStorage.getItem('galaxia_api_key') || ''; }catch(e){}
    if(!saved) return Promise.resolve(null);
    return fetch('/api/v1/account', { headers: { 'X-API-Key': saved } }).then(function(r){ return r.json(); })
      .then(function(d){ return d && d.ok && d.data.coin_audit === 'available' ? { key: saved } : null; }).catch(function(){ return null; });
  }
  Promise.all([fetch('/api/v1/plans').then(function(r){ return r.json(); }), meReq]).then(function(res){
    var d = res[0];
    plansData = d && d.ok ? d.data : { plans: [], listings: [] };
    var ref = readHash();
    if(ref){
      fetchOrder(ref).then(function(o){
        // signed in and opened with the ticket link: keep this order in the account panel
        if(o && me && ref.token) fetch('/api/account/claim-order', { method:'POST', credentials:'same-origin', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ order_id: ref.id, token: ref.token }) }).catch(function(){});
        if(o) renderOrder(o, ref);
        else app.innerHTML = '<div class=card><p class=err>' + esc(T[62]) + '</p><a class=btn style="text-decoration:none" href="/">' + esc(T[63]) + '</a></div>';
      });
      return;
    }
    var p = product && info(product);
    if(p && p.kind === 'listing' && p.type === 'coin' && p.tier === 'priority'){
      findAuditCredit().then(function(credit){
        if(credit){ p.included = true; p.credit = credit; p.available = true; }
        renderRegistration(p);
      });
      return;
    }
    if(p) renderRegistration(p); else renderChooser();
  }).catch(function(e){ app.innerHTML = '<div class=card><p class=err>' + esc(String(e)) + '</p></div>'; });
})();
