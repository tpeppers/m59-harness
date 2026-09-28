#!/usr/bin/env node
// THE OPERATOR'S STANDING REPORT: deaths, kills, max health, vigor and food, in one page.
//
//   node tools/m59-fleet-report.mjs                  markdown to stdout
//   node tools/m59-fleet-report.mjs --out <file>     and write it there too
//   node tools/m59-fleet-report.mjs --hours 24 --minutes 30
//
// Asked for on 2026-09-27 as a report every two hours. It is the same shape every time so two
// readings can be compared, and it reads everything through the modules the other reports
// use rather than re-deriving: deaths from the postmortem store the broker's fleet owns (and
// only that fleet's — m59-fleetscope), kills from the ledger (never a keeper's own tally),
// max health, vigor and packs from the broker's live rows.
//
// FOOD IS REPORTED AS INKIES AND EVERYTHING ELSE, because the two failed differently. Until
// 097d456 the keeper could not see an inky-cap at all (they sit on every vault list), so a
// character at 80 "with food" was usually a character with only inkies. A row at the resting
// cap that is still carrying inkies below 150 is the thing to look at, and it is counted.
import { writeFileSync } from 'node:fs';
import { killsIn } from './m59-ledger.mjs';
import { loadPostmortems, resolvePostmortemStores } from './m59-postmortems.mjs';
import { fleetScope, partition } from './m59-fleetscope.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf('--' + n); return i < 0 ? d : (argv[i + 1] ?? d); };
const HOURS = Number(arg('hours', 24)) || 24;
const MINUTES = Number(arg('minutes', 30)) || 30;
const OUT = arg('out', null);
const PORT = process.env.M59_BROKER_PORT || '8901';
const INKY = /inky.?cap/i;
const REST_CAP = 80;

async function call(name, args = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}/`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return JSON.parse(j.result.content[0].text);
}

const lines = [];
const say = (s = '') => lines.push(s);
const now = new Date();
say(`# Fleet report: ${now.toLocaleString('en-US', { hour12: false })}`);
say();

// ---------------------------------------------------------------- deaths
const scope = await fleetScope({});
const [store] = await resolvePostmortemStores({ probe: true });
const { kept: deaths } = partition(loadPostmortems({ sinceMs: HOURS * 3600e3, dir: store.dir }), scope);
say(`## Deaths, last ${HOURS}h: ${deaths.length}`);
say();
if (deaths.length) {
  say('| When | Character | Killer | Where |');
  say('|---|---|---|---|');
  for (const d of deaths) {
    const when = new Date(d.at).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    const killer = d.cause?.killer ? d.cause.killer + (d.cause.observed ? '' : ' (guess)') : 'unknown';
    const where = d.where?.trusted ? d.where.room : 'unplaced';
    say(`| ${when} | ${d.character ?? '?'} | ${killer} | ${where} |`);
  }
  say();
}

// ---------------------------------------------------------------- the fleet
let rows = [];
try { rows = (await call('fleet', {})).fleet || []; }
catch (e) { say(`**No answer from the broker on ${PORT}:** ${e.message}`); }
const kills = killsIn(MINUTES * 60000, 0);
const inkiesOf = (r) => (r.pack_items || []).filter(i => INKY.test(i.name || ''))
  .reduce((n, i) => n + (i.amount || 1), 0);

const table = rows.map(r => ({
  name: r.character, in_roster: r.in_roster !== false,
  hp: r.level ?? null, kills: kills.get(r.character) || 0,
  vigor: typeof r.vigor === 'number' ? r.vigor : null,
  inkies: inkiesOf(r),
  food: r.larder_vigor ?? null, has_food: r.has_food,
})).sort((a, b) => b.kills - a.kills || (b.hp ?? 0) - (a.hp ?? 0));

const inGame = table.filter(t => t.hp != null);
const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const vig = inGame.filter(t => t.vigor != null).map(t => t.vigor);
const hp = inGame.map(t => t.hp);
const totalKills = table.reduce((n, t) => n + t.kills, 0);
const atCap = inGame.filter(t => t.vigor === REST_CAP);
// A HUNGRY CHARACTER HOLDING INKIES IS ONLY STUCK WHEN IT HAS NOTHING ELSE TO EAT. Keepers eat
// ordinary food first and keep the inky (the chests ran down to 2 on 2026-09-28, and the operator
// wants deskers on ordinary food), so "at or below 150 and holding one" alone is not a failure:
// Waldorf, Floyd and Beaker were each eating mushrooms, pies and water at the time. +50 per inky.
const holding = inGame.filter(t => t.vigor != null && t.vigor <= 150 && t.inkies > 0);
const stuck = holding.filter(t => t.food != null && t.food - 50 * t.inkies <= 0);

say(`## Fleet: ${inGame.length} in game`);
say();
say(`- **Kills, last ${MINUTES}m:** ${totalKills} (${(totalKills / MINUTES).toFixed(2)}/min); ` +
    `${table.filter(t => t.kills > 0).length} characters made them`);
say(`- **Max HP:** avg ${avg(hp)?.toFixed(1) ?? '-'}, min ${hp.length ? Math.min(...hp) : '-'}, max ${hp.length ? Math.max(...hp) : '-'}`);
say(`- **Vigor:** avg ${avg(vig)?.toFixed(0) ?? '-'} of 200; ${atCap.length} at the ${REST_CAP} resting cap; ` +
    `${vig.filter(v => v > 150).length} above 150`);
say(`- **Inkies:** ${table.reduce((n, t) => n + t.inkies, 0)} carried fleet-wide; ` +
    `**${stuck.length} at or below 150 holding inkies with nothing else to eat**` +
    (stuck.length ? ` (${stuck.map(t => `${t.name} ${t.vigor}/${t.inkies}`).join(', ')})` : '') +
    (holding.length > stuck.length ? `; ${holding.length - stuck.length} more hold one while eating other food first ` +
      `(${holding.filter(t => !stuck.includes(t)).map(t => `${t.name} ${t.vigor}/${t.inkies}`).join(', ')})` : ''));
// THE FLEET'S ONE CHALICE (operator, 2026-09-27: "keep the chalice off the floor in room2, it
// should only ever be dropped very briefly"). In nobody's pack means on a floor or lost, and a
// ride dropped at the right moment reads that way for a few seconds, so it is a flag, not a verdict.
const cupWith = rows.filter(r => (r.pack_items || []).some(i => /chalice of the rain/i.test(i.name || '')));
if (rows.length)
  say(cupWith.length
    ? `- **Chalice:** with ${cupWith.map(r => `${r.character} (room ${r.room_num ?? '?'})`).join(', ')}`
    : "- **Chalice: IN NOBODY'S PACK.** On a floor or lost; check room 2.");
say();
say(`| Character | Max HP | Kills (${MINUTES}m) | Vigor | Inkies | Food vigor | has_food |`);
say('|---|---|---|---|---|---|---|');
for (const t of table) {
  const name = t.in_roster ? t.name : `*${t.name}*`;
  say(`| ${name} | ${t.hp ?? '—'} | ${t.kills} | ${t.vigor ?? '—'} | ${t.inkies} | ${t.food ?? '—'} | ${t.has_food ? 'Y' : 'N'} |`);
}
say();
say(`Food vigor is the nutrition the keeper can eat from the pack, inkies included. Italic rows are not on the roster.`);

const text = lines.join('\n') + '\n';
if (OUT) writeFileSync(OUT, text);
process.stdout.write(text);
