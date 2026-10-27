#!/usr/bin/env node
// Offline guard for GANG UP (policy.gangUp, a strategy's `gangUp`, m59-gang-up.mjs, Autopilot.gangUpFilter and the
// places the keeper chooses quarry). Opens no socket, touches no roster.
//
//   node tools/m59-gang-up-test.mjs
//
// Operator, 2026-10-27 ~19:35Z, of the Guardians of Zjiria in Ukgoth (599): "If a guardian is seen, they should try to
// fight it 2-on-1 (or more than 2 against it), that's the only change it should have from regular trolls." Minutes
// earlier a coordinator had switched the whole 599 crew to the guardian strategy on ">= 2 crew in the ROOM", and Janice
// (t7) fought the cluster alone with Bunsen forty rows away. So the quorum is fleet-mates AT THE MONSTER, read by the
// keeper from its own room view when it chooses. Pinned: a lone keeper beside a Guardian takes a troll; one fleet-mate
// within the radius of the GUARDIAN (not of us) makes it quarry; a stranger never counts; nor does a fleet-mate far
// from it; a menagerie host does; an unlisted creature is untouched; silence is the old behaviour; the radius is
// Chebyshev; min 3 needs two; closestPullable obeys it and exempts a quorum-met guardian from the ceiling and nothing
// else; the bystander rule, the pending pull and the buddy tagger ask it; the fight-back edict and the survival
// ladder do not; the field validates and a bad shape refuses the whole file at load. It should fail the day a keeper
// takes on a guardian alone because somebody else of ours is merely in the room.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'm59-gang-up-test-'));
const DIR = join(tmp, 'farm-strategies');
mkdirSync(DIR, { recursive: true });
process.env.M59_FARM_STRATEGY_DIR = DIR;
process.env.M59_FARM_STRATEGY_DIRS_FILE = join(tmp, 'no-such-dirs.json');
process.env.M59_LEDGER_DIR = join(tmp, 'ledger');
process.env.M59_PVP_HOLD_DIR = join(tmp, 'holds');

let pass = 0, fail = 0;
const test = async (label, fn) => {
  try { await fn(); pass++; console.log(`  ok   ${label}`); }
  catch (e) { fail++; console.log(`  FAIL ${label} -- ${e?.message ?? e}`); }
};
const assert = (cond, why = 'assertion failed') => { if (!cond) throw new Error(why); };
const eq = (a, b, what = '') => {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${what ? what + ': ' : ''}expected ${y}, got ${x}`);
};
const throws = (fn, re, what = '') => {
  try { fn(); } catch (e) { if (re && !re.test(e.message)) throw new Error(`${what} threw the wrong reason: ${e.message}`); return; }
  throw new Error(`${what} did not throw`);
};

const { normalizeGangUp, gangUpRuleFor, gangUpQuorum, chebyshev, GANG_UP_DEFAULTS } = await import('./m59-gang-up.mjs');
const schema = await import('./m59-strategy-schema.mjs');
const { loadFarmStrategy } = await import('./m59-strategy-engine.mjs');
const { Autopilot, policyDefaults, rankQuarries } = await import('./m59-autopilot.mjs');
const party = await import('./m59-party.mjs');
const skills = await import('./m59-skills.mjs');
const { OF } = await import('./m59-parse.mjs');
const { readToolSource } = await import('./autopilot/source.mjs');

// The keeper process's own fleet-mate source (m59-keeper-process.mjs): the roster, plus this character and the
// menagerie's hosts in `extra`. A stat that fails keeps the seed, so this is exactly what a keeper would answer.
const ROSTER = { t7: { credentials: { character: 'Janice' } }, t5: { credentials: { character: 'Bunsen' } },
                 t8: { credentials: { character: 'Robin' } } };
party.setRosterSource(party.rosterFileSource(join(tmp, 'no-such-roster.json'), {
  seed: ROSTER, extra: ['Janice', 'Tos Merchant'],
  fs: { statSync: () => { throw new Error('no file'); }, readFileSync: () => { throw new Error('no file'); } } }));

// ------------------------------------------------------------------------------------------- a room, as a keeper sees it
const MONSTER = OF.ATTACKABLE, PLAYER = OF.PLAYER | OF.ATTACKABLE;
const NAMES = new Map([[1, 'Janice'], [2, 'Bunsen'], [3, 'Morpheus'], [4, 'Robin'], [5, 'Tos Merchant'],
                       [10, 'Guardian of Zjiria'], [20, 'troll'], [30, 'giant rat']]);
const SELF = 1;
const RULE = { 'guardian of zjiria': { min: 2, radius: 4 } };
const ORDERS = { hunt: ['troll', 'guardian of zjiria'], huntPriority: ['guardian of zjiria', 'troll'], gangUp: RULE };

function keeper({ objects, policy = ORDERS, maxHealth = 79 }) {
  const map = new Map();
  let id = 1000;
  for (const o of objects) { const oid = o.id ?? id++; map.set(oid, { ...o, id: oid }); }
  const c = {
    selfId: SELF, room: { objects: map }, rsc: { get: k => NAMES.get(k) },
    get self() { return this.room.objects.get(SELF); },
    vitals: () => ({ health: { value: maxHealth, max: maxHealth } }),
  };
  const s = { name: 't7', client: c, need: () => c, world: { room: { num: 599 },
    approachSquare: (col, row) => ({ col, row, steps: chebyshev({ row, col }, c.self) }) } };
  const notes = [];
  const ap = Object.create(Autopilot.prototype);
  Object.assign(ap, { s, policy: JSON.parse(JSON.stringify(policy)), note: (what, data) => notes.push({ what, ...data }) });
  return { ap, c, notes };
}
const me = (row = 10, col = 10) => ({ id: SELF, nameRsc: 1, flags: PLAYER, row, col });
const guardian = (row = 11, col = 11, id = 100) => ({ id, nameRsc: 10, flags: MONSTER, row, col });
const troll = (row = 20, col = 20, id = 200) => ({ id, nameRsc: 20, flags: MONSTER, row, col });
const player = (nameRsc, row, col) => ({ nameRsc, flags: PLAYER, row, col });
const bunsen = (row, col) => player(2, row, col);
const stranger = (row, col) => player(3, row, col);

// THE CHOOSER, in passFarm's order (pinned against the source below): the hunt match, the gang-up filter, the claim
// ranking, then hunt_priority. Confinement, avoid, hunt area and cooling are the identity here.
function choose(ap) {
  let found = skills.findCreature(ap.s, ap.policy.hunt, { match: ap.huntMatch() });
  if (found.length && ap.policy.gangUp) found = ap.gangUpFilter(found);
  found = rankQuarries('t7', 599, found);
  if (ap.policy.huntPriority) found = ap.huntPriorityOrder(found);
  return found[0] ? ap.s.client.rsc.get(found[0].nameRsc) : null;
}

console.log('the choice, from this keeper\'s own room view');
await test('a lone keeper beside a Guardian does not take it: it takes a troll, though the priority names the guardian first', () => {
  const { ap, notes } = keeper({ objects: [me(), guardian(), troll()] });
  eq(choose(ap), 'troll');
  assert(notes.some(n => /gang-up: leaving it alone/.test(n.what) && n.need === 1 && n.have === 0), 'the skip is said, with the count');
  eq(ap.gangUpStatus().last.skipped.map(s => s.creature), ['Guardian of Zjiria'], 'status names what was left alone');
});
await test('one fleet-mate within the radius OF THE GUARDIAN makes it quarry (2-on-1)', () => {
  const { ap, notes } = keeper({ objects: [me(), guardian(), troll(), bunsen(13, 14)] });
  eq(choose(ap), 'Guardian of Zjiria');
  assert(notes.some(n => /enough of us at it/.test(n.what) && n.mates.includes('Bunsen')), 'the take is said, naming who');
});
await test('a STRANGER within the radius does not count', () => {
  const { ap } = keeper({ objects: [me(), guardian(), troll(), stranger(12, 12)] });
  eq(choose(ap), 'troll');
  eq(ap.gangUpBars(ap.s.client.room.objects.get(100)).strangers_near, 1, 'the stranger is seen, and counted as a stranger');
});
await test('a fleet-mate far from the guardian does not count -- in the room is not at the monster (the Janice incident)', () => {
  const { ap } = keeper({ objects: [me(), guardian(), troll(), bunsen(51, 11)] });
  eq(choose(ap), 'troll');
});
await test('a fleet-mate beside US but not within the radius of the guardian does not count', () => {
  const { ap } = keeper({ objects: [me(10, 10), guardian(11, 16), troll(), bunsen(10, 7)] });   // 9 squares from it
  eq(choose(ap), 'troll');
});
await test('this keeper itself never counts toward its own quorum', () => {
  const { ap } = keeper({ objects: [me(11, 12), guardian(11, 11), troll()] });
  eq(ap.gangUpVerdict(ap.s.client.room.objects.get(100)).mates, []);
});
await test('a menagerie host counts: fleetmate is the "do not shoot" answer, hosts included', () => {
  const { ap } = keeper({ objects: [me(), guardian(), troll(), player(5, 12, 13)] });
  eq(choose(ap), 'Guardian of Zjiria');
});
await test('the radius is CHEBYSHEV in coarse squares: 4 diagonal squares counts, 5 straight does not', () => {
  let { ap } = keeper({ objects: [me(), guardian(11, 11), troll(), bunsen(15, 15)] });   // Euclid 5.7, king's moves 4
  eq(choose(ap), 'Guardian of Zjiria');
  ({ ap } = keeper({ objects: [me(), guardian(11, 11), troll(), bunsen(16, 11)] }));
  eq(choose(ap), 'troll');
});
await test('min 3 needs TWO other fleet-mates at it; a stranger does not make up the number', () => {
  const policy = { ...ORDERS, gangUp: { 'guardian of zjiria': { min: 3, radius: 4 } } };
  eq(choose(keeper({ policy, objects: [me(), guardian(), troll(), bunsen(12, 12)] }).ap), 'troll');
  eq(choose(keeper({ policy, objects: [me(), guardian(), troll(), bunsen(12, 12), stranger(12, 13)] }).ap), 'troll');
  eq(choose(keeper({ policy, objects: [me(), guardian(), troll(), bunsen(12, 12), player(4, 13, 12)] }).ap), 'Guardian of Zjiria');
});
await test('each guardian is judged on its own: the one with a fleet-mate at it is taken, not the nearer one without', () => {
  const { ap } = keeper({ objects: [me(), guardian(11, 11, 100), guardian(30, 30, 101), troll(), bunsen(31, 31)] });
  let found = ap.gangUpFilter(skills.findCreature(ap.s, ap.policy.hunt, { match: ap.huntMatch() }));
  found = ap.huntPriorityOrder(found);
  eq(found[0].id, 101);
  assert(!found.some(o => o.id === 100), 'the lone one is not in the list at all');
});
await test('a creature gangUp does not list is untouched: a lone keeper takes the nearest troll', () => {
  const { ap } = keeper({ objects: [me(), troll(12, 12, 201), troll(25, 25, 202)] });
  eq(ap.gangUpVerdict(ap.s.client.room.objects.get(201)), null);
  const found = ap.gangUpFilter(skills.findCreature(ap.s, ap.policy.hunt, { match: ap.huntMatch() }));
  eq(found.map(o => o.id), [201, 202]);
});
await test('silence is the old behaviour: with no gangUp the guardian is taken alone, as ukgoth-guardians did', () => {
  const { ap, notes } = keeper({ policy: { ...ORDERS, gangUp: null }, objects: [me(), guardian(), troll()] });
  eq(choose(ap), 'Guardian of Zjiria');
  eq(ap.gangUpFilter([1, 2]), [1, 2]);
  eq(ap.gangUpStatus(), null);
  eq(notes.length, 0, 'nothing said');
});
await test('it never widens the hunt: a listed creature `hunt` does not name is not prey with a quorum, and status says so', () => {
  const { ap } = keeper({ policy: { hunt: ['troll'], gangUp: RULE }, objects: [me(), guardian(), troll(), bunsen(12, 12)] });
  eq(choose(ap), 'troll');
  eq(ap.gangUpStatus().ignored.map(i => i.name), ['guardian of zjiria']);
  const listed = keeper({ objects: [me()] }).ap;
  eq(listed.gangUpStatus().ignored, [], 'a rule hunt does produce is not ignored');
});
await test('the quorum is re-read every time: a fleet-mate walking away takes the guardian off the list', () => {
  const { ap, c } = keeper({ objects: [me(), guardian(), troll(), { ...bunsen(12, 12), id: 2 }] });
  eq(choose(ap), 'Guardian of Zjiria');
  Object.assign(c.room.objects.get(2), { row: 40, col: 40 });
  eq(choose(ap), 'troll');
});

console.log('pulling, and the engagement ceiling');
await test('closestPullable never pulls a guardian short of its quorum: it re-picks the troll', () => {
  const { ap } = keeper({ policy: { ...ORDERS, pullThroughCrowd: true }, objects: [me(), guardian(12, 12), troll(16, 16)] });
  eq(ap.closestPullable()?.id, 200);
});
await test('the ceiling decision: WITH its quorum a 79-health keeper may pull a level-120 guardian', () => {
  const { ap } = keeper({ policy: { ...ORDERS, pullThroughCrowd: true },
    objects: [me(), guardian(12, 12), troll(16, 16), bunsen(13, 13)] });
  assert(ap.refuseEngagement('Guardian of Zjiria'), 'premise: the ceiling refuses it for this body');
  eq(ap.closestPullable()?.id, 100);
});
await test('...and that exemption is the quorum\'s alone: hunted but unlisted, the ceiling still refuses it there', () => {
  const { ap } = keeper({ policy: { ...ORDERS, gangUp: null, pullThroughCrowd: true },
    objects: [me(), guardian(12, 12), troll(16, 16), bunsen(13, 13)] });
  eq(ap.closestPullable()?.id, 200);
});

// ------------------------------------------------------------------------------------------- where the keeper asks it
const SRC = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
// One method's text: from its definition to the next method definition at the class's indent.
const method = (name) => {
  const start = new RegExp(`\\n  (?:async )?${name}\\(`).exec(SRC);
  if (!start) throw new Error(`no ${name} in the keeper`);
  const next = /\n  (?:async )?[A-Za-z_$][\w$]*\(.*\)\s*\{\s*\n/g;
  next.lastIndex = start.index + start[0].length;
  const end = next.exec(SRC);
  return SRC.slice(start.index, end ? end.index : SRC.length);
};
const passFarm = SRC.slice(SRC.indexOf('  async passFarm(ctx) {'), SRC.indexOf('\n  async ', SRC.indexOf('  async passFarm(ctx) {') + 30));

console.log('where it is asked, and where it is not');
await test('passFarm: the gate runs after confinement, avoid and the hunt area, and before the ranking and the priority', () => {
  const at = s => { const i = passFarm.indexOf(s); if (i < 0) throw new Error(`passFarm lost: ${s}`); return i; };
  const gate = at('if (found.length && this.policy.gangUp) found = this.gangUpFilter(found);');
  assert(gate > at('found = found.filter(target => quarryPermittedByConfinement('), 'after confinement');
  assert(gate > at('const avoidPrey = this.preyAvoid('), 'after the avoid set');
  assert(gate > at('const huntArea = this.huntAreaHere(room?.num)'), 'after the hunt area');
  assert(gate < at('found = rankQuarries('), 'before the ranking');
  assert(gate < at('found = this.huntPriorityOrder(found, preferId)'), 'before hunt_priority');
  assert(gate < at('claimQuarry(this.s.name, room?.num, found[0]?.id)'), 'before the claim');
});
await test('passFarm: short of its quorum a gang-up creature in reach is a BYSTANDER, answered as unnamed orders would', () => {
  assert(passFarm.includes('return (!isOurs(n) || !!this.gangUpBars(o)) && !this.karmaForbids(n); });'));
  const by = passFarm.indexOf('!!this.gangUpBars(o)'), refused = passFarm.indexOf("this.note('will not trade blows with this'");
  assert(by > 0 && refused > by, 'the ceiling refusal still answers the bystander after it');
});
await test('passFarm: a pull out for a gang-up creature is dropped when its quorum lapses, before the swing is planned', () => {
  const drop = passFarm.indexOf('} else if (this.gangUpLapsedPull(pulled)) this.pendingPull = null;');
  assert(drop > passFarm.indexOf('A PULL WHOSE QUARRY IS GONE IS NOT A PLAN'), 'beside the vanished-quarry check');
  assert(drop < passFarm.indexOf('const plannedQuarryId = this.pendingPull?.target_id ?? selectedQuarry?.id ?? null;'));
});
await test('gangUpLapsedPull: true and said when the pulled guardian has nobody of ours at it; false while somebody is', () => {
  const lone = keeper({ objects: [me(), guardian(15, 15), troll()] });
  lone.ap.pendingPull = { target: 'Guardian of Zjiria', target_id: 100 };
  eq(lone.ap.gangUpLapsedPull(lone.c.room.objects.get(100)), true);
  assert(lone.notes.some(n => /dropping the pull/.test(n.what) && n.target_id === 100), 'the drop is said');
  const with2 = keeper({ objects: [me(), guardian(15, 15), troll(), bunsen(17, 17)] });
  eq(with2.ap.gangUpLapsedPull(with2.c.room.objects.get(100)), false);
  eq(with2.ap.gangUpLapsedPull(with2.c.room.objects.get(200)), false, 'a troll pull is never this rule\'s');
  eq(with2.ap.gangUpLapsedPull(null), false);
});
await test('closestPullable, the buddy tagger and the rest-to-work check ask it', () => {
  assert(method('closestPullable').includes('if (gang && !gang.met) continue;'));
  assert(method('closestPullable').includes('if (gang ? this.karmaForbids(name) : this.refuseEngagement(name)) continue;'));
  assert(SRC.includes('seen.monsters.filter(m => !this.gangUpBars(m, gangPlayers))'));
  assert(SRC.includes('.some(o=>!pilot.gangUpBars?.(o)&&Math.hypot('));
});
await test('SELF-DEFENCE IS UNTOUCHED: the fight-back edict, the flee/rest ladder and the ceiling never consult it', () => {
  for (const m of ['passFightBack', 'passFleeAndRest', 'refuseEngagement', 'threatCeiling', 'roomOutranksUs', 'karmaForbids'])
    assert(!/gangUp/.test(method(m)), `${m} mentions gangUp`);
  assert(method('passFightBack').includes(': this.refuseEngagement(name) };'), 'fight-back still asks the band alone');
});
await test('status reports gang_up beside hunt_priority', () => {
  assert(/hunt_priority: this\.huntPriorityStatus\(\),[\s\S]{0,400}gang_up: this\.gangUpStatus\(\),/.test(SRC));
});

// ------------------------------------------------------------------------------------------- the field
console.log('the field');
await test('the schema names gangUp as a work field, policy key gangUp', () => {
  const f = schema.STRATEGY_FIELDS.find(x => x.path === 'gangUp');
  assert(f && f.keys.length === 1 && f.keys[0] === 'gangUp' && f.faculty === 'work' && f.arg === 'gang_up', JSON.stringify(f));
  eq(schema.KEY_FACULTY.gangUp, 'work');
});
await test('the Autopilot default object carries gangUp: null, so an unassignment has somewhere to go back to', () => {
  new Autopilot({ name: 't0', live: true, client: null, world: { room: { num: 1 } }, need: () => null,
                  pacer: { submit: async (_k, fn) => fn() } });
  const d = policyDefaults();
  assert(d && Object.hasOwn(d, 'gangUp') && d.gangUp === null, JSON.stringify(d?.gangUp));
});
await test('normal form: names folded, defaults filled in, null and {} are inert', () => {
  eq(normalizeGangUp({ ' Guardian  of Zjiria ': { min: 2 }, Troll: { radius: 6, min: 3 } }),
     { 'guardian of zjiria': { min: 2, radius: GANG_UP_DEFAULTS.radius }, troll: { min: 3, radius: 6 } });
  eq(normalizeGangUp({ 'guardian of zjiria': {} }), { 'guardian of zjiria': { min: 2, radius: 4 } });
  eq(normalizeGangUp(null), null); eq(normalizeGangUp(undefined), null); eq(normalizeGangUp({}), null);
});
await test('bad shapes are refused, each with its reason', () => {
  const bad = [
    [['guardian of zjiria'], /gangUp is/], ['guardian of zjiria', /gangUp is/], [2, /gangUp is/],
    [{ 'guardian of zjiria': 2 }, /must be \{ min, radius \}/], [{ 'guardian of zjiria': null }, /must be \{ min, radius \}/],
    [{ 'guardian of zjiria': [2, 4] }, /must be \{ min, radius \}/],
    [{ 'guardian of zjiria': { min: 1 } }, /min must be a whole number from 2/],
    [{ 'guardian of zjiria': { min: 2.5 } }, /min must be/], [{ 'guardian of zjiria': { min: '2' } }, /min must be/],
    [{ 'guardian of zjiria': { min: 99 } }, /min must be/],
    [{ 'guardian of zjiria': { radius: 0 } }, /radius must be/], [{ 'guardian of zjiria': { radius: -1 } }, /radius must be/],
    [{ 'guardian of zjiria': { radius: 40 } }, /radius must be/], [{ 'guardian of zjiria': { radius: 1.5 } }, /radius must be/],
    [{ 'guardian of zjiria': { min: 2, count: 2 } }, /unrecognised count/],
    [{ 'Guardian of Zjiria': { min: 2 }, 'guardian of zjiria': { min: 3 } }, /twice/],
    [{ '  ': { min: 2 } }, /not a creature name/],
    [Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`creature ${i}`, {}])), /at most 24/],
  ];
  for (const [v, re] of bad) throws(() => normalizeGangUp(v), re, JSON.stringify(v));
});
await test('the rule lookup goes through the hunt matcher: "guardian of zjiria" is the live "Guardian of Zjiria", not a troll', () => {
  const { ap } = keeper({ objects: [me()] });
  const matcherFor = k => ap.huntMatch(k);
  eq(gangUpRuleFor(RULE, 'Guardian of Zjiria', { matcherFor }), { creature: 'guardian of zjiria', min: 2, radius: 4 });
  eq(gangUpRuleFor(RULE, 'troll', { matcherFor }), null);
  eq(gangUpRuleFor({ troll: { min: 2, radius: 4 } }, 'Guardian of Zjiria', { matcherFor }), null);
});
await test('a creature whose square is unknown fails closed', () => {
  const v = gangUpQuorum({ creature: 'x', min: 2, radius: 4 }, { row: null, col: 3 }, [{ name: 'Bunsen', row: 1, col: 3 }],
    { isFleetmate: () => true });
  assert(!v.met && /not known/.test(v.why), JSON.stringify(v));
});
const SNIPPET = `
  hunt: ['troll', 'guardian of zjiria'],
  huntPriority: ['guardian of zjiria', 'troll'],
  gangUp: { 'guardian of zjiria': { min: 2, radius: 4 } },`;
await test('the Ukgoth snippet validates in a strategy file, and the key lands as normalised, faculty work', () => {
  const r = schema.validateStrategy({ name: 'ukgoth-599-trolls', describe: 'x', hunt: ['troll', 'guardian of zjiria'],
    huntPriority: ['guardian of zjiria', 'troll'], gangUp: { 'guardian of zjiria': { min: 2, radius: 4 } },
    weapons: { preferMagic: true, banned: ['bow', 'crossbow'], style: 'normal' },
    confine: { rooms: [599], station: 599, roam: false }, vigor: { fightAbove: 100 } }, { file: 'ukgoth-599-trolls.mjs' });
  assert(r.ok, r.why);
  eq(r.strategy.desired.gangUp, { 'guardian of zjiria': { min: 2, radius: 4 } });
  eq(r.strategy.faculties.gangUp, 'work');
  eq(r.unrecognised, []);
});
await test('a bad gangUp refuses the WHOLE file at load, naming the field', async () => {
  writeFileSync(join(DIR, 'bad-gang.mjs'), `export default { name: 'bad-gang', hunt: ['troll'],
    gangUp: { 'guardian of zjiria': { min: 1 } } };\n`);
  const r = await loadFarmStrategy('bad-gang', { resolveItem: null });
  assert(!r.ok && /gangUp/.test(r.why), r.why);
  writeFileSync(join(DIR, 'good-gang.mjs'), `export default { name: 'good-gang', ${SNIPPET} };\n`);
  const g = await loadFarmStrategy('good-gang', { resolveItem: null });
  assert(g.ok, g.why);
});
await test('assigned, the engine lays it over the keeper\'s policy under work -- and yields it while a bot holds work', async () => {
  const mk = () => ({ name: 't7', live: true, client: null, world: { room: { num: 599 } }, need: () => null,
                      pacer: { submit: async (_k, fn) => fn() } });
  const ap = new Autopilot(mk(), { mode: 'farm', policy: { hunt: 'troll', farmStrategy: 'good-gang' } });
  await ap.applyFarmStrategy('join');
  eq(ap.policy.gangUp, RULE);
  const held = new Autopilot(mk(), { mode: 'farm', policy: { hunt: 'troll', farmStrategy: 'good-gang' } });
  held.facultyOwner = f => f === 'work' ? 'dum' : 'keeper';
  await held.applyFarmStrategy('join');
  eq(held.policy.gangUp ?? null, null, 'nothing written under a held work');
  eq(held.status().farm_strategy.keys.gangUp.yielded_to, 'dum');
});

party.setRosterSource(null);
try { rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
