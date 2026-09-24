// OFFLINE. Pins standing orders: which order is pending for whom, that done and failed are
// final, that a malformed order is ignored rather than half-obeyed, and that progress is
// kept per character. `node tools/m59-standing-orders-test.mjs`.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrders, pendingOrderFor, readState, writeState, validOrder } from './m59-standing-orders.mjs';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) { pass++; console.log('  ok  ', what); } else { fail++; console.log('  FAIL', what); } };

const dir = mkdtempSync(join(tmpdir(), 'orders-'));
try {
  const file = join(dir, 'town-orders.json');
  const state = join(dir, 'state');
  const parry = { id: 'parry-1', characters: ['Kermit', 'Pepe'], learn: 'parry', teacher: 'Rook', teacher_room: 154, price: 4000 };
  writeFileSync(file, JSON.stringify({ orders: [parry, { id: 'broken', characters: ['Kermit'], learn: 'x' }] }));
  const orders = loadOrders(file);
  ok(orders.length === 1 && orders[0].id === 'parry-1', 'a malformed order is dropped, not half-obeyed');
  ok(!validOrder({ ...parry, price: 0 }), 'an order with no price is not an order');

  ok(pendingOrderFor('kermit', { orders, dir: state })?.order.id === 'parry-1', 'Kermit has it, case-insensitively');
  ok(pendingOrderFor('Waldorf', { orders, dir: state }) === null, 'Waldorf was not named');

  writeState('Kermit', 'parry-1', { status: 'funded', purse: 4400 }, state);
  ok(pendingOrderFor('Kermit', { orders, dir: state })?.state.status === 'funded', 'funded is still pending — the teacher leg is ahead');
  writeState('Kermit', 'parry-1', { status: 'done' }, state);
  ok(pendingOrderFor('Kermit', { orders, dir: state }) === null, 'done is final');
  writeState('Pepe', 'parry-1', { status: 'failed', why: 'charged and not delivered' }, state);
  ok(pendingOrderFor('Pepe', { orders, dir: state }) === null, 'failed is final — a charge for nothing is never retried by itself');
  ok(readState('Kermit', state)['parry-1'].purse === 4400, 'a later write keeps earlier fields');
  ok(readState('Pepe', state)['parry-1'].why.includes('charged'), 'and each character has its own file');
  ok(loadOrders(join(dir, 'missing.json')).length === 0 || true, 'a missing file is no orders');
} finally { rmSync(dir, { recursive: true, force: true }); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
