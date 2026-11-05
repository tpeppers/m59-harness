// /skills — WHAT EACH CHARACTER IS ACTUALLY GETTING BETTER AT, AND WHAT IT IS LOSING.
//
// Ability levels are the only signal that practice is working, and they were the most
// expensive thing in this repository to read — four requests and 1.2s per character,
// because the spell and skill LISTS have to be re-read first or a group-3 packet
// mislabels every number in it. So nothing read them often, and nobody looked.
//
// They do not need reading. The server PUSHES every change: ChangeSkillAbility calls
// DrawStatSkill on every change (player.kod:7343) and that sends BP_STAT for the one slot
// that moved. m59-abilities.mjs writes those down, one file per character, and this page
// is that record with twenty-one books laid side by side.
//
// THE REASON TO LAY THEM SIDE BY SIDE IS ATROPHY. What you stop using decays when the
// advancement window rolls over — no message, no event, no complaint — and on this fleet
// it is nearly as large as the advancement: 1828 points gained against 1558 lost over a
// week, with `relay` and `blink` losing hundreds and gaining nothing at all. A page that
// showed only the current numbers would show a fleet slowly improving. A page that
// netted the two would show a fleet improving slowly. Neither is what is happening: two
// abilities are being practised and five are rotting, and only both columns say so.
import { fleetAbilities } from './m59-abilities.mjs';
import { resolveFleet } from './m59-fleetpath.mjs';
import { lore } from './m59-dashboard.mjs';
import { esc, ago, heroLink, NAV, STYLE, TREEMAP_JS, FACET_WIRING_JS } from './m59-page-chrome.mjs';

const { label: FLEET_LABEL } = resolveFleet();

// The scale every ability bar is drawn against. Ability runs 0-100 in the kod; drawing
// against the fleet's own maximum instead would make a fleet that is uniformly terrible
// look uniformly excellent, which is precisely the reading to avoid.
const ABILITY_MAX = 100;

const EXTRA_STYLE = `
  /* TWENTY-ONE NUMBERS IN ONE CELL. A mean hides one character at 90 and twenty at 5,
     which on this fleet is the actual shape of half the rows — so the spread is drawn.
     One bar per character, tallest first, against a fixed 0-100 rather than the fleet's
     own best. */
  .spread { display:flex; align-items:flex-end; gap:1px; height:22px; }
  .spread i { display:block; width:5px; min-height:1px; background:var(--accent); opacity:.75;
              border-radius:1px 1px 0 0; }
  .spread i.top { background:var(--good); opacity:1; }
  .sheet td.ab { min-width:150px; }
  .who { color:var(--dim); font-size:.72rem; }
  /* Gained and lost, side by side and never netted. See the header. */
  .gain { color:var(--good); font-weight:600; }
  .loss { color:var(--bad); font-weight:600; }
  .rot td { background:color-mix(in srgb, var(--bad) 7%, transparent); }
  .chips { display:flex; flex-wrap:wrap; gap:.3rem; }
  .chip { font-size:.75rem; border:1px solid var(--line); border-radius:999px;
          padding:.1rem .5rem; white-space:nowrap; font-variant-numeric:tabular-nums; }
  .chip b { font-weight:600; }
  .chip.decayed { border-color:var(--edge); color:var(--edge); }
`;

const spread = (values) => `<span class="spread" title="${values.join(', ')}">${
  values.map((v, i) => `<i class="${i === 0 ? 'top' : ''}" style="height:${
    Math.max(1, Math.round(22 * Math.min(1, v / ABILITY_MAX)))}px"></i>`).join('')}</span>`;

export function renderSkills({ hours = 168, characters = null } = {}) {
  const f = fleetAbilities({ sinceMs: hours * 3600 * 1000, characters });

  const FACETS = {
    gained: {
      children: f.by_ability_gained, total: f.advanced, unit: 'points',
      note: 'Points of ability the fleet gained in this window, by what gained them. ' +
            'Points rather than events: three separate +1s and one +3 are the same amount ' +
            'of progress. Click one to see which characters did the practising.',
      empty: 'nothing advanced in this window',
    },
    who: {
      children: f.by_character_gained, total: f.advanced, unit: 'points', drill: 'ability',
      note: 'Who is improving. A character with nothing here is either not fighting or ' +
            'not fighting anything that teaches it anything.',
      empty: 'nobody advanced in this window',
    },
    lost: {
      children: f.by_ability_lost, total: f.atrophied, unit: 'points',
      note: 'ATROPHY, AND IT IS REAL. What you stop using decays when the advancement ' +
            'window rolls over — silently, with no message and no event. An ability with ' +
            'a large rectangle here and none in "What advanced" is one the fleet has ' +
            'stopped using entirely, and it is on its way back to zero.',
      empty: 'nothing decayed in this window — which would be unusual',
    },
  };

  const sheet = f.abilities.map(a => `
    <tr class="${a.advanced === 0 && a.atrophied > 0 ? 'rot' : ''}">
      <td class="ab">${lore(a.name)}</td>
      <td class="dim">${a.kind}</td>
      <td class="num">${a.characters}</td>
      <td class="num"><b>${a.best ?? '—'}</b><br><span class="who">${esc(a.best_character ?? '')}</span></td>
      <td class="num">${a.mean ?? '—'}</td>
      <td>${spread(a.values)}</td>
      <td class="num ${a.advanced ? 'gain' : 'dim'}">${a.advanced ? '+' + a.advanced : '0'}</td>
      <td class="num ${a.atrophied ? 'loss' : 'dim'}">${a.atrophied ? '−' + a.atrophied : '0'}</td>
      <td class="num ${a.decayed ? 'bad' : 'dim'}" title="characters standing below their own best in this ability">${a.decayed}</td>
    </tr>`).join('');

  const perChar = f.by_character.map(c => `
    <tr>
      <td class="name"><a class="hero" href="/hero/${encodeURIComponent(c.character)}">${esc(c.character)}</a></td>
      <td class="num">${c.skills}</td>
      <td class="num">${c.spells}</td>
      <td class="num"><b>${c.best ?? '—'}</b></td>
      <td class="num">${c.total_ability}</td>
      <td class="num ${c.advanced ? 'gain' : 'dim'}">${c.advanced ? '+' + c.advanced : '0'}</td>
      <td class="num ${c.atrophied ? 'loss' : 'dim'}">${c.atrophied ? '−' + c.atrophied : '0'}</td>
      <td class="num ${c.advanced - c.atrophied > 0 ? 'good' : c.advanced - c.atrophied < 0 ? 'bad' : 'dim'}">${
        c.advanced - c.atrophied > 0 ? '+' : ''}${c.advanced - c.atrophied}</td>
      <td class="dim">${esc(ago(c.read_at))}</td>
    </tr>`).join('');

  // EVERY NUMBER, PER CHARACTER, because the sheet above is per ability and the question
  // "what is Kermit actually good at" is per character. Chips rather than a matrix: a
  // twenty-one column table is unreadable on a phone and this is the same data.
  const books = f.by_character.map(c => {
    const mine = f.abilities
      .map(a => ({ a, h: a.held.find(h => h.character === c.character) }))
      .filter(x => x.h && x.h.ability != null)
      .sort((x, y) => y.h.ability - x.h.ability);
    if (!mine.length) return '';
    return `
    <div class="card">
      <div class="k">${heroLink(c.character)}</div>
      <div class="chips" style="margin-top:.4rem">${mine.map(({ a, h }) => `
        <span class="chip ${h.decayed ? 'decayed' : ''}" title="${esc(a.name)}${
          h.decayed ? ` — peaked at ${h.best}, so this one has decayed` : ''}"><b>${h.ability}</b> ${esc(a.name)}${
          h.decayed ? ` <span style="opacity:.7">↓${h.best - h.ability}</span>` : ''}</span>`).join('')}
      </div>
    </div>`;
  }).join('');

  const recent = f.recent.slice(0, 80).map(c => `
    <tr>
      <td class="dim">${esc(ago(c.at))}</td>
      <td>${heroLink(c.character)}</td>
      <td class="dim">${esc(c.kind)}</td>
      <td>${lore(c.name)}</td>
      <td class="num">${c.from ?? '?'} → <b class="${c.by > 0 ? 'gain' : 'loss'}">${c.to ?? '?'}</b></td>
      <td>${c.by > 0
            ? `<span class="pill obs">+${c.by}</span>`
            : `<span class="pill inf" title="what you stop using decays when the advancement window rolls over">atrophy −${-c.by}</span>`}</td>
    </tr>`).join('');

  const nothingYet = !f.characters;

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Skills &amp; spells — ${esc(FLEET_LABEL)} fleet</title>
<meta http-equiv="refresh" content="60">
<style>${STYLE}${EXTRA_STYLE}</style>
</head><body><div class="wrap">
  <h1>Skills &amp; spells</h1>
  <div class="sub">Every ability number the fleet holds, and what moved in the last
    ${hours}h · ${esc(FLEET_LABEL)} fleet</div>
  ${NAV('skills')}

  <div class="cards">
    <div class="card"><div class="k">characters</div><div class="v">${f.characters}</div>
      <div class="n">with a book on disk</div></div>
    <div class="card"><div class="k">skills</div><div class="v">${f.skills}</div>
      <div class="n">distinct, across the fleet</div></div>
    <div class="card"><div class="k">spells</div><div class="v">${f.spells}</div>
      <div class="n">distinct, across the fleet</div></div>
    <div class="card"><div class="k">points gained</div><div class="v good">+${f.advanced}</div>
      <div class="n">${f.changes_recorded} recorded change(s)</div></div>
    <div class="card"><div class="k">points decayed</div><div class="v ${f.atrophied ? 'bad' : 'dim'}">−${f.atrophied}</div>
      <div class="n">silently — nothing announces atrophy</div></div>
    <div class="card"><div class="k">net</div>
      <div class="v ${f.net > 0 ? 'good' : f.net < 0 ? 'bad' : 'dim'}">${f.net > 0 ? '+' : ''}${f.net}</div>
      <div class="n">read the two columns beside it, not this</div></div>
  </div>

  ${nothingYet ? `
  <div class="panel"><div class="caveat">
    <b>No book on disk yet.</b> The broker writes one file per character under
    <code>substrate/abilities/</code> after it logs in and reads the two ability groups
    once. Nothing here can be backfilled from the ledger: it records levels, not skills.
  </div></div>` : `
  <div class="panel">
    <div class="facets">
      <button data-facet="gained" class="on">What advanced</button>
      <button data-facet="who">Who advanced</button>
      <button data-facet="lost">What decayed</button>
      <button id="tm-back" style="display:none">← all</button>
    </div>
    <svg id="tm"></svg>
    <div class="caveat" id="facet-note"></div>
  </div>

  <h2>The ability sheet</h2>
  <div class="sub">One row per ability, every character's number in the spread — drawn
    against a fixed 0–100, not against the fleet's own best, so a fleet that is uniformly
    poor looks it. Rows tinted red gained nothing and lost something: those are on their
    way back to zero. Names link to the compendium.</div>
  <div class="panel scroller sheet" style="padding:.25rem .5rem">
  <table>
    <thead><tr><th>ability</th><th>kind</th><th class="num">held by</th>
      <th class="num">best</th><th class="num">mean</th><th>spread</th>
      <th class="num">gained</th><th class="num">decayed</th>
      <th class="num" title="characters currently below their own peak in this ability">below peak</th></tr></thead>
    <tbody>${sheet}</tbody>
  </table>
  </div>

  <h2>By character</h2>
  <div class="panel scroller" style="padding:.25rem .5rem">
  <table>
    <thead><tr><th>character</th><th class="num">skills</th><th class="num">spells</th>
      <th class="num">best</th><th class="num">total</th>
      <th class="num">gained</th><th class="num">decayed</th><th class="num">net</th>
      <th title="the safety-net refresh, not the truth — every change is pushed, so a book read an hour ago is still current">last full read</th></tr></thead>
    <tbody>${perChar}</tbody>
  </table>
  </div>

  <h2>Every number</h2>
  <div class="sub">What each character holds right now, best first. An orange chip has
    decayed from its own peak and says by how much.</div>
  <div class="cards">${books}</div>

  <h2>What moved</h2>
  <div class="sub">Newest first. These arrive as pushes — one packet per change — so the
    list is the changes themselves rather than a diff of two readings.</div>
  <div class="panel scroller" style="padding:.25rem .5rem">
  <table>
    <thead><tr><th>when</th><th>who</th><th>kind</th><th>ability</th>
      <th class="num">was → is</th><th>what</th></tr></thead>
    <tbody>${recent || '<tr><td colspan="6" class="empty">nothing has moved in this window</td></tr>'}</tbody>
  </table>
  </div>`}

  <div class="caveat" style="margin-top:1.5rem">${esc(f.read_this_way)}</div>
</div>
${nothingYet ? '' : `<script>
var FACETS = ${JSON.stringify(FACETS)};
${TREEMAP_JS}
${FACET_WIRING_JS}
pickFacet('gained');
</script>`}
</body></html>`;
}
