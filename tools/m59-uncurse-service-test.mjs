// OFFLINE. The non-chalice remove-curse desk and the amulet re-wear (m59-uncurse-service.mjs; operator, 2026-11-13: Pepe
// and Sweetums as remove-curse desks for the Great Ocean farmers, each wearing an Amulet of Shadows to practise on).
// Pins: the desk record is published `ok` only while the body can cast (room, spell, karma, mana, an emerald over its
// floor) and says so at once when it cannot; a fresh record from a NON-holder opens the farmers' 'desk' gate; the board's
// two spellings (`uncurse`, `remove curse`) are one service; the desk casts on a requester standing here and closes the
// request; a farmer asks only for a curse it did not choose and only with a desk in its room; the amulet goes back on
// after a remove curse took it off; and a remove-curse practice cast on self is chosen only while something cursed is worn.
//
// `node tools/m59-uncurse-service-test.mjs`
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const dir = mkdtempSync(join(tmpdir(), 'm59-uncurse-'));
process.env.M59_REQUESTS_FILE = join(dir, 'requests.jsonl');
import { normalizeUncurseDesk, readUncurseDesk, normalizeRewearCursed, uncurseDeskMenu, uncurseCustomers,
         shouldAskUncurse, rewearDue } from './m59-uncurse-service.mjs';
import { serviceKey, postRequest, openRequests, board } from './rpg/requests.mjs';
import { unrevealedWeaponGate } from './m59-unrevealed-weapons.mjs';
import { choosePractice, normalizePractice } from './m59-deskpractice.mjs';
import { OF } from './m59-parse.mjs';
const { Autopilot, HANDLED, CONTINUE } = await import('./m59-autopilot.mjs');

let pass = 0, fail = 0;
const ok = (c, what) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${what}`); } };
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`);
const throws = (fn, re, what) => { let m = null; try { fn(); } catch (e) { m = e.message; } ok(m && re.test(m), `${what} (threw ${m})`); };
const section = s => console.log(`\n${s}`);

section('the policy');
{
  eq(normalizeUncurseDesk(null), null, 'null is off');
  eq(normalizeUncurseDesk({ enabled: false, room: 552 }), null, 'enabled false is off');
  eq(normalizeUncurseDesk({ enabled: true, room: 552 }), { enabled: true, room: 552, reserve: 0, cooldown_ms: 60_000 }, 'defaults');
  throws(() => normalizeUncurseDesk({ enabled: true, room: 'ocean' }), /room/, 'a room must be a number');
  throws(() => normalizeUncurseDesk({ enabled: true, rooms: [552] }), /unknown key/, 'an unknown key is refused, not dropped');
  ok(readUncurseDesk({ enabled: 'yes' }).cfg === null && /ignored/.test(readUncurseDesk({ enabled: 'yes' }).problem),
     'the keeper reports a bad value and stays off');
  eq(normalizeRewearCursed(['Amulet of Shadows', 'amulet of shadows']), ['amulet of shadows'], 'names are lower-cased and de-duplicated');
  throws(() => normalizeRewearCursed(['ring of lethargy']), /curse cycle/, 'a ring is the curse cycle\'s to drop, never re-worn');
  eq(normalizeRewearCursed([]), null, 'an empty list is none');
}

section('the menu: ok only when it can cast here');
{
  const cfg = normalizeUncurseDesk({ enabled: true, room: 552, reserve: 1 });
  const able = { here: 552, knows: true, karma: 40, mana: 20, emeralds: 5, floor: 2 };
  const m = uncurseDeskMenu(cfg, able);
  ok(m.able && m.menu.length === 1 && m.menu[0].kind === 'uncurse' && m.menu[0].ok === true, 'able: one uncurse line, ok');
  eq(uncurseDeskMenu(cfg, { ...able, here: 38 }).why, 'not in room 552', 'not in its room');
  eq(uncurseDeskMenu(cfg, { ...able, knows: false }).why, 'does not know remove curse', 'without the spell');
  eq(uncurseDeskMenu(cfg, { ...able, karma: 19 }).why, 'karma 19 below 20', 'below +20 karma');
  eq(uncurseDeskMenu(cfg, { ...able, karma: null }).why, 'karma unknown', 'karma unread shuts it');
  eq(uncurseDeskMenu(cfg, { ...able, mana: 8 }).why, 'Req. mana', 'under 9 mana');
  eq(uncurseDeskMenu(cfg, { ...able, emeralds: 3 }).why, 'Req. reagents', 'every emerald kept back (floor 2 + reserve 1)');
  ok(uncurseDeskMenu(cfg, { ...able, emeralds: 4 }).able, 'one over the floor and reserve is enough');
  ok(uncurseDeskMenu({ ...cfg, room: null }, { ...able, here: 999 }).able, 'a desk with no room serves wherever it stands');
}

section('a fresh record from a non-holder opens the farmers\' desk gate');
{
  const NOW = 1_800_000_000_000;
  const cfg = normalizeUncurseDesk({ enabled: true, room: 552 });
  const rec = m => ({ pepe: { server: 'Pepe', menu: m.menu, room: 552, fol_room: null, at: NOW - 30_000 } });
  const open = unrevealedWeaponGate('desk', { desks: rec(uncurseDeskMenu(cfg, { here: 552, knows: true, karma: 40, mana: 20, emeralds: 3 })),
                                              now: NOW, rooms: [552] });
  ok(open.allow === true && open.desk?.name === 'Pepe' && open.desk.room === 552, 'the gate opens on Pepe\'s record in 552');
  const shut = unrevealedWeaponGate('desk', { desks: rec(uncurseDeskMenu(cfg, { here: 552, knows: true, karma: 40, mana: 2, emeralds: 3 })),
                                              now: NOW, rooms: [552] });
  ok(shut.allow === false, 'and stays shut while the same desk says it cannot cast');
}

section('one service, two spellings');
{
  eq([serviceKey('uncurse'), serviceKey('Remove Curse'), serviceKey('remcurse'), serviceKey('purge')],
     ['uncurse', 'uncurse', 'uncurse', 'purge'], 'the aliases');
  postRequest({ service: 'remove curse', target: 'Echo', now: 1000, ttl_ms: 60_000 });
  postRequest({ service: 'uncurse', target: 't4', character: 'Floyd', now: 1100, ttl_ms: 60_000 });
  eq(openRequests({ service: 'uncurse', now: 2000 }).length, 2, 'a desk asking for `uncurse` sees the `remove curse` request too');
  eq(openRequests({ service: 'remove curse', now: 2000 }).length, 2, 'and the other way round');
  postRequest({ service: 'uncurse', target: 'Echo', now: 1500, ttl_ms: 60_000 });
  eq(board({ now: 2000 }).filter(q => q.state === 'open').length, 2, 'asking again in the other spelling refreshes, never doubles');
  ok(board({ now: 2000 }).some(q => q.character === 'Floyd'), 'the character rides on the request');
}

section('whom the desk serves');
{
  const players = [{ id: 7, name: 'Floyd' }, { id: 8, name: 'Echo' }, { id: 9, name: 'Pepe' }];
  const reqs = [{ id: 'a', service: 'uncurse', target: 't4', character: 'Floyd', room: 552, at: 2, state: 'open' },
                { id: 'b', service: 'remove curse', target: 'Echo', room: 552, at: 1, state: 'open' },
                { id: 'c', service: 'uncurse', target: 'Gonzo', room: 552, at: 0, state: 'open' },
                { id: 'd', service: 'uncurse', target: 'Pepe', room: 552, at: 0, state: 'open' },
                { id: 'e', service: 'purge', target: 'Floyd', room: 552, at: 0, state: 'open' }];
  eq(uncurseCustomers({ requests: reqs, players, room: 552, me: 'Pepe', now: 100 }).map(x => x.request.id), ['b', 'a'],
     'oldest first; only askers standing here; never the desk itself; never another service');
  eq(uncurseCustomers({ requests: reqs, players, room: 38, me: 'Pepe', now: 100 }).length, 0, 'not a request filed in another room');
  eq(uncurseCustomers({ requests: reqs, players, room: 552, me: 'Pepe', now: 100, lastCast: new Map([['echo', 90]]), cooldownMs: 60 })
     .map(x => x.request.id), ['a'], 'a name cast on inside the cooldown waits');
  eq(uncurseCustomers({ requests: reqs.map(q => (q.id === 'b' ? { ...q, claimed_by: 'Sweetums' } : q)), players, room: 552, me: 'Pepe', now: 100 })
     .map(x => x.request.id), ['a'], 'a request the other desk claimed is left to it');
}

section('the farmer asks only for a curse it did not choose, only with a desk here');
{
  const desk = { name: 'Pepe', room: 552 };
  ok(shouldAskUncurse({ cursedWorn: ['long sword'], desk, room: 552 }).ask, 'a cursed sword, a desk here: ask');
  ok(!shouldAskUncurse({ cursedWorn: ['amulet of shadows'], rewear: ['amulet of shadows'], desk, room: 552 }).ask,
     'never for the amulet worn on purpose');
  ok(!shouldAskUncurse({ cursedWorn: ['long sword'], desk: null, room: 552 }).ask, 'no desk: no request');
  ok(!shouldAskUncurse({ cursedWorn: ['long sword'], desk, room: 38 }).ask, 'a desk in another room: no request');
  ok(shouldAskUncurse({ suspect: { name: 'mace' }, desk, room: 552 }).ask, 'a curse suspect asks too');
}

section('the re-wear');
{
  eq(rewearDue({ rewear: ['amulet of shadows'], pack: [{ id: 3, name: 'Amulet of Shadows' }, { id: 4, name: 'amulet of shadows' }] }),
     [{ id: 3, name: 'amulet of shadows' }], 'one per name');
  eq(rewearDue({ rewear: ['amulet of shadows'], pack: [{ id: 3, name: 'Amulet of Shadows' }], wornIds: new Set([3]) }), [],
     'already worn: nothing');
  eq(rewearDue({ rewear: [], pack: [{ id: 3, name: 'Amulet of Shadows' }] }), [], 'not listed: nothing');
}

section('practice: remove curse on self only while something cursed is worn');
{
  const practice = normalizePractice({ enabled: true, spells: [{ name: 'remove curse', target: 'self' }] });
  const args = { practice, spells: [{ name: 'remove curse', targets: 1, ability: 40 }], mana: { value: 30, max: 40 },
                 have: () => 5, reserve: { mana: 0, reagents: {}, why: 'none' }, karma: 40 };
  ok(choosePractice({ ...args, cursedWorn: 1 }).cast?.name === 'remove curse', 'with the amulet on: cast');
  const none = choosePractice({ ...args, cursedWorn: 0 });
  ok(!none.cast && /nothing cursed/.test(none.why), `nothing worn: not cast, and said so (${none.why})`);
  ok(choosePractice({ ...args, cursedWorn: null }).cast?.name === 'remove curse', 'unread: as before');
}

// ------------------------------------------------------------------ the keeper, against a stub body
function body({ worn = [], pack = [], emeralds = 3, karma = 40, mana = 20, room = 552, policy = {}, players = [] } = {}) {
  const names = new Map();
  let nextId = 100;
  const mk = (name, extra = {}) => { const id = nextId++; names.set(id, name); return { id, nameRsc: id, amount: 1, ...extra }; };
  const inventory = [...worn.map(w => mk(w.name, w)), ...pack.map(p => mk(p.name, p))];
  let equipped = inventory.slice(0, worn.length).map(o => ({ id: o.id }));
  const objects = new Map(players.map((p, i) => { const id = 900 + i; names.set(id, p); return [id, { id, nameRsc: id, flags: OF.PLAYER }]; }));
  const calls = { casts: [], uses: [], desks: [] };
  let em = emeralds, mn = mana;
  const c = {
    me: { name: 'Pepe' }, selfId: 1, inventory, room: { objects },
    spells: [{ id: 1, nameRsc: 'rc' }],
    rsc: { get: k => (k === 'rc' ? 'remove curse' : names.get(k)) },
    stat: k => (k === 'karma' ? karma : null),
    vitals: () => ({ mana: { value: mn }, health: { value: 30, max: 30 } }),
    equipment: () => ({ known: true, equipped }),
    use: id => { calls.uses.push(names.get(id)); equipped = [...equipped, { id }]; },
  };
  const s = { name: 't2', client: c, pacer: { submit: async (_k, fn) => fn() }, world: { room: { num: room } } };
  const ap = Object.create(Autopilot.prototype);
  Object.assign(ap, { s, policy, tally: {}, notes: [], ledger: [] });
  ap.note = (what, d) => ap.notes.push({ what, d });
  ap.ledgerEvent = (k, d) => ap.ledger.push({ k, d });
  ap.threat = () => ({ landing: 0 });
  ap.reagentOnHand = n => (n === 'emerald' ? em : 0);
  ap.chaliceReagentFloor = () => ({});
  ap.chaliceRole = () => 'traveller';
  ap.chaliceStore = () => ({ setDesk: (server, rec) => calls.desks.push({ server, ...rec }) });
  ap.chaliceCast = async (spell, id) => { calls.casts.push({ spell, to: names.get(id) }); em--; mn -= 9; return { cast: true }; };
  ap._curseCycleCfg = null;
  return { ap, c, calls, unwear: () => { equipped = []; } };
}

section('the keeper: the desk');
{
  const { ap, calls } = body({ policy: { uncurseDesk: { enabled: true, room: 552 } }, players: ['Floyd'] });
  eq(await ap.passCurseCycle({}), CONTINUE, 'nobody asked: the rung hands the pass on');
  eq(calls.desks.length, 1, 'but the record is published');
  ok(calls.desks[0].server === 'Pepe' && calls.desks[0].room === 552 && calls.desks[0].menu[0].ok === true, 'as Pepe, in 552, ok');
  ok(ap.uncurseDeskStatus().able === true, 'and status says it can cast');
  postRequest({ service: 'uncurse', target: 't4', character: 'Floyd', room: 552, now: Date.now(), ttl_ms: 60_000 });
  ap._uncurseServeAt = 0;
  eq(await ap.passCurseCycle({}), HANDLED, 'a requester standing here: served');
  eq(calls.casts, [{ spell: 'remove curse', to: 'Floyd' }], 'remove curse, on Floyd');
  ok(!openRequests({ service: 'uncurse' }).some(q => q.character === 'Floyd'), 'and the request is closed');
  ok(ap.ledger.some(r => r.k === 'uncurse_desk' && r.d.outcome === 'lifted'), 'with a ledger row that says it cost something');
}
{
  const { ap, calls } = body({ policy: { uncurseDesk: { enabled: true, room: 552 } }, emeralds: 0 });
  await ap.passCurseCycle({});
  ok(calls.desks.length === 1 && calls.desks[0].menu[0].ok === false && calls.desks[0].menu[0].why === 'Req. reagents',
     'out of emeralds: published ok:false at once, never left as a stale ok');
}
{
  const { ap, calls } = body({ policy: { uncurseDesk: { enabled: true, room: 552 } } });
  ap.chaliceRole = () => 'holder';
  await ap.passCurseCycle({});
  eq(calls.desks.length, 0, 'a chalice holder\'s own desk is not overwritten');
}
{
  const { ap, calls } = body({});
  eq(await ap.passCurseCycle({}), CONTINUE, 'no policy: inert');
  eq(calls.desks.length + calls.casts.length + calls.uses.length, 0, 'and does nothing');
}

section('the keeper: the amulet goes back on');
{
  const { ap, calls } = body({ pack: [{ name: 'Amulet of Shadows', rarity: 200 }], policy: { rewearCursed: ['amulet of shadows'] } });
  eq(ap.cursedWornCount(), 0, 'off: nothing cursed worn, so a self practice would be refused');
  eq(await ap.passCurseCycle({}), HANDLED, 'the amulet in the pack is put back on');
  eq(calls.uses, ['Amulet of Shadows'], 'by use');
  eq(ap.cursedWornCount(), 1, 'and counts as worn for the practice choice');
  eq(await ap.passCurseCycle({}), CONTINUE, 'worn already: nothing more');
}
{
  const { ap, calls } = body({ pack: [{ name: 'Amulet of Shadows', rarity: 200 }] });
  await ap.passCurseCycle({});
  eq(calls.uses, [], 'not listed in rewearCursed: never put on');
}

section('the keeper: a farmer asks');
{
  const posted = [];
  const { ap } = body({ worn: [{ name: 'long sword', rarity: 200 }] });
  ap.who = () => 'Floyd';
  ap.s.joints = { effects: { request: r => posted.push(r) } };
  ap._unrevealedWeaponGate = { mode: 'desk', allow: true, desk: { name: 'Pepe', room: 552 } };
  await ap.passCurseCycle({});
  ok(posted.length === 1 && posted[0].service === 'uncurse' && posted[0].character === 'Floyd', 'posted an uncurse request as Floyd');
  await ap.passCurseCycle({});
  eq(posted.length, 1, 'at most once a minute');
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
