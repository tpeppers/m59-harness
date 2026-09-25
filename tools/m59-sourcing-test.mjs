#!/usr/bin/env node
// Offline tests for the sourcing planner (m59-sourcing-lib.mjs), over the committed compendium
// tables. No socket, no roster.
import { loadSourcingData, classOf, rollsPerKill, perKill, fightability, optionsFor, sourcingMenu,
         jobsFrom, GHOST_PLAN, preferredIndex } from './m59-sourcing-lib.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const data = loadSourcingData();

ok(classOf(data, "knight's shield") === 'Knightshield', "knight's shield resolves to its kod class");
ok(classOf(data, 'small round shield') === 'MetalShield', 'a small round shield is a MetalShield');

ok(Math.abs(rollsPerKill(60, 4) - (1 + 1 + 4 / 6)) < 1e-9, 'rolls: 1 + level/55 + difficulty/6 (the mean of random(0, d/3))');
ok(rollsPerKill(400, 21) === 6, 'rolls are capped at 6');
ok(Math.abs(perKill(0.05, 2) - 0.0975) < 1e-9, 'per kill: 1 - (1 - p)^rolls');

const lv = [75, 74, 72, 65, 60, 55];
ok(fightability(45, lv).grade === 'easy', 'a level-45 orc is easy for this fleet');
ok(fightability(90, lv).grade === 'in band', 'level 90 is in band (within 150% of the median)');
ok(fightability(200, lv).grade === 'above the fleet', 'level 200 is above the fleet');

const ks = optionsFor(data, "knight's shield", 4, { fleetLevels: lv });
ok(ks.options[0].kind === 'skip', "nobody sells knight's shields: option 0 is go without");
ok(ks.options[1].creature === 'battered skeleton', "the battered skeleton is the best knight's shield farm for this fleet");
ok(ks.options.findIndex(o => o.creature === 'ghost') > 1, 'the ghost is offered, and ranked below what the fleet can fight');

const srs = optionsFor(data, 'small round shield', 6, { fleetLevels: lv });
ok(srs.options[0].kind === 'buy', 'small round shields can be bought: option 0 is buy');
ok(srs.options.some(o => o.creature === 'orc' && o.rooms.some(r => r.num === 27)), 'orcs in the Icky Cave (27) are offered for small round shields');

const chain = optionsFor(data, 'chain armor', 15, { fleetLevels: lv, chestHas: 4 });
const c1 = chain.options.find(o => o.kind === 'chest');
ok(c1 && c1.count === 4 && c1.rest === 11, 'a partial chest draw takes what is there and names the rest');

const menu = sourcingMenu(data, { "knight's shield": 21, 'small round shield': 6 }, { fleetLevels: lv });
const pref = preferredIndex(menu[0], GHOST_PLAN.prefer["knight's shield"]);
ok(pref != null && menu[0].options[pref].creature === 'battered skeleton', "the ghost plan's preference finds the battered skeleton");
const orcIdx = menu[1].options.findIndex(o => o.creature === 'orc');
const jobs = jobsFrom(menu, { "knight's shield": pref, 'small round shield': orcIdx }, GHOST_PLAN.prefer);
ok(jobs.farm.length === 2, 'two sources, two farm jobs');
ok(jobs.farm.find(j => j.creature === 'battered skeleton')?.room === 39, 'the preferred room (Upstairs in Castle Victoria, 39) is the job room');

const m2 = sourcingMenu(data, { 'small round shield': 2, 'leather armor': 2 }, { fleetLevels: lv });
const orcOf = e => e.options.findIndex(o => o.creature === 'orc');
const both = jobsFrom(m2, { 'small round shield': orcOf(m2[0]), 'leather armor': orcOf(m2[1]) });
ok(both.farm.length === 1 && both.farm[0].items.length === 2, 'two items off the same creature in the same room are ONE job');

const partial = jobsFrom([chain], { 'chain armor': chain.options.indexOf(c1) });
ok(partial.chest[0].amount === 4 && partial.buy[0].amount === 11, 'the rest of a partial chest draw is bought');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
