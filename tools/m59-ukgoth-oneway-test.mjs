import assert from 'node:assert/strict';
import { isOneWayBlocked, loadMap, passableExits, findPath } from './m59-map.mjs';
assert.equal(isOneWayBlocked(599, 598), true);
assert.equal(isOneWayBlocked(598, 599), false);
const map = loadMap();
assert.equal(passableExits(map, 599).some(e => Number(e.to) === 598), false);
assert.equal(findPath(map, 598, 599).found, true, 'eastern entrance remains available');
console.log('Ukgoth east is entrance only; planning cannot reverse it');
