// MUSTER-RUN — FIRE A PREFLIGHT PLAN: settle, hand over, rest, check, and hand the ready ones to the operation.
//
//   node tools/m59-preflight.mjs avar-village --fleet shadow          1. the plan (read-only)
//   muster-run muster=avar-village accept=release_lockdown            2. in the fleet REPL: this
//   muster-run muster=avar-village accept=release_lockdown launch=false   ... stop at "ready", run nothing after
//
// The plan is `substrate/scratch/preflight/<muster>-<fleet>.json`, written by m59-preflight.mjs a moment before. This
// runs it and decides nothing new — a plan that is older than `max_age_min` is refused rather than acted on, because
// the fleet it describes has moved since (vigor drains, drills toggle survival, people eat).
//
// WHAT IT DOES, IN ORDER
//   settle   (before the runner leases anybody, so a running drill cannot hold a body against it)
//            - every job over a participant is RETIRED (job_cancel): stopped if live, and nothing ever resumes it --
//              the tripwire-paused solo errands of 2026-10-29 would otherwise restart mid-launch;
//            - each participant leaves its lockdown TO A HOLD (m59-posture release --to-hold), the rest stay in it;
//            refused unless every hazard the plan names is accepted by name (accept=release_lockdown).
//   per body - survival on and the fight floor (the second-wind drill leaves survival off and fight_above_vigor 0);
//            - its hand-overs as GIVER, each a verified `supply` between two bodies in one room, optional: a refusal
//              (a full pack is usually an ordering problem) is tried again after the rest, when meals have been eaten;
//            - rest to the target health and vigor (the keeper will not leave a safe room below its rest cap);
//            - the check: read back, by the game's Food tree and the keeper's own vitals; short is a failure, named.
//   then     the ready ones go to the muster's operation (the avar-village FleetScript) in this same process; the
//            rest stay held where they are, safe, and are listed.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify, rest, call as rpc } from '../m59-fleetscript.mjs';
import { fleetName } from '../m59-fleetpath.mjs';
import { accepts, refusal } from '../m59-hazards.mjs';
import { mealsOf, satisfies } from '../m59-muster-lib.mjs';
import { itemClassIndex, resolveItemClass } from '../m59-itemclass.mjs';
import { foodValue } from '../m59-items.mjs';

// HAND-OVERS ARE TOP-UPS, SO A PLAN IS SAFE TO RUN TWICE. Operator, 2026-10-29: "would it cause problems to manually
// rearrange reagents before calling the muster? or is the muster like idempotent?" It was not: each hand-over moved
// "N loaves from A to B", so a second run of one plan gave twice, and a hand rearrangement between preflight and run
// was given on top of. Now each one first reads the receiver and gives only what it is still SHORT of its need for
// that key (meals by the game's Food tree, a reagent by kod class) -- at most the planned amount -- and re-reads to
// say what actually moved. Run it again and it moves nothing.
let INDEX = null;
const classOf = n => { INDEX ??= itemClassIndex(); const r = resolveItemClass(String(n), INDEX); return r.ok ? r.class : String(n); };
const isFood = n => !!foodValue(n);
const holding = (items, key) => (items ?? []).filter(i => satisfies(i, key, { classOf, isFood }))
  .reduce((n, i) => n + Math.max(1, Number(i.amount) || 1), 0);
async function topUp(call, plan, g, from) {
  const need = (plan.needs?.[g.to] ?? []).find(n => n.key === g.key)?.amount;
  const read = async () => (await call('inventory', { agent: g.to }, 60_000).catch(() => null))?.items ?? null;
  const before = await read();
  if (!before) return { ok: false, why: `could not read ${g.to}'s pack` };
  const short = Math.max(0, (Number.isFinite(need) ? need : Infinity) - holding(before, g.key));
  const n = Math.min(g.amount, short);
  if (!n) return { ok: true, moved: 0, why: `${g.to} already holds its ${need} ${g.key}` };
  const r = await call('supply', { from, to: g.to, what: g.name, amount: n, stationary: true, who_travels: 'neither' }, 180_000)
    .catch(e => ({ error: e.message }));
  const after = await read();
  const moved = after ? holding(after, g.key) - holding(before, g.key) : 0;
  return moved > 0 ? { ok: true, moved } : { ok: false, moved: 0, why: r?.error ?? r?.reason ?? 'nothing moved' };
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUB = process.env.M59_SUBSTRATE || join(REPO, 'substrate');
const PLANS = new Map();
// THE DELIVERY BARRIER. Every body of one run is driven by this process in parallel, and a receiver's own steps finish
// in seconds (a rested body rests no further) -- so on the 2026-10-29 rehearsal eight receivers read "0/4 meals" before
// their givers had handed anything over. Each giver settles its hand-overs here when they are done (delivered or not);
// each receiver's check waits for every hand-over addressed to it, bounded, and only then reads its pack.
const DELIVERIES = new Map();          // `${muster}:${to}` -> [promise]
const settleOf = new Map();            // `${muster}:${from}` -> resolve()
function barrierFor(muster, plan) {
  if (DELIVERIES.has(`${muster}:*`)) return;
  DELIVERIES.set(`${muster}:*`, true);
  const byGiver = new Map();
  for (const t of plan.transfers.filter(x => x.kind === 'pack' && x.holder && !x.hops)) {
    if (!byGiver.has(t.holder)) {
      let done; const promise = new Promise(r => { done = r; });
      byGiver.set(t.holder, promise); settleOf.set(`${muster}:${t.holder}`, done);
    }
    const key = `${muster}:${t.to}`;
    DELIVERIES.set(key, [...(DELIVERIES.get(key) ?? []), byGiver.get(t.holder)]);
  }
}
const deliveriesTo = (muster, agent, ms) =>
  Promise.race([Promise.all(DELIVERIES.get(`${muster}:${agent}`) ?? []), new Promise(r => setTimeout(r, ms))]);
const truthy = v => v === true || /^(true|1|yes)$/i.test(String(v ?? ''));
const list = v => String(v ?? '').split(',').map(s => s.trim()).filter(Boolean);

function loadPlan(muster, maxAgeMin) {
  const fleet = fleetName();
  const f = join(SUB, 'scratch', 'preflight', `${muster}-${fleet}.json`);
  if (!existsSync(f)) throw new Error(`no plan at ${f}: run  node tools/m59-preflight.mjs ${muster} --fleet ${fleet}  first`);
  const plan = JSON.parse(readFileSync(f, 'utf8'));
  if (plan.fleet !== fleet) throw new Error(`the plan is for fleet ${plan.fleet}, this run is fleet ${fleet}`);
  const age = (Date.now() - Date.parse(plan.at)) / 60_000;
  if (age > maxAgeMin) throw new Error(`the plan is ${Math.round(age)} min old (max ${maxAgeMin}): preflight again, the fleet has moved`);
  return plan;
}

// SETTLE, before anybody is leased: retire the jobs over the participants, and take each out of its lockdown to a hold.
// ONE FUNCTION FOR BOTH DOORS -- the fleet REPL's `resolveAgents` and FleetScratch's `setup` (a pad's pre-run hook;
// FleetScratch never calls resolveAgents) -- and SAFE TO RUN TWICE: a unit already out of a posture is skipped, and a
// retired job is no longer live, so a second settle finds nothing to do rather than failing.
async function settle(p, log = console.log) {
  const plan = loadPlan(p.muster, Number(p.max_age_min ?? 15));
  const missing = (plan.hazards_to_accept ?? []).filter(h => !accepts(list(p.accept), h));
  if (missing.length) throw new Error(missing.map(h => refusal(h, `muster ${p.muster}`)).join(' | '));
  const retire = plan.settle.filter(x => x.cancel_jobs.length).map(x => x.agent);
  if (retire.length) {
    const r = await rpc('job_cancel', { agents: retire, by: `muster-run:${p.muster}`, why: `muster ${p.muster}: taking these characters` }, 60_000);
    log(`  settle: retired ${r?.cancelled?.length ?? 0} job(s): ${(r?.cancelled ?? []).map(j => `${j.name} (was ${j.was})`).join(', ') || '-'}`);
  }
  const byPosture = new Map();
  for (const x of plan.settle) for (const name of x.release ?? []) byPosture.set(name, [...(byPosture.get(name) ?? []), x.agent]);
  if (byPosture.size) {
    const { release, readSave } = await import('../m59-posture.mjs');
    for (const [name, wanted] of byPosture) {
      const still = wanted.filter(a => readSave(fleetName(), name)?.units?.[a]);
      if (!still.length) { log(`  settle: ${name}: already out of it`); continue; }
      const r = await release(name, { fleet: fleetName(), only: still, toHold: true, by: `muster-run:${p.muster}`, call: rpc, log: m => log(`  settle: ${m}`) });
      if (r.failed?.length) throw new Error(`${name}: release to a hold failed for ${r.failed.map(f => f.agent).join(', ')}`);
    }
  }
  PLANS.set(p.muster, plan);
  return plan;
}
/** Who a plan drives: its participants and every giver (a giver who stays home still hands over). */
export const planAgents = plan => [...new Set([...plan.participants, ...plan.transfers.filter(t => t.kind === 'pack' && t.holder).map(t => t.holder)])];

export const script = {
  name: 'muster-run',
  describe: 'Fire a preflight plan (m59-preflight.mjs): settle jobs and lockdowns, hand over supplies, rest, check, then run the muster\'s operation.',
  params: {
    agents:      { type: 'agents', default: 'plan', describe: '"plan" = the plan\'s participants and its givers' },
    muster:      { required: true, describe: 'the muster the plan was made for (substrate/musters/<name>.mjs)' },
    accept:      { default: '', describe: 'comma list of hazards the plan names, accepted by name (release_lockdown)' },
    max_age_min: { type: 'number', default: 15, describe: 'refuse a plan older than this' },
    launch:      { default: 'true', describe: 'true: hand the ready ones to the muster\'s operation afterwards' },
  },
  // FleetScratch's door: agents come from the `go` line (m59-preflight prints it), the settle runs here.
  setup: [async (ctx) => { await settle(ctx.params, ctx.say); }],
  async resolveAgents(p) {
    const plan = await settle(p);
    const agents = planAgents(plan);
    const skipped = [...plan.readiness.filter(a => a.exclude).map(a => ({ agent: a.agent, why: a.exclude })),
                     ...plan.excluded_for_supply.map(o => ({ agent: o.agent, why: `stays home: ${o.why}` }))];
    return { agents, skipped };
  },
  async steps(p) {
    const { agent } = p;
    const plan = PLANS.get(p.muster) ?? loadPlan(p.muster, Number(p.max_age_min));
    barrierFor(p.muster, plan);
    const t = plan.target;
    const isPart = plan.participants.includes(agent);
    const gives = plan.transfers.filter(x => x.kind === 'pack' && x.holder === agent && !x.hops);
    const handOver = g => ({ ...verify(async ({ call }) => topUp(call, plan, g, agent), `top up ${g.to}: up to ${g.amount} ${g.name}`), optional: true });
    // A giver hands over FIRST, before anything of its own can fail and unwind it, and then settles the barrier, so a
    // receiver never waits on a giver that stopped for some other reason.
    const steps = [...gives.map(handOver)];
    if (gives.length) steps.push({ ...verify(async () => { settleOf.get(`${p.muster}:${agent}`)?.(); return true; }, 'hand-overs settled'), optional: true });
    if (isPart) steps.push(verify(async ({ call }) => {
      const r = await call('autopilot', { agent, action: 'start', survival_enabled: true, fight_above_vigor: t.fightAboveVigor,
        why: `muster ${p.muster}: survival on, fight floor ${t.fightAboveVigor}` }, 60_000);
      return r?.error ? { ok: false, why: r.error } : true;
    }, 'survival on and the fight floor'));
    if (isPart) steps.push(rest({ health: t.health, vigor: t.vigor }));
    // THE SECOND CHANCE. A hand-over refused for room (a full pack) usually clears once the receiver has eaten; so each
    // of this giver's hand-overs is tried again after the rest -- the same top-up, so it sends only what is still short.
    if (gives.length) steps.push({ ...verify(async ({ call }) => {
      for (const g of gives) await topUp(call, plan, g, agent);
      return true;
    }, 'hand-overs, second chance'), optional: true });
    if (isPart) steps.push(verify(async ({ call }) => {
      await deliveriesTo(p.muster, agent, 600_000);
      const s = await call('status', { agent }, 60_000);
      const inv = await call('inventory', { agent }, 60_000);
      const meals = mealsOf(inv?.items ?? []);
      const hp = Number(s?.vitals?.health?.value ?? s?.health?.value), hpMax = Number(s?.vitals?.health?.max ?? s?.health?.max) || 1;
      const vigor = Number(s?.vitals?.vigor?.value ?? s?.vigor?.value);
      const short = [meals < t.meals && `${meals}/${t.meals} meals`, vigor < t.vigor && `vigor ${vigor}/${t.vigor}`,
                     hp / hpMax < t.health && `health ${hp}/${hpMax}`].filter(Boolean);
      return short.length ? { ok: false, why: `not ready: ${short.join(', ')}` } : true;
    }, 'ready, read back'));
    return steps;
  },
  async afterRun({ params, result, onLog }) {
    const plan = PLANS.get(params.muster);
    const ready = (plan?.participants ?? []).filter(a => result.results?.[a]?.ok);
    const notReady = (plan?.participants ?? []).filter(a => !result.results?.[a]?.ok);
    onLog?.(`muster ${params.muster}: ${ready.length} ready${notReady.length ? `; NOT ready (held where they are): ${notReady.join(', ')}` : ''}`);
    if (!truthy(params.launch) || !plan?.operation?.script || !ready.length) return { ready, not_ready: notReady };
    const { loadFleetScripts, runNamed } = await import('../m59-fleetlib.mjs');
    const { fleetScript } = await import('../m59-fleetscript.mjs');
    const { scripts } = await loadFleetScripts({ dirs: [['public', join(REPO, 'tools', 'fleetscripts')], ['local', join(SUB, 'fleetscripts')]] });
    onLog?.(`handing ${ready.length} to ${plan.operation.script}`);
    const op = await runNamed(plan.operation.script, { ...(plan.operation.params ?? {}), agents: ready.join(',') }, { scripts, fleetScript, onLog });
    return { ready, not_ready: notReady, operation: { ok: op?.ok ?? false, why: op?.why ?? null } };
  },
};
