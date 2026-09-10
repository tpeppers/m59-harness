// THE TWO ANSWERS THIS REPOSITORY IS NOT ALLOWED TO GIVE.
//
//   node tools/m59-critic.mjs                       both lenses, worst first
//   node tools/m59-critic.mjs travel --since 48h    the non-PVP travel deaths, as defects
//   node tools/m59-critic.mjs node                  the mana nodes, as missing affordances
//   node tools/m59-critic.mjs --rubric              the gates a verdict has to clear
//   node tools/m59-critic.mjs travel --tasks tmp/tasks.json    the worklist for the critic
//   node tools/m59-critic.mjs ingest tmp/verdicts.json         judge the judgements
//   node tools/m59-critic.mjs travel --postmortems <dir>       read that store instead
//   node tools/m59-critic.mjs travel --no-probe                do not ask a broker where it writes
//
// IT READS THE FLEET'S DEATHS, NOT THIS TREE'S. A keeper writes postmortems into the checkout it
// is running from, and prod runs from a different worktree — so the store is RESOLVED (explicit,
// then M59_POSTMORTEM_DIR, then the live broker's own `/health`, then here) and every run prints
// which directory it read and how many records were in it. On 2026-09-10 this tool answered
// "nothing in the window" for twelve hours holding forty-four deaths. The argument, and why an
// empty window has to name its directory, is above `substrateOf` in m59-postmortems.mjs.
//
// This is the TIER-1 half of a two-tier critic, in the SAILOR shape: a cheap, deterministic,
// wide-net locator that says WHERE TO LOOK and hands a strict rubric to a Tier-2 critic that
// reads the site and decides. Nothing here judges anything. The judge is the agent, and its
// instructions are `.claude/skills/m59-critic/SKILL.md`.
//
// WHAT IS INVERTED, AND WHY IT HAD TO BE. SAILOR's critic is default-REFUTED: a heuristic
// guessed, so make it earn a finding. Neither of the two questions here is a guess. A
// character died. A stone was not reached. The observation is not in doubt, and judging it
// "real" would be judging nothing. What is in doubt is WHAT THE OBSERVATION IS EVIDENCE OF,
// and in both cases this repository has a comfortable answer that is TRUE AND CLOSES THE FILE:
//
//   "killed by a spider"              the server said so. It is an observation wearing a
//                                     conclusion's clothes.
//   "no route / needs new jumping     the router said so. It is a statement about the model,
//    mechanics"                       read as a statement about the world.
//
// So the polarity flips. THE DEFAULT VERDICT IS DEFECT, AND THE BURDEN OF PROOF IS ON THE
// EXCUSE. A wide net that is safe because the critic is strict becomes a wide net that is
// USEFUL because the critic refuses to be satisfied.
//
// ---------------------------------------------------------------------------------------
// LENS A — A TRAVEL DEATH THAT IS NOT PVP IS A BUG REPORT.
//
// The operator's axiom, and it is the whole warrant: TOP-TIER PLAYERS DO NOT DIE TO MONSTERS
// FOR MONTHS TO YEARS AT A TIME, EVEN PLAYING INTOXICATED. A human at that level is not being
// lucky and is not being careful. Dying to the world's ambient monsters is not a risk they
// carry at a low rate — it is a thing that DOES NOT HAPPEN TO THEM. So when it happens here,
// the difference between the fleet and that player is not nerve, attention or dice. It is
// code, and the death is a bug report the fleet filed by dying.
//
// MEASURED 2026-09-10 against this checkout's 2,859 postmortems, which is why this exists:
//
//     1,330  died `travelling` — more than every other activity combined
//     1,268  of those killed by something the monster table resolves (95.3%)
//     1,181  of those with NO non-fleet player anywhere in the room (88.8% of travelling)
//     1,131  of 1,330 died with the keeper's own longest pass block over SIXTY SECONDS
//     1,108  killer confirmed by the server's own broadcast, and a monster
//
// Eighty-five per cent of them died while nobody was looking. That is not a monster being too
// strong. Read the worst and the shape repeats: `Fozzie`, 1,199 wedges and a longest block of
// 1,779 seconds. `Oooo`, blocked 5,707 seconds — ninety-five minutes — and wedged on one
// square for the last 51 of them with six things hitting it. Of the 163 that carry a movement
// summary, 59 made NET ZERO SQUARES while being eaten; one stood still for 132 seconds with
// twenty-five bodies on it. A level-58 character does not die to spiders. A level-58 character
// that does not move for twenty-five seconds dies to anything.
//
// The crowd sizes are their own indictment. `most_at_once` across those deaths: 3.2% died with
// five or fewer things on them; 79% died with TEN OR MORE. A road that puts ten monsters on a
// traveller is not a dangerous road, it is a routing decision nobody made on purpose.
//
// SO THE ONE LEGITIMATE "NOT A DEFECT" IS PVP, AND IT MUST BE SHOWN RATHER THAN ASSUMED. This
// repository has already been burned by the other direction: an unresolved resource id answers
// `<dynamic 1000081>`, which is a truthy string, and counting it made a death surrounded by six
// trolls read as PVP (Uuuu, 2026-08-28). A monster landing the last blow during a fight with a
// person is still a PVP death — so the two columns are kept apart and both are reported: who
// the server said killed it, and which non-fleet people were in the room. The fleet roster is
// inferred FROM THE CORPUS rather than read out of `fleet-accounts.json`, because that file is
// the only copy of the passwords and a reporting tool has no business opening it.
//
// ---------------------------------------------------------------------------------------
// LENS B — "UNREACHABLE" IS A FACT ABOUT THE MAP WE HAVE WRITTEN DOWN.
//
// Every mana node stands in a room a person can walk to in the retail client. That is not a
// hope, it is the premise: they are easter eggs, they were designed to be got, and players get
// them. So a router answering "no route" has proved something about `m59-falljumps.json` and
// the flood in `reachableFrom`, and NOTHING WHATEVER about the world. The agent is standing in
// that room BECAUSE the model is missing a jump, a ramp, a passage or a trigger. Finding which
// is the errand — it is not the obstacle.
//
// THE MEASUREMENT THAT MAKES THIS A RULE RATHER THAN AN ATTITUDE. `m59-falljumps.json` declares
// eight jumps, in four rooms: 599, 108, 579, 589. Line that up against the mover's own verdict
// on the seven stones and the predictor is not the terrain:
//
//     579  Ancient Place    four declared falls        reachable
//     589  Sentinel         one declared fall          reachable ONLY across it
//     39   Castle Victoria  reached over 599's fall    reachable
//     27   Icky Cave        NONE                       "unreachable" — AND ALREADY MELDED
//     45   Badlands         NONE                       "needs new jumping mechanics"
//     515  Seafarer's Peak  NONE                       "needs new jumping mechanics"
//     750  Ice Caves        NONE                       "needs new jumping mechanics"
//     1006 Mausoleum        NONE                       "needs new jumping mechanics"
//
// The column that predicts the verdict is WHETHER SOMEBODY WROTE THE JUMP DOWN. Room 27 is the
// control case and it is decisive: four independent measurements called it unreachable on a
// night when the operator had already melded it, and the retraction (fleetscript header,
// 2026-09-10) names the reason — the route is a jump this repository has never declared, and
// six orcs were standing in it. Height-agnostic collision means a body on the take-off, in the
// arc or on the landing refuses the move exactly like a wall, and then walks away.
//
// THAT ROW HAS NOW BEEN WRONG TWICE IN ONE DAY. 750 Ice Caves is ONE SQUARE off, inside the 5x5
// meld box, by walking alone — it needs no new jumping mechanics of any kind. 45 Badlands is
// THREE off, one square outside the box. Two of the four "impossible" entries fell to an
// afternoon of `m59-exitreport.mjs` rather than to new mechanics. A category that loses half its
// members the first time anybody measures it is not a category.
//
// So `unreachable`, `impossible` and `needs new jumping mechanics` are INADMISSIBLE as terminal
// verdicts here. Each is `no route` wearing a hat. A verdict has to name the missing affordance
// from a closed vocabulary, or say which measurement would tell two of them apart — and "the
// ground refuses" against "something is standing on it" is the pair that has cost the most nights.
//
// WHAT THIS TOOL WILL NOT DO. It will not tell you a death was a defect; it cannot read the
// code. It will not tell you which jump is missing; it has never seen the room. It locates, it
// cites, it hands over the gates, and it refuses a verdict that does not clear them. The judging
// is the agent's, and a judgement that names nothing is rejected on ingest.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolvePostmortemStores } from './m59-postmortems.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

// ── THE CLOSED VOCABULARIES ───────────────────────────────────────────────────────────────
//
// A verdict picks from these. Free text is how "it was overwhelmed" gets back in wearing a
// longer sentence, and a class nobody can name is a class nobody can grep the ledgers for.

// LENS A. What a non-PVP travel death is evidence OF. Ordered worst-first: the earlier classes
// are defects in whether the fleet was being driven at all, the later ones in what it decided
// while it was.
export const DEFECT_CLASSES = Object.freeze({
  keeper_blind: 'the keeper pass was blocked or elsewhere while the body took damage. Nobody '
              + 'was driving. The killer is irrelevant to this class and naming it is the error.',
  wedged: 'the mover was asked to move, refused, and kept refusing. Name the refusing predicate '
        + '— `no_ground_gained`, `refused_edges`, a step-height cap, a body in the way.',
  routed_into_a_crowd: 'the route put the body in a room with more threats than any traveller '
                     + 'crosses. The router had the room contents and either used them or did not.',
  guard_did_not_fire: 'a rung that exists — flee, divert, safe-spot, handbrake, travel_guard — '
                    + 'was gated off, ran out of order, or its threshold was never reached.',
  doctrine_wrong: 'the rung fired exactly as written and the writing is wrong for this case. The '
                + 'repair is the doctrine, and it needs the operator.',
  arrived_unfit: 'the body set out or pressed on below what the road costs — health, vigor, '
               + 'flasks, buffs. The defect is upstream of the death, in whatever let it leave.',
  instrument_missing: 'the record cannot support any of the above. Name the field that is absent '
                    + 'and where it would be written. A blind spot is a finding.',
  pvp: 'a person killed it, or a monster landed the last blow during a fight with one. NOT a '
     + 'defect. Requires a named non-fleet player, never an unresolved resource id.',
});

// LENS B. What "no route to the stone" is evidence OF. None of these is a property of the
// terrain; every one is a property of what we have written down about it.
export const MISSING_AFFORDANCES = Object.freeze({
  undeclared_jump: 'a fall or leap `substrate/m59-falljumps.json` does not carry. The flood '
                 + 'cannot see it, so every planner here answers "no route" about a route the '
                 + 'fleet has walked. Room 27 is the proven case.',
  unspelled_staircase: 'treads each legal on its own that the walker cannot spell as steps. 579 '
                     + 'is 5152 -> 5504 -> 5856 -> 6208, +352 a tread, legal every one of them, '
                     + 'and invisible unless you board at the bottom.',
  split_square: 'the coarse grid summarising a ledge and a valley as one number. r40c33 spans '
              + '3520 to 10880. Ask it where the floor is and it answers, wrongly.',
  occupancy: 'a body in the take-off, the arc or the landing. Collision is height-agnostic, so it '
           + 'refuses like a wall and then walks away. THE ONLY SOURCE OF NON-DETERMINISM here, '
           + 'and the reason one visit is never a measurement.',
  trigger: 'a lever, a door state, a karma gate, a timed or spoken effect. The room is not the '
         + 'same room in both states and the bake holds one of them.',
  unit_space: 'three coordinate spaces. FINENESS is 64 in kod and 1024 in the client; `walk_to` '
            + 'takes kod protocol units, and client units walk the body off the map.',
  predicate: 'the mover refused and said why. The predicate is named, the fix differs per name, '
           + 'and this is the class to prefer whenever the refusal was actually printed.',
  approach_wrong: 'the geometry is fine from a door nobody used. Room 39 is reachable from the '
                + 'EAST doorway and 22 squares short from the other one.',
  measured_reachable: 'already inside the meld box, and the claim is simply stale. 750 is one '
                    + 'square off by walking. Check before theorising.',
  instrument_missing: 'nothing in this repository can currently tell two of the classes above '
                    + 'apart here. Name the tool that would, and what it would print. This is '
                    + 'the honest floor, and it is a finding — never a shrug.',
});

// ── THE INADMISSIBLE ANSWERS ──────────────────────────────────────────────────────────────
//
// Both lenses share a failure mode: a true sentence that ends the enquiry. These are matched
// against a verdict's prose on ingest and rejected — not because they are false, but because
// each is a RESTATEMENT OF THE OBSERVATION and none of them can be acted on.
export const INADMISSIBLE = Object.freeze([
  { lens: 'travel', re: /\b(overwhelmed|too (strong|tough|many)|outnumbered|unlucky|bad luck)\b/i,
    why: 'a description of the outcome. Top-tier players are not overwhelmed for years at a time.' },
  // Anchored per LINE — the fields are joined with newlines before matching, and the thing being
  // caught is a whole answer that is nothing but the broadcast, not the phrase used in passing.
  { lens: 'travel', re: /^\s*killed by (a|an|the)?\s*[\w' -]+\.?\s*$/im,
    why: 'the server already said this. It is the observation, not a reading of it.' },
  { lens: 'travel', re: /\bthe roads? (are|is) dangerous\b|\b(risk|danger)s? of (travel|the road)\b/i,
    why: 'the road being dangerous is the premise of the whole harness, not a finding about a death.' },
  { lens: 'travel', re: /\b(working as intended|expected behaviou?r|nothing to fix|not a bug)\b/i,
    why: 'available only as `doctrine_wrong` with the doctrine cited, or `pvp` with a named person.' },
  { lens: 'node', re: /\b(unreachable|impossible|cannot be reached|not reachable|no route)\b/i,
    why: 'a statement about the flood and the declared-jump file. A player is standing on this stone.' },
  { lens: 'node', re: /\bneeds? new jumping mechanics\b/i,
    why: 'the row that has already been wrong twice in one day (750 needs none; 45 is one square out).' },
  { lens: 'node', re: /\bthe (terrain|geometry|map) (does not|doesn't) (allow|permit|support)\b/i,
    why: 'the terrain is the one thing here not in doubt. Our model of it is.' },
  { lens: 'both', re: /\b(needs? (further|more) (investigation|debugging)|investigate further|inconclusive)\b/i,
    why: 'not a verdict. `instrument_missing` with the absent field named is the honest version.' },
]);

// AN ATTRIBUTED REFUSAL IS A CITATION, NOT A VERDICT, AND THE DIFFERENCE IS THE WHOLE JOB.
//
// "the flood reads as unreachable at whatever distance it stops" is the critic QUOTING the
// model, which is exactly what G1 asks for. "the stone is unreachable" is the critic AGREEING
// with it, which is the thing banned. Both contain the word, and a ban that cannot tell them
// apart makes the only passing verdict one that never says what the tool actually printed —
// which is how a rule gets worked around instead of followed.
//
// The difference is an attribution verb in front of it, so one is required before a match
// counts. This is deliberately narrow: it exempts a quotation, never a conclusion.
const ATTRIBUTED = /\b(reads?|reports?|reported|answers?|answered|says?|said|called|claims?|claimed|returns?|returned|prints?|printed|flagged|filed|labell?ed|insists?)\s+(it\s+|them\s+|this\s+|that\s+)?(as\s+|that\s+)?["'`“]?\s*$/i;

// ── THE GATES ─────────────────────────────────────────────────────────────────────────────
export const GATES = Object.freeze({
  G1: { name: 'CITE', asks: 'the exact field, line or file carrying the evidence — '
                          + '`summary.watchdog.longest_block_ms = 1779000`, `m59-falljumps.json '
                          + 'has no entry for room 45`. A number nobody can look up is a mood.' },
  G2: { name: 'MECHANISM', asks: 'one sentence joining that citation to the outcome. If the '
                               + 'sentence needs "and then it was overwhelmed", the chain is broken.' },
  G3: { name: 'CLASS', asks: 'a name from the lens vocabulary. No free-text classes — the ledgers '
                           + 'are grepped by these, and a class of one is a class of none.' },
  G4: { name: 'DELIVERABLE', asks: 'the file and the change, OR the one question only the operator '
                                 + 'can answer, OR the field missing from the record and where it '
                                 + 'would be written. Never "look into it".' },
  G5: { name: 'STEELMAN', asks: 'the excuse, argued in its strongest form FIRST, and then why it '
                              + 'fails. The default here is DEFECT, so the critic earns it by '
                              + 'defeating the comfortable answer rather than by not thinking of it.' },
});

export const VERDICT_SHAPE = Object.freeze({
  id: '<the candidate id, carried through verbatim>',
  lens: 'travel | node',
  verdict: 'travel: defect | not_a_defect | instrument_missing. '
         + 'node: missing_affordance | measured_reachable | instrument_missing',
  class: '<one key of DEFECT_CLASSES (travel) or MISSING_AFFORDANCES (node)>',
  cite: '<G1: the field/file/line, and its value>',
  mechanism: '<G2: one sentence from that citation to the outcome>',
  steelman: '<G5: the excuse at its strongest, then why it fails>',
  deliverable: '<G4: file+change, or the one operator question, or the missing field>',
  person: '<travel/pvp only: the resolved name of the person who killed it>',
  confidence: '0..1',
});

// ── READING NAMES (kept pure, so the logic above tests offline) ───────────────────────────

// Every string the monster classes name themselves by. `_res` carries name, koc name and dead
// name per class, and a killer broadcast can be any of them.
export function monsterNames(table) {
  const out = new Set();
  for (const m of table || []) {
    for (const r of Object.values(m?._res || {})) {
      const s = Array.isArray(r) ? r[0] : r;
      if (typeof s === 'string' && s.trim()) out.add(s.toLowerCase().trim());
    }
  }
  return out;
}

// IS THIS NAME A MONSTER, BY WHOLE WORDS AND NEVER BY SUBSTRING. "ant" sits inside "Grant", and
// a substring test turns a person into a bug — which is the exact direction that produced the
// Uuuu misreading, in reverse. Articles are stripped, then leading adjectives are dropped one at
// a time, because the broadcast says "battered skeleton" and the class is "skeleton". Returns
// the matched class name, or null.
export function resolveMonster(name, monsters) {
  if (!name || !monsters) return null;
  const words = String(name).toLowerCase()
    .replace(/^(a|an|the)\s+/, '').replace(/[.!]+$/, '').trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const tail = words.slice(i).join(' ');
    if (monsters.has(tail)) return tail;
  }
  return null;
}

// THE FLEET, FROM THE CORPUS. Every postmortem names the character it is about, so the set of
// them IS the roster this broker has driven — without opening the password file.
export function roster(records) {
  const out = new Set();
  for (const r of records || []) if (r?.character) out.add(r.character);
  return out;
}

// ...BUT NEVER FROM A WINDOWED CORPUS, WHICH IS HOW A FLEET-MATE BECOMES A STRANGER.
//
// `roster(records)` is right about the whole store and WRONG about a slice of it, and the call
// site passed it the `--since` window. A character who did not happen to die in the last twelve
// hours was then absent from the inferred fleet, so `strangers` — which is every player in the
// room who is not fleet — picked them up and the death came back CONTESTED.
//
// FOUND 2026-09-10 by the fix above: with prod's real store finally being read, Kermit's death
// reported "CONTESTED: Janice in the room", Waldorf's "CONTESTED: Statler", Lew's
// "CONTESTED: Animal". All three are on `substrate/fleets/prod.json`. Every one of the 33
// candidates in that window was contested by a fleet-mate.
//
// THAT IS THE Uuuu FAILURE ARRIVING THROUGH A DIFFERENT DOOR, and it is the expensive direction.
// `pvp` is the single verdict this lens accepts as NOT a defect, `gateCheck` admits one only if
// the named person is among `strangers`, and this handed it a list of our own characters to
// validate against. A false stranger does not merely add noise — it makes a false exemption
// PASS THE GATE.
//
// SO THE ROSTER IS READ FROM THE WHOLE STORE, and cheaply. The filename cannot be used for it:
// the writer strips whitespace, so `Marco Polo` is on disk as `MarcoPolo-<stamp>.json` and
// `Loial the Ogier` as `LoialtheOgier-...`, and a roster built from stems would call both of
// them strangers — the same bug wearing the fix's clothes. But the stem does partition the store
// by character, so ONE representative file per stem yields the real `character` field: about
// twenty-five reads against three thousand.
export function rosterFromStore(dir, { readdir = readdirSync, read = readFileSync } = {}) {
  const out = new Set();
  let names;
  try { names = readdir(dir).filter(f => f.endsWith('.json')); } catch { return out; }
  const byStem = new Map();
  for (const f of names) {
    const m = f.match(/^(.+?)-\d{4}-\d{2}-\d{2}T/);
    if (!m) continue;
    if (!byStem.has(m[1])) byStem.set(m[1], []);
    const bucket = byStem.get(m[1]);
    // Three is enough to survive a half-written record — a keeper that died mid-write — without
    // turning "one read per character" back into "read the whole store".
    if (bucket.length < 3) bucket.push(f);
  }
  for (const [, files] of byStem) {
    for (const f of files) {
      try {
        const c = JSON.parse(read(join(dir, f), 'utf8'))?.character;
        if (c) { out.add(c); break; }
      } catch { /* try the next representative for this character */ }
    }
  }
  return out;
}

// ── LENS A ────────────────────────────────────────────────────────────────────────────────

// WHO THE SERVER SAID KILLED IT, AND WHETHER ANYBODY IS ENTITLED TO SAY.
//
// `killed_by_broadcast` is the server shouting it to the whole world and is the only killer
// worth the name. `summary.killed_by` is what was standing next to the body at the end, which
// `m59-postmortems.mjs` measured against the broadcasts and found right 51% of the time — a coin
// flip. So the two never merge: `observed` says which one this is.
export function killerOf(pm, monsters) {
  const bc = pm?.killed_by_broadcast;
  if (bc?.killer) {
    const cls = resolveMonster(bc.killer, monsters);
    return { name: bc.killer, observed: true, is_monster: !!cls, monster_class: cls,
             cite: 'killed_by_broadcast.killer' };
  }
  const guess = (pm?.summary?.killed_by || [])[0];
  if (guess) {
    const cls = resolveMonster(guess, monsters);
    return { name: guess, observed: false, is_monster: !!cls, monster_class: cls,
             cite: 'summary.killed_by[0] (A GUESS — right 51% of the time)' };
  }
  return { name: null, observed: false, is_monster: false, monster_class: null, cite: null };
}

// THE PVP EXEMPTION, AND IT IS THE ONLY ONE. Shown, never assumed: a NAMED non-fleet person has
// to have been in the room. An id the resource table could not resolve answers
// `<dynamic 1000081>`, which is truthy and is not a person — Uuuu, 2026-08-28, where counting it
// turned six trolls into a PVP death.
export function strangersPresent(pm, fleet) {
  const known = fleet || new Set();
  return (pm?.threats?.players_present || [])
    .filter(n => typeof n === 'string' && n.trim() && !/^<.*>$/.test(n))
    .filter(n => !known.has(n));
}

// THE SIGNATURES. Each is a mechanical fact with a citation, and each is the reason a given
// defect class is worth considering FIRST. None of them is a verdict; they are where to look.
export function signatures(pm) {
  const s = pm?.summary || {}, w = s.watchdog || {}, mv = s.movement || {}, out = [];
  const push = (name, cite, says, suggests) => out.push({ name, cite, says, suggests });

  if (Number.isFinite(w.longest_block_ms) && w.longest_block_ms > 60_000)
    push('keeper_blind', `summary.watchdog.longest_block_ms = ${w.longest_block_ms}`,
         `nobody drove this body for ${Math.round(w.longest_block_ms / 1000)}s at a stretch`,
         'keeper_blind');
  if (pm?.during_keeper_outage)
    push('outage', 'during_keeper_outage', 'the keeper was down across the death', 'keeper_blind');
  if (w.wedged_at_death)
    push('wedged_at_death', `summary.watchdog.wedged_at_death.for_ms = ${w.wedged_at_death.for_ms}`,
         `refusing to move for ${Math.round((w.wedged_at_death.for_ms || 0) / 1000)}s, inert on `
         + `"${w.wedged_at_death.inert ?? '?'}"`, 'wedged');
  else if (Number.isFinite(w.wedges) && w.wedges > 0)
    push('wedges', `summary.watchdog.wedges = ${w.wedges}`,
         `${w.wedges} separate refusals to move over this life`, 'wedged');
  if (mv.net_squares === 0 && Number.isFinite(mv.seconds) && mv.seconds > 10)
    push('net_zero', `summary.movement.net_squares = 0 over ${mv.seconds}s`,
         'the body finished where it started while taking damage', 'wedged');
  else if (Number.isFinite(mv.squares_per_second) && mv.squares_per_second < 1
           && Number(mv.samples) > 4)
    push('crawling', `summary.movement.squares_per_second = ${mv.squares_per_second}`,
         'a fraction of the 5 squares/second the walker paces to', 'wedged');
  if (Number.isFinite(pm?.was?.ms_since_moved) && pm.was.ms_since_moved > 5_000)
    push('inert_at_death', `was.ms_since_moved = ${pm.was.ms_since_moved}`,
         `stationary for the last ${Math.round(pm.was.ms_since_moved / 1000)}s`, 'wedged');
  const crowd = pm?.threats?.most_at_once;
  if (Number.isFinite(crowd) && crowd >= 10)
    push('crowd', `threats.most_at_once = ${crowd}`,
         'a crowd no traveller crosses; 79% of these deaths are in one', 'routed_into_a_crowd');
  else if (Number.isFinite(crowd) && crowd >= 6)
    push('crowd', `threats.most_at_once = ${crowd}`,
         'at or above travelStopMaxThreats, where a journey stops making stops',
         'routed_into_a_crowd');
  if (Number.isFinite(s.fled_in_time) && s.fled_in_time < 0.2)
    push('never_fled', `summary.fled_in_time = ${s.fled_in_time}`,
         'the flee rung did not get it out', 'guard_did_not_fire');
  if (s.at_a_safe_wall)
    push('died_at_a_wall', 'summary.at_a_safe_wall',
         'died ON a square the safe-spot book calls a wall — so the wall was not one',
         'guard_did_not_fire');
  if (Number.isFinite(pm?.vitals?.last_vigor) && pm.vitals.last_vigor <= 1)
    push('no_vigor', `vitals.last_vigor = ${pm.vitals.last_vigor}`,
         'no vigor, so no recovery was purchasable at any price', 'arrived_unfit');
  if (!s.movement && !s.watchdog)
    push('thin_record', 'summary.movement and summary.watchdog both absent',
         'this generation of postmortem cannot answer the question', 'instrument_missing');
  return out;
}

// THE CANDIDATES. A non-PVP travel death, with its signatures and its citation, and nothing
// decided. `doings` is deliberately wider than `travelling`: `stalled` is 1,007 more deaths that
// were going somewhere and stopped, which is the same defect wearing the keeper's word for it
// rather than the router's.
export function travelCandidates(records, { monsters, fleet, since = 0, character = null,
                                            doings = ['travelling', 'stalled'] } = {}) {
  const out = [];
  for (const pm of records || []) {
    if (pm?.reason !== 'died') continue;
    if (since && Number(pm.at || 0) < since) continue;
    if (character && pm.character !== character) continue;
    const doing = pm?.was?.doing || pm?.summary?.doing || 'unknown';
    if (!doings.includes(doing)) continue;

    const killer = killerOf(pm, monsters);
    const strangers = strangersPresent(pm, fleet);
    // THE EXEMPTION IS NARROW ON PURPOSE. A person in the room makes this CONTESTED, not exempt
    // — a monster landing the last blow during a fight with somebody is still PVP, and only
    // reading the text can tell. Contested candidates are kept, flagged, and still default to
    // defect, because the fleet dying while two people fight over it is also the fleet dying.
    const pvp = strangers.length > 0 && !(killer.is_monster && killer.observed);
    const contested = strangers.length > 0 && !pvp;

    const sigs = signatures(pm);
    out.push({
      id: `travel/${pm.character}/${new Date(Number(pm.at) || 0).toISOString()}`,
      lens: 'travel',
      subject: `${pm.character} lvl ${pm.vitals?.level ?? '?'} in ${pm.where?.room ?? '?'} `
             + `(${pm.where?.num ?? '?'}) at ${pm.where?.col ?? '?'},${pm.where?.row ?? '?'}`,
      at: Number(pm.at) || 0,
      doing,
      killer,
      strangers,
      pvp,
      contested,
      signatures: sigs,
      // Worst-first by how MECHANICAL the evidence is, never by how bad the death looked. A
      // blind keeper outranks a big crowd because it explains the crowd.
      weight: (sigs.some(x => x.suggests === 'keeper_blind') ? 100 : 0)
            + (sigs.some(x => x.suggests === 'wedged') ? 50 : 0)
            + (sigs.some(x => x.suggests === 'guard_did_not_fire') ? 20 : 0)
            + (sigs.some(x => x.suggests === 'routed_into_a_crowd') ? 10 : 0)
            + (pvp ? -1000 : 0),
      default_verdict: pvp ? 'not_a_defect (PVP — and SHOW the person)' : 'defect',
      asks: pvp
        ? 'name the person, and the evidence that they rather than the room killed it.'
        : 'name the defect class, cite the field, say what the repair is. "Killed by a monster" '
        + 'is the observation and is not available as an answer.',
    });
  }
  out.sort((a, b) => b.weight - a.weight || b.at - a.at);
  return out;
}

// ── LENS B ────────────────────────────────────────────────────────────────────────────────

// THE MOVER'S OWN VERDICT ON EACH STONE, TRANSCRIBED WITH ITS PROVENANCE.
//
// This is a `#movement` EPOCH FACT and it goes stale the moment somebody fixes the mover — which
// is the point of the exercise, so the report prints the epoch beside it rather than pretending
// the numbers are about the map. `off` is Chebyshev from the square a body lands on coming in,
// and the meld test is `abs(drow) < 3 AND abs(dcol) < 3` per axis (mananode.kod:177), so anything
// at 2 or less is already inside the box.
export const MOVER_VERDICT = Object.freeze({
  _source: 'tools/m59-fleetscript.mjs header, measured 2026-09-10 with '
         + '`m59-exitreport.mjs <room> --to <rNcM> --box 2`',
  _epoch: '#movement — a statement about which code was running, not about the terrain',
  27:   { off: 4,  melded: true,
          note: 'reached anyway. Melded 2026-09-09; the route is a jump nobody has declared.' },
  39:   { off: 0,  note: 'reachable from the EAST doorway only; 22 squares short from the other.' },
  45:   { off: 3,  note: 'ONE square outside the meld box, from r60c46.' },
  515:  { off: 5,  note: 'no measurement beyond the walking flood.' },
  579:  { off: 0,  note: 'four declared falls carry it.' },
  589:  { off: 0,  note: 'only across the declared fall r35c16 -> r38c19, entered from 599.' },
  750:  { off: 1,  note: 'INSIDE the meld box by walking alone. Filed as needing new jumping '
                       + 'mechanics; it needs none.' },
  // No route from anywhere, and that is the DESIGN — see the exemption in nodeCandidates.
  1006: { off: 10, note: 'no route from anywhere, by design: the guest demonstration stone.' },
});

// The room is the unit a jump is declared in, so this is the whole of the Tier-1 signal: does
// anything in this room exist in the model beyond walking?
export function declaredJumpsIn(room, jumps) {
  return (jumps || []).filter(j => Number(j?.room) === Number(room));
}

export function nodeCandidates({ nodes, jumps, verdicts = MOVER_VERDICT, dossiers = [] } = {}) {
  const out = [];
  for (const [key, spot] of Object.entries(nodes || {})) {
    const declared = declaredJumpsIn(spot.room, jumps);
    const v = verdicts?.[spot.room] || {};
    const off = Number.isFinite(v.off) ? v.off : null;
    const inBox = off != null && off <= 2;
    const sigs = [];
    // THE ONE EXEMPTION TO LENS B, AND IT IS THE OPERATOR'S. This lens exists to refuse
    // "unreachable" as a verdict, because every stone stands where a person can walk — with one
    // exception, stated 2026-09-10: "The 'Hazar' mana node is unreachable for normal players, by
    // the way, it's meant to demo the mana node existence for guest players." So NODE_GUEST's
    // absent route is the DESIGN. Filing it as a missing affordance is the critic manufacturing
    // work, which is worse here than anywhere: this file's whole claim is that it will not
    // accept a comfortable answer, and a false finding spends somebody's night.
    if (spot.guest_demo) {
      out.push({
        id: `node/${key}`, lens: 'node', subject:
          `${key} — ${spot.node}, room ${spot.room} (${spot.where}), stone at r${spot.row}c${spot.col}`,
        room: spot.room, declared_jumps: declared.length, off,
        note: 'EXEMPT — the guest demonstration stone. Unreachable BY DESIGN (operator, ' +
              '2026-09-10), so no affordance is missing and there is nothing here to fix.',
        signatures: [{ name: 'exempt_by_design',
                       cite: 'operator, 2026-09-10: meant to demo the mana node existence for ' +
                             'guest players',
                       says: 'the only stone this lens does not judge.',
                       suggests: 'no_action' }],
        weight: -1,
      });
      continue;
    }
    if (!declared.length)
      sigs.push({ name: 'no_declared_affordance',
                  cite: `substrate/m59-falljumps.json has no entry for room ${spot.room}`,
                  says: 'every planner here answers "no route" by construction. Room 27 had '
                      + 'exactly this property while the stone was already melded.',
                  suggests: 'undeclared_jump' });
    if (inBox)
      sigs.push({ name: 'already_in_the_box', cite: `the walking flood stops ${off} off the stone`,
                  says: 'inside `abs(drow) < 3 AND abs(dcol) < 3`. Stand and activate before '
                      + 'theorising about mechanics.', suggests: 'measured_reachable' });
    if (off != null && off > 2 && off <= 4)
      sigs.push({ name: 'near_miss', cite: `the walking flood stops ${off} off the stone`,
                  says: 'one to two squares outside the box — a tread, a lip or a body, not a '
                      + 'missing mechanic.', suggests: 'predicate' });
    if (v.melded)
      sigs.push({ name: 'melded_anyway', cite: 'the operator has stood on this stone',
                  says: 'THE CONTROL CASE. The model said no and the world said yes.',
                  suggests: 'undeclared_jump' });
    if (!dossiers.includes(key))
      sigs.push({ name: 'no_dossier',
                  cite: `.claude/skills/node-runner/nodes/${key}.md does not exist`,
                  says: 'nothing measured has been written down, so the next run re-measures it.',
                  suggests: 'instrument_missing' });

    out.push({
      id: `node/${key}`,
      lens: 'node',
      subject: `${key} — ${spot.node}, room ${spot.room} (${spot.where}), stone at r${spot.row}c${spot.col}`,
      room: spot.room,
      declared_jumps: declared.length,
      off,
      note: v.note || null,
      signatures: sigs,
      weight: (declared.length ? 0 : 100) + (v.melded ? 50 : 0) + (inBox ? 40 : 0)
            + (off != null ? Math.max(0, 20 - off) : 0),
      default_verdict: 'missing_affordance',
      asks: 'name what the model is missing, from the vocabulary, and the measurement that would '
          + 'tell it apart from the next candidate. "Unreachable" is not available: a player is '
          + 'standing on this stone.',
    });
  }
  out.sort((a, b) => b.weight - a.weight);
  return out;
}

// ── THE GATE CHECK — the half that makes this a voice rather than a suggestion ─────────────
//
// A verdict that names nothing is the failure this whole tool exists to stop, so it is REJECTED
// here rather than reported with a caveat. The rejection prints which gate it failed, because
// "try again" is the same non-answer from the other side.
export function gateCheck(verdict, candidate = null) {
  const failures = [];
  const lens = verdict?.lens || candidate?.lens || 'travel';
  const vocab = lens === 'node' ? MISSING_AFFORDANCES : DEFECT_CLASSES;

  if (!verdict?.cite || String(verdict.cite).trim().length < 8)
    failures.push({ gate: 'G1', why: GATES.G1.asks });
  if (!verdict?.mechanism || String(verdict.mechanism).trim().length < 20)
    failures.push({ gate: 'G2', why: GATES.G2.asks });
  if (!verdict?.class || !Object.prototype.hasOwnProperty.call(vocab, verdict.class))
    failures.push({ gate: 'G3', why: `${GATES.G3.asks} Available: ${Object.keys(vocab).join(', ')}` });
  if (!verdict?.deliverable || String(verdict.deliverable).trim().length < 20)
    failures.push({ gate: 'G4', why: GATES.G4.asks });
  if (!verdict?.steelman || String(verdict.steelman).trim().length < 30)
    failures.push({ gate: 'G5', why: GATES.G5.asks });

  // The banned readings. `steelman` IS EXEMPT BY CONSTRUCTION — the excuse has to be sayable in
  // order to be defeated, and a critic that cannot quote it cannot argue with it.
  const judged = [verdict?.mechanism, verdict?.deliverable, verdict?.verdict, verdict?.note]
    .filter(Boolean).join(' \n ');
  for (const rule of INADMISSIBLE) {
    if (rule.lens !== 'both' && rule.lens !== lens) continue;
    // Every occurrence is checked, not just the first: a verdict that quotes the tool's refusal
    // in one clause and then endorses it in the next is the case worth catching.
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags
                                                                     : rule.re.flags + 'g');
    for (const m of judged.matchAll(re)) {
      if (ATTRIBUTED.test(judged.slice(Math.max(0, m.index - 40), m.index))) continue;
      failures.push({ gate: 'INADMISSIBLE', why: `"${m[0].trim()}" — ${rule.why}` });
      break;
    }
  }

  // A PVP exemption has to name the person. It is the one place a "not a defect" is available,
  // so it is the one place worth policing hardest.
  if (lens === 'travel' && verdict?.class === 'pvp') {
    const named = String(verdict.person || '').trim();
    if (!named || /^<.*>$/.test(named))
      failures.push({ gate: 'PVP', why: 'a PVP exemption needs `person`: a resolved name, never '
                                      + 'an id the resource table could not answer for.' });
    else if (candidate?.strangers && !candidate.strangers.includes(named))
      failures.push({ gate: 'PVP', why: `"${named}" was not among the non-fleet people in the room `
                                      + `(${candidate.strangers.join(', ') || 'nobody was'}).` });
  }
  return { ok: failures.length === 0, failures };
}

// ── THE SIDE THAT TOUCHES DISK ────────────────────────────────────────────────────────────

export function readPostmortems(dir, { since = 0, limit = 0 } = {}) {
  if (!existsSync(dir)) return [];
  let names = readdirSync(dir).filter(f => f.endsWith('.json'));
  // The filename carries the timestamp, so a window is applied before any file is opened. A name
  // that does not parse is kept rather than dropped: a record this tool cannot date is still a
  // record, and silently losing it is the failure mode `m59-postmortems.mjs` was built to avoid.
  if (since) {
    names = names.filter(f => {
      const m = f.match(/(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.json$/);
      if (!m) return true;
      const t = Date.parse(m[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, 'T$1:$2:$3.$4Z'));
      return !Number.isFinite(t) || t >= since;
    });
  }
  names.sort();
  if (limit) names = names.slice(-limit);
  const out = [];
  for (const f of names) {
    try { out.push(JSON.parse(readFileSync(join(dir, f), 'utf8'))); }
    catch { /* a half-written postmortem is a keeper that died mid-write, not a complaint. */ }
  }
  return out;
}

function loadMonsters() {
  try { return monsterNames(JSON.parse(readFileSync(join(REPO, 'tools/monsters.json'), 'utf8'))); }
  catch { return new Set(); }
}

function loadJumps() {
  try {
    return JSON.parse(readFileSync(join(REPO, 'substrate/m59-falljumps.json'), 'utf8')).jumps || [];
  } catch { return []; }
}

function loadDossiers() {
  try {
    return readdirSync(join(REPO, '.claude/skills/node-runner/nodes'))
      .filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''));
  } catch { return []; }
}

// NODES IS READ OUT OF THE SOURCE RATHER THAN IMPORTED. It is a frozen object literal with no
// runtime dependencies, and importing `fleetscripts/mana-node.mjs` drags in the whole of
// `m59-fleetscript.mjs` — a module that takes leases and knows about live brokers — for one
// table. A report has no business loading that to print eight rows.
export function nodesFromSource(src) {
  const m = String(src).match(/export const NODES = Object\.freeze\((\{[\s\S]*?\n\s*\})\);/);
  if (!m) return {};
  try { return Function(`"use strict"; return (${m[1]});`)(); } catch { return {}; }
}

function loadNodes() {
  try { return nodesFromSource(readFileSync(join(HERE, 'fleetscripts/mana-node.mjs'), 'utf8')); }
  catch { return {}; }
}

const STORE = join(REPO, 'substrate', 'critic');

function readStore(name) {
  try { return JSON.parse(readFileSync(join(STORE, name), 'utf8')); } catch { return {}; }
}
function writeStore(name, obj) {
  mkdirSync(STORE, { recursive: true });
  const at = join(STORE, name);
  writeFileSync(at, JSON.stringify(obj, null, 2) + '\n');
  return at;
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────

export function parseSince(s, now = Date.now()) {
  if (!s) return 0;
  const m = String(s).match(/^(\d+(?:\.\d+)?)\s*([hdm])$/i);
  if (!m) return 0;
  const mult = { h: 3600e3, d: 86400e3, m: 60e3 }[m[2].toLowerCase()];
  return now - Number(m[1]) * mult;
}

function printRubric() {
  console.log('\nTHE GATES. A verdict clears all five or it is not a verdict.\n');
  for (const [k, g] of Object.entries(GATES))
    console.log(`  ${k} ${g.name.padEnd(12)} ${g.asks.replace(/\s+/g, ' ')}\n`);
  console.log('LENS A — a non-PVP travel death. DEFAULT VERDICT: DEFECT.\n');
  for (const [k, v] of Object.entries(DEFECT_CLASSES))
    console.log(`  ${k.padEnd(21)} ${v.replace(/\s+/g, ' ')}\n`);
  console.log('LENS B — a stone the mover did not reach. DEFAULT VERDICT: MISSING_AFFORDANCE.\n');
  for (const [k, v] of Object.entries(MISSING_AFFORDANCES))
    console.log(`  ${k.padEnd(21)} ${v.replace(/\s+/g, ' ')}\n`);
  console.log('INADMISSIBLE — true sentences that end the enquiry. Rejected on ingest.\n');
  for (const r of INADMISSIBLE)
    console.log(`  [${r.lens.padEnd(6)}] ${r.why}`);
  console.log('');
}

// A ZERO THAT CANNOT NAME THE DIRECTORY IT READ IS NOT AN ANSWER.
//
// See the resolution block in m59-postmortems.mjs for the incident. The rule that came out of
// it: this lens NEVER prints a count without the store it counted, and an empty window has to
// say where it looked and what the other stores on this machine hold. "Nothing in the window"
// and "nothing in the tree I happened to be run from" are the same sentence to a reader and
// opposite facts, and only the tool can tell them apart.
function reportStore(store, others) {
  const age = store.newest ? `newest ${new Date(store.newest).toISOString().replace('T', ' ').slice(0, 19)}`
                           : 'no dateable records';
  console.log(`\n  reading ${store.dir}`);
  console.log(`    ${store.records} record(s), ${age}  [${store.why}]`);
  for (const o of others) {
    // Only worth a line if it would have answered differently — a store that is empty, or older
    // than the one we read, changes no conclusion and is noise on every run.
    if (!o.records || (store.newest && o.newest && o.newest <= store.newest)) continue;
    console.log(`    ALSO ON THIS MACHINE: ${o.records} record(s) in ${o.dir}`
              + `\n      ${o.newest ? `newer — up to ${new Date(o.newest).toISOString().replace('T', ' ').slice(0, 19)}` : ''}`
              + ` [${o.why}]  --postmortems to read it instead`);
  }
}

function reportTravel(cands, { verbose, store = null, others = [] }) {
  const live = cands.filter(c => !c.pvp);
  console.log('\nLENS A — TRAVEL DEATHS THAT ARE NOT PVP, AS BUG REPORTS');
  if (store) reportStore(store, others);
  console.log(`\n${cands.length} candidate(s); ${cands.length - live.length} exempt as PVP; `
            + `${live.length} default to DEFECT.\n`);
  if (!cands.length) {
    console.log(store ? `  nothing in the window, in ${store.dir}\n`
                      : '  nothing in the window.\n');
    return;
  }
  const shown = verbose ? live : live.slice(0, 12);
  for (const c of shown) {
    console.log(`  ${new Date(c.at).toISOString().replace('T', ' ').slice(0, 19)}  ${c.subject}`);
    console.log(`    killed by ${c.killer.name ?? 'nobody could say'}`
              + `${c.killer.observed ? ' (server broadcast)' : ' (A GUESS — 51% right)'}`
              + `${c.contested ? `   CONTESTED: ${c.strangers.join(', ')} in the room` : ''}`);
    for (const s of c.signatures) console.log(`      ${s.name.padEnd(16)} ${s.cite}`);
    console.log(`    -> ${c.asks}\n`);
  }
  if (live.length > shown.length)
    console.log(`  ... and ${live.length - shown.length} more. --verbose for all, `
              + '--tasks <file> to hand them to the critic.\n');
}

function reportNode(cands) {
  console.log('\nLENS B — STONES THE MOVER DID NOT REACH, AS MISSING AFFORDANCES');
  console.log('Every one of these stands in a room a person can walk to in the retail client.');
  console.log('"Unreachable" is a fact about substrate/m59-falljumps.json, not about the world.');
  console.log(`Epoch: ${MOVER_VERDICT._epoch}\n`);
  if (!cands.length) { console.log('  no node table found — is this checkout missing '
                                 + 'tools/fleetscripts/mana-node.mjs?\n'); return; }
  for (const c of cands) {
    console.log(`  ${c.subject}`);
    console.log(`    declared jumps in this room: ${c.declared_jumps}`
              + `${c.off != null ? `    the walking flood stops ${c.off} off the stone` : ''}`);
    if (c.note) console.log(`    ${c.note}`);
    for (const s of c.signatures) console.log(`      ${s.name.padEnd(22)} ${s.cite}`);
    console.log('');
  }
}

async function main(argv) {
  const has = n => argv.includes('--' + n);
  const flag = (n, d = null) => {
    const i = argv.indexOf('--' + n);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
  };
  // A bare word that is not the value of a preceding flag is the subcommand.
  const words = argv.filter((a, i) => !a.startsWith('--')
                                   && !(i > 0 && argv[i - 1].startsWith('--')));
  const cmd = words[0] || 'all';

  if (has('rubric')) { printRubric(); return 0; }

  if (cmd === 'ingest') {
    const file = words[1];
    if (!file) { console.error('ingest needs a verdicts file.'); return 2; }
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const verdicts = Array.isArray(raw) ? raw : (raw.verdicts || []);
    const store = readStore('verdicts.json');
    let kept = 0, rejected = 0;
    console.log('');
    for (const v of verdicts) {
      const r = gateCheck(v, null);
      if (r.ok) {
        store[v.id] = { ...v, judged_at: Date.now() };
        kept++;
        console.log(`  KEPT      ${v.id}\n            ${v.class}: ${v.mechanism}\n`);
      } else {
        rejected++;
        console.log(`  REJECTED  ${v.id ?? '(no id)'}`);
        for (const f of r.failures)
          console.log(`            ${f.gate}: ${f.why.replace(/\s+/g, ' ')}`);
        console.log('');
      }
    }
    const at = writeStore('verdicts.json', store);
    console.log(`  ${kept} kept, ${rejected} rejected. ${at}\n`);
    return rejected ? 1 : 0;
  }

  const since = has('all-time') ? 0 : parseSince(flag('since', '7d'));
  const bundle = {
    _what: 'A Tier-1 worklist. Nothing here is judged. The critic is the agent — see '
         + '.claude/skills/m59-critic/SKILL.md, and `m59-critic.mjs --rubric`.',
    critic_rubric: { gates: GATES, verdict_shape: VERDICT_SHAPE,
                     inadmissible: INADMISSIBLE.map(r => ({ lens: r.lens, pattern: String(r.re),
                                                            why: r.why })) },
    vocabularies: { travel: DEFECT_CLASSES, node: MISSING_AFFORDANCES },
    candidates: [],
  };

  if (cmd === 'all' || cmd === 'travel') {
    // NOT `join(REPO, 'substrate/postmortems')`. That read this tree, which is not the tree the
    // fleet is running from, and on 2026-09-10 it answered "nothing in the window" for a window
    // holding forty-four deaths. resolvePostmortemStores asks the broker which tree it is
    // writing into; the argument is in m59-postmortems.mjs, above `substrateOf`.
    const stores = await resolvePostmortemStores({
      explicit: flag('postmortems', null),
      probe: !has('no-probe'),
    });
    const store = stores[0];
    const all = readPostmortems(store.dir, { since });
    // The roster comes off the WHOLE store and the window's own records are unioned in, never
    // the window alone — see rosterFromStore. Getting this wrong contests every death in a
    // short window with a fleet-mate's name.
    const fleet = new Set([...rosterFromStore(store.dir), ...roster(all)]);
    const cands = travelCandidates(all, { monsters: loadMonsters(), fleet, since,
                                          character: flag('char', null) });
    bundle.candidates.push(...cands);
    // The bundle carries the address too — a worklist handed to an agent has to say which
    // corpus produced it, or a verdict citing a postmortem cannot be checked against the file.
    bundle.postmortem_store = { dir: store.dir, why: store.why, records: store.records,
                                newest: store.newest,
                                others: stores.slice(1).map(o => ({ dir: o.dir, why: o.why,
                                                                    records: o.records,
                                                                    newest: o.newest })) };
    if (!has('tasks')) reportTravel(cands, { verbose: has('verbose'),
                                             store, others: stores.slice(1) });
  }

  if (cmd === 'all' || cmd === 'node') {
    const cands = nodeCandidates({ nodes: loadNodes(), jumps: loadJumps(),
                                   dossiers: loadDossiers() });
    bundle.candidates.push(...cands);
    if (!has('tasks')) reportNode(cands);
  }

  if (has('tasks')) {
    const out = flag('tasks');
    if (!out) { console.error('--tasks needs a path.'); return 2; }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(bundle, null, 2) + '\n');
    console.log(`\n  ${bundle.candidates.length} candidate(s) -> ${out}`);
    console.log('  The critic is the agent. .claude/skills/m59-critic/SKILL.md has the voice,');
    console.log('  `--rubric` has the gates. Verdicts come back through `ingest`.\n');
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).then(process.exit);
}
