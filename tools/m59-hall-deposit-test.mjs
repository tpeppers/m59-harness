#!/usr/bin/env node
// m59-hall-deposit-test.mjs -- offline. PART OF A STACK INTO A GUILD CHEST.
//
// `hall_withdraw`'s `deposit` put whole stacks only; the client's Put dialog puts any amount. This pins:
//   - the entry forms ("elderberry:150", "id:<n>:150", {item|id, amount}) and that every old form keeps its meaning;
//   - the BYTES of a counted BP_REQ_PUT -- the number-tagged id and the 4-byte count that UserPut Splits by
//     (user.kod:1002-1006, :3882; blakserv/parsecli.c:378) -- and of the old whole-stack put;
//   - hallWithdraw end to end against a fake server that decodes those bytes the way blakserv and UserPut do:
//     only the counted part leaves the pack, it is measured in units, a refusing chest passes the rest on,
//     a malformed entry moves nothing, and a worn item never moves.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'm59-hall-deposit-'));
process.env.M59_STORAGE_DIR = scratch;
process.env.M59_LEDGER_DIR = scratch;
const { M59Client, BP } = await import('./m59-client.mjs');
const { Autopilot } = await import('./m59-autopilot.mjs');
const { parseDeposit, depositEntryFor, depositPut, depositShort, countDepositMatches } = await import('./m59-hall-deposit.mjs');

let pass = 0, fail = 0;
const ok = (c, what, detail = '') => { if (c) pass++; else { fail++; console.log(`  FAIL: ${what}${detail ? ' — ' + detail : ''}`); } };
const section = s => console.log(`\n${s}`);
const nameOf = o => String(o?.name ?? '').toLowerCase();

section('the entry forms: old ones unchanged, a count after a colon or in `amount`');
{
  const { entries, refused } = parseDeposit(['Elderberry', 'id:8123', 'elderberry:150', 'id:8124:20',
    { item: 'herbs', amount: 30 }, { id: 77, amount: 5 }, { item: 'orc tooth' }, { id: 78 }]);
  const shape = entries.map(e => [e.kind, e.kind === 'id' ? e.id : e.name, e.amount]);
  ok(JSON.stringify(shape) === JSON.stringify([
    ['name', 'elderberry', null], ['id', 8123, null], ['name', 'elderberry', 150], ['id', 8124, 20],
    ['name', 'herbs', 30], ['id', 77, 5], ['name', 'orc tooth', null], ['id', 78, null]]), 'eight forms parsed', JSON.stringify(shape));
  ok(refused.length === 0, 'nothing refused');
  ok(entries.every(e => e.remaining === e.amount), 'the budget starts at the amount (null = whole stacks)');
  const bad = parseDeposit(['elderberry:0', 'id:', 'id:12:0', { item: 'herbs', amount: 2.5 }, { amount: 3 }, '', { id: -1 }]);
  ok(bad.entries.length === 0 && bad.refused.length === 7, 'zero, fraction, no name, empty, bad id: REFUSED, never read as "the whole stack"',
     JSON.stringify(bad));
}

section('which entry governs a pack row, and how big its put is');
{
  const { entries } = parseDeposit(['elderberry:150', 'id:5:3']);
  const stack = { id: 9, name: 'elderberry', amount: 432, tag: 1 };
  const e = depositEntryFor(entries, stack, nameOf);
  ok(e?.label === 'elderberry:150', 'a counted name entry matches by substring');
  const p = depositPut(stack, e);
  ok(p.asked === 150 && p.spec.id === 9 && p.spec.amount === 150, '150 of 432: a counted spec', JSON.stringify(p));
  e.remaining = 40;
  ok(depositPut(stack, e).spec.amount === 40, 'what is left of the budget, not the amount asked for at first');
  // 2026-11-20, 713: a chest refuses a put that does not fit whole; the retry halves the put in the same chest.
  ok(depositPut(stack, e, 20).spec.amount === 20, 'a cap halves the put (a refused 40 is retried as 20)');
  ok(depositPut(stack, e, 0.4).spec.amount === 1, 'the cap never goes below one unit');
  e.remaining = 0;
  ok(depositEntryFor(entries, stack, nameOf) === null && depositPut(stack, e) === null, 'a spent budget matches nothing more');
  const idE = depositEntryFor(entries, { id: 5, name: 'herbs', amount: 2, tag: 1 }, nameOf);
  ok(idE?.kind === 'id' && depositPut({ id: 5, amount: 2, tag: 1 }, idE).asked === 2, 'an id budget larger than the stack takes the stack');
  ok(JSON.stringify(depositShort(entries)) === JSON.stringify({ 'id:5:3': 3 }), 'deposit_short names what is still wanted');
  const whole = depositPut(stack, parseDeposit(['elderberry']).entries[0]);
  ok(whole.spec.amount === 432 && whole.asked === 432, 'no amount: the whole stack, exactly dropSpec(o)');
  const sword = depositPut({ id: 11, name: 'long sword' }, parseDeposit(['long sword:2']).entries[0]);
  ok(sword.spec === 11 && sword.asked === 1, 'a non-stack object is one unit and goes as its bare id');
  ok(countDepositMatches([{ id: 9, name: 'Elderberry', amount: 432 }, { id: 5, name: 'herbs', amount: 2 }, { id: 3, name: 'long sword' }],
     ['elderberry:150', 'id:5:3']) === 434, 'countDepositMatches counts the matching stock, counted entries included');
}

// The client's own encoder, unchanged: M59Client.prototype.put -> containerObject -> encodeIdList.
const wire = (spec, chest) => {
  const out = [];
  M59Client.prototype.put.call({ containerObject: M59Client.prototype.containerObject,
    send: (op, ...parts) => out.push([op, Buffer.concat(parts).toString('hex')]) }, spec, chest);
  return out[0];
};
section('the bytes on the wire: BP_REQ_PUT {number-tagged id, count} {chest}');
{
  const stack = { id: 8123, name: 'elderberry', amount: 432, tag: 1 };
  const { entries } = parseDeposit(['elderberry:150']);
  const [op, hex] = wire(depositPut(stack, entries[0]).spec, 9001);
  ok(op === BP.REQ_PUT && op === 112, 'opcode 112, BP_REQ_PUT');
  // 0x10001fbb = CLIENT_TAG_NUMBER<<28 | 8123; 150 = 0x96; chest 9001 = 0x2329. Little endian throughout.
  ok(hex === 'bb1f0010' + '96000000' + '29230000', '150 of 8123 into 9001: tagged id, count, chest', hex);
  const [, whole] = wire(depositPut(stack, parseDeposit(['elderberry']).entries[0]).spec, 9001);
  ok(whole === 'bb1f0010' + 'b0010000' + '29230000', 'the old whole-stack put: the same form carrying 432', whole);
  const [, bare] = wire(depositPut({ id: 8200, name: 'long sword' }, parseDeposit(['id:8200']).entries[0]).spec, 9001);
  ok(bare === '08200000' + '29230000', 'a non-stack object: a bare id and the chest, no count', bare);
  const [, byId] = wire(depositPut(stack, parseDeposit(['id:8123:20']).entries[0]).spec, 9001);
  ok(byId === 'bb1f0010' + '14000000' + '29230000', '"id:8123:20": 20 out of that stack', byId);
}

// A fake server for the put: decodes the payload as parsecli.c does (4-byte object, a count after it when the tag
// nibble is CLIENT_TAG_NUMBER) and applies UserPut (user.kod:3882): a NumberItem with no count or a count outside
// 1..piNumber moves nothing (Split, numbitem.kod:253); a chest that will not hold the split part refuses it whole and
// it rejoins the pack. `cap` is how many more units a chest will take.
function fakeKeeper({ pack, chests }) {
  const notes = [], sent = [];
  const objects = new Map(chests.map(ch => [ch.id, { id: ch.id, name: 'chest', nameRsc: ch.id, row: 18, col: 2 + ch.id % 7 }]));
  const c = {
    evSeq: 0, events: [], self: { row: 18, col: 4 }, me: { name: 'Tester' }, saveCount: 3, savePausedAt: null,
    room: { objects }, inventory: pack, using: new Set([900]),
    rsc: { get: (r) => (objects.has(r) ? 'chest' : null) },
    requestInventory() {},
    contents(id) {
      const ch = chests.find(x => x.id === id);
      this.events.push({ seq: ++this.evSeq, kind: 'container', id, items: ch.items.map(i => ({ ...i })) });
    },
    containerObject: M59Client.prototype.containerObject,
    put: M59Client.prototype.put,
    send(op, ...parts) {
      const b = Buffer.concat(parts);
      sent.push([op, b.toString('hex')]);
      if (op !== BP.REQ_PUT) return;
      const w = b.readUInt32LE(0), tag = w >>> 28, id = w & 0x0fffffff;
      const number = tag === 1 ? b.readInt32LE(4) : null;
      const where = b.readUInt32LE(tag === 1 ? 8 : 4);
      const ch = chests.find(x => x.id === where);
      const i = c.inventory.findIndex(x => x.id === id);
      if (!ch || i < 0) return;
      const o = c.inventory[i];
      const isNumber = Number(o.amount) >= 1;
      if (isNumber) {
        if (number == null || number < 1 || number > o.amount) return;     // Split refuses: nothing moves
        if (ch.cap != null && number > ch.cap) return;                        // ReqNewHold refuses: it rejoins
        o.amount -= number;
        if (o.amount === 0) c.inventory.splice(i, 1);
        const there = ch.items.find(x => x.name === o.name);
        if (there) there.amount += number; else ch.items.push({ id: 7000 + sent.length, name: o.name, amount: number });
        if (ch.cap != null) ch.cap -= number;
        return;
      }
      if (ch.cap != null && ch.cap < 1) return;
      ch.items.push(c.inventory.splice(i, 1)[0]);
      if (ch.cap != null) ch.cap -= 1;
    },
    async waitFor({ since = 0, kinds = [] } = {}) { return { events: this.events.filter(e => e.seq > since && kinds.includes(e.kind)) }; },
  };
  const s = { name: 'Tester', need: () => c, client: c, world: { room: { num: 714 } },
    pacer: { submit: async (_kind, fn) => fn() }, walkTo: async () => ({}) };
  const k = Object.create(Autopilot.prototype);
  const facts = [];
  Object.assign(k, { s, name: 'Tester', policy: {}, note: (what, f) => notes.push({ what, ...f }), tradeFact: f => facts.push(f),
    hallHere: () => ({ ok: true, room: 714 }), reachHallChests: async () => ({ ok: true, steps: [] }) });
  return { k, c, notes, sent, facts, chests };
}
const units = (list, name) => list.filter(x => x.name === name).reduce((n, x) => n + (Number(x.amount) || 1), 0);
const PACK = () => [{ id: 900, name: 'hammer' }, { id: 8123, name: 'elderberry', amount: 432, tag: 1 },
  { id: 8124, name: 'herbs', amount: 60, tag: 1 }, { id: 8200, name: 'long sword' }];

section('hallWithdraw: "elderberry:150" puts 150 of 432 in, and the stack stays in the pack');
{
  const g = fakeKeeper({ pack: PACK(), chests: [{ id: 2578, items: [] }] });
  const r = await g.k.hallWithdraw([], { deposit: ['elderberry:150'] });
  ok(units(g.c.inventory, 'elderberry') === 282 && units(g.chests[0].items, 'elderberry') === 150, '282 left, 150 in the chest',
     JSON.stringify([g.c.inventory, g.chests[0].items]));
  ok(g.c.inventory.some(x => x.id === 8123), 'the same stack, same id, fewer in it');
  ok(JSON.stringify(r.deposited) === JSON.stringify([{ name: 'elderberry', amount: 150 }]) && !r.deposit_short, 'reply: deposited 150, nothing short',
     JSON.stringify(r));
  ok(units(g.c.inventory, 'herbs') === 60 && g.c.inventory.some(x => x.id === 8200), 'nothing else moved');
  ok(g.sent.filter(([op]) => op === BP.REQ_PUT).length === 1, 'one put, no split-first round trip');
  ok(g.facts.some(f => f.guild_deposited?.[0]?.amount === 150), 'the trade book records 150, not the stack');
}

section('the old forms: whole stacks, exactly as before');
{
  const g = fakeKeeper({ pack: PACK(), chests: [{ id: 2578, items: [] }] });
  const r = await g.k.hallWithdraw([], { deposit: ['elderberry', 'id:8200'] });
  ok(units(g.c.inventory, 'elderberry') === 0 && units(g.chests[0].items, 'elderberry') === 432, '"elderberry": all 432');
  ok(!g.c.inventory.some(x => x.id === 8200) && g.chests[0].items.some(x => x.id === 8200), '"id:8200": that one sword');
  ok(units(g.c.inventory, 'herbs') === 60 && g.c.inventory.some(x => x.id === 900), 'herbs and the worn hammer stay');
  ok(r.deposited?.length === 2 && !r.deposit_refused, 'reply lists both', JSON.stringify(r.deposited));
  const st = fakeKeeper({ pack: PACK(), chests: [{ id: 2578, items: [] }] });
  const rs = await st.k.hallWithdraw([], { stash: ['herbs'] });
  ok(units(st.c.inventory, 'elderberry') === 0 && units(st.c.inventory, 'herbs') === 60 && st.c.inventory.some(x => x.id === 900),
     'stash (the keep list) is untouched: everything but herbs and the worn hammer', JSON.stringify(st.c.inventory));
  ok(rs.deposited === undefined, 'and a stash-only reply has no deposit fields');
}

section('across stacks, across chests, by id, as objects');
{
  const two = fakeKeeper({ pack: [{ id: 900, name: 'hammer' }, { id: 1, name: 'elderberry', amount: 100, tag: 1 },
    { id: 2, name: 'elderberry', amount: 80, tag: 1 }], chests: [{ id: 2578, items: [] }] });
  const r2 = await two.k.hallWithdraw([], { deposit: ['elderberry:150'] });
  ok(units(two.c.inventory, 'elderberry') === 30 && units(two.chests[0].items, 'elderberry') === 150, '150 out of 100 + 80: 30 left',
     JSON.stringify(two.c.inventory));
  ok(r2.deposited.reduce((n, d) => n + d.amount, 0) === 150, 'the reply adds to 150', JSON.stringify(r2.deposited));
  const full = fakeKeeper({ pack: PACK(), chests: [{ id: 2578, items: [], cap: 100 }, { id: 2579, items: [] }] });
  const rf = await full.k.hallWithdraw([], { deposit: ['elderberry:150'] });
  // 2026-11-20, 713: a refused put is retried SMALLER in the same chest before the next chest is tried, so a chest
  // with room for 100 takes 100 of the 150 (75 + 25 after halving) and the next chest takes the other 50.
  ok(units(full.chests[0].items, 'elderberry') === 100 && units(full.chests[1].items, 'elderberry') === 50 && units(full.c.inventory, 'elderberry') === 282,
     'a chest that refuses the whole put is filled by smaller puts, and the next chest takes the rest', JSON.stringify(full.chests));
  ok(rf.deposited.reduce((n, d) => n + d.amount, 0) === 150, 'the reply still adds to 150', JSON.stringify(rf.deposited));
  const byId = fakeKeeper({ pack: PACK(), chests: [{ id: 2578, items: [] }] });
  await byId.k.hallWithdraw([], { deposit: [{ id: 8124, amount: 25 }, { item: 'elderberry', amount: 32 }] });
  ok(units(byId.c.inventory, 'herbs') === 35 && units(byId.c.inventory, 'elderberry') === 400, '{id, amount} and {item, amount}',
     JSON.stringify(byId.c.inventory));
  const big = fakeKeeper({ pack: PACK(), chests: [{ id: 2578, items: [] }] });
  const rb = await big.k.hallWithdraw([], { deposit: ['herbs:500'] });
  ok(units(big.c.inventory, 'herbs') === 0 && rb.deposit_short?.['herbs:500'] === 440, 'more than is carried: all of it, and deposit_short says 440',
     JSON.stringify(rb));
}

section('refusals: a malformed entry moves nothing; worn never moves');
{
  const g = fakeKeeper({ pack: PACK(), chests: [{ id: 2578, items: [] }] });
  const r = await g.k.hallWithdraw([], { deposit: ['elderberry:0'] });
  ok(units(g.c.inventory, 'elderberry') === 432 && r.deposit_refused?.length === 1 && r.deposited.length === 0,
     '"elderberry:0" is refused and nothing goes in', JSON.stringify(r));
  const w = fakeKeeper({ pack: PACK(), chests: [{ id: 2578, items: [] }] });
  await w.k.hallWithdraw([], { deposit: ['hammer:1', 'id:900'] });
  ok(w.c.inventory.some(x => x.id === 900) && !w.sent.length, 'the worn hammer: never sent, by name with a count or by id');
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\nm59-hall-deposit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
