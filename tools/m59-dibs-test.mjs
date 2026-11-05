#!/usr/bin/env node
// Offline: DIBS -- floor items in one room reserved for named characters (tools/m59-dibs.mjs), pure and through the REAL
// Session.lootFloor. Operator 2026-11-05: Gonzo's purple mushroom drop at Zheng He's feet in 2144 was looted by every farmer
// walking through (Rizzo took 52); the ignore list is per character and everywhere, so the claim is per room and per item.
//
//   node tools/m59-dibs-test.mjs
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-dibs-test-'));
const FILE = join(dir, 'dibs-test.json');
process.env.M59_LEDGER_DIR = join(dir, 'ledger');
process.env.M59_DIBS_FILE = FILE;

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) pass++; else fail++; console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`); };

const d = await import('./m59-dibs.mjs');
const { Session } = await import('./m59-game.mjs');
const { OF } = await import('./m59-parse.mjs');

console.log('the rule, pure');
const book = d.normalizeBook({ claims: [{ room: 2144, item: 'purple mushroom', for: ['Bunsen', 'Beaker', 't8'] }] });
ok('a claimed item on the claimed floor is refused to anybody else',
   !d.dibsVerdict({ book, room: 2144, item: 'purple mushroom', character: 'Rizzo' }).allowed);
ok('...and allowed to a named character', d.dibsVerdict({ book, room: 2144, item: 'Purple Mushroom', character: 'beaker' }).allowed);
ok('a claim may name the agent id instead', d.dibsVerdict({ book, room: 2144, item: 'purple mushroom', character: ['Robin', 't8'] }).allowed);
ok('the floor\'s plural ("purple mushrooms") is the same item', !d.dibsVerdict({ book, room: 2144, item: 'purple mushrooms', character: 'Rizzo' }).allowed);
ok('ROOM-SCOPED: the same item in another room is anybody\'s', d.dibsVerdict({ book, room: 2143, item: 'purple mushroom', character: 'Rizzo' }).allowed);
ok('ITEM-SCOPED: another item on the claimed floor is anybody\'s', d.dibsVerdict({ book, room: 2144, item: 'mushroom', character: 'Rizzo' }).allowed);
ok('exact names: "purple mushroom" does not claim "purple mushroom pie"', d.dibsVerdict({ book, room: 2144, item: 'purple mushroom pie', character: 'Rizzo' }).allowed);
const spent = d.normalizeBook({ claims: [{ room: 2144, item: 'purple mushroom', for: ['Bunsen'], until: '2000-01-01T00:00:00Z' }] });
ok('a claim past its until is spent', d.dibsVerdict({ book: spent, room: 2144, item: 'purple mushroom', character: 'Rizzo' }).allowed);
const problems = [];
const bad = d.normalizeBook({ claims: [{ room: 2144, item: 'purple mushroom', for: [] }, { room: 'x', item: 'a', for: ['b'] }] }, problems);
ok('a claim for NOBODY is refused rather than stranding the item', bad.claims.length === 0 && problems.length === 2, JSON.stringify(problems));

console.log('the file');
writeFileSync(FILE, JSON.stringify({ claims: [{ room: 2144, item: 'purple mushroom', for: ['Bunsen'] }] }));
ok('a book is read', d.readDibs(FILE).claims.length === 1);
writeFileSync(FILE, '{ not json'); const t = new Date(Date.now() + 5000); utimesSync(FILE, t, t);
ok('a file that will not parse KEEPS the last good book (does not release every claim)', d.readDibs(FILE).claims.length === 1);
ok('...and says so', /unreadable/.test(d.dibsError(FILE) ?? ''), d.dibsError(FILE));
d.forgetDibs();
const fresh = join(dir, 'absent.json');
ok('no file: no claims, everything is anybody\'s', d.readDibs(fresh).claims.length === 0);
const cli = join(dir, 'cli.json');
d.setClaim(cli, { room: 2144, item: 'purple mushroom', forWho: ['Bunsen', 'Beaker', 'Robin'], why: 'hold practice', by: 'test' });
d.setClaim(cli, { room: 2144, item: 'purple mushroom', forWho: ['Bunsen'], by: 'test' });
ok('set replaces the claim on the same room and item rather than stacking a second', d.readDibs(cli).claims.length === 1 && d.readDibs(cli).claims[0].for.length === 1);
ok('clear removes it', d.clearClaim(cli, { room: 2144, item: 'purple mushrooms' }) === 1 && d.readDibs(cli).claims.length === 0);

console.log('through Session.lootFloor');
function world({ agent, me, room }) {
  let evSeq = 0, rsc = 1000;
  const events = [], names = new Map(), objects = new Map(), gets = [];
  const c = {
    selfId: 1, self: { col: 10, row: 11 }, me: { name: me }, room: { objects }, inventory: [],
    rsc: { get: id => names.get(id) ?? '' },
    get evSeq() { return evSeq; },
    roomContents() {}, requestInventory() {},
    equipment() { return { known: true, equipped: [] }; },
    async waitFor({ since = 0, kinds = [] } = {}) { return { events: events.filter(e => e.seq > since && kinds.includes(e.kind)) }; },
    get(id) { gets.push(names.get(objects.get(id)?.nameRsc)); objects.delete(id); events.push({ seq: ++evSeq, kind: 'got', id }); },
  };
  const s = new Session(agent);
  s.client = c; s.need = () => c; s.pacer = { submit: async (_k, fn) => fn() };
  s.world = { room: { num: room, name: `room ${room}` } };
  const drop = (id, name) => { const nameRsc = ++rsc; names.set(nameRsc, name); objects.set(id, { id, nameRsc, col: 10, row: 10, flags: OF.GETTABLE, amount: 1 }); };
  return { s, gets, drop };
}
writeFileSync(FILE, JSON.stringify({ claims: [{ room: 2144, item: 'purple mushroom', for: ['Bunsen', 'Beaker', 'Robin'], why: 'hold practice' }] }));
d.forgetDibs();
{
  const w = world({ agent: 't19', me: 'Rizzo', room: 2144 });
  w.drop(11, 'purple mushrooms'); w.drop(12, 'emerald');
  const r = await w.s.lootFloor({});
  ok('Rizzo\'s loot pass in 2144 leaves the claimed purple mushrooms', !w.gets.includes('purple mushrooms'), JSON.stringify(w.gets));
  ok('...takes what is not claimed', w.gets.includes('emerald'));
  ok('...and says why, naming who it is for', (r.refused ?? []).some(x => /DIBS/.test(x.why) && /Bunsen/.test(x.why)), JSON.stringify(r.refused));
  await w.s.lootFloor({ ids: [11], maxItems: 1 });
  ok('an explicit id request is the caller choosing it, and is never second-guessed', w.gets.includes('purple mushrooms'));
}
{
  const w = world({ agent: 't5', me: 'Bunsen', room: 2144 });
  w.drop(21, 'purple mushrooms');
  await w.s.lootFloor({});
  ok('Bunsen, named in the claim, picks the pile up', w.gets.includes('purple mushrooms'), JSON.stringify(w.gets));
}
{
  const w = world({ agent: 't19', me: 'Rizzo', room: 2143 });
  w.drop(31, 'purple mushroom');
  await w.s.lootFloor({});
  ok('Rizzo still loots purple mushrooms off his own kills in the farm room (2143)', w.gets.includes('purple mushroom'), JSON.stringify(w.gets));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
