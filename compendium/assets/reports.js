// reports.js -- the research reports: catalogue filtering and the reading page's contents.
// No dependencies. The catalogue's data is the cards themselves (data-* attributes), so
// there is no second copy of the corpus to fall out of step with the page.

(function () {
  // ------------------------------------------------------------- catalogue
  var grid = document.getElementById('rgrid');
  if (grid) {
    var cards = Array.prototype.slice.call(grid.querySelectorAll('.rcard'));
    var q = document.getElementById('rq');
    var sort = document.getElementById('rsort');
    var staleOnly = document.getElementById('rstale');
    var count = document.getElementById('rcount');
    var none = document.getElementById('rnone');
    var tagBox = document.getElementById('rtags');
    var tags = {};

    // Words too common in the questions to say anything about which report answers one.
    var STOP = ' a an and are as at be by can do does for from how i if in is it of on or so the to what when where which who why with you your my me we does did not ';

    function terms() {
      return q.value.toLowerCase().split(/[^a-z0-9'’-]+/).filter(function (t) {
        return t && STOP.indexOf(' ' + t + ' ') < 0;
      });
    }

    function bestQuestion(card, ts) {
      // The question this report lists that shares the most words with what was typed —
      // shown on the card, because "this report answers your question" is the useful part.
      var hay = card.getAttribute('data-hay').split(' \u0001 ');
      var best = '', bestN = 1;
      for (var i = 1; i < hay.length; i++) {
        var n = 0;
        for (var k = 0; k < ts.length; k++) if (hay[i].indexOf(ts[k]) >= 0) n++;
        if (n > bestN && /\?$/.test(hay[i])) { best = hay[i]; bestN = n; }
      }
      return best;
    }

    function apply() {
      var ts = terms();
      var want = Object.keys(tags);
      var shown = 0;
      cards.forEach(function (c) {
        var hay = c.getAttribute('data-hay');
        // A typed question rarely uses every word a report does, so past two words a report
        // needs most of them rather than all, and ranks by how many it has.
        var score = 0, hits = 0;
        for (var k = 0; k < ts.length; k++) {
          if (hay.indexOf(ts[k]) < 0) continue;
          hits++;
          score += c.getAttribute('data-title').indexOf(ts[k]) >= 0 ? 13 : 10;
        }
        var ok = ts.length <= 2 ? hits === ts.length : hits >= Math.ceil(ts.length * 0.6);
        if (ok && want.length) {
          var have = '|' + c.getAttribute('data-tags') + '|';
          for (var j = 0; j < want.length; j++) if (have.indexOf('|' + want[j] + '|') < 0) { ok = false; break; }
        }
        if (ok && staleOnly.checked && c.getAttribute('data-stale') !== '1') ok = false;
        c.hidden = !ok;
        var hit = c.querySelector('.rq-hit');
        var bq = ok && ts.length ? bestQuestion(c, ts) : '';
        hit.textContent = bq ? '“' + bq + '”' : '';
        c._score = ok ? score : 0;
        if (ok) shown++;
      });
      var key = sort.value;
      var val = function (c) {
        if (key === 'verified') return c.getAttribute('data-verified');
        if (key === 'mtime') return +c.getAttribute('data-mtime');
        if (key === 'qs') return +c.getAttribute('data-qs');
        return c.getAttribute('data-title');
      };
      var ordered = cards.slice().sort(function (a, b) {
        // While searching, relevance first; the chosen sort breaks ties.
        if (ts.length && a._score !== b._score) return b._score - a._score;
        var va = val(a), vb = val(b);
        if (key === 'title') return va < vb ? -1 : va > vb ? 1 : 0;
        return va < vb ? 1 : va > vb ? -1 : 0;
      });
      ordered.forEach(function (c) { grid.appendChild(c); });
      count.textContent = shown === cards.length ? cards.length + ' reports' : shown + ' of ' + cards.length;
      none.hidden = shown > 0;
      var h = want.length ? '#tag=' + want.map(encodeURIComponent).join(',') : '';
      if (location.hash !== h) history.replaceState(null, '', h || location.pathname);
    }

    tagBox.addEventListener('click', function (e) {
      var b = e.target.closest('.rtag');
      if (!b) return;
      var t = b.getAttribute('data-tag');
      if (tags[t]) { delete tags[t]; b.classList.remove('on'); } else { tags[t] = 1; b.classList.add('on'); }
      apply();
    });
    q.addEventListener('input', apply);
    sort.addEventListener('change', function () {
      try { localStorage.setItem('m59-reports-sort', sort.value); } catch (e) {}
      apply();
    });
    staleOnly.addEventListener('change', apply);

    // The tag cloud is long; show two rows and offer the rest.
    if (tagBox.scrollHeight > tagBox.clientHeight + 4) {
      var more = document.createElement('p');
      more.className = 'rtags-more';
      more.innerHTML = '<a href="#">all ' + tagBox.children.length + ' topics</a>';
      more.firstChild.addEventListener('click', function (e) {
        e.preventDefault();
        tagBox.classList.toggle('open');
        more.firstChild.textContent = tagBox.classList.contains('open') ? 'fewer topics' : 'all ' + tagBox.children.length + ' topics';
      });
      tagBox.parentNode.insertBefore(more, tagBox.nextSibling);
    }

    try { var s = localStorage.getItem('m59-reports-sort'); if (s) sort.value = s; } catch (e) {}
    var m = /^#tag=(.+)$/.exec(location.hash);
    if (m) m[1].split(',').forEach(function (t) {
      t = decodeURIComponent(t);
      tags[t] = 1;
      var b = tagBox.querySelector('[data-tag="' + t.replace(/"/g, '\\"') + '"]');
      if (b) { b.classList.add('on'); tagBox.classList.add('open'); }
    });
    apply();
    if (!m) q.focus();
  }

  // ------------------------------------------------------------- reading page
  // The contents entry for the section being read: the last heading above the fold. A
  // scroll listener rather than an IntersectionObserver, because one wheel flick can carry
  // a heading clean past an observer's band without it ever reporting a change.
  var toc = document.querySelector('.rtoc');
  if (toc) {
    var links = {};
    Array.prototype.forEach.call(toc.querySelectorAll('a'), function (a) { links[a.getAttribute('href').slice(1)] = a; });
    var heads = Array.prototype.filter.call(document.querySelectorAll('.rbody h2, .rbody h3'), function (h) { return links[h.id]; });
    var current = null, queued = false;
    var mark = function () {
      queued = false;
      var id = null;
      for (var i = 0; i < heads.length && heads[i].getBoundingClientRect().top < 120; i++) id = heads[i].id;
      if (id === current) return;
      if (current) links[current].classList.remove('on');
      if (id) {
        links[id].classList.add('on');
        // Keep the highlighted entry visible in a long contents list.
        var box = toc.parentNode, a = links[id];
        if (a.offsetTop < box.scrollTop || a.offsetTop > box.scrollTop + box.clientHeight - 40) box.scrollTop = a.offsetTop - 60;
      }
      current = id;
    };
    window.addEventListener('scroll', function () { if (!queued) { queued = true; requestAnimationFrame(mark); } }, { passive: true });
    mark();
  }
})();
