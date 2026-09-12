#!/usr/bin/env node
// THE WHOLE FLEET IN SIX NUMBERS.
//
//   node tools/m59-minimal.mjs                 min/max/avg max health and kills per minute
//   node tools/m59-minimal.mjs --minutes 60    over a different window
//   node tools/m59-minimal.mjs --json          the same, for something else to read
//
// Deliberately not a dashboard. Every other view here answers "what is this character
// doing"; this one answers "how is the fleet doing" in a form you can read at a glance
// and compare against the last time you asked. Two quantities, because they are the two
// that matter: max health IS the level in this game, and kills per minute is the rate
// everything else — vigor, supply, safe spots, which room — exists to protect.
//
// TWO RATES, AND THEY DIFFER BY A FACTOR OF THE FLEET SIZE. The min/max/avg row is PER
// CHARACTER; the line under it is the fleet. `avg 0.13` and `3.0/min` are the same
// measurement, and the header "fleet 23 in game" sitting above the first is enough to make
// a reader take it for the second — which happened, to the operator, before a ledger count
// run beside it caught the mistake. Both are printed now, each labelled.
//
// KILLS COME FROM THE LEDGER, NEVER FROM THE KEEPER'S OWN TALLY. `Autopilot.tally.kills`
// is a field set to empty in the constructor, and keepers are restarted constantly — by
// the supervisor, by a policy change, by a broker restart — so that counter means "since
// the last restart" and cannot answer "is this character earning now". `killsIn()` counts
// `killed` events over a real window and is the only definition of the number, which is
// why the board and the broker's live rows both use it.
//
// MAX HEALTH COMES FROM THE LIVE ROWS, because it is pushed and always current. A
// character that is out of game contributes nothing rather than a zero: an absent
// character is not a character at level 0, and averaging one in would quietly drag the
// fleet's number down every time somebody logged in with a client.
import { killsIn, fleetKills, KILL_WINDOW_MS } from './m59-ledger.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? (argv[i + 1] ?? true) : fallback;
};
const JSON_OUT = argv.includes('--json');
const MINUTES = Number(arg('minutes', KILL_WINDOW_MS / 60000)) || 30;
const PORT = process.env.M59_BROKER_PORT || '8901';

async function call(name, args = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}/`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                           params: { name, arguments: args } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return JSON.parse(j.result.content[0].text);
}

// min/max/avg over whatever survived the filter, and null rather than NaN when nothing
// did. A fleet with no readable character is a thing that happens — the broker restarts,
// the server drops everyone — and it must not print as zeros.
function spread(values) {
  const v = values.filter(x => Number.isFinite(x));
  if (!v.length) return { n: 0, min: null, max: null, avg: null };
  return { n: v.length, min: Math.min(...v), max: Math.max(...v),
           avg: v.reduce((a, b) => a + b, 0) / v.length };
}

const fleet = await call('fleet', {}).catch(e => {
  console.error(`no answer from the broker on ${PORT}: ${e.message}`);
  process.exit(1);
});

const rows = (fleet.fleet || []).filter(r => r.in_game !== false && r.level != null);
const kills = killsIn(MINUTES * 60000, 0);

const hp = spread(rows.map(r => r.level));

// THE SPREAD IS PER CHARACTER AND THE LABEL HAS TO SAY SO.
//
// `avg 0.13` against a fleet killing three a minute is the same number said two ways, and
// the header above it reads "fleet 23 in game" — which is enough to make a reader take the
// average for the fleet rate. It did: 0.13/min was reported to the operator as the fleet's
// figure, corrected to 3.0 only because a ledger count was run beside it. So the total is
// now stated in its own right rather than left to be multiplied out.
const perMin = spread(rows.map(r => (kills.get(r.character) || 0) / MINUTES));

// The union, the total and the silent list all live in m59-ledger beside killsIn, so they
// are pinned by m59-spellaudit-test rather than only exercised by running this.
const fk = fleetKills({ kills, characters: rows.map(r => r.character), minutes: MINUTES });
const { total, silent, off_board: offBoard } = fk;

if (JSON_OUT) {
  console.log(JSON.stringify({ window_minutes: MINUTES, characters: hp.n,
                               max_health: hp,
                               kills_per_minute_per_character: perMin,
                               kills_total: total,
                               kills_per_minute_fleet: total / MINUTES,
                               earned_nothing: silent,
                               counted_but_off_board: offBoard,
                               // Said in the payload too: a consumer that reads
                               // `kills_per_minute` and finds this instead should be told
                               // why the name changed rather than left to guess.
                               read_this_way:
                                 'kills_per_minute_per_character is the per-character ' +
                                 'spread; kills_per_minute_fleet is the fleet rate. The ' +
                                 'field was once called kills_per_minute and was the ' +
                                 'former, which reads as the latter.' }, null, 1));
} else {
  const n = (x, d = 0) => x == null ? '  -  ' : x.toFixed(d).padStart(5);
  console.log(`fleet ${hp.n} in game · ${MINUTES}m window`);
  console.log(`  max hp      min ${n(hp.min)}   max ${n(hp.max)}   avg ${n(hp.avg, 1)}`);
  console.log(`  kills/min   min ${n(perMin.min, 2)}   max ${n(perMin.max, 2)}   avg ${n(perMin.avg, 2)}   (per character)`);
  console.log(`  fleet       ${total} kills = ${n(total / MINUTES, 2)}/min`);
  if (silent.length)
    console.log(`  earned 0    ${silent.length} of ${hp.n}: ${silent.join(', ')}`);
  if (offBoard.length)
    console.log(`  off board   ${offBoard.length} counted from the ledger but not on the board now: ${offBoard.join(', ')}`);
}
