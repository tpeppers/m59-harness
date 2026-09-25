// PREFARM EQUIPMENT — KILL FACTION SOLDIERS FOR A RAID'S GEAR, SELL THE REST, FILL THE CHESTS.
//
// DRAFT (2026-09-25, operator's request). Attachable to any raid: run it days or hours before, and
// the raid's own `provision` phase then finds the gear in the guild chests instead of at a smith.
//
//   1. PLAN (m59-prefarm-lib.mjs): the nearest troop-spawning flag rooms to the guild hall, the kills
//      the list needs (the rarest line decides), the hours the flagpoles take to make them, what the
//      list would cost to buy, and what the byproducts sell for. It WARNS, loudly, when the fleet is
//      below the soldiers' band — docs/m59-combat.md: "DO NOT FARM SOLDIERS FOR ARMOUR" — and refuses
//      to walk anyone unless `accept_risk=true` when every soldier outranks every fighter.
//   2. FARM: each fighter walks to one of the faction's flag rooms (round-robin, two per room is the
//      useful most: a pole makes twelve an hour), takes a band that admits a soldier (flat
//      `threat_flat`), and `harvest`s — the keeper hunts; the script counts.
//   3. ALWAYS, whatever the farm did: settings restored; the byproducts SOLD at the hall town's smith
//      (keeping the list and the essentials); the list DEPOSITED into the guild chests
//      (hall_withdraw deposit). An island hall has no road worth the name to a flagpole: the plan
//      warns and the gear stays in the fighters' packs.
//
// With a DUM driving the fleet, switch its prefarm-soldiers profile on for the fighters instead of
// (or as well as) step 2's posture — see doctrines/profiles/prefarm-soldiers.jsonc in the DUM repo.
// It confines each farmer to its flag room so the bot does not re-task it mid-farm.
//
//   node tools/m59-prefarm.mjs plan --fleet prod --wants '{"chain armor":4,"long sword":4}'
//   node tools/m59-prefarm.mjs run  --fleet prod --wants '...' --top 6 --minutes 90 --commit
import { walk, verify, harvest, call } from '../m59-fleetscript.mjs';
import { hallDeposit } from '../m59-inventory.mjs';
import { planPrefarm, describePrefarm, SOLDIER, SMITHS } from '../m59-prefarm-lib.mjs';
import { barrier, expect } from '../m59-ghostraid-lib.mjs';
import { PACK_KEEP } from './ghost-outfit.mjs';

const LEVELS = new Map();
const SAVED = new Map();
let PRINTED = false;

const parseWants = w => { try { const v = typeof w === 'string' ? JSON.parse(w || '{}') : w; return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

export const script = {
  name: 'prefarm-equipment',
  describe: 'Farm faction soldiers for a raid\'s weapons and armour; sell the byproducts; deposit the list in the guild chests.',
  recipe: {
    effect: 'The guild chests gain the listed gear (or the fighters\' packs do, from an island hall); the rest of the loot becomes shillings.',
    run: 'prefarm-equipment agents=<fighters> wants=<JSON {item: count}> minutes=<budget>',
    needs: ['a faction-held flag room near the hall — prod\'s current holdings are NOT known to the plan; a pole held by nobody spawns nothing',
            'fighters at guild rank sir or better for the deposit',
            'keepers carrying hall_withdraw with deposit (deployed, restarted since)'],
    cost: { time: 'the plan says: kills / (rooms x 12 an hour)', risk: 'soldiers roll level 70-145; see the plan\'s warnings' },
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'the fighters (the driver picks the top N by level)' },
    wants: { type: 'string', required: true, describe: 'JSON {item: count}, e.g. {"chain armor":4,"long sword":4}' },
    hall: { type: 'number', default: 714, describe: 'the guild hall — decides the faction, the rooms and the smith' },
    faction: { type: 'string', default: '', describe: 'duke | princess | rebel; empty = the nearest to the hall' },
    minutes: { type: 'number', default: 60, describe: 'the farming budget per fighter' },
    threat_flat: { type: 'number', default: 90, describe: 'flat band over max health; 90 admits the level-145 top roll from 55 max health' },
    accept_risk: { type: 'boolean', default: false, describe: 'farm even when every soldier outranks every fighter' },
    sell: { type: 'boolean', default: true, describe: 'sell the byproducts at the hall town\'s smith' },
    deposit: { type: 'boolean', default: true, describe: 'deposit the list in the guild chests (never from an island hall)' },
  },

  async steps(p, agentArg) {
    const agent = p.agent ?? agentArg;
    const agents = String(p.agents ?? '').split(',').map(x => x.trim()).filter(Boolean);
    const all = agents.length ? agents : [agent];
    const wants = parseWants(p.wants);
    const plan = planPrefarm({ wants, hall: Number(p.hall), faction: p.faction || null });
    const room = plan.rooms[Math.max(0, all.indexOf(agent)) % Math.max(1, plan.rooms.length)];
    const names = plan.lines.map(l => l.item);
    const rarest = [...plan.lines].sort((a, b) => a.per_kill - b.per_kill)[0]?.item ?? '';
    expect('pf-survey', all.length);
    if (!plan.troop || !room || !names.length)
      return [verify(async () => ({ ok: false, why: `nothing to farm: ${plan.warnings.join('; ') || 'no soldier drops any of the list'}` }), 'the prefarm plan')];

    const truthy = v => v === true || v === 'true';
    return [
      // 1. THE PLAN, WITH THE FLEET'S REAL LEVELS, printed once; a refusal when it is hopeless.
      verify(async () => {
        const me = await call('status', { agent, brief: false }, 40_000).catch(() => null);
        // Level IS max health here (status level_note).
        LEVELS.set(agent, Number(me?.hp?.max ?? me?.vitals?.health?.max ?? 0));
        await barrier('pf-survey', agent, { ms: 60_000 });
        const levels = [...LEVELS.values()].filter(Boolean);
        const live = planPrefarm({ wants, hall: Number(p.hall), faction: p.faction || null, fleetLevels: levels });
        if (!PRINTED) { PRINTED = true; console.log(describePrefarm(live)); }
        const top = Math.max(0, ...levels);
        if (top && top < SOLDIER.level[0] && !truthy(p.accept_risk))
          return { ok: false, why: `every soldier (level ${SOLDIER.level[0]}+) outranks every fighter (top ${top}); pass accept_risk=true to farm anyway` };
        return true;
      }, 'the prefarm plan, against the fleet\'s levels'),

      walk(room, { why: `farm ${plan.troop} at the flag in room ${room}` }),

      // 2. THE BAND: a soldier is refused by the default 150% band, so take a flat one — and keep
      // what was there to put it back.
      verify(async () => {
        const st = await call('autopilot', { agent, action: 'status' }, 40_000).catch(() => null);
        const pol = st?.policy ?? {};
        SAVED.set(agent, { threat_ceiling: pol.threatCeiling ?? pol.threat_ceiling, flee_below: pol.fleeBelow, rest_below: pol.restBelow });
        const r = await call('autopilot', { agent, action: 'start', threat_ceiling: { mode: 'flat', value: Number(p.threat_flat) },
                                            flee_below: 0.4, rest_below: 0.7 }, 40_000).catch(e => ({ error: e.message }));
        return r?.error ? { ok: false, why: `the soldier band was refused: ${r.error}` } : true;
      }, 'the soldier band'),

      harvest({ quarry: [plan.troop], want: rarest, count: 0, room, minutes: Number(p.minutes) }),

      // 3. ALWAYS: settings back, byproducts sold, the list deposited.
      { ...verify(async () => {
        const saved = Object.fromEntries(Object.entries(SAVED.get(agent) ?? {}).filter(([, v]) => v !== undefined));
        if (Object.keys(saved).length) await call('autopilot', { agent, action: 'start', ...saved }, 40_000).catch(() => {});
        return true;
      }, 'settings restored'), always: true },
      ...(truthy(p.sell) && plan.smith ? [
        { ...walk(plan.smith), always: true },
        { ...verify(async () => {
          const r = await call('sell_all', { agent, merchant: SMITHS[plan.smith]?.name ?? null, keep: [...PACK_KEEP, ...names] }, 300_000).catch(e => ({ error: e.message }));
          console.log(`  ${agent} sold the byproducts at ${plan.smith}: ${r?.error ?? JSON.stringify(r?.sold ?? r?.count ?? '?')}`);
          return true;
        }, 'the byproducts sold'), always: true }] : []),
      ...(truthy(p.deposit) && !plan.keep_not_deposit ? [
        { ...walk(Number(p.hall)), always: true },
        { ...verify(async () => {
          const r = await hallDeposit(agent, names);   // m59-inventory: one at a time through the hall door
          console.log(`  ${agent} deposited ${r?.stashed ?? 0} piece(s) of the list${r?.ok ? '' : ` — REFUSED ${r?.why ?? '?'}`}`);
          return true;
        }, 'the list deposited in the guild chests'), always: true }] : [
        { ...verify(async () => { console.log(`  ${agent}: ${plan.keep_not_deposit ? 'island hall — the gear STAYS in the pack' : 'deposit off'}`); return true; }, 'no deposit'), always: true }]),
    ];
  },
};
