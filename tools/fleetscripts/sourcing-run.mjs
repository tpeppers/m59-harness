// SOURCING-RUN — EXECUTE A CHOSEN SOURCING PLAN: every fighter farms its own job, then the
// guild chests get what dropped.
//
// The execution half of tools/m59-sourcing.mjs. The planner asks "how would you like to get
// <item>?" per item and merges the answers into farm JOBS (one per creature x room). This runs
// them all in one held run, each fighter on its own job:
//
//   walk to the job's room -> take a band that admits its quarry (flat, for soldiers) -> HARVEST
//   (the keeper hunts; the script counts) -> ALWAYS: settings restored, walk to the hall, DEPOSIT
//   the job's items in the guild chests (hall_withdraw deposit). From an island hall, `deposit`
//   is off and the gear stays in the packs.
//
// Buying and chest draws are not here: that is `provision`, which a raid runs after its muster.
//
//   sourcing-run agents=t2,t5,t19 assign='{"t2":0,"t5":0,"t19":1}' jobs='[{...},{...}]'
// (m59-sourcing.mjs prints this line, with the jobs and the assignment filled in.)
import { walk, verify, harvest, call } from '../m59-fleetscript.mjs';
import { hallDeposit } from '../m59-inventory.mjs';

const SAVED = new Map();
const parse = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? d); } catch { return d; } };

export const script = {
  name: 'sourcing-run',
  describe: 'Run a chosen sourcing plan: each fighter farms its job (creature x room), then deposits the drops in the guild chests.',
  recipe: {
    effect: 'The guild chests gain what each job farmed; each fighter says what it deposited.',
    run: 'sourcing-run agents=<fighters> assign=<JSON {agent: jobIndex}> jobs=<JSON jobs from m59-sourcing.mjs>',
    needs: ['fighters at guild rank sir or better for the deposit', 'keepers carrying hall_withdraw with deposit'],
  },
  params: {
    agents: { type: 'agents', required: true },
    jobs: { type: 'string', required: true, describe: 'JSON jobs: [{creature, room, items:[{item,count}], kills, kind}]' },
    assign: { type: 'string', required: true, describe: 'JSON {agent: jobIndex}' },
    minutes: { type: 'number', default: 60, describe: 'farming budget per fighter' },
    hall: { type: 'number', default: 714 },
    deposit: { type: 'boolean', default: true },
    soldier_band: { type: 'number', default: 90, describe: 'flat threat band for soldier jobs' },
  },

  async steps(p, agentArg) {
    const agent = p.agent ?? agentArg;
    const jobs = parse(p.jobs, []);
    const job = jobs[Number(parse(p.assign, {})[agent])];
    if (!job) return [verify(async () => { console.log(`  ${agent}: no job assigned — standing by`); return true; }, 'no job')];
    const names = (job.items ?? []).map(i => i.item);
    const rarest = [...(job.items ?? [])].sort((a, b) => (a.per_kill ?? 1) - (b.per_kill ?? 1))[0]?.item ?? names[0];
    const soldiers = job.kind === 'soldiers';
    const truthy = v => v === true || v === 'true';
    return [
      walk(Number(job.room), { why: `farm ${job.creature} for ${names.join(', ')}` }),
      ...(soldiers ? [verify(async () => {
        const st = await call('autopilot', { agent, action: 'status' }, 40_000).catch(() => null);
        SAVED.set(agent, { threat_ceiling: st?.policy?.threatCeiling ?? st?.policy?.threat_ceiling });
        await call('autopilot', { agent, action: 'start', threat_ceiling: { mode: 'flat', value: Number(p.soldier_band) } }, 40_000).catch(() => {});
        return true;
      }, 'a band that admits a soldier')] : []),
      harvest({ quarry: [job.creature], want: rarest, count: 0, room: Number(job.room), minutes: Number(p.minutes) }),
      ...(soldiers ? [{ ...verify(async () => {
        const saved = SAVED.get(agent);
        if (saved?.threat_ceiling !== undefined) await call('autopilot', { agent, action: 'start', ...saved }, 40_000).catch(() => {});
        return true;
      }, 'settings restored'), always: true }] : []),
      ...(truthy(p.deposit) ? [
        { ...walk(Number(p.hall)), always: true },
        { ...verify(async () => {
          const r = await hallDeposit(agent, names);   // m59-inventory: one at a time through the hall door
          console.log(`  ${agent} (${job.creature} @${job.room}) deposited ${r?.stashed ?? 0} piece(s)${r?.ok ? '' : ` — REFUSED ${r?.why ?? '?'}`}`);
          return true;
        }, 'the job\'s drops deposited in the guild chests'), always: true }] : []),
    ];
  },
};
