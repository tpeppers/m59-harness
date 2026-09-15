// ARM THE FLEET: everyone drops their weapon in one pile, the casters enchant it, everyone
// picks their own back up.
//
//   node tools/m59-fleet-repl.mjs  ->  run raid-arm --room 2
//
// Phase zero of a boss raid, and the one that decides it. The Ghost of Far'Nohl resists
// ATCK_WEAP_NONMAGIC by 90% and takes -50 against ATCK_WEAP_MAGIC (ghost.kod:83): a mundane
// weapon lands a tenth of its damage and an enchanted one lands one and a half times. That
// is a FIFTEENFOLD difference and it dwarfs every other decision a raid can make. Most
// bosses in this game carry a resistance table of the same shape.
//
// ============================================================================
// NOBODY HANDS ANYTHING TO ANYBODY. THE WEAPONS GO ON THE FLOOR.
// ============================================================================
//
// `enchant weapon` decides reach with
//
//     IsTargetInRange(who,target) = who = Send(target,@GetOwner)
//                                OR send(who,@getOwner) = send(target,@getowner)
//
// (enchwp.kod:75). The first clause is the obvious one — the caster owns the weapon. The
// SECOND says the caster's owner and the weapon's owner need only be the same object, and
// for a caster standing in a room and a weapon lying on its floor, both are that room. So a
// dropped weapon is a legal target, and the whole hand-over dance is unnecessary:
//
//     drop -> enchant where it lies -> pick it back up
//
// Verified on the shadow fleet: Dddd's long sword, dropped in room 2 and dedicated by Eeee
// on the first attempt, WA_ENCHANTED confirmed on the object itself.
//
// This matters beyond saving steps. `trade` lies in both directions, a receiver that cannot
// take delivery is usually a full pack rather than a refusal, and a hand-over that completes
// the handshake while moving nothing is the commonest failure in this repository's history.
// The floor has none of those states: the weapon is either on it or it is not.
//
// WHAT IT COSTS INSTEAD: a weapon on the ground can be picked up by anyone. On a test server
// that is nothing; in a town full of strangers it is a real risk, so `--room` should name a
// room the fleet holds, and the pile should not sit there longer than the casting takes.
//
// ============================================================================
// ONLY REAL STEEL IS WORTH THE REAGENTS
// ============================================================================
//
// 11 of this fleet's 21 weapons were `create weapon` conjures, which carry a decay timer and
// evaporate — one did exactly that mid-session ("Your scimitar disappears in a puff of
// smoke"), taking with it an enchantment that had cost 17 mana, 3 elderberry and an orc
// tooth. A conjure is not worth enchanting, and the tell a player can see is the look text:
// a conjured item "shimmers insubstantially".
import { verify, castVerified, countReagents } from '../m59-fleetscript.mjs';
import { buffCatalogue } from '../m59-buffs.mjs';

// The pile, shared across the agents of one run. fleetScript runs them in the same process,
// so a module-level map IS the rendezvous — there is no cross-process coordination to do.
const PILE = new Map();          // agent -> { id, name, character }
const DROPPED = { count: 0, expected: 0 };

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Wait until every raider has dropped, or the patience runs out. A barrier, bounded. */
async function waitForThePile(ms = 90_000) {
  const until = Date.now() + ms;
  while (Date.now() < until && DROPPED.count < DROPPED.expected) await sleep(1000);
  return DROPPED.count;
}

export const script = {
  name: 'raid-arm',
  describe: 'Drop every weapon in one pile, enchant it, pick it back up. The 15x decision.',
  params: {
    room: { type: 'number', default: 0,
            describe: 'the room to pile the weapons in. 0 = wherever everyone already is' },
    casters: { type: 'string', default: '',
               describe: 'comma-separated agents who cast. Empty = auto, whoever knows the spell' },
    spell: { type: 'string', default: 'enchant weapon' },
    attempts: { type: 'number', default: 4,
                describe: 'tries per weapon. A broken trance and a failed roll are both retryable' },
    channel: { type: 'string', default: 'say' },
  },

  async steps({ room, casters, spell, attempts, channel }, agent, state) {
    const named = String(casters).split(',').map(s => s.trim()).filter(Boolean);
    const buff = buffCatalogue().find(b => b.name === String(spell).toLowerCase());

    return [
      ...(Number(room) ? [{ do: 'walk', to: Number(room) }] : []),

      verify(async ({ call, state: st }) => {
        const say = text => call('say', { agent, type: channel, text: String(text).slice(0, 220) }, 30_000)
          .catch(() => {});
        const me = await call('status', { agent, brief: false }, 40_000).catch(() => null);
        const who = me?.character ?? agent;

        // WHO CASTS IS A QUESTION FOR THE GAME, not for a list somebody typed. A named list
        // still wins, because an operator may want only two of four casters spending mana.
        const spells = await call('spells', { agent }, 40_000).catch(() => null);
        const knows = (spells?.spells ?? []).some(s =>
          String(s.name ?? '').toLowerCase() === String(spell).toLowerCase());
        const isCaster = named.length ? named.includes(agent) : knows;

        const roster = await call('fleet', {}, 40_000).catch(() => null);
        const here = (roster?.fleet ?? []).filter(r => r.room_num === (me?.where?.num ?? me?.room_num));
        DROPPED.expected = Math.max(DROPPED.expected, here.length);

        // ---- 1. DROP. Casters keep hold of their own: a caster can enchant the weapon in
        // its own pack directly (the first clause of IsTargetInRange), so putting it on the
        // floor would only add two steps and a chance for somebody else to walk off with it.
        const inv = await call('inventory', { agent }, 40_000).catch(() => null);
        const mine = (inv?.items ?? []).find(i =>
          String(i.name).toLowerCase() === String(me?.wielding ?? '').toLowerCase())
          ?? (inv?.items ?? []).find(i => /sword|hammer|axe|mace|scimitar|dagger|flail|staff/i.test(i.name));
        if (!mine) {
          st.armed = { skipped: 'nothing to enchant' };
          return true;
        }

        if (!isCaster) {
          await call('act', { agent, verb: 'drop', target: mine.id }, 60_000).catch(() => {});
          PILE.set(agent, { id: mine.id, name: mine.name, character: who });
          DROPPED.count++;
          await say(`My ${mine.name} is on the floor for enchanting.`);
        } else {
          PILE.set(agent, { id: mine.id, name: mine.name, character: who, kept: true });
          DROPPED.count++;
        }

        // ---- 2. CAST. Only the casters do anything here; everyone else waits for the pile
        // to be worked through, because picking a weapon up early takes it out of reach.
        if (!isCaster) {
          await sleep(Math.max(20_000, Number(attempts) * 40_000));
          st.armed = { dropped: mine.id, waited: true };
          return true;
        }

        const dropped = await waitForThePile();
        await say(`${dropped} weapon(s) down. Enchanting.`);

        // Split the pile between the casters so two of them do not spend reagents on the
        // same weapon: each takes every Nth entry, ordered so every caster sees one order.
        const order = [...PILE.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
        const allCasters = named.length ? named
          : order.filter(([, v]) => v.kept).map(([k]) => k);
        const slot = Math.max(0, allCasters.indexOf(agent));
        const n = Math.max(1, allCasters.length);
        const mineToDo = order.filter((_, i) => i % n === slot);

        const did = [];
        for (const [ownerAgent, w] of mineToDo) {
          // Reagents first: a cast short of them is refused free and SILENT, which is
          // byte-for-byte what a cast that never left looks like.
          const bag = countReagents((await call('inventory', { agent }, 40_000).catch(() => null))?.items ?? []);
          const key = x => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
          const have = {};
          for (const [k, v] of Object.entries(bag)) have[key(k)] = (have[key(k)] ?? 0) + v;
          const short = (buff?.reagents ?? [])
            .map(r => ({ item: r.item, want: r.count, got: have[key(r.item)] ?? 0 }))
            .filter(r => r.got < r.want);
          if (short.length) {
            await say(`Out of ${short.map(s => s.item).join(' and ')} — stopping.`);
            did.push({ on: w.character, outcome: 'no reagents' });
            break;
          }
          const mana = (await call('status', { agent, brief: true }, 40_000).catch(() => null))?.mana?.value ?? 0;
          if (mana < (buff?.mana ?? 17)) {
            await say(`Out of mana — stopping.`);
            did.push({ on: w.character, outcome: 'no mana' });
            break;
          }

          let r = null;
          for (let i = 0; i < Math.max(1, Number(attempts)); i++) {
            r = await castVerified(agent, spell, { target: w.id, cost: buff?.mana ?? null });
            if (!r.retryable) break;
          }
          const outcome = r?.in_effect ? 'already' : r?.landed ? 'enchanted' : 'failed';
          did.push({ on: w.character, weapon: w.name, outcome, why: r?.why });
          await say(`${w.character}'s ${w.name}: ${outcome}.`);
        }
        st.armed = { cast: did };
        console.log(`  ${String(who).padEnd(8)} enchanted ${did.filter(d => d.outcome === 'enchanted').length}` +
                    `/${did.length} of the pile`);
        return true;
      }, 'the arming could not be read back'),

      // ---- 3. PICK IT BACK UP, and wield it. A weapon left on the floor is worse than one
      // never enchanted, so this is verified rather than assumed: the read-back says who is
      // holding what, and anybody still empty-handed is named.
      verify(async ({ call, state: st }) => {
        const w = PILE.get(agent);
        if (!w || w.kept) { st.rearmed = { kept: true }; return true; }
        await call('act', { agent, verb: 'get', target: w.id }, 60_000).catch(() => {});
        await sleep(1200);
        await call('act', { agent, verb: 'use', target: w.id }, 60_000).catch(() => {});
        await sleep(1200);
        const me = await call('status', { agent, brief: false }, 40_000).catch(() => null);
        const back = String(me?.wielding ?? '').toLowerCase() === String(w.name).toLowerCase();
        st.rearmed = { weapon: w.name, wielding: me?.wielding ?? null, ok: back };
        if (!back)
          console.log(`  !! ${me?.character ?? agent} is wielding ${me?.wielding ?? 'nothing'}, not the ${w.name} it put down`);
        return true;
      }, 'the weapon could not be read back into a hand'),
    ];
  },
};
