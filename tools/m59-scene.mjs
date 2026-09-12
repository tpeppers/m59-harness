#!/usr/bin/env node
// SAVE A SCENE OFF PROD, REBUILD IT ON THE LAB SERVER, PAUSED.
//
//   node tools/m59-scene.mjs save t4 --name dukes-feast-hall      read a room, write a scene
//   node tools/m59-scene.mjs plan  substrate/scenes/<name>.json   the DM commands, printed
//   node tools/m59-scene.mjs load  substrate/scenes/<name>.json   rebuild it, HELD
//   node tools/m59-scene.mjs release substrate/scenes/<name>.json start the clocks
//   node tools/m59-scene.mjs scrub substrate/scenes/<name>.json -o published/    publishable
//
// A scene is the LONG WAY ROUND of a pad's `setup`. `setup` is a scene somebody wrote by hand
// -- "put this character on that square, spawns off" -- and it is small, readable and reusable.
// A saved scene is the same thing captured wholesale, and it is the only way to reconstruct
// something nobody would think to write down. They produce the same thing: a lab server in a
// known state. Which is why a pad may take either (see `setup` in m59-fleetscratch.mjs).
//
// ============================================================ WHAT A SCENE MAY AND MAY NOT SAY
//
// A CAPTURED FIELD IS EITHER OBSERVED OR ESTIMATED AND THE FILE HAS TO SAY WHICH.
//
// The interesting half of a scene is the half the wire does not carry. A monster's hit points
// are never sent to a client; what this repository has is an ESTIMATE built from watching the
// thing take damage. Saving that estimate is the point -- it is most of why a scene beats a
// screenshot -- but a file that lists a guessed 233 beside a measured position, in the same
// shape, is a file that will be reloaded, run, and cited as though the 233 were measured.
//
// So every actor field carries `observed`, `estimated` or `unknown`, and `sceneConfidence()`
// counts them. A scene that is mostly estimates is still useful and is not a measurement, and
// the difference has to survive being written down. This is the same three-valued discipline as
// m59-padcheck's verdicts, one layer up: the third value is the one that stops a guess being
// promoted to a fact by the act of storing it.
//
// ============================================================ DETERMINISM, AND WHAT A STAMP MEANS
//
// MEASURED IN THE SERVER SOURCE 2026-09-11, and it decides what a scenario can promise:
//
//   * every kod `random(a,b)` is `C_Random` (blakserv/ccode.c:1911), which is the C library
//     `rand()` called TWICE per draw (`:1943`);
//   * **`blakserv` never calls `srand`.** The only `srand` in the tree is in the WIN32 CLIENT's
//     face picker (module/char/charface.c:113). An unseeded `rand()` is defined to behave as
//     though `srand(1)` were called, so the server's random stream is THE SAME SEQUENCE ON
//     EVERY BOOT.
//
// Which means a scene is reproducible in principle and fragile in practice, and the fragility
// has a name: **draw-order coupling**. There is one global stream and every consumer shares it.
// A wandering monster, a second login, one extra spawn tick -- each consumes draws and shifts
// everything downstream. That is why `spawns: 'off'` belongs in a scenario for REPRODUCIBILITY
// and not only for quiet, and it is why a scene records the actor list it expected to be alone
// with.
//
// So a stamp cannot honestly say "this will happen". It can say one of these, and the file says
// which (`certification.tier`):
//
//   recorded        this happened once. No claim beyond that.
//   reconstructible the scene rebuilds to the same state. Says nothing about the outcome.
//   repeatable      rebuilt and run N times in one reality; the outcome held N of N.
//   surveyed        run across N REALITIES -- see below -- with the outcome distribution kept.
//
// A REALITY IS ONE SEED. The stream being identical every boot is the same as saying there is
// exactly one reality available today, and a scene that "always works" may only always work in
// that one. Running the same scene against other seeds is how you find out whether you have a
// scenario or a coincidence -- 20 boots, 20 seeds, and "the toast happened 20/20, the guard died
// 3/20" is a far more useful stamp than a single green run. Getting there needs a one-line
// `srand(N)` in blakserv, which is a SERVER PATCH and belongs in server-patches/ beside
// simulation-clock, under exactly its discipline: pinned source commit, per-file SHA-256, clean
// apply, image labels, and `attest`. Not built. `certification.reality` is null until it is, and
// a null reality means "whatever boot this was", which is honest and is not a seed.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setProp, sendMsg, relocateCmd, statCmds, healthCmds, manaCmds,
         isLoopbackHost, adminTarget, dm, split, rejections } from './m59-dm.mjs';
import { resolveControlUrl } from './m59-fleetpath.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
export const SCENE_SCHEMA = 'm59-scene/v1';
export const SCENE_DIR = process.env.M59_SCENE_DIR || join(REPO, 'substrate', 'scenes');

export const OBSERVED = 'observed';
export const ESTIMATED = 'estimated';
export const UNKNOWN_FIELD = 'unknown';

/** A captured value and how we came by it. `v` may be null only when how is 'unknown'. */
export const field = (v, how = OBSERVED) => ({ v, how });
export const observed = v => field(v, OBSERVED);
export const estimated = v => field(v, ESTIMATED);
export const unknownField = () => field(null, UNKNOWN_FIELD);

const git = (args, cwd) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8',
                                       stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
};

/**
 * EVERY VERSION THAT COULD CHANGE THE OUTCOME, or null and say so.
 *
 * A scene that does not pin its code is a screenshot. Three repositories decide what happens:
 * the harness that drives, the bots that decide, and the server that adjudicates -- and the
 * server is the one people forget, because it is the one nobody edits during a session.
 *
 * `dirty` is not decoration. A scene captured from a working tree with uncommitted changes
 * cannot be reproduced by anybody else, including us next week, and the flag is the only way
 * that survives into the file.
 */
export function sceneProvenance({ serverRoot = process.env.M59_ROOT || 'C:/code/Meridian59',
                                  dumbotRoot = process.env.M59_DUMBOT_ROOT || null } = {}) {
  const one = (root, label) => {
    if (!root || !existsSync(root)) return { root: root ?? null, commit: null, dirty: null,
                                             why: `${label} checkout not found` };
    const commit = git(['rev-parse', 'HEAD'], root);
    const status = git(['status', '--porcelain'], root);
    return { root, commit, dirty: status === null ? null : status.length > 0,
             why: commit ? null : `${label} is not a git checkout` };
  };
  return { harness: one(REPO, 'harness'), server: one(serverRoot, 'server'),
           dumbot: one(dumbotRoot, 'dumbot') };
}

/** Build a scene object. Pure: the caller does the reading, so a test needs no broker. */
export function makeScene({ name, room, actors = [], provenance = null, notes = [],
                            capturedFrom = null, capturedAt = new Date().toISOString() } = {}) {
  if (!name) throw new Error('a scene needs a name');
  if (!room || room.num == null) throw new Error('a scene needs a room with a num');
  return {
    schema: SCENE_SCHEMA,
    name,
    captured: { at: capturedAt, from: capturedFrom },
    provenance: provenance ?? sceneProvenance(),
    room,
    actors,
    notes,
    // Filled by whoever runs it. `tier: 'recorded'` is the only thing a capture may claim.
    certification: { tier: 'recorded', reality: null, runs: null, outcome: null },
  };
}

/** How much of this scene is measured, and how much is our own guess. */
export function sceneConfidence(scene) {
  const tally = { observed: 0, estimated: 0, unknown: 0 };
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.how === 'string' && 'v' in node) {
      if (node.how in tally) tally[node.how]++;
      return;
    }
    for (const v of Object.values(node)) walk(v);
  };
  for (const a of scene.actors ?? []) walk(a);
  walk(scene.room);
  const total = tally.observed + tally.estimated + tally.unknown;
  return { ...tally, total,
           ratio: total ? tally.observed / total : 0 };
}

export function formatConfidence(c) {
  if (!c.total) return '  the scene records no fields at all';
  const pct = n => `${Math.round(100 * n / c.total)}%`;
  return [
    `  ${c.total} captured field(s): ${c.observed} observed (${pct(c.observed)}), ` +
    `${c.estimated} estimated (${pct(c.estimated)}), ${c.unknown} unknown (${pct(c.unknown)})`,
    c.estimated
      ? `  ${c.estimated} value(s) are OUR INFERENCE, not the server's. A rebuild is only as ` +
        `good as they are — a monster's hit points are never on the wire.`
      : '  every captured field was read from the world.',
  ].join('\n');
}

// ------------------------------------------------------------------ reading one off a server
//
// WHAT A CLIENT CAN SEE, AND WHAT IT CANNOT. This is the whole shape of the reader, and it is a
// shorter list than people expect.
//
// `look` comes back through keeperView -> renderProjection, and one object in a room is
// `{ id, name, col, row, distance, facing, can, is_player }` (m59-render-projection.mjs:88-110).
// That is everything the wire offers about somebody else's body. In particular:
//
//   * THERE ARE NO HIT POINTS ON IT. Not for a monster, not for another player. A monster's
//     health is never sent to a client at all, which is why `hpEstimate` below is a HOOK rather
//     than a read, and why it defaults to `unknown` instead of to a number.
//   * THERE IS NO `kind`. A monster and a barrel arrive in the same shape. What separates them
//     is the affordance list: something you can attack is a body, something you cannot is
//     scenery. That is an inference and it is marked as one.
//   * `exits` IS ALWAYS `[]` for a keeper-backed character -- keeperView returns the empty array
//     unconditionally (m59-render-projection.mjs) and says so in its own comment. A reader that
//     captured exits from `look` would record "this room has no way out" about every room in the
//     world. So a scene does not capture exits, and that is a refusal rather than an oversight.
//
// AND WE READ OUR OWN FLEET DEEPLY AND EVERYONE ELSE SHALLOWLY. `status`, `inventory` and
// `equipment` answer for a character we hold the socket for. For anybody else in the room there
// is a name and a square and nothing further. A scene captured from one viewpoint is therefore
// mostly `unknown` outside our own roster, which is the honest result and is exactly what
// `sceneConfidence()` is for: it will say so rather than letting the gaps read as zeroes.

/** Attackable means a body; not attackable means furniture. An inference, marked as one. */
export const classify = (o) =>
  o.is_player ? 'player'
  : (Array.isArray(o.can) && o.can.includes('attack')) ? 'monster'
  : 'item';

/**
 * Read the room an agent is standing in, and build a scene.
 *
 * `read(tool, args)` is injected -- the same reason runNamed takes fleetScript and consultCorpus
 * takes its runner: the capture is then testable against a fixture, and nothing in this file
 * opens a socket. The CLI supplies a real broker call.
 *
 * `ours` is the set of handles we hold the socket for; only those get the deep read.
 * `hpEstimate(name, ctx)` is the hook for telemetry that does not exist yet -- return a number
 * to have it recorded as ESTIMATED, or null to have it recorded as unknown. It must never be
 * allowed to return a number it is not entitled to: an invented hit point total is the one value
 * in a scene that nobody can check afterwards.
 */
export async function captureRoom({ agent, read, name = null, ours = [], hpEstimate = null,
                                    capturedFrom = null, provenance = null } = {}) {
  if (!agent) throw new Error('captureRoom needs an agent to look through');
  if (typeof read !== 'function') throw new Error('captureRoom needs a read(tool, args) function');
  const mine = new Set([agent, ...ours].map(a => String(a).toLowerCase()));

  const view = await read('look', { agent });
  const roomNum = view?.room?.num ?? null;
  if (roomNum == null) throw new Error(`could not tell what room ${agent} is in`);

  const room = { num: roomNum, name: view.room?.name ? observed(view.room.name) : unknownField() };
  const actors = [];

  // The looking character: the one body we can read all the way down.
  const self = await read('status', { agent }).catch(() => null);
  const pack = await read('inventory', { agent }).catch(() => null);
  const worn = await read('equipment', { agent }).catch(() => null);
  actors.push({
    kind: 'player', name: self?.name ?? agent, agent, mine: true,
    at: view.you && Number.isFinite(view.you.col)
      ? observed({ row: view.you.row, col: view.you.col }) : unknownField(),
    vitals: {
      hp: self?.hp ? observed(self.hp) : unknownField(),
      mana: self?.mana ? observed(self.mana) : unknownField(),
      vigor: self?.vigor ? observed(self.vigor) : unknownField(),
    },
    inventory: pack?.items ? observed(pack.items) : unknownField(),
    equipment: worn ? observed(worn) : unknownField(),
  });

  for (const o of view.objects ?? []) {
    const kind = classify(o);
    const isOurs = o.is_player && mine.has(String(o.name ?? '').toLowerCase());
    const actor = {
      kind, name: o.name ?? `object ${o.id}`,
      // THE ID IS RECORDED AND MUST NOT BE RELIED ON. Object ids are renumbered around a save
      // (m59-dm.mjs's own second lesson), so this is a breadcrumb for the capture session and
      // never a key. `loadPlan` addresses actors by NAME for exactly that reason.
      object_at_capture: o.id ?? null,
      at: observed({ row: o.row, col: o.col }),
      facing: o.facing ? observed(o.facing) : unknownField(),
      // Marked estimated because it is read off an affordance list, not told to us.
      kind_source: estimated(kind === 'item' ? 'not attackable' : (o.is_player ? 'is_player' : 'attackable')),
    };
    if (kind !== 'item') {
      let est = null;
      if (typeof hpEstimate === 'function')
        try { est = await hpEstimate(actor.name, { room: roomNum, object: o.id }); }
        catch { est = null; }
      actor.vitals = {
        hp: Number.isFinite(est?.value) ? estimated(est) : unknownField(),
        mana: unknownField(),
      };
    }
    if (isOurs) actor.mine = true;
    if (o.amount) actor.amount = observed(o.amount);
    actors.push(actor);
  }

  return makeScene({
    name: name ?? `room-${roomNum}`,
    room, actors, capturedFrom, provenance,
    notes: [
      `captured by looking through ${agent}; only our own roster is read deeply`,
      'exits are NOT captured: keeperView returns exits:[] unconditionally for a ' +
      'keeper-backed character, so capturing them would record every room as having none',
      'object ids are a breadcrumb, not a key — the server renumbers them around a save',
    ],
  });
}

// ------------------------------------------------------------------ rebuilding it, held
//
// THE SCENE COMES UP PAUSED, AND THAT IS THE ORDER OF THE PLAN RATHER THAN A FLAG.
//
// A monster that is already acting while you are still placing the other eleven is not a
// reconstruction, it is a fight you did not choose. So every actor is frozen FIRST, in one
// batch, and only then positioned, dressed and healed. Releasing is a separate verb.
//
// The freeze is `ClearBasicTimers` (monster.kod:4281), which deletes ptRandom, ptSpasm and the
// rest of a monster's own clocks; `StartBasicTimers` (:4242) puts them back. Both are ordinary
// kod messages, so the maintenance socket can send them.
//
// WHAT THIS DOES NOT DO, said out loud because "paused" implies more than it delivers: it stops
// a monster ACTING ON ITS OWN. It does not make it inert. Reactive handlers -- SomethingMoved,
// SomethingAttacked (brain.kod:132, :190) -- fire on events rather than timers, so a held
// monster still answers a body walking into it. A scene is quiet, not frozen in amber.
export const HOLD_MSG = 'ClearBasicTimers';
export const RELEASE_MSG = 'StartBasicTimers';

/**
 * The ordered DM commands that rebuild this scene. PURE — sends nothing.
 *
 * Kept pure so `plan` can print it, a test can assert it, and nobody has to drive a server to
 * find out what a scene would do. Same contract as fleetScript's `dry`.
 */
export function loadPlan(scene, { pause = true, roomObject = '<room>', objectFor = null } = {}) {
  const steps = [];
  // THE CAPTURED ID IS NEVER USED TO ADDRESS ANYTHING. `object_at_capture` is a breadcrumb from
  // the capture session and the server renumbers objects around a save, so an executor resolves
  // names AGAIN, in the same batch it uses them, and passes the result in here. With no resolver
  // the plan addresses by name — which is what `plan` prints and what a test asserts.
  const ref = a => (objectFor ? objectFor(a.name) ?? a.name : a.name);

  if (pause) {
    for (const a of scene.actors ?? []) {
      if (a.kind === 'item') continue;
      steps.push({ why: `hold ${a.name}`, actor: a.name, cmd: sendMsg(ref(a), HOLD_MSG) });
    }
  }
  for (const a of scene.actors ?? []) {
    const at = a.at?.v ?? a.at;
    if (at && at.row != null && at.col != null)
      steps.push({ why: `place ${a.name} at r${at.row}c${at.col}`, actor: a.name,
                   cmd: relocateCmd(ref(a), roomObject, at.row, at.col) });
  }
  for (const a of scene.actors ?? []) {
    const st = a.stats?.v ?? a.stats;
    if (st && Object.keys(st).length)
      for (const cmd of statCmds(ref(a), st))
        steps.push({ why: `stats for ${a.name}`, actor: a.name, cmd });
    const hp = a.vitals?.hp?.v ?? a.vitals?.hp;
    if (hp?.value != null)
      for (const cmd of healthCmds(ref(a), hp.value))
        steps.push({ why: `health for ${a.name}` +
                          (a.vitals?.hp?.how === ESTIMATED ? ' (ESTIMATED)' : ''),
                     actor: a.name, cmd, estimated: a.vitals?.hp?.how === ESTIMATED });
    const mp = a.vitals?.mana?.v ?? a.vitals?.mana;
    if (mp?.value != null)
      for (const cmd of manaCmds(ref(a), mp.value))
        steps.push({ why: `mana for ${a.name}`, actor: a.name, cmd });
  }
  return steps;
}

/** The commands that start the clocks again. Separate verb, on purpose. */
export const releasePlan = (scene, { objectFor = null } = {}) => (scene.actors ?? [])
  .filter(a => a.kind !== 'item')
  .map(a => ({ why: `release ${a.name}`, actor: a.name,
               cmd: sendMsg(objectFor ? objectFor(a.name) ?? a.name : a.name, RELEASE_MSG) }));

/**
 * REFUSE TO REBUILD ANYWHERE BUT A LAB. The same rule m59-dm.mjs and m59-shadow.mjs enforce,
 * restated here because this file is the one that will be handed to a stranger with a scenario.
 */
export function assertLab(env = process.env) {
  const t = adminTarget(env);
  if (!isLoopbackHost(t.host))
    throw new Error(
      `refusing to load a scene against ${t.host}: a scene rebuild sets stats, health and ` +
      `positions by fiat, and the only place that is a test rather than an incident is a ` +
      `loopback lab server.`);
  return t;
}

// ------------------------------------------------------------------ actually doing it
//
// THE EXECUTOR RESOLVES NAMES AGAIN RATHER THAN TRUSTING THE CAPTURE.
//
// m59-dm.mjs's second lesson, applied: object ids are renumbered when the server garbage
// collects, which it does around a save every fifteen minutes. A scene captured an hour ago
// carries ids that may now be somebody else's furniture. So every load resolves the NAMES it
// recorded, in the same batch it uses them, and `object_at_capture` is never addressed.
//
// AND IT VERIFIES, BECAUSE THE SERVER NEVER SAYS NO. `UtilGoNearSquare` returns 1 for a square
// that does not exist -- it searches outward and finds something standable -- so a clean reply
// from a relocate is not a body on the square you asked for. The load reads the room back and
// reports what actually landed, which is the same reason `reach()` asks `holds` twice.

/**
 * Resolve every actor name in the scene to a CURRENT object id.
 *
 * The resolve is done here rather than through m59-dm's `resolve()` for one reason: that helper
 * calls the real `dm()` directly, so a caller supplying its own socket function could not reach
 * it and every test would have needed a live server. Same two commands, same parsing, injectable.
 */
export async function resolveActors(scene, { dmFn = dm, env = process.env } = {}) {
  const names = [...new Set((scene.actors ?? []).map(a => a.name).filter(Boolean))];
  if (!names.length) return { map: new Map(), missing: [] };
  const cmds = names.map(n => `show name ${n}`);
  const out = await dmFn(cmds, { env });
  const blocks = split(out, cmds);
  const map = new Map();
  const missing = [];
  names.forEach((n, i) => {
    const m = /object (\d+)/i.exec(blocks[i] || '');
    if (m) map.set(n, Number(m[1])); else missing.push(n);
  });
  return { map, missing };
}

/** The room's CURRENT object, resolved the same injectable way. */
export async function resolveRoom(num, { dmFn = dm, env = process.env } = {}) {
  const cmd = `show room ${num}`;
  const out = await dmFn([cmd], { env });
  const m = /object (\d+)/i.exec(String(out));
  return m ? Number(m[1]) : null;
}

/**
 * Rebuild the scene on the lab server, held.
 *
 * Refuses off loopback, refuses when an actor cannot be found, and reads the room back afterwards
 * so the caller learns what actually landed rather than that the commands were accepted.
 */
export async function executeLoad(scene, { pause = true, verify = null, dmFn = dm,
                                           env = process.env } = {}) {
  assertLab(env);
  const { map, missing } = await resolveActors(scene, { dmFn, env });
  if (missing.length)
    return { ok: false, sent: 0, missing,
             why: `refusing to load "${scene.name}": ${missing.length} actor(s) are not on this ` +
                  `server — ${missing.join(', ')}. A scene half-rebuilt is worse than one not ` +
                  `rebuilt, because the half that landed looks like the whole.` };

  const room = await resolveRoom(scene.room.num, { dmFn, env });
  if (room == null)
    return { ok: false, sent: 0, missing: [],
             why: `room ${scene.room.num} was not found on this server` };

  const steps = loadPlan(scene, { pause, roomObject: room, objectFor: n => map.get(n) });
  const out = await dmFn(steps.map(st => st.cmd), { env });
  const bad = rejections(out);

  let landed = null;
  if (typeof verify === 'function') landed = await verify(scene, map).catch(e => ({ error: e.message }));
  return { ok: bad.length === 0, sent: steps.length, missing: [], rejections: bad, landed,
           estimatedCommands: steps.filter(st => st.estimated).length,
           why: bad.length ? `${bad.length} command(s) were rejected: ${bad.slice(0, 3).join('; ')}`
                           : null };
}

/** Start the clocks again. Separate verb, on purpose — see the note above loadPlan. */
export async function executeRelease(scene, { dmFn = dm, env = process.env } = {}) {
  assertLab(env);
  const { map, missing } = await resolveActors(scene, { dmFn, env });
  const steps = releasePlan(scene, { objectFor: n => map.get(n) })
    .filter(st => !missing.includes(st.actor));
  if (!steps.length) return { ok: true, sent: 0, skipped: missing };
  const out = await dmFn(steps.map(st => st.cmd), { env });
  const bad = rejections(out);
  return { ok: bad.length === 0, sent: steps.length, skipped: missing, rejections: bad };
}

// ------------------------------------------------------------------ reading it off the broker
//
// One JSON-RPC call, the same shape m59-fleetscript's private `call` makes. Kept here rather than
// imported because that one is deliberately private -- a step must not be able to bypass its
// pacing -- and a capture is a different caller with different needs.
export async function brokerRead(tool, args = {}, { ms = 60_000 } = {}) {
  const r = resolveControlUrl();
  if (!r.url) throw new Error(`no broker named: ${r.why}`);
  const res = await fetch(r.url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
                           params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(ms),
  });
  const d = await res.json();
  try { return JSON.parse(d.result.content[0].text); }
  catch { return d.result?.content?.[0]?.text ?? d; }
}

// ---------------------------------------------------- the runner reach() hands declarative work
//
// `checkpoint({ establish: { scene: 'feast-hall' } })` names a scene instead of supplying a
// function, and `reach()` needs somebody to carry that out. This is that somebody, and keeping it
// here rather than inside m59-establish.mjs is deliberate: the strategy layer decides WHETHER a
// shortcut may be taken and writes down that it was; it should not also know how to talk to a
// server. That separation is what lets the whole of m59-establish.mjs be tested with no socket.
//
// SHADOW IS THE SAME OPERATION SCOPED TO CHARACTERS. `m59-shadow.mjs dress` sets level, karma,
// position and equipment on a cloned roster -- which is a scene load whose actor list happens to
// be "our people" rather than "this room". It is wired here as a child process because that is
// what exists today; the deeper version is for `dress` to BE a scene load with the actor list
// filtered, so cloning a fleet with its surroundings is one code path and not two. See the note
// in docs/m59-fleetscratch.md.
export function sceneRunner({ dir = SCENE_DIR, env = process.env, spawn = null } = {}) {
  return async (which, value, ctx = {}) => {
    if (which === 'scene') {
      const path = String(value).endsWith('.json') ? String(value) : join(dir, `${value}.json`);
      if (!existsSync(path)) throw new Error(`no scene at ${path}`);
      const scene = readScene(path);
      const r = await executeLoad(scene, { env });
      if (!r.ok) throw new Error(r.why ?? 'the scene did not load');
      return r;
    }
    if (which === 'shadow') {
      assertLab(env);
      const args = Array.isArray(value) ? value : [String(value || 'dress')];
      const run = spawn ?? defaultSpawn;
      const out = await run('m59-shadow.mjs', args, env);
      if (out.code !== 0)
        throw new Error(`m59-shadow.mjs ${args.join(' ')} exited ${out.code}: ` +
                        `${String(out.out).trim().split(/\r?\n/).slice(-2).join(' / ')}`);
      return out;
    }
    throw new Error(`sceneRunner does not carry out "${which}" — it handles scene and shadow`);
  };
}

async function defaultSpawn(tool, args, env) {
  const { spawn } = await import('node:child_process');
  return new Promise((res) => {
    const kid = spawn(process.execPath, [join(HERE, tool), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    kid.stdout.on('data', d => { out += d; });
    kid.stderr.on('data', d => { out += d; });
    kid.on('close', code => res({ code, out }));
  });
}

// ------------------------------------------------------------------ publishing one
//
// A SCENE IS A ROSTER WITH THE PASSWORDS NEXT TO IT UNTIL SOMEBODY TAKES THEM OUT.
//
// Meridian 59 is open source and a reproduction is worth more when somebody else can run it, so
// scenes are meant to be publishable. But a captured scene names our characters and may carry
// account material, and `substrate/fleet-accounts.json` is the only copy of the fleet's
// passwords. So publishing is an explicit verb that REWRITES rather than a flag that trusts.
//
// Names are replaced positionally (actor1, actor2) rather than removed: a reader has to be able
// to follow "actor3 attacked actor1" through the notes, and a scrub that leaves holes is a
// scrub nobody can use.
const SECRET_KEYS = /pass|secret|token|credential|account|md5|hash|email/i;

export function scrubScene(scene, { keepNames = false } = {}) {
  const alias = new Map();
  let n = 0;
  for (const a of scene.actors ?? [])
    if (!alias.has(a.name)) alias.set(a.name, keepNames ? a.name : `actor${++n}`);

  const rename = (s) => {
    let out = String(s);
    for (const [real, fake] of alias)
      if (real) out = out.split(real).join(fake);
    return out;
  };
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (SECRET_KEYS.test(k)) continue;            // dropped entirely, never masked
        out[k] = typeof v === 'string' ? rename(v) : walk(v);
      }
      return out;
    }
    return node;
  };
  const scrubbed = walk(scene);
  scrubbed.actors = (scrubbed.actors ?? []).map((a, i) => ({ ...a, name: alias.get(scene.actors[i].name) }));
  scrubbed.published = { scrubbed_at: new Date().toISOString(),
                         names: keepNames ? 'kept' : 'aliased',
                         dropped_keys: 'anything matching pass|secret|token|credential|account|md5|hash|email' };
  return scrubbed;
}

/** What is still missing before this scene can be handed to somebody else. */
export function publishBlockers(scene) {
  const bad = [];
  const p = scene.provenance ?? {};
  for (const [which, v] of Object.entries(p)) {
    if (!v?.commit) bad.push(`${which} has no pinned commit — ${v?.why ?? 'unknown'}`);
    else if (v.dirty) bad.push(`${which} was captured from a DIRTY working tree (${v.commit}) — ` +
                               `nobody else can check that out`);
  }
  const c = sceneConfidence(scene);
  if (!c.total) bad.push('the scene captured no fields at all');
  for (const a of scene.actors ?? [])
    if (SECRET_KEYS.test(JSON.stringify(a))) bad.push(`actor ${a.name} still carries a secret-shaped key`);
  return bad;
}

export const sceneFile = (name) => join(SCENE_DIR, `${String(name).replace(/[^\w.-]/g, '_')}.json`);
export function writeScene(scene) {
  mkdirSync(SCENE_DIR, { recursive: true });
  const f = sceneFile(scene.name);
  writeFileSync(f, JSON.stringify(scene, null, 2));
  return f;
}
export const readScene = (path) => JSON.parse(readFileSync(path, 'utf8'));

// ------------------------------------------------------------------ CLI
const invokedDirectly = process.argv[1] &&
  basename(process.argv[1]).replace(/\.mjs$/, '') === 'm59-scene';
if (invokedDirectly) {
  const [action, target, ...rest] = process.argv.slice(2);
  const arg = (k, d = null) => {
    const i = rest.indexOf(`--${k}`);
    return i >= 0 ? (rest[i + 1] ?? true) : d;
  };
  const show = (steps) => {
    for (const [i, s] of steps.entries())
      console.log(`  ${String(i).padStart(3)}. ${s.why}${s.estimated ? '  [ESTIMATED]' : ''}`);
    console.log(`  ${steps.length} command(s). Nothing was sent.`);
  };
  try {
    if (action === 'save') {
      const agent = target;
      if (!agent) throw new Error('usage: m59-scene.mjs save <agent> --name <scene>');
      const scene = await captureRoom({
        agent, read: brokerRead, name: arg('name'), capturedFrom: arg('from', 'prod'),
        ours: String(arg('ours', '')).split(',').map(x => x.trim()).filter(Boolean),
      });
      const f = writeScene(scene);
      console.log(`${scene.name} — room ${scene.room.num}, ${scene.actors.length} actor(s)`);
      console.log(formatConfidence(sceneConfidence(scene)));
      console.log(`wrote ${f}`);
    } else if (action === 'plan' || action === 'load' || action === 'release') {
      const scene = readScene(target);
      const steps = action === 'release' ? releasePlan(scene)
                                         : loadPlan(scene, { pause: arg('running') == null });
      console.log(`${scene.name} — room ${scene.room.num}, ${scene.actors.length} actor(s)`);
      console.log(formatConfidence(sceneConfidence(scene)));
      console.log('');
      show(steps);
      if (action !== 'plan') {
        const res = action === 'release' ? await executeRelease(scene)
                                         : await executeLoad(scene, { pause: arg('running') == null });
        if (!res.ok) { console.error(`\n${res.why ?? 'refused'}`); process.exitCode = 1; }
        else console.log(`\nsent ${res.sent} command(s)` +
                         (res.estimatedCommands ? `, ${res.estimatedCommands} of them ESTIMATED` : '') +
                         '. The server never says no — read the room back before believing it.');
      }
    } else if (action === 'scrub') {
      const scene = readScene(target);
      const blockers = publishBlockers(scene);
      const out = scrubScene(scene, { keepNames: arg('keep-names') != null });
      const dir = arg('o', 'published');
      mkdirSync(dir, { recursive: true });
      const f = join(dir, `${out.name}.json`);
      writeFileSync(f, JSON.stringify(out, null, 2));
      console.log(`wrote ${f}`);
      if (blockers.length) {
        console.log('\nNOT READY TO PUBLISH:');
        for (const b of blockers) console.log(`  - ${b}`);
        process.exitCode = 1;
      }
    } else {
      console.log('usage: m59-scene.mjs save <agent> --name <scene>');
      console.log('       m59-scene.mjs plan|load|release|scrub <scene.json>');
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(`m59-scene: ${e.message}`);
    process.exitCode = 1;
  }
}
