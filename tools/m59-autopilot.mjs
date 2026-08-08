#!/usr/bin/env node
// The keeper: a background loop that holds a character's baseline state so the model
// driving it does not have to.
//
// The problem this solves is a mismatch of clocks. The server runs at one action per
// second and a fight takes half a minute; a model thinks in one burst and then is
// gone until someone calls it again. In between, a character standing in a monster
// room bleeds out, or sits at full health doing nothing for an hour.
//
// So: a small always-on loop per character with no language model in it at all. It
// makes only the decisions that are genuinely mechanical — rest when hurt and safe,
// break off and withdraw when losing, get out of the Underworld after dying, re-wield
// a weapon — and it writes down everything it did so the model can read the history
// and take over whenever it likes.
//
// Two rules it follows, both of them about not surprising its owner:
//
//   * it never picks a fight the owner did not ask for. `survive` only defends what
//     is already happening; `farm` fights, but only what it was told to fight.
//   * everything it does is in the journal with a reason. An agent that comes back to
//     find itself somewhere else can find out why.

import * as skills from './m59-skills.mjs';
import { OF, affordances, dropSpec as dropSpecFor } from './m59-parse.mjs';
import { isFood, foodValue } from './m59-items.mjs';
import { loadSpawns, huntingGrounds, roomThreats, goalYield, roomCap, karmaSafe } from './m59-spawns.mjs';
import { findPath } from './m59-map.mjs';
import { nearestSafeSpot, safeSpotBook } from './m59-safespots.mjs';
import { inboxIfAny } from './m59-inbox.mjs';
import { describeCommitment } from './m59-commitment.mjs';
import * as tougher from './m59-tougher.mjs';
import { recordEvent } from './m59-ledger.mjs';
import * as uptime from './m59-uptime.mjs';
import * as party from './m59-party.mjs';
import { mayShareSpot } from './m59-party.mjs';
import { CITY_INNS } from './m59-underworld.mjs';
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Built by: node tools/m59-spawns.mjs
const SPAWN_FILE = process.env.M59_SPAWN_FILE ||
  fileURLToPath(new URL('../substrate/m59-spawns.json', import.meta.url));
// Learned by standing in them. See SafeSpotBook.
const SAFESPOT_FILE = process.env.M59_SAFESPOT_FILE ||
  fileURLToPath(new URL('../substrate/m59-safespots.json', import.meta.url));
// One file per death. Gitignored, like everything a running fleet writes.
export const POSTMORTEM_DIR = process.env.M59_POSTMORTEM_DIR ||
  fileURLToPath(new URL('../substrate/postmortems', import.meta.url));

// How long a spot must go quiet, with something adjacent to us that wants to kill us,
// before we believe it works. Two passes' worth: one quiet reading is also what you
// get from a monster that happened to be walking away.
const PROOF_MS = 12_000;
// AND HOW LONG AFTER SETTLING ON THE SQUARE BEFORE DAMAGE IS THE SQUARE'S FAULT.
//
// Being hit is resolved on the server and arrives here as a packet. Our arrival is also
// a packet, travelling the other way. So a blow the server resolved while we were still
// a square short can land in our lap after we have reported standing on the spot — and
// the reading blames the wall for a hit that was already in the air before we reached it.
// A failure is PERMANENT (see discredited() in m59-safespots.mjs), so one such reading
// retires a good square for ever, and nothing about it looks wrong afterwards.
//
// The walked-in path was already covered by accident: takeSafeSpot stamps movedAt on
// arrival, so the whole first window is thrown out for "we moved in this window", which
// at a 1s pass cadence tolerates about a second of skew. The hole was the OTHER path —
// `steps_away === 0`, taking a hold on a square we are already standing on, which walks
// nowhere and therefore stamps no movement. There the first window could open the
// instant the hold was taken, with the approach's damage still arriving.
//
// So the clock is the later of "we stopped moving" and "we claimed the square", and a
// window that opens inside this grace is discarded rather than counted either way.
// Discarded, not merely forgiven, because a window whose damage we do not trust is a
// window whose quiet we do not trust either — the same packet delay that hides a hit
// until later is what would make the square look quiet now.
//
// 250ms rather than the fuller half-second the round trip can take, deliberately. The
// asymmetry that governs this whole file runs the other way: being wrong about a bad
// square costs a character, being wrong about a good one costs a walk to the next
// corner. Widen it only against `settled_ms` on real failures, which is recorded for
// exactly that argument.
const SETTLE_GRACE_MS = 250;
// How far a swing carries, and how far away something still counts as part of a swarm.
//
// THREE, NOT 1.5. Reach is `SquaredDistanceTo <= GetAttackRange^2` on square
// coordinates (nomoveon.kod:121), and GetAttackRange is `Bound(2 + viDifficulty/6,2,3)`
// (monster.kod:1682) — so the shortest-armed thing in the game reaches two squares and
// a difficulty-6 one reaches three. 1.5 was the diagonal of a single square, i.e. the
// assumption that melee is adjacency, and it made this blind to more than half of what
// could hit us: a centipede sitting two squares away was not counted as adjacent at all.
//
// That mattered most where it was least visible. observe() only credits a quiet reading
// as proof of a square when something that wants us dead is in reach, so under-counting
// reach meant sieges that proved nothing, and the damage that did arrive was attributed
// to a square with "0 adjacent" — a contradiction that was written into the book as
// fact.
const REACH = 3;
const CROWD_RADIUS = 4;
// Where resting alone runs out. RestTimer stops awarding vigor at its threshold of 80
// out of 200, so 0.4 is the ceiling of what sitting down can ever buy — asking for
// more is asking to sit until the timeout expires. The rest comes from food.
const REST_VIGOR_CAP = 0.4;

// HOW LONG A POST-DEATH RECOVERY IS ALLOWED TO TAKE before the character goes back out
// anyway. recovered() waits on health, mana AND vigor, and each of the three is a way to
// wait for something that is not arriving — a health point that never lands, a mana bar
// held down by something chipping at us in a room we believed was safe.
//
// Twelve minutes is well clear of a real recovery. A character that walks to a corner of
// an inn and sits reaches full health and the 80 vigor resting can give in about two, and
// a full mana bar from empty in five or six. Anything past that is not recovering, it is
// stuck — and a stuck character should show up as a stall, not vanish into an inn for the
// rest of the session.
const RECOVER_MAX_MS = 12 * 60_000;

// HOW LONG A HURT CHARACTER MAY REFUSE TO GIVE UP A WALL FOR A DISCRETIONARY ERRAND.
//
// Far shorter than RECOVER_MAX_MS, because the two waits are not the same. That one is a
// character sitting in an INN, where nothing can reach it and waiting costs only time.
// This one is standing on a wall in a monster room, which is safe on the thesis but is
// still a room with monsters in it — so the cap is set where a real recovery has clearly
// failed rather than where patience runs out. Full health from the rest threshold takes
// well under a minute at any decent vigor; three is generous and still bounded.
const HOLD_WHILE_HURT_MAX_MS = 3 * 60_000;

// THE WATCHDOG'S THREE NUMBERS. See startWatchdog() for what it is for.
//
// The tick is fast because it is free: it reads `client.vitals()`, which the server
// pushes, and writes nothing to the wire. 500ms is well inside the ~1s pace at which
// damage can arrive, so nothing lands between two ticks unseen.
const WATCHDOG_MS = Number(process.env.M59_WATCHDOG_MS || 500);
// How long a pass may be inside one await before the watchdog will interrupt it. Three
// seconds is three normal passes — long enough that an ordinary slow call is not treated
// as a stall, short enough that a character bleeding out is not left to it.
const WATCHDOG_BLOCKED_MS = Number(process.env.M59_WATCHDOG_BLOCKED_MS || 3_000);
// The longest the record may go without a frame while nothing is changing. Matches the
// keeper's own resync interval, which is the same number the deaths page uses to decide
// whether a keeper counts as having been watching (`WATCH_MS` in m59-postmortems.mjs).
// Deliberately the same: the thing that reports blindness and the thing that prevents it
// should not disagree about what it is.
const WATCHDOG_FRAME_MS = Number(process.env.M59_WATCHDOG_FRAME_MS || 8_000);

// HOW LONG A KEEPER STAYS INERT WITHOUT ANYBODY SAYING SO AGAIN.
//
// Every caller that holds a keeper pairs the hold with a revive, and the pairing is the
// bug: `m59-outfit.mjs` has died between the two and left a character standing, and the
// supervisor's own log carries the line `COULD NOT RESTART ITS KEEPER — it is standing
// unattended` for exactly that. Inert is a better state to be abandoned in than stopped —
// it is still recording — but it is not a state to be abandoned in for ever.
//
// Fifteen minutes is longer than any errand here: the slowest is a cross-town outfit run
// at three or four. An errand still going at fifteen has already failed.
const INERT_MAX_MS = 15 * 60_000;

// Where to eat to when no strategy names a target. Resting stops awarding vigor at 80 of
// 200 (REST_VIGOR_CAP), and the death rate falls roughly thirtyfold once a character is
// clear of it — 101.8 deaths per thousand observations at or below 85, against 4.4 from
// 86 to 120. So the default is "get off the cap", not "fill the bar": it is the cheap
// part of the curve, and the stomach only admits 100 filling at a time anyway.
const EAT_TO_AT_LEAST = 120;

// HOW RESTED YOU HAVE TO BE TO FIGHT WITHOUT A WALL, WHICH DEPENDS ON WHAT YOU ARE FIGHTING.
//
// A flat 130 closed a loop the fleet could not get out of. A character with no food sits
// at the resting cap of 80; at 80 it refuses every wall-less fight; refusing means it
// leaves the ground it was sent to; wandering means "nothing to hunt here"; no kills
// means no money; no money means no food; and no food means it is still at 80 tomorrow.
// Nineteen of twenty-one characters were in that loop, and three were doing all the
// killing.
//
// The way out is to notice that "fighting in the open" is not one risk. A giant rat is
// the gentlest thing in this world — level 30, difficulty 1, attack rating 150 — and a
// level-23 character swinging at one from open floor is not the same act as taking on a
// centipede at 390. Damage still scales with level, so `blowsWeCanTake` stays the hard
// floor; this only says how much vigor to demand before allowing it at all.
//
// Gentle prey (at or under a fungus beast's 210, the same bar the room filter uses) is
// allowed from the resting cap. Anything harder still wants the full 130.
// The rating MUST come from the spawn table, which carries the real viDifficulty. My
// first attempt derived it from level alone as 3*level + 60 — that is the difficulty-1
// case, so it called a centipede (really 390) and an ant (360) gentle and would have sent
// characters at the resting cap against them in the open. Level is what a blow costs;
// difficulty is how often one lands, and only the table knows it.
//
// Unknown difficulty means unknown danger, and unknown is NOT gentle.
const GENTLE_RATING = 210;                 // a fungus beast: level 50, difficulty 1
function ratingOfCreature(name) {
  const all = loadSpawns(SPAWN_FILE)?.creatures;
  const q = String(name || '').toLowerCase();
  if (!all || !q) return null;
  const hit = all[q] || Object.values(all).find(v => q.includes(String(v.name).toLowerCase()));
  return hit?.attack_rating ?? null;
}
function vigorBarFor(names, policy) {
  const full = policy.openFightVigor ?? 130;
  const list = [].concat(names || []).filter(Boolean);
  if (!list.length) return full;
  const rates = list.map(ratingOfCreature);
  if (rates.some(r => r == null)) return full;              // do not guess in our own favour
  return Math.max(...rates) <= GENTLE_RATING ? (policy.openFightVigorGentle ?? 78) : full;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = v => (v && v.max ? v.value / v.max : null);

// ------------------------------------------------------- debugging from inside the game
//
// THREE STATES WE DO NOT YET UNDERSTAND, reported to whoever is standing next to the
// character rather than to a terminal nobody is reading.
//
// These are the three that survived the last round of fixes without being explained:
// they are common (across 403 attended deaths: 46%, 29% and 14% of them), each one is
// individually a correct-looking refusal, and the sum of them is a character quietly
// doing nothing until something eats it. The one thing they have in common is that the
// journal line does not carry enough to tell what the character could actually SEE.
//
// So: flag the state, keep the full detail on the keeper, and — only when a human has a
// client open on one of the fleet's own characters — send it as a tell. Standing next to
// the thing while it explains itself is a different debugging instrument from reading a
// post-mortem afterwards, which is the whole point.
export const DEBUG_STATES = {
  'every defensible square here is out of the fight\'s reach': 'no defensible square',
  'could not reach the safe spot': 'could not reach safe spot',
  'frozen': 'play-dead freeze',
};
// FIVE MINUTES PER CHARACTER PER CONDITION. Measured across 425 post-mortem journals the
// three states fire 2.12 times per character-minute, which across 21 characters is about
// 2,675 tells an hour at one mana each — unreadable, and expensive. The cooldown is per
// (character, condition) so one noisy character cannot mask another's first report, and
// what it suppresses is COUNTED and stated in the next tell rather than dropped, because
// "the 40th time in five minutes" is itself the finding.
// THE MASTER SWITCH, AND IT IS OFF.
//
// Opt-in rather than opt-out because the cost of being wrong is asymmetric: forgetting to
// turn it off means the fleet talks to a live shared server all day, and forgetting to
// turn it on means one debugging session prints a "debug tells are off" reason and you
// set the variable. Any value other than empty/0/false enables it.
const DEBUG_TELLS_ON = !['', '0', 'false', 'no', 'off']
  .includes(String(process.env.M59_DEBUG_TELLS ?? '').toLowerCase());
const DEBUG_TELL_COOLDOWN_MS = Number(process.env.M59_DEBUG_TELL_MS || 5 * 60_000);
const tellCooldown = new Map();     // "character|state" -> last sent at
const tellSuppressed = new Map();   // "character|state" -> how many since then

// WHO IS AT THE CONTROLS, if anyone.
//
// Registered by the broker rather than imported from it, because the pilot claim is
// bound to a local process id and that is broker state — and because importing
// m59-broker.mjs RUNS it (it takes the fleet lock and starts rejoin timers), which is
// the trap CLAUDE.md warns about. The keeper only needs the answer.
//
// Null until the broker sets it. A headless run, a test, or a broker with nobody piloting
// all give the same answer, and the same behaviour: say nothing to nobody.
let pilotLookup = () => null;
export function setPilotLookup(fn) {
  pilotLookup = typeof fn === 'function' ? fn : (() => null);
}
export function pilotedNow() { try { return pilotLookup(); } catch { return null; } }

// WHERE IN THE ROOM, IN WORDS. A tell that says "col 16, row 11" is a tell you have to go
// and look up; standing in the room you want "far north-west". Rows count from the north
// (LEAVE.NORTH aims at row 1) and columns from the west (LEAVE.WEST aims at col 1) —
// taken from the boundary candidates in World.exits(), not assumed.
export function bearingIn(row, col, rows, cols) {
  if (!rows || !cols || row == null || col == null) return null;
  const band = (v, n) => (v <= n / 3 ? 0 : v <= (2 * n) / 3 ? 1 : 2);
  const ns = ['north', '', 'south'][band(row, rows)];
  const ew = ['west', '', 'east'][band(col, cols)];
  const edge = row <= 2 || col <= 2 || row >= rows - 1 || col >= cols - 1;
  if (!ns && !ew) return 'the middle of the map';
  const where = [ns, ew].filter(Boolean).join('-');
  return (ns && ew) ? `the ${where} corner${edge ? ' (hard against the edge)' : ''}`
                    : `the ${where} side${edge ? ' (hard against the edge)' : ''}`;
}

// Once a meal has lifted us above the configured fighting floor, do not spend a
// long digestion interval chasing the strategy's ideal ceiling.  The floor is the
// operator's statement that fighting is safe; the ceiling is only a useful top-up
// target when the next bite is soon, or when the wait is also healing us.
export function shouldWaitForProvision({ vigor, floor, wait, hurt }) {
  return vigor < floor || hurt || wait <= 60;
}

// VIGOR IS NOT SHAPED LIKE THE OTHER TWO, and reading it as though it were has been
// quietly disabling every vigor decision in this file.
//
// Health and mana report {value, max}. Vigor reports {value, scale_max, rest_threshold}
// — there is no `max`, because its fourth field is the level the game counts as RESTED
// (80 of 200) rather than a ceiling. So `pct(vitals.vigor)` returned null, every
// `vig !== null` guard was false, and no character has ever rested because it was
// tired. Morgan sat at 14 vigor on full health "fighting from a proven safe spot",
// which is thirty seconds of swinging and no way back.
const vigorOf = v => (v?.vigor?.value ?? null);
// HOW MANY REAGENTS TO KEEP. Six is three casts of create food, which a character gets
// through in an hour and then declines every cast until it happens past another shop.
// The fleet declined 278 casts for want of reagents in three hours, against 21 for mana,
// while holding eight elderberry across twenty-one characters — and create food is the
// only route to vigor for anyone not standing in a town.
//
// Twenty is ten casts. Elderberry and herbs are 10 weight each, so both targets together
// are about 400 of a 1700 carry allowance, and the walking float still bounds the spend.
// Herbs are already abundant (135 fleet-wide against 8 elderberry); the target is really
// about elderberry, and being over-stocked on herbs costs weight and nothing else.
const REAGENT_TARGET = 20;

// WHAT A THING IS WORTH, from viValue_average in the kod — the number a merchant prices
// around, before markup. Read once at load; a missing file simply makes every pile value
// zero, which reads as "not worth a walk" and is the safe direction to fail in.
const ITEM_VALUE = (() => {
  try {
    const p = fileURLToPath(new URL('../substrate/m59-values.json', import.meta.url));
    return JSON.parse(readFileSync(p, 'utf8')).values ?? {};
  } catch { return {}; }
})();

// What `create food` costs to cast — viMana on the Kraanan spell, the same number the
// broker's `spells` tool reports out of the kod source. Reagents alone never made a cast
// affordable, and treating them as the only precondition is what put the fleet in the
// state where reagents were delivered to characters too tired to spend them.
const CREATE_FOOD_MANA = 10;

const vigorPct = v => {
  const g = v?.vigor;
  if (!g || g.value == null) return null;
  return g.value / (g.scale_max ?? 200);
};

// NOBODY STARTS A FIGHT TIRED.
//
// Attacking costs half a point a swing at one a second — thirty a minute — and vigor
// is also what sets how fast health comes back between fights. Below about a third of
// the bar a character cannot finish what it starts: it swings, runs dry, breaks off,
// and recovers slower than it would have if it had simply waited.
//
// Seventy WAS chosen to be reachable without food, and that turned out to be the wrong
// thing to optimise. Resting alone stops at 80 of 200, so a floor of 70 meant every
// character fought permanently exhausted — not occasionally, by accident, but as the
// designed steady state — and then recovered slowly between fights because vigor is
// what sets the regeneration rate. The floor was reachable; it was also useless.
//
// So the floor is now set by what a character needs to FIGHT WELL, and the food supply
// is expected to meet it. That is not a free choice — everything above 80 has to be
// eaten — which is exactly why the larder and the vigor floor are one problem.
const MIN_FIGHT_VIGOR = 100;      // never start a fight below this while there is food
const WANT_FIGHT_VIGOR = 140;     // what every pattern aims to set out at
// THE ESCAPE HATCH, and the reason a hard floor of 100 does not deadlock the fleet.
// With an empty larder the floor is unreachable by any action the keeper can take, and
// holding out for it idles the character for ever — so an empty larder drops it to what
// resting alone can actually deliver. This is a SUPPLY failure and is counted as one.
const STARVED_FIGHT_VIGOR = 70;

// WHERE THE MONEY GOES. Jasper and Tos share one banking system, so either counter
// pays into the same balance and the only question is which is nearer — which really
// does flip across this fleet's rooms: Jasper is closer to the Merchant Way rooms,
// Tos to the gate rooms. Ko'catan keeps a separate account and is deliberately not
// here; banking into it would strand the money somewhere nobody goes.
const BANKS = [
  { room: 54,  name: 'First Royal Bank of Tos' },
  { room: 376, name: 'The Royal Bank of Jasper' },
];

export const MODES = ['survive', 'farm', 'idle'];

// Farming patterns, as a table rather than scattered conditionals, so that adding a
// sixth is a row and so that the differences between them are readable side by side.
//
// The one thing they all share: what is being measured is MAX HEALTH GAINED PER
// HOUR, not kills. Kills are cheap to produce and easy to fool yourself with — a
// character killing something at or below its own level gains nothing at all.
export const STRATEGIES = {
  // WHAT THE VIGOR FLOORS NO LONGER VARY BY.
  //
  // These patterns used to disagree about how tired a character may be when it starts
  // a fight — baseline and fieldrest said "any", wellfed said 120, trader and coop
  // said 100 — and that comparison is finished. Nothing beats not fighting tired:
  // swinging costs about thirty vigor a minute, vigor sets how fast health returns
  // between fights, and a character that engages below the floor breaks off part-way
  // and then recovers slower than if it had simply waited.
  //
  // So every pattern now starts from MIN_FIGHT_VIGOR and the strategies differ only in
  // what they do about FOOD, which is the part still worth measuring: the floor is
  // reachable by resting, everything above it has to be eaten.

  // Control. Rest when hurt, fight from whatever vigor resting gives you.
  baseline: {
    vigorFloor: WANT_FIGHT_VIGOR, vigorCeiling: 200,
    eatBeforeFighting: true, restInTown: true, sellLoot: false,
    why: 'the obvious loop, and the thing every other pattern has to beat',
  },
  // Eat up to the stomach limit before going back out. Costs food; buys a faster
  // health regeneration rate and more margin in every fight.
  //
  // A ZONE, NOT A THRESHOLD. See provision() — the point of the ceiling is to set out
  // at the top of the band with an empty enough stomach to keep eating while
  // fighting, so the fighting stretch lasts as long as the food does.
  wellfed: {
    vigorFloor: WANT_FIGHT_VIGOR, vigorCeiling: 200,
    eatBeforeFighting: true, restInTown: true, sellLoot: true,
    why: 'vigor sets the regeneration rate, so being well fed should mean both ' +
         'shorter recovery and more survivable fights — at the cost of food',
  },
  // Never walk back to town. Withdraw within the hunting area and rest there.
  fieldrest: {
    vigorFloor: WANT_FIGHT_VIGOR, vigorCeiling: 200,
    eatBeforeFighting: true, restInTown: false, sellLoot: false,
    why: 'a town trip is several minutes of walking each way at one square a second; ' +
         'this trades safety and shopping for never paying that',
  },
  // The full economic loop: haul loot back, sell it, spend it on food, stay fed.
  trader: {
    vigorFloor: WANT_FIGHT_VIGOR, vigorCeiling: 200,
    eatBeforeFighting: true, restInTown: true, sellLoot: true,
    maxCarry: 40,
    why: 'tests whether the money loop pays for itself — reagents and drops fund the ' +
         'food that funds the vigor that funds the uptime',
  },
  // Cooperative: heal each other, and hand herbs to the Shal'ille casters who need
  // them rather than selling into an NPC spread.
  coop: {
    vigorFloor: WANT_FIGHT_VIGOR, vigorCeiling: 200,
    eatBeforeFighting: true, restInTown: true, sellLoot: false,
    medic: true, share: true,
    why: 'an NPC buys low and sells high; two players trading a herb for a loaf both ' +
         'do better than either does against that spread',
  },
};

export class Autopilot {
  constructor(session, { mode = 'survive', policy = {} } = {}) {
    this.s = session;
    this.mode = mode;
    this.policy = {
      // Rest when health OR vigor falls below this and nothing is attacking us.
      restBelow: 0.7,
      // Break off and withdraw at this. Deliberately higher than fight()'s own
      // threshold: the keeper is not watching a fight, it is watching a character.
      fleeBelow: 0.4,
      // What to hunt in `farm` mode. Never guessed — if it is empty, farm does nothing.
      hunt: null,
      // WHAT THE FARMING IS FOR — 'money' | 'items' | 'advance' | null. See scorePrey in
      // m59-spawns.mjs, which is where the rules live.
      //
      // This does NOT make the keeper choose prey. `hunt` is still never guessed, and
      // still only changes when someone changes it over MCP; the trade-off between money,
      // items and advancement is a decision about what a character is FOR, and the keeper
      // has no business inventing one.
      //
      // What it buys is the check in yieldCheck(): whether the thing we are already
      // killing still pays for the thing we said we were farming. That gap is the reason
      // this exists. A keeper grinding worthless prey looks EXACTLY like a healthy one —
      // it kills something every pass, so progress() fires, so the stall detector never
      // trips, and the board reads `hunting: giant rat` for as long as you leave it.
      // Twenty-one characters can farm nothing for an afternoon that way.
      purpose: null,
      // What `purpose: 'advance'` is trying to raise:
      //   [{ kind: 'hp' },
      //    { kind: 'skill', name: 'slash' },
      //    { kind: 'spell', name: 'blast', ability: 20, requisite: 25 }]
      // Empty means the check cannot run and says so, rather than passing silently.
      goals: [],
      // Stop farming when carrying this many things, so the character does not spend
      // an hour filling up and dropping the overflow.
      maxCarry: 14,
      // WHICH WEAPON TO REACH FOR. null ranks by the character's proficiency in each
      // weapon's own skill (m59-skills.mjs weaponRanking). A list of name fragments
      // overrides it — ['axe'] trains the axe on a character who would otherwise wield
      // its 90% sword for ever, because ranking by proficiency is a feedback loop that
      // only ever rewards what you are already good at.
      weaponPriority: null,
      // KILL WHAT WE DO NOT WANT, TO KEEP THE ROOM PRODUCING WHAT WE DO. The spawn cap
      // is a room-wide total, so a creature we step over is a slot our prey cannot use.
      // Off makes the keeper ignore weak creatures and slowly suffocate its own hunting
      // ground, which is what it did.
      clearWeak: true,
      // The karma school this character is protecting: 'good', 'evil', 'neutral', or
      // null for none. Only ever used to REFUSE a kill — it never picks prey.
      karma: null,
      // Drop junk, and weapons the server has told us are broken. A broken weapon is
      // NOT renamed (weapon.kod:788 changes only the icon), so it keeps out-scoring the
      // working one in the pack and cannot be recognised except by having been refused.
      dropJunk: true,
      // How many pulls that never turn into a fight before the square is written off.
      // See pullDidNotConvert(): the empirical cliff detector, and now the BACKSTOP —
      // takeSafeSpot refuses unreachable squares up front, so this should rarely fire.
      pullsBeforeBarren: 3,
      // WHICH MOVEMENT GRID THE SERVER PUTS MONSTERS ON. room.kod:2102 reads one
      // server-wide setting: 0 LOS_OLD (default — everyone coarse), 1 monsters fine,
      // 2 players fine, 3 both. Getting this wrong in the permissive direction is what
      // put five characters on a clifftop, so it defaults to the server's own default
      // rather than to the value that would let the keeper roam most freely.
      los: 0,
      // DECIDING IS FREE. ASKING IS NOT. These were the same number and should never
      // have been.
      //
      // A pass used to open with roomContents() + stats(1) — two requests and up to
      // four seconds waiting for the replies — so re-deciding meant re-polling, and
      // eight seconds between decisions looked like the price of not hammering the
      // server. It was not. The server PUSHES the world: BP.CREATE adds an object to
      // room.objects, BP.REMOVE deletes it, BP.MOVE moves it, and stats arrive on
      // change. The client's map is already live between polls; roomContents is a
      // RESYNC against drift, not the source of truth.
      //
      // And the poll is not passive. It counts as an action and calls
      // NotifyMonstersOfPresence — which is why playing dead forbids it. Polling every
      // second would wake the room eight times as often, in a safe spot whose entire
      // value is that nothing attacks until you swing.
      //
      // So: decide often on what we already know, resync rarely.
      decideMs: 1000,
      // How often to re-ask the server for the room and our stats. Drift correction:
      // a push can be missed, and a character that has been acting on a stale map is
      // the failure this guards against. Unchanged from the old pass interval, because
      // that cadence was never the problem.
      resyncMs: 8000,
      // Kept so an existing roster, and anything that set it, still means something.
      // Read as the resync interval — which is what it always actually controlled.
      idleMs: 8000,
      // Move to a neighbouring room when this one has nothing left to hunt. Monsters
      // do come back, but slowly, and a keeper that stands in a cleared room for an
      // hour is not managing anything. Off by default: wandering changes where the
      // owner left their character, which is a surprise, so it is opted into.
      roam: false,
      // How many empty passes to tolerate before moving on.
      roamAfterEmptyPasses: 3,
      // Never wander further than this from where roaming began, so a character can
      // still be found. Counted in rooms travelled, not distance.
      roamLimit: 6,
      // How far above the character's own level the toughest thing a room can
      // generate is allowed to be. See preyRooms.
      maxThreatOver: 6,
      // WHERE THIS CHARACTER IS SUPPOSED TO FARM. null means "wherever ranks best".
      //
      // Without it a fleet cannot be spread out, and not because anyone moves it back
      // by hand — the keeper does it. Standing anywhere its prey does not spawn (a
      // town, an inn, the room it woke up in after dying) the keeper leaves for
      // preyRooms()[0], and that is the same room for every character hunting the same
      // thing. Twenty-one characters were placed across six rooms and were back in two
      // within the hour, one death at a time, each one individually behaving correctly.
      //
      // Set this and the keeper goes HERE instead. It still refuses a room that cannot
      // generate the prey — an assignment is a preference, not a way to make a
      // character stand in a shop for ever.
      assignedRoom: null,
      // WHICH FARMING PATTERN THIS CHARACTER IS RUNNING. These exist to be compared
      // against each other — the ledger records the strategy with every sample, so
      // `history` can report health gained per hour by strategy rather than anyone
      // having to argue about which ought to work. See STRATEGIES below.
      strategy: 'baseline',
      // Vigor to reach before picking a fight. Resting alone tops out at the rest
      // threshold (80 of 200); anything above it has to be eaten.
      fightAboveVigor: MIN_FIGHT_VIGOR,
      // Disconnect rather than die when a single exchange could finish us. Set false
      // to forbid it — but it is the most effective survival move available when we
      // have nowhere safe to stand, and the penalties the game attaches to logging
      // off exist for PvP, not for this.
      panicLogoff: true,
      // How long to stay frozen and unattackable after reconnecting.
      freezeMs: 90_000,

      // FIGHT FROM A WALL WHENEVER THE FIGHT IS WORTH ANYTHING. See holdWorthwhile().
      useSafeSpots: true,
      // ALWAYS TAKE THE FIGHT FROM FULL, when we are somewhere that lets us choose.
      //
      // Out in the open, health is spent capital: recovering it means disengaging,
      // walking somewhere quiet and sitting down, so it is worth fighting well down
      // the bar before paying that. In a safe spot none of that is true — stopping
      // costs a pause and nothing else — so there is no reason to ever swing at
      // anything below this. It is much higher than restBelow on purpose.
      holdResumeAbove: 0.9,
      // How far to go to fetch a monster that will not come to us. UNSET: there is no
      // limit, because distance was never the thing that made a pull dangerous — see
      // pull(). It went 8, then 14 when the Tos gate turned out to be 58 by 44 and every
      // pull in it was being refused, and each of those numbers was a room-shaped guess
      // standing in for the reasoning. Set `pull_within` to put a ceiling back.
      pullWithin: null,
      // NEVER FIGHT IN A ROOM WITH NO SAFE WALL IN IT.
      //
      // holdWorthwhile() already said a wall was wanted against anything that outlevels
      // us, but it was only ever advice: when takeSafeSpot failed, the keeper noted "no
      // safe spot available here" and had the fight anyway, in the open, against the one
      // class of creature the wall exists for.
      //
      // This is stronger than that, on purpose. A room we cannot find a wall in is
      // written off entirely — not just for hard prey — and the fleet goes elsewhere.
      // The reasoning is at the check itself: the wall IS the survival model, and this
      // detector is known to miss plain wall edges, so "no wall found" is not the same
      // as "no wall". Treating the room as denied under-uses the world, which is
      // recoverable; guessing does not, which is not.
      requireSafeWall: true,
      // PARTY: who this character fights alongside, or null for solo.
      //
      // The pairing itself lives in m59-party.mjs, which is process-wide and shared by
      // every keeper; this is only the instruction, so it survives being written into
      // the roster and rebuilt after a restart. Setting it registers the pair.
      partner: null,
      // Below this fraction of health, a partnered character stops swinging and heals
      // while the other keeps the fight going. Higher than fleeBelow on purpose: the
      // point is to leave the fight early and cheaply, not to survive leaving it late.
      partyHealBelow: 0.5,
      // Reconnect before stepping off a spot that has a crowd on it. See breakOut().
      breakOutViaLogoff: true,
      // How many monsters camped on us make leaving worth a reconnect.
      breakOutAbove: 2,
      // HOW MANY TIMES A SESSION TO STOP AND ACTUALLY TEST A SPOT.
      //
      // Proof used to arrive only by accident: a character that swings every pass
      // never produces a quiet window, so the one state that can prove a wall — being
      // next to something and not hitting it — happened only when it got hurt enough
      // to sit down. That is exactly backwards, because the proof is worth most BEFORE
      // the fight goes badly.
      //
      // So: when a monster has come to the wall and the spot is untested, hold the
      // swing for a couple of passes and watch. It costs a few seconds, once per
      // fight, for the first few fights of a session. Not once ever — walls do not
      // move but maps get rebuilt and rooms get renumbered, so a handful of fresh
      // readings each session is what keeps the book honest.
      spotTestsPerSession: 3,
      // Below this fraction of health, in a safe spot, panic-logoff anyway. Out in
      // the open the trigger is two of the biggest hit the game can land, which is
      // around 70% for these characters — far too eager once a wall is doing the
      // work, and every false alarm costs a minute of not healing. See the doomed
      // check in pass().
      doomedInSpotBelow: 0.35,
      // Shillings to keep in hand for flasks and food; everything above this goes to
      // the bank, where death cannot take it.
      walkingMoney: 400,
      // CARRY MORE THAN THIS AND GO AND BANK IT, wherever you are. On by default,
      // because the alternative is what this fleet was already doing: 35,920 shillings
      // in pockets across twenty-one characters, one of them holding 5,840, all of it
      // dropped on a corpse the moment anything killed them. Two thousand is roughly
      // where a player stops what they are doing and walks to Jasper or Tos.
      // Set 0 or null to keep the old behaviour — bank only if you happen to walk past one.
      // BANK EARLY, BECAUSE DYING IS NOT RARE HERE.
      //
      // Everything carried drops where you die and a bank balance does not. Across 30
      // hours and 21 characters this fleet died 259 times — 0.41 deaths per character per
      // hour, a death every two and a half hours — so money held for an hour has roughly
      // a 41% chance of being dropped.
      //
      // At 2000 almost nothing was ever banked: a character carrying 1,900 shillings kept
      // carrying them and lost the lot at the next death, and the journal line for it was
      // a cheerful "carrying, but under the banking threshold". Expected loss on 1,000
      // carried is about 410 an hour, against one trip to a town — which is a sanctuary,
      // so the trip itself is the safest walking the fleet does.
      //
      // 800 is twice the walking float, so a character still keeps enough to shop with.
      //
      // CHANGING THIS DOES NOT REACH KEEPERS THAT ALREADY EXIST. Each keeper's policy is
      // persisted with the roster and restored by resumeFleet, so a new default applies
      // only to keepers created afterwards — I changed this to 800, restarted, and found
      // every keeper still reporting "carrying, but under the banking threshold ...
      // banks_at: 2000". Use the autopilot tool's `bank_above` to move the live ones.
      // Lowered again to 500 after Rowlf — the fleet's best character, ten levels gained
      // in a session — was found at 8 of 30 health carrying 731 shillings, which was 46%
      // of everything the fleet owned. At 800 it would not bank, and one bad fight would
      // have put nearly half the fleet's money on the floor of a monster room.
      //
      // The threshold is not really about the amount. It is about how much of the fleet's
      // total is riding on one character that can die in the next eight seconds.
      bankAbove: 500,
      ...policy,
    };
    // What we believe is in the stomach. Nothing reports it, so it is modelled from
    // what we ate plus the documented drain rate, and corrected whenever the server
    // refuses a mouthful. See provision().
    this.stomach = new skills.Stomach();
    this.climbing = false;
    this.running = false;
    this.stopping = false;
    // NOT ACTING IS NOT THE SAME AS NOT LOOKING. See goInert().
    this.inert = null;
    this.journal = [];
    this.passes = 0;
    this.startedAt = null;
    this.lastError = null;
    // What actually happened, so a returning model gets a summary rather than a tail.
    this.tally = { kills: 0, deaths: 0, rests: 0, withdrawals: 0, rooms_moved: 0, looted: {} };
    // WHEN each kill happened, not just how many there have been.
    //
    // A running total answers "has this character ever worked", and that is not the
    // question anyone asks of a fleet board. A character with 40 kills and none in the
    // last hour looks identical to one earning steadily, and the difference is the entire
    // point of watching. It is also reset by every keeper restart, so on a fleet whose
    // keepers get restarted constantly the total mostly measures uptime.
    //
    // Timestamps cost nothing and answer the real question. Bounded because a good session
    // is a few hundred, and nothing here looks further back than an hour.
    this.killTimes = [];
    // EVERY CAST, AND EVERY CAST IT DECIDED AGAINST.
    //
    // The keeper's self-supply decisions are the ones hardest to check from outside,
    // because both spells it relies on refuse SILENTLY: `create food` without 2
    // ElderBerry and 2 Herbs, `create weapon` below 15 mana. Neither says a word, so a
    // character that cast forty times and got nothing looks exactly like one that cast
    // forty times and ate well — and a character that never cast at all looks exactly
    // like one that does not know the spell. A count of actions cannot separate those;
    // the OUTCOME and the REFUSAL have to be recorded with the attempt.
    //
    // `declined` is the half a log of actions can never give you, and it is why this is
    // an audit rather than a counter.
    this.spellbook = { casts: [], by_spell: {}, declined_logged: new Map() };
    // WHAT IT SPENT MONEY ON. The economic half of the same question: a character can
    // keep its vigor up by buying food, or by buying the two reagents and casting for
    // it, and those cost differently and fail differently. Recorded per purchase so
    // the mix is readable rather than inferred from a shrinking purse.
    this.spending = { bought: [], spent: 0, by_kind: {}, declined: {} };
    // HOW WELL THE ASSIGNMENT IS HOLDING. Read by `status` and by the spread tool.
    //   effective  — returned_to_assignment / relocations
    //   consistent — drifted, and drifted_to says WHERE it keeps losing them to
    //   robust     — failed + why_not, the verbatim reason travel gave up
    this.placement = { relocations: 0, aimed_at_assignment: 0, returned_to_assignment: 0,
                       drifted: 0, drifted_to: {}, failed: 0, why_not: [] };
    // Consecutive failed attempts to reach a room, so a single transient miss does not
    // get mistaken for the room being unreachable. Cleared the moment one succeeds.
    this.relocFails = new Map();
    // WHAT VIGOR THE FIGHTS ACTUALLY START AT — the number the floor exists to move,
    // reported rather than assumed. `below_want` is the one to read: a floor nobody
    // reaches is a wish, and the commonest reason to miss it is an empty larder.
    this.vigor = { engagements: 0, total_at_engage: 0, lowest_at_engage: null,
                   below_want: 0, waited: 0, starved_passes: 0, cooked: 0, cook_failed: 0 };
    // Whether the money is actually getting to a bank, and what stops it when it does
    // not. `carried_at_death` is the number this whole mechanism exists to drive to 0.
    this.money = { trips: 0, trips_failed: 0, carried_at_death: 0, why_not: [] };
    this.emptyPasses = 0;
    this.roamedFrom = null;
    this.roamedRooms = 0;
    this.unreachable = new Set();   // spawn rooms we could not route to
    this.foeId = null;             // the creature we are part-way through killing
    // WHERE THE TIME ACTUALLY GOES.
    //
    // "Stalled" was doing too much work as a word. The commonest reason a keeper
    // reported it was `waiting to be healthy enough to fight` — a character sitting
    // down and regenerating, which is the correct thing to be doing and is not stuck
    // in any sense. Counting that as a stall makes the fleet look broken while it is
    // working, and hides the cases where it genuinely is.
    //
    // So: seconds by activity, and STALLED means only one thing — standing about not
    // knowing what to do, while NOT recovering.
    this.time = { fighting: 0, recovering: 0, travelling: 0, trading: 0, stalled: 0 };
    this.doing = null;             // set during a pass; decides which bucket it lands in
    this.visited = new Set();
    // Where the hunting was actually good. Roaming without this wanders off down a
    // one-way gradient and never comes back — it walked a character five rooms out
    // of a rat warren into a town and oscillated there for twenty minutes.
    this.homeRoom = null;
    // Consecutive passes that achieved nothing. A keeper that has done nothing for
    // ten passes is not idle, it is stuck, and the only way anyone found out before
    // was by noticing a number had not moved.
    this.idlePasses = 0;
    this.stalledSince = null;
    this.stalledWhy = null;
    // Passes in which the server's room contents did not contain our own object.
    // The usual cause is a save-game renumbering our object id out from under a live
    // session, after which everything that keys on selfId quietly reads as "dead".
    this.selfMissingPasses = 0;

    // THE SAFE SPOT WE ARE STANDING IN, and whether we have any evidence it works.
    // null when we are not holding one. See observe() for how `proven` is earned and
    // holdWorks() for what it entitles us to do.
    this.hold = null;
    // What the world was doing last time we looked, so that "did anything hit me
    // while I was sitting still?" can be answered at all. It is the only question
    // that distinguishes a safe spot from a hopeful one.
    this.lastObs = null;
    // When we last did something a monster is entitled to answer. Damage arriving
    // after one of these is retaliation and says nothing about the spot.
    this.swungAt = 0;
    this.movedAt = 0;
    // When we last did anything at all that ends the entry grace period, and when we
    // last reconnected. The pair exists to stop the keeper proving a safe spot with
    // the grace period rather than with the walls — see observe(). That would be a
    // false positive in the one direction that gets a character killed: believing a
    // bad square is good, on evidence collected while nothing was allowed to hit us.
    this.turnedAt = 0;
    this.rejoinedAt = 0;
    // Set after a reconnect made while holding: health regeneration is gated on
    // having acted since entering the room, and in a safe spot we can afford to act.
    this.needsArming = false;
    this.book = safeSpotBook(SAFESPOT_FILE);
    // EVERY WINDOW WE ADJUDICATED, INCLUDING THE ONES WE THREW AWAY.
    //
    // The verdict is the cheap thing to report and the useless thing to check. If
    // this measurement is wrong it will be wrong in the DISCARDS — a window dropped
    // as "we swung in it" that we did not swing in, a grace period believed over when
    // it was not, an adjacent monster that was actually a corpse — and a log of
    // conclusions cannot show that, because the conclusion is what is in doubt.
    //
    // So every window records its inputs and what became of them, counted or not, and
    // someone standing in the room watching can disagree with a specific reading
    // rather than with the summary. That is the only kind of disagreement that can
    // find a measurement bug.
    this.trials = [];
  }

  // HOW MUCH HEALTH IS ACTUALLY SAFE, derived rather than guessed.
  //
  // A lawful hit is capped at (base_max_health + 2) / 3 (player.kod:4612), so a
  // single blow can take A THIRD of a 25-health character's bar. Breaking off is not
  // instant either — the withdraw walk is a round or two during which it keeps
  // swinging.
  //
  // A flat "flee at 40%" ignores all three. Forty percent of 25 is ten health, which
  // is one hit plus change: Isolde was killed by a BABY SPIDER while nominally
  // obeying that threshold. Three hits of margin is the number that actually
  // survives, and before 30 it should never be tested at all — every death costs a
  // point of max health permanently, which is the very thing being farmed.
  // PROVISIONING: A ZONE AND A CYCLE, NOT A THRESHOLD.
  //
  // The old rule was one number — top up if below it, then fight regardless. That is
  // not how the mechanic rewards you. Three facts from the kod set the shape:
  //
  //   the stomach caps at 100 and drains 0.12 a second, so a full one takes 13.9
  //     minutes to clear (player.kod:45-51, 1347, 5703)
  //   eating converts nutrition to vigor by removing exertion (player.kod:5738)
  //   "Need empty stomach to get vigor boost from food" — the kod's own note
  //
  // So vigor is not a tap you open when low. Stomach room is the scarce resource,
  // and it refills on a clock you cannot hurry. Eating at 199 vigor wastes the room;
  // arriving at a fight with a full stomach means no top-ups for a quarter of an hour.
  //
  // What a player does, and what this now does:
  //
  //   CLIMB    eat what fits, wait for room, eat again, until vigor reaches the
  //            ceiling. The waiting is not idleness — it is the digestion clock.
  //   TOP OFF  at the ceiling, wait until there is room for one more meal before
  //            setting out, so the fighting stretch can be fed as it goes.
  //   FIGHT    eat opportunistically whenever there is room and vigor is off the
  //            ceiling. This never blocks the fight.
  //   FALL     when vigor drops through the FLOOR and the stomach is too full to do
  //            anything about it, stop and climb again.
  //
  // The floor and ceiling are what give it hysteresis. A single threshold makes the
  // character oscillate across one number, which is the thrashing this replaces.
  //
  // Returns true if the caller should NOT start a fight this pass.
  // THE ONE PLACE THAT DECIDES HOW TIRED IS TOO TIRED, because there used to be two
  // and they disagreed. provision() climbed to vigorFloor while the fight gate let the
  // character swing at fightAboveVigor, so `wellfed` ate its way to 120 and then
  // engaged at 70 anyway, and the whole strategy comparison was measuring nothing.
  fightFloor(plan = STRATEGIES[this.policy.strategy] || {}) {
    const p = this.policy;
    // fightAboveVigor was the old single knob; it still works, as the floor.
    const want = Math.max(MIN_FIGHT_VIGOR,
      p.vigorFloor ?? plan.vigorFloor ?? p.fightAboveVigor ?? plan.fightAboveVigor ?? 0);
    // An empty larder puts the floor out of reach — resting stops at 80 — so holding
    // out for it would idle the character for ever. Fall back to what resting can
    // deliver, and COUNT it: this is the food supply failing, not a fighting decision,
    // and it should show up as a supply number rather than as a quiet slowdown.
    if (!skills.larderOf(this.s.client).length) {
      this.vigor.starved_passes++;
      return Math.min(want, STARVED_FIGHT_VIGOR);
    }
    return want;
  }

  // TELL THE REST OF THE FLEET WHAT WE ARE SHORT OF AND WHAT WE CAN SPARE.
  //
  // Cheap, and called every pass, because the whole value is in it being current when
  // somebody else is standing at a merchant deciding what to sell.
  declareInterest() {
    const c = this.s.client;
    if (!c) return;
    const want = this.policy.reagentTarget ?? REAGENT_TARGET;
    const r = this.reagentCount();
    const wants = [], spare = new Map();
    for (const [kind, have] of [['elderberry', r.elderberry], ['herb', r.herbs]]) {
      if (have < want) wants.push(kind);
      else if (have > want) spare.set(kind, have - want);
    }
    // No food and nothing to cook with is a want somebody else can answer directly.
    if (!skills.larderOf(c).length && (r.elderberry < 2 || r.herbs < 2)) wants.push('food');
    if (!skills.weaponsOf(c).length) wants.push('weapon');
    skills.interest.declare(this.name ?? this.s.name, { wants, spare });
    // Kept for the party register too. The fleet-wide board is a broadcast — anyone may
    // read it — while a partner needs the same list addressed to it specifically, so
    // that "one of us is short" can become "both of us go to town" rather than each
    // discovering the same shortage separately twenty minutes apart.
    this.wantsNow = wants;
  }

  // What `create food` eats: 2 ElderBerry and 2 Herbs, from OUR pack, and it refuses
  // SILENTLY without them — so the count has to be checked before casting rather than
  // inferred from a failure.
  reagentCount() {
    const c = this.s.client;
    const n = (re) => (c?.inventory || [])
      .filter(o => re.test(c.rsc.get(o.nameRsc) || ''))
      .reduce((t, o) => t + (o.amount || 1), 0);
    return { elderberry: n(/elder\s?berry/i), herbs: n(/^herbs?$/i) };
  }

  // COOK. Returns true if we cast and something appeared, meaning the pass was spent.
  //
  // `why` is the decision that brought us here, carried into the record. It defaults to
  // the only caller's reason rather than to nothing, because "cast create food" with no
  // reason attached is exactly the un-auditable line this is meant to replace.
  async cookSomething(why = 'the larder is empty') {
    const s = this.s, c = s.client;
    const r = this.reagentCount();
    if (r.elderberry < 2 || r.herbs < 2)
      return this.declinedCast('create food', 'not enough reagents',
        { have: r, needs: '2 elderberry + 2 herbs' });
    // c.spells is empty until asked for — reading it cold is the phantom "the spell
    // did not encode" bug.
    await s.pacer.submit('read', () => c.requestSpells()).catch(() => {});
    await new Promise(x => setTimeout(x, 400));
    const spell = (c.spells || []).find(sp => (c.rsc.get(sp.nameRsc) || '').toLowerCase() === 'create food');
    if (!spell)
      return this.declinedCast('create food', 'the character does not have the spell',
        { note: 'an unknown spell and an unlearned one are both simply absent from plSpells' });
    // MANA IS THE CONSTRAINT, NOT THE REAGENTS. Checked BEFORE the cast, because a cast
    // that cannot afford itself is refused silently and looks exactly like every other
    // silent refusal.
    //
    // `create food` costs 10 mana (viMana, Kraanan school — the same number the `spells`
    // tool reports from the kod source). This function checked reagents and never mana,
    // and then the failure note blamed "the reagents having been spent or sold" — so the
    // record actively pointed away from the cause. Of twelve failures on the live fleet,
    // eleven were cast under 10 mana: Pepe at 2, 2, 2 and 3, Lew at 6, 7, 7 and 8,
    // Fozzie at 8 and 9 — while Lew was carrying 16 elderberry and 8 herbs and Zoot 30
    // and 102. Reagents were never short; the fleet had been delivering them to
    // characters that could not afford to use them.
    const manaBefore = c.vitals?.()?.mana?.value ?? null;
    if (manaBefore !== null && manaBefore < CREATE_FOOD_MANA)
      return this.declinedCast('create food', 'not enough mana',
        { mana: manaBefore, needs: CREATE_FOOD_MANA, have_reagents: r,
          note: 'mana comes back by resting; the reagents are already in the pack' });
    const had = new Set((c.inventory || []).map(o => o.id));
    await s.pacer.submit('cast', () => c.cast(spell.id, []), 1050);
    await c.waitFor({ kinds: ['message', 'inventory'], timeoutMs: 4000 }).catch(() => {});
    await new Promise(x => setTimeout(x, 1000));
    await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    const made = (c.inventory || []).filter(o => !had.has(o.id));
    this.vigor.cooked += made.length ? 1 : 0;
    if (!made.length) {
      this.vigor.cook_failed++;
      this.recordCast('create food', { ok: false, why, reagents_before: r,
        mana_before: manaBefore, mana_after: c.vitals?.()?.mana?.value ?? null });
      this.note('create food produced nothing', { had: r, mana: c.vitals?.()?.mana,
        mana_before: manaBefore, needs_mana: CREATE_FOOD_MANA,
        why: 'it refuses silently. Mana is checked before we get here, so reaching this ' +
             'means the cast was affordable and still made nothing — reagents spent or ' +
             'sold between the count and the cast, or the food merged into a stack we ' +
             'already carried and so shows up as no new object id' });
      return false;
    }
    this.recordCast('create food', { ok: true, why, reagents_before: r,
      made: made.map(o => c.rsc.get(o.nameRsc)),
      mana_before: manaBefore, mana_after: c.vitals?.()?.mana?.value ?? null });
    this.note('made our own food', { made: made.map(o => c.rsc.get(o.nameRsc)), from: r });
    this.progress('cooked');
    return true;
  }

  // MAKE A WEAPON RATHER THAN ASK FOR ONE.
  //
  // An unarmed character is not hunting, it is standing in a monster room punching
  // things: GetWeapon returns nothing for an empty hand and UserAttack quietly falls
  // back to a punch, so nothing about it reads as broken from the outside. The keeper
  // used to answer that by wielding whatever survived and, failing that, broadcasting
  // for charity — while carrying a spell that makes a weapon out of nothing but mana.
  //
  // `create weapon` costs 15 mana and refuses SILENTLY below it, so the check is on
  // mana before the cast rather than on the absence of an item afterwards. What it
  // makes is temporary: this buys the fight in front of us and the walk to a shop, and
  // it is not a substitute for a real blade.
  async makeWeapon(why = 'no weapon in the pack') {
    const s = this.s, c = s.client;
    if (!c) return false;
    const mana = c.vitals?.()?.mana;
    if ((mana?.value ?? 0) < 15)
      return this.declinedCast('create weapon', 'not enough mana',
        { mana: mana?.value ?? null, needs: 15 });
    await s.pacer.submit('read', () => c.requestSpells()).catch(() => {});
    await new Promise(x => setTimeout(x, 400));
    const spell = (c.spells || []).find(sp => (c.rsc.get(sp.nameRsc) || '').toLowerCase() === 'create weapon');
    if (!spell)
      return this.declinedCast('create weapon', 'the character does not have the spell');
    // STAND UP. This is the whole reason the spell appeared not to work: a sitting
    // character's cast is swallowed entirely — no mana, no message, no effect — and
    // "make a weapon" is reached almost exclusively from resting, so it was sitting
    // nearly every time. Scooter cast it forty times from an inn for nothing; standing
    // first produced a mace on the next attempt. See standToAct.
    await skills.standToAct(s).catch(() => null);
    // Standing invalidates any rest in progress, so stop believing we are seated — else
    // the unarmed branch will not sit again and the mana never comes back.
    this.sittingFor = null;
    // And shed anything already known dead, because the mana is spent whether or not the
    // weapon survives ReqNewHold (creaweap.kod:116-129).
    await skills.freeRoomFor(s).catch(() => null);
    const had = new Set((c.inventory || []).map(o => o.id));
    await s.pacer.submit('cast', () => c.cast(spell.id, []), 1050);
    await c.waitFor({ kinds: ['message', 'inventory'], timeoutMs: 4000 }).catch(() => {});
    await new Promise(x => setTimeout(x, 1000));
    await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    const made = (c.inventory || []).filter(o => !had.has(o.id));
    const manaAfter = c.vitals?.()?.mana?.value ?? null;
    const spent = mana?.value != null && manaAfter != null ? mana.value - manaAfter : null;
    if (!made.length) {
      this.tally.weapons_conjured_failed = (this.tally.weapons_conjured_failed || 0) + 1;
      this.recordCast('create weapon', { ok: false, why,
        mana_before: mana?.value ?? null, mana_after: manaAfter, mana_spent: spent });
      // The mana says which failure this was, and the reply never does: nothing spent
      // means the cast did not happen at all, half means it rolled and failed, full
      // means it worked and something downstream refused the weapon.
      this.note('create weapon produced nothing', { mana: mana?.value, mana_spent: spent,
        why: spent === 0 ? 'NOTHING was spent — the cast did not happen. Still sitting, frozen, or blocked.'
           : spent != null && spent < 15 ? 'half cost — it was cast and failed its roll'
           : 'full cost — it was cast and succeeded, so the weapon was refused on being handed over' });
      return false;
    }
    const eq = await skills.equipBest(s).catch(() => null);
    this.tally.weapons_conjured = (this.tally.weapons_conjured || 0) + 1;
    this.recordCast('create weapon', { ok: true, why, made: made.map(o => c.rsc.get(o.nameRsc)),
      mana_before: mana?.value ?? null, mana_after: c.vitals?.()?.mana?.value ?? null });
    this.note('conjured a weapon', { made: made.map(o => c.rsc.get(o.nameRsc)),
      now_wielding: eq?.wielding, mana_left: c.vitals?.()?.mana?.value,
      caveat: 'a made weapon is temporary — it buys this fight and the walk to a shop' });
    this.progress('armed itself');
    return true;
  }

  // ARE WE ACTUALLY ARMED, and if not, fix it with what we are carrying or can cast.
  // Called before picking a fight, because the alternative is a level-25 character
  // punching a level-30 centipede and neither the log nor the fleet page saying so.
  async armSelf() {
    const c = this.s.client;
    if (!c) return false;
    await this.wearArmourIfNeeded().catch(() => {});
    if (skills.weaponsOf(c).length) {
      const eq = await skills.equipBest(this.s).catch(() => null);
      if (eq?.wielding) return true;
    }
    return await this.makeWeapon('about to fight with nothing in hand').catch(() => false);
  }

  knowsCreateWeapon() {
    const c = this.s?.client;
    return !!(c?.spells || []).find(
      sp => (c.rsc?.get?.(sp.nameRsc) || '').toLowerCase() === 'create weapon');
  }

  // WEAR THE ARMOUR WE ARE CARRYING.
  //
  // Buying armour and not putting it on is the same as not buying it, and it is the
  // easy failure: the pack says the character owns leather, the server's use list says
  // it is fighting in its shirt, and only the second one is real. Nineteen of
  // twenty-five characters were once found wearing nothing at all.
  //
  // COSTS NOTHING WHEN THERE IS NOTHING TO DO. Both halves of the comparison are
  // already in the client's cache — armourOf reads the inventory we hold, equippedNow
  // reads the use list the server volunteers — so the common case is arithmetic and
  // sends no request at all. Only an actual mismatch pays for a `use`.
  async wearArmourIfNeeded() {
    const c = this.s.client;
    const using = skills.equippedNow(c);
    if (!c || !using) return false;          // no use list: cannot tell, so do not guess
    const have = skills.armourOf(c);
    const missing = skills.ARMOUR_SLOTS.filter(sl => have[sl]?.[0] && !using.has(have[sl][0].o.id));
    if (!missing.length) return false;
    const r = await skills.wearBest(this.s, { slots: missing }).catch(() => null);
    if (r?.worn?.length) {
      this.tally.armour_worn = (this.tally.armour_worn || 0) + r.worn.length;
      this.note('put on armour we were carrying', {
        worn: r.worn.map(w => `${w.name} (${w.slot})`), defense_total: r.defense_total,
        rejected: r.rejected?.length ? r.rejected : undefined,
        why: 'it was in the pack and not in the server\'s use list, which is the only list ' +
             'that fights' });
    }
    return !!r?.worn?.length;
  }

  async provision(plan, v) {
    const p = this.policy;
    const floor = this.fightFloor(plan);
    // EATING IS NOT A STRATEGY OPTION.
    //
    // This returned before it ever looked at the larder unless the policy named a fight
    // floor or a vigor ceiling — so `fightAboveVigor: 0`, which means "no minimum vigor
    // required to fight", silently also meant "never eat". Twelve of twenty-one
    // characters were running exactly that and had not eaten in hours; ten of them sat
    // at 78-80, which is the resting cap, with the fleet's food and reagents idle.
    //
    // What that costs is now measured rather than assumed. Across 6,800 armed
    // observations a character at or below 85 vigor died at 101.8 per thousand against
    // 4.4 in the 86-120 band — and carrying food changed nothing (94.7 without, 133.3
    // with), because carrying is not eating. The single cheapest thing any character can
    // do for its survival is swallow what is already in its pack.
    //
    // So when nothing sets a target, eat to just clear of the cap rather than not at all.
    // A named floor or ceiling still wins; this only fills the silence.
    const ceiling = p.vigorCeiling ?? plan.vigorCeiling
                 ?? (floor ? 0 : (p.eatToAtLeast ?? EAT_TO_AT_LEAST));
    if (!floor && !ceiling) return false;              // only if someone set it to zero on purpose

    const s = this.s;
    const vigor = v.vigor?.value ?? 0;
    const larder = skills.larderOf(s.client);
    const best = larder[0]?.food ?? null;

    if (!best) {
      // MAKE SOME, IF WE CAN. Out of food used to be treated as purely a supply
      // problem, which was true of a fleet that could not cast — and false of this
      // one, where every character knows `create food` and spends all day picking up
      // the two things it consumes. A cast is cheaper than a merchant, cheaper than
      // asking another character, and available in the field where the alternative
      // is a walk back through the rooms that keep killing them.
      if (await this.cookSomething()) return true;   // spend this pass eating instead
      // Genuinely nothing to eat and nothing to make it from. Say it once and carry
      // on fighting at whatever vigor resting gives — refusing to fight would idle
      // the character for ever. fightFloor() has already dropped to the starved floor.
      if (!this.warnedNoFood) {
        this.warnedNoFood = true;
        this.note('no food to raise vigor with', {
          vigor, floor, ceiling, reagents: this.reagentCount(),
          why: 'the larder is empty and there are not 2 elderberry + 2 herbs to cast with',
          hint: 'inky cap mushrooms give the most vigor per unit of stomach (50/25)' });
      }
      this.climbing = false;
      return false;
    }
    this.warnedNoFood = false;

    // Hysteresis: fall through the floor to start climbing, reach the ceiling to stop.
    // With no floor set there is nothing to fall through, so the latch also trips on the
    // ceiling — otherwise the implicit target above would be computed and never used.
    if (vigor < floor || (!floor && vigor < ceiling)) this.climbing = true;

    if (this.climbing) {
      this.doing = 'recovering';
      if (vigor < (ceiling || floor)) {
        const e = await skills.eat(s, { stomach: this.stomach, upToVigor: ceiling || undefined })
                              .catch(() => ({ ate: [] }));
        if (e.ate?.length) {
          this.tally.meals = (this.tally.meals || 0) + 1;
          this.note('ate while stocking up', {
            ate: e.ate, vigor: e.vigor, ceiling,
            stomach: Math.round(this.stomach.level), strategy: p.strategy });
          this.progress('ate to raise vigor');
          return true;
        }
        // Too full to make progress: waiting IS the strategy. Report the clock so
        // this does not read as a stall. Once the last meal has carried us above the
        // fighting floor, though, a long digestion wait is no longer the strategy:
        // set out and eat opportunistically during the hunt instead.
        const wait = this.stomach.secondsUntilRoomFor(best.filling);
        const hurt = (v.health?.value ?? 0) < (v.health?.max ?? 0) * 0.95;
        if (!shouldWaitForProvision({ vigor, floor, wait, hurt })) {
          this.climbing = false;
          this.note('setting out above the fighting floor', {
            vigor, floor, ceiling, stomach: Math.round(this.stomach.level),
            room_for_next_in_s: wait,
            why: 'the configured fighting floor is satisfied and the next top-up is too far away' });
          return false;
        }
        this.note('waiting to get hungry', {
          vigor, ceiling, stomach: Math.round(this.stomach.level),
          room_for_next_in_s: wait, next: larder[0].name,
          why: 'the stomach drains 0.12/s and food is refused above 100 — vigor above ' +
               'the resting threshold of 80 can only come from eating' });
        return true;
      }

      // At the ceiling. Waiting for stomach room before setting out is only worth it
      // if the wait buys something else, because the arithmetic is unforgiving:
      // attacking costs 0.5 vigor a swing at one a second, or 30 a minute, while the
      // very best food sustains 14.4. Nothing closes that gap, so vigor is spent
      // capital and TIME SPENT FIGHTING is what it buys. Idling 3.5 minutes to make
      // room is 3.5 minutes not fighting.
      //
      // The exception is being hurt: at 200 vigor health comes back at a point a
      // second, so an idle spent healing is not idle at all. Wait then, not otherwise.
      const wait = this.stomach.secondsUntilRoomFor(best.filling);
      const hurt = (v.health?.value ?? 0) < (v.health?.max ?? 0) * 0.95;
      if (!this.stomach.roomFor(best.filling) && (hurt || wait <= 60)) {
        this.note('topping off before setting out', {
          vigor, stomach: Math.round(this.stomach.level), room_for_next_in_s: wait,
          healing: hurt, why: hurt
            ? 'at this vigor health returns about a point a second, so the wait heals too'
            : 'the wait is short enough to be worth the top-up' });
        return true;
      }
      this.climbing = false;
      this.note('setting out fed', { vigor, floor, ceiling,
                                     stomach: Math.round(this.stomach.level) });
    }

    // FIGHTING: EAT EVERY TIME THERE IS ROOM. This is where the strategy actually
    // pays, and the old code missed it — it topped up once before setting out and
    // then let vigor sag for the whole hunt, which is the expensive half.
    //
    // Health regeneration goes as ((200-vigor)^2/6 + 1000) ms a point
    // (player.kod:5617), so 200 vigor heals 2.67x as fast as 100 and 3.4x as fast as
    // the 80 that resting alone reaches. Every minute spent fighting at 100 instead
    // of 200 is most of a healing rate thrown away.
    //
    // Stomach room is the throttle, so take all of it whenever it appears rather than
    // one item per pass — a pass is eight seconds and the room reappears on a clock
    // measured in minutes. `eat` declines anything that would overshoot 200.
    if (ceiling && this.stomach.roomFor(best.filling)) {
      const e = await skills.eat(s, { stomach: this.stomach, upToVigor: ceiling })
                            .catch(() => ({ ate: [] }));
      if (e.ate?.length) {
        this.tally.meals = (this.tally.meals || 0) + 1;
        this.note('ate mid-hunt', { ate: e.ate, vigor: e.vigor,
                                    stomach: Math.round(this.stomach.level) });
      }
    }

    // Say once whether the larder can actually sustain a hunt. The stomach drains
    // 0.12 filling a second, so the best food in the pack sets a hard ceiling on
    // vigor per minute — and it is well under what swinging costs.
    if (!this.warnedThroughput) {
      this.warnedThroughput = true;
      const perMin = +(best.nutrition / best.filling * 0.12 * 60).toFixed(1);
      this.note('vigor throughput', {
        food: larder[0].name, sustains_vigor_per_min: perMin,
        attacking_costs_per_min: 30,
        note: perMin < 30
          ? 'vigor cannot be held while swinging; it is spent capital, and better food ' +
            'buys more fighting time (inky cap 14.4/min vs wheel of cheese 5.4)'
          : undefined });
    }
    return false;
  }

  safety() {
    const v = this.s.client?.vitals?.();
    const max = v?.health?.max ?? 0;
    if (!max) return { fleeAt: this.policy.fleeBelow, engageAt: 0.85, maxHit: null };
    const maxHit = Math.min(30, Math.floor((max + 2) / 3));
    // Two hits of margin, not three. (base+2)/3 is the CAP on a single blow rather
    // than what a giant rat typically lands, so budgeting three of them leaves so
    // little of the bar to fight in that the character spends its life healing.
    // Two is the number that survives the realistic bad case — one hit landing as
    // the withdraw begins, and one more before it is out of reach — while still
    // leaving a usable window to actually fight in.
    const fleeAt = Math.max(this.policy.fleeBelow, Math.min(0.7, (2 * maxHit) / max));
    return {
      maxHit, fleeAt,
      // Do not start a fight that cannot be finished. Below this, heal or rest
      // first — going in at half health is how a survivable creature kills you.
      engageAt: max < 30 ? 0.9 : 0.75,
    };
  }

  // ------------------------------------------------------------- safe spots
  //
  // THE MOST VALUABLE THING ON THE MAP IS A PLACE TO STAND.
  //
  // In a working safe spot NO MONSTER CAN HIT YOU UNLESS YOU SWING AT IT FIRST. That
  // one sentence reorganises the whole of the rest of this file, because every
  // expensive decision the keeper makes is a decision about damage it cannot stop:
  //
  //   fleeing      is a walk of several seconds during which it is still being hit,
  //                and it is a gamble that has killed characters here. From a spot
  //                there is nothing to flee: stop swinging and the damage stops.
  //   logging off  buys a minute of safety at the price of not healing, because the
  //                same flag gates the grace period and HealthTimer. From a spot we
  //                can spend the flag — turn, wake them, let them come, and heal to
  //                full anyway, because none of them can reach us.
  //   a swarm      is the commonest death in this fleet. Seven of the eight squares
  //                a swarm needs are wall.
  //
  // So the policy is: fight from a wall whenever the fight is worth fighting, and
  // treat "am I in a spot that is actually working?" as a question with an
  // observable answer rather than a hope. That is what observe() is for.

  // WHO IS ACTUALLY TRYING TO KILL US.
  //
  // The protocol never says, and there is no packet to ask with — the server keeps
  // targeting on the monster's side and sends us positions and damage. So this is two
  // estimates, and they answer different questions:
  //
  //   COULD reach us   things standing close enough to swing. A count, nothing more,
  //                    and it is what decides whether walking out of here is safe.
  //   IS reaching us   health going down while we sit still and do not swing. Ground
  //                    truth, and the only evidence that says whether where we are
  //                    standing works.
  //
  // `engaged` is the useful middle: things that have been camped next to us for more
  // than one pass are trying to hit us whether or not they are landing anything. That
  // is the number a reconnect resets to about one, and the reason breakOut() works.
  threat() {
    const c = this.s.client, me = c?.self;
    const empty = { adjacent: [], near: [], engaged: 0, landing: 0, names: [] };
    if (!c || !me) return empty;
    const hostiles = [...c.room.objects.values()].filter(o =>
      o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER));
    const d = o => Math.hypot(o.col - me.col, o.row - me.row);
    const adjacent = hostiles.filter(o => d(o) <= REACH);
    const camped = this.campedIds || new Set();
    return {
      adjacent,
      near: hostiles.filter(o => d(o) <= CROWD_RADIUS),
      engaged: adjacent.filter(o => camped.has(o.id)).length,
      landing: this.idleDamage || 0,
      names: [...new Set(hostiles.filter(o => d(o) <= CROWD_RADIUS).map(o => c.rsc.get(o.nameRsc)))],
    };
  }

  // Are we standing somewhere we have EVIDENCE about, or somewhere that merely looks
  // right? Nothing in this file may spend the safe-spot advantage on a guess: an
  // unproven spot is treated exactly like open floor, which is what it might be.
  holdWorks() { return !!(this.hold && this.hold.proven); }

  // IS THERE A WEAPON IN OUR HAND — asked of the server, never of our own intentions.
  //
  // plUsing is the only authority (see equipment()): "the last use we sent was not
  // refused" has been wrong every time it mattered, because a weapon that shatters
  // mid-fight leaves the use list without anything being sent at all. A character that
  // cannot answer is treated as ARMED, because refusing to fight on a failed read would
  // idle the whole fleet the first time an inventory request timed out — the guard is
  // meant to catch the empty hand, not to become a new way to stop.
  armed() {
    const c = this.s.client;
    const eq = c?.equipment?.();
    if (!eq || eq.known === false) return true;
    return (eq.equipped || []).some(o =>
      skills.weaponScore(o.name ?? c.rsc?.get?.(o.nameRsc) ?? '') > 0);
  }

  // THE SAME QUESTION, FAILING THE OTHER WAY.
  //
  // armed() treats "cannot answer" as armed, and that is right where it is used: a
  // failed read must not stop a character mid-fight. It is exactly wrong for deciding
  // whether to WALK OUT OF AN INN, and that difference killed characters.
  //
  // `known` is false until the first BP_USE_LIST lands, which is precisely the window
  // just after a login — and a resume logs in twenty-one characters at once. So on the
  // pass right after a restart, every character answers "armed" on no evidence at all,
  // the farm branch reads that as permission, and marches an empty-handed character out
  // of the sanctuary it woke up in. Zoot did it with ten mana and no weapon: pass 0
  // "started", pass 2 "this room spawns nothing at all — going back to work", and dead
  // in the Yonder Inn's back yard four minutes later without one unarmed note in the
  // journal, because nothing ever asked a question this could answer no to.
  //
  // Leaving safety is the one decision that should need POSITIVE EVIDENCE. Waiting a
  // pass for the use list costs a second; being wrong costs the character everything it
  // was carrying.
  armedForSure() {
    const c = this.s.client;
    const eq = c?.equipment?.();
    if (!eq || eq.known === false) return false;       // no evidence is not a weapon
    return (eq.equipped || []).some(o =>
      skills.weaponScore(o.name ?? c.rsc?.get?.(o.nameRsc) ?? '') > 0);
  }

  // WHOLE ENOUGH TO GO BACK OUT, asked only after a death.
  //
  // Health to nearly full, and vigor to what RESTING CAN ACTUALLY DELIVER — not to
  // full. Everything above REST_VIGOR_CAP (80 of 200) has to be eaten, so demanding
  // more than that here would demand a number sitting down can never reach and the
  // character would rest in an inn for ever. That is the same trap `vigorRestAt`
  // exists to avoid a few lines below, and it is worth saying twice: getting it wrong
  // does not error, it silently retires the character.
  //
  // 0.95 rather than 1 because health arrives in whole points — a 29-max character
  // sits at 28/29 for a long time, and the last point is not worth blocking on.
  // Deliberately the same pair of numbers as the sanctuary check at the top of rest().
  //
  // MANA IS REQUIRED NOW, AND IT WAS THE MISSING THIRD. This used to say mana was not
  // needed because nothing needs it to swing. That is true and it is beside the point:
  // `create weapon` costs 15, it is the only route to a weapon for a character that
  // just lost everything it owned, and a character that leaves the inn at 10 mana
  // cannot cast it and cannot get back above 10 anywhere else — mana barely moves while
  // something is hitting you.
  //
  // That is the loop this closes. Zoot, Rizzo and Animal were all released by the old
  // bar — full health, vigor at the cap, ten-odd mana, no weapon — walked to a hunting
  // ground they could not fight in, and died there. Unlike vigor, mana genuinely does
  // refill on its own while sitting, so waiting for it is a wait that ends.
  //
  // Vigor stays at what RESTING CAN ACTUALLY DELIVER — not full. Everything above
  // REST_VIGOR_CAP (80 of 200) has to be eaten, so demanding more would demand a number
  // sitting down can never reach and the character would rest in an inn for ever. That
  // trap is why this is worth saying twice: getting it wrong does not error, it
  // silently retires the character. The shortfall above 80 is a food problem and
  // provision()/cookSomething() are what answer it.
  //
  // AND A DEADLINE, for the same reason. Three vitals means three ways to wait for
  // something that is not coming — a mana bar that will not fill because the character
  // is being nibbled, a health point that never lands. RECOVER_MAX_MS is long enough
  // that a genuine recovery always finishes inside it and short enough that a stuck one
  // is a stall rather than a retirement.
  recovered() {
    const v = this.s.client?.vitals?.();
    const hp = pct(v?.health);
    if (hp === null) return false;                     // cannot tell — keep resting
    const done = (why) => { this.recoverUntilWhole = false; this.recoverSince = null;
                            if (why) this.note('going back out before fully recovered', why);
                            return true; };
    // The deadline is checked FIRST, so a character that cannot reach the bar leaves
    // rather than sitting for ever — and says which vital it gave up on.
    const since = this.recoverSince ?? null;
    if (since && Date.now() - since > RECOVER_MAX_MS)
      return done({ waited_s: Math.round((Date.now() - since) / 1000),
                    health: v?.health?.pct ?? null, mana: v?.mana?.pct ?? null,
                    vigor: vigorOf(v),
                    why: 'recovering has a deadline: three vitals is three ways to wait for ' +
                         'something that is not coming, and a character parked in an inn for ever ' +
                         'is a character retired by accident' });
    if (hp < 0.95) return false;
    if ((vigorPct(v) ?? 1) < REST_VIGOR_CAP) return false;
    // A zero or unreadable mana ceiling is not a shortfall — it is a character that has
    // no bar to fill, and blocking on it would be the retirement this guards against.
    const mp = pct(v?.mana);
    if (mp !== null && mp < 0.95) return false;
    return done(null);
  }

  // The experiment, run once per pass, for free, out of readings we already take.
  //
  // Between the last look and this one: did we stand still, did we refrain from
  // swinging, was there something adjacent that wants us dead — and did our health
  // hold? All four have to be true for the answer to mean anything, which is why this
  // tracks when we last moved and last swung. Damage arriving after a swing is
  // retaliation and says nothing at all about the square.
  observe() {
    const s = this.s, c = s.client, me = c?.self;
    const room = s.world?.room, now = Date.now();
    const health = c?.vitals?.()?.health?.value ?? null;
    const prev = this.lastObs;

    const hostiles = me ? [...c.room.objects.values()].filter(o =>
      o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER)) : [];
    const adjacentIds = me
      ? hostiles.filter(o => Math.hypot(o.col - me.col, o.row - me.row) <= REACH).map(o => o.id)
      : [];
    this.campedIds = new Set(adjacentIds.filter(id => (prev?.adjacentIds || []).includes(id)));

    // A hold belongs to a room and to a square. Losing either loses it, and saying so
    // out loud matters more than it looks: a keeper that believes it is behind a wall
    // when it is not will make every following decision the wrong way round.
    if (this.hold && room?.num != null && this.hold.room !== room.num)
      this.releaseHold('we are not in that room any more');
    if (this.hold && me && (me.col !== this.hold.col || me.row !== this.hold.row))
      this.releaseHold('we are not standing on it any more');
    if (this.hold && me && me.x != null) { this.hold.x = me.x; this.hold.y = me.y; }

    // ARE THEY EVEN ALLOWED TO HIT US YET? On entry — including every reconnect —
    // the server withholds the monsters until the player acts. A quiet window inside
    // that period says nothing about the walls, and counting it would let the single
    // most dangerous mistake in this file happen quietly: a bad square proved safe by
    // evidence gathered while nothing was permitted to swing.
    const acted = Math.max(this.swungAt, this.movedAt, this.turnedAt);
    const awake = acted > this.rejoinedAt;

    this.idleDamage = 0;
    // Strictly before, not at: observe() runs at the top of a pass and everything else
    // in that pass happens after it, so a swing stamped at the same instant as the last
    // look is a swing we have not accounted for. Ambiguity here throws the window away,
    // which costs one reading and can never invent evidence either way.
    const stillness = prev ? (this.swungAt < prev.at && this.movedAt < prev.at) : false;
    const company = (prev?.adjacentIds || []).length;
    const lost = prev && health != null && prev.health != null ? prev.health - health : null;
    // HOW LONG WE HAD BEEN STANDING STILL ON THIS SQUARE WHEN THIS WINDOW OPENED — see
    // SETTLE_GRACE_MS. The later of the two clocks, because either one being recent
    // means damage from before we settled can still be arriving: `movedAt` covers
    // walking in, `hold.takenAt` covers claiming a square we were already on.
    const settledAt = Math.max(this.movedAt, this.hold?.takenAt ?? 0);
    const settledMs = prev ? prev.at - settledAt : 0;
    const settled = settledMs >= SETTLE_GRACE_MS;

    // The reading, whatever became of it. `verdict` is the thing to argue with; the
    // fields above it are what the argument is about. A discard is recorded exactly as
    // carefully as a conclusion, because a wrong discard is invisible otherwise.
    const trial = {
      at: now, pass: this.passes,
      room: room?.num ?? null,
      at_col: me?.col ?? null, at_row: me?.row ?? null,
      window_s: prev ? +((now - prev.at) / 1000).toFixed(1) : null,
      health_before: prev?.health ?? null, health_after: health, lost,
      adjacent_at_start: company, adjacent_now: adjacentIds.length,
      swung_in_window: prev ? this.swungAt >= prev.at : null,
      moved_in_window: prev ? this.movedAt >= prev.at : null,
      // How settled we were when this window opened. On a counted failure this is the
      // number that says whether SETTLE_GRACE_MS is wide enough; without it the question
      // can only be argued from intuition, which is how the square gets retired twice.
      settled_ms: prev ? Math.max(0, settledMs) : null,
      monsters_awake: awake,
      verdict: null, counted: false,
    };
    const settle = (verdict, counted = false) => {
      trial.verdict = verdict;
      trial.counted = counted;
      if (this.hold) {
        trial.quiet_total_s = Math.round(this.hold.quietMs / 1000);
        trial.proven_after = this.hold.proven;
      }
      this.trials.push(trial);
      if (this.trials.length > 120) this.trials.splice(0, this.trials.length - 120);
      return trial;
    };

    if (!this.hold) settle('not holding a spot — nothing to test');
    else if (!prev) settle('no previous reading to compare against');
    else if (health == null || prev.health == null) settle('health unreadable in one of the two readings');
    else if (!awake) settle('inside the entry grace period — the server is holding them back, so quiet proves nothing');
    else if (!stillness) settle(this.swungAt >= prev.at ? 'we swung in this window — damage would be retaliation'
                                                        : 'we moved in this window — we were not standing here throughout');
    else if (company === 0) settle('nothing was in swing range — a quiet window with nothing to be quiet about');
    else if (!settled) settle(`only ${Math.max(0, settledMs)}ms settled on this square when the window ` +
                              `opened, under the ${SETTLE_GRACE_MS}ms grace — a blow resolved before we ` +
                              'got here can still be arriving, and it is not this square\'s fault');

    if (this.hold && awake && prev && health != null && prev.health != null) {
      if (stillness && company > 0 && settled) {
        this.hold.mostAttackers = Math.max(this.hold.mostAttackers, company);
        if (lost > 0) {
          // It does not work. Say so loudly, forget the proof, and write it down so
          // that the geometry cannot talk us back onto this square in ten minutes.
          this.idleDamage = lost;
          this.hold.failures++;
          this.hold.damageWhileIdle += lost;
          this.hold.quietMs = 0;
          const wasProven = this.hold.proven;
          this.hold.proven = false;
          this.book.failed(this.hold.room, {
            col: this.hold.col, row: this.hold.row, damage: lost, attackers: company,
            settledMs });
          this.book.save();
          this.note('THIS IS NOT A SAFE SPOT', {
            where: { col: this.hold.col, row: this.hold.row }, room: room?.num,
            lost_health: lost, attackers: company, was_proven: wasProven,
            settled_ms: Math.max(0, settledMs),
            why: 'we were hit while standing still and not swinging, which is the one thing ' +
                 'that cannot happen in a working spot',
            caveat: 'poison and archers look the same from here, so this reading can be wrong — ' +
                    'but it is still permanent, and deliberately so. See discredited() in ' +
                    'm59-safespots.mjs: the two-failure rule this used to describe is what left ' +
                    'a square recommended after it killed somebody' });
          // Settle the reading BEFORE letting the hold go, or the record loses the
          // very state it is a record of.
          settle(`HIT for ${lost} while standing still with ${company} adjacent — this square does not work`, true);
          // And stop standing in it. Keeping the hold would mean fighting from a
          // square we have just watched fail — refusing to approach, refusing to
          // withdraw, and taking hits the whole time. Letting it go puts the next
          // pass back on the ordinary path, which will either find a better square or
          // fight in the open with the flee threshold live.
          this.releaseHold('it does not work — we were hit standing still in it');
        } else {
          this.hold.quietMs += now - prev.at;
          const alreadyProven = this.hold.proven;
          if (!this.hold.proven && this.hold.quietMs >= PROOF_MS) {
            this.hold.proven = true;
            this.hold.provenAt = now;
            this.book.held(this.hold.room, {
              col: this.hold.col, row: this.hold.row, x: this.hold.x, y: this.hold.y,
              seconds: this.hold.quietMs / 1000, attackers: this.hold.mostAttackers });
            this.book.save();
            this.note('this safe spot works', {
              where: { col: this.hold.col, row: this.hold.row }, room: room?.num,
              quiet_for_s: Math.round(this.hold.quietMs / 1000), attackers: this.hold.mostAttackers,
              why: 'things have been standing next to us for ' +
                   Math.round(this.hold.quietMs / 1000) + 's and none of them has landed a blow',
              means: 'we can now rest to full here instead of running, and break off any fight ' +
                     'that turns against us at no cost',
              ...(this.spotTest ? { learned_by: 'deliberately holding the swing to find out' } : {}) });
            this.spotTest = null;      // the question is answered; get on with the fight
          }
          // Settled last, so that `proven_after` on this reading says what this
          // reading concluded rather than what was believed before it.
          settle(this.hold.proven && !alreadyProven
            ? `PROVED: ${Math.round(this.hold.quietMs / 1000)}s quiet with up to ` +
              `${this.hold.mostAttackers} adjacent, nothing landed`
            : alreadyProven
              ? `still holding: ${company} adjacent, nothing landed`
              : `quiet with ${company} adjacent — ${Math.round(this.hold.quietMs / 1000)}s of the ` +
                `${PROOF_MS / 1000}s needed`, true);
        }
      }
    }

    // Where we were standing, kept briefly after the hold itself is gone. A death
    // releases the hold before anything gets to ask about it — the Underworld is a
    // different room, so observe() drops it on the very pass that discovers we died —
    // and "were we in a spot when we were killed?" is the question the whole thesis
    // turns on. Thirty seconds is long enough to survive that ordering and short
    // enough that it cannot be mistaken for where we are now.
    if (this.hold) this.lastHold = { ...this.hold, at: now };

    this.lastObs = { at: now, health, adjacentIds,
                     col: me?.col ?? null, row: me?.row ?? null, room: room?.num ?? null };
  }

  releaseHold(why) {
    if (!this.hold) return;
    const h = this.hold;
    this.note('gave up the safe spot', {
      where: { col: h.col, row: h.row }, why, proven: h.proven,
      held_s: Math.round((Date.now() - h.takenAt) / 1000) });
    this.hold = null;
    releaseSpot(this.s.name);
    this.book.save();
  }

  // What level is this thing, so we can ask whether killing it pays.
  creatureLevel(name) {
    const all = loadSpawns(SPAWN_FILE)?.creatures;
    const q = String(name || '').toLowerCase();
    if (!all || !q) return null;
    if (all[q]) return all[q].level ?? null;
    // "rat" has to resolve to "giant rat". Where a partial name matches several,
    // take the TOUGHEST: the cautious reading of an ambiguous name is the dangerous
    // one, and being wrong in that direction only costs a walk to a corner.
    let best = null;
    for (const [k, v] of Object.entries(all)) {
      if (!k.includes(q) && !q.includes(k)) continue;
      if (v.level != null && (best == null || v.level > best)) best = v.level;
    }
    return best;
  }

  // IS THIS FIGHT WORTH A WALL? The owner's rule of thumb, which turns out to be
  // exactly the rule the game already uses: if you can gain max health from it, fight
  // it from a safe spot.
  //
  // AdvancementCheck only rolls when monster_level > base_max_health, and max health
  // IS the level here — so "this kill can make me stronger" and "this creature is at
  // or above my level" are the same statement, and something at or above your level
  // is something that can take a third of your bar in one blow. The two halves of the
  // rule are the same fact read from either end.
  //
  // The exception is the one the rule names: prey we outclass pays nothing, cannot
  // realistically kill us, and the walk to the corner costs more than the fight.
  holdWorthwhile(names = []) {
    if (!this.policy.useSafeSpots) return { hold: false, why: 'safe spots are switched off in the policy' };
    const mine = this.s.client?.vitals?.()?.health?.max ?? 0;
    const levels = names.map(n => this.creatureLevel(n)).filter(x => x != null);
    const worst = levels.length ? Math.max(...levels) : null;
    const crowd = this.threat().near.length;
    if (worst == null)
      return { hold: true, crowd,
               why: 'nothing is known about what is here, and the careful reading of an unknown ' +
                    'creature is that it can hurt us' };
    if (worst > mine)
      return { hold: true, level: worst, my_level: mine, crowd,
               why: `a level ${worst} kill can raise our maximum health of ${mine}. Anything that ` +
                    'pays is by definition at or above our level, and anything at our level can ' +
                    'take a third of the bar in one blow — so fight it from a wall' };
    if (crowd >= 3)
      return { hold: true, level: worst, my_level: mine, crowd,
               why: `we outclass a level ${worst}, but there are ${crowd} of them within four ` +
                    'squares and swarms are what actually kills characters here' };
    return { hold: false, level: worst, my_level: mine, crowd,
             why: `level ${worst} against our ${mine}: the kill pays nothing — AdvancementCheck ` +
                  'needs the monster above our max health — and we are strong enough that the ' +
                  'walk to a corner costs more than the fight does' };
  }

  // Go and stand somewhere defensible, preferring somewhere we have already proved —
  // and somewhere the fight can actually be brought to.
  async takeSafeSpot(why, quarry = null) {
    const s = this.s, c = s.client;
    const room = s.world?.room, geo = s.world?.geometry, me = c?.self;
    if (!geo || !me || !room) return { took: false, why: 'no geometry for this room' };
    // Squares we have already discovered nothing can be pulled to. Without this the
    // keeper re-picks the same unusable corner every pass for ever, because the
    // geometry's opinion of it never changes and neither does ours.
    const barren = this.barrenSpots?.get(room.num);
    // Can the thing we came to fight actually get to the square? We already have the
    // quarry here and only ever used it to bias direction; this is the same fact asked
    // from the other end, and it is the one that was missing.
    const los = this.policy.los ?? 0;                       // LOS_OLD, the server default
    const quarryReach = (quarry && quarry.col != null && geo.monsterCanReach)
      ? (col, r2) => geo.monsterCanReach(quarry.row, quarry.col, r2, col, { los })
      : null;
    // SEARCH THE WHOLE ROOM. A RADIUS IS THE WRONG SHAPE OF ANSWER.
    //
    // `within` was a flat 12 squares from wherever the character happened to be
    // standing — a fact about the character, not about the room. Measured against the
    // live fleet, the rooms it was declaring wall-less hold 210 to 549 defensible
    // squares each, of which 124 to 206 are plain wall edges, and the book had tried
    // between 60 and 129. Nothing was exhausted. The search simply was not looking:
    // "found no wall" meant "did not walk far enough to see one".
    //
    // NEAR IS STILL PREFERRED, and it does not need a cutoff to be. The ranking already
    // pays 0.5 per step from us and 1.2 per step from the fight, so a merely-adequate
    // wall underfoot beats an excellent one thirty squares away on the arithmetic —
    // which is the behaviour the radius was reaching for, expressed as a preference
    // instead of a wall. Searching wide changes what is CONSIDERED, not what is chosen.
    //
    // Bounded by the room's own dimensions, so this is one pass over the floor.
    const within = Math.max(geo.rows ?? 0, geo.cols ?? 0) || 64;
    const spotStats = {};
    // FILL EVERY WALL ONCE BEFORE ANY WALL TAKES A SECOND.
    //
    // The search is run with a share cap and re-run one step higher when it finds
    // nothing, so the first keepers into a room take squares nobody is on, and only once
    // every square is occupied does anyone accept a neighbour. Four walls and eight
    // characters settle at two apiece without anybody computing that; four walls and four
    // characters still get one each, which is the old behaviour exactly.
    //
    // Cheap because the expensive part is per-candidate pathfinding inside
    // nearestSafeSpot, and a re-run only happens when the first pass rejected everything
    // — which in an uncrowded room never occurs.
    let spot = null, shareCap = 1;
    for (; shareCap <= SPOT_SHARE_CAP; shareCap++) {
      for (const k of Object.keys(spotStats)) delete spotStats[k];   // stats describe the LAST attempt
      spot = this.searchSafeSpot(geo, me, room, {
        within, quarryReach, los, quarry, barren, stats: spotStats, shareCap });
      if (spot) break;
    }
    if (spot && shareCap > 1)
      this.note('sharing a wall rather than standing in the open', {
        with: spotOccupancy(this.s.name, room.num, spot.col, spot.row), at: { col: spot.col, row: spot.row },
        why: `every wall in this room already had ${shareCap - 1} on it, and two to a wall ` +
             'beats one on a wall and one in the open' });
    if (!spot) {
      // Distinguish "flat room" from "ledge system". The second reads as the first
      // unless it is said out loud, and it was West Merchant Way for five characters.
      if (spotStats.unreachable_by_quarry > 0) {
        this.note('every defensible square here is out of the fight\'s reach', {
          considered: spotStats.considered, unreachable: spotStats.unreachable_by_quarry,
          quarry: quarry ? { col: quarry.col, row: quarry.row } : null,
          why: 'this is a ledge or clifftop system: the squares that score well do so ' +
               'BECAUSE nothing can get to them, which also means nothing will come.',
          note: 'fighting in the open here is the correct answer; a better room is a better one' });
        return { took: false, unreachable_terrain: true,
                 why: `${spotStats.unreachable_by_quarry} of ${spotStats.considered} defensible ` +
                      'squares here cannot be reached by what we are fighting' };
      }
      return { took: false, why: 'nothing in this room is more defensible than open floor' };
    }

    // CLAIM IT BEFORE WALKING, not after arriving. Choosing and taking are separated
    // by a walk, and a walk is an await: three keepers each looked at the room, each
    // saw (29,15) unclaimed because none of them had got there yet, and all three set
    // off for it. Reserving at selection time is what makes the register mean
    // anything; if the walk fails the reservation goes back.
    claimSpot(this.s.name, room.num, spot.col, spot.row);

    if ((spot.steps_away ?? 99) > 0) {
      this.doing = 'travelling';
      // THE SQUARE IS THE WHOLE MECHANIC. THERE IS NOTHING FINER TO STAND ON.
      //
      // This used to aim 24 of the 64 fine units toward the wall on the theory that the
      // real physics was finer than the movement grid, so a spot that worked by hugging
      // a wall would be most of a square off centre and a first visit conducted from the
      // middle of the floor would manufacture a false failure. The theory was wrong, and
      // the server says so plainly. Being hit is two tests and neither of them can see a
      // fine coordinate:
      //
      //   SquaredDistanceTo = (piRow-row)^2 + (piCol-col)^2         nomoveon.kod:121
      //   CanReach          = that <= range^2, then LineOfSight     monster.kod:1736
      //
      // Both read piRow/piCol, which are SQUARE coordinates. piFine_row and piFine_col do
      // exist on every object, and the only thing in the game that reads them is
      // MonsterOrient, to choose the angle a monster is DRAWN facing (monster.kod:2189).
      // So the offset could not have helped at any size, and 1 or 0 would have been no
      // better than 24 — the lever was not connected to anything.
      //
      // The book agrees, having accidentally run the experiment: of 411 recorded
      // positions the 72 taken at a hugged offset held 52% of the time against 87% for
      // the 339 taken at the square centre, and the gap survives excluding the retests.
      // It was not merely inert either — returnToSpot arrives within 12 fine units, so a
      // target 24 off centre costs up to six extra move packets shuffling at the wall,
      // can finish out of tolerance, and then releases the claim and reports a perfectly
      // good square unreachable.
      //
      // A REMEMBERED position is still honoured: it is a record of where we actually
      // stood, it costs nothing to reuse, and returning to it is free of the above
      // because we were demonstrably able to stand there. Only the synthesis is gone.
      const fine = spot.fine;
      const arrival = fine
        ? await skills.returnToSpot(s, { col: spot.col, row: spot.row, ...fine }, { maxSteps: 24 })
                      .catch(e => ({ arrived: false, why: e.message }))
        : await s.walkTo(spot.col, spot.row, { maxSteps: 24 })
                 .catch(e => ({ arrived: false, why: e.message }));
      this.movedAt = Date.now();
      if (!arrival.arrived) {
        releaseSpot(this.s.name);      // hand the reservation back
        this.note('could not reach the safe spot', {
          spot: { col: spot.col, row: spot.row }, why: arrival.why || arrival.reason });
        return { took: false, why: arrival.why || arrival.reason || 'could not get there' };
      }
    }

    const now = c.self;
    const known = this.book.get(room.num, spot.col, spot.row);
    const trusted = !!known?.held && !this.book.discredited(known);
    this.hold = {
      room: room.num, col: spot.col, row: spot.row,
      x: now?.x ?? null, y: now?.y ?? null,
      takenAt: Date.now(), quietMs: 0, damageWhileIdle: 0, failures: 0, mostAttackers: 0,
      // Walls do not move, so a square that held on a previous visit is believed on
      // arrival — that is the entire point of writing the book down. The experiment
      // still runs, and a single failure takes the belief straight back off it.
      // Inherit belief only from a CLEAN record. A square that has ever failed is
      // discredited for good, and nearestSafeSpot will not offer one — but this is also
      // reached by hand-picked and remembered spots, and trusting `held` alone would
      // walk a character back onto the square that killed the last one.
      proven: trusted, inherited: trusted, provenAt: trusted ? Date.now() : null,
      canReachYou: spot.can_reach_you, freeShots: spot.free_shots, backCover: spot.back_cover,
    };
    // Tell the other keepers this one is taken, so the next of them to look at this
    // room ranks it out instead of walking into us.
    claimSpot(this.s.name, room.num, spot.col, spot.row);
    this.note('took a safe spot', {
      where: { col: spot.col, row: spot.row }, why,
      can_reach_you: spot.can_reach_you, free_shots: spot.free_shots, back_cover: spot.back_cover,
      proven_before: known?.failed ? `DISCREDITED — failed ${known.failed} time(s) here`
                   : known?.held   ? `held ${known.held} time(s) before`
                   :                 'never tested',
      note: trusted
        ? 'this square has held under attack before and never failed, so it is trusted on arrival'
        : known?.failed
        ? 'this square has failed before; it is treated as open floor and should not have ' +
          'been offered — a failure is permanent'
        : 'unproven: it will be treated as open floor until something stands next to us ' +
          'for ' + Math.round(PROOF_MS / 1000) + 's without landing a blow',
    });
    return { took: true, spot: this.hold };
  }

  // GO AND FETCH IT.
  //
  // A safe spot only pays if the fight happens AT it, and monsters do not queue up:
  // the generator drops them where it likes and plenty will simply stand there. So
  // the move a player makes is to run out, hit it once so that it follows, and run
  // back — the fight then happens where we chose rather than where it spawned.
  //
  // The single swing is the whole purpose of the trip. Standing out there trading
  // blows is precisely what walking to the wall was meant to avoid.
  async pull(want) {
    const s = this.s, c = s.client;
    if (!this.hold) return { pulled: false, why: 'not holding a spot to pull it back to' };
    const spot = { ...this.hold };
    // NEVER TRUST A CAPTURED OBJECT'S COORDINATES. BP_ROOM_CONTENTS replaces the
    // whole object map with fresh instances, so anything picked up earlier in the
    // pass — before we walked to the wall, say — still holds the position it was at
    // then. Routing to that is routing to where the monster used to be.
    const foe = c.room.objects.get(want.id);
    if (!foe) return { pulled: false, why: 'it is not in the room any more' };
    const name = c.rsc.get(foe.nameRsc);
    const approach = s.world?.approachSquare?.(foe.col, foe.row);
    if (!approach) return { pulled: false, why: 'no square beside it that we can reach' };
    // NO DISTANCE LIMIT. IF WE CAN GET TO IT, IT IS WORTH FETCHING.
    //
    // This refused anything more than `pullWithin` steps away as "too far to fetch and
    // get back", which reads as prudence and is not. The walk out is taken before the
    // thing has noticed us and the walk back is the only part that costs anything, so a
    // long pull is not more dangerous than a short one — it is the same danger for
    // longer, and it ends with the fight happening at the wall instead of in the open,
    // which is the entire point. Refusing it does not avoid the fight; it leaves the
    // keeper standing at a good spot with nothing to kill, which is how a character
    // spends an hour reporting itself safe and earning nothing.
    //
    // The step budgets below are all relative to `approach.steps`, so they scale with
    // the trip and nothing here needs a ceiling to stay bounded. Patience is the
    // correct behaviour: walk however far it is, hit it once, walk back.
    //
    // `pullWithin` survives as an explicit override for anyone who wants one — the
    // broker still exposes it as `pull_within` — but it is unset by default.
    if (approach.steps > (this.policy.pullWithin ?? Infinity))
      return { pulled: false, why: `${approach.steps} steps away — beyond the pull_within override` };

    this.doing = 'fighting';
    const out = await s.walkTo(approach.col, approach.row, { maxSteps: approach.steps + 8 })
                       .catch(e => ({ arrived: false, reason: e.message }));
    this.movedAt = Date.now();
    if (!out.arrived) {
      const home = await skills.returnToSpot(s, spot, { maxSteps: 24 }).catch(() => ({ arrived: false }));
      this.movedAt = Date.now();
      if (!home.arrived) this.releaseHold('could not get back after a failed pull');
      return { pulled: false, why: out.reason || 'could not get to it' };
    }

    const it = c.room.objects.get(foe.id);
    if (it) {
      await s.faceToward(it);
      await s.pacer.submit('attack', () => c.attack(foe.id), 1050);
      this.swungAt = Date.now();
      this.foeId = foe.id;
    }

    const home = await skills.returnToSpot(s, spot, { maxSteps: approach.steps + 12 })
                             .catch(e => ({ arrived: false, why: e.message }));
    this.movedAt = Date.now();
    if (!home.arrived) {
      this.releaseHold('could not get back to it after pulling');
      return { pulled: true, back: false, target: name,
               why: home.why || 'hit it but could not get back to the wall' };
    }
    // We left and returned, so nothing is proved about the square any more until the
    // experiment runs again. The belief survives; the running clock does not.
    this.hold.quietMs = 0;
    this.note('pulled it to the wall', {
      target: name, went: approach.steps, back_at: { col: spot.col, row: spot.row },
      why: 'a safe spot is only worth anything if the fight happens at it' });
    return { pulled: true, back: true, target: name, steps: approach.steps };
  }

  // LEAVING A SAFE SPOT WITH A CROWD ON IT.
  //
  // Everything that makes the spot good makes stepping off it bad. The things that
  // could not reach us are standing in exactly the squares we have to walk through,
  // and every one of them gets its attacks back the moment we come out from behind
  // the wall — which is how a character survives twenty minutes of siege and then
  // dies in the four seconds after it decides to leave.
  //
  // A reconnect resets that. The entry grace period is handed out again and monsters
  // only wake as we act, so instead of walking out through five creatures that are
  // already swinging we walk out through five of which about one has noticed. It
  // costs a few seconds.
  async breakOut(why) {
    const t = this.threat();
    if (!this.policy.breakOutViaLogoff) return { did: false, crowd: t.near.length };
    if (t.near.length < (this.policy.breakOutAbove ?? 2)) return { did: false, crowd: t.near.length };
    this.note('reconnecting before stepping out', {
      why, crowd: t.near.length, camped_on_us: t.engaged, what: t.names,
      how: 'a reconnect hands back the entry grace period, so we walk out past a crowd that ' +
           'has to notice us one at a time rather than one that is already mid-swing' });
    const r = await this.reconnect('breaking out of a crowded safe spot');
    if (!r.ok) return { did: false, crowd: t.near.length };
    this.tally.breakouts = (this.tally.breakouts || 0) + 1;
    return { did: true, crowd: t.near.length };
  }

  // ------------------------------------------------------------- resting up
  //
  // A room nothing is generated in. The spawn table answers this directly and better
  // than the name does: an inn is safe, but so is a bank, a shop and a stretch of
  // road, and "tavern" is not a flag on anything.
  sanctuary(room = this.s.world?.room) {
    if (!room) return false;
    const here = loadSpawns(SPAWN_FILE)?.rooms?.[room.num] || [];
    return !here.some(x => x.huntable);
  }

  // WHAT HAS TO BE TRUE BEFORE A CHARACTER WALKS OUT OF SAFETY.
  //
  // THIS IS THE COMMONEST DEATH IN THE FLEET AND IT IS NOT CLOSE. Of the last fifty
  // deaths, twenty-three happened with the keeper mid-travel and blind; of those,
  // SEVENTEEN WERE OUTBOUND TO A HUNTING GROUND and only four were escapes. Eleven of
  // them set off on the line "this room cannot produce our prey — leaving now". The
  // shape is always the same: a character standing perfectly safely in an inn, which the
  // keeper marches to room 586 or 562 because an inn spawns nothing, and which arrives
  // hurt, unarmed, or both, into eight-plus monsters.
  //
  // Neither departure branch asked anything about the character before setting off. They
  // asked about the ROOM — does this room make what we hunt — which is a fine question
  // and the wrong one to leave on.
  //
  // Three conditions, and each one has a body count:
  //
  //   ARMED, ON EVIDENCE. armedForSure() rather than armed(), because `known` is false
  //   for the first pass after a login and a resume logs in twenty-one characters at
  //   once. See armedForSure for why the optimistic answer is right everywhere else and
  //   catastrophic here.
  //
  //   WHOLE. Health, mana AND vigor — the same bar recovered() uses, for the same
  //   reasons, and mana is in it because `create weapon` costs 15 and a character that
  //   leaves at ten cannot arm itself anywhere it is going.
  //
  //   AND A DEADLINE ON BOTH, because a rule that can never be satisfied is a character
  //   retired into an inn, and this fleet has retired characters that way before. After
  //   RECOVER_MAX_MS it goes anyway and says which condition it gave up on — a stall a
  //   human can read beats a character quietly parked for the rest of the session.
  //
  // When it says no it does not merely refuse: it SITS THE CHARACTER DOWN IN A CORNER
  // and rests, which is the thing that makes the answer become yes. The caller's only
  // job is to stop.
  async readyToLeaveSanctuary(going_to = null) {
    // Only ever a gate on leaving somewhere SAFE. A character standing in a monster room
    // must never be held there by this — that would be the same bug pointing the other
    // way, and it is the worse direction.
    if (!this.sanctuary()) return true;

    const v = this.s.client?.vitals?.();
    const hp = pct(v?.health), mp = pct(v?.mana), vig = vigorPct(v);
    const armed = this.armedForSure();
    // A null reading is "no such bar", not "empty" — blocking on one would be the
    // retirement this is careful about everywhere else.
    const whole = (hp ?? 0) >= 0.95 && (mp ?? 1) >= 0.95 && (vig ?? 1) >= REST_VIGOR_CAP;
    if (armed && whole) {
      this.sanctuaryHoldSince = null;
      this.sanctuaryHoldNoted = false;
      return true;
    }

    const blocked = [
      !armed ? 'no weapon in the use list' : null,
      (hp ?? 1) < 0.95 ? 'health' : null,
      (mp ?? 1) < 0.95 ? 'mana' : null,
      (vig ?? 1) < REST_VIGOR_CAP ? 'vigor' : null,
    ].filter(Boolean);

    this.sanctuaryHoldSince ??= Date.now();
    const held = Date.now() - this.sanctuaryHoldSince;
    if (held > RECOVER_MAX_MS) {
      this.note('going out anyway — waited long enough', {
        waited_s: Math.round(held / 1000), still_short: blocked, going_to,
        health: v?.health?.pct ?? null, mana: v?.mana?.pct ?? null, vigor: vigorOf(v),
        why: 'a condition that cannot be met is a character retired into an inn by ' +
             'accident. Twelve minutes is far longer than any real recovery takes, so ' +
             'this is a stall worth seeing rather than a wait worth continuing' });
      this.sanctuaryHoldSince = null;
      this.sanctuaryHoldNoted = false;
      return true;
    }

    // Once per hold, not once per pass: the pass is about a second long and this branch
    // can hold a character for minutes.
    if (!this.sanctuaryHoldNoted) {
      this.sanctuaryHoldNoted = true;
      this.note('not leaving safety yet', {
        room: this.s.world?.room?.name ?? null, going_to, short_of: blocked,
        health: v?.health?.pct ?? null, mana: v?.mana?.pct ?? null, vigor: vigorOf(v),
        armed_for_sure: armed,
        why: 'seventeen of the last twenty-three travel deaths were outbound to a hunting ' +
             'ground, most of them straight out of an inn. Nothing in here can hurt us and ' +
             'nothing out there gets easier by arriving early' });
    }

    this.doing = 'recovering';
    // Sit in a corner and fill the bars. hibernate() settles first, which is what arms
    // the health timer — a character that walked in and stopped regenerates nothing.
    await this.hibernate('waiting to be whole and armed before going back out')
              .catch(() => false);
    // THEN ARM, because the resting is what pays for it: armSelf() wields from the pack
    // and falls back to conjuring, and the conjure is the case that was failing for want
    // of the 15 mana this branch has just been sitting for.
    if (!this.armedForSure()) await this.armSelf().catch(() => false);
    // PROGRESS, NOT A STALL. The supervisor restarts keepers that report no progress, and
    // it was doing exactly that to characters sitting for mana — `restarted Animal:
    // {"why":"unarmed — 10 mana, needs 15 to make one"}` — which threw away the sit and
    // started the climb again. Recovering on purpose is the keeper working.
    this.progress('resting in safety until whole and armed');
    return false;
  }

  // A CLEAR PATCH OF FLOOR TO SIT ON.
  //
  // Bots do not merely share an inn, they stack: they all arrive by the same route
  // and stop on the same square, so four of them end up on the identical coordinate.
  // That is not cosmetic. Every character is ATTACKABLE, so a pile of friendly bots
  // reads to each of them as a crowd of things that can kill it — which is exactly
  // how one of them spent half an hour panic-logging-off at four health next to three
  // of its own fleet.
  //
  // Sitting somewhere with space around it fixes that at the source, and it is free:
  // walking there is itself the step that arms HealthTimer, so the character that
  // moves aside is also the only one actually regenerating.
  restingSquare({ within = 12, clear = 3 } = {}) {
    const s = this.s, c = s.client;
    const geo = s.world?.geometry, me = c?.self;
    if (!geo || !me) return null;
    const others = [...c.room.objects.values()].filter(o => o.id !== c.selfId);
    const gap = (col, row) => others.length
      ? Math.min(...others.map(o => Math.hypot(o.col - col, o.row - row))) : 99;
    // SIT IN A CORNER, AND IN THE EMPTIEST ONE THERE IS.
    //
    // It is what a person does — you take the corner table, not the middle of the floor —
    // and here it is also the only free tactical improvement available while sitting. A
    // corner has two of its four approaches walled off, so anything that wants to reach
    // the character has half as many squares to do it from; the same asymmetry the safe
    // spot book is built on, bought for nothing because we are sitting still anyway.
    //
    // walkable() reads out-of-bounds as false, so the edge of the grid counts as wall,
    // which is right: the far side of a room boundary is not floor you can be attacked
    // across.
    //
    // A PERPENDICULAR PAIR IS A CORNER; TWO OPPOSITE WALLS ARE A CORRIDOR. Scoring
    // "blocked neighbours" alone would rank the middle of a passage equal to a corner and
    // it is not — a corridor is open at both ends and things come down it.
    const corner = (col, row) => {
      const n = !geo.walkable(row - 1, col), s2 = !geo.walkable(row + 1, col);
      const w = !geo.walkable(row, col - 1), e = !geo.walkable(row, col + 1);
      if ((n && e) || (e && s2) || (s2 && w) || (w && n)) return 2;   // a corner
      if (n || s2 || w || e) return 1;                                // a wall at the back
      return 0;                                                       // open floor
    };
    // TWO ANSWERS, BECAUSE THE GRID LIES ABOUT INNS.
    //
    // The movement grid is one byte per square, and a room full of furniture and
    // doorways narrower than a square comes out of it disconnected: in the Limping
    // Toad, 76 squares are both free and clear of everyone, and the grid says NOT ONE
    // of them can be walked to from the middle of the floor. It is wrong — people sit
    // at those tables — but it is wrong in the direction that makes a keeper conclude
    // there is nowhere to go and stand in the doorway for ever.
    //
    // The server does not use that grid; it validates against the fine BSP geometry.
    // So keep the best square the grid endorses AND the best one it merely dislikes,
    // and let settle() walk to the second in fine coordinates, where the server is the
    // judge of each step. Same rule the ledge-walking code already follows.
    let best = null, byFine = null;
    for (let row = 2; row < geo.rows; row++) {
      for (let col = 2; col < geo.cols; col++) {
        if (!geo.walkable(row, col)) continue;
        const d = Math.max(Math.abs(col - me.col), Math.abs(row - me.row));
        if (d > within) continue;
        const space = gap(col, row);
        if (space < clear) continue;
        const p = s.world.reach(col, row);
        // Elbow room first, then closeness — but cap the value of space, because the
        // far corner of an inn is no safer than a clear table and costs the walk.
        //
        // The corner bonus is weighted to be worth about three squares of elbow room, so
        // it decides between two comparable squares without ever sending a character the
        // length of an inn for a corner it does not need. Space still counts inside that,
        // which is what "the open corner if there is one" means: an empty corner beats a
        // corner with somebody already sitting in it, and both beat the middle of the room.
        const nook = corner(col, row);
        const value = Math.min(space, 6) * 2 + nook * 3 - (p?.steps ?? d) * 0.3;
        const cand = { col, row, steps: p?.steps ?? d, clearance: +space.toFixed(1), value,
                       seat: nook === 2 ? 'corner' : nook === 1 ? 'against a wall' : 'open floor' };
        if (p?.reachable) { if (!best || value > best.value) best = cand; }
        else if (!byFine || value > byFine.value) byFine = { ...cand, viaFine: true };
      }
    }
    return best || byFine;
  }

  // Take a seat, once, on arriving somewhere safe. Doing it on ENTRY rather than when
  // the resting eventually starts is the whole point: the walk is what sets
  // PFLAG_MOVED_SINCE_ENTRY, and until that is set the character recovers no health at
  // all however long it sits. Arriving and stopping is the failure; arriving and
  // crossing the room is the fix.
  async settle(why) {
    const room = this.s.world?.room;
    if (!room) return { settled: false };
    if (this.settledIn === room.num) return { settled: false, already: true };
    // A FAILED ATTEMPT IS NOT A SEAT. Marking the room settled up front meant the
    // first try was the only try — and the first try is exactly the one that fails,
    // because the pass right after a reconnect can run before room contents have come
    // back, so we do not yet know where we are standing and every square looks
    // unreachable. Isolde spent that pass concluding there was nowhere to sit in a
    // sixteen-by-sixteen room with a hundred and thirty-five free squares in it.
    const tries = (this.settleTries || 0);
    const spot = this.restingSquare();
    if (!spot) {
      this.settleTries = tries + 1;
      // Say it once, and once more when giving up; not every eight seconds in between.
      if (tries === 0 || tries === 2)
        this.note('nowhere clear to rest here', {
          room: room.name, why, attempt: tries + 1,
          know_where_we_are: !!this.s.client?.self,
          note: tries === 2
            ? 'giving up on finding a clear corner in this room'
            : 'resting anyway, but crowded — health regeneration still needs us to have moved' });
      if (tries >= 2) this.settledIn = room.num;     // stop trying, but only after trying
      return { settled: false };
    }
    if (spot.steps === 0) {
      this.settledIn = room.num;
      this.settleTries = 0;
      return { settled: true, already: true, spot };
    }
    this.doing = 'recovering';
    // Fine movement when the grid refuses the route, because in an inn the grid is
    // usually the thing that is wrong. FINENESS is 64 units to the square and the
    // centre is the half — the same arithmetic moveToSquare does.
    const w = spot.viaFine
      ? await this.s.walkFine(spot.col * 64 + 32, spot.row * 64 + 32,
                              { maxSteps: 24, stride: 48, arriveWithin: 48 })
                    .then(r => ({ arrived: r.arrived, reason: r.reason, fine: true }))
                    .catch(e => ({ arrived: false, reason: e.message, fine: true }))
      : await this.s.walkTo(spot.col, spot.row, { maxSteps: Math.max(20, spot.steps + 8) })
                    .catch(e => ({ arrived: false, reason: e.message }));
    this.movedAt = Date.now();
    if (w.arrived) { this.settledIn = room.num; this.settleTries = 0; }
    else this.settleTries = tries + 1;
    this.note(w.arrived ? 'found a quiet corner to rest in' : 'could not reach the quiet corner', {
      room: room.name, why, to: { col: spot.col, row: spot.row },
      seat: spot.seat ?? null,
      nearest_other_character: spot.clearance, steps: spot.steps, reason: w.reason,
      routed: w.fine ? 'in fine coordinates — the square grid called this room disconnected'
                     : 'through the movement grid',
      because: 'characters stack on the square they arrive at, and every character is attackable — ' +
               'a pile of friendly bots reads as a crowd of threats to every one of them. Walking ' +
               'clear also arms the health timer, which sitting still never does.' });
    return { settled: !!w.arrived, spot };
  }

  // GO TO TOWN WHEN THE WILDERNESS HAS STOPPED WORKING.
  //
  // Called after a successful escape. Two flees is a bad patch; a third says this
  // character cannot fight anywhere it can currently reach, and the next wilderness room
  // will be the same. See the note at the call site for how that state is manufactured.
  //
  // FED AND RESTED CHARACTERS ARE EXEMPT. Above 140 vigor with food in the pack, the
  // fleeing is tactical — a bad room, a bad crowd — and hauling it to town would throw
  // away a working session for nothing.
  // THE NEAREST ROOM NOTHING IS GENERATED IN, by hops.
  //
  // Sanctuary is the right test rather than a list of town names: an inn qualifies, so
  // does a bank, a shop and a stretch of road, and "tavern" is not a flag on anything.
  //
  // Extracted from townTripIfCornered because the post-death recovery asks the identical
  // question — where is the nearest place I can sit down safely — and a second copy of
  // this would be a second place for the hop limit to drift.
  nearestSanctuary({ maxHops = 3 } = {}) {
    const s = this.s;
    const here = s.world?.room?.num;
    const spawns = loadSpawns(SPAWN_FILE)?.rooms || {};
    const safeRooms = Object.keys(spawns)
      .filter(n => !(spawns[n] || []).some(x => x.huntable))
      .map(Number).filter(n => n !== here);
    let best = null;
    for (const room of safeRooms) {
      const r = s.world?.route?.(room);
      if (!r?.found) continue;
      const hops = r.hops.length;
      if (hops > maxHops) continue;           // further than that is its own expedition
      if (!best || hops < best.hops) best = { room, hops };
    }
    return best;
  }

  async townTripIfCornered() {
    const s = this.s, c = s.client;
    if ((this.fledInARow || 0) <= 2) return false;
    if (this.noTownUntil && Date.now() < this.noTownUntil) return false;   // searched recently
    const v = c?.vitals?.();
    const vig = v?.vigor?.value ?? 0;
    const fed = skills.larderOf(c).length > 0;
    if (vig > 140 && fed) { this.fledInARow = 0; return false; }
    if (this.sanctuary()) { this.fledInARow = 0; return false; }   // already somewhere safe

    const best = this.nearestSanctuary({ maxHops: 3 });
    if (!best) {
      // DO NOT FORGET THAT WE ARE CORNERED. The first version reset the counter here,
      // so a character with no town within three hops re-decided from zero every third
      // flee and could never escalate — it just fled for ever, which is precisely what
      // this was written to stop. The count is kept and only the SEARCH is rate-limited.
      this.noTownUntil = Date.now() + 120_000;
      this.note('cornered but no town within reach', {
        fled_in_a_row: this.fledInARow, vigor: vig, has_food: fed,
        why: 'nothing unhuntable within three hops — carrying on in the wilderness ' +
             'because the alternative is a long walk through worse, but still counting ' +
             'the flees, because this is not a state to sit in' });
      return false;
    }
    this.doing = 'travelling';
    this.note('going to town', {
      fled_in_a_row: this.fledInARow, vigor: vig, has_food: fed,
      to_room: best.room, hops: best.hops,
      why: 'fled more than twice with neither the vigor nor the food to fight — the ' +
           'wilderness cannot fix that, and a town can: resting is safe there and the ' +
           'counters sell bread, which is the only way past the resting cap of 80' });
    const t = await this.travel(best.room, { maxHops: 6 }).catch(e => ({ arrived: false, reason: e.message }));
    this.fledInARow = 0;
    if (!t.arrived) { this.noProgress('could not reach town: ' + (t.reason || 'refused')); return false; }
    this.progress('reached town to resupply');
    await this.hibernate('resting in town after being driven out of the wilderness').catch(() => {});
    return true;
  }

  // Nothing to do and nowhere to be: sit down somewhere safe and get the bar back up.
  // Vigor is what a character actually leaves an inn with, and resting is the only way
  // to raise it without food — so idling on your feet is throwing away the one thing
  // idle time is good for.
  // MANA IS THE THIRD BAR AND IT IS THE ONE THAT MATTERS MOST AFTER A DEATH.
  //
  // This used to leave when health and vigor were back, which released characters at ten
  // mana — below the 15 `create weapon` needs, and with everything they owned lying on the
  // floor of the room that killed them, that spell is the whole plan. They walked out
  // bare-handed and died again. Mana genuinely does refill by sitting, unlike vigor, so
  // waiting for it is a wait that ends.
  async hibernate(why, { mana = 0.95 } = {}) {
    const s = this.s;
    if (!this.sanctuary()) return false;
    await this.settle(why);
    const v = s.client?.vitals?.();
    const vig = vigorPct(v), hp = pct(v?.health), mp = pct(v?.mana);
    // A missing mana reading means no bar to fill, not a shortfall to wait on.
    if ((vig ?? 1) >= REST_VIGOR_CAP && (hp ?? 1) >= 0.95 && (mp ?? 1) >= mana) return false;
    this.doing = 'recovering';
    const r = await skills.restUntil(s, {
      health: 0.98,
      // Resting stops at 80 of 200 — RestTimer will not take vigor past its threshold,
      // so asking for more is asking to sit until the timeout. Everything above this
      // has to be eaten, which is a supply problem and not something to wait out.
      vigor: REST_VIGOR_CAP, mana,
      // Longer than the old 120s because mana is the slowest of the three and this is now
      // waiting on it. Still bounded, and the caller's own deadline bounds the repeats.
      maxSeconds: 180 });
    this.tally.rests++;
    this.note('resting up', {
      why, seconds: r.seconds, health: r.vitals?.health, vigor: r.vitals?.vigor,
      mana: r.vitals?.mana, reached: r.reached_target,
      note: 'vigor tops out around 80 of 200 on rest alone; past that it has to come from food' });
    this.progress('resting up between jobs');
    return true;
  }

  // ------------------------------------------------------------- loot runs
  //
  // GO AND FETCH WHAT SOMEBODY ELSE CANNOT CARRY.
  //
  // A farmer that is doing well drops more than it can hold, and cannot leave to sell
  // it without giving up a wall it spent twenty minutes proving. A character with no
  // food is stuck at the resting cap of 80 vigor for ever and has no safe way to earn
  // its way out. Those are the same problem from two ends.
  //
  // The errand takes priority over farming but NOT over staying alive: it is checked
  // after the death, danger and rest branches, so a runner that gets into trouble on
  // the way deals with that first and picks the errand up afterwards.
  //
  // Payment is deliberately asymmetric and deliberately not carried: food changes
  // hands on the spot because a fed farmer earns back its value many times over, and
  // anything owed in coin is settled in a town afterwards. Carrying money into the
  // wilderness to settle a debt would put the one thing death takes into the one place
  // death happens.
  // WALK OVER AND MAKE THEM ONE.
  //
  // Both creation spells are self-only: creaweap.kod:117 and creafood.kod do
  // Send(who,@NewHold,#what=...) where `who` is the CASTER, and lTargets is never
  // read. So there is no such thing as casting a weapon onto someone else — the
  // quartermaster casts for itself and then hands the result over, which is the same
  // two-sided trade a loot run uses to pay a farmer.
  //
  // The caster travels, never the supplicant: a character with no weapon is the one
  // that should be walking through the fewest monster rooms.
  async runProvision(e) {
    const s = this.s, c = s.need();
    const room = s.world?.room;

    if (room?.num !== e.room) {
      this.doing = 'travelling';
      if ((await this.leaveHold('setting out to provision someone')).refused) return true;
      const r = await this.travel(e.room, { maxHops: 14 }).catch(x => ({ arrived: false, reason: x.message }));
      if (!r.arrived) {
        e.failures = (e.failures || 0) + 1;
        this.note('could not reach the supplicant', { to_room: e.room, why: r.reason, attempt: e.failures });
        if (e.failures >= 2) { e.done = true; e.why_done = 'could not get there'; }
        this.noProgress('cannot reach the supplicant');
        return true;
      }
      this.note('arrived to provision', { room: e.room_name, for: e.supplicant_name });
      this.progress('reached the supplicant');
      return true;
    }

    const them = [...c.room.objects.values()]
      .find(o => (o.flags & OF.PLAYER) &&
                 (c.rsc.get(o.nameRsc) || '').toLowerCase() === String(e.supplicant_name || '').toLowerCase());
    if (!them) {
      // They roamed. Follow once rather than abandoning: we are already out here, the
      // spell is already known, and giving up sends the whole errand back to the planner
      // only for it to pair the same two characters again against another stale room.
      const now = whereIs(e.supplicant);
      if (now && now.room !== e.room && (e.chases || 0) < 2) {
        e.chases = (e.chases || 0) + 1;
        this.note('supplicant has moved — following', {
          wanted: e.supplicant_name, expected: e.room_name, now: now.name ?? now.room,
          chase: e.chases });
        e.room = now.room; e.room_name = now.name ?? String(now.room);
        return true;
      }
      e.done = true; e.why_done = 'they had moved on';
      this.note('supplicant not here', { wanted: e.supplicant_name, room: e.room_name,
        chases: e.chases ?? 0,
        why: now ? 'followed as far as we are willing to' : 'no recent reading of where they went' });
      return true;
    }

    // Cast it for ourselves, then find what appeared. Comparing inventory before and
    // after is the only reliable way to know WHICH object to hand over — the spell
    // rolls a random weapon or foodstuff and tells us nothing machine-readable.
    // c.spells is empty until it is asked for — reading it cold is the phantom
    // "the spell did not encode" bug.
    await s.pacer.submit('read', () => c.requestSpells()).catch(() => {});
    await new Promise(x => setTimeout(x, 500));
    const want = String(e.service).toLowerCase();
    const spell = (c.spells || []).find(sp => (c.rsc.get(sp.nameRsc) || '').toLowerCase() === want);
    if (!spell) {
      e.done = true; e.why_done = `does not know ${e.service}`;
      this.note('cannot provide that', { spell: e.service,
                                         knows: (c.spells || []).map(sp => c.rsc.get(sp.nameRsc)) });
      return true;
    }

    await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});

    // DO NOT CAST TWICE FOR ONE ERRAND.
    //
    // The hand-over can fail on its own — a supplicant in the middle of a fight does
    // not reach the branch that accepts gifts within our window — and the retry used to
    // start again from the cast. Kraanite made a weapon, failed to hand it over, cast a
    // second one at fifteen mana, and then had nothing left to cast with while carrying
    // a perfectly good weapon it had already made. If what we made last pass is still in
    // the pack, offer that instead.
    const stillHave = (e.made_ids || []).filter(id => (c.inventory || []).some(o => o.id === id));
    let made;
    if (stillHave.length) {
      made = (c.inventory || []).filter(o => stillHave.includes(o.id));
      this.note('offering what we already made', { to: e.supplicant_name,
        items: made.map(o => c.rsc.get(o.nameRsc)),
        why: 'the previous hand-over did not complete; recasting would spend mana for nothing' });
    } else {
      const had = new Set((c.inventory || []).map(o => o.id));
      const manaBefore = c.vitals?.()?.mana?.value ?? null;
      const reagentsBefore = e.service === 'create food' ? this.reagentCount() : null;
      // Both creation spells take no target, so the target list is empty.
      await s.pacer.submit('cast', () => c.cast(spell.id, []), 1050);
      await c.waitFor({ kinds: ['message', 'inventory'], timeoutMs: 4000 }).catch(() => {});
      await new Promise(x => setTimeout(x, 1200));
      await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
      made = (c.inventory || []).filter(o => !had.has(o.id));
      e.made_ids = made.map(o => o.id);
      // Recorded as a cast for SOMEBODY ELSE. Same spell, same mana, entirely different
      // decision — a quartermaster spending its reagents on a crewmate is not the same
      // event as one feeding itself, and the audit should not have to guess from timing.
      this.recordCast(e.service, { ok: made.length > 0, target: e.supplicant_name,
        why: 'errand: a crewmate asked for one', reagents_before: reagentsBefore,
        made: made.map(o => c.rsc.get(o.nameRsc)),
        mana_before: manaBefore, mana_after: c.vitals?.()?.mana?.value ?? null });
    }
    if (!made.length) {
      e.failures = (e.failures || 0) + 1;
      this.note('the cast produced nothing we can see', {
        spell: e.service, attempt: e.failures,
        mana: c.vitals?.()?.mana,
        // The server refuses both of these without a word, so the absence of an item is
        // the only signal there is. Naming them saves the next reader an hour.
        why: e.service === 'create food'
          ? 'create food needs 2 ElderBerry and 2 Herbs in OUR pack, and refuses silently without them'
          : 'create weapon costs 15 mana and refuses silently below it' });
      if (e.failures >= 2) { e.done = true; e.why_done = 'cast produced nothing'; }
      return true;
    }

    const before = c.evSeq;
    await s.pacer.submit('trade', () => c.offer(them.id, made.map(o => o.id)));
    // Their keeper counters from social(), which runs once per pass — so the window has
    // to be wider than one of their passes or a supplicant that is mid-fight never
    // answers in time and we conclude, wrongly, that nobody is home.
    const ev = await c.waitFor({ since: before, kinds: ['countered', 'trade-ended'], timeoutMs: 20000 })
                      .catch(() => ({ events: [] }));
    if (!ev.events?.some(x => x.kind === 'countered')) {
      await s.pacer.submit('trade', () => c.cancelOffer()).catch(() => {});
      e.failures = (e.failures || 0) + 1;
      this.note('they never countered', { to: e.supplicant_name,
        why: 'a gift completes only when the other side counters; their keeper does that in social()' });
      if (e.failures >= 2) { e.done = true; e.why_done = 'no counteroffer'; }
      return true;
    }
    await s.pacer.submit('trade', () => c.acceptOffer());
    await new Promise(x => setTimeout(x, 1200));
    await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});

    e.done = true;
    e.why_done = 'handed over';
    e.gave = made.map(o => c.rsc.get(o.nameRsc));
    this.note('provisioned', { to: e.supplicant_name, service: e.service, gave: e.gave,
      caveat: e.service === 'create weapon'
        ? 'a made weapon is temporary — it buys the walk to a shop, it is not a repair' : undefined });
    this.progress('provisioned someone');
    return true;
  }

  // WALK THE RING TO THE PERSON IT BELONGS TO, THEN PUT THE MONEY SOMEWHERE DEATH CANNOT
  // REACH IT.
  //
  // The opportunistic check in the main loop hands a ring back whenever its owner happens
  // to be in the room, which for a fleet that never enters a town is approximately never.
  // Fifteen of the nineteen possible owners stand in a fixed room (SIGNET_OWNERS in
  // m59-skills.mjs), so this is a two-hop errand: go to that room, offer the ring.
  //
  // IT IS DISPATCHED TO THE CHARACTER THAT GETS PAID MOST, which is what makes the whole
  // thing worth building. Under 30 max health the ring pays ten times its value; at or
  // over, one times. So the fleet moves rings DOWN to its smallest characters first —
  // `signets` action=redistribute — and only then sends them walking.
  //
  // The last step is not optional. This errand deliberately hands a four-figure sum to
  // the most fragile character in the fleet, in a purse, in a world where death drops
  // your entire inventory. Banking it is the point of earning it.
  async runSignetReturn(e) {
    const s = this.s, c = s.need();
    const room = s.world?.room;

    // 0. IS THE RING STILL IN THE PACK? The first live dispatch died on the way and
    //    dropped both rings on a corpse, and the errand carried on walking to Tos to hand
    //    over something it no longer had — twenty-five minutes of a small character
    //    crossing the world for nothing, ending in the same two failures a missing owner
    //    produces. Death is not the only way to lose it either: the opportunistic check
    //    hands rings back whenever the owner walks past, and the world deletes the oldest
    //    signet when a twenty-first is made (library.kod:4288).
    //
    //    The cached inventory is checked first because it is free; only if it looks empty
    //    is a real read spent, because "empty" is also what a stale snapshot looks like
    //    in the seconds after a reconnect and giving up on that would be a coin flip.
    const carrying = () => (c.inventory || []).some(o => /signet ring/i.test(c.rsc.get(o.nameRsc) || ''));
    if (!carrying()) {
      await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
      await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
      if (!carrying()) {
        e.done = true;
        e.why_done = 'the ring is gone';
        this.note('no signet ring left to return', {
          was_for: e.owner, to: e.where,
          why: 'dropped on death, handed over already, or deleted by the world — either way ' +
               'there is nothing to walk anywhere for' });
        return true;
      }
    }

    // 1. Get there. Two failures and it gives up rather than pacing between a wall and a
    //    town for twenty minutes; the ring stays in the pack and the opportunistic check
    //    keeps working on it for free.
    if (room?.num !== e.room) {
      this.doing = 'travelling';
      if ((await this.leaveHold('taking a signet ring back to its owner')).refused) return true;
      const r = await this.travel(e.room, { maxHops: 20 })
                      .catch(x => ({ arrived: false, reason: x.message }));
      if (!r.arrived) {
        e.failures = (e.failures || 0) + 1;
        this.note('could not reach the ring\'s owner',
                  { to_room: e.room, where: e.where, why: r.reason, attempt: e.failures });
        if (e.failures >= 2) { e.done = true; e.why_done = 'could not get there'; }
        this.noProgress('cannot reach the signet ring\'s owner');
        return true;
      }
      this.note('arrived to return a signet ring', { room: e.where, owner: e.owner });
      this.progress('reached the ring\'s owner');
      return true;
    }

    // 2. Hand it over. returnSignetRings matches the owner named on each ring against the
    //    objects in this room, so it gives back every ring this character is carrying that
    //    belongs here — not only the one the errand was cut for. That is free and it is
    //    the whole reason redistribution groups rings by town before dispatching.
    const gave = await skills.returnSignetRings(s).catch(x => ({ returned: [], why: x.message }));
    if (!gave.returned?.length) {
      e.failures = (e.failures || 0) + 1;
      // The owner not being here is the interesting case and it is not a bug: the ring
      // may have named a Wanderer, or the room snapshot may be a pass stale. Two goes.
      this.note('the ring\'s owner was not here', {
        owner: e.owner, room: e.where, attempt: e.failures, why: gave.why,
        note: 'CheckWhyWanted names the correct owner out loud when the wrong NPC is ' +
              'offered a ring — read the journal if this keeps happening' });
      if (e.failures >= 2) { e.done = true; e.why_done = 'the owner was not there'; }
      return true;
    }

    e.returned = gave.returned.length;
    this.tally.signets_returned = (this.tally.signets_returned || 0) + gave.returned.length;
    this.note('returned a signet ring', {
      to: gave.returned.map(r => r.to), still_carrying: gave.carrying,
      paid: skills.signetPayout({ level: c.vitals()?.health?.max ?? null }),
      why: 'walked here on purpose; a ring returned by a character under 30 max health ' +
           'pays ten times its value',
    });
    this.progress('returned a signet ring');

    // 3. BANK IT BEFORE ANYTHING ELSE HAPPENS. bankSurplus() only acts when there is a
    //    teller in the room, which is exactly right for Yevitan — he stands in the Royal
    //    Bank of Jasper, so a Jasper ring pays out and is banked without moving. Anywhere
    //    else this is a no-op and the ordinary bankRun picks it up on a later pass, which
    //    it will: the default threshold is 500 and this just cleared four figures.
    await this.bankSurplus().catch(x => this.note('could not bank the ring money',
      { why: x.message, warning: 'this character is now carrying the payout in a purse' }));

    e.done = true;
    e.why_done = 'handed over';
    return true;
  }

  async runErrand() {
    const e = this.errand;
    if (!e) return false;
    const s = this.s, c = s.client;
    const room = s.world?.room;

    if (e.done || (e.expires && Date.now() > e.expires)) {
      if (e.kind === 'provision')
        this.note('provisioning errand finished',
                  { for: e.supplicant_name, service: e.service, gave: e.gave ?? [],
                    why: e.why_done ?? 'timed out' });
      else if (e.kind === 'signet')
        this.note('signet errand finished',
                  { to: e.owner, town: e.town, returned: e.returned ?? 0,
                    why: e.why_done ?? 'timed out' });
      else
        this.note('loot run finished', { for: e.farmer_name, took: e.took ?? [], why: e.why_done ?? 'timed out' });
      this.errand = null;
      return false;
    }

    // A quartermaster errand is a different job with the same priority: it outranks
    // farming and is outranked by staying alive, and we are already past those branches.
    if (e.kind === 'provision') return this.runProvision(e);
    if (e.kind === 'signet') return this.runSignetReturn(e);

    // 1. Get there. Travel is the risky half and the keeper above us has already
    //    decided we are healthy enough to be doing this at all.
    if (room?.num !== e.room) {
      this.doing = 'travelling';
      if ((await this.leaveHold('setting out on a loot run')).refused) return true;
      const r = await this.travel(e.room, { maxHops: 14 }).catch(x => ({ arrived: false, reason: x.message }));
      if (!r.arrived) {
        e.failures = (e.failures || 0) + 1;
        this.note('could not reach the loot run', { to_room: e.room, why: r.reason, attempt: e.failures });
        if (e.failures >= 2) { e.done = true; e.why_done = 'could not get there'; }
        this.noProgress('cannot reach the loot run');
        return true;
      }
      this.note('arrived for the loot run', { room: e.room_name, for: e.farmer_name });
      this.progress('reached the loot run');
      return true;
    }

    // 2. Hand over the food FIRST. It is the half of the bargain that pays for itself,
    //    and doing it before looting means a runner that has to leave in a hurry has
    //    already kept its side.
    if (!e.paid) {
      const paid = await this.payFarmer(e).catch(x => ({ gave: [], why: x.message }));
      e.paid = true;
      e.gave = paid.gave ?? [];
      this.note(paid.gave?.length ? 'paid the farmer in food' : 'nothing to pay with yet', {
        to: e.farmer_name, gave: paid.gave, why: paid.why,
        owes: paid.gave?.length ? null : 'half the sale proceeds, to be settled in town' });
    }

    // 3. STAND WHERE THE FARMER STANDS. This is the deliberate exception to one wall
    //    each: sharing a spot is pointless when both parties are fighting, and it is
    //    exactly right when one is fighting and the other is picking up behind them.
    //    The runner is the fragile one in the room and it is about to spend several
    //    passes stationary with its hands full — the wall is worth more to it than to
    //    anyone. Players have done this forever.
    //
    //    It is the farmer's claim, so we do not take it in the register; we just go
    //    and stand there, and the farmer's own keeper still owns it.
    if (!this.hold) {
      const farmerSpot = spotHeldBy(e.farmer);
      if (farmerSpot && farmerSpot.room === room?.num) {
        const near = s.world?.approachSquare?.(farmerSpot.col, farmerSpot.row);
        if (near && near.steps > 0 && near.steps <= 6) {
          this.doing = 'travelling';
          const w = await s.walkTo(near.col, near.row, { maxSteps: near.steps + 6 })
                          .catch(() => ({ arrived: false }));
          this.movedAt = Date.now();
          if (w.arrived) this.note('sheltering beside the farmer', {
            farmer: e.farmer_name, their_spot: { col: farmerSpot.col, row: farmerSpot.row },
            why: 'a loot run is several passes of standing still with full hands — the safest ' +
                 'place to do that is the wall the farmer already proved' });
        }
      }
    }

    //    Pick the floor clean. lootFloor already refuses cursed items and walks only
    //    when it has to; seven squares of reach covers a kill site.
    this.doing = 'trading';
    const l = await s.lootFloor({ maxItems: 12 }).catch(x => ({ taken: [], refused: [], error: x.message }));
    const took = (l.taken || []).map(t => t.name + (t.amount ? ` x${t.amount}` : ''));
    e.took = [...(e.took || []), ...took];
    this.countLoot(took);

    const cap = this.policy.maxCarry ?? 14;
    const full = (c.inventory?.length ?? 0) >= cap;
    if (!took.length || full) {
      e.done = true;
      e.why_done = full ? 'pack is full' : 'nothing left on the floor';
      this.note('loot run collected', {
        for: e.farmer_name, took: e.took, carrying: c.inventory?.length, of: cap,
        next: full ? 'go and sell it, then bank the money' : 'floor is clear' });
      this.progress('collected a loot run');
      return true;
    }
    this.note('picking up', { for: e.farmer_name, took, carrying: c.inventory?.length });
    this.progress('picking up loot');
    return true;
  }

  // Hand over every edible thing we are carrying. A runner is chosen for being poor,
  // so this is usually nothing — and that is fine, it becomes a debt instead. When
  // there IS food, giving all of it is correct: the runner is about to walk to a shop
  // and the farmer is not going anywhere.
  async payFarmer(e) {
    const s = this.s, c = s.need();
    const larder = skills.larderOf(c);
    if (!larder.length) return { gave: [], why: 'carrying no food' };
    const them = [...c.room.objects.values()]
      .find(o => (o.flags & OF.PLAYER) &&
                 (c.rsc.get(o.nameRsc) || '').toLowerCase() === String(e.farmer_name || '').toLowerCase());
    if (!them) return { gave: [], why: 'the farmer is not in the room' };
    const ids = larder.map(x => x.o.id);
    const before = c.evSeq;
    await s.pacer.submit('trade', () => c.offer(them.id, ids));

    // FINISH THE HANDSHAKE. An offer alone moves nothing: the sequence is
    // offer -> they counter (empty, which is how a gift is accepted) -> WE ACCEPT.
    // Stopping at the counter leaves the food sitting on the table until the trade
    // is cancelled, while the journal says "paid the farmer in food" — a hand-over
    // that reads as done in every log we keep and never happened in the world. The
    // farmer's own keeper counters for us in social(), so the only missing half was
    // this one.
    const ev = await c.waitFor({ since: before, kinds: ['countered', 'trade-ended'], timeoutMs: 8000 })
                      .catch(() => ({ events: [] }));
    if (!ev.events?.some(x => x.kind === 'countered')) {
      await s.pacer.submit('trade', () => c.cancelOffer()).catch(() => {});
      return { gave: [], why: 'they never countered, so the gift could not be completed' };
    }
    await s.pacer.submit('trade', () => c.acceptOffer());
    await new Promise(r => setTimeout(r, 1200));
    await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    return { gave: larder.map(x => x.name) };
  }

  // EVERY RECONNECT GOES THROUGH HERE, because a reconnect establishes two things and
  // both of them are easy to establish in only three of the four places it happens:
  //
  //   every object id we are holding is stale — the server reissues them at login
  //   the entry grace period has been handed back, so from now until we act again,
  //     nothing that fails to hit us proves anything about where we are standing
  //
  // The second is the subtle one and it is why this exists as a method. Without it a
  // character reconnects into a corner, sits quietly for a minute because the server
  // is holding the monsters back, and concludes the corner is safe. It is not; it was
  // never tested; and the next time it stands there it will do so believing it can
  // rest through anything.
  async reconnect(why) {
    const r = await this.s.rejoin().then(() => ({ ok: true }), e => ({ ok: false, why: e.message }));
    // Stamped even on failure: if we do not know whether we came back, we certainly
    // do not know whether the monsters are awake.
    this.rejoinedAt = Date.now();
    this.foeId = null;
    this.lastObs = null;
    this.campedIds = new Set();
    if (!r.ok) this.note('reconnect failed', { why: r.why, trying_to: why });
    return r;
  }

  // The one call every deliberate departure goes through, so that "we decided to
  // leave" and "we got out alive" are not two different problems solved in five
  // places. Breaks the siege first when there is one, then lets the hold go.
  // GIVING UP A WALL IS A SURVIVAL DECISION, AND MOST CALLERS ARE NOT MAKING ONE.
  //
  // Camilla, 2026-08-06 23:59. At −18.0s the keeper saw 69% health, took a safe spot, and
  // refused to rest in the open. TWO HUNDRED MILLISECONDS LATER, in the same pass, the
  // room check fired — "this room cannot produce our prey — leaving now" — and this
  // method gave up the wall it had just taken, `held_s: 0`. She walked out at 20/29 with
  // two monsters on her and was dead 17.8 seconds later, without swinging once.
  //
  // Both decisions were individually right and nothing arbitrated between them. So the
  // arbitration lives here, at the one place they both go through: A DISCRETIONARY
  // DEPARTURE FROM A HELD SPOT IS REFUSED WHILE HURT. Routing, roaming, banking and
  // errands are all discretionary — the room will still be the wrong room in thirty
  // seconds. Withdrawing from a fight is not, and passes `force`.
  //
  // `readyToLeaveSanctuary` is the same rule for inns and does not cover this: it returns
  // true immediately unless `sanctuary()`, and a monster room with a proven wall in it is
  // not a sanctuary. It is, however, the safest place in the world for a hurt character —
  // nothing can hit you there unless you swing first — which is exactly why leaving is
  // the mistake.
  //
  // IT CANNOT DEADLOCK. Refusing returns the pass, the rest gate above sees `hurt` and
  // `sheltered` and rests to full on the wall, and the next attempt is allowed. If that
  // somehow never happens the wait is capped and it goes anyway, saying so — the same
  // shape as the sanctuary hold, and for the same reason: a condition that cannot be met
  // is a character retired by accident.
  async leaveHold(why, { force = false } = {}) {
    if (!this.hold) return { left: false };
    if (!force) {
      const hp = pct(this.s.client?.vitals?.()?.health);
      const floor = this.policy.restBelow ?? 0.7;
      if (hp !== null && hp < floor) {
        this.holdKeptSince ??= Date.now();
        const kept = Date.now() - this.holdKeptSince;
        if (kept < HOLD_WHILE_HURT_MAX_MS) {
          // Once per hold rather than once per pass: this fires every second otherwise.
          if (!this.holdKeptNoted) {
            this.holdKeptNoted = true;
            this.note('staying on the wall — too hurt to go anywhere discretionary', {
              wanted_to: why, health: Math.round(hp * 100) + '%',
              rest_below: Math.round(floor * 100) + '%',
              proven: this.holdWorks?.() ?? null,
              why: 'a held safe spot is the safest square available and the errand is not ' +
                   'urgent. Rest here first — this is the decision that killed Camilla, ' +
                   'who gave up a proven wall at 69% and died 17.8s later',
            });
          }
          this.holdKept = (this.holdKept || 0) + 1;
          return { left: false, refused: true, health: hp, wanted_to: why };
        }
        this.note('leaving the wall anyway — waited long enough', {
          wanted_to: why, health: Math.round(hp * 100) + '%',
          waited_s: Math.round(kept / 1000),
          why: 'held for the cap without recovering. A wait that cannot end is a stall ' +
               'worth seeing rather than a wait worth continuing' });
      }
      this.holdKeptSince = null;
      this.holdKeptNoted = false;
    }
    const out = await this.breakOut(why).catch(e => ({ did: false, why: e.message }));
    this.releaseHold(why);
    return { left: true, reconnected: !!out.did, crowd: out.crowd ?? 0 };
  }

  // HOLD THE SWING AND WATCH.
  //
  // The one state that can prove a wall is being next to something that wants to kill
  // you and NOT hitting it — and a keeper that attacks every pass never enters it. So
  // proof used to arrive only by accident, when a fight went badly enough to force a
  // rest, which is precisely the moment the proof is too late to be worth anything.
  //
  // This makes it deliberate: a monster has walked to the wall, the spot is untested,
  // so hold the attack for a pass or two and let observe() adjudicate. It costs a few
  // seconds and it buys holdWorks() for the whole rest of the fight — which is what
  // makes breaking off free, and resting to full possible.
  //
  // Budgeted per session rather than done once and trusted for ever: walls do not
  // move, but maps get rebuilt and rooms renumbered, and a handful of fresh readings
  // each session is what keeps the book from ageing into fiction.
  //
  // Returns true if the caller should NOT attack this pass.
  maybeTestSpot(adjacent) {
    if (!this.hold || this.holdWorks() || !adjacent.length) { this.spotTest = null; return false; }
    const at = `${this.hold.col},${this.hold.row}`;
    if (this.spotTest && this.spotTest.at !== at) this.spotTest = null;   // a different square
    if (!this.spotTest) {
      if (this.hold.failures) return false;                                // already disproved
      if ((this.spotTestsRun || 0) >= (this.policy.spotTestsPerSession ?? 3)) return false;
      this.spotTestsRun = (this.spotTestsRun || 0) + 1;
      this.spotTest = { at, since: Date.now(), passes: 0 };
      this.note('holding the swing to test this spot', {
        where: { col: this.hold.col, row: this.hold.row },
        adjacent: adjacent.length, test: this.spotTestsRun,
        of: this.policy.spotTestsPerSession ?? 3,
        why: 'something has come to the wall and we have never tested this square. Standing ' +
             'still without swinging is the only thing that can prove it, and proving it now ' +
             'is worth far more than proving it after the fight has gone wrong.' });
    }
    this.spotTest.passes++;
    // Two passes covers the proof window; three is the cap, so a creature that
    // wanders off again cannot leave us standing here indefinitely.
    if (this.spotTest.passes > 3) {
      this.note('stopped testing this spot — nothing conclusive', {
        where: { col: this.hold.col, row: this.hold.row },
        why: 'three passes without a clean verdict; getting on with the fight' });
      this.spotTest = null;
      return false;
    }
    // Standing still on purpose is not idling, and must not read as a stall.
    this.doing = 'recovering';
    this.progress('testing a safe spot');
    return true;
  }

  // WHAT THIS CHARACTER IS DOING, in the words someone watching would use.
  //
  // `doing` is the time-accounting bucket and is too coarse to read — "recovering"
  // covers eating, resting and waiting out a digestion clock. This is the one-line
  // answer to "what is it up to?", which is the question a fleet page is for.
  // PARK: FINISH WHAT YOU ARE DOING, GET BEHIND A WALL, AND STOP.
  //
  // A broker restart stops all twenty-one keepers at once, and a stopped keeper is not
  // a paused character — it is a character held still in whatever fight it was in while
  // everything already swinging at it carries on. That is why deaths arrive in waves
  // after a restart, and it is the whole reason m59-uptime.mjs exists.
  //
  // Parking is the fix, and the only part of it that matters is WHEN it takes effect:
  // not mid-swing, not mid-route, but at the next point the keeper would have chosen a
  // new action anyway. So the check sits in pass() exactly where the mode dispatch does
  // — past death, danger and rest — and everything above it still runs. A parked
  // character that is attacked still defends itself, still flees, still escapes the
  // Underworld. It simply stops picking new fights.
  //
  // `ready` is the handshake. The orchestrator waits for every keeper to raise it before
  // it restarts anything, so the outage lands on a fleet that is standing behind walls
  // rather than one that is mid-pull.
  park(why = 'a fleet update is waiting for us') {
    if (!this.parking) {
      this.parking = { why, at: Date.now(), ready: false, tries: 0, since: null };
      this.note('parking for a fleet update', {
        why, what_happens: 'this pass finishes, then the keeper takes a wall and holds it. ' +
          'It will not start another fight. Danger, flight and death handling are unaffected' });
    }
    return this.parkStatus();
  }

  unpark(why = 'the update finished') {
    if (this.parking) this.note('unparked', { why });
    this.parking = null;
    return this.parkStatus();
  }

  parkStatus() {
    if (!this.parking) return null;
    return { parked: true, ready: !!this.parking.ready, why: this.parking.why,
             waiting_for_s: Math.round((Date.now() - this.parking.at) / 1000),
             holding: this.hold ? { col: this.hold.col, row: this.hold.row,
                                    proven: this.holdWorks() } : null };
  }

  // How long we will keep trying for a wall before reporting ready without one. A
  // character that cannot find a wall must not hold the whole fleet's update hostage —
  // and standing still in the open is still strictly better than being stopped mid-fight
  // there, because a parked keeper is awake and a stopped one is not.
  static PARK_GRACE_MS = 90_000;

  // How many kills inside the last `ms`. Survives a keeper restart no better than the
  // total does — the array lives on the keeper — but the WINDOW is what saves it: a
  // restart five minutes ago and an idle hour both read as a low number, and both mean
  // "this character is not earning right now", which is the same answer.
  killsSince(ms) {
    const from = Date.now() - ms;
    return (this.killTimes || []).filter(t => t >= from).length;
  }

  activity() {
    if (!this.running) return 'stopped';
    // A keeper whose session died keeps looping and keeps reporting whatever it was
    // last doing, which is how twenty-five logged-out characters showed up on the
    // board as sixteen of them holding walls. The loop is running; the character is
    // not there.
    if (!this.s?.live) return 'NOT IN GAME';
    // BEFORE ANYTHING ELSE IT WOULD OTHERWISE CLAIM TO BE DOING. An inert keeper still
    // holds a safe spot, a mode and a hunt, and reporting any of those on the board would
    // say a character is working when something else is walking it across the world.
    if (this.inert) return `inert — ${this.inert.why || 'something else is driving'}`;
    if (this.parking)
      return this.parking.ready
        ? (this.hold ? 'parked behind a wall, ready for the update' : 'parked in the open, ready for the update')
        : 'parking — getting behind a wall before the update';
    if (this.frozenUntil && Date.now() < this.frozenUntil) return 'playing dead';
    if (this.hold) {
      const proven = this.holdWorks() ? 'proven' : 'untested';
      if (this.spotTest) return 'testing a safe spot';
      if (this.doing === 'fighting') return `fighting from a ${proven} safe spot`;
      return `holding a ${proven} safe spot`;
    }
    // One wording for the errand, shared with the commitment the board greys rows on —
    // a character described as "loot run for Rowlf" in one place and "an errand" in the
    // other is two facts where there is one.
    if (this.errand)
      return describeCommitment({ errand: this.errand })?.label ?? 'on an errand';
    if (this.mode === 'idle') return 'idle';
    if (this.doing === 'travelling') return 'travelling';
    if (this.doing === 'trading') return 'trading';
    if (this.doing === 'recovering') return this.climbing ? 'eating to raise vigor' : 'resting';
    if (this.mode === 'farm' && this.policy.hunt) {
      // A keeper earning nothing must not describe itself the same way as one that is.
      // This string is what the fleet board renders, and it is where the afternoon of
      // worthless grinding would have been visible had there been anything to see.
      const y = this.yieldCheck();
      return y && !y.paying
        ? `hunting: ${this.policy.hunt} — PAYS NOTHING for ${this.policy.purpose}`
        : `hunting: ${this.policy.hunt}`;
    }
    return this.stalledSince ? `stuck: ${this.stalledWhy}` : 'waiting';
  }

  // DROPPING A STACK NEEDS THE QUANTITY, or the server refuses and says nothing useful.
  //
  // The cost was not one item. makeRoom returns from the pass as soon as it has "made
  // room", so a character whose overflow was a stack dropped nothing, stayed over the
  // limit, and returned at the top of every pass for ever. Beaker did it 14 passes
  // running -- "bags full - dropped red mushroom x20", still carrying 15 of 14 -- and
  // never reached the hunting code at all.
  //
  // The rule itself now lives beside encodeIdList in m59-parse.mjs, because this was the
  // third copy of it and the fourth site -- the broker's `act` -- had no copy at all and
  // was still sending bare ids. See dropSpec there for what the server actually does.
  dropSpec(o, want = null) { return dropSpecFor(o, want); }

  // THE ROOM HAS FILLED UP WITH THINGS WE DECLINED TO KILL.
  //
  // The cap is a room-wide TOTAL (monsroom.kod:242) and the generator is gated on it
  // before it rolls the table at all, so ignoring a creature does not leave more room
  // for the one you want — it leaves less. A fleet hunting centipedes and stepping over
  // baby spiders ends up in a room of baby spiders and then a room of nothing.
  //
  // AND LEAVING DOES NOT FIX IT. This is the part that reads backwards: LastUserLeft
  // (monsroom.kod:353) starts the 3-minute reload timer ONLY when piMonster_count = 0,
  // and otherwise just deletes the generation timer. The comment says why — "to prevent
  // endless exp boosting" — the game is deliberately stopping you from resetting a room
  // by walking out of it. A room abandoned while full stays full, with the generator
  // switched off, for as long as nobody kills anything in it.
  //
  // So clearing is not an optimisation, it is the only mechanism. Leaving is what you do
  // when you CANNOT clear, and it should be understood as giving the room up rather than
  // as resetting it.
  capBlockers(room) {
    const c = this.s.client;
    const spawns = loadSpawns(SPAWN_FILE);
    const cap = roomCap(spawns, room?.num);
    if (!cap || !c?.room) return null;
    const mons = [...c.room.objects.values()].filter(o =>
      o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER));
    const present = mons.length;
    const want = String(this.policy.hunt || '').toLowerCase();
    const preyPresent = want
      ? mons.filter(o => (c.rsc.get(o.nameRsc) || '').toLowerCase().includes(want)).length : 0;
    const status = { cap, present, prey_present: preyPresent,
                     full: present >= cap, clearable: [], blocked: [] };
    if (!status.full) return status;

    const level = c.vitals?.()?.health?.max ?? 0;
    const ceiling = level ? level + (this.policy.maxThreatOver ?? 6) : null;
    const seen = new Set();
    for (const o of mons) {
      const name = c.rsc.get(o.nameRsc) || '';
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      if (want && key.includes(want)) continue;          // our prey is not a blocker
      const info = Object.values(spawns.creatures ?? {})
        .find(x => x.name.toLowerCase() === key);
      const lvl = info?.level ?? null;
      const politicalTroop = info?.political_troop === true;
      const count = mons.filter(m => (c.rsc.get(m.nameRsc) || '').toLowerCase() === key).length;
      const row = { name, level: lvl, karma: info?.karma ?? null, count };
      // The two exceptions, and they are genuinely different. Karma is a decision the
      // owner made about what this character is; danger is a fact about the room.
      // A CREATURE WE HAVE NEVER HEARD OF IS DANGEROUS, NOT SAFE.
      //
      // `lvl` is null whenever the spawn table has no row for the name, and the level
      // test was written as `lvl != null && lvl > ceiling` — so an unknown creature
      // skipped the test and fell straight through to clearable. The table holds 120
      // creatures and exactly one faction soldier ("rebel soldier", level 50); there is
      // no row for "soldier of the Duke's army", so a level-27 character with a safety
      // band of 33 looked at three of them and decided to clear the room.
      //
      // That is the same shape as every other silent default in this tree: the absence
      // of information read as permission. Faction soldiers are the worst possible thing
      // to guess about — the Duke's soldiers alone account for 155 kills in the Tos
      // death record and appear in deaths that happened inside APPROVED safe squares.
      //
      // Judge on attack_rating where we have it, because level is not danger
      // (GetAttackAbility = 3*viLevel + 60*viDifficulty), and fall back to level only
      // when the rating is missing. Unknown is refused either way.
      const rating = info?.attack_rating ?? null;
      if (!karmaSafe(info?.karma, this.policy.karma)) {
        status.blocked.push({ ...row, why: `killing it moves karma the wrong way for a ` +
                                            `${this.policy.karma} character (its karma is ${info?.karma})` });
      } else if (!info) {
        status.blocked.push({ ...row, rating: null,
          why: 'nothing is known about it — the spawn table has no row for this name, and ' +
               'an unrecognised creature is refused rather than assumed harmless' });
      } else if (politicalTroop) {
        status.blocked.push({ ...row, rating,
          why: 'political faction troop; attackability permits an initiated swing but does not ' +
               'prove aggression, so it is never incidental room-clearing prey' });
      } else if (rating != null && rating > GENTLE_RATING && lvl != null && lvl > ceiling) {
        status.blocked.push({ ...row, rating,
          why: `attack rating ${rating} is above the forgiving band of ${GENTLE_RATING} ` +
               `and level ${lvl} is above the safety band of ${ceiling}` });
      } else if (ceiling != null && lvl != null && lvl > ceiling) {
        status.blocked.push({ ...row, rating, why: `level ${lvl} is above the safety band of ${ceiling}` });
      } else {
        status.clearable.push({ ...row, rating });
      }
    }
    // Most numerous first: the point is to free slots, and eight of one thing is where
    // the slots are.
    status.clearable.sort((a, b) => b.count - a.count);
    status.blocked.sort((a, b) => b.count - a.count);

    // SHOULD WE ACTUALLY STOP AND CLEAR, or just get on with hunting?
    //
    // The first version only asked when NO prey was in the room, and that was wrong in
    // the exact case it was written for. East Merchant Way was 8 baby spiders to 2
    // centipedes at a cap of 10: prey WAS present, so the keeper hunted the two and never
    // touched the eight, and the moment it killed them the generator refilled at 65%
    // spiders. The room degrades to all-spiders whatever you do, one kill at a time.
    //
    // So the trigger is composition, not absence. A full room where the things we will
    // not hunt outnumber the things we will is a room going the wrong way, and the only
    // move that reverses it is killing them.
    const blockerCount = status.clearable.reduce((a, b) => a + b.count, 0);
    status.should_clear = status.clearable.length > 0
      && (preyPresent === 0 || blockerCount > preyPresent);
    status.why_clear = !status.should_clear ? null
      : preyPresent === 0
        ? `the room is at ${present}/${cap} and none of it is what we hunt`
        : `${blockerCount} of the ${present} here are not our prey and only ${preyPresent} ` +
          `are — at cap that composition only gets worse`;
    return status;
  }

  // ONE ATTEMPT AT FINDING A SQUARE, at a given tolerance for sharing.
  //
  // Extracted from takeSafeSpot only so the search can be re-run at a higher share cap
  // without duplicating the option block — a second copy of these arguments is exactly
  // how the two would come to disagree about `los` or the book.
  searchSafeSpot(geo, me, room, { within, quarryReach, los, quarry, barren, stats, shareCap = 1 }) {
    const s = this.s;
    return nearestSafeSpot(geo, me, {
      // WHAT MAKES A SQUARE A CANDIDATE. `wall` asks for a wall to stand against and
      // ranks by how much of it there is; `disc` is the old attackers_avoided >= 20
      // gate, kept so the two can be compared rather than swapped on faith. See
      // SPOT_RULES — the disc threshold turned out to sit in a trough in the book, and
      // most of the evidence that put it there was written by a bug in restBroken.
      //
      // `los` has to be the same setting quarryReach uses, or the two disagree about
      // the same monster.
      within, rule: this.policy.spotRule ?? 'wall', minAvoided: 20,
      book: this.book, room: room.num, quarryReach, los,
      stats,
      toward: quarry ? { col: quarry.col, row: quarry.row } : null,
      // Skip squares already at the share cap, and squares nothing can be fetched to.
      // Both are expressed as "unreachable" because that is the question the ranking
      // already asks, and neither is worth a second mechanism.
      reach: (col, r2) => {
        if (barren?.has(`${col},${r2}`)) return { reachable: false };
        if (spotTakenByAnother(this.s.name, room.num, col, r2, shareCap)) return { reachable: false };
        return s.world.reach(col, r2);
      },
    });
  }

  // ONE FRAME. Extracted from the pass so a JOURNEY CAN LEAVE A TRAIL.
  //
  // Frames were written once per pass and nowhere else, and travel is a single await
  // INSIDE a pass — so a character that set off across four rooms and died on the way
  // recorded nothing between the room it left and the Underworld. The post-mortem then
  // reconstructed the death from "the last frame that was not the Underworld", which was
  // the room it had left minutes earlier.
  //
  // Janice is the worked example: her record says she died in the Brownestone Inn at
  // 30/30 health, with `threats: 0`. Her last decision there was "this room cannot
  // produce our prey — leaving now, going to Valley of Ileria", and 92 seconds later a
  // frogman killed her. Inns have no frogmen and nobody dies at full health; every field
  // in that record was true about somewhere she was no longer standing.
  //
  // 16% of attended records show full health at death, which is this shape.
  //
  // `why` is kept on the frame so the trail says what it is: a frame written because we
  // arrived somewhere is a different observation from the pass's regular sample, and a
  // reader that cannot tell them apart will read a travel trail as a stall.
  recordFrame(why = null) {
    const c = this.s.client;
    if (!c?.room) return null;
    const v = c.vitals?.() ?? {};
    const room = this.s.world?.room;
    const nowT = Date.now();
    const mine = (flag) => [...c.room.objects.values()]
      .filter(o => o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && (flag ? (o.flags & OF.PLAYER) : !(o.flags & OF.PLAYER)));
    const f = {
      at: nowT, room: room?.name ?? null, num: room?.num ?? null,
      col: c.self?.col ?? null, row: c.self?.row ?? null,
      health: v.health?.value ?? null, max: v.health?.max ?? null,
      vigor: v.vigor?.value ?? null,
      doing: this.doing ?? this.lastDoing ?? null,
      ...(why ? { why } : {}),
      holding: this.hold ? { col: this.hold.col, row: this.hold.row,
                             proven: this.holdWorks?.() ?? null } : false,
      // Ages rather than timestamps: a post-mortem is read by someone asking "was it
      // moving", not "what was the clock".
      moved_ms: this.movedAt ? nowT - this.movedAt : null,
      swung_ms: this.swungAt ? nowT - this.swungAt : null,
      // COUNT SEPARATELY FROM NAMING, because the cap on the names was silently becoming
      // the answer. `most_at_once` is derived from this list's LENGTH, and the list was
      // sliced to 6 — so every swarm death recorded "6 on them at the end", 55 times out
      // of 55 in room 586, and the real number was never written down. A constant that
      // appears in 100% of your records is a measurement artefact, not a finding.
      //
      // NOT FLEETMATES: every character in this fleet is ATTACKABLE and they stand next
      // to each other by design, so without the player bit a death record names four
      // Muppets as the things that killed you. They are recorded separately instead.
      threat_count: mine(false).length,
      threats: mine(false).map(o => c.rsc.get(o.nameRsc)).slice(0, 6),
      players_present: [...c.room.objects.values()]
        .filter(o => o.id !== c.selfId && (o.flags & OF.PLAYER))
        .map(o => c.rsc.get(o.nameRsc)).slice(0, 6),
    };
    this.recent5 = (this.recent5 || []);
    // WHEN THE RECORD LAST BREATHED. The watchdog spaces its own frames against this, so
    // an ordinary busy pass costs nothing extra and only a genuinely blind stretch does.
    this.lastFrameAt = nowT;
    this.recent5.push(f);
    // Deep enough to cover the whole of a death rather than its last few seconds. At an
    // 8s pass this is about three minutes, which is longer than any fight that kills one
    // of these characters — and a multi-hop journey now spends frames from the same
    // budget, which is the trade this exists to make.
    //
    // WIDENED FOR THE WATCHDOG. It writes a frame per health change during a blind walk,
    // which is the resolution the record most wants and also the fastest it can be spent:
    // a character under attack while travelling can burn twenty frames in twenty seconds,
    // and at 24 that evicted the entire run-up to the death being explained. Forty-eight
    // frames is about 12KB in a post-mortem — the text log is already larger.
    if (this.recent5.length > 48) this.recent5.shift();
    return f;
  }

  // TRAVEL, WITH THE TWO ENDS WRITTEN DOWN.
  //
  // Every `s.travel(...)` in this file goes through here so that setting off and arriving
  // are both observations rather than a silence with a conclusion drawn from whichever
  // side of it a pass happened to land on. The wrapper returns the same promise shape, so
  // the ten call sites keep their own `.catch(...)` exactly as they were, and the arrival
  // frame is written in a `finally` — a journey that THREW is the case where knowing
  // where it stopped matters most.
  async travel(room, opts) {
    this.recordFrame('setting off');
    try {
      return await this.s.travel(room, opts);   // the SESSION's travel, not this wrapper
    } finally {
      this.recordFrame('arrived');
    }
  }

  // WHAT IS ACTUALLY IN REACH OF US RIGHT NOW.
  //
  // NOT FLEETMATES. Without the player filter this chose a fleetmate 131 times out of
  // 132 — the characters stand next to each other by design, on walls and in inns, and
  // every one of them is ATTACKABLE. They cannot hurt each other while their guardian
  // angels hold, so it never showed as damage; it showed as twenty-five characters busy
  // all night and three kills between them.
  //
  // REACH is a disc of radius 3 on SQUARE coordinates, because that is what the server
  // tests: SquaredDistanceTo <= GetAttackRange^2 (nomoveon.kod:121). Up to 28 squares can
  // hit you, not the 8 that touch you.
  //
  // Extracted because two branches ask this question — the retaliation path and the
  // no-wall-nowhere-to-go dead end — and a copy that drifts would mean one of them
  // quietly disagreeing with the other about whether the character is under attack.
  inReachOfUs() {
    const c = this.s.client, me = c?.self;
    if (!me || !c?.room) return [];
    return [...c.room.objects.values()].filter(o =>
      o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER) &&
      Math.hypot(o.col - me.col, o.row - me.row) <= REACH);
  }

  // IS THIS THING TOO DANGEROUS TO SWING AT — asked of ONE creature, by name.
  //
  // capBlockers answers this for a whole room and only when the room is at cap, so the
  // judgement it makes was unreachable from anywhere else. That gap is what killed
  // Waldorf. `capBlockers` correctly refused four soldiers of the Princess' army as
  // unrecognised, logged the refusal, and 1.3 seconds later the retaliation branch below
  // picked one of the same four as a `bystander` and engaged it, because that branch
  // consulted nothing. Level 27, 27/27 health, dead in thirteen seconds.
  //
  // Faction soldiers were present at 241 of the 403 attended deaths on disk. Commit
  // 7a4705c ("Absence of information is not permission") fixed the clearing half of this
  // and left the retaliating half open; this is the same rule, extracted so both halves
  // ask one question.
  //
  // Returns null when the creature is fine to fight, or a reason when it is not. Karma is
  // deliberately NOT consulted here: karma is a choice about what to hunt, and something
  // already swinging at us is not a choice.
  refuseEngagement(name) {
    const key = String(name || '').toLowerCase();
    if (!key) return null;
    const spawns = loadSpawns(SPAWN_FILE);
    const info = Object.values(spawns.creatures ?? {})
      .find(x => String(x.name).toLowerCase() === key);
    const level = this.s.client?.vitals?.()?.health?.max ?? 0;
    const ceiling = level ? level + (this.policy.maxThreatOver ?? 6) : null;
    const lvl = info?.level ?? null, rating = info?.attack_rating ?? null;
    if (!info)
      return { name, level: null, rating: null,
               why: 'nothing is known about it — the spawn table has no row for this name, and ' +
                    'an unrecognised creature is refused rather than assumed harmless' };

    // GENTLE BY RATING IS FAIR GAME WHATEVER ITS LEVEL, and this is deliberately NOT the
    // same test capBlockers makes.
    //
    // capBlockers falls through to a level-only refusal, which reads a fungus beast —
    // level 50, difficulty 1, attack rating 210 — as more dangerous than a centipede at
    // level 30 and rating 390. CLAUDE.md is explicit that this is backwards: level is
    // what a blow costs, difficulty is how often one lands, and the level-50 creature is
    // the SAFER fight. There it is survivable, because a refusal only means "do not go
    // out of your way to clear it".
    //
    // Here it is not survivable, because the alternative to hitting back is turning your
    // back on something already swinging. Walking away from a gentle attacker costs free
    // hits and gains nothing. So retaliation judges on the RATING, which is the number
    // that actually describes danger, and refuses only what is genuinely above the band.
    if (rating != null && rating <= GENTLE_RATING) return null;
    if (ceiling != null && lvl != null && lvl > ceiling)
      return { name, level: lvl, rating,
               why: rating != null
                 ? `attack rating ${rating} is above the forgiving band of ${GENTLE_RATING} ` +
                   `and level ${lvl} is above the safety band of ${ceiling}`
                 : `level ${lvl} is above the safety band of ${ceiling} and the table has no ` +
                   `attack rating to judge it more kindly by` };
    return null;
  }

  // ------------------------------------------------------------------ post-mortem
  //
  // WHAT WAS HAPPENING WHEN IT DIED, written down while it is still true.
  //
  // `lastDeath` already said where and to what. It could not say WHY, because the two
  // things that answer why were never joined to it: the text the server sent — which is
  // where "you are hit for 11 damage" and "your sword shatters into pieces" live — and
  // the keeper's own decisions, which is where "gave up the safe spot" lives. Both were
  // being kept, in separate buffers, and neither survived the process.
  //
  // Nothing here is gathered specially. The client already keeps its last 500 events and
  // the keeper already keeps 200 journal entries; this is a join and a file.

  // The last N lines of text the server actually sent us, newest last. `said` is speech,
  // `message` is everything else — combat, refusals, the weapon breaking.
  recentText(limit = 30) {
    const evs = this.s.client?.events || [];
    const out = [];
    for (let i = evs.length - 1; i >= 0 && out.length < limit; i--) {
      const e = evs[i];
      if (e.kind === 'said' && e.text) out.push({ at: e.at, kind: 'said', who: e.name ?? null,
                                                  channel: e.type ?? null, text: e.text });
      else if (e.kind === 'message' && e.text) out.push({ at: e.at, kind: 'message', text: e.text });
    }
    return out.reverse();
  }

  // How fast health was going, in points per second, over the frames we have. Negative
  // means losing. A death at -0.3/s is attrition somebody should have withdrawn from;
  // a death at -4/s was not survivable by fleeing and the mistake was earlier.
  healthRate(frames) {
    const f = (frames || []).filter(x => x.health != null && x.at);
    if (f.length < 2) return null;
    const dt = (f[f.length - 1].at - f[0].at) / 1000;
    if (dt <= 0) return null;
    return +(((f[f.length - 1].health - f[0].health) / dt).toFixed(2));
  }

  // The whole record, as one object. Written on death, and readable any time — calling
  // it while alive is how you check the recorder works without killing anything.
  // Listen for our own death broadcast. Bounded and short: it normally lands within a
  // second, and everything after this point — the Underworld, the walk back — destroys
  // the evidence, so waiting long is worse than missing it.
  //
  // Matched on OUR name. A fleet of twenty-one dies often enough that "the most recent
  // ### line" is regularly about somebody else, which is exactly the sort of near-miss
  // that would make the record confidently wrong instead of honestly empty.
  async awaitDeathBroadcast({ waitMs = 3000 } = {}) {
    const c = this.s.client;
    if (!c) return null;
    const name = c.me?.name ?? this.s.name;
    const at = Date.now();
    // TIGHT FIRST, THEN THE WHOLE BUFFER.
    //
    // The windowed search is the precise answer when the death was noticed promptly, and
    // it is worth keeping for the `dt` it reports. But noticing is the slow part — death
    // is inferred from the Underworld on a LATER pass — so when the keeper is a journey
    // behind, the broadcast scrolled past the window before anything looked for it, and
    // the record lost the killer in exactly the cases where it is hardest to reconstruct
    // by hand. That was 69% of attended deaths: the line was sitting in `text` the whole
    // time, unmatched.
    const near = () => skills.deathBroadcastFor(name, c.events ?? [], at);
    const anywhere = () => skills.deathBroadcastFor(name, c.events ?? [], null);
    const already = near() ?? anywhere();
    if (already) return already;
    await c.waitFor({ kinds: ['message'], timeoutMs: waitMs }).catch(() => null);
    // `dt` is null on the fallback, which is the honest answer: we know the killer and we
    // do not know how long ago, because the thing that would have told us is the clock we
    // just admitted was wrong.
    return near() ?? anywhere();
  }

  postMortem(reason = 'died') {
    const frames = (this.recent5 || []).filter(f => !/underworld/i.test(f.room || ''));
    const last = frames[frames.length - 1] || null;
    // Rank frames on the true count, not the capped name list — otherwise every frame
    // with 6-or-more ties at 6 and "the worst moment" is just the first one that
    // saturated the cap. Falls back to the list length for records written before
    // threat_count existed.
    const crowd = f => f?.threat_count ?? f?.threats?.length ?? 0;
    const worst = frames.reduce((a, f) => (a && crowd(a) >= crowd(f)) ? a : f, null);
    return {
      character: this.s.client?.me?.name ?? this.s.name ?? null,
      agent: this.s.name ?? null,
      at: Date.now(), reason,
      // WHAT IT WAS DOING. The question everyone asks first.
      was: {
        doing: last?.doing ?? this.doing ?? this.lastDoing ?? null,
        mode: this.mode, hunting: this.policy.hunt, purpose: this.policy.purpose ?? null,
        strategy: this.policy.strategy,
        in_safe_spot: last?.holding ?? false,
        moving: last?.moved_ms != null && last.moved_ms < 12_000,
        swinging: last?.swung_ms != null && last.swung_ms < 12_000,
        ms_since_moved: last?.moved_ms ?? null,
        ms_since_swung: last?.swung_ms ?? null,
      },
      where: last ? { room: last.room, num: last.num, col: last.col, row: last.row } : null,
      vitals: {
        last_health: last?.health ?? null, level: last?.max ?? null,
        last_vigor: last?.vigor ?? null,
        health_per_second: this.healthRate(frames),
        trail: frames.map(f => f.health).filter(h => h != null),
        flee_threshold: this.safety?.().fleeAt ?? null,
      },
      threats: {
        present_at_the_end: last?.threats ?? [],
        // Prefer the real count; fall back to the capped list length for frames written
        // before threat_count existed, and say which it is so a mixed record is readable.
        most_at_once: worst?.threat_count ?? worst?.threats?.length ?? 0,
        most_at_once_is: worst?.threat_count != null ? 'a true count' : 'capped at 6 — old record',
        // Who else was standing there. Not a threat — these are ours — but it answers
        // "was anyone with it", which is the second question after "what killed it".
        players_present: last?.players_present ?? [],
      },
      // The three things that were being kept and never joined.
      frames,
      decisions: (this.journal || []).slice(-14),
      text: this.recentText(30),
      // WHERE THE DAMAGE ACTUALLY LANDED, which the three above cannot say.
      //
      // Frames are one per pass and a pass can be a multi-minute travel await, so the
      // record of a travelling death is a before and an after with the death in the gap.
      // These come off the event stream instead — health is pushed, one packet per change
      // — so they keep arriving through exactly that gap, and through an errand holding
      // the keeper inert. The last twenty segments are about the last few minutes of
      // trouble, which is longer than any fight that kills one of these characters.
      //
      // Read them against `frames`: a death whose frames say "inn, full health" and whose
      // hits say "nine squares of room 562 while travelling" is not a mystery, it is a
      // journey nobody was watching.
      hits: (this.s.hits?.segments || []).slice(-20),
      note: 'frames are one keeper pass each, oldest first. `text` is what the server ' +
            'sent, `decisions` is what the keeper chose, `hits` is where damage landed ' +
            'and comes off the event stream rather than the keeper — so it is the only ' +
            'one of the four that keeps recording during a travel or an errand. Read ' +
            'them side by side against the timestamps — the interesting moment is ' +
            'usually where they disagree.',
    };
  }

  // Durable, because the whole point is that somebody picks it up later. One file per
  // death under substrate/postmortems/, gitignored with everything else a fleet writes.
  writePostMortem(record) {
    try {
      mkdirSync(POSTMORTEM_DIR, { recursive: true });
      const who = String(record.character || record.agent || 'unknown').replace(/[^A-Za-z0-9_-]/g, '');
      const stamp = new Date(record.at).toISOString().replace(/[:.]/g, '-');
      const file = `${POSTMORTEM_DIR}/${who}-${stamp}.json`;
      writeFileSync(file, JSON.stringify(record, null, 2));
      return file;
    } catch (e) {
      // A failed write must not take the keeper down on the one pass where it is
      // already having a bad time.
      this.note('could not write the post-mortem', { why: e.message });
      return null;
    }
  }

  // THE SPOT NOTHING CAN ACTUALLY REACH — the cliff.
  //
  // A whole band of the fleet stood on the clifftop above West Merchant Way, taking a
  // swing at things below, walking back to the wall, and waiting for a fight that could
  // not happen: the monsters could not climb, and the characters were holding melee
  // weapons that could not reach down. Statler, Bunsen, Scooter, Beaker and Janice all
  // reported "fighting from an untrusted safe spot" and "hunting centipedes" while doing
  // neither, for hours.
  //
  // Nothing caught it, and the reason is precise. barrenSpots is written when pull()
  // FAILS. Here pull() SUCCEEDED every time — it reached the monster, hit it, and walked
  // back, which is exactly what it claims to do — so `progress('pulled something to the
  // wall')` fired every pass and cleared the stall counter. The keeper was busy, honest,
  // and completely stuck, and its own health check said so.
  //
  // The missing question is not "did the pull work" but "did the pull CONVERT". A pull
  // that never once results in something standing next to us is a pull into a place the
  // monster cannot follow, whatever the geometry says about the square. Counting them is
  // empirical and needs no height data, which is just as well: none is available, and
  // this failure catches human players too.
  pullDidNotConvert(why) {
    this.pullsWithoutContact = (this.pullsWithoutContact ?? 0) + 1;
    const limit = this.policy.pullsBeforeBarren ?? 3;
    if (this.pullsWithoutContact < limit) {
      this.note('pulled, but nothing came', {
        attempt: this.pullsWithoutContact, of: limit, why,
        hint: 'if this keeps happening the square cannot be fought from' });
      return false;
    }
    const room = this.s.world?.room;
    if (room?.num != null && this.hold) {
      (this.barrenSpots ??= new Map());
      const set = this.barrenSpots.get(room.num) ?? new Set();
      set.add(`${this.hold.col},${this.hold.row}`);
      this.barrenSpots.set(room.num, set);
    }
    // NOT recorded in the SafeSpotBook, deliberately. The book's `failed` means "we were
    // hit standing here" and feeds `discredited`, which is a SAFETY judgement. A cliff
    // square is perfectly safe — it is useless, which is the opposite problem — and
    // filing it under failed would teach the book a lie to get one convenient effect.
    // The cost is that this knowledge is per-process and a restart re-learns it, three
    // wasted passes at a time. Worth fixing with a second book, not with a wrong flag.
    this.note('SPOT UNUSABLE — nothing can reach it', {
      at: this.hold ? { col: this.hold.col, row: this.hold.row } : null,
      room: room?.num, attempts: this.pullsWithoutContact,
      why: 'every pull reached the target and none of them ever produced a fight. The ' +
           'commonest cause is standing somewhere the monsters cannot climb to, which ' +
           'also means a melee weapon cannot reach down to them.',
      note: 'excluded in this room; the keeper will pick somewhere else' });
    this.pullsWithoutContact = 0;
    this.releaseHold('nothing can reach this square');
    this.noProgress('holding a square nothing can reach');
    return true;
  }

  // Contact happened, so whatever we are standing on works. Called from the fight path.
  pullConverted() { this.pullsWithoutContact = 0; }

  // DOES WHAT WE ARE KILLING STILL PAY FOR WHAT WE SAID WE WERE FARMING?
  //
  // The one question the stall detector structurally cannot ask. noProgress() fires when
  // nothing WORKS; this fires when everything works and none of it is worth anything.
  // They are different failures and they need different words, because the second one
  // wears the first one's healthy face.
  //
  // Returns null when it cannot know — no purpose set, no spawn index, prey not in the
  // index, vitals not read yet. Null means "no opinion", never "fine".
  yieldCheck() {
    const { purpose, goals, hunt } = this.policy;
    if (purpose !== 'advance' || !hunt) return null;
    if (!goals?.length)
      return { paying: false, why: 'purpose is `advance` but no goals are set, so nothing ' +
                                   'can be checked — set policy.goals or clear policy.purpose' };
    const spawns = loadSpawns(SPAWN_FILE);
    if (!spawns) return null;
    const needle = String(hunt).toLowerCase();
    const c = Object.values(spawns.creatures)
      .find(x => x.name.toLowerCase().includes(needle) || x.cls.toLowerCase() === needle);
    if (!c) return null;
    const maxHealth = this.s.client?.vitals?.()?.health?.max ?? 0;
    if (!maxHealth) return null;
    // Stamina only moves the hit-point CEILING. Unknown is reported as unknown rather
    // than as 0, because 0 would put the ceiling at 101 and declare a healthy character
    // finished twenty hit points early.
    const stamina = this.s.client?.statsById?.get?.('stamina')?.value;
    const known = Number.isFinite(stamina) && stamina > 0;
    const ys = goals.map(g => goalYield(g, c, { maxHealth, stamina: known ? stamina : 0 }));
    const paying = ys.filter(y => y.pays);
    if (paying.length)
      return { paying: true, creature: c.name, level: c.level,
               for: paying.map(y => y.goal) };
    // Suppress a "finished" verdict we are not entitled to.
    const trustworthy = ys.filter(y => known || !y.done);
    if (!trustworthy.length) return null;
    return {
      paying: false, creature: c.name, level: c.level,
      why: trustworthy.map(y => `${y.goal} — ${y.why}`),
      hint: 'this keeper is working and gaining nothing. Re-target it with the `prey` ' +
            'tool; nothing in here will re-target it for you.',
      ...(known ? {} : { caveat: 'stamina unknown, so the hit-point ceiling was not checked' }),
    };
  }

  // Something useful happened; clear the stall.
  progress(why) {
    this.idlePasses = 0;
    this.stalledSince = null;
    this.stalledWhy = null;
    if (why) this.lastProgress = { at: Date.now(), why };
  }

  // Nothing useful happened. After a few of these in a row, say so out loud.
  noProgress(why) {
    this.idlePasses++;
    if (this.idlePasses >= 5 && !this.stalledSince) {
      this.stalledSince = Date.now();
      this.stalledWhy = why;
      this.note('STALLED', { why, passes: this.idlePasses,
                             hint: 'nothing has worked for several passes running' });
    } else if (this.stalledSince) this.stalledWhy = why;
  }

  // A DETAIL FIELD MUST NOT BE ABLE TO EAT THE RECORD'S OWN KEYS.
  //
  // This was `{ at: Date.now(), pass, what, ...detail }` — spread LAST — which is the
  // same shape CLAUDE.md documents for `emit(kind, data)` and for `recordEvent`, and it
  // failed the same way. `note('hitting back', { at: engageName, ... })` overwrote the
  // timestamp with "soldier of the Princess' army", so the one journal line that
  // explains why Waldorf picked a fight with four guards is the one line that cannot be
  // placed in time. The write succeeded; the record lied.
  //
  // Reserved keys are therefore applied AFTER the spread, so a colliding detail field is
  // inert rather than silent. It is preserved under `detail_<key>` rather than dropped,
  // because a caller that passed it meant something by it — see `detail_at` on the
  // retaliation note, which is the creature's name.
  note(what, detail = {}) {
    const e = { ...detail };
    for (const k of ['at', 'pass', 'what'])
      if (k in e) { e[`detail_${k}`] = e[k]; delete e[k]; }
    e.at = Date.now(); e.pass = this.passes; e.what = what;
    this.journal.push(e);
    if (this.journal.length > 200) this.journal.splice(0, this.journal.length - 200);
    if (what in DEBUG_STATES) this.flagDebug(what, e);
    return e;
  }

  // ------------------------------------------------------------------ debugging states
  //
  // Note it as usual, then keep the whole thing where the chat interface can find it and
  // push it to whoever has a client open. Called from note() rather than from the three
  // sites, so a state cannot be flagged in one place and forgotten in another.
  flagDebug(what, entry) {
    const c = this.s.client, me = c?.self;
    const room = this.s.world?.room, geo = this.s.world?.geometry;
    const v = c?.vitals?.() ?? {};
    this.debug = {
      what, label: DEBUG_STATES[what], at: Date.now(), pass: this.passes,
      room: room?.name ?? null, room_num: room?.num ?? null,
      col: me?.col ?? null, row: me?.row ?? null,
      grid: geo ? { rows: geo.rows, cols: geo.cols } : null,
      bearing: geo && me ? bearingIn(me.row, me.col, geo.rows, geo.cols) : null,
      on_floor: geo && me ? geo.walkable(me.row, me.col) : null,
      doing: this.doing ?? null, mode: this.mode, hunting: this.policy.hunt ?? null,
      health: v.health?.value ?? null, health_max: v.health?.max ?? null,
      vigor: vigorOf(v), rest_ceiling: REST_VIGOR_CAP * skills.VIGOR_MAX,
      holding: this.hold ? { col: this.hold.col, row: this.hold.row, proven: this.hold.proven } : null,
      monsters: c?.room ? [...c.room.objects.values()].filter(o =>
        o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER)).length : null,
      detail: entry,
    };
    this.debugSeen = this.debugSeen || {};
    this.debugSeen[what] = (this.debugSeen[what] || 0) + 1;
    this.tellPilot(this.debug).catch(() => {});   // never let a tell break a pass
  }

  // The full state as lines of prose, which is what both the tell and the in-game answer
  // want. Everything the journal entry carries is here — the entry is spread last so a
  // state-specific field (`considered`, `unreachable`, `spot`, `left_s`) is never lost.
  debugLines(d = this.debug) {
    if (!d) return ['nothing flagged — I am not in one of the three states being chased.'];
    const at = d.col != null ? `col ${d.col}/${d.grid?.cols ?? '?'}, row ${d.row}/${d.grid?.rows ?? '?'}` : 'position unknown';
    const lines = [
      `[${d.label}] ${d.room ?? 'unknown room'} (${d.room_num ?? '?'})`,
      `at ${d.bearing ?? 'somewhere'} — ${at}${d.on_floor === false ? ' — STANDING OFF THE FLOOR' : ''}`,
      `doing: ${d.doing ?? '?'} | mode ${d.mode} | hunting ${d.hunting ?? 'nothing'}`,
      `hp ${d.health ?? '?'}/${d.health_max ?? '?'} | vigor ${d.vigor ?? '?'} (rest cap ${d.rest_ceiling})`,
      `monsters here: ${d.monsters ?? '?'} | holding: ${d.holding ? `${d.holding.col},${d.holding.row}` : 'no spot'}`,
      `seen ${this.debugSeen?.[d.what] ?? 1}x this run`,
    ];
    // Whatever the specific state recorded, minus the keys already spoken above.
    const skip = new Set(['at', 'pass', 'what', 'why', 'note', 'hint']);
    const extra = Object.entries(d.detail || {})
      .filter(([k, v]) => !skip.has(k) && v != null && typeof v !== 'object')
      .map(([k, v]) => `${k}=${v}`);
    if (extra.length) lines.push(extra.join(' '));
    if (d.detail?.why) lines.push(`why: ${d.detail.why}`);
    return lines;
  }

  // SEND IT TO WHOEVER IS ACTUALLY HOLDING A CHARACTER, and to nobody otherwise.
  //
  // The recipient is not configured and cannot be: it is whichever of the fleet's own
  // characters a desktop client is currently piloting, which the broker knows because IT
  // spawned that client and can see the pid. No pilot means no tell — this must never
  // pick a name and message a stranger on a shared server.
  async tellPilot(d) {
    // OFF UNLESS SOMEBODY ASKS FOR IT, AND ASKING IS PER-SESSION.
    //
    // This speaks in-game, on a live server shared with other players, from twenty-one
    // characters at once. Even rate-limited to one tell per character per condition per
    // five minutes, three conditions across twenty-one characters is a steady trickle of
    // chatter that a person standing nearby sees, that costs mana, and that — per the
    // note below about UserSayGroup — is an ACTION, so it wakes the room's AIs.
    //
    // A debugging instrument should not be the fleet's default voice. It stays available
    // for the case it was built for (stand next to a character and have it explain
    // itself) but has to be turned on deliberately:
    //
    //   M59_DEBUG_TELLS=1 node tools/m59-broker.mjs ...
    //
    // Checked here rather than at the two call sites so there is one switch and no way to
    // add a third caller that misses it.
    if (!DEBUG_TELLS_ON) return { sent: false, why: 'debug tells are off (set M59_DEBUG_TELLS=1)' };
    const p = pilotedNow();
    if (!p || !p.character) return { sent: false, why: 'nobody is piloting a character' };
    if (p.agent === this.s.name) return { sent: false, why: 'that is this character' };
    const key = `${this.s.name}|${d.what}`;

    // NEVER SPEAK WHILE PLAYING DEAD. This is a backstop, not the mechanism.
    //
    // Settled from the server rather than guessed at. A tell runs UserSayGroup, which
    // begins:
    //
    //   % User took an action!  Wake any AIs in the room to the user's presence!
    //   if NOT (piFlags & PFLAG_MOVED_SINCE_ENTRY)
    //   { Send(self,@NotifyMonstersOfPresence); }        user.kod:4171
    //
    // UserSay carries the identical guard at user.kod:4052. So speech IS an action in the
    // one state where that matters: between the reconnect and the unfreeze the flag is
    // clear, and a single tell hands back the grace period the freeze exists to buy — on
    // a character that is, by definition, too hurt to survive the room noticing it.
    //
    // The freeze report is therefore sent from playDead() BEFORE the reconnect, where the
    // flag is still set from all the walking and swinging and the wake branch does not
    // run. That is both free and earlier. Anything still trying to speak in here is a
    // caller that has not been through that path, and it is refused rather than trusted.
    if (this.frozenUntil && Date.now() < this.frozenUntil) {
      tellSuppressed.set(key, (tellSuppressed.get(key) ?? 0) + 1);
      return { sent: false, why: 'playing dead — a tell would wake the room (user.kod:4171)' };
    }

    const last = tellCooldown.get(key) ?? 0;
    const since = Date.now() - last;
    if (since < DEBUG_TELL_COOLDOWN_MS) {
      const q = tellSuppressed.get(key) ?? 0;
      tellSuppressed.set(key, q + 1);
      return { sent: false, why: `cooled down, ${Math.round((DEBUG_TELL_COOLDOWN_MS - since) / 1000)}s left` };
    }
    const c = this.s.client;
    if (!c || !this.s.live) return { sent: false, why: 'not in game' };

    // Resolve the recipient by NAME through the online roster, the same way the `say`
    // tool does. Object ids are reissued by `save game`, so a stored id can silently
    // address the wrong thing; a name that is not logged on simply finds nobody.
    let id = null;
    try {
      await this.s.pacer.submit('read', () => c.players());
      await c.waitFor({ kinds: ['who'], timeoutMs: 3000 });
      const want = String(p.character).toLowerCase();
      id = [...c.playersOnline.values()].find(x => x.name && x.name.toLowerCase() === want)?.id ?? null;
    } catch { /* fall through to "not found" */ }
    if (id == null) return { sent: false, why: `${p.character} is not in the online roster` };

    const suppressed = tellSuppressed.get(key) ?? 0;
    tellSuppressed.set(key, 0);
    tellCooldown.set(key, Date.now());
    const head = `${this.s.name}: ${d.label}` +
                 (suppressed ? ` (+${suppressed} more in the last ${Math.round(DEBUG_TELL_COOLDOWN_MS / 60000)}m)` : '');
    // One tell per line rather than one long one: the server truncates a long say, and a
    // truncated tell would drop exactly the tail detail this exists to deliver. Capped,
    // and the cap is stated rather than silent.
    const lines = [head, ...this.debugLines(d).slice(1)];
    const MAX = 6;
    const send = lines.slice(0, MAX);
    if (lines.length > MAX) send.push(`(+${lines.length - MAX} more lines — ask me "debug" in game)`);
    for (const line of send) {
      try {
        await this.s.pacer.submit('say', () => c.sayGroup([id], line.slice(0, 200)));
      } catch { break; }        // out of mana, or the pilot logged off mid-send
    }
    return { sent: true, to: p.character, lines: send.length };
  }

  // Into the LONG record, keyed by character name, so it survives the keeper.
  //
  // The journal above is the flight recorder — 200 entries, gone when the broker
  // restarts, and the broker restarts often. An audit of what a character decided over
  // a week cannot live there. Bookkeeping must never break play, so this swallows
  // everything: a character with no name yet is simply not recorded.
  ledgerEvent(kind, detail = {}) {
    const who = this.s.client?.me?.name;
    if (!who) return;
    try { recordEvent(who, kind, { agent: this.name ?? this.s.name ?? undefined, ...detail }); }
    catch { /* never let the record break the play it is recording */ }
  }

  bookFor(spell) {
    const name = String(spell || 'unknown').toLowerCase();
    let b = this.spellbook.by_spell[name];
    if (!b) b = this.spellbook.by_spell[name] =
      { cast: 0, produced: 0, nothing: 0, mana_spent: 0, declined: {} };
    return b;
  }

  // A CAST THAT HAPPENED, with what it cost and what came back.
  //
  // `ok` is decided by the CALLER, from an inventory diff or a stat change, never from
  // the absence of an error — the server does not send one. `why` is the decision that
  // led here, and it is the field the audit is actually for: "cast create food" is a
  // fact, "cast create food because the larder was empty and a shop was four rooms
  // away" is a decision someone can disagree with.
  recordCast(spell, { ok = false, made = [], why = null, target = null,
                      mana_before = null, mana_after = null, reagents_before = null } = {}) {
    const name = String(spell || 'unknown').toLowerCase();
    const b = this.bookFor(name);
    b.cast++;
    if (ok) b.produced++; else b.nothing++;
    // Only when both readings are real and the mana went DOWN. A cast that completes as
    // the character regenerates can read as negative, and a guessed cost is worse than
    // no cost — it would be summed into a fleet total and quietly believed.
    const cost = (typeof mana_before === 'number' && typeof mana_after === 'number'
                  && mana_before >= mana_after) ? mana_before - mana_after : null;
    if (cost != null) b.mana_spent += cost;
    const e = { at: Date.now(), pass: this.passes, spell: name, ok: !!ok, why,
                made: made.length ? made : undefined, target: target || undefined,
                mana_cost: cost ?? undefined, reagents_before: reagents_before || undefined };
    this.spellbook.casts.push(e);
    if (this.spellbook.casts.length > 60)
      this.spellbook.casts.splice(0, this.spellbook.casts.length - 60);
    this.ledgerEvent('cast', { spell: name, ok: !!ok, why, target: target || undefined,
                               made: made.length ? made : undefined,
                               mana_cost: cost ?? undefined, reagents_before: reagents_before || undefined });
    return e;
  }

  // A CAST IT DECIDED AGAINST, and the reason.
  //
  // Counted every time; written to the long ledger at most once every ten minutes per
  // (spell, reason). provision() runs every pass and a pass is eight seconds, so a
  // character that has been two herbs short since lunch would otherwise write four
  // hundred identical lines a day — twenty-one of those, into a file nothing rotates.
  // The count is the interesting part anyway; the line is only there to date it.
  declinedCast(spell, why, detail = {}) {
    const name = String(spell || 'unknown').toLowerCase();
    const b = this.bookFor(name);
    b.declined[why] = (b.declined[why] || 0) + 1;
    const key = name + '/' + why;
    const last = this.spellbook.declined_logged.get(key) || 0;
    if (Date.now() - last >= 600_000) {
      this.spellbook.declined_logged.set(key, Date.now());
      this.ledgerEvent('cast_declined', { spell: name, why, times_so_far: b.declined[why], ...detail });
    }
    return false;
  }

  // WHAT IT BOUGHT AND WHY, one line per item.
  //
  // `kind` is the audit's actual question — reagent or food. The fleet's supply plan is
  // to cast rather than shop, and reagents at a counter it is already standing at are
  // the cheap top-up that makes casting possible; food bought outright is the fallback
  // that admits the casting loop is not keeping up. Which of those is happening is not
  // visible in a purse balance.
  recordPurchase(what, cost, { kind = null, from = null, why = null } = {}) {
    const k = kind || 'other';
    const price = Number(cost) || 0;
    this.spending.spent += price;
    const by = this.spending.by_kind[k] || (this.spending.by_kind[k] = { items: 0, spent: 0 });
    by.items++; by.spent += price;
    this.spending.bought.push({ at: Date.now(), what, cost: price, kind: k, from, why });
    if (this.spending.bought.length > 60)
      this.spending.bought.splice(0, this.spending.bought.length - 60);
    // `item_kind`, NOT `kind`. The ledger record has a `kind` of its own — the event
    // type — and a detail field of the same name used to overwrite it, filing every
    // purchase under 'elderberry' or 'herb' so that nothing looking for 'bought' ever
    // found one. recordEvent now refuses to be clobbered, but the field still reads
    // better named for what it is.
    this.ledgerEvent('bought', { what, cost: price, item_kind: k, from: from || undefined, why });
  }

  // healUp() may spend a flask, cast a heal on ourselves, or both, and an audit wants
  // those apart: a flask is an item the character had to find or buy, a cast is mana it
  // regenerates for free. `used` carries the spell's own name for a cast and the
  // literal 'flask' otherwise (m59-skills.mjs healUp), so that is the discriminator.
  //
  // Recorded from here rather than inside healUp so that module keeps no opinion about
  // bookkeeping — it is called by tools that have no keeper and no ledger.
  recordHealUse(h, why) {
    for (const used of h?.used || []) {
      if (/^flask$/i.test(used)) continue;
      this.recordCast(used, { ok: !!h.healed, target: 'self', why });
    }
  }

  // THE SESSION'S CASTING, as one block for `status`.
  //
  // Null rather than an empty table when nothing has happened: a keeper that has been
  // up for thirty seconds and one that has spent an hour declining to cast are
  // different states, and a row of zeroes reads as the second.
  spellSummary() {
    const spells = Object.entries(this.spellbook.by_spell);
    const bought = Object.entries(this.spending.by_kind);
    if (!spells.length && !bought.length) return null;
    return {
      cast: spells.map(([spell, b]) => ({
        spell, cast: b.cast, produced: b.produced, nothing: b.nothing,
        // The number the audit exists for. A spell cast forty times that produced
        // nothing forty times is not a working supply loop, and every count above this
        // line would say it was.
        worked: b.cast ? Math.round(100 * b.produced / b.cast) + '%' : null,
        mana_spent: b.mana_spent || undefined,
        declined: Object.keys(b.declined).length ? b.declined : undefined,
      })).sort((a, b) => b.cast - a.cast),
      // Spells it only ever declined appear above with cast: 0 — that is the point.
      bought: bought.length
        ? { total_spent: this.spending.spent,
            by_kind: Object.fromEntries(bought.map(([k, v]) => [k, v])),
            recent: this.spending.bought.slice(-5).map(p => `${p.what} @${p.cost}`) }
        : null,
      never_bought_food: !this.spending.by_kind.food,
      note: 'nothing in this fleet buys prepared food: restockReagents filters the shop ' +
            'list through skills.SHAREABLE, which is elderberry and herbs only. So an ' +
            'empty larder is answered by casting or by looting, never by shopping — if ' +
            'that is not what you want, the list is the place to change it',
    };
  }

  // A PURCHASE IT DECIDED AGAINST. Same rate limit and same reason as declinedCast:
  // makeRoom() reaches a merchant often, and "already had enough" every time is not
  // worth a line each, but the count answers "why has this one never restocked".
  declinedPurchase(why, detail = {}) {
    this.spending.declined[why] = (this.spending.declined[why] || 0) + 1;
    const key = 'buy/' + why;
    const last = this.spellbook.declined_logged.get(key) || 0;
    if (Date.now() - last >= 600_000) {
      this.spellbook.declined_logged.set(key, Date.now());
      this.ledgerEvent('buy_declined', { why, times_so_far: this.spending.declined[why], ...detail });
    }
  }

  status({ full = false } = {}) {
    return {
      running: this.running, mode: this.mode, policy: this.policy,
      // Null unless a fleet update is waiting on this character. See park().
      parked: this.parkStatus(),
      // Null unless something else is driving this character. `running: true` with
      // `inert` set is the normal shape of an errand in progress — the loop is watching
      // and recording, and it is not the thing moving the character.
      inert: this.inertStatus(),
      // What it is up to, in the words someone watching would use. Belongs here rather
      // than only on the fleet snapshot: anything reading a keeper's status — the
      // terminal board, another agent — wants the sentence, not the time buckets.
      activity: this.activity(),
      // IS THE FLEET ALREADY USING THIS CHARACTER FOR SOMETHING? Null for nearly all of
      // them, and never absent — a board that greys committed rows has to be able to tell
      // "free" from "this broker does not answer that question", and undefined is what it
      // reads as the second. See m59-commitment.mjs for what counts and why the answer is
      // computed there rather than here.
      committed: this.commitment(),
      // HOW BLIND THIS KEEPER HAS BEEN, and what it did about it. `longest_block_ms` is
      // the headline: it is how long the decide loop has gone inside a single await, and
      // it is the number the whole watchdog exists to bound the damage from. Null before
      // the keeper has started, never absent while it is running.
      watchdog: this.watchTimer ? {
        ticks: this.watch.ticks, frames_written: this.watch.frames,
        interrupts: this.watch.interrupts,
        longest_block_ms: this.watch.longest_block_ms,
        blocked_now_ms: this.passStartedAt ? Date.now() - this.passStartedAt : 0,
        last_frame_s_ago: this.lastFrameAt ? Math.round((Date.now() - this.lastFrameAt) / 1000) : null,
      } : null,
      passes: this.passes,
      running_for_seconds: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      // The summary is the part a returning model should read first; the journal is
      // there for when the summary is surprising.
      did: {
        ...this.tally,
        // THIS KEEPER'S OWN VIEW, AND IT IS NARROWER THAN ITS NAME. `killTimes` starts
        // empty in the constructor and the supervisor restarts keepers about once a
        // minute, so this really means "kills since the last restart, capped at 30
        // minutes" — it is the keeper's opinion of its own run, not a fleet-wide rate.
        // Anything rendering a kills/30m column must use countKills() in m59-ledger.mjs,
        // which counts `killed` events off disk and therefore survives a keeper. The
        // fleet rows do; this stays because a returning model reading `did` wants to
        // know what THIS keeper has managed since it started.
        kills_30m: this.killsSince(30 * 60_000),
        looted: Object.entries(this.tally.looted).map(([k, n]) => `${k}${n > 1 ? ` x${n}` : ''}`),
        rooms_visited: [...this.visited],
      },
      last_error: this.lastError,
      // The one field worth reading before anything else. Everything this keeper got
      // wrong in practice was invisible: it kept running, kept journalling, and did
      // no work. If this is set, it has been going through the motions.
      // The second invisible failure, alongside `stalled`: working perfectly and earning
      // nothing. Null when there is no opinion to give — never a quiet "fine".
      yield_check: this.yieldCheck(),
      stalled: this.stalledSince
        ? { since_seconds: Math.round((Date.now() - this.stalledSince) / 1000),
            idle_passes: this.idlePasses, why: this.stalledWhy }
        : false,
      home_room: this.homeRoom,
      // WHAT VIGOR IT IS ACTUALLY FIGHTING AT. Vigor sets how fast health comes back
      // between fights, so a character that engages tired stays tired. `below_want`
      // over `engagements` is the honest score; `starved_passes` says the reason is
      // an empty pack rather than a bad threshold.
      vigor: this.vigor.engagements || this.vigor.waited ? {
        floor_now: this.fightFloor(), want: WANT_FIGHT_VIGOR,
        engagements: this.vigor.engagements,
        average_at_engage: this.vigor.engagements
          ? Math.round(this.vigor.total_at_engage / this.vigor.engagements) : null,
        lowest_at_engage: this.vigor.lowest_at_engage,
        started_below_want: this.vigor.engagements
          ? Math.round(100 * this.vigor.below_want / this.vigor.engagements) + '%' : null,
        waited_for_vigor: this.vigor.waited,
        starved_passes: this.vigor.starved_passes,
        // Self-provisioning: how often it fed itself rather than needing a supply run.
        cooked: this.vigor.cooked, cook_failed: this.vigor.cook_failed,
        reagents: this.reagentCount(),
      } : null,
      // WHAT IT CAST, WHAT IT REFUSED TO CAST, AND WHAT IT BOUGHT INSTEAD.
      //
      // Since the broker restarts this is only the current session; `history spells:true`
      // is the same question over days. Both, because they answer different ones — this
      // says what the keeper in front of you is doing, that says whether it has ever
      // worked. Null when it has neither cast nor declined anything, so an idle keeper
      // does not render an empty table that reads as "casting nothing on purpose".
      spells: this.spellSummary(),
      // ROOMS THIS KEEPER HAS REFUSED, and why. Null when it has refused none.
      //
      // Reported rather than merely obeyed, because refusing rooms is a self-inflicted
      // limit: a keeper that quietly declines half the map looks identical to one that
      // is simply unlucky with spawns, and the fleet would slowly stop working with no
      // single thing to point at. This is the list to read when output falls.
      denied_rooms: this.noWallRooms?.size
        ? { count: this.noWallRooms.size,
            rooms: [...this.noWallRooms.entries()].filter(([, v]) => v !== false)
                     .map(([room, why]) => ({ room, why })),
            note: 'refused for having no safe wall this keeper could find. Not proof there is ' +
                  'none — see requireSafeWall. Cleared on restart, so a better detector wins ' +
                  'them back without anything to undo' }
        : null,
      // IS THE MONEY GETTING TO A BANK. banked is the total put away; carried_at_death
      // is what was lost on the floor anyway, and is the number to drive to zero.
      money: (this.money.trips || this.money.carried_at_death || this.tally.banked) ? {
        bank_above: this.policy.bankAbove, float_kept: this.policy.walkingMoney ?? 400,
        carrying: this.lastSeenPurse ?? null,
        banked: this.tally.banked ?? 0,
        trips: this.money.trips, trips_failed: this.money.trips_failed,
        carried_at_death: this.money.carried_at_death,
        why_not: this.money.why_not,
      } : null,
      // WHERE IT WAS PUT, AND WHETHER THAT STUCK. Three numbers, in the order worth
      // arguing about: did the assignment work, does it work every time, and how does
      // it fail. `held` null means it has never had to relocate, which is the good
      // case and must not read as 0%.
      placement: this.policy.assignedRoom == null && !this.placement.relocations ? null : {
        assigned_room: this.policy.assignedRoom,
        standing_where_assigned: this.policy.assignedRoom != null
          ? this.s.world?.room?.num === this.policy.assignedRoom : null,
        held: this.placement.relocations
          ? Math.round(100 * this.placement.returned_to_assignment / this.placement.relocations) + '%'
          : null,
        ...this.placement,
        drifted_to: Object.entries(this.placement.drifted_to)
          .map(([r, n]) => `${r}${n > 1 ? ` x${n}` : ''}`),
      },
      // WHERE WE ARE STANDING AND WHETHER IT WORKS. Read this before deciding
      // anything about a fight: `works` true means the character cannot be hit unless
      // it swings first, which makes breaking off free, makes resting to full
      // possible in a monster room, and makes fleeing the wrong move.
      safe_spot: this.hold ? {
        at: { col: this.hold.col, row: this.hold.row },
        works: this.holdWorks(),
        evidence: this.hold.proven
          ? (this.hold.inherited && !this.hold.provenAt
              ? 'held under attack on an earlier visit'
              : `nothing landed in ${Math.round(this.hold.quietMs / 1000)}s with ` +
                `${this.hold.mostAttackers} thing(s) standing next to us`)
          : (this.hold.failures
              ? `hit ${this.hold.failures} time(s) while standing still — this square does not work`
              : 'untested: treated as open floor until something stands next to us without landing a blow'),
        // Not "sides open" any more: how many of the 28 squares within melee reach can
        // actually swing at this one, and how many we can hit from it for free.
        can_reach_you: this.hold.canReachYou, free_shots: this.hold.freeShots,
        back_cover: this.hold.backCover,
        held_s: Math.round((Date.now() - this.hold.takenAt) / 1000),
      } : false,
      // Who is on us, and how that is known — the protocol never says outright.
      threat: (() => {
        const t = this.threat();
        return { could_reach_us: t.near.length, camped_on_us: t.engaged,
                 in_swing_range: t.adjacent.length, what: t.names,
                 landing_damage: t.landing || 0,
                 note: 'nothing in the protocol says who has targeted us. `camped_on_us` is things ' +
                       'that have stayed next to us for more than one pass; `landing_damage` is the ' +
                       'only direct evidence, and it is what proves or disproves a safe spot' };
      })(),
      // Where the time went. `stalled` here means only what it says: standing about
      // not knowing what to do, while not recovering.
      time: (() => {
        const t = this.time, act = this.activeSeconds, total = act + t.stalled;
        const r = n => Math.round(n);
        return { fighting_s: r(t.fighting), recovering_s: r(t.recovering),
                 travelling_s: r(t.travelling), trading_s: r(t.trading),
                 stalled_s: r(t.stalled),
                 active_s: r(act),
                 stalled_pct: total ? +((100 * t.stalled) / total).toFixed(1) : 0 };
      })(),
      last_death: this.lastDeath ?? null,
      // Visible on purpose: "resting and refusing to fight" and "stuck doing nothing"
      // look identical from outside, and the whole point of the flag is that it holds a
      // character still on purpose for a while.
      recovering_from_death: this.recoverUntilWhole ? {
        until: 'health >= 95% and vigor >= the resting cap',
        why: 'came back from the dead; not going out again until whole',
      } : null,
      recent: this.journal.slice(-12),
      // THE MEASUREMENT, NOT THE CONCLUSION. Every window observe() looked at, with
      // the readings it was looking at, so that someone standing in the room can
      // disagree with a specific one. Discards are here too and are the interesting
      // half: a window wrongly thrown away is how this would be quietly broken.
      trials: this.trials.slice(-12),
      ...(full ? { journal: this.journal, all_trials: this.trials } : {}),
    };
  }

  countLoot(items = []) {
    for (const it of items) {
      const name = String(it).replace(/ x\d+$/, '');
      const n = Number(/ x(\d+)$/.exec(String(it))?.[1] ?? 1);
      this.tally.looted[name] = (this.tally.looted[name] || 0) + n;
    }
  }

  // STOPPING IS NOT INSTANT, AND STARTING HAS TO KNOW THAT.
  //
  // stop() only sets a flag; the loop notices it when the pass it is in finishes,
  // which can be most of a minute later if that pass is walking across the world. So
  // the ordinary "stop it, move it, start it again" sequence lands its start while
  // the old loop is still winding down — and the old code took `running` at face
  // value, returned "already running", and was then switched off by the very loop it
  // had just declined to replace. The keeper reported itself started and did nothing
  // for ever after, which is exactly the silent stall the rest of this file exists to
  // prevent. Three characters were sitting in it before it was noticed.
  //
  // Cancelling the pending stop is the whole fix; loop() re-checks the flag on its way
  // out so a cancellation lands even at the last moment.
  // INERT: STILL WATCHING, JUST NOT ACTING.
  //
  // Almost every "stop the keeper" in this repository does not want the keeper gone. It
  // wants the keeper to stop DRIVING, because something else is about to — an errand
  // walking the character to a smith, a supply trade, a person taking the controls. Only
  // one thing may drive a character at a time, and that is the whole requirement.
  //
  // Stopping is a very expensive way to get it. A stopped keeper writes no frames, runs
  // no observe(), records no death and files no post-mortem — so the character keeps
  // playing and the instruments go dark, which is precisely when we most want them. It is
  // why the post-mortem carries `during_keeper_outage` at all: deaths kept happening in
  // exactly the windows we had chosen to stop looking. Three of the last fourteen death
  // records died inside one, one of them 794 seconds in, and the field exists because
  // there was nothing else to say about them.
  //
  // Inert is the same non-interference with the instruments left on. The loop keeps
  // running, so noteWhere, declareInterest, the partner register, observe(), recordFrame()
  // and the death record all keep working; everything from the first branch that would
  // MOVE, SWING, SPEAK, TRADE or CAST is skipped.
  //
  // THE ONE EXEMPTION IS DEATH, and it is not a compromise. A character in the Underworld
  // has no exits, cannot be observed and cannot be recorded — a corpse produces no
  // telemetry at all — so escaping is what makes the rest of this state worth having.
  // Whatever errand was driving has already failed by then; its travel calls are the
  // thing reporting so.
  //
  // AND IT HAS A DEADLINE, because an errand that crashes between goInert and revive
  // would otherwise leave a character watching itself for the rest of the session. Every
  // caller here restores explicitly; the deadline is for the ones that do not get to.
  goInert(why = null, { maxMs = INERT_MAX_MS } = {}) {
    if (this.inert) return this.inertStatus();
    this.inert = { why, at: Date.now(), maxMs };
    // Everything learned about which squares hold, in case the process goes away while
    // we are in this state. Same reason stop() does it.
    this.book.save();
    // The ledger gets it too, so a death in this window is attributable. Deliberately a
    // DIFFERENT event from 'stop': the whole point is that this outage is not one.
    uptime.record(this.s.name, 'inert', { why, room: this.s.world?.room?.num ?? null });
    this.note('going inert', {
      why, what_happens: 'the keeper keeps looking and keeps recording — frames, ' +
        'observations, the death record — and stops moving, swinging, speaking and trading. ' +
        'Something else is driving now',
      until: 'revive(), start(), or ' + Math.round(maxMs / 60_000) + ' minutes, whichever is first' });
    return this.inertStatus();
  }

  revive(why = null) {
    if (!this.inert) return null;
    const held = Date.now() - this.inert.at;
    uptime.record(this.s.name, 'revive', { why, held_ms: held });
    this.inert = null;
    this.note('no longer inert', { why, was_inert_for_s: Math.round(held / 1000) });
    return null;
  }

  // The name the world knows this character by, falling back to the agent name before
  // login has answered. Everything keyed per character — the feed, the gains, the hits
  // book — has to agree on this or it silently keeps two sets of books.
  who() { return this.s.client?.me?.name ?? this.s.name ?? null; }

  // "YOU SUDDENLY FEEL A LITTLE TOUGHER." — the only announcement of the only thing this
  // fleet is for, and nothing was listening for it.
  //
  // The point is rolled inside the killing blow (player.kod:7827) and announced on the
  // spot, so this scans the client's own event ring for the line and hands it to the
  // record, which attributes it to the kill on either side of it. Everything else about
  // a gain — the full heal, the 200 nutrition — is a consequence the server applies for
  // free; it is this string that says a point was earned rather than restored.
  //
  // Watermarked rather than time-windowed. A pass can take minutes (a travel is one
  // await), so "events in the last N seconds" would miss gains outright; a sequence
  // number cannot. Only ever moves forward, so a gain is counted exactly once.
  noteToughness() {
    const c = this.s.client;
    if (!c) return;
    const evs = c.events || [];
    // THE FIRST CALL ONLY SETS THE WATERMARK. The client keeps its last 500 events and
    // outlives the keeper — `autopilot stop` then `start` hands back the same client —
    // so starting from zero would re-scan a ring that may already contain a gain this
    // record has, and write it twice. A keeper that starts mid-session is not entitled
    // to claim what happened before it was watching.
    const high0 = evs.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
    if (this.toughSeen == null) { this.toughSeen = high0; return; }
    const from = this.toughSeen;
    let high = from;
    for (const e of evs) {
      // `call` events carry no seq; every message does. Treating a missing seq as 0
      // skips it, which is right for the only kind that lacks one.
      const seq = e.seq ?? 0;
      if (seq <= from) continue;
      if (seq > high) high = seq;
      if (e.kind !== 'message' || !tougher.TOUGHER_LINE.test(e.text || '')) continue;
      const room = this.s.world?.room;
      const max = c.vitals?.()?.health?.max ?? null;
      tougher.recordGain(this.who(), {
        at: e.at ?? Date.now(), from: max == null ? null : max - 1, to: max,
        room: room?.name ?? null, room_num: room?.num ?? null, said: e.text,
      });
      this.tally.toughened = (this.tally.toughened || 0) + 1;
      this.progress('gained a point of maximum health');
      this.note('TOUGHER', {
        now: max, room: room?.name,
        why: 'the server announced a maximum-health gain — the one thing being farmed',
      });
    }
    this.toughSeen = high;
    // A gain nothing claimed within the window is written with its cause left null. Done
    // here rather than on a timer so it costs a comparison on a pass we were running
    // anyway.
    tougher.flushPending(this.who());
  }

  // WHAT THE FLEET IS USING THIS CHARACTER FOR, if anything. One place, because two
  // things ask it — the keeper's own status, and the terminal that greys the row and
  // steps over it — and an operation the board misses is one somebody takes a character
  // out of without knowing there was another end to it.
  commitment() {
    return describeCommitment({
      errand: this.errand,
      inert: this.inertStatus(),
      parked: this.parkStatus(),
      partner: this.policy?.partner ?? null,
    });
  }

  // RELEASE IT, whatever is holding it. The override key on the fleet board is the only
  // caller, and it is an emergency key: a character is about to die on a loot run, or the
  // person wants it NOW. So this is deliberately blunt — cancel the errand, drop the
  // pairing on this side, revive an inert keeper — and it reports each thing it undid so
  // the terminal can say what it just cost. It does not touch the OTHER end of a pairing:
  // that character's keeper finds its partner gone on its next pass and goes back to
  // fighting alone, which is the behaviour it already has for a partner that logs out.
  releaseCommitment(why = 'an operator took this character back') {
    const was = this.commitment();
    const undone = [];
    if (this.errand) {
      undone.push(`cancelled the ${this.errand.kind || 'errand'}`);
      this.note('errand cancelled by an operator', { was: was?.label, why });
      this.errand = null;
    }
    if (this.policy?.partner) {
      undone.push(`unpaired from ${this.policy.partner}`);
      party.unpair(this.name ?? this.s?.name);
      this.policy.partner = null;
    }
    if (this.inert) { undone.push('revived the keeper'); this.revive(why); }
    return { released: !!was, was, undone };
  }

  inertStatus() {
    if (!this.inert) return null;
    return { inert: true, why: this.inert.why,
             for_s: Math.round((Date.now() - this.inert.at) / 1000),
             gives_up_after_s: Math.round(this.inert.maxMs / 1000) };
  }

  start() {
    // A start on an inert keeper is a revive. Every caller that held one already pairs
    // its hold with a `start`, so this is what makes the change invisible to them.
    if (this.inert) {
      this.revive('started again');
      if (this.running) { this.note('started', { mode: this.mode, hunt: this.policy.hunt }); return this.status(); }
    }
    if (this.running && this.stopping) {
      this.stopping = false;
      this.note('start cancelled a stop that had not taken effect yet', {
        why: 'the previous loop was still finishing a pass; it now carries on with the new orders' });
      return this.status();
    }
    if (this.running) return this.status();
    this.running = true; this.stopping = false; this.startedAt = Date.now();
    // The independent eye. Started with the keeper and stopped with it, because it exists
    // to watch this keeper's blind spots and has nothing to watch when there is no keeper.
    this.startWatchdog();
    // WRITTEN OUTSIDE THE KEEPER, because a keeper that is gone cannot record that it is
    // gone. Without this there is no way to tell a death the strategy caused from one
    // that happened while nothing was driving — and a broker restart stops all twenty-one
    // at once, which is exactly why deaths arrive in waves. See m59-uptime.mjs.
    uptime.record(this.s.name, 'start', { mode: this.mode, hunt: this.policy?.hunt ?? null });
    // A fresh start is a new job: whatever room was worth hunting under the last
    // orders is not evidence about these ones, and may not even be reachable now.
    this.homeRoom = null;
    this.roamedFrom = null;
    this.roamedRooms = 0;
    // A room we could not route to from the last job's starting point may be
    // perfectly reachable from this one.
    this.unreachable.clear();
    // Whatever we believed about where we were standing was believed under the last
    // orders and possibly in another room. The BOOK survives — walls do not move, and
    // that is the whole reason it is written down — but the claim to be standing on
    // one does not.
    this.hold = null;
    this.lastObs = null;
    this.campedIds = new Set();
    // A fresh session gets fresh readings. The book persists; the willingness to spend
    // a few seconds re-checking it does not, or a keeper restarted twenty times would
    // never test anything again.
    this.spotTestsRun = 0;
    this.spotTest = null;
    this.progress('started');
    this.note('started', { mode: this.mode, hunt: this.policy.hunt });
    // Deliberately not awaited: the loop outlives the call that started it.
    this.loop().catch(e => { this.lastError = e.message; this.running = false; this.note('crashed', { why: e.message }); });
    return this.status();
  }

  // STOPPING NOW MEANS GOING INERT, and a real stop has to be asked for.
  //
  // Every caller of this wanted the same thing — stop driving, something else is about to
  // — and none of them wanted the instruments switched off, which is what they were
  // getting. So the default is the one that keeps looking, and `hard` is for the case
  // where the keeper genuinely has to end: the object is being discarded, or the process
  // is going away and the loop must not outlive it.
  //
  // The distinction is worth keeping rather than deleting the hard path: an inert keeper
  // is still a running loop holding a session, and dropAutopilot must be able to get rid
  // of one. See goInert for why everything else should not.
  stop(why = null, { hard = false } = {}) {
    if (!hard) { this.goInert(why); return this.status(); }
    this.stopping = true;
    this.stopWatchdog();
    this.passStartedAt = null;
    // A hard stop leaves nothing behind to revive, so clear this rather than letting a
    // later start() see a stale hold and report a revive that did not happen.
    this.inert = null;
    // Everything learned about which squares hold, before this keeper goes away.
    this.book.save();
    // The character is about to be left standing exactly where it is, in whatever room
    // it is in, while everything already swinging at it carries on. That is a fact about
    // the world, not about this keeper, so it goes in the ledger that outlives it.
    uptime.record(this.s.name, 'stop', { why, room: this.s.world?.room?.num ?? null });
    this.note('stopping', why ? { why } : undefined);
    return this.status();
  }

  // Charge the elapsed time of a pass to whatever it turned out to be doing.
  spend(ms) {
    const k = this.doing || 'stalled';
    this.time[k] = (this.time[k] || 0) + ms / 1000;
    // WHAT THE PASS TURNED OUT TO BE, kept after the reset.
    //
    // `doing` is set part-way through a pass and cleared here at the end of it, so
    // anything reading it at the START of a pass — which is where the post-mortem frame
    // is written — sees null, always. Nine frames of a live character all said "doing:
    // null" while it was plainly farming, and the unit tests missed it because they set
    // the field by hand. This is the pass that just finished, which is the honest answer
    // to "what was it doing" for a frame taken before the next one decides anything.
    this.lastDoing = k;
    this.doing = null;
  }

  get activeSeconds() {
    const t = this.time;
    return t.fighting + t.recovering + t.travelling + t.trading;
  }

  // ------------------------------------------------------------------ the watchdog
  //
  // THE KEEPER GOES BLIND FOR MOST OF EVERY DEATH, AND ADDING FRAMES AROUND THE AWAIT DOES
  // NOT FIX IT.
  //
  // Measured over 715 deaths: 645 had a keeper the uptime ledger says was running, and
  // 521 of those — 81% — had it blind at the moment of death. Median gap 18 seconds,
  // p90 219. The cause is structural rather than a missing call: `pass()` is one long
  // async function and a single `await this.travel(...)` inside it can run for minutes,
  // during which nothing re-decides anything.
  //
  // travel() ALREADY records a frame either side of itself — 'setting off' and 'arrived' —
  // and Camilla's post-mortem is the proof that this is not enough. Her last frame reads
  // `why: "setting off"`, 17.8 seconds before she died: the 'arrived' frame in the
  // `finally` never described anything, because she died inside the await. Bracketing a
  // blind interval tells you when it started. It does not make anybody look.
  //
  // So the watchdog is a SEPARATE TIMER that does not care what the pass is doing, and
  // this is the whole point of it being a timer rather than another await: the server
  // PUSHES health (BP_STAT, one packet per change), so `client.vitals()` is live and
  // free whatever the pass is blocked on. Reading it costs no packet, no round trip, and
  // no permission from whatever is holding the call stack.
  //
  // Two jobs, in order of how much they matter:
  //
  //   1. THE RECORD KEEPS BREATHING. A frame whenever health changes, and one every
  //      WATCHDOG_FRAME_MS regardless, so a post-mortem is never a bracket around a hole.
  //   2. IT CAN PULL THE HANDBRAKE. `Session.cancelMovement()` bumps the movement
  //      generation, and travel checks it in twelve places including inside the paced
  //      step loops — so a walk stops within about a second of being told to. If health
  //      crosses the flee line while the pass is blocked in a walk, the walk ends and the
  //      next pass gets to make a survival decision with fresh numbers instead of
  //      arriving as a corpse.
  //
  // What it deliberately does NOT do is decide anything. It has no policy, it never
  // fights, rests or moves, and it cannot take a safe spot. It interrupts, and the
  // ordinary pass — which already knows how to flee, rest and find a wall — does the rest.
  // A second decision-maker running concurrently with the first is how you get two
  // keepers arguing over one body.
  startWatchdog() {
    if (this.watchTimer) return;
    this.watch = { ticks: 0, frames: 0, interrupts: 0, longest_block_ms: 0,
                   lastHealth: null, blockedSince: null, interruptedPass: null };
    this.watchTimer = setInterval(() => {
      try { this.watchdogTick(); } catch (e) { this.watch.lastError = e.message; }
    }, WATCHDOG_MS);
    this.watchTimer.unref?.();
  }

  stopWatchdog() {
    if (!this.watchTimer) return;
    clearInterval(this.watchTimer);
    this.watchTimer = null;
  }

  watchdogTick() {
    const s = this.s, c = s?.client;
    if (!c || s.live !== true || c.state !== 'game') return;
    const w = this.watch;
    w.ticks++;
    const now = Date.now();
    const v = c.vitals?.();
    const hp = v?.health;

    // 1. A FRAME WHEN SOMETHING MOVED, OR WHEN NOTHING HAS FOR A WHILE.
    //
    // Gated on change rather than written every tick, because the frame ring is small and
    // a three-minute quiet travel would otherwise evict the entire run-up to the death it
    // is there to explain. A quiet walk produces one frame every WATCHDOG_FRAME_MS; a
    // character being chewed on produces one per hit, which is exactly the resolution the
    // record wants and the case the ring should be spent on.
    const changed = hp?.value != null && hp.value !== w.lastHealth;
    if (changed || now - (this.lastFrameAt ?? 0) >= WATCHDOG_FRAME_MS) {
      this.recordFrame(changed ? 'watchdog: health moved' : 'watchdog');
      w.frames++;
    }
    w.lastHealth = hp?.value ?? null;

    // 2. THE HANDBRAKE.
    const blockedFor = this.passStartedAt ? now - this.passStartedAt : 0;
    if (blockedFor > w.longest_block_ms) w.longest_block_ms = blockedFor;
    if (blockedFor < WATCHDOG_BLOCKED_MS) return;
    w.blockedSince ??= this.passStartedAt;

    // Not while something else is driving. An errand or a supply exchange owns the
    // character deliberately, and cancelling its movement from underneath it would be
    // this keeper fighting the thing it stood down for.
    if (this.inert) return;
    // Once per blocked pass. Cancelling twice does nothing useful and the note would
    // repeat every tick.
    if (w.interruptedPass === this.passes) return;

    const frac = pct(hp);
    if (frac === null) return;
    const fleeAt = this.safety().fleeAt;
    if (frac >= fleeAt) return;

    w.interruptedPass = this.passes;
    w.interrupts++;
    this.tally.watchdog_interrupts = (this.tally.watchdog_interrupts || 0) + 1;
    const stopped = (() => {
      try { return s.cancelMovement(); } catch (e) { return { cancelled: false, why: e.message }; }
    })();
    this.note('WATCHDOG — pulled the character out of a blind walk', {
      health: `${hp.value}/${hp.max}`, at_fraction: Math.round(frac * 100) + '%',
      flee_at: Math.round(fleeAt * 100) + '%',
      pass_blocked_for_s: Math.round(blockedFor / 1000),
      interrupted: stopped.interrupted ?? null,
      why: 'the pass has been inside one await long enough to have stopped looking, and ' +
           'health crossed the withdraw threshold while it was not. The walk is cancelled ' +
           'so the next pass can decide with real numbers — this keeper does not decide ' +
           'anything itself',
    });
    this.progress('watchdog interrupted a blind walk');
  }

  async loop() {
    // The outer loop is the other half of start()'s cancellation. Between leaving the
    // inner loop and admitting we have stopped there is no await, so a start() can
    // only ever be observed by the outer test — which means a cancelled stop is picked
    // up rather than racing us to the exit.
    do {
      while (!this.stopping) {
        this.passes++;
        const began = Date.now();
        // WHEN THIS PASS STARTED, readable from outside the call stack. The watchdog runs
        // on its own timer and this is the only way it can tell "the keeper is between
        // passes" from "the keeper has been inside one await for ninety seconds".
        this.passStartedAt = began;
        try {
          await this.pass();
          this.spend(Date.now() - began);
        } catch (e) {
          this.spend(Date.now() - began);
          // A pass that throws must not kill the keeper — the session may simply have
          // gone away underneath it, and the next pass will find out properly.
          this.lastError = e.message;
          this.note('pass failed', { why: e.message });
          await sleep(5000);
        }
        this.passStartedAt = null;
        if (this.stopping) break;
        await sleep(this.policy.decideMs ?? 1000);
      }
    } while (!this.stopping);
    this.running = false;
    this.note('stopped');
  }

  // One decision cycle. Ordered by urgency: being dead, then being in danger, then
  // being hurt, then whatever the mode is for.
  async pass() {
    const s = this.s;
    if (!s.live) { this.note('not in game'); return; }
    const c = s.client;
    // Post where we are, every pass. Cheap, and it is the only way one keeper can find
    // another that has wandered — see runProvision, where a quartermaster arrives to
    // find the supplicant has roamed off and would otherwise abandon the errand.
    if (s.world?.room?.num != null) noteWhere(s.name, s.world.room.num, s.world.room.name);
    // And post what we need and what we can spare, for the same reason: the sell and
    // drop paths read the aggregate, and a stale board sells somebody else's herbs.
    this.declareInterest();
    // POST OUR SITUATION FOR OUR PARTNER, every pass and before any decision that reads
    // theirs. A partner acts on health, room and whether we are behind a wall; all
    // three are read from the register rather than asked for over the wire, so a
    // reading nobody refreshed is a decision made about where we were a minute ago.
    // m59-party treats anything older than 90s as absent for exactly that reason.
    if (this.policy.partner) {
      const pv = c?.vitals?.() ?? {};
      party.report(this.s.name, {
        health: pv.health?.max ? pv.health.value / pv.health.max : null,
        room: s.world?.room?.num ?? null,
        holding: this.hold ? { col: this.hold.col, row: this.hold.row } : null,
        doing: this.doing ?? null,
        needs: this.wantsNow ?? [],
      });
    }
    // Remember the purse while we still can. After a death the inventory is already on
    // the corpse, so the only way to know what was lost is to have looked before.
    if (c?.inventory?.length)
      this.lastSeenPurse = c.inventory
        .filter(o => /shilling/i.test(c.rsc.get(o.nameRsc) || ''))
        .reduce((t, o) => t + (o.amount || 1), 0);

    // FROZEN after a panic logoff. Do nothing that the server counts as an action:
    // no room-contents request, no movement, no turning, no fighting. Rest, read the
    // stats, and wait. Anything else calls NotifyMonstersOfPresence and hands back
    // the one thing this state is for.
    if (this.frozenUntil && Date.now() < this.frozenUntil) {
      this.doing = 'recovering';
      await s.pacer.submit('read', () => c.stats(1));
      await c.waitFor({ kinds: ['stat'], timeoutMs: 1500 });
      await s.pacer.submit('rest', () => c.rest());
      const vv = c.vitals();
      this.note('frozen', { left_s: Math.round((this.frozenUntil - Date.now()) / 1000),
                            health: vv?.health?.value, vigor: vv?.vigor?.value,
                            note: 'recovering vigor; health needs us to move again first' });
      this.progress('playing dead to avoid a death');
      return;
    }
    if (this.frozenUntil) {
      this.frozenUntil = null;
      this.note('unfreezing', { note: 'moving again — monsters can see us from here on' });
    }

    // RESYNC ON A CLOCK, NOT EVERY PASS. See decideMs/resyncMs above: room.objects is
    // maintained by pushes, so between resyncs we are deciding on a live map rather
    // than a stale one, and asking again costs two requests, up to four seconds of
    // waiting, and a NotifyMonstersOfPresence that wakes the room.
    //
    // Resync anyway when we have reason to distrust the cache: right after arriving
    // somewhere, and whenever the last one is older than resyncMs.
    const resyncEvery = this.policy.resyncMs ?? this.policy.idleMs ?? 8000;
    const roomChanged = this.lastResyncRoom !== (s.world?.room?.num ?? null);
    if (roomChanged || !this.lastResyncAt || Date.now() - this.lastResyncAt >= resyncEvery) {
      this.lastResyncAt = Date.now();
      this.lastResyncRoom = s.world?.room?.num ?? null;
      this.resyncs = (this.resyncs || 0) + 1;
      await s.pacer.submit('read', () => c.roomContents());
      await c.waitFor({ kinds: ['room-contents'], timeoutMs: 2500 });
      await s.pacer.submit('read', () => c.stats(1));
      await c.waitFor({ kinds: ['stat'], timeoutMs: 1500 });
    }

    const room = s.world?.room;
    const v = c.vitals();
    const hp = pct(v.health);

    // BEFORE ANY DECISION: do we still know where we are standing, and is it working?
    // Every branch below reads differently depending on the answer — fleeing, resting
    // and logging off all invert inside a working safe spot — so it has to be settled
    // first and from evidence, not from what the geometry hoped.
    this.observe();

    // A SHORT MEMORY, kept only so that a death can be explained.
    //
    // The ledger samples every five minutes, which is far too coarse to catch a
    // death: it reports where the character was up to five minutes BEFORE it died,
    // which is why the last dozen death records all name inns and towns. Nobody died
    // in an inn. They died somewhere else, minutes later, and the sample was stale.
    //
    // The keeper is the only thing running at the resolution a death happens at.
    //
    // Each frame also records WHAT WE WERE DOING, because "health 22, 14, 6" is a
    // description of dying and not an explanation of it. Standing on a wall at 6 health
    // and running for a door at 6 health are the same three numbers and opposite
    // mistakes, and only the second column tells them apart.
    this.recordFrame();

    // DID WE GET TOUGHER? Read before any branch that can return, because most passes
    // end early — in a safe spot, resting, mid-errand — and a gain announced during one
    // of those is still a gain. It is a scan of an in-memory ring against a watermark
    // and sends nothing.
    this.noteToughness();

    // Answer people and take hand-outs before anything else. Cheap, and a player
    // trying to help should not have to wait for a fight to finish.
    await this.social().catch(e => this.note('social failed', { why: e.message }));

    // GIVE BACK ANY SIGNET RING WHOSE OWNER IS STANDING HERE.
    //
    // Each one pays up to ten times its value to a character under 30 max health, and the
    // fleet had been carrying them as loot; Statler had six. The owner is named in the
    // ring's own description, so this costs nothing to ask wherever we happen to be.
    //
    // THIS IS THE FALLBACK NOW, NOT THE WHOLE STRATEGY. I said the owners wander and that
    // an NPC-location table would not help. Four of the nineteen wander; the other fifteen
    // stand in a fixed room in a town — see SIGNET_OWNERS in m59-skills.mjs — so the ring
    // usually names a destination, and `signets` dispatches an errand that goes there. This
    // branch is what catches the four that roam, and what catches a routed ring early if
    // its owner happens to walk past first.
    //
    // Cheap enough to ask every pass ONLY because the answer is cached: a ring's owner
    // never changes, so it is one look per ring ever, and afterwards this is a name
    // comparison against the objects already in the room snapshot. Gated on carrying one
    // at all, which is almost never.
    if ((c.inventory || []).some(o => /signet ring/i.test(c.rsc.get(o.nameRsc) || ''))) {
      const gave = await skills.returnSignetRings(s).catch(() => null);
      if (gave?.returned?.length) {
        this.tally.signets_returned = (this.tally.signets_returned || 0) + gave.returned.length;
        this.progress('returned a signet ring');
        this.note('returned a signet ring', {
          to: gave.returned.map(r => r.to),
          still_carrying: gave.carrying,
          paid: skills.signetPayout({ level: c.vitals()?.health?.max ?? null }),
          why: 'the owner was standing here, and a returned ring pays ten times its value ' +
               'to a character under 30 max health',
        });
      }
    }

    // 0. Do we still know who we are? A `save game` renumbers every object, and a
    //    session that was live across one keeps a selfId the server no longer uses.
    //    Nothing errors. Position reads null, our own object is missing from room
    //    contents, and every check written as "am I still in the room?" concludes we
    //    died — forever, at full health. Re-logging in is the whole fix, because the
    //    id is handed out fresh at login.
    if (!c.self) {
      this.selfMissingPasses++;
      if (this.selfMissingPasses >= 3) {
        this.note('lost our own object id — reconnecting',
                  { passes: this.selfMissingPasses,
                    why: 'not in room contents; usually a save-game renumber' });
        const again = await this.reconnect('recovering a renumbered object id');
        this.selfMissingPasses = 0;
        this.note(again.ok ? 'reconnected' : 'reconnect failed',
                  again.ok ? { object_id: s.client?.selfId } : { why: again.why });
        this.noProgress('reconnecting after losing our object id');
        return;
      }
    } else this.selfMissingPasses = 0;

    // 1. Dead. The Underworld has no graph exits, so a character left there stays
    //    there forever unless something walks it onto a portal.
    if (room && /underworld/i.test(room.name)) {
      this.tally.deaths++;
      this.deathsThisRun = (this.deathsThisRun || 0) + 1;
      // WHAT THE PURSE WAS WORTH WHEN IT HIT THE FLOOR. Recorded from the last frame
      // before the Underworld, because by now the inventory is already gone — and it
      // is the only honest score for whether the banking trips are worth their walk.
      const lastPurse = this.lastSeenPurse ?? 0;
      if (lastPurse > 0) {
        this.money.carried_at_death += lastPurse;
        this.note('died carrying money', { shillings: lastPurse,
          bank_above: this.policy.bankAbove,
          why: lastPurse > (this.policy.bankAbove ?? Infinity)
            ? 'over the banking threshold — the trip did not happen in time'
            : 'under the banking threshold, so this was the float we accept losing' });
      }

      // Reconstruct the death from the short memory, ONCE, on the pass that first
      // finds us here. The last frame that was not the Underworld is where it
      // actually happened, and what was standing there is the best evidence of what
      // did it.
      if (!this.reportedDeath) {
        this.reportedDeath = true;
        // Were we behind a wall when it happened? See lastHold in observe().
        const diedHolding = this.lastHold && Date.now() - this.lastHold.at < 30_000
          ? this.lastHold : null;
        const before = (this.recent5 || []).filter(f => !/underworld/i.test(f.room || ''));
        const at = before[before.length - 1] || null;
        const trail = before.slice(-4).map(f => `${f.health}/${f.max}`).join(' -> ');
        this.lastDeath = {
          at: Date.now(),
          died_in: at?.room ?? null, room_num: at?.num ?? null,
          at_col: at?.col ?? null, at_row: at?.row ?? null,
          level: at?.max ?? null,
          health_trail: trail || null,
          last_health: at?.health ?? null,
          last_vigor: at?.vigor ?? null,
          killed_by: at?.threats?.length ? at.threats : null,
          hunting: this.policy.hunt,
          strategy: this.policy.strategy,
          flee_threshold: this.safety().fleeAt,
          // The two questions worth asking of any death.
          fled_in_time: at && at.max ? (at.health / at.max) : null,
          had_flasks: this.hadFlasks ?? null,
          // WHAT WAS ON THE FLOOR WHEN WE FELL, so something can decide whether the walk
          // back is worth making. Dying drops the whole inventory, and until now nothing
          // recorded what that was — so a recovery errand had to treat every death site
          // as equally promising and walk to all of them. It sent couriers to sites that
          // held nothing, through the two rooms this fleet dies in most, and the trips
          // cost more lives than the drops were worth.
          //
          // Counted from the last inventory the client saw, because the corpse is already
          // gone by the time anything asks. Names kept for the notable kinds only — a
          // weapon or reagent is worth a walk, four mushrooms are not.
          carrying: (() => {
            try {
              const inv = this.s.client?.inventory ?? [];
              const names = inv.map(o => ({ name: this.s.client.rsc.get(o.nameRsc) || '',
                                            amount: o.amount > 0 ? o.amount : 1 }));
              // WHAT IT IS WORTH, NOT HOW MANY THINGS IT WAS. A stack count cannot tell
              // four mushrooms from four swords. viValue_average is declared per item
              // class in the kod — emerald 30, sapphire 60, mace 50, mushroom 10 — so the
              // pile has an actual number and the walk back can be judged against it.
              let value = 0;
              for (const it of names) {
                if (/shilling/i.test(it.name)) { value += it.amount; continue; }
                value += (ITEM_VALUE[String(it.name).toLowerCase()] ?? 0) * it.amount;
              }
              const worth = names.map(x => x.name).filter(n =>
                /mace|sword|axe|hammer|bow|armor|armour|shield|helm|elder|herb|shilling|emerald|sapphire|ruby|diamond|flask/i.test(n));
              return { stacks: inv.length, value, notable: [...new Set(worth)].slice(0, 8) };
            } catch { return null; }
          })(),
          // DID WE DIE SOMEWHERE WE BELIEVED WAS SAFE? The whole safe-spot thesis
          // predicts this should be close to never: a working spot cannot be hit out
          // of unless we swing first, so anything that dies in one is either standing
          // somewhere that does not work, or was killed on the way in or out. Which
          // of those it is matters, and only recording it can tell them apart.
          in_safe_spot: diedHolding ? {
            at: { col: diedHolding.col, row: diedHolding.row },
            proven: diedHolding.proven,
            held_s: Math.round((Date.now() - diedHolding.takenAt) / 1000),
          } : false,
        };
        if (diedHolding) {
          this.tally.deaths_in_safe_spot = (this.tally.deaths_in_safe_spot || 0) + 1;
          if (diedHolding.proven)
            this.tally.deaths_in_proven_safe_spot = (this.tally.deaths_in_proven_safe_spot || 0) + 1;
          // A square that got somebody killed has failed the only test that counts,
          // whatever it had done before.
          this.book.failed(diedHolding.room, {
            col: diedHolding.col, row: diedHolding.row,
            damage: diedHolding.proven ? 99 : 1, attackers: diedHolding.mostAttackers });
          this.book.save();
        }
        // THE FULL RECORD, WRITTEN BEFORE ANYTHING ELSE HAPPENS. Everything below this
        // point — escaping the Underworld, walking back, rejoining — overwrites the
        // evidence: the client's event buffer fills with the Underworld, the frames roll
        // over, and the journal moves on. `lastDeath` is the summary; this is the thing
        // somebody can actually read afterwards.
        //
        // Assembled from `lastDeath` rather than beside it, so the two cannot drift.
        // WAIT FOR THE SERVER TO SAY WHO DID IT.
        //
        // The death is broadcast to the whole world and the broadcast NAMES THE KILLER —
        // the one that struck the final blow, not the crowd (system.kod:49-57). It
        // arrives a moment after we notice we are dead, so the record used to be written
        // just before the single most authoritative fact about the death showed up, and
        // `killed_by` was filled in from whatever happened to be standing next to us.
        //
        // That is a different question and it answers it badly. Against 249 deaths with a
        // matching broadcast, the crowd's most common member was the actual killer 51% of
        // the time — a coin flip, written into the record as a cause of death. It also
        // manufactured a culprit: twelve deaths at the border of the Badlands were blamed
        // on "soldier of the Duke's army" purely for being nearby, when the broadcasts say
        // groundworm and troll, and faction soldiers do not start fights with the
        // unaligned in the first place.
        //
        // A couple of seconds is worth it once per death. If it never comes, the record
        // says so rather than falling back silently.
        const bcast = await this.awaitDeathBroadcast().catch(() => null);
        // WAS ANYTHING DRIVING WHEN THIS HAPPENED? A character whose keeper stopped
        // stands still in whatever fight it was in; attributing that to a hunting
        // decision charges the strategy for an operator restart. Marked, not excluded —
        // it is still a real death, it just should not be read as evidence about how the
        // fleet fights.
        const unattended = uptime.outageAround(this.s.name, Date.now());
        const pm = { ...this.postMortem('died'), summary: this.lastDeath,
                     killed_by_broadcast: bcast,
                     during_keeper_outage: unattended };
        if (bcast) {
          // The authoritative answer wins, and what was nearby is kept beside it — the
          // crowd is still the right answer to "how outnumbered were we".
          this.lastDeath.was_nearby = this.lastDeath.killed_by;
          this.lastDeath.killed_by = bcast.killer ? [bcast.killer] : [];
          this.lastDeath.death_broadcast = bcast.text;
          this.lastDeath.how_died = bcast.how;
        } else {
          this.lastDeath.killed_by_is_a_guess = true;
          this.lastDeath.note_killer = 'no death broadcast arrived within the wait, so ' +
            'killed_by is only what was standing nearby — right about half the time';
        }
        if (unattended) {
          this.lastDeath.unattended = true;
          this.lastDeath.keeper_was_down_for_seconds = Math.round(unattended.ms / 1000);
          this.lastDeath.note_unattended = 'nothing was driving this character when it died — ' +
            'do not read this as evidence about the hunting strategy';
        }
        const file = this.writePostMortem(pm);
        this.lastDeath.post_mortem = file;
        this.lastPostMortem = pm;
        // ON THE FEED TOO, beside the kills, and only now — after the broadcast has had
        // its couple of seconds. Recording it any earlier would put the 51%-accurate
        // guess on the live feed while the authoritative answer arrived a moment later
        // and went only into the file.
        tougher.recordDeath(this.who(), {
          at: this.lastDeath.at, killer: this.lastDeath.killed_by?.[0] ?? null,
          observed: !!bcast?.killer,
          room: this.lastDeath.died_in, room_num: this.lastDeath.room_num,
          level: this.lastDeath.level, in_safe_spot: !!diedHolding,
        });
        this.note('DIED', { ...this.lastDeath, ...(file ? { post_mortem: file } : {}) });
      }
      this.note('woke up dead', { room: room.name, attempt: (this.underworldTries || 0) + 1 });
      // A tell costs nothing and we have no mana for anything else.
      await this.answerWhere().catch(() => {});

      // NEVER SIT HERE. The Underworld has no exits in the room graph — only
      // portals you walk onto — so a character left in it stays in it until
      // something acts. One failed attempt is not a reason to stop trying: one or
      // two of the five fixed portals are unlit at random and the sixth changes
      // destination every few seconds, so trying again IS the strategy.
      this.underworldTries = (this.underworldTries || 0) + 1;
      // COME OUT NEAR THE CORPSE. Everything the character was carrying is on the floor
      // where it died, and the walk back is the real cost of dying — a keeper that comes
      // out at the far end of the world has turned a recoverable death into an
      // unrecoverable one. The room is in the post-mortem we just wrote, which is
      // deliberately taken before the Underworld overwrites the frames.
      const diedIn = this.lastPostMortem?.where?.num ?? null;
      const e = await skills.escapeUnderworld(s, { maxSeconds: 120, nearestTo: diedIn });
      if (e.left) {
        this.reportedDeath = false;
        this.tally.rooms_moved++;
        this.underworldTries = 0;
        this.needsRecovery = true;      // we lost everything we were carrying
        // AND DO NOT GO BACK OUT UNTIL WHOLE. A character comes out of the Underworld
        // at a fraction of its health, with mana and vigor to match, and the ordinary
        // rest threshold lets it leave again long before any of that is back — which is
        // how Scooter died twice inside forty minutes, the second time at 5 health with
        // no weapon, having been sent straight back to the room that killed it.
        //
        // This is a separate flag from needsRecovery because that one is a one-shot: it
        // fires askForHelp once and clears on the same pass. Recovery is a STATE, and it
        // has to outlive the pass that noticed it. Cleared in recovered() once health,
        // mana and vigor are all back as far as their own mechanisms can carry them.
        this.recoverUntilWhole = true;
        // When the clock started, so recovered() can give up on it. Stamped here rather
        // than on the first resting pass: the walk to an inn is part of the recovery and
        // a character that spends ten minutes failing to find one has not been recovering
        // slowly, it has been stuck, and that is what the deadline is for.
        this.recoverSince = Date.now();
        this.progress('escaped the underworld');
        this.note('escaped the underworld', {
          to: e.arrived_in, via: e.via, city: e.city ?? null,
          ...(e.wanted ? { wanted: e.wanted, got_it: e.got_what_was_wanted !== false } : {}),
          ...(diedIn != null ? { died_in_room: diedIn, hops_from_death: e.hops_from_death ?? null } : {}),
        });
      } else {
        this.noProgress('stuck in the Underworld: ' + (e.reason || 'no portal took us'));
        this.note('could not escape — will keep trying', { why: e.reason, tried: e.tried });
      }
      return;
    }

    // ============================ INERT STOPS HERE ============================
    //
    // Everything above this line is looking: where we are, what we need, what our partner
    // should know, the observation, the frame, and — if it came to it — the death record
    // and the walk out of the Underworld. Everything below is DOING, and while something
    // else is driving this character we must not.
    //
    // Placed here rather than at the top of the pass because that is the whole point of
    // the state. A keeper stopped for an errand went blind, and the deaths that happened
    // in those windows are the ones nothing can explain afterwards.
    if (this.inert) {
      // The deadline. An errand that crashed between the hold and the restore would
      // otherwise leave a character watching itself until the next broker restart.
      if (Date.now() - this.inert.at > this.inert.maxMs) {
        const held = Math.round((Date.now() - this.inert.at) / 1000);
        const why = this.inert.why;
        this.revive('nobody came back for it');
        this.note('reviving myself — nobody came back', {
          was_inert_for_s: held, was_held_for: why,
          why: 'whatever took the controls has not given them back inside the deadline, and ' +
               'an unattended character is worse than a contested one. If that errand is ' +
               'still running it will now report being fought for control, which is the ' +
               'symptom worth seeing' });
        // Fall through and act on this pass: the character has been standing still long
        // enough already.
      } else {
        // NOT A STALL. The supervisor restarts keepers that report no progress, and an
        // inert keeper is doing exactly what it was asked to do.
        this.progress('inert — something else is driving');
        return;
      }
    }

    // Just came back from the dead. Everything carried dropped where we fell, so
    // the character is unarmed and unarmoured and cannot fight anything. A human
    // in this position rests somewhere safe and asks for help, which is a real and
    // surprisingly effective move in a populated world — so do that rather than
    // walk a naked character back into a monster room.
    if (this.needsRecovery) {
      this.needsRecovery = false;
      await this.askForHelp();
      return;
    }

    // AND THEN SIT DOWN SOMEWHERE SAFE UNTIL WHOLE. THIS IS THE POINT OF THE FLAG.
    //
    // recoverUntilWhole was already set here and already refused fights and raised the
    // resting bar — but nothing ever put the character in a chair. It relied on the
    // ordinary rest branch further down, and that branch is satisfied by health and
    // vigor, so a character at full health, 80 vigor and ten mana was "not hurt", never
    // rested, and dropped through to the farm branch, which walked it out of the inn.
    // Zoot, Rizzo and Animal each did exactly that within the last half hour.
    //
    // So make it explicit and put it AHEAD of everything else: while recovering, the job
    // is to be somewhere nothing spawns, sitting in a corner, until health, mana and
    // vigor are all back — and then to be holding a weapon before anything else happens.
    // hibernate() waits on all three now; recovered() clears the flag and has its own
    // deadline, so this cannot become a character parked for ever.
    if (this.recoverUntilWhole && !this.recovered()) {
      if (this.sanctuary()) {
        await this.hibernate('recovering after a death — health, mana and vigor')
                  .catch(() => false);
        // Everything we owned is on the floor where we died, so this is usually a
        // conjure, and the conjure is why the mana in hibernate's bar is there.
        if (!this.armedForSure()) await this.armSelf().catch(() => false);
        this.progress('recovering after a death');
        return;
      }
      // Not somewhere safe yet. Walk to the nearest room that spawns nothing rather than
      // recovering where we stand — resting in the open is how a rest becomes a death,
      // and that is doubly true for a character that has just lost its weapon.
      const safe = this.nearestSanctuary({ maxHops: 3 });
      if (safe) {
        this.doing = 'travelling';
        this.note('going somewhere safe to recover', {
          to_room: safe.room, hops: safe.hops,
          health: v?.health?.pct ?? null, mana: v?.mana?.pct ?? null, vigor: vigorOf(v),
          why: 'just came back from the dead with nothing on us. Resting in a room that ' +
               'spawns is the thing that turns a recovery into the next death' });
        const t = await this.travel(safe.room, { maxHops: 6 })
                        .catch(e => ({ arrived: false, reason: e.message }));
        if (t.arrived) { this.progress('reached somewhere safe to recover'); return; }
        this.note('could not reach somewhere safe', { to_room: safe.room, why: t.reason });
      }
      // No sanctuary in reach. Fall through — the danger and rest branches below are the
      // right handlers for "hurt in a bad room with nowhere to go", and holding the
      // character here would only add a way to do nothing.
    }

    // NO WEAPON: FIX IT BEFORE ANYTHING ELSE, and never walk out to hunt without one.
    //
    // armSelf() already wields from the pack and falls back to conjuring, and makeWeapon
    // already exists — but nothing was GATING on the result, so a character whose weapon
    // shattered simply carried on hunting bare-handed. Scooter did it three times today,
    // Rowlf, Gonzo and Animal once each. An empty hand still swings and still reports
    // fighting, so it never reads as broken from outside.
    //
    // Ahead of the danger and rest branches on purpose: being unarmed is WHY the fight
    // is going badly, and the shortest way out is to be holding something.
    if (!this.armed()) {
      const ok = await this.armSelf().catch(() => false);
      if (ok && this.armed()) { this.progress('armed itself'); return; }
      // makeWeapon refreshes the spell list before reporting failure when mana is
      // sufficient. If Create Weapon is absent, sitting for 15 mana can never change
      // the result. Stop cleanly in sanctuary so an external controller can provision
      // a real weapon instead of advertising a false mana-recovery loop forever.
      if (!this.knowsCreateWeapon() && this.sanctuary()) {
        await s.pacer.submit('read', () => c.requestSpells()).catch(() => {});
        await sleep(400);
      }
      if (!this.knowsCreateWeapon() && this.sanctuary()) {
        const why = 'unarmed and does not know create weapon — external weapon acquisition required';
        this.noProgress(why);
        this.note('cannot self-arm', {
          why,
          mana: c.vitals?.()?.mana?.value ?? null,
          action_needed: 'buy, recover, or receive a weapon before restarting combat',
        });
        this.stop(why);
        return;
      }
      // Not enough mana to conjure one yet. SIT DOWN — and do not let settle() decide
      // whether that happens.
      //
      // Rowlf spent twenty minutes and 1078 passes stuck on exactly this. settle()
      // answered "nowhere clear to rest here" three times and gave up, so the character
      // stayed on its feet, where mana regenerates slowly enough that it climbed 1 to 14
      // in twenty minutes — and needed 15. It then failed the roll (half cost) and began
      // the climb again. settle() is choosing a good square with elbow room, which is
      // the right question when picking a spot to fight from and the wrong one here:
      // sitting anywhere in a room nothing spawns in beats standing in the best square
      // of one.
      this.doing = 'recovering';
      // AN UNARMED CHARACTER IN A SPAWN ROOM CANNOT WAIT WHERE IT IS STANDING.
      //
      // Everything below sits down and waits for the 15 mana, which is right — but the
      // sit-anywhere fallback is gated on sanctuary(), so a character stuck in a room
      // that generates monsters got neither: settle() refuses because there is no clear
      // floor, the fallback declines because the room spawns, and the pass ends with it
      // still standing there. Mana regenerates barely at all on its feet while something
      // is hitting it, so it never reaches 15 and never conjures.
      //
      // That is the state the whole fleet reached: Kermit at 12 mana, Rizzo at 12, Animal
      // at 4, all three "hunting fungus beast" bare-handed in the Valley, with no spare
      // weapon anywhere, no shillings, and nothing able to sell them one. Four routes to a
      // weapon and all four shut.
      //
      // So walk out first. townTripIfCornered already knows how to find the nearest room
      // nothing huntable spawns in and hibernate there, which is exactly the errand — a
      // character with nothing in its hands has no business in a monster room, and the
      // walk is the cheapest of the four routes because it needs no money, no donor and
      // no meeting.
      if (!this.sanctuary()) {
        const went = await this.townTripIfCornered().catch(() => false);
        this.note('unarmed and in a room that spawns — leaving to regain mana', {
          mana: this.s.client?.vitals?.()?.mana?.value ?? null,
          needs: 15, went_to_town: !!went,
          why: 'create weapon needs 15 mana and mana barely moves while standing in a ' +
               'fight. Sitting somewhere nothing spawns is the only way this character ' +
               'gets armed again when it has no weapon, no money and no donor' });
        if (went) return;
      }
      // settle() returns {settled}, not a boolean — reading it as one would make this
      // fallback dead code, which is exactly the kind of silent no-op this branch exists
      // to stop happening.
      const sat = await this.settle('no weapon, resting for the mana to make one')
                            .catch(() => ({ settled: false }));
      if (!sat?.settled && this.sanctuary()) {
        // SIT ONCE AND THEN LEAVE IT ALONE.
        //
        // The pass is about a second long, so the first version of this re-sent REST
        // every second. Rowlf spent hundreds of passes "sitting down anywhere to regain
        // mana" while its mana crawled from 2 to 4, and wrote the same journal line
        // hundreds of times, which buries everything else.
        //
        // WHAT A REST ACTUALLY NEEDS is PFLAG_MOVED_SINCE_ENTRY — set by having moved
        // since arriving in the room. A character that walked in and stopped regenerates
        // nothing however long it sits, which is why settle() walks to its square rather
        // than resting where it lands. Re-sending REST every second is noise rather than
        // harm; the reason to stop doing it is that it hides whether the rest is working
        // at all, which is the question that matters and is checked below.
        //
        // So sit when we are not already sitting, and say so once. Standing up for any
        // reason clears the flag, because the next thing to do is sit again.
        const now = Date.now();
        if (!this.sittingFor || now - this.sittingFor > 60_000) {
          await s.pacer.submit('rest', () => c.rest()).catch(() => {});
          this.sittingFor = now;
          // Baseline, so the next pass can answer the only question that matters about a
          // rest: is it paying? See restWatch below.
          this.restWatch = { at: now, mana: c.vitals?.()?.mana?.value ?? null };
          this.note('sitting down anywhere to regain mana', {
            mana: c.vitals?.()?.mana?.value ?? null, needs: 15,
            why: 'settle() found nowhere it liked, and standing regenerates mana far too ' +
                 'slowly to ever reach the 15 this needs — sitting is what matters, not where',
          });
        }
        // CHECK THAT THE REST IS ACTUALLY PAYING, rather than assuming it.
        //
        // Resting is only awarded while PFLAG_MOVED_SINCE_ENTRY is set — a character that
        // walked into a room and stopped regenerates nothing, however long it sits, and
        // nothing in its own journal would ever say so. "Sitting down to regain mana" is
        // a report of an INTENTION; the number moving is the report of an effect, and the
        // two came apart for twenty-nine consecutive rest attempts once already.
        //
        // So take a reading a few seconds after sitting and compare. If it has not moved,
        // say that plainly — the cure is to move and sit again, which is what standing up
        // and re-entering this branch does.
        if (this.restWatch && now - this.restWatch.at > 8_000) {
          const manaNow = c.vitals?.()?.mana?.value ?? null;
          const gained = manaNow != null && this.restWatch.mana != null
            ? manaNow - this.restWatch.mana : null;
          if (gained !== null && gained <= 0 && !this.restNotPayingAt) {
            this.restNotPayingAt = now;
            this.note('resting is not restoring anything', {
              mana: manaNow, was: this.restWatch.mana,
              seconds: Math.round((now - this.restWatch.at) / 1000),
              why: 'a rest only pays while PFLAG_MOVED_SINCE_ENTRY is set, which having ' +
                   'moved since arriving is what sets. Sitting where we landed without ' +
                   'having walked buys nothing and looks identical to resting',
              doing: 'standing and re-seating so the flag is set again' });
            this.sittingFor = null;          // let the next pass sit again, after a step
            // skills.nudge(s), NOT c.nudge() — nudge is a skill helper and the client has
            // no such method, so `c.nudge?.()` would have been an optional call on
            // undefined: silent, inert, and indistinguishable from working.
            await skills.nudge(s).catch(() => {});
          } else if (gained > 0) {
            this.restNotPayingAt = null;     // it is paying; stop watching this window
          }
          this.restWatch = { at: now, mana: manaNow };
        }
      }
      this.noProgress(`unarmed — ${c.vitals?.()?.mana?.value ?? 0} mana, needs 15 to make one`);
      return;
    }

    // 2. In danger. "Something attackable is adjacent and we are hurt" is the only
    //    threat signal available — the protocol does not say who is targeting us.
    //
    //    OTHER PLAYERS ARE NOT THREATS, and leaving them in this list is not a
    //    conservative choice, it is a catastrophic one. Every character is ATTACKABLE,
    //    so a friendly bot standing next to you is indistinguishable from a monster
    //    here — and they do not merely stand next to each other, they stack on the
    //    identical square, because they all walk to the same inn by the same route.
    //    Isolde sat at 4 of 25 health in the Limping Toad with Aurelia, Malig and
    //    Yorick all on square (8,15) beside her, concluded she was about to be killed
    //    by three of her own fleet, and panic-logged-off in a loop that could never
    //    end: freezing is what stops health coming back, so she woke at 4 health,
    //    counted the same three, and froze again. Thirty passes, no healing, no
    //    stall reported, nothing wrong with any single decision.
    //
    //    The trade is real and worth stating: a genuinely hostile player will now not
    //    register here. That costs us a fight we were losing anyway; the other way
    //    round costs a character that never recovers.
    const me = c.self;
    const near = me ? [...c.room.objects.values()].filter(o =>
      o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER) &&
      Math.hypot(o.col - me.col, o.row - me.row) <= 2) : [];
    // EVERYTHING IN THE ROOM THAT CAN SWING, not just what is adjacent right now.
    // `near` looks two squares out, which is the right question for "am I in a fight"
    // and the WRONG one for "is this a place to sit down": a room with four monsters
    // in it and none of them currently beside us read as safe to rest in, and the
    // first one to wander over got a free run at a character sitting still and not
    // looking. Most of this fleet's deaths were logged as happening while resting.
    const hostiles = [...c.room.objects.values()].filter(o =>
      o.id !== c.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER));

    // ABOUT TO DIE. Below two hits of margin with something adjacent, withdrawing is
    // a gamble — the walk takes seconds during which it keeps swinging, and losing
    // that gamble costs a point of maximum health for ever. Logging off costs a
    // minute and cannot fail.
    //
    // UNLESS WE ARE IN A SPOT THAT WORKS, in which case none of that applies: we are
    // not about to die at all, we are merely hurt somewhere nothing can reach us. The
    // correct move is to stop swinging and sit down, which the rest branch below
    // does. Note the test is holdWorks() and not "we are standing in a corner" —
    // spending this on an unproven square is exactly the mistake it exists to
    // prevent, and an unproven square gets us the logoff, which is also how we
    // survive long enough to prove it.
    const worstHit = Math.min(30, Math.floor(((v.health?.max ?? 0) + 2) / 3));
    const sheltered = this.holdWorks();
    // THE TRIGGER IS DIFFERENT BEHIND A WALL, and it has to be, because the cost of a
    // false alarm is not zero. Two of the biggest hit the game can land works out at
    // about 70% of health for these characters — sensible in the open, absurd in a
    // spot, where the things that could hit us are on squares they cannot reach us
    // from and we choose which one we swing at. Cedric logged off three times in five
    // minutes at 71%, and each of those minutes was a minute of not healing and not
    // killing anything. Below a third of health it is still worth it.
    const doomedAt = this.hold
      ? Math.round((v.health?.max ?? 0) * (this.policy.doomedInSpotBelow ?? 0.35))
      : worstHit * 2;
    const doomed = hp !== null && near.length && v.health?.value != null &&
                   v.health.value <= doomedAt;
    // PLAY DEAD ONLY WHERE STANDING STILL IS ALREADY SAFE. FLEE EVERYWHERE ELSE.
    //
    // This was gated on `!sheltered` — it froze precisely when the character was NOT
    // behind a wall, which is the case where freezing helps least and costs most. A
    // freeze keeps the monsters off by not acting, and the same flag keeps HealthTimer
    // off with it, so the character comes back with the same health it went down with,
    // still standing in the open, still surrounded. That is why playDead needs its own
    // "refusing to freeze again — it is not helping" guard: the tactic was being used in
    // the one place it cannot work.
    //
    // In a safe spot it is a different move entirely. Nothing can reach the square, so
    // the character can turn in place — which sets PFLAG_MOVED_SINCE_ENTRY without giving
    // up the square — and heal back to full while the room mills about outside its reach.
    //
    // Out in the open with something adjacent, there is no version of standing still that
    // ends well. The only thing that changes the situation is distance: run for the
    // nearest town, become combat-ready, come back. townTripIfCornered already knows how
    // to find it.
    if (doomed && this.policy.panicLogoff !== false) {
      if (sheltered) {
        if (await this.playDead('at ' + v.health.value + ' health with ' + near.length +
                                ' adjacent, behind a wall that holds')) return;
      } else {
        this.note('hurt in the open — running for a town rather than playing dead', {
          health: v.health.value, adjacent: near.length, worst_single_hit: worstHit,
          why: 'a freeze recovers no health and leaves us exactly where we were, in reach ' +
               'of everything that put us here. Only distance changes this fight' });
        this.doing = 'travelling';
        if (await this.townTripIfCornered().catch(() => false)) return;
        // Could not reach one. Fall through to the withdraw/rest branches below rather
        // than freezing, which is the thing we just decided does not work here.
      }
    }

    // WITHDRAWING IS FOR THE OPEN FLOOR. Walking away is the only thing a plain
    // character can do about a fight it is losing — out in the open. In a working
    // safe spot it is the single worst available move: it costs the wall, hands every
    // camped monster its attacks back, and spends several seconds being hit to reach
    // a square that is no safer than the one it left. Staying put and not swinging
    // stops the damage immediately and for free.
    if (hp !== null && hp < this.policy.fleeBelow && near.length && !sheltered) {
      this.tally.withdrawals++;
      // ALL THE WAY, NOT FOUR SQUARES. This called withdraw(), a move to a wall a few
      // squares off, and the town trip above only engages after THREE flees in a row
      // (townTripIfCornered) — so the first two flees from a losing fight in the open
      // were a shuffle that nothing was fooled by. Monster vision is 4 + difficulty/2
      // (monster.kod:1676): four squares is inside every creature in the game.
      this.note('running for safety', {
        health: Math.round(hp * 100) + '%', from: near.map(o => c.rsc.get(o.nameRsc)),
        why: 'below the flee threshold in the open — distance is the only thing that ' +
             'stops this, and a wall four squares away is not distance' });
      await this.retreatToSafety({
        because: 'below the flee threshold in the open',
        from: near.map(o => c.rsc.get(o.nameRsc)),
      });
      return;
    }
    if (hp !== null && hp < this.policy.fleeBelow && near.length && sheltered) {
      this.tally.mulligans = (this.tally.mulligans || 0) + 1;
      this.note('breaking off without moving', {
        health: Math.round(hp * 100) + '%', crowd: near.length,
        where: { col: this.hold.col, row: this.hold.row },
        why: 'we are in a spot that has held under attack, so nothing can hit us unless we ' +
             'swing first. Stopping is the whole withdrawal.',
        next: 'rest to full here, then take the fight again from the top or leave on our own terms' });
    }

    // SIT DOWN PROPERLY THE MOMENT WE ARRIVE SOMEWHERE SAFE.
    //
    // Not when the resting eventually starts — on entry. The walk to a clear patch of
    // floor is what sets PFLAG_MOVED_SINCE_ENTRY, and until it is set the character
    // recovers no health at all no matter how long it sits there. A bot that walks
    // into an inn and stops is not resting, it is waiting, and nothing in its own
    // journal will ever say so.
    //
    // It also un-stacks the pile. They all arrive on the same square by the same
    // route, and since every character is attackable, a heap of friendly bots is
    // indistinguishable from a mob to every bot in it.
    if (this.sanctuary(room) && this.settledIn !== room?.num &&
        ((hp !== null && hp < 0.95) || (vigorPct(v) ?? 1) < REST_VIGOR_CAP))
      await this.settle('arrived somewhere safe and not at full strength').catch(() => {});
    // Leaving a room means the next safe one gets its own seat, and its own attempts.
    if (this.settledIn != null && room?.num !== this.settledIn && !this.sanctuary(room)) {
      this.settledIn = null;
      this.settleTries = 0;
    }

    // 3. Hurt but safe. Resting next to something hostile just feeds it — out in the
    //    open. In a proven safe spot "next to something hostile" is not a danger at
    //    all, and refusing to rest there is refusing the single largest advantage the
    //    game offers: a free heal to full, in the middle of a monster room, with
    //    three things standing next to us that cannot do anything about it.
    //
    //    THIS IS THE MULLIGAN. A fight going badly stops being a death and becomes a
    //    draw we can re-take at full health.
    const vig = vigorPct(v);
    // Sheltered, rest at whatever it takes to be fit to fight — never leave a gap
    // between "too hurt to start" and "hurt enough to rest", because a character
    // standing at a wall in that gap does neither and simply stops. engageAt is in
    // here for exactly that reason.
    // NEVER LEAVE A GAP BETWEEN "TOO HURT TO START" AND "HURT ENOUGH TO REST".
    //
    // This was applied to the sheltered case and not to the ordinary one, and the
    // ordinary one is where the whole fleet lives. restBelow is 0.6; engageAt is 0.9
    // for anything under thirty max health. A character at 64% is therefore too hurt
    // to pick a fight and not hurt enough to sit down, so it does NEITHER — and the
    // branch that declines the fight calls progress(), so it does not even register
    // as stalled. Cedric held that state at the Tos gate with full vigor, a wall
    // available and centipedes wandering past, reporting a healthy-looking journal
    // line every eight seconds.
    //
    // The fix is to say it once: whatever health it takes to be willing to fight is
    // the health worth resting to. Anything less is a keeper that waits for a number
    // nothing will ever move.
    // AFTER A DEATH, REST TO WHOLE BEFORE ANYTHING ELSE.
    //
    // recoverUntilWhole is set when we come out of the Underworld and stays set until
    // recovered() says otherwise. While it is set this does two things, and it needs
    // both: it refuses to fight, and it raises the resting bar to full. Raising the bar
    // alone would leave the character willing to take a fight it stumbled into on the
    // way to sit down; refusing to fight alone would leave it standing around at 11%
    // health because the ordinary restBelow of 0.7 was already satisfied.
    const recovering = !!this.recoverUntilWhole && !this.recovered();
    // AN EMPTY HAND IS NOT A FIGHT, IT IS A BEATING.
    //
    // The keeper sent unarmed characters out to hunt over and over: Scooter three times,
    // Rowlf, Gonzo, Animal. An unarmed character still swings, still reports fighting,
    // and punches for almost nothing while everything hits back — so nothing about it
    // reads as broken from outside, and the only reason it was ever caught is that a
    // human looked at the board.
    //
    // Weapons break constantly here and the pack usually has no spare, so this is not an
    // edge case. It is the steady state after a few hours. The answer is not to hunt
    // anyway: it is to stop, make one, and go back out — which costs a couple of minutes
    // and 15 mana, against a character that otherwise farms nothing until someone
    // notices. See armed() for why the server's own use list is the only acceptable
    // evidence here.
    const unarmed = !this.armed();
    const wantsToFight = this.mode === 'farm' && !!this.policy.hunt && !recovering && !unarmed;
    const restAt = Math.max(
      this.policy.restBelow,
      sheltered ? this.policy.holdResumeAbove : 0,
      recovering ? 1 : 0,
      wantsToFight ? this.safety().engageAt : 0);
    // NEVER SIT DOWN FOR SOMETHING SITTING DOWN CANNOT FIX.
    //
    // restBelow is one threshold used for two vitals that recover by different means.
    // Resting restores vigor only as far as RestTimer's threshold — 80 of 200, which is
    // REST_VIGOR_CAP — and everything above that has to be eaten. Comparing vigor
    // against restBelow (0.6, i.e. 120) therefore asks for a level resting can never
    // reach, so the character was still "hurt" when it stood up and went straight back
    // down on the next pass. Hungry characters spent entire sessions in that loop.
    // For vigor the trigger is what resting can actually deliver; the shortfall above
    // it is a food problem, and eat()/loot runs are what answer it.
    const vigorRestAt = Math.min(this.policy.restBelow, REST_VIGOR_CAP);
    const hurt = (hp !== null && hp < restAt) || (vig !== null && vig < vigorRestAt);

    // RUN THE EXPERIMENT ON PURPOSE. A spot is only proved by standing in it without
    // swinging while something tries to kill us — and every other branch here is
    // gated on already having that proof, so without this the keeper can fight from
    // an untested corner forever and never find out whether it works.
    //
    // The window it needs is the same window resting needs, so testing costs nothing
    // beyond the pause. Bounded twice, because being wrong here means sitting still
    // while something eats us: only while we still have flee margin in hand, and for
    // one pass at a time, so observe() gets to adjudicate quickly either way.
    const testing = !sheltered && !!this.hold && !this.hold.failures &&
                    hp !== null && hp >= this.policy.fleeBelow;
    // RESTING IN A COMBAT ZONE IS SOMETHING YOU DO BEHIND A WALL OR NOT AT ALL.
    // Sheltered means the square is proven; testing means we are deliberately proving
    // it with margin in hand. Anything else, with anything hostile in the room, and the
    // answer is to go and get a wall first — not to sit down and find out.
    const combatZone = hostiles.length > 0;
    // Go and get a wall — but DO NOT CONSUME THE PASS DOING IT. The first version
    // returned as soon as takeSafeSpot() succeeded, and that deadlocked characters
    // outright: holding a square is not the same as the square being PROVEN, so
    // `sheltered` stayed false, the branch fired again next pass, and a character at
    // 100% health spent sixty consecutive passes taking a wall and doing nothing else.
    // It was `hurt` on VIGOR, not health, which is the state a keeper is in most of the
    // time. Take the spot as a side effect and let the pass carry on — the rest gate
    // below already refuses to rest in the open, which was the actual requirement.
    // AN EMPTY SPAWN ROOM IS NOT AN EMPTY ROOM — IT IS A ROOM BETWEEN SPAWNS.
    //
    // This asked for a wall only when something hostile was ALREADY standing there, so a
    // character that sat down during the gap between spawns rested in the open with
    // nothing to fetch it a wall. That is how Waldorf died, and its own journal reads the
    // sequence out: "hit while resting in the open — there was no wall at our back; this
    // is the case the safe spot exists for", then a reconnect to shed aggro, then "could
    // not reach the safe spot", then dead. The resting came first and the damage second.
    //
    // Across characters at or below the resting cap, resting ran 529 deaths per thousand
    // observations against 7.5 for holding a proven safe spot — the same act of sitting
    // still, differing only in whether a wall was at their back.
    //
    // sanctuary() is the existing test for "nothing huntable spawns here". This only
    // widens WHEN A WALL IS FETCHED; the rest gate below is untouched, so nothing that
    // could rest before is forbidden from resting now — it just sits down behind
    // something first.
    const spawnsHere = !this.sanctuary();
    if (hurt && (combatZone || spawnsHere) && !sheltered && !testing && this.policy.useSafeSpots && !this.hold
        && (!this.wallTriedAt || Date.now() - this.wallTriedAt > 30_000)) {
      this.wallTriedAt = Date.now();
      const got = await this.takeSafeSpot(
        'hurt in a room that spawns monsters — a wall before a rest', near[0] ?? hostiles[0] ?? null)
        .catch(() => false);
      this.note('will not rest in the open here', {
        health: hp === null ? null : Math.round(hp * 100) + '%',
        monsters_in_room: hostiles.length, adjacent: near.length, got_a_wall: !!got,
        room_spawns: spawnsHere, nothing_visible_yet: hostiles.length === 0 || undefined,
        why: 'resting is sitting still and not looking. Doing it where something can reach us is ' +
             'how a rest becomes a death, and an empty room that spawns is a room between spawns' });
    }
    // VIGOR TO SPARE MEANS WALK, DO NOT WAIT.
    //
    // The deadlock this closes: hurt, something hostile somewhere in the room, no wall
    // to be had. The branch above tries for a wall once every thirty seconds; the rest
    // gate below refuses to sit down in a combat zone; and the fight path refuses to
    // engage while too hurt. So the character does nothing at all — not resting, not
    // fighting, not leaving — and it does not even register as a stall, because each
    // individual refusal is correct.
    //
    // Piggy sat in it at 12 of 27 health with FULL VIGOR, nothing in swing range and
    // zero landing damage, in the room where the fleet has been dying. At 200 vigor she
    // would have healed to full in fifteen seconds anywhere safe.
    //
    // 80 is the line because 80 is what RESTING alone can reach — the rest threshold.
    // Below it, standing still is at least buying back the vigor that walking spends.
    // Above it, waiting buys nothing at all: the vigor is already there, it is only in
    // the wrong place, and moving is the only thing that converts it into health.
    //
    // withdraw() retreats to a WALL now rather than to open floor, so this is a move
    // toward somewhere it can actually heal, not merely away from here.
    // REST_VIGOR_CAP is a FRACTION (0.4), not a vigor value — it is passed to
    // restUntil, which takes fractions. Comparing a raw vigor of 200 against 0.4 is
    // true for every character that has any vigor at all, which would have fired this
    // branch at 5 vigor: the precise opposite of the rule, and it would have sent
    // exhausted characters walking instead of resting.
    const vigorNow2 = vigorOf(v);
    const restCeiling = REST_VIGOR_CAP * skills.VIGOR_MAX;      // 0.4 * 200 = 80
    if (hurt && combatZone && !sheltered && !testing && !this.hold &&
        vigorNow2 != null && vigorNow2 > restCeiling) {
      this.note('not waiting this out — moving to somewhere I can heal', {
        health: hp === null ? null : Math.round(hp * 100) + '%',
        vigor: vigorNow2, rest_ceiling: restCeiling,
        monsters_in_room: hostiles.length, in_swing_range: near.length,
        why: 'hurt, no wall here, and too much vigor for waiting to be worth anything — resting ' +
             'cannot raise vigor past ' + restCeiling + ' and we are already above it, so the ' +
             'only thing standing still produces is time spent hurt in a monster room' });
      // "Somewhere I can heal" is an inn, not a wall in the same monster room. The
      // wall version left us inside the vision of everything that was already hitting
      // us, healing at a rate that damage cancelled out.
      await this.retreatToSafety({
        because: 'hurt, no wall here, and too much vigor for waiting to be worth anything',
        vigor: vigorNow2, monsters_in_room: hostiles.length,
      });
      this.progress('moved toward somewhere I can heal');
      return;
    }

    // AND BELOW THE RESTING CEILING: GET OFF THE MAP ENTIRELY.
    //
    // The other half of the same deadlock, and the worse one. Hurt, something hostile
    // in the room, no wall — and now too little vigor to want a fight or to make a
    // long walk pay. The branch above does not fire, the rest gate refuses (combat
    // zone), the fight path refuses (too hurt). Sweetums sat in it for 670 passes,
    // roughly three hours, and Piggy before her. Every individual refusal is correct
    // and the sum of them is a character quietly doing nothing until it dies.
    //
    // Resting here is not an option — that is the one thing that turns this into a
    // death — so the answer is to stop being here at all: LEAVE THE ROOM by the
    // nearest exit. Out of the room the hostiles are not, and resting becomes legal.
    //
    // Then fix the actual cause, which is an empty larder: cook if we can, and
    // otherwise declare the want so the fleet's supply machinery can answer it. A
    // character at this vigor with no food is not in a fight it can win; it is in a
    // supply problem wearing a fight's clothes.
    // LOW VIGOR IS NOT A REASON TO RUN AWAY. LOW HEALTH IS.
    //
    // `hurt` is true when EITHER health or vigor is short, which is right for deciding to
    // rest and badly wrong for deciding to abandon a room. Vigor does not fall because
    // there is a monster nearby; health does. So a character at full health and the
    // vigor cap read as "hurt", found something hostile, and left — then did it again in
    // the next room, for ever.
    //
    // Measured: of 107 room-flees, ALL 107 were by characters below 180 vigor and NONE
    // by a well-fed one, and every single fleeing character had zero kills. Robin fled
    // 54 times at 29 of 29 health and killed nothing. Fixing the escape so it actually
    // works converted "die where you stand" into "run for ever", which is better and
    // still not farming.
    //
    // The deadlock this branch exists to break is real — too hurt to fight, unable to
    // rest because something is watching — but it is a HEALTH deadlock. At full health
    // there is no deadlock: a tired character fights worse, not not-at-all, and the
    // answer to low vigor is food, which is somewhere else entirely.
    // The one case where low vigor SHOULD still send us away: when this character refuses
    // to fight below a vigor floor. Then it genuinely cannot act here — cannot fight,
    // cannot rest in a combat zone — and leaving is the only move left. That is the
    // deadlock the branch was written for, kept intact. Most of the fleet runs
    // fightAboveVigor at 0 and will simply fight on, tired, which is the point.
    const healthHurt = hp !== null && hp < restAt;
    // A FLOOR YOU CAN NEVER REACH IS NOT A FLOOR, IT IS A STOP.
    //
    // fightAboveVigor is 180 on graduated pairs, and vigor only passes 80 by EATING.
    // A character with no food is therefore permanently below its own floor: it refuses
    // every fight, flees every room, earns nothing, and so never buys the food that
    // would raise the vigor. Animal ran that loop 150 times for zero kills, at full
    // health the whole way.
    //
    // So the floor only applies while it is achievable. With an empty larder, the honest
    // ceiling is what resting can deliver, and a tired character fighting badly beats a
    // rested one fighting nothing.
    const larder = skills.larderOf(c).length;
    const floor = (this.policy.fightAboveVigor ?? 0) / 200;
    const reachable = larder > 0 || floor <= REST_VIGOR_CAP;
    const tooTiredToFight = reachable && vig !== null && vig < floor;
    if ((healthHurt || tooTiredToFight) && combatZone && !sheltered && !testing && !this.hold) {
      this.doing = 'travelling';
      const ways = (s.world?.exits() || []).filter(e => e.to != null && e.reachable !== false);
      const out = ways.sort((a, b) => (a.steps_away ?? 999) - (b.steps_away ?? 999))[0];
      this.note('leaving the room rather than dying in it', {
        health: hp === null ? null : Math.round(hp * 100) + '%', vigor: vigorNow2,
        monsters_in_room: hostiles.length, leaving_via: out?.to_name ?? 'nothing reachable',
        why: 'too hurt to fight, too tired to be worth walking far, and resting where something ' +
             'can reach us is how a rest becomes a death. Out of the room none of that is true',
        then: 'find food — that is the thing actually wrong' });
      // TRY EVERY WAY OUT, AND THEN STOP BEING SURROUNDED.
      //
      // THIS IS WHAT IS KILLING THE FLEET. Of 37 deaths since the reach model went in,
      // 33 decided to leave and 13 recorded "could not leave" — and every single death
      // was slow attrition: median -0.03 health per second, nothing worse than -0.22.
      // Nobody was killed in a fight. They chose correctly, failed to get out, and then
      // bled to death over minutes at 10-12 attackers, standing exactly where they were.
      //
      // Two things were wrong here and both are one-liners:
      //
      //   ONE EXIT. This picked the nearest and tried it once, so the boundary-wide
      //   candidates from world.exits() were never used. leaveViaAny walks the whole
      //   wall and every other exit besides.
      //
      //   NO FALLBACK. When the walk out failed it gave up and returned, and the pass
      //   ended with the character still standing in the room. But a walk failing while
      //   surrounded is the EXPECTED case — that is what being surrounded does — and
      //   there is already a tool for it: a reconnect hands back the entry grace period,
      //   so we come back with about one of them aware of us instead of twelve. It was
      //   only ever wired to stepping off a safe spot, which is the same problem in a
      //   politer setting.
      const tryOut = async () => {
        const cands = ways.length ? ways : (s.world?.exits() || []).filter(e => e.to != null);
        if (!cands.length) return { left: false, reason: 'no exit from this room at all' };
        return await s.leaveViaAny(cands).catch(e => ({ left: false, reason: e.message }));
      };
      const gotOut = async (r) => {
        this.tally.fled_rooms = (this.tally.fled_rooms || 0) + 1;
        this.fledInARow = (this.fledInARow || 0) + 1;
        await skills.restUntil(s, { health: 0.95, vigor: REST_VIGOR_CAP, maxSeconds: 90 })
                    .catch(() => {});
        await this.cookSomething('got out of a bad room and need food before going back')
                  .catch(() => {});
        this.progress('left a room I could neither fight nor rest in');
        // FLEEING TWICE IS A SUPPLY PROBLEM WEARING A TACTICS PROBLEM'S CLOTHES.
        //
        // Leaving one bad room is a decision. Leaving three is a character that cannot
        // fight anywhere, and walking to a fourth wilderness room will not change that.
        // Animal proved it: 168 flees and 2 kills, because the supervisor graduates a
        // pair with fight_above_vigor 180 and a character at the resting cap of 80 can
        // never meet it — so it refused every fight, fled every room, earned nothing,
        // and therefore never got the food that would have let it fight. The loop is
        // closed and nothing inside the wilderness opens it.
        //
        // Town does open it: it is a sanctuary, so resting is legal and safe, and it
        // has counters that sell bread — which is the only route past 80 vigor.
        //
        // The exemption is for a character that is merely having a bad room: plenty of
        // vigor and food in the pack means the fleeing is tactical, not structural, and
        // sending it to town would be throwing away a working session.
        await this.townTripIfCornered().catch(() => {});
        return r;
      };

      let r = await tryOut();
      if (r.left) { await gotOut(r); return; }
      this.note('could not leave', { why: r.reason, tried: r.tried?.length ?? 1,
        next: 'reconnecting to shed the crowd, then trying again' });

      // Being unable to walk out IS the crowd. Reset it and try once more.
      const broke = await this.breakOut('cannot walk out of a room that is killing us')
                              .catch(() => ({ did: false }));
      if (broke.did) {
        r = await tryOut();
        if (r.left) {
          this.note('got out after reconnecting', { crowd_before: broke.crowd,
            why: 'the walk failed because twelve things were already swinging; after a ' +
                 'reconnect only about one of them has noticed' });
          await gotOut(r);
          return;
        }
      }
      // Nowhere to go. Say what is actually needed rather than looping silently — the
      // interest board is what the almoner and the quartermaster read.
      this.declareInterest();
      this.noProgress('trapped: cannot fight, cannot rest, cannot leave — needs food or a rescue');
      return;
    }

    if ((!combatZone || sheltered || testing) && hurt) {
      if (testing && near.length)
        this.note('testing this spot the only way there is', {
          where: { col: this.hold.col, row: this.hold.row }, crowd: near.length,
          health: Math.round(hp * 100) + '%',
          why: 'sitting still without swinging is the experiment. If nothing lands we can rest to ' +
               'full here from now on; if something does, we find out in one pass and with two ' +
               'hits of margin still in hand' });
      // HEALTH AND VIGOR COME BACK BY COMPLETELY DIFFERENT MEANS, and only one of
      // them comes back by resting. RestTimer restores vigor and never touches
      // health (player.kod:10033). Having a high vigor then enhances your health regeneration.
      this.doing = 'recovering';
      // Arm whenever we are here for HEALTH, at whichever threshold brought us — a
      // sheltered character resting at 85% still needs the flag set, and gating this
      // on the open-floor threshold would have it sit there collecting vigor and
      // wondering why its health never moved.
      if (hp !== null && hp < restAt) {
        // ARM THE TIMER FIRST. HealthTimer only awards a point if
        // PFLAG_MOVED_SINCE_ENTRY is set, so a character that walked into an inn and
        // stopped regenerates nothing at all — which is precisely what happened to one
        // of mine for twenty-nine consecutive rest attempts.
        //
        // HOW we arm it depends entirely on where we are standing. A step arms it and
        // gives up the square; a TURN arms it and does not. Out in the open that
        // distinction does not exist, which is why the original only ever stepped —
        // but stepping off a safe spot to start healing is giving away the reason the
        // healing is safe, and it is worth being exact about.
        const n = this.hold
          ? await skills.turnInPlace(s).catch(() => ({ turned: false }))
          : await skills.nudge(s).catch(() => ({ moved: false }));
        // Both of these end the entry grace period, which is the point: from here on
        // anything that fails to hit us is failing because of the walls.
        if (n.turned) this.turnedAt = Date.now();
        if (n.moved) this.movedAt = Date.now();
        if (n.moved && this.hold) {
          // DRIFTING OFF A PROVEN SQUARE IS A REASON TO WALK BACK, NOT TO GIVE IT UP.
          //
          // This released the hold outright, on the reasoning that REQ_TURN carries no
          // coordinates so a move here "should be impossible". It is not impossible, and
          // it killed Animal: a proven spot at (23,6) in the Main gate to the city of Tos
          // that had held for 44 seconds, broken off from correctly at 34% health, then
          // abandoned on this line with the note "a turn moved us off the square". He
          // healed in the open instead — 10 health, then 2, then dead, with three
          // centipedes and two of the Duke's soldiers in the room.
          //
          // And the detection cannot support the conclusion it draws. turnInPlace
          // compares position from before the turn against a read taken after a 300ms
          // sleep and a room-contents round trip — up to 2.3 seconds of live combat. All
          // `moved` establishes is that the square changed at some point in that window;
          // it does not establish that the turn did it.
          //
          // Whatever moved us, the right answer at low health is the square we already
          // know holds. returnToSpot closes to the fine unit, which matters because a
          // safe spot can sit most of a square off centre. Give it up only if we cannot
          // get back.
          const back = await skills.returnToSpot(
            s, { col: this.hold.col, row: this.hold.row, x: this.hold.x, y: this.hold.y },
            { maxSteps: 12 }).catch(() => ({ arrived: false }));
          if (back.arrived) {
            this.note('drifted off the safe square and walked back', {
              where: { col: this.hold.col, row: this.hold.row }, off_by: back.off_by ?? null,
              proven: this.hold.proven, health: hp,
              why: 'the square is known to hold and we are too hurt to fight in the open; ' +
                   'returning is cheaper than finding another one' });
          } else {
            this.releaseHold(`moved off the square and could not get back: ${back.why || 'unknown'}`);
          }
        } else if (n.turned) {
          this.note('turned to arm health regeneration', {
            ...n, kept: this.hold ? { col: this.hold.col, row: this.hold.row } : null,
            why: 'this wakes the monsters, and in a working safe spot that costs nothing — ' +
                 'they cannot reach us, and the flag it sets is what lets health come back' });
        } else if (n.moved) {
          this.note('stepped to arm health regeneration', n);
        }
        const h = await skills.healUp(s, { target: 0.9 }).catch(e => ({ healed: false, reason: e.message }));
        this.recordHealUse(h, 'hurt, and resting behind a wall');
        if (h.healed) {
          this.tally.heals = (this.tally.heals || 0) + 1;
          this.progress('healed');
          this.note('healed', { used: h.used, health: h.health });
        } else if (h.reason === 'nothing to heal with') {
          // No flask and no heal spell is NOT a dead end — health comes back on its
          // own now that we have moved. It is only slow, at roughly
          // ((200-vigor)^2/6 + 1000) milliseconds a point, which is why resting
          // matters: it is vigor, not time, that sets the rate. Only ask for help if
          // we are badly hurt AND cannot rest safely.
          this.note('healing the slow way', {
            health: h.health, armed_by: n.turned ? 'turning in place' : (n.moved ? 'a step' : 'nothing'),
            note: 'no flask or heal spell; regenerating on the vigor timer' });
          // Being out of flasks is only an emergency when we have nowhere safe to be.
          // In a spot that holds, it is a wait.
          if ((hp ?? 1) < 0.25 && !sheltered)
            await this.askForHelp('badly hurt and out of flasks').catch(() => {});
        }
      }
      this.tally.rests++;
      // Sheltered, resting is free and uninterruptible, so take it all the way to
      // full rather than to a threshold — the next fight starts from whatever we
      // stand up with, and there is nothing to spend the difference on.
      const r = await skills.restUntil(s, {
        // Always finish above the threshold that sent us here, or the next pass sends
        // us straight back and the character rests in one-second slices forever.
        health: Math.min(0.99, Math.max(0.95, restAt + 0.02)),
        // Not 0.95. RestTimer stops awarding vigor at 80 of 200, so asking for more
        // guarantees the full timeout is burned every single rest and reached_target
        // is always false.
        vigor: REST_VIGOR_CAP,
        // A short leash while the spot is only a hypothesis: resting does not look at
        // anything, so a two-minute rest in a corner that does not work is two minutes
        // of being hit with nobody watching.
        //
        // AND A PROOF IS ABOUT THE ROOM IT WAS TAKEN IN. The long leash is earned by
        // evidence — this square held while N things stood next to it — and it stops
        // meaning anything once more than N are there. Twenty-one of our own characters
        // moved into the Mausoleum and the mummy cap is twenty; squares proven against
        // one or two attackers were suddenly being approached by four, from angles the
        // proof never covered. Zoot took the full sheltered leash on such a square and
        // spent it going from 17 health to 3.
        //
        // So the leash is the SHORT one whenever the present crowd is bigger than the
        // one the square was proven against. Not a demotion — the square may well still
        // work — just a refusal to bet two minutes of not looking on it.
        maxSeconds: testing ? 15
                  : (sheltered ? (near.length > (this.hold?.mostAttackers ?? 0) ? 20 : 150)
                               : 90) });
      this.note('rested', { seconds: r.seconds, to: r.vitals?.health, reached: r.reached_target, why: r.note,
                            in_safe_spot: sheltered || undefined,
                            crowd: sheltered ? near.length : undefined,
                            interrupted: r.interrupted || undefined,
                            note: r.interrupted
                              ? 'cut short — see interrupted'
                              : sheltered
                              ? 'resting to full in a monster room, which the safe spot is what makes possible'
                              : 'resting restores vigor, and vigor sets how fast health regenerates' });
      // TAKING DAMAGE THROUGH A REST IS EVIDENCE, AND IT IS THE SAME EVIDENCE the hold
      // evaluator acts on — hit while standing still and not swinging. It just arrived
      // three seconds after the fact instead of at the end of the leash, which is the
      // entire point. Give the square up now rather than resting into it again on the
      // next pass and waiting for observe() to reach the same conclusion a minute later.
      if (r.interrupted) { await this.restBroken(room, near).catch(() => {}); return; }
      return;
    }

    // PARKED. This is the point the keeper would otherwise choose a new action — the
    // errand, the roam, the fight — and it is past death, danger and rest, so a parked
    // character has already handled anything that was happening to it. See park().
    //
    // Deliberately ABOVE the errand branch: an errand is a multi-minute walk across the
    // world, which is the worst possible thing to be half-way through when the broker
    // goes down. A character that is already on one finishes nothing and stands still;
    // the errand is still in `this.errand` and the keeper on the far side of the restart
    // picks it up from the roster.
    if (this.parking) {
      const p = this.parking;
      // Somewhere hostile? Get a wall. `takeSafeSpot` is the same call the rest gate
      // uses, so a parked character ends up in exactly the state resting requires.
      //
      // `hostiles` is the whole room, not `near` — the same distinction the rest gate
      // makes and for the same reason: a room with four monsters in it and none beside
      // us right now is not a place to sit out an outage. And a room that merely SPAWNS
      // counts too, because an empty spawn room is a room between spawns.
      const wantWall = this.policy.useSafeSpots && !this.hold &&
                       (hostiles.length > 0 || !this.sanctuary());
      if (wantWall && !p.ready) {
        p.tries++;
        await this.takeSafeSpot('parking for a fleet update — a wall before the outage',
                                hostiles[0] ?? null).catch(() => false);
      }
      // READY WHEN WE ARE BEHIND SOMETHING, or when we have spent long enough failing to
      // find one that holding up the fleet costs more than the wall is worth. Reporting
      // ready without a wall is honest rather than convenient: parkStatus() carries
      // `holding: null` and the orchestrator prints it, so the operator sees which
      // characters are about to take the outage standing in the open.
      const graceUp = Date.now() - p.at > Autopilot.PARK_GRACE_MS;
      if (!p.ready && (this.hold || !wantWall || graceUp)) {
        p.ready = true; p.since = Date.now();
        this.note('parked and ready for the update', {
          holding: this.hold ? { col: this.hold.col, row: this.hold.row, proven: this.holdWorks() } : null,
          attempts: p.tries,
          why: this.hold ? 'behind a wall, taking no new fights until the update is done'
             : !wantWall ? 'nothing here spawns or threatens, so a wall buys nothing'
             : 'could not find a wall in ' + Math.round(Autopilot.PARK_GRACE_MS / 1000) + 's — ' +
               'reporting ready rather than holding the whole fleet up, and saying so' });
      }
      // Rest while we wait, but only where resting is legal — the same rule the rest
      // gate applies, and for the same reason. Free health for the far side of the
      // restart when it is safe, and nothing at all when it is not.
      if (this.holdWorks() || !hostiles.length) {
        const hp = pct(this.s.client?.vitals?.health);
        if (hp !== null && hp < 0.95) {
          this.doing = 'recovering';
          await skills.restUntil(this.s, { health: 0.99, vigor: REST_VIGOR_CAP, maxSeconds: 20 })
                      .catch(() => {});
        }
      }
      return;
    }

    // An errand outranks farming and is outranked by everything above it: we are past
    // the death, danger and rest branches, so a runner in trouble has already dealt
    // with the trouble.
    if (this.errand && await this.runErrand().catch(e => {
      this.note('loot run failed', { why: e.message }); this.errand = null; return false;
    })) return;

    // Standing in a bank? Put the takings away before anything can take them.
    await this.bankSurplus().catch(() => {});
    // Carrying enough that it is worth WALKING to one? Go. See bankRun().
    if (await this.bankRun().catch(() => false)) return;

    // Someone else is standing here and we can mend them: do that first. It costs a
    // second and it is the only action available that helps another character.
    if ((STRATEGIES[this.policy.strategy] || {}).medic) await this.medic().catch(() => {});

    // HIBERNATING IS NOT DOING NOTHING. A keeper with no job still has a bar to fill,
    // and vigor is what a character walks out of an inn with — it sets the health
    // regeneration rate and it is what swinging spends. Standing about at 30 of 200
    // because nobody gave us a task is throwing away the one thing idle time is for.
    if (this.mode === 'idle') {
      if (await this.hibernate('idle: no job to do').catch(() => false)) return;
      return;
    }

    // 4. Work. Only in farm mode, and only on what we were told to hunt.
    if (this.mode === 'farm') {
      // NEVER STAND IN A ROOM THAT CANNOT PRODUCE THE PREY.
      //
      // This does not need to be discovered by waiting. The spawn table says up
      // front whether a giant rat can ever appear here, so tolerating three empty
      // passes first is three passes of pretending. Riven spent them standing in
      // Quintor's Smithy "hunting giant rats" — a shop, where nothing is generated,
      // nothing can be fought, and no amount of patience would have changed either.
      //
      // The check is on GENERATORS, not on the room's object list: a smithy contains
      // the blacksmith, who is placed once at construction, so "does anything spawn
      // here" is true of every shop in the game unless you distinguish the two.
      if (room) {
        const spawns0 = loadSpawns(SPAWN_FILE);
        const here = (spawns0?.rooms?.[room.num] || []).filter(x => x.huntable);
        const want0 = String(this.policy.hunt || '').toLowerCase();
        const preyHere = here.some(x => (x.creature || '').toLowerCase().includes(want0));
        if (!preyHere) {
          const known = this.preyRooms(room);
          if (known.length) {
            const target = known[0];
            // NOT WHILE HURT OR EMPTY-HANDED. Eleven of the last fifty deaths set off on
            // this exact line. The room is still the wrong room; that is not a reason to
            // arrive at the right one in no state to be there.
            if (!await this.readyToLeaveSanctuary(target.room_name)) return;
            this.note('this room cannot produce our prey — leaving now', {
              room: room.name, hunting: this.policy.hunt,
              generates: here.map(x => x.creature),
              going_to: target.room_name,
              why: here.length ? 'none of what spawns here is what we hunt'
                               : 'nothing is generated here at all — it is not a hunting ground' });
            this.doing = 'travelling';
            if ((await this.leaveHold('travelling to a room that generates our prey')).refused) return;
            // THE THREE THINGS WE WANT TO KNOW ABOUT AN ASSIGNMENT, recorded where a
            // human and an agent can both read them later: does it do what we hoped
            // (did we end up where we were assigned), does it do it every time
            // (drifts vs holds), and how does it fail (why_not, kept verbatim).
            const mine = this.policy.assignedRoom;
            const p = this.placement;
            p.relocations++;
            if (mine != null) p.aimed_at_assignment += (target.room === mine ? 1 : 0);
            const r0 = await this.travel(target.room, { maxHops: 14 })
                             .catch(e => ({ arrived: false, reason: e.message }));
            if (r0.arrived) {
              this.homeRoom = target.room;
              this.emptyPasses = 0;
              this.relocFails.delete(target.room);   // it works; forget the near misses
              if (mine != null) {
                if (target.room === mine) p.returned_to_assignment++;
                else { p.drifted++; p.drifted_to[target.room] = (p.drifted_to[target.room] || 0) + 1; }
              }
              this.progress('moved to a room that generates the prey');
            } else {
              p.failed++;
              if (p.why_not.length < 8) p.why_not.push({ room: target.room, why: r0.reason || 'travel did not arrive' });
              // ONE MISS IS NOT A PROOF OF UNREACHABILITY, and treating it as one is
              // how a spread fleet quietly re-collapses: the first transient failure
              // blacklists the ASSIGNED room, so the keeper never tries it again and
              // goes back to the top-ranked room for ever. Both failures seen in
              // practice were transient — a crowded `go` square ("stood on the exit
              // square and nothing happened"), and a route the planner picked through
              // an edge with no floor, which succeeds from a different starting room.
              const n = (this.relocFails.get(target.room) ?? 0) + 1;
              this.relocFails.set(target.room, n);
              if (n >= 3) this.unreachable.add(target.room);
              this.noProgress('cannot reach anywhere that generates ' + this.policy.hunt);
            }
            return;
          }
        }
      }

      if (!this.policy.hunt) {
        // No quarry named is the same situation as idle mode: rest up rather than
        // stand there, so that whenever a job does arrive it starts from a full bar.
        if (await this.hibernate('farm mode with nothing named to hunt').catch(() => false)) return;
        this.note('idle: nothing to hunt', { hint: 'set policy.hunt to a creature name' });
        return;
      }
      // Bags full. This used to stop and say so, and then say so again every eight
      // seconds for as long as you left it — a third of one run spent announcing a
      // problem it could have solved. Sell to anyone here who buys; failing that,
      // drop the biggest pile of junk. Keep money, gems, and anything in use.
      if (c.inventory.length >= this.policy.maxCarry) {
        const freed = await this.makeRoom();
        this.note('bags full — ' + freed.did, { carrying: c.inventory.length, max: this.policy.maxCarry, ...freed.detail });
        if (freed.ok) this.progress('made room in bags'); else this.noProgress('bags full and could not make room');
        return;
      }
      let found = skills.findCreature(s, this.policy.hunt);
      this.clearing = null;

      // IS THIS ROOM STILL WORTH HUNTING IN, or is it silting up?
      //
      // Asked whether or not our prey is present — see capBlockers().should_clear. The
      // first version only asked when the room held no prey at all, and so did nothing
      // in the case it was built for: two centipedes among eight baby spiders reads as
      // "prey available", and the keeper hunted the two while the eight held the cap.
      if (this.policy.clearWeak !== false) {
        const capped = this.capBlockers(room);
        if (capped?.should_clear) {
          const target = capped.clearable[0];
          const shot = skills.findCreature(s, target.name);
          if (shot.length) {
            this.clearing = target.name;
            found = shot;
            this.note('clearing the room so it can spawn again', {
              killing: target.name, of_them: target.count,
              room: room?.name, at_cap: `${capped.present}/${capped.cap}`,
              prey_present: capped.prey_present, hunting: this.policy.hunt,
              why: capped.why_clear,
              note: 'the cap is a room-wide total, so what we decline to kill is what ' +
                    'stops our prey appearing. Leaving would not reset it.' });
          }
        } else if (capped?.full && !capped.clearable.length && capped.blocked.length) {
          // Cannot clear it, so the room is finished for us — and it will still be
          // finished when we come back, because an abandoned full room keeps its
          // generator switched off. Go, and prefer somewhere else next time.
          this.note('this room is capped by things we will not fight', {
            room: room?.name, at_cap: `${capped.present}/${capped.cap}`,
            blocked_by: capped.blocked.map(b => `${b.count}x ${b.name} — ${b.why}`),
            why: 'the generator is gated on the room total, so nothing new spawns while ' +
                 'these are alive. Leaving does NOT reset it (monsroom.kod:353 only ' +
                 'reloads a room left with zero monsters) — this is giving it up.' });
          this.cappedRooms = (this.cappedRooms ?? new Set()).add(room?.num);
          if (this.policy.roam) { await this.roam(room); return; }
          this.noProgress('room capped by creatures we will not fight');
        }
      }

      if (!found.length) {
        // HOLDING A WALL IN A ROOM THAT SPAWNS IS WORK. WAITING IS THE JOB.
        //
        // An empty pass means "nothing of ours is visible RIGHT NOW", and in a spawning
        // room that is the normal state between a kill and the next wanderer. Monsters
        // take their time crossing a big outdoor room, and the whole value of a safe spot
        // is that waiting there costs nothing — nothing can reach the square, so patience
        // is free and the alternative is walking around in the open looking for a fight.
        //
        // Counting those passes the same as fruitless ones is what makes a character give
        // up a proven square and roam, which is both worse ground and the state most of
        // the death record happens in ("travelling" and "recovering" are 21% and 35% of
        // deaths; "fighting" is 17%). A spot that took a walk and a probe to find should
        // not be abandoned because the room was quiet for eight seconds.
        //
        // So while we are holding a working spot in a room that generates our prey, an
        // empty pass is not counted at all. Everything that ends a vigil for a real
        // reason still fires: being hit in the spot releases it, the room going capped is
        // handled above, hunger and health run on their own clocks.
        const waitingInASpot = !!this.hold && this.holdWorks() && !this.sanctuary(room);
        if (waitingInASpot) {
          if (!this.waitedInSpotAt || Date.now() - this.waitedInSpotAt > 60_000) {
            this.waitedInSpotAt = Date.now();
            this.note('holding the spot and waiting for something to come to us', {
              room: room?.name, spot: { col: this.hold.col, row: this.hold.row },
              proven: this.hold.proven,
              why: 'nothing in reach this pass, but this room spawns and the square holds. ' +
                   'Waiting behind a wall costs nothing; wandering to find a fight is how ' +
                   'characters end up dying while travelling' });
          }
          return;
        }
        this.emptyPasses++;
        // A ROOM THAT SPAWNS NOTHING IS NOT AN EMPTY ROOM, AND WAITING IN IT IS NOT WORK.
        //
        // "They respawn eventually" is true of a hunting ground between spawns and false
        // of a tavern. This branch could not tell them apart, so a character that drifted
        // into an inn after a death or a shop trip stood there for the rest of the
        // session logging "nothing to hunt here" — perfectly accurately — and roam:false
        // meant it never left.
        //
        // Fourteen of twenty-one were doing exactly that: Kermit and Floyd in Cibilo
        // Creek Inn, Statler in The Limping Toad, Janice in Marion, Pepe and Camilla in
        // Barloque. Three characters were producing every kill the fleet made.
        //
        // sanctuary() already answers "does anything huntable spawn here". When the
        // answer is no, leaving is not roaming — it is going to work — so it does not
        // wait on the roam permission, which exists to stop characters wandering off
        // productive ground.
        const barren = this.sanctuary(room);
        if (barren && this.emptyPasses >= 2) {
          // policy.assignedRoom is where `spread` put us; homeRoom is where we last
          // settled. `this.assignedRoom` does not exist — reading it would have made this
          // whole branch quietly do nothing, which is the failure mode this fix is about.
          const home = this.policy.assignedRoom ?? this.homeRoom;
          if (home != null && home !== room?.num) {
            // The other door out of an inn, and it killed Zoot, Piggy and Rizzo inside
            // twenty minutes: all three woke up in a tavern after a death, took this
            // branch on pass 2, and never got to the unarmed check further down because
            // they were already walking. Going back to work is right; going back to work
            // hurt and bare-handed is what the last twenty minutes of records are.
            if (!await this.readyToLeaveSanctuary(home)) return;
            this.note('this room spawns nothing at all — going back to work', {
              room: room?.name, room_num: room?.num, going_to: home,
              why: 'a tavern has no spawn table, so waiting for a respawn here waits for ' +
                   'something that cannot happen. This is not roaming; roam guards against ' +
                   'leaving GOOD ground, and this is not that.' });
            this.doing = 'travelling';
            const moved = await this.travel(home, { maxHops: 20 })
                                  .catch(e => ({ arrived: false, reason: e.message }));
            if (moved.arrived) { this.emptyPasses = 0; this.progress('left a room that spawns nothing'); return; }
            this.note('could not get back to the assigned room', { going_to: home, why: moved.reason });
          }
        }
        if (this.policy.roam && this.emptyPasses >= this.policy.roamAfterEmptyPasses) {
          await this.roam(room);
        } else {
          this.note('nothing to hunt here', {
            looking_for: this.policy.hunt, room: room?.name, empty_passes: this.emptyPasses,
            hint: this.policy.roam ? undefined
              : 'they respawn eventually; set roam:true to move on instead of waiting',
          });
        }
        return;
      }
      this.emptyPasses = 0;

      // EAT BEFORE FIGHTING, if this pattern says to. Resting stops at the rest
      // threshold of 80; everything above that has to come from food, and vigor is
      // what sets the health regeneration rate — so a well-fed character recovers
      // between fights several times faster than a merely rested one.
      const plan = STRATEGIES[this.policy.strategy] || STRATEGIES.baseline;
      if (await this.provision(plan, v)) return;   // still stocking up — do not engage

      // ARMED? Both of this fleet's characters-can-fix-it-themselves problems are
      // checked in the same place and for the same reason: they are silent. An empty
      // larder caps vigor at what resting gives, and an empty hand turns every fight
      // into punching — and the server reports neither. `create food` and `create
      // weapon` are carried by every character here, so the first question when either
      // is missing is whether we can simply make one.
      if (!skills.weaponsOf(this.s.client).length) {
        const armed = await this.armSelf().catch(() => false);
        if (!armed) {
          this.note('about to fight unarmed', {
            mana: this.s.client?.vitals?.()?.mana?.value,
            why: 'no weapon in the pack and create weapon could not be cast — it needs 15 mana',
            note: 'UserAttack falls back to a punch silently, so this would otherwise look like ' +
                  'a character that is fighting badly rather than one that is not armed' });
        }
      }

      // Resume the creature we already hurt rather than whatever is nearest now. A
      // kill scores nothing unless we damaged it and it was our current target, and
      // each new attack resets both flags — so breaking off at 40% health and then
      // starting fresh on a different monster silently throws away every point of
      // progress the first fight earned.

      // Refuse the fight outright if we are not healthy enough to take it. Heal
      // first — that is a real action now, not a euphemism for resting.
      const safe = this.safety();
      if (hp !== null && hp < safe.engageAt) {
        const h = await skills.healUp(s, { target: 0.95 }).catch(() => ({ healed: false }));
        this.recordHealUse(h, 'too hurt to start the fight in front of us');
        if (h.healed) this.note('healed before engaging', { used: h.used, health: h.health });
        else {
          this.note('too hurt to start a fight', {
            health: Math.round(hp * 100) + '%', need: Math.round(safe.engageAt * 100) + '%',
            worst_single_hit: safe.maxHit,
            why: 'a single hit can take ' + safe.maxHit + ' of ' + (s.client.vitals()?.health?.max) +
                 ', and health does not come back on its own' });
          // ONLY WHEN ACTUALLY BADLY HURT. engageAt is a "do not START a fight" line,
          // not a distress signal — for a character under thirty max health it sits at
          // 90%, so this was broadcasting for a rescue at 89% health, every five
          // minutes, in front of everybody. Being unready to pick a fight and being in
          // trouble are different states and only one of them is worth asking about.
          if ((hp ?? 1) < 0.35)
            await this.askForHelp('badly hurt and out of flasks').catch(() => {});
          // NOT A STALL — PROVIDED WE ARE ACTUALLY RECOVERING. Regenerating on the
          // vigor timer is the most useful thing available and calling it a stall made
          // a working system look broken. But the claim has to be true: if we got here
          // it means the rest branch above declined, which now happens only when
          // something hostile is stood over us, and a character being hit while
          // refusing to fight or flee is the definition of stuck. Reporting progress
          // in that state is what let the dead zone hide for so long.
          this.doing = 'recovering';
          if (near.length) {
            this.note('cornered while too hurt to engage', {
              health: Math.round(hp * 100) + '%', crowd: near.length,
              what: near.map(o => c.rsc.get(o.nameRsc)),
              why: 'cannot rest with something on us and not healthy enough to start a fight' });
            this.noProgress('too hurt to fight and not safe enough to rest');
          } else {
            this.progress('recovering to fighting strength');
          }
          return;
        }
      }
      // TOO TIRED TO START. Checked before choosing a wall, not after, because the
      // answer is the same either way — go and sit down — and doing it here means a
      // character that is out of vigor spends its pass recovering rather than walking
      // somewhere to be out of vigor in.
      //
      // The retreat is deliberately TO A SAFE SPOT rather than away: resting is what
      // is needed, resting next to a monster is only possible behind a wall, and a
      // character that has to leave the room to recover has to walk back afterwards
      // through everything it just walked past.
      const vigorNow = vigorOf(v);
      const vigorFloor = this.fightFloor();
      if (vigorNow != null && vigorNow < vigorFloor) {
        this.vigor.waited++;
        this.doing = 'recovering';
        // A wall first, if one is going and we do not already have it — resting with
        // something adjacent is only safe behind one.
        if (!this.hold && this.policy.useSafeSpots && room)
          await this.takeSafeSpot('too tired to fight — need somewhere safe to rest',
                                  found[0] ?? null).catch(() => {});
        const r = await skills.restUntil(s, {
          health: 0.98, vigor: REST_VIGOR_CAP, maxSeconds: 120 }).catch(() => null);
        this.tally.rests++;
        this.note('too tired to start a fight', {
          vigor: vigorNow, need: vigorFloor, after_resting: r?.vitals?.vigor?.value,
          behind_a_wall: !!this.hold,
          why: 'attacking costs about thirty vigor a minute and vigor also sets how fast health ' +
               'comes back, so starting a fight below ' + vigorFloor + ' means breaking off ' +
               'part-way and recovering slower than if we had waited',
          note: (r?.vitals?.vigor?.value ?? 0) < vigorFloor && !this.hadFood
            ? 'resting alone stops at 80; if this does not clear, the character needs food'
            : undefined });
        this.progress('resting up to fighting vigor');
        return;
      }

      // PUT YOUR BACK TO A WALL BEFORE FIGHTING ANYTHING WORTH FIGHTING.
      //
      // This used to trigger on a crowd of three, which reads as caution and is
      // actually the wrong test: it made the safe spot an emergency measure for when
      // things had already gone wrong, when it is really the normal way to fight.
      // Every fight the keeper picks on purpose is against something at or above its
      // own level — that is what makes the kill pay at all — and something at your
      // own level can take a third of your bar in one blow.
      //
      // So the test is the owner's rule of thumb, which is also the game's own
      // advancement rule: IF YOU CAN GAIN MAX HEALTH FROM IT, FIGHT IT FROM A WALL.
      // See holdWorthwhile(). Against prey we genuinely outclass, and only then, the
      // walk to the corner costs more than the fight does.
      const foundNames = [...new Set(found.map(o => c.rsc.get(o.nameRsc)))];
      const worth = this.holdWorthwhile([...new Set([...foundNames, ...this.threat().names])]);
      if (worth.hold && !this.hold && room) {
        // Aim at the fight, not just at the nicest wall. `found` is sorted nearest
        // first by findCreature, so its head is the thing we are about to go and get.
        const t = await this.takeSafeSpot(worth.why, found[0] ?? null);
        if (t.took) {
          // Do not burn the pass on arriving. The whole point of the spot is that the
          // fight happens here, and the fight is directly below.
          this.progress('took up a defensible position');
        } else if (!this.warnedNoSpot || this.warnedNoSpot !== room.num) {
          // Say this once per room rather than every eight seconds: a room with no
          // corner in it is a fact about the room, not an event.
          this.warnedNoSpot = room.num;
          this.note('no safe spot available here', {
            room: room.name, why: t.why,
            consequence: 'fighting in the open, so the flee threshold is doing all the work',
            hint: 'somewhere with a wall to put our back to would be worth moving to' });
        }
      }

      // NO WALL, NO FIGHT — AND THE ROOM IS WRITTEN OFF UNTIL SOMEONE FIXES DETECTION.
      //
      // Not "prefer a wall". A room this keeper cannot find a defensible square in is
      // treated as UNUSABLE and left, whatever is standing in it and whatever its
      // level. That is a deliberate over-reaction and it is worth being explicit about
      // why, because it will make the fleet refuse places it could probably survive:
      //
      // The wall is the entire survival model. In a spot that holds, nothing lands a
      // blow unless we swing first, so a fight is a sequence of exchanges we choose;
      // in the open it is a race between their damage and our health, which is the
      // race the death log is made of — characters going from full health to dead
      // inside one eight-second pass, faster than any withdrawal could have helped.
      //
      // And this keeper's detection is known to be weak rather than merely unlucky.
      // The candidate ranking was, until recently, capped at the 400 best-scoring
      // squares in the room, which in a large outdoor room filled up with alcoves
      // before a single plain wall edge was considered — and a plain edge is exactly
      // what the known-good squares are. So "found no wall here" has often meant "did
      // not look properly".
      //
      // The honest response to a detector we do not trust is to STOP, not to guess. So
      // a room with no wall we can find is a denial of service for that area: recorded,
      // reported, and left alone until better detection earns it back. Under-using the
      // world is recoverable; the alternative is not.
      if (this.policy.requireSafeWall !== false && !this.hold && room?.num != null) {
        // Ask once per room, not once per pass. takeSafeSpot is a scan plus pathfinds,
        // and the answer does not change while we stand here — but it DOES change when
        // the book learns something, so this is per session rather than persisted.
        if (!this.noWallRooms) this.noWallRooms = new Map();
        let denied = this.noWallRooms.get(room.num);
        if (denied === undefined) {
          const probe = await this.takeSafeSpot(
            'testing whether this room can be fought in at all', found[0] ?? null)
            .catch(() => ({ took: false, why: 'the search threw' }));
          // DENY THE ROOM ONLY WHEN NO SQUARE WAS FOUND — not when we failed to WALK to
          // one. Those are different facts about different things: the first is about
          // the room, the second is about us, and takeSafeSpot returns took:false for
          // both. Conflating them meant a character that could not cross the floor
          // (blocked, mid-fight, position unsettled after an edge crossing) wrote off a
          // room full of walls, permanently for that session, and then had nowhere to
          // go because preyRooms excludes denied rooms. Three characters were stuck
          // exactly that way, reporting "no safe wall here and nowhere better to go"
          // about rooms with hundreds of usable squares in them.
          //
          // A walk that failed is retried next pass, which costs a pass. A room wrongly
          // denied costs the room.
          const noneExist = !probe.took && /more defensible than open floor|out of the fight/i
                              .test(String(probe.why || ''));
          denied = probe.took ? false : (noneExist ? (probe.why || 'no defensible square found') : undefined);
          if (denied !== undefined) this.noWallRooms.set(room.num, denied);
          else this.note('could not reach a wall this pass — not blaming the room', {
            room: room.name, why: probe.why,
            note: 'the room has candidate squares; getting to one failed, which is about us ' +
                  'and is retried next pass' });
        }
        // WHEN THE CHARACTER CAN AFFORD AN OPEN FIGHT, TAKE IT.
        //
        // Refusing outright turned a risk into a certainty. With this absolute, the fleet
        // spent 95% of its time travelling and 0% fighting: fifteen of twenty-one walked
        // between rooms looking for one the detector approved of, scored no kills in
        // forty-five minutes, and lost four levels to the deaths that happened anyway.
        // Under-using the world is recoverable, but only if something is being used.
        //
        // Where the risk actually lives is now measurable rather than assumed. Across
        // 6,570 observations and 221 deaths, deaths per thousand observations ran 75.7
        // below 85 vigor and 12.4 above 160 — a six-fold difference, and vigor is the
        // variable, not the wall. Vigor sets how fast health returns between exchanges,
        // so a rested character in the open is in a different fight from a tired one.
        //
        // So the wall is still preferred and still taken whenever one is found. It stops
        // being mandatory only for a character that is close to whole, above the vigor
        // band where the death rate collapses, and facing prey no higher level than
        // itself. Anything short of all three, the old refusal stands.
        // HOW MANY BLOWS CAN WE TAKE, not how the two levels compare.
        //
        // holdWorthwhile asks `prey level > our max health`, which is the right test for
        // whether a kill PAYS — AdvancementCheck uses exactly that — and the wrong one
        // for whether it is survivable. A fungus beast is level 50 against our 32, so
        // that test says "wall required" for every one of them, and the fleet walked.
        //
        // Damage is Fuzzy(viLevel / Random(10,15)) — about level/12 a blow — and it
        // depends on the LEVEL alone. Difficulty decides how often the blow lands and how
        // far it reaches, not how hard it hits. So the number that says whether an open
        // fight can be broken off is our health divided by that: a fungus beast does
        // about four to a 32-health character, which is eight exchanges, and eight is a
        // long time when a withdrawal takes one.
        const vNow = this.s.client?.vitals?.();
        const hpFrac = pct(vNow?.health);
        const vigNow = vNow?.vigor?.value ?? null;
        const myMax = vNow?.health?.max ?? null;
        const preyLvl = worth.level ?? null;
        const perBlow = preyLvl != null ? Math.max(1, preyLvl / 12) : null;
        const blowsWeCanTake = myMax != null && perBlow != null ? myMax / perBlow : null;
        const canFightOpen =
          hpFrac !== null && hpFrac >= (this.policy.openFightHealth ?? 0.9) &&
          // WHAT WE INTEND TO FIGHT, not what happens to be standing next to us.
          //
          // This asked threat().names — creatures inside the crowd radius right now — and
          // at the moment the room decision is taken that list is normally EMPTY, so the
          // bar fell back to the strict 130 every time and the relaxation never fired
          // once. Thirteen "REFUSING TO FIGHT HERE" entries and zero "fighting anyway"
          // across the whole fleet.
          //
          // The question being asked is whether to fight our PREY without a wall, so the
          // prey is what should set the bar; anything else in the room that is worse
          // still has to get past blowsWeCanTake and the room's own danger filter.
          vigNow !== null && vigNow >= vigorBarFor([this.policy.hunt, ...this.threat().names], this.policy) &&
          blowsWeCanTake !== null && blowsWeCanTake >= (this.policy.openFightBlows ?? 7);
        if (denied !== false && !this.hold && canFightOpen) {
          // ONE FLAG PER BRANCH, BECAUSE THE TRANSITION IS THE INTERESTING EVENT.
          //
          // Both branches shared `warnedOpenFight` and both SET it before logging, so a
          // character that refused a room once could never log fighting in it: the
          // refusal wrote the room number, and every later pass — including every pass
          // where the relaxation fired — found the flag already equal and said nothing.
          // "Fighting anyway" could only ever appear if the very first evaluation in a
          // room passed the gate, which for a fleet that starts tired is close to never.
          //
          // This cost two rounds of chasing a gate that was working. The counter sat at
          // 0 across both while kills broadened from three characters to seven and
          // fighting time went 2% to 7% — the behaviour had changed and the instrument
          // could not show it. A shared one-shot flag across two mutually exclusive
          // branches does not report a state, it reports whichever state was seen first.
          if (this.warnedFightingOpen !== room.num) {
            this.warnedFightingOpen = room.num;
            this.warnedOpenFight = null;   // so flipping back reports the change
            this.note('no safe wall here, but fighting anyway', {
              room: room.name, room_num: room.num, why_no_spot: denied,
              health_pct: Math.round(hpFrac * 100), vigor: vigNow,
              prey_level: preyLvl, my_max_health: myMax,
              blows_we_can_take: Math.round(blowsWeCanTake * 10) / 10,
              why: 'whole, well above the vigor band where the death rate collapses, and it ' +
                   'takes this thing seven or more blows to finish us — the wall is worth ' +
                   'having and is not worth another twenty minutes of walking to find' });
          }
        } else if (denied !== false && !this.hold) {
          this.tally.rooms_denied = this.noWallRooms.size;
          this.emptyPasses++;
          if (this.warnedOpenFight !== room.num) {
            this.warnedOpenFight = room.num;
            this.warnedFightingOpen = null;   // so flipping back reports the change
            this.note('REFUSING TO FIGHT HERE — no safe wall in this room', {
              room: room.name, room_num: room.num, why_no_spot: denied,
              prey_level: worth.level ?? null, my_level: worth.my_level ?? null,
              treated_as: 'a denial of service for this area until safe-wall detection improves',
              why: 'fighting in the open is the condition the wall exists to prevent, and this ' +
                   'detector is known to miss plain wall edges — so a miss here is not evidence ' +
                   'the room has no wall, which is exactly why we do not gamble on it',
              doing_instead: 'roaming to a room we can hold a square in' });
          }
          // LEAVING IS THE POINT, and it must not depend on `roam`.
          //
          // The first version only set emptyPasses and reported no progress, which
          // assumed the roam logic would carry the character out. Most of this fleet
          // runs roam:false so it stays in its assigned room — so the refusal became a
          // permanent stall, the supervisor restarted the keeper, the fresh keeper
          // re-probed the same room and refused again, once a minute. Eight characters
          // did that within a minute of the rule going live.
          //
          // A denied room is not a stall, it is a decision, and the decision is to go
          // somewhere else. Relocation is the same machinery the "this room cannot
          // produce our prey" branch uses, and preyRooms now excludes denied rooms so
          // it cannot pick another one of these.
          const elsewhere = this.preyRooms(room);
          if (elsewhere.length) {
            this.doing = 'travelling';
            // FORCED: the room has been denied for having no usable wall, so whatever is held
            // here is not the shelter the refusal exists to protect.
            await this.leaveHold('leaving a room with no wall in it', { force: true }).catch(() => {});
            const go = elsewhere[0];
            const moved = await this.travel(go.room, { maxHops: 14 })
                                    .catch(e => ({ arrived: false, reason: e.message }));
            if (moved.arrived) {
              this.homeRoom = go.room;
              this.emptyPasses = 0;
              this.placement.relocations++;
              this.note('left a room with no safe wall', {
                from: room.name, to: go.room_name, room: go.room,
                why: 'refused to fight here, so staying would be standing still for ever' });
              this.progress('left a room that cannot be fought in safely');
              return;
            }
            this.note('could not leave the wall-less room', {
              room: room.name, tried: go.room_name, why: moved.reason });
          } else {
            this.note('nowhere else to hunt this', {
              room: room.name, hunting: this.policy.hunt,
              why: 'every room that generates it is either unreachable or has already been ' +
                   'refused for having no wall',
              hint: 'this prey has no safely fightable room for this character — re-target it' });
          }
          // STANDING STILL WHILE SOMETHING CHEWS ON YOU IS NOT A DECISION, IT IS A GAP.
          //
          // This `return` sat four lines above "FIGHT WHAT IS ACTUALLY HITTING YOU", so a
          // character that found no wall and could not leave bailed out of the pass just
          // before the branch that would have swung back — and then did it again next
          // pass, and the pass after that. Beaker was found in Valley of Ileria at 29/29
          // with monsters in the room, reporting STALLED once a second and never lifting
          // its weapon. Every refusal on the way here is individually correct and the sum
          // of them is a punching bag.
          //
          // So the dead end stops ending the pass when the character is OTHERWISE READY TO
          // FIGHT and exactly one thing is on it. Three gates, and each rules out a way
          // that "might as well swing back" turns into a death:
          //
          //   ONE ATTACKER. A swarm is the commonest death in this fleet, and swinging at
          //   one of four is not a fight, it is choosing which one lands the last blow.
          //   Against a crowd the existing withdraw/leave path is still correct.
          //
          //   HEALTH WE WOULD NORMALLY OPEN ON. safety().engageAt is already the "do not
          //   start what you cannot finish" line (0.9 under 30 max health, 0.75 above).
          //   Below it the answer is to heal, not to trade blows without a wall.
          //
          //   A TARGET WE WOULD NORMALLY TAKE. refuseEngagement is the same band that
          //   killed Waldorf when nothing consulted it. Unrecognised or over the band and
          //   we withdraw, exactly as the retaliation branch does.
          //
          // Deliberately NOT a blanket "always swing". The whole safe-spot mechanic is
          // that nothing can hit you until you swing first, so retaliating is exactly
          // wrong while a spot is holding — which is why this lives in the branch where
          // there is provably no spot and no hold, and nowhere else.
          const onUs = this.inReachOfUs();
          const lone = onUs.length === 1 ? onUs[0] : null;
          const loneName = lone ? (c.rsc.get(lone.nameRsc) || '') : '';
          const vNow = c.vitals?.() ?? {};
          const hpNow = pct(vNow.health);
          const ready = hpNow == null || hpNow >= this.safety().engageAt;
          const refusedLone = lone ? this.refuseEngagement(loneName) : null;

          if (!lone || !ready || refusedLone) {
            if (onUs.length) this.note('not fighting my way out of this one', {
              room: room.name, in_reach: onUs.length,
              what: onUs.map(o => c.rsc.get(o.nameRsc)).filter(Boolean).slice(0, 4),
              health: hpNow == null ? null : Math.round(hpNow * 100) + '%',
              engage_at: Math.round(this.safety().engageAt * 100) + '%',
              why: !lone ? `${onUs.length} of them are in reach and a swarm without a wall is ` +
                           'how these characters die'
                   : !ready ? 'below the health we would open a fight at, so healing beats trading blows'
                   : `would not normally fight a ${loneName}: ${refusedLone.why}` });
            this.noProgress('no safe wall here and nowhere better to go');
            return;
          }
          this.note('no wall, nowhere to go, and one thing is on us — fighting back', {
            room: room.name, what: loneName,
            health: hpNow == null ? null : Math.round(hpNow * 100) + '%',
            why: 'one attacker, health we would open a fight at, and a target inside the band — ' +
                 'there is no spot to protect by holding fire and no exit to walk to, so the ' +
                 'only thing standing still buys is being hit for free' });
        }
      }

      // FIGHT WHAT IS ACTUALLY HITTING YOU, not only what you came for.
      //
      // Farm mode named one creature and fought only that, which is correct as a
      // statement of intent and fatal as a policy: the rooms are shared. Every room a
      // Qor character can legally hunt in is 50-75% BABY SPIDER and only 25-50%
      // centipede, so a Qor student attacks its centipede while two or three spiders
      // it is deliberately ignoring chew on it from behind. Thirteen of the last
      // twenty deaths in this fleet were the five Qor characters, and this is why —
      // not their karma, which is the story I first reached for, but the fact that
      // they alone are hunting the MINORITY spawn in every room open to them.
      //
      // So: if something attackable is adjacent and it is not the prey, it is the
      // prey now. Refusing to hit back is not a strategy.
      // Re-read where we are: taking a spot may have walked us across the room, and
      // "adjacent" computed from before the walk is a different question.
      const here = c.self;
      // See inReachOfUs() for why fleetmates are excluded and why the radius is 3.
      const adjacent = here ? this.inReachOfUs() : [];
      const want = String(this.clearing || this.policy.hunt || '').toLowerCase();
      const bystander = adjacent.find(o =>
        !(c.rsc.get(o.nameRsc) || '').toLowerCase().includes(want));

      // HITTING BACK IS STILL A CHOICE, AND IT IS NOT ALWAYS THE RIGHT ONE.
      //
      // "Refusing to hit back is not a strategy" is true of a baby spider chewing on a
      // Qor student, which is the case this branch was written for. It is not true of
      // four soldiers of the Princess' army, and the branch could not tell them apart
      // because it asked nothing about what it was swinging at.
      //
      // So the same question capBlockers asks before CLEARING a room is now asked before
      // RETALIATING in one. A refused attacker is not ignored — ignoring it really is how
      // these characters die — it is escaped from: withdraw, which retreats to a wall
      // where the health timer can run, and failing that leaves the room. Standing and
      // trading blows with something outside our band is the one option removed.
      const refused = bystander ? this.refuseEngagement(c.rsc.get(bystander.nameRsc)) : null;
      if (refused) {
        this.note('will not trade blows with this', {
          creature: refused.name, level: refused.level, rating: refused.rating,
          adjacent: adjacent.length, why: refused.why,
          instead: 'leaving the room entirely — hitting back at something outside our ' +
                   'safety band is how a level-27 character dies at full health, and so is ' +
                   'stepping four squares away from it' });
        this.tally.refused_retaliation = (this.tally.refused_retaliation || 0) + 1;
        // WALKING A FEW SQUARES FROM A TROLL IS NOT ESCAPING A TROLL.
        //
        // This called withdraw(), which retreats to a wall a few squares off. Against
        // something inside our band that is right — the wall is the whole advantage.
        // Against something OUTSIDE it, which is exactly the case this branch has just
        // identified, it is not a retreat at all: GetVisionDistance is 4 + difficulty/2
        // (monster.kod:1676), so a troll at difficulty 8 sees eight squares and a
        // groundworm at 5 sees six. There is no square in the room that is out of range.
        //
        // The border of the Badlands is what this costs. Measured over all history: a
        // successful crossing takes a median of 15.8 seconds, and the median DEATH
        // there had been in the room 208 seconds — thirteen times longer. The fastest
        // of 24 was 32 seconds, still twice a crossing, and not one died faster than a
        // median crossing. Nobody dies passing through; they die refusing, shuffling
        // four squares, being followed, and refusing again. 51 of 52 of them were
        // nominally hunting giant rats, in a room that generates none — only trolls at
        // attack rating 750 and groundworms at 600.
        await this.retreatToSafety({
          because: 'refused to fight ' + refused.name + ' (rating ' + refused.rating + ')',
          adjacent: adjacent.length,
        });
        this.progress('left the room rather than trade blows with something out of band');
        return;
      }

      // `clearing` is a target for THIS PASS only — a creature we are killing to free
      // the room's cap, not a change of orders. policy.hunt is never rewritten by it.
      let engageName = bystander ? c.rsc.get(bystander.nameRsc)
                                 : (this.clearing || this.policy.hunt);
      if (bystander)
        this.note('hitting back', { target: engageName, instead_of: this.policy.hunt,
                                    why: 'it is adjacent and attacking; ignoring it is how these characters die' });

      // SWING AT WHAT MY PARTNER IS SWINGING AT.
      //
      // This is the whole of the party. Advancement needs that WE damaged it and that
      // it was OUR current target when it died, per character — so two characters on
      // one creature both advance from one corpse, and two characters on two creatures
      // are two solo fights sharing a room, with the danger of both and the benefit of
      // neither.
      //
      // Deliberately below the bystander rule: something already hitting us outranks
      // convergence, because ignoring it is how these characters die, and a partner
      // whose target we cannot see is not a target at all.
      let partyFoe = null;
      if (!bystander) {
        const agreed = party.agreedTarget(this.s.name);
        const seen = agreed ? c.room.objects.get(agreed.id) : null;
        if (seen && (seen.flags & OF.ATTACKABLE) && !(seen.flags & OF.PLAYER)) {
          partyFoe = seen;
          engageName = c.rsc.get(seen.nameRsc) || engageName;
          if (this.foeId !== seen.id)
            this.note('joining my partner\'s fight', {
              target: engageName, partner: agreed.from,
              why: 'both of us have to land a hit on the same creature for both of us to ' +
                   'advance from it — a kill only scores for a character that damaged it' });
        }
      }

      // DO NOT START A PAIRED FIGHT ALONE.
      //
      // Everything that makes a fungus beast survivable at level 30 assumes two
      // characters: the damage is split between them while each regenerates on its own
      // clock, and it dies in half the time. One character doing it alone is not
      // running the plan at reduced efficiency, it is running a different and much
      // worse plan — the whole margin is the second swinger.
      //
      // So a partnered character whose partner is elsewhere waits rather than engages.
      // The wait is cheap and self-correcting: the partner is walking to the same
      // assigned room, and the rejoin logic puts it back if it dropped.
      if (this.policy.partner && !party.together(this.s.name, room?.num ?? null)) {
        const mate = party.mateOf(this.s.name);
        this.doing = 'travelling';
        this.waitedForMate = (this.waitedForMate || 0) + 1;

        // THE WAIT WAS NOT SELF-CORRECTING, AND IT WAS NOT CHEAP.
        //
        // The note below says the partner is walking to the same assigned room. It very
        // often is not: characters drift, the supervisor re-deploys one of a pair, and
        // the two simply stay in different rooms. Measured on the fleet: 15 of 18 paired
        // characters were in a different room from their partner, and Gonzo had been
        // waiting 640 CONSECUTIVE PASSES. Every one of those waiting characters had zero
        // kills; the only three killing anything were the unpaired ones.
        //
        // So bound it. First go to them — the pairing is worth keeping and the partner's
        // room is known. If that keeps failing, engage alone: a worse plan than the pair,
        // and an enormously better one than standing still for an hour.
        if (this.waitedForMate > 8 && mate?.room != null && mate.room !== room?.num) {
          this.note('going to my partner rather than waiting for it', {
            partner: this.policy.partner, they_are_in: mate.room, waited_passes: this.waitedForMate,
            why: 'the wait assumed they were walking to meet us and they are not — 640 passes ' +
                 'of waiting was the record before this was bounded' });
          const t = await this.travel(mate.room, { maxHops: 8 })
                              .catch(e => ({ arrived: false, reason: e.message }));
          if (t.arrived) { this.waitedForMate = 0; this.progress('joined my partner'); return; }
          this.note('could not reach my partner', { why: t.reason ?? 'refused' });
        }
        if (this.waitedForMate > 20) {
          this.note('engaging without my partner', {
            partner: this.policy.partner, waited_passes: this.waitedForMate,
            why: 'we could neither meet nor reach them. Fighting this alone is the worse ' +
                 'plan and standing here is not a plan at all — nothing has been earned ' +
                 'in twenty passes of waiting' });
          this.waitedForMate = 0;
          // fall through to the ordinary fight path
        } else {
        this.note('waiting for my partner before engaging', {
          waited_passes: this.waitedForMate,
          partner: this.policy.partner,
          they_are_in: mate?.room ?? 'unknown — no fresh reading',
          i_am_in: room?.num ?? null,
          why: 'this prey is only survivable as a pair: two of us split what it deals and each ' +
               'heal at our own rate. Alone it is simply a stronger monster',
          note: mate ? undefined
            : 'no fresh report from them at all — they may be logged out, in which case the ' +
              'broker rejoins them within 45s' });
        // Rest while waiting rather than standing about: arriving at full is the point.
        await skills.restUntil(this.s, { health: 0.98, vigor: REST_VIGOR_CAP, maxSeconds: 20 })
                    .catch(() => {});
        // NOT progress(). Calling it here is why nobody noticed: progress clears the
        // stall detector, so a character waiting for a partner it will never meet looked
        // busy and honest for 640 passes and never once reported itself stuck.
        this.noProgress(`waiting for ${this.policy.partner}, who is in ${mate?.room ?? 'somewhere unknown'}`);
        return;
        }   // end of "still willing to wait"
      }

      // WHOEVER IS BEING HURT STOPS SWINGING. The monster chooses who it hits and
      // nothing in the protocol tells us who that is, so there is no tanking rota to
      // run — only the observable fact that one of us is losing health faster.
      //
      // CRITICALLY, BREAKING OFF MUST NOT RE-TARGET. Stopping costs nothing; switching
      // to something else resets both advancement flags and throws away the credit for
      // every hit already landed. So this returns without touching foeId, and the
      // healing happens exactly where we stand — behind the wall we already hold.
      if (this.policy.partner && this.hold) {
        const role = party.roleFor(this.s.name,
          { health: hp, floor: this.policy.partyHealBelow ?? 0.5 });
        if (role === 'heal') {
          this.doing = 'recovering';
          const h = await skills.healUp(this.s, { target: 0.95 }).catch(() => ({ healed: false }));
          this.recordHealUse(h, 'partner is carrying the fight while I heal');
          this.note('stepping out of the fight to heal', {
            health: hp == null ? null : Math.round(hp * 100) + '%',
            floor: this.policy.partyHealBelow ?? 0.5,
            partner: this.policy.partner, still_targeting: this.foeId ?? null,
            healed: !!h.healed,
            why: 'my partner keeps swinging while I come back up. Not re-targeting: a kill ' +
                 'only pays a character that damaged it AND still has it targeted' });
          this.progress('healing while my partner holds the fight');
          return;
        }
      }

      // Something has come to the wall and we have never tested this square: watch it
      // for a pass before hitting it. This is the only way proof ever arrives on
      // purpose rather than by accident. See maybeTestSpot().
      if (this.maybeTestSpot(adjacent)) return;

      this.doing = 'fighting';
      // The measurement the vigor floor exists for: not what we intended to set out
      // at, but what we actually swung at.
      const vAt = vigorOf(this.s.client?.vitals?.() ?? {});
      if (vAt != null) {
        const V = this.vigor;
        V.engagements++;
        V.total_at_engage += vAt;
        V.lowest_at_engage = V.lowest_at_engage == null ? vAt : Math.min(V.lowest_at_engage, vAt);
        if (vAt < WANT_FIGHT_VIGOR) V.below_want++;
      }
      const holding = !!this.hold;
      // TELL THE PARTNER WHAT WE ARE ABOUT TO HIT, before hitting it. Declaring after
      // the swing means the first exchange of every fight is two characters choosing
      // independently, which is the one moment convergence is worth most — whoever
      // gets there first sets the target and the other joins on its next pass.
      const swingAt = bystander ? bystander.id : (partyFoe ? partyFoe.id : this.foeId);
      if (this.policy.partner) party.declareTarget(this.s.name, swingAt ?? null, engageName);
      const f = await skills.fight(s, { target: engageName,
                                        preferId: swingAt,
                                        disengageAt: safe.fleeAt, loot: true,
                                        holdPosition: holding, reach: REACH,
                                        weaponPriority: this.policy.weaponPriority });

      // NOTHING IN REACH, AND WE ARE NOT GOING TO CHASE IT. fight() refuses to walk
      // while we are holding, which is correct and leaves the interesting half to us:
      // a monster that will not come to the wall has to be fetched. Hit it once and
      // walk back, and the fight happens where we chose.
      if (f.out_of_reach) {
        // WE PULLED LAST PASS AND WE ARE STILL STANDING HERE ALONE. The pull did what it
        // said and the monster never arrived, so this square is a candidate for the
        // cliff. Ask before pulling again, or we spend the afternoon proving it.
        if (this.pulledLastPass && this.pullDidNotConvert(f.reason || 'still nothing in reach'))
          return;
        const quarry = found.find(o => o.id === f.nearest?.id) || found[0];
        const p = quarry ? await this.pull(quarry) : { pulled: false, why: 'nothing to pull' };
        if (p.pulled && p.back) {
          this.pulledLastPass = true;
          // DELIBERATELY NOT progress(). A pull is not an achievement, it is an attempt,
          // and calling it progress is what kept the stall detector quiet through hours
          // of this. Contact is the achievement, and the fight path below reports that.
          this.note('waiting for it at the wall', {
            target: p.target, pull_attempt: (this.pullsWithoutContact ?? 0) + 1,
            why: 'it has been hit and is following; the next pass fights it from here — ' +
                 'if it never arrives, the square gets written off' });
        } else {
          // Fetching failed. Give the spot up — but REMEMBER that it cannot be used,
          // or the next pass picks the identical square for the identical reason and
          // the keeper spends its life walking between a wall and a decision. Cedric
          // did exactly that at the Tos gate: take, fail, release, take, fail.
          const room2 = s.world?.room;
          if (room2?.num != null && this.hold) {
            (this.barrenSpots ??= new Map());
            const set = this.barrenSpots.get(room2.num) ?? new Set();
            set.add(`${this.hold.col},${this.hold.row}`);
            this.barrenSpots.set(room2.num, set);
          }
          this.note('could not bring it to the wall', {
            why: p.why, target: p.target,
            note: 'that square is now excluded in this room — nothing can be fetched to it' });
          this.releaseHold('nothing can be pulled to it from here');
          this.noProgress('holding a spot nothing will come to');
        }
        return;
      }
      // We got a fight. Whatever we are standing on can be fought from, so the cliff
      // counter resets — this is the only evidence that actually settles the question.
      if (f.rounds > 0) { this.pullConverted(); this.pulledLastPass = false; }
      this.swungAt = Date.now();
      this.foeId = f.foe_id ?? null;
      // fight() can now tell death apart from a stale object id. If it is the
      // latter, reconnecting fixes it; treating it as death would loop forever.
      if (f.stale_identity) {
        this.note('stale object id during a fight — reconnecting', { why: f.note });
        await this.reconnect('clearing a stale object id mid-fight');
        this.noProgress('reconnected after a stale object id');
        return;
      }
      // WE BROKE OFF. GO ALL THE WAY.
      //
      // This branch did not exist, which is why the fleet has been dying at a fifth of
      // its health bar standing perfectly still. `fight()` set `disengaged`, wrote a
      // note saying to walk away, and returned into code that read neither.
      //
      // Behind a wall the advice inverts and `fight()` says so: sitting still IS the
      // recovery there, because nothing can land a blow unless we swing first. So a
      // held safe spot rests where it stands; everything else leaves the room.
      if (f.disengaged) {
        const hp = v.health?.max ? Math.round(100 * v.health.value / v.health.max) + '%' : null;
        if (holding && this.holdWorks?.()) {
          this.note('broke off behind the wall — resting here rather than running', {
            at_health: f.disengaged.at_health, mid_round: !!f.disengaged.mid_round,
            why: 'nothing can hit us on this square unless we swing first, so standing still ' +
                 'is a free heal and walking off it would start the damage' });
        } else {
          await this.retreatToSafety({
            because: 'broke off a fight at ' + (f.disengaged.at_health ?? hp),
            mid_round: !!f.disengaged.mid_round,
            still_here: (this.inReachOfUs() ?? []).length,
          });
          this.progress('retreated after breaking off a fight');
          return;
        }
      }
      const looted = (f.looted || []).map(x => x.name + (x.amount ? ` x${x.amount}` : ''));
      if (f.killed) {
        this.tally.kills++;
        this.killTimes.push(Date.now());
        if (this.killTimes.length > 500) this.killTimes.shift();
        // ON THE FEED, WITH THE CREATURE AND THE ROOM. The tally counts; this remembers
        // what and where, which is what makes a max-health gain attributable to the thing
        // that paid for it. Ten per character, in memory — see m59-tougher.mjs.
        tougher.recordKill(this.who(), {
          creature: f.target, room: room?.name ?? null, room_num: room?.num ?? null,
          level: v.health?.max ?? null, rounds: f.rounds, looted, from_safe_spot: !!holding,
        });
        // AND INTO THE LONG RECORD, because every in-process count of a kill is wiped
        // constantly. `tally.kills` and `killTimes` are both fields on this object, and
        // the supervisor restarts keepers about once a minute — so both really mean
        // "since the last restart", and the board column asking "is this character
        // earning RIGHT NOW" was answered from a counter that had been zeroed since the
        // last kill. Measured: the fleet killed at least 26 things in half an hour while
        // every kills/30m on the page read 0. countKills() in m59-ledger.mjs counts these
        // instead, and this is the only thing that survives a keeper.
        this.ledgerEvent('killed', {
          creature: f.target, room: room?.name ?? null, room_num: room?.num ?? null,
          rounds: f.rounds, from_safe_spot: !!holding,
          looted: looted.length ? looted.join(', ') : undefined,
        });
        // A kill means the wilderness is working again, so the run of flees that would
        // otherwise accumulate over a long healthy session is cleared. Without this a
        // character that fled three times an hour ago gets marched to town mid-fight.
        this.fledInARow = 0;
        // Remember where the work is. This is what roaming steers back toward.
        if (room?.num != null) this.homeRoom = room.num;
        this.progress('killed something');
      } else this.noProgress(f.died ? 'died in a fight' : 'broke off without a kill');
      this.countLoot(looted);
      this.note(f.killed ? 'killed' : (f.died ? 'died' : 'broke off'), {
        target: f.target, rounds: f.rounds, looted,
        health: f.health?.after?.value, why: f.note,
        ...(holding ? { from_safe_spot: { col: this.hold?.col, row: this.hold?.row,
                                          proven: this.holdWorks() } } : {}),
        ...(f.refused?.length ? { left_on_the_floor: f.refused.length } : {}),
      });
      return;
    }

    this.note('nothing to do', { health: v.health, vigor: v.vigor, room: room?.name });
  }

  // BE ANSWERABLE. A character that never replies is not just rude, it is a dead
  // end: someone offering a newly-killed bot a weapon has no way to tell whether
  // anyone is home, and gives up. Two things are worth doing every pass, both
  // cheap because they read state we already have.
  async social() {
    const s = this.s, c = s.need();

    // 1. Take gifts. A trade where the other side has put something up and we have
    //    put up nothing is a hand-out, and the way to accept one is to counter with
    //    nothing — countering is what grants the other side permission to accept.
    //    Only ever counter EMPTY, so this can never give our own things away.
    const t = c.trade;
    if (t && t.withId && (t.theirs?.length) && !(t.ours?.length)) {
      try {
        await s.pacer.submit('trade', () => c.counterOffer([]));
        this.note('accepted a gift', { from: t.withName,
                                       items: t.theirs.map(i => i.name + (i.amount > 1 ? ` x${i.amount}` : '')) });
        this.progress('someone gave us something');
        // Put it to use immediately — a donated sword is no help in the pack.
        await skills.equipBest(s).catch(() => {});
      } catch (e) { this.note('could not accept a gift', { why: e.message }); }
    }

    // 2. Answer anyone who says our name. Rate-limited, because the reply goes to
    //    the whole room and a keeper that chatters every eight seconds is worse
    //    than one that says nothing.
    const evs = c.eventsSince(this.socialCursor || 0).filter(e => e.kind === 'said');
    this.socialCursor = c.evSeq;
    const myName = (c.me?.name || '').toLowerCase();
    if (!myName) return;
    const toMe = evs.filter(e => e.speaker !== c.selfId &&
                                 String(e.text || '').toLowerCase().includes(myName));
    if (!toMe.length) return;
    if (Date.now() - (this.lastReply || 0) < 25000) return;
    this.lastReply = Date.now();

    const v = c.vitals();
    const hp = v.health ? `${v.health.value}/${v.health.max}` : '?';
    const wielding = (c.inventory || []).length ? '' : ' I have nothing on me.';
    const what = this.policy.hunt ? `hunting ${this.policy.hunt}` : 'not hunting anything';
    const stalled = this.stalledSince ? ` I am stuck: ${this.stalledWhy}.` : '';
    const reply = `${c.me.name}: ${what}, ${hp} health.${wielding}${stalled} ` +
                  (this.needsRecovery || !(c.inventory || []).length
                    ? 'Gear or shillings would help enormously.'
                    : 'Thanks for asking.');
    try {
      await s.pacer.submit('say', () => c.say(reply));
      this.note('answered someone', { heard: toMe[toMe.length - 1].text?.slice(0, 80), said: reply });
    } catch (e) { this.note('could not answer', { why: e.message }); }
  }

  // Rearm after dying, and if we cannot, say so out loud where people are.
  //
  // Dying drops everything, so the character wakes with nothing. First try the
  // obvious: re-wield whatever survived. If there is genuinely no weapon, ask —
  // broadcasting for a hand-out at an inn is what a newly-dead player actually
  // does, and in a world with other agents in it, it is a strategy rather than a
  // gesture. Kept to one message per death: the same channel carries a mana cost
  // and a social one.
  // Heal whoever else is standing here, if we can.
  //
  // Minor heal (heal.kod:100) is worth far more in this fleet than its name suggests:
  //     iHeal = random(1,5) + (power+1)/20 + target_karma/20, bounded to 10
  //     ... PLUS random(2,5) again if the target is not yet PKILL_ENABLE
  // Every character here is under 30 base health, so every one of them qualifies for
  // that newbie bonus — up to ten points for three mana and one herb. It also pays
  // the CASTER: healing someone whose karma is higher than yours awards karma, which
  // is exactly the direction a Shal'ille student needs to move.
  //
  // And casting is how abilities improve at all, so a Shal'ille character with a
  // wounded ally in the room has a move that heals the ally, trains the spell, and
  // raises its own karma in one action. There is no reason not to take it.
  async medic() {
    const s = this.s, c = s.need();
    const MEDIC_GAP_MS = 45_000;
    if (this.lastHealAt && Date.now() - this.lastHealAt < MEDIC_GAP_MS) return;

    const spell = (c.spells || []).find(sp => /^(minor heal|heal)$/i.test(c.rsc.get(sp.nameRsc) || ''));
    if (!spell) return this.declinedCast('heal', 'the character does not have the spell');
    const mana = c.vitals()?.mana;
    if (mana && mana.value < 4)                            // 3 to cast, leave a margin
      return this.declinedCast('heal', 'not enough mana', { mana: mana.value, needs: 4 });

    // Another player, not us, not a monster.
    // Raw room objects carry flags, not the snapshot's derived booleans — `is_player`
    // is computed in the world model and does not exist here.
    const other = [...c.room.objects.values()]
      .find(o => o.id !== c.selfId && (o.flags & OF.PLAYER));
    if (!other) return this.declinedCast('heal', 'nobody else in the room to heal');

    this.lastHealAt = Date.now();
    await s.pacer.submit('cast', () => c.cast(spell.id, [other.id]), 1050);
    const ev = await c.waitFor({ kinds: ['message', 'stat'], timeoutMs: 3000 }).catch(() => ({ events: [] }));
    this.tally.heals_given = (this.tally.heals_given || 0) + 1;
    // A heal cast on someone else has no inventory diff to prove it landed, so `ok`
    // here means "the cast went out", not "they were healed". Said plainly rather than
    // borrowing the confidence the creation spells earn from a changed pack.
    this.recordCast(c.rsc.get(spell.nameRsc) || 'heal', {
      ok: true, target: c.rsc.get(other.nameRsc),
      why: 'a wounded ally in the room: heals them, trains the spell, raises our karma',
      mana_before: mana?.value ?? null, mana_after: c.vitals?.()?.mana?.value ?? null });
    this.note('healed someone', {
      target: c.rsc.get(other.nameRsc), spell: c.rsc.get(spell.nameRsc),
      said: ev.events?.filter(e => e.text).map(e => e.text).slice(0, 2),
      why: 'heals them, trains the spell, and raises our karma if theirs is higher' });
    this.progress('cast a heal on an ally');
  }

  // TELL PEOPLE WHERE THE BODY IS.
  //
  // A death is broadcast to the whole world ("### Yorick was just killed by a
  // troll."), and the usual reply is somebody asking "where?". The dead player is
  // the one person who cannot answer at scale: dying costs all your mana, and a
  // broadcast costs mana. But a TELL is cheap, and whoever asked still has theirs —
  // so the protocol players actually use is: the corpse tells one person, that
  // person broadcasts, and the room fills up.
  //
  // Everything needed is already recorded. `lastDeath` has the room and the health
  // trail; all that was missing was answering the question.
  async answerWhere() {
    const s = this.s, c = s.need();
    const box = inboxIfAny(this.s.name);
    if (!box || !this.lastDeath) return;

    // Anything recent that reads like someone asking after the body.
    const since = this.lastDeath.at - 60_000;
    const asks = box.select({ since, limit: 20 })
      .filter(m => /where|where\?|what room|which room|loc|location/i.test(m.text || ''));
    for (const m of asks) {
      if (this.answered?.has(m.id)) continue;
      (this.answered ??= new Set()).add(m.id);
      const d = this.lastDeath;
      const where = d.died_in || 'somewhere I could not name';
      const at = d.room_num != null ? ` (room ${d.room_num})` : '';
      const spot = d.at_col != null ? `, around col ${d.at_col} row ${d.at_row}` : '';
      const text = `${where}${at}${spot}. Killed by ${d.killed_by?.join(' and ') || 'something'}. ` +
                   `I have no mana to broadcast it — please pass it on if you would.`;
      try {
        await s.pacer.submit('say', () => c.tell(m.from_id ?? m.fromId, text));
        this.note('told someone where the body is', { to: m.from ?? m.from_name, where, text });
        this.progress('answered a where');
      } catch (e) {
        this.note('could not answer where', { why: e.message });
      }
    }
  }

  // HIT WHILE RESTING. The one response that must never happen is the one that used
  // to: note it and rest again next pass on the same square.
  //
  // Being hit while resting is proof that this is not a place to rest — resting is
  // standing still and not swinging, which is the one thing a working safe spot makes
  // free. So do the two things that change the situation, in the order that makes both
  // of them work:
  //
  //   RECONNECT first. It drops the aggro of whatever is on us and hands back the entry
  //   grace period, so the walk out is made past monsters that have to notice us one at
  //   a time. It costs nothing we were not already losing: health regeneration is gated
  //   on PFLAG_MOVED_SINCE_ENTRY, so we cannot heal until we have moved anyway.
  //
  //   THEN take a real wall, rather than sitting back down where we are. Since we have
  //   to move before we can heal regardless, we may as well move somewhere that holds.
  //
  // Only after both is resting allowed again, and by then it is a different square.
  async restBroken(room, near) {
    this.tally.rests_broken = (this.tally.rests_broken || 0) + 1;
    // A BROKEN REST WITH NOTHING NEXT TO US IS NOT EVIDENCE ABOUT THE SQUARE.
    //
    // observe() has always refused this reading — `nothing was in swing range, a quiet
    // window with nothing to be quiet about` — and it refuses it for BOTH verdicts,
    // because a window with no attacker in it says nothing either way. This path never
    // had the guard, and it is the path that fires in a town: a character crosses Tos,
    // sits down, the rest is interrupted by something that is not a monster, and the
    // paving stone it happened to stop on is condemned for ever.
    //
    // It wrote 130 of the book's 474 failures that way — 27% of all the evidence we had
    // — and 116 of those are in five rooms with nothing hostile in them at all: 58 in
    // The Streets of Tos, 17 in the Sparkling Stone Shop, 15 in South Barloque, 14 in
    // Familiars, 12 in Marion. Every recorded square in all five is a phantom, written
    // ten seconds apart along a walking route.
    //
    // Worse than the count is the SHAPE: those squares are open floor, so they poisoned
    // every comparison of one selection rule against another in exactly the direction
    // that flatters "prefer a wall". A metric graded against them scores well for the
    // wrong reason.
    //
    // The rest is still broken, and everything below still runs. All this refuses to do
    // is blame the square when nothing was there to blame it for.
    if (this.hold && !near.length) {
      this.note('rest broken with nothing in reach — not counted against this square', {
        where: { col: this.hold.col, row: this.hold.row }, room: room?.num,
        why: 'a rest can be interrupted by things that are not an attack, and a window ' +
             'with no attacker in it is not a reading. See observe(), which has always ' +
             'refused the same window' });
    }
    // Evidence first, while we still know which square failed.
    if (this.hold && near.length) {
      this.book.failed(this.hold.room, {
        col: this.hold.col, row: this.hold.row, damage: 1, attackers: near.length });
      this.book.save();
      this.note('THIS IS NOT A SAFE SPOT', {
        where: { col: this.hold.col, row: this.hold.row }, room: room?.num,
        attackers: near.length, proven_against: this.hold.mostAttackers ?? 0,
        why: 'we were hit while resting, which is standing still and not swinging — the ' +
             'one thing that cannot happen in a working spot',
        caveat: 'found by the rest rather than by observe(), so it is one reading like any ' +
                'other: it demotes the square, and a second stops it being recommended' });
      this.releaseHold('we were hit while resting in it');
    } else if (!this.hold) {
      this.note('hit while resting in the open', { room: room?.num, attackers: near.length,
        why: 'there was no wall at our back; this is the case the safe spot exists for' });
    }
    // The third case — holding a spot, rest broken, nothing in reach — is noted above and
    // deliberately falls through without releasing the hold. There is no evidence against
    // the square, so giving it up would throw away a working wall over a hunger tick.

    // Shed the aggro before walking anywhere.
    let dropped = false;
    if (this.policy.breakOutViaLogoff !== false) {
      const rc = await this.reconnect('hit while resting — shedding aggro before moving')
                           .catch(e => ({ ok: false, why: e.message }));
      dropped = !!rc?.ok;
      this.note(dropped ? 'reconnected to shed aggro' : 'could not reconnect', {
        why: dropped
          ? 'the entry grace period is handed back, so the walk to a real spot is made past ' +
            'monsters that have to notice us one at a time'
          : rc?.why });
    }
    // Then go and get a wall. Not resting again until we have one.
    if (this.policy.useSafeSpots) {
      const got = await this.takeSafeSpot('hit while resting — need a square that holds',
                                          near[0] ?? null).catch(() => false);
      this.note('moving rather than resting again', { got_a_wall: !!got, shed_aggro: dropped,
        why: 'resting again where we were just hit is the loop that kills characters "while resting"' });
    }
    this.progress('left a square that could not be rested in');
  }

  // MAKE THE TRIP, once there is enough in the purse to be worth it.
  //
  // bankSurplus() only ever fired when a character HAPPENED to be standing in a bank —
  // sound for the strategies that pass through town, and dead code for `fieldrest`,
  // whose whole point is that it never goes. The fleet ran that way for hours and
  // accumulated 35,920 shillings in pockets, single characters holding five thousand,
  // every coin of it on the floor the moment they died.
  //
  // This is what a player does instead: at a few thousand you stop what you are doing
  // and walk to Jasper or Tos, whichever is nearer, because it is the only way a death
  // is a setback rather than a reset. The walk is not free and neither is dying with
  // 5,840 on you.
  //
  // No return leg is needed. A bank is a town room and generates no prey, so the
  // relocation in farm() sends the character back to its assignedRoom on the next pass
  // — the same mechanism that used to scatter the fleet, working for us.
  async bankRun() {
    const above = this.policy.bankAbove;
    if (!above) return false;                       // 0 or null turns the trips off
    const s = this.s, c = s.need();
    const room = s.world?.room;
    if (!room || BANKS.some(b => b.room === room.num)) return false;   // already there
    // Wait for the reply, not just the request. Reading c.inventory straight after
    // submitting reads the PREVIOUS snapshot, which is the whole family of bugs this
    // file keeps re-learning.
    await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
    const carried = (c.inventory || [])
      .filter(o => /shilling/i.test(c.rsc.get(o.nameRsc) || ''))
      .reduce((t, o) => t + (o.amount || 1), 0);
    if (carried <= above) {
      // Say what we saw, occasionally. A threshold that never trips is indistinguishable
      // from one that is never checked, and that cost an eight-minute run to find out.
      if (carried > 0 && (!this.notedPurse || Date.now() - this.notedPurse > 120_000)) {
        this.notedPurse = Date.now();
        this.note('carrying, but under the banking threshold', { carrying: carried, banks_at: above });
      }
      return false;
    }

    // Jasper and Tos share one account, so the only question is which is nearer.
    // world.route() returns {found, hops:[...]}, NOT an array — taking .length off it
    // gives undefined, every bank scores Infinity, and the character stands in a field
    // with 5,840 shillings reporting that it cannot reach a bank seven hops away.
    const options = BANKS
      .map(b => { const r = s.world?.route?.(b.room);
                  return { ...b, hops: r?.found ? r.hops.length : Infinity }; })
      .sort((x, y) => x.hops - y.hops);
    const target = options[0];
    if (!Number.isFinite(target.hops)) {
      if (!this.warnedNoBank) {
        this.warnedNoBank = true;
        this.note('cannot reach a bank', { carrying: carried, tried: options.map(o => o.name) });
      }
      return false;
    }

    this.doing = 'travelling';
    this.note('going to the bank', {
      carrying: carried, to: target.name, hops: target.hops, keeping: this.policy.walkingMoney ?? 400,
      why: 'everything carried is dropped on death and usually unrecoverable; a balance is not' });
    if ((await this.leaveHold('walking to the bank')).refused) return true;
    const r = await this.travel(target.room, { maxHops: Math.max(12, target.hops + 4) })
                    .catch(e => ({ arrived: false, reason: e.message }));
    this.money.trips++;
    if (!r.arrived) {
      this.money.trips_failed++;
      if (this.money.why_not.length < 6) this.money.why_not.push({ to: target.room, why: r.reason || 'did not arrive' });
      this.noProgress('could not reach the bank');
      return true;                                   // the pass was spent walking either way
    }
    await this.bankSurplus().catch(() => {});
    this.progress('banked the takings');
    return true;
  }

  // BANK THE MONEY BEFORE GOING BACK OUT.
  //
  // Dying drops your ENTIRE inventory on a corpse you usually cannot return to, and
  // shillings are inventory. Bank deposits are not. This fleet has already proved the
  // point the expensive way: twenty-three deaths, and an audit afterwards found
  // nineteen of twenty-five characters wearing nothing and most carrying no money at
  // all — everything they had earned was lying on corpses across the world.
  //
  // With a balance, a death costs a point of maximum health and an errand. Without
  // one it costs everything and the character restarts from nothing, which is the
  // difference between a setback and a spiral. Jasper and Tos share one banking
  // system, so either counter will do.
  //
  // Keep a float in hand for flasks and food; bank the rest.
  async bankSurplus() {
    const s = this.s, c = s.need();
    const FLOAT = this.policy.walkingMoney ?? 400;
    const room = s.world?.room;
    if (!room) return;
    const teller = [...c.room.objects.values()]
      .find(o => /bank/i.test(c.rsc.get(o.nameRsc) || '') ||
                 affordances(o.flags).includes('bank'));
    // Only when we happen to be standing in a bank — a special trip is not worth the
    // walk, and the trader/wellfed loops already pass through town.
    if (!teller && !/bank/i.test(room.name || '')) return;

    await s.pacer.submit('read', () => c.requestInventory());
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });
    const purse = c.inventory.find(o => /shilling/i.test(c.rsc.get(o.nameRsc) || ''));
    const carried = purse?.amount ?? 0;
    if (carried <= FLOAT) return;

    const put = carried - FLOAT;
    this.doing = 'trading';
    // The client speaks to the teller directly; there is no skills wrapper for this.
    const r = await s.pacer.submit('bank', () => c.deposit(put))
                    .then(() => c.waitFor({ kinds: ['message'], timeoutMs: 3000 }))
                    .then(ev => ({ said: ev.events?.filter(e => e.text).map(e => e.text).slice(0, 2) }))
                    .catch(e => ({ error: e.message }));
    this.note(r.error ? 'could not bank' : 'banked the surplus', {
      deposited: r.error ? undefined : put, kept: FLOAT, why: r.error, said: r.said,
      because: 'money in hand is lost on death; money in the bank is not' });
    if (!r.error) { this.tally.banked = (this.tally.banked || 0) + put; this.progress('banked money'); }
  }

  // LOG OFF RATHER THAN DIE.
  //
  // This is the single most effective survival move in the game and it is not a
  // trick so much as a documented mechanic. NotifyMonstersOfPresence
  // (user.kod:3114) carries the comment: "When a player first enters the room, the
  // game will prevent AIs from attacking that player until that player takes an
  // action." That grace period is real, it applies on every entry including a
  // reconnect, and PFLAG_MOVED_SINCE_ENTRY is what ends it.
  //
  // Crucially, UC_REST goes straight to StartResting (user.kod:1480) WITHOUT calling
  // NotifyMonstersOfPresence — so resting does not wake anything. Moving, turning,
  // attacking, casting and picking things up all do.
  //
  // The honest limit, because the same flag gates two different things: HealthTimer
  // also requires PFLAG_MOVED_SINCE_ENTRY, so while frozen we recover VIGOR and not
  // health. That is still the right trade. A death costs a point of maximum health
  // permanently plus everything carried; this costs a minute and buys back the vigor
  // that sets the regeneration rate for when we do move.
  //
  // ALL OF THAT CHANGES IF WE ARE STANDING IN A SAFE SPOT, and it changes for the
  // better, because the reason to stay frozen disappears. Logging back in puts us
  // back exactly where we logged off; the walls have not moved; so the grace period
  // is no longer the thing keeping us alive — the geometry is. That means we can
  // afford to SPEND the grace period rather than hoard it: turn once, which wakes
  // everything and arms HealthTimer, and then rest to full while the things that
  // noticed us stand there unable to do anything about it.
  //
  // The frozen version buys a minute of vigor. This version buys a full heal in the
  // middle of a monster room, and it is the difference between a fight we lost and a
  // fight we get to have again.
  async playDead(why) {
    const s = this.s;
    // A FREEZE THAT CHANGED NOTHING MUST NOT BE REPEATED.
    //
    // Freezing buys safety by not acting, and the same flag that keeps the monsters
    // off also keeps HealthTimer off — so it recovers vigor and NEVER health. That is
    // the right trade exactly once. Do it twice from the same health and it is a
    // livelock: wake, see the same danger, freeze again, for ever, at four health,
    // reporting a sensible-looking journal line every eight seconds.
    //
    // So: remember the health we last froze at. If we are back here no better off,
    // the freeze is not working and the answer has to be something that moves.
    const nowHp = s.client?.vitals?.()?.health?.value ?? null;
    if (this.frozeAt != null && nowHp != null && nowHp <= this.frozeAt) {
      this.freezesWithoutGain = (this.freezesWithoutGain || 0) + 1;
      if (this.freezesWithoutGain >= 2) {
        this.note('refusing to freeze again — it is not helping', {
          health: nowHp, froze_at: this.frozeAt, times: this.freezesWithoutGain,
          why: 'playing dead recovers vigor and never health, so repeating it from the same ' +
               'health cannot ever end. Something that moves has to happen instead.' });
        return false;      // the caller falls through to withdrawing or resting
      }
    } else this.freezesWithoutGain = 0;
    this.frozeAt = nowHp;

    // TELL THE PILOT NOW, BEFORE THE RECONNECT — this is the only free moment there is.
    //
    // Speaking is not unconditionally an action. UserSayGroup, the handler behind a tell,
    // opens with:
    //
    //   % User took an action!  Wake any AIs in the room to the user's presence!
    //   if NOT (piFlags & PFLAG_MOVED_SINCE_ENTRY)
    //   { Send(self,@NotifyMonstersOfPresence); }        user.kod:4171
    //
    // The wake is GATED on the grace-period flag being clear. Right here the character
    // has been walking and swinging for minutes, so the flag is already set and the
    // branch does not run: the tell costs a point of mana and nothing else.
    //
    // Two lines further down, reconnect() re-enters the world and CLEARS that flag, and
    // from then until the unfreeze every word is a wake-up call to the whole room. So
    // "during the freeze" is precisely the window where a tell would kill the character
    // it is reporting on — and this, the moment the decision is taken, is both free and
    // the earliest the news can possibly travel. The character then sits still for ninety
    // seconds, which is time enough to walk over and watch it.
    this.debug = {
      what: 'frozen', label: DEBUG_STATES['frozen'], at: Date.now(), pass: this.passes,
      room: this.s.world?.room?.name ?? null, room_num: this.s.world?.room?.num ?? null,
      col: s.client?.self?.col ?? null, row: s.client?.self?.row ?? null,
      grid: this.s.world?.geometry ? { rows: this.s.world.geometry.rows, cols: this.s.world.geometry.cols } : null,
      bearing: this.s.world?.geometry && s.client?.self
        ? bearingIn(s.client.self.row, s.client.self.col,
                    this.s.world.geometry.rows, this.s.world.geometry.cols) : null,
      doing: 'about to play dead', mode: this.mode, hunting: this.policy.hunt ?? null,
      health: nowHp, health_max: s.client?.vitals?.()?.health?.max ?? null,
      vigor: vigorOf(s.client?.vitals?.() ?? {}), rest_ceiling: REST_VIGOR_CAP * skills.VIGOR_MAX,
      monsters: s.client?.room ? [...s.client.room.objects.values()].filter(o =>
        o.id !== s.client.selfId && (o.flags & OF.ATTACKABLE) && !(o.flags & OF.PLAYER)).length : null,
      detail: { why, freeze_s: Math.round((this.policy.freezeMs ?? 90_000) / 1000),
                froze_at: this.frozeAt, times: this.freezesWithoutGain ?? 0,
                note: 'sent BEFORE the logoff — during the freeze a tell would wake the room' },
    };
    await this.tellPilot(this.debug).catch(() => {});
    // Keep our own copy: rejoin() renumbers everything, and observe() will not have
    // run again by the time we need to know where we were standing.
    const spot = this.hold ? { ...this.hold } : null;
    const inSpot = this.holdWorks();
    this.note('LOGGING OFF TO AVOID DYING', {
      why, health: s.client?.vitals?.()?.health,
      in_safe_spot: inSpot || undefined,
      how: inSpot
        ? 'disconnect, reconnect, and then deliberately turn — we come back standing in a spot ' +
          'nothing can reach us in, so waking the room costs nothing and buys the health timer'
        : 'disconnect, wait, reconnect, and then do NOTHING that counts as an action' });
    this.tally.logoffs = (this.tally.logoffs || 0) + 1;
    this.doing = 'recovering';

    const came = await this.reconnect('logging off rather than dying');
    if (!came.ok) {
      this.note('reconnect after logoff failed', { why: came.why });
      return false;
    }

    if (spot) {
      const me = s.client?.self;
      const back = me && me.col === spot.col && me.row === spot.row;
      if (back) {
        // Not frozen: the walls are doing the work, so the grace period is ours to
        // spend. The ordinary rest branch takes it from here — it turns to arm the
        // timer, rests to full, and observe() keeps checking that nothing lands.
        this.hold = { ...spot, takenAt: Date.now(), quietMs: 0, reclaimed: true };
        this.tally.mulligans = (this.tally.mulligans || 0) + 1;
        this.note('back on the safe spot', {
          where: { col: spot.col, row: spot.row }, proven: spot.proven,
          plan: 'turn to wake the room and arm health regeneration, then rest to full here',
          why: 'a reconnect puts us back exactly where we were, and nothing about the walls ' +
               'changed while we were gone' });
        return true;
      }
      // We came back somewhere else. Say so rather than carry on believing in a
      // square we are not standing on — every branch above trusts this flag.
      this.hold = null;
      this.note('did not come back on the safe spot', {
        expected: { col: spot.col, row: spot.row },
        actually: me ? { col: me.col, row: me.row } : null,
        why: 'falling back to staying completely still, which needs no geometry to work' });
    }

    // Frozen. Rest only — no movement, no turning, no looking around, and in
    // particular no room-contents request, because anything that reads as an action
    // hands the grace period back.
    this.frozenUntil = Date.now() + (this.policy.freezeMs ?? 90_000);
    this.note('playing dead', {
      until_s: Math.round((this.frozenUntil - Date.now()) / 1000),
      note: 'monsters cannot attack until this character acts; resting is not an action' });
    return true;
  }

  // Ask other players for what the game will not give us.
  //
  // Rate-limited hard, because a broadcast costs a share of max mana and a keeper
  // loops every eight seconds; unthrottled this would be indistinguishable from
  // spam, and would empty the mana bar of the very character that needs it.
  async askForHelp(reason = null) {
    const s = this.s, c = s.need();
    const PLEA_GAP_MS = 5 * 60 * 1000;
    if (this.lastPleaAt && Date.now() - this.lastPleaAt < PLEA_GAP_MS) return;

    // NOBODY NEEDS RESCUING IN AN INN.
    //
    // Being hurt is not being in danger, and broadcasting as though it were is both
    // embarrassing and expensive — it costs a share of maximum mana and it spends
    // other players' attention on a character that is in no trouble whatsoever.
    // Isolde did it from the middle of the Limping Toad, where monsters cannot attack
    // at all. The remedy there is entirely in our own hands: move, which is what arms
    // the regeneration timer, then sit down. That reaches full health and the 80
    // vigor that resting can reach, without anybody being asked for anything.
    //
    // (The pedantic exception is an assassin's game blade, which can strike you in an
    // inn — but it costs no health, no stats and no inventory, so it is not a reason
    // to call for help either.)
    //
    // Being unarmed after a death is different and still worth asking about: no
    // amount of resting produces a sword.
    const hurtOnly = /hurt|heal|flask/i.test(reason || '');
    if (hurtOnly && this.sanctuary()) {
      if (!this.quietedPleaIn || this.quietedPleaIn !== this.s.world?.room?.num) {
        this.quietedPleaIn = this.s.world?.room?.num ?? null;
        this.note('not asking for help — we are somewhere safe', {
          room: this.s.world?.room?.name, reason,
          why: 'nothing can attack us here, so being hurt is a wait rather than an emergency: ' +
               'moving arms the health timer and resting does the rest' });
      }
      return;
    }

    await s.pacer.submit('read', () => c.requestInventory());
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });

    let eq = await skills.equipBest(s).catch(() => null);
    // Before asking a stranger for a blade, try the one we can make. Charity is slow,
    // uncertain, and costs another player something; the spell costs 15 mana.
    if (!eq?.wielding && await this.makeWeapon('the alternative was begging a stranger for a blade')
                                  .catch(() => false))
      eq = await skills.equipBest(s).catch(() => eq);
    const armed = !!eq?.wielding;
    const where = c.rsc.get(c.roomNameRsc) || 'somewhere';
    const hurt = /hurt|heal|flask/i.test(reason || '');
    this.note(hurt ? 'asking for a heal' : 'recovering after death',
              { armed, wielding: eq?.wielding, room: where, reason });

    // Rearming solves the post-death case by itself; being hurt never does.
    if (armed && !hurt) { this.progress('rearmed after dying'); return; }

    const v = c.vitals()?.health;
    const name = c.me?.name || 'a traveller';
    const plea = hurt
      ? `${name} here at ${where} — I am down to ${v ? `${v.value} of ${v.max}` : 'almost no'} health ` +
        `and I have nothing to heal with. Resting brings health back slowly in these lands. ` +
        `If anyone can spare a flask or cast a heal on me I would be in your debt.`
      : `${name} here — I was killed and lost everything. I am at ${where} with no weapon ` +
        `or armour. If anyone can spare a blade or a few shillings I would be grateful, ` +
        `and I will pay it forward once I am on my feet.`;
    this.lastPleaAt = Date.now();
    try {
      await s.pacer.submit('say', () => c.broadcast(plea));
      this.note('asked for help', { channel: 'broadcast', room: where });
    } catch (e) {
      // Broadcast costs a share of max mana and is refused when squelched; the
      // room is free and someone may well be standing in the inn.
      try { await s.pacer.submit('say', () => c.say(plea)); this.note('asked for help', { channel: 'say', room: where }); }
      catch { this.note('could not ask for help', { why: e.message }); }
    }
    this.noProgress(hurt ? 'hurt with no way to heal — waiting on a passer-by'
                         : 'dead broke and unarmed — waiting on charity');
  }

  // BUY THE INGREDIENTS, NOT THE MEAL, and only while we are already at a counter.
  //
  // Buying from a vendor pays their spread, which is why this is a top-up rather than
  // the supply plan: the fleet's own herbs are free and are handled by not selling them
  // in the first place. But `create food` refuses silently without 2 ElderBerry and 2
  // Herbs, and a character stuck at 80 vigor for want of four items is losing far more
  // than the markup. Bounded by reagentTarget and by walkingMoney, so it can never eat
  // the money a character needs to get home.
  async restockReagents(seller) {
    const s = this.s, c = s.need();
    const want = this.policy.reagentTarget ?? REAGENT_TARGET;
    const have = this.reagentCount();
    const need = { elderberry: Math.max(0, want - have.elderberry), herb: Math.max(0, want - have.herbs) };
    if (!need.elderberry && !need.herb) {
      this.declinedPurchase('already at the reagent target', { have, target: want });
      return [];
    }
    const purse = (c.inventory || []).filter(o => /shilling/i.test(c.rsc.get(o.nameRsc) || ''))
                                     .reduce((t, o) => t + (o.amount || 1), 0);
    // THE WALKING FLOAT MUST NOT STARVE THE CHARACTER IT PROTECTS.
    //
    // This refused outright below the float, so a character holding 300 shillings bought
    // no reagents at all — when sixty of them is three casts of create food, and create
    // food is the only route to vigor for a character nowhere near a shop. The fleet
    // declined 894 casts in one day for want of reagents, against 58 for want of mana.
    //
    // The float exists so a character can pay its way home. Reagents are 10 or so each
    // and weigh nothing, so when it is hungry the reserve drops to what a trip home
    // actually costs and the rest is spendable. A character that cannot eat cannot earn,
    // and the float it was guarding buys nothing at all if it dies holding it.
    const hungryNow = (vigorPct(c.vitals?.()) ?? 1) < (this.policy.vigorWant ?? 0.9);
    const fullFloor = this.policy.walkingMoney ?? 400;
    const floor = hungryNow ? Math.min(fullFloor, this.policy.hungryFloor ?? 100) : fullFloor;
    if (purse <= floor) {
      this.declinedPurchase('purse is down to the walking float', { purse, float: floor,
        ...(floor !== fullFloor ? { relaxed_from: fullFloor, why: 'hungry — reagents outrank the float' } : {}),
        need });
      return [];
    }

    const before = c.evSeq;
    await s.pacer.submit('buy', () => c.buy(seller.id ?? seller));
    const ev = await c.waitFor({ since: before, kinds: ['shop', 'message'], timeoutMs: 4000 }).catch(() => ({ events: [] }));
    const shop = ev.events?.find(e => e.kind === 'shop');
    if (!shop) {
      this.declinedPurchase('the merchant never opened a shop list');
      return [];
    }
    // BUY FOOD TOO, NOT JUST REAGENTS.
    //
    // This filtered every shop list through shareKind, which matches elderberry and herbs
    // and nothing else — so a character could stand at a counter selling bread, with
    // money in hand and vigor pinned at the resting cap, and buy nothing. Ten of
    // twenty-one sat at exactly 80 for an entire session on that.
    //
    // Resting stops awarding vigor at 80 of 200, so everything above it has to be EATEN.
    // Making food needs elderberry and herbs in the eater's own pack, and the fleet's
    // reagents are hoarded in rooms nobody hungry ever visits — buying is the route that
    // does not depend on the geography lining up.
    //
    // isFood comes from the Food class tree (m59-items.mjs), not a word list: guessing by
    // name would miss "Inky-cap mushroom" and "goblet of ale" and would wrongly include
    // the mushrooms that are reagents.
    const hungry = hungryNow;

    // RANK FOOD BY VIGOR PER SHILLING, and stop once the gap is closed.
    //
    // viNutrition is vigor one-for-one (player.kod:1277-1278) and spans an order of
    // magnitude: a water skin is 3, a wheel of cheese 30. This took one of everything in
    // whatever order the shop listed it, and checked each price against the purse it
    // walked in with rather than what was left — so it could both overspend and come away
    // with a handful of water skins when a single cheese was the same trip.
    const budget = purse - floor;
    let spend = 0;
    const affordable = it => (it.cost ?? 0) > 0 && (it.cost ?? 0) <= budget - spend;

    const reagents = (shop.items || []).filter(it => {
      const k = skills.shareKind(it.name);
      return k && need[k] > 0 && affordable(it);
    });
    for (const it of reagents) spend += it.cost;

    // What eating everything already in the pack would be worth, so a character with a
    // cheese in hand does not buy another.
    // c.inventory is an ARRAY, not a method, and vitals().vigor is {value, scale_max} —
    // both were wrong on the first go, and the vigor one is the dangerous shape: an
    // object in arithmetic is NaN, NaN > 0 is false, and the fleet would have quietly
    // stopped buying food altogether while every reading still said it was shopping.
    const carried = (c.inventory || []).reduce(
      (t, i) => t + (foodValue(i.name)?.nutrition ?? 0) * (i.amount || 1), 0);
    const vg = c.vitals?.()?.vigor;
    const vigorNow = vg?.value ?? null;
    const vigorMax = vg?.scale_max ?? 200;
    let gap = hungry && vigorNow !== null
      ? Math.max(0, ((this.policy.vigorWant ?? 0.9) * vigorMax) - vigorNow - carried)
      : 0;

    const food = [];
    if (gap > 0) {
      const menu = (shop.items || []).filter(it => isFood(it.name) && (foodValue(it.name)?.nutrition ?? 0) > 0)
        .map(it => ({ it, vigor: foodValue(it.name).nutrition }))
        .sort((a, b) => (b.vigor / b.it.cost) - (a.vigor / a.it.cost) || b.vigor - a.vigor);
      for (let pass = 0; pass < 20 && gap > 0; pass++) {
        const pick = menu.find(m => affordable(m.it));
        if (!pick) break;
        food.push(pick.it); spend += pick.it.cost; gap -= pick.vigor;
      }
    }
    const wanted = [...reagents, ...food];
    if (!wanted.length) {
      // WHICH of the two it was matters, and both look like "bought nothing" from the
      // outside: a merchant that stocks no reagents at all is a routing problem, while
      // one whose prices are above the float is a money problem.
      const stocked = (shop.items || []).some(it => skills.shareKind(it.name));
      this.declinedPurchase(stocked ? 'reagents here cost more than the purse can spare'
                                    : 'this merchant does not stock elderberry or herbs',
        { spendable: purse - floor, need,
          offered: (shop.items || []).filter(it => skills.shareKind(it.name))
                                     .map(it => `${it.name} @${it.cost}`).slice(0, 6) });
      return [];
    }
    const got = [];
    for (const it of wanted) {
      await s.pacer.submit('buy', () => c.buyItems(shop.sellerId, [it.id]));
      await new Promise(r => setTimeout(r, 700));
      got.push(`${it.name} @${it.cost}`);
      this.recordPurchase(it.name, it.cost, { kind: skills.shareKind(it.name) || (isFood(it.name) ? 'food' : null),
        // seller may be a bare id — the signature accepts both — so do not assume an object.
        from: seller?.nameRsc ? (c.rsc.get(seller.nameRsc) ?? null) : null,
        why: isFood(it.name) ? 'food bought at a counter we were already standing at — the only way past the vigor-80 resting cap' : 'reagent top-up at a counter we were already standing at, to keep create food castable' });
    }
    await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
    if (got.length) this.note('restocked reagents', { bought: got, had: have, target: want,
      why: 'create food refuses silently without 2 elderberry and 2 herbs' });
    return got;
  }

  // Free up carrying space rather than announcing that we cannot. Sell if anyone
  // here buys; otherwise drop the largest pile of the least valuable thing. Money,
  // gems and anything we are wearing or wielding are never touched.
  async makeRoom() {
    this.doing = 'trading';
    const s = this.s, c = s.need();
    const buyer = [...c.room.objects.values()].find(o => affordances(o.flags).includes('buy'));
    if (buyer) {
      const sold = await skills.sellAll(s, { merchant: buyer.id }).catch(e => ({ error: e.message }));
      // WE ARE STANDING AT A SHOP WITH MONEY IN HAND. Restocking reagents here costs
      // nothing extra — the walk is already paid for — and it is the one time buying
      // from a vendor is not simply losing the spread to them.
      const bought = await this.restockReagents(buyer).catch(() => null);
      if (!sold.error && sold.sold?.length) {
        return { ok: true, did: 'sold to ' + c.rsc.get(buyer.nameRsc),
                 detail: { earned: sold.total_received, sold: sold.sold.length,
                           kept_for_the_fleet: sold.kept_for_the_fleet?.length || undefined,
                           bought: bought?.length || undefined } };
      }
      if (bought?.length)
        return { ok: true, did: 'restocked reagents at ' + c.rsc.get(buyer.nameRsc),
                 detail: { bought } };
    }
    // No buyer. Drop the biggest stack of something expendable.
    await s.pacer.submit('read', () => c.requestInventory());
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });

    // DEAD WEIGHT FIRST, and it has to be first because the keep list below protects it.
    //
    // `keep` names sword|mace|hammer|axe|bow to stop the pack-clearer stripping the
    // character's weapon — sound, except that a BROKEN weapon is not renamed
    // (weapon.kod:788 changes only the icon) and the junk item is literally called
    // "broken mace". So the guard that exists to protect equipment was the reason every
    // character hauled its shattered swords around for ever: unsellable, unwieldable,
    // and specifically exempted from being dropped.
    // ASK ABOUT THE SPARES BEFORE DECIDING THERE IS NOTHING TO DROP.
    //
    // junkAndBroken can only report weapons brokenSet already knows about, and brokenSet
    // only ever learned by a failed wield — which happens at most once a pass and only
    // for the weapon the character was about to use. So a pack full of dead maces
    // reported "nothing to drop" indefinitely: the spares were never the ones being
    // wielded, so they were never tested, so they were never known, so they were never
    // dropped. Floyd had six and Kermit eight on exactly that loop.
    //
    // Looking is the cheap question (see inspectForBroken), and it is asked only about
    // spares — never the weapon in hand — and only when the pack is worth clearing, so
    // it costs nothing on the common path.
    const worn0 = skills.equippedNow(c) ?? new Set();
    const spares = (c.inventory || [])
      .filter(o => !worn0.has(o.id) && skills.weaponScore(c.rsc.get(o.nameRsc) || '') > 0)
      .map(o => o.id);
    if (this.policy.dropJunk !== false && spares.length)
      await skills.inspectForBroken(s, spares).catch(() => null);

    const dead = skills.junkAndBroken(c);
    if (this.policy.dropJunk !== false && dead.length) {
      const d = dead[0];
      await s.pacer.submit('drop', () => c.drop([this.dropSpec(d)]));
      await new Promise(r => setTimeout(r, 900));
      await s.pacer.submit('read', () => c.requestInventory());
      await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });
      return { ok: true, did: `dropped ${d.name} (${d.why})`,
               detail: { now_carrying: c.inventory.length, dead_weight_left: dead.length - 1 } };
    }

    // The keep list is a VALUE guard — money, gems, the sort of gear worth carrying a
    // spare of. It used to double as the equipment guard, and that was only ever an
    // approximation: it protects things whose NAMES look like equipment, so anything
    // worn that is not named after a weapon or a piece of armour — a ring, a cloak, an
    // amulet, boots, a lute — was as droppable as a rat pelt while the character was
    // wearing it.
    //
    // The server keeps the real answer in plUsing and sends it on every inventory read,
    // which is exactly what just happened above. Use it: this cannot be got wrong by a
    // name nobody thought of.
    const keep = /shilling|coin|diamond|ruby|emerald|sapphire|armor|armour|shield|sword|mace|hammer|axe|bow|helm|gauntlet/i;
    const worn = skills.equippedNow(c) ?? new Set();
    const me = this.s.name;
    // THE ORDER THINGS GET GIVEN UP IN. Own needs first — reagents we are short of
    // ourselves are covered by `keep` below via mine(). Then anything a crewmate is
    // short of, which outranks loot we are only carrying in order to sell it: the
    // vendor spread means a herb dropped here and bought back there costs twice, and
    // the character who needed it could not eat in the meantime. Bulk breaks ties,
    // because the point of the drop is to make room.
    const r = this.reagentCount();
    const target = this.policy.reagentTarget ?? REAGENT_TARGET;
    const mine = name => {
      const k = skills.shareKind(name);
      if (!k) return false;
      return (k === 'elderberry' ? r.elderberry : r.herbs) <= target;   // still short ourselves
    };
    const rank = o => {
      const name = c.rsc.get(o.nameRsc) || '';
      if (mine(name)) return 2;                                          // ours, keep longest
      if (skills.interest.anyoneWants(name, { except: me })) return 1;    // somebody's, keep
      return 0;                                                          // sell-fodder, goes first
    };
    const junk = (c.inventory || [])
      .filter(o => !worn.has(o.id)
                   && !keep.test(c.rsc.get(o.nameRsc) || '')
                   && !this.wontDrop?.has(o.id))
      .sort((a, b) => rank(a) - rank(b) || (b.amount || 1) - (a.amount || 1));
    if (!junk.length) {
      return { ok: false, did: 'nothing safe to drop',
               detail: { hint: 'raise maxCarry, or go and sell — everything carried looks worth keeping' } };
    }
    const drop = junk[0];
    const name = c.rsc.get(drop.nameRsc);
    const before = c.inventory.length;
    await s.pacer.submit('drop', () => c.drop([this.dropSpec(drop)]));
    await new Promise(r => setTimeout(r, 900));
    await s.pacer.submit('read', () => c.requestInventory());
    await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });
    // DID IT ACTUALLY GO? A drop the server refused looks exactly like one it accepted
    // from here, and makeRoom returns from the pass either way, so a refusal that repeats
    // is a character that never does anything again. Refuse to report success for a drop
    // that changed nothing, and remember the item so the next pass tries something else.
    if (c.inventory.length >= before) {
      (this.wontDrop ??= new Set()).add(drop.id);
      return { ok: false, did: `the server would not drop ${name}`,
               detail: { still_carrying: c.inventory.length, refused: name,
                         hint: 'a stacked item needs a quantity (UserDrop returns early on ' +
                               'number <= 0); this one is now skipped for the rest of the session' } };
    }
    return { ok: true, did: `dropped ${name}${drop.amount > 1 ? ` x${drop.amount}` : ''}`,
             detail: { now_carrying: c.inventory.length } };
  }

  // Move to a neighbouring room and look there instead. Prefers somewhere not yet
  // visited, so the character sweeps outward rather than bouncing between two rooms.
  // Rooms whose spawn table generates what we are hunting, safest-and-likeliest
  // first, excluding where we already are and anywhere we have failed to reach.
  //
  // The threat ceiling is expressed relative to the character's own level, because
  // that is what makes it portable: prey worth killing is ABOVE your level (the
  // advancement roll needs monster_level > base_max_health), so a flat "nothing
  // above your level" rule would reject every room worth being in. Six over is the
  // gap between prey that pays and prey that kills — level-30 rats are right for a
  // level-25 character; the level-35 larvae sharing room 567 with them are not.
  preyRooms(room) {
    const want = this.policy.hunt;
    if (!want) return [];
    const spawns = loadSpawns(SPAWN_FILE);
    if (!spawns) return [];
    const level = this.s.client?.vitals?.()?.health?.max ?? 0;
    const ceiling = level ? level + (this.policy.maxThreatOver ?? 6) : null;
    const rooms = huntingGrounds(spawns, want, { maxDanger: ceiling, limit: 8 })
      .filter(r => !r.rejected && r.room !== room?.num && !this.unreachable.has(r.room))
      // And not one we have already refused for having no wall. Without this the
      // keeper walks out of a wall-less room straight into the next wall-less room and
      // back again, because the spawn table ranks them identically and has no opinion
      // about whether either can be fought in.
      .filter(r => this.noWallRooms?.get(r.room) === undefined ||
                   this.noWallRooms.get(r.room) === false);
    // AN ASSIGNMENT OUTRANKS THE SPAWN TABLE. Every caller takes [0], so putting the
    // assigned room at the front is the whole of "go back where you were put" — and
    // it stays subject to the same filters above, so an assignment to somewhere that
    // cannot generate the prey, or that we have proven unreachable, is ignored rather
    // than obeyed into a corner.
    const mine = this.policy.assignedRoom;
    if (mine == null || mine === room?.num) return rooms;
    const i = rooms.findIndex(r => r.room === mine);
    if (i > 0) rooms.unshift(rooms.splice(i, 1)[0]);
    return rooms;
  }

  async roam(room) {
    const s = this.s;
    // Getting out is its own move when there is a crowd standing on us. Doing it here
    // rather than at each of the three departures below means it cannot be forgotten
    // at one of them.
    if ((await this.leaveHold('roaming to look for hunting elsewhere')).refused) return;

    // GO BACK TO WHERE THE WORK WAS. Roaming outward is a one-way gradient: each
    // empty room justifies moving to the next, and nothing ever argues for turning
    // round. Left alone it walked out of a rat warren, through four rooms, into a
    // town square, and spent twenty minutes there alternating between "nothing to
    // hunt" and "the guardian angel will not let me leave". If we know somewhere
    // that produced a kill, that is where to be.
    if (this.homeRoom != null && room?.num !== this.homeRoom) {
      this.note('heading back to where the hunting was', { from: room?.name, to_room: this.homeRoom });
      const back = await this.travel(this.homeRoom, { maxHops: 8 }).catch(e => ({ arrived: false, reason: e.message }));
      this.emptyPasses = 0;
      if (back.arrived) {
        this.tally.rooms_moved++;
        this.roamedRooms = 0;
        this.progress('returned to the hunting ground');
        this.note('back at the hunting ground', { room: this.homeRoom });
      } else {
        // FORGET IT RATHER THAN RETRY FOREVER. Some rooms cannot be returned to at
        // all — the newbie zone is behind a one-way portal, and a character that
        // graduated out of it keeps a homeRoom it can never reach again. Retrying
        // that route every eight seconds is exactly the silent stall this whole
        // mechanism was meant to prevent.
        this.note('cannot get back — forgetting that hunting ground',
                  { to_room: this.homeRoom, why: back.reason });
        this.homeRoom = null;
        this.noProgress('lost the way back; will look for new hunting from here');
      }
      return;
    }

    // ASK WHERE THE PREY LIVES BEFORE WALKING ANYWHERE.
    //
    // Creatures do not wander in this world: each room has a generator with a fixed
    // table, and a giant rat appears in a room if and only if that room's table
    // names it. So the room to go to is a lookup, and walking the exit graph hoping
    // to stumble across one is searching for something that was never going to move.
    // Left to do that, a character walked out of a rat warren and into the
    // Princess's castle — a room whose table contains no vermin at all and never
    // will.
    //
    // The threat ceiling is the other half. Two rooms both list giant rats at 60-70%;
    // one of them also rolls a level-35 groundworm larva, and that is the room that
    // kept killing a level-26 character of mine. Filtering on the toughest thing the
    // TABLE can produce — not on what happens to be standing there now — is what
    // separates them.
    const known = this.preyRooms(room);
    if (known.length) {
      const target = known[0];
      this.note('going where this creature is actually generated', {
        to_room: target.room, room_name: target.room_name,
        spawn_chance: target.chance, also_here: target.also_here,
      });
      this.doing = 'travelling';
      const r = await this.travel(target.room, { maxHops: 12 })
                       .catch(e => ({ arrived: false, reason: e.message }));
      this.emptyPasses = 0;
      if (r.arrived) {
        this.tally.rooms_moved++;
        this.roamedRooms = 0;
        this.homeRoom = target.room;
        this.progress('reached a room that generates the prey');
        return;
      }
      // Unreachable from here — remember not to keep choosing it, and fall through
      // to the exit walk rather than retrying the same failed route forever.
      this.unreachable.add(target.room);
      this.note('could not reach that spawn room', { to_room: target.room, why: r.reason });
    }

    if (this.roamedFrom === null) { this.roamedFrom = room?.num ?? null; this.roamedRooms = 0; }
    if (this.roamedRooms >= this.policy.roamLimit) {
      this.note('roamed far enough', { rooms: this.roamedRooms, limit: this.policy.roamLimit,
                                       hint: 'raise roamLimit, or move the character yourself' });
      this.emptyPasses = 0;
      this.noProgress('roam limit reached with nothing to hunt');
      return;
    }
    // DO NOT WALK INTO A ROOM YOU CANNOT WALK OUT OF.
    //
    // Thirty-two rooms in this world have no route back to any hunting ground, and
    // they are not marked as anything: Marion is a perfectly ordinary-looking town
    // whose room object has plEdge_Exits = $, so you can walk in from the West
    // Merchant Way and then there is no edge to walk out of. The Marion crypt below
    // it is worse. Eight characters roamed in and spent half an hour cycling between
    // an inn and a sanctuary, reporting a roam limit rather than a trap, because
    // from the inside it looks exactly like a room with nothing to hunt in it.
    //
    // The graph already knows. Ask it before stepping through, not after.
    const map = s.world?.map;
    const goals = this.preyRooms(room).map(r => r.room);
    // CAN I GET BACK? That is the whole test, and it is local — no global notion of
    // "sealed" is needed, and none of the ones I tried worked: Marion reaches its own
    // crypt, and the crypt has a spawn table, so every reachability-to-anything test
    // declared the pocket healthy right up until twenty-three characters were in it.
    //
    // Asking instead whether the DESTINATION can route back HERE catches a one-way
    // door exactly, because that is what a one-way door is.
    const escapable = (to) => {
      if (!map || room?.num == null) return true;
      if (to === room.num) return true;
      if (!findPath(map, to, room.num).found) return false;
      if (!goals.length) return true;
      return goals.includes(to) || goals.some(g => findPath(map, to, g).found);
    };
    // AND DO NOT WALK INTO A ROOM THAT WILL KILL YOU.
    //
    // Escapability is only half of it. Room 2602, "Affirmation of the Forsaken",
    // is one door off a quiet Marion crypt and its generator is thrashers — level
    // 150, cap fifteen, a hundred percent of the table. Eight characters of mine
    // stood in it and lived only because nothing had spawned yet. The room next
    // door rolls level-75 skeletons at 80%.
    //
    // None of this is visible from inside the room, and none of it is in the room's
    // name. It is in the spawn table, which we already have, so there is no excuse
    // for stepping through the door to find out.
    const spawns = loadSpawns(SPAWN_FILE);
    const level = s.client?.vitals?.()?.health?.max ?? 0;
    const ceiling = level ? level + (this.policy.maxThreatOver ?? 6) : null;
    const tooDangerous = (to) => {
      if (!spawns || ceiling == null) return null;
      const worst = (roomThreats(spawns, to) || [])[0];
      return worst && (worst.level ?? 0) > ceiling ? worst : null;
    };

    const all = (s.world?.exits() || []).filter(e => e.to != null && e.reachable !== false);
    const dangerous = [];
    const exits = all.filter(e => {
      const d = tooDangerous(e.to);
      if (d) { dangerous.push(`${e.to_name} (${e.to}): ${d.creature} is level ${d.level}`); return false; }
      return escapable(e.to);
    });
    if (dangerous.length)
      this.note('refused to roam somewhere lethal', { rejected: dangerous, my_ceiling: ceiling });
    if (all.length && !exits.length) {
      this.note('every way out of here is a dead end', {
        room: room?.name,
        rejected: all.map(e => `${e.to_name} (${e.to})`),
        why: 'none of these can route back to a room that generates ' + this.policy.hunt });
      this.noProgress('surrounded by rooms with no way back to the hunting grounds');
      this.emptyPasses = 0;
      return;
    }
    if (!exits.length) { this.note('nowhere to roam to', { room: room?.name }); this.emptyPasses = 0; return; }
    const fresh = exits.filter(e => !this.visited.has(e.to));
    const pick = (fresh.length ? fresh : exits)
      .sort((a, b) => (a.steps_away ?? 999) - (b.steps_away ?? 999))[0];

    const r = await s.leaveVia(pick);
    this.emptyPasses = 0;
    if (r.left) {
      this.roamedRooms++;
      this.tally.rooms_moved++;
      if (room?.num != null) this.visited.add(room.num);
      const now = s.world?.room;
      if (now?.num != null) this.visited.add(now.num);
      this.note('roamed', { from: room?.name, to: r.arrived_in, rooms_so_far: this.roamedRooms });
    } else {
      this.note('could not roam', { toward: pick.to_name, why: r.reason });
    }
  }

  // RETREAT TO A WALL, NOT MERELY AWAY.
  //
  // This used to give up the spot it was holding and walk to the furthest reachable
  // OPEN square — distance was the only thing it ranked. That is the wrong currency,
  // and it is how characters died: a plain square six steps away is still a square
  // anything can walk up to and hit, so the retreat bought a few seconds and put the
  // character somewhere it could not recover.
  //
  // What makes it fatal is what happens next. playDead() — disconnect, reconnect,
  // turn — is a FULL HEAL in the middle of a monster room, but only from a spot that
  // holds: the freeze that protects also stops HealthTimer, so out in the open it
  // recovers vigor and never health. Do that twice from the same health and it is a
  // livelock, which is what "refusing to freeze again" is, and after refusing, the
  // caller falls through to here. So a withdrawal onto open ground is precisely the
  // state in which the escape hatch does not work.
  //
  // Defensibility beats distance, because in a spot that holds the distance does not
  // matter — nothing lands at all. So: try for a wall first, preferring one the book
  // has already proved, and keep the distance-based walk only as the fallback for
  // rooms that genuinely have no corner in them.
  // RUNNING PART OF THE WAY TO SAFETY IS A DEATH SENTENCE.
  //
  // `fight()` has always broken off at the flee threshold, set `disengaged`, and
  // returned a note saying in plain words: "the monster is still there and still
  // hostile — walk away before resting, or it will keep hitting you."
  //
  // NOTHING READ IT. `grep -n "\.disengaged" m59-autopilot.mjs` returned nothing. So
  // the character stopped swinging and stood exactly where it was, at 20% health, next
  // to the six things that had just taken it there. Out in the open that protects you
  // from nothing — not swinging only helps behind a wall, and the note says so.
  //
  // That is the shape of this fleet's deaths. Of 65: 92% were killed by something they
  // were not hunting, 91% had five or more creatures within reach, and the mean at the
  // moment of death was 5.6. Standing still in that is not a retreat.
  //
  // `withdraw()` is a LOCAL move — to a wall, a few squares. It is the right answer
  // when a safe spot stopped working and the wrong one here: a few squares away from
  // six centipedes is still inside their vision (4-6 squares) and well inside a chase.
  // So this leaves the room entirely and goes to an inn, which is a sanctuary — the
  // Brownestone and its siblings carry ROOM_NO_COMBAT and ROOM_SANCTUARY, so arriving
  // is the end of the fight rather than a pause in it.
  //
  // The destination is the nearest CITY_INNS entry the router will accept. If travel
  // cannot get us there we fall back to the local withdraw, because a wall we can
  // reach beats an inn we cannot.
  async retreatToSafety(why = {}) {
    const s = this.s, c = s.client;
    const here = s.world?.room?.num ?? null;
    const inns = Object.entries(CITY_INNS).map(([city, v]) => ({ city, ...v }));

    // A WORKING SAFE SPOT IS ALREADY SAFETY, AND RUNNING FROM ONE IS THE WORST MOVE
    // AVAILABLE. This guard lived inside withdraw(), and swapping callers over to this
    // function quietly dropped it — which would have taken characters off proven walls
    // and marched them across a monster field at the health that made them flee.
    //
    // The asymmetry is the whole safe-spot thesis. `Player.TargetWithinSightAndRange`
    // never calls LineOfSight while `Monster.CanReach` does (player.kod:4115 against
    // monster.kod:1782), so on the right square nothing can land a blow unless we swing
    // first. Standing still there stops the damage immediately and for free, and it is
    // the one place the offline/online rotation can be used to shed whatever has piled
    // up. Distance solves being hurt EVERYWHERE ELSE; here it is what starts it.
    //
    // Deliberately checks holdWorks() and not merely hold: a square we believe in but
    // have never been attacked on is not evidence, and the whole point of this branch
    // is that something is attacking us right now.
    if (this.hold && this.holdWorks()) {
      this.note('staying behind the wall instead of running', {
        spot: { col: this.hold.col, row: this.hold.row }, ...why,
        why: 'this square has held under attack, so nothing here can land a blow unless we ' +
             'swing — leaving it would trade the only thing keeping us alive for distance ' +
             'we do not need' });
      return { arrived: true, held_spot: true };
    }

    // Already in one? Then we are safe and this is a no-op worth saying out loud.
    if (here != null && inns.some(i => i.inn === here)) {
      this.note('already in a sanctuary', { room: here, ...why });
      return { arrived: true, already: true };
    }
    // NEAREST FIRST, AND NOT MANY. Iterating the six in declaration order would send a
    // character bleeding in the Badlands to whichever inn happened to be listed first —
    // possibly across the world, through everything in between, at the health that made
    // it flee. So rank by actual hops and take the closest; anything unroutable sorts
    // last and is skipped.
    const ranked = inns
      .map(i => ({ ...i, hops: s.world?.route?.(i.inn)?.hops?.length ?? Infinity }))
      .filter(i => Number.isFinite(i.hops))
      .sort((a, b) => a.hops - b.hops);
    if (!ranked.length) {
      this.note('no inn is routable from here — falling back to a local wall', why);
      await this.withdraw(this.inReachOfUs() ?? []).catch(() => {});
      return { arrived: false, fell_back: true, no_route: true };
    }
    // Two attempts, not six. A retreat that keeps trying is a character walking while
    // being hit; if the two nearest both refuse, the wall here is the better bet.
    for (const dest of ranked.slice(0, 2)) {
      this.note('running all the way to safety', {
        to: dest.innName, room: dest.inn, hops: dest.hops, ...why,
        health: (() => { const h = c?.vitals?.()?.health; return h?.max ? Math.round(100 * h.value / h.max) + '%' : null; })(),
        why_not_local: 'a few squares from a crowd is still inside its vision and its chase — ' +
                       'an inn is a sanctuary and ends the fight',
      });
      const r = await this.travel(dest.inn, { reason: 'retreat' }).catch(e => ({ arrived: false, error: String(e) }));
      if (r?.arrived) {
        this.progress('reached safety at ' + dest.innName);
        this.fledInARow = 0;
        return { arrived: true, at: dest.innName, room: dest.inn, hops: dest.hops };
      }
    }
    // Nothing reachable. A wall here is better than nothing, so fall through to the
    // behaviour that at least gets our back covered.
    this.note('could not reach any inn — falling back to a local wall', why);
    await this.withdraw(this.inReachOfUs() ?? []).catch(() => {});
    return { arrived: false, fell_back: true };
  }

  async withdraw(threats) {
    const s = this.s, c = s.client;
    const me0 = c.self, geo0 = s.world?.geometry;
    if (!me0 || !geo0) { this.note('cannot withdraw', { why: 'no geometry' }); return; }

    // A WALL WE ALREADY HOLD IS NOT SOMETHING TO RUN FROM. We normally reach here
    // because the spot stopped working, but the rest of the loop can send us here
    // while a good one is still under us — and abandoning it to stand in the open is
    // strictly worse than staying. Check before paying for the walk.
    if (this.hold && this.holdWorks()) {
      this.note('staying behind the wall instead of withdrawing', {
        spot: { col: this.hold.col, row: this.hold.row }, threats: threats.length,
        why: 'this square has held under attack, so nothing here can land a blow — walking ' +
             'off it to gain distance would trade the one thing keeping us alive for space' });
      return;
    }

    // Somewhere defensible to run TO. Aim it at whatever is hitting us so the square
    // it picks is one the fight can actually be held at, and so we do not retreat into
    // a corner the threats simply follow us into.
    const spot = await this.takeSafeSpot(
      'withdrawing from a fight we are losing — to a wall, not into the open',
      threats[0] ?? null).catch(() => ({ took: false }));
    if (spot.took) {
      this.tally.withdrawals_to_a_wall = (this.tally.withdrawals_to_a_wall || 0) + 1;
      this.note('withdrew to a defensible square', {
        to: { col: this.hold?.col, row: this.hold?.row }, threats: threats.length,
        why: 'a spot that holds ends the fight on our terms and makes the logoff-and-turn ' +
             'heal available, which open ground does not' });
      return;
    }

    // No corner in this room. Fall back to distance, and say plainly that this is the
    // weak version — it is the branch that precedes most of the deaths.
    this.note('no wall to withdraw to', {
      why: spot.why, threats: threats.length,
      consequence: 'falling back to walking away, which buys seconds rather than safety',
      hint: 'this room cannot be fought in safely at this level; somewhere with a corner is' });
    // Only now is leaving the hold right — we have nowhere better, so the siege has to
    // be broken before the walk.
    // FORCED: this is the survival case, not a discretionary one. A hurt character is
    // exactly who is withdrawing, so the hurt refusal would block the one departure
    // that must always be allowed.
    await this.leaveHold('withdrawing from a fight we are losing', { force: true });
    const me = c.self, geo = s.world?.geometry;
    if (!me || !geo) { this.note('cannot withdraw', { why: 'no geometry' }); return; }
    const away = (r, col) => Math.min(...threats.map(t => Math.hypot(col - t.col, r - t.row)));

    let best = null;
    for (let r = 1; r <= geo.rows; r++) {
      for (let col = 1; col <= geo.cols; col++) {
        if (!geo.walkable(r, col)) continue;
        const d = away(r, col);
        if (d < 6) continue;                       // not far enough to be worth it
        const p = geo.path(me.row, me.col, r, col);
        if (!p.found) continue;
        // Prefer close-to-reach among the far-enough, so we spend the fewest seconds
        // being hit on the way out.
        if (!best || p.steps.length < best.steps) best = { row: r, col, steps: p.steps.length, dist: d };
      }
    }
    if (!best) { this.note('nowhere to withdraw to', { why: 'no reachable square far enough away' }); return; }
    const walk = await s.walkTo(best.col, best.row, { maxSteps: Math.max(30, best.steps + 10) });
    this.note('withdrew', { to: { col: best.col, row: best.row }, steps: walk.steps, arrived: walk.arrived });
  }
}

// ONE WALL EACH.
//
// The geometry is deterministic, so every keeper in a room ranks the same squares in
// the same order and they all walk to the identical corner — which is how three
// characters ended up on square (50,21) of the same room, and four stacked on (8,15)
// of the Limping Toad. Sharing a safe spot buys nothing: the wall covers a square, not
// a queue, and standing in a heap makes every one of them look to the others like a
// crowd of attackable things.
//
// A player might share a wall deliberately — one tanking while another heals past them
// is a real tactic.
//
// SO IT IS A SPREAD, NOT AN EXCLUSION. "One each" was right about the failure it was
// written for — four characters stacked on (8,15) of the Limping Toad — and wrong about
// what to do when there are more keepers than squares. A room with four walls and eight
// characters gave four of them a wall and sent the other four to the no-wall path, which
// is the branch that precedes most of the deaths. Two to a wall is worse than one and far
// better than none.
//
// The cap therefore RISES ONLY WHEN IT HAS TO: every square fills to one before any takes
// a second, and to two before any takes a third. takeSafeSpot retries with a higher cap
// when the search comes back empty, so the distribution is a consequence of the search
// rather than a number anybody has to maintain.
//
// The register lives in the module rather than in a keeper because that is the only
// place all of them can see: every session in a broker shares this process.
//
// A SQUARE HOLDS A SET, NOT A NAME, because partners share one on purpose (see
// m59-party.mjs). With a single name the second partner to claim simply overwrote the
// first, and the register then believed the first had gone — so releasing the second
// freed a square somebody was still standing on. Everyone who is actually there is
// recorded; who is ALLOWED to join is a separate question, answered below.
const claimedSpots = new Map();        // "room:col,row" -> Set<agent name>
const spotKey = (room, col, row) => `${room}:${col},${row}`;

export function claimSpot(agent, room, col, row) {
  releaseSpot(agent);                  // one square each; claiming a new one gives up the old
  const k = spotKey(room, col, row);
  let held = claimedSpots.get(k);
  if (!held) claimedSpots.set(k, held = new Set());
  held.add(agent);
}
export function releaseSpot(agent) {
  for (const [k, who] of claimedSpots) {
    if (!who.delete(agent)) continue;
    if (!who.size) claimedSpots.delete(k);
  }
}
// WHO IS IN THE WAY — meaning who is standing here that this agent may not join.
//
// Partners are not in the way. That is the exception the ONE WALL EACH note above
// carves out, and it is the only one: every other keeper is still refused, so an
// uncoordinated fleet cannot pile onto the same corner.
// How many OTHERS are standing here that this agent is not deliberately sharing with.
// Partners are not crowding us — that is the exception m59-party.mjs relies on — so they
// do not count toward the cap.
export function spotOccupancy(agent, room, col, row) {
  const held = claimedSpots.get(spotKey(room, col, row));
  if (!held) return 0;
  let n = 0;
  for (const who of held) {
    if (who === agent) continue;
    if (mayShareSpot(agent, who)) continue;
    n++;
  }
  return n;
}
// `cap` is how many strangers this agent will tolerate on the square. 1 is the old
// behaviour and stays the default, so every existing caller is unchanged; takeSafeSpot
// raises it a step at a time when nothing is free at the current level, which is what
// turns "one each" into "spread evenly".
export function spotTakenByAnother(agent, room, col, row, cap = 1) {
  const held = claimedSpots.get(spotKey(room, col, row));
  if (!held) return null;
  if (spotOccupancy(agent, room, col, row) < cap) return null;
  for (const who of held) {
    if (who === agent) continue;
    if (mayShareSpot(agent, who)) continue;
    return who;
  }
  return null;
}
// How deep the stacking is allowed to get before a wall stops being worth sharing. Four
// on one square is the pile-up this register exists to prevent; three is the point where
// the wall covers less than it costs.
export const SPOT_SHARE_CAP = 3;
export const claimedSpotList = () =>
  [...claimedSpots.entries()].flatMap(([k, who]) => [...who].map(agent => ({ at: k, agent })));

// WHICH ROOM EACH KEEPER IS IN, refreshed every pass.
//
// Errands name a destination room, and by the time the character has walked there the
// target may have roamed — the supervisor runs the fleet with roam on, so they move
// constantly. Without this, a quartermaster that arrives to an empty room can only give
// up, and the commonest provisioning outcome was "they had moved on". One shared map in
// the module, the same trick as claimedSpots: every session in a broker is this process.
const lastRoom = new Map();            // agent -> { room, name, at }
export function noteWhere(agent, room, name = null) {
  lastRoom.set(agent, { room: Number(room), name, at: Date.now() });
}
export function whereIs(agent, { staleMs = 120000 } = {}) {
  const r = lastRoom.get(agent);
  if (!r) return null;
  return (Date.now() - r.at) > staleMs ? null : r;   // a stale reading is worse than none
}

// Where a particular keeper is standing, for the one case that WANTS to share: a loot
// runner sheltering on the farmer's wall while it picks up behind them.
export function spotHeldBy(agent) {
  for (const [k, who] of claimedSpots) {
    if (who !== agent) continue;
    const [room, rc] = k.split(':');
    const [col, row] = rc.split(',');
    return { room: Number(room), col: Number(col), row: Number(row) };
  }
  return null;
}

// One keeper per agent, held by the broker.
const pilots = new Map();
export function autopilotFor(session) {
  if (!pilots.has(session.name)) pilots.set(session.name, new Autopilot(session));
  return pilots.get(session.name);
}
export function dropAutopilot(name) {
  const p = pilots.get(name);
  // HARD, because the object is being thrown away. An inert keeper is a running loop
  // holding a session; leaving one behind here would keep a discarded autopilot alive and
  // recording against a character nobody is tracking any more.
  if (p) p.stop('the keeper is being discarded', { hard: true });
  pilots.delete(name);
}
export const autopilotIfAny = (name) => pilots.get(name) || null;
export const allAutopilots = () => [...pilots.entries()].map(([name, p]) => ({ name, ...p.status() }));
