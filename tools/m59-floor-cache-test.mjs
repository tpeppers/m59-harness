#!/usr/bin/env node
// THE FLOOR AROUND A CACHE, OFFLINE. tools/m59-floor-cache.mjs (floorPickup / floorDrop / the pure helpers), its dibs
// reservation (m59-dibs.mjs near-scoped and stash claims), supply's automatic floor pickup and its receiver_full overflow
// with `no_dropoff`, and the wiring in the keeper's loot ejection, the autobalancer cache, the fleetscript supply step and
// both bow paths. No socket, no roster: a fake floor world and fake sessions.
//
// Pins: exact names only (a 'wand' want never takes 'wand of healing'; 'arrows' is nerudite arrows then arrows); within
// `radius` of the HOLDER; the 7-square pickup reach (approach, or skip); every get and drop judged by the pack, never by a
// reply; the excess over `amount` dropped back and reserved; a refused drop reported and not counted; the stash reserved
// for the holder within `near.radius`, never replacing an operator claim; supply picks from the floor when the giver has
// none, drops on receiver_full by default, and does not with no_dropoff: true.
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'm59-floor-cache-test-'));
process.env.M59_FLOOR_SIGNAL_DIR = join(scratch, 'signals');
const FC = await import('./m59-floor-cache.mjs');
const D = await import('./m59-dibs.mjs');
const { supplyBetween } = await import('./m59-supply.mjs');
const { normalizeLootEject } = await import('./m59-loot-eject.mjs');
const AB = await import('./m59-reagent-autobalance.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' -- ' + detail : ''}`); }
};
const section = t => console.log('\n' + t);
const src = f => readFileSync(join(HERE, f), 'utf8');

// ---------------------------------------------------------------- a fake world with a floor
// Bodies stand on squares; the floor holds objects; a get moves a whole stack into the pack (split to what fits, as
// UserGet does); a drop puts a stack down at the dropper's square. `refuseGet` / `refuseDrop` model the server saying no.
function world({ room = 2144, bodies = {}, floor = [], free = {}, refuseGet = new Set(), refuseDrop = new Set(), approach = true } = {}) {
  const w = { room, bodies, floor: floor.map(o => ({ ...o })), free, refuseGet, refuseDrop, log: [], reserved: [], nextId: 900 };
  const body = a => w.bodies[a];
  const per = { 'nerudite arrows': 5, arrows: 4, mushrooms: 1, 'red mushrooms': 1, 'wand of healing': 10, wand: 10, herbs: 1 };
  w.io = {
    async scene(a) {
      const me = body(a);
      return { room: w.room, you: { col: me.col, row: me.row },
               objects: [...w.floor.map(o => ({ ...o, player: false })),
                         ...Object.entries(w.bodies).filter(([k]) => k !== a).map(([k, b]) => ({ id: b.id, name: b.name, col: b.col, row: b.row, player: true }))] };
    },
    async inventory(a) { return body(a).pack.map(r => ({ ...r })); },
    async get(a, id) {
      w.log.push(`get:${a}:${id}`);
      const me = body(a), i = w.floor.findIndex(o => o.id === id);
      if (i < 0 || w.refuseGet.has(id)) return { sent: true };
      const o = w.floor[i];
      if (Math.abs(o.row - me.row) + Math.abs(o.col - me.col) > 7) return { sent: true };   // too far: a sentence, nothing moves
      const room = w.free[a] == null ? Infinity : Math.floor(w.free[a] / (per[o.name] ?? 1));
      const n = Math.min(o.amount, room);
      if (n <= 0) return { sent: true };
      if (n === o.amount) w.floor.splice(i, 1); else o.amount -= n;
      if (w.free[a] != null) w.free[a] -= n * (per[o.name] ?? 1);
      const have = me.pack.find(r => r.name === o.name);
      if (have) have.amount += n; else me.pack.push({ id: w.nextId++, name: o.name, amount: n });
      return { sent: true };
    },
    async drop(a, row, n) {
      w.log.push(`drop:${a}:${row.name}:${n}`);
      const me = body(a), r = me.pack.find(x => x.id === row.id);
      if (!r || w.refuseDrop.has(row.name)) return { sent: true };
      const k = n == null ? r.amount : Math.min(n, r.amount);
      r.amount -= k; if (r.amount <= 0) me.pack.splice(me.pack.indexOf(r), 1);
      w.floor.push({ id: w.nextId++, name: r.name, amount: k, col: me.col, row: me.row });
      return { sent: true };
    },
    async capacity(a) { return w.free[a] == null ? null : { bulk: w.free[a], weight: w.free[a] }; },
    character(a) { return body(a)?.name ?? a; },
    ...(approach ? { async approach(a, sq) { w.log.push(`approach:${a}:${sq.row},${sq.col}`); const me = body(a); me.col = sq.col; me.row = sq.row; return { arrived: true }; } } : {}),
    async reserve(claim) { w.reserved.push(claim); return claim; },
    settle: async () => {},
  };
  return w;
}
const archerAndZheng = (extra = {}) => world({
  bodies: { hk2: { id: 1, name: 'Zheng He', col: 20, row: 20, pack: [{ id: 50, name: 'mushrooms', amount: 400 }] },
            t9: { id: 2, name: 'Robin', col: 22, row: 21, pack: [{ id: 60, name: 'arrows', amount: 10 }] }, ...(extra.bodies ?? {}) },
  floor: extra.floor ?? [{ id: 101, name: 'arrows', amount: 80, col: 21, row: 20 },
                         { id: 102, name: 'nerudite arrows', amount: 30, col: 19, row: 21 },
                         { id: 103, name: 'arrows', amount: 500, col: 40, row: 40 },      // far from Zheng He: not his stash
                         { id: 104, name: 'wand of healing', amount: 0, col: 20, row: 21 }],
  ...extra,
});

// ---------------------------------------------------------------- pure
section('WHAT A WANT MEANS');
ok("'arrows' is the family: nerudite arrows first, then arrows", JSON.stringify(FC.wantNames('arrows')) === JSON.stringify(['nerudite arrows', 'arrows']));
ok('a name matches exactly, plural-insensitive', FC.matchIndex('Mushrooms', ['mushroom']) === 0 && FC.matchIndex('red mushrooms', ['mushroom']) === -1);
ok('a -y name matches its -ies stack, and nothing else', FC.matchIndex('entroot berries', ['entroot berry']) === 0 && FC.matchIndex('elderberries', ['entroot berry']) === -1 && FC.matchIndex('elderberry', ['elderberries']) === 0);
ok("'wand' never matches 'wand of healing' (2026-10-13)", FC.matchIndex('wand of healing', FC.wantNames('wand')) === -1);
{
  const objs = [{ id: 1, name: 'arrows', amount: 5, col: 10, row: 10 }, { id: 2, name: 'nerudite arrows', amount: 5, col: 12, row: 12 },
                { id: 3, name: 'arrows', amount: 5, col: 30, row: 30 }, { id: 4, name: 'arrows', col: 10, row: 11, player: true }];
  const c = FC.floorCandidates({ objects: objs, want: 'arrows', near: { col: 10, row: 10 }, radius: 4 });
  ok('candidates: within radius of the holder, players never, want order first', c.map(x => x.id).join() === '2,1', JSON.stringify(c));
}
ok('unitsThatFit: the tighter of bulk and weight', FC.unitsThatFit('nerudite arrows', { bulk: 40, weight: 30 }) === 6);
ok('unitsThatFit: unweighed is null, not zero', FC.unitsThatFit('no such thing at all', { bulk: 40, weight: 30 }) === null);

section('PICKUP AROUND THE HOLDER');
{
  const w = archerAndZheng();
  const r = await FC.floorPickup(w.io, { agent: 't9', holder: 'hk2', want: 'arrows', amount: 50 });
  const robin = w.bodies.t9.pack;
  ok('nerudite arrows taken first, then plain, up to the want', r.ok && r.got === 50 && r.picked['nerudite arrows'] === 30, JSON.stringify(r));
  ok('the excess of the plain stack went back to the floor', r.returned.arrows === 60 && w.floor.some(o => o.name === 'arrows' && o.amount === 60 && o.col === 22));
  ok('verified by the pack: Robin holds 10 + 20 arrows and 30 nerudite', robin.find(x => x.name === 'arrows').amount === 30 && robin.find(x => x.name === 'nerudite arrows').amount === 30);
  ok('the far pile (not around Zheng He) is untouched', w.floor.some(o => o.id === 103 && o.amount === 500));
  ok('the wand of healing is never a candidate', !w.log.includes('get:t9:104'));
  ok('the returned excess is reserved for the holder', w.reserved.some(c => c.item === 'arrows' && c.for[0] === 'Zheng He' && c.near?.radius === 4));
}
{
  const w = archerAndZheng({ refuseGet: new Set([102]) });
  const r = await FC.floorPickup(w.io, { agent: 't9', holder: 'hk2', want: 'arrows', amount: 20 });
  ok('a get the server refuses is not counted, and the next pile is tried', r.refused.some(x => x.id === 102) && r.got === 20 && !r.picked['nerudite arrows'], JSON.stringify(r));
}
{
  const w = archerAndZheng({ free: { t9: 40 } });
  const r = await FC.floorPickup(w.io, { agent: 't9', holder: 'hk2', want: 'arrows', amount: 100 });
  ok('pack room bounds it: 40 free takes 8 nerudite, then stops on no_room', r.got === 8 && r.skipped.some(s => /no_room/.test(s.why)) && !r.ok, JSON.stringify(r));
}
{
  const w = archerAndZheng({ approach: false });
  w.bodies.t9.col = 30; w.bodies.t9.row = 30;
  const r = await FC.floorPickup(w.io, { agent: 't9', holder: 'hk2', want: 'arrows', amount: 10 });
  ok('beyond the 7-square reach with no approach: skipped too_far, nothing got', r.got === 0 && r.skipped.every(s => /too_far/.test(s.why)) && r.skipped.length === 2);
}
{
  const w = archerAndZheng();
  w.bodies.t9.col = 30; w.bodies.t9.row = 30;
  const r = await FC.floorPickup(w.io, { agent: 't9', holder: 'hk2', want: 'arrows', amount: 10 });
  ok('beyond reach with an approach: walks to the pile, then gets it', r.got === 10 && w.log.some(l => l.startsWith('approach:t9')));
}
{
  const w = archerAndZheng();
  delete w.bodies.hk2;
  const r = await FC.floorPickup(w.io, { agent: 't9', holder: 'hk2', want: 'arrows', amount: 10 });
  ok('holder not in the room: nothing picked, says why', r.got === 0 && /not visible/.test(r.why));
}
{
  const w = archerAndZheng({ floor: [] });
  const r = await FC.floorPickup(w.io, { agent: 't9', holder: 'hk2', want: 'arrows', amount: 10 });
  ok('an empty floor is a clean no', !r.ok && r.got === 0 && /nothing matching/.test(r.why));
}

section('DROP-OFF AT THE HOLDER\'S FEET');
{
  const w = world({ bodies: { hk2: { id: 1, name: 'Zheng He', col: 20, row: 20, pack: [] },
                              t1: { id: 3, name: 'Piggy', col: 21, row: 20, pack: [{ id: 70, name: 'mushrooms', amount: 50 }, { id: 71, name: 'herbs', amount: 9 }] } } });
  const r = await FC.floorDrop(w.io, { agent: 't1', holder: 'hk2', items: [{ name: 'mushrooms', amount: 30 }, { name: 'herbs', amount: 9 }] });
  ok('drops exactly what was asked, verified by the pack', r.ok && r.dropped.mushrooms === 30 && r.dropped.herbs === 9 && w.bodies.t1.pack.find(x => x.name === 'mushrooms').amount === 20);
  ok('the piles lie at the giver\'s square beside the holder', w.floor.filter(o => o.col === 21 && o.row === 20).length === 2);
  ok('each pile reserved for the holder, near its square', r.reserved.length === 2 && w.reserved.every(c => c.for[0] === 'Zheng He' && c.near.row === 20 && c.near.col === 20 && c.source === 'floor-cache'));
}
{
  const w = world({ bodies: { hk2: { id: 1, name: 'Zheng He', col: 20, row: 20, pack: [] },
                              t1: { id: 3, name: 'Piggy', col: 21, row: 20, pack: [{ id: 70, name: 'mushrooms', amount: 50 }] } },
                    refuseDrop: new Set(['mushrooms']) });
  const r = await FC.floorDrop(w.io, { agent: 't1', holder: 'hk2', items: [{ name: 'mushrooms', amount: 30 }] });
  ok('a drop the server refuses is reported, never counted, never reserved', !r.ok && r.total === 0 && r.refused[0]?.why.includes('refused') && w.reserved.length === 0);
}
{
  const w = world({ approach: false, bodies: { hk2: { id: 1, name: 'Zheng He', col: 20, row: 20, pack: [] },
                              t1: { id: 3, name: 'Piggy', col: 40, row: 40, pack: [{ id: 70, name: 'mushrooms', amount: 50 }] } } });
  const r = await FC.floorDrop(w.io, { agent: 't1', holder: 'hk2', items: [{ name: 'mushrooms', amount: 30 }] });
  ok('too far from the holder and no approach: nothing is dropped (no littering elsewhere)', r.total === 0 && w.floor.length === 0 && /could not stand within/.test(r.why));
}

{
  // 2026-11-05 22:54Z: Zheng He (a cache) was walked ~30 squares to an archer's feet by a hand-over's overflow.
  const w = world({ bodies: { hk2: { id: 1, name: 'Zheng He', col: 20, row: 20, pack: [] },
                              t1: { id: 3, name: 'Piggy', col: 40, row: 40, pack: [{ id: 70, name: 'mushrooms', amount: 50 }] } } });
  const r = await FC.floorDrop(w.io, { agent: 't1', holder: 'hk2', items: [{ name: 'mushrooms', amount: 30 }], walk: false });
  ok('walk:false never walks the giver, even with an approach: nothing dropped far away', r.total === 0 && !w.log.some(l => l.startsWith('approach:')) && w.floor.length === 0);
}

section('DIBS: THE STASH IS THE CACHE\'S');
{
  const near = { row: 20, col: 20, radius: 4 };
  const book = D.normalizeBook({ claims: [
    { room: 2144, item: 'purple mushroom', for: ['Bunsen'] },
    { room: 2144, item: 'purple mushroom', for: ['Zheng He'], near, source: 'floor-cache' },
    { room: 2144, item: 'arrows', for: ['Zheng He'], near, source: 'floor-cache' } ] });
  ok('a stash claim covers its squares: another farmer leaves it', !D.dibsVerdict({ book, room: 2144, item: 'arrows', character: 'Rizzo', at: { row: 21, col: 21 } }).allowed);
  ok('outside the stash radius the same item is anybody\'s', D.dibsVerdict({ book, room: 2144, item: 'arrows', character: 'Rizzo', at: { row: 40, col: 40 } }).allowed);
  ok('the holder may sweep its own stash', D.dibsVerdict({ book, room: 2144, item: 'arrows', character: 'Zheng He', at: { row: 21, col: 21 } }).allowed);
  ok('two claims on one item: the operator\'s still lets Bunsen take it', D.dibsVerdict({ book, room: 2144, item: 'purple mushrooms', character: 'Bunsen', at: { row: 20, col: 21 } }).allowed);
  ok('... and the stash lets Zheng He take it', D.dibsVerdict({ book, room: 2144, item: 'purple mushrooms', character: 'Zheng He', at: { row: 20, col: 21 } }).allowed);
  ok('... and anybody else leaves it', !D.dibsVerdict({ book, room: 2144, item: 'purple mushrooms', character: 'Rizzo', at: { row: 20, col: 21 } }).allowed);
  const { keep, left } = D.dibsFilter([{ id: 1, name: 'arrows', row: 21, col: 20 }, { id: 2, name: 'arrows', row: 50, col: 50 }], { book, room: 2144, character: 'Rizzo' });
  ok('dibsFilter reads each object\'s square', keep.map(o => o.id).join() === '2' && left.length === 1);
  ok('a malformed near is reported, not guessed', (() => { const p = []; D.normalizeBook({ claims: [{ room: 1, item: 'x', for: ['a'], near: { row: 'q' } }] }, p); return p.length === 1; })());
}
{
  const file = join(scratch, 'dibs-test.json');
  D.setClaim(file, { room: 2144, item: 'purple mushroom', forWho: ['Bunsen', 'Beaker'], by: 'operator' });
  const c = FC.stashClaim({ room: 2144, item: 'purple mushrooms', holder: 'Zheng He', near: { row: 20, col: 20 }, now: Date.now() });
  D.addStashClaim(file, c);
  D.addStashClaim(file, { ...c, until: new Date(Date.now() + 3600_000).toISOString() });
  D.addStashClaim(file, { ...FC.stashClaim({ room: 2144, item: 'arrows', holder: 'Zheng He', near: { row: 20, col: 20 } }), until: new Date(Date.now() - 1000).toISOString() });
  let raw = JSON.parse(readFileSync(file, 'utf8'));
  ok('a stash claim sits BESIDE the operator\'s claim on the same item', raw.claims.length === 3 && raw.claims.some(x => !x.source && x.for.includes('Bunsen')));
  ok('a second drop at the same cache refreshes its claim instead of adding one', raw.claims.filter(x => x.source === 'floor-cache' && /purple/.test(x.item)).length === 1);
  D.addStashClaim(file, FC.stashClaim({ room: 2144, item: 'herbs', holder: 'Zheng He', near: { row: 20, col: 20 } }));
  raw = JSON.parse(readFileSync(file, 'utf8'));
  ok('spent stash claims are pruned on the next write', !raw.claims.some(x => x.item === 'arrows'));
  D.setClaim(file, { room: 2144, item: 'purple mushroom', forWho: ['Robin'], by: 'operator' });
  raw = JSON.parse(readFileSync(file, 'utf8'));
  ok('an operator re-claim replaces the operator claim and leaves the stash claim', raw.claims.filter(x => /purple/.test(x.item)).length === 2 && raw.claims.some(x => x.for.includes('Robin')) && raw.claims.some(x => x.source === 'floor-cache' && /purple/.test(x.item)));
}

// ---------------------------------------------------------------- supply
section('SUPPLY: FLOOR PICKUP WHEN THE GIVER HAS NONE; OVERFLOW ON receiver_full UNLESS no_dropoff');
const PLAYER = 0x0004;
function fakeSession(name, { character, room = 2144, items = [], others = [] } = {}) {
  const s = { items: items.map(o => ({ ...o })), log: [], said: [], held: null, willSeeOffer: true };
  const client = () => ({ me: { name: character }, rsc: { get: k => (typeof k === 'string' && k.length ? k : null) },
    inventory: s.items.map(o => ({ id: o.id, nameRsc: o.name, amount: o.amount ?? 0, flags: 0 })),
    waitFor: async () => ({ events: [], timedOut: true }), requestInventory: () => null, idGenerations: [], idsAsOf: () => null,
    equipment: () => ({ known: true, equipped: [] }) });
  return { name, _fake: s, get world() { return { room: { num: room } }; },
    pacer: { submit: async (k, fn) => (fn ? fn() : null) }, need: client,
    async roomContents() { return { room, answered: true, objects: others.map(o => ({ id: o.id, name: o.name, flags: PLAYER })) }; },
    async holdStill(why, ms, token) { if (s.held && token === s.held) return { held: true, renewed: true, hold: { token } }; s.held = `t-${name}`; return { held: true, hold: { token: s.held } }; },
    async releaseHold() { s.held = null; return { released: true }; },
    async tradeStep(op) {
      s.log.push(op);
      if (op === 'seq') return { seq: 0 };
      if (op === 'said') return { said: s.said };
      if (op === 'await_offer') return { saw: s.willSeeOffer };
      if (op === 'await_countered') return { saw: true, trade: { may_accept: true } };
      return { sent: true };
    } };
}
const supplyPair = () => {
  const giver = fakeSession('hk2', { character: 'Zheng He', items: [{ id: 50, name: 'mushrooms', amount: 400 }], others: [{ id: 2, name: 'Robin' }] });
  const recv = fakeSession('t9', { character: 'Robin', items: [], others: [{ id: 1, name: 'Zheng He' }] });
  return { giver, recv };
};
const sdeps = (map, floorIo) => ({ session: n => map[n], isProxied: () => true, autopilotIfAny: () => undefined, floorIo });
{
  const { giver, recv } = supplyPair();
  const w = archerAndZheng();
  const out = await supplyBetween({ from: 'hk2', to: 't9', what: 'arrows', amount: 40, stationary: true, who_travels: 'neither' }, sdeps({ hk2: giver, t9: recv }, w.io));
  ok('Zheng He holds no arrows: Robin gets them off the floor around him (automatic)', out.supplied === true && out.from_floor === true && out.floor.got === 40, JSON.stringify(out).slice(0, 300));
  ok('... and no trade was attempted', !giver._fake.log.includes('offer'));
}
{
  const { giver, recv } = supplyPair();
  const out = await supplyBetween({ from: 'hk2', to: 't9', what: 'arrows', amount: 40, stationary: true, who_travels: 'neither' }, sdeps({ hk2: giver, t9: recv }, null));
  ok('without a floor io the old answer stands: carrying nothing matching', out.supplied === false && /carrying nothing matching/.test(out.reason));
}
// The overflow: Piggy -> Zheng He, the server says Zheng He cannot carry it.
const overflowCase = async (extra, said = ["Zheng He can't carry all the items you have offered."]) => {
  const giver = fakeSession('t1', { character: 'Piggy', items: [{ id: 70, name: 'mushrooms', amount: 50 }], others: [{ id: 1, name: 'Zheng He' }] });
  const recv = fakeSession('hk2', { character: 'Zheng He', items: [], others: [{ id: 3, name: 'Piggy' }] });
  giver._fake.said = said;
  recv._fake.willSeeOffer = false;
  const w = world({ bodies: { hk2: { id: 1, name: 'Zheng He', col: 20, row: 20, pack: [] },
                              t1: { id: 3, name: 'Piggy', col: 21, row: 20, pack: [{ id: 70, name: 'mushrooms', amount: 50 }] } } });
  const out = await supplyBetween({ from: 't1', to: 'hk2', what: 'mushrooms', amount: 30, stationary: true, who_travels: 'neither', ...extra },
                                  sdeps({ t1: giver, hk2: recv }, w.io));
  return { out, w };
};
{
  const { out, w } = await overflowCase({});
  ok('receiver_full: the remainder is dropped at Zheng He\'s feet BY DEFAULT', out.reason_code === 'receiver_full' && out.to_floor?.dropped?.mushrooms === 30 && out.to_receiver === 0, JSON.stringify(out).slice(0, 400));
  ok('... verified on the giver\'s pack, and reserved for Zheng He', w.bodies.t1.pack[0].amount === 20 && w.reserved[0]?.for[0] === 'Zheng He');
  ok('... and the delivery still reads unsupplied (the receiver got none)', out.supplied === false);
}
{
  const { out, w } = await overflowCase({ no_dropoff: true });
  ok('no_dropoff: true -- nothing dropped, the goods stay with the giver', out.reason_code === 'receiver_full' && !out.to_floor && w.floor.length === 0 && w.bodies.t1.pack[0].amount === 50);
}

section('AFFIRMATIVE ONLY: EVERY OTHER REFUSAL IN supply DROPS NOTHING');
for (const [kind, line] of [
  ['item_refuses_to_leave (a cursed item)', "The sword doesn't seem to want to be given away."],
  ['giver_no_longer_has_it', "Zheng He didn't have everything offered."],
  ['counterparty_busy', "Zheng He can't deal with you now."],
  ['counterparty_left', 'Zheng He is no longer here.'],
  ['counterparty_offline', 'Zheng He is not online to accept.'],
  ['amount_refused', "You can't offer that many."],
  ['a silent wire (no sentence at all)', null],
]) {
  const { out, w } = await overflowCase({}, line ? [line] : []);
  ok(`supply refusal "${kind}": nothing dropped, goods stay with the giver`, !out.to_floor && w.floor.length === 0 && w.bodies.t1.pack[0].amount === 50 && w.reserved.length === 0,
     JSON.stringify(out).slice(0, 200));
}

section('AFFIRMATIVE ONLY: LOOT EJECTION NEEDS "WILLING" AND "FULL"');
{
  const V = FC.overflowVerdict, now = Date.now(), since = now - 2000;
  const willing = { receiver: 'Zheng He', at: now, trade_goods: { from: null, keep_free: 0.25 } };
  const cap = { kind: 'capacity', why: 'would fill to 92%', after: 0.92, at: now - 500 };
  ok('willing + the receiver refused for space: drop', V({ accepts: willing, refusal: cap, giver: 'Piggy', since, now }).drop);
  ok('willing + the server said it cannot carry it: drop', V({ accepts: willing, said: ["Zheng He can't carry all the items you have offered."], giver: 'Piggy', since, now }).drop);
  ok('no accepts record (not configured, or never published): no drop', !V({ accepts: null, refusal: cap, giver: 'Piggy', since, now }).drop);
  ok('accepts record stale (> 5 min): no drop', !V({ accepts: { ...willing, at: now - 6 * 60_000 }, refusal: cap, giver: 'Piggy', since, now }).drop);
  ok('receiver does not take trade goods at all: no drop, even when "full"', !V({ accepts: { ...willing, trade_goods: null }, refusal: cap, said: ["Zheng He can't carry all the items you have offered."], giver: 'Piggy', since, now }).drop);
  ok('trade goods only from others: no drop', !V({ accepts: { ...willing, trade_goods: { from: ['beaker'], keep_free: 0.25 } }, refusal: cap, giver: 'Piggy', since, now }).drop);
  ok('... but from-list naming this giver: drop', V({ accepts: { ...willing, trade_goods: { from: ['piggy'], keep_free: 0.25 } }, refusal: cap, giver: 'Piggy', since, now }).drop);
  for (const kind of ['not_accepting', 'unweighed'])
    ok(`willing but refused as "${kind}": no drop`, !V({ accepts: willing, refusal: { kind, why: 'x', at: now - 500 }, giver: 'Piggy', since, now }).drop);
  ok('a capacity refusal of an EARLIER offer does not count for this one', !V({ accepts: willing, refusal: { ...cap, at: since - 10_000 }, giver: 'Piggy', since, now }).drop);
  ok('willing, no counter, nothing said, no record: no drop (silence is not "full")', !V({ accepts: willing, refusal: null, said: [], giver: 'Piggy', since, now }).drop);
  ok('other sentences (busy, left, cursed) are not "full"', !V({ accepts: willing, said: ["Zheng He can't deal with you now.", 'Zheng He is no longer here.'], giver: 'Piggy', since, now }).drop);
  // the files: what the receiver publishes is what the giver reads
  const dir = join(scratch, 'sig');
  FC.publishAccepts('Zheng He', { from: null, keep_free: 0.25 }, { dir });
  FC.noteRefusal('Zheng He', 'Piggy', { kind: 'capacity', why: 'would fill to 92%', after: 0.92 }, { dir });
  FC.noteRefusal('Zheng He', 'Rizzo', { kind: 'not_accepting', why: 'not on the take list' }, { dir });
  ok('published records round-trip: Piggy (capacity) may drop', V({ accepts: FC.readAccepts('Zheng He', { dir }), refusal: FC.readRefusal('Zheng He', 'Piggy', { dir }), giver: 'Piggy', since }).drop);
  ok('... Rizzo (not on the take list) may not', !V({ accepts: FC.readAccepts('Zheng He', { dir }), refusal: FC.readRefusal('Zheng He', 'Rizzo', { dir }), giver: 'Rizzo', since }).drop);
  FC.publishAccepts('Zheng He', null, { dir });
  ok('a receiver that stops taking trade goods says so: no drop', !V({ accepts: FC.readAccepts('Zheng He', { dir }), refusal: FC.readRefusal('Zheng He', 'Piggy', { dir }), giver: 'Piggy', since }).drop);
  const so = src('autopilot/social.mjs');
  ok('receiver: publishes its trade_goods every 30 s from acceptDonations', /publishAccepts\(meName, tg\)/.test(so));
  ok('receiver: only a weighed over-full trade-goods refusal is kind capacity; unweighed is not',
     /refuse\(`no room for trade goods: \$\{fit\.why\}`, fit\.after != null \? 'capacity' : 'unweighed'/.test(so));
  ok('receiver: every other refusal defaults to not_accepting, recorded before the cancel',
     /const refuse = async \(why, kind = 'not_accepting', after = null\) => \{[\s\S]{0,400}noteRefusal\(meName, t\.withName[\s\S]{0,400}cancelOffer/.test(so));
  const dl = src('autopilot/delivery.mjs');
  ok('giver: drops only on overflowVerdict(accepts, refusal, said) and never with no_dropoff',
     /cfg\.no_dropoff \? \{ drop: false[\s\S]{0,300}overflowVerdict\(\{ accepts: readAccepts\(target\), refusal: readRefusal\(target/.test(dl) && /if \(verdict\.drop\) \{\s*const d = await this\.floorDropOff/.test(dl));
  ok('giver: giveItems reports what the server said and when the offer went out', /return \{ moved: \[\], offeredAt, said: await heard\(\)/.test(dl));
}

// ---------------------------------------------------------------- wiring
section('THE PATHS THAT USE IT');
{
  ok('lootEject accepts no_dropoff (and refuses a non-boolean)', normalizeLootEject({ to: ['Zheng He'], no_dropoff: true }).no_dropoff === true &&
     normalizeLootEject({ to: ['Zheng He'] }).no_dropoff === false && (() => { try { normalizeLootEject({ to: ['x'], no_dropoff: 'yes' }); return false; } catch { return true; } })());
  const dl = src('autopilot/delivery.mjs');
  ok('ejectLoot: a refused batch goes to the floor only on the affirmative verdict', /if \(verdict\.drop\) \{\s*const d = await this\.floorDropOff\(target/.test(dl));
  ok('floorDropOff reserves in the fleet\'s dibs book', /async floorDropOff\([\s\S]{0,300}addStashClaim\(dibsFile\(\), claim\)/.test(dl));
  const book = { loops: { Scooter: { mode: 'practice', practice: ['haste'], cache: { agent: 'hk3', room: 27, no_dropoff: true } },
                          Rizzo: { mode: 'practice', practice: ['haste'], cache: { agent: 'hk3', room: 27 } } } };
  const s1 = AB.loopFor(book, { character: 'Scooter' }).loop, s2 = AB.loopFor(book, { character: 'Rizzo' }).loop;
  ok('autobalance cache.no_dropoff: true is kept, absent is false (drop-off on)', s1?.cache?.no_dropoff === true && s2?.cache?.no_dropoff === false, JSON.stringify([s1?.cache, s2?.cache]));
  const ab = src('m59-autobalance.mjs');
  ok('autobalance cache hand-over passes no_dropoff to supply', /what, amount, stationary: true, who_travels: 'neither',\s*\.\.\.\(loop\.cache\.no_dropoff \? \{ no_dropoff: true \} : \{\}\)/.test(ab));
  ok('autobalance cache restock picks up around the cache before buying', /'floor_cache', \{ action: 'pickup', agent, near: loop\.cache\.agent/.test(ab) && ab.indexOf("'floor_cache'") < ab.indexOf('RESTOCK IN THE CACHE ROOM'));
  const fs = src('m59-fleetscript.mjs');
  ok('fleetscript supply step: floor pickup for the shortfall, no_dropoff passed through', /call\('floor_cache', \{ action: 'pickup', agent: step\.to, near: step\.from/.test(fs) && /step\.no_dropoff === true/.test(fs));
  ok('practice-bow: arrows off the floor around each giver here', /call\('floor_cache', \{ action: 'pickup', agent, near: g, what: 'arrows'/.test(src('fleetscripts/practice-bow.mjs')));
  ok('bow-supply: arrows off the floor around a donor in the room', /ctx\.call\('floor_cache',\{action:'pickup',agent:ctx\.agent,near:donor,what:'arrows'/.test(src('m59-bow-supply.mjs')));
  const br = src('m59-broker.mjs');
  ok('broker: floor_cache tool (pickup/drop/scan) and supply\'s no_dropoff in the schema',
     /name: 'floor_cache'[\s\S]{0,4000}floorPickup\(floorIo[\s\S]{0,600}a\.no_dropoff === true[\s\S]{0,300}floorDrop\(floorIo/.test(br) && /no_dropoff: \{ type: 'boolean',\s*description: 'FLOOR OVERFLOW OFF/.test(br));
  ok('broker: supply deps carry the floor io, reserving in this fleet\'s dibs book', /floorIo,\s*\};/.test(br) && /addStashClaim\(dibsBookFile\(FLEET \|\| undefined\), claim\)/.test(br));
  ok('lootFloor still applies dibs to sweeps only (explicit ids bypass it)', /if \(!ids\?\.length && cands\.length\) \{\s*const book = readDibs\(dibsFile\(\)\)/.test(src('m59-game.mjs')));
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
