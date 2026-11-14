#!/usr/bin/env node
// NEVER EAT AS AN OPTIONAL MEAL (policy.neverEat, autopilot `never_eat`) — offline, scratch ledger.
//
//   node tools/m59-never-eat-test.mjs
//
// 2026-11-14: Zoot carried 102 mugs of brew as quest cargo for a guild hall and his keeper ate every
// one as mid-hunt top-offs (185 'ate' events in a day), with fight_above_vigor lowered to 40. A mug of
// brew is 3 nutrition for 10 filling, so it is always the smallest bite and there is always room for it.
// protectedItems could not stop that and must not (the bread note above notOursToEat). This pins:
//   - the mid-hunt top-off and the before-travel top-off never eat a never-eat item;
//   - the climb eats other food first;
//   - and falls back to the never-eat item only below the fight floor with nothing else aboard
//     (the bread lesson: a keep list never starves a body), and only up to the floor;
//   - above the floor with only never-eat food aboard, the climb sets out instead of waiting for ever;
//   - the broker argument, the policy default and the strategy field all exist and agree.
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readToolSource } from './autopilot/source.mjs';

const dir = mkdtempSync(join(tmpdir(), 'never-eat-ledger-'));
process.env.M59_LEDGER_DIR = dir;
const { Autopilot } = await import('./m59-autopilot.mjs');
const { Stomach } = await import('./m59-skills.mjs');
const { validateStrategy, mergeOver, fieldForKey, KEY_FACULTY, ARG_KEYS } = await import('./m59-strategy-schema.mjs');

let passed = 0, failed = 0;
const ok = (what, cond, detail = '') => { if (cond) { passed++; console.log(`  ok   ${what}`); }
  else { failed++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); } };

const BREW = 'mug of brew', BREAD = 'loaf of bread';
const NUTRITION = { [BREW]: 3, [BREAD]: 20 };
const names = new Map([[1, BREW], [2, BREAD]]);
const BREW_ID = 100, BREAD_ID = 101;

// A pack-and-vitals rig. `apply` eats one of the stack and records which stack it came from.
function rig({ vigor = 150, floor = 40, ceiling = 200, brew = 50, bread = 0, neverEat = [BREW], hp = 75 } = {}) {
  const eaten = [];
  const c = {
    rsc: { get: id => names.get(id) }, selfId: 9, evSeq: 0, spells: [],
    inventory: [
      ...(brew ? [{ id: BREW_ID, nameRsc: 1, amount: brew }] : []),
      ...(bread ? [{ id: BREAD_ID, nameRsc: 2, amount: bread }] : []),
    ],
    _v: vigor,
    vitals() { return { vigor: { value: this._v }, health: { value: hp, max: 75 } }; },
    apply(id) {
      const o = this.inventory.find(x => x.id === id);
      const name = names.get(o.nameRsc);
      eaten.push(name);
      this._v = Math.min(200, this._v + NUTRITION[name]);
      if (--o.amount <= 0) this.inventory = this.inventory.filter(x => x !== o);
    },
    requestInventory() {}, stats() {}, async waitFor() { return { events: [] }; },
  };
  const ap = Object.create(Autopilot.prototype);
  ap.mode = 'farm';
  ap.policy = { vigorFloor: floor, fightAboveVigor: floor, vigorCeiling: ceiling, restBelow: 0.55, neverEat };
  ap.s = { client: c, need: () => c, pacer: { submit: async (_k, fn) => fn() }, world: { room: { num: 2 } } };
  ap.stomach = new Stomach();
  ap.tally = {}; ap.notes = [];
  ap.note = (what, detail) => ap.notes.push({ what, detail });
  ap.progress = () => {};
  ap.recordAte = () => {};
  ap.who = () => 'Zoot';
  ap.inReachOfUs = () => [];
  ap.inheritedProtectedNames = () => [];
  ap.fightFloor = () => floor;
  ap.poorFarmingActive = () => false;
  ap.secondWindFarming = () => null;
  ap.cookFirst = async () => false;
  ap.warnedThroughput = true;
  return { ap, c, eaten };
}
const provision = (ap, c) => ap.provision({}, c.vitals());

try {
  console.log('--- the mid-hunt top-off ---');
  {
    const { ap, c, eaten } = rig({ vigor: 150, brew: 50 });
    await provision(ap, c);
    ok('only never-eat food aboard: the mid-hunt top-off eats nothing', eaten.length === 0, eaten.join(','));
    ok('and the stack is untouched', c.inventory.find(x => x.id === BREW_ID)?.amount === 50);
  }
  {
    const { ap, c, eaten } = rig({ vigor: 150, brew: 50, bread: 3 });
    await provision(ap, c);
    ok('with bread aboard, the mid-hunt top-off eats the bread', eaten.includes(BREAD), eaten.join(','));
    ok('and never the brew', !eaten.includes(BREW), eaten.join(','));
  }
  {
    const { ap, c, eaten } = rig({ vigor: 150, brew: 50, neverEat: [] });
    await provision(ap, c);
    ok('control: with no never-eat list the brew IS eaten mid-hunt (the bug this fixes)', eaten.includes(BREW), eaten.join(','));
  }
  {
    // Policy names are matched like every keep list: case and the plural do not matter.
    const { ap, c, eaten } = rig({ vigor: 150, brew: 50, neverEat: ['Mugs of Brew'] });
    await provision(ap, c);
    ok('a plural, capitalised list entry still names the brew', eaten.length === 0, eaten.join(','));
  }

  console.log('\n--- the before-travel top-off ---');
  {
    const { ap, c, eaten } = rig({ vigor: 80, floor: 160, brew: 50 });
    const r = await ap.eatBeforeTravel(599);
    ok('only never-eat food aboard: nothing eaten before setting out', r === null && eaten.length === 0, `${r} ${eaten}`);
  }
  {
    const { ap, c, eaten } = rig({ vigor: 80, floor: 160, brew: 50, bread: 5 });
    const r = await ap.eatBeforeTravel(599);
    ok('with bread aboard, a sitting of bread before setting out', r === 'ate' && eaten.includes(BREAD), `${r} ${eaten}`);
    ok('and never the brew', !eaten.includes(BREW), eaten.join(','));
  }
  {
    // Overdrive before a journey in a no-combat room: its climb loop must not wait out the stomach for brew.
    const { ap, c, eaten } = rig({ vigor: 80, floor: 160, brew: 50 });
    ap.policy.overdrive = { target: 200, maxMinutes: 1 };
    ap.s.world.room.num = 38;
    const t0 = Date.now();
    const r = await ap.eatBeforeTravel(599);
    ok('overdrive before travel with only brew aboard returns at once, eating nothing',
       r === null && eaten.length === 0 && Date.now() - t0 < 3000, `${r} ${eaten} ${Date.now() - t0}ms`);
  }

  console.log('\n--- the climb to the fight floor ---');
  {
    const { ap, c, eaten } = rig({ vigor: 30, floor: 40, brew: 50, bread: 3 });
    const r = await provision(ap, c);
    ok('below the floor with bread aboard: the climb eats the bread', r === 'ate' && eaten.includes(BREAD), `${r} ${eaten}`);
    ok('and not the brew', !eaten.includes(BREW), eaten.join(','));
  }
  {
    const { ap, c, eaten } = rig({ vigor: 30, floor: 40, brew: 50 });
    const r = await provision(ap, c);
    ok('below the floor with ONLY brew aboard: the fallback eats it (a body never starves for a keep list)',
       r === 'ate' && eaten.includes(BREW), `${r} ${eaten}`);
  }
  {
    // The fallback climbs to the FLOOR, not the ceiling: pass after pass, it stops eating brew at 40.
    const { ap, c, eaten } = rig({ vigor: 30, floor: 40, brew: 50 });
    for (let i = 0; i < 10; i++) { ap.stomach = new Stomach(); await provision(ap, c); }
    ok('the fallback stops at the floor, not the ceiling', c._v >= 40 && c._v < 40 + NUTRITION[BREW] + 1 && eaten.length <= 4,
       `vigor ${c._v}, ate ${eaten.length}`);
  }
  {
    // Above the floor, latched into a climb towards the ceiling, with only brew aboard: set out.
    const { ap, c, eaten } = rig({ vigor: 100, floor: 40, brew: 50 });
    ap.climbing = true;
    const r = await provision(ap, c);
    ok('above the floor with only brew aboard, the climb sets out rather than waiting for a meal it will not take',
       r === false && ap.climbing === false && eaten.length === 0, `${r} climbing=${ap.climbing} ${eaten}`);
    ok('and says why', ap.notes.some(n => n.what === 'setting out: only reserved food aboard'));
  }
  {
    const { ap, c, eaten } = rig({ vigor: 100, floor: 40, brew: 50, bread: 3 });
    ap.climbing = true;
    const r = await provision(ap, c);
    ok('above the floor in a climb with bread aboard: bread, not brew', r === 'ate' && eaten.includes(BREAD) && !eaten.includes(BREW),
       `${r} ${eaten}`);
  }

  console.log('\n--- the plumbing ---');
  {
    const ap = Object.create(Autopilot.prototype);
    ap.policy = {};
    ok('no neverEat is an empty list, never a throw', Array.isArray(ap.neverEatNames()) && ap.neverEatNames().length === 0);
    ap.policy = { neverEat: 'mug of brew' };
    ok('a malformed neverEat (not a list) reads as empty', ap.neverEatNames().length === 0);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const keeper = readToolSource(join(here, 'm59-autopilot.mjs'), 'utf8');
  ok('the policy default is an empty list', /\n\s+neverEat: \[\],/.test(keeper));
  const broker = readToolSource(join(here, 'm59-broker.mjs'), 'utf8');
  ok('the broker autopilot tool declares never_eat as a list of names',
     /never_eat: \{ type: 'array', items: \{ type: 'string' \}/.test(broker));
  ok('and maps it to policy.neverEat through the item datastore',
     broker.includes('p.policy.neverEat = resolveItemNames(a.never_eat);'));
  const v = validateStrategy({ name: 'brew-run', neverEat: ['mug of brew'] });
  ok('a farm strategy may declare neverEat', v.ok && v.strategy.desired.neverEat?.[0] === BREW, v.why ?? '');
  ok('and it is ADDED to the orders, never replacing them (like protect)',
     JSON.stringify(mergeOver(fieldForKey('neverEat'), ['meat pie'], [BREW])) === JSON.stringify(['meat pie', BREW]));
  ok('credited to the economy faculty, with never_eat as its broker argument',
     KEY_FACULTY.neverEat === 'economy' && ARG_KEYS.never_eat?.[0] === 'neverEat');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
