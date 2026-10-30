// One disposition decision across pickup and town services. Importing never contacts a game.
import { readFileSync, statSync, mkdirSync, rmdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJson } from './m59-inventory-intent.mjs';
import { itemNameKey } from './m59-items.mjs';

export const DISPOSITIONS = ['leave', 'keep', 'sell', 'vault', 'drop_town'];
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const need = (yes, why) => { if (!yes) throw new Error(why); };
const safeText = (v, max = 120) => typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= max && !/[\x00-\x1f]/.test(v);
const idOK = v => typeof v === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(v) && !['constructor', 'prototype', '__proto__'].includes(v);
const keys = (v, allowed) => { need(object(v), 'Expected an object'); for (const k of Object.keys(v)) need(allowed.includes(k), `Unknown field: ${k}`); };
export const policyPath = stateFile => resolve(stateFile) + '.loot-policies.json';
export const policyRevision = doc => createHash('sha256').update(JSON.stringify(doc)).digest('hex');
export const blankLootPolicies = () => ({ format: 'm59-loot-policies/1', profiles: {}, assignments: { fleet: null, guilds: {}, characters: {} } });

export function validateLootPolicies(input, importedProfiles = {}) {
  keys(input, ['format', 'profiles', 'assignments']);
  need(input.format === 'm59-loot-policies/1', 'Unsupported loot-policy format');
  need(object(input.profiles) && Object.keys(input.profiles).length <= 100, 'At most 100 profiles');
  const profiles = {};
  for (const [id, p] of Object.entries(input.profiles)) {
    need(idOK(id), 'Invalid profile id'); keys(p, ['name', 'rules']);
    need(safeText(p.name) && Array.isArray(p.rules) && p.rules.length <= 200, 'Profile needs a name and at most 200 rules');
    const rules = p.rules.map(r => {
      keys(r, ['item', 'action', 'min_condition', 'otherwise']);
      need(safeText(r.item) && itemNameKey(r.item), 'Rules need an exact item name');
      need(DISPOSITIONS.includes(r.action), 'Unknown disposition');
      if (r.min_condition !== undefined) {
        need(Number.isInteger(r.min_condition) && r.min_condition >= 0 && r.min_condition <= 4, 'Condition must be 0–4');
        need(DISPOSITIONS.includes(r.otherwise), 'Quality rule needs a below-condition action');
      } else need(r.otherwise === undefined, 'Otherwise needs a minimum condition');
      return { item: r.item, action: r.action, ...(r.min_condition !== undefined ? { min_condition: r.min_condition, otherwise: r.otherwise } : {}) };
    });
    need(new Set(rules.map(r => itemNameKey(r.item))).size === rules.length, `Duplicate item in ${id}`);
    profiles[id] = { name: p.name, rules };
  }
  keys(input.assignments, ['fleet', 'guilds', 'characters']);
  const assignment = id => { need(id === null || (idOK(id) && (Object.hasOwn(profiles, id) || Object.hasOwn(importedProfiles, id))), `Unknown assigned profile: ${id}`); return id; };
  const a = input.assignments;
  need(object(a.guilds) && object(a.characters) && Object.keys(a.guilds).length <= 100 && Object.keys(a.characters).length <= 500, 'Invalid assignment maps');
  const guilds = {}, characters = {};
  for (const [guild, id] of Object.entries(a.guilds)) { need(/^[1-9]\d{0,9}$/.test(guild), 'Guild assignments use observed numeric guild IDs'); guilds[guild] = assignment(id); }
  for (const [name, id] of Object.entries(a.characters)) {
    need(safeText(name) && !['__proto__', 'constructor', 'prototype'].includes(name.toLowerCase()), 'Invalid character name');
    need(!Object.keys(characters).some(n => n.toLowerCase() === name.toLowerCase()), 'Duplicate character assignment');
    characters[name] = assignment(id);
  }
  return { format: input.format, profiles, assignments: { fleet: assignment(a.fleet), guilds, characters } };
}

export function policyChain(doc, { character = '', guild = null } = {}) {
  const a = doc.assignments;
  const name = Object.keys(a.characters).find(n => n.toLowerCase() === character.toLowerCase());
  return [[name ? `character:${name}` : '', name ? a.characters[name] : null],
    [`guild:${guild}`, guild ? a.guilds[String(guild)] : null], ['fleet', a.fleet]]
    .filter(([, id]) => id).map(([scope, id]) => ({ scope, id, ...doc.profiles[id] }));
}
export function decideLoot(doc, context, item) {
  for (const p of policyChain(doc, context)) {
    const rule = p.rules.find(r => itemNameKey(r.item) === itemNameKey(item.name));
    if (!rule) continue;
    const unknown = rule.min_condition !== undefined && !Number.isInteger(item.condition);
    const action = unknown ? 'keep' : rule.min_condition !== undefined && item.condition < rule.min_condition ? rule.otherwise : rule.action;
    return { action, pickup: action !== 'leave', profile: p.id, scope: p.scope, rule,
      reason: unknown ? 'Condition unknown — retain pending inspection' : `${p.name}: ${action}`, needs_inspection: unknown };
  }
  return null; // No assignment or matching rule: legacy behavior, not an empty keep list.
}

export class LootPolicyStore {
  constructor(stateFile, { sources = JSON.parse(process.env.M59_LOOT_POLICY_SOURCES || '[]') } = {}) {
    need(Array.isArray(sources) && sources.length <= 16 && sources.every(p => safeText(p, 1000) || (object(p) && safeText(p.path, 1000) && typeof p.writable === 'boolean')), 'M59_LOOT_POLICY_SOURCES needs paths or {path,writable} registrations');
    this.path = policyPath(stateFile); this.sources = sources.map(p => resolve(typeof p === 'string' ? p : p.path)); this.cached = null;
    this.writable = new Set([this.path, ...sources.filter(p => object(p) && p.writable).map(p => resolve(p.path))]);
    need(new Set([...this.sources, this.path]).size === this.sources.length + 1, 'Duplicate policy source');
  }
  compose(override, target = this.path) {
    const paths = [...this.sources, this.path];
    const stamps = paths.map(path => { try { const s = statSync(path); need(s.size <= 1_000_000, `Loot policy file too large: ${path}`); return `${s.mtimeMs}:${s.ctimeMs}:${s.size}`; }
      catch (e) { if (e.code !== 'ENOENT' || path !== this.path) throw e; return 'absent'; } });
    const stamp = stamps.join('|');
    if (!override && this.cached?.stamp === stamp) return this.cached.value;
    const effective = blankLootPolicies(), provenance = { profiles: {}, assignments: {} }, warnings = [], layers = [];
    const raws = paths.map((path, i) => path === target && override ? override : stamps[i] === 'absent' ? blankLootPolicies() : JSON.parse(readFileSync(path, 'utf8')));
    // Definitions are global; source order determines assignment precedence, not whether
    // an earlier file may refer to a profile contributed by a later repository.
    const allProfiles = Object.create(null);
    for (const raw of raws) for (const id of Object.keys(raw?.profiles || {})) {
      need(!Object.hasOwn(allProfiles, id), `Profile ${id} is defined by two sources; fork it under a new ID`);
      allProfiles[id] = true;
    }
    let document;
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i], local = path === this.path;
      const doc = validateLootPolicies(raws[i], allProfiles);
      for (const [id, p] of Object.entries(doc.profiles)) {
        need(!Object.hasOwn(effective.profiles, id), `Profile ${id} is defined by two sources; fork it under a new ID`);
        effective.profiles[id] = p; provenance.profiles[id] = path;
      }
      for (const [scope, values] of [['fleet', doc.assignments.fleet === null ? {} : { '*': doc.assignments.fleet }], ['guilds', doc.assignments.guilds], ['characters', doc.assignments.characters]]) {
        for (const [target, id] of Object.entries(values)) {
          const key = `${scope}:${scope === 'characters' ? target.toLowerCase() : target}`;
          if (provenance.assignments[key]) warnings.push({ code: 'assignment_override', scope: key, previous: provenance.assignments[key], source: path });
          if (scope === 'fleet') effective.assignments.fleet = id;
          else {
            if (scope === 'characters') for (const old of Object.keys(effective.assignments.characters))
              if (old.toLowerCase() === target.toLowerCase()) delete effective.assignments.characters[old];
            effective.assignments[scope][target] = id;
          }
          provenance.assignments[key] = path;
        }
      }
      layers.push({ path, writable: this.writable.has(path), profiles: Object.keys(doc.profiles), document: doc });
      if (local) document = doc;
    }
    const value = { document, effective, provenance, warnings, sources: layers, revision: policyRevision(layers) };
    if (!override) this.cached = { stamp, value };
    return value;
  }
  read() { return this.compose().effective; }
  snapshot() { return this.compose(); }
  save(document, expectedRevision, target = this.path) {
    // The caller may select a registered source, never supply an arbitrary filesystem path.
    need(this.writable.has(target), 'This source is not registered for writeback');
    const clean = this.compose(document, target).sources.find(s => s.path === target).document;
    mkdirSync(dirname(target), { recursive: true });
    const lock = target + '.lock'; mkdirSync(dirname(lock), { recursive: true }); mkdirSync(lock);
    try {
      need(this.snapshot().revision === expectedRevision, 'Loot policies changed; reload before saving');
      atomicJson(target, clean); this.cached = null; return this.snapshot();
    } finally { rmdirSync(lock); }
  }
}

// Diagnostics compare the effective new disposition with legacy contributions, without
// rewriting their source files. Exact matching here; dynamic matcher details remain in previews.
export function lootPolicyDiagnostics(doc, context, legacy = {}) {
  const chain = policyChain(doc, context), issues = [];
  const names = new Set([...chain.flatMap(p => p.rules.map(r => r.item)), ...(legacy.vaultItems || []), ...(legacy.protectedItems || [])]);
  for (const name of names) {
    const decision = decideLoot(doc, context, { name, condition: 4 });
    const ignored = (legacy.lootIgnore || []).some(n => itemNameKey(typeof n === 'string' ? n : n?.name || '') === itemNameKey(name));
    const excludedBy = Object.entries(legacy.lootOnly || {}).filter(([, items]) => !items.some(n => itemNameKey(n) === itemNameKey(name))).map(([monster]) => monster);
    const wanted = decision ? decision.pickup : [...(legacy.vaultItems || []), ...(legacy.protectedItems || [])].some(n => itemNameKey(n) === itemNameKey(name));
    if (wanted && (ignored || excludedBy.length)) issues.push({ code: decision ? 'pickup_override' : 'unreachable_accumulation', item: name,
      severity: decision ? 'warning' : 'error', message: decision ? 'Disposition permits pickup over legacy ignore/creature filters; safety refusals still win.' : 'Legacy keep/vault demand conflicts with pickup filters.',
      excluded_after_kills: excludedBy, source: decision?.scope ?? 'legacy', legacy_sources: legacy.sources ?? {} });
    if (decision && ['vault', 'sell', 'drop_town'].includes(decision.action) && legacy.townTrips === false)
      issues.push({ code: 'town_trips_disabled', item: name, severity: 'warning', message: 'Automatic town trips are disabled; disposition needs an operator trip or another authorized service.' });
    if (decision?.action === 'vault') issues.push({ code: 'vault_route_requirement', item: name, severity: 'info',
      message: 'Vaulting uses the existing Barloque service (within four route hops); otherwise goods remain carried. Bans and confinement still apply.' });
  }
  return issues;
}

// Fresh observations only, keyed by BOTH id and name. Recycled IDs must not certify quality.
export function observedLootItem(c, o, now = Date.now()) {
  const name = c.rsc.get(o.nameRsc) || o.name || '';
  const reading = c._lootCondition?.get(o.id);
  return { name, condition: reading?.name === name && now - reading.at < 60_000 ? reading.level : null };
}
export function sessionLootDecision(s, o) {
  if (!s?.lootPolicyStore) return null;
  try { return decideLoot(s.lootPolicyStore.read(), { character: s.client?.me?.name || '', guild: s.client?.guild?.id ?? null }, observedLootItem(s.client, o)); }
  catch (e) { return { action: 'keep', pickup: false, reason: `Loot policy unavailable: ${e.message}`, error: true }; }
}
