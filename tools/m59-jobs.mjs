#!/usr/bin/env node
// THE JOB BOARD, FROM A TERMINAL: WHAT IS DRIVING CHARACTERS RIGHT NOW, WHAT AN ALERT PAUSED, AND WHAT WAS ORPHANED.
//
//   node tools/m59-jobs.mjs                      report: running / paused / orphaned / resumed / recent, and who is held
//   node tools/m59-jobs.mjs list --state paused  one line per job (filters: --state a,b --agent t6 --kind fleetscript)
//   node tools/m59-jobs.mjs pause <id>           stop that job (stop file + kill), keep its restart
//   node tools/m59-jobs.mjs pause --agents t5,t6 every running job holding one of them
//   node tools/m59-jobs.mjs pause --all [--force]  everything (finish-on-alert jobs too only with --force)
//   node tools/m59-jobs.mjs resume <id> | --all  spawn each paused job's restart
//   node tools/m59-jobs.mjs ... --json
//
// The board is held by the broker (m59-jobboard.mjs, docs/m59-operations.md "The job board"); this asks the same broker
// fleetscripts drive (resolveControlUrl: M59_CONTROL_URL, else substrate/control-url). Every fleetscript run through
// the REPL is on it; other scripts join with m59-jobclient.mjs registerJob.
import { jobTool } from './m59-jobclient.mjs';
import { formatJob } from './m59-jobboard.mjs';

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
  } else if (cmd === 'resume') {
    const args = flag('all') ? { all: true } : target ? { ids: [target] } : null;
    if (!args) throw new Error('resume needs <id> or --all');
    const r = out(await jobTool('job_resume', { ...args, by: 'm59-jobs' }));
    if (!flag('json')) console.log(`resumed ${r.resumed.length}: ${r.resumed.map(x => `${x.id} (pid ${x.pid ?? '?'})`).join(', ') || '-'}` +
      (r.cancelled.length ? `; cancelled (nothing to restart): ${r.cancelled.join(', ')}` : ''));
  } else {
    console.log('usage: m59-jobs.mjs [report|list|pause|resume] (see the header)');
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`jobs: ${e.message}`);
  process.exitCode = 1;
}
