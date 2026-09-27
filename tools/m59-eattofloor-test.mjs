#!/usr/bin/env node
// A FLOOR ABOVE THE REST CAP IS EATEN TO IN EVERY MODE, NOT ONLY FARM.
//
//   node tools/m59-eattofloor-test.mjs
//
// Offline: binds Autopilot.prototype.eatToFloor to a rig, and reads the source for the two call
// sites. Opens no socket.
//
// 2026-09-27: provision() — the only thing that eats — ran only inside passFarm's farm block. The
// Ukgoth troll crew is staged IDLE (passErrand returns before passFarm) and Raphael runs SURVIVE
// (skips the farm block), so a floor of 160 was an order nothing could carry out: every one sat at
// 80 of 200 with bread, meat pies and inky-caps in the pack.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Autopilot } from './m59-autopilot.mjs';

let passed = 0, failed = 0;
const ok = (what, cond) => { if (cond) { passed++; console.log(`  ok   ${what}`); }
                             else { failed++; console.log(`  FAIL ${what}`); } };

const rig = (floor) => {
  const calls = [];
  const r = { policy: { fightAboveVigor: floor, strategy: 'fieldrest' },
              s: { client: { vitals: () => ({ vigor: { value: 80, max: 200 } }) } },
              provision: async (plan, v) => { calls.push({ plan, v }); return 'ate'; } };
  r.eatToFloor = Autopilot.prototype.eatToFloor.bind(r);
  return { r, calls };
};

{
  const { r, calls } = rig(160);
  ok('a floor of 160 eats', await r.eatToFloor({ v: { vigor: { value: 80 } } }) === 'ate' && calls.length === 1);
}
{
  const { r, calls } = rig(80);
  ok('a floor at the rest cap (80) leaves the fleet as it was', await r.eatToFloor({}) === null && !calls.length);
}
{
  const { r, calls } = rig(40);
  ok('and so does the fleet default of 40', await r.eatToFloor({}) === null && !calls.length);
}

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'm59-autopilot.mjs'), 'utf8');
const idleAt = src.indexOf("if (await this.hibernate('idle: no job to do')");
ok('the idle branch eats before it hibernates',
   idleAt > 0 && src.slice(Math.max(0, idleAt - 300), idleAt).includes('this.eatToFloor(ctx)'));
ok('a non-farm mode eats in passFarm before the farm block',
   /if \(this\.mode !== 'farm' && await this\.eatToFloor\(ctx\) === 'ate'\) return HANDLED;/.test(src));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
