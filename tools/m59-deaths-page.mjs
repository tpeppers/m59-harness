// TWO PAGES ABOUT THE SAME LEDGER, READ FROM OPPOSITE ENDS.
//
//   /deaths    what killed them, where — and a loud refusal to say where, for most of them
//   /tougher   what it took to earn a point of maximum health, which is the only thing
//              any of this is for
//
// The fleet page answers "how is it going". These answer "why" — and the deaths half has
// to do something the fleet page never has to: DECLINE TO ANSWER. 253 of 637 deaths have
// no trustworthy location, and the honest rendering of that is a hole in the treemap and
// a number beside it, not a plausible-looking room. See m59-postmortems.mjs for the
// measurement that set the threshold.
//
// The nav, the stylesheet and the inlined treemap used to live here and now live in
// m59-page-chrome.mjs, because five boards carrying five copies of one tab list means a
// sixth board is invisible from whichever copy nobody remembered to edit.
import { loadPostmortems, facets, digest, TRUST_MS } from './m59-postmortems.mjs';
import { allGains, toughSummary, allFeeds, FEED_SIZE } from './m59-tougher.mjs';
import { resolveFleet } from './m59-fleetpath.mjs';
import { lore, roomLink } from './m59-dashboard.mjs';
import { esc, ago, NAV, STYLE, SQUARIFY_JS, TREEMAP_JS, FACET_WIRING_JS } from './m59-page-chrome.mjs';

const { label: FLEET_LABEL } = resolveFleet();

// m59-deaths-test.mjs evaluates this exact string to check the rectangles the layout
// produces, and imports it from here. Kept as an export so moving it did not move the
// test's idea of where it lives.
export { SQUARIFY_JS };

const DEATH_LOG_JS = `
// CLICK A DEATH, GET THE REPORT. Fetched rather than inlined: 600 digests with their
// text logs is megabytes, and the page has to open on a phone.
document.addEventListener('click', function (e) {
  var tr = e.target.closest && e.target.closest('tr.death');
  if (!tr) return;
  var next = tr.nextElementSibling;
  if (next && next.classList.contains('detail')) { next.remove(); return; }
  document.querySelectorAll('tr.detail').forEach(function (d) { d.remove(); });
  var row = document.createElement('tr');
  row.className = 'detail';
  row.innerHTML = '<td colspan="7" class="dim">reading the post mortem…</td>';
  tr.parentNode.insertBefore(row, tr.nextSibling);
  fetch('/deaths/report?file=' + encodeURIComponent(tr.dataset.file))
    .then(function (r) { return r.json(); })
    .then(function (d) { row.innerHTML = '<td colspan="7">' + renderDigest(d) + '</td>'; })
    .catch(function (err) { row.innerHTML = '<td colspan="7" class="bad">could not read it: ' + err + '</td>'; });
});
function kv(k, v) { return '<div class="kv"><div class="k">' + k + '</div><div>' + v + '</div></div>'; }
function renderDigest(d) {
  if (!d || d.error) return '<span class="bad">' + ((d && d.error) || 'not found') + '</span>';
  var w = d.where, c = d.cause;
  var decisions = d.survival_decisions;
  var safeText = function(v) { return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
  var survival = decisions && decisions.available ? (decisions.decisions || []).map(function(x) {
    var p=x.chosen_refuge;
    return '<div><b>' + safeText(x.strategy) + '</b> · chosen ' +
      (x.chosen_ms_before_death/1000).toFixed(1) + 's before death · ' + safeText(x.reason) +
      (p ? ' · refuge r'+safeText(p.row)+'c'+safeText(p.col)+' in room '+safeText(p.room) : ' · refuge not selected') +
      (x.path_length != null ? ' · planned path '+safeText(x.path_length)+' steps' : '') +
      (x.cancelled_at ? ' · cancelled '+(x.cancelled_ms_before_death/1000).toFixed(1)+'s before death: '+safeText(x.cancel_reason) : '') +
      (x.replacement_id ? ' · replacement '+safeText(x.replacement_id) : '') +
      ' · '+safeText(x.outcome || x.status)+'</div>';
  }).join('') : '<span class="dim">No explicit survival decisions in this older record.</span>';
  var place = w.trusted
    ? w.room + ' <span class="dim">(' + w.col + ',' + w.row + ')</span>'
    : '<span class="guess">not known — ' + w.why + '</span>';
  var killer = c.killer
    ? c.killer + (c.observed ? ' <span class="pill obs">announced</span>'
                             : ' <span class="pill inf">a guess</span>')
    : '<span class="dim">nothing named it</span>';
  var text = (d.text || []).map(function (t) {
    return '<div><span class="t">-' + (t.dt / 1000).toFixed(1) + 's</span> ' + t.text + '</div>';
  }).join('');
  // THE CELL THAT EXPLAINS MOST OF THIS PAGE. A keeper that was up and not looking is
  // the ordinary case, not the exception, and the report should say it in words.
  var k = d.keeper || {};
  var keeper = k.up === false ? '<span class="bad">N — nothing was driving</span>'
             : k.up === null ? '<span class="dim">? — no record either way</span>'
             : k.watching ? '<span class="good">Y</span> <span class="dim">last looked ' +
                 ((k.blind_ms || 0) / 1000).toFixed(1) + 's before the end</span>'
             : '<span class="guess">Y, but BLIND for ' + Math.round((k.blind_ms || 0) / 1000) +
               's</span> <span class="dim">— running, and not looking</span>';
  return '<div class="grid">' +
    kv('killed by', killer) +
    kv('keeper', keeper) +
    kv('where', place) +
    kv('was', (d.was.doing || '?') + (d.was.hunting ? ' · hunting ' + d.was.hunting : '')) +
    kv('level', d.level + (d.was.in_safe_spot ? ' · <span class="bad">in a safe spot</span>' : '')) +
    kv('shape', d.shape + ' <span class="dim">(biggest drop ' + d.biggest_drop + ')</span>') +
    kv('health', '<span class="trail">' + (d.health_trail || []).join(' ') + '</span>') +
    kv('crowd', (d.threats || []).join(', ') || '<span class="dim">nothing in view</span>') +
    kv('vigor', d.was.vigor == null ? '—' : d.was.vigor) +
    (d.during_keeper_outage ? kv('caveat', '<span class="guess">nothing was driving this character' +
      ' — do not read it as evidence about the strategy</span>') : '') +
  '</div>' +
  '<div class="log"><b>Survival decisions</b>'+survival+'</div>' +
  (text ? '<div class="log">' + text + '</div>' : '');
}
`;

// WAS ANYTHING DRIVING? Y/N — with the part that a bare Y hides.
//
// N is an outage: nothing was at the controls, and the death says nothing about how the
// fleet fights. Y is the uptime ledger saying the keeper was running.
//
// But 81% of the deaths where the keeper WAS up have it blind at the moment of death —
// median gap 18 seconds — and a plain Y over that is the most misleading cell on the page.
// A keeper blind for 18s has taken roughly eighteen decisions against a view of the world
// that stopped changing, including every decision about whether to flee. So Y carries the
// gap, and only a keeper inside its own 8s resync envelope gets the green one.
function keeperCell(k) {
  if (!k || k.up === null)
    return `<span class="dim" title="${esc(k?.why ?? 'no record')}">?</span>`;
  if (k.up === false)
    return `<span class="bad" title="${esc(k.why)}">N</span>`;
  const gap = k.blind_ms == null ? null
    : k.blind_ms < 1000 ? `${k.blind_ms}ms` : `${Math.round(k.blind_ms / 1000)}s`;
  if (k.watching)
    return `<span class="good" title="${esc(k.why)}">Y</span>` +
           (gap ? ` <span class="dim gapnum">${gap}</span>` : '');
  return `<span class="guess" title="${esc(k.why)}">Y</span>` +
         `<span class="pill inf" title="${esc(k.why)}">blind ${gap}</span>`;
}

// ------------------------------------------------------------------ /deaths

// `characters` is the fleet this board is about, as a Set of names, or null for every
// record on the machine. The broker passes its OWN roster — it is serving this page, so it
// already knows, and probing itself over HTTP to find out would be absurd. See
// m59-fleetscope.mjs for why these directories need telling at all.
export function renderDeaths({ hours = 168, characters = null } = {}) {
  const all = loadPostmortems({ sinceMs: hours * 3600 * 1000 });
  const rows = characters ? all.filter(r => characters.has(r.character)) : all;
  const f = facets(rows);
  const placed = rows.filter(r => r.where.trusted).length;
  const observed = rows.filter(r => r.cause.observed).length;
  const inSpot = rows.filter(r => r.in_safe_spot).length;
  const unattended = rows.filter(r => r.during_keeper_outage).length;
  const blind = rows.filter(r => r.keeper.up === true && !r.keeper.watching).length;
  const watching = rows.filter(r => r.keeper.watching).length;

  const logRows = rows.slice(0, 80).map(r => `
    <tr class="death" data-file="${esc(r.file)}">
      <td class="dim">${esc(ago(r.at))}</td>
      <td>${esc(r.character ?? '?')}</td>
      <td class="dim">${r.level ?? '—'}</td>
      <td class="keeper">${keeperCell(r.keeper)}</td>
      <td>${r.cause.killer
            ? `${lore(r.cause.killer)} ${r.cause.observed
                 ? '<span class="pill obs">announced</span>'
                 : '<span class="pill inf">a guess</span>'}`
            : '<span class="dim">unattributed</span>'}</td>
      <td>${r.where.trusted
            ? roomLink(r.where.room, r.where.num)
            : `<span class="guess" title="${esc(r.where.why)}">not known</span>`}</td>
      <td class="dim">${r.in_safe_spot ? '<span class="bad">in a safe spot</span>'
                     : esc(r.hunting ? 'hunting ' + r.hunting : (r.doing ?? '—'))}</td>
    </tr>`).join('');

  const FACETS = {
    cause: { ...f.cause, unit: 'deaths', empty: 'no death was announced by the server in this window' },
    place: { ...f.place, unit: 'deaths', empty: 'nothing in this window has a location we can stand behind' },
    inferred: { children: f.cause.inferred, total: f.cause.inferred_total, unit: 'deaths',
                note: 'THESE ARE GUESSES. No broadcast arrived, so this is the commonest thing that ' +
                      'was standing nearby — which matched the real killer 51% of the time when both ' +
                      'were available. Shown because a guess you can see is better than one folded ' +
                      'into the totals.',
                empty: 'nothing here — every death in this window was announced' },
  };

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Post mortems — ${esc(FLEET_LABEL)} fleet</title>
<style>${STYLE}</style>
</head><body><div class="wrap">
  <h1>Post mortems</h1>
  <div class="sub">${rows.length} deaths in the last ${hours}h · ${esc(FLEET_LABEL)} fleet</div>
  ${NAV('deaths')}

  <div class="cards">
    <div class="card"><div class="k">deaths</div><div class="v">${rows.length}</div>
      <div class="n">each costs a point of max health, for ever</div></div>
    <div class="card"><div class="k">killer announced</div><div class="v good">${observed}</div>
      <div class="n">${rows.length ? Math.round(100 * observed / rows.length) : 0}% — the rest is inference</div></div>
    <div class="card"><div class="k">location trusted</div><div class="v">${placed}</div>
      <div class="n">${rows.length - placed} we cannot place at all</div></div>
    <div class="card"><div class="k">died in a safe spot</div><div class="v ${inSpot ? 'bad' : 'good'}">${inSpot}</div>
      <div class="n">the number that falsifies the thesis</div></div>
    <div class="card"><div class="k">keeper was down</div><div class="v ${unattended ? 'bad' : 'dim'}">${unattended}</div>
      <div class="n">not evidence about the strategy</div></div>
    <div class="card"><div class="k">up but blind</div><div class="v ${blind ? 'bad' : 'good'}">${blind}</div>
      <div class="n">${watching} were actually watching — a keeper past its own 8s resync is
        deciding against a world that stopped changing</div></div>
  </div>

  <div class="panel">
    <div class="facets">
      <button data-facet="cause" class="on">What killed them</button>
      <button data-facet="place">Where they died</button>
      <button data-facet="inferred">Guessed killers</button>
      <button id="tm-back" style="display:none">← all</button>
    </div>
    <svg id="tm"></svg>
    <div class="caveat" id="facet-note"></div>
  </div>

  <h2>The last ${Math.min(80, rows.length)} deaths</h2>
  <div class="sub">Click one to open its report.</div>
  <div class="panel scroller" style="padding:.25rem .5rem">
  <table>
    <thead><tr><th>when</th><th>who</th><th>lvl</th>
      <th title="was a keeper driving — and had it looked recently">keeper?</th>
      <th>killed by</th><th>where</th><th>doing</th></tr></thead>
    <tbody>${logRows || '<tr><td colspan="7" class="empty">no deaths in this window</td></tr>'}</tbody>
  </table>
  </div>
</div>
<script>
var FACETS = ${JSON.stringify(FACETS)};
${TREEMAP_JS}
${DEATH_LOG_JS}
${FACET_WIRING_JS}
pickFacet('cause');
</script>
</body></html>`;
}

// ------------------------------------------------------------------ /tougher

export function renderTougher({ hours = 168, characters = null } = {}) {
  const gains = allGains({ sinceMs: hours * 3600 * 1000, characters });
  const s = toughSummary(gains);
  const feeds = allFeeds({ characters });

  const FACETS = {
    creature: { children: s.by_creature, total: s.total, unit: 'points',
                note: 'What actually paid. A kill only rolls for a point when the creature is at ' +
                      'or above your own level, so a creature that appears here is one worth ' +
                      'hunting and one that never does is a creature the fleet is killing for free.',
                empty: 'nothing yet' },
    room: { children: s.by_room, total: s.total, unit: 'points',
            note: 'Where the points were earned. The positive image of the deaths map — and unlike ' +
                  'that one, every row here is exact: a gain is announced the instant it happens, ' +
                  'so the room is where the character was standing, not where it was last seen.',
            empty: 'nothing yet' },
    character: { children: s.by_character, total: s.total, unit: 'points',
                 note: 'Who earned them.', empty: 'nothing yet' },
  };

  const gainRows = gains.slice(0, 60).map(g => `
    <tr>
      <td class="dim">${esc(ago(g.at))}</td>
      <td>${esc(g.character)}</td>
      <td class="good">${g.from != null && g.to != null ? `${g.from} → <b>${g.to}</b>` : (g.to ?? '—')}</td>
      <td>${g.creature ? lore(g.creature) : '<span class="guess">cause not recorded</span>'}</td>
      <td>${g.room ? roomLink(g.room, g.room_num) : '<span class="dim">—</span>'}</td>
    </tr>`).join('');

  // THE KILL FEED. In memory, ten per character, gone when the broker stops — which is
  // the right lifetime for "what is this character doing right now".
  const feedBlocks = feeds.map(f => `
    <div class="card">
      <div class="k">${esc(f.character)}</div>
      ${f.feed.map(e => {
        if (e.kind === 'gain')
          return `<div class="good"><b>TOUGHER</b> → ${e.to ?? '?'}${
            e.creature ? ' · ' + esc(e.creature) : ''} <span class="dim">${esc(ago(e.at))}</span></div>`;
        if (e.kind === 'death')
          return `<div class="bad">died${e.killer ? ' · ' + esc(e.killer) : ''}${
            e.observed ? '' : ' <span class="guess">(guess)</span>'} <span class="dim">${esc(ago(e.at))}</span></div>`;
        return `<div class="dim">killed ${esc(e.creature ?? '?')}${
          e.from_safe_spot ? ' <span class="pill">wall</span>' : ''} <span class="dim">${esc(ago(e.at))}</span></div>`;
      }).join('')}
    </div>`).join('');

  const nothingYet = !gains.length;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tougher — ${esc(FLEET_LABEL)} fleet</title>
<meta http-equiv="refresh" content="60">
<style>${STYLE}</style>
</head><body><div class="wrap">
  <h1>Tougher</h1>
  <div class="sub">Every point of maximum health the fleet has earned, and what died for it ·
    ${esc(FLEET_LABEL)} fleet</div>
  ${NAV('tougher')}

  <div class="cards">
    <div class="card"><div class="k">points earned</div><div class="v good">${s.total}</div>
      <div class="n">last ${hours}h</div></div>
    <div class="card"><div class="k">creatures that paid</div><div class="v">${s.by_creature.length}</div>
      <div class="n">of everything the fleet kills</div></div>
    <div class="card"><div class="k">rooms that paid</div><div class="v">${s.by_room.length}</div>
      <div class="n">where the work actually is</div></div>
    <div class="card"><div class="k">cause not recorded</div><div class="v ${s.unattributed ? 'bad' : 'dim'}">${s.unattributed}</div>
      <div class="n">announced, but no kill near it</div></div>
  </div>

  ${nothingYet ? `
  <div class="panel">
    <div class="caveat">
      <b>Nothing on record yet, and that is expected.</b> A gain is caught from the server's own
      announcement — "You suddenly feel a little tougher." (<code>player.kod:144</code>) — which
      arrived on the wire for months with nothing listening. This record starts the first time a
      broker running this code sees one, and <b>it cannot be backfilled</b>: the ledger's
      <code>level_up</code> events were derived by diffing five-minute samples, so they know the
      net change and not the kill that caused it. Expect the first rows within a few hours of play.
    </div>
  </div>` : `
  <div class="panel">
    <div class="facets">
      <button data-facet="creature" class="on">What paid for them</button>
      <button data-facet="room">Where they were earned</button>
      <button data-facet="character">Who earned them</button>
      <button id="tm-back" style="display:none">← all</button>
    </div>
    <svg id="tm"></svg>
    <div class="caveat" id="facet-note"></div>
  </div>

  <h2>Every point, newest first</h2>
  <div class="panel scroller" style="padding:.25rem .5rem">
  <table>
    <thead><tr><th>when</th><th>who</th><th>max health</th><th>what paid</th><th>where</th></tr></thead>
    <tbody>${gainRows}</tbody>
  </table>
  </div>`}

  <h2>Kill feed</h2>
  <div class="sub">The last ${FEED_SIZE} kills and deaths per character, held in memory —
    this empties when the broker restarts, on purpose.</div>
  ${feeds.length
    ? `<div class="cards">${feedBlocks}</div>`
    : '<div class="panel"><div class="empty">no keeper has killed anything since the broker started</div></div>'}
</div>
${nothingYet ? '' : `<script>
var FACETS = ${JSON.stringify(FACETS)};
${TREEMAP_JS}
${FACET_WIRING_JS}
pickFacet('creature');
</script>`}
</body></html>`;
}

export function deathReportJSON(file) {
  // Path traversal is the only real hazard on a read-only server that binds to every
  // interface: the file name comes off a query string and is used to open a file. A
  // postmortem name has no directory in it, so anything that does is refused outright
  // rather than sanitised — sanitising invites a bypass, refusing does not.
  if (!file || /[\\/]/.test(file) || !file.endsWith('.json')) return { error: 'bad file name' };
  const d = digest(file);
  return d ?? { error: 'no such post mortem' };
}

export { TRUST_MS };
