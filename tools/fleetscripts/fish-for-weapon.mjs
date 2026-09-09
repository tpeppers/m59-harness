// CAST CREATE WEAPON UNTIL IT PRODUCES THE ONE YOU ASKED FOR — OR REFUSE BEFORE STARTING.
//
// PUBLIC, and deliberately naive: cast, look at what appeared, drop it if it is wrong, cast
// again. The interesting part is not the loop, it is the REFUSAL in front of it.
//
// ---------------------------------------------------------------- what the spell does
//
// Create Weapon does not grant a choice. It rolls a ladder (creaweap.kod:66-107):
//
//     iNum = Random(iSpellPower/3, iSpellPower)
//
//      <20 Mace | <30 ShortSword | <45 Hammer | <60 Axe | <75 LongSword
//      <95 Scimitar | else MysticSword
//
// Both ends of the range move with spell power, which is what makes this worth writing
// down: a HIGHER ability does not mean "everything the low one could make, plus more". It
// slides the whole window upward and drops the bottom weapons off the end.
//
//     spell power   P(short sword)   what can appear
//        15             0%           Mace only
//        20           6.7%           Mace, ShortSword
//        29          47.6%           Mace, ShortSword           <- the sweet spot
//        45          32.3%           Mace .. Axe
//        89           1.6%           ShortSword .. Scimitar
//        90             0%           Hammer and up — never a short sword again
//
// So a character can be TOO GOOD at this spell to make the weapon it wants, and looping
// would then never terminate. That is the case this file exists to catch: `plan` computes
// the reachable set and throws with the arithmetic rather than casting even once.
//
// ---------------------------------------------------------------- lowering spell power
//
// The lever is ARMOUR, not the weapon in hand — I had this backwards at first and the
// source is unambiguous. `GetSpellPower` sums `GetSpellModifier` over everything the
// character is USING (spell.kod:2096-2102), and melee weapons set no modifier at all:
// mace, hammer, axe and short sword are all 0. What carries a real penalty is armour —
// chain -15, scale and nerudite -20, base armour -25, plate -30, helmets -5 — and bows,
// at -30.
//
// So `wear` below names armour to put ON to bring the number DOWN into the reachable band.
// Wielding a hammer to "weigh down" the roll does nothing whatsoever.
//
// ---------------------------------------------------------------- and do it alone
//
// `room` sends the character somewhere empty first. Nothing here needs solitude for
// correctness — the weapons land in the caster's own pack — but a fishing trip drops a
// pile of rejected maces on the floor, and dropping them where the fleet is farming leaves
// litter that the loot pass will pick straight back up.
import { walk, act, verify } from '../m59-fleetscript.mjs';

// The ladder, as bands of the roll. Kept in the shape the source has it so a change there
// is a change here and not a translation.
export const WEAPON_BANDS = Object.freeze([
  { name: 'mace', lo: 0, hi: 20 },
  { name: 'short sword', lo: 20, hi: 30 },
  { name: 'hammer', lo: 30, hi: 45 },
  { name: 'axe', lo: 45, hi: 60 },
  { name: 'long sword', lo: 60, hi: 75 },
  { name: 'scimitar', lo: 75, hi: 95 },
  { name: 'mystic sword', lo: 95, hi: Number.POSITIVE_INFINITY },
]);

/**
 * Can a caster at this spell power ever roll into this band, and how often?
 *
 * `Random(sp/3, sp)` is inclusive at both ends and the division is integer, which is why
 * this is written out rather than approximated: the difference between "1.6% and rare" and
 * "0% and never" is the whole point of the check.
 */
export function chanceOf(name, spellPower) {
  const band = WEAPON_BANDS.find(b => b.name === String(name).toLowerCase());
  if (!band) return null;
  const sp = Math.floor(Number(spellPower));
  if (!Number.isFinite(sp) || sp < 1) return null;
  const lo = Math.floor(sp / 3), hi = sp;
  if (hi < band.lo || lo >= band.hi) return 0;
  const overlap = Math.min(band.hi - 1, hi) - Math.max(band.lo, lo) + 1;
  return Math.max(0, overlap) / (hi - lo + 1);
}

/** Everything reachable at this spell power, for an error message worth reading. */
export const reachableAt = spellPower =>
  WEAPON_BANDS.filter(b => (chanceOf(b.name, spellPower) ?? 0) > 0).map(b => b.name);

export const script = {
  name: 'fish-for-weapon',
  describe: 'Cast Create Weapon until it yields a named weapon, refusing if it never could.',
  recipe: {
    effect: 'Conjures weapons until one of them is the weapon you asked for. Refuses up front ' +
            'when the caster CANNOT produce it at any power, instead of casting until ' +
            'the reagents run out.',
    run: 'fish-for-weapon agents=<a> want="short sword" power=<n>',
    needs: ['Create Weapon, and the mana and reagents for repeated casts',
            'spell power inside the band that yields the wanted weapon — armour can be worn ' +
              'to LOWER power into a reachable band'],
    cost: { time: 'up to maxCasts (12 by default), each a cast plus a settle',
            reagents: 'one cast worth of reagents per attempt', risk: 'none if done somewhere empty',
            estimate: 'attempts are bounded by maxCasts; the yield per cast is the band table in this file' },
    scales: 'Higher spell power moves the band upward, so the wanted weapon can become ' +
            'unreachable by getting BETTER at the spell.',
  },

  provenance: {
    pinned: 'dbcc73e', verified: '2026-09-08',
    touches: ['tools/m59-fleetscript.mjs', 'tools/m59-broker.mjs',
              'tools/m59-keeper-process.mjs'],
  },

  params: {
    agents: { type: 'agents', required: true, describe: 'who is casting' },
    want: { required: true, describe: 'the weapon to fish for, e.g. "short sword"' },
    spellPower: { type: 'number', required: true,
      describe: 'the caster\'s Create Weapon spell power — half its ability, plus bonuses' },
    room: { type: 'number', required: true,
      describe: 'somewhere empty to do this in, so rejects are not dropped on the farm floor' },
    // A CAP, BECAUSE A 6.7% CHANCE IS NOT ZERO AND ALSO NOT A PLAN. At the sweet spot this
    // is ~2 casts; at the edge of the band it is ~15 and each one costs mana.
    maxCasts: { type: 'number', default: 12, describe: 'give up after this many casts' },
    wear: { type: 'string', default: '',
      describe: 'armour to put on first to LOWER spell power into the reachable band ' +
                '(chain -15, scale -20, plate -30). The wielded weapon does not affect it.' },
    home: { type: 'number', default: 0, describe: 'room to return to; 0 stays put' },
  },

  async steps({ want, spellPower, room, maxCasts, wear, home }) {
    // THE REFUSAL, BEFORE ANYTHING WALKS OR SPENDS MANA.
    const p = chanceOf(want, spellPower);
    if (p === null)
      throw new Error(`fish-for-weapon: "${want}" is not on the Create Weapon ladder — ` +
                      `it makes ${WEAPON_BANDS.map(b => b.name).join(', ')}`);
    if (p === 0) {
      const band = WEAPON_BANDS.find(b => b.name === String(want).toLowerCase());
      const lo = Math.floor(spellPower / 3);
      throw new Error(
        `fish-for-weapon: at spell power ${spellPower} the roll is Random(${lo}, ${spellPower}), ` +
        `and "${want}" needs ${band.lo}..${band.hi - 1} — so it can NEVER be produced, however ` +
        `long this ran. Reachable now: ${reachableAt(spellPower).join(', ')}. ` +
        (spellPower >= band.hi
          ? 'Spell power is too HIGH: wear armour to bring it down (chain -15, scale -20, ' +
            'plate -30) — the wielded weapon does not affect it.'
          : 'Spell power is too LOW: this needs a better Create Weapon ability.'));
    }

    const steps = [walk(room)];
    if (wear) steps.push(act('act', { verb: 'use', name: wear },
      { why: `wear ${wear} to pull spell power down into the ${want} band` }));

    // THE LOOP LIVES INSIDE ONE `verify`, AND THE FIRST VERSION OF THIS DID NOT.
    //
    // I wrote it as cast, verify, cast, verify — and a failing step ENDS THAT AGENT'S
    // errand in fleetScript, by design. So the first verify that did not find the weapon
    // aborted the whole thing: a script advertised as "cast until it appears" could cast
    // exactly once. It looked right and read right and was wrong in the one way that
    // mattered.
    //
    // STAND UP FIRST. Measured 2026-09-08: the trial cast returned `cast: true` with
    // `mana_spent: 0` and the tool's own note — "NOTHING was spent, the cast did not happen
    // at all; being asleep, frozen or otherwise blocked looks exactly like this". The
    // keeper rests characters, and a resting character silently casts nothing.
    steps.push(verify(async ({ agent, call }) => {
      const holds = async () => {
        const inv = await call('inventory', { agent }, 60_000).catch(() => null);
        return (inv?.items || []).some(i =>
          String(i.name || '').toLowerCase() === String(want).toLowerCase());
      };
      if (await holds()) return true;

      // MANA IS THE REAL BUDGET, NOT THE CAST COUNT.
      //
      // Create Weapon costs 15 (creaweap.kod:41) and this fleet's mana pool is 21, so a
      // character gets ONE cast per full pool and then has to regenerate most of it. The
      // first working version of this loop fired ten casts in sixty seconds, every one of
      // them into 14 mana, and reported "bad luck" — at 48% a side, ten real casts miss
      // 0.14% of the time, so "unlucky" was never the explanation. `mana_spent: 0` was
      // saying so the whole time and the loop was not reading it.
      const MANA_COST = 15;
      const manaNow = async () => {
        const st = await call('status', { agent, brief: true }, 30_000).catch(() => null);
        return Number(st?.mana?.value);
      };
      let blocked = 0;
      for (let i = 0; i < Math.max(1, Number(maxCasts)); i++) {
        // Wait for the pool rather than spending the budget on casts that cannot happen.
        for (let w = 0; w < 40; w++) {
          const m = await manaNow();
          if (!Number.isFinite(m) || m >= MANA_COST) break;
          await new Promise(x => setTimeout(x, 6000));
        }
        await call('act', { agent, verb: 'stand' }, 30_000).catch(() => {});
        const r = await call('cast', { agent, spell: 'create weapon' }, 60_000).catch(() => null);
        if (!r || !Number(r.mana_spent)) { blocked++; await new Promise(x => setTimeout(x, 4000)); }
        else await new Promise(x => setTimeout(x, 1500));
        if (await holds()) return true;

        // DROP THE REJECTS. The header of this file has always said "cast, look at what
        // appeared, drop it if it is wrong" and the first version simply did not do it —
        // it cast and checked and left everything in the pack.
        //
        // That is not untidy, it is ACTIVELY HARMFUL. Create Weapon's ladder is centred
        // below the short sword band for this fleet, so most rolls are maces; they
        // accumulated, and `equipBest` then put one in the character's hand. Measured
        // 2026-09-08: five characters came out of a fishing run WIELDING maces — the exact
        // weapon the training doctrine exists to get them off — and the short-sword count
        // went DOWN across the run.
        //
        // Only weapons this cast could have produced are dropped, and only ones the
        // character is not using: a rejected mace is litter, but the sword it walked in
        // with is not.
        const inv = await call('inventory', { agent }, 60_000).catch(() => null);
        const junk = (inv?.items || []).filter(i => {
          const n = String(i.name || '').toLowerCase();
          return n !== String(want).toLowerCase() &&
                 ['mace', 'hammer', 'axe', 'long sword', 'scimitar', 'mystic sword'].includes(n);
        });
        for (const j of junk.slice(0, 4))
          await call('act', { agent, verb: 'drop', id: j.id, amount: 1 }, 30_000).catch(() => {});
      }
      // Say WHICH failure it was. "Did not appear" and "never actually cast" need
      // different fixes and must not read the same.
      if (blocked) throw new Error(
        `${blocked}/${maxCasts} casts spent no mana — the character could not cast, not ` +
        `unlucky. Create Weapon needs ${MANA_COST} and this pool regenerates slowly.`);
      return false;
    }, `no ${want} after ${maxCasts} cast(s) — at ~${Math.round(p * 100)}% each that is ` +
       'either bad luck or the casts are not happening; check mana_spent'));

    if (home) steps.push(walk(home));
    return steps;
  },
};
