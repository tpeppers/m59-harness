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
import { verify, supply, rest, call as rpc } from '../m59-fleetscript.mjs';
import { fleetName } from '../m59-fleetpath.mjs';
import { accepts, refusal } from '../m59-hazards.mjs';
import { mealsOf } from '../m59-muster-lib.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUB = process.env.M59_SUBSTRATE || join(REPO, 'substrate');
const PLANS = new Map();
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
  async resolveAgents(p) {
    const plan = loadPlan(p.muster, Number(p.max_age_min));
    const missing = (plan.hazards_to_accept ?? []).filter(h => !accepts(list(p.accept), h));
    if (missing.length) throw new Error(missing.map(h => refusal(h, `muster ${p.muster}`)).join(' | '));
    const givers = [...new Set(plan.transfers.filter(t => t.kind === 'pack' && t.holder).map(t => t.holder))];
    const agents = [...new Set([...plan.participants, ...givers])];
    // SETTLE, before the runner leases anybody.
    const retire = plan.settle.filter(s => s.cancel_jobs.length).map(s => s.agent);
    if (retire.length) {
      const r = await rpc('job_cancel', { agents: retire, by: `muster-run:${p.muster}`, why: `muster ${p.muster}: taking these characters` }, 60_000);
      console.log(`  settle: retired ${r?.cancelled?.length ?? 0} job(s): ${(r?.cancelled ?? []).map(j => `${j.name} (was ${j.was})`).join(', ') || '-'}`);
    }
    const byPosture = new Map();
    for (const s of plan.settle) for (const name of s.release ?? []) byPosture.set(name, [...(byPosture.get(name) ?? []), s.agent]);
    if (byPosture.size) {
      const { release } = await import('../m59-posture.mjs');
      for (const [name, only] of byPosture) {
        const r = await release(name, { fleet: fleetName(), only, toHold: true, by: `muster-run:${p.muster}`, call: rpc, log: s => console.log(`  settle: ${s}`) });
        if (r.failed?.length) throw new Error(`${name}: release to a hold failed for ${r.failed.map(f => f.agent).join(', ')}`);
      }
    }
    PLANS.set(p.muster, plan);
    const skipped = [...plan.readiness.filter(a => a.exclude).map(a => ({ agent: a.agent, why: a.exclude })),
                     ...plan.excluded_for_supply.map(o => ({ agent: o.agent, why: `stays home: ${o.why}` }))];
    return { agents, skipped };
  },
  async steps(p) {
    const { agent } = p;
    const plan = PLANS.get(p.muster) ?? loadPlan(p.muster, Number(p.max_age_min));
    const t = plan.target;
    const isPart = plan.participants.includes(agent);
    const gives = plan.transfers.filter(x => x.kind === 'pack' && x.holder === agent && !x.hops);
    const handOver = g => ({ ...supply(agent, g.to, g.name, { amount: g.amount, exact: true }), optional: true });
    const steps = [];
    if (isPart) steps.push(verify(async ({ call }) => {
      const r = await call('autopilot', { agent, action: 'start', survival_enabled: true, fight_above_vigor: t.fightAboveVigor,
        why: `muster ${p.muster}: survival on, fight floor ${t.fightAboveVigor}` }, 60_000);
      return r?.error ? { ok: false, why: r.error } : true;
    }, 'survival on and the fight floor'));
    steps.push(...gives.map(handOver));
    if (isPart) steps.push(rest({ health: t.health, vigor: t.vigor }));
    // THE SECOND CHANCE. A hand-over refused for room (a full pack) usually clears once the receiver has eaten; so each
    // of this giver's hand-overs is checked again after the rest, and only the short part is sent.
    if (gives.length) steps.push({ ...verify(async ({ call }) => {
      for (const g of gives) {
        const inv = await call('inventory', { agent: g.to }, 60_000).catch(() => null);
        const have = (inv?.items ?? []).filter(i => String(i.name).toLowerCase() === g.name.toLowerCase()).reduce((n, i) => n + (Number(i.amount) || 1), 0);
        if (have >= g.amount) continue;
        await call('supply', { from: agent, to: g.to, what: g.name, amount: g.amount - have, stationary: true, who_travels: 'neither' }, 180_000).catch(() => null);
      }
      return true;
    }, 'hand-overs, second chance'), optional: true });
    if (isPart) steps.push(verify(async ({ call }) => {
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
