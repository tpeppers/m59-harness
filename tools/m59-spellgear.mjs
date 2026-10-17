#!/usr/bin/env node
// SPELL GEAR: THE MECHANICS OF A COSTUME CHANGE, AND THE TAGS THAT SAY WHO IS WHAT. No policy.
//
//   node tools/m59-spellgear.mjs roles                 who is tagged, on this machine
//   node tools/m59-spellgear.mjs tag <agent> <role>    tag a character (gitignored substrate/cast-roles.json)
//   node tools/m59-spellgear.mjs untag <agent>
//
// PUBLIC FRAMEWORK, PRIVATE POLICY (operator, 2026-10-16): "the framework for 'can plan those extension
// points of deciding what to equip/unequip/etc.' is public, but should be implemented to just
// no-op/continue the current behaviors". So this file decides NOTHING about what to wear. It knows:
//
//   - which gear slot an item fills and how many hands it takes (m59-spellpower.mjs, from the kod), and
//     its spellpower modifier for a given spell -- facts, the same ones the compendium prints;
//   - the LEGAL ways to hold things: one weapon, or a weapon and a shield, or a two-handed bow (and a
//     bow with a soldier's shield, player.kod CheckPosition) -- `legalHands`;
//   - the fewest packets that move hands, body and head from one state to another -- `transitionSteps`;
//   - a role TAG per character (substrate/cast-roles.json). A tag means nothing here: it is handed to
//     the strategies in ctx.role, and what a "mage" does is a private strategy's business.
//
// A strategy (substrate/strategies/, m59-castrite.mjs hooks) chooses the target; the engine turns it
// into packets with these functions and puts the stash back with the same ones.
//
// THE PACKET RULES. Using a weapon, a shield, armour or a helmet takes off whatever was in that slot by
// itself (weapon.kod:474, shield.kod:93, armor.kod:49, helmet.kod:46), so a swap is ONE packet. A bow
// takes both hands (ranged.kod:45): leaving one, or taking one up, unuses explicitly first, because the
// automatic freeing of hand slots (player.kod FreeHandSlotsFor) is upstream #1423 and a server we do
// not run may not have it. The server drops use/unuse/cast past five packets per wall-clock second
// (user.kod:874-886), which the Pacer's 200ms spacing already respects.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { itemSpellModifier, itemSlot, itemHands, itemRow, normSchool } from './m59-spellpower.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export let ROLES_FILE = process.env.M59_CAST_ROLES || path.join(HERE, '..', 'substrate', 'cast-roles.json');
/** Point the role registry at another file (tests; a lab fleet). */
export function setRolesFile(file) { ROLES_FILE = file; ROLES_CACHE = { mtime: -1, roles: {} }; }
// A role is a short lowercase word (mage, caster, healer ...). Which roles exist, and what each one
// means, is the strategies' business; this only refuses something that is not a word.
export const ROLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;

// ------------------------------------------------------------------------------------ roles
let ROLES_CACHE = { mtime: -1, roles: {} };
/** { agent: role } from substrate/cast-roles.json; re-read when the file changes. Never throws. */
export function castRoles(file = ROLES_FILE) {
  file ??= ROLES_FILE;
  try {
    const st = fs.statSync(file);
    if (st.mtimeMs !== ROLES_CACHE.mtime || ROLES_CACHE.file !== file) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const roles = {};
      for (const [agent, role] of Object.entries(j?.roles ?? {})) if (ROLE_RE.test(String(role))) roles[agent] = role;
      ROLES_CACHE = { mtime: st.mtimeMs, file, roles };
    }
    return ROLES_CACHE.roles;
  } catch { return {}; }
}
export const castRole = (agent, file = null) => (agent ? castRoles(file ?? ROLES_FILE)[agent] ?? null : null);

export function setRole(agent, role, file = null) {
  file ??= ROLES_FILE;
  if (role != null && !ROLE_RE.test(String(role))) throw new Error('a role is one short lowercase word, e.g. mage');
  let j = { roles: {} };
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* a new file */ }
  j.roles ??= {};
  if (role) j.roles[agent] = role; else delete j.roles[agent];
  j.describe ??= 'Cast roles (tools/m59-spellgear.mjs). A mage dresses for maximum spellpower for every spell it casts. Gitignored: this machine\'s orders.';
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
  ROLES_CACHE = { mtime: -1, roles: {} };
  return j.roles;
}

// ------------------------------------------------------------------------------ the mechanics
/**
 * The gear a character could wear, from the castrite ctx's `items` (or any [{id,name,equipped,
 * rarity,cursed,broken}]), annotated with slot, hands and this spell's modifier.
 */
export function gearCandidates(items, { spellSchool = null, robeSchoolOf = null, schoolLevelOf = null } = {}) {
  const out = [];
  for (const i of items ?? []) {
    const slot = itemSlot(i.name);
    if (!slot) continue;
    const robeSchool = i.robe_school ?? robeSchoolOf?.(i) ?? null;
    out.push({ ...i, slot, hands: itemHands(i.name), cls: itemRow(i.name)?.cls ?? null,
      mod: itemSpellModifier(i.name, { spellSchool, robeSchool, schoolLevel: i.school_level ?? schoolLevelOf?.(robeSchool) ?? 0 }) });
  }
  return out;
}
const isSoldierShield = (g) => /soldier|army|militia/i.test(g?.name ?? '');

/**
 * Is this pair legal in two hands? `weapon`/`shield` are candidates (or null). A bow fills both
 * hands, except beside a soldier's shield (player.kod CheckPosition).
 */
export function legalHands(weapon, shield) {
  const used = (weapon?.hands ?? 0) + (shield ? 1 : 0);
  return used <= 2 || (weapon?.hands === 2 && isSoldierShield(shield));
}

/** The {weapon, shield, armour, helm} worn now, out of the candidates. */
export function wornState(cands) {
  const worn = (slot) => cands.find(g => g.equipped && g.slot === slot) ?? null;
  return { weapon: worn('weapon'), shield: worn('shield'), armour: worn('armour'), helm: worn('helm') };
}

/**
 * The packets that take the hands/body/head from `from` to `to` (each {weapon, shield, armour, helm}
 * of items or nulls): one per changed slot where a use replaces the incumbent, an explicit unuse first
 * where a bow's two hands are involved, and an unuse where the slot is to be empty.
 * Steps are `{ unequip: id }` / `{ equip: id }`, in send order.
 */
export function transitionSteps(from, to) {
  const id = (g) => g?.id ?? null;
  const unuse = [], use = [];
  const wFrom = from.weapon, wTo = to.weapon, sFrom = from.shield, sTo = to.shield;
  const wChange = id(wFrom) !== id(wTo), sChange = id(sFrom) !== id(sTo);
  // HANDS. A two-handed weapon on either side of the change makes the order explicit.
  const twoHands = (wFrom?.hands === 2) || (wTo?.hands === 2);
  // (The engine refuses an illegal target -- legalHands -- so a shield leaving for a bow is simply a
  // shield whose target is empty.)
  if (wChange && wFrom && (!wTo || twoHands)) unuse.push(wFrom);
  if (sChange && sFrom && !sTo) unuse.push(sFrom);
  if (wChange && wTo) use.push(wTo);
  if (sChange && sTo) use.push(sTo);
  // BODY and HEAD: a use replaces the incumbent by itself; an empty target is an unuse.
  for (const slot of ['armour', 'helm']) {
    if (id(from[slot]) === id(to[slot])) continue;
    if (to[slot]) use.push(to[slot]); else if (from[slot]) unuse.push(from[slot]);
  }
  const seen = new Set();
  const steps = [];
  for (const g of unuse) if (!seen.has('u' + g.id)) { seen.add('u' + g.id); steps.push({ unequip: g.id }); }
  for (const g of use) if (!seen.has('e' + g.id)) { seen.add('e' + g.id); steps.push({ equip: g.id }); }
  return steps;
}

/** The {weapon, shield, armour, helm} worn, out of a list of worn ids and the candidates. */
export function slotState(cands, wornIds) {
  const set = new Set(wornIds ?? []);
  const of = (slot) => cands.find(g => set.has(g.id) && g.slot === slot) ?? null;
  return { weapon: of('weapon'), shield: of('shield'), armour: of('armour'), helm: of('helm') };
}

// -------------------------------------------------------------------------------------- cli
if (import.meta.filename === process.argv[1]) {
  const [cmd, agent, role] = process.argv.slice(2);
  if (cmd === 'tag' && agent && role) { console.log(setRole(agent, role)); }
  else if (cmd === 'untag' && agent) { console.log(setRole(agent, null)); }
  else {
    const r = castRoles();
    console.log(`${ROLES_FILE}\n` + (Object.keys(r).length ? Object.entries(r).map(([a, x]) => `  ${a.padEnd(8)} ${x}`).join('\n')
      : '  nobody is tagged'));
  }
}
