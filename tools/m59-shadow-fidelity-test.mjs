#!/usr/bin/env node
// WHAT THIS PINS: what a shadow clone CARRIES, WEARS and BELONGS TO — the snapshot's reading
// of prod's replies, the wire-name -> kod-class step, and the exact maintenance-socket
// commands `m59-shadow.mjs dress` sends for a given snapshot and a given lab state.
//
//   node tools/m59-shadow-fidelity-test.mjs
//
// Offline: no socket, no roster, no broker. Reads compendium/data/koddb.json for the class
// index (the same file m59-itemclass.mjs reads). The fixtures below are shaped from real
// replies read on 2026-09-24 — prod's `equipment`/`inventory`/`guild status` over the
// broker, and the lab's `show object`/`show list` over the maintenance socket — with the
// numbers shortened.
import * as F from './m59-shadow-fidelity.mjs';
import { dressFlags, DRESS_FLAGS } from './m59-shadow-run.mjs';

let passed = 0, failed = 0;
const ok = (cond, what, extra = '') => {
  if (cond) { passed++; console.log(`  ok   ${what}`); }
  else { failed++; console.log(`  FAIL ${what}${extra ? `\n       ${extra}` : ''}`); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const same = (got, want, what) => ok(eq(got, want), what, `got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);

// ------------------------------------------------------------------ the prod read gate
console.log('\nprod is READ, by tool and by action');
ok(F.prodReadAllowed('inventory').ok, 'inventory is a read');
ok(F.prodReadAllowed('guild', { action: 'status' }).ok, 'guild status is a read');
for (const a of ['create', 'disband', 'rent_hall', 'induct', 'set_rank', 'exile', undefined])
  ok(!F.prodReadAllowed('guild', { action: a }).ok, `guild action=${a} is refused on prod`);
ok(!F.prodReadAllowed('container', { slot: 'r18c6' }).ok, 'container is not on the list — the chests come from the cache');
ok(!F.prodReadAllowed('reroll').ok && !F.prodReadAllowed('supply').ok, 'anything that writes is refused by name');

// ------------------------------------------------------------------ snapshot: the replies
console.log('\nequipment: `equipped`, not `worn`');
const eqReply = { character: 'Zoot', known: true,
  equipped: [{ id: 8756, name: 'chain armor', flags: 16 }, { id: 9032, name: 'hammer', flags: 16 }],
  wielding: ['hammer'] };
same(F.equippedNames(eqReply), ['chain armor', 'hammer'], 'reads both worn items from the real reply');
// The old expression, verbatim: every snapshot ever taken with it recorded [] — pinned so the
// bug cannot come back looking like "wears nothing".
const oldRead = (eq) => (eq?.worn ?? eq?.equipment?.worn ?? []).map(x => x.name).filter(Boolean);
same(oldRead(eqReply), [], 'and the old `eq.worn` read of the SAME reply was empty — the bug');
same(F.equippedNames({ worn: [{ name: 'mace' }] }), ['mace'], 'an older broker\'s `worn` still reads');
same(F.equippedNames({ equipped: ['chain armor'] }), ['chain armor'], 'bare-string rows are accepted');
// Measured on prod: the same two worn items came back as `<rsc undefined>` on a second read.
const unresolved = { equipped: [{ id: 8756, name: '<rsc undefined>' }, { id: 9032, name: '<rsc undefined>' }] };
same(F.equippedNames(unresolved, { items: [{ id: 8756, name: 'chain armor' }, { id: 9032, name: 'hammer' }] }),
     ['chain armor', 'hammer'], 'an unresolved name is repaired from the inventory row with the same id');
same(F.equippedNames(unresolved, { items: [], equipped: ['chain armor', 'hammer'] }), ['chain armor', 'hammer'],
     'or from the inventory reply\'s own equipped list');
same(F.equippedNames({ equipped: [{ id: -1, name: '<rsc undefined>' }] }, { items: [{ id: -1, name: 'hammer' }] }), [],
     'a negative id is never looked up (it is an array index), and a name nothing resolves is dropped');

console.log('\ninventory: every row, its amount, its grade; the purse');
const invReply = { items: [
  { id: 8712, name: 'scale armor', amount: 0, rarity_name: 'normal' },
  { id: 8340, name: 'shilling', amount: 11869, rarity_name: 'normal' },
  { id: 8701, name: 'herb', amount: 80, rarity_name: 'normal' },
  { id: 9383, name: 'long sword', amount: 0, rarity_name: 'uncommon' },
  { id: 7849, name: 'Chalice of the Rain', amount: 0, rarity_name: 'normal' },
  { id: 9220, name: 'scroll', amount: 0, rarity_name: 'unidentified' },
], equipped: ['long sword'] };
const pack = F.packRows(invReply);
same(pack[0], { name: 'scale armor', amount: 0 }, 'a non-stack keeps amount 0 (= one) and no grade when normal');
same(pack[3], { name: 'long sword', amount: 0, rarity: 'uncommon' }, 'a non-normal grade is kept');
ok(F.purseOf(pack) === 11869, 'the purse is the shilling stack');
ok(F.purseOf([{ name: 'shilling', amount: 5 }, { name: 'Shillings', amount: 7 }]) === 12, 'two money stacks sum, any case');

console.log('\nguild: per character, and the fleet\'s once');
const gonzo = { in_guild: true, guild: { id: 8041, name: 'The Second Swines', rank: 5, rank_title: 'master',
  hall_password: 'pw', read_at: 1,
  rank_titles: ['Apprentice', 'Apprentice', 'Sir', 'Madame', 'Lord', 'Lady', 'Lieutenant', 'Lieutenant', 'Master', 'Mistress'],
  roster: [{ name: 'Sweetums', rank: 3 }, { name: 'Kermit', rank: 4 }, { name: 'Gonzo', rank: 5 }, { name: 'Floyd', rank: 1 }] } };
same(F.guildOf(gonzo), { name: 'The Second Swines', rank: 5, rank_title: 'master' }, 'a member\'s name, rank and title');
ok(F.guildOf({ in_guild: false }) === null, 'not in a guild is null');
ok(F.guildOf({ _error: 'client timeout' }).unknown === true, 'an unread reply is UNKNOWN, never "not in a guild"');
const chestFile = { slot: 'r18c6', row: 18, col: 6, object_id: 2578, room: 714, observed_at: 99,
  items: [{ name: 'shilling', amount: 73109 }, { name: 'ruby', amount: 8 }, { name: 'scroll', amount: 1 }] };
const fg = F.fleetGuild([{ in_guild: false }, gonzo], { chests: [chestFile], rent: { credit: 27698, observed_at: 5 } });
ok(fg.name === 'The Second Swines' && fg.master === 'Gonzo', 'the fleet guild and its master come from the roster');
same(fg.members.find(m => m.prod_character === 'Kermit'), { prod_character: 'Kermit', rank: 4 }, 'every member with prod\'s rank');
ok(fg.hall_room === 714 && fg.hall_room_from === 'chest cache', 'the hall room comes from the chest cache, and says so');
ok(fg.rent_credit === 27698, 'the rent credit comes from the rent cache');
same(fg.chests[0], { slot: 'r18c6', row: 18, col: 6, room: 714, items: chestFile.items, observed_at: 99 },
     'a chest is its square and its items — the object id is NOT kept (ids are handles)');
ok(F.fleetGuild([gonzo], { hallRoom: 715 }).hall_room === 715, 'an explicit --hall-room wins');
ok(F.fleetGuild([{ in_guild: false }]) === null, 'no member with a roster: no guild, not an empty one');

// ------------------------------------------------------------------ stable slots
console.log('\nthe shadow <-> prod mapping does not move');
const prev = [{ prod_agent: 't3', shadow_account: 'shadow01' }, { prod_agent: 't6', shadow_account: 'shadow02' },
              { prod_agent: 'hk2', shadow_account: 'shadow23' }, { prod_agent: 'gone', shadow_account: 'shadow03' }];
const slots = F.assignShadowSlots(['t16', 't6', 'hk3', 't3', 'hk2'], prev);
ok(slots.get('t3') === 0 && slots.get('t6') === 1 && slots.get('hk2') === 22, 'a known agent keeps its slot whatever the row order');
ok(slots.get('t16') === 3 && slots.get('hk3') === 4, 'new agents take the lowest FREE slots, in fleet order');
ok(![...slots.values()].includes(2), 'a departed agent\'s slot stays reserved — its account still holds that body');
same([...F.assignShadowSlots(['a', 'b', 'c'], []).values()], [0, 1, 2], 'with no previous snapshot, slots are the row order');
ok(F.shadowName(0) === 'Aaaa' && F.shadowName(26) === 'Aaaaa' && F.shadowAcct(23) === 'shadow24', 'names and accounts are unchanged');

// ------------------------------------------------------------------ name -> class
console.log('\nwhat a pack is, by kod class');
const w = F.wantedHoldings(pack, ['long sword']);
const byCls = Object.fromEntries(w.want.map(x => [x.class, x]));
ok(byCls.Money?.stack && byCls.Money.count === 11869, 'shilling -> Money, a stack of 11869');
ok(byCls.Herbs?.count === 80, 'herb -> Herbs x80');
ok(byCls.Chalice?.count === 1 && !byCls.Chalice.stack, 'Chalice of the Rain -> Chalice, one');
ok(byCls.LongSword?.wear === 1 && byCls.LongSword.count === 1, 'the worn long sword is counted once and marked worn');
same(w.approximated.map(a => a.class), ['LongSword'], 'an uncommon long sword is created as a LongSword and APPROXIMATED');
ok(!byCls.Scroll && w.unknown.some(u => /^scroll/.test(u.name) && /family of 15 Scroll/.test(u.why)),
   'an unidentified scroll is REPORTED, not created — `Scroll` is a scroll of light, the real one is 1 of 15 subclasses');
const uh = F.wantedHoldings([{ name: 'hammer', amount: 0, rarity: 'unidentified' }]);
ok(uh.want[0]?.class === 'Hammer' && uh.approximated.length === 1, 'an unidentified hammer (no subclasses) is still a Hammer, approximated');
const u = F.wantedHoldings([{ name: 'flask', amount: 0 }, { name: 'wand', amount: 0 }, { name: 'widget', amount: 0 }, { name: 'herb', amount: 3 }]);
same(u.unknown.map(x => x.name), ['flask', 'wand', 'widget'], 'ambiguous and unknown names are REPORTED, never guessed');
ok(u.unknown[0].candidates.length === 3, 'with the candidates named');
same(u.want.map(x => x.class), ['Herbs'], 'and nothing is created for them');
const two = F.wantedHoldings([{ name: 'chain armor', amount: 0 }, { name: 'chain armor', amount: 0 }], ['chain armor']);
ok(two.want[0].count === 2 && two.want[0].wear === 1, 'two chain armours carried, one worn');
const oldSnap = F.wantedHoldings([], ['hammer']);
ok(oldSnap.want[0].class === 'Hammer' && oldSnap.want[0].count === 1 && oldSnap.want[0].wear === 1,
   'a worn name the pack does not list is still created — an old snapshot\'s `wielding` arms its shadow');

// ------------------------------------------------------------------ reading the lab
console.log('\nreading the lab\'s `show` replies');
const userShow = ':< OBJECT 4292 is CLASS User\n: poOwner              = OBJECT 1579\n' +
  ': plPassive            = LIST 255965\n: poGuild              = $ 0\n: plUsing              = LIST 81727\n';
same((({ id, class: c, passive, using, guild, owner }) => ({ id, c, passive, using, guild, owner }))(F.parseShowObject(userShow)),
     { id: 4292, c: 'User', passive: 255965, using: 81727, guild: null, owner: 1579 }, 'a character: its lists, no guild');
ok(F.parseShowObject(':< OBJECT 15552 is CLASS Herbs\n: piNumber             = INT 60\n').number === 60, 'a stack\'s piNumber');
ok(F.parseShowObject(':< OBJECT 2576 is CLASS Chest\n: plPassive            = $ 0\n').passive === null, 'an empty holder has a nil list, not an undefined one');
same(F.parseListObjects(':<\n: [\n: OBJECT 15552\n: OBJECT 7293\n: ]\n:>\n'), [15552, 7293], 'a flat list');
const activeList = ':<\n: [\n: [\n: OBJECT 2604\n: INT 0\n: INT 5\n: INT 29\n: INT 32\n: INT 32\n: $ 0\n: ]\n' +
  ': [\n: OBJECT 2578\n: INT 2048\n: INT 18\n: INT 6\n: INT 32\n: INT 32\n: $ 0\n: ]\n: ]\n:>\n';
same(F.placedEntries(activeList), [{ id: 2604, angle: 0, row: 5, col: 29 }, { id: 2578, angle: 2048, row: 18, col: 6 }],
     'a room\'s plActive entry is [object, angle, row, col, …] — measured on hall 714');
same(F.memberEntries(':<\n: [\n: [\n: OBJECT 11\n: INT 5\n: OBJECT 11\n: ]\n: [\n: OBJECT 12\n: INT 1\n: OBJECT 11\n: ]\n: ]\n'),
     [{ id: 11, rank: 5 }, { id: 12, rank: 1 }], 'a guild\'s plMembers entry is [who, rank, vote]');
ok(F.returnedString(':< return from OBJECT 900 MESSAGE GetName (1)\n: RESOURCE 1000123\n:   == "The Second Swines"\n:>') === 'The Second Swines',
   'a send that returns a resource prints its string');
ok(F.createdResource('> create resource The Second Swines\n1000123 (dynamic) = The Second Swines\n', 'The Second Swines') === 1000123,
   '`create resource` id, its echo confirmed');
ok(F.createdResource(': 1000124 (dynamic) = Other\n', 'The Second Swines') === null, 'an echo that is not the value asked for is not trusted');
same(F.createdObjects('Created object 51.\n> \nCreated object 52.\n'), [51, 52], '`create object` ids, in order');
const pre = F.splitReplies('> show object 1234\n:< OBJECT 1234 is CLASS Herbs\n> \nshow object 123\n:< OBJECT 123 is CLASS Ruby\n',
                           ['show object 1234', 'show object 123']);
ok(/Herbs/.test(pre[0]) && /Ruby/.test(pre[1]) && !/Herbs/.test(pre[1]),
   'replies split on the EXACT echo — `show object 123` is a prefix of `show object 1234`');

// ------------------------------------------------------------------ dress: the commands
console.log('\ndress: the commands for a sample character');
// Tttt <- Loial: shillings, herbs, a chalice, a scale armour; wearing nothing. The lab body
// already holds 40 herbs (a previous build) and a leather armour it is wearing (its own
// history, not prod's).
const loial = F.wantedHoldings([{ name: 'shilling', amount: 11869 }, { name: 'herb', amount: 80 },
  { name: 'Chalice of the Rain', amount: 0 }, { name: 'scale armor', amount: 0 }], []);
const have = [{ id: 700, class: 'Herbs', number: 40, using: false },
              { id: 701, class: 'LeatherArmor', number: null, using: true }];
const plan = F.planHoldings({ want: loial.want, have });
same(F.createCmds(plan), ['create object Money number INT 11869', 'create object Chalice', 'create object ScaleArmor'],
     'creates: the purse as ONE stack, the chalice, the armour');
same(plan.setNumber, [{ id: 700, class: 'Herbs', from: 40, to: 80 }], 'an existing stack is SET to prod\'s number, not topped up');
same(F.holdingCmds(plan, { holder: 4310, wearer: 4310, created: [9001, 9002, 9003] }), [
  'send object 4310 TryUnuseItem what OBJECT 701',
  'set object 700 piNumber INT 80',
  'send object 4310 NewHold what OBJECT 9001',
  'send object 4310 NewHold what OBJECT 9002',
  'send object 4310 NewHold what OBJECT 9003',
], 'then: take off what prod is not wearing, restack, hand over — in that order');
ok(plan.surplus.length === 1 && plan.surplus[0].id === 701, 'the leather armour prod does not carry is SURPLUS');
ok(!F.holdingCmds(plan, { holder: 4310, wearer: 4310, created: [1, 2, 3] }).some(c => /Delete/.test(c)), 'and is not deleted by default');
ok(F.holdingCmds(plan, { holder: 4310, wearer: 4310, created: [1, 2, 3], trim: true }).at(-1) === 'send object 701 Delete',
   'only --trim-items deletes it');
let threw = false; try { F.holdingCmds(plan, { holder: 1, created: [1] }); } catch { threw = true; }
ok(threw, 'a create count that does not match hands NOTHING over — the ids would not line up');

console.log('\ndress: worn gear goes on through the player\'s own TryUseItem');
const zoot = F.wantedHoldings([{ name: 'shilling', amount: 422 }, { name: 'chain armor', amount: 0 }, { name: 'hammer', amount: 0 }],
                              ['chain armor', 'hammer']);
const zp = F.planHoldings({ want: zoot.want, have: [{ id: 800, class: 'Hammer', number: null, using: false }] });
same(F.holdingCmds(zp, { holder: 4320, wearer: 4320, created: [9101, 9102] }), [
  'send object 4320 NewHold what OBJECT 9101',
  'send object 4320 NewHold what OBJECT 9102',
  'send object 4320 TryUseItem what OBJECT 800',
  'send object 4320 TryUseItem what OBJECT 9102',
], 'the hammer already carried is wielded; the new chain armour is handed over and worn');
same(F.createCmds(zp), ['create object Money number INT 422', 'create object ChainArmor'], 'and only what is missing is created');

console.log('\ndress: re-running changes nothing');
const settled = F.planHoldings({ want: zoot.want, have: [
  { id: 1, class: 'Money', number: 422, using: false }, { id: 2, class: 'ChainArmor', number: null, using: true },
  { id: 3, class: 'Hammer', number: null, using: true }] });
same(F.holdingCmds(settled, { holder: 4320, wearer: 4320, created: [] }), [], 'a body that already matches gets no commands');
ok(F.describePlan(settled) === 'already matches', 'and says so');
const worn2 = F.planHoldings({ want: zoot.want, have: [
  { id: 1, class: 'Money', number: 422 }, { id: 2, class: 'ChainArmor', using: true }, { id: 4, class: 'ChainArmor', using: true },
  { id: 3, class: 'Hammer', using: true }] });
ok(worn2.surplus.length === 1 && worn2.surplus[0].id === 4 && worn2.unwear.length === 0,
   'a second chain armour (somehow worn) is surplus; the one kept is a worn one');

// ------------------------------------------------------------------ the guild mirror
console.log('\nthe guild mirror');
const chars = [{ prod_character: 'Gonzo', shadow_name: 'Pppp' }, { prod_character: 'Kermit', shadow_name: 'Gggg' },
               { prod_character: 'Sweetums', shadow_name: 'Mmmm' }, { prod_character: 'Floyd', shadow_name: 'Rrrr' }];
const ids = { Pppp: 4301, Gggg: 4302, Mmmm: 4303 };                 // Rrrr is not on the lab
const gm = F.guildMembers(fg, chars, ids);
ok(gm.master?.shadow === 'Pppp' && gm.master.id === 4301, 'prod\'s master maps to his shadow');
same(gm.missing, [{ prod_character: 'Floyd', shadow: 'Rrrr', why: 'not on the lab server' }], 'a member with no lab body is REPORTED');
const res = F.guildResourceCmds(fg);
same(res.map(r => r.cmd).slice(0, 2), ['create resource The Second Swines', 'create resource Apprentice'], 'name and titles become dynamic resources');
ok(res.length === 12 && res.at(-1).key === 'password' && !res.at(-1).invented, 'ten titles and prod\'s own hall password');
ok(F.guildResourceCmds({ ...fg, hall_password: null }).at(-1).invented === true, 'an unread password is invented and SAYS so');
ok(F.guildCreateCmd({ masterId: 4301, nameRsc: 1000123 }) === 'create object Guild master OBJECT 4301 guildname RESOURCE 1000123',
   'the guild is created with two blakod parms — the admin parser\'s 10-slot array has no bound check');
const titleRscs = Object.fromEntries(F.TITLE_PROPS.map((p, i) => [p, 2000 + i]));
const fresh = F.guildSetupCmds({ guildId: 900, guild: fg, members: gm.members, current: [{ id: 4301, rank: 5 }], titleRscs });
same(fresh.cmds, [
  ...F.TITLE_PROPS.map((p, i) => `set object 900 ${p} RESOURCE ${2000 + i}`),
  'set object 900 piMature INT 0',
  'set object 900 piRentDue INT -27698',
  'set object 4303 piGuildRejoinTimestamp INT 0',
  'send object 900 InductNewMember who OBJECT 4303',
  'set object 4302 piGuildRejoinTimestamp INT 0',
  'send object 900 InductNewMember who OBJECT 4302',
  'send object 900 ChangeRank who OBJECT 4303 newrank INT 3',
  'send object 900 ChangeRank who OBJECT 4302 newrank INT 4',
], 'a fresh guild: titles, matured, prod\'s rent credit, every member in (prod\'s roster order), every rank prod\'s');
const again = F.guildSetupCmds({ guildId: 900, guild: fg, members: gm.members, setTitles: false,
  current: [{ id: 4301, rank: 5 }, { id: 4302, rank: 4 }, { id: 4303, rank: 1 }] });
same(again.cmds, ['set object 900 piMature INT 0', 'set object 900 piRentDue INT -27698',
                  'send object 900 ChangeRank who OBJECT 4303 newrank INT 3'],
     'a re-run inducts nobody twice and fixes only the rank that is wrong');
const elsewhere = F.guildSetupCmds({ guildId: 900, guild: fg, members: gm.members, current: [{ id: 4301, rank: 5 }], others: { 4303: 777 } });
ok(elsewhere.refused.length === 1 && elsewhere.refused[0].id === 4303 && !elsewhere.cmds.some(c => /4303/.test(c)),
   'a shadow already in ANOTHER guild is reported, not forced');
const deposed = F.guildSetupCmds({ guildId: 900, guild: fg, members: gm.members, setTitles: false,
  current: [{ id: 4302, rank: 5 }, { id: 4301, rank: 3 }, { id: 4303, rank: 3 }] });
ok(deposed.cmds.includes('send object 900 NewGuildMaster who OBJECT 4301') &&
   deposed.cmds.includes('send object 900 ChangeRank who OBJECT 4302 newrank INT 4'),
   'the wrong master is replaced and put back at prod\'s rank for him');
ok(F.hallClaimCmd({ hallId: 2572, guildId: 900, repId: 4301, passwordRsc: 3000 }) ===
   'send object 2572 ClaimGuildHall oGuild OBJECT 900 rep OBJECT 4301 password RESOURCE 3000', 'the hall is claimed the way renting claims it');

console.log('\nthe chests');
const placed = [{ id: 2576, row: 20, col: 4 }, { id: 2577, row: 18, col: 2 }, { id: 2578, row: 18, col: 6 }, { id: 2604, row: 5, col: 29 }];
const cls = { 2576: 'Chest', 2577: 'Chest', 2578: 'Chest', 2604: 'Stool' };
const mc = F.matchChests([chestFile, { slot: 'r9c9', row: 9, col: 9, items: [] }], placed, id => cls[id]);
ok(mc.chests.length === 1 && mc.chests[0].id === 2578, 'a prod chest is matched to the lab Chest on the same square');
ok(mc.missing.length === 1 && mc.missing[0].slot === 'r9c9', 'a square with no chest is reported');
const cw = F.wantedHoldings(chestFile.items, []);
const cp = F.planHoldings({ want: cw.want, have: [], wearable: false });
same(F.holdingCmds(cp, { holder: 2578, wearer: null, created: [1, 2] }),
     ['send object 2578 NewHold what OBJECT 1', 'send object 2578 NewHold what OBJECT 2'],
     'items go INTO the chest; nothing is worn by a chest');
same(F.createCmds(cp), ['create object Money number INT 73109', 'create object Ruby number INT 8'],
     'the 73,109 shillings are one stack');
ok(cw.unknown.some(u => u.name === 'scroll'), 'and a chest\'s bare `scroll` (no grade recorded) is refused by its family shape');

// ------------------------------------------------------------------ the shim
console.log('\nthe shim forwards every dress flag it accepts');
same(dressFlags(['x', '--no-items', '--no-guild']), ['dress', '--no-items', '--no-guild'], '--no-items and --no-guild reach dress');
same(dressFlags(['--no-skills', '--trim-items']), ['dress', '--no-skills', '--trim-items'], 'and --no-skills, --trim-items');
ok(DRESS_FLAGS.length === 4, 'four of them');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
