// site.js -- search, table sort, table filter, theme toggle, research reports.  No dependencies.

(function () {
  var rel = window.M59_REL || '..';

  // ------------------------------------------------------------- theme
  var toggle = document.getElementById('themeToggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      if (!cur) {
        cur = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      var next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('m59-theme', next); } catch (e) {}
    });
  }

  // ------------------------------------------------------------- search
  var q = document.getElementById('q');
  var box = document.getElementById('results');
  var index = null, loading = false, sel = -1, waiting = null;

  // Keys typed while the index is still loading are not dropped: the LAST one's search
  // runs when it arrives, or the box shows results for "d" under a query of "disciple".
  function load(cb) {
    if (index) return cb();
    waiting = cb;
    if (loading) return;
    loading = true;
    cb = function () { if (waiting) waiting(); };
    // The research reports are a second, optional index: served only where a compendium
    // server has a reports directory beside it, so its absence is not a failure.
    var extra = fetch(rel + '/reports/search.json')
      .then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
    fetch(rel + '/search.json').then(function (r) { return r.json(); })
      .then(function (j) { return extra.then(function (x) { index = j.concat(x); loading = false; cb(); }); })
      .catch(function () { loading = false; });
  }

  function score(item, terms) {
    var name = item.n.toLowerCase();
    var s = 0;
    for (var i = 0; i < terms.length; i++) {
      var t = terms[i];
      var p = name.indexOf(t);
      if (p === 0) s += 100 - Math.min(name.length, 40);
      else if (p > 0) s += 40;
      else if ((item.d || '').toLowerCase().indexOf(t) >= 0) s += 8;
      else if ((item.q || '').toLowerCase().indexOf(t) >= 0) s += 6;
      else if ((item.k || '').toLowerCase().indexOf(t) >= 0) s += 5;
      else return -1;
    }
    return s;
  }

  function render(list) {
    if (!list.length) { box.innerHTML = '<a style="color:var(--ink-faint)">no match</a>'; box.classList.add('open'); return; }
    box.innerHTML = list.map(function (it, i) {
      var img = it.i ? '<img src="' + rel + '/' + it.i + '" alt="">' : '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="">';
      return '<a href="' + rel + '/' + it.u + '"' + (i === sel ? ' class="sel"' : '') + '>' + img +
        '<span>' + it.n + '</span><span class="kind">' + it.k + '</span></a>';
    }).join('');
    box.classList.add('open');
  }

  function run() {
    var v = q.value.trim().toLowerCase();
    if (v.length < 1) { box.classList.remove('open'); return; }
    load(function () {
      if (!index) return;
      var terms = v.split(/\s+/);
      var out = [];
      for (var i = 0; i < index.length; i++) {
        var s = score(index[i], terms);
        if (s >= 0) out.push([s, index[i]]);
      }
      out.sort(function (a, b) { return b[0] - a[0]; });
      sel = 0;
      render(out.slice(0, 25).map(function (x) { return x[1]; }));
    });
  }

  if (q) {
    q.addEventListener('input', run);
    q.addEventListener('focus', function () { if (q.value) run(); });
    q.addEventListener('keydown', function (e) {
      var links = box.querySelectorAll('a');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!links.length) return;
        sel = (sel + (e.key === 'ArrowDown' ? 1 : links.length - 1)) % links.length;
        for (var i = 0; i < links.length; i++) links[i].className = i === sel ? 'sel' : '';
        links[sel].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        if (links.length && sel >= 0) { e.preventDefault(); window.location = links[sel].href; }
      } else if (e.key === 'Escape') { box.classList.remove('open'); q.blur(); }
    });
    document.addEventListener('click', function (e) {
      if (!box.contains(e.target) && e.target !== q) box.classList.remove('open');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && document.activeElement !== q && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
        e.preventDefault(); q.focus();
      }
    });
  }

  // ------------------------------------------------------------- research reports
  // A compendium server with m59-research beside it serves /reports/. Where it does, every
  // page gets a Reports tab, and an entity page that some report names gets a box pointing
  // at those reports. Where it does not (a static copy), the fetch fails and nothing shows.
  if (!document.body.classList.contains('reports')) {
    fetch(rel + '/reports/entities.json').then(function (r) { return r.ok ? r.json() : null; })
      .then(function (map) {
        if (!map) return;
        var nav = document.querySelector('.topbar nav');
        if (nav && !nav.querySelector('a[href$="reports/index.html"]')) {
          var a = document.createElement('a');
          a.href = rel + '/reports/index.html';
          a.textContent = 'Reports';
          nav.appendChild(a);
        }
        var h1 = document.querySelector('main h1');
        if (!h1 || rel === '.') return;
        var hits = map[h1.textContent.trim().toLowerCase()];
        if (!hits || !hits.length) return;
        var box = document.createElement('div');
        box.className = 'rrefs';
        box.innerHTML = '<b>Research reports</b><ul>' + hits.map(function (h) {
          return '<li><a href="' + rel + '/reports/' + encodeURIComponent(h.u) + '.html"></a></li>';
        }).join('') + '</ul>';
        var as = box.querySelectorAll('a');
        for (var i = 0; i < hits.length; i++) as[i].textContent = hits[i].t;
        var after = h1.closest('.hero') || h1;
        if (after === h1 && h1.nextElementSibling && h1.nextElementSibling.classList.contains('lede')) after = h1.nextElementSibling;
        after.parentNode.insertBefore(box, after.nextSibling);
      }).catch(function () {});
  }

  // ------------------------------------------------------------- sort
  function cellKey(td) {
    var s = td.getAttribute('data-sort');
    if (s === null) s = td.textContent.trim();
    var n = parseFloat(s.replace(/[, ]/g, ''));
    return (s !== '' && !isNaN(n) && /^[-+]?[\d., ]+$/.test(s)) ? n : s.toLowerCase();
  }
  Array.prototype.forEach.call(document.querySelectorAll('table.data'), function (table) {
    var heads = table.querySelectorAll('thead th.sortable');
    Array.prototype.forEach.call(heads, function (th) {
      th.addEventListener('click', function () {
        // Read the position live: the bestiary lets the reader reorder columns.
        var col = th.cellIndex;
        var dir = th.classList.contains('asc') ? -1 : 1;
        Array.prototype.forEach.call(heads, function (h) { h.classList.remove('asc', 'desc'); });
        th.classList.add(dir === 1 ? 'asc' : 'desc');
        var tb = table.tBodies[0];
        var rows = Array.prototype.slice.call(tb.rows);
        rows.sort(function (a, b) {
          var x = cellKey(a.cells[col]), y = cellKey(b.cells[col]);
          if (x === y) return 0;
          if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
          return (String(x) < String(y) ? -1 : 1) * dir;
        });
        for (var i = 0; i < rows.length; i++) tb.appendChild(rows[i]);
      });
    });
  });

  // ------------------------------------------------------------- filter
  var bars = document.querySelectorAll('.filterbar');
  Array.prototype.forEach.call(bars, function (bar) {
    var table = document.getElementById(bar.getAttribute('data-for'));
    if (!table) return;
    var counter = bar.querySelector('.count');
    var total = table.tBodies[0].rows.length;

    function apply() {
      var text = (bar.querySelector('input[type=search]') || { value: '' }).value.trim().toLowerCase();
      var sels = bar.querySelectorAll('select[data-filter]');
      var shown = 0;
      Array.prototype.forEach.call(table.tBodies[0].rows, function (tr) {
        var ok = true;
        if (text && tr.textContent.toLowerCase().indexOf(text) < 0) ok = false;
        if (ok) {
          for (var i = 0; i < sels.length; i++) {
            var key = sels[i].getAttribute('data-filter'), want = sels[i].value;
            if (want && (tr.getAttribute('data-' + key) || '') !== want) { ok = false; break; }
          }
        }
        tr.style.display = ok ? '' : 'none';
        if (ok) shown++;
      });
      if (counter) counter.textContent = shown === total ? total + ' entries' : shown + ' of ' + total;
    }
    bar.addEventListener('input', apply);
    bar.addEventListener('change', apply);
    apply();
  });
})();
