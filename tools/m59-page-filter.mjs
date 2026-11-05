// EVERY BOARD IS ABOUT CHARACTERS, SO EVERY BOARD CAN BE ASKED ABOUT ONE OF THEM.
//
// Operator, 2026-11-04: "the basic unit of the inter-link is each page is a character" —
// a filter on every table, list and chart that lists fleet members, and every fleetmate's
// name a link to their hero page, the way the fleet board's character column already was.
//
// There are nineteen boards and they are written by different sessions, so doing that per
// page is nineteen copies of one behaviour that drift the day a twentieth page is added —
// the receipt for that is the tab bar itself (m59-page-chrome.mjs). So it is ONE script,
// shipped inside NAV(), which every board already renders. A page that has a tab bar has
// filters and links, including pages nobody has written yet.
//
// What it does, in the order a reader meets it:
//
//   1. `?who=Name` is the page-wide filter. The tab bar carries it from page to page, a
//      picker at the end of the tab bar sets it, and a banner says it is on — a filtered
//      page that does not say so is a page that reads "Janice has no deaths" as "nobody
//      does". The broker ALSO narrows the data server-side for the boards whose cards and
//      charts are built per character (deaths, tougher, skills, travel, stats, economy,
//      inventory, maximums, factions), so the totals and the treemaps agree with the rows.
//      `/pvp` is deliberately not narrowed server-side: it uses the roster to decide who is
//      OURS, and a roster of one would file every other fleetmate as an enemy.
//   2. Every fleetmate's name in a table cell, list item, card or log line becomes a link to
//      `/hero/<name>`. Whole words, case-sensitive, roster names only — never a stranger,
//      because the roster is the only list here that is exactly "ours".
//   3. Every table of 4+ rows, list of 8+ items, log of 8+ lines, and card grid keyed by
//      character gets a filter bar: free text (every word must match) plus a character
//      picker listing the fleetmates that table actually mentions. The text survives the
//      boards' meta-refresh because it is written back into the URL.
//   4. `?embed=1` (or being inside a frame) hides the chrome, so the hero page can show
//      any board filtered to one character as a tab. Links to OTHER pages open at the top
//      level; links to the same board stay in the frame and keep the filter.
//
// It is a progressive enhancement and nothing more: with scripts off, or with the roster
// endpoint unreachable, every page renders exactly as it did. The figures on these boards
// are server-rendered so they read when the broker is struggling, and this must not change
// that.
//
// NO BACKTICK AND NO DOLLAR-BRACE IN THE SCRIPT BODY. It is a String.raw template, so the
// first would end it and the second would be interpolated at import time.

export const FLEET_FILTER_JS = String.raw`
(function () {
  if (window.__m59Filter) return;
  window.__m59Filter = true;
  var params = new URLSearchParams(location.search);
  var WHO = params.get('who') || '';
  var EMBED = params.get('embed') === '1';
  try { if (window.self !== window.top) EMBED = true; } catch (e) { EMBED = true; }
  var NAMES = [], NAME_RE = null;

  var CSS = [
    '.m59f-bar{display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;margin:.35rem 0 .35rem;font-size:.8rem}',
    '.m59f-bar input,.m59f-bar select{font:inherit;font-size:.8rem;padding:.2rem .45rem;border:1px solid var(--line,#ccc);',
    '  border-radius:6px;background:var(--panel,#fff);color:inherit}',
    '.m59f-bar input{min-width:12rem}',
    '.m59f-bar .m59f-n{color:var(--dim,#777)}',
    '.m59f-bar.on input,.m59f-bar.on select.set{border-color:var(--accent,#5b6ee1)}',
    '.m59f-hide{display:none !important}',
    'nav.tabs .m59f-pick{margin-left:auto;align-self:center;font:inherit;font-size:.8rem;padding:.15rem .4rem;',
    '  border:1px solid var(--line,#ccc);border-radius:6px;background:var(--panel,#fff);color:inherit}',
    '.m59f-banner{margin:-1rem 0 1rem;padding:.4rem .7rem;font-size:.85rem;border-left:3px solid var(--accent,#5b6ee1);',
    '  background:color-mix(in srgb,var(--accent,#5b6ee1) 8%,transparent);border-radius:0 6px 6px 0}',
    'a.m59f-who{text-decoration:none;border-bottom:1px dotted currentColor}',
    'html.m59f-embed body{padding:.4rem .4rem 1rem !important}',
    'html.m59f-embed nav.tabs,html.m59f-embed .m59f-banner,html.m59f-embed .back{display:none !important}',
    'html.m59f-embed .wrap,html.m59f-embed main{max-width:none !important}',
    'html.m59f-embed h1{font-size:1.05rem !important}'
  ].join('\n');

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }
  function escRe(s) { return s.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&'); }
  function nameRe(names, flags) {
    return new RegExp("(?<![A-Za-z0-9_'])(" + names.map(escRe).join('|') + ")(?![A-Za-z0-9_'])", flags);
  }
  function setParam(k, v) {
    var u = new URL(location.href);
    if (v) u.searchParams.set(k, v); else u.searchParams.delete(k);
    history.replaceState(null, '', u);
  }

  // ---------------------------------------------------------------- 2. names become links
  var SKIP = 'a,script,style,textarea,select,option,button,input,svg,nav,title,head,h1,label,[data-nolink],.m59f-bar,.m59f-banner';
  function linkNames(root) {
    if (!NAME_RE || !root) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: function (n) {
      var v = n.nodeValue;
      if (!v || v.length < 2) return NodeFilter.FILTER_REJECT;
      var p = n.parentElement;
      if (!p || p.closest(SKIP)) return NodeFilter.FILTER_REJECT;
      NAME_RE.lastIndex = 0;
      return NAME_RE.test(v) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    } });
    var hits = [], n;
    while ((n = walker.nextNode()) && hits.length < 6000) hits.push(n);
    hits.forEach(function (t) {
      var s = t.nodeValue, frag = document.createDocumentFragment(), last = 0, m;
      NAME_RE.lastIndex = 0;
      while ((m = NAME_RE.exec(s))) {
        frag.appendChild(document.createTextNode(s.slice(last, m.index)));
        var a = document.createElement('a');
        a.href = '/hero/' + encodeURIComponent(m[1]);
        a.className = 'hero m59f-who';
        a.textContent = m[1];
        if (EMBED) a.target = '_top';
        frag.appendChild(a);
        last = m.index + m[0].length;
      }
      frag.appendChild(document.createTextNode(s.slice(last)));
      if (t.parentNode) t.parentNode.replaceChild(frag, t);
    });
  }

  // ---------------------------------------------------------------- 3. the filter bars
  // A table's rows come in GROUPS: the deaths board inserts a 'detail' row under the one you
  // clicked, and hiding the parent while leaving its report showing would be nonsense.
  function tableItems(table) {
    var groups = [];
    for (var b = 0; b < table.tBodies.length; b++) {
      var rows = table.tBodies[b].rows;
      for (var i = 0; i < rows.length; i++) {
        var tr = rows[i];
        if (!tr.querySelector('td')) continue;                    // a header row inside tbody
        if (tr.classList.contains('detail') && groups.length) groups[groups.length - 1].push(tr);
        else groups.push([tr]);
      }
    }
    return groups;
  }
  function childItems(el, sel) {
    return Array.prototype.filter.call(el.children, function (c) { return c.matches(sel); })
      .map(function (c) { return [c]; });
  }
  function namesIn(text) {
    return NAMES.filter(function (nm) { return nameRe([nm], '').test(text); });
  }

  var BARS = [];
  function attach(container, items, before) {
    if (container.dataset.m59f) return;
    container.dataset.m59f = String(BARS.length);
    var idx = BARS.length;
    var bar = document.createElement('div');
    bar.className = 'm59f-bar';
    var input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'filter ' + items().length + ' rows…';
    input.value = params.get('f' + idx) || '';
    var pick = document.createElement('select');
    pick.title = 'only rows that mention this character';
    var count = document.createElement('span');
    count.className = 'm59f-n';
    bar.appendChild(input); bar.appendChild(pick); bar.appendChild(count);
    before.parentNode.insertBefore(bar, before);
    var state = { container: container, items: items, input: input, pick: pick, count: count, bar: bar,
                  hasNames: false, idx: idx };
    input.addEventListener('input', function () { setParam('f' + idx, input.value.trim()); apply(state); });
    pick.addEventListener('change', function () { setParam('n' + idx, pick.value); apply(state); });
    BARS.push(state);
    fillPick(state);
    apply(state);
  }
  function fillPick(state) {
    var text = state.container.textContent;
    var present = namesIn(text);
    state.hasNames = present.length > 0;
    var want = params.get('n' + state.idx) || (state.hasNames ? WHO : '') || '';
    if (want && present.indexOf(want) < 0 && NAMES.indexOf(want) >= 0) present.push(want);
    state.pick.innerHTML = '';
    var all = document.createElement('option');
    all.value = ''; all.textContent = 'all characters';
    state.pick.appendChild(all);
    present.sort().forEach(function (nm) {
      var o = document.createElement('option'); o.value = nm; o.textContent = nm;
      state.pick.appendChild(o);
    });
    state.pick.value = want;
    state.pick.style.display = present.length ? '' : 'none';
  }
  function apply(state) {
    var terms = state.input.value.toLowerCase().split(/\s+/).filter(Boolean);
    var who = state.pick.value;
    var re = who ? nameRe([who], '') : null;
    var groups = state.items(), shown = 0;
    groups.forEach(function (g) {
      var text = g.map(function (r) { return r.textContent; }).join(' ');
      var low = text.toLowerCase();
      var ok = terms.every(function (t) { return low.indexOf(t) >= 0; }) && (!re || re.test(text));
      g.forEach(function (r) { r.classList.toggle('m59f-hide', !ok); });
      if (ok) shown++;
    });
    state.count.textContent = (terms.length || who) ? shown + ' of ' + groups.length : groups.length + ' rows';
    state.bar.classList.toggle('on', !!(terms.length || who));
    state.pick.classList.toggle('set', !!who);
    if (EMBED) reportHeight();
  }

  function scan() {
    document.querySelectorAll('table').forEach(function (t) {
      if (t.dataset.m59f || t.closest('.m59f-bar,nav,[data-nofilter]')) return;
      var items = function () { return tableItems(t); };
      if (items().length < 4) return;
      var p = t.parentElement, before = t;
      if (p && /scroll/.test(p.className) && p.children.length === 1) before = p;
      attach(t, items, before);
    });
    document.querySelectorAll('ul,ol').forEach(function (l) {
      if (l.dataset.m59f || l.closest('nav,.m59f-bar,[data-nofilter]')) return;
      var items = function () { return childItems(l, 'li'); };
      if (items().length >= 8) attach(l, items, l);
    });
    document.querySelectorAll('.log').forEach(function (l) {
      if (l.dataset.m59f || l.closest('[data-nofilter]')) return;
      var items = function () { return childItems(l, 'div'); };
      if (items().length >= 8) attach(l, items, l);
    });
    // A grid of cards keyed by character (the kill feed, a build's members) is a list too.
    if (NAMES.length) document.querySelectorAll('.cards').forEach(function (g) {
      if (g.dataset.m59f || g.closest('[data-nofilter]')) return;
      var cards = childItems(g, '.card');
      var keyed = cards.filter(function (c) {
        var k = c[0].querySelector('.k');
        return k && NAMES.indexOf(k.textContent.trim()) >= 0;
      });
      if (keyed.length >= 3) attach(g, function () { return childItems(g, '.card'); }, g);
    });
  }

  // ---------------------------------------------------------------- 1. the page-wide filter
  function decorateNav() {
    var nav = document.querySelector('nav.tabs');
    if (!nav || nav.dataset.m59f) return;
    nav.dataset.m59f = '1';
    if (WHO) nav.querySelectorAll('a[href^="/"]').forEach(function (a) {
      var u = new URL(a.getAttribute('href'), location.origin);
      u.searchParams.set('who', WHO);
      a.setAttribute('href', u.pathname + u.search);
    });
    if (!NAMES.length) return;
    var pick = document.createElement('select');
    pick.className = 'm59f-pick';
    pick.title = 'show every board for one character';
    var all = document.createElement('option');
    all.value = ''; all.textContent = 'all characters';
    pick.appendChild(all);
    NAMES.forEach(function (nm) {
      var o = document.createElement('option'); o.value = nm; o.textContent = nm; pick.appendChild(o);
    });
    // On a hero page the picker is "go to another character", keeping the open tab.
    var hero = /^\/hero\/([^/]+)/.exec(location.pathname);
    pick.value = hero ? decodeURIComponent(hero[1]) : WHO;
    pick.addEventListener('change', function () {
      if (hero) {
        location.href = pick.value ? '/hero/' + encodeURIComponent(pick.value) + location.hash : '/fleet';
        return;
      }
      var u = new URL(location.href);
      if (pick.value) u.searchParams.set('who', pick.value); else u.searchParams.delete('who');
      for (var k of Array.from(u.searchParams.keys())) if (/^[fn]\d+$/.test(k)) u.searchParams.delete(k);
      location.href = u.toString();
    });
    nav.appendChild(pick);
    if (WHO) {
      var u = new URL(location.href);
      u.searchParams.delete('who');
      var banner = document.createElement('div');
      banner.className = 'm59f-banner';
      banner.innerHTML = 'Showing only <a class="hero" href="/hero/' + encodeURIComponent(WHO) + '"></a>' +
        ' on this board and on every tab above · <a href="' + u.pathname + u.search + '">show everyone</a>';
      banner.querySelector('a').textContent = WHO;
      nav.parentNode.insertBefore(banner, nav.nextSibling);
    }
  }

  // ---------------------------------------------------------------- 4. inside a hero page
  var lastH = 0;
  function reportHeight() {
    var h = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    if (Math.abs(h - lastH) < 4) return;
    lastH = h;
    try { parent.postMessage({ m59height: h, href: location.href }, location.origin); } catch (e) {}
  }
  function embedLinks() {
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href]');
      if (!a || a.target) return;
      var href = a.getAttribute('href');
      if (!href || href.charAt(0) === '#' || /^javascript:/i.test(href)) return;
      var u = new URL(href, location.href);
      if (u.origin === location.origin && u.pathname === location.pathname) {
        if (WHO) u.searchParams.set('who', WHO);
        u.searchParams.set('embed', '1');
        a.href = u.toString();                       // same board: stay in the frame
      } else a.target = '_top';                       // another page: leave the frame
    }, true);
  }

  if (EMBED) document.documentElement.classList.add('m59f-embed');
  var style = document.createElement('style');
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);

  ready(function () {
    if (EMBED) {
      embedLinks();
      if (window.ResizeObserver) new ResizeObserver(reportHeight).observe(document.body);
      reportHeight();
    }
    scan();
    fetch('/fleet-names.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (body) {
        NAMES = (body && Array.isArray(body.names) ? body.names : []).filter(Boolean);
        NAMES.sort(function (a, b) { return a.localeCompare(b); });
        if (NAMES.length) {
          var longest = NAMES.slice().sort(function (a, b) { return b.length - a.length; });
          NAME_RE = nameRe(longest, 'g');
          linkNames(document.body);
        }
        decorateNav();
        scan();
        BARS.forEach(function (s) { fillPick(s); apply(s); });
      });
    window.addEventListener('load', function () { scan(); if (EMBED) reportHeight(); });
  });
})();
`;

// Server-side half of `?who=`. Narrows a board's character list to the one asked for, in
// whichever shape that board takes it — a Set or array of names, or `{agent, character}`
// rows — and returns it unchanged when nothing was asked. Case-insensitive, because the
// value arrives off a URL a person typed.
export function narrowToWho(characters, who) {
  if (!who) return characters;
  const want = String(who).toLowerCase();
  const nameOf = c => String(typeof c === 'string' ? c : c?.character ?? '').toLowerCase();
  if (characters instanceof Set) return new Set([...characters].filter(c => nameOf(c) === want));
  if (Array.isArray(characters)) return characters.filter(c => nameOf(c) === want);
  return characters;
}
