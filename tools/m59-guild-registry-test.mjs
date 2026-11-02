#!/usr/bin/env node
//
// MORE THAN ONE GUILD IN THE ROSTER: chests, rent, rosters, halls, passwords and plans kept apart.
// Offline, scratch directories only — never substrate/, which the running broker writes.
//
// The rules pinned here, each one a mix-up that the single-guild code would have made silently:
//   - a chest reading is filed under the hall it was TAKEN IN, and refused without a hall room number;
//   - the flat chest layout is hall 714, whatever room id an old reading carries (prod's say 2569);
//   - rent is filed under the guild Frular NAMED, and one guild never reads another's balance;
//   - a roster files every member; the newest roster wins; 714 is adopted only by a sole guild;
//   - an ally may use a hall, a stranger may not, an apprentice may not;
//   - each hall has its own password and its own plan, and a plan only counts its own hall's chests.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'm59-multiguild-'));
process.env.M59_GUILD_PLAN = join(root, 'guild-plan.json');
process.env.M59_GUILD_PLANS_DIR = join(root, 'guild-plans');
const { StorageCache, rentGuildName, isGuildHallRoom, LEGACY_CHEST_HALL } = await import('./m59-storage.mjs');
const { GuildRegistry, guildSummary } = await import('./m59-guild-registry.mjs');
const { hallPassword, setHallPassword, describe: describeSecret, foyerFor, inFoyer } = await import('./m59-hallsecret.mjs');
const { guildPlan, saveGuildPlan, guildPlanRooms, guildPlanFileFor, guildKeepTest, contributionPlan } =
  await import('./m59-guildwants.mjs');

let n = 0, failed = 0;
const ok = (c, why) => { try { assert.ok(c, why); n++; console.log(`  ok   ${why}`); } catch { failed++; console.log(`  FAIL ${why}`); } };
const eq = (a, b, why) => ok(Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b), `${why} (got ${JSON.stringify(a)})`);
const section = s => console.log(`\n${s}`);

const A = 'The Second Swines', B = 'Muppet Workshop';
try {
  // ---------------------------------------------------------------- chests
  section('a chest reading is filed under the hall it was read in');
  const dir = join(root, 'storage');
  const store = new StorageCache({ dir });
  ok(isGuildHallRoom(714) && isGuildHallRoom(705) && !isGuildHallRoom(2569) && !isGuildHallRoom(null),
     'hall rooms are 701-715; an object id is not one');
  assert.throws(() => store.writeChest('r18c6', { room: 2569, items: [] }), /ROOM NUMBER/); n++;
  console.log('  ok   a reading filed under an object id is refused, not guessed at');
  assert.throws(() => store.writeChest('r18c6', { room: null, items: [] }), /ROOM NUMBER/); n++;
  console.log('  ok   and so is a reading with no room at all');

  // A legacy flat reading, exactly as prod has them: room is the room's OBJECT ID.
  mkdirSync(join(dir, 'chests'), { recursive: true });
  writeFileSync(join(dir, 'chests', 'r18c2.json'), JSON.stringify({ slot: 'r18c2', row: 18, col: 2, room: 2569,
    items: [{ name: 'elderberry', amount: 300 }], opened_by: 'Piggy', observed_at: 1 }));
  eq(store.readChest('r18c2').room, 714, 'a flat (pre-split) reading is hall 714 whatever room id it recorded');
  eq(store.allChests({ room: 714 }).length, 1, 'and is found by a filter on 714 — the old filter on room===714 never matched it');

  store.writeChest('r18c6', { room: 714, items: [{ name: 'herbs', amount: 5 }], by: 'Kermit' });
  store.writeChest('r18c6', { room: 705, items: [{ name: 'emerald', amount: 9 }], by: 'Gonzo' });
  ok(existsSync(join(dir, 'chests', 'r18c6.json')), '714 still writes the flat layout every older reader opens');
  ok(existsSync(join(dir, 'chests', '705', 'r18c6.json')), 'another hall writes under chests/<room>/');
  eq(store.readChest('r18c6', 714).items[0].name, 'herbs', 'the SAME square in two halls is two chests (714)');
  eq(store.readChest('r18c6', 705).items[0].name, 'emerald', 'the SAME square in two halls is two chests (705)');
  eq(store.chestHalls(), [705, 714], 'every hall with readings is listed');
  eq(store.allChests().map(c => c.chest_id), ['705/r18c6', '714/r18c2', '714/r18c6'], 'unfiltered = every hall, each row naming its hall');
  eq(store.allChests({ room: 705 }).length, 1, 'filtered = one hall');

  store.writeChest('r18c6', { room: 705, items: [{ name: 'emerald', amount: 4 }], by: 'Gonzo' });
  eq(store.readChestHistory('r18c6', { room: 705 })[0].left[0]?.amount, 5, 'history is per hall: 705 records what left 705');
  eq(store.readChestHistory('r18c6', { room: 714 }).length, 0, 'and 714 records nothing for a change in 705');

  // ---------------------------------------------------------------- rent
  section('rent is filed under the guild Frular named');
  eq(rentGuildName('Frular says, "The The Second Swines has a positive balance of 255744 shillings."'), A,
     'the guild name is read out of the sentence, including a name that itself begins with "The"');
  eq(rentGuildName('The Muppet Workshop owes 6547 coins in rent at this time.'), B, 'and out of a debt');
  // Prod's legacy reading: guild null, the sentence names A.
  writeFileSync(join(dir, 'rent.json'), JSON.stringify({ due: -255744, credit: 255744, in_guild: true, guild: null,
    said: 'Frular says, "The The Second Swines has a positive balance of 255744 shillings."', observed_at: 10 }));
  eq(store.readRent(A)?.credit, 255744, 'the pre-split rent.json still answers for the guild its sentence names');
  eq(store.readRent(B), null, 'and NOT for any other guild — B must not read A\'s balance as its own');
  store.writeRent({ due: 6547, credit: -6547, in_guild: true, said: 'The Muppet Workshop owes 6547 coins in rent at this time.',
                    guild: A /* the asker's guild, wrong on purpose */, by: 'Gonzo', at: 20 });
  eq(store.readRent(B)?.due, 6547, 'a reading is filed under the NAMED guild even when the asker passed another');
  eq(store.readRent(A)?.credit, 255744, 'and the other guild\'s reading is untouched');
  eq(store.allRents().map(r => r.guild).sort(), [B, A].sort(), 'allRents: one per guild');

  // ---------------------------------------------------------------- rosters and halls
  section('rosters, halls, allies');
  const reg = new GuildRegistry({ dir });
  reg.recordRoster({ id: 1, name: A, rank: 5, password: 'never-stored',
    members: [{ id: 11, name: 'Kermit', rank: 5 }, { id: 12, name: 'Piggy', rank: 2 }, { id: 13, name: 'Animal', rank: 1 }] },
    { by: 'Kermit', at: 100 });
  ok(!readFileSync(reg.guildPath(A), 'utf8').includes('never-stored'), 'the GUILDINFO password is never written to the registry');
  eq(reg.hallOf(A), 714, 'the sole guild, with flat readings on disk, adopts 714');
  reg.recordRoster({ id: 2, name: B, members: [{ id: 21, name: 'Gonzo', rank: 3 }, { id: 22, name: 'Rizzo', rank: 1 }] },
    { by: 'Gonzo', at: 200 });
  eq(reg.hallOf(B), null, 'the second guild adopts nothing — a hall of its own must be learned or declared');
  eq(reg.ownerOfHall(714), A, 'and 714 stays with the first');
  eq(reg.guildOf('Piggy')?.name, A, 'a roster files every member, not only the reader');
  eq(reg.guildOf('gonzo')?.name, B, 'names match case-insensitively');
  reg.recordRoster({ id: 2, name: B, members: [{ id: 21, name: 'Gonzo', rank: 3 }, { id: 12, name: 'Piggy', rank: 2 }] },
    { by: 'Gonzo', at: 300 });
  eq(reg.guildOf('Piggy')?.name, B, 'a character that moved guild belongs to the NEWER roster');
  reg.recordHall(705, B, { source: 'chalice landing' });
  eq(reg.hallOf(B), 705, 'a recorded hall');
  reg.recordHall(712, B);
  eq([reg.hallOf(B), reg.ownerOfHall(705)], [712, null], 'a guild has ONE hall: recording another frees the first');
  reg.recordHall(705, B);

  let ctx = reg.contextFor('Gonzo', { here: 714 });
  eq([ctx.guild, ctx.own_hall, ctx.here_hall, ctx.here_owner, ctx.may_use_here], [B, 705, 714, A, false],
     'not allied yet: Gonzo standing in A\'s hall may not use it');
  reg.recordAllies(A, { guilds: [{ id: 1, name: A }, { id: 2, name: B }, { id: 3, name: 'Strangers' }], allies: [2] });
  ctx = reg.contextFor('Gonzo', { here: 714 });
  eq(ctx.may_use_here, true, 'once UC_GUILD_LIST says they are allied, he may');
  eq(reg.contextFor('Rizzo', { here: 714 }).may_use_here, false, 'but an ally\'s APPRENTICE may not (ghall.kod:1039)');
  eq(reg.contextFor('Nobody', { here: 714 }).may_use_here, false, 'nor a character in no known guild');
  eq(reg.contextFor('Gonzo', { here: 101 }).here_hall, null, 'a room that is not a hall is not a hall');
  reg.recordRoster({ id: 1, name: A, members: [{ id: 11, name: 'Kermit', rank: 5 }] }, { by: 'Kermit', at: 400 });
  eq(reg.alliesOf(A), [B], 'a later roster read does not erase the alliance');
  const summary = guildSummary({ registry: reg, store });
  eq(summary.map(r => [r.guild, r.hall_room, r.chests]).sort(), [[A, 714, 2], [B, 705, 1]].sort(),
     'the board summary: one row per guild, its own hall, its own chest count');
  eq(summary.find(r => r.guild === B).rent?.due, 6547, 'and its own rent');

  section('login order does not decide who adopts 714');
  {
    const d2 = join(root, 'race');
    mkdirSync(join(d2, 'chests'), { recursive: true });
    writeFileSync(join(d2, 'chests', 'r18c2.json'), JSON.stringify({ slot: 'r18c2', row: 18, col: 2, room: 2569, items: [] }));
    writeFileSync(join(d2, 'rent.json'), JSON.stringify({ in_guild: true, guild: null,
      said: 'Frular says, "The The Second Swines has a positive balance of 9 shillings."' }));
    const r2 = new GuildRegistry({ dir: d2 });
    r2.recordRoster({ name: B, members: [{ name: 'Gonzo', rank: 3 }] }, { by: 'Gonzo' });
    eq(r2.ownerOfHall(714), null, 'B logs in first: it is the only guild seen, but the old rent reading names A — B adopts nothing');
    r2.recordRoster({ name: A, members: [{ name: 'Kermit', rank: 5 }] }, { by: 'Kermit' });
    eq(r2.ownerOfHall(714), A, 'A arrives second and adopts 714, because it is the guild that was paying for it');
  }

  // ---------------------------------------------------------------- passwords
  section('each hall has its own password');
  const fleets = join(root, 'fleets');
  setHallPassword('prod', 'aaa-fake', { dir: fleets, room: 714 });
  setHallPassword('prod', 'bbb-fake', { dir: fleets, room: 705 });
  eq(hallPassword('prod', { dir: fleets }), 'aaa-fake', 'no room: the original hall\'s word, as before');
  eq(hallPassword('prod', { dir: fleets, room: 714 }), 'aaa-fake', '714');
  eq(hallPassword('prod', { dir: fleets, room: 705 }), 'bbb-fake', 'the second hall\'s word, without overwriting the first');
  eq(hallPassword('prod', { dir: fleets, room: 712 }), null, 'a hall with no recorded word has none — never another hall\'s');
  const shown = JSON.stringify(describeSecret('prod', { dir: fleets }));
  ok(!shown.includes('aaa-fake') && !shown.includes('bbb-fake') && shown.includes('705'),
     'describe() lists the halls and never a word');
  eq(inFoyer(2, 30, foyerFor(714)), true, '714\'s foyer box');
  eq(inFoyer(2, 30, foyerFor(705)), false, 'the same square is outside 705\'s box — each hall is asked about its own');
  eq(inFoyer(30, 10, foyerFor(705)), true, '705\'s box is rows 27-48, cols 0-27 (guildh12.kod)');
  eq(inFoyer(2, 30, foyerFor(706)), null, 'a hall that declares no box cannot answer, rather than answering "outside"');

  // ---------------------------------------------------------------- plans
  section('one plan per hall, counted against that hall only');
  saveGuildPlan({ chests: { r18c6: { items: [{ item: 'herbs', target: 10 }] } } }, 714);
  saveGuildPlan({ chests: { r18c6: { items: [{ item: 'emerald', target: 10 }] } } }, 705);
  eq(guildPlanFileFor(714), process.env.M59_GUILD_PLAN, '714\'s plan is the file it always was');
  ok(existsSync(join(process.env.M59_GUILD_PLANS_DIR, '705.json')), 'another hall\'s plan has a file of its own');
  eq(guildPlanRooms(), [705, 714], 'both plans are listed');
  const p714 = guildPlan(714), p705 = guildPlan(705);
  eq([p714.hall_room, [...p714.chests.get('r18c6')].map(i => i.item)], [714, ['herbs']], '714\'s plan');
  eq([p705.hall_room, [...p705.chests.get('r18c6')].map(i => i.item)], [705, ['emerald']], '705\'s plan');
  const saved = saveGuildPlan({ chests: { 1: { items: [{ item: 'herbs', target: 1 }] } } }, 705);
  ok(saved.problems.some(p => /outside/.test(p)) && !Object.keys(saved.saved.chests).length,'an old slot NUMBER means one of the Bookmaker\'s chests, so in 705 it is refused');
  saveGuildPlan({ chests: { r18c6: { items: [{ item: 'emerald', target: 10 }] } } }, 705);

  const every = store.allChests();               // BOTH halls, as a careless caller would pass them
  const rentA = store.readRent(A), rentB = { ...store.readRent(B), in_guild: true };
  const keep714 = guildKeepTest({ plan: guildPlan(714), chests: every, rent: rentA });
  eq(keep714.shortfall.get('herbs'), 5, '714 counts 714\'s r18c6 (5 herbs of 10) — not 705\'s r18c6 that holds none');
  const keep705 = guildKeepTest({ plan: guildPlan(705), chests: every, rent: rentB });
  eq(keep705.shortfall.get('emerald'), 6, '705 counts 705\'s r18c6 (4 emeralds of 10)');
  const give = contributionPlan({ plan: guildPlan(705), chests: every, rent: rentB,
    pack: [{ name: 'emerald', amount: 20 }, { name: 'herbs', amount: 20 }] });
  eq(give.chests.flatMap(c => c.give.map(g => [g.item, g.amount])), [['emerald', 6]],
     'a contribution to 705 gives what 705 is short of, nothing toward 714');
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`\n${n} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
