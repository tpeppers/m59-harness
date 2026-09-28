#!/usr/bin/env node
// EAT BEFORE SETTING OUT, SO THE STOMACH DIGESTS ON THE ROAD — offline, scratch ledger.
//
//   node tools/m59-eatbeforetravel-test.mjs
//
// Operator, 2026-09-27: "keepers eat before travel if they expect to want to have eaten on the other
// side ... get their stomachs digesting by eating before". A sitting is capped by the stomach (80 ->
// 119 on bread, then "too full"), and the next sitting waits on the drain; a walk is that wait.
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'ebt-ledger-'));
process.env.M59_LEDGER_DIR = dir;
const { Autopilot } = await import('./m59-autopilot.mjs');
const { Stomach } = await import('./m59-skills.mjs');

let passed = 0, failed = 0;
const ok = (what, cond, detail = '') => { if (cond) { passed++; console.log(`  ok   ${what}`); }
  else { failed++; console.log(`  FAIL ${what}${detail ? ' — ' + detail : ''}`); } };

const names = new Map([[1, 'loaf of bread']]);
// A character in a pack-and-vitals rig: `apply` eats one loaf (20 vigor, 40 filling).
function rig({ floor = 160, vigor = 80, hp = 75, bread = 5, near = [], restBelow = 0.55 } = {}) {
  const c = {
    rsc: { get: id => names.get(id) }, selfId: 9, evSeq: 0,
    inventory: bread ? [{ id: 100, nameRsc: 1, amount: bread }] : [],
    _v: vigor,
    vitals() { return { vigor: { value: this._v }, health: { value: hp, max: 75 } }; },
    apply(id) { const o = this.inventory.find(x => x.id === id); this._v = Math.min(200, this._v + 20);
      if (--o.amount <= 0) this.inventory = this.inventory.filter(x => x !== o); },
    requestInventory() {}, stats() {}, async waitFor() { return { events: [] }; },
  };
  const ap = Object.create(Autopilot.prototype);
  ap.policy = { vigorFloor: floor, fightAboveVigor: floor, vigorCeiling: 200, restBelow };
  ap.s = { client: c, need: () => c, pacer: { submit: async (_k, fn) => fn() }, world: { room: { num: 2 } } };
  ap.stomach = new Stomach();
  ap.tally = {}; ap.notes = [];
  ap.note = (what, detail) => ap.notes.push({ what, detail });
  ap.who = () => 'Rizzo';
  ap.inReachOfUs = () => near;
  ap.inheritedProtectedNames = () => [];
  return { ap, c };
}

try {
  {
    const { ap, c } = rig();
    const r = await ap.eatBeforeTravel(599);
    ok('a crew member at 80 with bread eats before setting out', r === 'ate' && c._v > 80, `${r} ${c._v}`);
    ok('and says why', ap.notes.some(n => n.what === 'ate before setting out' && n.detail.to === 599));
    ok('a whole sitting, not one mouthful: two loaves fill the stomach (80 -> 120)', c._v === 120, String(c._v));
    ok('the stomach model saw the meal', ap.stomach.level > 0);
    const again = await ap.eatBeforeTravel(599);
    ok('a full stomach asks the server for nothing', again === null, String(again));
  }
  {
    const { ap, c } = rig({ floor: 80 });
    ok('a floor at the rest cap leaves the fleet as it was', await ap.eatBeforeTravel(2) === null && c._v === 80);
  }
  {
    const { ap, c } = rig({ near: [{ id: 5 }] });
    ok('never with something in reach: a retreat does not stop to eat', await ap.eatBeforeTravel(2) === null && c._v === 80);
  }
  {
    const { ap, c } = rig({ hp: 30 });
    ok('never hurt below the rest line', await ap.eatBeforeTravel(2) === null && c._v === 80);
  }
  {
    const { ap } = rig({ bread: 0 });
    ok('no food, nothing to do', await ap.eatBeforeTravel(2) === null);
  }
  {
    const { ap, c } = rig({ vigor: 195 });
    ok('already near the ceiling: no meal', await ap.eatBeforeTravel(2) === null && c._v === 195);
  }
  {
    const { ap } = rig();
    ap.larder = () => { throw new Error('boom'); };
    ok('it never throws into travel', await ap.eatBeforeTravel(2) === null);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'm59-autopilot.mjs'), 'utf8');
  const t = src.indexOf('  async travel(room, opts) {');
  ok('the keeper\'s own travel eats before it moves',
     t > 0 && src.slice(t, t + 2500).includes('await this.eatBeforeTravel(room);'));
  const kp = readFileSync(join(here, 'm59-keeper-process.mjs'), 'utf8');
  const j = kp.indexOf('const job = session.travelJob(dest, {');
  // AND SO DOES A JOURNEY ORDERED FROM OUTSIDE — inside the job, not before the answer. The keeper
  // process used to await the meal before replying; with overdrive that held a DUM travel order's
  // HTTP answer for up to 30 minutes and it was re-issued (2026-09-28). Session.travelJob routes
  // through the keeper's Autopilot.travel, which eats first (asserted above).
  const game = readFileSync(join(here, 'm59-game.mjs'), 'utf8');
  ok('and so does a journey ordered from outside (DUM recall, stand-down) — inside the job',
     j > 0 && !kp.slice(Math.max(0, j - 400), j).includes('await autopilot?.eatBeforeTravel?.(dest);') &&
     /travelJob\(dest[\s\S]{0,8000}keeper\.travel\(dest/.test(game));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
