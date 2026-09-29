import { resolveFleet } from './m59-fleetpath.mjs';
import { HOMETOWNS } from './m59-describe.mjs';
import { hometownDir, hometownRoster, readHometown } from './m59-hometowns.mjs';
import { NAV, STYLE, esc } from './m59-page-chrome.mjs';

export function hometownReport({ stateFile = resolveFleet().stateFile,
  roster = hometownRoster(stateFile), dir = hometownDir(stateFile) } = {}) {
  const rows = roster.map(row => ({ ...row, record: readHometown(row.character, { dir }) }))
    .sort((a, b) => a.character.localeCompare(b.character));
  const groups = HOMETOWNS.filter(h => h.town).map(h => ({ town: h.town, room: h.room, members: [] }));
  groups.push({ town: 'Wandering', room: null, members: [] }, { town: 'Unknown', room: null, members: [] });
  for (const row of rows) {
    row.town = row.record ? row.record.current.town ?? 'Wandering' : 'Unknown';
    groups.find(g => g.town === row.town).members.push(row);
  }
  groups.sort((a, b) => b.members.length - a.members.length || a.town.localeCompare(b.town));
  return { rows, groups };
}
export function renderHometownsBoard(options = {}) {
  const { rows, groups } = hometownReport(options);
  const label = options.label ?? resolveFleet().label;
  const who = row => `<a href="/hero/${encodeURIComponent(row.character)}">${esc(row.character)}</a>`;
  const date = at => Number.isFinite(at) ? esc(new Date(at).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')) : 'Never';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Hometown / Rescue · ${esc(label)}</title>
<style>${STYLE} .table-scroll{overflow-x:auto} td{vertical-align:top} .members{min-width:16rem} </style>
</head><body><div class="wrap"><h1>Hometown / Rescue</h1>${NAV('hometowns')}
<p>${esc(label)} · ${rows.length} characters · ${rows.filter(r => r.record).length} checked · ${rows.filter(r => !r.record).length} unknown</p>
<p>Saved hometown observations. Hometown changes are explicit actions at the Hall of Genealogy in Cor Noth; this report only reads the saved record.</p>
<h2>By hometown</h2><div class="panel table-scroll"><table><thead><tr><th>Hometown</th><th>Characters</th><th>Share of fleet</th><th>Home room</th><th>Assigned characters</th></tr></thead><tbody>
${groups.map(g => `<tr><td><b>${esc(g.town)}</b></td><td>${g.members.length}</td><td>${rows.length ? Math.round(g.members.length / rows.length * 100) : 0}%</td><td>${g.room ?? '—'}</td><td class="members">${g.members.map(who).join(', ') || '—'}</td></tr>`).join('')}
</tbody></table></div>
<p>Rescue can use a guild hall or a regional destination instead of the hometown. Home rooms here are hometown destinations, not guaranteed landing rooms. Wandering means the server reported no recognised hometown; Unknown means no confirmed reading is saved.</p>
<h2>By character</h2><div class="panel table-scroll"><table><thead><tr><th>Character</th><th>Agent</th><th>Hometown</th><th>Home room</th><th>Last checked (UTC)</th><th>Assignment first observed (UTC)</th></tr></thead><tbody>
${rows.map(r => `<tr><td>${who(r)}</td><td>${esc(r.agent)}</td><td>${esc(r.town)}</td><td>${r.record?.current.room ?? '—'}</td><td>${date(r.record?.checked_at)}</td><td>${r.record ? date(r.record.changed_at) : '—'}</td></tr>`).join('') || '<tr><td colspan="6">No characters in this fleet.</td></tr>'}
</tbody></table></div><p>Checks are saved on disk with a history of observed changes. “First observed” is when we read that assignment, not when it was made. A failed check keeps the last confirmed reading.</p>
</div></body></html>`;
}
