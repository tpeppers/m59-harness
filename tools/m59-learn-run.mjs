#!/usr/bin/env node
// RUN THE learn-skill FLEETSCRIPT FOR ONE CHARACTER, from a command line.
//
// This exists so `buy_next_planned_skills` has something to spawn that is not
// `m59-outfit.mjs`. That script was the original `--learn` path and it is the one whose
// three failures are catalogued at the top of fleetscripts/learn-skill.mjs; the rewrite
// fixed them and then nothing was pointed at it.
//
// The failure that mattered on 2026-09-08 is the FOURTH one, and it is the reason this
// file was written rather than the old script being patched:
//
//     Scooter: short 482sh and no bank reachable, standing with Rook, at 154,
//              punch: 500sh, only 18sh
//
// He had 10,306 shillings in Jasper. `m59-outfit.mjs` looks for a bank it considers
// "reachable" and gives up where there is none in the room; the FleetScript simply WALKS
// to one — `walk(bankRoom) -> bank('withdraw', price - carrying)` — which is what a person
// would do. The old script had walked him to the teacher and left him standing there
// broke, and because the broker spawned it with `stdio: 'ignore'` nobody saw the sentence
// above until it was run by hand.
//
//   node tools/m59-learn-run.mjs --agent t21 --skill punch --price 500 \
//        --teacher Rook --teacher-room 154 --home 544
import { fleetScript } from './m59-fleetscript.mjs';
import { script } from './fleetscripts/learn-skill.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : fallback;
};

const agent = flag('agent');
const skill = flag('skill');
const price = Number(flag('price'));
if (!agent || !skill || !Number.isFinite(price)) {
  console.error('usage: --agent <a> --skill <name> --price <n> [--teacher <who>] ' +
                '[--teacher-room <n>] [--bank-room <n>] [--home <n>]');
  process.exit(2);
}

// The planner names the teacher and the room; both are passed in rather than looked up
// here, because two merchants can share a name and the ROOM is the address.
const params = {
  agents: [agent], skill,
  teacher: flag('teacher', 'Rook'),
  teacherRoom: Number(flag('teacher-room', 154)),
  price,
  bankRoom: Number(flag('bank-room', 54)),
  carrying: Number(flag('carrying', 0)),
  home: Number(flag('home', 544)),
};

const out = await fleetScript({
  name: script.name,
  agents: [agent],
  provenance: script.provenance,
  steps: () => script.steps(params),
});

// THE EXIT CODE IS THE ONLY THING THE BROKER READS WITHOUT OPENING THE LOG, and there are
// THREE outcomes, not two. Collapsing them to pass/fail is what made the money guard fire
// on errands that had not spent anything and could not have:
//
//   0  the skill was verified in the list afterwards
//   1  it was attempted and did not verify -- the money MAY have moved, so do not retry
//   2  it never reached the counter, so nothing was spent and retrying is free and correct
//
// THE TEST FOR 2 IS 'DID THE SHOP STEP RUN', NOT 'WAS IT REFUSED'. Only the shop step can
// move money, so every failure before it — the run lock, a walk that never set out, a
// character that could not reach its health floor — leaves the purse untouched and must
// stay retryable.
//
// Both halves of that were learned the hard way on 2026-09-08, hours apart. First the run
// lock: fleetScript takes ONE lock per fleet, so a rule dispatching three learning errands
// gets one runner and two refusals, and the guard blocked both of those purchases. Then
// Robin, whose errand never left the valley —
//
//     step 0 (walk) failed: could not reach the health floor: health stopped
//     improving at 48/58 (floor 1)
//
// — and whose hammer wielding was burnt anyway, with 26,664 shillings in the bank and no
// shilling of it at risk. A fighting fleet trips the health floor constantly, so this was
// not a rare case; it was the common one.
const refused = out?.refused === true;
const ok = out?.ok === true || out?.results?.[0]?.ok === true;
// The per-agent step record, keyed `<index>:<step>` — see fleetScript's `state`.
const state = out?.results?.[agent]?.state ?? out?.results?.[0]?.state ?? {};
const reachedCounter = Object.keys(state).some(k => k.endsWith(':shop'));
const spentNothing = refused || !reachedCounter;
console.log(`learn-skill ${agent} ${skill}: ` +
  (ok ? 'BOUGHT'
     : refused ? 'never started (fleet already being driven)'
     : !reachedCounter ? 'never reached the counter — nothing spent, safe to retry'
     : 'did not complete'));
console.log(JSON.stringify(out, null, 1).slice(0, 4000));
process.exit(ok ? 0 : spentNothing ? 2 : 1);
