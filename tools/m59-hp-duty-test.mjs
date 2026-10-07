// OFFLINE. Pins m59-hp-duty's decision: the band, the skill it waits on, the exceptions, and that
// leaving a band restores exactly the orders it overwrote. `node tools/m59-hp-duty-test.mjs`.
import { bandFor, decide } from './m59-hp-duty.mjs';

let pass = 0, fail = 0;
const ok = (c, what) => { if (c) { pass++; console.log('  ok  ', what); } else { fail++; console.log('  FAIL', what); } };

const config = { except: ['Pepe', 'Statler'], bands: [{ name: 'living-tree-duty', at_least: 75, requires: ['parry'],
  order: { farm_strategy: 'living-tree-duty', assigned_room: 537, confine_rooms: [537, 536] } }] };
const orders = { farmStrategy: null, assignedRoom: 38, confineRooms: null, hunt: ['skeleton', 'zombie'] };
const parry = ['dodge', 'Parry'];

ok(bandFor({ maxHealth: 75, skills: parry, character: 'Lew', config })?.name === 'living-tree-duty', '75 with parry is in the band');
ok(bandFor({ maxHealth: 74, skills: parry, character: 'Lew', config }) === null, '74 is not');
ok(bandFor({ maxHealth: 80, skills: ['dodge'], character: 'Lew', config }) === null, 'without parry, not yet');
ok(bandFor({ maxHealth: 80, skills: parry, character: 'pepe', config }) === null, 'an excepted character never is');

let d = decide({ agent: 't20', character: 'Lew', maxHealth: 75, skills: ['dodge'], orders, prior: null, config });
ok(d.action === 'none' && /waiting on parry/.test(d.why), `the reason it waits is said (${d.why})`);

d = decide({ agent: 't20', character: 'Lew', maxHealth: 75, skills: parry, orders, prior: null, config });
ok(d.action === 'enter' && d.push.farm_strategy === 'living-tree-duty' && d.push.assigned_room === 537, 'entering pushes the band order');
ok(d.save.before.assigned_room === 38 && d.save.before.farm_strategy === null && !('hunt' in d.save.before),
   'and saves only the keys it overwrites');

const prior = d.save;
d = decide({ agent: 't20', character: 'Lew', maxHealth: 76, skills: parry, orders: {}, prior, config });
ok(d.action === 'stay' && !d.push, 'staying in the band pushes nothing');

d = decide({ agent: 't20', character: 'Lew', maxHealth: 74, skills: parry, orders: {}, prior, config });
ok(d.action === 'leave' && d.push.assigned_room === 38 && d.push.farm_strategy === null && d.push.confine_rooms === null,
   'dropping below restores the saved orders, nulls included');
ok(d.save === null, 'and forgets the band');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
