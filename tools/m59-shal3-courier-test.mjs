// Offline: the pure halves of the Shal'ille level-3 trainee courier (tools/fleetscripts/shal3-courier.mjs).
//   node tools/m59-shal3-courier-test.mjs
// Opens no socket: only the exported helpers are exercised, never `steps()` (which reads the broker).
import { hurtAllies, readIdentify } from './fleetscripts/shal3-courier.mjs';
let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what} ${extra}`); } };

const rows = [
  { agent: 't1', character: 'Kermit', room_num: 599, health: '30/80' },
  { agent: 't2', character: 'Pepe', room_num: 599, health: '10/74' },      // a trainee: excluded
  { agent: 't3', character: 'Statler', room_num: 38, health: '5/80' },     // another room
  { agent: 't12', character: 'Lew', room_num: 599, health: '70/80' },      // not hurt enough
  { agent: 't13', character: 'Scooter', room_num: 599, health: '20/80', in_game: false },   // not in the world
  { agent: 't17', character: 'Rizzo', room_num: 599, health: '40/80' },
];
const h = hurtAllies(rows, { room: 599, below: 0.7, exclude: ['t2'] });
ok('hospice goes to fleet-mates in the room, worst first', h.map(r => r.agent).join() === 't1,t17', JSON.stringify(h));
ok('and by CHARACTER name, which is what the cast resolves', h[0].name === 'Kermit');
ok('a trainee is never on its own list', !h.some(r => r.agent === 't2'));
ok('nobody hurt is an empty list, not an error', hurtAllies([], { room: 599 }).length === 0);

const fire = readIdentify(['The ring glows: it protects its wearer from fire.']);
ok('a fire line is read as fire', fire.fire && !fire.cursed);
const cursed = readIdentify(['This item is cursed.']);
ok('a curse is read as a curse', cursed.cursed && !cursed.fire);
ok('silence reads as nothing', !readIdentify([]).fire && !readIdentify([]).cursed);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
