// FETCH PURPLE MUSHROOMS FROM THE GUILD HALL FOR A CASTER WHO MUST NOT MOVE.
//
// THE SHAPE of a local pad (substrate/fleetscripts/ is this machine's and gitignored; this copy sits
// BESIDE it so the REPL does not list it twice). Copy it there and give `to` a default.
//
// Operator, 2026-10-03: "When resupplying Janice, I recommend never moving Janice from the safe spot
// and just having whoever's available to do a lap back from CV ... run an errand to bring back 200
// purple mushrooms at a time from the guild hall chest. The top priority is achieving 99% hold on
// Janice." Hold costs 2 purple mushrooms a cast.
//
// AND THE WAY IN IS THE CHALICE (operator, 2026-10-03: "Build the direct ride the chalice now for
// couriers bit and enable that"). The courier steps out to the station (room 2, next door to Castle
// Victoria), rides the fleet's Chalice of the Rain into the Bookmaker's hall (714) — the keeper's own
// ride sequence, served by whoever is on chalice duty — instead of walking there. A refused ride (a
// PvP lockout, nobody on duty, the cup elsewhere) is optional: the walk after it is the fallback, and
// costs nothing when the ride landed, because a walk to the room the body is already in arrives at once.
//
// MAKE ROOM FIRST, DRAW LAST. Operator, 2026-10-03: "The courier will also need to empty their pack
// enough to carry the 200 purple mushrooms for Janice, too (can deposit some things in the chest and
// sell others, then return to the guild hall to get the 200 purple mushrooms last before setting out
// to CV". 200 purple mushrooms are 400 weight / 1000 bulk (m59-items weighItem), which a farmer's
// pack full of loot cannot take. So:
//
//   1. the station (2), then the chalice ride into the hall (714) — walking in if the ride is refused;
//   2. the hall: deposit the keepers (wands, scrolls, rings, the rare reagents nobody in CV casts)
//      — hall_withdraw with empty `wants` and a `deposit` list; worn and wielded gear never goes;
//   3. Fehr'loi Qan (113, Barloque): sell_all — the sell step keeps FLEET_KEEP, food and two weapons;
//   4. back to the hall: draw the mushrooms, read off the pack;
//   5. Castle Victoria: `supply` hands over what ARRIVED (it stops when the courier runs out, so a
//      short draw delivers what there is rather than failing), judged by the receiver's count.
// Every leg but the draw is optional: a refused ride, a refused sale or a full chest must not stop
// the delivery.
import { walk, verify, supply, sell, rideChalice } from '../../tools/m59-fleetscript.mjs';

const count = (inv, rx) => (inv?.items ?? []).filter(i => rx.test(String(i.name ?? '').trim())).reduce((n, i) => n + (Number(i.amount) || 1), 0);
const PURPLE = /^purple mushrooms?$/i;
// FLEET_KEEP's valuables, MINUS the reagents a farmer may still cast with (herb, elderberry, gems,
// orc tooth, Inky-cap). Substrings, matched by the keeper against pack items that are not worn.
const DEPOSIT = ['wand', 'scroll', 'ring', 'staff', 'bonkstick', 'mystic sword', 'true lute', 'flask', 'rose',
  'blue dragon scale', 'dark angel feather', 'shrunken head'];

const packLine = async (call, agent) => {
  const st = await call('status', { agent }, 60_000).catch(() => null);
  const p = st?.pack ?? {};
  return `pack ${p.percent ?? '?'}%${p.binding ? ` (bound by ${p.binding})` : ''}`;
};

export const script = {
  name: 'mushroom-courier',
  describe: 'Ride the chalice into the guild hall, make pack room (deposit keepers, sell the rest), then draw purple mushrooms from the hall chests last and hand them to a caster who stays put.',
  params: {
    agents: { type: 'agents', required: true, describe: 'the courier' },
    to:     { type: 'string', required: true, describe: 'the caster (who does not move)' },
    room:   { type: 'number', default: 38, describe: 'where the caster stands' },
    amount: { type: 'number', default: 200 },
    hall:   { type: 'number', default: 714 },
    station: { type: 'number', default: 2, describe: 'the chalice station (Outside Castle Victoria)' },
    ride:   { type: 'boolean', default: true, describe: 'ride the chalice into the hall; false walks it' },
    market: { type: 'number', default: 113, describe: "where to sell (113: Fehr'loi Qan, Barloque)" },
    merchant: { type: 'string', default: "Fehr'loi_Qan" },
  },
  async steps(p) {
    const agent = p.agent, n = Number(p.amount), hall = Number(p.hall);
    const ride = p.ride !== false && String(p.ride) !== 'false';
    return [
      ...(ride ? [
        { ...walk(Number(p.station), { why: 'the chalice station' }), optional: true },
        { ...rideChalice({ why: `purple mushrooms for ${p.to}`, expect: hall }), optional: true },
      ] : []),
      walk(hall, { why: ride ? 'the guild hall chests (on foot only if the ride was refused)' : 'the guild hall chests' }),
      verify(async ({ call }) => {
        const r = await call('hall_withdraw', { agent, wants: [], deposit: DEPOSIT }, 620_000).catch(e => ({ error: e.message }));
        console.log(`  ${agent}: deposited in the chests ${JSON.stringify(r?.stashed ?? r?.deposited ?? r?.why ?? r?.error ?? '').slice(0, 120)}; ${await packLine(call, agent)}`);
        return true;
      }, 'keepers into the chests', 'deposit'),
      { ...walk(Number(p.market), { why: 'sell the loot' }), optional: true },
      { ...sell(String(p.merchant).replace(/_/g, ' '), { noVault: true }), optional: true },
      walk(hall, { why: 'back to the chests for the mushrooms, last' }),
      verify(async ({ call }) => {
        const before = count(await call('inventory', { agent }, 60_000).catch(() => null), PURPLE);
        console.log(`  ${agent}: before the draw, ${await packLine(call, agent)}`);
        const r = await call('hall_withdraw', { agent, wants: [{ item: 'purple mushroom', amount: n }] }, 620_000).catch(e => ({ error: e.message }));
        const after = count(await call('inventory', { agent }, 60_000).catch(() => null), PURPLE);
        console.log(`  ${agent}: hall withdraw ${before} -> ${after} purple mushrooms ${JSON.stringify(r?.short ?? r?.error ?? r?.why ?? '').slice(0, 80)}`);
        return after > before ? true : { ok: false, why: 'no purple mushrooms came out of the chests' };
      }, 'purple mushrooms from the hall', 'draw'),
      walk(Number(p.room), { why: `back to ${p.to}` }),
      supply(agent, String(p.to), 'purple mushroom', { amount: n, bite: n }),
    ];
  },
};
