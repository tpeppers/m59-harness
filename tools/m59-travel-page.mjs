import { readLedger } from './m59-ledger.mjs';
import { listCharacters, loadBook } from './m59-transits.mjs';
import { resolveFleet } from './m59-fleetpath.mjs';
import { esc, NAV, STYLE, num } from './m59-page-chrome.mjs';
import { travelSummary, TRAVEL_METHODS } from './m59-travel-summary.mjs';

const duration = ms => ms == null ? '—' : ms < 60000 ? `${(ms / 1000).toFixed(1)}s`
  : ms < 3600000 ? `${(ms / 60000).toFixed(1)}m` : `${(ms / 3600000).toFixed(1)}h`;
const cell = value => `<td class="num">${esc(value)}</td>`;

export function renderTravel({ hours = 24, characters = null, sort = 'crossings', data = null } = {}) {
  const ledger = data ? null : readLedger({ sinceMs: hours * 3600000 });
  const report = data ?? travelSummary({ ...ledger, characters, since: Date.now() - hours * 3600000,
    books: listCharacters().map(loadBook).filter(b => !characters || characters.has(b.character)) });
  const sorts = { crossings: 'Most traveled', issues: 'Most crossing issues', collisions: 'Most collision refusals',
    stuck_ms: 'Most time stuck', issue_rate: 'Highest issue rate' };
  if (!Object.hasOwn(sorts, sort)) sort = 'crossings';
  const maps = [...report.maps].sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1) || b.crossings - a.crossings);
  const total = key => report.characters.reduce((s, r) => s + r[key], 0);
  const highest = key => [...report.maps].filter(r => r[key] > 0).sort((a, b) => b[key] - a[key])[0];
  const highlight = (label, r, detail) => `<div class="card"><div class="k">${label}</div><div style="font-size:1.2rem">${r ? esc(r.name) : '—'}</div><div class="n">${r ? `Map ${r.room} · ${detail(r)}` : 'No recorded evidence in this window'}</div></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60"><title>Travel — ${esc(resolveFleet().label)} fleet</title>
<style>${STYLE}select,button{font:inherit;background:var(--bg);color:var(--fg);padding:.4rem;border:1px solid var(--line);border-radius:5px} .num{text-align:right;white-space:nowrap} .scroller{overflow:auto} form{display:flex;gap:.8rem;flex-wrap:wrap;margin:1rem 0} th{white-space:nowrap}</style></head>
<body><div class="wrap"><h1>Travel</h1><div class="sub">${esc(resolveFleet().label)} fleet · last ${hours}h · refreshes every 60s</div>${NAV('travel')}
<form method="get"><label>Window <select name="hours">${[6,24,168,720].map(h => `<option value="${h}"${h === hours ? ' selected' : ''}>${h} hours</option>`).join('')}</select></label>
<label>Maps <select name="sort">${Object.entries(sorts).map(([key, label]) => `<option value="${key}"${key === sort ? ' selected' : ''}>${label}</option>`).join('')}</select></label><button>Update</button></form>
<div class="cards"><div class="card"><div class="k">Journeys ended</div><div class="v">${num(total('journeys'))}</div><div class="n">${num(total('arrived'))} arrived · ${num(total('failed'))} failed · ${num(total('unknown'))} unknown</div></div>
<div class="card"><div class="k">Maps observed</div><div class="v">${report.maps.length}</div></div>
<div class="card"><div class="k">Crossing attempts</div><div class="v">${num(report.transitRecords)}</div><div class="n">${num(total('issues'))} with issues</div></div>
<div class="card"><div class="k">Recorded time stuck</div><div class="v">${duration(total('stuck_ms'))}</div></div></div>
<h2>Characters</h2><div class="panel scroller"><table><thead><tr><th>Character</th><th>Maps observed</th><th>Map entries</th><th>Journeys</th><th>Arrived / failed / ?</th><th>Journey time</th><th>Alternative types</th>${Object.values(TRAVEL_METHODS).map(label => `<th>${label}</th>`).join('')}<th>Crossings with issues</th><th>Time stuck</th></tr></thead><tbody>
${report.characters.map(r => `<tr><td><a href="/hero/${encodeURIComponent(r.character)}">${esc(r.character)}</a></td>${cell(r.maps)}${cell(r.entries)}${cell(r.journeys)}${cell(`${r.arrived} / ${r.failed} / ${r.unknown}`)}${cell(duration(r.journey_ms))}${cell(r.method_types)}${Object.keys(TRAVEL_METHODS).map(k => cell(r.methods[k])).join('')}${cell(r.issues)}${cell(duration(r.stuck_ms))}</tr>`).join('') || '<tr><td colspan="14">No travel recorded in this window.</td></tr>'}
</tbody></table></div>
<h2>Across the fleet</h2><div class="cards">
${highlight('Most traveled map', highest('crossings'), r => `${r.crossings} crossing attempts`)}
${highlight('Most crossing issues', highest('issues'), r => `${r.issues} / ${r.crossings} attempts`)}
${highlight('Most time stuck', highest('stuck_ms'), r => duration(r.stuck_ms))}
${highlight('Busiest map with no recorded issues', report.cleanBusy, r => `${r.crossings} attempts; minimum 5`)}
</div><div class="panel scroller"><table><thead><tr><th>Map</th><th>Characters</th><th>Crossings</th><th>Failed / ?</th><th>With issues</th><th>Issue rate</th><th>Collision refusals</th><th>Median</th><th>90th percentile</th><th>Crossing time</th><th>Time stuck</th></tr></thead><tbody>
${maps.map(r => `<tr><td>${esc(r.name)} <span class="dim">#${r.room}</span></td>${cell(r.characters)}${cell(r.crossings)}${cell(`${r.failed} / ${r.unknown}`)}${cell(r.issues)}${cell(r.issue_rate === null ? '—' : `${(100*r.issue_rate).toFixed(1)}%`)}${cell(r.collisions)}${cell(duration(r.median_ms))}${cell(duration(r.p90_ms))}${cell(duration(r.ms))}${cell(duration(r.stuck_ms))}</tr>`).join('') || '<tr><td colspan="11">No maps recorded.</td></tr>'}
</tbody></table></div>
<p class="caveat">Coverage: map counts are distinct maps actually observed in samples, arrivals or crossings; failed destinations do not count.
Map entries count recorded room changes since entry logging was installed. Crossings use the retained transit books (at most 600 attempts per character), so long windows may be incomplete.
${report.oldestTransit ? `Oldest included crossing: ${esc(new Date(report.oldestTransit).toISOString())}.` : ''}
Chalice rides count confirmed landings. Rescue and Elusion count cast requests, which may fail; portal and Underworld counts require observed exits.
Historical method logs are partial; zero means none recorded. Alternative types count the five displayed categories; an Underworld portal can appear in both exit categories.
An issue is a failed crossing, a refusal or more than one exit attempt. Collision refusals require an explicit collision reason.
Stuck time unions overlapping recorded wedge intervals; it excludes resting and unmeasured delays. Journey and crossing time include pauses.</p>
</div></body></html>`;
}
