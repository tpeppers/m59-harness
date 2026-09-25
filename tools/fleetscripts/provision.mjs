// PROVISION — BRING A LIST OF THINGS HOME: from the guild chests first, the shops second.
//
// PUBLIC, and meant to be attached to any raid. "Buying and bringing everything we need, given a
// list of reagents/items" is the same errand for every raid plan (operator, 2026-09-25), so it is
// one script rather than a step buried in the ghost raid:
//
//   1. whoever carries the Chalice of the Rain stays in the stage room as the CUP HOLDER;
//   2. `riders` characters (named, or the ones with the most FREE pack room) ride the cup to the
//      guild hall one at a time — dropped and grabbed, never handed over (it refuses a trade);
//   3. at the hall each rider empties its pack into a chest (HALL_STASH_KEEP), then draws its
//      share of `wants` in EXACT amounts (REQ_GET_FROM_CONTAINER carries a count);
//   4. what the chests could not give is bought: reagents at the apothecary (`reagent_shop`),
//      gear at the smith (`shop_room`), in the same town;
//   5. the riders walk home to `stage`, Ukgoth one at a time on safe-spot legs, and everyone waits
//      at the `provisioned` barrier.
//
// It brings the goods HOME; it does not hand them out. Who gets what is the raid's decision, and
// the ghost raid's own reagent step and armorers already do that from fuller packs.
//
//   node tools/m59-fleet-repl.mjs  ->  run provision agents=t1,t2,t3,hk1 wants='[{"item":"orc tooth","amount":40}]'
//   composed:  runPhases(cfg, [{ file: 'provision.mjs', params: { wants } }, ...the raid's phases])
//
// Every mechanic it relies on was found the hard way on the 2026-09-25 ghost-raid rehearsals and is
// argued where it lives, in ghost-outfit.mjs (chaliceRide, grabFromFloor, hallDraw, buyByName) and
// Autopilot.hallWithdraw. `node tools/m59-ghostraid.mjs chests` prints the chest plan this draws on.
import { verify, call } from '../m59-fleetscript.mjs';
import { weighItem } from '../m59-items.mjs';
import { barrier, expect, reexpect } from '../m59-ghostraid-lib.mjs';
import { hallDraw, hallSplit, packRoom, HALL_WANTS } from './ghost-outfit.mjs';

const SURVEY = new Map();                    // agent -> { items, might, maxHealth }
export const PROVISION_RUN = { holder: null, riders: [], draws: [] };

const parseWants = (w) => {
  if (Array.isArray(w)) return w;
  try { const v = JSON.parse(String(w || '')); return Array.isArray(v) ? v : HALL_WANTS; } catch { return HALL_WANTS; }
};

/** The cup holder: whoever carries the chalice, read off the survey. */
export function cupHolderIn(survey) {
  for (const [a, s] of survey) if ((s.items ?? []).some(i => /chalice/i.test(String(i.name ?? '')))) return a;
  return null;
}

/** The riders: named, or the `n` with the most free pack room who are not the cup holder. Pure. */
export function pickRiders(survey, { named = [], n = 2, holder = null, exclude = [] } = {}) {
  if (named.length) return named.filter(a => a !== holder);
  const free = a => { const s = survey.get(a); const r = packRoom(s?.might, s?.items ?? []); return (r.weight ?? 0) + (r.bulk ?? 0); };
  return [...survey.keys()].filter(a => a !== holder && !exclude.includes(a))
    .sort((a, b) => (free(b) - free(a)) || a.localeCompare(b)).slice(0, Math.max(1, Number(n) || 1));
}

export const script = {
  name: 'provision',
  describe: 'Bring a list of items home: guild chests first (cup ride, stash, exact draw), then the apothecary and the smith.',
  recipe: {
    effect: 'The riders come home to `stage` carrying the list; each says what it took, bought and could not get.',
    run: 'provision agents=<everyone taking part, the cup holder included> wants=<JSON [{item, amount}]>',
    needs: ['the Chalice of the Rain in somebody\'s pack, standing in `stage`',
            'riders at guild rank sir or better (the hall door refuses in silence)',
            'the hall password recorded for the fleet (m59-hallsecret.mjs)',
            'keepers carrying hall_withdraw (deployed, and restarted since)'],
    cost: { time: 'rides ~1 min each, hall 2-4 min each (one at a time), shops ~2 min, the road home 5-15 min',
            risk: 'the road home crosses Ukgoth; it is walked one at a time on safe-spot legs' },
  },
  params: {
    agents: { type: 'agents', required: true, describe: 'everyone taking part — the cup holder and the candidate riders' },
    wants: { type: 'string', default: '', describe: 'JSON [{item, amount}]; empty = the ghost raid\'s HALL_WANTS' },
    riders: { type: 'number', default: 2, describe: 'how many riders when none are named' },
    rider_names: { type: 'string', default: '', describe: 'comma-separated riders; empty = most free pack room' },
    stage: { type: 'number', default: 2, describe: 'where the cup is dropped and the goods come home (a Shal\'ille room refills the cup)' },
    hall: { type: 'number', default: 714, describe: 'where the chalice lands a guild member' },
    rally: { type: 'number', default: 598, describe: 'where riders gather before crossing Ukgoth home' },
    reagent_shop: { type: 'number', default: 104, describe: 'the apothecary for reagents the chests lacked (0 = do not buy)' },
    apothecary: { type: 'string', default: 'Joguer' },
    shop_room: { type: 'number', default: 113, describe: 'the smith for gear the chests lacked' },
    smith: { type: 'string', default: "Fehr'loi Qan" },
    buy_gear: { type: 'boolean', default: true, describe: 'buy gear the chests lacked at the smith on the same trip' },
    wait_s: { type: 'number', default: 2400, describe: 'how long everyone waits for the riders to come home' },
  },

  async steps(p, agentArg) {
    const agent = p.agent ?? agentArg;
    const agents = String(p.agents ?? '').split(',').map(x => x.trim()).filter(Boolean);
    const all = agents.length ? agents : [agent];
    for (const k of ['prov-survey', 'provisioned']) expect(k, all.length);
    return [
      // SURVEY: who carries the cup, and how much room everyone has — one picture for everyone.
      verify(async ({ state: st }) => {
        const [me, inv] = await Promise.all([
          call('status', { agent, brief: false }, 40_000).catch(() => null),
          call('inventory', { agent }, 40_000).catch(() => null)]);
        SURVEY.set(agent, { items: inv?.items ?? [], might: Number(me?.attributes?.might ?? 0),
                            maxHealth: Number(me?.hp?.max ?? me?.vitals?.health?.max ?? 0) });
        await barrier('prov-survey', agent, { ms: 120_000 });
        reexpect('provisioned', SURVEY.size);
        st.survey = SURVEY.size;
        return true;
      }, 'the provisioning survey could not be read'),

      // THE DRAW. Riders go; the holder and everyone else wait in the stage room.
      verify(async ({ state: st }) => {
        const holder = cupHolderIn(SURVEY);
        const named = String(p.rider_names ?? '').split(',').map(x => x.trim()).filter(Boolean);
        const crew = pickRiders(SURVEY, { named, n: p.riders, holder });
        PROVISION_RUN.holder = holder; PROVISION_RUN.riders = crew;
        if (!holder) console.log('  provision: NOBODY carries the Chalice of the Rain — riders will walk to the hall');
        if (crew.includes(agent)) {
          const share = hallSplit(crew, parseWants(p.wants), weighItem)[agent] ?? [];
          st.draw = await hallDraw({ agent, crew, holder, share, p });
          PROVISION_RUN.draws.push({ agent, ...st.draw });
        } else if (agent !== holder) {
          await call('rest', { agent }, 30_000).catch(() => {});
        }
        await barrier('provisioned', agent, { ms: Number(p.wait_s) * 1000 });
        return true;
      }, 'the provisioning draw could not be read back'),
    ];
  },
};
