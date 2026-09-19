#!/usr/bin/env node
// THREE LAYERS AGAINST A RING THAT CAN NEVER COME OFF. Offline: no broker, no socket, no fleet.
//
// A cursed ring is not an ordinary bad pickup. `item.kod:514` POSTS `TryUseItem` on the picker
// the moment a cursed item enters the pack, so the item EQUIPS ITSELF, and `ItemReqUnuse`
// returns FALSE unconditionally so it never comes off. The loot decision is the wear decision
// and it is irreversible.
//
// The harness had one defence, `CURSED_ITEMS`, and it is a NAME ban — which cannot fire on an
// item whose name is still hidden. An unidentified ring of lethargy reads as an ordinary ring.
//
// Measured on prod 2026-09-19: Fozzie, Piggy, Floyd and Lew each wearing one, each pinned at
// 60 vigor of a 200 bar for life, and all four parked against a wall at FULL HEALTH for
// nineteen minutes — because the rest floor they were waiting for was 80, which the curse had
// already put out of reach.
import { UNREVEALED_JEWELLERY } from './m59-game.mjs';
import { isUnrevealed, VIGOR_MAX } from './m59-skills.mjs';
import { readFileSync } from 'node:fs';

let failed = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'yes ' : 'NO  '} ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failed++;
};

console.log('--- layer 1: never pick it up ---');
{
  const unread = (name) => ({ name, rarity: 100, amount: 1 });
  const read = (name) => ({ name, rarity: 200, amount: 1 });
  const blocked = (o) => UNREVEALED_JEWELLERY.test(o.name) && isUnrevealed(o);

  ok('an UNIDENTIFIED ring is refused', blocked(unread('ring')));
  ok('so is an unidentified amulet', blocked(unread('amulet')));
  ok('an IDENTIFIED ring is not refused here', !blocked(read('ring of lethargy')),
     'CURSED_ITEMS catches that one by name — this layer is for the ones it cannot see');
  ok('an unidentified WEAPON is still taken', !blocked(unread('mace')),
     'the wield is a separate decision and weaponRanking already guards it');
  ok('an unidentified reagent is still taken', !blocked(unread('emerald')));
  ok('a stack is never "unrevealed"', !blocked({ name: 'ring', rarity: 100, amount: 4 }),
     'isUnrevealed excludes stacks, which is how a pile of arrows stays lootable');
}

console.log('\n--- layer 3: the bar is what THIS character can reach ---');
{
  // lethring.kod: SetVigorRestThreshold(current - 20), floored at 10.
  // Points, then one division — the same arithmetic the implementation uses, and for
  // the same reason: 0.4 - 0.1 is 0.30000000000000004 and 60/200 is 0.3, so a fraction
  // subtraction leaves the bar fractionally above the vigor that should clear it.
  const ceiling = (rings) => Math.max(10, Math.round(0.4 * VIGOR_MAX) - rings * 20) / VIGOR_MAX;
  ok('uncursed rests to 80 of 200', Math.round(ceiling(0) * VIGOR_MAX) === 80);
  ok('ONE ring of lethargy rests to 60 — the number measured on all four', 
     Math.round(ceiling(1) * VIGOR_MAX) === 60);
  ok('two rings to 40', Math.round(ceiling(2) * VIGOR_MAX) === 40);
  ok('and the kod floor of 10 holds', Math.round(ceiling(9) * VIGOR_MAX) === 10,
     'SetVigorRestThreshold floors at 10, so the bar can never reach zero');
  // BOTH BARS, because they are the same mistake in two places: one decides whether to SIT
  // DOWN and the other whether to GET UP, and a cursed character failed both for ever.
  const restAt = (rings, restBelow = 0.85) => Math.min(restBelow, ceiling(rings));
  ok('a cursed character is not "hurt" at its own ceiling', !(60 / VIGOR_MAX < restAt(1)),
     `sit-down bar ${restAt(1)} against vigor ${60 / VIGOR_MAX}`);
  ok('an uncursed one still rests below 80 as before', 70 / VIGOR_MAX < restAt(0),
     'the uncursed behaviour is unchanged, which is the point of a per-character ceiling');
  ok('a cursed character clears its own bar at the vigor it actually has',
     60 / VIGOR_MAX >= ceiling(1),
     'against the old fixed 0.4 it never could, which is why they never left the wall');
}

console.log('\n--- the wiring, so a silent no-op cannot come back ---');
{
  const src = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
  const ap = src('./m59-autopilot.mjs');
  ok('the release is asked for a FARMER, not only a traveller',
     /if \(this\.hold\) await this\.releaseRestedHold\(\);/.test(ap),
     'the `&& this.suspendedJourney` gate made the farming branch unreachable');
  ok('and the bar is the per-character ceiling',
     /vig < this\.restVigorCeiling\(\)/.test(ap));
  const game = src('./m59-game.mjs');
  ok('the SIT-DOWN threshold uses the ceiling too, not the fixed cap',
     /Math\.min\(this\.policy\.restBelow, this\.restVigorCeiling\(\)\)/.test(ap),
     'fixing only the release left this one deciding a cursed character was permanently hurt');
  // CODE LINES ONLY. The first version of this matched the explanatory comment above
  // `restVigorCeiling`, which quotes the old expression on purpose — a source-text test that
  // reads prose is testing the documentation, not the program.
  const codeLines = ap.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const bare = codeLines.filter(l => /<\s*REST_VIGOR_CAP/.test(l));
  ok('no vigor comparison still uses the bare global cap', bare.length === 0,
     bare.join(' | ').slice(0, 120));
  ok('the loot path refuses unrevealed jewellery',
     /UNREVEALED_JEWELLERY\.test\(n\) && skills\.isUnrevealed\(o\)/.test(game));
}

console.log(failed ? `\n${failed} FAILED` : '\nall good');
process.exit(failed ? 1 : 0);
