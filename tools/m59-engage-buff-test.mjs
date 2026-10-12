// Offline guard for THE ENGAGE BUFF (policy.engageBuff, a strategy's `engageBuff`, Autopilot.castEngageBuff and
// escapeEngageBuffHold). Opens no socket.
//
//   node tools/m59-engage-buff-test.mjs
//
// Operator, 2026-10-12: "have them use karahols curse on themselves when full hp and starting attacking", and
// "They can log off and on if the hold starts on them while they are still fighting". Pinned: cast at full
// health only, never while it is on or while held, at most once in fifteen seconds, at our own object id; a
// cast is judged landed by the mana it spent; the hold escape fires only with something unspared in reach,
// only after a curse this keeper cast, once a minute; and both call sites and the strategy.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OF } from './m59-parse.mjs';
import { Autopilot } from './m59-autopilot.mjs';
import { STRATEGY_FIELDS, validateStrategy } from './m59-strategy-schema.mjs';

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`ok ${name}`); };
const AUTOPILOT = readFileSync(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');

function keeper({ hp = 70, max = 70, mana = 40, spend = 9, ench = [], known = true, cfg = {} } = {}) {
  const casts = [], reconnects = [];
  const c = { selfId: 7, evSeq: 0, rsc: { get: k => ({ 1: "Kara'hol's curse" })[k] ?? '' },
    spells: known ? [{ id: 501, nameRsc: 1 }] : [],
    enchantments: () => ench.map(name => ({ name })),
    vitals: () => ({ health: { value: hp, max }, mana: { value: mana, max: 60 } }),
    cast: (id, targets) => { casts.push({ id, targets }); mana -= spend; },
    waitFor: async () => ({ events: [] }) };
  const ap = Object.create(Autopilot.prototype);
  ap.policy = { engageBuff: { spell: "kara'hol's curse", fullHealthOnly: true, logoffOnHold: true, ...cfg },
                spareCreatures: ['giant rat'] };
  ap.tally = {}; ap.notes = []; ap.recordCast = () => {};
  ap.note = (what) => ap.notes.push(what);
  ap.s = { client: c, pacer: { submit: async (k, f) => f() } };
  ap.reconnect = async (why) => { reconnects.push(why); return { ok: true }; };
  return { ap, c, casts, reconnects, setEnch: e => { ench = e; } };
}

await ok('full health, not on, known: cast at our own object id, landed by the mana spent', async () => {
  const { ap, casts } = keeper();
  const r = await ap.castEngageBuff('before pulling lupogg');
  assert.deepEqual(casts, [{ id: 501, targets: [7] }]);
  assert.equal(r.landed, true);
  assert.equal(ap.tally.engage_buffs, 1);
  assert.ok(ap._engageBuffOnAt > 0);
});

await ok('not at full health, already on, held, or unknown: no cast', async () => {
  for (const opts of [{ hp: 69 }, { ench: ["Kara'hol's curse"] }, { ench: ['Hold'] }, { known: false }]) {
    const { ap, casts } = keeper(opts);
    await ap.castEngageBuff('x');
    assert.equal(casts.length, 0, JSON.stringify(opts));
  }
  const { ap, casts } = keeper({ hp: 50, cfg: { fullHealthOnly: false } });
  await ap.castEngageBuff('x');
  assert.equal(casts.length, 1, 'fullHealthOnly:false casts hurt too');
});

await ok('at most once in fifteen seconds, so a refused cast is not a loop', async () => {
  const { ap, casts } = keeper({ spend: 0 });
  const r = await ap.castEngageBuff('x');
  assert.equal(r.landed, false, 'no mana spent: no proof it landed');
  await ap.castEngageBuff('x');
  assert.equal(casts.length, 1);
});

await ok('the hold escape: held, something unspared in reach, after our own curse -> one reconnect a minute', async () => {
  const lupogg = { id: 30, nameRsc: 2, flags: OF.ATTACKABLE }, rat = { id: 31, nameRsc: 3, flags: OF.ATTACKABLE };
  const k = keeper({ ench: ['Hold'] });
  k.c.rsc = { get: id => ({ 1: "Kara'hol's curse", 2: 'lupogg', 3: 'giant rat' })[id] ?? '' };
  k.ap.inReachOfUs = () => [lupogg];
  assert.equal(await k.ap.escapeEngageBuffHold(), false, 'no curse cast by this keeper: not ours to answer');
  k.ap._engageBuffOnAt = Date.now();
  assert.equal(await k.ap.escapeEngageBuffHold(), true);
  assert.equal(k.reconnects.length, 1);
  assert.equal(await k.ap.escapeEngageBuffHold(), false, 'once a minute');
  k.ap._engageHoldEscapeAt = 0;
  k.ap.inReachOfUs = () => [rat];
  assert.equal(await k.ap.escapeEngageBuffHold(), false, 'a spared rat is not a fight');
  k.ap.inReachOfUs = () => [lupogg];
  k.setEnch([]);
  assert.equal(await k.ap.escapeEngageBuffHold(), false, 'not held');
  k.setEnch(['Hold']);
  k.ap.policy.engageBuff.logoffOnHold = false;
  assert.equal(await k.ap.escapeEngageBuffHold(), false, 'off unless asked');
});

await ok('both call sites, and the escape at the top of the survival stage', () => {
  const pull = AUTOPILOT.slice(AUTOPILOT.indexOf('  async pull(want) {'));
  assert.ok(pull.indexOf('await this.castEngageBuff(`before pulling ${name}`)') < pull.indexOf("c.attack(foe.id)"));
  assert.ok(AUTOPILOT.includes('await this.castEngageBuff(`before swinging at ${engageName}`).catch(() => null);'));
  const flee = AUTOPILOT.slice(AUTOPILOT.indexOf('  async passFleeAndRest(ctx) {'));
  assert.ok(flee.slice(0, 200).includes('if (await this.escapeEngageBuffHold().catch(() => false)) return HANDLED;'));
});

await ok('the field normalises; qor-lupogg-sewers casts Kara\'hol\'s curse and logs off on the hold', async () => {
  const f = STRATEGY_FIELDS.find(x => x.path === 'engageBuff');
  assert.equal(f?.arg, 'engage_buff');
  assert.deepEqual(f.normalize({ spell: " Kara'hol's Curse " }), { spell: "kara'hol's curse", fullHealthOnly: true, logoffOnHold: false });
  assert.throws(() => f.normalize({}));
  const mod = await import('../substrate/farm-strategies.example/qor-lupogg-sewers.mjs');
  assert.deepEqual(mod.default.engageBuff, { spell: "kara'hol's curse", fullHealthOnly: true, logoffOnHold: true });
  const v = validateStrategy(mod.default, { file: 'qor-lupogg-sewers.mjs' });
  assert.ok(v.ok !== false && !(v.problems?.length), JSON.stringify(v).slice(0, 300));
});

console.log(`\n${n} passed`);
