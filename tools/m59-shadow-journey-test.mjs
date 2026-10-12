import assert from 'node:assert/strict';
import {replayJourneyMayResume} from './m59-shadow-replay.mjs';
assert.equal(replayJourneyMayResume(null),true);
assert.equal(replayJourneyMayResume({strategy:'yield_to_controller',status:'yielded'}),true,'Cor Noth yielded decision must not park an active journey at its old wall');
assert.equal(replayJourneyMayResume({strategy:'rest_safe',status:'ended'}),true);
for(const status of ['pending','selected','approaching','resting','logged_off'])
 assert.equal(replayJourneyMayResume({strategy:'route_refuge',status}),false,'active recovery must retain ownership');
console.log('8 shadow journey resume assertions passed');
