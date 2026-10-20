// party.js — the fleet as a party. Source, not generated: derive/party.mjs writes only the
// page around it.
//
// THREE VIEWS OF ONE STATE. The roster (every character, a card each), the sheet (one
// character, everything about its schools), and the comparison strip (the characters whose
// build looks like this one's). All three draw from CHARS, and every edit goes to a
// character's DRAFT plan; nothing is written until Review & save, which reads each file
// back from the server first and replaces only its `plan`.
//
// Every learning number comes from window.M59Learn (assets/learn.js, inlined from
// tools/learn.mjs). This file decides what to ASK it, never how to compute an answer.
/* global window, document, fetch */
(function () {
  'use strict';

  var LEARN = window.M59Learn || null;
  var rel = window.M59_REL || '..';
  var D = null;            // data/planner.json
  var ICON = {};           // norm(name) -> {i, u} from search.json
  var CHARS = [];          // one record per character, see blankChar
  var OPEN = null;         // the character whose sheet is open
  var FOCUS_TRACK = null;  // the track whose detail is open on the sheet
  var SORT = 'build';
  var SERVED = false;      // the harness is serving this page (writes are possible)
  try { SORT = window.localStorage.getItem('m59-party-sort') || 'build'; } catch (e) { /* no storage */ }

  var el = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var norm = function (s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };

  // ------------------------------------------------------------------ the seven tracks
  //
  // Weaponcraft first because it is the one every character holds. The colours follow the
  // in-game school banners closely enough to be recognisable, and are only ever paired with
  // the school's name — never colour alone.
  var TRACKS = [
    { key: 'weaponcraft', label: 'Weaponcraft', abbr: 'W', hue: '#b4702a', stat: null },
    { key: 'Kraanan',   label: 'Kraanan',   abbr: 'K', hue: '#3f63c4', stat: 'stamina' },
    { key: 'Faren',     label: 'Faren',     abbr: 'F', hue: '#c23b2e', stat: 'mysticism' },
    { key: 'Shal’ille', label: 'Shal’ille', abbr: 'S', hue: '#c9b458', stat: 'mysticism' },
    { key: 'Qor',       label: 'Qor',       abbr: 'Q', hue: '#7a4fa3', stat: 'mysticism' },
    { key: 'Riija',     label: 'Riija',     abbr: 'R', hue: '#c04a93', stat: 'intellect' },
    { key: 'Jala',      label: 'Jala',      abbr: 'J', hue: '#3e9a57', stat: 'intellect' },
  ];
  var DISCIPLE = { 'kraanan': 1, 'faren': 1, 'shal ille': 1, 'qor': 1 };
  var STATS = ['might', 'intellect', 'stamina', 'agility', 'mysticism', 'aim'];
  var STAT_ABBR = { might: 'MIG', intellect: 'INT', stamina: 'STA', agility: 'AGI', mysticism: 'MYS', aim: 'AIM' };
  var trackOf = function (key) {
    for (var i = 0; i < TRACKS.length; i++) if (norm(TRACKS[i].key) === norm(key)) return TRACKS[i];
    return null;
  };
  var isWeapon = function (t) { return t.key === 'weaponcraft'; };
  var MAX_LEVEL = 6;

  // ------------------------------------------------------------------ catalogue

  var CATALOGUE = [];        // learn.mjs's shape: {name, kind, school, level, ...}
  var BY_SKILL = {};
  function buildCatalogue() {
    CATALOGUE = [];
    D.spells.forEach(function (s) { CATALOGUE.push(Object.assign({ kind: 'spell' }, s)); });
    D.skills.forEach(function (s) {
      BY_SKILL[norm(s.name)] = s;
      CATALOGUE.push(Object.assign({ kind: 'skill' }, s));
    });
    // Track names in the data use the typographic apostrophe; keep TRACKS in step with it.
    TRACKS.forEach(function (t) {
      if (isWeapon(t)) return;
      var hit = D.schools.filter(function (s) { return norm(s) === norm(t.key); })[0];
      if (hit) { t.key = hit; t.label = hit; }
    });
  }

  // The abilities a track offers at a level, as the learning errand will buy them: the
  // purchasable ones (learning_queue rows buy "every ability at that level").
  function abilitiesAt(track, level) {
    return CATALOGUE.filter(function (r) {
      if (Number(r.level) !== level) return false;
      if (isWeapon(track)) return r.kind === 'skill' && r.learnable !== false && r.for_sale !== false && !r.abstract;
      return r.kind === 'spell' && norm(r.school) === norm(track.key);
    }).sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  }

  // ------------------------------------------------------------------ one character

  function blankPlan() {
    return { schools: {}, weapon_level: null, learning_target: null, learning_queue: [], abilities: [] };
  }
  function blankChar(agent, character) {
    return { agent: agent, character: character, obs: null, loadout: null, orig: blankPlan(),
             draft: blankPlan(), state: 'loading', err: null, selected: false, m: null };
  }
  function planOf(loadout) {
    var p = (loadout && loadout.plan) ? clone(loadout.plan) : blankPlan();
    var b = blankPlan();
    Object.keys(b).forEach(function (k) { if (p[k] === undefined) p[k] = b[k]; });
    return p;
  }
  function samePlan(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function dirty(c) { return !samePlan(c.orig, c.draft); }

  function knownRows(c) {
    if (!c.obs) return [];
    var out = [];
    (c.obs.spells || []).forEach(function (s) {
      out.push({ name: s.name, kind: 'spell', school: s.school, level: s.level, ability: s.ability });
    });
    (c.obs.skills || []).forEach(function (s) { out.push({ name: s.name, kind: 'skill', ability: s.ability }); });
    return out;
  }
  function knownAbility(c, name) {
    if (!c.obs) return null;
    var n = norm(name), hit = null;
    (c.obs.spells || []).concat(c.obs.skills || []).forEach(function (r) { if (norm(r.name) === n) hit = r; });
    return hit ? hit.ability : null;
  }
  function intellectOf(c) { return (c.obs && c.obs.attributes && c.obs.attributes.intellect) || 0; }

  // THE BUDGET: the largest point total PlayerCanLearn can ever say yes to. The requirement
  // is points*slope + (297 - max*slope) - floor(int*2*slope/5), and the most anyone can
  // bring is 3 x 99 = 297, so points <= (max*slope + floor(int*2*slope/5)) / slope. The
  // scarcity relief does not move this: it divides the requirement by exactly the factor by
  // which fewer abilities shrink the 297 (player.kod:10915-10945).
  function budgetFor(intellect) {
    var L = D.learning;
    if (L.points_slope == null || L.max_learn_points == null) return null;
    var fromInt = Math.trunc(intellect * 2 * L.points_slope / 5);
    return Math.floor((L.max_learn_points * L.points_slope + fromInt) / L.points_slope);
  }
  var levelPoints = function (l) { return LEARN ? LEARN.levelPointsAt(D.learning.level_points, l) : 0; };
  var cumulative = function (l) { return levelPoints(l); };

  // Everything about one character that every view needs, computed once per change.
  function model(c) {
    var m = { observed: {}, actual: {}, target: {}, next: {}, ready: [] };
    var known = knownRows(c);
    var rr = (LEARN && c.obs) ? LEARN.RemainingRequiredToLearnNewSkills({
      known: known, catalogue: CATALOGUE, intellect: intellectOf(c), constants: D.learning,
    }) : null;
    m.rr = rr;
    TRACKS.forEach(function (t) {
      var actual = 0, shown = 0;
      if (rr) {
        if (isWeapon(t)) {
          actual = rr.track_levels.weapon || 0;
          // The granted level-50 sentinels (thrust, kick, assess) are not a Weaponcraft level
          // anyone planned; show the highest SOLD level and keep `actual` for the points.
          (c.obs.skills || []).forEach(function (s) {
            var row = BY_SKILL[norm(s.name)];
            if (row && row.level <= MAX_LEVEL && row.for_sale !== false) shown = Math.max(shown, row.level);
          });
        } else {
          Object.keys(rr.track_levels).forEach(function (k) {
            if (norm(k) === norm(t.key)) actual = rr.track_levels[k];
          });
          shown = actual;
        }
      }
      var planned = isWeapon(t) ? Number(c.draft.weapon_level) || 0 : Number(c.draft.schools[t.key]) || 0;
      m.observed[t.key] = shown;
      m.actual[t.key] = actual;
      m.target[t.key] = Math.max(shown, planned);
      m.next[t.key] = readiness(c, t, shown, rr);
    });
    m.intellect = intellectOf(c);
    m.budget = budgetFor(m.intellect);
    m.pointsNow = pointsWith(m, {});
    m.pointsPlan = pointsWith(m, m.target);
    m.archetype = archetype(m);
    m.queue = queueSteps(c, m);
    TRACKS.forEach(function (t) {
      var n = m.next[t.key];
      if (n && n.state === 'ready' && m.target[t.key] > m.observed[t.key]) m.ready.push(t.label + ' ' + n.level);
    });
    return m;
  }

  // Points for a set of track levels. A track not named uses what is known. The weapon
  // track is a MAX over every skill held, so a granted sentinel (level 50, worth nothing:
  // learn.mjs levelPointsAt) keeps hiding any level planned under it — as on the server.
  function pointsWith(m, levels) {
    var total = 0;
    TRACKS.forEach(function (t) {
      var want = levels[t.key] != null ? levels[t.key] : m.observed[t.key];
      var lvl = Math.max(m.actual[t.key], want);
      total += levelPoints(lvl);
    });
    return total;
  }

  // What stands between this character and the NEXT level of a track, right now — straight
  // from RemainingRequiredToLearnNewSkills, reduced to the best candidate at that level.
  function readiness(c, t, shown, rr) {
    var level = shown + 1;
    if (level > MAX_LEVEL) return { state: 'max', level: MAX_LEVEL };
    if (!rr) return { state: 'unknown', level: level };
    var rows = rr.candidates.filter(function (r) {
      if (Number(r.level) !== level) return false;
      return isWeapon(t) ? r.kind === 'skill' : (r.kind === 'spell' && norm(r.school) === norm(t.key));
    });
    if (!rows.length) return { state: 'none', level: level };
    rows.sort(function (a, b) {
      return (b.can_learn === true ? 1 : 0) - (a.can_learn === true ? 1 : 0)
        || (a.remaining_required == null ? 1e9 : a.remaining_required) - (b.remaining_required == null ? 1e9 : b.remaining_required);
    });
    var best = rows[0];
    var base = {
      level: level, need: best.need, have: best.have, example: best.name,
      best3: best.previous_level_best_three || [], prevInGame: best.previous_level_abilities_in_game,
      shortcut: best.shortcut || null,
    };
    if (best.can_learn === true) return Object.assign(base, { state: 'ready' });
    if (best.impossible) return Object.assign(base, { state: 'impossible' });
    if (best.blocked_by && best.blocked_by.some(function (b) { return /knows nothing/.test(b); }))
      return Object.assign(base, { state: 'nobase' });
    return Object.assign(base, { state: 'short', short: best.remaining_required });
  }

  // THE BUILD, IN TWO WORDS. Highest planned school wins (Weaponcraft only when no school
  // reaches 2); "fighter" when Weaponcraft is 3+, since that is the line a proficiency
  // above mace crosses. Used for grouping, so it only has to put alike things together.
  function archetype(m) {
    var schools = TRACKS.filter(function (t) { return !isWeapon(t); })
      .map(function (t) { return { t: t, l: m.target[t.key] }; })
      .filter(function (x) { return x.l > 0; })
      .sort(function (a, b) { return b.l - a.l || a.t.label.localeCompare(b.t.label); });
    var w = m.target.weaponcraft || 0;
    var top = schools[0];
    var label, hue;
    if (top && top.l >= 2) {
      label = top.t.label + (w >= 3 ? ' knight' : ' caster');
      hue = top.t.hue;
    } else if (w >= 3) { label = 'Fighter'; hue = TRACKS[0].hue; }
    else { label = 'Novice'; hue = '#8b8175'; }
    var also = schools.slice(top && top.l >= 2 ? 1 : 0).filter(function (x) { return x.l >= 1; })
      .map(function (x) { return x.t.label + ' ' + x.l; });
    return { label: label, hue: hue, also: also, key: label };
  }

  // ------------------------------------------------------------------ the queue
  //
  // learning_queue is ordered and the keeper buys from its first unfinished row only, so
  // order is the whole meaning. Rows are {track, level} — every ability at that level — or
  // {name, kind} for one ability. A school's rows are kept where they already were when its
  // target changes, and appended when it is new, so re-planning one school does not shuffle
  // another's priority.
  function setTarget(c, t, level) {
    var p = c.draft;
    var obs = c.m ? c.m.observed[t.key] : 0;
    var cur = isWeapon(t) ? Number(p.weapon_level) || 0 : Number(p.schools[t.key]) || 0;
    var clear = level === cur || level <= obs;
    if (isWeapon(t)) p.weapon_level = clear ? null : level;
    else if (clear) delete p.schools[t.key];
    else p.schools[t.key] = level;

    var q = Array.isArray(p.learning_queue) ? p.learning_queue : [];
    var mine = function (e) { return e && e.track && norm(e.track) === norm(t.key); };
    var at = -1;
    for (var i = 0; i < q.length; i++) if (mine(q[i])) { at = i; break; }
    var rest = q.filter(function (e) { return !mine(e); });
    if (!clear) {
      var rows = [];
      for (var lv = 1; lv <= level; lv++) rows.push({ track: t.key, level: lv });
      if (at < 0) at = rest.length;
      else at = Math.min(at, rest.length);
      rest.splice.apply(rest, [at, 0].concat(rows));
      p.learning_target = p.learning_target || t.key;
    }
    p.learning_queue = rest;
  }

  // Each queue row, as a step with a projected cost: the requirement as it will be WHEN the
  // keeper reaches that row, with every earlier row assumed done. That is the number that
  // says whether a plan is a weekend or a month.
  function queueSteps(c, m) {
    var q = c.draft.learning_queue || [];
    var levels = {};
    TRACKS.forEach(function (t) { levels[t.key] = m.actual[t.key]; });
    var steps = [];
    q.forEach(function (e, i) {
      if (e && e.name) {
        var have = knownAbility(c, e.name);
        steps.push({ i: i, kind: 'ability', name: e.name, done: have != null, have: have });
        return;
      }
      var t = trackOf(e && e.track);
      if (!t) { steps.push({ i: i, kind: 'unknown', name: String(e && e.track) }); return; }
      var level = Number(e.level) || 0;
      var all = abilitiesAt(t, level);
      var knownAt = all.filter(function (r) { return knownAbility(c, r.name) != null; });
      var step = { i: i, kind: 'track', t: t, level: level, total: all.length, known: knownAt.length,
                   done: all.length > 0 && knownAt.length === all.length };
      var prior = clone(levels);
      // Free passes first, as PlayerCanLearn checks them first.
      var heldAbove = m.observed[t.key] > level;
      if (heldAbove || (knownAt.length && (level > 2 || knownAt.length >= 2))) {
        step.free = true;
      } else if (LEARN) {
        var trackLevels = {};
        TRACKS.forEach(function (x) { trackLevels[isWeapon(x) ? 'weapon' : x.key] = prior[x.key]; });
        var prevCount = level > 1 ? abilitiesAtAll(t, level - 1) : 0;
        var cost = LEARN.learnCost({
          trackLevels: trackLevels, school: t.key, level: level, intellect: m.intellect,
          knowOneAtLevel: knownAt.length > 0, prevLevelCount: prevCount, constants: D.learning,
        });
        // Level 1 is measured against a flat 297 (player.kod:10783): free unless the
        // points already spent have pushed even that out of reach.
        step.slots = level === 1 ? 3 : Math.max(1, Math.min(3, prevCount));
        step.impossible = cost.need != null && cost.need > 99 * step.slots;
        if (level === 1 && !step.impossible) step.free = true;
        else { step.need = cost.need; step.have = level === 1 ? 297 : bestThree(c, t, level - 1); }
      }
      levels[t.key] = Math.max(levels[t.key], level);
      step.pointsAfter = pointsWith(m, levels);
      steps.push(step);
    });
    return steps;
  }
  // iHave as it stands today: the best three abilities held at that level of the track.
  function bestThree(c, t, level) {
    if (!c.obs) return 0;
    var vals = [];
    (isWeapon(t) ? c.obs.skills || [] : c.obs.spells || []).forEach(function (r) {
      var row = isWeapon(t) ? BY_SKILL[norm(r.name)] : null;
      var lv = isWeapon(t) ? row && Number(row.school) === 10 && row.level : (norm(r.school) === norm(t.key) && r.level);
      if (Number(lv) === level) vals.push(Number(r.ability) || 0);
    });
    vals.sort(function (a, b) { return b - a; });
    return vals.slice(0, 3).reduce(function (s, v) { return s + v; }, 0);
  }

  // GetNumAtLevel: everything that EXISTS at a level of that school, learnable or not.
  function abilitiesAtAll(t, level) {
    return CATALOGUE.filter(function (r) {
      if (Number(r.level) !== level || r.abstract) return false;
      if (isWeapon(t)) return r.kind === 'skill' && Number(r.school) === 10;
      return r.kind === 'spell' && norm(r.school) === norm(t.key);
    }).length;
  }

  // ------------------------------------------------------------------ faction crests
  //
  // THE CREST IS FACTION SOLDIER STATUS. The letter is the faction — Duke, Princess, Rebel,
  // Unfactioned — and the SHIELD around it is drawn only for a soldier: a character carrying its
  // faction's army shield (m59-factions.mjs soldierFromInventory). A member who is not a soldier is
  // the bare letter. Both arrive on the broker's fleet row (`faction`, `faction_soldier`), null
  // when the profile has never been read, which is drawn as "?" rather than as unfactioned.
  var FACTIONS = {
    duke:     { letter: 'D', name: 'Duke',        hue: '#b2402f' },
    princess: { letter: 'P', name: 'Princess',    hue: '#6a4bb4' },
    rebel:    { letter: 'R', name: 'Rebel',       hue: '#3f8a45' },
    neutral:  { letter: 'U', name: 'Unfactioned', hue: '#7d7666' },
  };
  var SHIELD = 'M4 6 H60 V34 C60 52 46 63 32 69 C18 63 4 52 4 34 Z';
  function factionOf(c) {
    var f = FACTIONS[String(c.faction || '').toLowerCase()];
    return f || { letter: '?', name: 'faction not read yet', hue: '#8b8175', unknown: true };
  }
  function factionTitle(c) {
    var f = factionOf(c);
    if (f.unknown) return 'Faction not read yet';
    if (f.letter === 'U') return 'Unfactioned';
    return f.name + (c.soldier ? ' — soldier (carries the army shield)' : ' — member, not a soldier');
  }
  function crest(c, size) {
    var f = factionOf(c);
    var soldier = !!c.soldier && !f.unknown && f.letter !== 'U';
    var id = 'g' + norm(c.character || c.agent).replace(/ /g, '') + size;
    var h = Math.round(size * 1.125);
    var letter = '<text x="32" y="' + (soldier ? 46 : 50) + '" text-anchor="middle" font-family="Georgia,serif" font-size="' + (soldier ? 32 : 40)
      + '" font-weight="700" fill="' + (soldier ? '#fff8e6' : f.hue) + '"'
      + (soldier ? ' stroke="#2a1c0c" stroke-width="1" paint-order="stroke"' : '') + '>' + f.letter + '</text>';
    var body = soldier
      ? '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + f.hue + '"/>'
        + '<stop offset="1" stop-color="' + shade(f.hue, -0.4) + '"/></linearGradient></defs>'
        + '<path d="' + SHIELD + '" fill="url(#' + id + ')"/>'
        + '<path d="' + SHIELD + '" fill="none" stroke="#d9b45a" stroke-width="2.5"/>'
      : '';
    return '<svg class="pt-crest' + (soldier ? ' soldier' : ' bare') + '" viewBox="0 0 64 72" width="' + size + '" height="' + h + '" role="img" aria-label="' + esc(factionTitle(c)) + '">'
      + '<title>' + esc(factionTitle(c)) + '</title>' + body + letter + '</svg>';
  }
  function shade(hex, f) {
    var n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    var k = function (v) { return Math.max(0, Math.min(255, Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f))); };
    return '#' + ((1 << 24) + (k(r) << 16) + (k(g) << 8) + k(b)).toString(16).slice(1);
  }

  // ------------------------------------------------------------------ roster

  function sorted() {
    var list = CHARS.slice();
    var by = {
      name: function (a, b) { return String(a.character).localeCompare(String(b.character)); },
      level: function (a, b) { return ((b.obs && b.obs.level) || 0) - ((a.obs && a.obs.level) || 0); },
      intellect: function (a, b) { return ((b.m && b.m.intellect) || 0) - ((a.m && a.m.intellect) || 0); },
      budget: function (a, b) { return left(b) - left(a); },
    };
    if (SORT === 'build') {
      return list.sort(function (a, b) {
        var ka = groupOf(a), kb = groupOf(b);
        return (ka.rank - kb.rank) || ka.label.localeCompare(kb.label) || by.level(a, b) || by.name(a, b);
      });
    }
    return list.sort(function (a, b) { return (by[SORT] || by.name)(a, b) || by.name(a, b); });
  }
  // One answer to "which heading is this card under", for the sort and the headings alike.
  function groupOf(c) {
    if (c.m && c.obs) return { label: c.m.archetype.label, rank: 0 };
    if (c.state === 'loading' || c.state === 'saved-loading') return { label: 'Reading the fleet…', rank: 1 };
    return { label: c.agent ? 'Not answering' : 'Not in the fleet — plan only', rank: 2 };
  }
  function left(c) { return c.m && c.m.budget != null ? c.m.budget - c.m.pointsPlan : -99; }

  function renderRoster() {
    var box = el('ptRoster');
    var list = sorted();
    var html = '', group = null;
    list.forEach(function (c) {
      if (SORT === 'build') {
        var g = groupOf(c).label;
        if (g !== group) {
          var count = list.filter(function (x) { return groupOf(x).label === g; }).length;
          html += (group === null ? '' : '</div>') + '<div class="pt-group"><h2 class="pt-group-h">'
            + esc(g) + ' <span>' + count + '</span></h2><div class="pt-cards">';
          group = g;
        }
      } else if (group === null) { html += '<div class="pt-group"><div class="pt-cards">'; group = ''; }
      html += card(c);
    });
    if (group !== null) html += '</div></div>';
    box.innerHTML = html || '<p class="pt-empty">No characters yet.</p>';
    Array.prototype.forEach.call(box.querySelectorAll('[data-open]'), function (b) {
      b.onclick = function (e) {
        if (e.target.closest('.pt-pick')) return;
        openSheet(b.getAttribute('data-open'));
      };
      b.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSheet(b.getAttribute('data-open')); } };
    });
    Array.prototype.forEach.call(box.querySelectorAll('.pt-pick input'), function (i) {
      i.onchange = function () { var c = find(i.getAttribute('data-pick')); if (c) c.selected = i.checked; renderSheet(); renderDock(); };
    });
  }

  function card(c) {
    var m = c.m, key = esc(c.character || c.agent);
    var cls = 'pt-card' + (OPEN === c ? ' open' : '') + (c.state !== 'ok' ? ' dim' : '') + (dirty(c) ? ' dirty' : '');
    var ladder = '';
    TRACKS.forEach(function (t) {
      var o = m ? m.observed[t.key] : 0, tg = m ? m.target[t.key] : 0;
      ladder += '<span class="pt-rung" title="' + esc(t.label) + ': knows ' + o + (tg > o ? ', heading for ' + tg : '') + '" style="--hue:' + t.hue + '">'
        + '<i style="height:' + (o / MAX_LEVEL * 100) + '%"></i>'
        + (tg > o ? '<b style="height:' + ((tg - o) / MAX_LEVEL * 100) + '%;bottom:' + (o / MAX_LEVEL * 100) + '%"></b>' : '')
        + '<em>' + t.abbr + '</em></span>';
    });
    var budget = '';
    if (m && m.budget != null) {
      var over = m.pointsPlan > m.budget;
      budget = '<div class="pt-mini-budget' + (over ? ' over' : '') + '" title="learn points: ' + m.pointsNow + ' held, '
        + m.pointsPlan + ' when the plan is done, of ' + m.budget + ' that intellect ' + m.intellect + ' allows">'
        + '<span style="width:' + pct(m.pointsNow, m.budget) + '%"></span>'
        + '<span class="plan" style="width:' + pct(Math.max(0, Math.min(m.pointsPlan, m.budget) - m.pointsNow), m.budget) + '%"></span>'
        + '</div><div class="pt-mini-num">' + m.pointsPlan + ' / ' + m.budget + ' pts' + (over ? ' — over' : '') + '</div>';
    }
    var badges = '';
    if (c.state === 'loading' || c.state === 'saved-loading') badges += '<span class="pt-badge wait">reading…</span>';
    if (c.stale) badges += '<span class="pt-badge wait" title="drawn from the last reading; a fresh one is on its way">' + ago(c.stale) + ' old</span>';
    if (c.state === 'error') badges += '<span class="pt-badge bad" title="' + esc(c.err) + '">not answering</span>';
    if (c.state === 'saved') badges += '<span class="pt-badge">plan only</span>';
    if (m && m.ready.length) badges += '<span class="pt-badge good" title="the plan asks for it and the character can learn it now">ready: ' + esc(m.ready[0]) + '</span>';
    if (dirty(c)) badges += '<span class="pt-badge edit">unsaved</span>';
    var hp = c.obs && c.obs.level ? '<span class="pt-hp" title="maximum hit points — a character\'s level">' + c.obs.level + '</span>' : '';
    return '<div class="' + cls + '" data-open="' + key + '" role="button" tabindex="0" aria-label="Open ' + key + '">'
      + '<label class="pt-pick" title="Select for copying a plan"><input type="checkbox" data-pick="' + key + '"' + (c.selected ? ' checked' : '') + '><span></span></label>'
      + '<div class="pt-face">' + crest(c, 52) + hp + '</div>'
      + '<div class="pt-id"><div class="pt-name">' + esc(c.character || c.agent) + '</div>'
      + '<div class="pt-sub">' + esc(c.agent || 'no agent') + (m && m.archetype.also.length ? ' · ' + esc(m.archetype.also.slice(0, 2).join(', ')) : '') + '</div></div>'
      + '<div class="pt-ladder">' + ladder + '</div>'
      + budget
      + '<div class="pt-badges">' + badges + '</div>'
      + '</div>';
  }
  var pct = function (a, b) { return b > 0 ? Math.max(0, Math.min(100, a / b * 100)) : 0; };
  function find(key) {
    for (var i = 0; i < CHARS.length; i++) if (norm(CHARS[i].character || CHARS[i].agent) === norm(key)) return CHARS[i];
    return null;
  }

  // ------------------------------------------------------------------ the sheet

  function openSheet(key) {
    var c = find(key);
    if (!c) return;
    OPEN = (OPEN === c) ? null : c;
    FOCUS_TRACK = null;
    renderRoster();
    renderSheet();
    if (OPEN) el('ptSheet').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderSheet() {
    var box = el('ptSheet'), c = OPEN;
    if (!c) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    var m = c.m;
    var head = '<div class="pt-sheet-head">' + crest(c, 88)
      + '<div class="pt-sheet-id"><h2>' + esc(c.character || c.agent) + '</h2>'
      + '<div class="pt-sheet-sub">' + esc(c.agent || '') + (c.obs && c.obs.level ? ' · ' + c.obs.level + ' hit points' : '')
      + ' · ' + esc(factionTitle(c))
      + (m ? ' · <span class="pt-arch" style="--hue:' + m.archetype.hue + '">' + esc(m.archetype.label) + '</span>' : '') + '</div>'
      + (c.state === 'error' ? '<p class="pt-warn">The broker did not answer for this character: ' + esc(c.err) + '. Its saved plan is shown; what it knows is not.</p>' : '')
      + (c.obs && c.obs.abilities_age_ms > 300000 ? '<p class="pt-warn">Its ability list was last read ' + Math.round(c.obs.abilities_age_ms / 60000) + ' minutes ago.</p>' : '')
      + '</div><button type="button" class="pt-close" id="ptClose" aria-label="Close">×</button></div>';
    if (!m) { box.innerHTML = head + '<p>Still reading this character…</p>'; bindClose(); return; }

    var body = '<div class="pt-sheet-grid">'
      + '<div class="pt-col-a">' + statsBlock(c) + budgetBlock(c) + '</div>'
      + '<div class="pt-col-b">' + boardBlock(c) + (FOCUS_TRACK ? trackDetail(c, FOCUS_TRACK) : '') + '</div>'
      + '<div class="pt-col-c">' + ordersBlock(c) + copyBlock(c) + '</div>'
      + '</div>' + compareBlock(c);
    box.innerHTML = head + body;
    bindClose();
    bindSheet(c);
  }
  function bindClose() { var b = el('ptClose'); if (b) b.onclick = function () { OPEN = null; renderRoster(); renderSheet(); }; }

  function statsBlock(c) {
    var a = (c.obs && c.obs.attributes) || {};
    var rows = STATS.map(function (k) {
      var v = a[k] || 0;
      var feeds = TRACKS.filter(function (t) { return t.stat === k; }).map(function (t) { return t.label; });
      var title = k + ' ' + v + (feeds.length ? ' — the requisite stat of ' + feeds.join(', ') + '; spells there soft-cap at ' + (2 * v - 1) + '%' : '')
        + (k === 'intellect' ? ' — sets the learn-point budget' : '') + (k === 'stamina' ? ' — maximum health is 101 + stamina' : '');
      return '<div class="pt-stat" title="' + esc(title) + '"><span class="k">' + STAT_ABBR[k] + '</span>'
        + '<span class="bar"><i style="width:' + pct(v, 50) + '%"></i></span><span class="v">' + v + '</span></div>';
    }).join('');
    return '<section class="pt-block"><h3>Attributes</h3>' + rows
      + '<p class="pt-fine">Fixed at creation. Hover a bar for what it drives.</p></section>';
  }

  function budgetBlock(c) {
    var m = c.m;
    if (m.budget == null) return '';
    var over = m.pointsPlan > m.budget;
    var segs = '';
    TRACKS.forEach(function (t) {
      var now = levelPoints(Math.max(m.actual[t.key], m.observed[t.key]));
      var plan = levelPoints(Math.max(m.actual[t.key], m.target[t.key])) - now;
      if (now > 0) segs += '<i style="flex:' + now + ';--hue:' + t.hue + '" title="' + esc(t.label) + ': ' + now + ' held"></i>';
      if (plan > 0) segs += '<i class="plan" style="flex:' + plan + ';--hue:' + t.hue + '" title="' + esc(t.label) + ': +' + plan + ' planned"></i>';
    });
    var free = Math.max(0, m.budget - m.pointsPlan);
    if (free) segs += '<i class="free" style="flex:' + free + '" title="' + free + ' unspent"></i>';
    // The requirement for the LAST point the plan buys, which is what makes the end of a
    // plan expensive: at the full budget it is three abilities at 99.
    var last = m.queue.filter(function (s) { return s.need != null; }).pop();
    return '<section class="pt-block"><h3>Learn points</h3>'
      + '<div class="pt-budget' + (over ? ' over' : '') + '">' + segs + '</div>'
      + '<div class="pt-budget-num"><b>' + m.pointsPlan + '</b> / ' + m.budget
      + (over ? ' <span class="bad">— ' + (m.pointsPlan - m.budget) + ' over: the last levels can never be learned</span>'
              : ' <span>· ' + free + ' left</span>') + '</div>'
      + '<p class="pt-fine">' + m.pointsNow + ' held now. Intellect ' + m.intellect + ' allows ' + m.budget
      + '; each 5 more intellect is +2.'
      + (last ? ' The hardest purchase in this plan needs the best three at the level below to total <b>' + last.need + '</b> (≈' + Math.ceil(last.need / last.slots) + '% each).' : '')
      + '</p></section>';
  }

  // THE SCHOOL BOARD. One row per track, six pips each. A pip is known (solid), planned
  // (lit), or reachable-but-unplanned (dim); a pip whose level would push the plan past the
  // budget is marked, because a plan that cannot finish is the thing to catch here.
  function boardBlock(c) {
    var m = c.m;
    var rows = TRACKS.map(function (t) {
      var o = m.observed[t.key], tg = m.target[t.key];
      var pips = '';
      for (var lv = 1; lv <= MAX_LEVEL; lv++) {
        var overAt = m.budget != null && lv > o && pointsWith(m, (function () { var x = clone(m.target); x[t.key] = lv; return x; })()) > m.budget;
        var st = lv <= o ? 'have' : lv <= tg ? 'plan' : 'open';
        var tip = t.label + ' ' + lv + ' — ' + (st === 'have' ? 'known' : st === 'plan' ? 'planned' : 'click to plan up to here')
          + ' · track worth ' + cumulative(lv) + ' points at this level'
          + (overAt ? ' · past the budget' : '')
          + (lv === 3 && DISCIPLE[norm(t.key)] ? ' · needs the disciple quest' : '');
        pips += '<button type="button" class="pt-pip ' + st + (overAt ? ' over' : '') + '" data-track="' + esc(t.key) + '" data-level="' + lv + '" title="' + esc(tip) + '">'
          + '<span>' + lv + '</span>' + (lv === 3 && DISCIPLE[norm(t.key)] && lv > o ? '<em aria-hidden="true">✦</em>' : '') + '</button>';
      }
      var n = m.next[t.key], chip = '';
      if (n.state === 'ready') chip = '<span class="pt-chip good" title="' + esc((n.shortcut || 'best three at level ' + (n.level - 1) + ' total ' + n.have + ', needs ' + n.need)) + '">Lv ' + n.level + ' ready</span>';
      else if (n.state === 'short') chip = '<span class="pt-chip" title="best three at level ' + (n.level - 1) + ' total ' + n.have + '; level ' + n.level + ' needs ' + n.need + '">Lv ' + n.level + ': +' + n.short + '%</span>';
      else if (n.state === 'impossible') chip = '<span class="pt-chip bad" title="needs ' + n.need + ', more than the level below can ever provide — points are spent elsewhere">Lv ' + n.level + ' out of reach</span>';
      else if (n.state === 'nobase') chip = '<span class="pt-chip faint" title="knows nothing at level ' + (n.level - 1) + ' here">needs ' + (n.level - 1) + ' first</span>';
      else if (n.state === 'max') chip = '<span class="pt-chip faint">mastered</span>';
      var stat = t.stat && c.obs ? c.obs.attributes[t.stat] : null;
      return '<div class="pt-row' + (FOCUS_TRACK === t.key ? ' focus' : '') + '" style="--hue:' + t.hue + '">'
        + '<button type="button" class="pt-track" data-focus="' + esc(t.key) + '" title="Show ' + esc(t.label) + '’s abilities">'
        + '<span class="sw"></span><span class="nm">' + esc(t.label) + '</span>'
        + (stat != null ? '<span class="req">' + STAT_ABBR[t.stat] + ' ' + stat + '</span>' : '') + '</button>'
        + '<span class="pt-pips">' + pips + '</span>' + chip + '</div>';
    }).join('');
    var both = m.target['Shal’ille'] > 0 && m.target.Qor > 0;
    return '<section class="pt-block"><h3>Schools <span class="pt-h-note">click a pip to set where this character is heading · click it again to clear</span></h3>'
      + '<div class="pt-board">' + rows + '</div>'
      + '<div class="pt-legend"><span class="pt-pip have"><span>1</span></span> known <span class="pt-pip plan"><span>2</span></span> planned '
      + '<span class="pt-pip open over"><span>3</span></span> past the budget <span class="pt-dq">✦</span> disciple quest</div>'
      + (both ? '<p class="pt-warn">This plan has both Shal’ille and Qor. Karma is one number — Shal’ille needs +10 per level, Qor −10 — so one of them can never be cast.</p>' : '')
      + '</section>';
  }

  function trackDetail(c, key) {
    var t = trackOf(key), m = c.m;
    if (!t) return '';
    var n = m.next[t.key];
    var levels = '';
    for (var lv = 1; lv <= MAX_LEVEL; lv++) {
      var list = abilitiesAt(t, lv);
      if (!list.length) continue;
      levels += '<div class="pt-lv"><div class="pt-lv-h">Level ' + lv + ' <span>' + levelPoints(lv) + ' pts</span></div><ul>'
        + list.map(function (r) {
          var a = knownAbility(c, r.name), ic = ICON[norm(r.name)];
          var stat = t.stat && c.obs ? c.obs.attributes[t.stat] : null;
          var cap = stat != null ? 2 * stat - 1 : null;
          return '<li class="' + (a != null ? 'known' : '') + '">'
            + (ic && ic.i ? '<img src="' + rel + '/' + esc(ic.i) + '" alt="" loading="lazy">' : '<span class="noimg"></span>')
            + (ic && ic.u ? '<a href="' + rel + '/' + esc(ic.u) + '">' + esc(r.name) + '</a>' : '<span>' + esc(r.name) + '</span>')
            + (a != null ? '<span class="pct' + (cap != null && a > cap ? ' capped' : '') + '" title="' + (cap != null && a > cap ? 'past the soft cap of ' + cap + '% — improves four times slower' : '') + '"><i style="width:' + a + '%"></i>' + a + '%</span>' : '<span class="pct none">—</span>')
            + '</li>';
        }).join('') + '</ul></div>';
    }
    var trainer = '';
    if (n.state === 'short' || n.state === 'ready' || n.state === 'impossible') {
      var slots = [0, 1, 2].map(function (i) {
        var b = n.best3[i];
        return b ? '<span class="pt-slot"><b>' + esc(b.name) + '</b> ' + b.ability + '%</span>'
                 : '<span class="pt-slot empty">— learn another level-' + (n.level - 1) + ' ability</span>';
      }).join('');
      trainer = '<div class="pt-trainer ' + n.state + '"><div class="pt-trainer-h">To learn level ' + n.level + '</div>'
        + '<div class="pt-meter"><i style="width:' + pct(n.have, n.need) + '%"></i><span>' + n.have + ' / ' + n.need + '</span></div>'
        + '<div class="pt-slots">' + slots + '</div>'
        + '<p class="pt-fine">' + (n.state === 'ready' ? 'Ready — the trainer will sell it now.'
          : n.state === 'impossible' ? 'More than three 99% abilities could ever provide here: points spent in other tracks have priced it out.'
          : 'Raise these three by <b>' + n.short + '</b> points between them.') + '</p></div>';
    }
    return '<section class="pt-block pt-detail" style="--hue:' + t.hue + '"><h3>' + esc(t.label)
      + (t.stat ? ' <span class="pt-h-note">requisite ' + t.stat + '</span>' : '') + '</h3>' + trainer + levels + '</section>';
  }

  // TRAINING ORDERS: the queue, in the order the keeper will work through it.
  function ordersBlock(c) {
    var m = c.m;
    var steps = m.queue;
    var firstOpen = steps.filter(function (s) { return !s.done; })[0];
    var rows = steps.map(function (s, idx) {
      var label, meta = '', cls = 'pt-step';
      if (s.kind === 'ability') {
        label = esc(s.name);
        meta = s.done ? s.have + '%' : 'one ability';
      } else if (s.kind === 'track') {
        label = '<span class="sw" style="--hue:' + s.t.hue + '"></span>' + esc(s.t.label) + ' ' + s.level;
        meta = s.known + '/' + s.total + ' known';
        if (!s.done) {
          if (s.free) meta += ' · free';
          else if (s.need != null) {
            meta += ' · needs ' + s.need + (s.impossible ? ' — unreachable' : ' (≈' + Math.ceil(s.need / s.slots) + '% ×' + s.slots + ')');
            if (!s.impossible) meta += s.have >= s.need ? ' · <span class="ok">has ' + s.have + ' ✓</span>' : ' · has ' + s.have;
          }
        }
        if (s.impossible && !s.done) cls += ' bad';
        if (m.budget != null && s.pointsAfter > m.budget && !s.done) cls += ' over';
      } else label = esc(s.name) + ' <em>— not a track this page knows</em>';
      if (s.done) cls += ' done';
      if (s === firstOpen) cls += ' now';
      return '<li class="' + cls + '"><span class="pt-step-n">' + (s.done ? '✓' : idx + 1) + '</span>'
        + '<span class="pt-step-t">' + label + '<small>' + meta + '</small></span>'
        + '<span class="pt-step-b"><button type="button" data-up="' + s.i + '" title="Earlier"' + (idx === 0 ? ' disabled' : '') + '>↑</button>'
        + '<button type="button" data-down="' + s.i + '" title="Later"' + (idx === steps.length - 1 ? ' disabled' : '') + '>↓</button>'
        + '<button type="button" data-rm="' + s.i + '" title="Remove">×</button></span></li>';
    }).join('');
    return '<section class="pt-block"><h3>Training orders</h3>'
      + (rows ? '<ol class="pt-steps">' + rows + '</ol>' : '<p class="pt-fine">No orders. Click a pip on the board to give this character somewhere to go.</p>')
      + '<p class="pt-fine">The keeper buys from the first unfinished row only, and a school row means every ability at that level. Needs are projected: each row is priced as if every row above it were done.</p>'
      + '</section>';
  }

  function copyBlock(c) {
    var picked = CHARS.filter(function (x) { return x.selected && x !== c; });
    var similar = CHARS.filter(function (x) { return x !== c && x.m && c.m && x.m.archetype.key === c.m.archetype.key; });
    return '<section class="pt-block"><h3>Copy this plan</h3>'
      + '<p class="pt-fine">Gives other characters the same school targets and the same order. Each keeps the abilities it already knows; nothing is saved until you review.</p>'
      + '<div class="pt-copy">'
      + '<button type="button" class="btn" id="ptCopySel"' + (picked.length ? '' : ' disabled') + '>To ' + picked.length + ' selected</button>'
      + '<button type="button" class="btn" id="ptCopySim"' + (similar.length ? '' : ' disabled') + '>To ' + similar.length + ' ' + esc(c.m.archetype.label.toLowerCase()) + (similar.length === 1 ? '' : 's') + '</button>'
      + '</div>'
      + (picked.length ? '' : '<p class="pt-fine">Tick the box on a card to select it.</p>') + '</section>';
  }

  // SIMILAR CHARACTERS, as a table: one row each, a cell per track, so a fleet of
  // "Kraanan knights" can be read across in one glance and the odd one out stands out.
  function compareBlock(c) {
    var peers = CHARS.filter(function (x) { return x.m && c.m && x.m.archetype.key === c.m.archetype.key; });
    if (peers.length < 2) return '';
    peers.sort(function (a, b) { return a === c ? -1 : b === c ? 1 : String(a.character).localeCompare(String(b.character)); });
    var head = '<tr><th>' + esc(c.m.archetype.label) + 's</th><th>HP</th><th>INT</th>'
      + TRACKS.map(function (t) { return '<th style="--hue:' + t.hue + '" title="' + esc(t.label) + '"><span class="sw"></span>' + t.abbr + '</th>'; }).join('')
      + '<th>points</th><th>next</th></tr>';
    var rows = peers.map(function (x) {
      var m = x.m;
      var cells = TRACKS.map(function (t) {
        var o = m.observed[t.key], tg = m.target[t.key];
        return '<td class="lv" style="--hue:' + t.hue + '">' + (o || tg ? '<b>' + o + '</b>' + (tg > o ? '<span>→' + tg + '</span>' : '') : '<span class="z">·</span>') + '</td>';
      }).join('');
      var nextStep = m.queue.filter(function (s) { return !s.done; })[0];
      var nx = nextStep ? (nextStep.kind === 'track' ? nextStep.t.label + ' ' + nextStep.level : nextStep.name) : '—';
      return '<tr class="' + (x === c ? 'me' : '') + (dirty(x) ? ' dirty' : '') + '" data-open="' + esc(x.character) + '">'
        + '<td class="nm">' + crest(x, 22) + esc(x.character) + '</td><td>' + ((x.obs && x.obs.level) || '') + '</td><td>' + m.intellect + '</td>'
        + cells + '<td class="' + (m.budget != null && m.pointsPlan > m.budget ? 'bad' : '') + '">' + m.pointsPlan + '/' + (m.budget == null ? '?' : m.budget) + '</td>'
        + '<td class="nx">' + esc(nx) + '</td></tr>';
    }).join('');
    return '<section class="pt-block pt-compare"><h3>Alongside the other ' + esc(c.m.archetype.label.toLowerCase()) + 's</h3>'
      + '<div class="pt-scroll"><table>' + head + rows + '</table></div></section>';
  }

  function bindSheet(c) {
    var box = el('ptSheet');
    Array.prototype.forEach.call(box.querySelectorAll('.pt-pip[data-track]'), function (b) {
      b.onclick = function () {
        var t = trackOf(b.getAttribute('data-track')), lv = Number(b.getAttribute('data-level'));
        if (lv <= c.m.observed[t.key]) { FOCUS_TRACK = t.key; renderSheet(); return; }
        setTarget(c, t, lv);
        changed(c);
      };
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-focus]'), function (b) {
      b.onclick = function () { var k = b.getAttribute('data-focus'); FOCUS_TRACK = FOCUS_TRACK === k ? null : k; renderSheet(); };
    });
    var move = function (i, d) {
      var q = c.draft.learning_queue, j = i + d;
      if (j < 0 || j >= q.length) return;
      var x = q[i]; q[i] = q[j]; q[j] = x;
      changed(c);
    };
    Array.prototype.forEach.call(box.querySelectorAll('[data-up]'), function (b) { b.onclick = function () { move(Number(b.getAttribute('data-up')), -1); }; });
    Array.prototype.forEach.call(box.querySelectorAll('[data-down]'), function (b) { b.onclick = function () { move(Number(b.getAttribute('data-down')), 1); }; });
    Array.prototype.forEach.call(box.querySelectorAll('[data-rm]'), function (b) {
      b.onclick = function () {
        var i = Number(b.getAttribute('data-rm')), e = c.draft.learning_queue[i];
        c.draft.learning_queue.splice(i, 1);
        // Removing a school's LAST row also drops its target, or the board would keep
        // showing a destination the keeper has no order to reach.
        if (e && e.track) {
          var t = trackOf(e.track), still = c.draft.learning_queue.some(function (x) { return x.track && norm(x.track) === norm(e.track); });
          if (t && !still) { if (isWeapon(t)) c.draft.weapon_level = null; else delete c.draft.schools[t.key]; }
          else if (t && Number(e.level) === (isWeapon(t) ? Number(c.draft.weapon_level) : Number(c.draft.schools[t.key]))) {
            var lower = Number(e.level) - 1;
            if (isWeapon(t)) c.draft.weapon_level = lower > 0 ? lower : null;
            else if (lower > 0) c.draft.schools[t.key] = lower; else delete c.draft.schools[t.key];
          }
        }
        if (e && e.name) c.draft.abilities = (c.draft.abilities || []).filter(function (a) { return norm(a.name) !== norm(e.name); });
        changed(c);
      };
    });
    var sel = el('ptCopySel'), sim = el('ptCopySim');
    if (sel) sel.onclick = function () { copyTo(c, CHARS.filter(function (x) { return x.selected && x !== c; })); };
    if (sim) sim.onclick = function () { copyTo(c, CHARS.filter(function (x) { return x !== c && x.m && x.m.archetype.key === c.m.archetype.key; })); };
    Array.prototype.forEach.call(box.querySelectorAll('.pt-compare tr[data-open]'), function (r) {
      r.onclick = function () { var x = find(r.getAttribute('data-open')); if (x && x !== c) { OPEN = x; FOCUS_TRACK = null; renderRoster(); renderSheet(); } };
    });
  }

  function copyTo(src, targets) {
    targets.forEach(function (x) {
      if (x.state === 'loading') return;
      var p = clone(src.draft);
      // One-ability rows are specific to a character's gaps; keep the target's own.
      p.learning_queue = p.learning_queue.filter(function (e) { return e.track; });
      var own = (x.draft.learning_queue || []).filter(function (e) { return e.name; });
      p.learning_queue = own.concat(p.learning_queue);
      p.abilities = x.draft.abilities || [];
      x.draft = p;
      x.m = model(x);
    });
    say('Copied ' + src.character + '’s plan to ' + targets.length + ' character' + (targets.length === 1 ? '' : 's') + ' — review before saving.', 'good');
    renderRoster(); renderSheet(); renderDock();
  }

  function changed(c) { c.m = model(c); renderRoster(); renderSheet(); renderDock(); }

  // ------------------------------------------------------------------ saving

  function renderDock() {
    var d = CHARS.filter(dirty);
    el('ptDock').hidden = !d.length;
    el('ptDockText').textContent = d.length + ' character' + (d.length === 1 ? '' : 's') + ' with unsaved plans: '
      + d.map(function (c) { return c.character; }).join(', ');
  }

  function describe(a, b) {
    var out = [];
    TRACKS.forEach(function (t) {
      var x = isWeapon(t) ? a.weapon_level : a.schools[t.key], y = isWeapon(t) ? b.weapon_level : b.schools[t.key];
      if ((x || null) !== (y || null)) out.push(t.label + ' ' + (x || '—') + ' → ' + (y || '—'));
    });
    if (JSON.stringify(a.learning_queue) !== JSON.stringify(b.learning_queue))
      out.push('order: ' + (b.learning_queue || []).length + ' row' + ((b.learning_queue || []).length === 1 ? '' : 's'));
    return out;
  }

  function review() {
    var d = CHARS.filter(dirty);
    if (!d.length) return;
    var body = '<h2>Save ' + d.length + ' plan' + (d.length === 1 ? '' : 's') + ' to the fleet</h2>'
      + '<p>Each character’s keeper reads its file on its next pass and starts buying in this order. Only the plan is written; gear, carry list and every other setting is read fresh from disk and kept.</p>'
      + '<ul class="pt-review">' + d.map(function (c) {
        return '<li><b>' + esc(c.character) + '</b> ' + esc(describe(c.orig, c.draft).join(' · ') || 'reordered')
          + (c.m && c.m.budget != null && c.m.pointsPlan > c.m.budget ? ' <span class="bad">— over budget</span>' : '') + '</li>';
      }).join('') + '</ul>'
      + (SERVED ? '' : '<p class="pt-warn">This page is not being served by the harness, so it cannot write.</p>')
      + '<div class="pt-dialog-b"><button type="button" class="btn" id="ptCancel">Cancel</button>'
      + '<button type="button" class="btn primary" id="ptConfirm"' + (SERVED ? '' : ' disabled') + '>Save ' + d.length + '</button></div>';
    el('ptDialogBody').innerHTML = body;
    var dlg = el('ptDialog');
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    el('ptCancel').onclick = function () { dlg.close ? dlg.close() : dlg.removeAttribute('open'); };
    el('ptConfirm').onclick = function () {
      el('ptConfirm').disabled = true;
      saveAll(d).then(function (res) {
        dlg.close ? dlg.close() : dlg.removeAttribute('open');
        var bad = res.filter(function (r) { return !r.ok; });
        say(bad.length ? 'Saved ' + (res.length - bad.length) + ', failed ' + bad.length + ': '
          + bad.map(function (r) { return r.c.character + ' (' + r.err + ')'; }).join('; ')
          : 'Saved ' + res.length + ' plan' + (res.length === 1 ? '' : 's') + '. The keepers pick them up on their next pass.', bad.length ? 'bad' : 'good');
        renderRoster(); renderSheet(); renderDock();
      });
    };
  }

  // ONE AT A TIME, AND ONLY THE PLAN. /_plan replaces `plan` in the file as it is on disk
  // NOW — the loadout planner, the CLI or a fleet-wide gear apply may have changed the rest
  // since this page loaded — and writes every other field back untouched
  // (writeLoadoutPlan in tools/m59-loadout.mjs).
  function saveAll(list) {
    var out = [];
    return list.reduce(function (p, c) {
      return p.then(function () {
        var plan = clone(c.draft);
        var firstOpen = c.m && c.m.queue.filter(function (s) { return !s.done && s.kind === 'track'; })[0];
        plan.learning_target = firstOpen ? firstOpen.t.key : (plan.learning_target || null);
        return fetch(rel + '/_plan', { method: 'POST', headers: { 'content-type': 'application/json' },
                                       body: JSON.stringify({ character: c.character, agent: c.agent, plan: plan }) })
          .then(function (r) { return r.json().then(function (j) { return { r: r, j: j }; }); })
          .then(function (x) {
            if (!x.r.ok || !x.j.ok) throw new Error(x.j.error || ('HTTP ' + x.r.status));
            c.loadout = c.savedLoadout = x.j.loadout;
            c.gen = (c.gen || 0) + 1;
            var last = c.agent && cacheRead()[c.agent];
            if (last) cacheWrite(c.agent, { obs: last.obs, loadout: c.loadout, at: last.at });
            c.orig = planOf(x.j.loadout);
            c.draft = clone(c.orig);
            c.m = model(c);
            out.push({ c: c, ok: true });
          })
          .catch(function (e) { out.push({ c: c, ok: false, err: e.message }); });
      });
    }, Promise.resolve()).then(function () { return out; });
  }

  function say(text, kind) {
    var s = el('ptStatus');
    s.textContent = text || '';
    s.className = 'pt-status' + (kind ? ' ' + kind : '');
  }

  // ------------------------------------------------------------------ loading

  function loadAll() {
    say('Reading the fleet…');
    return fetch(rel + '/_loadouts').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      SERVED = true;
      return r.json();
    }).then(function (j) {
      var prev = {};
      CHARS.forEach(function (c) { prev[norm(c.character)] = c; });
      var seen = {};
      CHARS = [];
      (j.fleet || []).forEach(function (f) {
        var c = blankChar(f.agent, f.character);
        c.faction = f.faction; c.soldier = f.faction_soldier === true;
        var p = prev[norm(f.character)];
        if (p && dirty(p)) { c.draft = p.draft; }
        if (p) c.selected = p.selected;
        CHARS.push(c); seen[norm(f.character)] = true;
      });
      (j.loadouts || []).forEach(function (l) {
        if (!l.ok || seen[norm(l.character)]) return;
        var c = blankChar(null, l.character);
        c.state = 'saved-loading';
        CHARS.push(c); seen[norm(l.character)] = true;
      });
      if (OPEN) OPEN = find(OPEN.character);
      // DRAW THE LAST READING FIRST. A character takes the broker several seconds to read
      // while it is busy driving the fleet, so the page shows what it saw last time —
      // labelled with its age — and replaces each card as the fresh reading lands.
      var cache = cacheRead();
      CHARS.forEach(function (c) {
        var hit = c.agent && cache[c.agent];
        if (!hit || norm(hit.obs && hit.obs.character) !== norm(c.character)) return;
        c.obs = hit.obs; c.loadout = hit.loadout; c.state = 'ok'; c.stale = hit.at;
        c.orig = planOf(c.loadout);
        if (!dirty(c) || samePlan(c.draft, blankPlan())) c.draft = clone(c.orig);
        c.m = model(c);
      });
      renderRoster();
      if (OPEN) renderSheet();
      return pool(CHARS, 4, loadOne);
    }).then(function () {
      var bad = CHARS.filter(function (c) { return c.state === 'error'; }).length;
      say(CHARS.length + ' characters' + (bad ? ', ' + bad + ' not answering' : '') + '.', bad ? 'bad' : null);
      renderRoster(); renderSheet(); renderDock();
    }).catch(function (e) {
      SERVED = false;
      say('This page needs the harness serving it (node tools/m59-compendium.mjs) — ' + e.message, 'bad');
    });
  }

  function loadOne(c) {
    // A save bumps c.gen. A reading that set off before the save carries the plan as it was,
    // and must not be allowed to put it back when it lands.
    var gen = c.gen || 0;
    var req = c.agent
      ? fetch(rel + '/_planner?agent=' + encodeURIComponent(c.agent)).then(function (r) {
          return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status); return j; });
        }).then(function (j) {
          c.obs = j.observed; c.loadout = j.loadout; c.state = 'ok'; c.stale = null;
          cacheWrite(c.agent, { obs: j.observed, loadout: j.loadout, at: Date.now() });
        })
      : fetch(rel + '/_loadout?character=' + encodeURIComponent(c.character)).then(function (r) { return r.json(); })
          .then(function (j) { c.loadout = j.loadout; c.state = 'saved'; });
    return req.catch(function (e) {
      c.state = 'error'; c.err = e.message;
      return fetch(rel + '/_loadout?character=' + encodeURIComponent(c.character))
        .then(function (r) { return r.ok ? r.json() : { loadout: null }; })
        .then(function (j) { c.loadout = j.loadout; })
        .catch(function () { /* nothing saved either */ });
    }).then(function () {
      if ((c.gen || 0) !== gen) c.loadout = c.savedLoadout;
      // Decided NOW, not when the request went out: a pip clicked on the cached card while
      // this reading was in flight is an edit, and must survive the reading landing.
      var edited = dirty(c) ? c.draft : null;
      c.orig = planOf(c.loadout);
      c.draft = edited || clone(c.orig);
      c.m = model(c);
      renderRoster();
      if (OPEN === c) renderSheet();
      renderDock();
    });
  }

  // Per-viewer convenience only: the broker is the truth, and a page without storage just
  // waits for it.
  var CACHE_KEY = 'm59-party-last-reading';
  function cacheRead() {
    try { return JSON.parse(window.localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function cacheWrite(agent, rec) {
    try { var all = cacheRead(); all[agent] = rec; window.localStorage.setItem(CACHE_KEY, JSON.stringify(all)); } catch (e) { /* full or blocked */ }
  }
  var ago = function (t) {
    var s = Math.round((Date.now() - t) / 1000);
    return s < 90 ? s + 's' : s < 5400 ? Math.round(s / 60) + ' min' : Math.round(s / 3600) + ' h';
  };

  function pool(items, n, fn) {
    var i = 0;
    var next = function () { if (i >= items.length) return Promise.resolve(); var x = items[i++]; return fn(x).then(next); };
    var workers = [];
    for (var k = 0; k < n; k++) workers.push(next());
    return Promise.all(workers);
  }

  // ------------------------------------------------------------------ boot

  function boot() {
    if (!LEARN) { say('assets/learn.js did not load — no learning arithmetic, so nothing is drawn.', 'bad'); return; }
    el('ptSort').value = SORT;
    el('ptSort').onchange = function () {
      SORT = el('ptSort').value;
      try { window.localStorage.setItem('m59-party-sort', SORT); } catch (e) { /* fine */ }
      renderRoster();
    };
    el('ptRefresh').onclick = function () { loadAll(); };
    el('ptReview').onclick = review;
    el('ptDiscard').onclick = function () {
      CHARS.forEach(function (c) { if (dirty(c)) { c.draft = clone(c.orig); c.m = model(c); } });
      say('Changes discarded.'); renderRoster(); renderSheet(); renderDock();
    };
    window.addEventListener('beforeunload', function (e) {
      if (CHARS.some(dirty)) { e.preventDefault(); e.returnValue = ''; }
    });
    Promise.all([
      fetch(rel + '/data/planner.json').then(function (r) { return r.json(); }),
      fetch(rel + '/search.json').then(function (r) { return r.json(); }).catch(function () { return []; }),
    ]).then(function (x) {
      D = x[0];
      (x[1] || []).forEach(function (s) {
        if ((s.k === 'spell' || s.k === 'skill') && !ICON[norm(s.n)]) ICON[norm(s.n)] = { i: s.i, u: s.u };
      });
      buildCatalogue();
      return loadAll();
    }).catch(function (e) { say('Could not load the catalogue: ' + e.message, 'bad'); });
  }

  // For a console: the state, read-only by convention.
  window.M59Party = { chars: function () { return CHARS; }, model: model };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
