#!/usr/bin/env node
// LAY A NEEDLE-TEST CONFIGURATION OUT ON THE SHADOW SERVER SO A PERSON CAN TRY TO WALK IT.
//
//   node tools/m59-needle-lay.mjs        # list them
//   node tools/m59-needle-lay.mjs 11     # lay trial 11 out and put TESTER at the west end
//   node tools/m59-needle-lay.mjs 9      # the first one settled by hand
//
// `m59-needle-test.mjs` sweeps 200 random one-body-per-square configurations of row 29 of the
// Western border of the Twisted Wood. THIS FILE EXISTS BECAUSE A SUITE CAN ONLY EVER CHECK THE
// MODEL IT WAS WRITTEN WITH, and on three separate occasions the model was wrong in a way no
// amount of offline work would have found. Each time, laying the configuration out on a live
// server and letting a person try to walk it settled it in a minute:
//
//   * trial 9 was "shut". Walked by hand, two routes found, corridor looped twice. The defect
//     was a greedy chooser walking into a pocket, not a shut corridor.
//   * trial 38 was "shut" by an independent search too. Walked. The search's lattice sampled
//     the middle of each square and never its last eight units, and the only lane was there.
//   * trial 11 was "shut" by both, after both were fixed. Walked — BETWEEN two bodies 25.3
//     apart, which every clearance model in this repository said was impossible. That is what
//     sent somebody to read clientd3d/move.c, where the object rule turns out to test the
//     ENDPOINT of a move, permit ending inside the zone while moving away, and SLIDE rather
//     than refuse. All three earlier models were inventions.
//
// So: keep it, use it, and prefer it to an argument. Anything here that reports a corridor
// impassable is a hypothesis until somebody walks it.
import { relocate } from './m59-dm.mjs';
import {
  discoverKeeperStates,
  keeperIdentityHeaders,
  probeKeeperLive,
  readVerifiedKeeperState,
  resolveKeeperBand,
} from './runtime/keeper-discovery.mjs';
import { normalizeKeeperCharacter } from './runtime/keeper-liveness.mjs';

const ROOM = 587, ROW = 29, START_COL = 40;
const CONFIGS = {
  // All nine are walkable. They are kept as the controls they became: every one of them was
  // called impassable by some version of this repository's collision model, and every one of
  // them is crossed by the mover now.
  9:   [[43,2812,1904],[44,2840,1884],[45,2884,1908],[46,2964,1896],
        [47,3044,1912],[48,3092,1916],[49,3172,1884],[50,3260,1896]],
  11:  [[43,2804,1864],[44,2860,1896],[45,2884,1904],[46,2992,1868],
        [47,3068,1912],[48,3108,1876],[49,3196,1872],[50,3256,1892]],
  12:  [[43,2792,1908],[44,2876,1888],[45,2888,1916],[46,3000,1872],
        [47,3040,1916],[48,3132,1912],[49,3140,1900],[50,3232,1864]],
  38:  [[43,2808,1916],[44,2864,1900],[45,2888,1896],[46,2984,1888],
        [47,3044,1880],[48,3088,1864],[49,3172,1904],[50,3260,1872]],
  46:  [[43,2800,1896],[44,2852,1908],[45,2896,1900],[46,2988,1868],
        [47,3068,1888],[48,3100,1872],[49,3140,1908],[50,3260,1900]],
  73:  [[43,2812,1908],[44,2872,1912],[45,2884,1888],[46,3000,1896],
        [47,3052,1884],[48,3080,1880],[49,3152,1872],[50,3228,1900]],
  74:  [[43,2812,1872],[44,2872,1912],[45,2896,1896],[46,2992,1892],
        [47,3016,1864],[48,3100,1904],[49,3152,1872],[50,3252,1888]],
  98:  [[43,2764,1864],[44,2864,1908],[45,2888,1892],[46,2992,1880],
        [47,3036,1860],[48,3076,1912],[49,3144,1912],[50,3256,1912]],
  166: [[43,2792,1876],[44,2860,1904],[45,2884,1900],[46,2996,1868],
        [47,3028,1904],[48,3080,1892],[49,3156,1876],[50,3252,1900]],
};
const AGENTS = ['shadow01','shadow02','shadow03','shadow04','shadow05','shadow06','shadow07','shadow08'];
const NAME = { shadow01:'Aaaa', shadow02:'Bbbb', shadow03:'Cccc', shadow04:'Dddd',
               shadow05:'Eeee', shadow06:'Ffff', shadow07:'Gggg', shadow08:'Hhhh' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const which = process.argv[2];
if (!which || !CONFIGS[which]) {
  console.log('\n  usage: node tools/m59-needle-lay.mjs <trial>\n');
  for (const [k, v] of Object.entries(CONFIGS)) {
    const tight = [];
    for (let i = 0; i < v.length - 1; i++) {
      const g = Math.hypot(v[i][1] - v[i + 1][1], v[i][2] - v[i + 1][2]);
      if (g < 32) tight.push(`${v[i][0]}/${v[i + 1][0]} ${g.toFixed(0)} apart`);
    }
    console.log(`  ${String(k).padStart(4)}  walkable` +
                (tight.length ? `   —   ${tight.join(', ')}` : '   —   no pair under 32 apart'));
  }
  console.log('');
  process.exit(0);
}

const CONFIG = CONFIGS[which].map(([col, x, y]) => ({ col, x, y }));

// This is intentionally and exclusively a shadow-fleet tool. Resolve that fleet's complete
// band from the shared registry (or an explicit, validated service override); never assume
// that today's 9111 assignment is permanent and never search a neighbouring fleet.
const KEEPER_BAND = resolveKeeperBand('shadow', {
  ...(Object.hasOwn(process.env, 'M59_KEEPER_PORT_BASE')
    ? { override: process.env.M59_KEEPER_PORT_BASE }
    : {}),
});
const discovery = await discoverKeeperStates({
  band: KEEPER_BAND,
  expectedAgents: AGENTS,
  liveTimeoutMs: 1500,
  stateTimeoutMs: 15000,
});
const KEEPERS = new Map([...discovery.states].map(([agent, state]) =>
  [agent, state.__identity]));

async function currentIdentity(agent) {
  const expected = KEEPERS.get(agent);
  if (!expected) throw new Error(`${agent}: no verified keeper in the shadow fleet's band`);
  const live = await probeKeeperLive(expected.port, {
    expectedAgents: [agent],
    timeoutMs: 5000,
  });
  if (!live || live.pid !== expected.pid ||
      normalizeKeeperCharacter(live.character) !==
        normalizeKeeperCharacter(expected.character)) {
    throw new Error(`${agent}: keeper identity changed; refusing the write`);
  }
  return live;
}

const post = async (agent, path, body, ms = 60000) => {
  const identity = await currentIdentity(agent);
  return (await fetch(`http://127.0.0.1:${identity.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...keeperIdentityHeaders(identity) },
    body: JSON.stringify({
      ...body,
      agent: identity.agent,
      character: identity.character,
      keeper_pid: identity.pid,
    }),
    signal: AbortSignal.timeout(ms),
  })).json();
};
const state = async agent => {
  const identity = await currentIdentity(agent);
  return readVerifiedKeeperState(identity, { fresh: true, timeoutMs: 15000 });
};

// HOLD FIRST, ALWAYS. A blocker whose keeper is still deciding things walks off the mark between
// being placed and being looked at, and then the configuration on the screen is not the one under
// test. It is not sufficient either — one of these was observed moving every second while its own
// keeper reported `kind: inert` — which is why the read-back at the end is not a formality.
for (const a of AGENTS)
  await post(a, '/action', { name: 'hold', args: { why: `needle trial ${which}`, max_ms: 3600000 } })
    .catch(() => {});

for (let i = 0; i < AGENTS.length; i++)
  await relocate([NAME[AGENTS[i]]], ROOM, { row: ROW, col: CONFIG[i].col }).catch(() => {});
await sleep(1500);

// AND IT HAS TO BE `step_fine`, NOT `walk_fine`. The DM only ever drops a body on a square's
// CENTRE — `UtilGoNearSquare` takes a square, not a fine point — and the whole subject here is
// where inside the square somebody is standing. `walkFine`'s `arriveWithin` defaults to 40 fine
// units, more than half a square, and the keeper's `walk_fine` does not expose it, so every one
// of these returned `arrived: true, steps: 0` without moving and the layout was eight bodies dead
// centre. `step_fine` sends one validated move at the point asked for.
for (let i = 0; i < AGENTS.length; i++)
  for (let tries = 0; tries < 4; tries++) {
    const r = await post(AGENTS[i], '/action',
      { name: 'step_fine', args: { x: CONFIG[i].x, y: CONFIG[i].y } }).catch(() => null);
    if (r?.position && Math.hypot(r.position.x - CONFIG[i].x, r.position.y - CONFIG[i].y) < 2) break;
  }
await sleep(1500);

console.log(`\ntrial ${which} — asked for, and as they actually stand:\n`);
let worst = 0;
const standing = [];
for (let i = 0; i < AGENTS.length; i++) {
  const s = await state(AGENTS[i]).catch(() => null);
  const want = CONFIG[i];
  if (!s?.you || s.room?.num !== ROOM) { console.log(`  29,${want.col}  NOT IN THE ROOM`); continue; }
  const off = Math.hypot(s.you.x - want.x, s.you.y - want.y);
  worst = Math.max(worst, off);
  standing.push({ col: want.col, x: s.you.x, y: s.you.y });
  console.log(`  29,${want.col}  wanted ${want.x},${want.y}   standing ${s.you.x},${s.you.y}` +
              `   off by ${off.toFixed(1)}   (${s.character})`);
}
console.log(`\n  worst placement error: ${worst.toFixed(1)} fine units`);

// THE GAPS AS THEY ACTUALLY ARE, not as they were asked for. A body that landed 30 units off
// changes the very thing being looked at, so the pairs are measured from the read-back.
const tight = [];
for (let i = 0; i < standing.length - 1; i++) {
  const g = Math.hypot(standing[i].x - standing[i + 1].x, standing[i].y - standing[i + 1].y);
  if (g < 40) tight.push(`${standing[i].col}/${standing[i + 1].col} ${g.toFixed(1)} apart`);
}
console.log(`  pairs under 40 apart, as laid: ${tight.join(', ') || 'none'}`);
console.log('  (passing BETWEEN two bodies needs 16 from each, so 32)');

await relocate(['TESTER'], ROOM, { row: ROW, col: START_COL }).catch(() => {});
console.log(`
  TESTER is at 29,${START_COL}. Walk east along row 29 to 29,54.
`);
