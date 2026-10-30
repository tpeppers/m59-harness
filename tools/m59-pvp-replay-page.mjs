// m59-pvp-replay-page.mjs -- one PvP battle, replayed over the rooms it happened in.
//
// Drawn by the geometry server (tools/m59-roomserve.mjs, /replay/<battle id>) from a replay built by
// tools/m59-pvp-replay.mjs. Linked from every battle on the /pvp page and from the "PvP here" panel
// on every room's geometry page.
//
// The page is one self-contained file: the replay and each room's outline are embedded, the player
// is plain script. It names real players, so like /pvp and the room pages it is served on loopback.
//
// WHAT IT SHOWS. A slider over the battle's time, and on the map every body the fleet saw at that
// moment: blue ours, red the enemy, grey anyone else, a cross where one of ours died. Each event
// draws a line from who did it to whom for a moment after it happens — red for damage taken, blue
// for damage dealt, violet for a spell, dashed orange for an attack the rules refused. Beside it,
// the log, scrolled to the moment, and each of ours with what it has taken so far, as a RANGE: no
// HP is logged anywhere, so every number is a verb tier (reports/combat-message-damage-ranges.md).
//
// PLAYING IT. Real time, 2x, 4x, 8x, 16x. Autopause stops at the kinds of event ticked in its list
// (saved in this browser). Step by 1, 10 or 100 events, or by 1 or 10 seconds. Keys: space plays,
// left/right step one event (shift: ten), comma/period step a second.

import { roomOutline } from './m59-roomview.mjs';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The outline of every map the replay has a point on. */
export function replayGeometry(replay) {
  const out = {};
  for (const m of replay.maps ?? []) {
    try { const o = roomOutline(m.num); if (o) out[m.num] = o; } catch { /* a room we cannot draw is listed, not drawn */ }
  }
  return out;
}

export function renderReplayPage(replay, { geoms = replayGeometry(replay), pvpUrl = 'http://localhost:8902/pvp?days=7' } = {}) {
  const enemies = (replay.actors ?? []).filter(a => a.side === 'enemy').map(a => a.name);
  const title = `PvP replay — ${new Date(replay.start).toISOString().replace('T', ' ').slice(0, 19)}Z vs ${enemies.join(', ') || '?'}`;
  const data = JSON.stringify({ replay, geoms, pvpUrl }).replace(/<\//g, '<\\/');
  return PAGE.replace('__TITLE__', esc(title)).replace('__H1__', esc(title)).replace('__DATA__', data);
}

/** The /replay index: every battle in the window, newest first. */
export function renderReplayIndex(battles, { days = 7 } = {}) {
  const rows = battles.map(b => `<tr><td><a href="/replay/${esc(encodeURIComponent(b.id))}">${esc(new Date(b.start).toISOString().replace('T', ' ').slice(0, 19))}Z</a></td>
    <td class="${b.result === 'won' ? 'good' : b.result === 'lost' ? 'bad' : ''}">${esc(b.result)}</td><td>K${b.kills} / D${b.our_deaths}</td>
    <td>${esc(b.enemies.map(e => e.name).join(', ') || '?')}</td><td>${esc(b.rooms.join(', '))}</td><td>${Math.round(b.duration_ms / 1000)} s</td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>PvP replays</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;margin:2rem;background:#14161a;color:#d8dee9}a{color:#8fb7ff;text-decoration:none}
td,th{padding:.25rem .8rem .25rem 0;text-align:left}.bad{color:#f87171}.good{color:#4ade80}.dim{color:#8b8b8b}</style>
<h2>PvP battles, last ${days} days</h2><p class="dim">Each one replays over the rooms it happened in. <a href="/">rooms</a> · <a href="http://localhost:8902/pvp?days=${days}">PvP page</a></p>
<table><tr><th>When (UTC)</th><th>Result</th><th></th><th>Against</th><th>Maps</th><th>Contact</th></tr>${rows}</table>`;
}

const PAGE = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
:root{ color-scheme: light dark; --fg:#1a1a1a; --dim:#767676; --bg:#fbfbfa; --panel:#fff; --line:#e6e4e0; --sunk:#eef0ef;
  --stand:#dde5e2; --walk:#c2d2cd; --wall:#2b3436; --ours:#2563eb; --enemy:#dc2626; --other:#8b8b8b; --spell:#9333ea;
  --refused:#ea8a0c; --good:#1a7f4b; --bad:#b3261e; --accent:#5b6ee1; }
@media (prefers-color-scheme: dark){ :root{ --fg:#e8e6e3; --dim:#8b8b8b; --bg:#16161a; --panel:#1e1e24; --line:#2e2e36; --sunk:#111317;
  --stand:#1d2427; --walk:#26333a; --wall:#c9d4d6; --ours:#60a5fa; --enemy:#f87171; --other:#9ca3af; --spell:#c084fc;
  --refused:#fbaa3e; --good:#4ade80; --bad:#f87171; --accent:#8b9bff; } }
*{box-sizing:border-box} html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;flex-direction:column}
header{padding:.6rem 1rem .4rem;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:.3rem 1rem;align-items:baseline}
header h1{font-size:1.05rem;margin:0} header a{color:var(--accent);text-decoration:none;font-size:.85rem} .dim{color:var(--dim)}
.badge{color:#fff;font-size:.7rem;font-weight:600;padding:.05rem .5rem;border-radius:999px;text-transform:uppercase}
main{flex:1;display:grid;grid-template-columns:minmax(0,1fr) 430px;min-height:0}
#stage{position:relative;min-height:0;display:flex;flex-direction:column}
#maps{display:flex;flex-wrap:wrap;gap:.3rem;padding:.4rem .6rem;border-bottom:1px solid var(--line);align-items:center}
#maps button,.ctl button,.pop button{font:inherit;font-size:.78rem;padding:.2rem .55rem;border:1px solid var(--line);background:var(--panel);color:var(--fg);border-radius:6px;cursor:pointer}
#maps button.on,.ctl button.on{background:var(--accent);color:#fff;border-color:var(--accent)}
#cvwrap{flex:1;position:relative;min-height:300px} canvas#map{position:absolute;inset:0;width:100%;height:100%;cursor:grab}
#tip{position:absolute;pointer-events:none;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:.3rem .5rem;font-size:.78rem;display:none;box-shadow:0 4px 14px rgba(0,0,0,.2);z-index:5;max-width:280px}
#now{position:absolute;left:.6rem;top:.5rem;background:color-mix(in srgb,var(--panel) 85%,transparent);border:1px solid var(--line);border-radius:6px;padding:.25rem .5rem;font-size:.8rem;max-width:70%;pointer-events:none}
#legend{position:absolute;right:.6rem;top:.5rem;background:color-mix(in srgb,var(--panel) 85%,transparent);border:1px solid var(--line);border-radius:6px;padding:.25rem .5rem;font-size:.72rem;line-height:1.6}
.sw{display:inline-block;width:18px;height:3px;vertical-align:middle;margin-right:4px}
#bar{border-top:1px solid var(--line);padding:.45rem .6rem .55rem;background:var(--panel)}
.ctl{display:flex;flex-wrap:wrap;gap:.25rem;align-items:center;margin-bottom:.35rem}
.ctl .sep{width:1px;height:18px;background:var(--line);margin:0 .25rem}
#clock{font-variant-numeric:tabular-nums;margin-left:auto;font-size:.82rem}
#strip{width:100%;height:26px;display:block;cursor:pointer}
#slider{width:100%;margin:0}
aside{border-left:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
#actors{max-height:38%;overflow:auto;border-bottom:1px solid var(--line);padding:.35rem .5rem}
#actors table{width:100%;border-collapse:collapse;font-size:.76rem} #actors td,#actors th{padding:.1rem .3rem;text-align:left;white-space:nowrap}
#actors th{color:var(--dim);font-weight:500} #actors tr{cursor:pointer} #actors tr.focus td{background:color-mix(in srgb,var(--accent) 18%,transparent)}
#actors tr.dead td{opacity:.55} .num{text-align:right;font-variant-numeric:tabular-nums}
#logh{display:flex;gap:.4rem;align-items:center;padding:.3rem .5rem;border-bottom:1px solid var(--line);font-size:.78rem}
#log{flex:1;overflow:auto;font-size:.76rem;position:relative}
#log .row{display:grid;grid-template-columns:62px 52px 1fr;gap:.35rem;padding:.12rem .5rem;border-bottom:1px solid color-mix(in srgb,var(--line) 60%,transparent);cursor:pointer}
#log .row:hover{background:color-mix(in srgb,var(--accent) 8%,transparent)} #log .row.cur{background:color-mix(in srgb,var(--accent) 22%,transparent)}
#log .row.future{opacity:.45} #log .t{font-variant-numeric:tabular-nums;color:var(--dim)} #log .hp{color:var(--dim);font-variant-numeric:tabular-nums}
.chip{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px;vertical-align:middle}
.pop{position:absolute;bottom:100%;left:0;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:.6rem .8rem;box-shadow:0 8px 24px rgba(0,0,0,.25);z-index:10;display:none;min-width:290px}
.pop label{display:block;font-size:.8rem;padding:.1rem 0;cursor:pointer} .pop h4{margin:0 0 .3rem;font-size:.82rem}
.rel{position:relative}
.note{font-size:.72rem;color:var(--dim);padding:.3rem .5rem;border-top:1px solid var(--line)}
@media (max-width:900px){ main{grid-template-columns:1fr} aside{border-left:none;border-top:1px solid var(--line);max-height:50vh} }
</style></head><body>
<header><h1>__H1__</h1><span id="hres"></span><span id="hlinks"></span></header>
<main>
<div id="stage">
  <div id="maps"></div>
  <div id="cvwrap"><canvas id="map"></canvas><div id="now"></div><div id="tip"></div>
    <div id="legend"><div><span class="sw" style="background:var(--enemy)"></span>damage to ours</div><div><span class="sw" style="background:var(--ours)"></span>ours hit / zap / swing</div>
      <div><span class="sw" style="background:var(--spell)"></span>spell cast</div><div><span class="sw" style="background:var(--refused)"></span>refused (safety, reach, karma)</div>
      <div><span class="sw" style="background:var(--other)"></span>miss / dodge</div><div><span class="sw" style="background:#f97316;height:8px;width:8px"></span>burned by a fire wall here</div><div class="dim">● ours · ● enemy · ✕ died · hollow = last seen &gt;15 s ago</div></div>
  </div>
  <div id="bar">
    <div class="ctl">
      <button id="bStart" title="Back to the start">⏮</button>
      <button data-ev="-100" title="Back 100 events">−100</button><button data-ev="-10" title="Back 10 events (shift+←)">−10</button><button data-ev="-1" title="Back 1 event (←)">−1</button>
      <button id="bPlay" title="Play / pause (space)" style="min-width:4.2em">▶ Play</button>
      <button data-ev="1" title="Forward 1 event (→)">+1</button><button data-ev="10" title="Forward 10 events (shift+→)">+10</button><button data-ev="100" title="Forward 100 events">+100</button>
      <span class="sep"></span>
      <button data-sec="-10">−10s</button><button data-sec="-1" title="(,)">−1s</button><button data-sec="1" title="(.)">+1s</button><button data-sec="10">+10s</button>
      <span class="sep"></span>
      <span class="dim">speed</span><button data-speed="1" class="on" title="Real time">1×</button><button data-speed="2">2×</button><button data-speed="4">4×</button><button data-speed="8">8×</button><button data-speed="16">16×</button>
      <span class="sep"></span>
      <span class="rel"><button id="bAuto">Autopause ▾</button><div class="pop" id="autoPop"></div></span>
      <span id="clock"></span>
    </div>
    <canvas id="strip"></canvas>
    <input type="range" id="slider" min="0" max="1000" step="1" value="0">
  </div>
</div>
<aside>
  <div id="actors"></div>
  <div id="logh"><b>Log</b><span class="dim" id="logcount"></span><span class="rel" style="margin-left:auto"><button id="bFilt" class="ctlb" style="font:inherit;font-size:.75rem;padding:.1rem .45rem;border:1px solid var(--line);background:var(--panel);color:var(--fg);border-radius:6px;cursor:pointer">Show ▾</button><div class="pop" id="filtPop" style="left:auto;right:0;bottom:auto;top:100%"></div></span></div>
  <div id="log"></div>
  <div class="note">HP figures are ranges read from the hit verb (nick 1–5, wound 6–15, damage ≈ a third of max HP, capped); no HP is logged. Enemy max HP is assumed ≥ 88. Positions are the fleet's own move packets and the trail recorder; a body nobody of ours could see is not drawn.</div>
</aside>
</main>
<script>
var D = __DATA__;
var R = D.replay, GEO = D.geoms, EV = R.events;
var T0 = R.t0, T1 = R.t1;
function css(n){ return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function norm(n){ return String(n == null ? '' : n).trim().toLowerCase(); }

/* ---------- categories: colour, label, and which autopause group they belong to ---------- */
var GROUPS = [
  { key:'death', label:'Deaths', cats:['death_ours','death_enemy','died','killing_blow'], on:true, col:'--bad' },
  { key:'dmg_in_p', label:'Damage taken from players (and walls)', cats:['hit_in_player','wall_in'], on:true, col:'--enemy' },
  { key:'dmg_in_m', label:'Damage taken from monsters', cats:['hit_in_monster'], on:false, col:'--other' },
  { key:'dmg_out', label:'Damage dealt to players', cats:['hit_out'], on:false, col:'--ours' },
  { key:'miss', label:'Misses, dodges, resist lines', cats:['miss_out','miss_in','resist_out','resist_in'], on:false, col:'--other' },
  { key:'cast_e', label:'Spells cast by the enemy (incl. sweep)', cats:['cast_enemy','cast_monster'], on:true, col:'--spell' },
  { key:'cast_o', label:'Spells cast by ours (and replies)', cats:['cast_ours','cast_ours_seen','spell_reply'], on:false, col:'--spell' },
  { key:'effect', label:'Effects on ours (hold, blind, ...)', cats:['effect_in','effect_off'], on:true, col:'--spell' },
  { key:'wand', label:'Wand zaps by ours', cats:['wand_out'], on:false, col:'--ours' },
  { key:'swing', label:'Swings by ours', cats:['swing'], on:false, col:'--ours' },
  { key:'refused', label:'Refused: safety, reach, karma, broken gear', cats:['refused'], on:false, col:'--refused' },
  { key:'move', label:'Map changes', cats:['move'], on:false, col:'--accent' },
  { key:'decision', label:'Alarms and fight decisions', cats:['alarm','decision','safety_toggle'], on:false, col:'--dim' },
  { key:'chat', label:'Speech', cats:['chat','chat_enemy'], on:false, col:'--dim' },
  { key:'misc', label:'Everything else (gear, other lines)', cats:['gear','other','action','hit_out_monster'], on:false, col:'--dim' }
];
var CAT = {};
GROUPS.forEach(function(g){ g.cats.forEach(function(c){ CAT[c] = g; }); });
function groupOf(e){ return CAT[e.cat] || GROUPS[GROUPS.length - 1]; }
var auto = {}, show = {};
try { auto = JSON.parse(localStorage.getItem('pvpReplayAutopause') || 'null') || {}; } catch(e){}
try { show = JSON.parse(localStorage.getItem('pvpReplayShow') || 'null') || {}; } catch(e){}
GROUPS.forEach(function(g){ if (auto[g.key] === undefined) auto[g.key] = g.on; if (show[g.key] === undefined) show[g.key] = g.key !== 'misc' && g.key !== 'dmg_in_m'; });

/* ---------- actors and tracks ---------- */
var ACT = {};
R.actors.forEach(function(a){ ACT[a.name] = a; });
var TR = R.tracks;
var SIDE_COL = { ours:'--ours', enemy:'--enemy', other:'--other', unknown:'--other' };
function lastIdx(arr, t){ var lo = 0, hi = arr.length - 1, ans = -1; while (lo <= hi){ var m = (lo + hi) >> 1; if (arr[m][0] <= t){ ans = m; lo = m + 1; } else hi = m - 1; } return ans; }
function posAt(name, t){
  var tk = TR[name]; if (!tk || !tk.length) return null;
  var i = lastIdx(tk, t); if (i < 0) return null;
  var p = tk[i], n = tk[i + 1], x = p[2], y = p[3];
  if (n && n[1] === p[1] && n[0] - p[0] < 3000 && n[0] > p[0]){ var f = (t - p[0]) / (n[0] - p[0]); x += (n[2] - x) * f; y += (n[3] - y) * f; }
  return { map:p[1], x:x, y:y, age:t - p[0] };
}
function evIdx(t){ var lo = 0, hi = EV.length - 1, ans = -1; while (lo <= hi){ var m = (lo + hi) >> 1; if (EV[m].t <= t){ ans = m; lo = m + 1; } else hi = m - 1; } return ans; }

/* ---------- state ---------- */
var t = R.start - 3000, playing = false, speed = 1, curMap = null, follow = true, focus = null, curIdx = -1;
var view = { s: 8, x: 0, y: 0 }, fitted = {};
var mapsWithGeo = R.maps.filter(function(m){ return GEO[m.num]; });
function firstMap(){ for (var i = 0; i < EV.length; i++){ var e = EV[i]; if (e.map != null && GEO[e.map] && e.t >= R.start - 1000) return e.map; } return mapsWithGeo.length ? mapsWithGeo[0].num : null; }
curMap = firstMap();

/* ---------- header ---------- */
(function(){
  var col = R.result === 'lost' ? 'var(--bad)' : R.result === 'won' ? 'var(--good)' : 'var(--dim)';
  document.getElementById('hres').innerHTML = '<span class="badge" style="background:' + col + '">' + esc(R.result) + '</span> <span class="dim">kills ' + R.kills + ' · deaths ' + R.our_deaths +
    ' · contact ' + Math.round((R.end - R.start)/1000) + ' s · ' + EV.length + ' events · ' + R.sources.track_points + ' positions</span>';
  document.getElementById('hlinks').innerHTML = '<a href="' + esc(D.pvpUrl) + '#' + encodeURIComponent(R.id) + '">← PvP page</a> · <a href="/replay">all replays</a> · <a id="roomLink" href="#">geometry page for this map</a>';
})();

/* ---------- map buttons ---------- */
function drawMapButtons(){
  var el = document.getElementById('maps'), h = '<button id="bFollow" class="' + (follow ? 'on' : '') + '" title="Switch to wherever the latest event is">Follow action</button>';
  R.maps.forEach(function(m){
    var g = GEO[m.num];
    h += '<button data-map="' + m.num + '" class="' + (m.num === curMap ? 'on' : '') + '"' + (g ? '' : ' disabled title="no geometry for this map"') + '>' + m.num + ' ' + esc(m.name || '') + ' <span class="dim">' + m.points + '</span></button>';
  });
  h += '<span style="margin-left:auto"></span><button id="bFit" title="Zoom to where bodies were">Fit action</button><button id="bWhole" title="Show the whole room">Whole room</button>';
  el.innerHTML = h;
  document.getElementById('roomLink').href = '/' + curMap;
}
document.getElementById('maps').addEventListener('click', function(ev){
  var b = ev.target.closest('button'); if (!b) return;
  if (b.id === 'bFollow'){ follow = !follow; drawMapButtons(); return; }
  if (b.id === 'bFit'){ fitAction(); return; }
  if (b.id === 'bWhole'){ fitWhole(); return; }
  if (b.dataset.map){ setMap(Number(b.dataset.map)); follow = false; drawMapButtons(); }
});
function setMap(n){ if (n === curMap || !GEO[n]) return; curMap = n; if (!fitted[n]) fitAction(); else draw(); drawMapButtons(); buildBg(); }

/* ---------- canvas ---------- */
var cv = document.getElementById('map'), ctx = cv.getContext('2d'), bg = null, bgKey = '';
function resize(){
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(cv.clientWidth * dpr); cv.height = Math.round(cv.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); bgKey = ''; draw();
}
function fitBox(r0, c0, r1, c1){
  var w = cv.clientWidth, h = cv.clientHeight, pad = 30;
  var rows = r1 - r0 + 1, cols = c1 - c0 + 1;
  view.s = Math.max(1, Math.min((w - pad*2) / cols, (h - pad*2) / rows));
  view.x = (w - cols * view.s) / 2 - (c0 - 1) * view.s;
  view.y = (h - rows * view.s) / 2 - (r0 - 1) * view.s;
  fitted[curMap] = true; bgKey = ''; draw();
}
function fitWhole(){ var g = GEO[curMap]; if (g) fitBox(1, 1, g.rows, g.cols); }
function fitAction(){
  var g = GEO[curMap]; if (!g) return;
  var r0 = 1e9, c0 = 1e9, r1 = -1e9, c1 = -1e9, n = 0;
  for (var k in TR){ var tk = TR[k]; for (var i = 0; i < tk.length; i++){ var p = tk[i]; if (p[1] !== curMap) continue;
    var c = Math.floor(p[2]/64), r = Math.floor(p[3]/64); if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r; n++; } }
  if (!n) return fitWhole();
  fitBox(Math.max(1, r0 - 4), Math.max(1, c0 - 4), Math.min(g.rows, r1 + 4), Math.min(g.cols, c1 + 4));
}
function sx(x){ return view.x + (x/64 - 1) * view.s; }
function sy(y){ return view.y + (y/64 - 1) * view.s; }
function buildBg(){
  var g = GEO[curMap], w = cv.width, h = cv.height;
  var key = curMap + '|' + view.s.toFixed(3) + '|' + view.x.toFixed(1) + '|' + view.y.toFixed(1) + '|' + w + 'x' + h;
  if (key === bgKey && bg) return; bgKey = key;
  bg = document.createElement('canvas'); bg.width = w; bg.height = h;
  var b = bg.getContext('2d'), dpr = w / Math.max(1, cv.clientWidth); b.setTransform(dpr, 0, 0, dpr, 0, 0);
  b.fillStyle = css('--sunk'); b.fillRect(0, 0, cv.clientWidth, cv.clientHeight);
  if (!g) return;
  var s = view.s, cs = Math.max(s, 1), r, c;
  b.fillStyle = css('--stand');
  for (r = 1; r <= g.rows; r++){ var st = g.standable[r-1]; for (c = 1; c <= g.cols; c++) if (st.charCodeAt(c-1) === 49) b.fillRect(view.x + (c-1)*s, view.y + (r-1)*s, cs, cs); }
  b.fillStyle = css('--walk');
  for (r = 1; r <= g.rows; r++){ var wk = g.walkable[r-1]; for (c = 1; c <= g.cols; c++) if (wk.charCodeAt(c-1) === 49) b.fillRect(view.x + (c-1)*s, view.y + (r-1)*s, cs, cs); }
  if (s >= 14){ b.strokeStyle = css('--line'); b.lineWidth = .5; b.beginPath();
    for (c = 1; c <= g.cols + 1; c++){ b.moveTo(view.x + (c-1)*s, view.y); b.lineTo(view.x + (c-1)*s, view.y + g.rows*s); }
    for (r = 1; r <= g.rows + 1; r++){ b.moveTo(view.x, view.y + (r-1)*s); b.lineTo(view.x + g.cols*s, view.y + (r-1)*s); } b.stroke(); }
  var u = g.unitsPerSquare || 1024;
  b.strokeStyle = css('--wall'); b.lineWidth = Math.max(1, s * .1); b.globalAlpha = .85; b.beginPath();
  g.walls.forEach(function(wl){ b.moveTo(view.x + (wl[0]/u)*s, view.y + (wl[1]/u)*s); b.lineTo(view.x + (wl[2]/u)*s, view.y + (wl[3]/u)*s); });
  b.stroke(); b.globalAlpha = 1;
}
var LINE = { hit_in_player:'--enemy', wall_in:'--enemy', hit_in_monster:'--other', killing_blow:'--enemy', hit_out:'--ours', wand_out:'--ours', swing:'--ours',
  cast_enemy:'--spell', cast_ours:'--spell', cast_ours_seen:'--spell', refused:'--refused', miss_out:'--other', miss_in:'--other', death_ours:'--bad', death_enemy:'--good' };
var DASH = { swing:[4,3], miss_out:[2,3], miss_in:[2,3], refused:[5,3], wand_out:[1,0] };
function draw(){
  var w = cv.clientWidth, h = cv.clientHeight;
  buildBg();
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(bg, 0, 0);
  var dpr = cv.width / Math.max(1, w); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!GEO[curMap]){ ctx.fillStyle = css('--dim'); ctx.fillText('No geometry for map ' + curMap, 20, 40); return; }
  var s = view.s, rad = Math.max(4, Math.min(9, s * .45));
  /* trails: the last 12 seconds of each body */
  var bodies = [];
  for (var name in TR){
    var tk = TR[name], i = lastIdx(tk, t); if (i < 0) continue;
    var a = ACT[name] || { side:'unknown' }, col = css(SIDE_COL[a.side] || '--other');
    ctx.strokeStyle = col; ctx.lineWidth = focus === name ? 2.5 : 1.3;
    ctx.globalAlpha = .35; ctx.beginPath(); var started = false;
    for (var j = i; j >= 0 && t - tk[j][0] < 12000; j--){ var p = tk[j]; if (p[1] !== curMap){ started = false; continue; }
      if (!started){ ctx.moveTo(sx(p[2]), sy(p[3])); started = true; } else ctx.lineTo(sx(p[2]), sy(p[3])); }
    ctx.stroke(); ctx.globalAlpha = 1;
    var pos = posAt(name, t); if (pos && pos.map === curMap) bodies.push({ name:name, a:a, pos:pos, col:col });
  }
  /* fire walls: where a body of ours was burned by one, for a minute after (a wall outlasts the hit) */
  for (var wi = Math.max(0, evIdx(t - 60000)); wi <= evIdx(t); wi++){ var we = EV[wi]; if (!we || we.cat !== 'wall_in') continue;
    var wp = posAt(we.heard_by || we.target, we.t); if (!wp || wp.map !== curMap) continue;
    var age = (t - we.t) / 60000, ws = Math.max(6, s * .8); ctx.globalAlpha = Math.max(.25, 1 - age); ctx.fillStyle = '#f97316';
    ctx.fillRect(sx(wp.x) - ws/2, sy(wp.y) - ws/2, ws, ws); ctx.globalAlpha = 1;
    if (age < .5){ ctx.fillStyle = css('--fg'); ctx.font = '600 10px ui-sans-serif,system-ui'; ctx.fillText('fire wall', sx(wp.x) + ws/2 + 2, sy(wp.y) + ws); } }
  /* deaths: a cross where each fell, from the moment it fell */
  R.actors.forEach(function(a){ (a.deaths || []).forEach(function(dt){ if (dt > t) return; var p = posAt(a.name, dt - 1); if (!p || p.map !== curMap) return;
    var X = sx(p.x), Y = sy(p.y), k = rad; ctx.strokeStyle = css(a.side === 'ours' ? '--ours' : '--enemy'); ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(X-k, Y-k); ctx.lineTo(X+k, Y+k); ctx.moveTo(X+k, Y-k); ctx.lineTo(X-k, Y+k); ctx.stroke();
    ctx.fillStyle = css('--fg'); ctx.font = '600 10px ui-sans-serif,system-ui'; ctx.fillText('✝ ' + a.name, X + k + 2, Y - k); }); });
  /* the last 1.5 s of events: who did what to whom */
  var lo = evIdx(t - 1600), hi = evIdx(t);
  for (var ei = Math.max(0, lo); ei <= hi; ei++){
    var e = EV[ei]; if (!e || e.t > t || t - e.t > 1600) continue;
    var colv = LINE[e.cat]; if (!colv) continue;
    var A = e.actor ? posAt(e.actor, e.t) : null, B = e.target ? posAt(e.target, e.t) : null;
    if (e.cat === 'hit_in_player' || e.cat === 'wall_in' || e.cat === 'hit_in_monster'){ if (!B && e.heard_by) B = posAt(e.heard_by, e.t); }
    var fade = 1 - (t - e.t) / 1600;
    ctx.globalAlpha = Math.max(.15, fade); ctx.strokeStyle = css(colv); ctx.lineWidth = 2.2; ctx.setLineDash(DASH[e.cat] || []);
    if (A && B && A.map === curMap && B.map === curMap){ ctx.beginPath(); ctx.moveTo(sx(A.x), sy(A.y)); ctx.lineTo(sx(B.x), sy(B.y)); ctx.stroke();
      ctx.setLineDash([]); ctx.beginPath(); ctx.arc(sx(B.x), sy(B.y), rad + 4 + (1 - fade) * 8, 0, Math.PI*2); ctx.stroke(); }
    else { var P = B || A; if (P && P.map === curMap){ ctx.setLineDash([]); ctx.beginPath(); ctx.arc(sx(P.x), sy(P.y), rad + 4 + (1 - fade) * 10, 0, Math.PI*2); ctx.stroke(); } }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }
  /* bodies */
  ctx.font = '600 11px ui-sans-serif,system-ui';
  bodies.sort(function(p, q){ return (p.a.side === 'enemy') - (q.a.side === 'enemy'); });
  bodies.forEach(function(b){
    var X = sx(b.pos.x), Y = sy(b.pos.y), stale = b.pos.age > 15000;
    ctx.globalAlpha = stale ? .45 : 1; ctx.beginPath(); ctx.arc(X, Y, b.a.side === 'enemy' ? rad + 1.5 : rad, 0, Math.PI*2);
    if (stale){ ctx.strokeStyle = b.col; ctx.lineWidth = 2; ctx.stroke(); } else { ctx.fillStyle = b.col; ctx.fill(); }
    if (focus === b.name){ ctx.strokeStyle = css('--fg'); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X, Y, rad + 4, 0, Math.PI*2); ctx.stroke(); }
    if (b.a.side === 'enemy' || focus === b.name || s >= 9){ ctx.fillStyle = css('--fg'); ctx.fillText(b.name, X + rad + 3, Y + 4); }
    ctx.globalAlpha = 1; b.X = X; b.Y = Y;
  });
  lastBodies = bodies;
  /* the newest event, in words, over the map */
  var cur = EV[evIdx(t)];
  document.getElementById('now').innerHTML = cur ? '<span class="chip" style="background:var(' + groupOf(cur).col + ')"></span>' + esc(rel(cur.t)) + ' ' + esc(cur.text) + (cur.hp ? ' <span class="dim">[' + cur.hp[0] + '–' + (cur.hp[1] == null ? '?' : cur.hp[1]) + ' HP]</span>' : '') : '';
}
var lastBodies = [];

/* ---------- pan, zoom, hover ---------- */
var drag = null, tip = document.getElementById('tip');
cv.addEventListener('mousedown', function(e){ drag = { x:e.clientX, y:e.clientY, vx:view.x, vy:view.y, moved:false }; cv.style.cursor = 'grabbing'; });
window.addEventListener('mouseup', function(e){ if (drag && !drag.moved){ var b = hit(e); if (b){ focus = focus === b.name ? null : b.name; renderActors(true); draw(); } } drag = null; cv.style.cursor = 'grab'; });
window.addEventListener('mousemove', function(e){
  if (drag){ var dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true; view.x = drag.vx + dx; view.y = drag.vy + dy; draw(); return; }
  if (e.target !== cv){ tip.style.display = 'none'; return; }
  var b = hit(e), r = cv.getBoundingClientRect();
  if (b){ var a = b.a, c = Math.floor(b.pos.x/64), rr = Math.floor(b.pos.y/64);
    tip.innerHTML = '<b style="color:' + b.col + '">' + esc(b.name) + '</b> <span class="dim">' + esc(a.side) + (a.faction ? ' · ' + esc(a.faction) : '') + (a.max_hp ? ' · max ' + a.max_hp + ' HP' : '') + '</span><br>r' + rr + 'c' + c +
      ' <span class="dim">(' + Math.round(b.pos.x) + ',' + Math.round(b.pos.y) + ' fine)</span>' + (b.pos.age > 1500 ? '<br><span class="dim">last seen ' + (b.pos.age/1000).toFixed(1) + ' s ago</span>' : '');
    tip.style.left = (e.clientX - r.left + 14) + 'px'; tip.style.top = (e.clientY - r.top + 10) + 'px'; tip.style.display = 'block';
  } else {
    var g = GEO[curMap]; if (!g){ tip.style.display = 'none'; return; }
    var mx = e.clientX - r.left, my = e.clientY - r.top, col = Math.floor((mx - view.x) / view.s) + 1, row = Math.floor((my - view.y) / view.s) + 1;
    if (row < 1 || col < 1 || row > g.rows || col > g.cols){ tip.style.display = 'none'; return; }
    tip.innerHTML = 'r' + row + 'c' + col + ' <span class="dim">' + (g.walkable[row-1][col-1] === '1' ? 'walkable' : g.standable[row-1][col-1] === '1' ? 'standable, not walkable' : 'not walkable') + '</span>';
    tip.style.left = (mx + 14) + 'px'; tip.style.top = (my + 10) + 'px'; tip.style.display = 'block';
  }
});
function hit(e){ var r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, best = null, bd = 12;
  lastBodies.forEach(function(b){ var d = Math.hypot(b.X - mx, b.Y - my); if (d < bd){ bd = d; best = b; } }); return best; }
cv.addEventListener('wheel', function(e){ e.preventDefault(); var r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  var f = e.deltaY < 0 ? 1.18 : 1/1.18, ns = Math.max(.5, Math.min(80, view.s * f)); f = ns / view.s;
  view.x = mx - (mx - view.x) * f; view.y = my - (my - view.y) * f; view.s = ns; draw(); }, { passive:false });

/* ---------- time ---------- */
function clockOf(ms){ return new Date(ms).toISOString().slice(11, 21) + 'Z'; }
function rel(ms){ var d = (ms - R.start) / 1000, sg = d < 0 ? '−' : '+'; d = Math.abs(d); var m = Math.floor(d / 60), s = d - m*60; return sg + m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); }
var slider = document.getElementById('slider');
function setT(nt, opts){
  t = Math.max(T0, Math.min(T1, nt));
  var idx = evIdx(t);
  if (follow){ for (var i = idx; i >= 0 && i > idx - 40; i--){ var e = EV[i]; if (e.map != null && GEO[e.map] && (!focus || norm(e.actor) === norm(focus) || norm(e.target) === norm(focus) || norm(e.heard_by) === norm(focus))){ if (e.map !== curMap){ curMap = e.map; drawMapButtons(); if (!fitted[curMap]) fitAction(); } break; } } }
  slider.value = Math.round((t - T0) / (T1 - T0) * 1000);
  var dur = (R.end - R.start) / 1000;
  document.getElementById('clock').innerHTML = '<b>' + clockOf(t) + '</b> <span class="dim">' + new Date(t).toLocaleTimeString() + ' local · ' + rel(t) + ' of ' + Math.floor(dur/60) + ':' + ('0' + Math.round(dur % 60)).slice(-2) + ' · ' + speed + '×</span>';
  if (idx !== curIdx || (opts && opts.force)){ curIdx = idx; renderActors(); renderLog(); }
  draw(); drawStrip();
}
slider.addEventListener('input', function(){ setT(T0 + (T1 - T0) * slider.value / 1000); });
var last = 0;
function frame(now){
  if (!playing){ last = 0; return; }
  if (!last) last = now;
  var dt = Math.min(250, now - last) * speed; last = now;
  var nt = t + dt;
  /* autopause: the first ticked event in (t, nt] stops the clock on it */
  var i = evIdx(t) + 1;
  while (i < EV.length && EV[i].t <= nt){ var e = EV[i]; if (auto[groupOf(e).key] && show[groupOf(e).key] !== false){ setT(e.t); pause('autopaused: ' + groupOf(e).label); return; } i++; }
  setT(nt);
  if (t >= T1){ pause(); return; }
  requestAnimationFrame(frame);
}
var bPlay = document.getElementById('bPlay');
function play(){ if (t >= T1) setT(T0); playing = true; bPlay.textContent = '⏸ Pause'; bPlay.title = 'Pause (space)'; requestAnimationFrame(frame); }
function pause(why){ playing = false; bPlay.textContent = '▶ Play'; bPlay.title = why ? why + ' — play to resume' : 'Play (space)'; if (why) flash(why); }
function flash(msg){ var c = document.getElementById('clock'); c.style.outline = '2px solid var(--accent)'; setTimeout(function(){ c.style.outline = ''; }, 600); }
bPlay.addEventListener('click', function(){ playing ? pause() : play(); });
document.getElementById('bStart').addEventListener('click', function(){ pause(); setT(R.start - 3000); });
function stepEv(n){ pause(); var i = evIdx(t);
  /* step to the next/previous VISIBLE event, so a hidden category is skipped */
  var k = Math.abs(n), dir = n > 0 ? 1 : -1, j = i;
  if (dir < 0 && j >= 0 && EV[j].t < t) { /* already past j: stepping back lands on j first */ if (show[groupOf(EV[j]).key] !== false) k--; }
  while (k > 0){ j += dir; if (j < 0 || j >= EV.length) break; if (show[groupOf(EV[j]).key] !== false) k--; }
  j = Math.max(0, Math.min(EV.length - 1, j)); setT(EV[j].t); }
document.querySelectorAll('[data-ev]').forEach(function(b){ b.addEventListener('click', function(){ stepEv(Number(b.dataset.ev)); }); });
document.querySelectorAll('[data-sec]').forEach(function(b){ b.addEventListener('click', function(){ pause(); setT(t + Number(b.dataset.sec) * 1000); }); });
document.querySelectorAll('[data-speed]').forEach(function(b){ b.addEventListener('click', function(){ speed = Number(b.dataset.speed);
  document.querySelectorAll('[data-speed]').forEach(function(x){ x.classList.toggle('on', x === b); }); setT(t); }); });
window.addEventListener('keydown', function(e){
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
  if (e.key === ' '){ e.preventDefault(); playing ? pause() : play(); }
  else if (e.key === 'ArrowRight'){ e.preventDefault(); stepEv(e.shiftKey ? 10 : 1); }
  else if (e.key === 'ArrowLeft'){ e.preventDefault(); stepEv(e.shiftKey ? -10 : -1); }
  else if (e.key === '.'){ pause(); setT(t + 1000); } else if (e.key === ','){ pause(); setT(t - 1000); }
});

/* ---------- autopause and log filter pop-ups ---------- */
function popup(btnId, popId, state, storeKey, title){
  var pop = document.getElementById(popId);
  function render(){ pop.innerHTML = '<h4>' + title + '</h4>' + GROUPS.map(function(g){ return '<label><input type="checkbox" data-k="' + g.key + '"' + (state[g.key] ? ' checked' : '') + '> <span class="chip" style="background:var(' + g.col + ')"></span>' + esc(g.label) + '</label>'; }).join('') +
    '<div style="margin-top:.4rem;display:flex;gap:.3rem"><button data-all="1">all</button><button data-all="0">none</button><button data-close="1" style="margin-left:auto">close</button></div>'; }
  render();
  document.getElementById(btnId).addEventListener('click', function(ev){ ev.stopPropagation(); document.querySelectorAll('.pop').forEach(function(p){ if (p !== pop) p.style.display = 'none'; }); pop.style.display = pop.style.display === 'block' ? 'none' : 'block'; });
  pop.addEventListener('click', function(ev){ ev.stopPropagation(); var b = ev.target.closest('button');
    if (b && b.dataset.close){ pop.style.display = 'none'; return; }
    if (b && b.dataset.all){ GROUPS.forEach(function(g){ state[g.key] = b.dataset.all === '1'; }); render(); save(); } });
  pop.addEventListener('change', function(ev){ var k = ev.target.dataset.k; if (!k) return; state[k] = ev.target.checked; save(); });
  function save(){ try { localStorage.setItem(storeKey, JSON.stringify(state)); } catch(e){} renderLog(); drawStrip(); }
}
popup('bAuto', 'autoPop', auto, 'pvpReplayAutopause', 'Autopause at…');
popup('bFilt', 'filtPop', show, 'pvpReplayShow', 'Show in the log and the strip');
document.addEventListener('click', function(){ document.querySelectorAll('.pop').forEach(function(p){ p.style.display = 'none'; }); });

/* ---------- the event strip under the slider ---------- */
var strip = document.getElementById('strip'), sctx = strip.getContext('2d');
function drawStrip(){
  var dpr = Math.min(window.devicePixelRatio || 1, 2), w = strip.clientWidth, h = strip.clientHeight;
  if (strip.width !== Math.round(w * dpr)){ strip.width = Math.round(w * dpr); strip.height = Math.round(h * dpr); }
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0); sctx.clearRect(0, 0, w, h);
  sctx.fillStyle = css('--sunk'); sctx.fillRect(0, 0, w, h);
  var X = function(ms){ return (ms - T0) / (T1 - T0) * w; };
  sctx.fillStyle = css('--line'); sctx.fillRect(X(R.start), 0, Math.max(1, X(R.end) - X(R.start)), h);
  EV.forEach(function(e){ var g = groupOf(e); if (show[g.key] === false) return;
    var big = g.key === 'death', mid = g.key === 'dmg_in_p' || g.key === 'cast_e' || g.key === 'effect';
    sctx.fillStyle = css(g.col); sctx.globalAlpha = big ? 1 : mid ? .8 : .35; var hh = big ? h : mid ? h * .62 : h * .35;
    sctx.fillRect(X(e.t), h - hh, big ? 2.5 : 1, hh); });
  sctx.globalAlpha = 1; sctx.fillStyle = css('--fg'); sctx.fillRect(X(t) - 1, 0, 2, h);
}
strip.addEventListener('click', function(e){ var r = strip.getBoundingClientRect(); pause(); setT(T0 + (T1 - T0) * (e.clientX - r.left) / r.width); });

/* ---------- the log ---------- */
var logEl = document.getElementById('log');
function renderLog(){
  var vis = []; for (var i = 0; i < EV.length; i++) if (show[groupOf(EV[i]).key] !== false) vis.push(i);
  document.getElementById('logcount').textContent = vis.length + ' of ' + EV.length + ' events';
  var at = 0; while (at < vis.length && vis[at] <= curIdx) at++;
  var from = Math.max(0, at - 120), to = Math.min(vis.length, at + 80), h = '';
  if (from > 0) h += '<div class="row dim"><span></span><span></span><span>… ' + from + ' earlier</span></div>';
  for (var k = from; k < to; k++){ var e = EV[vis[k]], g = groupOf(e);
    h += '<div class="row' + (vis[k] === lastShown(at, vis) ? ' cur' : '') + (e.t > t ? ' future' : '') + '" data-i="' + vis[k] + '"><span class="t" title="' + esc(clockOf(e.t)) + '">' + esc(rel(e.t)) + '</span><span class="t">' + esc(clockOf(e.t).slice(0, 8)) + '</span>' +
      '<span><span class="chip" style="background:var(' + g.col + ')"></span>' + (e.map != null && e.map !== curMap ? '<span class="dim">m' + e.map + '</span> ' : '') + esc(e.text) +
      (e.hp ? ' <span class="hp">[' + e.hp[0] + '–' + (e.hp[1] == null ? '?' : e.hp[1]) + ']</span>' : '') + '</span></div>'; }
  if (to < vis.length) h += '<div class="row dim"><span></span><span></span><span>… ' + (vis.length - to) + ' later</span></div>';
  logEl.innerHTML = h;
  var cur = logEl.querySelector('.row.cur'); if (cur){ var top = cur.offsetTop - logEl.clientHeight * .45; if (Math.abs(logEl.scrollTop - top) > 30) logEl.scrollTop = top; }
}
function lastShown(at, vis){ return at > 0 ? vis[at - 1] : -1; }
logEl.addEventListener('click', function(e){ var r = e.target.closest('.row'); if (!r || r.dataset.i == null) return; pause(); setT(EV[Number(r.dataset.i)].t, { force:true }); });

/* ---------- each of ours, and the enemy: what it has taken so far ---------- */
function renderActors(force){
  var st = {};
  R.actors.forEach(function(a){ st[a.name] = { a:a, inMin:0, inMax:0, inN:0, outMin:0, outMax:0, outN:0, casts:0, refused:0, dead:false, lastDeath:null }; });
  function S(n){ if (!n) return null; for (var k in st) if (norm(k) === norm(n)) return st[k]; return null; }
  for (var i = 0; i <= curIdx; i++){ var e = EV[i];
    if (e.cat === 'hit_in_player' || e.cat === 'wall_in' || e.cat === 'hit_in_monster'){ var v = S(e.target || e.heard_by); if (v && e.hp){ v.inMin += e.hp[0]; v.inMax += e.hp[1] == null ? e.hp[0] : e.hp[1]; v.inN++; }
      var at = S(e.actor); if (at && e.hp && e.cat === 'hit_in_player'){ at.outMin += e.hp[0]; at.outMax += e.hp[1] == null ? e.hp[0] : e.hp[1]; at.outN++; } }
    else if (e.cat === 'hit_out'){ var o = S(e.actor); if (o && e.hp){ o.outMin += e.hp[0]; o.outMax += e.hp[1] == null ? e.hp[0] : e.hp[1]; o.outN++; }
      var tg = S(e.target); if (tg && e.hp){ tg.inMin += e.hp[0]; tg.inMax += e.hp[1] == null ? e.hp[0] : e.hp[1]; tg.inN++; } }
    else if (e.cat === 'cast_enemy' || e.cat === 'cast_ours'){ var c = S(e.actor); if (c) c.casts++; }
    else if (e.cat === 'refused'){ var r = S(e.actor); if (r) r.refused++; }
    else if (e.cat === 'death_ours' || e.cat === 'death_enemy'){ var d = S(e.target); if (d){ d.dead = true; d.lastDeath = e.t; d.inMin = 0; d.inMax = 0; } var kk = S(e.actor); if (kk) kk.kills = (kk.kills || 0) + 1; }
  }
  var rows = Object.keys(st).map(function(k){ return st[k]; }).filter(function(v){ return v.inN || v.outN || v.casts || v.refused || v.dead || v.a.side === 'enemy' || (TR[v.a.name] && posAt(v.a.name, t)); });
  rows.sort(function(p, q){ return (q.a.side === 'enemy') - (p.a.side === 'enemy') || (q.inMax - p.inMax) || p.a.name.localeCompare(q.a.name); });
  var h = '<table><tr><th>Body</th><th>map</th><th class="num" title="Estimated HP taken since the battle began, or since its last death">taken</th><th class="num" title="Estimated HP dealt to players">dealt</th><th class="num">casts</th><th class="num" title="Attacks the rules refused">refused</th></tr>';
  rows.forEach(function(v){ var p = posAt(v.a.name, t), hpTxt = v.inN ? v.inMin + '–' + v.inMax : '';
    var pct = v.a.max_hp && v.inN ? ' <span class="dim">(' + Math.round(100 * v.inMin / v.a.max_hp) + '–' + Math.round(100 * v.inMax / v.a.max_hp) + '%)</span>' : '';
    var justDied = v.lastDeath && t - v.lastDeath < 60000;
    h += '<tr data-n="' + esc(v.a.name) + '" class="' + (focus === v.a.name ? 'focus' : '') + (justDied ? ' dead' : '') + '"><td><span class="chip" style="background:var(' + (SIDE_COL[v.a.side] || '--other') + ')"></span>' + esc(v.a.name) + (justDied ? ' ✝' : '') + (v.a.faction ? ' <span class="dim">' + esc(v.a.faction) + '</span>' : '') + '</td>' +
      '<td class="dim">' + (p ? p.map : '') + '</td><td class="num">' + hpTxt + pct + '</td><td class="num">' + (v.outN ? v.outMin + '–' + v.outMax : '') + '</td><td class="num">' + (v.casts || '') + '</td><td class="num">' + (v.refused || '') + '</td></tr>'; });
  document.getElementById('actors').innerHTML = h + '</table>';
}
document.getElementById('actors').addEventListener('click', function(e){ var r = e.target.closest('tr[data-n]'); if (!r) return; var n = r.dataset.n; focus = focus === n ? null : n;
  var p = posAt(n, t); if (focus && p && p.map !== curMap && GEO[p.map]) setMap(p.map); renderActors(); draw(); });

/* ---------- go ---------- */
drawMapButtons();
var q = new URLSearchParams(location.search);
if (q.get('map') && GEO[Number(q.get('map'))]){ curMap = Number(q.get('map')); follow = false; drawMapButtons(); }
window.addEventListener('resize', function(){ resize(); drawStrip(); });
resize(); fitAction();
setT(q.get('t') ? Number(q.get('t')) : R.start - 3000, { force:true });
</script></body></html>`;
