#!/usr/bin/env node
// THE IDENTIFICATION SERVICE'S RULES, offline: no socket, no roster, no broker, no fleet.
//
// Everything here pins a decision that costs orc teeth to get wrong. Teeth are 325 each at
// Paddock and there is no way to get them back, so "it cast at the wrong thing" is a bill
// rather than a log line.
import assert from 'node:assert/strict';
import { ITEM_RARITY, rarityName, isUnidentified, isCursed } from './m59-items.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REVEAL, IDENTIFY, teethIn, revealable, budget,
         loadDesk, saveDesk, noteIntake, ownerOf, markReturned, deskPlan } from './m59-reveal.mjs';

let n = 0;
const ok = (what, fn) => { fn(); n++; console.log('  ok  ' + what); };

console.log('\nrarity grades — the filter the whole tool rests on');

ok('100 is unidentified, and that is the only grade reveal can act on', () => {
  assert.equal(ITEM_RARITY.UNIDENTIFIED, 100);
  assert.equal(rarityName(100), 'unidentified');
  assert.equal(isUnidentified({ rarity: 100 }), true);
});

// GetRarity tests IsIdentified BEFORE IsCursed (item.kod:723-736), so anything still reading
// 200 has already been revealed. Casting at it burns 3 teeth to discover nothing, for ever,
// on every cursed weapon in the fleet.
ok('cursed (200) is NOT work — it is already identified', () => {
  assert.equal(isUnidentified({ rarity: 200 }), false);
  assert.equal(rarityName(200), 'cursed');
});

// An item with no attributes at all skips IsIdentified's loop and returns TRUE, so plain gear
// reads 0. If this ever read as work the fleet would cast at every slice of pork it owns.
ok('normal (0) is not work', () => {
  assert.equal(isUnidentified({ rarity: 0 }), false);
  assert.equal(rarityName(0), 'normal');
});

// A missing grade is the case that matters most: before this change BOTH serializers dropped
// the field, so every item everywhere read `undefined`. Guessing "unidentified" there would
// have spent the fleet's entire tooth supply on its own pork in one pass.
ok('an ABSENT grade is not work — unknown must never read as yes', () => {
  assert.equal(isUnidentified({}), false);
  assert.equal(isUnidentified({ rarity: null }), false);
  assert.equal(isUnidentified(undefined), false);
  assert.equal(rarityName(undefined), null);
});

console.log('\nwhat counts as work');

ok('revealable takes grade 100 and nothing else', () => {
  const got = revealable([
    { id: 1, name: 'long sword', rarity: 0 },
    { id: 2, name: 'gnarled staff', rarity: 100 },
    { id: 3, name: 'cursed mace', rarity: 200 },
    { id: 4, name: 'herald shield', rarity: 4 },
    { id: 5, name: 'wand', rarity: 100 },
  ]).map(i => i.id);
  assert.deepEqual(got, [2, 5]);
});

// A NumberItem stack is money, arrows, food or reagents. None carries an attribute and the
// server has no per-stack identification, so a stack reading 100 is a bug somewhere else and
// must not be paid for here.
ok('a stack is never work, whatever it is graded', () => {
  assert.deepEqual(revealable([{ id: 9, name: 'arrows', rarity: 100, amount: 40 }]), []);
  assert.equal(revealable([{ id: 9, name: 'wand', rarity: 100, amount: 1 }]).length, 1);
});

ok('an empty or absent pack is no work and does not throw', () => {
  assert.deepEqual(revealable([]), []);
  assert.deepEqual(revealable(undefined), []);
});

console.log('\ncounting orc teeth');

ok('teeth count by amount, singular and plural, and ignore everything else', () => {
  assert.equal(teethIn([{ name: 'orc teeth', amount: 6 }]), 6);
  assert.equal(teethIn([{ name: 'orc tooth', amount: 1 }]), 1);
  // A bare object with no amount is one thing, not zero.
  assert.equal(teethIn([{ name: 'orc tooth' }]), 1);
  assert.equal(teethIn([{ name: 'slice of pork', amount: 208 }]), 0);
  assert.equal(teethIn([]), 0);
});

console.log('\nthe two spells are priced differently and it is not a detail');

ok('reveal is 3 teeth and permanent; identify is 1 and transient', () => {
  assert.equal(REVEAL.teeth, 3);
  assert.equal(REVEAL.mana, 30);
  assert.equal(IDENTIFY.teeth, 1);
  assert.equal(IDENTIFY.mana, 10);
});

console.log('\nbudget — what a pass can actually pay for');

ok('teeth are the hard limit and the shortfall is named in teeth', () => {
  const b = budget(10, 9, 200, REVEAL);
  assert.equal(b.wanted, 10);
  assert.equal(b.affordable, 3);            // 9 teeth / 3 per reveal
  assert.equal(b.teeth_needed, 30);
  assert.equal(b.teeth_short, 21);
  assert.match(b.paced_by, /orc teeth/);
});

// Mana regenerates and teeth do not. Reporting a mana shortage as a shortage would send an
// operator to a merchant to solve a problem that solves itself in a few minutes.
ok('mana paces a run, it does not block it', () => {
  const b = budget(4, 99, 30, REVEAL);
  assert.equal(b.affordable, 4);            // teeth are fine
  assert.equal(b.by_mana_now, 1);
  assert.match(b.paced_by, /regenerates/);
});

ok('with teeth and mana to spare nothing is named as the pacer', () => {
  const b = budget(2, 99, 200, REVEAL);
  assert.equal(b.affordable, 2);
  assert.equal(b.paced_by, null);
});

ok('identify stretches the same teeth three times as far', () => {
  assert.equal(budget(9, 9, 500, REVEAL).affordable, 3);
  assert.equal(budget(9, 9, 500, IDENTIFY).affordable, 9);
});

ok('no teeth means no work, and it says which shortage it is', () => {
  const b = budget(5, 0, 200, REVEAL);
  assert.equal(b.affordable, 0);
  assert.match(b.paced_by, /orc teeth/);
});


console.log('\ncursed is the same grade, and the hand is where it matters');

// NULL IS NOT ZERO, AND ZERO IS `normal`.
//
// `Number(null)` is 0, so a null grade fell through to the NORMAL case and every item whose
// rarity nobody had read came back labelled `normal`. Found on a live character the day the
// grade first shipped: Rizzo's wielded mace reported `rarity_name: "normal"` alongside a note
// saying nothing equipped was cursed, while his own keeper had been refusing to train for
// eighty consecutive passes because "mace is cursed and cannot be removed". The field added to
// answer "is this cursed" was answering "no" from an absence.
ok('a null grade has no name — it is not `normal`', () => {
  assert.equal(rarityName(null), null);
  assert.equal(rarityName(undefined), null);
  assert.equal(rarityName(''), null);
  assert.equal(rarityName(0), 'normal', 'and ZERO still is, because zero is a real grade');
});

// The two predicates were already safe here, but by luck rather than design — `Number(null)`
// is 0 and 0 is neither 100 nor 200 — so pin it rather than leave it to be re-derived.
ok('and the predicates answer false for a grade nobody has read, which is the safe direction',
   () => {
  assert.equal(isCursed({ rarity: null }), false);
  assert.equal(isUnidentified({ rarity: null }), false);
  assert.equal(isCursed({}), false);
});

// `grades_known` SAYS THE LIST ARRIVED, NOT THAT EVERY ROW IN IT IS GRADED, and the note in
// m59-broker.mjs was written as though those were the same thing. Pinned as the expression,
// because the broker cannot be imported — importing it takes the fleet lock.
ok('an ungraded row is reported as ungraded rather than folded into "none is cursed"', () => {
  const equipped = [{ name: 'mace', rarity: null }, { name: 'leather armor', rarity: 0 }];
  const ungraded = equipped.filter(e => e.rarity === null || e.rarity === undefined)
                           .map(e => e.name);
  assert.deepEqual(ungraded, ['mace']);
  const cursed = equipped.filter(e => isCursed(e)).map(e => e.name);
  assert.equal(cursed.length, 0, 'nothing READS as cursed');
  // …and that is exactly the case where the old note asserted it was clean.
  assert.ok(ungraded.length > 0, 'so the claim has to be withheld');
});

ok('200 is cursed, by the server\'s own word rather than an inference', () => {
  assert.equal(ITEM_RARITY.CURSED, 200);
  assert.equal(rarityName(200), 'cursed');
  assert.equal(isCursed({ rarity: 200 }), true);
});

// The two grades are mutually exclusive and the reveal filter must not widen to take the
// second. GetRarity tests IsIdentified before IsCursed, so a 200 has already been revealed —
// counting it as work would burn three teeth per cursed weapon in the fleet, for ever.
ok('and a cursed item is NOT revealable, which is what keeps teeth off it', () => {
  assert.equal(isUnidentified({ rarity: 200 }), false);
  assert.equal(isCursed({ rarity: 100 }), false);
  assert.equal(revealable([{ name: 'mace', rarity: 200 }]).length, 0);
});

// ABSENT IS NOT NEGATIVE. A keeper too old to send the field, and a keeper reporting a clean
// weapon, both produce `rarity: null` — and reading those the same way is the whole reason
// three checks in a row reported Rizzo's cursed mace as clean.
ok('a missing grade is not a clean one', () => {
  assert.equal(isCursed({ rarity: null }), false);
  assert.equal(isCursed({}), false);
  assert.equal(isUnidentified({ rarity: null }), false);
});

// THE REBUILD THE BROKER DOES, PINNED HERE BECAUSE THE BROKER CANNOT BE IMPORTED — importing
// it takes the fleet lock. This is the exact expression from m59-broker.mjs's KeeperProxy:
// a keeper that sends `equipment_items` carries grades, one that sends only `equipment` does
// not, and `grades_known` is what stops the second reading as "nothing is cursed".

// THE GRADE IS ON THE INVENTORY OBJECT, NOT ON THE USE-LIST ONE. BP_USE_LIST carries ids and
// little else; the rarity arrives with ToCliInventory. So the keeper's equipment serializer
// passing its use-list rows through unchanged shipped the field and still answered null —
// measured on prod, the same object id read two ways:
//
//   equipment -> { id: 8376, name: 'mace', rarity: null }
//   inventory -> { id: 8376, name: 'mace', rarity: 100, unidentified: true }
//
// This is the one place an object id may be trusted: both lists come off the SAME client, in
// one process, at one moment. Anywhere else they are renumbered by every save and recycle
// within hours.
console.log('\nthe equipped row takes its grade from the pack');
{
  const join = (equipped, inventory) => {
    const byId = new Map();
    for (const o of inventory) if (o?.id != null) byId.set(o.id, o);
    return equipped.map(o => {
      const inv = o.id != null ? byId.get(o.id) : null;
      return { name: o.name, id: o.id ?? null,
               flags: o.flags ?? inv?.flags ?? null,
               rarity: o.rarity ?? inv?.rarity ?? null };
    });
  };

  ok('an ungraded use-list row picks the grade up off the matching pack row', () => {
    const r = join([{ id: 8376, name: 'mace' }], [{ id: 8376, name: 'mace', rarity: 100 }]);
    assert.equal(r[0].rarity, 100);
    assert.equal(isUnidentified(r[0]), true);
  });

  ok('a CURSED grade crosses the same way, which is the case this exists for', () => {
    const r = join([{ id: 8380, name: 'mace' }], [{ id: 8380, name: 'mace', rarity: 200 }]);
    assert.equal(isCursed(r[0]), true);
  });

  ok('the use-list wins when it has an opinion of its own', () => {
    const r = join([{ id: 1, name: 'mace', rarity: 200 }], [{ id: 1, name: 'mace', rarity: 0 }]);
    assert.equal(r[0].rarity, 200, 'not overwritten by the pack');
  });

  // AN UNREAD PACK IS NOT AN UNGRADED ITEM. The join has to leave null alone rather than
  // invent a grade, or this becomes the same absent-reads-as-negative bug one layer down.
  ok('no matching pack row leaves the grade null rather than guessing', () => {
    const r = join([{ id: 8376, name: 'mace' }], []);
    assert.equal(r[0].rarity, null);
    assert.equal(rarityName(r[0].rarity), null, 'and null still has no name');
    assert.equal(isCursed(r[0]), false, 'so the predicate answers false, not true');
  });

  // IDS MAY ONLY BE JOINED WITHIN ONE READ. A stale id matching a recycled object is exactly
  // the trap CLAUDE.md documents; pinned here so the next person does not widen this join
  // across two separate reads.
  ok('a row with no id at all is carried through ungraded', () => {
    const r = join([{ id: null, name: 'mace' }], [{ id: 8376, name: 'mace', rarity: 200 }]);
    assert.equal(r[0].rarity, null, 'no id, no join — never matched by name');
  });
}

console.log('\nthe keeper-backed rebuild keeps both shapes apart');
{
  const rebuild = (s) => ({
    known: Array.isArray(s.equipment_items) || Array.isArray(s.equipment),
    equipped: Array.isArray(s.equipment_items)
      ? s.equipment_items.map((o, i) => ({ id: o.id ?? -1 - i, name: o.name,
          nameRsc: o.nameRsc ?? o.name, flags: o.flags ?? null, rarity: o.rarity ?? null }))
      : (s.equipment ?? []).map((name, i) => ({ id: -1 - i, name, nameRsc: name,
          flags: null, rarity: null })),
    grades_known: Array.isArray(s.equipment_items),
  });

  ok('a keeper that sends the structured list carries the grade through', () => {
    const eq = rebuild({ equipment: ['mace'],
                         equipment_items: [{ name: 'mace', id: 9001, rarity: 200 }] });
    assert.equal(eq.grades_known, true);
    assert.equal(eq.equipped[0].rarity, 200);
    assert.equal(isCursed(eq.equipped[0]), true);
    assert.equal(eq.equipped[0].id, 9001);
  });

  ok('an OLDER keeper still answers, with the names and no grades — this fleet restarts ' +
     'keepers every minute, so both shapes are live at once', () => {
    const eq = rebuild({ equipment: ['mace'] });
    assert.equal(eq.known, true);
    assert.equal(eq.equipped[0].name, 'mace');
    assert.equal(eq.equipped[0].rarity, null);
    assert.equal(eq.grades_known, false);
  });

  ok('NO SNAPSHOT AT ALL is still not "nothing equipped"', () => {
    const eq = rebuild({});
    assert.equal(eq.known, false);
    assert.equal(eq.equipped.length, 0);
    assert.equal(eq.grades_known, false);
  });
}


console.log('\nthe desk — what happens to an item after the trance');

{
  const empty = { version: 1, intake: [] };

  ok('a pack carries no provenance, so an item nobody handed in has no owner', () => {
    assert.equal(ownerOf(empty, { name: 'short sword' }), null);
  });

  ok('an intake note needs BOTH a giver and a name — an unattributable one is dropped', () => {
    const d = noteIntake(empty, { from: 'Gonzo', items: [{ name: '' }, { name: 'axe' }] });
    assert.equal(d.intake.length, 1);
    assert.equal(d.intake[0].name, 'axe');
    assert.equal(noteIntake(empty, { from: null, items: [{ name: 'axe' }] }).intake.length, 0);
  });

  ok('noteIntake is PURE — the book it was handed is unchanged', () => {
    const d = noteIntake(empty, { from: 'Gonzo', items: [{ name: 'axe' }] });
    assert.equal(empty.intake.length, 0);
    assert.equal(d.intake.length, 1);
  });

  // A NAME IS A QUEUE, NOT A KEY. Two characters hand in a short sword and the desk must not
  // invent which one it is holding.
  ok('two claims on one name are a queue, oldest first, and it SAYS how many are behind', () => {
    let d = noteIntake(empty, { from: 'Gonzo', items: [{ name: 'short sword' }], at: 100 });
    d = noteIntake(d, { from: 'Waldorf', items: [{ name: 'short sword' }], at: 200 });
    const who = ownerOf(d, { name: 'short sword' });
    assert.equal(who.from, 'Gonzo');
    assert.equal(who.queued_behind, 1);
    assert.equal(who.matched_by, 'name, oldest first');
  });

  // THE ID IS A HINT AND NEVER THE KEY. Ids are renumbered by every system save and 23% named a
  // different object within three days, so a book keyed on one starts naming somebody else's
  // property. It may still promote a row within one session, which is all it is trusted for.
  ok('an id promotes a row within a session and is never matched on alone', () => {
    let d = noteIntake(empty, { from: 'Gonzo', items: [{ name: 'short sword', id: 11 }], at: 100 });
    d = noteIntake(d, { from: 'Waldorf', items: [{ name: 'short sword', id: 22 }], at: 200 });
    assert.equal(ownerOf(d, { name: 'short sword', id: 22 }).from, 'Waldorf');
    assert.equal(ownerOf(d, { name: 'short sword', id: 22 }).matched_by, 'id and name');
    // An id that matches nothing is not evidence against the name — it falls back to the queue.
    assert.equal(ownerOf(d, { name: 'short sword', id: 999 }).from, 'Gonzo');
  });

  ok('settling a claim takes exactly one row out of the queue', () => {
    let d = noteIntake(empty, { from: 'Gonzo', items: [{ name: 'short sword' }], at: 100 });
    d = noteIntake(d, { from: 'Waldorf', items: [{ name: 'short sword' }], at: 200 });
    d = markReturned(d, { name: 'short sword' });
    assert.equal(d.intake.filter(r => r.returned).length, 1);
    assert.equal(ownerOf(d, { name: 'short sword' }).from, 'Waldorf');
    assert.equal(ownerOf(d, { name: 'short sword' }).queued_behind, 0);
  });

  ok('marking something nobody handed in changes nothing', () => {
    assert.deepEqual(markReturned(empty, { name: 'nothing' }), empty);
  });
}

console.log('\nthe desk plan — every item, including the ones still unread');

{
  const mundane = { id: 1, name: 'short sword', rarity: 0 };
  const waiting = { id: 2, name: 'long sword', rarity: 100 };

  // A BACKLOG THAT IS LEFT OUT OF THE PLAN IS AN INVISIBLE BACKLOG, which is this repository's
  // commonest failure shape. An unrevealed item is work, so it is a row with a stage.
  ok('an item still reading unidentified is a ROW, staged as awaiting_reveal', () => {
    const p = deskPlan([mundane, waiting], { mule: 'Loial the Ogier' });
    assert.equal(p.rows.length, 2);
    assert.equal(p.rows.find(r => r.id === 2).stage, 'awaiting_reveal');
    assert.equal(p.rows.find(r => r.id === 1).stage, 'revealed');
    // awaiting_reveal sorts first: it is the half somebody has to act on.
    assert.equal(p.rows[0].stage, 'awaiting_reveal');
  });

  ok('every verdict carries its destination, and unknown defaults to the mule', () => {
    const p = deskPlan([{ id: 3, name: 'thing nobody listed', rarity: 0 }],
                       { mule: 'Loial the Ogier' });
    assert.equal(p.rows[0].verdict, 'unknown');
    assert.equal(p.rows[0].route, 'mule');
    assert.equal(p.rows[0].to, 'Loial the Ogier');
  });

  // `keep` MEANS "GO HOME", AND HOME MAY BE HERE. Routing a found item to "owner" would be
  // describing a journey to where it already is.
  // A REAL `keep`, ASSERTED UNCONDITIONALLY. The first draft of this case used a mystic
  // sword, which the list routes to the MULE as sell_to_players — so the `if (route === 'owner')`
  // it was wrapped in never ran and the case proved nothing. A test that cannot fail is
  // decoration. 'of the defender' is a difficulty-8 weapon attribute and is on the keep list.
  const KEEP_LOOK = 'It bears the mark of the defender.';

  ok('a keep IS a keep — the fixture routes to the owner, or this case proves nothing', () => {
    const row = deskPlan([{ id: 4, name: 'long sword', rarity: 0, look: KEEP_LOOK }], {}).rows[0];
    assert.equal(row.verdict, 'keep');
    assert.equal(row.route, 'owner');
  });

  ok('a keep with no intake note STAYS — there is nobody to send it back to', () => {
    const row = deskPlan([{ id: 4, name: 'long sword', rarity: 0, look: KEEP_LOOK }],
                         { mule: 'Loial the Ogier' }).rows[0];
    assert.equal(row.stays, true);
    assert.equal(row.owner, null);
    assert.equal(row.to, 'Loial the Ogier');   // the finder keeps what nobody claimed
  });

  ok('...and the same item WITH a note names the character it goes back to', () => {
    const desk = noteIntake({ version: 1, intake: [] },
                            { from: 'Janice', items: [{ name: 'long sword' }] });
    const row = deskPlan([{ id: 4, name: 'long sword', rarity: 0, look: KEEP_LOOK }],
                         { desk, mule: 'Loial the Ogier' }).rows[0];
    assert.equal(row.owner, 'Janice');
    assert.equal(row.to, 'Janice');
    assert.equal(row.stays, false);
  });

  // THE SORTER DECIDES WHAT IT IS FOR AND THE MULE IS NOT AN EXCEPTION TO THAT. A mystic sword
  // is sell_to_players — no fixed merchant stocks one — so it stays with the mule even when
  // somebody handed it in. The intake note is about `keep`, not about every verdict.
  ok('an intake note does NOT drag a sell_to_players back to its finder', () => {
    const desk = noteIntake({ version: 1, intake: [] },
                            { from: 'Janice', items: [{ name: 'mystic sword' }] });
    const row = deskPlan([{ id: 5, name: 'mystic sword', rarity: 0 }],
                         { desk, mule: 'Loial the Ogier' }).rows[0];
    assert.equal(row.verdict, 'sell_to_players');
    assert.equal(row.to, 'Loial the Ogier');
  });

  ok('an empty pack is an empty plan, not a crash', () => {
    const p = deskPlan([], {});
    assert.equal(p.rows.length, 0);
    assert.equal(Object.values(p.counts).reduce((a, b) => a + b, 0), 0);
  });
}

console.log('\nthe intake book on disk');

{
  const tmp = path.join(os.tmpdir(), `m59-desk-test-${process.pid}.json`);
  try {
    ok('a missing book is an EMPTY one and says so with a null source', () => {
      const d = loadDesk({ file: tmp });
      assert.equal(d.intake.length, 0);
      assert.equal(d.source, null);
      assert.equal(d.unreadable, undefined);
    });

    ok('a round trip keeps the claims', () => {
      const d = noteIntake(loadDesk({ file: tmp }),
                           { from: 'Scooter', items: [{ name: 'chain armor', id: 7 }] });
      saveDesk(d, { file: tmp });
      const back = loadDesk({ file: tmp });
      assert.equal(back.intake.length, 1);
      assert.equal(back.intake[0].from, 'Scooter');
      assert.equal(back.source, tmp);
    });

    // A FILE THAT WILL NOT PARSE IS NOT AN EMPTY FILE. Reading it as empty would silently
    // forget who owns what and every `keep` would become a `stays`.
    ok('a corrupt book is DISTINGUISHABLE from an absent one', () => {
      fs.writeFileSync(tmp, '{ this is not json');
      const d = loadDesk({ file: tmp });
      assert.equal(d.intake.length, 0);
      assert.ok(d.unreadable, 'it has to say it could not read it');
      assert.equal(d.source, tmp);
    });
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

console.log(`\n${n} assertions, all offline.\n`);
