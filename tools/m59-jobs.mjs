#!/usr/bin/env node
// THE JOB BOARD, FROM A TERMINAL: WHAT IS DRIVING CHARACTERS RIGHT NOW, WHAT AN ALERT PAUSED, AND WHAT WAS ORPHANED.
//
//   node tools/m59-jobs.mjs                      report: running / paused / orphaned / resumed / recent, and who is held
//   node tools/m59-jobs.mjs list --state paused  one line per job (filters: --state a,b --agent t6 --kind fleetscript)
//   node tools/m59-jobs.mjs pause <id>           stop that job (stop file + kill), keep its restart
//   node tools/m59-jobs.mjs pause --agents t5,t6 every running job holding one of them
//   node tools/m59-jobs.mjs pause --all [--force]  everything (finish-on-alert jobs too only with --force)
//   node tools/m59-jobs.mjs resume <id> | --all  spawn each paused job's restart
//   node tools/m59-jobs.mjs cancel <id> | --agents t17,t20   retire them: stop a live one, and nothing resumes them
//                                                 --agents also OVERRIDES the bodies (m59-overrides.mjs): releases each keeper
//                                                 lease and open trade, and refuses every fleetscript on them for 15 min
//                                                 (--hold N minutes; --hold 0 for none), so a supervisor's next step is refused
//   node tools/m59-jobs.mjs override [clear --agents t17]   the overrides in force; lift one early
//   node tools/m59-jobs.mjs ... --json
//
// The board is held by the broker (m59-jobboard.mjs, docs/m59-operations.md "The job board"); this asks the same broker
// fleetscripts drive (resolveControlUrl: M59_CONTROL_URL, else substrate/control-url). Every fleetscript run through
// the REPL is on it; other scripts join with m59-jobclient.mjs registerJob.
import { jobTool } from './m59-jobclient.mjs';
import { formatJob } from './m59-jobboard.mjs';
import { overridesPath, readOverrides, activeOverrides, setOverrides, clearOverrides, DEFAULT_HOLD_MIN } from './m59-overrides.mjs';
import { fleetName } from './m59-fleetpath.mjs';
import { fileURLToPath } from 'node:url';
const OVERRIDES = () => overridesPath(fileURLToPath(new URL('../substrate', import.meta.url)), fleetName());

const argv = process.argv.slice(2);
const flag = k => argv.includes('--' + k);
const opt = k => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : null; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !['--json', '--all', '--force'].includes(argv[i - 1])));
const [cmd = 'report', target] = positional;
const list = v => String(v ?? '').split(',').map(s => s.trim()).filter(Boolean);
const out = d => { if (flag('json')) console.log(JSON.stringify(d, null, 1)); return d; };

try {
  if (cmd === 'report') {
    const r = out(await jobTool('jobs', { action: 'report', recent: Number(opt('recent') ?? 10) }));
    if (!flag('json')) {
      const now = r.at ?? Date.now();
      for (const [label, rows] of [['RUNNING', r.running], ['PAUSED', r.paused], ['ORPHANED', r.orphaned], ['RESUMED', r.resumed], ['RECENT', r.recent]]) {
        console.log(`${label} (${rows.length})`);
        for (const j of rows) console.log('  ' + formatJob(j, now));
      }
      console.log(`held: ${r.held.length ? r.held.join(', ') : 'nobody'}`);
    }
  } else if (cmd === 'list') {
    const r = out(await jobTool('jobs', { state: opt('state') ?? undefined, agent: opt('agent') ?? undefined, kind: opt('kind') ?? undefined }));
    if (!flag('json')) for (const j of r.jobs) console.log(formatJob(j));
  } else if (cmd === 'pause') {
    const args = flag('all') ? { all: true } : opt('agents') ? { agents: list(opt('agents')) } : target ? { ids: [target] } : null;
    if (!args) throw new Error('pause needs <id>, --agents a,b or --all');
    const r = out(await jobTool('job_pause', { ...args, force: flag('force'), by: 'm59-jobs', why: opt('why') ?? 'paused by hand' }));
    if (!flag('json')) console.log(`paused ${r.paused.length}: ${r.paused.join(', ') || '-'}` + (r.left_to_finish.length ? `; left to finish: ${r.left_to_finish.join(', ')}` : ''));
  } else if (cmd === 'cancel') {
    const args = opt('agents') ? { agents: list(opt('agents')) } : target ? { ids: [target] } : null;
    if (!args) throw new Error('cancel needs <id> or --agents a,b (never --all: it is not undone)');
    const r = out(await jobTool('job_cancel', { ...args, by: 'm59-jobs', why: opt('why') ?? 'cancelled by hand' }));
    if (!flag('json')) console.log(`cancelled ${r.cancelled.length}: ${r.cancelled.map(x => `${x.id} ${x.name} (was ${x.was})`).join(', ') || '-'}`);
    // THE BODY, NOT ONLY THE JOB (m59-overrides.mjs): a killed job leaves its keeper lease and any open trade behind, and the
    // supervisor that launched it goes straight on to its next step. Release both, then hold the body.
    if (args.agents) {
      const hold = opt('hold') == null ? DEFAULT_HOLD_MIN : Number(opt('hold'));
      for (const a of args.agents) {
        const f = await jobTool('autopilot', { agent: a, action: 'free', why: 'm59-jobs cancel: release the cancelled job lease' }).catch(e => ({ error: e.message }));
        const t = await jobTool('trade', { agent: a, action: 'cancel' }).catch(e => ({ error: e.message }));
        if (!flag('json')) console.log(`  ${a}: lease ${f?.was ? 'released (' + f.was.by + ')' : f?.error ? 'not released: ' + f.error : 'none held'}; ` +
          `trade ${t?.cancelled ? 'cancelled' : 'none open'}`);
      }
      if (hold > 0) {
        setOverrides(OVERRIDES(), args.agents, { minutes: hold, by: opt('by') ?? 'm59-jobs cancel', why: opt('why') ?? null });
        if (!flag('json')) console.log(`  override: no fleetscript drives ${args.agents.join(', ')} for ${hold} min (lift: m59-jobs override clear --agents ...)`);
      }
    }
  } else if (cmd === 'override') {
    if (target === 'clear') {
      const agents = list(opt('agents'));
      if (!agents.length) throw new Error('override clear needs --agents a,b');
      const c = clearOverrides(OVERRIDES(), agents);
      out({ cleared: c });
      if (!flag('json')) console.log(`cleared: ${c.join(', ') || '-'}`);
    } else {
      const live = activeOverrides(readOverrides(OVERRIDES()));
      out({ overrides: live });
      if (!flag('json')) { const rows = Object.entries(live); if (!rows.length) console.log('no overrides in force');
        for (const [a, e] of rows) console.log(`  ${a}  until ${new Date(e.until).toISOString().slice(11, 19)}Z  by ${e.by ?? '-'}${e.why ? ': ' + e.why : ''}`); }
    }
  } else if (cmd === 'resume') {
    const args = flag('all') ? { all: true } : target ? { ids: [target] } : null;
    if (!args) throw new Error('resume needs <id> or --all');
    const r = out(await jobTool('job_resume', { ...args, by: 'm59-jobs' }));
    if (!flag('json')) console.log(`resumed ${r.resumed.length}: ${r.resumed.map(x => `${x.id} (pid ${x.pid ?? '?'})`).join(', ') || '-'}` +
      (r.cancelled.length ? `; cancelled (nothing to restart): ${r.cancelled.join(', ')}` : ''));
  } else {
    console.log('usage: m59-jobs.mjs [report|list|pause|resume|cancel|override] (see the header)');
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`jobs: ${e.message}`);
  process.exitCode = 1;
}
