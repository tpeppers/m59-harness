// OFFLINE. Pins the overfarm policy: the mixture arithmetic the operator predicted, the
// four refusals in m59-overfarm.mjs's header, and the phase boundaries.
//
// THE CASE WORTH READING IS THE FIRST ONE. The operator's prediction — sift 150% of a 50/50
// stream with A preferred and come home about 75/25 — is not a tuning target that could be
// adjusted to taste. It falls out of the definition of `overfarm_percent` as bulk sifted
// against pack capacity, and if it ever stops coming out at 75/25 then the unit has drifted
// and every number the strategy reports is in a different currency from the one it claims.
//
// No socket, no roster, no broker. `node tools/m59-overfarm-test.mjs`.
import { readFileSync } from 'node:fs';
import { OVERFARM_DEFAULTS, normalizeOverfarm, unitCost, unitWorth, scoreItem,
         overfarmPhase, planPickup, siftValue, mixtureOf } from './m59-overfarm.mjs';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) { pass++; } else { fail++; console.log(`  FAIL: ${what}`); } };
const eq = (a, b, what) => ok(Object.is(a, b), `${what} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`);
const section = (s) => console.log(`\n${s}`);

const ON = { ...OVERFARM_DEFAULTS, enabled: true };
const share = (mix, name) => mix.find(m => m.name === name)?.percent ?? 0;

// ---------------------------------------------------------------------------------------
section('the operator\'s prediction: 150% of a 50/50 stream comes home 75/25');
{
  // Ruby and emerald both cost 1 against the pack, so the mixture is decided purely by the
  // ratio and the ranking — which is the point. Capacity 100, sift 150.
  const stream = [];
  for (let i = 0; i < 75; i++) stream.push({ name: 'ruby', amount: 1 }, { name: 'emerald', amount: 1 });
  const v = siftValue({ stream: stream.slice(0, 150), capacity: 100, policy: ON });

  eq(v.sifted, 150, 'sifted the whole stream');
  eq(v.sifted_percent, 150, 'which is 150% of capacity');
  const baselineMix = mixtureOf(siftValueKept(stream.slice(0, 150), 100, ON, 'baseline'));
  eq(share(v.mixture, 'ruby'), 75, 'ruby is 75% of the pack that came home');
  eq(share(v.mixture, 'emerald'), 25, 'emerald is 25%');
  eq(share(baselineMix, 'ruby'), 50, 'a greedy lap over the same stream would have been 50% ruby');
  ok(v.gain > 0, 'the overfarm is worth more than the greedy lap');
  eq(v.gain, (75 * 140 + 25 * 21) - (50 * 140 + 50 * 21), 'and the gain is exactly the difference of the two packs');
}

// A preference reverses the ranking, which is what the slider is for.
{
  const stream = [];
  for (let i = 0; i < 75; i++) stream.push({ name: 'ruby', amount: 1 }, { name: 'emerald', amount: 1 });
  const policy = { ...ON, prefer: ['emerald'], avoid: ['ruby'] };
  const v = siftValue({ stream, capacity: 100, policy });
  eq(share(v.mixture, 'emerald'), 75, 'preferring the cheaper item carries 75% of it home instead');
  ok(v.gain < 0, 'and it costs shillings to do so, which the ledger states rather than hides');
}

// 100% is "no overfarming": one capacity sifted, so selection has nothing to choose between.
{
  const stream = [];
  for (let i = 0; i < 50; i++) stream.push({ name: 'ruby', amount: 1 }, { name: 'emerald', amount: 1 });
  const v = siftValue({ stream, capacity: 100, policy: { ...ON, overfarm_percent: 100 } });
  eq(v.gain, 0, 'sifting exactly one pack of goods leaves nothing to trade away');
  eq(share(v.mixture, 'ruby'), 50, 'so the mixture is the stream\'s own');
}

// ---------------------------------------------------------------------------------------
section('an unknown value is not a value of zero');
{
  // THE UNPRICED ARE THE MAJORITY, NOT THE EDGE CASE. 160 of the 249 items in the weight
  // table have no entry in the value table — every unique, every magical item, most quest
  // gear. `ancient shield` is one of them: 100 cost, no price.
  const UNPRICED = 'ancient shield';
  const s = scoreItem(UNPRICED, ON);
  eq(s.score, null, 'an unpriced item scores null, not 0');
  eq(s.rankable, false, 'and says it is unrankable');
  eq(s.cost, 100, 'while still costing what it costs');

  // A name nothing has ever heard of must not throw — the input is read off the floor of a
  // monster room, which is exactly where an unknown name appears.
  const nonsense = scoreItem('a thing nobody has ever priced', ON);
  eq(nonsense.rankable, false, 'an unresolvable name is unrankable rather than an exception');
  eq(nonsense.cost, null, 'with no cost either');

  // It is takeable when there is room, even in the selective phase where everything else is
  // being judged on a score it does not have.
  const plan = planPickup({ floor: [{ id: 1, name: UNPRICED, amount: 1 }],
                            pack: [{ name: 'ruby', amount: 900 }],
                            capacity: 1000, sifted: 900, policy: ON });
  eq(plan.phase, 'selective', 'a 90%-full pack is in the selective phase');
  eq(plan.take.length, 1, 'an unrankable item is still taken when the pack has room for it');
  ok(/not a worthless one/.test(plan.take[0].why), 'and the reason says why it was taken anyway');

  // ...and it is never the thing dropped to make room for something better.
  const full = planPickup({
    floor: [{ id: 2, name: 'ruby', amount: 1 }],
    pack: [{ name: UNPRICED, amount: 1 }],
    capacity: 100, sifted: 120, policy: ON,
  });
  eq(full.pack_percent, 100, 'a pack holding one ancient shield is full');
  eq(full.swaps.length, 0, 'and it is never dropped to make room for a ruby');
  eq(full.take.length, 0, 'so the ruby is left rather than bought with an unknown');
  ok(/nothing in the pack may be dropped/.test(full.leave[0].why), 'and the refusal says why');
}

// ---------------------------------------------------------------------------------------
section('protected is protected');
{
  const full = planPickup({
    floor: [{ id: 3, name: 'ruby', amount: 5 }],
    pack: [{ name: 'spider eye', amount: 11 }],   // 9 cost each, the worst score in the game
    capacity: 100, sifted: 120, policy: ON,
    protect: ['spider eye'],
  });
  eq(full.swaps.length, 0, 'a protected item is not dropped even though it is the worst thing carried');
  eq(full.take.length, 0, 'so nothing is taken');

  const unprotected = planPickup({
    floor: [{ id: 3, name: 'ruby', amount: 5 }],
    pack: [{ name: 'spider eye', amount: 11 }],
    capacity: 100, sifted: 120, policy: ON,
  });
  ok(unprotected.swaps.length > 0, 'and without the protection the same swap happens');
  eq(unprotected.swaps[0].drop[0].name, 'spider eye', 'dropping the worst-scoring thing first');

  // Plural and singular are the same entry, which is where a protection list usually leaks.
  const plural = planPickup({
    floor: [{ id: 4, name: 'ruby', amount: 5 }],
    pack: [{ name: 'orc tooth', amount: 34 }],
    capacity: 100, sifted: 120, policy: ON, protect: ['orc teeth'],
  });
  eq(plural.swaps.length, 0, '"orc teeth" protects "orc tooth"');
}

// ---------------------------------------------------------------------------------------
section('a pack has two ceilings, and cost is the worse of them');
{
  const sword = unitCost('long sword');
  eq(sword.weight, 80, 'a long sword weighs 80');
  eq(sword.bulk, 60, 'and is 60 bulk');
  eq(sword.cost, 80, 'so it costs 80 against the pack, not 60');
  const mush = unitCost('mushroom');
  eq(mush.weight, 2, 'a mushroom weighs 2');
  eq(mush.bulk, 5, 'and is 5 bulk');
  eq(mush.cost, 5, 'so the bulk binds instead');
}

// ---------------------------------------------------------------------------------------
section('a swap must clear the margin');
{
  // Elderberry 4.67, orc tooth 9.33 — a factor of exactly 2.
  const wide = planPickup({
    floor: [{ id: 5, name: 'orc tooth', amount: 1 }],
    pack: [{ name: 'elderberry', amount: 34 }],
    capacity: 100, sifted: 120, policy: { ...ON, swap_margin: 1.5 },
  });
  ok(wide.swaps.length > 0, 'a 2x improvement clears a 1.5x margin');

  const narrow = planPickup({
    floor: [{ id: 5, name: 'orc tooth', amount: 1 }],
    pack: [{ name: 'elderberry', amount: 34 }],
    capacity: 100, sifted: 120, policy: { ...ON, swap_margin: 3 },
  });
  eq(narrow.swaps.length, 0, 'and does not clear a 3x one');
  ok(/does not beat by 3x/.test(narrow.leave[0].why), 'the refusal names the margin it failed');
}

// ---------------------------------------------------------------------------------------
section('the phases');
{
  eq(overfarmPhase({ packPercent: 10, sifted: 10, capacity: 100, policy: { ...ON, enabled: false } }).phase,
     'off', 'a disabled policy is off');
  eq(overfarmPhase({ packPercent: 10, sifted: 10, capacity: 100, policy: ON }).phase,
     'fill', 'below the threshold, take everything');
  eq(overfarmPhase({ packPercent: 85, sifted: 85, capacity: 100, policy: ON }).phase,
     'selective', 'at the threshold exactly, be selective');
  eq(overfarmPhase({ packPercent: 100, sifted: 100, capacity: 100, policy: ON }).phase,
     'overfarm', 'full but under the sift target, keep killing');
  eq(overfarmPhase({ packPercent: 100, sifted: 150, capacity: 100, policy: ON }).phase,
     'done', 'at the sift target, go home');
  eq(overfarmPhase({ packPercent: 40, sifted: 150, capacity: 100, policy: ON }).phase,
     'done', 'the sift target ends the lap even with a pack that emptied into a chest');
  eq(overfarmPhase({ packPercent: 95, sifted: 95, capacity: null, policy: ON }).phase,
     'fill', 'an unknown capacity cannot size selectivity, so it takes everything');
}

// ---------------------------------------------------------------------------------------
section('off behaves exactly as the fleet did before this existed');
{
  const floor = [{ id: 1, name: 'spider eye', amount: 3 }, { id: 2, name: 'ruby', amount: 1 }];
  const off = planPickup({ floor, pack: [], capacity: 100, policy: { ...ON, enabled: false } });
  eq(off.take.length, 2, 'a disabled policy takes everything on the floor');
  eq(off.leave.length, 0, 'and leaves nothing');
}

// ---------------------------------------------------------------------------------------
section('the policy reader keeps the default rather than unsetting it');
{
  const n = normalizeOverfarm({ enabled: true, selective_at: 90, overfarm_percent: 'lots',
                                nonsense: 1, avoid: ['spider eye'] });
  eq(n.enabled, true, 'enabled is read');
  eq(n.selective_at, 90, 'a usable value is taken');
  eq(n.overfarm_percent, 150, 'an unusable one keeps the committed default');
  ok(n.rejected.some(r => /overfarm_percent/.test(r)), 'and says so');
  ok(n.unknown.includes('nonsense'), 'an unrecognised key is reported');
  ok(!Object.hasOwn(n, 'nonsense'), 'and never applied');
  eq(normalizeOverfarm(null).enabled, false, 'silence is not an empty policy, it is off');
  eq(normalizeOverfarm(null).selective_at, OVERFARM_DEFAULTS.selective_at, 'with the defaults intact');
  ok(normalizeOverfarm({ selective_at: 900 }).rejected.length > 0, 'an out-of-range value is refused and reported');
  eq(normalizeOverfarm({ selective_at: 900 }).selective_at, 85, 'and the default survives it');
}

// ---------------------------------------------------------------------------------------
section('value lookups resolve the name the table actually uses');
{
  eq(unitWorth('herb').known, true, '"herb" is priced through "herbs"');
  eq(unitWorth('herbs').value, unitWorth('herb').value, 'and both give the same number');
}

// ---------------------------------------------------------------------------------------
// THE POLICY HAS TO SURVIVE THE TRANSPORT, and in this repository that is the half that
// breaks. `rarity` was added to both serializers and dropped by the rebuild in between, so
// a sweep answered "nothing in the fleet reads unidentified" while the keeper's own state,
// read thirty seconds earlier, showed two unidentified items. The four checks below are
// each one link of the chain that carries `overfarm` from a DUM slider to a pickup.
section('the policy survives the wiring');
{
  const src = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');

  // Read as text rather than imported: importing m59-broker.mjs RUNS it — it takes the
  // fleet lock and starts rejoin timers. CLAUDE.md says so in as many words.
  const broker = src('./m59-broker.mjs');
  ok(/^\s*overfarm: \{ type: \['object', 'null'\]/m.test(broker),
     'the autopilot tool declares an overfarm argument');
  ok(/p\.policy\.overfarm = policy;/.test(broker), 'and the start handler writes it to the policy');
  ok(/if \(a\.overfarm == null\) p\.policy\.overfarm = null;/.test(broker),
     'with null meaning off rather than "leave it alone"');
  ok(/out\.overfarm_notes = overfarmNotes/.test(broker),
     'and a rejected or unrecognised setting comes back in the reply rather than vanishing');
  ok(/'farm_delivery', 'overfarm'\]/.test(broker), 'overfarm is a strategy-stats category');

  const autopilot = src('./m59-autopilot.mjs');
  ok(/^\s*overfarm: null,/m.test(autopilot), 'the autopilot policy defaults it to null — inert, not empty');
  ok(/s\.setOverfarmPolicy\?\.\(this\.policy\.overfarm \?\? null, this\.protectedItemNames\(\)\)/.test(autopilot),
     "every pass installs it on the session with the fleet's own protected names");
  ok(/this\.detailEvent\('overfarm', 'lap'/.test(autopilot), 'and a finished lap is recorded');

  const game = src('./m59-game.mjs');
  ok(/overfarm = this\._overfarmPolicy \?\? null/.test(game),
     'lootFloor defaults the policy from the session, so all six call sites inherit it');
  ok(/setOverfarmPolicy\(policy = null, protect = \[\]\)/.test(game), 'the session accepts a policy');
  ok(/endOverfarmLap\(\)/.test(game), 'and can close a lap');

  const stats = src('./m59-strategy-stats.mjs');
  ok(/category === 'overfarm' \? policy\?\.overfarm\?\.enabled/.test(stats),
     'the record stays on when overfarm is on, even with the broad stats switch off');
}

// A helper used by the first section: the greedy pack, for comparison.
function siftValueKept(stream, capacity, policy) {
  let used = 0; const kept = [];
  for (const o of stream) {
    const r = scoreItem(o.name, policy);
    const c = (r.cost ?? 0) * (Number(o.amount) || 1);
    if (!(c > 0) || used + c > capacity) continue;
    used += c; kept.push({ ...o, rank: r });
  }
  return kept;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
