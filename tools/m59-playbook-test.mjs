#!/usr/bin/env node
// THE PLAYBOOK -- what the keeper does at the moments it has no opinion about. Offline,
// no server, no broker, safe any time:
//
//   node tools/m59-playbook-test.mjs
//
// Everything here is fixtures against a pure function, which is the point: the moments
// this table covers are a player attacking you, dying, and gaining a level. Testing them
// for real means arranging all three on a live shared server, so in practice they would
// be tested by hoping.
//
// What is pinned, in order of how expensive being wrong would be:
//
//   1. AN ABSENT PLAYBOOK CHANGES NOTHING. Silence resolves to null and the keeper does
//      what it did before this file existed. Getting this backwards -- silence meaning
//      "do nothing" rather than "carry on" -- would replace the survival ladder with
//      paralysis at exactly the moments it is most needed.
//   2. AN UNKNOWN CONDITION NEVER HOLDS, and a typo therefore disables a rule rather
//      than promoting it to unconditional.
//   3. THE VERBS ARE A CLOSED SET. A bot cannot hand the keeper an arbitrary act.
//   4. THE TWO OUTWARD VERBS need a literal message, because `prod` is a shared server
//      and the text is visible to strangers and attributable to the account.

import { readFileSync } from 'node:fs';
import { decide, validate, VERBS, TRIGGERS, unknownVerbs } from './m59-playbook.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};
const clean = pb => validate(pb).length === 0;
const problems = pb => validate(pb).map(p => p.where).join(',');

console.log('\nsilence means carry on');
{
  const facts = { who: 'somebody', health_pct: 0.3, room: 71, attackers: 1, in_safe_spot: false };
  ok('no playbook at all', decide('attacked_by_player', null, facts) === null);
  ok('a playbook with no `on`', decide('attacked_by_player', {}, facts) === null);
  ok('a playbook that covers a different moment',
     decide('attacked_by_player', { on: { died: [{ do: 'nothing' }] } }, facts) === null);
  ok('an empty rule list', decide('attacked_by_player', { on: { attacked_by_player: [] } }, facts) === null);
  // The distinction that matters: DECLARED nothing is not the same as nothing declared.
  // One of them is a decision somebody made and belongs in the journal.
  const declared = decide('attacked_by_player', { on: { attacked_by_player: [{ do: 'nothing' }] } }, facts);
  ok('but an explicit `nothing` is an answer, not a silence', declared?.verb === 'nothing');
  ok('an unknown trigger is null rather than a throw', decide('invented', { on: {} }, {}) === null);
}

console.log('\nattacked by a player');
{
  // The worked example from the design: run if it is one attacker and we are healthy,
  // log off for five minutes if we are losing. A player who has to wait five minutes
  // usually goes elsewhere; a player you merely walked away from does not.
  const pb = { on: { attacked_by_player: [
    { when: { health_pct_below: 0.5 }, do: 'logoff', stay_off_s: 300,
      why: 'they came for a fight now, and will not wait five minutes for one' },
    { when: { attackers_at_least: 2 }, do: 'logoff', stay_off_s: 300 },
    { do: 'retreat' },
  ] } };
  ok('the playbook is valid', clean(pb), problems(pb));

  const hurt = decide('attacked_by_player', pb,
    { who: 'x', health_pct: 0.3, attackers: 1, room: 71, in_safe_spot: false });
  ok('badly hurt logs off', hurt.verb === 'logoff' && hurt.args.stay_off_s === 300);
  ok('and carries the reason into the journal', /will not wait five minutes/.test(hurt.why));

  const ganged = decide('attacked_by_player', pb,
    { who: 'x', health_pct: 0.9, attackers: 3, room: 71, in_safe_spot: false });
  ok('healthy but outnumbered also logs off', ganged.verb === 'logoff' && ganged.rule === 1);

  const fine = decide('attacked_by_player', pb,
    { who: 'x', health_pct: 0.9, attackers: 1, room: 71, in_safe_spot: false });
  ok('healthy and alone retreats', fine.verb === 'retreat' && fine.rule === 2);

  // FIRST MATCH WINS, so a doctrine reads top to bottom.
  ok('and the first matching rule is the one that runs', hurt.rule === 0);
}

console.log('\nattacked by a player -- fight_back and fleet_alert');
{
  // THE PvP RESPONSE. When the keeper is healthy and alone against one attacker the
  // doctrine for the level-30+ fleet members is: signal the fleet, then fight back.
  // fleet_alert is declared first so the conflict row is in the broker's table BEFORE
  // the keeper engages -- a fight that starts a second earlier than the call still
  // gets help on the way.
  const pb = { on: { attacked_by_player: [
    { when: { health_pct_below: 0.4 }, do: 'logoff', stay_off_s: 300,
      why: 'genuinely losing and cannot escape' },
    { when: { health_pct_below: 0.7 }, do: 'leave_room',
      why: 'hurt enough that fighting back is not a win' },
    { when: { attackers_at_least: 2 }, do: 'leave_room',
      why: 'outnumbered -- leave, do not log off back into the same fight' },
    { when: { health_pct_at_least: 0.7 }, do: 'fleet_alert',
      why: 'call the fleet so nearby members converge' },
    { when: { health_pct_at_least: 0.7 }, do: 'fight_back',
      why: 'healthy and alone -- fight back' },
  ] } };
  ok('the new policy is valid', clean(pb), problems(pb));

  // Both verbs must be in the closed set -- a closed set is the safety property, and
  // adding a verb here is the only place they get into the harness.
  ok('fight_back is in VERBS', !!VERBS.fight_back);
  ok('fleet_alert is in VERBS', !!VERBS.fleet_alert);
  ok('neither takes arguments', VERBS.fight_back.args.length === 0 && VERBS.fleet_alert.args.length === 0);

  const hurt = decide('attacked_by_player', pb,
    { who: 'griefer', health_pct: 0.3, attackers: 1, room: 71, in_safe_spot: false });
  ok('badly hurt still logs off (the floor survives the new policy)', hurt.verb === 'logoff');

  const ganged = decide('attacked_by_player', pb,
    { who: 'griefer', health_pct: 0.9, attackers: 3, room: 71, in_safe_spot: false });
  ok('outnumbered still leaves the room, not logs off', ganged.verb === 'leave_room');

  // FIRST MATCH WINS, so the fleet_alert rule must precede the fight_back rule or the
  // signal would never be declared -- the test below locks that ordering in.
  const fine = decide('attacked_by_player', pb,
    { who: 'griefer', health_pct: 0.9, attackers: 1, room: 71, in_safe_spot: false });
  ok('healthy and alone against one attacker signals the fleet first', fine.verb === 'fleet_alert');
  ok('and the rule index points at the fleet_alert rule, not fight_back', fine.rule === 3);

  // FIRST MATCH WINS. The fleet_alert rule precedes the fight_back rule, so under
  // identical `when` clauses the signal is what fires. A doctrine that wants
  // fight_back alone drops the signal rule; the closed-set guard ensures neither
  // ever invents a third verb.
  const two = { on: { attacked_by_player: [
    { when: { health_pct_at_least: 0.7 }, do: 'fleet_alert' },
    { when: { health_pct_at_least: 0.7 }, do: 'fight_back' },
  ] } };
  ok('the first matching rule is the one that runs (fleet_alert before fight_back)',
     decide('attacked_by_player', two,
            { who: 'griefer', health_pct: 0.9, attackers: 1, room: 71, in_safe_spot: false }).rule === 0);
  ok('and a doctrine that omits the signal drops straight to fight_back',
     decide('attacked_by_player',
            { on: { attacked_by_player: [{ when: { health_pct_at_least: 0.7 }, do: 'fight_back' }] } },
            { who: 'griefer', health_pct: 0.9, attackers: 1, room: 71, in_safe_spot: false }).verb === 'fight_back');

  // Unknown verbs stay unknown -- the closed-set guard must not have a back door.
  ok('a made-up verb is still skipped, not guessed at',
     decide('attacked_by_player', { on: { attacked_by_player: [{ do: 'fight_everyone' }] } },
            { who: 'x', health_pct: 1, attackers: 1, room: 71, in_safe_spot: false }) === null);
}

console.log('\nconditions that nobody can evaluate');
{
  // THE DANGEROUS DIRECTION. An unrecognised condition must fail CLOSED: a typo disables
  // its rule rather than promoting it to unconditional. The opposite convention turns
  // `health_pct_bellow: 0.5` into "log off every single time a player is nearby".
  const typo = { on: { attacked_by_player: [
    { when: { health_pct_bellow: 0.5 }, do: 'logoff', stay_off_s: 60 },
    { do: 'retreat' },
  ] } };
  const got = decide('attacked_by_player', typo,
    { who: 'x', health_pct: 0.1, attackers: 1, room: 71, in_safe_spot: false });
  ok('a misspelled condition does not fire its rule', got.verb === 'retreat');
  ok('and validation says so, naming the fields that exist',
     validate(typo).some(p => /when.health_pct_bellow/.test(p.where) && /never fire/.test(p.why)),
     JSON.stringify(validate(typo)));

  // A fact the trigger does supply, but which this event did not carry.
  const missing = { on: { died: [{ when: { level_at_least: 30 }, do: 'nothing' }] } };
  ok('a condition on a fact that came back null does not hold',
     decide('died', missing, { killed_by: 'a rat', level: null }) === null);
}

console.log('\nthe verbs are a closed set');
{
  const invented = { on: { attacked_by_player: [
    { do: 'cast_fireball_at_them' },
    { do: 'retreat' },
  ] } };
  const got = decide('attacked_by_player', invented,
    { who: 'x', health_pct: 1, attackers: 1, room: 71, in_safe_spot: false });
  ok('a verb this harness does not know is skipped, not guessed at', got.verb === 'retreat');
  ok('and is reportable rather than silent',
     JSON.stringify(unknownVerbs(invented)) === '["cast_fireball_at_them"]');
  ok('and validation refuses it', validate(invented).some(p => /\.do$/.test(p.where)));

  // There is deliberately no way to say "stand still". A playbook ADDS a response; it
  // cannot remove the survival floor, which is the whole promise of the carve-out.
  ok('there is no verb for standing still',
     !Object.keys(VERBS).some(v => /stand_still|ignore|do_nothing|suppress/.test(v)));
  ok('and none of them is an arbitrary tool call',
     Object.values(VERBS).every(v => Array.isArray(v.args)));
}

console.log('\nspeaking to a shared server');
{
  // `prod` has real players on it. Anything the fleet says is visible to strangers and
  // attributable to whoever owns the account, so the text is a literal somebody chose in
  // advance and never something assembled from what the world said back to us.
  ok('say with no message is refused',
     validate({ on: { died: [{ do: 'say' }] } }).some(p => /message/.test(p.where)));
  ok('tell with no recipient is refused',
     validate({ on: { died: [{ do: 'tell', message: 'hello' }] } }).some(p => /\.to$/.test(p.where)));
  ok('a literal message is fine',
     clean({ on: { died: [{ do: 'tell', to: 'a-role', message: 'I died at the crossroads.' }] } }));
  ok('something that looks like a template is refused',
     validate({ on: { died: [{ do: 'say', message: 'I died in ${room}' }] } })
       .some(p => /message/.test(p.where)));
  ok('and so is one longer than the game will send',
     validate({ on: { died: [{ do: 'say', message: 'x'.repeat(200) }] } })
       .some(p => /message/.test(p.where)));
}

console.log('\nthe one verb that blocks');
{
  // `ask_for_orders` is the escape hatch and its whole cost is latency. It has to be
  // possible -- that is what makes hands-on LLM supervision work at all -- and it has to
  // be impossible to reach for by accident at the moment it is most expensive.
  ok('a short wait on a slow trigger is fine',
     clean({ on: { improved: [{ do: 'ask_for_orders', wait_s: 20 }] } }));
  ok('a long wait is refused anywhere',
     validate({ on: { improved: [{ do: 'ask_for_orders', wait_s: 120 }] } })
       .some(p => /wait_s/.test(p.where)));
  ok('and on attacked_by_player even a moderate one is refused, because the answer ' +
     'would arrive after the fight',
     validate({ on: { attacked_by_player: [{ do: 'ask_for_orders', wait_s: 20 }] } })
       .some(p => /wait_s/.test(p.where) && /after the fight/.test(p.why)));
  ok('five seconds there is allowed',
     clean({ on: { attacked_by_player: [{ do: 'ask_for_orders', wait_s: 5 }] } }));
}

console.log('\nlogging off is not free');
{
  ok('a stay-off window is required', validate({ on: { attacked_by_player: [{ do: 'logoff' }] } })
       .some(p => /stay_off_s/.test(p.where)));
  ok('and an absurd one is refused -- a character that is off is not being defended, ' +
     'not earning, and not on the board',
     validate({ on: { attacked_by_player: [{ do: 'logoff', stay_off_s: 7200 }] } })
       .some(p => /stay_off_s/.test(p.where)));
  ok('five minutes is fine',
     clean({ on: { attacked_by_player: [{ do: 'logoff', stay_off_s: 300 }] } }));
}

console.log('\nthe three moments');
{
  ok('are attacked_by_player, died and improved',
     JSON.stringify(Object.keys(TRIGGERS)) ===
     JSON.stringify(['attacked_by_player', 'died', 'improved']));
  ok('and each states what it knows, so a `when` can be checked against it',
     Object.values(TRIGGERS).every(t => Array.isArray(t.facts) && t.facts.length && t.why));

  // A block for a trigger that does not exist can never run, and nothing else would say so.
  ok('a block for a trigger that does not exist is reported',
     validate({ on: { attacked_by_monster: [{ do: 'retreat' }] } })
       .some(p => /can never run/.test(p.why)));

  // The worked case for `improved`: max health IS the level, and a kill only pays when
  // the creature's level is strictly above it -- so a gain can make the current prey
  // worthless without anything else changing.
  const retask = { on: { improved: [
    { when: { what_is: 'max_health', to_at_least: 50 }, do: 'ask_for_orders', wait_s: 20,
      why: 'a level-50 creature cannot advance a level-50 character; the prey needs re-picking' },
  ] } };
  ok('gaining into a new band asks for orders',
     decide('improved', retask, { what: 'max_health', from: 49, to: 50, hunting: 'fungus beast', room: 544 })
       ?.verb === 'ask_for_orders');
  ok('and a smaller gain does not',
     decide('improved', retask, { what: 'max_health', from: 40, to: 41, hunting: 'x', room: 544 }) === null);
}

console.log('\ncalling for help — the three verbs that speak to strangers');
{
  const lit = 'HELP - a murderer is killing me in the Sewers of Barloque';

  ok('yell needs a literal like say does',
     validate({ on: { attacked_by_player: [{ do: 'yell' }] } }).some(p => /message/.test(p.where)));
  ok('tell_guild does too',
     validate({ on: { attacked_by_player: [{ do: 'tell_guild' }] } }).some(p => /message/.test(p.where)));
  ok('a templated yell is refused, exactly as a templated say is',
     validate({ on: { attacked_by_player: [{ do: 'yell', message: 'help me in ${room}' }] } })
       .some(p => /template/.test(p.why)));

  // THE SECOND SENTENCE GOES TO REAL PEOPLE TOO, and it is the one that would be easy to
  // leave unvalidated because it is optional.
  ok('a templated guild_message is refused',
     validate({ on: { attacked_by_player: [
       { do: 'call_for_help', message: lit, guild_message: 'help at ${room}', stay_off_s: 300 }] } })
       .some(p => /guild_message/.test(p.where) && /template/.test(p.why)));
  ok('an empty guild_message is refused rather than silently skipped',
     validate({ on: { attacked_by_player: [
       { do: 'call_for_help', message: lit, guild_message: '  ', stay_off_s: 300 }] } })
       .some(p => /guild_message/.test(p.where)));
  ok('but omitting it entirely is fine — not every character has a guild',
     validate({ on: { attacked_by_player: [
       { do: 'call_for_help', message: lit, stay_off_s: 300 }] } }).length === 0);

  // call_for_help ENDS in a logoff, so it inherits the stay-off ceiling. A character that
  // is off is not being defended, not earning and not on the board.
  ok('call_for_help is held to the same stay_off_s rules as logoff',
     validate({ on: { attacked_by_player: [
       { do: 'call_for_help', message: lit, stay_off_s: 99999 }] } }).some(p => /stay_off_s/.test(p.where)));
  ok('and a missing stay_off_s is refused, not defaulted to zero',
     validate({ on: { attacked_by_player: [{ do: 'call_for_help', message: lit }] } })
       .some(p => /stay_off_s/.test(p.where)));

  // THE LOCATION PROBLEM, SOLVED BY THE CONDITION SYSTEM RATHER THAN BY A TEMPLATE.
  // `room` is a fact on this trigger, so one rule per room carries a sentence its author
  // actually wrote. This is the pattern the docs should show.
  const perRoom = { on: { attacked_by_player: [
    { when: { room: 108 }, do: 'call_for_help', stay_off_s: 600,
      message: 'HELP - a murderer is killing me in the Sewers of Barloque',
      guild_message: 'Murderer in the Sewers of Barloque - I am logging off' },
    { when: { room: 52 }, do: 'call_for_help', stay_off_s: 600,
      message: 'HELP - a murderer is killing me in Familiars, Tos',
      guild_message: 'Murderer in Familiars - I am logging off' },
    { do: 'logoff', stay_off_s: 600, why: 'somewhere with no sentence written for it' },
  ] } };
  ok('the per-room playbook validates', validate(perRoom).length === 0);
  const inSewers = decide('attacked_by_player', perRoom,
    { who: 'X', health_pct: 20, room: 108, attackers: 1, in_safe_spot: false });
  ok('and the sewers rule names the sewers', /Sewers of Barloque/.test(inSewers.args.message));
  const inFamiliars = decide('attacked_by_player', perRoom,
    { who: 'X', health_pct: 20, room: 52, attackers: 1, in_safe_spot: false });
  ok('the Familiars rule names Familiars', /Familiars/.test(inFamiliars.args.message));
  // A ROOM NOBODY WROTE A SENTENCE FOR STILL GETS THE SURVIVAL BEHAVIOUR, silently and
  // without inventing a sentence — which is the whole reason the fallback rule is a bare
  // logoff rather than a templated shout.
  const elsewhere = decide('attacked_by_player', perRoom,
    { who: 'X', health_pct: 20, room: 999, attackers: 1, in_safe_spot: false });
  ok('an unwritten room falls through to the plain logoff', elsewhere.verb === 'logoff');
  ok('and says nothing at all there', elsewhere.args.message === undefined);
}


console.log('');
console.log('a broadcast is heard by the whole server, so it rotates its line and carries a clock');
{
  // THE VERB EXISTS FOR THE DESIGNATED DIE-ER, and every part of it is a thing that was
  // nearly got wrong. Added 2026-09-10 for Marco Polo on the mana-node tour.
  const pb = { on: { died: [
    { do: 'broadcast', when: { was_killed_by_player: false },
      message: ['line one', 'line two', 'line three'] },
    { do: 'nothing' },
  ] } };
  const monster = { killed_by: ['troll'], was_killed_by_player: false, room: 599, level: 20 };
  const player  = { killed_by: ['someone'], was_killed_by_player: true, room: 39, level: 20 };

  const a = decide('died', pb, monster);
  ok('a monster death broadcasts', a?.verb === 'broadcast');
  ok('and the line comes from the list', ['line one', 'line two', 'line three'].includes(a.args.message));

  // PURITY IS THE PROPERTY THIS MODULE DEFENDS: "no clock, no randomness -- which is what
  // lets the whole table be tested against fixtures, and what makes an action reproducible
  // from the journal line that recorded the facts it was given." A Math.random pick would
  // have cost both, so the line is hashed FROM THE FACTS.
  ok('the same death replays to the same line',
     decide('died', pb, monster).args.message === a.args.message);
  const other = decide('died', pb, { ...monster, room: 568, killed_by: ['baby spider'] });
  ok('a different death is free to choose differently', typeof other.args.message === 'string');

  // A CLOCK THE PURE LAYER CANNOT ENFORCE STILL HAS TO BE HANDED DOWN, or the executor has
  // to know which verbs are rate-limited, which is exactly the sort of split knowledge that
  // goes stale.
  ok('the verb hands its own cooldown down', a.args.cooldown_s === 600);
  ok('and a playbook may lower it',
     decide('died', { on: { died: [{ do: 'broadcast', message: ['x'], cooldown_s: 30 }] } },
            monster).args.cooldown_s === 30);

  ok('a player kill falls through to the next rule', decide('died', pb, player)?.verb === 'nothing');

  // AN EMPTY LIST IS NOT AN EMPTY MESSAGE. The executor refuses a blank one, but the
  // decision should not carry a `message` key at all rather than carry undefined.
  const blank = decide('died', { on: { died: [{ do: 'broadcast', message: ['', '  '] }] } }, monster);
  ok('an all-blank list leaves no message behind', !('message' in blank.args));

  // AND THE EXECUTOR HAS TO KNOW THE VERB. A verb in VERBS that no executor dispatches is
  // decided, journalled and silently dropped -- the exact shape of failure this repository
  // keeps paying for, and it was the state of `broadcast` for the first ten minutes of its
  // life. Checked as SOURCE because the executor needs a live client to run.
  const AP = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('the executor dispatches broadcast', /case 'broadcast':/.test(AP));
  ok('and enforces the cooldown rather than trusting it', /broadcast cooldown/.test(AP));
  ok('and reports a suppressed one instead of reporting success',
     /suppressed: true/.test(AP));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
