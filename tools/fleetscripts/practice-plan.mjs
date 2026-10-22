// practice-plan — DRILL THE SPELLS THAT GATE EACH CHARACTER'S NEXT SCHOOL LEVEL, ON SPARE MANA,
// WHILE IT FARMS; AND ASK THE COURIER FOR THE REAGENTS THE DRILL WILL BURN.
//
//   practice-plan agents=t2,t3,t5                           # DRY: plan and print, change nothing
//   practice-plan agents=all exclude=hk1,hk3                # every in-roster, non-piloted character
//   practice-plan agents=t2,t3,t5 apply=true                # push practice_spells + file courier requests
//   practice-plan agents=t2,t3 schools=kraanan,shalille apply=true
//   practice-plan agents=t5,t6 quarry=troll,orc rooms=599,579,350 apply=true
//   practice-plan agents=t2 apply=true request=false        # the list only, no courier requests
//
// Operator, 2026-10-22: "make gate-practice into something more robust/general. It should read
// skills out of the planner, categorize the skills (personal enchants, reagents required, etc.),
// autorequest/deliver the reagents, etc. We want it as a re-usable FleetScript." The prototypes were
// two scratch scripts on the prod deploy (substrate/scratch/gate-practice.mjs and
// bard/ukgoth-practice.mjs, 2026-10-21/22); every decision they made is now tools/m59-practice-plan.mjs,
// pure and pinned by m59-practice-plan-test.mjs. Read that header for the gate, the categories, the
// never-drill list and the blockers.
//
// DRY BY DEFAULT. Without `apply=true` it reads each character (abilities, autopilot status, status,
// inventory, the fleet row's planner view) and prints the plan: per school the gate, the order, the
// floor, every blocker that would stop practice in silence, and the reagent need with the courier
// requests it WOULD file. `dry practice-plan ...` in the REPL prints only the compiled steps.
//
// IT IS A POSTURE, NOT AN ERRAND, like practice-while-farming: one autopilot setting
// (`practice_spells`) and walks nobody. Rooms are kept unless `rooms=` is given. The previous
// practice_spells is stashed first, per agent, in substrate/history/<fleet>/practice-plan-stash.json
// (`restore=true` puts the stashed one back).
//
// REAGENTS GO THROUGH THE COURIER THAT ALREADY EXISTS. Shortfalls become standing top-up targets in
// substrate/courier-requests.json -- { agent: { "<SHOPPING item>": count } }, the file Zheng He's lap
// reads at the start of every lap and the PLAN tab's "Request a delivery" row writes
// (tools/plans/courier.mjs). A reagent the lap has no shopping line for goes to
// substrate/courier-wishlist.json, which nothing buys from: it is printed as such. A request is never
// LOWERED -- an operator's standing herb 140 stays 140. No second courier is invented here.
//
// WHO IT WILL NOT TOUCH. A character a person is piloting (the fleet row's `piloted`), anything in
// `exclude` and anything not in the roster are dropped by `resolveAgents` BEFORE the runner takes its
// run lock and `busy` mark -- never locked, never marked -- and the step re-checks as a second net. It takes no faculty lease (`keeperLease` waived, as in
// practice-while-farming): a lease would cancel a farmer's journey for a policy write, and it never
// claims or releases anybody else's. The work faculty's owner is printed so a bot that will
// overwrite the list is visible.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify, call as brokerCall, FOOD_KEEP } from '../m59-fleetscript.mjs';
import { fleetName } from '../m59-fleetpath.mjs';
import { planPractice, courierRequestPlan, mergeCourierRequests, itemKey } from '../m59-practice-plan.mjs';
import { lapState } from '../plans/courier.mjs';

const SUBSTRATE = process.env.M59_SUBSTRATE_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'substrate');
const REQUESTS = join(SUBSTRATE, 'courier-requests.json');
const WISHLIST = join(SUBSTRATE, 'courier-wishlist.json');
const stashFile = () => join(SUBSTRATE, 'history', fleetName() || 'default', 'practice-plan-stash.json');

// THE REPL HANDS PARAMETERS OVER AS STRINGS, so `request=false` is the string "false" and truthy.
export const yes = v => v === true || /^(true|yes|1|on)$/i.test(String(v ?? '').trim());
const list = s => String(s ?? '').split(',').map(x => x.trim()).filter(Boolean);
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')) ?? d; } catch { return d; } };
// SYNCHRONOUS read-merge-write: agents run in parallel, and an await between the read and the write
// would let two of them each write a file missing the other's line.
const writeJson = (f, v) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f + '.tmp', JSON.stringify(v, null, 1)); renameSync(f + '.tmp', f); };
const FOOD = new Set(FOOD_KEEP.map(itemKey));
const names = p => (p?.spells ?? []).map(e => String(e?.name ?? e).toLowerCase());
const sameList = (live, want) => !!live && JSON.stringify(names(live)) === JSON.stringify(names(want))
  && Number(live.mana_floor ?? live.manaFloor ?? 0) === Number(want.mana_floor ?? 0)
  && JSON.stringify([...(live.rooms ?? [])].map(Number).sort()) === JSON.stringify([...(want.rooms ?? [])].map(Number).sort());

// One `fleet` read per run, shared by every agent's step.
let fleetRows = null;
const fleetRow = async (call, agent) => {
  fleetRows ??= call('fleet', {}).then(r => r?.fleet ?? []).catch(() => []);
  return (await fleetRows).find(r => r.agent === agent) ?? null;
};

/**
 * WHO THIS RUN MAY TOUCH, decided BEFORE the runner locks or marks anybody busy (the runner does
 * both to every agent it is handed, before any step can skip one). Pure. `requested` may be
 * ['all']: every in-roster character on the fleet list. Piloted, excluded and not-in-roster
 * characters are dropped with the reason; so is a name the fleet list does not carry at all.
 * @returns { agents: [...], skipped: [{ agent, why }] }
 */
export function pickAgents({ rows = [], requested = [], exclude = [] } = {}) {
  const byAgent = new Map(rows.filter(r => r?.agent).map(r => [r.agent, r]));
  const out = [], skipped = [], ex = new Set(exclude);
  const want = requested.some(a => String(a).toLowerCase() === 'all') ? [...byAgent.keys()] : requested;
  for (const agent of [...new Set(want)]) {
    const r = byAgent.get(agent);
    if (ex.has(agent)) skipped.push({ agent, why: 'excluded' });
    else if (!r) skipped.push({ agent, why: 'not on the fleet list' });
    else if (r.in_roster === false) skipped.push({ agent, why: 'not in the roster' });
    else if (r.piloted) skipped.push({ agent, why: 'piloted by a person' });
    else out.push(agent);
  }
  return { agents: out, skipped };
}

export const script = {
  name: 'practice-plan',
  describe: "Practise the spells that gate each character's next school level first, weakest first, on spare mana while farming; request the reagents from the courier. Dry unless apply=true.",
  recipe: {
    effect: 'Each character drills its school-level gate spells first; its reagent shortfalls are standing courier requests.',
    run: 'practice-plan agents=<list> [schools=kraanan,shalille] [quarry=troll,orc] apply=true',
    needs: ['substrate/m59-spells.json (the kod spell catalogue)', 'a planner (loadout plan) for points-short; works without one'],
    cost: { time: 'seconds per character; nothing walks', risk: 'reagents are spent on practice -- the need list says how many' },
  },

  unsafe: {
    reason: "Writes one autopilot setting (practice_spells) and moves nobody; holding the keeper would cancel the farmer's journey for nothing, and taking a lease would step on a bot's.",
    waives: ['keeperLease'],
  },

  consults: ['the fleet row (piloted, learning = the planner view)', 'the abilities tool', 'autopilot status', 'status', 'inventory',
             'substrate/m59-spells.json', 'substrate/courier-requests.json', "the courier lap's SHOPPING lines (tools/plans/courier.mjs)"],

  notes: [
    'PRACTICE CASTS THE FIRST LISTED SPELL IT CAN AFFORD, so order is the lever: for each school the',
    'best three spells at the highest known level gate the next level (PlayerCanLearn), and those go',
    'first, weakest first, planned schools before unplanned. Everything else drillable follows.',
    '',
    'DRY unless apply=true. Read the blockers: each one stops practice without an error.',
  ],

  params: {
    agents:  { type: 'agents', required: true, describe: 'who practises; `all` = every in-roster, non-piloted character' },
    apply:   { type: 'boolean', default: false, describe: 'push the plan; without it nothing is changed' },
    request: { type: 'boolean', default: true, describe: 'with apply, file reagent shortfalls as courier requests' },
    restore: { type: 'boolean', default: false, describe: 'put back the practice_spells stashed by the first apply' },
    exclude: { type: 'string', default: null, describe: 'agents to skip, comma separated' },
    schools: { type: 'string', default: null, describe: "gate only these schools (kraanan,shalille); default every school known" },
    quarry:  { type: 'string', default: null, describe: 'creatures for creature-target spells; default the current list, else the hunt' },
    rooms:   { type: 'string', default: null, describe: 'practice rooms; default the current practice rooms, else the farming rooms' },
    floor:   { type: 'number', default: null, describe: 'mana floor instead of the current one (never under the derived floor)' },
    gap_s:   { type: 'number', default: null, describe: 'seconds between practice casts; default keeps the current gap' },
    stock_casts: { type: 'number', default: 20, describe: 'reagent stock to request per gate spell, in casts' },
    rest_casts:  { type: 'number', default: 5, describe: 'reagent stock to request per other spell, in casts' },
    relay_min_vigor: { type: 'number', default: 110, describe: 'min_vigor for a newly listed relay' },
  },

  // Run by m59-fleetlib's runNamed before fleetScript sees the list. An unreadable fleet list
  // refuses the run: an unchecked list is exactly how a piloted character gets locked.
  resolveAgents: async (p, { call = brokerCall } = {}) => {
    const reply = await call('fleet', {});
    if (!Array.isArray(reply?.fleet)) throw new Error('the fleet list is unreadable, so piloted characters cannot be told apart');
    return pickAgents({ rows: reply.fleet, requested: [].concat(p.agents ?? []), exclude: list(p.exclude) });
  },

  steps: (p) => [
    verify(async ({ agent, call, state }) => {
      const row = await fleetRow(call, agent);
      if (list(p.exclude).includes(agent)) { state.skip = 'excluded'; return { ok: true, why: `${agent}: excluded, untouched` }; }
      if (row?.piloted) { state.skip = 'piloted'; return { ok: true, why: `${agent}: piloted by a person, untouched` }; }
      if (row && row.in_roster === false) { state.skip = 'not in roster'; return { ok: true, why: `${agent}: not in the roster, untouched` }; }

      const [ab, ap, st, inv] = await Promise.all([
        call('abilities', { agent, kind: 'spells' }), call('autopilot', { agent, action: 'status' }),
        call('status', { agent, brief: true }), call('inventory', { agent }).catch(() => null)]);
      const policy = ap?.policy ?? {};
      const stash = readJson(stashFile(), {});
      const work = ap?.faculties?.work;
      const workOwner = work && work !== 'keeper' ? work.owner ?? null : null;

      if (yes(p.restore)) {
        const was = stash[agent];
        if (!was) return { ok: false, why: `${agent}: nothing stashed to restore` };
        state.planned = was.practice_spells ?? null;
        if (!yes(p.apply)) return { ok: true, why: `${agent}: DRY -- would restore ${JSON.stringify(state.planned).slice(0, 300)}` };
        const r = await call('autopilot', { agent, action: 'start', ...(ap?.mode ? { mode: ap.mode } : {}),
          practice_spells: state.planned, why: 'practice-plan restore=true' });
        if (r?.error) return { ok: false, why: `${agent}: ${r.error}` };
        state.pushed = true;
        return { ok: true, why: `${agent}: restored the practice list stashed ${was.at}` };
      }

      const plan = planPractice({
        known: ab?.spells ?? [], planner: row?.learning ?? null, pack: inv?.items ?? [],
        // The fleet row carries mana as "value/max" and vigor as a number; status as vitals.
        maxMana: Number(String(row?.mana ?? '').split('/')[1]) || st?.vitals?.mana?.max || st?.mana?.max || null,
        vigor: row?.vigor ?? st?.vitals?.vigor?.value ?? null,
        karma: st?.karma?.value ?? null, policy,
        options: {
          schools: p.schools ? list(p.schools) : null, quarry: p.quarry ? list(p.quarry) : null,
          rooms: p.rooms ? list(p.rooms).map(Number) : null, floor: p.floor,
          gapMs: p.gap_s != null && p.gap_s !== '' ? Math.max(2, Number(p.gap_s)) * 1000 : null,
          stockCasts: Number(p.stock_casts) || 20, restCasts: Number(p.rest_casts) || 0,
          relayMinVigor: Number(p.relay_min_vigor) || 110, isFood: n => FOOD.has(itemKey(n)),
        },
      });
      const lap = lapState(SUBSTRATE, fleetName());
      const courier = courierRequestPlan({ agent, reagents: plan.reagents, shopping: lap?.shopping ?? [],
                                           existing: readJson(REQUESTS, {}) });
      state.plan = plan;
      // The whole plan, one line per character, for the operator to read before apply=true.
      console.log(JSON.stringify({ agent, character: row?.character ?? null, ok: plan.ok, why: plan.why,
        work_owner: workOwner, gates: plan.gates.map(g => ({ school: g.school, from: g.level, to: g.target_level,
          best_three: g.best_three.map(b => `${b.name} ${b.ability}${b.drillable ? '' : '*'}`), have: g.have,
          points_short: g.points_short, planned: g.planned, drill: g.drill, bench: g.bench.length ? g.bench : undefined })),
        order: plan.order, mana: plan.mana, rooms: plan.practice?.rooms,
        blockers: plan.blockers.map(b => `${b.kind}: ${b.why}`),
        not_drilled: plan.spells.filter(s => !s.drillable).map(s => `${s.name}: ${s.why}`),
        reagents: plan.reagents.map(r => `${r.item} ${r.per_cast}/cast, ${r.on_hand} on hand${r.kept ? `, ${r.kept} kept` : ''}, want ${r.wanted}, short ${r.shortfall}`),
        courier: { lap: lap?.agent ?? null, requests: courier.requests, wishlist: courier.wishes } }));
      if (!plan.ok) return { ok: false, why: `${agent}: ${plan.why}` };

      const head = `${agent}: ${plan.order.slice(0, 4).join(' > ')}${plan.order.length > 4 ? ' ...' : ''}, floor ${plan.mana.floor}` +
        (plan.blockers.length ? `, ${plan.blockers.length} blocker(s)` : '') + (workOwner ? `, work held by ${workOwner}` : '');
      if (!yes(p.apply)) return { ok: true, why: `DRY ${head}; would request ${courier.requests.filter(q => q.change !== 'keep')
        .map(q => `${q.item}->${q.count}`).join(', ') || 'nothing'}${courier.wishes.length ? `; wishlist ${courier.wishes.map(w => w.item).join(', ')}` : ''}` };

      // STASH FIRST, once: the first apply's "before" is the one worth keeping.
      if (!stash[agent]) { stash[agent] = { at: new Date().toISOString(), practice_spells: policy.practiceSpells ?? null }; writeJson(stashFile(), stash); }
      state.planned = plan.practice;
      const r = await call('autopilot', { agent, action: 'start', ...(ap?.mode ? { mode: ap.mode } : {}),
        practice_spells: plan.practice, why: 'practice-plan: the next school level\'s gate spells first' });
      if (r?.error) return { ok: false, why: `${agent}: ${r.error}` };
      if (r?.keeper_backed && !(r.keeper_push?.confirmed && r.keeper_push?.ok))
        return { ok: false, why: `${agent}: the keeper did not confirm the push (${JSON.stringify(r.keeper_push ?? null).slice(0, 200)})` };
      state.pushed = true;

      let filed = 'requests off';
      if (yes(p.request)) {
        const merged = mergeCourierRequests({ agent, plan: courier, requests: readJson(REQUESTS, {}), wishlist: readJson(WISHLIST, {}) });
        const changed = courier.requests.some(q => q.change !== 'keep');
        if (changed) writeJson(REQUESTS, merged.requests);
        if (courier.wishes.length) writeJson(WISHLIST, merged.wishlist);
        filed = [changed ? `requested ${courier.requests.filter(q => q.change !== 'keep').map(q => `${q.item}->${q.count}`).join(', ')}` : 'no new requests',
                 courier.wishes.length ? `wishlist (NOT bought by the lap) ${courier.wishes.map(w => `${w.item} ${w.count}`).join(', ')}` : null]
          .filter(Boolean).join('; ');
        if (!lap) filed += ' -- NOTE: no courier lap on this machine reads these';
      }
      return { ok: true, why: `${head}; ${filed}` };
    }, 'plan the practice list from the planner and the spellbook; push it and request the reagents when apply=true'),

    // READ IT BACK FROM THE KEEPER, not from the reply: the value in force is what counts.
    verify(async ({ agent, call, state }) => {
      if (state.skip || !state.pushed) return { ok: true };
      const ap = await call('autopilot', { agent, action: 'status' });
      const live = ap?.policy?.practiceSpells ?? null, orders = ap?.policy_orders?.practiceSpells ?? null;
      if (state.planned == null) return !live || !(live.spells ?? []).length ? { ok: true, why: `${agent}: practice off` }
        : { ok: false, why: `${agent}: practice still lists ${names(live).join(', ')}` };
      if (sameList(live, state.planned)) return { ok: true, why: `${agent}: drilling ${names(live).join(' > ')}, floor ${live.mana_floor ?? live.manaFloor}` };
      if (sameList(orders, state.planned))
        return { ok: true, why: `${agent}: ordered, but a strategy overlay shadows it -- in force: ${names(live).join(' > ') || 'nothing'}` };
      return { ok: false, why: `${agent}: the keeper holds ${JSON.stringify(live).slice(0, 300)}` };
    }, "the keeper's practice setting is the one planned"),
  ],
};
