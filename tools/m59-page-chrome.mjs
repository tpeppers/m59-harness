// THE PARTS EVERY BOARD SHARES, IN ONE PLACE, BECAUSE THE NAV IS THE THING THAT ROTS.
//
// There are eight pages now — Fleet, DUM bot, Harness, Post mortems, Tougher, Economy,
// Skills, Stats — and each one carries a tab bar naming the other seven. Written per page
// that is eight copies of
// one list, and the failure is not that they look different: it is that a page added to
// seven of them is INVISIBLE from the eighth, and nothing errors. The fleet board and the
// deaths page had already drifted into two separate copies of the same `<nav>` before
// this file existed.
//
// So the nav, the stylesheet and the treemap live here and every page imports them. A
// new tab is one line, once.
//
// The treemap was inlined rather than loaded from a CDN, and it stays that way: these
// pages are served by the machine running the game server and are meant to be read from
// a phone on its LAN, which is exactly the situation where an unrelated CDN is not
// reachable. A treemap that renders as a blank rectangle when the internet is down is
// worse than no treemap.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, m =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

export function ago(t) {
  if (!t) return 'never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

// A round number with thousands separators. Money on this fleet reaches five figures
// across twenty-one characters and `12345` next to `1234` is unreadable in a column.
export const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-GB'));

// ------------------------------------------------------------------ the tab bar
//
// `here` is the page's own key; everything else is a link. A key nothing matches simply
// leaves no tab highlighted, which is the right failure — a page that forgets to name
// itself still gets a working nav.
// A MAGIC ITEM, MARKED WHEREVER A PACK IS LISTED.
//
// Operator, 2026-09-17: identify magic items with a "(magic)" and a mouse-over tooltip carrying
// the full description text, anywhere an inventory shows on the fleet pages. One renderer, used
// by every board, because the alternative is each page deciding for itself what magic means —
// and this repository already has the receipt for that: six boards share this tab bar because a
// seventh written by hand was invisible from whichever copy nobody edited.
//
// WHAT IT WILL NOT DO IS GUESS. `magicOf` answers null when nothing is known, which is not the
// same as "ordinary" — an item nobody has looked at has no description to show, and a page that
// rendered that as a plain name would be asserting it is mundane. So there are three states and
// the markup says which: a grade the server gave us, an attribute we have READ, and silence.
//
// THE TOOLTIP IS A `title` ATTRIBUTE AND THAT IS DELIBERATE. Every other figure on these boards
// is server-rendered and readable with the broker down; a hover that needs a script is a hover
// that is missing in exactly the situation somebody is reading the page urgently.
export function magicTag(m) {
  if (!m) return '';
  const cls = m.grade === 'cursed' ? 'magic cursed'
            : m.grade === 'unidentified' ? 'magic unread' : 'magic';
  const label = m.grade === 'cursed' ? '(cursed)'
              : m.grade === 'unidentified' ? '(magic, unread)' : '(magic)';
  // The description first, because it is what was asked for and what a person wants; the reason
  // under it, because "why does this say magic" is the next question and the page should not
  // make anybody go and find out.
  const tip = [m.text, m.verdict ? `verdict: ${m.verdict}` : null, m.why]
    .filter(Boolean).join('\n\n');
  return ` <span class="${cls}" title="${esc(tip)}">${label}</span>`;
}

export const TABS = [
  { key: 'fleet', href: '/', label: 'Fleet' },
  { key: 'dum', href: '/dum', label: 'DUM bot' },
  { key: 'harness', href: '/harness', label: 'Harness' },
  { key: 'deaths', href: '/deaths', label: 'Post mortems' },
  { key: 'tougher', href: '/tougher', label: 'Tougher' },
  { key: 'economy', href: '/economy', label: 'Economy' },
  { key: 'inventory', href: '/inventory', label: 'Inventory' },
  { key: 'skills', href: '/skills', label: 'Skills' },
  { key: 'stats', href: '/stats', label: 'Stats' },
  { key: 'players', href: '/players', label: 'Players' },
];

export const NAV = (here) => `
  <nav class="tabs">${TABS.map(t =>
    `\n    <a href="${t.href}"${t.key === here ? ' class="on"' : ''}>${t.label}</a>`).join('')}
  </nav>`;

export const STYLE = `
  /* A magic item's marker. The cursed variant is red because it is the one irreversible
     mistake here; the unread one is dimmed because it is a backlog, not a property. */
  .magic { font-size:.75em; color:#b48ead; white-space:nowrap; cursor:help;
           border-bottom:1px dotted currentColor; }
  .magic.cursed { color:#bf616a; }
  .magic.unread { color:#8a8a8a; }

  :root { color-scheme: light dark; --fg:#1a1a1a; --dim:#767676; --bg:#fbfbfa;
          --panel:#fff; --line:#e6e4e0; --good:#1a7f4b; --bad:#b3261e; --accent:#5b6ee1;
          --edge:#c2700a; --mana:#2563eb; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e6e3; --dim:#8b8b8b; --bg:#16161a; --panel:#1e1e24;
            --line:#2e2e36; --good:#4ade80; --bad:#f87171; --accent:#8b9bff;
            --edge:#fbaa3e; --mana:#60a5fa; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:1.5rem 1rem 4rem; background:var(--bg); color:var(--fg);
         font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  .wrap { max-width:1100px; margin:0 auto; }
  h1 { font-size:1.4rem; margin:0 0 .25rem; letter-spacing:-.01em; }
  h2 { font-size:1rem; margin:2rem 0 .5rem; letter-spacing:.01em; }
  .sub { color:var(--dim); font-size:.85rem; margin-bottom:1rem; }
  .tabs { display:flex; gap:.25rem; margin:0 0 1.5rem; border-bottom:1px solid var(--line);
          flex-wrap:wrap; }
  .tabs a { padding:.5rem .9rem; text-decoration:none; color:var(--dim); font-size:.9rem;
            border-bottom:2px solid transparent; margin-bottom:-1px; }
  .tabs a.on { color:var(--fg); border-bottom-color:var(--accent); font-weight:600; }
  .tabs a:hover { color:var(--fg); }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
           gap:.75rem; margin-bottom:1.5rem; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:.85rem 1rem; }
  .card .k { color:var(--dim); font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; }
  .card .v { font-size:1.5rem; font-weight:600; line-height:1.2; }
  .card .n { color:var(--dim); font-size:.75rem; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px;
           padding:1rem; margin-bottom:1.25rem; }
  .facets { display:flex; gap:.4rem; flex-wrap:wrap; margin-bottom:.75rem; }
  .facets button { font:inherit; font-size:.82rem; padding:.35rem .8rem; cursor:pointer;
                   border:1px solid var(--line); background:transparent; color:var(--dim);
                   border-radius:999px; }
  .facets button.on { background:var(--accent); border-color:var(--accent); color:#fff; }
  /* THE HOLE IN THE DATA, RENDERED AS A HOLE. An excluded death is not a smaller
     rectangle, it is an absent one, and the banner is the only thing that says so. */
  .caveat { border-left:3px solid var(--edge); padding:.5rem .8rem; margin:.75rem 0 0;
            background:color-mix(in srgb, var(--edge) 8%, transparent);
            font-size:.82rem; color:var(--fg); border-radius:0 6px 6px 0; }
  #tm { width:100%; height:460px; display:block; }
  #tm rect { stroke:var(--panel); stroke-width:1.5px; cursor:pointer; }
  #tm rect:hover { stroke:var(--fg); stroke-width:2px; }
  #tm text { pointer-events:none; font:12px ui-sans-serif,system-ui,sans-serif; fill:#fff; }
  /* WHITE-ON-WHITE. Labels are white because they sit on coloured rectangles, and that
     rule also caught the "nothing to show" message, which sits on the page background —
     so an empty treemap rendered as a blank panel with the explanation invisible inside
     it. Found by looking at the Tougher page on its first day, when there was genuinely
     nothing to show and the page said so in white text on white. */
  #tm text.empty-label { fill:var(--dim); font-size:13px; }
  #tm text.sm { font-size:10px; opacity:.75; }
  #tm .leafname { font-size:10px; opacity:.85; }
  .tip { position:fixed; pointer-events:none; background:var(--panel); color:var(--fg);
         border:1px solid var(--line); border-radius:8px; padding:.45rem .65rem;
         font-size:.8rem; box-shadow:0 4px 14px rgba(0,0,0,.18); opacity:0;
         transition:opacity .1s; max-width:260px; z-index:10; }
  /* A SIX-COLUMN TABLE OF ROOM NAMES IS WIDER THAN A PHONE, AND WIDER THAN THIS PAGE.
     Without this the table pushes the whole document past the viewport and everything
     scrolls sideways — including the header, the cards and the treemap, none of which
     are too wide. Caught by looking at it: the treemap's right-hand rectangles and the
     last column of the death report were both off-screen. The table scrolls inside its
     own panel instead, and keeps a min-width so it degrades to a scroll rather than to
     a column of single words. */
  .scroller { overflow-x:auto; }
  table { width:100%; min-width:640px; border-collapse:collapse; font-size:.85rem; }
  th { text-align:left; font-weight:600; color:var(--dim); font-size:.72rem;
       text-transform:uppercase; letter-spacing:.05em; padding:.4rem .5rem;
       border-bottom:1px solid var(--line); }
  td { padding:.4rem .5rem; border-bottom:1px solid var(--line); vertical-align:top; }
  tr.death { cursor:pointer; }
  tr.death:hover td { background:color-mix(in srgb, var(--accent) 7%, transparent); }
  .dim { color:var(--dim); }
  .bad { color:var(--bad); }
  .good { color:var(--good); }
  /* AT RISK IS NOT BROKEN. Red is what a page uses for a row that is failing, and
     spending it on "this is worth watching" leaves nothing louder for the real thing. */
  .warn { color:var(--edge); }
  .guess { color:var(--edge); font-size:.75rem; }
  .num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .pill { font-size:.68rem; padding:.05rem .4rem; border-radius:999px; border:1px solid var(--line);
          color:var(--dim); white-space:nowrap; }
  .pill.obs { border-color:var(--good); color:var(--good); }
  .pill.inf { border-color:var(--edge); color:var(--edge); }
  .detail td { background:color-mix(in srgb, var(--accent) 4%, transparent); }
  .detail .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr));
           gap:.6rem 1.2rem; }
  .detail td { max-width:0; }   /* let the grid track the table, not the other way round */
  .detail .kv .k { color:var(--dim); font-size:.7rem; text-transform:uppercase; letter-spacing:.05em; }
  .log { font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; margin:.6rem 0 0;
         max-height:230px; overflow:auto; background:var(--bg); border:1px solid var(--line);
         border-radius:6px; padding:.5rem .6rem; }
  .log div { white-space:pre-wrap; }
  .log .t { color:var(--dim); }
  .trail { font:12px ui-monospace,monospace; letter-spacing:-.5px; }
  a { color:var(--accent); }
  .empty { color:var(--dim); padding:2rem 0; text-align:center; }
  /* A NUMBER IN A CELL, WITH ITS SIZE BEHIND IT. Used by the ability sheet and the
     economy table: the bar is a background wash rather than a separate column, so a
     twenty-one-row table still fits a phone and the shape is still scannable. */
  .meter { position:relative; display:block; padding:.05rem .35rem; border-radius:4px;
           font-variant-numeric:tabular-nums; text-align:right; }
  .meter i { position:absolute; inset:0 auto 0 0; border-radius:4px; display:block;
             background:color-mix(in srgb, var(--accent) 22%, transparent); }
  .meter b { position:relative; font-weight:600; }
  .meter.good i { background:color-mix(in srgb, var(--good) 24%, transparent); }
  .meter.edge i { background:color-mix(in srgb, var(--edge) 26%, transparent); }
`;

// The layout on its own, with no DOM in it, so that m59-deaths-test.mjs can evaluate
// this exact string and check the rectangles it produces. A treemap that is subtly wrong
// still looks like a treemap, which is the whole reason to test it rather than squint.
export const SQUARIFY_JS = `
// ---- d3-hierarchy's squarified treemap, inlined. https://d3js.org/d3-hierarchy/treemap
// Squarify lays each row along the SHORTER side of the remaining rectangle and keeps
// adding to that row while doing so IMPROVES the worst aspect ratio in it. That is the
// whole trick: it is what stops a treemap becoming a row of slivers, and it is why the
// rectangles stay readable when one category dwarfs the rest — which is exactly this
// data, where one room holds a quarter of the deaths.
function worst(row, w, s) {
  if (!row.length) return Infinity;
  var rmax = -Infinity, rmin = Infinity, sum = 0, i;
  for (i = 0; i < row.length; i++) {
    var v = row[i].value * s;
    if (v > rmax) rmax = v;
    if (v < rmin) rmin = v;
    sum += v;
  }
  if (!(rmin > 0) || !(sum > 0)) return Infinity;   // a zero-value node has no aspect ratio
  return Math.max(w * w * rmax / (sum * sum), sum * sum / (w * w * rmin));
}
function squarify(nodes, x0, y0, x1, y1) {
  var out = [], items = nodes.slice().filter(function (n) { return n.value > 0; })
                              .sort(function (a, b) { return b.value - a.value; });
  var i = 0;
  while (i < items.length) {
    // The shorter side. Rows are laid along it, which is what keeps them square-ish.
    var w = Math.min(x1 - x0, y1 - y0);
    if (!(w > 0)) break;
    var remaining = 0;
    for (var q = i; q < items.length; q++) remaining += items[q].value;
    var s = (x1 - x0) * (y1 - y0) / remaining;      // value -> area, for what is LEFT
    var row = [], best = Infinity, j = i;
    while (j < items.length) {
      var r = worst(row.concat([items[j]]), w, s);
      if (r > best) break;                          // adding it makes the row worse: stop
      row.push(items[j]); best = r; j++;
    }
    if (!row.length) { row = [items[i]]; j = i + 1; }
    var rowArea = 0;
    for (var m = 0; m < row.length; m++) rowArea += row[m].value * s;
    // \`wide\` means the remaining rectangle is wider than tall, so this row becomes a
    // COLUMN down its left edge — laid along the short side, which is the height.
    var wide = (x1 - x0) >= (y1 - y0);
    var thick = rowArea / w;                        // how deep the row/column is
    var off = wide ? y0 : x0;
    for (var k = 0; k < row.length; k++) {
      var len = (row[k].value * s) / thick;
      out.push(wide
        ? { node: row[k], x0: x0, y0: off, x1: x0 + thick, y1: Math.min(off + len, y1) }
        : { node: row[k], x0: off, y0: y0, x1: Math.min(off + len, x1), y1: y0 + thick });
      off += len;
    }
    if (wide) x0 += thick; else y0 += thick;
    i = j;
  }
  return out;
}
`;

// THE TREEMAP, and the tooltip, and the drill-down. One script for every page that has
// one — they differ only in the data handed to it.
export const TREEMAP_JS = SQUARIFY_JS + `
var SVGNS = 'http://www.w3.org/2000/svg';
var el = function (n, a) { var e = document.createElementNS(SVGNS, n);
  for (var k in a) e.setAttribute(k, a[k]); return e; };

// Colour by rank rather than by value: with one category at 25% and a tail at 1%, a
// value ramp is one bright block and a wall of identical dark ones. Rank keeps the tail
// distinguishable, which is where the surprises are.
// "1 points" is the reading you get on day one of a record that counts rare events, and
// it is the reading a person sees first. Singular by stripping the s, which is enough for
// "deaths" and "points" and is all this needs to cover.
function unitOf(n, unit) { return n === 1 ? unit.replace(/s$/, '') : unit; }
function hue(i, n) { return 'hsl(' + Math.round(210 + (i / Math.max(1, n)) * 130) % 360 +
  ' 55% ' + (34 + 26 * (1 - i / Math.max(1, n))).toFixed(0) + '%)'; }

var TIP = document.createElement('div');
TIP.className = 'tip'; document.body.appendChild(TIP);
function showTip(e, html) {
  TIP.innerHTML = html; TIP.style.opacity = 1;
  var x = Math.min(e.clientX + 14, window.innerWidth - 280);
  TIP.style.left = x + 'px'; TIP.style.top = (e.clientY + 16) + 'px';
}
function hideTip() { TIP.style.opacity = 0; }

var DRILL = null;                                   // which top-level box is opened
function drawTreemap(data, opts) {
  var svg = document.getElementById('tm');
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  var W = svg.clientWidth || 900, H = svg.clientHeight || 460;
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  var rows = data.children || [];
  if (!rows.length) {
    var t = el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'empty-label' });
    t.textContent = opts.empty || 'nothing to show';
    svg.appendChild(t); return;
  }
  // DRILLED IN: one category, split by character. Same layout, different question —
  // "the border of the Badlands killed 36" versus "it killed Zoot 9 times".
  var top = DRILL ? rows.filter(function (r) { return r.name === DRILL; }) : rows;
  var laid = DRILL
    ? squarify((top[0] && top[0].children) || [], 0, 0, W, H)
    : squarify(rows, 0, 0, W, H);
  var n = laid.length;
  laid.forEach(function (b, i) {
    var g = el('g', {});
    var r = el('rect', { x: b.x0, y: b.y0, width: Math.max(0, b.x1 - b.x0),
                         height: Math.max(0, b.y1 - b.y0), fill: hue(i, n), rx: 2 });
    var name = b.node.name, val = b.node.value;
    var pct = data.total ? Math.round(1000 * val / data.total) / 10 : null;
    // WHAT A CLICK ACTUALLY SPLITS BY IS PER FACET, and saying "by character" on a map
    // that is already keyed by character is how a drill-down that shows the same number
    // twice goes unnoticed — it renders perfectly. Facets that have no children say so
    // rather than inviting a click that blanks the map.
    var drill = b.node.children && b.node.children.length ? (data.drill || 'character') : null;
    r.addEventListener('mousemove', function (e) {
      showTip(e, '<b>' + name + '</b><br>' + val + ' ' + unitOf(val, opts.unit) +
        (pct != null ? ' · ' + pct + '% of ' + data.total : '') +
        (DRILL || !drill ? '' : '<br><span style="opacity:.7">click to split by ' + drill + '</span>'));
    });
    r.addEventListener('mouseleave', hideTip);
    r.addEventListener('click', function () {
      if (!DRILL && !drill) return;                 // nothing underneath: do not blank it
      DRILL = DRILL ? null : name; hideTip(); drawTreemap(data, opts);
    });
    g.appendChild(r);
    var w = b.x1 - b.x0, h = b.y1 - b.y0;
    if (w > 46 && h > 22) {
      var label = el('text', { x: b.x0 + 6, y: b.y0 + 16 });
      label.textContent = name.length > Math.floor(w / 7) ? name.slice(0, Math.floor(w / 7) - 1) + '…' : name;
      g.appendChild(label);
      if (h > 36) {
        var v = el('text', { x: b.x0 + 6, y: b.y0 + 31, class: 'sm' });
        v.textContent = val + ' ' + unitOf(val, opts.unit);
        g.appendChild(v);
      }
    }
    svg.appendChild(g);
  });
  var back = document.getElementById('tm-back');
  if (back) { back.style.display = DRILL ? '' : 'none';
              back.textContent = '← all (' + DRILL + ')'; }
}

function pickFacet(key) {
  DRILL = null;
  var f = FACETS[key];
  document.querySelectorAll('.facets button').forEach(function (b) {
    b.classList.toggle('on', b.dataset.facet === key);
  });
  document.getElementById('facet-note').textContent = f.note || '';
  drawTreemap(f, { unit: f.unit || 'deaths', empty: f.empty });
}
window.addEventListener('resize', function () {
  var on = document.querySelector('.facets button.on');
  if (on) { var f = FACETS[on.dataset.facet]; drawTreemap(f, { unit: f.unit || 'deaths', empty: f.empty }); }
});
`;

// The three lines every treemap page repeats to wire its buttons up. Here so a page is
// its data and its prose, and nothing else.
export const FACET_WIRING_JS = `
document.querySelectorAll('.facets button[data-facet]').forEach(function (b) {
  b.addEventListener('click', function () { pickFacet(b.dataset.facet); });
});
document.getElementById('tm-back').addEventListener('click', function () {
  DRILL = null;
  var on = document.querySelector('.facets button.on');
  var f = FACETS[on.dataset.facet];
  drawTreemap(f, { unit: f.unit, empty: f.empty });
});
`;
