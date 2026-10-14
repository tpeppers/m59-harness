// /faction — WHO IN THE FLEET SERVES WHOM, HOW HIGH, AND WHAT IT IS WORTH TO THEM RIGHT NOW.
//
// Three caches, none of them live, all of them evidence:
//
//   substrate/faction-status/<Character>.json   membership, soldier, loyalty clock (m59-faction-status.mjs)
//   substrate/faction-intel.jsonl               everything overheard about the struggle (m59-faction-intel.mjs)
//   the roster                                  which characters are ours, and which server
//
// The server never reports faction power, so the power table is an ESTIMATE with its blind
// spot printed beside it: a flag nobody has seen claimed is unknown, not neutral, and the
// range runs from "only what we saw" to "every unseen flag and councilor theirs". A rumour,
// when one has been heard, is the server's own band and outranks the arithmetic.
//
// "Personal strength" is parlia.kod's Effects Part — spell power, learn chance, to-hit,
// defense, regen, vigor, prices, damage. Factions grant NO attribute points; nothing in the
// kod touches a stat. Expected values assume the character is INTRIGUING (PK switch on and 40
// base health) and that the faction is not over-subscribed: the server also scales by member
// count, which no client can see, down to a quarter at worst.

import { FactionStatusCache } from './m59-faction-status.mjs';
import { readIntelRows, foldIntel, estimatePower, benefitValue, BENEFITS, POWER_BANDS,
         FACTIONS, FLAG_COUNT, COUNCILORS, INTEL_FILE } from './m59-faction-intel.mjs';
import { loyaltyDebt } from './m59-factions.mjs';
import { esc, ago, NAV, STYLE } from './m59-page-chrome.mjs';

const NAMES = { duke: 'Duke', princess: 'Princess', rebel: 'Rebel', neutral: 'Unfactioned', unknown: 'Unknown' };
const COLOURS = { duke: '#c0392b', princess: '#8e44ad', rebel: '#27ae60', neutral: 'var(--dim)', unknown: 'var(--dim)' };
// soldshld.kod rank bands; a fresh shield is rank 4, the top is 10, one rank per enemy troop.
const RANK_MIN = { 'a lowly peon': 1, 'an average soldier': 3, 'a notable fighter': 5, 'a great warrior': 7, 'a supreme hero': 9 };

/**
 * @param characters [{ agent, character }] — the fleet, from the roster
 * @param server     "host:port" the roster plays on, to keep two servers' intel apart
 */
export function factionReport({ characters = [], server = null, statusDir = 'substrate/faction-status',
                                intelFile = INTEL_FILE, now = Date.now() } = {}) {
  const cache = new FactionStatusCache({ dir: statusDir, now: () => now });
  const rows = readIntelRows({ file: intelFile, server, now });
  const state = foldIntel(rows);
  const power = estimatePower(state);

  const people = characters.map(({ agent, character }) => {
    const st = character ? cache.read(character) : null;
    const faction = st?.faction ?? 'unknown';
    const rank = state.ranks[character] ?? state.ranks[agent] ?? null;
    const lo = RANK_MIN[rank?.title];
    const p = power.factions[faction];
    const benefits = ['duke', 'princess', 'rebel', 'neutral'].includes(faction)
      ? BENEFITS.map(b => {
          const low = benefitValue(b, faction, { contribution: p.contribution[0] });
          if (!low) return null;
          const high = benefitValue(b, faction, { contribution: p.contribution[1] });
          return { kind: b.kind, label: b.label, unit: b.unit, on: b.applies[faction],
                   low: low.value, high: high.value, max: low.max, flat: b.flat ?? null };
        }).filter(Boolean)
      : [];
    return {
      agent, character, faction, soldier: st?.soldier === true, observed_at: st?.observed_at ?? null,
      loyalty: st?.loyalty ?? null, debt: st ? loyaltyDebt(st, now) : null,
      rank, kills_to_max: lo ? { min: Math.max(0, 9 - (lo + 1)), max: Math.max(0, 9 - lo) } : null,
      measured: state.bonuses[character] ?? state.bonuses[agent] ?? {},
      benefits,
    };
  });

  const counts = Object.fromEntries([...FACTIONS, 'unknown'].map(f => [f, people.filter(x => x.faction === f).length]));
  return { now, server, rows: rows.length, state, power, people, counts,
           soldiers: people.filter(x => x.soldier).length };
}

const range = (a, b, unit = '') => a === b ? `${a}${unit}` : `${a}–${b}${unit}`;
const badge = f => `<span class="fbadge" style="--c:${COLOURS[f] ?? 'var(--dim)'}">${esc(NAMES[f] ?? f)}</span>`;

export function renderFaction(opts = {}) {
  const r = opts.report ?? factionReport(opts);
  const { power, state } = r;

  const cards = ['duke', 'princess', 'rebel', 'neutral', 'unknown'].map(f =>
    `<div class="card"><div class="k">${esc(NAMES[f])}</div><div class="v" style="color:${COLOURS[f]}">${r.counts[f]}</div>` +
    `<div class="n">${f === 'unknown' ? 'never observed' : 'characters'}</div></div>`).join('') +
    `<div class="card"><div class="k">Soldiers</div><div class="v">${r.soldiers}</div><div class="n">wearing a shield</div></div>` +
    `<div class="card"><div class="k">Power shift</div><div class="v sm">${esc(ago(state.shifts.at(-1)))}</div><div class="n">${state.shifts.length} heard</div></div>`;

  const powerRows = ['duke', 'princess', 'rebel', 'neutral'].map(f => {
    const p = power.factions[f];
    const band = p.band[0] === p.band[1] ? POWER_BANDS[p.band[0]] : `${POWER_BANDS[p.band[0]]} … ${POWER_BANDS[p.band[1]]}`;
    const rumour = p.rumour ? `<b>${esc(POWER_BANDS[p.rumour.band])}</b> <span class="dim">${esc(ago(p.rumour.at))}</span>` : '<span class="dim">none heard</span>';
    return `<tr><td>${badge(f)}</td><td class="num">${p.flags}</td><td class="num">${p.councilors}</td>
      <td class="num">${range(p.points[0], p.points[1])}</td><td>${esc(band)}</td>
      <td class="num">${range(p.contribution[0], p.contribution[1], '%')}</td><td>${rumour}</td></tr>`;
  }).join('');

  const flagRows = Object.entries(state.flags).sort((a, b) => b[1].at - a[1].at).map(([place, v]) =>
    `<tr><td>${esc(place)}</td><td>${badge(v.holder)}</td><td class="dim">${esc(ago(v.at))}</td></tr>`).join('');
  const conRows = COUNCILORS.map(c => {
    const v = state.councilors[c];
    return `<tr><td>${esc(c)}</td><td>${v ? badge(v.faction) : '<span class="dim">unknown</span>'}</td>` +
      `<td class="dim">${esc(v?.strength ?? '')}</td><td class="dim">${v ? esc(ago(v.at)) : ''}</td></tr>`;
  }).join('');
  const tokenRows = state.tokens.slice(-10).reverse().map(t =>
    `<tr><td>${esc(t.token)}</td><td class="dim">${esc(ago(t.at))}</td></tr>`).join('');

  const personRows = r.people.map(x => {
    const rank = x.rank
      ? `${esc(x.rank.title)}${x.kills_to_max ? ` <span class="dim">· ${range(x.kills_to_max.min, x.kills_to_max.max)} to max</span>` : ''}` +
        `<div class="dim small">read ${esc(ago(x.rank.at))}</div>`
      : (x.soldier ? '<span class="dim">not read</span>' : '');
    const l = x.loyalty;
    let favour = '';
    if (l?.served_at) favour = `served ${esc(ago(l.served_at))}`;
    if (x.debt) favour += `${favour ? '<br>' : ''}<span class="${x.debt.soldier ? 'dim' : 'bad'}">asked ${esc(ago(x.debt.warned_at))}` +
      `${x.debt.due_in_ms != null ? `, due in ${Math.max(0, Math.round(x.debt.due_in_ms / 60000))} min` : ' (a soldier is never expelled)'}</span>`;
    if (l?.lost_at) favour += `${favour ? '<br>' : ''}<span class="bad">expelled ${esc(ago(l.lost_at))}</span>`;
    if (!favour && x.faction !== 'neutral' && x.faction !== 'unknown') favour = '<span class="dim">no service seen</span>';
    const strength = x.benefits.filter(b => b.max != null).map(b => {
      const m = x.measured[b.kind];
      const hint = m ? ` <span class="${m.last === 'up' ? 'good' : 'bad'}" title="${m.up} up, ${m.down} down, last ${esc(ago(m.last_at))}">${m.last === 'up' ? '▲' : '▼'}</span>` : '';
      return `<span class="ben">${esc(b.label)} <b>${range(b.low, b.high)}</b><span class="dim">/${b.max}${esc(b.unit)}</span>${hint}</span>`;
    }).join(' ');
    return `<tr><td><b>${esc(x.character ?? x.agent)}</b> <span class="dim">${esc(x.agent)}</span></td><td>${badge(x.faction)}</td>
      <td>${x.soldier ? '🛡' : ''}</td><td>${rank}</td><td>${favour}</td><td class="strength">${strength}</td>
      <td class="dim">${esc(ago(x.observed_at))}</td></tr>`;
  }).join('');

  const benefitRows = BENEFITS.map(b => `<tr><td>${esc(b.label)}</td>` + ['duke', 'princess', 'rebel', 'neutral'].map(f => {
    if (!b.applies[f]) return '<td class="dim">—</td>';
    const p = power.factions[f];
    const lo = benefitValue(b, f, { contribution: p.contribution[0] });
    const hi = benefitValue(b, f, { contribution: p.contribution[1] });
    const v = b.base == null ? (b.fixed == null ? 'yes' : `${b.fixed}${b.unit}`)
      : `<b>${range(lo.value, hi.value)}</b><span class="dim">/${lo.max}${esc(b.unit)}</span>`;
    return `<td>${v}<div class="dim small">${esc(b.applies[f])}</div></td>`;
  }).join('') + '</tr>').join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Factions</title>
<style>${STYLE}
  .bad { color:var(--bad); } .good { color:var(--good); } .dim { color:var(--dim); } .small { font-size:.75rem; }
  .card .v.sm { font-size:1.1rem; }
  table { border-collapse:collapse; width:100%; font-size:.85rem; }
  th { text-align:left; color:var(--dim); font-weight:500; font-size:.75rem; text-transform:uppercase;
       letter-spacing:.04em; border-bottom:1px solid var(--line); padding:.3rem .5rem; }
  td { padding:.28rem .5rem; border-bottom:1px solid var(--line); vertical-align:top; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .tablewrap { overflow-x:auto; }
  .fbadge { display:inline-block; font-size:.72rem; font-weight:600; padding:.05rem .5rem; border-radius:999px;
            border:1px solid var(--c); color:var(--c); white-space:nowrap; }
  .ben { display:inline-block; margin:0 .6rem .15rem 0; white-space:nowrap; font-size:.8rem; }
  td.strength { min-width:260px; }
  .cols { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:1.25rem; }
  @media (max-width:600px) { body { padding:1rem 16px 3rem; } }
</style></head><body><div class="wrap">
${NAV('faction')}
<h1>Factions</h1>
<div class="sub">The fleet's cached faction standing, and an estimate of each faction's power on the server built from
  everything the fleet has overheard (${r.rows} sightings${r.server ? ` on ${esc(r.server)}` : ''}). Nothing here is read live.</div>
<div class="cards">${cards}</div>

<h2>Characters</h2>
<div class="tablewrap"><table>
<tr><th>Character</th><th>Faction</th><th>Soldier</th><th>Rank</th><th>Last favour</th><th>Personal strength (expected/max)</th><th>Observed</th></tr>
${personRows || '<tr><td colspan="7" class="dim">No roster.</td></tr>'}
</table></div>
<div class="caveat">Rank is the shield's own band (rank 1–10 in pairs, a fresh shield is 4), read when
  <code>max-faction-shield</code> inspects it; kills to max count one rank per enemy troop. "Last favour" is the liege's loyalty
  service: when one was seen completed, and any request still open. Strength is the faction's bonus at the estimated power
  below, if the character is intriguing (PK switch on, 40+ base health) — otherwise a small flat bonus. ▲/▼ is the server's own
  1-in-101 hint that the bonus is currently positive or not. Factions give no attribute points.</div>

<h2>Server power (estimated)</h2>
<div class="tablewrap"><table>
<tr><th>Faction</th><th>Flags seen</th><th>Councilors</th><th>Points of 2000</th><th>Band (estimate)</th><th>Bonus scale</th><th>Rumour heard</th></tr>
${powerRows}
</table></div>
<div class="caveat">Two games of 1000 points each (parlia.kod): territory, split by flags held across ${FLAG_COUNT} flagpoles,
  and the council, split by which way five councilors lean after token returns. ${power.seen_flags} of ${FLAG_COUNT} flags and
  ${power.seen_councilors} of ${COUNCILORS.length} councilors have been seen, so each range runs from "only what we saw" to
  "every unseen one is theirs". A balanced faction holds 500; the bonus scale is the power half of the server's formula
  (−10% to 150% of normal) and the server further cuts it for a faction with too many active members.</div>

<div class="cols">
<div><h2>Flags</h2><div class="tablewrap"><table><tr><th>Place</th><th>Held by</th><th>Seen</th></tr>
${flagRows || '<tr><td colspan="3" class="dim">No claim heard yet.</td></tr>'}</table></div></div>
<div><h2>Council</h2><div class="tablewrap"><table><tr><th>Councilor</th><th>Leans</th><th></th><th>Seen</th></tr>
${conRows}</table></div>
<h2>Token returns</h2><div class="tablewrap"><table><tr><th>Token</th><th>When</th></tr>
${tokenRows || '<tr><td colspan="2" class="dim">None heard.</td></tr>'}</table></div></div>
</div>

<h2>What each faction grants</h2>
<div class="tablewrap"><table>
<tr><th>Benefit</th><th>${badge('duke')}</th><th>${badge('princess')}</th><th>${badge('rebel')}</th><th>${badge('neutral')}</th></tr>
${benefitRows}
</table></div>
<div class="caveat">Expected at the estimated power / the most the formula allows (150% of normal; unfactioned get a quarter).</div>
</div></body></html>`;
}
