#!/usr/bin/env node
// OFFLINE. The concierge route (operator, 2026-09-28: "Make it so those chest routings are automatic,
// like the same path someone would normally route to try to deposit, it checks for the 'concierge
// service'"): readDeskOpen in m59-vault-broker.mjs, and Autopilot.depositViaDesk — walk to the desk's
// town room, file a deposit ticket, and count what the go-between took off the PACK, not the ticket.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-concierge-'));
process.env.M59_VAULT_TICKETS = join(dir, 'vault-broker', 'tickets.json');
const { readDeskOpen, writeDeskOpen, DESK_OPEN_FILE, DESK_OPEN_STALE_MS, TicketBook, TICKETS_FILE } =
  await import('./m59-vault-broker.mjs');
const { Autopilot } = await import('./m59-autopilot.mjs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

// ---- is the desk open
ok(readDeskOpen('prod') === null, 'no OPEN file: the desk is closed');
writeDeskOpen('prod', { pid: 1, town_rooms: [106, 104] }, { now: 1_000_000 });
ok(readDeskOpen('prod', { now: 1_000_000 + 60_000 })?.meet_room === 106, 'a fresh file: open, meeting in its first town room');
ok(readDeskOpen('prod', { now: 1_000_000 + DESK_OPEN_STALE_MS + 1 }) === null, 'a stale file: closed (a crashed desk is not open)');
ok(DESK_OPEN_FILE('prod').startsWith(join(dir, 'vault-broker')), 'the file sits beside the tickets');

// ---- depositViaDesk against a fake body and a fake desk
function keeper({ taker = null, reach = true } = {}) {
  const k = new Autopilot({}, { mode: 'farm', policy: { vaultDeskPollMs: 20, vaultDeskWaitMs: 400 } });
  k.name = 't12';
  k.pack = [{ name: 'dragonfly eye', amount: 6 }, { name: 'vial of solagh', amount: 9 }, { name: 'meat pie', amount: 12 }];
  k.walked = [];
  k.packAsItems = () => k.pack;
  k.note = () => {};
  k.travel = async room => { k.walked.push(room); return reach ? { arrived: true } : { arrived: false, reason: 'no route' }; };
  if (taker) setTimeout(() => taker(k), 60);
  return k;
}
const want = { total: 15, chests: [{ slot: 'r18c2', give: [{ item: 'dragonfly eye', amount: 6 }] },
                                   { slot: 'r18c6', give: [{ item: 'vial of solagh', amount: 9 }, { item: 'nothing', amount: 0 }] }] };
const desk = { meet_room: 106, town_rooms: [106] };

// The desk's go-between takes it: the pack drops and the ticket is closed done.
let k = keeper({ taker: kk => {
  kk.pack = kk.pack.filter(i => i.name === 'meat pie');
  const b = new TicketBook(TICKETS_FILE('prod')); const t = b.open().find(x => x.from === 't12');
  b.update(t.id, { status: 'done' });
} });
let r = await k.depositViaDesk(want, desk);
ok(k.walked[0] === 106, `walks to the desk's town room, never into the hall (${k.walked.join(',')})`);
ok(r.contributed === 15 && r.status === 'done', `counts what LEFT THE PACK: 15 (${r.contributed}, ${r.status})`);
const filed = new TicketBook(TICKETS_FILE('prod')).read().tickets.find(x => x.id === r.ticket);
ok(filed?.kind === 'deposit' && filed.items.length === 2 && filed.where === 106,
   `files exactly what the plan gives, by name, with its room (${JSON.stringify(filed?.items)})`);
ok(!filed.items.some(i => i.item === 'meat pie'), 'nothing outside the plan is on the ticket');

// Nobody comes: nothing moved, and the ticket is withdrawn so the desk does not chase a gone customer.
k = keeper();
r = await k.depositViaDesk(want, desk);
ok(r.contributed === 0 && r.status === 'expired', `nobody took it: 0, ticket expired (${r.contributed}, ${r.status})`);

// Cannot get there: nothing filed.
const before = new TicketBook(TICKETS_FILE('prod')).read().tickets.length;
k = keeper({ reach: false });
r = await k.depositViaDesk(want, desk);
ok(r.contributed === 0 && new TicketBook(TICKETS_FILE('prod')).read().tickets.length === before,
   'the town room was unreachable: no ticket is filed');

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
