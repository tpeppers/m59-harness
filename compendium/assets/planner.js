// planner.js -- the character planner, and the thing that hands a loadout to the fleet.
//
// Three sources for a character, in the order the page tries them:
//
//   1. THE LIVE ONE. When the harness is serving this page (m59-compendium.mjs), /_planner
//      answers with a character's real attributes, abilities, equipment and pack, plus
//      whatever loadout it already has. The `m59char` cookie names which one — the same
//      cookie the bestiary reads, set by pressing C in the fleet terminal.
//   2. A FILE. Either a loadout exported earlier, or a character sheet out of
//      substrate/sheets/. Both are recognised; a sheet becomes a starting point.
//   3. NOTHING. A blank build, which is the whole planner minus the diff.
//
// WHAT IS OBSERVED AND WHAT IS PLANNED ARE NEVER DRAWN THE SAME. Everything read off a real
// character renders solid; everything somebody typed renders hatched, and says so. That is
// the site's one rule and this is the page most able to break it, because a plan and a
// reading are the same shape here.

/* global window, document, fetch, FileReader, Blob, URL */
(function () {
  var root = document.getElementById('plPanel');
  if (!root) return;
  var rel = window.M59_REL || '..';
  var LEARN = window.M59Learn || null;
  // statpane.js, generated from compendium/tools/statpane.mjs by the build that generated
  // this page — the same file the fleet's /stats board imports in node. It owns the six
  // stats in the client's order and the three derived numbers this page shows in the stats
  // footer, so that the planner and the board cannot disagree about either. There is no
  // fallback on purpose: a second copy of the order or of `101 + stamina` is the whole
  // failure this arrangement exists to prevent.
  var SP = window.M59StatPane;

  // ------------------------------------------------------------------ state

  var D = null;            // planner.json
  var BY_ITEM = {};        // normalised item name -> catalogue row
  var BY_SPELL = {};       // normalised spell name -> row
  var TAB = 'inventory';
  var SEL = null;          // selected item name in the inventory grid
  var FILTER = 'reagent';
  var QUERY = '';
  var SERVED = false;      // is the harness serving this, i.e. can we save?
  var CHOICES = {};        // checkbox value -> character source
  var ACTIVE_KEY = null;   // the single character whose full plan is currently loaded
  var LOAD_SEQ = 0;        // ignores a character read superseded by another selection

  // The loadout being edited, in the on-disk shape. Kept in exactly that shape so what the
  // page shows and what the file contains cannot drift apart.
  var L = null;
  // What was OBSERVED of the character, if anything. Never edited, never saved — it is the
  // evidence the plan is drawn against.
  var OBS = null;

  var norm = function (s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); };
  var el = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  function blank(name) {
    return {
      format: 'm59-loadout/1', character: name || '', agent: null, updated: null, note: '',
      plan: { schools: {}, weapon_level: null, learning_target: null,
              learning_queue: [], abilities: [] },
      gear: { weapon: [], slots: {}, from: null },
      carry: [], sell: [], keep: [], purse: { float: null, bank_above: null },
    };
  }

  function say(text, kind) {
    var m = el('plMsg');
    m.textContent = text || '';
    m.className = 'pl-msg' + (kind ? ' ' + kind : '');
  }

  // ------------------------------------------------------------------ the pack

  // What the character is actually holding, as {normalised name: count}. Empty when nothing
  // was observed — which is NOT the same as an empty pack, so every reader checks OBS first.
  function held() {
    var out = {};
    if (!OBS || !OBS.inventory) return out;
    OBS.inventory.forEach(function (i) {
      var k = norm(i.name);
      out[k] = (out[k] || 0) + (i.amount || 1);
    });
    return out;
  }

  function carryEntry(name) {
    var k = norm(name);
    for (var i = 0; i < L.carry.length; i++) if (norm(L.carry[i].item) === k) return L.carry[i];
    return null;
  }

  function checkedChoices() {
    var box = el('plChars');
    if (!box) return [];
    return Array.prototype.map.call(box.querySelectorAll('input[type="checkbox"]:checked'),
      function (input) { return CHOICES[input.value]; }).filter(Boolean);
  }

  function multipleCharacters() { return checkedChoices().length > 1; }

  // A multi-character plan has one shared, meaningful surface: gear and desired inventory.
  // Schools, skills and attributes describe one character, so the UI refuses those tabs
  // instead of showing the first checked character as though it represented the group.
  function syncSelectionMode() {
    var selected = checkedChoices(), multi = selected.length > 1;
    if (multi) TAB = 'inventory';
    ['inventory', 'spells', 'skills', 'stats'].forEach(function (t) {
      var b = el('tab-' + t), p = el('pane-' + t), off = multi && t !== 'inventory';
      if (!b) return;
      b.disabled = off;
      b.setAttribute('aria-disabled', String(off));
      b.setAttribute('aria-selected', String(t === TAB));
      if (p) p.hidden = t !== TAB;
      b.title = off ? 'Choose one character to plan ' + t : '';
    });
    el('plName').disabled = multi;
    el('plSave').textContent = multi ? 'Apply gear + carry to selected' : 'Save to the fleet';
  }

  // ------------------------------------------------------------------ tabs

  function selectTab(id) {
    if (multipleCharacters() && id !== 'inventory') return;
    TAB = id;
    ['inventory', 'spells', 'skills', 'stats'].forEach(function (t) {
      var b = el('tab-' + t), p = el('pane-' + t);
      if (b) b.setAttribute('aria-selected', String(t === id));
      if (p) p.hidden = t !== id;
    });
    renderEditor();
  }

  // ------------------------------------------------------------------ inventory pane

  function iconFor(name) {
    var it = BY_ITEM[norm(name)];
    return it && it.icon ? rel + '/' + it.icon : null;
  }

  function renderInventory() {
    var grid = el('plGrid'), have = held(), any = OBS && OBS.inventory;
    grid.innerHTML = '';
    L.carry.forEach(function (c) {
      var n = norm(c.item), h = any ? (have[n] || 0) : null;
      var cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'm59-cell'
        + (h !== null && h < c.min ? ' short' : '')
        + (h !== null && c.max !== null && h > c.max ? ' over' : '');
      cell.setAttribute('aria-pressed', String(SEL === c.item));
      cell.title = c.item + ' — want ' + c.min + (c.max === null ? ' or more' : ' to ' + c.max)
        + (h === null ? '' : ', holding ' + h);
      var src = iconFor(c.item);
      cell.innerHTML =
        (src ? '<img src="' + esc(src) + '" alt="">' : '<span class="noicon">' + esc(c.item) + '</span>')
        + '<span class="n">' + c.min + '</span>'
        + (c.max === null ? '' : '<span class="mx">/' + c.max + '</span>');
      cell.onclick = function () { SEL = c.item; renderInventory(); renderEditor(); };
      grid.appendChild(cell);
    });
    el('plGridEmpty').hidden = L.carry.length > 0;

    // WEIGHT AND BULK ARE BOTH BOUNDED BY THE SAME CAP (player.kod:10456), so a list that
    // fits by weight can still be refused for bulk. Both are shown, and the might it is
    // measured against is the character's own. The arithmetic is statpane.mjs's.
    var might = effectiveStats().might;
    var cap = SP.carryCapacity(might);
    var w = 0, b = 0, unknown = 0;
    L.carry.forEach(function (c) {
      var it = BY_ITEM[norm(c.item)];
      if (!it || it.weight == null) { unknown++; return; }
      w += it.weight * c.min; b += (it.bulk == null ? 0 : it.bulk) * c.min;
    });
    el('plCarryFoot').innerHTML =
      '<span' + (w > cap ? ' class="over"' : '') + '>weight ' + w + ' / ' + cap + '</span>'
      + '<span' + (b > cap ? ' class="over"' : '') + '>bulk ' + b + ' / ' + cap + '</span>'
      + '<span>' + L.carry.length + ' kind(s)</span>'
      + (unknown ? '<span>' + unknown + ' not in the catalogue, not counted</span>' : '')
      // NULL, not falsy: a build planned with 0 might is a real (terrible) build whose cap
      // genuinely is 1700, and it must not be reported as a character nobody has read.
      + (might == null ? '<span>no might known, so the cap is the floor of 1700</span>' : '');
  }

  // ------------------------------------------------------------------ spells pane

  // The highest level known in each school, off the observed character. Blink excluded —
  // the server does not count it toward a school's level (player.kod:10735).
  function observedSchools() {
    var out = {};
    if (!OBS || !OBS.spells) return out;
    OBS.spells.forEach(function (sp) {
      if (norm(sp.name) === 'blink') return;
      var row = BY_SPELL[norm(sp.name)];
      var school = sp.school || (row && row.school), lvl = sp.level || (row && row.level);
      if (!school || !lvl) return;
      out[school] = Math.max(out[school] || 0, lvl);
    });
    return out;
  }

  // How many abilities the character has at a given school and level, which decides both
  // whether the next one is cheap (knowOneAtLevel) and whether the scarcity relief applies.
  function countAt(school, level) {
    if (!OBS || !OBS.spells) return 0;
    var n = 0;
    OBS.spells.forEach(function (sp) {
      var row = BY_SPELL[norm(sp.name)];
      var s = sp.school || (row && row.school), l = sp.level || (row && row.level);
      if (s === school && l === level) n++;
    });
    return n;
  }

  // Every track's level as PlayerCanLearn counts them: the six schools plus one for skills.
  function trackLevels(planned) {
    var have = observedSchools(), out = {};
    D.schools.forEach(function (s) {
      var p = planned && L.plan.schools[s];
      out[s] = Math.max(have[s] || 0, p || 0);
    });
    // The plan's Weaponcraft goal counts only when the caller asked for the PLANNED state;
    // pricing the next school level against a weapon level not yet held overcharged it.
    // A MAX either way, so a held level-50 sentinel still hides it (learn.mjs levelPointsAt).
    out.weapon = Math.max(planned ? (L.plan.weapon_level || 0) : 0, observedWeaponLevel());
    return out;
  }

  // iWeapon: the highest viSkill_level of any skill known, all of them pooled. The wire
  // does not carry a skill's level — BP_STAT sends a name and a number — so it comes off the
  // compiled table, which is the only place it exists outside the server.
  //
  // A MAX, and that is load-bearing: knowing thrust (the level-50 sentinel) makes iWeapon
  // 50, which costs nothing at all because Nth falls off the end of the table. See
  // levelPointsAt in learn.mjs.
  var BY_SKILL = {};
  function observedWeaponLevel() {
    if (!OBS || !OBS.skills) return 0;
    var top = 0;
    OBS.skills.forEach(function (sk) {
      var lvl = sk.level || (BY_SKILL[norm(sk.name)] && BY_SKILL[norm(sk.name)].level);
      if (lvl) top = Math.max(top, lvl);
    });
    return top;
  }

  // The server's accounting track intentionally includes the granted level-50 sentinels
  // (thrust/kick). A human planning purchasable Weaponcraft levels does not mean that
  // sentinel; show the highest ordinary, sold level here while trackLevels() keeps the
  // server-exact MAX above for its cost calculation.
  function observedPlannedWeaponLevel() {
    if (!OBS || !OBS.skills) return 0;
    var top = 0;
    OBS.skills.forEach(function (sk) {
      var row = BY_SKILL[norm(sk.name)];
      var lvl = sk.level || (row && row.level);
      if (lvl && lvl <= 6 && (!row || row.for_sale !== false)) top = Math.max(top, lvl);
    });
    return top;
  }

  function learningQueue() {
    L.plan.learning_queue = Array.isArray(L.plan.learning_queue) ? L.plan.learning_queue : [];
    return L.plan.learning_queue;
  }

  function setTrackQueue(track, level) {
    var q = learningQueue().filter(function (entry) { return norm(entry.track) !== norm(track); });
    for (var lv = 1; lv <= level; lv++) q.push({ track: track, level: lv });
    L.plan.learning_queue = q;
    L.plan.learning_target = track;
  }

  function intellect() {
    return (L.plan.stats && L.plan.stats.intellect)
      || (OBS && OBS.attributes && OBS.attributes.intellect) || 0;
  }

  function renderSpells() {
    var wrap = el('plSchools'), have = observedSchools();
    wrap.innerHTML = '';
    D.schools.forEach(function (school) {
      var row = document.createElement('div');
      row.className = 'm59-school';
      var want = L.plan.schools[school] || 0, has = have[school] || 0;

      var pips = '';
      for (var lv = 1; lv <= (D.learning.max_school_level || 6); lv++) {
        var mine = lv <= has, chosen = lv <= want;
        pips += '<button type="button" class="m59-pip'
          + (mine ? ' have' : '') + (chosen ? ' on' : '') + (chosen && !mine ? ' beyond' : '')
          + '" data-school="' + esc(school) + '" data-level="' + lv + '"'
          + ' title="' + esc(school) + ' level ' + lv
          + (mine ? ' — already known' : chosen ? ' — planned' : '') + '">' + lv + '</button>';
      }

      // THE COST OF THE NEXT LEVEL, not of the plan. That is the number that decides
      // anything: a plan four levels out is priced against knowledge the character does not
      // have yet, and quoting a total for it would be arithmetic about an imaginary
      // character.
      var next = Math.max(has, 0) + 1;
      var cost = { need: null };
      if (LEARN && next <= (D.learning.max_school_level || 6)) {
        cost = LEARN.learnCost({
          trackLevels: trackLevels(false), school: school, level: next, intellect: intellect(),
          knowOneAtLevel: countAt(school, next) > 0,
          // GetNumAtLevel counts what EXISTS at that level in the game (system.kod:1693),
          // not what this character knows; counting known spells applied the ÷3 relief to
          // anyone holding a single spell at the level below.
          prevLevelCount: next > 1 ? D.spells.filter(function (sp) {
            return sp.school === school && sp.level === next - 1;
          }).length : 3,
          constants: D.learning,
        });
      }
      var costHtml = cost.need == null
        ? '<span class="cost">—</span>'
        : '<span class="cost" title="' + esc(cost.why) + '">L' + next + ' needs ' + cost.need + '</span>';

      row.innerHTML = '<span class="k" title="' + esc(school) + '">' + esc(school) + '</span>'
        + '<span class="m59-pips">' + pips + '</span>' + costHtml;
      wrap.appendChild(row);
    });

    Array.prototype.forEach.call(wrap.querySelectorAll('.m59-pip'), function (b) {
      b.onclick = function () {
        var s = b.getAttribute('data-school'), lv = Number(b.getAttribute('data-level'));
        // Clicking the level you already asked for clears it, so there is a way back to
        // "no opinion" that is not the same as "level zero".
        if (L.plan.schools[s] === lv) {
          delete L.plan.schools[s];
          L.plan.learning_queue = learningQueue().filter(function (entry) {
            return norm(entry.track) !== norm(s);
          });
        } else {
          L.plan.schools[s] = lv;
          setTrackQueue(s, lv);
        }
        renderSpells(); renderEditor();
      };
    });

    var t = trackLevels(true), pts = LEARN ? LEARN.trackPoints(D.learning.level_points, t) : null;
    el('plSchoolFoot').innerHTML =
      (pts === null ? '' : '<span>' + pts + ' track points if this plan is reached</span>')
      + '<span>intellect ' + intellect() + ' buys off '
      + (D.learning.points_slope == null ? '—'
         : Math.trunc(intellect() * 2 * D.learning.points_slope / 5)) + '</span>'
      + '<span>the seventh track is skills: level ' + t.weapon + '</span>';
  }

  // ------------------------------------------------------------------ skills pane

  function renderSkills() {
    var wrap = el('plSkills');
    var abilityOf = {};
    if (OBS && OBS.skills) OBS.skills.forEach(function (s) { abilityOf[norm(s.name)] = s.ability; });
    var wanted = {};
    L.plan.abilities.forEach(function (a) { wanted[norm(a.name)] = true; });

    var has = observedPlannedWeaponLevel(), wantLevel = L.plan.weapon_level || 0;
    var pips = '';
    for (var lv = 1; lv <= (D.learning.max_school_level || 6); lv++) {
      var mine = lv <= has, chosen = lv <= wantLevel;
      pips += '<button type="button" class="m59-pip' + (mine ? ' have' : '')
        + (chosen ? ' on' : '') + (chosen && !mine ? ' beyond' : '')
        + '" data-weapon-level="' + lv + '" title="Weaponcraft level ' + lv
        + (mine ? ' — already known' : chosen ? ' — planned' : '') + '">' + lv + '</button>';
    }
    wrap.innerHTML = '<div class="m59-school"><span class="k">Weaponcraft</span>'
      + '<span class="m59-pips">' + pips + '</span></div>';
    Array.prototype.forEach.call(wrap.querySelectorAll('[data-weapon-level]'), function (b) {
      b.onclick = function () {
        var level = Number(b.getAttribute('data-weapon-level'));
        if (L.plan.weapon_level === level) {
          L.plan.weapon_level = null;
          L.plan.learning_queue = learningQueue().filter(function (entry) {
            return norm(entry.track) !== 'weaponcraft';
          });
        } else {
          L.plan.weapon_level = level;
          setTrackQueue('weaponcraft', level);
        }
        renderSkills(); renderEditor();
      };
    });
    D.skills.filter(function (s) { return s.learnable; }).forEach(function (s) {
      var ab = abilityOf[norm(s.name)], want = wanted[norm(s.name)];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'm59-row' + (ab == null && want ? ' planned' : '');
      b.setAttribute('aria-pressed', String(!!want));
      b.title = (s.description || s.name) + '\nkeys off ' + (s.requisite_stat || 'nothing recorded')
        + '\n' + (s.for_sale ? 'level ' + s.level + ', ' + s.price + ' shillings (250 x 2^level, no markup)'
                             : (s.level_note || 'not sold'));
      b.innerHTML = '<span class="ic"></span><span class="nm">' + esc(s.name) + '</span>'
        + (s.requisite_stat ? '<span class="tag">' + esc(s.requisite_stat) + '</span>' : '')
        // NOT SOLD IS NOT A MISSING PRICE. assess, thrust and kick are granted rather than
        // bought, and showing them with a blank price would read as "we could not find out".
        + '<span class="tag">' + (s.for_sale ? 'L' + s.level + ' · ' + s.price + 'sh' : 'granted') + '</span>'
        + '<span class="pc">' + (ab == null ? '—' : ab + '%') + '</span>';
      b.onclick = function () {
        if (wanted[norm(s.name)]) {
          L.plan.abilities = L.plan.abilities.filter(function (a) { return norm(a.name) !== norm(s.name); });
          L.plan.learning_queue = learningQueue().filter(function (a) { return norm(a.name) !== norm(s.name); });
        } else {
          L.plan.abilities.push({ name: s.name, kind: 'skill', level: null, why: null });
          learningQueue().push({ name: s.name, kind: 'skill' });
        }
        renderSkills(); renderEditor();
      };
      wrap.appendChild(b);
    });

    var known = Object.keys(abilityOf).length;
    // WHAT THE PLAN COSTS TO BUY, which is the number an errand withdraws against. Only the
    // ones not already known, and only the ones anybody sells.
    var bill = 0, unsold = 0;
    L.plan.abilities.forEach(function (a) {
      if (abilityOf[norm(a.name)] != null) return;
      var s = BY_SKILL[norm(a.name)];
      if (s && s.for_sale) bill += s.price; else if (s) unsold++;
    });
    el('plSkillFoot').innerHTML =
      '<span>' + known + ' known' + (OBS ? '' : ' (nothing observed)') + '</span>'
      + '<span>' + L.plan.abilities.length + ' on the plan</span>'
      + (bill ? '<span>' + bill + 'sh to buy what is missing</span>' : '')
      + (unsold ? '<span>' + unsold + ' of them are granted, not sold</span>' : '')
      + '<span>250 &times; 2^level, no markup (monster.kod:4880)</span>';
  }

  // ------------------------------------------------------------------ stats pane

  var STAT_ORDER = SP.STAT_ORDER;

  function renderStats() {
    var wrap = el('plStats');
    var obs = (OBS && OBS.attributes) || null;
    wrap.innerHTML = '';
    STAT_ORDER.forEach(function (k) {
      var meta = D.stats[k] || { label: k, blurb: '' };
      var observed = obs ? obs[k] : null;
      var planned = L.plan.stats ? L.plan.stats[k] : null;
      var v = planned != null ? planned : (observed == null ? 0 : observed);
      var kk = document.createElement('span');
      kk.className = 'k'; kk.textContent = meta.label; kk.title = meta.blurb;
      var bar = document.createElement('span');
      // ATTRIBUTES ARE FIXED AT CREATION AND NEVER MOVE, so a slider here is a HYPOTHETICAL
      // character — a re-roll — not something this character can be walked towards. It is
      // hatched for that reason, the same way a planned school level is.
      bar.className = 'm59-bar edit' + (planned != null ? ' planned' : observed != null ? ' observed' : '');
      bar.title = meta.blurb + (observed != null && planned != null && planned !== observed
        ? '\nObserved ' + observed + '. A different value here describes a RE-ROLL: attributes are '
          + 'fixed at creation and never move.' : '');
      // The ceiling is the server's own `hard_cap`, which it sends with every attribute.
      // 70 is only the fallback for a build nobody has observed.
      var cap = (OBS && OBS.attribute_caps && OBS.attribute_caps[k]) || SP.HARD_CAP_FALLBACK;
      bar.innerHTML = '<i style="width:' + Math.max(0, Math.min(100, v / cap * 100)) + '%"></i>'
        + '<b>' + v + '</b>'
        + '<input type="range" min="0" max="' + cap + '" step="1" value="' + v
        + '" aria-label="' + esc(meta.label) + '">';
      bar.querySelector('input').oninput = function (e) {
        L.plan.stats = L.plan.stats || {};
        L.plan.stats[k] = Number(e.target.value);
        renderStats(); renderInventory(); renderSpells(); renderEditor();
      };
      wrap.appendChild(kk); wrap.appendChild(bar);
    });

    // The footer is statpane.mjs's, not this page's — the same three numbers the fleet's
    // /stats board prints under its own panes, from the same function. It is handed the
    // EFFECTIVE build: planned where a slider has been moved, observed everywhere else,
    // which is what the bars above are drawn from too.
    el('plStatFoot').innerHTML = SP.statFoot(effectiveStats());
  }

  // Planned over observed, per stat. A plan that names three attributes describes a re-roll
  // of those three and the same character everywhere else, so the arithmetic has to see
  // both — and everything that computes against a build (the carry cap, the mana pool, the
  // footer) has to see the same merge or the page will contradict itself between tabs.
  function effectiveStats() {
    var obs = (OBS && OBS.attributes) || null;
    var out = {};
    STAT_ORDER.forEach(function (k) {
      var planned = L.plan.stats ? L.plan.stats[k] : null;
      // NULL, NOT ZERO, for a stat nobody has read. Zero is a real roll — `create automated`
      // produces one and the character is capped at 102 max health for ever — so a blank
      // build must not report a ceiling of 101 as though it had rolled nothing.
      out[k] = planned != null ? planned : (obs && obs[k] != null ? obs[k] : null);
    });
    return out;
  }

  // ------------------------------------------------------------------ the editor column

  function renderEditor() {
    var t = el('plEditorTitle'), b = el('plEditorBody');
    if (TAB === 'inventory') { t.textContent = 'Gear, and what to carry'; renderCarryEditor(b); }
    else if (TAB === 'spells') { t.textContent = 'Schools and what they cost'; renderSpellEditor(b); }
    else if (TAB === 'skills') { t.textContent = 'Skills on the plan'; renderSkillEditor(b); }
    else { t.textContent = 'Attributes, and what they are worth'; renderStatEditor(b); }
    renderDiff();
    renderProblems();
  }

  // ---- inventory editor: the picker and the selected entry

  function renderCarryEditor(box) {
    var kinds = ['reagent', 'food', 'weapon', 'armour', 'shield', 'other'];
    box.innerHTML =
      gearEditorHtml()
      + '<h2 style="margin-top:16px">What to carry</h2>'
      + '<p class="hint">The number on each icon is the MINIMUM — what the keeper tops up to '
      + 'when it is standing at a counter, and what it will not sell below. The small number '
      + 'is the ceiling: anything above it is shed.</p>'
      + '<div class="pl-filters">'
      + kinds.map(function (k) {
        return '<button type="button" class="btn" data-kind="' + k + '" aria-pressed="'
          + (FILTER === k) + '">' + k + '</button>';
      }).join('')
      + '</div>'
      + '<label style="display:block;margin-bottom:6px">Search '
      + '<input type="search" id="plSearch" value="' + esc(QUERY) + '" style="width:100%">'
      + '</label>'
      + '<div class="pl-picker" id="plPicker"></div>'
      + '<div id="plEntry"></div>';

    bindGearEditor(box);
    Array.prototype.forEach.call(box.querySelectorAll('[data-kind]'), function (btn) {
      btn.onclick = function () { FILTER = btn.getAttribute('data-kind'); renderEditor(); };
    });
    var s = el('plSearch');
    s.oninput = function () { QUERY = s.value; renderPicker(); };
    renderPicker();
    renderEntry();
  }

  // ---- the gear editor
  //
  // GEAR IS A DIFFERENT KIND OF ANSWER FROM A CARRY LIST AND THE PAGE HAD NO WAY TO SAY IT.
  // A carry entry is a quantity — twenty elderberry, shed above forty. Gear is an ORDERED
  // PREFERENCE with one winner per slot: the keeper reaches for the first of these it owns
  // (weaponPriorityNow, m59-autopilot.mjs:982) and an outfitting run buys the first it is
  // missing. Until now the only way to fill it in was to seed a file from a character sheet
  // and hand-edit the JSON, which is why every loadout here has an empty one.
  //
  // The slots are the keeper's own (GEAR_SLOTS in m59-loadout.mjs). The catalogue only
  // classifies weapons, shields and body armour, so those three offer a filtered list and
  // the rest offer everything — an honest "we do not know which items go here" rather than
  // an empty box that reads as "there are none".

  var GEAR_SLOTS = ['body', 'shield', 'head', 'hands', 'feet', 'neck', 'finger', 'cloak'];
  var GEAR_KIND = { weapon: 'weapon', shield: 'shield', body: 'armour' };
  var GEAR_SLOT = 'weapon';        // which slot the add control is pointed at

  function gearList(key, make) {
    if (key === 'weapon') return L.gear.weapon;
    if (!L.gear.slots[key] && make) L.gear.slots[key] = [];
    return L.gear.slots[key] || null;
  }

  function gearKeys() {
    var out = ['weapon'];
    GEAR_SLOTS.forEach(function (s) { if ((L.gear.slots[s] || []).length) out.push(s); });
    // A slot from a file that this page has not heard of is shown rather than dropped — it
    // is a fact about the loadout, and normalise() carries it through for the same reason.
    Object.keys(L.gear.slots).forEach(function (s) {
      if (out.indexOf(s) < 0 && (L.gear.slots[s] || []).length) out.push(s);
    });
    return out;
  }

  function gearEditorHtml() {
    var have = held(), any = OBS && OBS.inventory;
    var rows = gearKeys().map(function (key) {
      var list = gearList(key) || [];
      var items = list.map(function (n, i) {
        var src = iconFor(n), h = any ? (have[norm(n)] || 0) : null;
        return '<span class="pl-gear-item' + (i === 0 ? ' first' : '') + (h === 0 ? ' none' : '') + '"'
          + ' title="' + esc(n) + (i === 0 ? ' — first choice' : ' — fallback ' + i)
          + (h === null ? '' : h > 0 ? ', holding one' : ', not in the pack') + '">'
          + (src ? '<img src="' + esc(src) + '" alt="">' : '')
          + '<b>' + esc(n) + '</b>'
          + (i === 0 ? '' : '<button type="button" data-gear-up="' + esc(key) + '" data-i="' + i
             + '" title="Make this the first choice">&#9650;</button>')
          + '<button type="button" data-gear-rm="' + esc(key) + '" data-i="' + i
          + '" title="Stop asking for this">&times;</button></span>';
      }).join('');
      if (!items && key !== 'weapon') return '';
      return '<div class="pl-gear"><span class="slot">' + esc(key) + '</span>'
        + '<span class="items">' + (items || '<em class="muted">nothing asked for</em>') + '</span></div>';
    }).join('');

    var slotOpts = ['weapon'].concat(GEAR_SLOTS).map(function (s) {
      return '<option value="' + esc(s) + '"' + (GEAR_SLOT === s ? ' selected' : '') + '>' + esc(s) + '</option>';
    }).join('');
    var kind = GEAR_KIND[GEAR_SLOT] || null;
    var choices = D.items.filter(function (i) {
      return kind ? i.kind === kind : (i.kind !== 'reagent' && i.kind !== 'food');
    }).sort(function (a, b) { return a.name < b.name ? -1 : 1; });

    return '<h2>Gear — what it fights in</h2>'
      + '<p class="hint">An ordered preference, best first. The keeper reaches for the first of '
      + 'these the character owns, and an outfitting run buys the first it is missing — so a '
      + 'character holding the second is one upgrade short, not missing its gear. Names are '
      + 'exact: a list saying "short sword" is <em>not</em> satisfied by a mace.</p>'
      + '<div class="pl-gears">' + rows + '</div>'
      + '<div class="pl-gear-add">'
      + '<select id="plGearSlot" aria-label="Which slot">' + slotOpts + '</select>'
      + '<select id="plGearItem" aria-label="Which item">'
      + choices.map(function (i) { return '<option value="' + esc(i.name) + '">' + esc(i.name) + '</option>'; }).join('')
      + '</select>'
      + '<button type="button" class="btn" id="plGearAdd">Add</button>'
      + '</div>'
      + (kind ? '' : '<p class="hint">The catalogue only classifies weapons, shields and body '
         + 'armour, so this list is everything else it knows rather than the pieces that fit '
         + 'that slot.</p>')
      + (L.gear.from ? '<p class="pl-note">This gear was applied from ' + esc(L.gear.from) + '.</p>' : '');
  }

  // EDITING THE LIST ENDS ITS PROVENANCE. `from` says this gear arrived from somebody else's
  // plan, and the moment somebody adds or reorders an entry that is no longer true — a line
  // claiming it came from Kermit, over a list Kermit never had, is worse than no line.
  function gearEdited() {
    L.gear.from = null;
    renderInventory(); renderEditor();
  }

  function bindGearEditor(box) {
    var slot = box.querySelector('#plGearSlot');
    if (slot) slot.onchange = function () { GEAR_SLOT = slot.value; renderEditor(); };
    var add = box.querySelector('#plGearAdd');
    if (add) add.onclick = function () {
      var name = box.querySelector('#plGearItem').value;
      var list = gearList(GEAR_SLOT, true);
      if (list.some(function (n) { return norm(n) === norm(name); })) {
        say(name + ' is already on that list', 'bad');
        return;
      }
      list.push(name);
      gearEdited();
    };
    Array.prototype.forEach.call(box.querySelectorAll('[data-gear-rm]'), function (b) {
      b.onclick = function () {
        var key = b.getAttribute('data-gear-rm'), i = Number(b.getAttribute('data-i'));
        var list = gearList(key);
        if (!list) return;
        list.splice(i, 1);
        // An empty slot is removed rather than left as an empty list, because an empty list
        // and an absent one mean the same thing to every reader and only one of them is
        // written down that way.
        if (!list.length && key !== 'weapon') delete L.gear.slots[key];
        gearEdited();
      };
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-gear-up]'), function (b) {
      b.onclick = function () {
        var key = b.getAttribute('data-gear-up'), i = Number(b.getAttribute('data-i'));
        var list = gearList(key);
        if (!list || i <= 0) return;
        list.unshift(list.splice(i, 1)[0]);
        gearEdited();
      };
    });
  }

  function renderPicker() {
    var box = el('plPicker');
    if (!box) return;
    var q = norm(QUERY);
    var rows = D.items.filter(function (i) {
      var kindOk = FILTER === 'other'
        ? ['reagent', 'food', 'weapon', 'armour', 'shield'].indexOf(i.kind) < 0
        : i.kind === FILTER;
      if (q) return norm(i.name).indexOf(q) >= 0;      // a search crosses the filters
      return kindOk;
    }).slice(0, 300);

    box.innerHTML = rows.map(function (i) {
      var on = !!carryEntry(i.name);
      var meta = [];
      if (i.weight != null) meta.push(i.weight + 'w');
      if (i.value != null) meta.push(i.value + 'sh');
      if (i.nutrition) meta.push(i.nutrition + ' vigor');
      if (i.reagent_for && i.reagent_for.length) meta.push(i.reagent_for.length + ' spells');
      return '<button type="button" class="pl-pick" data-name="' + esc(i.name) + '"'
        + (on ? ' disabled' : '') + ' title="' + esc(i.description || i.name) + '">'
        + (i.icon ? '<img src="' + esc(rel + '/' + i.icon) + '" alt="">' : '<span style="width:20px"></span>')
        + '<span class="nm">' + esc(i.name) + (on ? ' — already asked for' : '') + '</span>'
        + '<span class="meta">' + esc(meta.join(' · ')) + '</span></button>';
    }).join('') || '<p class="pl-note" style="padding:8px">Nothing matches.</p>';

    Array.prototype.forEach.call(box.querySelectorAll('.pl-pick'), function (btn) {
      btn.onclick = function () {
        var name = btn.getAttribute('data-name');
        if (carryEntry(name)) return;
        var it = BY_ITEM[norm(name)];
        L.carry.push({
          item: name, min: 1, max: null, match: 'exact',
          why: it && it.reagent_for && it.reagent_for.length
            ? 'reagent for ' + it.reagent_for.slice(0, 3).map(function (r) { return r.spell; }).join(', ')
            : null,
        });
        SEL = name;
        renderInventory(); renderEditor();
      };
    });
  }

  function renderEntry() {
    var box = el('plEntry');
    if (!box) return;
    var c = SEL ? carryEntry(SEL) : null;
    if (!c) { box.innerHTML = '<p class="pl-note">Pick something in the grid to set its amounts.</p>'; return; }
    var it = BY_ITEM[norm(c.item)];
    var have = held()[norm(c.item)];
    box.innerHTML = '<h2 style="margin-top:14px">' + esc(c.item) + '</h2>'
      + (it && it.description ? '<p class="hint">' + esc(it.description) + '</p>' : '')
      + '<div class="pl-fields">'
      + '<label for="plMin">Carry at least</label><input type="number" id="plMin" min="0" max="9999" value="' + c.min + '">'
      + '<label for="plMax">Shed above</label><input type="number" id="plMax" min="0" max="9999" value="'
      + (c.max === null ? '' : c.max) + '" placeholder="no ceiling">'
      + '<label for="plWhy">Because</label><input type="text" id="plWhy" value="' + esc(c.why || '') + '">'
      + '</div>'
      + '<p class="pl-note" style="margin-top:8px">'
      + (OBS ? 'Holding ' + (have || 0) + ' now. ' : '')
      + (it && it.weight != null ? c.min + ' of these weigh ' + (it.weight * c.min) + '. ' : '')
      + (it && it.reagent_for && it.reagent_for.length
        ? 'Consumed by ' + it.reagent_for.map(function (r) { return esc(r.spell) + ' (' + r.count + ')'; })
          .slice(0, 8).join(', ') + (it.reagent_for.length > 8 ? ' and others' : '') + '.'
        : '')
      + '</p>'
      + '<p><button type="button" class="btn" id="plDrop">Stop asking for this</button></p>';

    el('plMin').oninput = function (e) { c.min = Math.max(0, Number(e.target.value) || 0); renderInventory(); renderDiff(); renderProblems(); };
    el('plMax').oninput = function (e) {
      var v = e.target.value === '' ? null : Math.max(0, Number(e.target.value) || 0);
      c.max = v; renderInventory(); renderDiff(); renderProblems();
    };
    el('plWhy').oninput = function (e) { c.why = e.target.value || null; };
    el('plDrop').onclick = function () {
      L.carry = L.carry.filter(function (x) { return norm(x.item) !== norm(c.item); });
      SEL = null; renderInventory(); renderEditor();
    };
  }

  // ---- one acquisition queue, shared by spells and skills

  function appendLearningQueue(box) {
    var q = learningQueue();
    var section = document.createElement('div');
    section.className = 'pl-learning-queue';
    section.innerHTML = '<h2 style="margin-top:14px">Acquisition queue</h2>'
      + '<p class="hint">The auto-level strategy works only on the first unfinished row. '
      + 'Every ability at that exact school level is bought before the next row opens.</p>'
      + (q.length ? '<ol>' + q.map(function (entry, i) {
        var label = entry.name ? entry.name : (entry.track + ' level ' + entry.level);
        return '<li><span>' + esc(label) + '</span><span class="pl-queue-buttons">'
          + '<button type="button" class="btn" data-q-up="' + i + '" title="Move earlier">↑</button>'
          + '<button type="button" class="btn" data-q-down="' + i + '" title="Move later">↓</button>'
          + '<button type="button" class="btn" data-q-remove="' + i + '">Remove</button>'
          + '</span></li>';
      }).join('') + '</ol>'
        : '<p class="pl-note">Nothing queued. Pick a school level or tick an individual skill.</p>');
    box.appendChild(section);

    function rerender() { renderSpells(); renderSkills(); renderEditor(); }
    Array.prototype.forEach.call(section.querySelectorAll('[data-q-up]'), function (b) {
      b.onclick = function () {
        var i = Number(b.getAttribute('data-q-up'));
        if (i > 0) { var x = q[i - 1]; q[i - 1] = q[i]; q[i] = x; rerender(); }
      };
    });
    Array.prototype.forEach.call(section.querySelectorAll('[data-q-down]'), function (b) {
      b.onclick = function () {
        var i = Number(b.getAttribute('data-q-down'));
        if (i < q.length - 1) { var x = q[i + 1]; q[i + 1] = q[i]; q[i] = x; rerender(); }
      };
    });
    Array.prototype.forEach.call(section.querySelectorAll('[data-q-remove]'), function (b) {
      b.onclick = function () {
        var i = Number(b.getAttribute('data-q-remove')), removed = q.splice(i, 1)[0];
        if (removed && removed.name) L.plan.abilities = L.plan.abilities.filter(function (a) {
          return norm(a.name) !== norm(removed.name);
        });
        rerender();
      };
    });
  }

  // ---- spells editor

  function renderSpellEditor(box) {
    var have = observedSchools();
    var chosen = Object.keys(L.plan.schools);
    var wanted = [];               // every spell the plan would reach
    D.spells.forEach(function (sp) {
      var target = L.plan.schools[sp.school];
      if (target && sp.level <= target) wanted.push(sp);
    });

    // WHAT THE PLAN NEEDS TO CAST, which is the point of the whole page: a spell list is
    // also a shopping list, and until now nothing joined the two. Counted as ONE CASTING of
    // each spell, because "how many castings" is a question about how the character is
    // played and this page cannot answer it — the number is a floor, and the minimums in
    // the inventory tab are where somebody says how many.
    var need = {};
    wanted.forEach(function (sp) {
      (sp.reagents || []).forEach(function (r) {
        var it = itemForClass(r.item);
        var key = it ? it.name : r.item;
        need[key] = Math.max(need[key] || 0, r.count);
      });
    });
    var needList = Object.keys(need).sort();

    box.innerHTML =
      '<p class="hint">Solid pips are levels the character already has; hatched ones are the '
      + 'plan. The cost shown is for the NEXT level only — a level four out is priced against '
      + 'knowledge this character does not have yet, so a total for it would be arithmetic '
      + 'about an imaginary character.</p>'
      + (chosen.length
        ? '<p class="pl-note">The plan reaches <strong>' + wanted.length + '</strong> spell(s) across '
          + chosen.length + ' school(s).</p>'
        : '<p class="pl-note">No school picked yet.</p>')
      + (needList.length
        ? '<h2 style="margin-top:14px">Reagents those spells eat</h2>'
          + '<p class="hint">One casting of each. Add them to the carry list and set real '
          + 'numbers on the Inventory tab.</p>'
          + '<ul style="margin:0 0 8px;padding-left:18px">'
          + needList.map(function (n) {
            return '<li>' + esc(n) + ' &times;' + need[n]
              + (carryEntry(n) ? ' <em>— already asked for</em>' : '') + '</li>';
          }).join('') + '</ul>'
          + '<p><button type="button" class="btn" id="plAddReagents">Add these to the carry list</button></p>'
        : '')
      + (LEARN && D.learning.points_slope != null ? '' :
        '<p class="pl-problems">Costs are not shown: ' + esc((D.learning.unresolved || []).join(', '))
        + ' could not be read from the game source.</p>')
      + '<h2 style="margin-top:14px">Spells the plan would reach</h2>'
      + (wanted.length
        ? '<div class="pl-picker">' + wanted.map(function (sp) {
          var known = OBS && OBS.spells && OBS.spells.some(function (x) { return norm(x.name) === norm(sp.name); });
          return '<div class="pl-pick" style="cursor:default">'
            + '<span class="nm">' + esc(sp.name) + (known ? '' : ' <em>— not learned</em>') + '</span>'
            + '<span class="meta">' + esc(sp.school) + ' L' + sp.level
            + (sp.mana ? ' · ' + sp.mana + ' mana' : '') + '</span></div>';
        }).join('') + '</div>'
        : '');

    var add = el('plAddReagents');
    if (add) add.onclick = function () {
      needList.forEach(function (n) {
        if (carryEntry(n)) return;
        var it = BY_ITEM[norm(n)];
        // A FLOOR OF ONE CASTING IS NOT ENOUGH TO CAST TWICE, and the whole reason the fleet
        // sits at 80 vigor is running out between shops. Ten castings is the keeper's own
        // default (REAGENT_TARGET) expressed per character, and it is a starting number to
        // be edited, not a claim.
        L.carry.push({ item: n, min: need[n] * 10, max: need[n] * 20, match: 'exact',
                       why: it && it.reagent_for && it.reagent_for.length
                         ? 'reagent for ' + it.reagent_for.slice(0, 3).map(function (r) { return r.spell; }).join(', ')
                         : 'a spell on the plan needs it' });
      });
      say('added ' + needList.length + ' reagent(s) to the carry list', 'good');
      selectTab('inventory');
      renderInventory(); renderEditor();
    };
    appendLearningQueue(box);
  }

  // The catalogue keys on DISPLAY names and a spell's reagent list names CLASSES —
  // "ElderBerry" against "elderberry". Matched on the class first and the name second,
  // rather than lowercasing one and hoping.
  var BY_CLASS = {};
  function itemForClass(cls) {
    return BY_CLASS[norm(cls)] || BY_ITEM[norm(cls)] || null;
  }

  // ---- skills editor

  function renderSkillEditor(box) {
    var abilityOf = {};
    if (OBS && OBS.skills) OBS.skills.forEach(function (s) { abilityOf[norm(s.name)] = s.ability; });
    var missing = L.plan.abilities.filter(function (a) { return abilityOf[norm(a.name)] == null; });
    box.innerHTML =
      '<p class="hint">Ticking a skill appends it to the acquisition queue. It does not buy it — '
      + '<code>node tools/m59-outfit.mjs --learn &lt;name&gt;</code> is the errand that does, '
      + 'and it reads these names.</p>'
      + (L.plan.abilities.length
        ? '<ul style="padding-left:18px">' + L.plan.abilities.map(function (a) {
          var ab = abilityOf[norm(a.name)];
          return '<li>' + esc(a.name) + (ab == null ? ' <em>— not learned</em>' : ' — ' + ab + '%') + '</li>';
        }).join('') + '</ul>'
        : '<p class="pl-note">Nothing on the plan.</p>')
      + (missing.length
        ? '<p class="pl-note">' + missing.length + ' of these are not learned. A merchant that '
          + 'cannot teach you one does not say so — it is simply absent from the shop list '
          + '(<code>monster.kod:4855</code>), so a quiet trip is not evidence of anything.</p>'
        : '')
      + '<h2 style="margin-top:14px">What each attribute drives</h2>'
      + Object.keys(D.by_stat).filter(function (k) { return (D.by_stat[k].skills || []).length; })
        .map(function (k) {
          return '<p class="pl-note"><strong>' + esc((D.stats[k] || {}).label || k) + '</strong> — '
            + esc(D.by_stat[k].skills.join(', ')) + '</p>';
        }).join('');
    appendLearningQueue(box);
  }

  // ---- stats editor

  function renderStatEditor(box) {
    var obs = OBS && OBS.attributes;
    box.innerHTML =
      '<p class="hint">Attributes are fixed at character creation and never move. Changing '
      + 'them here describes a <strong>re-roll</strong> — a different character — not '
      + 'something this one can be walked towards. That is why they hatch when you touch '
      + 'them.</p>'
      + (obs && L.plan.stats
        ? '<p><button type="button" class="btn" id="plStatReset">Back to what was observed</button></p>'
        : '')
      + Object.keys(D.stats).map(function (k) {
        return '<p class="pl-note"><strong>' + esc(D.stats[k].label) + '</strong> — '
          + esc(D.stats[k].blurb) + '</p>';
      }).join('')
      + (D.by_stat.intellect && D.by_stat.intellect.applies_to_everything
        ? '<p class="pl-note">' + esc(D.by_stat.intellect.applies_to_everything) + '</p>' : '');
    var r = el('plStatReset');
    if (r) r.onclick = function () {
      delete L.plan.stats;
      renderStats(); renderInventory(); renderSpells(); renderEditor();
    };
  }

  // ------------------------------------------------------------------ the diff

  function renderDiff() {
    var box = el('plDiffBox'), out = el('plDiff');
    if (!OBS || !OBS.inventory) { box.hidden = true; return; }
    box.hidden = false;
    var have = held(), rows = [];

    L.carry.forEach(function (c) {
      var h = have[norm(c.item)] || 0;
      if (h < c.min) rows.push(['buy', c.item, (c.min - h) + ' more', h + ' of ' + c.min]);
      else if (c.max !== null && h > c.max) rows.push(['shed', c.item, (h - c.max) + ' over', h + ' of ' + c.max]);
    });
    L.sell.forEach(function (s) {
      var h = have[norm(s)] || 0;
      if (h > 0) rows.push(['shed', s, 'all ' + h, 'on the sell list']);
    });
    // GEAR: HOLDING THE SECOND CHOICE IS NOT MISSING IT. Reporting those alike is how an
    // outfitting run buys a mace for a character already carrying one.
    function gearRow(list, what) {
      if (!list || !list.length) return;
      var best = -1;
      for (var i = 0; i < list.length; i++) if ((have[norm(list[i])] || 0) > 0) { best = i; break; }
      if (best < 0) rows.push(['buy', list[0], 'missing', what]);
      else if (best > 0) rows.push(['', list[best], 'holding this', 'wants ' + list.slice(0, best).join(' or ')]);
    }
    gearRow(L.gear.weapon, 'weapon');
    Object.keys(L.gear.slots).forEach(function (s) { gearRow(L.gear.slots[s], s); });

    if (!rows.length) {
      out.innerHTML = '<p class="pl-note">Everything the loadout asks for is already there.</p>';
      return;
    }
    out.innerHTML = '<table class="data"><tbody>' + rows.map(function (r) {
      return '<tr class="' + r[0] + '"><td>' + esc(r[1]) + '</td><td>' + esc(r[2])
        + '</td><td class="muted">' + esc(r[3]) + '</td></tr>';
    }).join('') + '</tbody></table>';
  }

  // ------------------------------------------------------------------ problems
  //
  // The same checks m59-loadout.mjs's normalise() makes on the way in, run here so the page
  // says so before somebody saves rather than after. The tool is still the authority — this
  // is a preview of its answer, not a substitute for it.

  function renderProblems() {
    var box = el('plProblemBox'), out = el('plProblems'), p = [];
    L.carry.forEach(function (c) {
      if (c.max !== null && c.max < c.min)
        p.push('"' + c.item + '": the ceiling (' + c.max + ') is below the floor (' + c.min
          + '). The keeper would buy up to the floor and sell back to the ceiling, for ever, '
          + 'paying the vendor spread on every lap.');
      if (!BY_ITEM[norm(c.item)])
        p.push('"' + c.item + '" is not in the item catalogue — check the spelling.');
    });
    L.sell.forEach(function (s) {
      if (L.keep.some(function (k) { return norm(k) === norm(s); }))
        p.push('"' + s + '" is on both the sell and the keep list. Keep wins.');
      var c = carryEntry(s);
      if (c && c.min > 0) p.push('"' + s + '" is sell-on-sight but ' + c.min + ' are wanted. The floor wins.');
    });
    if (!L.character) p.push('No character name, so there is nowhere to save this.');
    box.hidden = p.length === 0;
    out.innerHTML = p.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('');
  }

  // ------------------------------------------------------------------ loading a character

  function cookieAgent() {
    try {
      var m = document.cookie.match(/(?:^|;\s*)m59char=([^;]*)/);
      if (!m) return null;
      var b = JSON.parse(decodeURIComponent(m[1]));
      return (b && b.from && b.from.agent) || null;
    } catch (e) { return null; }
  }

  function adopt(snapshot) {
    OBS = snapshot.observed || null;
    L = snapshot.loadout || blank(snapshot.character || (OBS && OBS.character) || '');
    L.plan = L.plan || { schools: {}, weapon_level: null, learning_target: null,
                         learning_queue: [], abilities: [] };
    L.plan.schools = L.plan.schools || {};
    L.plan.abilities = Array.isArray(L.plan.abilities) ? L.plan.abilities : [];
    L.plan.learning_queue = Array.isArray(L.plan.learning_queue) ? L.plan.learning_queue : [];
    // Older loadouts predate the explicit queue but already have deterministic order:
    // checked abilities, spell schools alphabetically by level, then Weaponcraft. Show
    // that order instead of an empty queue which the server would still infer on save.
    if (!L.plan.learning_queue.length) {
      L.plan.abilities.forEach(function (a) {
        L.plan.learning_queue.push({ name: a.name, kind: a.kind || null });
      });
      Object.keys(L.plan.schools).sort().forEach(function (school) {
        for (var lv = 1; lv <= Number(L.plan.schools[school]); lv++)
          L.plan.learning_queue.push({ track: school, level: lv });
      });
      for (var wlv = 1; wlv <= Number(L.plan.weapon_level || 0); wlv++)
        L.plan.learning_queue.push({ track: 'weaponcraft', level: wlv });
    }
    if (!L.character && OBS && OBS.character) L.character = OBS.character;
    if (!L.agent && OBS && OBS.agent) L.agent = OBS.agent;
    el('plName').value = L.character || '';
    SEL = L.carry.length ? L.carry[0].item : null;
    renderAll();
  }

  function renderAll() {
    renderInventory(); renderSpells(); renderSkills(); renderStats(); renderEditor();
  }

  // A FILE CAN BE EITHER OF TWO THINGS AND THEY ARE NOT THE SAME. A loadout is a plan; a
  // character sheet out of substrate/sheets/ is an observation. Loading a sheet as though it
  // were a plan would turn "this is what it happens to be carrying" into "this is what it
  // must carry", which is exactly the confusion this page exists to remove.
  function adoptFile(j) {
    if (j && j.format === 'm59-loadout/1') {
      adopt({ loadout: j, character: j.character, observed: OBS });
      say('loaded the loadout for ' + (j.character || 'an unnamed character'), 'good');
      return;
    }
    if (j && j._format && j.attributes) {
      OBS = {
        character: j.character, agent: j.agent, attributes: j.attributes,
        skills: j.skills || [], spells: j.spells || [],
        inventory: j.inventory || [], equipment: (j.equipment && j.equipment.worn) || [],
        at: j.captured_at_iso || null, source: 'a character sheet',
      };
      L = blank(j.character || '');
      L.agent = j.agent || null;
      L.note = 'Started from a character sheet captured ' + (j.captured_at_iso || 'at an unknown time') + '.';
      el('plName').value = L.character;
      renderAll();
      say('read the sheet for ' + j.character + ' — it is an observation, so nothing is planned yet', 'good');
      return;
    }
    say('that file is neither a loadout nor a character sheet', 'bad');
  }

  // ------------------------------------------------------------------ saving

  function currentLoadout() {
    var out = JSON.parse(JSON.stringify(L));
    out.character = el('plName').value.trim() || out.character;
    out.format = 'm59-loadout/1';
    return out;
  }

  function exportFile() {
    var j = currentLoadout();
    if (!j.character) { say('give it a name first', 'bad'); return; }
    var blob = new Blob([JSON.stringify(j, null, 1)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = j.character.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    say('downloaded — put it in substrate/loadouts/ and the keeper will read it', 'good');
  }

  function save() {
    if (multipleCharacters()) { sharedToCharacters('selected', false); return; }
    var j = currentLoadout();
    if (!j.character) { say('give it a name first', 'bad'); return; }
    if (!SERVED) {
      say('nothing is listening — use Export, or open this page from the harness ' +
          '(node tools/m59-compendium.mjs --open --to /planner/)', 'bad');
      return;
    }
    say('saving…');
    fetch(rel + '/_loadout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(j),
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        if (!res.ok) { say(res.b.error || 'refused', 'bad'); return; }
        L = res.b.loadout || L;
        say('saved to ' + res.b.path + (res.b.problems && res.b.problems.length
          ? ' — with ' + res.b.problems.length + ' thing(s) to look at' : ''), 'good');
        if (res.b.problems && res.b.problems.length) {
          var out = el('plProblems');
          el('plProblemBox').hidden = false;
          out.innerHTML = res.b.problems.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('');
        }
        renderAll();
      })
      .catch(function (e) { say('could not save: ' + e.message, 'bad'); });
  }

  // ------------------------------------------------------------------ the fleet, all at once
  //
  // ONE SHARED INVENTORY PLAN, GIVEN TO A GROUP. Gear and the desired carry list can be an
  // answer for several characters; schools, skills, stats and purse rules cannot. The same
  // preview/write path serves the checked subset and the whole live fleet.
  //
  // IT PLANS FIRST AND ALWAYS. The first press asks the server what it would do and shows
  // the answer per character; the second one writes. That is not politeness — this writes a
  // file per character, and the group write nobody read first is the one that turns up later
  // as twenty characters carrying something nobody chose.

  function gearEmpty(g) {
    if (!g) return true;
    if (g.weapon && g.weapon.length) return false;
    var slots = g.slots || {};
    return !Object.keys(slots).some(function (s) { return slots[s] && slots[s].length; });
  }

  function sharedPayload(j) {
    var body = { carry: j.carry || [] };
    // An empty gear section is ordinary silence, but the carry list is the desired inventory
    // itself: an empty one deliberately means no shared carry rules. The preview spells that
    // out before the second press writes anything.
    if (!gearEmpty(j.gear)) body.gear = j.gear;
    return body;
  }

  function sharedToCharacters(scope, apply) {
    if (!SERVED) {
      say('nothing is listening — this one needs the harness serving the page ' +
          '(node tools/m59-compendium.mjs --open --to /planner/)', 'bad');
      return;
    }
    var j = currentLoadout();
    var body = sharedPayload(j);
    if (!body.gear && !body.carry.length) {
      say('there is no gear or carry list on this plan — add something above first', 'bad');
      return;
    }
    body.from = j.character || null;
    body.apply = !!apply;
    if (scope === 'selected') body.targets = checkedChoices().map(function (c) {
      return { character: c.character, agent: c.agent || null };
    });
    say(apply ? 'writing…' : 'asking what that would do…');
    fetch(rel + '/_inventory-to-fleet', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        if (!res.ok) { el('plFleetBox').hidden = true; say(res.b.error || 'refused', 'bad'); return; }
        renderFleetPlan(res.b, scope);
        if (!res.b.applied) {
          say(res.b.counts.changed
            ? 'nothing written yet — ' + res.b.counts.changed + ' of ' + res.b.counts.total
              + ' would change'
            : (scope === 'selected' ? 'the selected characters' : 'every character in the fleet')
              + ' already ask for this gear and carry list', 'good');
          return;
        }
        say(res.b.counts.changed + ' of ' + res.b.counts.total + ' given this gear and carry list'
            + (res.b.counts.failed ? ', ' + res.b.counts.failed + ' refused' : ''),
            res.b.counts.failed ? 'bad' : 'good');
        // The checkbox labels say which characters have a loadout, and some have one now
        // that did not a moment ago. The files are already written either way, so a failure
        // here is a stale label rather than a lost write — said, not swallowed.
        refreshChoices().catch(function (e) {
          say('written, but the character list could not be re-read: ' + e.message, 'bad');
        });
      })
      .catch(function (e) { say('could not reach the fleet: ' + e.message, 'bad'); });
  }

  function renderFleetPlan(b, scope) {
    var box = el('plFleetBox'), out = el('plFleet');
    box.hidden = false;
    el('plFleetTitle').textContent = scope === 'selected'
      ? 'Give the selected characters this gear and carry list'
      : 'Give the whole fleet this gear and carry list';
    var lines = [];
    if (b.gear && b.gear.weapon.length) lines.push('weapon — ' + b.gear.weapon.join(' then '));
    Object.keys((b.gear && b.gear.slots) || {}).forEach(function (s) {
      lines.push(s + ' — ' + b.gear.slots[s].join(' then '));
    });
    if (b.carry) lines.push('carry — ' + (b.carry.length
      ? b.carry.map(function (c) {
        return c.item + ' ' + c.min + (c.max === null ? '+' : '–' + c.max);
      }).join(', ')
      : 'nothing'));
    var mine = norm(el('plName').value || L.character);

    var rows = b.rows.map(function (r) {
      var cls = r.error ? 'bad' : r.changed ? 'changed' : 'same';
      var changed = [];
      if (r.gear_changed) changed.push('gear');
      if (r.carry_changed) changed.push('carry list');
      var what = r.error ? 'refused'
        : !r.changed ? 'already asks for this'
        : r.created ? (b.applied ? 'new loadout written' : 'would get its first loadout')
        : (b.applied ? changed.join(' + ') + ' replaced' : 'would change ' + changed.join(' + '));
      var beforeGear = r.before && r.before.gear;
      var was = r.error ? r.error
        : r.before
          ? 'had ' + (beforeGear && (beforeGear.weapon.length || Object.keys(beforeGear.slots).length)
            ? (beforeGear.weapon[0] || Object.keys(beforeGear.slots).map(function (s) {
                return beforeGear.slots[s][0];
              }).join(', ') || 'no gear')
            : 'no gear') + ', ' + r.before.carry.length + ' carry item(s)'
          : 'no loadout yet';
      return '<tr class="' + cls + '"><td>' + esc(r.character)
        + (norm(r.character) === mine ? ' <em>(this one)</em>' : '')
        + '</td><td>' + esc(what) + '</td><td class="muted">' + esc(was) + '</td></tr>';
    }).join('');

    out.innerHTML =
      '<p class="hint">Only gear and the desired carry list are shared. Schools, skills, sell and '
      + 'keep lists, purse floors, notes and every other field stay exactly as they are.</p>'
      + '<p class="pl-note"><strong>' + lines.map(esc).join('<br>') + '</strong></p>'
      + (b.problems && b.problems.length
        ? '<ul class="pl-problems">' + b.problems.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>'
        : '')
      + '<div class="pl-fleet"><table class="data"><tbody>' + rows + '</tbody></table></div>'
      + '<p>' + (b.applied
        ? '<button type="button" class="btn" id="plFleetClose">Close</button>'
        : '<button type="button" class="btn primary" id="plFleetGo"' + (b.counts.changed ? '' : ' disabled')
          + '>Write it to ' + b.counts.changed + ' character(s)</button> '
          + '<button type="button" class="btn" id="plFleetCancel">Cancel</button>') + '</p>';

    var go = el('plFleetGo');
    if (go) go.onclick = function () { sharedToCharacters(scope, true); };
    var cancel = el('plFleetCancel') || el('plFleetClose');
    if (cancel) cancel.onclick = function () { box.hidden = true; say(''); };
  }

  // ------------------------------------------------------------------ boot

  function fillCharacterChecks(choices) {
    var box = el('plChars');
    var checked = {};
    Array.prototype.forEach.call(box.querySelectorAll('input[type="checkbox"]:checked'),
      function (input) { checked[input.value] = true; });
    box.innerHTML = '';
    CHOICES = {};
    choices.forEach(function (group, gi) {
      if (!group.rows.length) return;
      var wrap = document.createElement('div');
      wrap.className = 'pl-char-group';
      var title = document.createElement('strong');
      title.textContent = group.label;
      var checks = document.createElement('div');
      checks.className = 'pl-char-checks';
      group.rows.forEach(function (r, ri) {
        CHOICES[r.value] = r;
        var label = document.createElement('label');
        label.className = 'pl-char-check';
        var input = document.createElement('input');
        input.type = 'checkbox'; input.value = r.value;
        input.id = 'plChar-' + gi + '-' + ri;
        input.checked = !!checked[r.value];
        input.onchange = characterChecksChanged;
        var text = document.createElement('span');
        text.textContent = r.text; text.title = r.text;
        label.appendChild(input); label.appendChild(text); checks.appendChild(label);
      });
      wrap.appendChild(title); wrap.appendChild(checks); box.appendChild(wrap);
    });
    if (!box.children.length) {
      var empty = document.createElement('p');
      empty.className = 'pl-character-empty';
      empty.textContent = 'No fleet characters are available. Name a new plan or import a file.';
      box.appendChild(empty);
    }
    syncSelectionMode();
  }

  // WHO THERE IS TO PLAN FOR, re-read rather than assumed. Also the page's one test for
  // whether the harness is serving it. Called again after a fleet-wide write, because
  // characters that had no loadout a moment ago have one now and the checkbox label says so.
  function refreshChoices() {
    return fetch(rel + '/_loadouts').then(function (r) {
      if (!r.ok) throw new Error('not the harness');
      return r.json();
    }).then(function (b) {
      var inFleet = {};
      var fleetRows = (b.fleet || []).map(function (r) {
        inFleet[norm(r.character)] = true;
        return {
          value: 'agent:' + r.agent, character: r.character, agent: r.agent, source: 'agent',
          text: r.character + ' (' + r.agent + ')' + (r.loadout ? ' — has a loadout' : ''),
        };
      });
      var savedRows = (b.loadouts || []).filter(function (r) {
        return !inFleet[norm(r.character)];
      }).map(function (r) {
        return {
          value: 'loadout:' + r.character, character: r.character, agent: null, source: 'loadout',
          text: r.character,
        };
      });
      fillCharacterChecks([
        { label: 'In the fleet', rows: fleetRows },
        { label: 'Saved only', rows: savedRows },
      ]);
      return b;
    });
  }

  function loadAgent(agent, key, group) {
    var ticket = ++LOAD_SEQ;
    say('reading ' + agent + '…');
    return fetch(rel + '/_planner?agent=' + encodeURIComponent(agent))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (ticket !== LOAD_SEQ) return;
        if (j.error) { say(j.error, 'bad'); return; }
        ACTIVE_KEY = key || ('agent:' + agent);
        if (group) j.observed = null;
        syncSelectionMode();
        adopt(j);
        say(group ? checkedChoices().length + ' characters selected — editing shared gear and carry'
          : j.loadout
          ? 'loaded ' + j.observed.character + ' and the loadout it already has'
          : 'loaded ' + j.observed.character + ' — no loadout yet, so this is a fresh one', 'good');
      })
      .catch(function (e) { say('could not read ' + agent + ': ' + e.message, 'bad'); });
  }

  function loadSaved(choice, group) {
    var ticket = ++LOAD_SEQ;
    say('reading ' + choice.character + '…');
    return fetch(rel + '/_loadout?character=' + encodeURIComponent(choice.character))
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (res) {
        if (ticket !== LOAD_SEQ) return;
        if (!res.ok) { say(res.b.error || 'could not read that loadout', 'bad'); return; }
        ACTIVE_KEY = choice.value;
        syncSelectionMode();
        adopt({ loadout: res.b.loadout, character: res.b.loadout.character, observed: null });
        say(group ? checkedChoices().length + ' characters selected — editing shared gear and carry'
          : 'loaded the saved loadout for ' + choice.character, 'good');
      })
      .catch(function (e) { say('could not read ' + choice.character + ': ' + e.message, 'bad'); });
  }

  function loadChoice(choice, group) {
    return choice.source === 'agent'
      ? loadAgent(choice.agent, choice.value, group)
      : loadSaved(choice, group);
  }

  function characterChecksChanged() {
    var selected = checkedChoices();
    ++LOAD_SEQ;
    syncSelectionMode();
    el('plFleetBox').hidden = true;
    if (!selected.length) {
      ACTIVE_KEY = null; OBS = null; L = blank(''); el('plName').value = '';
      renderAll(); say('name a new plan, import one, or select a character');
      return;
    }
    if (selected.length === 1) { loadChoice(selected[0], false); return; }

    // Keep unsaved inventory edits when the character they came from remains checked.
    // Otherwise seed the shared editor from the first checked character.
    if (ACTIVE_KEY && selected.some(function (c) { return c.value === ACTIVE_KEY; }) && L.character) {
      OBS = null;
      renderAll();
      say(selected.length + ' characters selected — editing shared gear and carry', 'good');
      return;
    }
    loadChoice(selected[0], true);
  }

  fetch(rel + '/data/planner.json').then(function (r) { return r.json(); }).then(function (j) {
    D = j;
    D.items.forEach(function (i) { BY_ITEM[norm(i.name)] = i; BY_CLASS[norm(i.cls)] = i; });
    D.spells.forEach(function (s) { BY_SPELL[norm(s.name)] = s; });
    D.skills.forEach(function (s) { BY_SKILL[norm(s.name)] = s; });

    L = blank('');
    renderAll();

    ['inventory', 'spells', 'skills', 'stats'].forEach(function (t) {
      el('tab-' + t).onclick = function () { selectTab(t); };
    });
    el('plExport').onclick = exportFile;
    el('plSave').onclick = save;
    el('plGearFleet').onclick = function () { sharedToCharacters('fleet', false); };
    el('plImport').onclick = function () { el('plFile').click(); };
    el('plFile').onchange = function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        try { adoptFile(JSON.parse(fr.result)); }
        catch (err) { say('that file is not JSON: ' + err.message, 'bad'); }
      };
      fr.readAsText(f);
      e.target.value = '';
    };
    el('plName').oninput = function () { L.character = el('plName').value; renderProblems(); };

    // Is the harness serving us? /_loadouts is its endpoint and nothing else answers it, so
    // a 404 here is the honest signal that Save cannot work — which the page then says
    // rather than offering a button that silently does nothing.
    refreshChoices().then(function () {
      SERVED = true;
      var agent = cookieAgent();
      if (agent) {
        var opt = 'agent:' + agent;
        var input = Array.prototype.find.call(el('plChars').querySelectorAll('input[type="checkbox"]'),
          function (c) { return c.value === opt; });
        if (input) {
          input.checked = true;
          syncSelectionMode();
          return loadChoice(CHOICES[opt], false);
        }
      }
      say('pick a character, or press C on one in the fleet terminal to arrive with it loaded');
    }).catch(function () {
      SERVED = false;
      fillCharacterChecks([]);
      say('opened as a static page — plan freely and Export; Save needs the harness serving this ' +
          '(node tools/m59-compendium.mjs --open --to /planner/)');
    });
  }).catch(function (e) {
    say('could not load data/planner.json (' + e.message + ') — run node tools/m59-planner-data.mjs', 'bad');
  });
}());
