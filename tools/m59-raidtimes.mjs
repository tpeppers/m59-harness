#!/usr/bin/env node
// m59-raidtimes — HOW LONG EACH PART OF A RAID TOOK, AND WHETHER THAT IS GETTING BETTER.
//
//   node tools/m59-raidtimes.mjs                          the history, one line per run, newest last
//   node tools/m59-raidtimes.mjs --run <dir>              one run: every block, p50/p90/wall, deaths
//   node tools/m59-raidtimes.mjs --run <dir> --write      reduce it and append it to the history
//   node tools/m59-raidtimes.mjs --prep-lead [--write]     how early THIS fleet must prepare for a ghost, measured
//   node tools/m59-raidtimes.mjs --from-log <log> --run <dir> --write
//                                                          a run from before the step hook: rebuilt
//                                                          from the rehearsal log's "step N ok" lines
//
// Every FleetScript step appends a line to M59_STEP_TIMES (m59-fleetscript.mjs recordStepTime). The
// raid runner points that at <run>/steps.jsonl and records the git SHA it ran; this reduces the
// steps to per-block p50/p90 across agents and a WALL time per block (first start to last end —
// what the fleet as a whole waited), and appends one line per run to substrate/raids/history.jsonl.
//
// WHY PER-AGENT PERCENTILES *AND* WALL TIME. A block's p50 says what a typical character spent in
// it; its wall time says what the RAID spent, because a barrier waits for the slowest. A change
// that halves the p50 and leaves one straggler has not moved the raid at all, and only the pair
// shows it. The pre-raid time (run start to entering the throne room) is the number to drive down.
//
// A run is only comparable to another run at a known SHA, so a dirty tree is recorded as dirty.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
export const HISTORY = path.join(REPO, 'substrate', 'raids', 'history.jsonl');

export const pct = (xs, p) => {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1))];
};

export const keyOf = r => r.label ?? (r.do === 'walk' && r.to != null ? `walk:${r.to}` : `${r.script ?? '?'}#${r.at}:${r.do}`);

/** Steps -> { blocks: {key: {n, p50, p90, max, wall, first, ok, failed, dead}}, order: [key...] } */
export function reduceSteps(rows = []) {
  const by = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  const blocks = {};
  for (const [k, rs] of by) {
    const ms = rs.map(r => r.ms);
    const first = Math.min(...rs.map(r => r.t0)), last = Math.max(...rs.map(r => r.t0 + r.ms));
    blocks[k] = { n: rs.length, p50: pct(ms, 50), p90: pct(ms, 90), max: Math.max(...ms),
                  wall: last - first, first, ok: rs.filter(r => r.ok).length,
                  failed: rs.filter(r => !r.ok).length, dead: rs.filter(r => r.dead).length };
  }
  const order = Object.keys(blocks).sort((a, b) => blocks[a].first - blocks[b].first);
  return { blocks, order };
}

/**
 * A rehearsal log from before the hook: "HH:MM:SS <agent> step N (<do>) ok". Each step's duration
 * is the gap since that agent's previous line (the first step from `started`). Keys are the step
 * index, not a label, so these runs compare with each other and only roughly with hooked ones.
 */
export function stepsFromLog(text, { day, started }) {
  const rows = [], last = new Map();
  const base = started ? new Date(started).getTime() : null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d\d):(\d\d):(\d\d) (\S+) step (\d+) \((\w+)\) (ok|failed|skipped)/.exec(line);
    if (!m) continue;
    const t = Date.parse(`${day}T${m[1]}:${m[2]}:${m[3]}Z`);
    const agent = m[4];
    const t0 = last.get(agent) ?? base ?? t;
    rows.push({ agent, at: Number(m[5]), do: m[6], label: `log#${m[5]}:${m[6]}`, t0, ms: Math.max(0, t - t0), ok: m[7] === 'ok' });
    last.set(agent, t);
  }
  return rows;
}

export function gitState(repo = REPO) {
  const run = args => { try { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim(); } catch { return null; } };
  const sha = run(['rev-parse', 'HEAD']);
  const dirty = run(['status', '--porcelain', '-uno']);
  return { sha, short: sha?.slice(0, 7) ?? null, dirty: !!dirty, dirty_files: dirty ? dirty.split(/\r?\n/).length : 0,
           branch: run(['rev-parse', '--abbrev-ref', 'HEAD']) };
}

/** One run -> one history line. */
export function summarise(dir, { steps = null } = {}) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'raid.json'), 'utf8'));
  const rows = steps ?? readJsonl(path.join(dir, 'steps.jsonl'));
  const events = readJsonl(path.join(dir, 'events.jsonl'));
  const report = fs.existsSync(path.join(dir, 'report.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')) : null;
  const deaths = readJsonl(path.join(dir, 'deaths.jsonl'));
  const { blocks, order } = reduceSteps(rows);
  const started = rows.length ? Math.min(...rows.map(r => r.t0)) : Date.parse(meta.started);
  const entered = events.find(e => e.kind === 'entered')?.t ?? null;
  const killAt = events.find(e => e.kind === 'ghost_gone')?.t ?? null;
  return {
    run: path.basename(dir), fleet: meta.fleet, agents: meta.agents?.length ?? null,
    git: meta.git ?? null, started: new Date(started).toISOString(),
    pre_raid_ms: entered ? entered - started : null,
    kill_s: entered && killAt ? Math.round((killAt - entered) / 1000) : null,
    survival: report?.survival ?? report?.survived ?? null,
    deaths: deaths.length || null,
    deaths_before_entry: deaths.filter(d => entered && d.t < entered).length,
    blocks: Object.fromEntries(order.map(k => [k, { n: blocks[k].n, p50: blocks[k].p50, p90: blocks[k].p90, wall: blocks[k].wall }])),
  };
}

export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const min = ms => ms == null ? '—' : `${(ms / 60000).toFixed(1)}m`;

function printRun(s) {
  console.log(`${s.run}  fleet ${s.fleet}  ${s.agents} agents  git ${s.git?.short ?? '?'}${s.git?.dirty ? ' (DIRTY)' : ''}`);
  console.log(`  pre-raid ${min(s.pre_raid_ms)}   kill ${s.kill_s ?? '—'}s   deaths ${s.deaths ?? '—'} (${s.deaths_before_entry ?? 0} before entry)   survival ${JSON.stringify(s.survival ?? '—')}`);
  console.log(`  ${'block'.padEnd(28)} ${'n'.padStart(3)} ${'p50'.padStart(7)} ${'p90'.padStart(7)} ${'wall'.padStart(7)}`);
  for (const [k, b] of Object.entries(s.blocks))
    console.log(`  ${k.padEnd(28)} ${String(b.n).padStart(3)} ${min(b.p50).padStart(7)} ${min(b.p90).padStart(7)} ${min(b.wall).padStart(7)}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  if (argv.includes('--prep-lead')) {
    // HOW EARLY THIS FLEET MUST START PREPARING FOR A GHOST. From the prep episodes ghost-raid logs
    // (valve shut -> ready), recommend shutting at 108 min (the earliest a ghost can come) minus the
    // p90 lead minus a margin. Written to prep-lead.json, which ghost-raid reads (prep_close_min=auto).
    const eps = readJsonl(path.join(REPO, 'substrate', 'raids', 'prep-lead.jsonl')).filter(e => e.lead_ms != null);
    const leads = eps.map(e => e.lead_ms / 60_000);
    const margin = Number(opt('--margin') ?? 3);
    const p90 = pct(leads, 90);
    const rec = p90 == null ? 95 : Math.max(60, Math.floor(108 - p90 - margin));
    const out = { recommended_close_min: rec, episodes: eps.length, lead_p50_min: pct(leads, 50), lead_p90_min: p90, margin_min: margin,
                  late: readJsonl(path.join(REPO, 'substrate', 'raids', 'prep-lead.jsonl')).filter(e => e.lead_ms == null).length,
                  basis: 'the fleet that ran these episodes; re-measure on the shadow fleet when the fleet changes', at: new Date().toISOString() };
    console.log(JSON.stringify(out, null, 1));
    if (argv.includes('--write')) { fs.writeFileSync(path.join(REPO, 'substrate', 'raids', 'prep-lead.json'), JSON.stringify(out, null, 1)); console.log('written: substrate/raids/prep-lead.json'); }
    return;
  }
  const dir = opt('--run');
  if (dir) {
    let steps = null;
    if (opt('--from-log')) {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'raid.json'), 'utf8'));
      steps = stepsFromLog(fs.readFileSync(opt('--from-log'), 'utf8'), { day: meta.started.slice(0, 10), started: null });
    }
    const s = summarise(dir, { steps });
    if (opt('--from-log')) s.source = 'log';
    printRun(s);
    if (argv.includes('--write')) {
      fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
      fs.appendFileSync(HISTORY, JSON.stringify(s) + '\n');
      console.log(`appended to ${HISTORY}`);
    }
    return;
  }
  const hist = readJsonl(HISTORY);
  if (!hist.length) { console.log(`no runs recorded yet (${HISTORY})`); return; }
  console.log(`${'run'.padEnd(36)} ${'git'.padEnd(9)} ${'pre-raid'.padStart(8)} ${'kill'.padStart(6)} ${'deaths'.padStart(6)}  slowest blocks (wall)`);
  for (const s of hist) {
    const slow = Object.entries(s.blocks ?? {}).sort((a, b) => (b[1].wall ?? 0) - (a[1].wall ?? 0)).slice(0, 3)
      .map(([k, b]) => `${k} ${min(b.wall)}`).join(', ');
    console.log(`${s.run.padEnd(36)} ${(s.git?.short ?? '?').padEnd(7)}${s.git?.dirty ? '* ' : '  '}${min(s.pre_raid_ms).padStart(8)} ${String(s.kill_s ?? '—').padStart(5)}s ${String(s.deaths ?? '—').padStart(6)}  ${slow}${s.source === 'log' ? '  [from log]' : ''}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
