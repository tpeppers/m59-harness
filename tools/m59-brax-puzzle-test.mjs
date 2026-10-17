import assert from 'node:assert/strict';
import {liftServerModel} from './fixtures/brax-lift-server-model.mjs';
import {braxPuzzleReadiness,braxResetBaseline,braxLeverUsable,braxFailedReadyAfter,BRAX_RESET_FLOORS} from './m59-brax-puzzle.mjs';
const old=liftServerModel();old.solve();old.advance(314000);assert(old.pull(0));
for(const [at,index]of [[323000,1],[337000,2],[352000,3]]){old.advance(at);assert(old.pull(index));}
old.advance(366000);assert.equal(old.pull(4),false,'reproduce the recorded final-corner stuck refusal after an early second trip');
assert.deepEqual(old.state.events.filter(e=>e.kind==='activate').map(e=>e.at),[240000,360000],'a reentrant solve creates a second late activation callback');
const fixed=liftServerModel();fixed.solve();fixed.advance(361000);assert(braxResetBaseline(fixed.state.floors));
const readiness=braxPuzzleReadiness({raisedAt:0,readyAfter:241000},fixed.state.floors,361000);assert(readiness.ready);
assert(!braxPuzzleReadiness({raisedAt:0,readyAfter:241000},fixed.state.floors,314000).ready);
const group={phase:'center',readiness:{verifiedAt:361000,readyAfter:361000}};
assert(braxLeverUsable(group,{row:21,col:55},fixed.state.floors));assert(fixed.pull(0));
group.phase='corners';group.centerAt=361000;
for(let i=1;i<=4;i++){assert(braxLeverUsable(group,{row:16,col:51},fixed.state.floors));assert(fixed.pull(i));}
assert.equal(fixed.state.floors[3],800,'all five ordinary pulls solve after the complete reset chain');
assert(!braxLeverUsable(group,{row:25,col:60},fixed.state.floors),'never activate a lever on an already raised platform');
let unknown=braxPuzzleReadiness(null,BRAX_RESET_FLOORS,1000);assert(!unknown.ready);
assert(braxPuzzleReadiness(unknown,BRAX_RESET_FLOORS,242000).ready);
assert.equal(braxPuzzleReadiness(unknown,{...BRAX_RESET_FLOORS,2:800},242000).baselineSince,null);
assert(!braxLeverUsable({phase:'corners'}, {row:16,col:51},{...BRAX_RESET_FLOORS,2:800,5:340,6:340,7:340,8:340}));
assert.equal(braxFailedReadyAfter({readiness:{readyAfter:361000}},400000),361000,'an untouched cancelled boarding group adds no puzzle cooldown');
assert.equal(braxFailedReadyAfter({lastTouchAttemptAt:1000},5000),422000);
console.log('Brax puzzle: reproduced reentrant reset and stuck lever; readiness waits through late activation, requires full baseline, and fences every pull');

assert(!braxLeverUsable({phase:'center',failure:'boarding stopped',readiness:{verifiedAt:1}},{row:21,col:55},BRAX_RESET_FLOORS),'a failed boarding cohort must not touch the otherwise ready center lever');
