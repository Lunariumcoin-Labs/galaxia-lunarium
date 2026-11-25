// Visitors: the same counter as the Lunarium explorer (explorerxln.com). No cookies: only a session id in
// sessionStorage and a "seen" flag in localStorage. The header badge shows the total and who is online now;
// a click opens the Visitors screen (?view=visitantes) with the community pulse and the globe of countries.
// The server side is backend/visits.js (POST /api/visits).
(function(){
var VIS_I18N = {"ar":{"visLive":"مباشر","visTitle":"نبض المجتمع","visPrivacy":"بلا ملفات تعريف ارتباط وبلا حفظ عناوين IP","visTotal":"إجمالي الزوار","vis7d":"الزوار في آخر 7 أيام","visOnline":"متصل الآن","visToday":"اليوم","glLabel":"انتشار عالمي","glTitle":"زوار من حول العالم","glCountries":"دولة","glHint":"اسحب للتدوير","glRank":"ترتيب الدول","glWait":"جارٍ جمع مواقع الزوار…","glLive":"النشاط المباشر","visPage":"الزوار"},"en":{"visLive":"LIVE","visTitle":"Community pulse","visPrivacy":"No cookies, no IPs stored","visTotal":"total visitors","vis7d":"Visitors in the last 7 days","visOnline":"online now","visToday":"today","glLabel":"Global reach","glTitle":"Visitors around the world","glCountries":"countries","glHint":"Drag to rotate","glRank":"Top countries","glWait":"Collecting visitor locations…","glLive":"Live activity","visPage":"Visitors"},"es":{"visLive":"EN VIVO","visTitle":"Pulso de la comunidad","visPrivacy":"Sin cookies y sin guardar IP","visTotal":"visitantes en total","vis7d":"Visitantes en los últimos 7 días","visOnline":"en línea ahora","visToday":"hoy","glLabel":"Alcance global","glTitle":"Visitantes de todo el mundo","glCountries":"países","glHint":"Arrastra para girar","glRank":"Ranking de países","glWait":"Recopilando ubicaciones de visitantes…","glLive":"Actividad en vivo","visPage":"Visitantes"},"he":{"visLive":"חי","visTitle":"הדופק של הקהילה","visPrivacy":"בלי עוגיות ובלי שמירת IP","visTotal":"סה״כ מבקרים","vis7d":"מבקרים ב-7 הימים האחרונים","visOnline":"מחוברים עכשיו","visToday":"היום","glLabel":"פריסה עולמית","glTitle":"מבקרים מכל העולם","glCountries":"מדינות","glHint":"גררו כדי לסובב","glRank":"דירוג מדינות","glWait":"אוספים את מיקומי המבקרים…","glLive":"פעילות חיה","visPage":"מבקרים"},"hi":{"visLive":"लाइव","visTitle":"समुदाय की धड़कन","visPrivacy":"न कुकी, न IP सहेजा जाता है","visTotal":"कुल आगंतुक","vis7d":"पिछले 7 दिनों के आगंतुक","visOnline":"अभी ऑनलाइन","visToday":"आज","glLabel":"वैश्विक पहुँच","glTitle":"दुनिया भर के आगंतुक","glCountries":"देश","glHint":"घुमाने के लिए खींचें","glRank":"देशों की रैंकिंग","glWait":"आगंतुकों के स्थान इकट्ठे हो रहे हैं…","glLive":"लाइव गतिविधि","visPage":"आगंतुक"},"it":{"visLive":"LIVE","visTitle":"Il polso della community","visPrivacy":"Niente cookie, nessun IP salvato","visTotal":"visitatori totali","vis7d":"Visitatori negli ultimi 7 giorni","visOnline":"online ora","visToday":"oggi","glLabel":"Portata globale","glTitle":"Visitatori da tutto il mondo","glCountries":"paesi","glHint":"Trascina per ruotare","glRank":"Classifica dei paesi","glWait":"Raccolta delle posizioni dei visitatori…","glLive":"Attività in diretta","visPage":"Visitatori"},"ja":{"visLive":"ライブ","visTitle":"コミュニティの鼓動","visPrivacy":"Cookie なし・IP は保存しません","visTotal":"累計訪問者","vis7d":"直近 7 日間の訪問者","visOnline":"現在オンライン","visToday":"今日","glLabel":"グローバル","glTitle":"世界中からの訪問者","glCountries":"か国","glHint":"ドラッグで回転","glRank":"国別ランキング","glWait":"訪問者の位置を集計中…","glLive":"リアルタイムの動き","visPage":"訪問者"},"pt-BR":{"visLive":"AO VIVO","visTitle":"Pulso da comunidade","visPrivacy":"Sem cookies e sem guardar IP","visTotal":"visitantes no total","vis7d":"Visitantes nos últimos 7 dias","visOnline":"online agora","visToday":"hoje","glLabel":"Alcance global","glTitle":"Visitantes ao redor do mundo","glCountries":"países","glHint":"Arraste para girar","glRank":"Ranking de países","glWait":"Coletando a localização dos visitantes…","glLive":"Atividade ao vivo","visPage":"Visitantes"},"ru":{"visLive":"В ЭФИРЕ","visTitle":"Пульс сообщества","visPrivacy":"Без cookies и без хранения IP","visTotal":"всего посетителей","vis7d":"Посетители за 7 дней","visOnline":"сейчас онлайн","visToday":"сегодня","glLabel":"Глобальный охват","glTitle":"Посетители со всего мира","glCountries":"стран","glHint":"Потяните, чтобы вращать","glRank":"Рейтинг стран","glWait":"Собираем данные о посетителях…","glLive":"Активность в реальном времени","visPage":"Посетители"},"zh":{"visLive":"实时","visTitle":"社区脉搏","visPrivacy":"不使用 Cookie，不保存 IP","visTotal":"访客总数","vis7d":"最近 7 天访客","visOnline":"当前在线","visToday":"今日","glLabel":"全球覆盖","glTitle":"来自世界各地的访客","glCountries":"个国家","glHint":"拖动旋转","glRank":"国家排名","glWait":"正在收集访客位置…","glLive":"实时动态","visPage":"访客"},"de":{"visLive":"LIVE","visTitle":"Puls der Community","visPrivacy":"Keine Cookies, keine gespeicherten IPs","visTotal":"Besucher insgesamt","vis7d":"Besucher der letzten 7 Tage","visOnline":"jetzt online","visToday":"heute","glLabel":"Globale Reichweite","glTitle":"Besucher aus aller Welt","glCountries":"Länder","glHint":"Zum Drehen ziehen","glRank":"Top-Länder","glWait":"Standorte der Besucher werden gesammelt…","glLive":"Live-Aktivität","visPage":"Besucher"},"fr":{"visLive":"EN DIRECT","visTitle":"Pouls de la communauté","visPrivacy":"Sans cookies, sans stocker d’IP","visTotal":"visiteurs au total","vis7d":"Visiteurs des 7 derniers jours","visOnline":"en ligne","visToday":"aujourd’hui","glLabel":"Portée mondiale","glTitle":"Visiteurs du monde entier","glCountries":"pays","glHint":"Faites glisser pour tourner","glRank":"Classement des pays","glWait":"Collecte de la position des visiteurs…","glLive":"Activité en direct","visPage":"Visiteurs"},"pl":{"visLive":"NA ŻYWO","visTitle":"Puls społeczności","visPrivacy":"Bez cookies i bez zapisywania IP","visTotal":"odwiedzających łącznie","vis7d":"Odwiedzający w ostatnich 7 dniach","visOnline":"teraz online","visToday":"dziś","glLabel":"Zasięg globalny","glTitle":"Odwiedzający z całego świata","glCountries":"krajów","glHint":"Przeciągnij, aby obrócić","glRank":"Ranking krajów","glWait":"Zbieranie lokalizacji odwiedzających…","glLive":"Aktywność na żywo","visPage":"Odwiedzający"},"vi":{"visLive":"TRỰC TIẾP","visTitle":"Nhịp đập cộng đồng","visPrivacy":"Không cookie, không lưu IP","visTotal":"tổng lượt khách","vis7d":"Khách trong 7 ngày qua","visOnline":"đang trực tuyến","visToday":"hôm nay","glLabel":"Phạm vi toàn cầu","glTitle":"Khách từ khắp thế giới","glCountries":"quốc gia","glHint":"Kéo để xoay","glRank":"Xếp hạng quốc gia","glWait":"Đang thu thập vị trí khách truy cập…","glLive":"Hoạt động trực tiếp","visPage":"Khách truy cập"},"bg":{"visLive":"НА ЖИВО","visTitle":"Пулсът на общността","visPrivacy":"Без бисквитки и без запазване на IP","visTotal":"посетители общо","vis7d":"Посетители през последните 7 дни","visOnline":"онлайн сега","visToday":"днес","glLabel":"Глобален обхват","glTitle":"Посетители от цял свят","glCountries":"държави","glHint":"Плъзнете, за да завъртите","glRank":"Класиране на държавите","glWait":"Събиране на местоположението на посетителите…","glLive":"Активност на живо","visPage":"Посетители"},"cs":{"visLive":"ŽIVĚ","visTitle":"Puls komunity","visPrivacy":"Bez cookies a bez ukládání IP","visTotal":"návštěvníků celkem","vis7d":"Návštěvníci za posledních 7 dní","visOnline":"právě online","visToday":"dnes","glLabel":"Globální dosah","glTitle":"Návštěvníci z celého světa","glCountries":"zemí","glHint":"Táhněte pro otočení","glRank":"Žebříček zemí","glWait":"Shromažďuje se poloha návštěvníků…","glLive":"Aktivita živě","visPage":"Návštěvníci"},"da":{"visLive":"LIVE","visTitle":"Fællesskabets puls","visPrivacy":"Ingen cookies, ingen gemte IP-adresser","visTotal":"besøgende i alt","vis7d":"Besøgende de sidste 7 dage","visOnline":"online nu","visToday":"i dag","glLabel":"Global rækkevidde","glTitle":"Besøgende fra hele verden","glCountries":"lande","glHint":"Træk for at dreje","glRank":"Top-lande","glWait":"Indsamler de besøgendes placering…","glLive":"Aktivitet live","visPage":"Besøgende"},"el":{"visLive":"ΖΩΝΤΑΝΑ","visTitle":"Ο παλμός της κοινότητας","visPrivacy":"Χωρίς cookies, χωρίς αποθήκευση IP","visTotal":"επισκέπτες συνολικά","vis7d":"Επισκέπτες τις τελευταίες 7 ημέρες","visOnline":"συνδεδεμένοι τώρα","visToday":"σήμερα","glLabel":"Παγκόσμια εμβέλεια","glTitle":"Επισκέπτες από όλο τον κόσμο","glCountries":"χώρες","glHint":"Σύρετε για περιστροφή","glRank":"Κατάταξη χωρών","glWait":"Συλλογή τοποθεσίας επισκεπτών…","glLive":"Ζωντανή δραστηριότητα","visPage":"Επισκέπτες"},"fi":{"visLive":"LIVE","visTitle":"Yhteisön syke","visPrivacy":"Ei evästeitä, ei tallennettuja IP-osoitteita","visTotal":"kävijää yhteensä","vis7d":"Kävijät viimeisen 7 päivän aikana","visOnline":"paikalla nyt","visToday":"tänään","glLabel":"Maailmanlaajuinen kattavuus","glTitle":"Kävijöitä ympäri maailmaa","glCountries":"maata","glHint":"Vedä kääntääksesi","glRank":"Maiden kärki","glWait":"Kerätään kävijöiden sijainteja…","glLive":"Toiminta nyt","visPage":"Kävijät"},"hr":{"visLive":"UŽIVO","visTitle":"Puls zajednice","visPrivacy":"Bez kolačića i bez spremanja IP-a","visTotal":"posjetitelja ukupno","vis7d":"Posjetitelji u zadnjih 7 dana","visOnline":"trenutačno online","visToday":"danas","glLabel":"Globalni doseg","glTitle":"Posjetitelji iz cijelog svijeta","glCountries":"zemalja","glHint":"Povucite za okretanje","glRank":"Poredak zemalja","glWait":"Prikupljanje lokacija posjetitelja…","glLive":"Aktivnost uživo","visPage":"Posjetitelji"},"hu":{"visLive":"ÉLŐ","visTitle":"A közösség pulzusa","visPrivacy":"Sütik és IP-tárolás nélkül","visTotal":"látogató összesen","vis7d":"Látogatók az elmúlt 7 napban","visOnline":"most online","visToday":"ma","glLabel":"Globális elérés","glTitle":"Látogatók a világ minden tájáról","glCountries":"ország","glHint":"Húzza a forgatáshoz","glRank":"Országok rangsora","glWait":"A látogatók helyének gyűjtése…","glLive":"Élő aktivitás","visPage":"Látogatók"},"id":{"visLive":"LANGSUNG","visTitle":"Denyut komunitas","visPrivacy":"Tanpa cookie, tanpa menyimpan IP","visTotal":"total pengunjung","vis7d":"Pengunjung 7 hari terakhir","visOnline":"online sekarang","visToday":"hari ini","glLabel":"Jangkauan global","glTitle":"Pengunjung dari seluruh dunia","glCountries":"negara","glHint":"Seret untuk memutar","glRank":"Peringkat negara","glWait":"Mengumpulkan lokasi pengunjung…","glLive":"Aktivitas langsung","visPage":"Pengunjung"},"ko":{"visLive":"실시간","visTitle":"커뮤니티 펄스","visPrivacy":"쿠키 없음, IP 저장 안 함","visTotal":"총 방문자","vis7d":"최근 7일 방문자","visOnline":"현재 접속","visToday":"오늘","glLabel":"글로벌 도달","glTitle":"전 세계의 방문자","glCountries":"개국","glHint":"드래그하여 회전","glRank":"국가 순위","glWait":"방문자 위치 수집 중…","glLive":"실시간 활동","visPage":"방문자"},"lt":{"visLive":"TIESIOGIAI","visTitle":"Bendruomenės pulsas","visPrivacy":"Be slapukų ir be IP saugojimo","visTotal":"lankytojų iš viso","vis7d":"Lankytojai per pastarąsias 7 dienas","visOnline":"dabar prisijungę","visToday":"šiandien","glLabel":"Pasaulinis pasiekiamumas","glTitle":"Lankytojai iš viso pasaulio","glCountries":"šalių","glHint":"Vilkite, kad pasuktumėte","glRank":"Šalių reitingas","glWait":"Renkamos lankytojų vietos…","glLive":"Veikla tiesiogiai","visPage":"Lankytojai"},"nl":{"visLive":"LIVE","visTitle":"Puls van de community","visPrivacy":"Geen cookies, geen opgeslagen IP’s","visTotal":"bezoekers in totaal","vis7d":"Bezoekers in de afgelopen 7 dagen","visOnline":"nu online","visToday":"vandaag","glLabel":"Wereldwijd bereik","glTitle":"Bezoekers van over de hele wereld","glCountries":"landen","glHint":"Sleep om te draaien","glRank":"Toplanden","glWait":"Locaties van bezoekers worden verzameld…","glLive":"Live activiteit","visPage":"Bezoekers"},"no":{"visLive":"DIREKTE","visTitle":"Fellesskapets puls","visPrivacy":"Ingen informasjonskapsler, ingen lagrede IP-er","visTotal":"besøkende totalt","vis7d":"Besøkende de siste 7 dagene","visOnline":"pålogget nå","visToday":"i dag","glLabel":"Global rekkevidde","glTitle":"Besøkende fra hele verden","glCountries":"land","glHint":"Dra for å rotere","glRank":"Toppland","glWait":"Samler inn besøkendes plassering…","glLive":"Aktivitet nå","visPage":"Besøkende"},"ro":{"visLive":"LIVE","visTitle":"Pulsul comunității","visPrivacy":"Fără cookie-uri, fără stocarea IP-ului","visTotal":"vizitatori în total","vis7d":"Vizitatori în ultimele 7 zile","visOnline":"online acum","visToday":"azi","glLabel":"Acoperire globală","glTitle":"Vizitatori din toată lumea","glCountries":"țări","glHint":"Trageți pentru a roti","glRank":"Clasamentul țărilor","glWait":"Se colectează locațiile vizitatorilor…","glLive":"Activitate live","visPage":"Vizitatori"},"sk":{"visLive":"NAŽIVO","visTitle":"Pulz komunity","visPrivacy":"Bez cookies a bez ukladania IP","visTotal":"návštevníkov celkom","vis7d":"Návštevníci za posledných 7 dní","visOnline":"práve online","visToday":"dnes","glLabel":"Globálny dosah","glTitle":"Návštevníci z celého sveta","glCountries":"krajín","glHint":"Potiahnutím otočíte","glRank":"Rebríček krajín","glWait":"Zbiera sa poloha návštevníkov…","glLive":"Aktivita naživo","visPage":"Návštevníci"},"sl":{"visLive":"V ŽIVO","visTitle":"Utrip skupnosti","visPrivacy":"Brez piškotkov in brez shranjevanja IP","visTotal":"obiskovalcev skupaj","vis7d":"Obiskovalci v zadnjih 7 dneh","visOnline":"zdaj na spletu","visToday":"danes","glLabel":"Globalni doseg","glTitle":"Obiskovalci z vsega sveta","glCountries":"držav","glHint":"Povlecite za vrtenje","glRank":"Lestvica držav","glWait":"Zbiranje lokacij obiskovalcev…","glLive":"Dejavnost v živo","visPage":"Obiskovalci"},"sv":{"visLive":"LIVE","visTitle":"Gemenskapens puls","visPrivacy":"Inga kakor, inga sparade IP-adresser","visTotal":"besökare totalt","vis7d":"Besökare de senaste 7 dagarna","visOnline":"online nu","visToday":"i dag","glLabel":"Global räckvidd","glTitle":"Besökare från hela världen","glCountries":"länder","glHint":"Dra för att rotera","glRank":"Toppländer","glWait":"Samlar in besökarnas platser…","glLive":"Aktivitet live","visPage":"Besökare"},"th":{"visLive":"สด","visTitle":"ชีพจรของชุมชน","visPrivacy":"ไม่มีคุกกี้ ไม่เก็บ IP","visTotal":"ผู้เยี่ยมชมทั้งหมด","vis7d":"ผู้เยี่ยมชมใน 7 วันล่าสุด","visOnline":"ออนไลน์ตอนนี้","visToday":"วันนี้","glLabel":"เข้าถึงทั่วโลก","glTitle":"ผู้เยี่ยมชมจากทั่วโลก","glCountries":"ประเทศ","glHint":"ลากเพื่อหมุน","glRank":"อันดับประเทศ","glWait":"กำลังรวบรวมตำแหน่งของผู้เยี่ยมชม…","glLive":"กิจกรรมสด","visPage":"ผู้เยี่ยมชม"},"tr":{"visLive":"CANLI","visTitle":"Topluluğun nabzı","visPrivacy":"Çerez yok, IP saklanmaz","visTotal":"toplam ziyaretçi","vis7d":"Son 7 gündeki ziyaretçiler","visOnline":"şu an çevrimiçi","visToday":"bugün","glLabel":"Küresel erişim","glTitle":"Dünyanın dört bir yanından ziyaretçiler","glCountries":"ülke","glHint":"Döndürmek için sürükleyin","glRank":"Ülke sıralaması","glWait":"Ziyaretçi konumları toplanıyor…","glLive":"Canlı etkinlik","visPage":"Ziyaretçiler"},"uk":{"visLive":"НАЖИВО","visTitle":"Пульс спільноти","visPrivacy":"Без cookie і без збереження IP","visTotal":"відвідувачів загалом","vis7d":"Відвідувачі за останні 7 днів","visOnline":"зараз онлайн","visToday":"сьогодні","glLabel":"Глобальне охоплення","glTitle":"Відвідувачі з усього світу","glCountries":"країн","glHint":"Перетягніть, щоб обертати","glRank":"Рейтинг країн","glWait":"Збираємо розташування відвідувачів…","glLive":"Активність наживо","visPage":"Відвідувачі"},"zh-TW":{"visLive":"即時","visTitle":"社群脈動","visPrivacy":"不使用 Cookie，不儲存 IP","visTotal":"訪客總數","vis7d":"最近 7 天訪客","visOnline":"目前在線","visToday":"今日","glLabel":"全球觸及","glTitle":"來自世界各地的訪客","glCountries":"個國家","glHint":"拖曳以旋轉","glRank":"國家排名","glWait":"正在收集訪客位置…","glLive":"即時動態","visPage":"訪客"}};
var VIS_API = '/api/visits';
// the site's language is the value of its language selector (coins-data's currentLang() is not global)
function visLang(){ var sel = document.getElementById('languageSelect'); return (sel && sel.value) || 'pt-BR'; }
function vt(key){ var l = visLang(); var d = VIS_I18N[l] || VIS_I18N.en; return d[key] != null ? d[key] : VIS_I18N.en[key]; }
function nf(n){ try{ return new Intl.NumberFormat(visLang()).format(n || 0); }catch(e){ return String(n || 0); } }
function regionName(cc){ try{ return new Intl.DisplayNames([visLang()], { type: 'region' }).of(cc) || cc; }catch(e){ return cc; } }
var FLAGS = 'ADAEAFAGAIALAMAOAQARASATAUAWAXAZBABBBDBEBFBGBHBIBJBLBMBNBOBQBRBSBTBVBWBYBZCACCCDCFCGCHCICKCLCMCNCOCPCRCUCVCWCXCYCZDEDGDJDKDMDODZECEEEGEHERESETEUFIFJFKFMFOFRGAGBGDGEGFGGGHGIGLGMGNGPGQGRGSGTGUGWGYHKHMHNHRHTHUICIDIEILIMINIOIQIRISITJEJMJOJPKEKGKHKIKMKNKPKRKWKYKZLALBLCLILKLRLSLTLULVLYMAMCMDMEMFMGMHMKMLMMMNMOMPMQMRMSMTMUMVMWMXMYMZNANCNENFNGNINLNONPNRNUNZOMPAPCPEPFPGPHPKPLPMPNPRPSPTPWPYQARERORSRURWSASBSCSDSESGSHSISJSKSLSMSNSOSRSSSTSVSXSYSZTCTDTFTGTHTJTKTLTMTNTOTRTTTVTWTZUAUGUMUNUSUYUZVAVCVEVGVIVNVUWFWSXKXXYEYTZAZMZW';
// flag images (flag-icons, MIT): flag emoji do not render on Windows
function flag(cc){
  var c = String(cc || '').toUpperCase();
  for(var i = 0; i < FLAGS.length; i += 2) if(FLAGS.substr(i, 2) === c) return '<img class=glFlagImg src="flags/' + c.toLowerCase() + '.svg" alt="" width=22 height=16>';
  return '<span class=glFlagImg>🌐</span>';
}

// ---- tracking
var sid = null, counted = false, last = null, listeners = [];
function post(a, extra){
  var body = { a: a, sid: sid || '' };
  if(extra) for(var k in extra) body[k] = extra[k];
  return fetch(VIS_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' })
    .then(function(r){ return r.json(); })
    .then(function(r){ if(r && r.ok){ last = r; listeners.forEach(function(fn){ fn(r); }); } return r; })
    .catch(function(){ return null; });
}
function startVisits(){
  // automated browsers (bots that run JavaScript) are not counted
  try{ if(navigator.webdriver) return; }catch(e){}
  var id = null;
  try{ id = sessionStorage.getItem('galaxia_sid'); }catch(e){}
  if(!id){
    id = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    try{ sessionStorage.setItem('galaxia_sid', id); }catch(e){}
  }
  // a visitor counts after a real tap/click/key press or 10 s with the page visible (bots leave in ~3 s)
  var evs = ['pointerdown', 'touchstart', 'keydown', 'wheel'], shown = 0;
  var timer = setInterval(function(){ if(!document.hidden && ++shown >= 10) go(); }, 1000);
  function onInput(e){ if(e.isTrusted) go(); }
  function go(){
    if(counted) return;
    counted = true;
    clearInterval(timer);
    evs.forEach(function(ev){ removeEventListener(ev, onInput, true); });
    sid = id;
    var isNew = '1';
    try{ if(localStorage.getItem('galaxia_seen')) isNew = '0'; else localStorage.setItem('galaxia_seen', '1'); }catch(e){}
    post('hit', { 'new': isNew });
    setInterval(function(){ if(!document.hidden) post('beat'); }, 45000);
  }
  evs.forEach(function(ev){ addEventListener(ev, onInput, { capture: true, passive: true }); });
}

// ---- header badge
function paintBadge(r){
  var v = document.getElementById('visitorCountValue'), o = document.getElementById('visitorOnlineValue'), w = document.getElementById('visitorOnlineWord'), b = document.getElementById('visitorBadge');
  if(v) v.textContent = nf(r.total);
  if(o) o.textContent = nf(Math.max(1, r.online));
  if(w) w.textContent = vt('visOnline');
  if(b) b.title = nf(r.total) + ' ' + vt('visTotal') + ' · ' + nf(Math.max(1, r.online)) + ' ' + vt('visOnline') + ' · ' + nf(r.today) + ' ' + vt('visToday');
}
listeners.push(paintBadge);

// ---- Visitors screen
var ICON_GLOBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18"/></svg>';
var ICON_USER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>';
var ICON_CAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
var cur = { vTotal: 0, vOnline: 0, vToday: 0 }, globe = null, pollTimer = null, mounted = false;
function viewOpen(){ var v = document.getElementById('visitantesView'); return !!(v && v.classList.contains('show')); }
function renderVisitors(){
  var app = document.getElementById('visApp');
  if(!app) return;
  var title = document.querySelector('.visitantesViewTitle');
  if(title) title.textContent = vt('visPage');
  if(globe){ globe.destroy(); globe = null; }
  cur = { vTotal: 0, vOnline: 0, vToday: 0 };
  app.innerHTML =
    '<section class="visStrip glass">' +
      '<div class=visHead><span class=visLive><span class=liveDot></span>' + vt('visLive') + '</span><span class=visTitle>' + vt('visTitle') + '</span><span class=visPriv>' + vt('visPrivacy') + '</span></div>' +
      '<div class=visGrid>' +
        '<div class="visCell visBig"><div class=visIco>' + ICON_GLOBE + '</div><div class=visTxt><b id=vTotal>—</b><span>' + vt('visTotal') + '</span></div><svg id=vSpark viewBox="0 0 120 36" preserveAspectRatio="none" aria-label="' + vt('vis7d') + '"></svg></div>' +
        '<div class=visCell><div class="visIco green">' + ICON_USER + '</div><div class=visTxt><b id=vOnline>—</b><span>' + vt('visOnline') + '</span></div></div>' +
        '<div class=visCell><div class="visIco gold">' + ICON_CAL + '</div><div class=visTxt><b id=vToday>—</b><span>' + vt('visToday') + '</span></div></div>' +
      '</div>' +
    '</section>' +
    '<section class="glCard glass" id=globeSec>' +
      '<div class=glLeft>' +
        '<div class=glHead><div><div class=eyebrow>' + vt('glLabel') + '</div><h2 class=glTitle>' + vt('glTitle') + '</h2></div><div class=glKpi><b id=glNC>0</b><span>' + vt('glCountries') + '</span></div></div>' +
        '<div class=glStage><canvas id=glCanvas aria-label="' + vt('glTitle') + '"></canvas><div class=glHint>' + vt('glHint') + '</div></div>' +
      '</div>' +
      '<div class=glRight>' +
        '<h3 class=glH3><span class=liveDot></span>' + vt('glRank') + '</h3>' +
        '<div id=glRank class=glRank><div class=glSoft>' + vt('glWait') + '</div></div>' +
        '<h3 class=glH3>' + vt('glLive') + '</h3>' +
        '<div id=glFeed class=glFeed></div>' +
      '</div>' +
    '</section>';
  loadGlobeData(function(G){
    if(!viewOpen()) return;
    globe = createGlobe(document.getElementById('globeSec'), G);
    if(last) globe.apply(last);
  });
  if(last) paintStrip(last);
  post('read');
}
function tween(id, to){
  var el = document.getElementById(id);
  if(!el) return;
  var from = cur[id] || 0, t0 = performance.now();
  function step(now){
    var p = Math.min(1, (now - t0) / 1000), e = 1 - Math.pow(1 - p, 3);
    el.textContent = nf(Math.round(from + (to - from) * e));
    if(p < 1) requestAnimationFrame(step); else cur[id] = to;
  }
  requestAnimationFrame(step);
}
function spark(arr){
  var sv = document.getElementById('vSpark');
  if(!sv || !arr || arr.length < 2) return;
  var mx = Math.max.apply(null, [1].concat(arr)), n = arr.length;
  var pts = arr.map(function(v, i){ return [i * (120 / (n - 1)), 32 - (v / mx) * 28]; });
  var l = 'M' + pts.map(function(p){ return p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' L');
  sv.innerHTML = '<defs><linearGradient id=visGrad x1=0 y1=0 x2=0 y2=1><stop offset=0 stop-color="#1fa3c2" stop-opacity=".4"/><stop offset=1 stop-color="#1fa3c2" stop-opacity=0 /></linearGradient></defs><path d="' + l + ' L120 36 L0 36Z" fill="url(#visGrad)"/><path d="' + l + '" fill=none stroke="#32b9d6" stroke-width=1.6 vector-effect=non-scaling-stroke /><circle cx="' + pts[n - 1][0].toFixed(1) + '" cy="' + pts[n - 1][1].toFixed(1) + '" r=2.4 fill="#6fe3f7"/>';
}
function paintStrip(r){
  if(!document.getElementById('vTotal')) return;
  tween('vTotal', r.total); tween('vOnline', Math.max(1, r.online)); tween('vToday', r.today); spark(r.series);
  if(globe) globe.apply(r);
}
listeners.push(function(r){ if(viewOpen()) paintStrip(r); });

var globeData = null, globeLoading = [];
function loadGlobeData(cb){
  if(globeData) return cb(globeData);
  globeLoading.push(cb);
  if(globeLoading.length > 1) return;
  var s = document.createElement('script');
  s.src = 'galaxialunarium-globe-data.js?v=1';
  s.onload = function(){ globeData = window.GALAXIA_GLOBE; var q = globeLoading; globeLoading = []; q.forEach(function(f){ f(globeData); }); };
  document.head.appendChild(s);
}

function openVisitors(){
  if(window.GalaxiaShowView) window.GalaxiaShowView('visitantes');
  // no menu button belongs to this screen: none stays highlighted
  document.querySelectorAll('.nav button.on').forEach(function(btn){ btn.classList.remove('on'); });
  renderVisitors();
  if(!pollTimer) pollTimer = setInterval(function(){
    if(!viewOpen()){ clearInterval(pollTimer); pollTimer = null; if(globe){ globe.destroy(); globe = null; } return; }
    if(!document.hidden) post('read');
  }, 8000);
}
window.GalaxiaOpenVisitors = openVisitors;

function init(){
  var badge = document.getElementById('visitorBadge');
  if(badge){
    badge.setAttribute('role', 'button');
    badge.setAttribute('tabindex', '0');
    badge.onclick = openVisitors;
    badge.onkeydown = function(e){ if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); openVisitors(); } };
  }
  // redraw in a new language: picked by the visitor (change event) or set by the site's own detection
  // (it writes the selector's value without an event), so the value is also watched
  var shownLang = visLang();
  function langChanged(){
    var l = visLang();
    if(l === shownLang) return;
    shownLang = l;
    if(last) paintBadge(last);
    if(viewOpen()) renderVisitors();
  }
  var sel = document.getElementById('languageSelect');
  if(sel) sel.addEventListener('change', function(){ setTimeout(langChanged, 60); });
  setInterval(langChanged, 1000);
  startVisits();
  post('read');
  setInterval(function(){ if(!document.hidden && !viewOpen()) post('read'); }, 60000);
}
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

// ---- the dot globe (from the explorer, adapted from the lunariumcoin.com globe)
function createGlobe(sec, GLD){
  var cv = sec.querySelector('#glCanvas'), ctx = cv.getContext('2d');
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var bin = atob(GLD.dots), N = bin.length / 6;
  var dv = new DataView(new ArrayBuffer(bin.length));
  for(var i = 0; i < bin.length; i++) dv.setUint8(i, bin.charCodeAt(i));
  var DLon = new Float32Array(N), sinP = new Float32Array(N), cosP = new Float32Array(N), DCC = new Array(N), byNum = {};
  for(var a in GLD.A2N) byNum[GLD.A2N[a]] = a;
  for(i = 0; i < N; i++){
    var la = (dv.getInt16(i * 6, true) / 50) * Math.PI / 180, lo = (dv.getInt16(i * 6 + 2, true) / 50) * Math.PI / 180;
    DLon[i] = lo; sinP[i] = Math.sin(la); cosP[i] = Math.cos(la); DCC[i] = byNum[dv.getUint16(i * 6 + 4, true)] || '';
  }
  var W = 0, H = 0, R = 0, dpr = 1, lam = -0.9, phi = 0.35, vLam = 0.0035, drag = false, lastX = 0, lastY = 0, focus = null, focusUntil = 0;
  var data = { countries: [], live: [], occ: {}, ncountries: 0 }, level = {}, rings = [], seen = {}, first = true, tFetch = 0, raf = 0, dead = false;
  var rankEl = sec.querySelector('#glRank'), feedEl = sec.querySelector('#glFeed');
  var light = function(){ return document.documentElement.getAttribute('data-theme') === 'light'; };
  function resize(){
    var r = cv.getBoundingClientRect();
    W = Math.max(200, r.width); H = W; dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.height = H + 'px'; R = W * 0.43;
  }
  function renderRank(){
    var c = data.countries, tot = 0;
    c.forEach(function(x){ tot += x.u; });
    sec.querySelector('#glNC').textContent = nf(data.ncountries || 0);
    if(!c.length){ rankEl.innerHTML = '<div class=glSoft>' + vt('glWait') + '</div>'; return; }
    var mx = c[0].u || 1;
    rankEl.innerHTML = c.slice(0, 8).map(function(x, i){
      var pct = tot ? (x.u / tot) * 100 : 0;
      return '<button class=glRow data-cc="' + x.cc + '"><span class=glN>' + (i + 1) + '</span><span class=glFlag>' + flag(x.cc) + '</span><span class=glName>' + regionName(x.cc) + '</span><span class=glBar><i style="width:' + Math.max(4, (x.u / mx) * 100).toFixed(1) + '%"></i></span><span class=glVal>' + nf(x.u) + '<em>' + pct.toFixed(pct < 10 ? 1 : 0) + '%</em></span></button>';
    }).join('');
  }
  function agoS(s){ s = Math.max(0, Math.round(s)); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h'; }
  function renderFeed(){
    var now = (performance.now() - tFetch) / 1000;
    feedEl.innerHTML = (data.live || []).slice(0, 5).map(function(e){ return '<div class=glEv><span class=glEvDot></span><span class=glFlag>' + flag(e.cc) + '</span><span class=glEvN>' + regionName(e.cc) + '</span><span class=glEvT>' + agoS(e.age + now) + '</span></div>'; }).join('');
  }
  function focusCC(cc, hold){ var c = GLD.C[cc]; if(!c) return; focus = { lat: c[0] * Math.PI / 180, lon: c[1] * Math.PI / 180 }; focusUntil = performance.now() + (hold ? 6000 : 3000); }
  rankEl.addEventListener('click', function(e){ var b = e.target.closest('.glRow'); if(b) focusCC(b.getAttribute('data-cc'), true); });
  rankEl.addEventListener('mouseover', function(e){ var b = e.target.closest('.glRow'); if(b) focusCC(b.getAttribute('data-cc'), false); });
  function ping(cc){
    var c = GLD.C[cc]; if(!c) return;
    rings.push({ lat: c[0] * Math.PI / 180, lon: c[1] * Math.PI / 180, t0: performance.now(), cc: cc });
    if(!drag){ focus = { lat: c[0] * Math.PI / 180, lon: c[1] * Math.PI / 180 }; focusUntil = performance.now() + 3500; }
  }
  function apply(r){
    if(!r || !r.ok) return;
    tFetch = performance.now();
    data = { countries: r.countries || [], live: r.live || [], occ: r.occ || {}, ncountries: r.ncountries || 0 };
    var mx = data.countries.length ? data.countries[0].u || 1 : 1;
    level = {};
    data.countries.forEach(function(x){ level[x.cc] = 0.35 + 0.65 * Math.sqrt((x.u || 0) / mx); });
    Object.keys(data.occ).forEach(function(cc){ if(level[cc] == null) level[cc] = 0.5; });
    var fresh = [];
    data.live.forEach(function(e){ var k = e.cc + '|' + Math.round(e.ts); if(!seen[k]){ seen[k] = 1; fresh.push(e); } });
    fresh = first ? fresh.slice(0, 3).reverse() : fresh.reverse();
    fresh.forEach(function(e, i){ setTimeout(function(){ ping(e.cc); }, i * 700); });
    first = false;
    renderRank(); renderFeed();
  }
  cv.addEventListener('pointerdown', function(e){ drag = true; lastX = e.clientX; lastY = e.clientY; vLam = 0; focus = null; try{ cv.setPointerCapture(e.pointerId); }catch(err){} });
  cv.addEventListener('pointermove', function(e){
    if(!drag) return;
    var dx = e.clientX - lastX, dy = e.clientY - lastY; lastX = e.clientX; lastY = e.clientY;
    lam -= (dx / R) * 0.9; phi = Math.max(-1.1, Math.min(1.1, phi + (dy / R) * 0.9)); vLam = (-dx / R) * 0.9;
  });
  function up(){ drag = false; if(Math.abs(vLam) < 0.001) vLam = 0.0035; }
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  function angDiff(a, b){ var d = a - b; while(d > Math.PI) d -= 2 * Math.PI; while(d < -Math.PI) d += 2 * Math.PI; return d; }
  function draw(now){
    if(dead) return;
    if(document.hidden){ raf = requestAnimationFrame(draw); return; }
    if(focus && now < focusUntil && !drag){ lam += angDiff(focus.lon, lam) * 0.045; phi += (Math.max(-0.9, Math.min(0.9, focus.lat * 0.6)) - phi) * 0.045; }
    else if(!drag && !reduce){ lam += vLam; if(Math.abs(vLam) > 0.0036) vLam *= 0.96; else vLam = 0.0035; }
    var S = dpr, cx = (W / 2) * S, cy = (H / 2) * S, r = R * S, lt = light();
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
    var g = ctx.createRadialGradient(cx, cy, r * 0.9, cx, cy, r * 1.32);
    g.addColorStop(0, 'rgba(50,185,214,.28)'); g.addColorStop(0.45, 'rgba(123,92,255,.08)'); g.addColorStop(1, 'rgba(50,185,214,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r * 1.32, 0, 7); ctx.fill();
    g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
    g.addColorStop(0, '#10285a'); g.addColorStop(0.6, '#091535'); g.addColorStop(1, '#040a1c');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
    var sp0 = Math.sin(phi), cp0 = Math.cos(phi);
    function proj(la, lo){ var c = Math.cos(la), d = lo - lam; return { x: c * Math.sin(d), y: cp0 * Math.sin(la) - sp0 * c * Math.cos(d), z: sp0 * Math.sin(la) + cp0 * c * Math.cos(d) }; }
    ctx.lineWidth = Math.max(1, S * 0.6); ctx.strokeStyle = 'rgba(120,160,255,.10)';
    var la2, lo2, p, st;
    for(la2 = -60; la2 <= 60; la2 += 30){ ctx.beginPath(); st = false; for(lo2 = -180; lo2 <= 180; lo2 += 4){ p = proj(la2 * Math.PI / 180, lo2 * Math.PI / 180); if(p.z > 0){ if(!st){ ctx.moveTo(cx + r * p.x, cy - r * p.y); st = true; } else ctx.lineTo(cx + r * p.x, cy - r * p.y); } else st = false; } ctx.stroke(); }
    for(lo2 = -180; lo2 < 180; lo2 += 30){ ctx.beginPath(); st = false; for(la2 = -88; la2 <= 88; la2 += 4){ p = proj(la2 * Math.PI / 180, lo2 * Math.PI / 180); if(p.z > 0){ if(!st){ ctx.moveTo(cx + r * p.x, cy - r * p.y); st = true; } else ctx.lineTo(cx + r * p.x, cy - r * p.y); } else st = false; } ctx.stroke(); }
    var pulse = 0.5 + 0.5 * Math.sin(now / 700), base = Math.max(1.1, r / 230), lit = [];
    for(var k = 0; k < N; k++){
      var d = DLon[k] - lam, cd = Math.cos(d), z = sp0 * sinP[k] + cp0 * cosP[k] * cd;
      if(z <= 0.02) continue;
      var x = cosP[k] * Math.sin(d), y = cp0 * sinP[k] - sp0 * cosP[k] * cd, px = cx + r * x, py = cy - r * y;
      var lv = level[DCC[k]];
      if(lv) lit.push(px, py, z, lv);
      else { ctx.fillStyle = 'rgba(120,165,255,' + (0.14 + 0.5 * z * z).toFixed(3) + ')'; var s = base * (0.55 + 0.45 * z); ctx.fillRect(px - s / 2, py - s / 2, s, s); }
    }
    var q, zz, s2;
    for(q = 0; q < lit.length; q += 4){ zz = lit[q + 2]; lv = lit[q + 3]; s2 = base * (0.9 + 0.9 * zz) * (0.9 + 0.25 * lv);
      ctx.fillStyle = 'rgba(50,185,214,' + (0.12 * lv * zz).toFixed(3) + ')'; ctx.beginPath(); ctx.arc(lit[q], lit[q + 1], s2 * 2.6, 0, 7); ctx.fill(); }
    for(q = 0; q < lit.length; q += 4){ zz = lit[q + 2]; lv = lit[q + 3]; s2 = base * (0.9 + 0.9 * zz) * (0.9 + 0.25 * lv);
      ctx.fillStyle = 'rgba(' + Math.round(90 + 21 * lv) + ',' + Math.round(160 + 67 * lv) + ',' + Math.round(255 - 8 * lv) + ',' + (0.55 + 0.45 * zz).toFixed(3) + ')'; ctx.beginPath(); ctx.arc(lit[q], lit[q + 1], s2 * 0.62, 0, 7); ctx.fill(); }
    g = ctx.createRadialGradient(cx - r * 0.25, cy - r * 0.3, r * 0.55, cx, cy, r * 1.02);
    g.addColorStop(0, 'rgba(4,10,28,0)'); g.addColorStop(1, 'rgba(4,10,28,.55)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
    Object.keys(data.occ).forEach(function(cc){
      var c = GLD.C[cc]; if(!c) return;
      var pp = proj(c[0] * Math.PI / 180, c[1] * Math.PI / 180); if(pp.z <= 0.05) return;
      var X = cx + r * pp.x, Y = cy - r * pp.y;
      ctx.fillStyle = 'rgba(255,255,255,.95)'; ctx.beginPath(); ctx.arc(X, Y, base * 1.5, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(243,183,71,' + (0.75 - 0.5 * pulse).toFixed(3) + ')'; ctx.lineWidth = S * 1.3; ctx.beginPath(); ctx.arc(X, Y, base * (3 + 5 * pulse), 0, 7); ctx.stroke();
    });
    rings = rings.filter(function(rg){ return now - rg.t0 < 3200; });
    rings.forEach(function(rg){
      var pp = proj(rg.lat, rg.lon); if(pp.z <= 0.02) return;
      var tt0 = (now - rg.t0) / 3200, X = cx + r * pp.x, Y = cy - r * pp.y;
      for(var j = 0; j < 3; j++){ var tt = tt0 - j * 0.16; if(tt <= 0 || tt >= 1) continue;
        ctx.strokeStyle = 'rgba(243,183,71,' + ((1 - tt) * 0.9).toFixed(3) + ')'; ctx.lineWidth = S * (2 - tt);
        ctx.beginPath(); ctx.ellipse(X, Y, r * 0.16 * tt * (0.4 + pp.z * 0.6), r * 0.16 * tt * (0.4 + pp.z * 0.6) * (0.45 + 0.55 * pp.z), 0, 0, 7); ctx.stroke(); }
      var h = r * 0.2 * Math.min(1, tt0 * 5) * (1 - Math.max(0, tt0 - 0.7) / 0.3);
      var gg = ctx.createLinearGradient(X, Y, X, Y - h); gg.addColorStop(0, 'rgba(243,183,71,.95)'); gg.addColorStop(1, 'rgba(243,183,71,0)');
      ctx.strokeStyle = gg; ctx.lineWidth = S * 2; ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(X, Y - h); ctx.stroke();
      if(tt0 < 0.8){ ctx.font = '600 ' + Math.round(11 * S) + 'px Consolas, monospace'; ctx.textAlign = 'center'; ctx.fillStyle = lt ? 'rgba(120,70,0,' + (1 - tt0 / 0.8).toFixed(3) + ')' : 'rgba(255,236,200,' + (1 - tt0 / 0.8).toFixed(3) + ')'; ctx.fillText(rg.cc, X, Y - h - 6 * S); }
    });
    g = ctx.createRadialGradient(cx, cy, r * 0.96, cx, cy, r * 1.035);
    g.addColorStop(0, 'rgba(111,227,247,0)'); g.addColorStop(0.55, 'rgba(111,227,247,.5)'); g.addColorStop(1, 'rgba(111,227,247,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r * 1.035, 0, 7); ctx.fill();
    raf = requestAnimationFrame(draw);
  }
  function onResize(){ resize(); }
  window.addEventListener('resize', onResize);
  resize();
  var feedTimer = setInterval(renderFeed, 1000);
  raf = requestAnimationFrame(draw);
  return {
    apply: apply,
    destroy: function(){ dead = true; cancelAnimationFrame(raf); clearInterval(feedTimer); window.removeEventListener('resize', onResize); }
  };
}
})();
