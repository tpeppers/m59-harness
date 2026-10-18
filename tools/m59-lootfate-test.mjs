// WHAT BECAME OF THE DROPS — offline, no socket, no roster. Pins m59-killdrop.mjs (what a kill
// dropped and why each piece was left) and m59-lootfate.mjs (following an id to its fate).
import { killDropItems, leftReason } from './m59-killdrop.mjs';
import { lootFate, departureFate } from './m59-lootfate.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.log('FAIL', name, detail); }
};

// ---------------------------------------------------------------- killDropItems
{
  const floor = [
    { id: 1, name: 'mushroom', amount: 1 },                     // there before the fight
    { id: 2, name: 'ring', icon_rsc: 30600, unrevealed: true },
    { id: 3, name: 'long sword' },
    { id: 4, name: 'elderberry', amount: 4 },
    { id: 5, name: 'troll tooth' },
  ];
  const items = killDropItems({ floor, before: new Set([1]),
    taken: [{ id: 3 }, { id: 4 }],
    refused: [{ item: 'ring (unidentified — a cursed ring equips itself on pickup)', why: 'CURSED — it equips itself' }] });
  ok('only what arrived during the fight is the drop', items.map(i => i.id).join() === '2,3,4,5');
  ok('taken is marked taken', items.find(i => i.id === 3).taken === true);
  ok('a name-only refusal finds its item, suffix and all', /CURSED/.test(items.find(i => i.id === 2).why));
  ok('the unidentified ring keeps its icon', items.find(i => i.id === 2).icon_rsc === 30600
     && items.find(i => i.id === 2).unrevealed === true);
  ok('an item nobody refused says it was not attempted', /not attempted/.test(items.find(i => i.id === 5).why));
  ok('a stack carries its amount', items.find(i => i.id === 4).amount === 4);
  ok('no before-snapshot means no row, not an empty one', killDropItems({ floor }) === null);
  const twoRings = killDropItems({ floor: [{ id: 7, name: 'ring' }, { id: 8, name: 'ring' }], before: new Set(),
    refused: [{ item: 'ring', why: 'CURSED — x' }] });
  ok('one name-only refusal explains one item, not every item of that name',
     /CURSED/.test(twoRings[0].why) && /not attempted/.test(twoRings[1].why));
  const cancelled = killDropItems({ floor: [{ id: 9, name: 'axe' }], before: new Set(), cancelled: true });
  ok('a cancelled pass says so', /cancelled/.test(cancelled[0].why));
}

ok('leftReason keeps the shouted label', leftReason('CURSED — it equips itself') === 'cursed');
ok('leftReason keeps the first clause', leftReason('more than seven squares away, and we are holding') === 'more than seven squares away');

// ---------------------------------------------------------------- departureFate
{
  const fleet = new Set(['kermit', 'raphael']);
  ok('drop is discarded', departureFate({ after: 'drop' }, fleet) === 'discarded');
  ok('apply is used', departureFate({ after: 'apply' }, fleet) === 'used');
  ok('a trade with a merchant is a sale', departureFate({ after: 'accept_offer', to: 'Kardde the smith' }, fleet) === 'sold');
  ok('a trade with a fleet-mate is a hand-off', departureFate({ after: 'accept_offer', to: 'Raphael' }, fleet) === 'handed to a fleet-mate');
  ok('a trade with nobody recorded is not guessed', departureFate({ after: 'accept_offer' }, fleet) === 'traded (counterparty unrecorded)');
  ok('nothing asked for is unexplained', departureFate({ after: null }, fleet) === 'left unexplained');
}

// ---------------------------------------------------------------- lootFate
{
  const T = 1_000_000;
  const ev = (t, kind, character, extra) => ({ t, kind, character, ...extra });
  const events = [
    ev(T, 'killed', 'Kermit', { creature: 'troll' }),
    ev(T + 1, 'kill_drop', 'Kermit', { creature: 'troll', room: 599, items: [
      { id: 10, name: 'ring', icon_rsc: 111, unrevealed: true, taken: false, why: 'CURSED — x' },
      { id: 11, name: 'ring', icon_rsc: 222, unrevealed: true, taken: false, why: 'CURSED — x' },
      { id: 12, name: 'long sword', taken: true },
      { id: 13, name: 'elderberry', amount: 3, taken: true },
      { id: 14, name: 'troll tooth', taken: true },
      { id: 15, name: 'hammer', taken: true },
    ] }),
    // A fleet-mate in the same room claims the same floor: counted once.
    ev(T + 2, 'kill_drop', 'Piggy', { creature: 'troll', items: [{ id: 12, name: 'long sword', taken: false, why: 'x' }] }),
    ev(T + 3, 'looted', 'Kermit', { items: [{ id: 12, name: 'long sword' }, { id: 13, name: 'elderberry', amount: 3 },
                                             { id: 14, name: 'troll tooth' }, { id: 15, name: 'hammer' }] }),
    // A later sweep picks one of the rings up after all.
    ev(T + 4, 'looted', 'Kermit', { items: [{ id: 11, name: 'ring' }] }),
    // The sword goes to Raphael, who sells it; the tooth goes to Raphael and stays.
    ev(T + 5, 'left_pack', 'Kermit', { after: 'accept_offer', to: 'Raphael', items: [{ id: 12 }] }),
    ev(T + 6, 'left_pack', 'Raphael', { after: 'accept_offer', to: 'Kardde the smith', items: [{ id: 12 }] }),
    ev(T + 7, 'left_pack', 'Kermit', { after: 'accept_offer', to: 'Raphael', items: [{ id: 14 }] }),
    ev(T + 8, 'left_pack', 'Kermit', { after: null, items: [{ id: 15 }] }),
    ev(T + 9, 'died', 'Kermit', {}),
    // Before the window: ignored.
    ev(T - 10_000, 'kill_drop', 'Kermit', { items: [{ id: 99, name: 'axe', taken: false, why: 'x' }] }),
  ];
  const classOf = id => ({ 111: 'RingOfLethargy', 222: 'RingFireResistance' })[id] ?? null;
  const r = lootFate(events, { sinceMs: T - 1, classOf });
  const fate = id => r.items.find(i => i.id === id)?.fate;
  ok('an id claimed by two kill rows is counted once', r.total.dropped === 6, r.total.dropped);
  ok('drops before the window are not counted', !r.items.some(i => i.id === 99));
  ok('a sword handed on and sold by the receiver is SOLD', fate(12) === 'sold', fate(12));
  ok('a tooth handed on and kept is held by a fleet-mate', fate(14) === 'held by a fleet-mate', fate(14));
  ok('an unexplained departure beside a death is lost on a death', fate(15) === 'lost on a death', fate(15));
  ok('a stack is merged, not traced', fate(13) === 'merged into a stack', fate(13));
  ok('a ring left on the floor is left, with its reason', fate(10) === 'left on the floor'
     && r.items.find(i => i.id === 10).left_why === 'cursed');
  ok('a ring a later sweep picked up counts as picked up', fate(11) === 'still carried', fate(11));
  const ring = r.groups.find(g => g.key === 'ring (unidentified)');
  ok('unidentified rings group under one name', ring?.dropped === 2 && ring?.taken === 1);
  ok('and split by icon class beneath it', ring?.sub.map(s => s.key).sort().join() === 'RingFireResistance,RingOfLethargy');
  ok('kills are counted for coverage', r.kills === 1 && r.drop_rows === 2);
  const only = lootFate(events, { sinceMs: T - 1, item: 'ring', classOf });
  ok('--item narrows to one kind', only.total.dropped === 2);
  const none = lootFate(events.filter(e => e.kind !== 'kill_drop'), { sinceMs: T - 1 });
  ok('with no kill_drop rows it says what was picked up, not a share', none.pickups_only?.['long sword'] === 1
     && none.total.dropped === 0);
}

console.log(`m59-lootfate-test: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
