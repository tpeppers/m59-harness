#!/usr/bin/env node
//
// The four containers and their four different rules. Runs against scratch directories and
// never touches substrate/storage — the running broker writes that.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCache, packFullness, bulkFullness, vaultFullness, chestFullness,
         packMax, PACK_BASE, VAULT_BULK_MAX, CHEST_BULK_MAX, STOREBOX_BULK_MAX,
         GUILD_CHEST_SLOTS, BOOKMAKERS_CHESTS, chestKey, parseChestKey } from './m59-storage.mjs';

let n = 0;
const ok = (c, why) => { assert.ok(c, why); n++; };
const eq = (a, b, why) => { assert.equal(a, b, why); n++; };

// ------------------------------------------------------------------ the ceilings
eq(PACK_BASE, 1700, 'player.kod:737');
eq(packMax(0), 1700, 'no might is still the base, not zero');
eq(packMax(35), 2400, '1700 + might*20 (player.kod:10458)');
eq(VAULT_BULK_MAX, 3000, 'storage.kod:31');
eq(CHEST_BULK_MAX, 24000, 'chest.kod:29');
eq(STOREBOX_BULK_MAX, 4000, 'storebox.kod:33');
eq(GUILD_CHEST_SLOTS, 4, 'a hall may hold four');
eq(BOOKMAKERS_CHESTS, 3, 'guildh14.kod:518,520,522 creates three');

// ------------------------------------------------------------------ a pack has TWO
//
// The one container with two ceilings, and it is full when EITHER is reached. Reporting
// the average, or whichever is lower, says there is room when there is not — which is the
// bug the weight table exists to prevent: a create weapon on a full pack costs 15 mana and
// the server DELETES the weapon.
const heavy = packFullness([{ name: 'plate armor', amount: 3 }], 35);
const bulky = packFullness([{ name: 'herb', amount: 200 }], 35);
ok(heavy.known && bulky.known, 'both are answerable with a might');
eq(heavy.percent, Math.max(heavy.weight_pct, heavy.bulk_pct), 'the pack takes the WORSE fraction');
eq(bulky.percent, Math.max(bulky.weight_pct, bulky.bulk_pct));
ok(heavy.binding === 'weight' || heavy.binding === 'bulk', 'and says which one binds');
eq(bulky.binding, 'bulk', 'two hundred herbs is bulk-bound, not weight-bound');

// WITHOUT MIGHT THERE IS NO CEILING, and a percentage of an unknown ceiling is not zero.
const noMight = packFullness([{ name: 'mace', amount: 1 }], null);
eq(noMight.known, false, 'unknown rather than a number');
eq(noMight.percent, undefined, 'and specifically not a percentage');

// ------------------------------------------------------------------ the bulk-only three
//
// These declare viWeight_hold_max = $, which is nil and means unlimited. Weighing them
// would invent a limit the server does not have — so a pack of lead fills a vault by bulk
// alone, and the answer must not move when the weight does.
const light = vaultFullness([{ name: 'herb', amount: 100 }]);
eq(light.binding, 'bulk', 'a vault is bulk-only');
ok(light.percent > 0 && light.percent < 100);
eq(vaultFullness([]).percent, 0, 'an empty vault is genuinely 0%');
eq(bulkFullness([{ name: 'herb', amount: 100 }], CHEST_BULK_MAX).percent,
   chestFullness([{ name: 'herb', amount: 100 }]).percent,
   'a chest is the same arithmetic against a bigger number');
ok(chestFullness([{ name: 'herb', amount: 100 }]).percent < light.percent,
   'and the same load is a smaller fraction of the bigger container');

// ------------------------------------------------------------------ the record
const dir = mkdtempSync(join(tmpdir(), 'm59-storage-'));
try {
  const cache = new StorageCache({ dir, now: () => 5000 });

  // NEVER LOOKED AND EMPTY ARE OPPOSITE FACTS about a store, and the whole point of the
  // board is to keep them apart. A guild that thinks a chest is empty when nobody has
  // opened it will not go and look.
  eq(cache.readVault('Piggy'), null, 'an unread vault is null, not an empty one');
  // NOTHING LOOKED IN IS AN EMPTY LIST, not four placeholders. This used to synthesise
  // slots 1..4 and mark each `never_opened`, which made sense while a slot was an index.
  // A chest is now named by its square, and there is no list of every square a chest could
  // stand on — so inventing rows here would be inventing chests. `guildStoreAvailable`
  // already reads the empty list as "no evidence of a hall to fill", which is the same
  // protection the placeholders were giving.
  eq(cache.allChests().length, 0, 'no chest has been looked in, so there are no readings');

  cache.writeVault('Piggy', [{ name: 'herb', amount: 40 }, { name: 'mace', amount: 1, fee: 12 }]);
  const v = cache.readVault('Piggy');
  eq(v.items.length, 2);
  eq(v.items[1].fee, 12, 'the retrieval fee is kept — it is what getting it back costs');
  eq(v.fullness.max, VAULT_BULK_MAX, 'and fullness comes back with the reading');
  ok(v.fullness.percent > 0);

  cache.writeChest('r18c2', { object_id: 77, room: 714,
                              items: [{ name: 'elderberry', amount: 300 }], by: 'Piggy' });
  const c2 = cache.readChest('r18c2');
  eq(c2.opened_by, 'Piggy');
  eq(c2.slot, 'r18c2', 'a chest is named by the square it stands on');
  eq(c2.object_id, 77, 'the id is recorded — useful within a visit, never the name');
  eq(cache.allChests().length, 1, 'and only what has been looked in is reported');

  // A name that is not a square is refused rather than silently filed somewhere.
  assert.throws(() => cache.writeChest(0, {}), /named by its square/); n++;
  assert.throws(() => cache.writeChest('kitchen', {}), /named by its square/); n++;

  // RENT HAS A SIGN AND THE SIGN IS THE WHOLE MEANING. Positive is a debt that loses the
  // hall; negative is credit. An unparsed answer stores as null and must never read as a
  // guild that owes nothing.
  cache.writeRent({ due: 4200, credit: -4200, in_guild: true, hours_left: 3,
                    said: 'owes 4200 coins in rent', by: 'Piggy' });
  eq(cache.readRent().due, 4200, 'positive is owed');
  eq(cache.readRent().hours_left, 3);
  cache.writeRent({ due: -900, credit: 900, in_guild: true, said: 'positive balance of 900' });
  eq(cache.readRent().due, -900, 'negative is credit');
  cache.writeRent({ due: null, in_guild: true, said: 'something nobody parsed' });
  eq(cache.readRent().due, null, 'and an unparsed answer is null, never zero');
} finally { rmSync(dir, { recursive: true, force: true }); }


// ---------------------------------------------------------------- what a chest is called
//
// A CHEST IS ITS SQUARE. The scheme this replaced kept a slot number and matched it to a
// square, which meant a mapping — and a mapping has to be learned, can be learned from too
// short a reading, and then files one chest's contents under another chest's name. All of
// that machinery existed to protect a number that carries no information. There is no number.
//
// A chest cannot move, which is what makes a square a NAME rather than a position:
// `Chest is StorageBox is Holder` sets viObject_flags = CONTAINER_YES and declares no
// GETTABLE flag, so it is GETTABLE_NO (blakston.khd:62).
{
  n += 4;
  assert.equal(chestKey({ row: 18, col: 6 }), 'r18c6');
  assert.deepEqual(parseChestKey('r20c4'), { row: 20, col: 4 });
  // A NUMBER IS NOT A CHEST NAME. The old scheme's files are named 1.json..4.json and must
  // not be read as squares — they named a hall the guild no longer owns.
  assert.equal(parseChestKey('2'), null);
  assert.equal(parseChestKey('r18'), null);

  // A chest whose position did not arrive cannot be named, and must not be guessed at —
  // that is the entire mis-filing hazard, reduced to one branch.
  n += 3;
  assert.equal(chestKey({ row: 18 }), null);
  assert.equal(chestKey({}), null);
  assert.equal(chestKey(null), null);

  const dir2 = mkdtempSync(join(tmpdir(), 'm59-chestsq-'));
  try {
    const cache = new StorageCache({ dir: dir2 });
    cache.writeChest({ row: 18, col: 6 }, { object_id: 2576, room: 714,
      items: [{ name: 'elderberry', amount: 300 }], by: 'Fozzie' });
    cache.writeChest('r20c4', { object_id: 2577, room: 714, items: [], by: 'Gonzo' });

    n += 4;
    const one = cache.readChest('r18c6');
    assert.equal(one.slot, 'r18c6');
    assert.equal(one.row, 18);
    assert.equal(one.col, 6);
    // Addressable by the object shape too, so a caller with a room object need not stringify.
    assert.equal(cache.readChest({ row: 18, col: 6 }).object_id, 2576);

    // THE WHOLE POINT: every object id changes across a restart and the readings still
    // belong to the right chests, because no id was ever the name.
    n += 2;
    cache.writeChest('r18c6', { object_id: 99991, room: 714,
      items: [{ name: 'elderberry', amount: 260 }], by: 'Kermit' });
    assert.equal(cache.readChest('r18c6').object_id, 99991);
    assert.equal(cache.readChest('r18c6').items[0].amount, 260);

    // allChests reports what has been LOOKED IN, in a stable order — never a synthesised
    // 1..4, because there is no list of every square a chest could stand on and inventing
    // one would be inventing chests.
    n += 2;
    assert.deepEqual(cache.allChests().map(c => c.slot), ['r18c6', 'r20c4']);
    assert.equal(cache.allChests()[1].items.length, 0, 'an opened but empty chest is empty');

    // A FILE FROM THE OLD NUMBERED SCHEME IS NOT A CHEST READING.
    n += 1;
    writeFileSync(join(dir2, 'chests', '2.json'),
                  JSON.stringify({ slot: 2, items: [{ name: '', amount: 1 }] }));
    assert.deepEqual(cache.allChests().map(c => c.slot), ['r18c6', 'r20c4'],
                     'a numbered file is skipped, not parsed as a square');

    // And a slot number is refused outright rather than written somewhere odd.
    n += 1;
    assert.throws(() => cache.writeChest(2, {}), /named by its square/);
  } finally { rmSync(dir2, { recursive: true, force: true }); }
}

console.log(`storage: ${n} assertions passed`);
