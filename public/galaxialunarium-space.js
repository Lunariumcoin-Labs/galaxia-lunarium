// Space background of the Lunarium explorer (explorerxln.com, web/space.js): stars in 3 layers, a slowly
// rotating spiral galaxy and shooting stars. Dark theme only: with the light theme the canvas is hidden by
// CSS and nothing is drawn. The galaxy is drawn once on an offscreen canvas and only rotated each frame.
(function(){
var canvas = document.getElementById('space');
if(!canvas || !canvas.getContext) return;
var ctx = canvas.getContext('2d');
var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
var DPR = Math.min(window.devicePixelRatio || 1, 1.5);
var W = 0, H = 0, stars = [], galaxy = null, galaxy2 = null, meteors = [], raf = 0, idle = 0, t0 = performance.now();
function rand(a, b){ return a + Math.random() * (b - a); }
function light(){ return document.documentElement.getAttribute('data-theme') === 'light'; }

function makeGalaxy(size, arms, hueCore, hueArm, count){
  var c = document.createElement('canvas');
  c.width = c.height = size;
  var g = c.getContext('2d'), R = size / 2;
  var halo = g.createRadialGradient(R, R, 0, R, R, R);
  halo.addColorStop(0, 'hsla(' + hueCore + ', 90%, 80%, 0.55)');
  halo.addColorStop(0.12, 'hsla(' + hueCore + ', 80%, 60%, 0.22)');
  halo.addColorStop(0.45, 'hsla(' + hueArm + ', 70%, 45%, 0.07)');
  halo.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = halo;
  g.fillRect(0, 0, size, size);
  for(var i = 0; i < count; i++){
    var arm = i % arms, d = Math.pow(Math.random(), 1.6), r = d * R * 0.95;
    var theta = (arm / arms) * Math.PI * 2 + d * 7.2 + rand(-0.35, 0.35) * (1 - d * 0.5);
    var spread = rand(-1, 1) * (6 + 22 * d) * (size / 900);
    var x = R + Math.cos(theta) * r + spread, y = R + Math.sin(theta) * r * 0.92 + spread;
    var hue = d < 0.18 ? hueCore : hueArm + rand(-18, 18), lt = d < 0.18 ? 82 : rand(60, 82), a = (1 - d) * 0.55 + 0.08;
    g.fillStyle = 'hsla(' + hue + ', 85%, ' + lt + '%, ' + a + ')';
    var s = Math.random() < 0.02 ? 2.2 : rand(0.5, 1.4);
    g.fillRect(x, y, s, s);
  }
  var core = g.createRadialGradient(R, R, 0, R, R, R * 0.12);
  core.addColorStop(0, 'rgba(255,246,220,0.95)');
  core.addColorStop(1, 'rgba(255,210,140,0)');
  g.fillStyle = core;
  g.beginPath(); g.arc(R, R, R * 0.12, 0, Math.PI * 2); g.fill();
  return c;
}

function resize(){
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  var n = Math.round(Math.min(900, (W * H) / 2200));
  stars = [];
  for(var i = 0; i < n; i++){
    var layer = Math.random();
    stars.push({
      x: Math.random() * W, y: Math.random() * H,
      r: layer < 0.75 ? rand(0.3, 0.9) : layer < 0.96 ? rand(0.9, 1.5) : rand(1.5, 2.2),
      tw: rand(0.002, 0.006), ph: rand(0, Math.PI * 2),
      drift: layer < 0.75 ? 0.004 : layer < 0.96 ? 0.009 : 0.016,
      hue: Math.random() < 0.15 ? 40 : Math.random() < 0.3 ? 200 : 220
    });
  }
  if(!W || !H) return;
  var gs = Math.round(Math.min(1100, Math.max(320, Math.max(W, H) * 0.85)));
  galaxy = makeGalaxy(gs, 3, 42, 205, 14000);
  galaxy2 = makeGalaxy(Math.round(gs * 0.35), 2, 300, 265, 3000);
}

function draw(now){
  raf = 0;
  if(light()){ ctx.clearRect(0, 0, W, H); idle = setTimeout(function(){ idle = 0; schedule(); }, 1000); return; }
  var t = now - t0;
  if(!W || !H || !galaxy || !galaxy2){ schedule(); return; }
  ctx.clearRect(0, 0, W, H);
  var rot = reduce ? 0.6 : t * 0.0000045;
  ctx.save(); ctx.globalAlpha = 0.55; ctx.translate(W * 0.78, H * 0.3); ctx.scale(1, 0.55); ctx.rotate(rot);
  ctx.drawImage(galaxy, -galaxy.width / 2, -galaxy.height / 2); ctx.restore();
  ctx.save(); ctx.globalAlpha = 0.35; ctx.translate(W * 0.12, H * 0.82); ctx.scale(1, 0.62); ctx.rotate(-rot * 1.6 + 1.2);
  ctx.drawImage(galaxy2, -galaxy2.width / 2, -galaxy2.height / 2); ctx.restore();
  for(var i = 0; i < stars.length; i++){
    var s = stars[i];
    var y = reduce ? s.y : (s.y + t * s.drift * 0.06) % H;
    var a = reduce ? 0.8 : 0.45 + 0.55 * Math.abs(Math.sin(s.ph + t * s.tw * 0.25));
    ctx.fillStyle = 'hsla(' + s.hue + ', 80%, 92%, ' + a + ')';
    ctx.beginPath(); ctx.arc(s.x, y, s.r, 0, Math.PI * 2); ctx.fill();
    if(s.r > 1.6){ ctx.fillStyle = 'hsla(' + s.hue + ', 90%, 85%, ' + (a * 0.18) + ')'; ctx.beginPath(); ctx.arc(s.x, y, s.r * 3.2, 0, Math.PI * 2); ctx.fill(); }
  }
  if(!reduce && Math.random() < 0.004 && meteors.length < 2) meteors.push({ x: rand(W * 0.1, W), y: rand(-20, H * 0.4), vx: rand(-9, -6), vy: rand(3, 5), life: 1 });
  meteors.forEach(function(m){
    m.x += m.vx; m.y += m.vy; m.life -= 0.012;
    var grad = ctx.createLinearGradient(m.x, m.y, m.x - m.vx * 14, m.y - m.vy * 14);
    grad.addColorStop(0, 'rgba(220,240,255,' + (0.9 * m.life) + ')');
    grad.addColorStop(1, 'rgba(120,200,255,0)');
    ctx.strokeStyle = grad; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(m.x - m.vx * 14, m.y - m.vy * 14); ctx.stroke();
  });
  meteors = meteors.filter(function(m){ return m.life > 0 && m.x > -200 && m.y < H + 200; });
  if(!reduce) schedule();
}
function schedule(){ if(!raf && !idle && !document.hidden) raf = requestAnimationFrame(draw); }

resize();
var rT;
window.addEventListener('resize', function(){ clearTimeout(rT); rT = setTimeout(function(){ resize(); if(reduce) draw(performance.now()); }, 150); });
document.addEventListener('visibilitychange', function(){
  if(document.hidden){ if(raf) cancelAnimationFrame(raf); raf = 0; }
  else schedule();
});
// the theme button switches to dark again: draw at once (reduced motion draws a single frame)
new MutationObserver(function(){ if(!light()){ if(idle){ clearTimeout(idle); idle = 0; } if(reduce) draw(performance.now()); else schedule(); } })
  .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
schedule();
})();
