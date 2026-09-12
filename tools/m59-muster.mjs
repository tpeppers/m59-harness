#!/usr/bin/env node
// MUSTER PEOPLE BY NAME — list who, say where, nothing else.
//
//   node tools/m59-muster.mjs --who Kermit,Gonzo,Fozzie --to 39
//   node tools/m59-muster.mjs --who all --fleet prod --to 52
//   node tools/m59-muster.mjs --who prod:Kermit --to 39 --dry
//   node tools/m59-muster.mjs --who Gonzo --to 104 --min-health 0.5 --why "inside Tos, no open country"
//   node tools/m59-muster.mjs --list     who this machine can address, and which names are ambiguous
//
// NOT m59-route.mjs, which is the per-tick router and a different thing entirely. This is the
// front door: names in, bodies moved, refusals when a name is not enough to identify a body.
//
// WHY. Every fleet tool speaks AGENT IDS (`t18`); every person speaks NAMES ("Gonzo"). On
// 2026-09-12 that gap was crossed by hand a dozen times in one session, and each crossing was
// a fresh chance to move the wrong body. This closes it once, with the resolution living in
// m59-roster-index.mjs where it is unit-tested offline and mutation-checked.
//
// ============================================================ IT REFUSES RATHER THAN GUESSES
//
//   AMBIGUOUS NAME. A hero name is unique only by accident — two rosters on this machine can
//   each hold a "Kermit", on different servers, and they are different bodies. Refused, with
//   the qualified forms printed (prod:Kermit, or 76.214.42.186:5959/Kermit).
//
//   TWO FLEETS AT ONCE. One errand cannot drive two rosters; the broker matches on the state
//   path rather than the fleet label for precisely this reason.
//
//   A BODY SOMEBODY IS PLAYING. `connected: false` on a keeper means a person has that
//   character open in a client and the broker does not hold it. Those are SKIPPED and named,
//   not failed — measured today on Gonzo and Loial, where the symptom was a walk that
//   restarted for ever against a human.
//
// ============================================================ THE HEALTH FLOOR
//
// `--min-health` DEFAULTS TO 1 (full) and going below it requires `--why`.
//
// Not ceremony. This errand was run by hand at 0.35 on 2026-09-12 to "get people moving", and
// seven characters set out across the Cragged Mountains, the Twisted Wood and Ukgoth at
// 41-56% health against six trolls apiece. All seven died. Max-health loss is PERMANENT:
// Kermit 42 -> 39, Lew 42 -> 39, Sweetums 34 -> 33, in one afternoon. A city errand really is
// a different bet from a wilderness crossing, so the override exists — but it is argued in a
// field, and the run prints the argument.
//
// NOTHING HERE SENDS A PACKET OF ITS OWN. The walk is `fleetScript` with `walk`, so the run
// lock, the held body, the lease, the journey budgets and the read-back all apply.
import { fleetScript, walk, verify } from './m59-fleetscript.mjs';
import { indexRosters, resolveHeroes, oneFleetOnly } from './m59-roster-index.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes('--' + name);

const CTL = process.env.M59_CONTROL_URL || 'http://127.0.0.1:8901/';
const post = async (name, args) => {
  const r = await fetch(CTL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = await r.json();
  const t = j?.result?.content?.[0]?.text;
  try { return JSON.parse(t); } catch { return j?.result ?? j; }
};

const index = indexRosters();

// ---------------------------------------------------------------- --list
if (has('list') || !argv.length) {
  console.log('rosters this machine can address (' + index.fleets.length + ')\n');
  for (const f of index.fleets)
    console.log('  ' + f.fleet.padEnd(16) + String(f.slots).padStart(3) + ' slots   ' +
                (f.servers.join(', ') || 'server unknown'));
  const dupes = [...index.heroes.entries()].filter(([, v]) => v.length > 1);
  console.log('\n' + index.heroes.size + ' distinct hero name(s)');
  if (dupes.length) {
    console.log('\nNOT UNIQUE — these must be qualified as fleet:Name or host:port/Name:');
    for (const [name, es] of dupes)
      console.log('  ' + name.padEnd(18) + es.map(e => e.fleet + ':' + e.agent).join('  '));
  } else console.log('all unique, so bare names are safe here');
  console.log('\n  node tools/m59-muster.mjs --who <names> --to <room>');
  process.exit(0);
}

// ---------------------------------------------------------------- resolve
const to = Number(flag('to'));
if (!Number.isFinite(to)) { console.error('--to <room> is required'); process.exit(2); }
const whoRaw = flag('who');
if (!whoRaw) { console.error('--who <names|all> is required'); process.exit(2); }

const fleetArg = flag('fleet');
let asked;
if (whoRaw.trim().toLowerCase() === 'all') {
  if (!fleetArg) { console.error('--who all needs --fleet: "everyone" means nothing across rosters'); process.exit(2); }
  asked = [...index.heroes.values()].flat()
    .filter(e => e.fleet === fleetArg).map(e => e.fleet + ':' + e.character);
  if (!asked.length) { console.error('no roster called "' + fleetArg + '" on this machine'); process.exit(2); }
} else asked = whoRaw.split(',').map(s => s.trim()).filter(Boolean);

const r = resolveHeroes(asked, index);
let fatal = false;
for (const a of r.ambiguous) { console.error('REFUSED  ' + a.asked + '\n         ' + a.why); fatal = true; }
for (const u of r.unknown) { console.error('REFUSED  ' + u + ': no hero or agent by that name on this machine'); fatal = true; }
if (fatal) process.exit(1);

const one = oneFleetOnly(r.resolved);
if (!one.ok) { console.error('REFUSED  ' + one.why); process.exit(1); }

const minHealth = Number(flag('min-health', '1'));
const why = flag('why', '');
if (minHealth < 1 && !String(why).trim()) {
  console.error('REFUSED  --min-health ' + minHealth + ' is below full and no --why was given.\n' +
    '         The default is 1 because seven characters died in one afternoon walking\n' +
    '         wilderness at 0.35. Say what makes this road different.');
  process.exit(1);
}

// ---------------------------------------------------------------- who is actually ours
const take = [], skip = [];
for (const e of r.resolved) {
  const st = await post('status', { agent: e.agent }).catch(() => null);
  const connected = st?.connected ?? st?.in_game ?? null;   // `status` has two shapes
  if (connected === false) skip.push({ ...e, why: 'open in a game client — a person holds this body' });
  else if (st == null) skip.push({ ...e, why: 'no keeper answered' });
  else take.push(e);
}

console.log('fleet ' + one.fleet + '  ->  room ' + to +
            '   (floor ' + minHealth + (minHealth < 1 ? ': ' + why : '') + ')\n');
for (const e of take) console.log('  GO    ' + e.character.padEnd(16) + e.agent.padEnd(5) + (e.server ?? ''));
for (const e of skip) console.log('  skip  ' + e.character.padEnd(16) + e.agent.padEnd(5) + e.why);
if (!take.length) { console.log('\nnobody to drive.'); process.exit(0); }
if (has('dry')) { console.log('\ndry run — nothing sent.'); process.exit(0); }

const res = await fleetScript({
  name: 'muster',
  agents: take.map(e => e.agent),
  controls: take.map(e => e.agent),
  minHealth,
  steps: async () => [
    walk(to),
    // Read the world back rather than trusting the walk's own verdict.
    verify(async ({ agent, call }) => {
      const st = await call('status', { agent }, 60_000).catch(() => null);
      const at = st?.room_num ?? st?.where?.num ?? st?.room?.num ?? null;
      return Number(at) === to ? { ok: true, room: at }
        : { ok: false, why: 'expected room ' + to + ', read ' + (at ?? 'nothing') };
    }, 'standing in room ' + to),
  ],
  onLog: (agent, line) => {
    const e = take.find(x => x.agent === agent);
    console.log('  ' + (e?.character ?? agent).padEnd(16) + line);
  },
});

const results = res.results ?? {};
const good = Object.values(results).filter(v => v.ok).length;
console.log('\n' + good + '/' + take.length + ' arrived in room ' + to);
for (const [agent, v] of Object.entries(results).filter(([, v]) => !v.ok)) {
  const e = take.find(x => x.agent === agent);
  console.log('  ' + (e?.character ?? agent).padEnd(16) + String(v.why ?? '').slice(0, 120));
}
process.exit(good === take.length ? 0 : 1);
