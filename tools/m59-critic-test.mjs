#!/usr/bin/env node
// m59-critic-test.mjs -- tests for the two-lens critic.
//
//   node tools/m59-critic-test.mjs
//
// Offline. No corpus, no server, no falljumps file. Synthetic postmortems and a synthetic node
// table, because the point of the tool is a rule about how evidence is READ and a test against
// the live corpus would only prove that today's corpus still looks like today's corpus.
//
// The tests that matter most are the NEGATIVE ones. A critic whose gates can be talked past is
// a style guide, so the bulk of this file is verdicts that ought to be REJECTED: the excuse in
// each of its costumes, the empty class, the missing citation, the PVP exemption that names
// nobody, and the one exemption that must survive — an excuse QUOTED inside a steelman, which
// is the critic doing its job rather than failing it.

import {
  DEFECT_CLASSES, MISSING_AFFORDANCES, INADMISSIBLE, GATES,
  monsterNames, resolveMonster, roster, rosterFromStore, killerOf, strangersPresent,
  signatures, travelCandidates, declaredJumpsIn, nodeCandidates, gateCheck,
  nodesFromSource, parseSince,
} from './m59-critic.mjs';
import { substrateOf, storeStats } from './m59-postmortems.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

// ── fixtures ──────────────────────────────────────────────────────────────────────────────

const MONSTERS = monsterNames([
  { _res: { a: ['spider', 1], b: ['dead spider', 2] } },
  { _res: { a: ['skeleton', 3] } },
  { _res: { a: ['ant', 4] } },
  { _res: { a: ['giant rat', 5] } },
]);

// A death with every mechanical signature the tool knows how to see.
const WEDGED_DEATH = {
  character: 'Oooo', reason: 'died', at: 1788939413371,
  was: { doing: 'travelling', ms_since_moved: 7064 },
  where: { room: 'Forest of Farol', num: 536, col: 32, row: 25 },
  vitals: { level: 58, last_vigor: 1 },
  threats: { most_at_once: 12, players_present: [] },
  killed_by_broadcast: { killer: 'spider', text: '### Oooo was just killed by a spider.' },
  summary: {
    killed_by: ['living tree'], fled_in_time: 0.06,
    movement: { squares_per_second: 0.16, net_squares: 13, seconds: 255.4, samples: 48 },
    watchdog: { longest_block_ms: 5706576, wedges: 16,
                wedged_at_death: { for_ms: 50573, inert: 'travelling to 104' } },
  },
};

// The same death one generation earlier: no watchdog, no movement summary. The record cannot
// answer the question and the tool has to say so rather than invent a reading.
const THIN_DEATH = {
  character: 'Aaaa', reason: 'died', at: 1787000000000,
  was: { doing: 'travelling' },
  where: { room: 'The Sewers of Barloque', num: 377, col: 5, row: 5 },
  vitals: { level: 21 },
  threats: { most_at_once: 3, players_present: [] },
  summary: { killed_by: ['giant rat'], fled_in_time: 0.9 },
};

// A person in the room, and the person landed the blow.
const PVP_DEATH = {
  character: 'Bbbb', reason: 'died', at: 1788000000000,
  was: { doing: 'travelling' },
  where: { room: 'Ukgoth', num: 599, col: 1, row: 1 },
  vitals: { level: 40 },
  threats: { most_at_once: 0, players_present: ['Strangerman', 'Cccc'] },
  killed_by_broadcast: { killer: 'Strangerman' },
  summary: { killed_by: ['Strangerman'], fled_in_time: 0.5 },
};

// A person in the room and a MONSTER landed the blow, confirmed by broadcast. Contested — and
// this repository's own rule is that a monster's last blow during a fight with somebody is
// still a PVP death, so it must not be auto-exempted either way.
const CONTESTED_DEATH = {
  character: 'Cccc', reason: 'died', at: 1788100000000,
  was: { doing: 'travelling', ms_since_moved: 9000 },
  where: { room: 'Ukgoth', num: 599, col: 2, row: 2 },
  vitals: { level: 40 },
  threats: { most_at_once: 7, players_present: ['Strangerman'] },
  killed_by_broadcast: { killer: 'a skeleton' },
  summary: { killed_by: ['skeleton'], fled_in_time: 0.1 },
};

const NODES = {
  cave: { room: 27, node: 'NODE_ORCCAVES', row: 23, col: 53, where: 'Icky Cave' },
  sentinel: { room: 589, node: 'NODE_H9', row: 45, col: 32, where: 'Sentinel' },
  ice: { room: 750, node: 'NODE_ICECAVE1', row: 25, col: 23, where: 'Ice Caves' },
};
const JUMPS = [{ room: 589, kind: 'fall' }, { room: 599, kind: 'fall' }];
const VERDICTS = { 27: { off: 4, melded: true }, 589: { off: 0 }, 750: { off: 1 } };

// ── name resolution: the half that decides whether a person is a bug ──────────────────────

console.log('\nresolveMonster: whole words, never substrings');
{
  check('a bare class name resolves', resolveMonster('spider', MONSTERS) === 'spider');
  check('an article is stripped', resolveMonster('a spider', MONSTERS) === 'spider');
  check('a trailing full stop is stripped', resolveMonster('the skeleton.', MONSTERS) === 'skeleton');
  check('a leading adjective is dropped', resolveMonster('battered skeleton', MONSTERS) === 'skeleton');
  check('a two-word class resolves whole', resolveMonster('giant rat', MONSTERS) === 'giant rat');
  // The one that matters: "ant" is inside "Grant", and a substring test makes a person a bug.
  check('a person whose name CONTAINS a monster is not a monster',
        resolveMonster('Grant', MONSTERS) === null);
  check('an unknown name is not a monster', resolveMonster('Strangerman', MONSTERS) === null);
  check('nothing resolves to nothing', resolveMonster(null, MONSTERS) === null);
}

console.log('\nkillerOf: the broadcast is an observation, the neighbour is a guess');
{
  const k = killerOf(WEDGED_DEATH, MONSTERS);
  check('prefers the server broadcast over the neighbour', k.name === 'spider');
  check('marks a broadcast as observed', k.observed === true);
  check('resolves the broadcast to a monster class', k.is_monster === true);
  const t = killerOf(THIN_DEATH, MONSTERS);
  check('falls back to summary.killed_by', t.name === 'giant rat');
  check('and says out loud that it is a guess', t.observed === false && /GUESS/.test(t.cite));
  const none = killerOf({ summary: {} }, MONSTERS);
  check('no killer at all is admitted rather than invented', none.name === null);
}

console.log('\nstrangersPresent: an unresolved id is not a person');
{
  const fleet = roster([WEDGED_DEATH, PVP_DEATH, CONTESTED_DEATH]);
  check('the roster comes out of the corpus', fleet.has('Oooo') && fleet.has('Bbbb'));
  check('a fleet-mate in the room is not a stranger',
        strangersPresent(PVP_DEATH, fleet).join() === 'Strangerman');
  // Uuuu, 2026-08-28: `<dynamic 1000081>` is truthy, and counting it made six trolls into PVP.
  const dyn = { threats: { players_present: ['<dynamic 1000081>', '<dynamic 22>'] } };
  check('an unresolved resource id is discarded', strangersPresent(dyn, fleet).length === 0);
  check('no players is no strangers', strangersPresent(WEDGED_DEATH, fleet).length === 0);
}

// ── the signatures ────────────────────────────────────────────────────────────────────────

console.log('\nsignatures: mechanical facts, each with a citation');
{
  const s = signatures(WEDGED_DEATH);
  const names = s.map(x => x.name);
  check('a blocked keeper pass is seen', names.includes('keeper_blind'));
  check('a wedge at death is seen', names.includes('wedged_at_death'));
  check('a crowd is seen', names.includes('crowd'));
  check('a flee that never fired is seen', names.includes('never_fled'));
  check('no vigor is seen', names.includes('no_vigor'));
  check('every signature carries a citation', s.every(x => x.cite && x.cite.length > 3));
  check('every signature suggests a class in the vocabulary',
        s.every(x => Object.prototype.hasOwnProperty.call(DEFECT_CLASSES, x.suggests)));
  // wedged_at_death is the stronger statement, so the bare count must not double-report it.
  check('wedges is not reported alongside wedged_at_death', !names.includes('wedges'));

  const thin = signatures(THIN_DEATH).map(x => x.name);
  check('a record with neither instrument says so', thin.includes('thin_record'));
  check('and does not invent a keeper block', !thin.includes('keeper_blind'));
}

console.log('\nsignatures: net-zero movement outranks a slow crawl');
{
  const still = { summary: { movement: { net_squares: 0, seconds: 132.2, squares_per_second: 0,
                                         samples: 40 } } };
  const names = signatures(still).map(x => x.name);
  check('net zero over a long window is seen', names.includes('net_zero'));
  check('and is not also reported as crawling', !names.includes('crawling'));
  // A body that finished where it started in two seconds crossed nothing worth reporting.
  const brief = { summary: { movement: { net_squares: 0, seconds: 2, samples: 2 } } };
  check('net zero over a brief window is not a signature',
        !signatures(brief).map(x => x.name).includes('net_zero'));
}

// ── lens A ────────────────────────────────────────────────────────────────────────────────

console.log('\ntravelCandidates: the default verdict is DEFECT');
{
  const recs = [WEDGED_DEATH, THIN_DEATH, PVP_DEATH, CONTESTED_DEATH];
  const fleet = roster(recs);
  const c = travelCandidates(recs, { monsters: MONSTERS, fleet });
  check('every travelling death is a candidate', c.length === 4);
  const wedged = c.find(x => x.id.includes('Oooo'));
  check('a monster death defaults to defect', wedged.default_verdict === 'defect');
  check('and says the observation is not an available answer',
        /not available as an answer/.test(wedged.asks));
  const pvp = c.find(x => x.id.includes('Bbbb'));
  check('a person landing the blow is exempt', pvp.pvp === true);
  check('and the exemption still asks for the person named', /name the person/.test(pvp.asks));
  const contested = c.find(x => x.id.includes('Cccc'));
  check('a monster blow with a person in the room is NOT auto-exempted', contested.pvp === false);
  check('it is flagged contested instead', contested.contested === true);
  check('the blind keeper sorts above the thin record',
        c[0].id.includes('Oooo'));
  check('the PVP death sorts to the bottom', c[c.length - 1].id.includes('Bbbb'));
}

console.log('\ntravelCandidates: the filters');
{
  const recs = [WEDGED_DEATH, THIN_DEATH];
  const fleet = roster(recs);
  check('a window drops what is older than it',
        travelCandidates(recs, { monsters: MONSTERS, fleet, since: 1788000000000 }).length === 1);
  check('a character filter narrows to one',
        travelCandidates(recs, { monsters: MONSTERS, fleet, character: 'Aaaa' }).length === 1);
  check('a death that was not travelling is not a candidate',
        travelCandidates([{ ...WEDGED_DEATH, was: { doing: 'fighting' } }],
                         { monsters: MONSTERS, fleet }).length === 0);
  check('`stalled` counts as travelling — it is the keeper\'s word for the same thing',
        travelCandidates([{ ...WEDGED_DEATH, was: { doing: 'stalled' } }],
                         { monsters: MONSTERS, fleet }).length === 1);
  check('a record that is not a death is not a candidate',
        travelCandidates([{ ...WEDGED_DEATH, reason: 'level_lost' }],
                         { monsters: MONSTERS, fleet }).length === 0);
}

// ── lens B ────────────────────────────────────────────────────────────────────────────────

console.log('\nnodeCandidates: an undeclared room is the whole Tier-1 signal');
{
  check('declaredJumpsIn matches by room number, not by string',
        declaredJumpsIn('589', JUMPS).length === 1 && declaredJumpsIn(589, JUMPS).length === 1);
  const c = nodeCandidates({ nodes: NODES, jumps: JUMPS, verdicts: VERDICTS, dossiers: ['cave'] });
  check('every stone is a candidate', c.length === 3);
  check('every stone defaults to missing_affordance',
        c.every(x => x.default_verdict === 'missing_affordance'));
  check('"unreachable" is refused in the ask', c.every(x => /not available/.test(x.asks)));

  const cave = c.find(x => x.id === 'node/cave');
  check('a room with no declared jump is flagged',
        cave.signatures.some(s => s.name === 'no_declared_affordance'));
  check('the melded-anyway control case is flagged',
        cave.signatures.some(s => s.name === 'melded_anyway'));
  check('and it sorts first — it is the proof the rule is right', c[0].id === 'node/cave');

  const sentinel = c.find(x => x.id === 'node/sentinel');
  check('a room WITH a declared jump is not flagged for one',
        !sentinel.signatures.some(s => s.name === 'no_declared_affordance'));
  const ice = c.find(x => x.id === 'node/ice');
  check('a stone already inside the meld box is flagged as such',
        ice.signatures.some(s => s.name === 'already_in_the_box'));
  check('a stone with a dossier is not asked for one',
        !cave.signatures.some(s => s.name === 'no_dossier'));
  check('a stone without one is', ice.signatures.some(s => s.name === 'no_dossier'));
  check('every node signature suggests a class in the vocabulary',
        c.every(x => x.signatures.every(s =>
          Object.prototype.hasOwnProperty.call(MISSING_AFFORDANCES, s.suggests))));
}

console.log('\nnodesFromSource: the table is read, not imported');
{
  const src = `
    import { walk } from '../m59-fleetscript.mjs';
    export const NODES = Object.freeze({
      cave: { room: 27, node: 'NODE_ORCCAVES', row: 23, col: 53, where: 'Icky Cave' },
      ice:  { room: 750, node: 'NODE_ICECAVE1', row: 25, col: 23, where: 'Ice' },
    });
    export const script = { name: 'mana-node' };`;
  const n = nodesFromSource(src);
  check('the frozen literal is recovered', Object.keys(n).length === 2 && n.cave.room === 27);
  check('a source with no table gives an empty one',
        Object.keys(nodesFromSource('export const x = 1;')).length === 0);
}

// ── the gates: the half that has to be un-talkable-past ───────────────────────────────────

const GOOD_TRAVEL = {
  id: 'travel/Oooo/x', lens: 'travel', verdict: 'defect', class: 'keeper_blind',
  cite: 'summary.watchdog.longest_block_ms = 5706576',
  mechanism: 'the keeper pass was blocked for ninety-five minutes, so nothing read the health '
           + 'trail and no rung could fire against it.',
  steelman: 'The strongest case for the excuse: twelve things were on it and a level-58 body at '
          + 'one vigor cannot outrun a forest. It fails because the body was never asked to — '
          + 'nothing was driving it for 95 minutes.',
  deliverable: 'tools/m59-autopilot.mjs — the travel loop awaits per hop with no watchdog '
             + 'yield; give Session.travel a pass budget and surface a block over 30s.',
  confidence: 0.9,
};

const GOOD_NODE = {
  id: 'node/cave', lens: 'node', verdict: 'missing_affordance', class: 'undeclared_jump',
  cite: 'substrate/m59-falljumps.json has no entry for room 27',
  mechanism: 'the flood steps one square at a time and a fall is not a step, so a stone across '
           + 'an undeclared one reads as unreachable at whatever distance the flood stops.',
  steelman: 'The strongest case for the excuse: four independent measurements agreed the stone '
          + 'was four squares out of reach. It fails because the operator had already melded it '
          + 'on the night they were taken.',
  deliverable: 'declare the jump in substrate/m59-falljumps.json with observed_by, the way '
             + 'Ukgoth and the Ancient Place are declared.',
  confidence: 0.85,
};

console.log('\ngateCheck: a complete verdict passes');
{
  check('a travel verdict clearing all five gates passes', gateCheck(GOOD_TRAVEL).ok);
  check('a node verdict clearing all five gates passes', gateCheck(GOOD_NODE).ok);
}

console.log('\ngateCheck: each gate refuses on its own');
{
  const without = (k) => { const v = { ...GOOD_TRAVEL }; delete v[k]; return gateCheck(v); };
  const failed = (r, g) => r.failures.some(f => f.gate === g);
  check('G1 refuses a verdict with no citation', failed(without('cite'), 'G1'));
  check('G2 refuses a verdict with no mechanism', failed(without('mechanism'), 'G2'));
  check('G3 refuses a verdict with no class', failed(without('class'), 'G3'));
  check('G4 refuses a verdict with no deliverable', failed(without('deliverable'), 'G4'));
  check('G5 refuses a verdict with no steelman', failed(without('steelman'), 'G5'));
  check('a bare gesture at a citation is not a citation',
        failed(gateCheck({ ...GOOD_TRAVEL, cite: 'logs' }), 'G1'));
  check('a one-word mechanism is not a mechanism',
        failed(gateCheck({ ...GOOD_TRAVEL, mechanism: 'wedged' }), 'G2'));
  check('G3 lists the vocabulary in its refusal',
        gateCheck({ ...GOOD_TRAVEL, class: 'it_died' })
          .failures.some(f => f.gate === 'G3' && f.why.includes('keeper_blind')));
  check('a class from the OTHER lens is refused',
        failed(gateCheck({ ...GOOD_TRAVEL, class: 'undeclared_jump' }), 'G3'));
  check('and the same in reverse',
        failed(gateCheck({ ...GOOD_NODE, class: 'keeper_blind' }), 'G3'));
  check('an empty verdict fails every gate',
        gateCheck({}).failures.filter(f => f.gate.startsWith('G')).length === 5);
}

console.log('\ngateCheck: the excuse, in each of its costumes');
{
  const said = (text, base = GOOD_TRAVEL) =>
    gateCheck({ ...base, mechanism: text }).failures.some(f => f.gate === 'INADMISSIBLE');
  check('"it was overwhelmed" is refused',
        said('the character was overwhelmed by the number of monsters in the room at the time'));
  check('"there were too many" is refused',
        said('there were simply too many monsters present for any character to survive that'));
  check('"it got unlucky" is refused',
        said('the character got unlucky with the spawn timing on that particular crossing'));
  check('"the road is dangerous" is refused',
        said('the roads are dangerous and this is the cost of doing business on a live server'));
  check('"working as intended" is refused',
        said('this is working as intended: travel doctrine says push through a monster'));
  check('a bare restatement of the broadcast is refused',
        said('killed by a spider'));
  check('"needs further investigation" is refused',
        said('this needs further investigation before anything can be said about it'));

  const saidNode = (text) => gateCheck({ ...GOOD_NODE, mechanism: text })
    .failures.some(f => f.gate === 'INADMISSIBLE');
  check('"unreachable" is refused on the node lens',
        saidNode('the stone is unreachable from every entrance that was tried on the night'));
  check('"no route" is refused', saidNode('there is no route to this stone with the current bake'));
  check('"needs new jumping mechanics" is refused',
        saidNode('this one needs new jumping mechanics before it can be attempted at all'));
  check('"the terrain does not allow it" is refused',
        saidNode('the terrain does not allow a body to cross that gap in a single movement'));

  // A lens's ban belongs to that lens. "no route" is a fine thing to say about a travel death.
  check('a node ban does not fire on the travel lens',
        !gateCheck({ ...GOOD_TRAVEL,
                     mechanism: 'the router found no route and the keeper stood still for it' })
          .failures.some(f => f.gate === 'INADMISSIBLE'));
}

console.log('\ngateCheck: quoting the tool\'s refusal is a citation; agreeing with it is a verdict');
{
  // G1 asks the critic to say what the tool printed, and the tool prints "no route". If the ban
  // could not tell a quotation from a conclusion, the only passing verdict would be one that
  // never named the output it was judging.
  const quoted = (t) => gateCheck({ ...GOOD_NODE, mechanism: t })
    .failures.some(f => f.gate === 'INADMISSIBLE');
  check('"reads as unreachable" is a quotation and passes',
        !quoted('a fall is not a step, so a stone across one reads as unreachable at whatever '
              + 'distance the flood happens to stop'));
  check('"the report says no route" is a quotation and passes',
        !quoted('the exit report says no route because the room carries no declared fall, which '
              + 'is true of the file and not of the ground'));
  check('"fineroute returned no route" is a quotation and passes',
        !quoted('fineroute returned no route within 4 jumps, which is a fact about its candidate '
              + 'generator rather than about the canyon'));
  check('but "the stone is unreachable" is a conclusion and is refused',
        quoted('the stone is unreachable from every rim square that was tried across two visits'));
  check('and quoting once does not license concluding it afterwards',
        quoted('the flood reads as unreachable, and having checked the rim I agree it is '
             + 'impossible without new mechanics'));
}

console.log('\ngateCheck: the steelman is exempt, because it has to quote the excuse');
{
  // This is the test that keeps the rule from eating its own critic. G5 REQUIRES the excuse be
  // argued at its strongest; if the ban applied there, the only passing verdict would be one
  // that never considered the obvious answer.
  const v = { ...GOOD_TRAVEL,
              steelman: 'The strongest case: it was overwhelmed by twelve things at once and the '
                      + 'roads are dangerous. It fails because nothing drove the body for 95 '
                      + 'minutes — the crowd is what a blind keeper looks like from outside.' };
  check('an excuse quoted inside the steelman passes', gateCheck(v).ok);
  check('the same words in the mechanism do not',
        !gateCheck({ ...GOOD_TRAVEL, mechanism: v.steelman }).ok);
}

console.log('\ngateCheck: the PVP exemption is the one place that is policed hardest');
{
  const base = { ...GOOD_TRAVEL, verdict: 'not_a_defect', class: 'pvp' };
  const cand = { lens: 'travel', strangers: ['Strangerman'] };
  check('a PVP exemption with no person named is refused',
        gateCheck(base, cand).failures.some(f => f.gate === 'PVP'));
  check('an unresolved id is not a person',
        gateCheck({ ...base, person: '<dynamic 1000081>' }, cand)
          .failures.some(f => f.gate === 'PVP'));
  check('a person who was not in the room is refused',
        gateCheck({ ...base, person: 'Nobody' }, cand).failures.some(f => f.gate === 'PVP'));
  check('a person who WAS in the room is accepted',
        gateCheck({ ...base, person: 'Strangerman' }, cand).ok);
  // Without a candidate to check against there is nothing to cross-reference, so the name alone
  // has to do — but it still has to be a name.
  check('with no candidate, a named person still passes',
        gateCheck({ ...base, person: 'Strangerman' }, null).ok);
}

console.log('\nthe vocabularies and the gates are complete');
{
  check('every gate has a name and a question',
        Object.values(GATES).every(g => g.name && g.asks && g.asks.length > 30));
  check('every travel class carries its argument',
        Object.values(DEFECT_CLASSES).every(v => v.length > 40));
  check('every affordance carries its argument',
        Object.values(MISSING_AFFORDANCES).every(v => v.length > 40));
  check('pvp is the only travel class that is not a defect',
        Object.keys(DEFECT_CLASSES).filter(k => k === 'pvp').length === 1);
  check('every inadmissible rule says WHY it is inadmissible',
        INADMISSIBLE.every(r => r.why && r.why.length > 20 && r.re instanceof RegExp));
  check('every inadmissible rule names a lens it belongs to',
        INADMISSIBLE.every(r => ['travel', 'node', 'both'].includes(r.lens)));
}

console.log('\nparseSince');
{
  const now = 1_000_000_000;
  check('hours', parseSince('24h', now) === now - 24 * 3600e3);
  check('days', parseSince('7d', now) === now - 7 * 86400e3);
  check('minutes', parseSince('90m', now) === now - 90 * 60e3);
  check('nothing is the whole corpus', parseSince(null, now) === 0);
  check('nonsense is the whole corpus rather than a crash', parseSince('soon', now) === 0);
}

// WHICH TREE'S DEATHS — the 2026-09-10 false green, pinned.
//
// The bug was not that the answer was wrong; it was that "0 candidates" and "I read the wrong
// directory" printed identically. These fix the reading and the saying-so separately, because
// either one alone leaves the failure available.
console.log('\nthe store is resolved rather than assumed');
{
  check('a roster path yields its substrate',
        substrateOf('C:\\code\\m59-lab\\prod-deploy\\substrate\\fleets\\prod.json')
          .endsWith('prod-deploy\\substrate'));
  check('a posix roster path yields its substrate',
        String(substrateOf('/srv/m59/substrate/fleet-state.json')).replace(/\\/g, '/')
          .endsWith('/srv/m59/substrate'));
  // A path with no `substrate` in it must be REFUSED rather than guessed at: inventing a
  // directory for a broker we do not understand is the same quiet wrongness as reading the
  // wrong tree, which is what this whole block exists to stop.
  check('a path with no substrate segment is refused, not guessed',
        substrateOf('C:\\somewhere\\else\\thing.json') === null);
  check('nothing in is nothing out', substrateOf(null) === null && substrateOf('') === null);

  const missing = storeStats('C:\\definitely\\not\\here');
  check('a store that is not there reports absent rather than throwing',
        missing.exists === false && missing.records === 0 && missing.newest === null);
}

console.log('\nthe fleet roster is never inferred from a WINDOW');
{
  // Two characters, one of whom did not die inside the window. Reading the roster off the
  // window alone makes the other one a stranger, and `strangers` is the list a `pvp` verdict is
  // validated against — so this is the difference between a false exemption being rejected and
  // being admitted. Kermit/Janice/Waldorf/Statler on prod, 2026-09-10.
  const store = {
    'Kermit-2026-09-10T20-57-28-711Z.json': { character: 'Kermit' },
    'Janice-2026-08-02T01-02-03-004Z.json': { character: 'Janice' },
    // The writer strips whitespace from the filename, so the stem is NOT the character. A
    // roster built from stems calls this one a stranger — the bug wearing the fix's clothes.
    'MarcoPolo-2026-09-10T02-23-51-518Z.json': { character: 'Marco Polo' },
    'LoialtheOgier-2026-09-09T02-23-51-518Z.json': { character: 'Loial the Ogier' },
    'not-a-postmortem.txt': null,
  };
  const readdir = () => Object.keys(store);
  const read = (p) => {
    const f = String(p).split(/[\\/]/).pop();
    if (!store[f]) throw new Error('unreadable');
    return JSON.stringify(store[f]);
  };
  const fleet = rosterFromStore('anywhere', { readdir, read });

  check('a fleet-mate who did not die in the window is still fleet', fleet.has('Janice'));
  check('a name whose filename stripped its spaces is still fleet',
        fleet.has('Marco Polo') && fleet.has('Loial the Ogier'));
  check('the stripped stem itself is NOT the roster entry', !fleet.has('MarcoPolo'));
  check('the window roster alone would have got Janice wrong',
        !roster([store['Kermit-2026-09-10T20-57-28-711Z.json']]).has('Janice'));
  check('a fleet-mate is not reported as a stranger',
        strangersPresent({ threats: { players_present: ['Janice', 'Kage'] } }, fleet)
          .join() === 'Kage');
  check('non-json files are ignored rather than counted', fleet.size === 4);

  // One read per character, not one per record: the store this runs against holds ~3,000 files
  // for ~25 characters, and a roster that costs 3,000 JSON parses is a roster nobody computes.
  let reads = 0;
  rosterFromStore('anywhere', { readdir, read: (p) => { reads++; return read(p); } });
  check('one representative read per character, not one per record', reads === 4);

  // A half-written record is a keeper that died mid-write. It must cost that character its
  // representative, never its place on the roster.
  const withCorrupt = { readdir: () => ['Zoot-2026-09-01T00-00-00-000Z.json',
                                        'Zoot-2026-09-02T00-00-00-000Z.json'],
                        read: (p) => { if (String(p).includes('09-01')) return '{ broken';
                                       return JSON.stringify({ character: 'Zoot' }); } };
  check('a half-written record falls through to the next representative',
        rosterFromStore('anywhere', withCorrupt).has('Zoot'));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
