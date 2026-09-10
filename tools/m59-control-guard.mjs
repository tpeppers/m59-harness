// A SCRIPT CONTROLS THE CHARACTERS IT DECLARED, AND NO OTHERS.
//
//   import { declaredControl, controlViolation } from './m59-control-guard.mjs';
//
// WHY THIS EXISTS, and why it is a separate file rather than four lines inside runStep().
//
// FleetScript used to take ONE lock over the whole fleet for every errand, however small.
// That was wrong in the direction everybody notices — two errands driving disjoint
// characters serialised for no reason, measured 2026-09-10 when minor heal had to be bought
// for Pepe and then Statler one after the other, same teacher, no shared body between them.
//
// The obvious fix is to lock `agents` instead of the fleet. That is better and still not
// right, because `agents` is what the run was STARTED with, not what it turns out to touch.
// Operator, 2026-09-10:
//
//   "the way fleetscript should handle it is really 'locks characters it will control'
//    (with an error/warning for trying to order around/control a character in a script
//    that isn't called out as locked at the top of the file?)"
//
// So the unit is a DECLARATION, not an inference. A script says at the top which characters
// it will drive; the lock is taken over exactly that set; and driving anything outside it is
// a fault rather than a silently wider blast radius. The failure that catches is the one
// nobody sees in a log: a script that touches a body it never said it would, and therefore
// never locked, while some other driver holds it.
//
// THE HOLE IT IS ACTUALLY PLUGGING IS `act`. Most verbs take the agent the step is being run
// for, and for those a declaration adds little. `act(tool, args)` is the escape hatch — it
// forwards arbitrary arguments to any broker tool, so `act('supply', { from: 't7', to: 't2' })`
// drives t7 from a script that named only t2. That call is indistinguishable from a correct
// one until you read the transit book. Hence the scan below is over EVERY string in the
// step at any depth, not just a known `agent` field: the same argument m59-menagerie-guard
// makes about host names, for the same reason, and it is the reason that guard reads
// arguments rather than trusting a tool's schema.
//
// WHAT THIS IS NOT. It is not a permission system and it must never be described as one. A
// script that wants a character declares it and gets it; nothing here refuses on authority.
// It stops the MISTAKE — an undeclared body driven by accident — which is the whole
// requirement, and it is the same shape as `unsafe: { reason, waives }`: declare the intent
// at the top, enforce it at the door, and make "I meant to" and "I did not notice" look
// different on the page.

// Fields whose content is PROSE, where a character's name is being talked about rather than
// commanded. Without this every `why:` explaining which character an errand is for would
// trip the guard, which is how a check like this gets switched off in its first week.
const FREE_TEXT_FIELDS = new Set([
  'why', 'reason', 'label', 'message', 'text', 'note', 'describe', 'description',
  'said', 'name', 'title', 'comment',
]);

function* strings(value, key = null, depth = 0) {
  if (depth > 6) return;                       // bounded; steps are small and not cyclic
  if (typeof value === 'string') {
    if (!FREE_TEXT_FIELDS.has(key)) yield value;
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) yield* strings(v, key, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) yield* strings(v, k, depth + 1);
  }
}

/**
 * WHAT A SCRIPT SAID IT WOULD DRIVE.
 *
 * `controls` is the declaration and is the whole point of this file. When it is absent the
 * set falls back to the agents the run was started with, and the answer says so — because
 * the twenty scripts already on disk declared nothing, and a guard that breaks all of them
 * on the day it lands is a guard that gets reverted rather than adopted.
 *
 * Returns `{ names, declared }` where `declared` is false for the derived case. Callers use
 * that to decide between an ERROR and a WARNING; see controlViolation.
 */
export function declaredControl(script = {}, agents = []) {
  const raw = script.controls;
  const clean = list => [...new Set((list ?? [])
    .map(a => String(a ?? '').trim()).filter(Boolean))].sort();
  if (raw === undefined || raw === null) return { names: clean(agents), declared: false };
  // `controls: '*'` is the deliberate whole-fleet script — the case the operator's "unless
  // it's actually a script that uses the whole fleet" carves out. It still locks the agents
  // it runs with; it just stops the guard complaining about bodies it picks up on the way.
  if (raw === '*') return { names: clean(agents), declared: true, wildcard: true };
  return { names: clean(Array.isArray(raw) ? raw : [raw]), declared: true };
}

/**
 * DOES THIS STEP DRIVE SOMETHING THE SCRIPT DID NOT DECLARE?
 *
 * `known` is every name that IS a character on this fleet — agent slots and character names
 * both, because naming the character where the agent goes is this repository's commonest
 * identifier mistake (see m59-agent-name.mjs). Only names in `known` are ever flagged: a
 * step mentioning the word "rescue" must not trip a guard because some character is called
 * Rescue somewhere else, and a guard that fires on arbitrary strings is noise.
 *
 * Returns null when the step is within its declaration, or `{ named, agent, error }`.
 */
export function controlViolation({ step, agent, control, known } = {}) {
  const { names, declared, wildcard } = control ?? {};
  if (!declared || wildcard) return null;      // derived sets are warned about, not refused
  const allowed = new Set((names ?? []).map(s => String(s).toLowerCase()));
  const index = known instanceof Map ? known : new Map(
    [...(known ?? [])].map(n => [String(n).toLowerCase(), String(n)]));

  // The agent the step is being RUN for counts, first and separately, because it is the one
  // case where the violation is the run's own shape rather than something buried in args.
  const candidates = [agent, ...strings(step)];
  for (const raw of candidates) {
    const key = String(raw ?? '').trim().toLowerCase();
    if (!key || allowed.has(key)) continue;
    const slot = index.get(key);
    if (!slot) continue;
    // REPORT THE NAME AS WRITTEN AND THE SLOT IT RESOLVES TO, because they are routinely
    // different and only one of them is in the script. A refusal that says `t3` when the
    // script says `Statler` sends the reader looking for a string that is not there — the
    // same identifier confusion m59-agent-name.mjs exists for.
    const written = String(raw).trim();
    const both = written.toLowerCase() === slot.toLowerCase() ? slot : `${written} (${slot})`;
    return {
      named: written,
      slot,
      agent: agent ?? null,
      step: step?.do ?? null,
      error:
        `this script drove "${both}" and never declared it.\n` +
        `  step        ${step?.do ?? '?'}${agent ? ` (running for ${agent})` : ''}\n` +
        `  declared    ${names.length ? names.join(', ') : '(nothing)'}\n` +
        `A script locks the characters it declares, so a body it did not declare is a body ` +
        `it did not lock — another driver may hold it, and neither of you would be told.\n` +
        `Add it to the declaration at the top of the script:\n` +
        `      controls: [${[...names, slot].map(n => `'${n}'`).join(', ')}]\n` +
        `or, if this really is a whole-fleet script, say so with  controls: '*'`,
    };
  }
  return null;
}

/**
 * The same question for a whole plan, before anything walks.
 *
 * Guarantee 1 is worth checking at COMPILE time and not only at dispatch: a script whose
 * tenth step drives an undeclared character should say so before its first step moves a
 * body, not after. runStep still checks, because a step's arguments can be computed from
 * state that does not exist yet — but everything knowable early is reported early.
 */
export function controlViolations(plan = [], { control, known, agent = null } = {}) {
  const out = [];
  for (const step of plan) {
    const bad = controlViolation({ step, agent, control, known });
    if (bad) out.push(bad);
  }
  return out;
}
