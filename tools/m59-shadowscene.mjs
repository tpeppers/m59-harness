#!/usr/bin/env node
// THE SHADOW FLEET IS A SCENE LOAD WITH THE ACTOR LIST FILTERED TO OUR OWN CHARACTERS.
//
//   import { snapshotToScene, filterActors, dressPlan, shadowRunner } from './m59-shadowscene.mjs';
//
// ============================================================ THE SENTENCE THIS FILE ANSWERS
//
// m59-establish.mjs's own header, listing the four ways to reach a checkpoint:
//
//     shadow   m59-shadow.mjs `dress`. A scene load scoped to CHARACTERS rather than a room --
//              WHICH IS WHY THE SHADOW FLEET HAS NEVER CLONED ANYBODY'S SURROUNDINGS: it was
//              written as its own thing rather than as one of these.
//
// That is the whole diagnosis. `dress` and `executeLoad` do the same job — resolve names to
// current object ids, then set stats, health and position by fiat on a loopback server — and
// because they were written separately, `dress` grew an actor list and no room, while
// `executeLoad` grew a room and no way to say "only these actors". Each was missing exactly
// what the other had.
//
// So this file is the join, and it is deliberately thin:
//
//   snapshotToScene   a shadow snapshot IS a scene. Same schema, same provenance, same
//                     observed/estimated marking — the characters become actors with
//                     `mine: true`, and every field carries how we know it.
//   filterActors      the missing half of executeLoad. `only`/`except`/`kinds`/`mine` narrow
//                     a scene's actor list, so one loader serves "dress my characters",
//                     "rebuild the monsters and leave my fleet where it stands", and "load
//                     the whole room".
//   dressPlan         the pure part of cmdDress, as DM commands. Same helpers (statCmds,
//                     healthCmds), so it is the same commands rather than a second opinion
//                     about them.
//
// ============================================================ WHAT IT BUYS, CONCRETELY
//
// The shadow fleet can now clone surroundings, which is the thing the header said it never
// could. Capture a prod room with `captureRoom`, then:
//
//   load the scene with `mine: false`   -> the monsters and furniture, without touching our
//                                          characters (who are being dressed separately)
//   load it with `mine: true`           -> exactly what `dress` does today
//   load it whole                       -> the room AND the fleet standing in it
//
// And `checkpoint({ establish: { shadow: 'prod-mirror' } })` gets a runner, so "the fleet is
// dressed like production" becomes a checkpoint with a `holds` predicate like any other —
// which means it is asked twice, and a dress that silently landed somebody in the wrong room
// is caught by the same mechanism that catches a DM teleport landing on the wrong square.
//
// ============================================================ WHAT IS NOT MOVED, AND WHY
//
// The weapon and the position phases of cmdDress stay procedural, because both must ASK the
// world before they can decide: the weapon phase reads the character's inventory (created
// unconditionally, it accumulated — five runs left every shadow carrying five hammers), and the
// placement phase verifies each relocate one at a time because UtilGoNearSquare never says no.
// A pure plan cannot do either. What it CAN do is take the same filtered actor list, which is
// what makes the two halves one operation rather than two.
//
// ============================================================ AND WHY THE SPLIT IS ALONG THIS LINE
//
// m59-shadow.mjs IS GITIGNORED -- `/tools/m59-shadow.mjs`, because it reads live production
// characters and writes their stats to disk. This file is not, and the difference is the whole
// reason to separate them rather than adding the filter inside `dress`: everything here is pure
// transformation and DM command generation against a snapshot it is handed. It reads no
// production, opens no socket, and carries no credential -- the same class of module as
// m59-scene.mjs, which is committed for the same reason.
//
// So `cmdDress` calling into this is a wiring that lives only on the machine that owns the
// roster. If you are reading this in a checkout without m59-shadow.mjs, the shape it uses is:
//
//   const scene = filterActors(snapshotToScene(snap), { only });
//   const cmds  = dressPlan({ ...scene, actors: scene.actors.filter(a => ids[a.name] != null) },
//                           { objectFor: n => ids[n] }).map(st => st.cmd);
import { statCmds, healthCmds, setProp } from './m59-dm.mjs';
import { SCENE_SCHEMA, observed, estimated, unknownField, sceneProvenance,
         OBSERVED, ESTIMATED } from './m59-scene.mjs';

/**
 * A shadow snapshot, as a scene.
 *
 * `room` is the scene's room and a snapshot has one per character, so this records the room each
 * actor stands in ON THE ACTOR and leaves the scene's own room as the majority one. A shadow
 * snapshot is a fleet scattered across the world rather than a tableau in one hall, and
 * pretending otherwise would make `executeLoad`'s room resolution place twenty-one characters in
 * whichever room happened to come first.
 */
export function snapshotToScene(snap, { name = 'prod-mirror', provenance = null } = {}) {
  const chars = [].concat(snap?.characters ?? []);
  if (!chars.length) throw new Error('a shadow snapshot with no characters is not a scene');

  const actors = chars.map(c => {
    const a = {
      kind: 'player', mine: true,
      name: c.shadow_name, agent: c.shadow_account,
      // KEPT, because it is the only way back to the character this one is a copy of.
      mirrors: c.prod_character ?? null,
      room: c.room ?? null,
      at: (c.row != null && c.col != null) ? observed({ row: c.row, col: c.col }) : unknownField(),
      vitals: {
        // MAX HEALTH IS THE LEVEL in this game (GetLevel returns GetBaseMaxHealth), so it is
        // recorded as health rather than as a separate level field that would then need
        // reconciling with it.
        hp: Number.isFinite(c.max_health) ? observed({ value: c.max_health }) : unknownField(),
        mana: unknownField(),
        vigor: Number.isFinite(c.vigor) ? observed({ value: c.vigor }) : unknownField(),
      },
      wielding: c.wielding ? observed(c.wielding) : unknownField(),
    };
    // The sheet is read off the character generation record, not off the wire, so it is observed
    // when present and absent rather than zeroed when not. m59-shadow's own rule: a snapshot with
    // no sheet says "NO SHEET — attributes unknown" instead of inventing six numbers.
    a.stats = (c.attributes && c.attributes.might != null) ? observed(c.attributes) : unknownField();
    return a;
  });

  // The room most of the fleet is standing in, so `executeLoad` has something to resolve. Actors
  // elsewhere carry their own `room` and are placed by the procedural half.
  const counts = new Map();
  for (const c of chars) if (c.room != null) counts.set(c.room, (counts.get(c.room) ?? 0) + 1);
  const [majority] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null];

  return {
    schema: SCENE_SCHEMA, name,
    captured: { at: snap?.taken_at ?? new Date().toISOString(), from: snap?.source ?? null },
    provenance: provenance ?? sceneProvenance(),
    room: { num: majority, name: unknownField() },
    actors,
    notes: [
      'built from a shadow snapshot, so every actor is one of ours and none of the room is here',
      `the scene room is where ${counts.get(majority) ?? 0} of ${chars.length} characters stand; ` +
      'the rest carry their own `room` and are placed one at a time',
      'no credentials: a snapshot carries shadow_account, never a password',
    ],
    certification: { tier: 'recorded', reality: null, runs: null, outcome: null },
  };
}

/**
 * Narrow a scene's actor list. The half executeLoad was missing.
 *
 * Every filter is a WHITELIST except `except`, and they compose by intersection, so the default
 * (no options) returns the scene untouched. That matters: a filter that silently dropped actors
 * when called with an empty option would produce a half-rebuilt scene, which m59-scene.mjs
 * already says is worse than one not rebuilt because the half that landed looks like the whole.
 */
export function filterActors(scene, { only = null, except = null, kinds = null,
                                      mine = null } = {}) {
  const lower = (x) => String(x ?? '').toLowerCase();
  const onlySet = only ? new Set([].concat(only).map(lower)) : null;
  const exceptSet = except ? new Set([].concat(except).map(lower)) : null;
  const kindSet = kinds ? new Set([].concat(kinds)) : null;

  const kept = (scene.actors ?? []).filter(a => {
    const n = lower(a.name), ag = lower(a.agent);
    if (onlySet && !onlySet.has(n) && !onlySet.has(ag)) return false;
    if (exceptSet && (exceptSet.has(n) || exceptSet.has(ag))) return false;
    if (kindSet && !kindSet.has(a.kind)) return false;
    if (mine === true && a.mine !== true) return false;
    if (mine === false && a.mine === true) return false;
    return true;
  });
  const dropped = (scene.actors ?? []).length - kept.length;
  return {
    ...scene, actors: kept,
    filtered: dropped ? { dropped, of: (scene.actors ?? []).length,
                          by: [only && 'only', except && 'except', kinds && 'kinds',
                               mine != null && `mine=${mine}`].filter(Boolean).join(', ') }
                      : null,
  };
}

/** Names in `only` that match no actor. Silently dropping them is how a load half-lands. */
export function unmatched(scene, only) {
  if (!only) return [];
  const have = new Set((scene.actors ?? []).flatMap(a => [a.name, a.agent])
    .filter(Boolean).map(x => String(x).toLowerCase()));
  return [].concat(only).filter(n => !have.has(String(n).toLowerCase()));
}

/**
 * The DM commands that write a scene's actors onto the server. PURE — sends nothing.
 *
 * This is cmdDress's first phase, as a plan: stats, then max health, then vigor. The ORDER and
 * the helpers are cmdDress's, not a restatement of them — `healthCmds` exists because piHealth
 * alone gets refigured straight back down, piMax_Health alone leaves the base where it was, and
 * the base is what the game reads as level. Calling it here is what makes this the same
 * operation rather than a second implementation that will drift.
 */
export function dressPlan(scene, { objectFor = null, vigor = true } = {}) {
  const steps = [];
  const ref = a => (objectFor ? objectFor(a.name) ?? a.name : a.name);
  for (const a of scene.actors ?? []) {
    const id = ref(a);
    const st = a.stats?.v ?? (a.stats?.how ? null : a.stats);
    if (st && Object.keys(st).length)
      for (const cmd of statCmds(id, st))
        steps.push({ why: `stats for ${a.name}`, actor: a.name, cmd });

    const hp = a.vitals?.hp?.v ?? a.vitals?.hp;
    if (hp?.value != null)
      for (const cmd of healthCmds(id, hp.value))
        steps.push({ why: `max health (which IS the level) for ${a.name}`, actor: a.name, cmd,
                     estimated: a.vitals?.hp?.how === ESTIMATED });

    // VIGOR AND EXERTION TOGETHER. Exertion is what eats vigor back down, so setting one without
    // the other leaves the copy draining at a rate the original is not — and a snapshot taken
    // before vigor was recorded has none, in which case the character is LEFT ALONE rather than
    // defaulted, because an invented number is worse than a missing one.
    const vg = a.vitals?.vigor?.v ?? a.vitals?.vigor;
    if (vigor && vg?.value != null) {
      steps.push({ why: `vigor for ${a.name}`, actor: a.name,
                   cmd: setProp(id, 'piVigor', Math.max(0, Math.round(vg.value))) });
      steps.push({ why: `exertion for ${a.name}`, actor: a.name, cmd: setProp(id, 'piExertion', 0) });
      steps.push({ why: `apply vigor for ${a.name}`, actor: a.name, cmd: `send object ${id} NewVigor` });
    }
  }
  return steps;
}

/** How much of this dress is measured rather than guessed — the same question sceneConfidence asks. */
export function dressConfidence(scene) {
  const t = { observed: 0, estimated: 0, unknown: 0 };
  for (const a of scene.actors ?? [])
    for (const f of [a.stats, a.at, a.wielding, a.vitals?.hp, a.vitals?.vigor])
      if (f && typeof f.how === 'string') t[f.how] = (t[f.how] ?? 0) + 1;
  const total = t.observed + t.estimated + t.unknown;
  return { ...t, total, ratio: total ? t.observed / total : 0 };
}

export function formatDress(scene, steps) {
  const c = dressConfidence(scene);
  const out = [`${scene.name}: ${(scene.actors ?? []).length} actor(s), ${steps.length} command(s)`];
  if (scene.filtered)
    out.push(`  filtered: ${scene.filtered.dropped} of ${scene.filtered.of} actor(s) dropped ` +
             `by ${scene.filtered.by}`);
  out.push(`  fields: ${c.observed} observed, ${c.estimated} estimated, ${c.unknown} unknown`);
  const est = steps.filter(s => s.estimated).length;
  if (est) out.push(`  ${est} command(s) write an ESTIMATED value — those are the ones to doubt`);
  return out.join('\n');
}

/**
 * The runner `reach()` hands `establish: { shadow: '<scene name>' }` to.
 *
 * Mirrors sceneRunner: injectable everywhere, opens nothing by itself, and refuses off loopback
 * through the same executeLoad that every other scene load goes through — so "dress the fleet"
 * inherits the lab refusal rather than carrying its own copy of it.
 */
export function shadowRunner({ readSnapshot, execute, only = null, mine = true } = {}) {
  return async function run(which, value, ctx = {}) {
    if (which !== 'shadow')
      throw new Error(`shadowRunner was handed strategy "${which}"`);
    const snap = await readSnapshot();
    const scene = snapshotToScene(snap, { name: typeof value === 'string' ? value : 'prod-mirror' });
    const want = only ?? ctx.agents ?? null;
    const miss = unmatched(scene, want);
    if (miss.length)
      throw new Error(`the snapshot has no actor for ${miss.join(', ')} — refusing to dress a ` +
                      `partial fleet, because the part that landed looks like the whole`);
    // PASSED THROUGH AS-IS. `mine ? true : null` was here, which quietly turned an explicit
    // `mine: false` — "dress everything that is NOT ours" — into "do not filter at all", and a
    // filter that widens when told to narrow is the exact shape of the half-load this file
    // refuses everywhere else. false means false; null means no filter.
    const filtered = filterActors(scene, { only: want, mine });
    if (!filtered.actors.length)
      throw new Error(`nothing to dress: the filter left no actors`);
    // PAUSE OFF. A scene load freezes monsters so a tableau can be built without a fight
    // starting; dressing our own characters has nothing to freeze, and ClearBasicTimers on a
    // player is not a thing this wants to be doing by default.
    return execute(filtered, { pause: false });
  };
}
