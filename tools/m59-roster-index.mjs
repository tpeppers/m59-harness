#!/usr/bin/env node
// WHO IS "KERMIT"? — NAME A HERO, GET A FLEET, AN AGENT AND A SERVER, OR A REFUSAL.
//
//   node tools/m59-roster-index.mjs                 every hero this machine can address
//   node tools/m59-roster-index.mjs Kermit Fozzie   resolve these, and say what is ambiguous
//
// The problem this solves is small and it has bitten this session repeatedly: every fleet
// tool wants an AGENT id (`t18`), and every human wants a NAME ("Gonzo"). Worse, a name is
// only unique by accident — two rosters on this machine can each hold a "Kermit" and they
// are different bodies on different servers. So the resolution has to be able to say NO.
//
// ============================================================ WHAT THIS WILL NOT DO
//
// IT NEVER READS AN ACCOUNT OR A PASSWORD, and that is structural rather than a promise.
// A roster entry is `{ credentials: { account, password, character, host, port }, autopilot }`
// and THE ROSTER IS THE ONLY RECORD OF THOSE PASSWORDS — there is no reset and no email on
// the account. `indexRosters` copies exactly three fields out of `credentials` (character,
// host, port) and never holds a reference to the object it read them from, so there is no
// path by which a caller of this module can reach a secret. `--json` therefore cannot leak
// one either.
//
// ============================================================ WHY A FLEET IS ITS FILE
//
// A fleet is a ROSTER FILE, never a name. Two checkouts can each hold a fleet called `prod`
// and they are not the same characters — the broker refuses to act on a fleet label for
// exactly this reason, matching on the state path instead. So the index is keyed on the file
// and carries the label as a convenience, not as identity.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Roster directories to scan. Defaults to this checkout's, plus any given. */
export function rosterDirs({ extra = [], env = process.env } = {}) {
  const here = join(HERE, '..', 'substrate', 'fleets');
  const fromEnv = (env.M59_ROSTER_DIRS ?? '').split(/[;,]/).map(s => s.trim()).filter(Boolean);
  return [...new Set([here, ...fromEnv, ...extra])].filter(d => existsSync(d));
}

/**
 * Build the index. Returns { fleets: [...], heroes: Map<lowerName, [entry]> }.
 *
 * An entry is { fleet, file, agent, character, server } and NOTHING ELSE — see the note
 * above about what is deliberately not carried.
 */
// `list` IS INJECTABLE AND THAT IS NOT A CONVENIENCE. With `readdirSync` hard-coded the only
// way to test this was to rebuild the index by hand in the test — which is what the first
// version of m59-roster-index-test.mjs did, and a mutation check found it worthless: letting
// the index carry the entire `credentials` object, passwords and all, still passed 27 of 27,
// because the test was asserting against its own hand-built copy rather than against this
// function. The peer session's lesson from the same afternoon, arrived at independently: if
// the read is not extractable, the test is decoration.
export function indexRosters({ dirs = rosterDirs(), read = readFileSync, list = readdirSync } = {}) {
  const fleets = [], heroes = new Map();

  for (const dir of dirs) {
    let names = [];
    try { names = list(dir).filter(f => f.endsWith('.json')); } catch { continue; }
    for (const file of names) {
      // A MENAGERIE FILE IS NOT A FLEET and is un-nameable as one (`--fleet` allows no dot).
      // `prod.secrets.json` is not a roster either. Skip anything with an extra dot rather
      // than trying to list the exceptions, which is how one gets missed.
      const label = basename(file, '.json');
      if (label.includes('.')) continue;

      let raw;
      try { raw = JSON.parse(read(join(dir, file), 'utf8')); } catch { continue; }
      if (!raw || typeof raw !== 'object') continue;

      const slots = [];
      for (const [agent, entry] of Object.entries(raw)) {
        const c = entry?.credentials;
        if (!c || typeof c !== 'object') continue;
        const character = typeof c.character === 'string' ? c.character : null;
        if (!character) continue;
        // Exactly three fields. Nothing else crosses this line.
        const server = (c.host && c.port) ? `${c.host}:${c.port}` : null;
        const rec = Object.freeze({ fleet: label, file: join(dir, file), agent, character, server });
        slots.push(rec);
        const key = character.toLowerCase();
        if (!heroes.has(key)) heroes.set(key, []);
        heroes.get(key).push(rec);
      }
      if (slots.length) {
        const servers = [...new Set(slots.map(s => s.server).filter(Boolean))];
        fleets.push({ fleet: label, file: join(dir, file), slots: slots.length, servers });
      }
    }
  }
  return { fleets, heroes };
}

/**
 * Resolve names to entries.
 *
 * A BARE NAME IS ALLOWED ONLY WHERE IT IS UNIQUE. "Kermit" resolves when exactly one roster
 * on this machine holds a Kermit. Where two do, it is REFUSED and the caller is told how to
 * disambiguate — `prod:Kermit`, or `76.214.42.186:5959/Kermit`. Picking one would be a
 * coin-flip that moves somebody else's character, silently, which is the failure this whole
 * module exists to make impossible.
 *
 * Agent ids (`t18`) are accepted too, qualified the same way, because the tools speak them.
 */
export function resolveHeroes(names, index = indexRosters()) {
  const resolved = [], ambiguous = [], unknown = [];

  for (const raw of [].concat(names ?? []).map(String).map(s => s.trim()).filter(Boolean)) {
    let want = raw, fleetHint = null, serverHint = null;

    // `host:port/Name` — the server-qualified form. Checked FIRST because a bare `prod:Kermit`
    // and a `1.2.3.4:5959/Kermit` are told apart by the slash, not by the colon.
    const slash = raw.lastIndexOf('/');
    if (slash > 0) { serverHint = raw.slice(0, slash); want = raw.slice(slash + 1); }
    else {
      const colon = raw.indexOf(':');
      if (colon > 0) { fleetHint = raw.slice(0, colon); want = raw.slice(colon + 1); }
    }

    const byName = index.heroes.get(want.toLowerCase()) ?? [];
    const byAgent = [...index.heroes.values()].flat()
      .filter(e => e.agent.toLowerCase() === want.toLowerCase());
    let hits = byName.length ? byName : byAgent;

    if (fleetHint) hits = hits.filter(e => e.fleet === fleetHint);
    if (serverHint) hits = hits.filter(e => e.server === serverHint);

    if (hits.length === 1) { resolved.push({ asked: raw, ...hits[0] }); continue; }
    if (hits.length === 0) { unknown.push(raw); continue; }
    ambiguous.push({
      asked: raw,
      found: hits.map(h => ({ fleet: h.fleet, agent: h.agent, server: h.server })),
      why: `"${want}" exists in ${hits.length} rosters on this machine and they are different ` +
           `bodies. Qualify it: ${hits.map(h => `${h.fleet}:${want}`).join(' or ')}` +
           (hits.some(h => h.server) ? `, or by server ${hits.map(h => `${h.server}/${want}`).join(' or ')}` : ''),
    });
  }
  return { resolved, ambiguous, unknown };
}

/** One fleet, or a refusal, for a set of resolved entries. A routing order cannot span two. */
export function oneFleetOnly(resolved) {
  const files = [...new Set(resolved.map(r => r.file))];
  if (files.length <= 1) return { ok: true, file: files[0] ?? null, fleet: resolved[0]?.fleet ?? null };
  return {
    ok: false,
    why: `these heroes are on ${files.length} different rosters, and one errand cannot drive ` +
         `two fleets: ${[...new Set(resolved.map(r => `${r.fleet} (${r.server ?? 'server unknown'})`))].join(', ')}. ` +
         `Run it once per fleet.`,
  };
}

if (import.meta.url === pathToFileUrlSafe(process.argv[1])) {
  const args = process.argv.slice(2).filter(a => a !== '--json');
  const asJson = process.argv.includes('--json');
  const index = indexRosters();

  if (!args.length) {
    if (asJson) { console.log(JSON.stringify({ fleets: index.fleets }, null, 1)); process.exit(0); }
    console.log(`rosters on this machine (${index.fleets.length})\n`);
    for (const f of index.fleets)
      console.log(`  ${f.fleet.padEnd(16)} ${String(f.slots).padStart(3)} slots   ${f.servers.join(', ') || 'server unknown'}`);
    const dupes = [...index.heroes.entries()].filter(([, v]) => v.length > 1);
    console.log(`\nheroes: ${index.heroes.size} distinct name(s)`);
    if (dupes.length) {
      console.log(`\nNAMES THAT ARE NOT UNIQUE — these must be qualified:`);
      for (const [name, es] of dupes)
        console.log(`  ${name.padEnd(18)} ${es.map(e => `${e.fleet}:${e.agent}`).join('  ')}`);
    } else {
      console.log('every hero name here is unique, so bare names are safe');
    }
    process.exit(0);
  }

  const r = resolveHeroes(args, index);
  if (asJson) { console.log(JSON.stringify(r, null, 1)); process.exit(r.ambiguous.length || r.unknown.length ? 1 : 0); }
  for (const e of r.resolved)
    console.log(`  ${String(e.asked).padEnd(18)} -> ${e.fleet}:${e.agent}  (${e.character}) on ${e.server ?? '?'}`);
  for (const a of r.ambiguous) console.log(`  ${String(a.asked).padEnd(18)} -> REFUSED. ${a.why}`);
  for (const u of r.unknown) console.log(`  ${String(u).padEnd(18)} -> no hero or agent by that name on this machine`);
  process.exit(r.ambiguous.length || r.unknown.length ? 1 : 0);
}

function pathToFileUrlSafe(p) {
  if (!p) return '';
  return 'file:///' + String(p).replace(/\\/g, '/');
}
