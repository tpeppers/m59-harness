#!/usr/bin/env node
// FLOOR GEAR IS TAKEN ONLY WHEN A LOOK SAYS IT IS NOT BROKEN — offline, no socket, no roster.
//
//   node tools/m59-loot-sound-gear-test.mjs
//
// Operator, 2026-10-31: "only pick up affirmatively non-broken". A broken longbow looks identical
// on the floor, an archer carrying one cannot shoot, and that day the fleet kept finding them in
// its packs for the Avar coordinator to hunt down and drop. `lootFloor` used to take a weapon- or
// armour-shaped item whose look came back empty ("UNKNOWN is taken, not skipped"), and took
// EVERYTHING when the inspection threw. What this pins, through the REAL Session.lootFloor and
// the real skills.inspectForBroken against a fake client:
//   * a bow whose look reads sound is taken;
//   * a bow whose look reads broken is left, refused as BROKEN;
//   * a bow whose look stays empty after the retry is left, refused as UNCONFIRMED (not BROKEN);
//   * an inspection that throws takes none of the weapon/armour candidates, and still takes the
//     arrows and the shillings, which are never asked about;
//   * an explicit `ids` request with explicitIdsOverride still takes the item, unlooked at;
//   * `explicitIdsOverride: false` holds an id list to the same rule.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'm59-loot-sound-gear-test-'));
process.env.M59_LEDGER_DIR = join(dir, 'ledger');

const { Session } = await import('./m59-game.mjs');
const { OF } = await import('./m59-parse.mjs');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || !detail ? '' : `  -- ${detail}`}`);
};

const SOUND = 'This longbow is well worn and could use some repair.';
const BROKEN = 'Expertly carved for flexibility and range, this bow gives you the envious advantage of ' +
               'a long ranged attack.\r\n\r\nThis longbow is broken and in pieces.';
const RUINED = 'This leather armor is useless.';

// `looks` maps an id to the description its look returns; an id absent from it answers nothing,
// on every attempt, which is what an empty look after inspectForBroken's one retry looks like.
function world(floor, { looks = {}, lookThrows = false } = {}) {
  let seq = 0;
  const events = [], names = new Map(), objects = new Map(), gets = [], looked = [];
  let rsc = 1000;
  for (const f of floor) {
    const nameRsc = ++rsc;
    names.set(nameRsc, f.name);
    objects.set(f.id, { id: f.id, nameRsc, col: 10, row: 10, flags: OF.GETTABLE, amount: f.amount ?? 1 });
  }
  const c = {
    selfId: 1, self: { col: 10, row: 11 }, room: { objects }, inventory: [],
    rsc: { get: id => names.get(id) ?? '' },
    get evSeq() { return seq; },
    roomContents() {}, requestInventory() {},
    equipment() { return { known: true, equipped: [] }; },
    async waitFor({ since = 0, kinds = [] } = {}) {
      return { events: events.filter(e => e.seq > since && kinds.includes(e.kind)) };
    },
    look(id) {
      looked.push(id);
      if (lookThrows) throw new Error('socket closed mid-look');
      if (looks[id] != null) events.push({ seq: ++seq, kind: 'look', id, description: looks[id] });
    },
    get(id) {
      const o = objects.get(id);
      gets.push(names.get(o?.nameRsc));
      objects.delete(id);
      if (o) c.inventory.push(o);
      events.push({ seq: ++seq, kind: 'got', id });
    },
  };
  const s = new Session('t1');
  s.client = c;
  s.need = () => c;
  s.pacer = { submit: async (_k, fn) => fn() };
  s.world = { room: { num: 2154, name: 'Avar Village' } };
  return { s, c, gets, looked };
}
const refusedAs = (r, item, re) => (r.refused ?? []).some(x => x.item === item && re.test(x.why ?? ''));

console.log('a sound bow is taken');
{
  const w = world([{ id: 11, name: 'longbow' }], { looks: { 11: SOUND } });
  const r = await w.s.lootFloor({});
  ok('the longbow a look reads as sound is picked up', w.gets.includes('longbow'), JSON.stringify(w.gets));
  ok('...after a look at its own id', w.looked.includes(11), JSON.stringify(w.looked));
  ok('...and nothing is refused', (r.refused ?? []).length === 0, JSON.stringify(r.refused));
}

console.log('a broken bow is left');
{
  const w = world([{ id: 11, name: 'longbow' }], { looks: { 11: BROKEN } });
  const r = await w.s.lootFloor({});
  ok('the longbow a look reads as broken stays on the floor', !w.gets.includes('longbow'), JSON.stringify(w.gets));
  ok('...refused as BROKEN', refusedAs(r, 'longbow', /^BROKEN/), JSON.stringify(r.refused));
  ok('...and not as UNCONFIRMED', !refusedAs(r, 'longbow', /^UNCONFIRMED/));
}

console.log('an unknown (empty look) bow is left');
{
  const w = world([{ id: 11, name: 'longbow' }, { id: 12, name: 'arrow', amount: 40 }]);
  const r = await w.s.lootFloor({});
  ok('the longbow whose look stays empty stays on the floor', !w.gets.includes('longbow'), JSON.stringify(w.gets));
  ok('...after the look AND its one retry', w.looked.filter(id => id === 11).length === 2, JSON.stringify(w.looked));
  ok('...refused as UNCONFIRMED, so the log tells it from a broken one',
     refusedAs(r, 'longbow', /^UNCONFIRMED/) && !refusedAs(r, 'longbow', /^BROKEN/), JSON.stringify(r.refused));
  ok('...and it is still on the floor to be looked at again next sweep', w.c.room.objects.has(11));
  ok('the arrows beside it are taken, never looked at',
     w.gets.includes('arrow') && !w.looked.includes(12), JSON.stringify({ gets: w.gets, looked: w.looked }));
}

console.log('armour follows the same rule');
{
  const w = world([{ id: 21, name: 'leather armor' }, { id: 22, name: 'gold round shield' }, { id: 23, name: 'circlet' }],
                  { looks: { 21: RUINED, 22: 'A sturdy gold round shield.' } });
  const r = await w.s.lootFloor({});
  ok('a sound shield is taken', w.gets.includes('gold round shield'), JSON.stringify(w.gets));
  ok('ruined armour is left as BROKEN', !w.gets.includes('leather armor') && refusedAs(r, 'leather armor', /^BROKEN/),
     JSON.stringify(r.refused));
  ok('an unlooked circlet is left as UNCONFIRMED', !w.gets.includes('circlet') && refusedAs(r, 'circlet', /^UNCONFIRMED/),
     JSON.stringify(r.refused));
}

console.log('an inspection that throws takes none of the gear');
{
  const w = world([{ id: 11, name: 'longbow' }, { id: 13, name: 'mace' }, { id: 14, name: 'leather armor' },
                   { id: 12, name: 'arrow', amount: 40 }, { id: 15, name: 'shilling', amount: 120 }],
                  { lookThrows: true });
  const r = await w.s.lootFloor({});
  ok('no weapon or armour candidate is picked up',
     !['longbow', 'mace', 'leather armor'].some(n => w.gets.includes(n)), JSON.stringify(w.gets));
  ok('...each is refused as UNCONFIRMED, not BROKEN',
     ['longbow', 'mace', 'leather armor'].every(n => refusedAs(r, n, /^UNCONFIRMED/) && !refusedAs(r, n, /^BROKEN/)),
     JSON.stringify(r.refused));
  ok('the arrows and the shillings are still taken',
     w.gets.includes('arrow') && w.gets.includes('shilling'), JSON.stringify(w.gets));
}

console.log('an explicit id request is the caller naming the item');
{
  const w = world([{ id: 11, name: 'longbow' }]);
  await w.s.lootFloor({ ids: [11], maxItems: 1 });
  ok('an explicit id (explicitIdsOverride, the default) takes the unlooked bow',
     w.gets.includes('longbow'), JSON.stringify(w.gets));
  ok('...without asking the server about it', w.looked.length === 0, JSON.stringify(w.looked));
  const b = world([{ id: 11, name: 'longbow' }], { looks: { 11: BROKEN } });
  await b.s.lootFloor({ ids: [11], maxItems: 1 });
  ok('...even one that would read broken: the caller overrides on purpose', b.gets.includes('longbow'));
  const h = world([{ id: 11, name: 'longbow' }, { id: 12, name: 'arrow', amount: 5 }]);
  const r = await h.s.lootFloor({ ids: [11, 12], maxItems: 2, explicitIdsOverride: false });
  ok('explicitIdsOverride:false holds an id list to the rule: the unconfirmed bow is left, the arrows taken',
     !h.gets.includes('longbow') && h.gets.includes('arrow') && refusedAs(r, 'longbow', /^UNCONFIRMED/),
     JSON.stringify({ gets: h.gets, refused: r.refused }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
