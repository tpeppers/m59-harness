#!/usr/bin/env node
// A SWEEP THAT HAS STOPPED PAYING SHOULD STOP RUNNING SO OFTEN.
// Offline: no broker, no socket, no roster, no fleet, no spawn.
//
// `m59-supervise.mjs` dispatches `m59-reclaim.mjs` every 180 seconds to walk to recent death
// sites and pick the fleet's own drops back up. The short interval is deliberate and the
// argument for it is sound — drop value decays, so an hourly sweep arrives after the world
// has swept up.
//
// WHAT THAT ARGUMENT DID NOT ACCOUNT FOR is a sweep that cannot reach the site at all.
// Measured on prod 2026-09-19 across two consecutive rounds: 1,419 recorded death sites, the
// newest six tried each time, TWELVE attempts, "nobody can route there" on every one, and
// `recovered 0 item stack(s)` both times. The newest sites were in 598 and 599 — the rooms
// this fleet dies in — which are exactly the rooms nothing can plan a route to. Deaths
// concentrate where routing fails, so the sites most worth recovering are the least
// reachable, and the sweep scores zero for as long as that holds.
//
// IT IS A BACKOFF, NOT A ROOM BAN, and that distinction is the whole design. A room becomes
// routable again when a bake is repaired or a body moves, so a permanent skip would outlive
// its reason — the failure mode this repository has already hit with square-keyed memories.
// Only the FREQUENCY is conserved, and any recovery at all restores it immediately.
import { reclaimVerdict } from './m59-supervise.mjs';

let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + what); }
  else { fail++; console.log('  FAIL ' + what + (extra ? '  ' + extra : '')); }
};

// THE REAL THING, copied verbatim out of substrate/supervise-prod.log rather than
// paraphrased. A gate tested against a sentence I wrote myself would pin my spelling.
const DRY_SWEEP = `1419 recorded death sites; trying the newest 6
couriers fit to travel (armed, >=80% health, >=100 vigor): Kermit, Waldorf, Raphael son of Mephistopheles, Animal, Robin
  Uuuu's site (room 598): nobody can route there
  Rrrr's site (room 598): nobody can route there
  Scooter's site (room 599): nobody can route there
  Gonzo's site (room 599): nobody can route there
  Loial the Ogier's site (room 598): nobody can route there
  Loial the Ogier's site (room 39): nobody can route there

recovered 0 item stack(s)`;

const PAID_SWEEP = DRY_SWEEP.replace('recovered 0 item stack(s)', 'recovered 3 item stack(s)');
const BASE = 180_000, MAX = 1_800_000;

console.log('\nTHE MEASURED CASE: TWELVE ATTEMPTS, NOTHING RECOVERED');
{
  const v = reclaimVerdict(DRY_SWEEP, { dry: 0, baseMs: BASE, maxMs: MAX });
  ok('reads the sweep\'s own sentence rather than guessing', v.got === 0, String(v.got));
  ok('and counts the unroutable sites, which is the diagnosis', v.unroutable === 6, String(v.unroutable));
  ok('does not call it paid', v.paid === false);
  ok('and doubles the interval', v.everyMs === 2 * BASE, String(v.everyMs / 1000) + 's');
}

console.log('\nIT BACKS OFF GEOMETRICALLY AND STOPS AT A CEILING');
{
  let dry = 0, every = BASE;
  const seen = [];
  for (let i = 0; i < 12; i++) {
    const v = reclaimVerdict(DRY_SWEEP, { dry, baseMs: BASE, maxMs: MAX });
    dry = v.dry; every = v.everyMs; seen.push(Math.round(every / 1000));
  }
  // Strictly increasing UNTIL the ceiling, flat after it. The first draft of this asserted
  // seen[3] < seen[6] and failed on correct behaviour, because by the fourth dry sweep it has
  // already capped — the assertion was testing that the ceiling did not work.
  const climbing = seen.slice(1).every((v, i) => v > seen[i] || v === MAX / 1000);
  ok('the interval climbs until it caps, then holds',
     climbing && seen[0] === 360 && seen[2] > seen[0], seen.slice(0, 7).join('s ') + 's');
  ok('and never exceeds the ceiling', Math.max(...seen) === MAX / 1000, Math.max(...seen) + 's');
  // A RUNAWAY EXPONENT IS THE OTHER WAY TO BREAK THIS. 2**dry with dry unbounded overflows
  // into Infinity and then into NaN arithmetic; the min() on the exponent is what stops it.
  ok('and is a finite number after many dry sweeps', Number.isFinite(every) && every > 0, String(every));
}

console.log('\nONE RECOVERY RESTORES IT IMMEDIATELY — THIS IS NOT A BAN');
{
  const v = reclaimVerdict(PAID_SWEEP, { dry: 8, baseMs: BASE, maxMs: MAX });
  ok('a paying sweep is recognised', v.paid === true && v.got === 3, String(v.got));
  ok('the dry streak resets to zero', v.dry === 0, String(v.dry));
  ok('and the interval goes straight back to the base, not halfway',
     v.everyMs === BASE, String(v.everyMs / 1000) + 's');
  // The sites it could not route to are still reported even on a paying sweep, because that
  // is the number that says WHY a good sweep was only partly good.
  ok('and the unroutable count survives a payday', v.unroutable === 6, String(v.unroutable));
}

console.log('\nSILENCE IS DRY, NOT PAID');
{
  // A sweep killed by the six-minute SIGTERM, or one that threw, never prints its total.
  // Defaulting that to "paid" would hold the short interval for ever on a sweep that is not
  // even finishing — the failure mode is indistinguishable from success from the outside,
  // which is the shape this repository keeps getting caught by.
  for (const [label, out] of [['no output at all', ''],
                              ['killed mid-sweep', '1419 recorded death sites; trying the newest 6'],
                              ['threw', 'reclaim threw — socket hang up']]) {
    const v = reclaimVerdict(out, { dry: 0, baseMs: BASE, maxMs: MAX });
    ok(`${label} counts as dry`, v.paid === false && v.dry === 1, JSON.stringify(v));
  }
}

console.log('\nAND IT READS THE NUMBER, NOT THE PRESENCE OF THE WORD');
{
  const v = reclaimVerdict('recovered 12 item stack(s)', { dry: 3, baseMs: BASE, maxMs: MAX });
  ok('a double-digit total is read whole', v.got === 12, String(v.got));
  const z = reclaimVerdict('recovered 0 item stacks', { dry: 0, baseMs: BASE, maxMs: MAX });
  ok('the singular/plural tail does not change the reading', z.got === 0 && z.paid === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
