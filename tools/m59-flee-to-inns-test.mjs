// Offline: who flees how, in tools/m59-flee-to-inns.mjs. Opens no socket and runs no plan --
// the tool exits in plan mode before touching a broker, and only its pure exports are used here.
//   node tools/m59-flee-to-inns-test.mjs
process.argv.push('--fleet', '__flee_test_no_such_fleet__');
const { classify, nextRider, isInn } = await import('./m59-flee-to-inns.mjs');
let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what} ${extra}`); } };
const cfg = { cup: 'hk1', station: 38, hall: 714, hallInn: 103, fragile: 30, splitRow: 36, nearStation: [38, 2] };

ok('an inn is already done', classify({ agent: 't1', room: 153, max: 77 }, cfg) === 'done');
ok('the cup holder holds the station', classify({ agent: 'hk1', room: 38, max: 20 }, cfg) === 'holder');
ok('a 26-health character outside Castle Victoria rides', classify({ agent: 'hk3', room: 2, max: 26 }, cfg) === 'rider');
ok('the fragile ride out of Ukgoth from anywhere in it', classify({ agent: 'hk3', room: 599, row: 60, max: 26 }, cfg) === 'rider');
ok('...but walk from a safe road (Zheng He, 535 -> Marion in 73 s)', classify({ agent: 'hk2', room: 535, max: 20 }, cfg) === 'walker');
ok('Castle Victoria and Outside ride', classify({ agent: 't2', room: 38, max: 74 }, cfg) === 'rider'
  && classify({ agent: 't4', room: 2, max: 76 }, cfg) === 'rider');
ok('north Ukgoth rides (72 s to the north exit)', classify({ agent: 't8', room: 599, row: 5, max: 70 }, cfg) === 'rider');
ok('south Ukgoth walks out the south edge', classify({ agent: 't12', room: 599, row: 66, max: 75 }, cfg) === 'walker');
ok('an unknown row in Ukgoth walks (the router decides the edge)', classify({ agent: 't13', room: 599, max: 76 }, cfg) === 'walker');
ok('elsewhere walks', classify({ agent: 't14', room: 556, max: 75 }, cfg) === 'walker');
ok('Kocatan counts as an inn on arrival', isInn(2001) && isInn(103) && !isInn(714));

const q = nextRider([{ agent: 't2', hp: 70, max: 74 }, { agent: 't11', hp: 30, max: 75 }, { agent: 'hk3', hp: 26, max: 26 }], cfg);
ok('the fragile drink first, whatever their health', q.agent === 'hk3');
ok('then the most hurt', nextRider([{ agent: 't2', hp: 70, max: 74 }, { agent: 't11', hp: 30, max: 75 }], cfg).agent === 't11');
ok('nobody waiting is null', nextRider([], cfg) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
