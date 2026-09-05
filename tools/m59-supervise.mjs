#!/usr/bin/env node
// THE THING NO SINGLE KEEPER CAN DECIDE.
//
//   node tools/m59-supervise.mjs                 # run it, every 60s, until stopped
//   node tools/m59-supervise.mjs --once          # one round and exit
//   node tools/m59-supervise.mjs --graduate 30   # the level at which the valley starts
//   node tools/m59-supervise.mjs --deploy        # opt into legacy pairing/room deployment
//   node tools/m59-supervise.mjs --dry-run
//
// A keeper knows about one character and the room it is standing in. Three things are
// invisible from there, and all three are what this does:
//
//   PAIR      Two characters on one monster both advance from it — advancement is a
//             per-character flag, not a split pot — and between them they take the
//             damage one would have taken alone while each regenerates on its own
//             clock. Nothing in the game pairs anyone; the pairing is a convention two
//             keepers hold, and something outside them has to decide who with whom.
//   GRADUATE  Prey stops paying the moment the character reaches its level
//             (AdvancementCheck needs monster_level > base_max_health). A keeper
//             happily farms something worth nothing for ever, reporting kills.
//   UNSTICK   A keeper that has stalled cannot restart itself.
//
// NO CHARACTER NAMES IN THIS FILE. The old supervisor carried a hard-coded table of
// twenty-five names mapping to schools, and when the fleet was replaced every lookup
// missed and silently fell through to a default — every character got the same prey
// and nothing said so. Everything here is read from the live fleet instead, which is
// also what lets this repository be public.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { localise } from './m59-localpolicy.mjs';

const arg = (n, d = null) => {
  const i = process.argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const PORT = Number(arg('port', 8901));
// NOT `URL`. Naming this URL shadows the global constructor for the whole module, and
// the only use of `new URL(...)` is in outfitPair — so the shadowing turned deployment
// into "round failed: URL is not a constructor" while every other round looked fine.
const RPC = `http://127.0.0.1:${PORT}/`;
const ONCE = !!arg('once', false);
const DRY = !!arg('dry-run', false);
// DIRECTIONAL PLACEMENT MOVED TO DUM. The supervisor keeps its 60-second keeper-internal
// unstick work, but no longer pairs, graduates or assigns rooms unless an operator asks
// for the legacy deployment explicitly. This default matters most when DUM is down: a
// lapsed bot lease must not silently turn the old room-spreading writer back on.
const DEPLOY = !!arg('deploy', false);
// `--dry-run` STOPS AT THE PROCESS BOUNDARY UNLESS YOU CARRY IT ACROSS, AND IT DID NOT.
//
// Three of this file's rounds are not calls, they are `spawn`s: reclaim, the almoner and
// outfit are separate tools with their own errand loops. `DRY` guarded every branch in
// THIS process and none of them, so `--dry-run` printed "would send X + Y" for the
// deploys while three subprocesses walked characters across the world for real. Every
// line of the output looked like a dry run.
//
// Found by running it: a `--once --dry-run` round on the live fleet dispatched a reclaim
// and an almoner. All three tools already parse `--dry-run` — nobody had passed it.
const DRY_ARGS = DRY ? ['--dry-run'] : [];
const GRADUATE_AT = Number(arg('graduate', 30));
const EVERY_MS = Number(arg('every', 60)) * 1000;
// FLY SOLO. Room assignment is still done in twos — that is what spreads the fleet
// across the generators instead of stacking it — but neither character is told the other
// is its partner, so nobody waits for anybody and nobody holds fire for a mate.
//
// This exists because unpairing the fleet by hand does not survive: the round below
// re-pairs whatever it finds unpaired, so a fleet set solo at the console is back in
// parties inside twenty minutes. Measured over the hour after the first split, solo ran
// 1 death and +14 max health against 14 deaths and +3 for the paired hour before it.
const SOLO = !!arg('solo', false);

let id = 0;
async function call(name, args = {}) {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call',
                           params: { name, arguments: args } }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${name}: ${JSON.stringify(j.error)}`);
  const text = j.result?.content?.[0]?.text;
  if (j.result?.isError) throw new Error(`${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);

// WHERE THE GRADUATES GO, and why these three.
//
// All three generate fungus beasts. A fungus beast is level 50, which reads as far out
// of reach for a character of 30 — and the level is the wrong number to read. Level
// sets HIT POINTS and what the kill pays; what it hits you WITH is viDifficulty, and a
// fungus beast's is 1:
//
//   GetAttackAbility = 3*viLevel + 60*viDifficulty     (monster.kod)
//   fungus beast:  3*50 + 60*1  = 210
//   centipede:     3*30 + 60*5  = 390
//
// So the thing they have been farming all week is nearly twice as likely to land a
// blow. Damage is Fuzzy(viLevel/Random(10,15)) — 3 to 5 for a fungus beast against 2
// to 3 for a centipede — so per swing it is comparable, and it swings less often
// (viSpeed 4 against 16). What level 50 buys is a long fight against a big pool of hit
// points, which is exactly the fight a pair at 200 vigor wins: health comes back at
// ((200-vigor)^2/6 + 1000) ms a point, or one a second at 200, and two characters
// splitting the incoming hits each regenerate faster than one slow monster can deal.
//
// They are also FRESH GROUND. The safe-spot book has no failures recorded in any of
// them, where the old rooms have hundreds — 95 discredited squares at the Tos gate
// alone — and a room with no usable squares left is a room the keeper has to fight in
// the open in, which is where the fleet has been dying.
// THE VALLEY IS NOW A DEAD END, AND THAT IS AN ARITHMETIC FACT RATHER THAN A PREFERENCE.
//
// Everything above is still true about how SAFE a fungus beast is. It stopped being the
// right answer for a different reason: AdvancementCheck only rolls when the creature's
// level is STRICTLY GREATER than base max health, and this fleet is at 47-50. A level-50
// fungus beast pays a level-50 character exactly nothing, for ever. Ten characters sat at
// the cap killing steadily and gaining not one point — the failure `yieldCheck` exists to
// name, and the board reads `hunting: fungus beast` the whole time it is happening.
//
// Castle Victoria is the cheapest ground that is strictly above 50 without being absurd:
//
//   38 Castle Victoria      skeleton         level 75, rating 525, 40% of a cap of 10
//   39 Upstairs             battered skeleton level 60, rating 420, 60% of a cap of 10
//
// Both also generate zombies (55), which still pay a character at 50. 39 is the gentler
// room and carries the denser prey, which is why it takes the weaker half of the fleet.
//
// WHAT IS NEXT DOOR IS THE REASON maxThreatOver IS 28 AND NOT MORE. 40 The Throne Room is
// tusked skeleton (100) and ghost (200); 41 Underbasement is narthyl worm (120). At 28 a
// character of 47 may take a skeleton (47+28 = 75, and 75 is not > 75) while every one of
// those neighbours stays refused at any max health in this fleet. Raising it further to
// "make travel smoother" opens all three. Do not.
// 39 IS THE PRIMARY AND IT IS LISTED TWICE ON PURPOSE. `assignRooms` is a round robin —
// `rooms[i % rooms.length]` — so weighting a room means repeating it, not scoring it.
// Two entries to one puts roughly two thirds of the fleet Upstairs.
//
// Upstairs is the better room on every axis that matters here, which is not obvious
// because 38's prey is the higher level:
//
//   39 battered skeleton  level 60, rating 420, 60% of the table
//   38 skeleton           level 75, rating 525, 40% of the table
//
// Advancement is strictly-greater-than max health, and the whole fleet is 47-50 — so a
// level-60 battered skeleton pays EVERY character here exactly as reliably as a level-75
// skeleton does. The extra fifteen levels buy nothing at all in advancement terms while
// costing a hundred points of attack rating. Denser prey, softer fight, same payout.
// 38 keeps a third of the fleet because its table is the only source of skeleton-tier
// loot, not because it advances anyone faster.
// PULLED OUT OF THE CASTLE, AND THIS IS AN EQUIPMENT RUN RATHER THAN AN ADVANCEMENT ONE.
//
// Room 27 is orc (level 45, rating 495) and spider (level 50, rating 390), 50/50, cap 10.
// Say the cost plainly: advancement is strictly-greater-than max health, so an orc pays
// NOBODY here and a spider pays only the nine characters still under 50. The twelve at 50
// gain no max health in this room at all. The castle's battered skeleton (60) paid all
// twenty-one and this does not.
//
// What it buys instead is armour, and seventeen of twenty-one are bare. Orc drops leather
// at 5% a roll over about two rolls — ~10% a kill, the best rate of anything this fleet is
// allowed to fight — and spider adds leather 2% + chain 1%. Both sit UNDER the castle's
// rating band (495/390 against 420/525), and it is one room instead of two, which is what
// the transit deaths were being paid for.
// Both entries are the SAME ROOM. The table is 50/50 and the two creatures pay for
// different things — orc is the leather, spider is the only one of the pair that still
// advances anybody — so the round robin splits the fleet between them rather than putting
// twenty-one characters on one half of one spawn table.
// ROOM 27 WAS ASKED FOR AND CANNOT BE WALKED TO. Recording that here because it looks
// like a perfectly ordinary room and the failure is silent: the keeper reports
// "cannot reach anywhere that generates orc", then ROAMS looking for it, which is the
// exact path that put Sweetums in the Decaying City of Brax.
//
// Ugol's Warren — 27, 2500, 2501, 2502, 2506, 2508, 2509 — is a CLOSED CLUSTER in this
// map. Every edge into any of them comes from another one of them. The single edge that
// crosses the boundary is 27 -> 587 (Western border of the Twisted Wood) and it is
// OUTBOUND ONLY: 587's own exits are 576, 586 and 597 and none of them is 27. That is
// the "exits are not doors and they are not 1:1" rule in its purest form — you can leave
// the cave into the woods and you cannot enter the cave from them. `m59-codeexits.json`
// holds three source rooms and none of them reaches the warren either.
//
// The same is true of the forest rooms 4, 6 and 26 (Deep Dark Woods of Tos/Marion,
// Forests of Meridian): no edgeExits in either direction and no code exit into them.
//
// So this is the reachable version of the same idea — woods, spiders, nothing in either
// table rating above 390, and both are what CLAUDE.md already names as the places to take
// spiders from. Spider is level 50, so it still advances everyone under 50 and drops
// leather 2% + chain 1% a roll.
// HUNTING "spider" COSTS 70% OF EVERY KILL, BECAUSE THE MATCHER IS A SUBSTRING.
//
// `findCreature` is `name.includes(needle)` (m59-skills.mjs), so the word "spider" names
// four creatures and only one of them is the prey:
//
//   spider        L50   <- what we want
//   baby spider   L25   <- pays nobody, and room 574 is 75% of them
//   black spider  L75
//   queen spider  L165
//
// 574 Main gate to Cor Noth sits on the route to Farol, so a character crossing it finds
// something matching its hunt, decides this room will do, and settles. Measured over three
// passes: 44 of 87 kills, then 36 of 85, then 71 of 128 were baby spiders. The paying rate
// fell to 30% while the board read a healthy "hunting: spider" throughout. Evicting the
// characters by hand fixed it for exactly one pass and they drifted back with company.
//
// "living tree" matches ONE creature in the whole index. Same level 50, same attack rating
// 390 — identical fight — and it drops Snack at 30% against spider's 16%, which matters
// because food has been this fleet's binding constraint all week. What it gives up is
// spider's LeatherArmor 2% / ChainArmor 1%; that is a real loss, and it was already being
// multiplied by a 30% paying rate, so the fleet was barely collecting it.
//
// 536 is listed twice because living tree is 30% of its table against 15% of 556's.
//
// `level` IS THE PREY'S OWN LEVEL AND IT IS NOT OPTIONAL. fallbackHunt picks the first
// entry whose ground can still advance the character, and the test it used was
// `g.level == null || g.level > l` — with no entry carrying a level, `undefined == null`
// matched the FIRST ENTRY EVERY TIME. Measured after the fact: fallbackHunt(10) through
// fallbackHunt(95) all returned 'living tree', and the whole ladder underneath it — giant
// rat, fungus beast, zombie, battered skeleton, skeleton, troll — was unreachable code.
//
// It cost the fleet two things at once. Living tree is level 50, so every one of the
// twelve characters at 50 or above was handed prey that CANNOT advance them
// (AdvancementCheck needs monster level strictly greater), which is why the fleet went two
// hours without a single level gain while killing steadily. And it sent them to 536, which
// is the deadliest room in the whole postmortem record at 17 deaths: Kermit was re-tasked
// to 'living tree @ 536', walked there at low health, and died.
const CAVE = [
  { room: 536, name: 'Forest of Farol',      hunt: 'living tree', level: 50, share: 30, cap: 12 },
  { room: 536, name: 'Forest of Farol',      hunt: 'living tree', level: 50, share: 30, cap: 12 },
  { room: 556, name: 'Deep Forest of Farol', hunt: 'living tree', level: 50, share: 15, cap: 16 },
];

// `hunt` is matched as a SUBSTRING (findCreature, m59-skills.mjs), so the single word
// "skeleton" is what names both the skeleton in 38 and the battered skeleton in 39 — and
// it would equally name the tusked skeleton in 40. That is safe only because the level
// gate above refuses it; the hunt string is not doing that work and must not be trusted to.

// WHERE THE UNGRADUATED GO, AND WHY THEY NEEDED ANYWHERE AT ALL.
//
// VALLEY covers level 30 and up. Under that, characters got a hunt target — giant rat,
// correctly, since a level-30 rat still pays them — and NO ROOM, so they roamed to find
// one. That is the whole of the Badlands story: every character that died at the border
// of the Badlands was under 30 (Pepe 20, Clifford 28 and 27, Scooter 29, Kermit 29),
// nominally hunting giant rats, in a room that generates NONE — only troll at attack
// rating 750 and groundworm at 600.
//
// Measured over all history: a successful crossing of that room takes a median of 15.8
// seconds and the median DEATH there had been standing in it for 208. Nobody dies
// passing through. They die arriving, finding no rats, and staying.
//
// So these are rooms that actually contain the prey, chosen on what ELSE lives there —
// which is the number that kills, not the target's:
//
//   575 The King's Way        rat 150, worst neighbour baby spider 315, cap 7
//   567 Off the beaten path   rat 150, worst neighbour groundworm larva 285, cap 9
//
// 567's worst resident is 285, exactly the same as Valley of Ileria, which the
// graduated pairs already survive. 575 is ONE HOP from Cor Noth (150), which has no
// generators at all — so a retreat is short, and retreats are now real.
//
// Deliberately NOT included: 586 Main gate to the city of Tos (centipede 390, and 117
// of 361 fleet deaths historically), 603 The Queen's Way (a Keep Guard whose rating we
// do not know, and faction soldiers are exactly what refuseEngagement was written for),
// and the sewers (lupogg 855).
//
// ROAM MUST BE FALSE HERE, more than in the valley. Both of these rooms are paired with
// a twin that carries the same name and none of the prey: 576 The King's Way is
// centipede 390 and FROGMAN 510, and 566 Off the beaten path is centipede 390. A
// character that wanders one room over is in a worse fight than the one it left, with
// nothing there worth the trip.
const LOWLANDS = [
  { room: 575, name: "The King's Way",      hunt: 'giant rat', share: 50, cap: 7 },
  { room: 567, name: 'Off the beaten path', hunt: 'giant rat', share: 60, cap: 9 },
];

// The orders a graduated pair runs. Everything here is a deliberate departure from the
// low-level loop, and each one is load-bearing:
//
// THESE ARE A STARTING POINT, NOT THIS FLEET'S ANSWER. Every key below can be overridden
// per checkout in `substrate/policy.local.json` under the block `valley_orders`, which is
// gitignored — see tools/m59-localpolicy.mjs. Tune there, not here: a number that is
// right for one roster on one server is not advice, and editing this file makes it advice
// to everybody who clones. What stays committed is what a fresh clone should run and the
// MECHANICS behind each number, which are not opinions.
const VALLEY_ORDERS = {
  mode: 'farm',
  strategy: 'wellfed',          // vigor IS the healing rate, and healing is the tactic
  // Set out near the 200 ceiling rather than at the 140 floor. Reachable only by EATING —
  // resting stops awarding vigor at 80 of 200 — so this number is a bet on the food chain
  // rather than on courage, and a fleet with no reagents cannot honour it. That is why it
  // belongs in a local file: the bet is about one fleet's apothecary, not about the game.
  fight_above_vigor: 180,
  rest_below: 0.75,             // break off early; there is a partner to carry it
  flee_below: 0.35,
  max_carry: 14,   // the pack holds about 14 STACKS; 40 is unreachable, see m59-autopilot sellInTown
  roam: false,                  // stay in the assigned room; the partner is there
  use_safe_spots: true,
  hold_resume_above: 0.9,
  // THE CEILING IS PART OF THE ORDERS, because the room is worthless without it. Sending
  // a character to Castle Victoria at the default 6 walks it the whole way there and then
  // refuses every skeleton in it — a keeper standing in the right room declining to swing,
  // which on the board is indistinguishable from a room that will not spawn. See CASTLE
  // above for why this number is 28 and not larger.
  // BACK TO THE DEFAULT NOW THE CASTLE IS ABANDONED. 28 existed to admit a level-75
  // skeleton to a character of 47 and nothing else; the cave tops out at a level-50
  // spider, which clears a ceiling of 6 for every character here. Leaving it at 28 would
  // keep the fleet willing to trade blows with things three times its weight all the way
  // through the transit rooms, which is what the ceiling is for in the first place.
  max_threat_over: 6,
  // BLUNT FIRST AGAINST BONE. Default (null) ranks weapons by the character's own
  // proficiency, which only ever rewards what it is already best at — so a fleet that
  // learned fencing keeps swinging swords at skeletons for ever. Naming the fragments
  // overrides that. "anything is better than punching" is already the floor: this is a
  // PREFERENCE ORDER, not a filter, and a character holding only a sword still wields it.
  weapon_priority: ['mace', 'hammer'],
};

const inTown = n => /Raza|Mausoleum|Museum|Marion|Tos|Barloque|Jasper|Cornoth|inn/i.test(n || '');

// WHAT TO HUNT WHEN WE HAVE LOST TRACK OF THE ORDERS, by level.
//
// Every restart path needs a fallback, and the old one was the bare string 'giant rat'
// — which is right for a character of 25 and actively harmful for one of 32, because a
// level-30 rat pays a level-32 character NOTHING. AdvancementCheck only rolls when
// monster_level > base_max_health. Three graduated characters were found hunting rats,
// two of them standing IN the valley rooms, having been re-targeted by a restart. They
// were killing steadily and gaining nothing, which is the failure that looks exactly
// like success: the keeper works, the journal fills, the level never moves.
//
// So the fallback has to know the level it is falling back FOR:
//
//   under 30   giant rat (L30) — above them, so it still pays
//   30 to 44   fungus beast (L50) — the valley prey; see the viDifficulty note in
//              CLAUDE.md for why a level-50 creature is the safer fight here
//   over 44    null. Nothing here is a safe guess, and guessing is what caused this;
//              the caller keeps whatever orders it already had.
//   under 30   giant rat (L30)
//   30 to 58   fungus beast (L50)
//   59 to 73   battered skeleton (L60)
//   74 to 88   skeleton (L75)
//   89 and up  troll (L90)
//
// Each threshold sits one below its creature's level, so the prey is always ABOVE the
// character when the band opens — which is the whole requirement, since AdvancementCheck
// only rolls when monster_level > base_max_health. The band then runs until the next
// prey becomes reachable rather than until this one stops paying, so a character does
// not sit on worthless prey waiting for a promotion.
export function fallbackHunt(level) {
  // EACH BOUND IS THE CREATURE'S OWN LEVEL, NOT ONE BELOW IT, AND THE OFF-BY-ONE WAS THE
  // WHOLE PLATEAU. AdvancementCheck rolls only when monster level > base max health, so
  // the band that ends at the creature's level is exactly the band it still pays. The old
  // table ran fungus beast (L50) up to 58: every character from 50 to 58 was handed prey
  // that could not advance it by definition, and ten of them sat there for a week killing
  // steadily and gaining nothing. `< 59` looks like deliberate headroom and is the bug.
  // THE GROUND WINS OVER THE LEVEL TABLE, because the two can disagree and the character
  // is standing in the ground. A restart that loses the hunt was being handed prey chosen
  // purely by level — 'zombie' for anyone at 50 — while `assigned_room` still said Forest
  // of Farol, which generates spider, living tree and centipede and NO zombies. The keeper
  // then reports "cannot reach anywhere that generates zombie" and roams looking for it.
  // Three characters drifted that way within one round of this being introduced.
  //
  // So: if the fleet's own hunting ground can advance this character, hunt what IT holds.
  // The level table below is only for a character that ground cannot pay.
  const l = Number(level) || 0;
  // AN ENTRY WITH NO LEVEL IS NOT A WILDCARD, IT IS AN ENTRY THAT CANNOT BE JUDGED — and
  // treating it as one made this function a constant. `g.level == null` matched the first
  // row of CAVE for every character in the fleet, so the ladder below never ran once. Skip
  // what we cannot judge and fall through to the level table, which is the safe direction:
  // being wrong there costs a walk, being wrong here costs the character its advancement
  // and points it at Forest of Farol.
  const here = CAVE.find(g => g.level != null && g.level > l);
  if (here?.hunt) return here.hunt;
  if (l < 30) return 'giant rat';          // L30
  if (l < 50) return 'fungus beast';       // L50 — gentlest thing in the game, rating 210
  if (l < 55) return 'zombie';             // L55
  if (l < 60) return 'battered skeleton';  // L60
  if (l < 75) return 'skeleton';           // L75
  return 'troll';                          // L90
}

// PAIR THEM UP. Two rules, both about not producing a party that cannot function:
//   * never pair a character with itself, and never leave a three
//   * pair by level, so neither partner is fighting something the other outclasses
// An odd fleet leaves one unpaired, and that is reported rather than hidden — a
// character that thinks it has a partner and has not is worse than a solo one.
// KEEP PAIRS THAT ALREADY WORK. Re-pairing from scratch every round looks like
// self-healing and is actually a thrash: pairUp sorts by level, levels change as
// characters gain and die, so the assignment reshuffles constantly — and every
// reshuffle stops two keepers and re-travels two characters. Nobody arrives before
// being reassigned. Nineteen of twenty-one were misplaced and six pairings one-sided
// within two rounds of running it that way, while deaths climbed.
//
// So an existing MUTUAL pair is left exactly as it is, and only the unpaired are
// matched up. That still heals a widowed character — its partner is gone, so it is
// unpaired and gets re-matched — without disturbing anything that is working.
// A RESTART IS A LEVER FOR A STALL THE KEEPER IS CARRYING, AND A LOOP FOR ONE IT IS NOT.
//
// Restarting a stalled keeper works when the thing in the way is keeper-local: a room
// written off for the session, a route given up on, a square's failure budget, a stale
// safe-spot hold. A fresh process throws all of that away and the character gets another
// go. That is why this exists and it is not going anywhere.
//
// It is not a lever for a DETERMINISTIC stall. The keeper comes back, walks into the same
// room with the same orders and the same geometry, and re-enters the loop within seconds —
// once every ninety seconds, for ever, each line reading `restarted <character>` as though
// something had been achieved. This file already refuses that trap twice by name, for
// `NO_SAFE_WALL` and for a character resting up the mana to arm itself, and both of those
// were found the same way: somebody noticed the log looked like work.
//
// So the restart is BOUNDED against the reason. The keeper now declares `STALL_NO_LEVER`
// when the same stall reason repeats with nothing in the keeper that can act on it
// (`stallLever` in m59-autopilot.mjs); when it does, this allows two restarts — because the
// first one is a genuine experiment and the second covers a restart that raced something —
// and then stops, and says why, and leaves the refusal standing where a person can see it.
//
// Pure and exported so it can be tested without a broker: it takes the memory and the row
// and returns the decision. The memory is a plain Map owned by the caller.
export const STALL_RESTARTS_BEFORE_GIVING_UP = 2;

// One round's memory of who has been restarted for what. Module-level because the
// supervisor loop is a long-running process and the whole point is to remember across
// rounds; the helper below takes it as an argument so a test can hand it its own.
const STALL_RESTARTS = new Map();

export function stallRestartDecision(memory, character, row, { limit = STALL_RESTARTS_BEFORE_GIVING_UP } = {}) {
  const refusals = Array.isArray(row?.refusals) ? row.refusals : [];
  const declared = refusals.find(x => x?.code === 'STALL_NO_LEVER' && x?.blocking !== false);
  // A keeper that has not declared one is the ordinary case and is not rationed. That
  // matters: this must not become a general throttle on a mechanism that works.
  if (!declared) { memory.delete(character); return { restart: true, count: 0, declared: false }; }
  // Keyed on the REASON, not merely on the character. A character that gets stuck on
  // something new has a new experiment coming to it, and the count starts again.
  const why = String(declared.why ?? row?.stalled?.why ?? '');
  const seen = memory.get(character);
  const count = seen && seen.why === why ? seen.count : 0;
  if (count >= limit) {
    memory.set(character, { why, count });
    return { restart: false, count, declared: true, why,
             because: `restarted ${count} time(s) for the same declared stall and it came ` +
                      'back — a restart is not the lever for this one' };
  }
  memory.set(character, { why, count: count + 1 });
  return { restart: true, count: count + 1, declared: true, why };
}

export function pairUp(rows) {
  const by = new Map(rows.map(r => [r.agent, r]));
  const pairs = [], taken = new Set();
  for (const r of rows) {
    if (taken.has(r.agent) || !r.partner_ok) continue;
    const mate = by.get(r.partner);
    if (!mate || taken.has(mate.agent)) continue;
    taken.add(r.agent); taken.add(mate.agent);
    pairs.push([r, mate]);
  }
  const rest = rows.filter(r => !taken.has(r.agent))
                   .sort((a, b) => (b.level ?? 0) - (a.level ?? 0));
  while (rest.length >= 2) pairs.push([rest.shift(), rest.shift()]);
  return { pairs, odd: rest[0] ?? null };
}

// Spread the pairs over the rooms rather than stacking them: each room caps its
// generator (10, 7 and 6), and two pairs in one room halve each other's supply while
// sharing all of the danger.
export function assignRooms(pairs, rooms = CAVE) {
  return pairs.map((p, i) => ({ pair: p, ...rooms[i % rooms.length] }));
}

// The low-level equivalent of VALLEY_ORDERS. Same shape, three deliberate differences:
// a lower fight_above_vigor because these characters cannot reach 180 reliably without
// the food chain a graduated pair has; a slightly earlier flee, because 25 max health
// gives no room to be wrong; and use_safe_spots on, because the wall is worth more to
// something this fragile than to anything else in the fleet.
// Overridable per checkout under the block `lowland_orders`; see VALLEY_ORDERS above.
const LOWLAND_ORDERS = {
  mode: 'farm',
  strategy: 'wellfed',
  fight_above_vigor: 140,
  rest_below: 0.8,
  flee_below: 0.45,
  max_carry: 14,   // the pack holds about 14 STACKS; 40 is unreachable, see m59-autopilot sellInTown
  roam: false,                  // see LOWLANDS — the twin room next door is a worse fight
  use_safe_spots: true,
  hold_resume_above: 0.9,
};

// WHICH BLOCK OF substrate/policy.local.json EACH SET OF COMMITTED ORDERS ANSWERS TO.
//
// A WeakMap rather than a field on the object, because these blocks are SPREAD into the
// autopilot call — a `__block` key would travel with them and arrive at the broker as an
// unrecognised argument, which is exactly the class of silent junk this file spends its
// comments warning about.
const POLICY_BLOCK = new WeakMap([
  [VALLEY_ORDERS, 'valley_orders'],
  [LOWLAND_ORDERS, 'lowland_orders'],
]);

// Say a refusal ONCE, not sixty times an hour. This loop prints every round, and an
// operator who has learned to skim a repeated line is an operator who will skim the one
// that matters. Keyed on the message, so a file that is edited and still wrong says so
// again.
const said = new Set();
const sayOnce = (line) => { if (!said.has(line)) { said.add(line); console.log(line); } };

// Let this checkout's own numbers win over the committed ones. Committed defaults are
// what a fresh clone runs; substrate/policy.local.json is what THIS fleet believes, and
// it is gitignored so the belief never ships as advice. See tools/m59-localpolicy.mjs.
function localOrders(base) {
  const block = POLICY_BLOCK.get(base);
  if (!block) return base;                       // an orders block nobody may override
  const r = localise(block, base);
  for (const x of r.refused)
    sayOnce(`  local policy [${block}] REFUSED ${x.key}: ${x.why}`);
  for (const w of r.warnings)
    sayOnce(`  local policy [${block}] ${w.key}=${JSON.stringify(w.value)} — ${w.why}`);
  for (const a of r.applied.filter((x) => !x.same))
    sayOnce(`  local policy [${block}] ${a.key}: ${JSON.stringify(a.from)} -> ${JSON.stringify(a.to)}`);
  return r.orders;
}

async function orders(agent, room, hunt, partner, base = VALLEY_ORDERS) {
  return call('autopilot', {
    agent, action: 'start', ...localOrders(base),
    hunt, assigned_room: room, partner,
  });
}

// TRAVEL IS FLAKY IN THE MIDDLE, AND RETRYING WORKS.
//
// A multi-hop route fails part-way with things like "start is outside the room grid" —
// the character arrives at an edge, its coordinates read as off the grid for a moment,
// and the next edge cannot be computed. It is transient: the position settles and the
// same route succeeds. What makes retrying correct rather than hopeful is that travel
// is resumable — each attempt starts from wherever the character actually got to, so
// three attempts continue a route rather than restarting it.
//
// Reports where it ended up when it never makes it, because "could not reach" without
// a location leaves a character stranded somewhere nobody is looking.
async function travelTo(agent, room, { tries = 3, hops = 20 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const t = await call('travel', { agent, to: room, max_hops: hops })
                    .catch(e => ({ arrived: false, why: e.message }));
    if (t.arrived) return { arrived: true, attempts: i + 1 };
    last = t;
    const st = await call('status', { agent, brief: true }).catch(() => null);
    if (st?.where?.num === room) return { arrived: true, attempts: i + 1, note: 'already there' };
    await sleep(1500);
  }
  const st = await call('status', { agent, brief: true }).catch(() => null);
  const stuck = (last?.log || []).filter(h => !h.ok).slice(-1)[0];
  return { arrived: false, attempts: tries,
           why: stuck ? `${stuck.from} -> ${stuck.to}: ${stuck.also_tried?.[0]?.why ?? stuck.why ?? 'refused'}`
                      : (last?.why || 'refused'),
           left_in: st?.where?.name ?? null };
}

// GUARANTEE THE KEEPER IS RUNNING WHEN WE LEAVE, WHATEVER HAPPENED.
//
// Patching individual failure paths was not enough. The travel path restored the keeper,
// then the orders path was made to restore it too — and t1 was STILL found stopped for
// ten minutes, skipped while the supervisor cycled five other characters happily. Any
// throw between the stop and the restart strands the character, and there are more ways
// to throw than there are paths worth enumerating: a status read, a map lookup, a socket
// dying mid-call.
//
// So this stops enumerating and states the invariant instead: whoever we stopped is
// running again by the time we return, on every path out including a throw. Checked
// rather than assumed, because "start" on an already-running keeper is a no-op and
// costs nothing, while the alternative costs a character.
// A RESTART MUST NOT BE A POLICY RESET.
//
// Both restart paths here used to send {agent, action, mode, hunt} and nothing else, so
// every field the operator had set — assigned_room, roam, partner, bank_above — was
// silently dropped and the keeper came back with defaults. Two characters were moved off
// "Main gate to the city of Tos" (117 of 361 fleet deaths) with assigned_room and
// roam:false, and both were back in that room inside the hour with assigned_room reading
// "(none)". Nothing errored; the correction simply evaporated.
//
// A stalled character is restarted every 90s, which is exactly the character whose policy
// was most deliberately chosen. So carry the whole policy across and let the caller's
// arguments win only where it actually has an opinion.
// THE POLICY IS camelCase AND THE ARGUMENTS ARE snake_case, so this has to be a mapping
// and not a list of names. The first version was a list, which silently preserved exactly
// the three keys that are spelled the same in both — roam, partner, strategy — and
// dropped assignedRoom, bankAbove, restBelow and the rest. It looked like it worked:
// the restart reported `kept {"roam":false,"partner":"t7"}` and that is a true statement
// about the two fields it managed to carry.
//
// policy key (what `autopilot status` returns) -> argument name (what `start` accepts)
const KEEP_ACROSS_RESTART = {
  assignedRoom: 'assigned_room', roam: 'roam', roamLimit: 'roam_limit',
  partner: 'partner', bankAbove: 'bank_above', restBelow: 'rest_below',
  walkingMoney: 'walking_money', sellAtLoad: 'sell_at_load',
  dropAtLoad: 'drop_at_load',
  sellWhenBroke: 'sell_when_broke', sellWhenBrokeUnder: 'sell_when_broke_under',
  sellWhenBrokeStacks: 'sell_when_broke_stacks',
  maxBotsPerSafeSpot: 'max_bots_per_safe_spot',
  fleeBelow: 'flee_below', maxCarry: 'max_carry', weaponPriority: 'weapon_priority',
  dropJunk: 'drop_junk', strategy: 'strategy',
  // The stall restart fires every 90s, so anything missing from this map has a half-life
  // of about a minute. Leaving maxThreatOver out would have quietly walked the whole fleet
  // back down to a ceiling of 6 while it stood in a castle full of level-75 skeletons —
  // still assigned to the right room, still hunting the right word, and earning nothing.
  maxThreatOver: 'max_threat_over',
  // AND THE CONFINEMENT ITSELF, which was missing and is the one field whose whole purpose
  // is to survive the moment everything else has gone wrong. A stalled character is
  // restarted every 90s; without this line the castle fleet came back with confineRooms
  // cleared, still on the right strategy, still hunting the right word, and free to walk
  // to room 2 — the front step where Gonzo was murdered — the next time the survival
  // refuge went looking for somewhere to withdraw to. Same failure as the assigned_room
  // one above: nothing errors, and the correction simply evaporates.
  confineRooms: 'confine_rooms',
};

function carriedPolicy(st) {
  const p = st?.policy || {};
  const out = {};
  for (const [key, arg] of Object.entries(KEEP_ACROSS_RESTART))
    if (p[key] !== undefined && p[key] !== null) out[arg] = p[key];
  return out;
}

async function ensureKeeper(agent, hunt) {
  try {
    const st = await call('autopilot', { agent, action: 'status' }).catch(() => null);
    if (st?.running) return true;
    await call('autopilot', { agent, action: 'start', mode: 'farm', ...carriedPolicy(st), hunt });
    return true;
  } catch { return false; }
}

async function deploy(a, b, room, name, hunt, base = VALLEY_ORDERS) {
  const out = [];
  for (const [me, mate] of [[a, b], [b, a]]) {
   try {
    // STOP THE KEEPER BEFORE WALKING IT ACROSS THE WORLD.
    //
    // A running keeper is also moving the character — taking safe spots, pulling
    // monsters back to them, breaking off. Travel plans a route to an exact square and
    // then finds the character somewhere else, which is reported as "kept ending up
    // somewhere other than the planned square" and retried until it gives up. Both
    // sides are working correctly and fighting each other; the fix is that only one
    // thing may drive a character at a time.
    await call('autopilot', { agent: me.agent, action: 'stop' }).catch(() => {});
    const t = await travelTo(me.agent, room);
    if (!t.arrived) {
      // NEVER LEAVE A CHARACTER WITH NO KEEPER. We stopped it to travel; if the travel
      // failed it is standing in a monster room with nothing driving it, which is worse
      // than the situation we were trying to improve. Put it back to work where it is.
      await call('autopilot', { agent: me.agent, action: 'start', mode: 'farm',
                                hunt: me.hunting || hunt }).catch(() => {});
      out.push(`${me.character}: could not reach ${name} after ${t.attempts} tries — ` +
               `${t.why}${t.left_in ? ` (left in ${t.left_in})` : ''} — keeper restarted where it stands`);
      continue;
    }
    // AND IF GIVING THE ORDERS FAILS, THE KEEPER IS STILL OFF.
    //
    // The failed-travel path above is careful about this and this one was not: a throw
    // from orders() was caught, noted, and the loop moved on — leaving a character
    // standing in a room with nothing driving it, indefinitely, for whatever reason the
    // call failed. It is the same hazard the comment above names, on the success path.
    //
    // Found by the uptime ledger within an hour of it existing: t1 and t5 stopped 104ms
    // apart, travelled to Marion, and sat there at full health with no keeper for eight
    // minutes. The stops had no matching starts, which is exactly what that ledger is
    // for. Falling back to "farm where you stand" is worse than the intended orders and
    // enormously better than nothing.
    const gave = await orders(me.agent, room, hunt, SOLO ? null : mate.agent, base)
                         .then(() => true)
                         .catch(e => { out.push(`${me.character}: ${e.message}`); return false; });
    if (!gave) {
      const back = await call('autopilot', { agent: me.agent, action: 'start', mode: 'farm',
                                             hunt: me.hunting || hunt }).catch(() => null);
      out.push(`${me.character}: orders failed after arriving — keeper ${back ? 'restarted plainly' : 'COULD NOT BE RESTARTED'}`);
      continue;
    }
    out.push(`${me.character} -> ${name} (${room}) hunting ${hunt}, partnered with ${mate.character}`);
   } catch (e) {
     out.push(`${me.character}: deploy threw — ${e.message}`);
   } finally {
     // The invariant. Nothing above may leave this character unattended.
     const ok = await ensureKeeper(me.agent, me.hunting || hunt);
     if (!ok) out.push(`${me.character}: COULD NOT RESTART ITS KEEPER — it is standing unattended`);
   }
  }
  return out;
}

async function round(n) {
  const f = await call('fleet', {});
  const all = (f.fleet || []).filter(r => r.in_game !== false);

  // ---------------------------------------------------------------- THE BOUNDARY
  //
  // WHAT THIS FILE OWNS AND WHAT IT MUST NOT TOUCH, and the split is by CLOCK rather
  // than by importance. The keeper decides at one second, this decides at sixty, and a
  // directional bot decides over minutes. Anything that has to be right within a second
  // stays with the keeper; anything with no single right answer belongs to whoever the
  // operator pointed at the fleet.
  //
  //   UNSTICK      ours, always. A keeper that has stalled cannot restart itself, and
  //                the three refusals below — no safe wall, waiting for casting mana —
  //                need knowledge of keeper internals that has no business leaving this
  //                repository. It runs on bot-held characters too.
  //   PAIR /       theirs, when a bot holds `work` or `movement`. Two writers on the
  //   GRADUATE /   same policy fields on different cadences does not produce a winner;
  //   DEPLOY       it produces a character whose orders oscillate while both logs look
  //                correct. So a held character is stepped over here rather than raced.
  //   BUSY         nobody's. An operation is in flight and even the unstick round stands
  //                off, because the keeper is inert BY DESIGN while an external errand
  //                walks and `ms_since_moved` measures the keeper, not the character.
  //
  // Both readings come off the fleet row's `committed`, which is one answer computed in
  // one place (m59-commitment.mjs) rather than this file's guess about who is driving.
  const heldBy = r => r.committed?.held_by?.by ?? null;
  const midOperation = r => !!r.committed && r.committed.takeable !== true &&
                            r.committed.kind === 'bot';

  const busyRows = all.filter(midOperation);
  if (busyRows.length)
    console.log(`   standing off ${busyRows.length}: ` +
      busyRows.map(r => `${r.character} (${r.committed.label})`).join(', ') +
      ' — an operation is in flight and its keeper is inert on purpose');

  // `rows` is what the DIRECTIONAL rounds below may act on. The unstick round
  // deliberately reads `all` instead, minus the ones mid-operation.
  const rows = all.filter(r => !heldBy(r) && !midOperation(r));
  const unstickable = all.filter(r => !midOperation(r));
  const bots = new Map();
  for (const r of all.filter(heldBy)) {
    if (midOperation(r)) continue;
    bots.set(heldBy(r), (bots.get(heldBy(r)) ?? 0) + 1);
  }
  for (const [by, count] of bots)
    console.log(`   leaving ${count} character(s) to ${by} — it holds work/movement on them, ` +
                'and two writers on the same policy fields oscillate quietly');
  const hist = {};
  for (const r of rows) if (r.level) hist[r.level] = (hist[r.level] || 0) + 1;
  // STAND DOWN WHILE THE FLEET IS PARKING.
  //
  // A parked keeper is running and deliberately doing nothing, which is exactly what
  // this supervisor is built to notice and fix. Left alone it would read the idle
  // passes as a stall, restart the keeper — clearing the parking flag with it — and
  // send the character back to work in the minute before the broker goes down. That is
  // the same shape as the refusal loop below: every line of it would look like the
  // supervisor working.
  //
  // Deploying is worse than restarting. It stops keepers and walks pairs across the
  // world, so an update that arrived mid-deploy would take the outage with two
  // characters somewhere between towns and no keeper on either.
  //
  // So: one parked character stands the whole round down. The update is measured in
  // minutes and this runs every ninety seconds, so nothing is lost by waiting.
  //
  // AGAINST `all`, NOT `rows`. An update stops the whole broker, so a bot-held character
  // parking for it is every bit as much a reason to stand down as one of ours — and this
  // is the one round where "not mine to touch" is the wrong reading, because the thing
  // being waited for is not a decision about that character at all.
  const parking = all.filter(r => r.parked);
  if (parking.length) {
    const ready = parking.filter(r => r.parked.ready).length;
    console.log(`   standing down: ${parking.length} character(s) are parking for a fleet update ` +
                `(${ready} ready) — not restarting or deploying anyone until it is done`);
    return rows;
  }

  const ready = rows.filter(r => (r.level ?? 0) >= GRADUATE_AT);
  console.log(`${stamp()} [${n}] ${all.length} in game, ${rows.length} mine  ` +
              `ready=${ready.length} (>=${GRADUATE_AT}hp)  ` +
              `stalled=${f.stalled_count ?? '?'}  ${JSON.stringify(hist)}`);

  // 1. UNSTICK. Before anything else: a stalled keeper cannot be paired or moved, and
  // restarting it is what clears the set of rooms it gave up routing to.
  //
  // OVER `unstickable`, WHICH INCLUDES THE BOT-HELD ONES. This is the harness's half of
  // the split and it does not hand over: a directional bot decides where a character goes
  // and what it kills, and has neither the clock nor the keeper internals to tell a
  // deliberate refusal from a stall. Only an operation IN FLIGHT is excluded, and that is
  // because the keeper is inert on purpose for the length of it.
  for (const r of unstickable.filter(r => r.stalled && r.stalled !== false)) {
    const why = JSON.stringify(r.stalled).slice(0, 90);
    const reason = String(r.stalled?.why ?? r.stalled);
    // A DELIBERATE REFUSAL IS NOT A STALL, and restarting it is actively harmful.
    //
    // The keeper refuses to fight in a room with no safe wall it can find, and records
    // which rooms those are for the session. Restarting the keeper throws that record
    // away, so the fresh one walks back in, re-probes, refuses again, and reports a
    // stall again — once a minute, for ever. Eight characters were caught in that loop
    // within a minute of the rule going live, and every line of it looked like the
    // supervisor working.
    //
    // The keeper relocates itself out of a denied room. Leave it alone to do it.
    // NOW READ AS DATA. `status.refusals` carries a stable code; the regex below stays
    // only as the fallback for a broker that predates the field, and can go once every
    // broker in use reports it. The code is the contract; the sentence is for people.
    const refusals = Array.isArray(r.refusals) ? r.refusals : [];
    const refused = (code) => refusals.some(x => x?.code === code && x?.blocking !== false);
    if (refused('NO_SAFE_WALL') || /no safe wall|refusing to fight/i.test(reason)) {
      console.log(`   leaving ${r.character} alone: ${reason.slice(0, 70)} ` +
                  '(a refusal, not a stall — it relocates itself)');
      continue;
    }
    // WAITING FOR MANA IS THE PLAN, AND RESTARTING IT IS WHY IT NEVER FINISHES.
    //
    // An unarmed character with no weapon to borrow, no money and no donor has exactly
    // one route left: sit somewhere safe until it has the 15 mana `create weapon` needs.
    // The keeper does that deliberately — "sitting down anywhere to regain mana" — and
    // sitting still with no kills looks precisely like a stall from out here.
    //
    // So this restarted it, every 90 seconds, and the mana barely climbed: Sweetums sat
    // at 4 of 18, Animal at 11, Zoot at 13, all three reporting "sitting down anywhere to
    // regain mana" and "STALLED" over and over while the supervisor logged a successful
    // restart each time. Three characters bare-handed in a loop that looked like both of
    // us working.
    //
    // The restart costs the PROGRESS SO FAR, not the mechanism: what a rest needs is
    // PFLAG_MOVED_SINCE_ENTRY, which is set by having moved since arriving. Churning the
    // keeper keeps re-deciding rather than waiting, and a character that is re-deciding
    // is not accumulating.
    //
    // The keeper arms itself and moves on the moment it reaches 15. Leave it be.
    if (refused('UNARMED_NO_DONOR') || r.waiting_on?.code === 'MANA_FOR_CREATE_WEAPON' ||
        /needs \d+ to make one|resting for the mana|regain mana|unarmed —/i.test(reason)) {
      console.log(`   leaving ${r.character} alone: ${reason.slice(0, 70)} ` +
                  '(waiting for casting mana — churning the keeper restarts the decision, not the wait)');
      continue;
    }
    if (DRY) { console.log(`   would restart ${r.character}: ${why}`); continue; }
    const persistent = typeof r.stalled === 'object' && (r.stalled.idle_passes ?? 0) >= 8;
    if (!persistent && !/no keeper|keeper stopped/.test(String(r.stalled))) continue;
    // A DECLARED LEVERLESS STALL GETS TWO RESTARTS AND THEN THE TRUTH. See
    // stallRestartDecision — the restart is the right experiment and a terrible habit.
    const d = stallRestartDecision(STALL_RESTARTS, r.character, r);
    if (!d.restart) {
      console.log(`   NOT restarting ${r.character}: ${d.because}. ` +
                  `stalled on: ${String(d.why).slice(0, 90)}`);
      console.log('     this needs a different room, different orders, or a fix — ' +
                  'the refusal STALL_NO_LEVER stays up until the character earns something');
      continue;
    }
    // Same reason as ensureKeeper: the stall restart is the one that fires every 90s, so
    // it is the one most likely to erase a deliberate placement. Read the policy back
    // and carry it, rather than rebuilding the keeper from defaults.
    const cur = await call('autopilot', { agent: r.agent, action: 'status' }).catch(() => null);
    await call('autopilot', { agent: r.agent, action: 'start', mode: 'farm',
                              ...carriedPolicy(cur),
                              // Its own hunt first; only fall back when we genuinely do
                              // not know, and then by level rather than to a constant.
                              hunt: r.hunting || fallbackHunt(r.level) }).catch(() => {});
    console.log(`   restarted ${r.character}: ${why}`);
  }

  // FOOD BEFORE ARMOUR, AND BEFORE THE EARLY RETURNS.
  //
  // This was at the bottom of the round and fired exactly never, for two reasons that
  // both look like nothing in the source. The graduation step returns early when nobody
  // is ready, skipping everything after it; and when somebody IS ready the round walks
  // the pairs one at a time through outfitPair, which allows eight minutes each — so the
  // first round of the day was still outfitting its fifth pair an hour in, and the call
  // at the end had not been reached once.
  //
  // Vigor is the survival variable the death record actually turns on; armour is a
  // second-order effect on a fleet that means to be hit zero times. So the cheap,
  // rate-limited errand goes FIRST, where nothing can starve it.
  // RECLAIM BEFORE SHOPPING. What the fleet dropped is free and already the right level
  // for whoever lost it; what a shop sells has to be paid for with money the fleet does
  // not have. Running this first also means the reagent errand sees the elderberry the
  // reclaim just picked up, rather than walking to an apothecary to buy what is already
  // in a pack.
  await reclaimDrops();
  await spreadReagents(rows);

  if (!DEPLOY) {
    console.log('   directional pairing/room deployment is off — enable the DUM spread strategy, ' +
                'or pass --deploy to opt into the legacy supervisor plan');
    return rows;
  }

  // 2. GRADUATE EVERYONE WHO IS READY, including those already out there.
  //
  // The pool is every character at or over the threshold, not just the ones still in
  // the old rooms. Two reasons, and the second is the one that was wrong before:
  //
  //   * pairs do not survive on their own. A partner dies, or drops, or is left over
  //     from an odd round — and re-pairing from the whole ready set each round heals
  //     that, where pairing only the newly-ready leaves a widowed character alone in a
  //     room full of level-50 creatures, which is the worst place in the plan to be.
  //   * an odd round used to leave one character behind entirely. With the whole set
  //     in the pool it is a different character each round and it joins the next one.
  //
  // Characters already standing in their assigned room with the right partner are
  // skipped below, so this costs nothing for the ones that are already right.
  const alreadyThere = new Set(CAVE.map(v => v.room));

  // THE UNGRADUATED GET A ROOM TOO, and until now they did not.
  //
  // This is the half of the plan that was missing. Everything above decides where a
  // character goes once it reaches 30; under that, a character got a prey name and was
  // left to find it, which meant roaming, which meant the border of the Badlands. See
  // LOWLANDS for the arithmetic. Same machinery as the graduates — pair, assign, deploy
  // — with the low-level room table and the low-level orders.
  const young = rows.filter(r => (r.level ?? 0) < GRADUATE_AT && r.in_game !== false);
  if (young.length >= 2) {
    const settledLow = new Set(LOWLANDS.map(v => v.room));
    const { pairs: lowPairs, odd: lowOdd } = pairUp(young);
    if (lowOdd) console.log(`   ${lowOdd.character} is the odd low-level one this round`);
    for (const p of assignRooms(lowPairs, LOWLANDS)) {
      const [a, b] = p.pair;
      const settled = (x, y) => x.room_num === p.room && (SOLO ? !x.partner : x.partner === y.agent);
      if (settled(a, b) && settled(b, a)) continue;
      if (DRY) { console.log(`   would send ${a.character} + ${b.character} -> ${p.name} (${p.room})`); continue; }
      console.log(`   outfitting ${a.character} + ${b.character} (low)`);
      await outfitPair(a, b).catch(() => {});
      for (const line of await deploy(a, b, p.room, p.name, p.hunt, LOWLAND_ORDERS))
        console.log('   ' + line);
    }
    // Not `alreadyThere` — that set is the valley's, and adding these to it would make
    // a low-level character in the King's Way read as an unaccounted graduate.
    void settledLow;
  }

  if (!ready.length) { console.log('   nobody is ready to graduate yet'); return rows; }

  const { pairs, odd } = pairUp(ready);
  if (odd) console.log(`   ${odd.character} is the odd one this round — left on its current ` +
                       'orders rather than sent to fight level-50 prey alone; it pairs up next ' +
                       'round, and the pool is re-paired every round so it will not be the same one');
  const plan = assignRooms(pairs);
  for (const p of plan) {
    const [a, b] = p.pair;
    // ALREADY IN PLACE, TOGETHER, AND PAIRED WITH EACH OTHER. Anything less than all
    // three and it is re-deployed: a character in the right room with the wrong partner
    // is not in a party, it is standing next to someone.
    const settled = (x, y) => x.room_num === p.room && (SOLO ? !x.partner : x.partner === y.agent);
    if (settled(a, b) && settled(b, a)) continue;
    if (DRY) { console.log(`   would send ${a.character} + ${b.character} -> ${p.name} (${p.room})`); continue; }
    // GEAR BEFORE GOING. Sending an unarmoured pair at a level-50 creature is the one
    // way this plan fails for a reason that was entirely avoidable.
    console.log(`   outfitting ${a.character} + ${b.character}`);
    await outfitPair(a, b);
    for (const line of await deploy(a, b, p.room, p.name, p.hunt)) console.log('   ' + line);
  }
  for (const line of await reconcilePartners()) console.log('   ' + line);
  return rows;
}

// A PARTNERSHIP ONE SIDE HAS NOT HEARD ABOUT IS A CHARACTER WAITING FOR EVER.
//
// deploy() sets a partner only after the character has ARRIVED — and it has three early
// exits before that: travel failed, orders failed, or it threw. Every one of them puts
// the keeper back with plain farm orders and no partner, while the mate, deployed
// independently, may already be pointing here. Given the walks involved — 40 to 50 steps
// across rooms holding a dozen hostiles — that half-failure is routine rather than rare.
//
// The result is a character that waits for someone who is never coming. It reports
// "waiting for t19, who is in somewhere unknown" and stalls until an operator clears it
// by hand; this fleet needed exactly that twice in one session, six pairings the first
// time and six more the second, and each clearing orphans the other side in turn.
//
// The halves cannot fix it between themselves because they are deployed separately, so
// this is a post-condition on the round: after everyone has been placed, any partner who
// is not pointed back at is cleared. Cheap — one fleet read — and it converges, because
// clearing A's partner can orphan B, which the next round then clears.
async function reconcilePartners() {
  const out = [];
  const f = await call('fleet', {}).catch(() => null);
  // ITS OWN FLEET READ, SO IT NEEDS ITS OWN COPY OF THE BOUNDARY. Clearing a one-sided
  // pairing is a write to `partner`, which is an order field — so on a character a bot
  // holds `work` on, this is the second writer, and the symptom of getting it wrong is
  // not an error but a partner setting that flickers between two processes that each
  // log success.
  const rows = (f?.fleet || []).filter(r => r.character && !r.committed?.held_by);
  if (!rows.length) return out;
  for (const r of rows) {
    if (!r.partner || r.partner_ok) continue;
    const st = await call('autopilot', { agent: r.agent, action: 'status' }).catch(() => null);
    const ok = await call('autopilot', { agent: r.agent, action: 'start', mode: 'farm',
                                         ...carriedPolicy(st), partner: null,
                                         hunt: st?.policy?.hunt || undefined })
                     .then(() => true).catch(() => false);
    out.push(`${r.character}: cleared a one-sided partnership with ${r.partner}` +
             (ok ? '' : ' — BUT THE RESTART FAILED'));
  }
  return out;
}

// FOOD IS THE ONE THING NOTHING OWNED.
//
// The supervisor pairs, graduates and outfits; the keeper casts create food when it
// already holds 2 elderberry, 2 herbs and 10 mana. Nobody got reagents to the characters
// that had none, so that job fell to whoever was watching — and when nobody was, the
// fleet slid back to the resting cap of 80 within the hour, every hour.
//
// It is not a supply problem and never was. The fleet was measured holding 646 elderberry
// and 1287 herbs — hundreds of castings — while twelve of twenty-one characters could not
// cast at all. It is a DISTRIBUTION problem, and it regenerates continuously as reagents
// are spent, characters die and drop their packs, and rejoined characters come back with
// nothing. A one-off fix is worth about forty minutes. Run by hand it took eight or nine
// passes in a day and drifted back between every one of them.
//
// Shelled out for the same reason outfitPair is: m59-almoner.mjs already knows who can
// cast, who can spare a share, how to bridge the two, and that a share is a quantity
// rather than a whole stack.
const ALMONER_EVERY_MS = Number(arg('almoner-every', 300)) * 1000;
// A share small enough to reach several characters rather than filling one. Measured: at
// 10 a donor served three per pass, at 6 it served four to five, and elderberry is the
// scarce half of the recipe.
const ALMONER_SHARE = Number(arg('almoner-share', 6));
let almonerAt = 0;
let almonerBusy = false;

// GO BACK FOR THE PACK BEFORE SOMEBODY ELSE DOES.
//
// A death drops the character's whole inventory on the floor. The corpse decays; THE ITEMS
// DO NOT — they lie there, and any player can take them. Meridian's history includes
// people looting corpses to ransom the gear back to its owner. So this is a race against
// the world, and the clock starts the moment somebody dies.
//
// Nothing in this repository had ever gone back for one. Across 594 recorded death sites
// the fleet had recovered nothing, which is why it could report "0 spare weapon stacks
// across 0 characters" while five maces lay on the floor of West Merchant Way, and why the
// almoner kept answering "genuinely short" of a recipe that was also lying there. The
// first real run recovered eleven stacks — five maces, elderberry and herbs — and armed
// two characters that had been waiting on casting mana for hours.
//
// SHORT INTERVAL, ON PURPOSE. Of the six sites that first run tried, the recent ones paid
// and the two oldest came back empty: the value decays. An hourly sweep would arrive after
// the world has swept up. This wants to run minutes after a death, which means often.
//
// m59-reclaim.mjs picks its own couriers (armed, near-whole, not pinned at the resting
// cap) and refuses to send anyone if nobody qualifies — the errand that ignored that cost
// twenty-nine deaths in one pass. It also revives everything it made inert on every exit
// path including a kill, so the timeout below cannot strand a character the way this file's
// own outfitPair once did.
const RECLAIM_EVERY_MS = Number(arg('reclaim-every', 180)) * 1000;
const RECLAIM_SITES = Number(arg('reclaim-sites', 6));
let reclaimAt = 0;
let reclaimBusy = false;

async function reclaimDrops() {
  if (reclaimBusy || Date.now() - reclaimAt < RECLAIM_EVERY_MS) return;
  reclaimBusy = true;
  reclaimAt = Date.now();
  const { spawn } = await import('node:child_process');
  const script = fileURLToPath(new URL('./m59-reclaim.mjs', import.meta.url));
  console.log(`   reclaiming drops (m59-reclaim.mjs --sites ${RECLAIM_SITES})`);
  try {
    await new Promise(res => {
      const p = spawn(process.execPath, [script, '--sites', String(RECLAIM_SITES),
                                         '--port', String(PORT), ...DRY_ARGS], { stdio: 'inherit' });
      p.on('exit', res);
      // SIGTERM rather than the default kill, so the errand's own signal handler runs and
      // revives its couriers. That is the whole reason it has one.
      setTimeout(() => { try { p.kill('SIGTERM'); } catch {} res(); }, 6 * 60 * 1000);
    });
  } catch (e) {
    console.log(`   reclaim threw — ${e.message}`);
  } finally {
    reclaimBusy = false;
  }
}

async function spreadReagents(rows) {
  const { spawn } = await import('node:child_process');
  // NOT EVERY ROUND. A round is 90s and a delivery is a walk of minutes, so firing one
  // per round would stack processes that fight each other for the same donors.
  if (almonerBusy || Date.now() - almonerAt < ALMONER_EVERY_MS) return;
  almonerBusy = true;
  almonerAt = Date.now();
  const script = fileURLToPath(new URL('./m59-almoner.mjs', import.meta.url));
  console.log(`   spreading reagents (m59-almoner.mjs --amount ${ALMONER_SHARE})`);
  try {
    await new Promise(res => {
      const p = spawn(process.execPath, [script, '--amount', String(ALMONER_SHARE),
                                         '--port', String(PORT), ...DRY_ARGS], { stdio: 'inherit' });
      p.on('exit', res);
      setTimeout(() => { try { p.kill(); } catch {} res(); }, 8 * 60 * 1000);
    });
  } catch (e) {
    console.log(`   almoner threw — ${e.message}`);
  } finally {
    almonerBusy = false;
    // THE SAME INVARIANT outfitPair LEARNED THE HARD WAY. supply() holds BOTH keepers for
    // the length of an exchange and restores them in a finally of its own — which does
    // not survive the hard kill above. Anything this errand may have stopped is running
    // again before we return, checked rather than assumed.
    for (const r of rows || []) {
      if (!r?.agent) continue;
      const ok = await ensureKeeper(r.agent, r.hunting || fallbackHunt(r.level));
      if (!ok) console.log(`   ${r.character}: COULD NOT RESTART ITS KEEPER after the almoner`);
    }
  }
}

// Shell out to the outfitter rather than reimplementing it: it already knows about
// per-town bank accounts, the shop-reply race, and putting the keeper's orders back.
async function outfitPair(a, b) {
  const { spawn } = await import('node:child_process');
  const script = fileURLToPath(new URL('./m59-outfit.mjs', import.meta.url));
  try {
    await new Promise(res => {
      const p = spawn(process.execPath, [script, '--agents', `${a.agent},${b.agent}`,
                                         '--port', String(PORT), ...DRY_ARGS], { stdio: 'inherit' });
      p.on('exit', res);
      setTimeout(() => { try { p.kill(); } catch {} res(); }, 8 * 60 * 1000);
    });
  } finally {
    // THE ERRAND STOPS THE KEEPERS AND THE KILL STOPS THE ERRAND.
    //
    // m59-outfit.mjs restores the keepers in a finally of its own, which is correct and
    // does not survive the timeout above: p.kill() is a hard kill and finally blocks do
    // not run through one. Robin and Clifford were found stopped in Marion for exactly
    // this — their travel to the smith kept being refused ("You are unable to go
    // anywhere"), the process ran past eight minutes, was killed, and its restore never
    // happened.
    //
    // Same invariant as deploy(): whoever this errand may have stopped is running again
    // before we return. Checked rather than assumed, because start on an already-running
    // keeper is free and the alternative is a character standing in a town for ever.
    for (const who of [a, b]) {
      const ok = await ensureKeeper(who.agent, who.hunting || fallbackHunt(who.level));
      if (!ok) console.log(`   ${who.character}: COULD NOT RESTART ITS KEEPER after outfitting`);
    }
  }
}

// ONLY WHEN RUN, NEVER WHEN IMPORTED.
//
// pairUp and assignRooms are worth testing and the test has to import this file to
// reach them — and without this guard that import starts supervising the live fleet
// in a loop that never returns. It is the same trap m59-broker.mjs carries a warning
// about, and it caught this file the first time the test was run.
// pathToFileURL, not string surgery: on Windows a bare C:\... path is neither a valid
// URL nor comparable to import.meta.url without it.
const { pathToFileURL } = await import('node:url');
const isEntryPoint = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
// ONE SUPERVISOR, OR NONE OF THIS IS SEQUENTIAL.
//
// The loop below cannot overlap itself — round() is awaited before the sleep, so `--every`
// is a gap BETWEEN rounds rather than a cadence, and a round that runs an hour simply
// delays the next one. What that does not survive is a second PROCESS.
//
// Two supervisors do not merely duplicate work, they fight: both re-pair the same
// characters from the same pool, both spawn m59-outfit against the same agents, and both
// call ensureKeeper on keepers the other has just stopped for an errand. The almoner guard
// is a module variable, so a second process has its own and neither can see the other's.
// This fleet has had its supervisor restarted by hand many times today, and a stop that
// silently failed would have left exactly that.
//
// The broker guards its fleet the same way and for the same reason. A pid file, checked
// against a live process rather than merely present, because a crashed supervisor must not
// lock the next one out for ever.
if (isEntryPoint) {
  const { writeFileSync, readFileSync, existsSync, unlinkSync } = await import('node:fs');
  // Keyed by PORT, not by fleet name: this file has no fleet of its own, it supervises
  // whichever broker answers on that port, and two supervisors on one port are the
  // collision that matters.
  const LOCK = fileURLToPath(new URL(`../substrate/supervise-${PORT}.pid`, import.meta.url));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  if (existsSync(LOCK)) {
    const held = Number(String(readFileSync(LOCK, 'utf8')).trim());
    if (held && held !== process.pid && alive(held)) {
      console.error(`another supervisor is already running as pid ${held} (${LOCK}).`);
      console.error('Two of them re-pair the same characters and fight over the same errands.');
      console.error('Stop that one first — by pid, never by name.');
      process.exit(1);
    }
    // Stale: the holder is gone. Say so rather than silently taking over, because a
    // supervisor that died mid-round may have left keepers stopped behind it.
    if (held) console.error(`[lock] pid ${held} is gone — taking over ${LOCK}`);
  }
  writeFileSync(LOCK, String(process.pid));
  const dropLock = () => { try { if (existsSync(LOCK) &&
    Number(String(readFileSync(LOCK, 'utf8')).trim()) === process.pid) unlinkSync(LOCK); } catch {} };
  process.on('exit', dropLock);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { dropLock(); process.exit(0); });

  for (let n = 0; ; n++) {
    try { await round(n); }
    catch (e) {
      // A broker restart makes every call fail for a minute. Not a reason to stop.
      console.log(`${stamp()} round failed: ${e.message}`);
    }
    if (ONCE) break;
    await sleep(EVERY_MS);
  }
}
