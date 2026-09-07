// Offline behavior checks for the actual internal-door executor.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
const start = source.indexOf('  async crossSameRoomDoor(');
const end = source.indexOf('\n  // WHICH INTERNAL DOOR', start);
const Session = new Function('KOD_FINENESS', 'DOOR_SETTLE_MS', 'isTerminalMovementReason',
  'setTimeout', `return class { ${source.slice(start, end)} }`)(64, 0, () => false, fn => fn());
const door = { row: 10, col: 13, arriveRow: 10, arriveCol: 15 };
function body({ teleport = true, cancelAt = null } = {}) {
  const s = new Session();
  let cancelled = false, go = 0, lean = 0;
  let pos = { row: 10, col: 12 };
  s.movementGeneration = 1;
  s.world = { room: { num: 951 } };
  s.need = () => ({ evSeq: 0, eventsSince: () => [], go: () => {
    go++; if (teleport) pos = { row: 10, col: 15 };
  }});
  s.confirmPosition = async () => ({ ...pos });
  s.movementWasCancelled = () => cancelled;
  s.walkTo = async () => {
    if (cancelAt === 'walk') { cancelled = true; return { cancelled: true }; }
    pos = { row: door.row, col: door.col }; return { arrived: true };
  };
  s.stepFine = async () => { lean++; return { moved: true }; };
  s.standBeforeGo = async () => { if (cancelAt === 'stand') cancelled = true; };
  s.pacer = { submit: async (_kind, fn) => fn() };
  return { s, counts: () => ({ go, lean }) };
}
for (const cancelAt of ['walk', 'stand']) {
  const b = body({ cancelAt });
  assert.equal((await b.s.crossSameRoomDoor(door)).cancelled, true);
  assert.deepEqual(b.counts(), { go: 0, lean: 0 });
}
{
  const b = body({ teleport: false });
  assert.equal((await b.s.crossSameRoomDoor(door)).crossed, false,
    'standing within two squares of the landing is not evidence that go moved us');
}
{
  const b = body();
  assert.equal((await b.s.crossSameRoomDoor(door)).crossed, true);
  assert.equal(b.counts().go, 1);
}
console.log('4 internal-door crossing scenarios passed');
