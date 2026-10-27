// FLEET-WIDE MAXIMUMS AND COMBOS: WHAT THE FLEET CAN CAST BETWEEN ALL OF ITS CHARACTERS.
//
//   /maximums on the dashboard port; ?format=json for the report.
//
// Three checklists, one question each, and every box names the characters that tick it:
//
//   1. EVERY SPELL. Does anybody in the fleet know it, or plan to? The catalogue is the one
//      the planner learns from (compendium/data/planner.json), so "every spell in the game"
//      means every spell a character can actually be taught.
//   2. EVERY POTION. Distill (Jala 3) bottles a spell, but only one the DISTILLER knows: it
//      reads the caster's own ability in the target spell and refuses with "You have no
//      knowledge of %s" otherwise (distill.kod PerformDistill / CastSpell). So a potion is
//      only makeable by a character holding BOTH spells, and the box is about one body, not
//      the fleet's union. Which spells can be bottled is the kod's GetPotionClass answer,
//      compiled into substrate/m59-spells.json as `potion` by m59-spells.mjs.
//   3. EVERY PRISM SPELL. A multicast spell (MultiCastSpell, multicst.kod) is cast by several
//      characters focusing on a prism in the room. The operator's bar is THREE casters each;
//      the kod's own design note is five contributing three a second, so three is the floor
//      worth planning for, not a guarantee the cast completes in good time.
//
// A PLAN IS HALF A BOX, NEVER A WHOLE ONE. Known and planned render differently everywhere on
// this page, for the same reason the party page draws observed and planned apart: a fleet that
// plans every prism spell and knows none of them cannot cast any of them today.
//
// WHERE THE ANSWERS COME FROM, AND WHY NOTHING HERE ASKS THE SERVER. Known spells are the
// keeper's own book, substrate/abilities/<character>.json, written from the server's pushes
// (the same file /skills reads). Plans are substrate/loadouts/<character>.json, expanded by
// the same plannedAbilities() the learning errand buys from — so "planned" here means "the
// keeper will try to buy it", including the cross-school refusal. Twenty-one characters asked
// live would be eighty-four requests per page load.
import { readFileSync } from 'node:fs';
import { esc, NAV, STYLE } from './m59-page-chrome.mjs';
import { compendiumBase } from './m59-compendium-links.mjs';
import { lore } from './m59-dashboard.mjs';
import { loadBook } from './m59-abilities.mjs';
import { loadoutFor, plannedAbilities } from './m59-loadout.mjs';
import { loadSpells } from './m59-spells.mjs';

export const PRISM_CASTERS = 3;
const SCHOOL_ORDER = ['Shal’ille', 'Qor', 'Kraanan', 'Faren', 'Riija', 'Jala'];

// "Kara'hol's curse" on the wire, "karahols curse" from the SID constant: one key for both.
export const spellKey = s => String(s ?? '').toLowerCase().replace(/['’]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

function plannerSpells() {
  try {
    const j = JSON.parse(readFileSync(new URL('../compendium/data/planner.json', import.meta.url), 'utf8'));
    return (j.spells || []).map(s => ({ ...s, kind: 'spell' }));
  } catch { return []; }
}

// The keeper's book keys spells by their wire name; an unresolved resource shows as
// "<rsc 27099>" and names nothing anybody could check, so it is left out rather than guessed.
function bookSpells(character) {
  const book = loadBook(character) || {};
  return Object.keys(book.spells || {}).filter(n => !n.startsWith('<'));
}

// Everything is injectable so the test can hand in a fleet; the defaults read this machine.
export function maximumsReport({
  characters = [],
  catalogue = plannerSpells(),
  kod = (() => { try { return loadSpells().spells || []; } catch { return []; } })(),
  knownOf = bookSpells,
  planOf = c => loadoutFor(c)?.plan ?? null,
} = {}) {
  const bySpell = new Map(catalogue.map(s => [spellKey(s.name), s]));
  const fleet = characters.map(({ agent = null, character }) => {
    const known = new Set((knownOf(character) || []).map(spellKey));
    // School on the known rows so the cross-school guard sees what this character casts.
    const knownRows = [...known].map(k => ({ name: bySpell.get(k)?.name ?? k, kind: 'spell',
      school: bySpell.get(k)?.school ?? null }));
    const plan = planOf(character);
    const planned = new Set();
    if (plan) for (const row of plannedAbilities(plan, catalogue, knownRows))
      if (row.kind === 'spell' && !known.has(spellKey(row.name))) planned.add(spellKey(row.name));
    return { agent, character, known, planned, has_plan: !!plan };
  });

  const access = key => ({
    known: fleet.filter(c => c.known.has(key)).map(c => c.character),
    planned: fleet.filter(c => c.planned.has(key)).map(c => c.character),
  });
  const verdict = (known, reach) => known ? 'yes' : reach ? 'planned' : 'no';

  // ---- 1. every spell
  const spells = catalogue.map(s => {
    const a = access(spellKey(s.name));
    return { name: s.name, school: s.school, level: s.level, ...a,
             status: verdict(a.known.length > 0, a.planned.length > 0) };
  }).sort((a, b) => SCHOOL_ORDER.indexOf(a.school) - SCHOOL_ORDER.indexOf(b.school) ||
    a.level - b.level || a.name.localeCompare(b.name));

  // ---- 2. every potion: one body holding distill AND the spell
  const DISTILL = spellKey('distill');
  const distill = access(DISTILL);
  const potions = kod.filter(s => s.potion).map(s => {
    const key = spellKey(s.name), cat = bySpell.get(key);
    const brewers = [];
    for (const c of fleet) {
      const d = c.known.has(DISTILL) ? 'known' : c.planned.has(DISTILL) ? 'planned' : null;
      const p = c.known.has(key) ? 'known' : c.planned.has(key) ? 'planned' : null;
      if (d && p) brewers.push({ character: c.character,
        how: d === 'known' && p === 'known' ? 'known' : 'planned', distill: d, spell: p });
    }
    const a = access(key);
    return { name: cat?.name ?? s.name, potion: s.potion, school: cat?.school ?? s.school_name,
             level: cat?.level ?? s.level, brewers,
             // Who has the spell but not distill: the cheapest way to tick the box.
             spell_only: [...a.known.map(character => ({ character, how: 'known' })),
                          ...a.planned.map(character => ({ character, how: 'planned' }))]
               .filter(x => !brewers.some(b => b.character === x.character)),
             status: verdict(brewers.some(b => b.how === 'known'), brewers.length > 0) };
  }).sort((a, b) => a.name.localeCompare(b.name));

  // ---- 3. every prism spell: at least PRISM_CASTERS bodies
  const prism = kod.filter(s => s.multicast).map(s => {
    const key = spellKey(s.name), cat = bySpell.get(key), a = access(key);
    return { name: cat?.name ?? s.name, school: cat?.school ?? s.school_name, level: cat?.level ?? s.level,
             ...a, need: PRISM_CASTERS,
             status: verdict(a.known.length >= PRISM_CASTERS, a.known.length + a.planned.length >= PRISM_CASTERS) };
  }).sort((a, b) => a.name.localeCompare(b.name));

  const tally = rows => ({ total: rows.length, yes: rows.filter(r => r.status === 'yes').length,
                           planned: rows.filter(r => r.status === 'planned').length });
  return {
    characters: fleet.map(c => ({ agent: c.agent, character: c.character, known: c.known.size,
                                  planned: c.planned.size, has_plan: c.has_plan })),
    spells, potions, distill, prism, prism_casters: PRISM_CASTERS,
    summary: { spells: tally(spells), potions: tally(potions), prism: tally(prism) },
  };
}

// ------------------------------------------------------------------ the page

const BOX = { yes: '<span class="box yes" title="known">✓</span>',
              planned: '<span class="box half" title="planned only">½</span>',
              no: '<span class="box no" title="nobody"></span>' };
const who = (known, planned) => [
  ...known.map(n => `<span class="who k">${esc(n)}</span>`),
  ...planned.map(n => `<span class="who p" title="planned, not yet learned">${esc(n)} <i>plan</i></span>`),
].join(' ') || '<span class="dim">nobody</span>';

function card(label, t, extra = '') {
  return `<div class="card"><div class="k">${esc(label)}</div>
    <div class="v">${t.yes}<span class="dim">/${t.total}</span></div>
    <div class="n">${t.planned ? `+${t.planned} planned only` : 'nothing planned beyond that'}${extra}</div></div>`;
}

export function renderMaximums(opts = {}) {
  const r = opts.report ?? maximumsReport(opts);
  const party = `${compendiumBase()}/party/index.html`;
  const partyLink = (text = 'party page') =>
    `<a href="${esc(party)}" target="_blank" rel="noopener">${esc(text)}</a>`;
  const s = r.summary;

  const bySchool = new Map();
  for (const sp of r.spells) {
    if (!bySchool.has(sp.school)) bySchool.set(sp.school, []);
    bySchool.get(sp.school).push(sp);
  }
  const spellSections = [...bySchool].map(([school, rows]) => {
    const yes = rows.filter(x => x.status === 'yes').length;
    const half = rows.filter(x => x.status === 'planned').length;
    return `<details class="school"${yes + half < rows.length ? ' open' : ''}>
<summary><b>${esc(school)}</b> <span class="dim">${yes}/${rows.length} known${half ? `, ${half} planned only` : ''}</span></summary>
<div class="tablewrap"><table>
<tr><th></th><th>Spell</th><th class="num">Lvl</th><th>Has access via</th></tr>
${rows.map(x => `<tr class="${x.status}"><td>${BOX[x.status]}</td><td>${lore(x.name)}</td>
  <td class="num">${esc(x.level)}</td><td>${who(x.known, x.planned)}</td></tr>`).join('\n')}
</table></div></details>`;
  }).join('\n');

  const potionRows = r.potions.map(x => {
    const brew = x.brewers.map(b => b.how === 'known'
      ? `<span class="who k">${esc(b.character)}</span>`
      : `<span class="who p" title="distill ${esc(b.distill)}, ${esc(x.name)} ${esc(b.spell)}">${esc(b.character)} <i>plan</i></span>`)
      .join(' ') || '<span class="dim">nobody</span>';
    const near = x.spell_only.length
      ? `<div class="dim small">has the spell, not distill: ${x.spell_only.map(o =>
        esc(o.character) + (o.how === 'planned' ? ' (plan)' : '')).join(', ')}</div>` : '';
    return `<tr class="${x.status}"><td>${BOX[x.status]}</td><td>${lore(x.name)}</td>
  <td class="dim">${esc(x.school)} ${esc(x.level)}</td><td>${brew}${near}</td></tr>`;
  }).join('\n');

  const pips = x => {
    const k = Math.min(x.known.length, x.need);
    const p = Math.min(x.planned.length, x.need - k);
    return `<span class="pips" title="${x.known.length} know it, ${x.planned.length} plan it, ${x.need} needed">` +
      '<i class="k"></i>'.repeat(k) + '<i class="p"></i>'.repeat(p) + '<i></i>'.repeat(x.need - k - p) +
      `</span> <span class="dim small">${x.known.length}${x.planned.length ? `+${x.planned.length}` : ''}/${x.need}</span>`;
  };
  const prismRows = r.prism.map(x => `<tr class="${x.status}"><td>${BOX[x.status]}</td><td>${lore(x.name)}</td>
  <td class="dim">${esc(x.school)} ${esc(x.level)}</td><td>${pips(x)}</td><td>${who(x.known, x.planned)}</td></tr>`).join('\n');

  const noPlans = r.characters.filter(c => !c.has_plan).length;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fleet Maximums</title>
<style>${STYLE}
  .dim { color:var(--dim); } .small { font-size:.75rem; }
  table { border-collapse:collapse; width:100%; font-size:.85rem; }
  th { text-align:left; color:var(--dim); font-weight:500; font-size:.75rem; text-transform:uppercase;
       letter-spacing:.04em; border-bottom:1px solid var(--line); padding:.3rem .5rem; }
  td { padding:.28rem .5rem; border-bottom:1px solid var(--line); vertical-align:top; }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  td:first-child { width:1.8rem; }
  .tablewrap { overflow-x:auto; }
  a { color:var(--accent); }
  .box { display:inline-flex; align-items:center; justify-content:center; width:1.1rem; height:1.1rem;
         border-radius:4px; border:1.5px solid var(--line); font-size:.75rem; font-weight:700; line-height:1; }
  .box.yes { background:var(--good); border-color:var(--good); color:#fff; }
  .box.half { border-color:var(--edge); color:var(--edge);
              background:linear-gradient(135deg, color-mix(in srgb, var(--edge) 30%, transparent) 50%, transparent 50%); }
  tr.no td:nth-child(2) { color:var(--dim); }
  .who { display:inline-block; font-size:.78rem; padding:.02rem .45rem; margin:0 .2rem .15rem 0;
         border-radius:999px; border:1px solid var(--good); color:var(--fg); white-space:nowrap; }
  .who.p { border-style:dashed; border-color:var(--edge); color:var(--dim); }
  .who i { font-style:normal; font-size:.65rem; color:var(--edge); text-transform:uppercase; letter-spacing:.04em; }
  .pips { display:inline-flex; gap:3px; vertical-align:middle; }
  .pips i { width:.85rem; height:.85rem; border-radius:50%; border:1.5px solid var(--line); display:block; }
  .pips i.k { background:var(--good); border-color:var(--good); }
  .pips i.p { border-color:var(--edge);
              background:linear-gradient(90deg, var(--edge) 50%, transparent 50%); }
  details.school { background:var(--panel); border:1px solid var(--line); border-radius:10px;
                   padding:.5rem .9rem; margin-bottom:.6rem; }
  details.school summary { cursor:pointer; padding:.2rem 0; }
  .legend { display:flex; gap:1.1rem; flex-wrap:wrap; font-size:.8rem; color:var(--dim); margin:.25rem 0 1rem; align-items:center; }
  @media (max-width:600px) { body { padding:1rem 16px 3rem; } }
</style></head><body><div class="wrap">
${NAV('maximums')}
<h1>Fleet-wide maximums &amp; combos</h1>
<div class="sub">What the fleet can cast between all of its ${r.characters.length} characters, and what it is
  planning to. Known spells are each keeper's own ability book; plans are the loadouts the ${partyLink()} writes,
  expanded exactly as the learning errand will buy them.${noPlans ? ` ${noPlans} character${noPlans === 1 ? ' has' : 's have'} no plan saved.` : ''}</div>
<div class="cards">
  ${card('Spells covered', s.spells)}
  ${card('Potions makeable', s.potions)}
  ${card(`Prism spells (${r.prism_casters}+ casters)`, s.prism)}
</div>
<div class="legend"><span>${BOX.yes} somebody knows it</span><span>${BOX.planned} only planned — half a box</span>
  <span>${BOX.no} nobody</span><span><span class="who k">Name</span> knows</span>
  <span><span class="who p">Name <i>plan</i></span> plans it</span></div>

<h2>1. Combined spells — every spell, anybody in the fleet</h2>
<div class="sub">Every spell a character can be taught (the planner's catalogue, ${s.spells.total} of them), grouped by school.
  A school with every box ticked starts folded.</div>
${spellSections || '<div class="dim">No spell catalogue on this machine (compendium/data/planner.json).</div>'}

<h2>2. Distillable spells — potions the fleet can make</h2>
<div class="sub">Distill (Jala 3) bottles a spell the <em>distiller</em> knows, so each box needs one character holding
  both — and the potion keeps for ever. Distill itself:
  ${who(r.distill.known, r.distill.planned)}. Plan it for somebody on the ${partyLink()}.</div>
<div class="tablewrap"><table>
<tr><th></th><th>Spell</th><th>School</th><th>Has access via (distill + spell, one character)</th></tr>
${potionRows || '<tr><td colspan="4" class="dim">No distillable spells in substrate/m59-spells.json — rebuild it with m59-spells.mjs build.</td></tr>'}
</table></div>

<h2>3. Prism spells — at least ${r.prism_casters} casters each</h2>
<div class="sub">A multicast spell is cast by several characters focusing on a prism in the same room. Green
  pips know it, half pips plan it; the box is full at ${r.prism_casters} who know it and half when plans make up the rest.</div>
<div class="tablewrap"><table>
<tr><th></th><th>Spell</th><th>School</th><th>Casters</th><th>Has access via</th></tr>
${prismRows || '<tr><td colspan="5" class="dim">No multicast spells in substrate/m59-spells.json — rebuild it with m59-spells.mjs build.</td></tr>'}
</table></div>
</div></body></html>`;
}
