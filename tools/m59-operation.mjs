#!/usr/bin/env node
// AN OPERATION: A BATTLE PLAN AS DATA -- ROLES, PHASES, POSTS AND ZONES, AND EXPECTATIONS THAT CAN BE WRONG.
//
//   node tools/m59-operation.mjs check <file>                  validate; say what each phase asks of each role
//   node tools/m59-operation.mjs dry <file> [--timeline t.json] [--json]
//                                                             walk a timeline of facts through the plan: which
//                                                             phase holds, which expectations stand, which were
//                                                             invalidated, and what each role is told to do
//   node tools/m59-operation.mjs assign <file> --units u.json  who fills which role, and where each one stands
//
// The operator, 2026-10-25, on the Fleet Management pages to come: select zones of coverage; give "archers",
// "melee fighters", "qor masters" squares to stand on; PHASES -- "waiting for an ambush" is a different plan
// from "during the ensuing fight"; and EXPECTATIONS, anticipatory or reactionary, with conditions that
// invalidate them: "the enemy will run for the exit, so head him off -- but if he stops and slugs it out with
// the one ally near him, the others should go and help, because the door has become irrelevant." And a
// review step: plans proposed, approved, run, cancelled, confirmed, doubled down -- "think like Dungeon
// Master tools".
//
// So an operation is a FILE a person (or a page) writes, and every part of it is data a page can draw:
//
//   {
//     "format": "m59-operation/1", "name": "cv-stairs-ambush", "about": "...",
//     "state": "proposed",                      // proposed | approved | running | paused | done | cancelled
//     "roles": {                                // a role is a kind of unit, filled from the fleet by `fill`
//       "archers": { "fill": { "has_channel": "bow" }, "min": 2, "max": 4 },
//       "melee":   { "fill": { "not": "archers" }, "min": 4 },
//       "healers": { "fill": { "can_cast": "heal" }, "max": 2 }
//     },
//     "zones": {                                // named areas: squares, a rectangle, or the doors between rooms
//       "stairs": { "room": 39, "rect": { "row": [7, 9], "col": [26, 29] } },
//       "doors":  { "doors_between": [38, 39], "radius": 2 }
//     },
//     "phases": [                               // in order; the first whose `when` holds is the phase
//       { "name": "ambush", "when": ["enemy.seen", "==", false],
//         "posts": { "archers": { "zone": "stairs", "keep_clear": 1 }, "melee": { "zone": "doors" } },
//         "posture": { "melee": { "pvp_rooms": [38, 39] } } },
//       { "name": "fight", "when": ["enemy.seen", "==", true],
//         "posts": { "archers": { "zone": "stairs" } },
//         "expect": [
//           { "name": "he runs for the door", "anticipate": { "melee": { "go": "doors" } },
//             "invalidate_when": { "any": [["enemy.engaged_with", ">=", 1], ["enemy.health_band", ">=", 3]] },
//             "then": { "melee": { "go": "assist" } } }
//         ] }
//     ]
//   }
//
// What this file does is PURE: validate, choose the phase, judge each expectation against facts, and say what
// each role is told. Carrying that out is a runner's job (a FleetScript, or the joints the keepers already
// answer) -- so a dry run here is exactly what the runner would decide, without a single packet.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, CONDITION_OPS } from './m59-joints.mjs';

export const STATES = Object.freeze(['proposed', 'approved', 'running', 'paused', 'done', 'cancelled']);
// Who may move a plan from one state to another, and what each move means. `double_down` is a running
// plan re-approved with a larger commitment (more units, a longer hold); `confirm` closes it as done.
export const TRANSITIONS = Object.freeze({
  proposed: { approve: 'approved', cancel: 'cancelled' },
  approved: { start: 'running', cancel: 'cancelled', revise: 'proposed' },
  running: { pause: 'paused', confirm: 'done', cancel: 'cancelled', double_down: 'running' },
  paused: { resume: 'running', cancel: 'cancelled' },
  done: {}, cancelled: {},
});
export const ROLE_VERBS = Object.freeze(['post', 'go', 'hold', 'assist', 'withdraw', 'stand_down']);

export function transition(op, verb, { by = null, why = null, now = new Date().toISOString() } = {}) {
  const next = TRANSITIONS[op.state ?? 'proposed']?.[verb];
  if (!next) throw new Error(`${op.name}: cannot ${verb} a plan that is ${op.state ?? 'proposed'} (${Object.keys(TRANSITIONS[op.state ?? 'proposed'] ?? {}).join(', ') || 'final'})`);
  return { ...op, state: next, history: [...(op.history ?? []), { at: now, verb, from: op.state ?? 'proposed', to: next, by, why }] };
}

/** Validate an operation. Returns a list of problems; empty is valid. */
export function checkOperation(op) {
  const errs = [];
  if (op?.format !== 'm59-operation/1') errs.push('format is "m59-operation/1"');
  if (!op?.name) errs.push('an operation has a name');
  if (op?.state && !STATES.includes(op.state)) errs.push(`state is one of ${STATES.join(', ')}`);
  const roles = Object.keys(op?.roles ?? {}), zones = Object.keys(op?.zones ?? {});
  if (!roles.length) errs.push('an operation names at least one role');
  for (const [z, def] of Object.entries(op?.zones ?? {})) {
    if (!def.doors_between && !Number.isInteger(def.room)) errs.push(`zone ${z}: a room, or doors_between [a, b]`);
    if (def.doors_between && !(Array.isArray(def.doors_between) && def.doors_between.length === 2)) errs.push(`zone ${z}: doors_between is two rooms`);
  }
  const cond = (where, c) => { try { evaluate(c, {}, { options: {}, memory: {} }); } catch (e) { errs.push(`${where}: ${e.message}`); } };
  if (!Array.isArray(op?.phases) || !op.phases.length) errs.push('an operation has phases');
  for (const [i, ph] of (op?.phases ?? []).entries()) {
    const at = `phase ${ph.name ?? i + 1}`;
    if (!ph.name) errs.push(`${at}: a phase has a name`);
    if (ph.when) cond(`${at} when`, ph.when);
    for (const [r, post] of Object.entries(ph.posts ?? {})) {
      if (!roles.includes(r)) errs.push(`${at}: posts names unknown role "${r}"`);
      if (post.zone && !zones.includes(post.zone)) errs.push(`${at}: ${r} posts to unknown zone "${post.zone}"`);
    }
    for (const [j, ex] of (ph.expect ?? []).entries()) {
      const w = `${at} expectation ${ex.name ?? j + 1}`;
      if (ex.invalidate_when) cond(`${w} invalidate_when`, ex.invalidate_when);
      if (ex.holds_when) cond(`${w} holds_when`, ex.holds_when);
      for (const part of ['anticipate', 'then']) for (const [r, order] of Object.entries(ex[part] ?? {})) {
        if (!roles.includes(r)) errs.push(`${w} ${part}: unknown role "${r}"`);
        const verb = Object.keys(order)[0];
        if (!ROLE_VERBS.includes(verb)) errs.push(`${w} ${part}: ${r} "${verb}" is not one of ${ROLE_VERBS.join(', ')}`);
        if (verb === 'go' && order.go !== 'assist' && !zones.includes(order.go)) errs.push(`${w} ${part}: ${r} goes to unknown zone "${order.go}"`);
      }
    }
  }
  return errs;
}

/**
 * Decide, for one moment's facts: the phase, each expectation's standing, and each role's order.
 * An expectation is ANTICIPATED until its `invalidate_when` holds, then its `then` replaces its
 * `anticipate` (a reactionary order); `holds_when`, if given, must also hold for it to be in force at all.
 * Later expectations override earlier ones for the same role, so a plan reads top to bottom.
 */
export function decide(op, facts = {}) {
  const ctx = { options: op.options ?? {}, memory: {} };
  let phase = null, phaseWhy = null;
  for (const ph of op.phases ?? []) {
    const r = evaluate(ph.when ?? null, facts, ctx);
    if (r.pass) { phase = ph; phaseWhy = r.why; break; }
  }
  if (!phase) return { phase: null, why: 'no phase holds', expectations: [], orders: {} };
  const orders = {};
  for (const [role, post] of Object.entries(phase.posts ?? {})) orders[role] = { post: post.zone ?? null, ...post, from: 'posts' };
  const expectations = [];
  for (const ex of phase.expect ?? []) {
    const inForce = ex.holds_when ? evaluate(ex.holds_when, facts, ctx) : { pass: true, why: 'always' };
    if (!inForce.pass) { expectations.push({ name: ex.name, standing: 'not_applicable', why: inForce.why }); continue; }
    const inv = ex.invalidate_when ? evaluate(ex.invalidate_when, facts, ctx) : { pass: false, why: 'never invalidated' };
    const standing = inv.pass ? 'invalidated' : 'anticipated';
    const part = inv.pass ? ex.then ?? {} : ex.anticipate ?? {};
    for (const [role, order] of Object.entries(part)) orders[role] = { ...order, from: `${ex.name}: ${standing}` };
    expectations.push({ name: ex.name, standing, why: inv.why });
  }
  return { phase: phase.name, why: phaseWhy, expectations, orders };
}

/** Walk a timeline [{ at, facts }] and report each change of decision. */
export function dryTimeline(op, timeline) {
  const out = []; let last = null;
  for (const step of timeline) {
    const d = decide(op, step.facts ?? {});
    const key = JSON.stringify([d.phase, d.expectations.map(e => e.standing), d.orders]);
    out.push({ at: step.at ?? null, label: step.label ?? null, changed: key !== last, ...d });
    last = key;
  }
  return out;
}

/**
 * Fill roles from the fleet. `units` is [{ agent, character, channels: [...], can_cast: [...], max_health }].
 * A fill rule is a condition over the unit, plus `not: <role>` (exclude units already in that role). Roles
 * are filled in declaration order up to `max`; a role short of `min` is reported, never silently accepted.
 */
export function fillRoles(op, units) {
  const taken = new Set(), roles = {}, short = [];
  for (const [role, def] of Object.entries(op.roles ?? {})) {
    const f = def.fill ?? {};
    const pool = units.filter(u => !taken.has(u.agent)).filter(u => {
      if (f.agents && !f.agents.includes(u.agent)) return false;
      if (f.has_channel && !(u.channels ?? []).some(c => c === f.has_channel || String(c).startsWith(f.has_channel + ':'))) return false;
      if (f.can_cast && !(u.can_cast ?? []).includes(f.can_cast)) return false;
      if (f.when && !evaluate(f.when, u).pass) return false;
      return true;
    });
    roles[role] = pool.slice(0, def.max ?? pool.length).map(u => u.agent);
    for (const a of roles[role]) taken.add(a);
    if (roles[role].length < (def.min ?? 0)) short.push({ role, have: roles[role].length, need: def.min });
  }
  return { roles, short, unassigned: units.filter(u => !taken.has(u.agent)).map(u => u.agent) };
}

async function main(argv) {
  const [cmd, file] = argv;
  const flag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  if (!file) throw new Error('usage: m59-operation.mjs check|dry|assign <file> (see the header)');
  const op = JSON.parse(readFileSync(file, 'utf8'));
  const errs = checkOperation(op);
  if (cmd === 'check') {
    console.log(`${op.name}: ${errs.length ? errs.length + ' problem(s)' : 'valid'}  (state ${op.state ?? 'proposed'})`);
    for (const e of errs) console.log(`  ! ${e}`);
    for (const ph of op.phases ?? []) console.log(`  phase ${ph.name}: ${Object.keys(ph.posts ?? {}).map(r => `${r}@${ph.posts[r].zone ?? '?'}`).join(', ') || 'no posts'}${(ph.expect ?? []).length ? `; ${(ph.expect).length} expectation(s)` : ''}`);
    return process.exitCode = errs.length ? 1 : 0;
  }
  if (errs.length) throw new Error(`${op.name} is not valid:\n  ${errs.join('\n  ')}`);
  if (cmd === 'dry') {
    const timeline = flag('--timeline') ? JSON.parse(readFileSync(flag('--timeline'), 'utf8')) : op.timeline ?? [];
    const rows = dryTimeline(op, timeline);
    if (argv.includes('--json')) return console.log(JSON.stringify(rows, null, 2));
    for (const r of rows) {
      console.log(`${r.changed ? '*' : ' '} ${r.label ?? r.at ?? ''}  phase ${r.phase ?? '-'}`);
      for (const e of r.expectations) console.log(`     ${e.standing.padEnd(14)} ${e.name}  (${e.why})`);
      if (r.changed) for (const [role, o] of Object.entries(r.orders)) console.log(`     -> ${role}: ${JSON.stringify(o)}`);
    }
    return;
  }
  if (cmd === 'assign') {
    const units = JSON.parse(readFileSync(flag('--units'), 'utf8'));
    console.log(JSON.stringify(fillRoles(op, units), null, 2));
    return;
  }
  throw new Error(`unknown command ${cmd}; operators: ${CONDITION_OPS.join(' ')}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
}
