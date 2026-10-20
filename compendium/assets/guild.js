// guild.js — the Guild Chest page. Source, not generated: derive/guild.mjs writes the page around it.
//
// ONE BOARD, TWO DRAFTS. The board is what /_guildchest read (the chests' last readings against the
// saved plan). PLAN is the plan being edited, per chest; SALE is the sell list and where its money
// goes. The chest bars are recomputed from PLAN as it is edited, so a target change shows its
// effect on reserve and surplus before it is saved; the eviction lists are the SAVED plan's, and say so.
/* global window, document, fetch */
(function () {
  'use strict';

  var rel = window.M59_REL || '..';
  var B = null;                 // the board
  var PLAN = {};                // slot -> [{item, target, also}]
  var PLAN0 = '';               // PLAN as loaded, for dirty
  var SALE = { items: [], proceeds: { mode: 'courier', to: null, bank: 'nearest', hall: 'chest' } };
  var SALE0 = '';
  var TAB = null;
  var FILTER = '';
  var FLEET = [];               // [{agent, character}] for the "give to" picker
  var COURIERS = null;
  var POLL = null;

  var el = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var norm = function (s) { return String(s == null ? '' : s).toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim(); };
  var num = function (n) { return n == null ? '?' : Math.round(n).toLocaleString(); };
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  var ago = function (t) {
    if (!t) return 'never';
    var s = Math.round((Date.now() - t) / 1000);
    return s < 90 ? s + ' s ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 172800 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago';
  };
  var when = function (t) { return t ? new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'; };
  var pct = function (a, b) { return b > 0 ? Math.max(0, Math.min(100, a / b * 100)) : 0; };

  function say(text, kind) { var s = el('gcStatus'); s.innerHTML = text || ''; s.className = 'gc-status' + (kind ? ' ' + kind : ''); }
  function post(path, body) {
    return fetch(rel + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || j.why || ('HTTP ' + r.status)); return j; }); });
  }

  // ------------------------------------------------------------------ the chest, re-read from PLAN

  function chestOf(slot) { return B.chests.filter(function (c) { return c.slot === slot; })[0]; }
  // The board's per-item facts (bulk, value, seller) by name; bulk falls back to the item table
  // for a line added here that the chest does not hold yet.
  function factsIn(c, item) {
    var n = norm(item), hit = null;
    c.planned.concat(c.unplanned).forEach(function (r) { if (norm(r.item) === n) hit = r; });
    if (hit) return hit;
    var b = B.catalogue ? B.catalogue[n] : null;
    return { item: n, bulk_each: b == null ? null : b, value_each: null, sell_at: null };
  }
  // `also` names count toward the same line, as the keeper counts them (guildwants countWanted).
  function heldIn(c, entry) {
    return [entry.item].concat(entry.also || []).reduce(function (s, nm) { return s + (Number((c.counts || {})[norm(nm)]) || 0); }, 0);
  }
  // The four parts of a chest under the DRAFT plan.
  function partsFor(c) {
    var rows = PLAN[c.slot] || [];
    var claimed = {};
    var p = { kept: 0, surplus: 0, unplanned: 0, reserve: 0, planned: 0 };
    rows.forEach(function (e) {
      var f = factsIn(c, e.item) || {};
      var held = heldIn(c, e), b = f.bulk_each;
      [e.item].concat(e.also || []).forEach(function (n) { claimed[norm(n)] = true; });
      if (b == null) return;
      p.kept += Math.min(held, e.target) * b;
      p.surplus += Math.max(0, held - e.target) * b;
      p.reserve += Math.max(0, e.target - held) * b;
      p.planned += e.target * b;
    });
    // Unplanned under the DRAFT: every held name no draft line claims (a line removed here turns
    // its stock unplanned; one added claims it).
    Object.keys(c.counts || {}).forEach(function (n) {
      if (claimed[n]) return;
      var b = (factsIn(c, n) || {}).bulk_each;
      if (b != null) p.unplanned += c.counts[n] * b;
    });
    return p;
  }

  // ------------------------------------------------------------------ the chest cards

  function renderChests() {
    var box = el('gcChests');
    box.innerHTML = B.chests.map(function (c) {
      var p = partsFor(c), cap = c.capacity;
      var held = p.kept + p.surplus + p.unplanned;
      var free = Math.max(0, cap - held);
      var over = p.planned - cap;
      var resShown = Math.min(p.reserve, free);
      var bar = '<div class="gc-bar" role="img" aria-label="' + esc(c.slot + ': ' + num(held) + ' of ' + num(cap) + ' bulk held') + '">'
        + seg('kept', p.kept, cap, 'kept to plan') + seg('surplus', p.surplus, cap, 'surplus above target')
        + seg('unplanned', p.unplanned, cap, 'unplanned') + seg('reserve', resShown, cap, 'reserved for planned stock not yet here')
        + '</div>';
      var short = (PLAN[c.slot] || []).map(function (e) {
        var f = factsIn(c, e.item) || {}; var h = heldIn(c, e);
        return { item: e.item, short: Math.max(0, e.target - h), bulk: Math.max(0, e.target - h) * (f.bulk_each || 0) };
      }).filter(function (x) { return x.short > 0; }).sort(function (a, b) { return b.bulk - a.bulk; }).slice(0, 5);
      var surplus = (PLAN[c.slot] || []).map(function (e) {
        var f = factsIn(c, e.item) || {}; var h = heldIn(c, e);
        return { item: e.item, over: Math.max(0, h - e.target), bulk: Math.max(0, h - e.target) * (f.bulk_each || 0) };
      }).filter(function (x) { return x.over > 0; }).sort(function (a, b) { return b.bulk - a.bulk; }).slice(0, 5);
      var ev = c.evictions.slice(0, 8).map(function (r) {
        return '<li><span class="nm">' + esc(r.name) + ' <b>×' + num(r.evict) + '</b></span>'
          + '<span class="t">' + esc(r.tier) + ' · ' + (r.bulk == null ? 'bulk ?' : num(r.bulk) + ' bulk') + ' · '
          + (r.sell_at ? esc(r.sell_at.merchant) : '<span class="bad">no merchant buys it</span>') + '</span>'
          + (r.sell_at ? '<button type="button" class="gc-mini" data-sell="' + esc(r.name) + '" data-amt="' + r.evict + '" title="Add to the sell list">+ sell</button>' : '')
          + '</li>';
      }).join('');
      return '<article class="gc-chest' + (TAB === c.slot ? ' on' : '') + '" data-slot="' + esc(c.slot) + '">'
        + '<header><h3>' + esc(c.slot) + '</h3><span class="gc-dim">' + (c.seen ? 'read ' + ago(c.observed_at) + (c.opened_by ? ' by ' + esc(c.opened_by) : '') : 'never opened') + '</span></header>'
        + bar
        + '<div class="gc-nums"><span><b>' + num(held) + '</b> / ' + num(cap) + ' held</span><span>' + num(free) + ' free</span>'
        + '<span class="' + (over > 0 ? 'bad' : '') + '">plan reserves ' + num(p.planned) + (over > 0 ? ' — <b>' + num(over) + ' more than fits</b>' : '') + '</span></div>'
        + '<div class="gc-legend"><i class="kept"></i>kept ' + num(p.kept) + ' <i class="surplus"></i>surplus ' + num(p.surplus)
        + ' <i class="unplanned"></i>unplanned ' + num(p.unplanned) + ' <i class="reserve"></i>reserved ' + num(p.reserve) + '</div>'
        + '<div class="gc-lists">'
        + list('Under-reserve', short.map(function (x) { return esc(x.item) + ' <b>−' + num(x.short) + '</b>'; }), 'nothing short')
        + list('Surplus', surplus.map(function (x) { return esc(x.item) + ' <b>+' + num(x.over) + '</b>'; }), 'nothing over target')
        + '</div>'
        + '<div class="gc-ev"><h4>First to leave <span class="gc-dim">(saved plan)</span></h4>'
        + (ev ? '<ol>' + ev + '</ol>' : '<p class="gc-dim">nothing: every stack is within its target</p>')
        + (c.evictions_more ? '<p class="gc-dim">and ' + c.evictions_more + ' more · evicting all of it frees ' + num(c.freeable_bulk) + ' bulk</p>' : '')
        + '</div>'
        + '<button type="button" class="btn gc-edit" data-tab="' + esc(c.slot) + '">Edit this chest’s plan</button>'
        + '</article>';
    }).join('') || '<p class="gc-dim">No chest has been read yet.</p>';
    Array.prototype.forEach.call(box.querySelectorAll('[data-sell]'), function (b) {
      b.onclick = function () { addLine(b.getAttribute('data-sell'), Number(b.getAttribute('data-amt'))); };
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-tab]'), function (b) {
      b.onclick = function () { TAB = b.getAttribute('data-tab'); renderAll(); el('gcTabs').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    });
  }
  function seg(cls, v, cap, label) {
    return v > 0 ? '<i class="' + cls + '" style="width:' + pct(v, cap) + '%" title="' + esc(label + ': ' + num(v) + ' bulk') + '"></i>' : '';
  }
  function list(title, rows, empty) {
    return '<div><h4>' + title + '</h4>' + (rows.length ? '<ul>' + rows.map(function (r) { return '<li>' + r + '</li>'; }).join('') + '</ul>' : '<p class="gc-dim">' + empty + '</p>') + '</div>';
  }

  // ------------------------------------------------------------------ the plan editor

  function renderTabs() {
    el('gcTabs').innerHTML = B.chests.map(function (c) {
      var d = JSON.stringify(PLAN[c.slot] || []) !== JSON.stringify((JSON.parse(PLAN0 || '{}'))[c.slot] || []);
      return '<button type="button" role="tab" aria-selected="' + (TAB === c.slot) + '" class="gc-tab' + (TAB === c.slot ? ' on' : '') + '" data-t="' + esc(c.slot) + '">'
        + esc(c.slot) + (d ? ' •' : '') + '</button>';
    }).join('');
    Array.prototype.forEach.call(el('gcTabs').querySelectorAll('[data-t]'), function (b) {
      b.onclick = function () { TAB = b.getAttribute('data-t'); renderAll(); };
    });
  }

  function renderPlan() {
    var c = chestOf(TAB);
    if (!c) { el('gcPlan').innerHTML = ''; return; }
    var rows = PLAN[c.slot] || (PLAN[c.slot] = []);
    var f = norm(FILTER);
    var body = rows.map(function (e, i) {
      if (f && norm(e.item).indexOf(f) < 0) return '';
      var x = factsIn(c, e.item) || {};
      var h = heldIn(c, e), d = h - e.target;
      var orig = ((JSON.parse(PLAN0 || '{}'))[c.slot] || []).filter(function (o) { return norm(o.item) === norm(e.item); })[0];
      var changed = !orig || orig.target !== e.target;
      return '<tr class="' + (changed ? 'chg' : '') + '"><td class="nm">' + esc(e.item)
        + ((e.also || []).length ? ' <span class="gc-dim">+ ' + esc(e.also.join(', ')) + '</span>' : '') + '</td>'
        + '<td><input type="number" min="0" step="1" value="' + e.target + '" data-i="' + i + '" aria-label="Target for ' + esc(e.item) + '"></td>'
        + '<td>' + num(h) + '</td><td class="' + (d > 0 ? 'over' : d < 0 ? 'under' : '') + '">' + (d > 0 ? '+' : '') + num(d) + '</td>'
        + '<td>' + (x.bulk_each == null ? '?' : x.bulk_each) + '</td><td>' + (x.bulk_each == null ? '?' : num(e.target * x.bulk_each)) + '</td>'
        + '<td>' + (x.value_each == null ? '—' : num(x.value_each)) + '</td>'
        + '<td><button type="button" class="gc-mini" data-rm="' + i + '" aria-label="Remove ' + esc(e.item) + '">×</button></td></tr>';
    }).join('');
    var claimed = {};
    rows.forEach(function (e) { [e.item].concat(e.also || []).forEach(function (n) { claimed[norm(n)] = true; }); });
    var loose = c.unplanned.filter(function (u) { return !claimed[norm(u.item)] && !u.never_evict; });
    var dirtyN = dirtySlots().length;
    el('gcPlan').innerHTML = '<div class="gc-plan-bar">'
      + '<input type="search" id="gcFilter" placeholder="Filter items…" value="' + esc(FILTER) + '" aria-label="Filter plan">'
      + '<input id="gcNewItem" list="gcItemList" placeholder="add an item…" autocomplete="off" spellcheck="false" aria-label="Item to plan">'
      + '<input id="gcNewTarget" type="number" min="0" step="1" value="1" aria-label="Target">'
      + '<button type="button" class="btn" id="gcAddPlan">Add to ' + esc(c.slot) + '</button>'
      + '<span class="grow"></span>'
      + '<button type="button" class="btn" id="gcDiscardPlan"' + (dirtyN ? '' : ' disabled') + '>Discard</button>'
      + '<button type="button" class="btn primary" id="gcSaveEdits"' + (dirtyN ? '' : ' disabled') + '>Save edits' + (dirtyN ? ' (' + dirtyN + ' chest' + (dirtyN > 1 ? 's' : '') + ')' : '') + '</button>'
      + '</div>'
      + '<div class="gc-scroll"><table class="gc-table"><thead><tr><th>item</th><th>target</th><th>held</th><th>±</th><th>bulk ea</th><th>planned bulk</th><th>value ea</th><th></th></tr></thead>'
      + '<tbody>' + (body || '<tr><td colspan="8" class="gc-dim">' + (rows.length ? 'nothing matches' : 'no plan lines for this chest') + '</td></tr>') + '</tbody></table></div>'
      + (loose.length ? '<div class="gc-loose"><h4>Held here, in no plan line</h4>' + loose.slice(0, 40).map(function (u) {
          return '<span class="gc-chip">' + esc(u.item) + ' ×' + num(u.held)
            + ' <button type="button" class="gc-mini" data-keep="' + esc(u.item) + '" data-n="' + u.held + '" title="Plan to keep what is here">keep</button>'
            + (u.sell_at ? ' <button type="button" class="gc-mini" data-sell="' + esc(u.item) + '" data-amt="' + u.held + '" title="Add all of it to the sell list">sell</button>' : '') + '</span>';
        }).join('') + '</div>' : '');
    var box = el('gcPlan');
    el('gcFilter').oninput = function (e) { FILTER = e.target.value; renderPlan(); el('gcFilter').focus(); el('gcFilter').setSelectionRange(FILTER.length, FILTER.length); };
    Array.prototype.forEach.call(box.querySelectorAll('input[data-i]'), function (inp) {
      inp.onchange = function () { rows[Number(inp.getAttribute('data-i'))].target = Math.max(0, Math.floor(Number(inp.value) || 0)); planChanged(); };
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-rm]'), function (b) {
      b.onclick = function () { rows.splice(Number(b.getAttribute('data-rm')), 1); planChanged(); };
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-keep]'), function (b) {
      b.onclick = function () { rows.push({ item: norm(b.getAttribute('data-keep')), target: Number(b.getAttribute('data-n')) }); planChanged(); };
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-sell]'), function (b) {
      b.onclick = function () { addLine(b.getAttribute('data-sell'), Number(b.getAttribute('data-amt'))); };
    });
    el('gcAddPlan').onclick = function () {
      var item = norm(el('gcNewItem').value), t = Math.max(0, Math.floor(Number(el('gcNewTarget').value) || 0));
      if (!item) return;
      if (rows.some(function (r) { return norm(r.item) === item; })) { say(esc(item) + ' is already planned in ' + esc(c.slot) + ' — change its target instead.', 'bad'); return; }
      rows.push({ item: item, target: t });
      planChanged();
    };
    el('gcSaveEdits').onclick = savePlan;
    el('gcDiscardPlan').onclick = function () { PLAN = JSON.parse(PLAN0); planChanged(); };
  }
  function dirtySlots() {
    var o = JSON.parse(PLAN0 || '{}');
    return Object.keys(PLAN).filter(function (s) { return JSON.stringify(PLAN[s]) !== JSON.stringify(o[s] || []); });
  }
  function planChanged() { renderChests(); renderTabs(); renderPlan(); }

  function savePlan() {
    var chests = {};
    Object.keys(PLAN).forEach(function (s) {
      chests[s] = { items: PLAN[s].map(function (e) { var o = { item: e.item, target: e.target }; if ((e.also || []).length) o.also = e.also; return o; }) };
    });
    el('gcSaveEdits').disabled = true;
    post('/_guildplan', { chests: chests }).then(function (j) {
      PLAN0 = '';   // reload from what was saved
      return load().then(function () {
        say('Plan saved' + (j.problems && j.problems.length ? ' — ' + esc(j.problems.length) + ' note(s): ' + esc(j.problems.slice(0, 3).join('; ')) : '') + '. The keepers read it on their next pass.', 'good');
      });
    }).catch(function (e) { say('Could not save the plan: ' + esc(e.message), 'bad'); el('gcSaveEdits').disabled = false; });
  }

  // ------------------------------------------------------------------ the sale

  // Facts about an item across every chest: total held, bulk, value, seller.
  function itemFacts(item) {
    var n = norm(item), out = { held: 0, bulk_each: null, value_each: null, sell_at: null };
    B.chests.forEach(function (c) {
      c.planned.concat(c.unplanned).forEach(function (r) {
        if (norm(r.item) !== n) return;
        out.held += r.held; out.bulk_each = r.bulk_each; out.value_each = r.value_each; out.sell_at = out.sell_at || r.sell_at;
      });
      c.evictions.forEach(function (r) { if (norm(r.name) === n && !out.sell_at) out.sell_at = r.sell_at; });
    });
    return out;
  }
  function addLine(item, amount) {
    item = norm(item);
    if (!item || !(amount > 0)) return;
    var hit = SALE.items.filter(function (l) { return l.item === item; })[0];
    if (hit) hit.amount = amount; else SALE.items.push({ item: item, amount: Math.floor(amount) });
    renderSale();
    el('gcSaleSec').classList.add('pulse'); setTimeout(function () { el('gcSaleSec').classList.remove('pulse'); }, 600);
  }
  function saleBulk() {
    return SALE.items.reduce(function (n, l) { var f = itemFacts(l.item); return n + (f.bulk_each || 0) * l.amount; }, 0);
  }

  function renderSale() {
    var tot = { bulk: 0, value: 0, unknown: 0 };
    el('gcLines').innerHTML = SALE.items.length ? '<table class="gc-table gc-lines"><thead><tr><th>item</th><th>amount</th><th>in chests</th><th>bulk</th><th>≈ value</th><th>sold to</th><th></th></tr></thead><tbody>'
      + SALE.items.map(function (l, i) {
        var f = itemFacts(l.item);
        var b = f.bulk_each == null ? null : f.bulk_each * l.amount, v = f.value_each == null ? null : f.value_each * l.amount;
        if (b != null) tot.bulk += b; if (v != null) tot.value += v; else tot.unknown++;
        return '<tr><td class="nm">' + esc(l.item) + '</td>'
          + '<td><input type="number" min="1" step="1" value="' + l.amount + '" data-li="' + i + '" aria-label="Amount of ' + esc(l.item) + '"></td>'
          + '<td class="' + (f.held < l.amount ? 'under' : '') + '">' + num(f.held) + '</td><td>' + (b == null ? '?' : num(b)) + '</td>'
          + '<td>' + (v == null ? '?' : num(v)) + '</td>'
          + '<td>' + (f.sell_at ? esc(f.sell_at.merchant) + ' <span class="gc-dim">@' + f.sell_at.room + '</span>' : '<span class="bad">nobody — stays</span>') + '</td>'
          + '<td><button type="button" class="gc-mini" data-lrm="' + i + '" aria-label="Remove ' + esc(l.item) + '">×</button></td></tr>';
      }).join('') + '</tbody><tfoot><tr><td>total</td><td></td><td></td><td>' + num(tot.bulk) + '</td><td>≈ ' + num(tot.value) + (tot.unknown ? ' +?' : '') + '</td><td colspan="2"></td></tr></tfoot></table>'
      : '<p class="gc-dim">Nothing yet. Use <b>+ sell</b> on a chest’s evictions, or add a line below.</p>';
    Array.prototype.forEach.call(el('gcLines').querySelectorAll('[data-li]'), function (inp) {
      inp.onchange = function () { SALE.items[Number(inp.getAttribute('data-li'))].amount = Math.max(1, Math.floor(Number(inp.value) || 1)); renderSale(); };
    });
    Array.prototype.forEach.call(el('gcLines').querySelectorAll('[data-lrm]'), function (b) {
      b.onclick = function () { SALE.items.splice(Number(b.getAttribute('data-lrm')), 1); renderSale(); };
    });
    renderProceeds();
    var dirty = JSON.stringify(SALE) !== SALE0;
    el('gcPlanMsg').textContent = dirty ? 'unsaved changes' : (B.sell_plan && B.sell_plan.updated ? 'saved ' + ago(Date.parse(B.sell_plan.updated)) : '');
    var empty = !SALE.items.length;
    ['gcDry', 'gcNow', 'gcLater'].forEach(function (id) { el(id).disabled = empty; });
  }

  function renderProceeds() {
    var p = SALE.proceeds;
    var opt = function (v, label, cur) { return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + label + '</option>'; };
    var banks = opt('nearest', 'the nearest bank', p.bank) + opt('tos', 'Tos', p.bank) + opt('jasper', 'Jasper', p.bank);
    var people = '<option value="">choose…</option>' + FLEET.map(function (f) { return opt(f.character, esc(f.character), p.to); }).join('');
    var card = function (mode, title, inner) {
      return '<label class="gc-pcard' + (p.mode === mode ? ' on' : '') + '"><input type="radio" name="gcMode" value="' + mode + '"' + (p.mode === mode ? ' checked' : '') + '>'
        + '<span class="gc-pt">' + title + '</span><span class="gc-pi">' + inner + '</span></label>';
    };
    el('gcProceeds').innerHTML =
      card('courier', 'The courier banks it', 'at <select data-p="bank">' + banks + '</select>')
      + card('give', 'Hand it to a character at the bank', '<select data-p="to">' + people + '</select> at <select data-p="bank">' + banks + '</select>, who banks it')
      + card('hall', 'Put it in the guild hall', 'as <select data-p="hall">' + opt('chest', 'shillings in a chest', p.hall) + opt('rent', 'rent credit with Frular', p.hall) + '</select>');
    Array.prototype.forEach.call(el('gcProceeds').querySelectorAll('input[name=gcMode]'), function (r) {
      r.onchange = function () { SALE.proceeds.mode = r.value; renderSale(); };
    });
    Array.prototype.forEach.call(el('gcProceeds').querySelectorAll('select[data-p]'), function (s) {
      s.onchange = function () { SALE.proceeds[s.getAttribute('data-p')] = s.value || null; renderSale(); };
      s.onclick = function (e) { e.stopPropagation(); };
    });
  }

  function findCouriers() {
    el('gcCouriers').innerHTML = '<p class="gc-dim">Asking the broker where everyone is and what they carry…</p>';
    return fetch(rel + '/_guildsale/couriers?bulk=' + Math.round(saleBulk())).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw new Error(j.error);
      COURIERS = j.couriers;
      renderCouriers(j.desk_open);
    }).catch(function (e) { el('gcCouriers').innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; });
  }
  function renderCouriers(deskOpen) {
    var sel = el('gcCourier'), cur = sel.value;
    sel.innerHTML = '<option value="auto">Automatic — best available</option>'
      + (COURIERS || []).map(function (c) { return '<option value="' + esc(c.agent) + '"' + (c.agent === cur ? ' selected' : '') + '>' + esc(c.character) + (c.ok ? '' : ' (not available)') + '</option>'; }).join('');
    if (!COURIERS) return;
    var best = COURIERS.filter(function (c) { return c.ok; })[0];
    el('gcCouriers').innerHTML = (deskOpen ? '<p class="gc-dim">The vault desk is open: its two staff are not offered.</p>' : '')
      + '<table class="gc-table gc-ctable"><thead><tr><th></th><th>character</th><th>to hall</th><th>pack free</th><th>drop-off</th><th>trips</th></tr></thead><tbody>'
      + COURIERS.slice(0, 14).map(function (c) {
        return '<tr class="' + (c.ok ? 'ok' : 'no') + (c === best ? ' best' : '') + (sel.value === c.agent ? ' picked' : '') + '" data-pick="' + esc(c.agent) + '" title="' + esc(c.why.join('; ')) + '">'
          + '<td>' + (c === best ? '★' : c.ok ? '✓' : '—') + '</td><td class="nm">' + esc(c.character) + '<small>' + esc(c.room || '') + '</small></td>'
          + '<td>' + (c.eta_ms == null ? '?' : Math.round(c.eta_ms / 60000) + ' min') + '</td><td>' + num(c.free_bulk) + '</td>'
          + '<td>' + (c.dropoff_bulk ? num(c.dropoff_bulk) + '<small>' + esc(c.dropoff_items.slice(0, 3).join(', ')) + '</small>' : '—') + '</td>'
          + '<td>' + (c.rounds == null ? '?' : c.rounds) + '</td></tr>'
          + (c.ok ? '' : '<tr class="why"><td></td><td colspan="5">' + esc(c.why.join('; ')) + '</td></tr>');
      }).join('') + '</tbody></table>'
      + '<p class="gc-dim">★ is who “automatic” would send. A drop-off is guild wants it already carries — it puts those in first, which is the room it sells with.</p>';
    Array.prototype.forEach.call(el('gcCouriers').querySelectorAll('[data-pick]'), function (r) {
      r.onclick = function () { sel.value = r.getAttribute('data-pick'); renderCouriers(deskOpen); };
    });
  }

  function saleBody() {
    return { items: SALE.items, proceeds: SALE.proceeds, courier: el('gcCourier').value, borrow: el('gcBorrow').checked };
  }
  function proceedsText(p) {
    if (p.mode === 'give') return 'handed to ' + (p.to || '?') + ' at ' + (p.bank === 'nearest' ? 'the nearest bank' : p.bank) + ', who banks it';
    if (p.mode === 'hall') return p.hall === 'rent' ? 'paid to Frular as rent credit' : 'put in a guild chest as shillings';
    return 'banked by the courier at ' + (p.bank === 'nearest' ? 'the nearest bank' : p.bank);
  }

  function dryRun() {
    var box = el('gcDryLog');
    box.hidden = false; box.textContent = 'Walking it on paper — reading the fleet, nothing moves…';
    post('/_guildsale/dry', saleBody()).then(function (j) {
      box.textContent = (j.log || []).join('\n') + (j.ok ? '' : '\n\nWOULD FAIL: ' + j.error)
        + ((j.problems || []).length ? '\n\nnotes: ' + j.problems.join('; ') : '');
      box.className = 'gc-log' + (j.ok ? '' : ' bad');
    }).catch(function (e) { box.textContent = e.message; box.className = 'gc-log bad'; });
  }

  function confirmSale(at) {
    var b = saleBody();
    if (b.proceeds.mode === 'give' && !b.proceeds.to) { say('Choose who the money is handed to.', 'bad'); return; }
    var courier = b.courier === 'auto' ? 'the best available courier, chosen when it starts' : (COURIERS || []).filter(function (c) { return c.agent === b.courier; }).map(function (c) { return c.character; })[0] || b.courier;
    el('gcDialogBody').innerHTML = '<h2>' + (at ? 'Schedule this sale' : 'Sell now') + '</h2>'
      + '<p>This drives a live character: it walks to the hall, draws from the chests, sells, and moves the money.</p>'
      + '<ul class="gc-review"><li><b>When</b> ' + (at ? esc(when(at)) : 'as soon as the scheduler next looks (within 30 s)') + '</li>'
      + '<li><b>Courier</b> ' + esc(courier) + (b.borrow ? ' — may be borrowed from its training' : '') + '</li>'
      + '<li><b>Selling</b> ' + esc(SALE.items.map(function (l) { return l.amount + ' ' + l.item; }).join(', ')) + '</li>'
      + '<li><b>Money</b> ' + esc(proceedsText(b.proceeds)) + '</li></ul>'
      + (B.scheduler && B.scheduler.on ? '' : '<p class="bad">The scheduler is off on this server (' + esc(B.scheduler && B.scheduler.why || '') + '): the job will be filed and will not start until a server with it on reads the book.</p>')
      + '<div class="gc-dialog-b"><button type="button" class="btn" id="gcNo">Cancel</button><button type="button" class="btn primary" id="gcYes">' + (at ? 'Schedule' : 'Sell now') + '</button></div>';
    var d = el('gcDialog');
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
    el('gcNo').onclick = function () { d.close ? d.close() : d.removeAttribute('open'); };
    el('gcYes').onclick = function () {
      el('gcYes').disabled = true;
      post('/_guildsale/jobs', Object.assign({ at: at || null }, b)).then(function (j) {
        d.close ? d.close() : d.removeAttribute('open');
        return load().then(function () { say('Filed ' + esc(j.job.id) + (at ? ' for ' + esc(when(j.job.at)) : ' — it starts within 30 s') + '.', 'good'); });
      }).catch(function (e) { d.close ? d.close() : d.removeAttribute('open'); say('Not filed: ' + esc(e.message), 'bad'); });
    };
  }

  // ------------------------------------------------------------------ the jobs

  function renderJobs() {
    var jobs = B.jobs || [];
    el('gcJobs').innerHTML = (B.scheduler ? '<p class="gc-dim">Scheduler: ' + (B.scheduler.on ? 'on, checked ' + ago(B.scheduler.last_tick) : 'off — ' + esc(B.scheduler.why || '')) + '</p>' : '')
      + (jobs.length ? '<table class="gc-table gc-jobs"><thead><tr><th>sale</th><th>when</th><th>courier</th><th>selling</th><th>money</th><th>status</th><th></th></tr></thead><tbody>'
        + jobs.map(function (j) {
          var res = j.result || {};
          return '<tr class="st-' + esc(j.status) + '"><td>' + esc(j.id) + '</td><td>' + esc(when(j.at)) + '</td>'
            + '<td>' + esc(res.character || (j.courier === 'auto' ? 'automatic' : j.courier)) + '</td>'
            + '<td>' + esc(j.items.map(function (l) { return l.amount + ' ' + l.item; }).join(', ')) + '</td>'
            + '<td>' + esc(proceedsText(j.proceeds)) + (res.gain != null ? ' <b>' + num(res.gain) + '</b>' : '') + '</td>'
            + '<td><span class="gc-st">' + esc(j.status) + '</span>' + (j.error ? '<small class="bad">' + esc(j.error) + '</small>' : '') + '</td>'
            + '<td>' + (j.status === 'scheduled' ? '<button type="button" class="gc-mini" data-cancel="' + esc(j.id) + '">cancel</button>' : '')
            + (j.status !== 'scheduled' && j.status !== 'cancelled' ? '<button type="button" class="gc-mini" data-log="' + esc(j.id) + '">log</button>' : '') + '</td></tr>'
            + '<tr class="gc-logrow" id="log-' + esc(j.id) + '" hidden><td colspan="7"><pre class="gc-log"></pre></td></tr>';
        }).join('') + '</tbody></table>' : '<p class="gc-dim">No sales yet.</p>');
    Array.prototype.forEach.call(el('gcJobs').querySelectorAll('[data-cancel]'), function (b) {
      b.onclick = function () { post('/_guildsale/cancel', { id: b.getAttribute('data-cancel') }).then(load).catch(function (e) { say(esc(e.message), 'bad'); }); };
    });
    Array.prototype.forEach.call(el('gcJobs').querySelectorAll('[data-log]'), function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-log'), row = el('log-' + id);
        row.hidden = !row.hidden;
        if (!row.hidden) fetch(rel + '/_guildsale/log?id=' + encodeURIComponent(id)).then(function (r) { return r.json(); })
          .then(function (j) { row.querySelector('pre').textContent = (j.log || []).join('\n') || '(nothing logged yet)'; });
      };
    });
    clearTimeout(POLL);
    if (jobs.some(function (j) { return j.status === 'running' || (j.status === 'scheduled' && j.at < Date.now() + 120000); }))
      POLL = setTimeout(function () { refreshJobsOnly(); }, 15000);
  }
  function refreshJobsOnly() {
    fetch(rel + '/_guildchest').then(function (r) { return r.json(); }).then(function (j) { B.jobs = j.jobs; B.scheduler = j.scheduler; renderJobs(); });
  }

  // ------------------------------------------------------------------ loading

  function renderAll() { renderChests(); renderTabs(); renderPlan(); renderSale(); renderJobs(); }

  function load() {
    say('Reading the chests…');
    return fetch(rel + '/_guildchest').then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status); return j; });
    }).then(function (j) {
      B = j;
      var keepPlanEdits = PLAN0 && dirtySlots().length;
      if (!keepPlanEdits) {
        PLAN = {};
        B.chests.forEach(function (c) { PLAN[c.slot] = c.planned.map(function (r) { var o = { item: r.item, target: r.target }; if (r.also) o.also = r.also; return o; }); });
        PLAN0 = JSON.stringify(PLAN);
      }
      if (!SALE0 || JSON.stringify(SALE) === SALE0) {
        SALE = clone(B.sell_plan || SALE);
        delete SALE.updated;
        SALE0 = JSON.stringify(SALE);
      }
      if (!TAB || !chestOf(TAB)) TAB = (B.chests[0] || {}).slot || null;
      el('gcItemList').innerHTML = Object.keys(B.catalogue || {}).sort().map(function (n) { return '<option value="' + esc(n) + '">'; }).join('');
      var r = B.rent || {};
      say((B.gate && B.gate.ok ? 'In the guild' : '<span class="bad">' + esc((B.gate && B.gate.why) || 'no guild hall') + '</span>')
        + (r.credit != null ? ' · rent credit ' + num(r.credit) + ' (read ' + ago(r.observed_at) + ')' : '')
        + ' · vault desk ' + (B.desk ? 'open' : 'closed')
        + (B.problems && B.problems.length ? ' · <span title="' + esc(B.problems.join('\n')) + '">' + B.problems.length + ' plan notes</span>' : ''));
      renderAll();
    }).catch(function (e) {
      say('This page needs the harness serving it (node tools/m59-compendium.mjs): ' + esc(e.message), 'bad');
    });
  }

  function boot() {
    el('gcRefresh').onclick = load;
    el('gcAddLine').onclick = function () { addLine(el('gcAddItem').value, Number(el('gcAddAmt').value)); el('gcAddItem').value = ''; };
    el('gcFillEvict').onclick = function () {
      B.chests.forEach(function (c) { c.evictions.forEach(function (r) { if (r.sell_at) addLine(r.name, r.evict); }); });
    };
    el('gcSavePlan').onclick = function () {
      post('/_guildsale/plan', SALE).then(function (j) {
        B.sell_plan = j.sell_plan; SALE = clone(j.sell_plan); delete SALE.updated; SALE0 = JSON.stringify(SALE);
        say('Sell plan saved' + (j.problems.length ? ' — ' + esc(j.problems.join('; ')) : '') + '.', j.problems.length ? null : 'good');
        renderSale();
      }).catch(function (e) { say(esc(e.message), 'bad'); });
    };
    el('gcFind').onclick = findCouriers;
    el('gcCourier').onchange = function () { if (COURIERS) renderCouriers(); };
    el('gcDry').onclick = dryRun;
    el('gcNow').onclick = function () { confirmSale(null); };
    el('gcLater').onclick = function () {
      var v = el('gcAt').value;
      if (!v) { say('Pick a time first.', 'bad'); el('gcAt').focus(); return; }
      var t = new Date(v).getTime();
      if (!(t > Date.now())) { say('That time has passed — use Sell now.', 'bad'); return; }
      confirmSale(t);
    };
    window.addEventListener('beforeunload', function (e) {
      if ((PLAN0 && dirtySlots().length) || (SALE0 && JSON.stringify(SALE) !== SALE0)) { e.preventDefault(); e.returnValue = ''; }
    });
    fetch(rel + '/_loadouts').then(function (r) { return r.json(); }).then(function (j) {
      FLEET = (j.fleet || []).slice().sort(function (a, b) { return String(a.character).localeCompare(String(b.character)); });
      if (B) renderSale();
    }).catch(function () { /* the give-to picker stays empty */ });
    load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
