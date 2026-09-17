#!/usr/bin/env node
// A WHOLE TEST SCENARIO FROM ONE FILE, BROUGHT UP IN ONE COMMAND.
//
//   node tools/m59-testbed.mjs plan   scenarios/arena.json    validate + expand, change nothing
//   node tools/m59-testbed.mjs up     scenarios/arena.json    make it so
//   node tools/m59-testbed.mjs reset  scenarios/arena.json    heal + put everyone back
//   node tools/m59-testbed.mjs place  scenarios/arena.json    just the placement
//   node tools/m59-testbed.mjs status scenarios/arena.json    what is actually true
//
// Setting one of these up by hand is six or seven separate steps — accounts on the
// maintenance socket, a broker, a join and a re-roll each, the DM kit, the placement,
// the keepers — and every one of them is a place to get a name wrong and find out
// twenty minutes later. Written down, it is a file you can diff and re-run.
//
// `reset` IS THE VERB THAT MATTERS. `up` runs once per scenario; `reset` runs between
// every round, and it is deliberately the cheap one — heal and place, both pure
// maintenance-socket batches, no broker, no walking, no logins. Sub-second, so a loop
// can afford to call it every time rather than hoping the last round left things tidy.
//
// FOUR THINGS THIS REFUSES TO DO.
//
//  * IT WILL NOT POINT AT A SERVER THAT IS NOT ON THIS MACHINE. Every step here is
//    either the unauthenticated maintenance socket or account creation, and neither is
//    something you have the right to do to somebody else's server. `prod` lives on
//    76.214.42.186 and this refuses it by address, not by convention.
//  * IT WILL NOT RE-ROLL A CHARACTER THAT ALREADY HAS THE RIGHT NAME. A re-roll is a
//    suicide followed by a replacement and there is no undo, so `up` is idempotent by
//    checking first: run it twice and the second run kits and places the characters the
//    first one made.
//  * IT WILL NOT INVENT A NAME THE SERVER WOULD REJECT. The name rule is a letter then
//    one to fifteen more of letter, apostrophe, space or hyphen — so `{n}` templating,
//    which produces digits, is refused in a name and `{word}` exists instead. The server
//    would not refuse it either: it would silently stamp its junk character on you.
//  * IT WILL NOT REPORT SUCCESS FOR A RE-ROLL IT CANNOT VERIFY. `stats_as_asked` off the
//    broker is the verdict, exactly as m59-makefleet.mjs has it.
//
// THE SPEC
//
//   {
//     "fleet": "arena",
//     "server":  { "host": "127.0.0.1", "port": 15959 },
//     "broker":  { "http": 8931, "dashboard": 8932 },
//     "characters": [
//       { "agent": "t0", "account": "t0", "password": "t0", "name": "TESTER",
//         "roll": "balanced",
//         "kit":   { "stats": 50, "health": 151, "mana": 200, "vigor": 200,
//                    "karma": -60, "skills": 99, "spells": 99,
//                    "money": 1000000, "reagents": 50 },
//         "place": { "room": 60, "at": [13, 8] } }
//     ],
//     "squads": [
//       { "count": 5, "agent": "arena{n}", "account": "arena{n}", "password": "arena{n}",
//         "name": "{word}", "roll": "melee",
//         "kit":   { "stats": 50, "health": 50, "skills": 50 },
//         "place": { "room": 60, "at": [13, 16] },
//         "keeper": { "mode": "survive", "roam": false, "assigned_room": 60 } }
//     ]
//   }
//
// A squad is the same entry `count` times with `{n}` (1, 2, 3…) and `{word}` (One, Two,
// Three…) substituted. Everything else is per-character and optional: omit `kit` and
// nothing is granted, omit `place` and nobody is moved, omit `keeper` and no keeper is
// started.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as dm from './m59-dm.mjs';
import { CHAR_NAME_RE, checkCharacterName } from './m59-newchar.mjs';

// ------------------------------------------------------------------ the spec
//
// Everything from here to `up` is pure. A scenario file that is wrong should say so
// before anything is created, and proving that needs no server.

// ONE COPY OF THE RULE, IMPORTED. This used to be a second regex with a comment claiming
// player.kod, and the two drifted: the rule is in system.kod, it allows thirty characters
// rather than sixteen, and it does NOT allow the hyphen both copies admitted. A rule
// written down twice is a rule that disagrees with itself eventually.
export const NAME_RE = CHAR_NAME_RE;

export const ROLLS = new Set(['melee', 'caster', 'archer', 'balanced']);

// Letter-only, because this repository's name rule excludes digits (see
// checkCharacterName). The server itself would take `Bot1`; the substitution story that
// used to be written here belongs to the STATS list, not the name — player.kod:2081
// stamps 3/1/4/1/5/9 on a character it has already created, while a name it dislikes is
// refused outright and never exists.
export const ORDINAL_WORDS = [
  'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen',
  'Eighteen', 'Nineteen', 'Twenty',
];

export const ordinalWord = i =>
  ORDINAL_WORDS[i - 1] ?? `Number${ORDINAL_WORDS[((i - 1) % ORDINAL_WORDS.length)]}`;

export const fill = (template, i) =>
  String(template ?? '').replace(/\{n\}/g, String(i)).replace(/\{word\}/g, ordinalWord(i));

// Squads expand into ordinary characters, so everything downstream sees one flat list
// and there is no second code path for "the squad case".
export function expand(spec) {
  const out = [];
  for (const c of spec?.characters ?? []) out.push({ ...c });
  for (const sq of spec?.squads ?? []) {
    const n = Number(sq.count ?? 0);
    for (let i = 1; i <= n; i++) {
      const one = { ...sq };
      delete one.count;
      delete one.names;
      for (const k of ['agent', 'account', 'password', 'name']) one[k] = fill(sq[k], i);
      // AN EXPLICIT LIST BEATS THE TEMPLATE, because the names people actually want are
      // not ordinals. `{word}` gives One..Five; a squad called Alpha..Echo cannot be
      // spelled by any template and would otherwise have to be five hand-written
      // entries, which is the repetition squads exist to remove.
      if (Array.isArray(sq.names) && sq.names[i - 1] != null) one.name = sq.names[i - 1];
      out.push(one);
    }
  }
  return out;
}

export function validate(spec) {
  const problems = [];
  if (!spec || typeof spec !== 'object') return ['the spec is not an object'];

  const host = spec.server?.host ?? '127.0.0.1';
  if (!dm.isLoopbackHost(host))
    problems.push(`server.host is ${host} — this tool creates accounts and drives the ` +
                  `unauthenticated maintenance socket, so it only ever runs against a ` +
                  `server on this machine`);

  const chars = expand(spec);
  if (!chars.length) problems.push('no characters and no squads — there is nothing to build');

  // A short `names` list would silently fall back to the template for the tail, so half
  // the squad would be called Alpha, Bravo, Three, Four.
  for (const sq of spec.squads ?? []) {
    if (Array.isArray(sq.names) && sq.names.length < Number(sq.count ?? 0))
      problems.push(`squad "${sq.agent ?? '(unnamed)'}": names lists ${sq.names.length} ` +
                    `but count is ${sq.count} — the rest would fall back to the template`);
  }

  const seen = { agent: new Map(), account: new Map(), name: new Map() };
  for (const c of chars) {
    const who = c.agent || c.account || c.name || '(unnamed entry)';
    for (const k of ['agent', 'account', 'password', 'name']) {
      if (!c[k]) problems.push(`${who}: ${k} is missing`);
    }
    // THE CHECKER SAYS WHY, so this does not keep its own second opinion about the rule.
    // The digit case still earns an extra sentence, because the fix is a template change
    // and nothing else here would tell you that.
    if (c.name) {
      const named = checkCharacterName(c.name);
      if (!named.ok)
        problems.push(`${who}: ${named.why}` +
          (/\d/.test(c.name) ? '. Use {word} rather than {n} in a name.' : ''));
    }
    if (c.roll && !ROLLS.has(c.roll))
      problems.push(`${who}: roll "${c.roll}" is not one of ${[...ROLLS].join(', ')}`);
    // Collisions are the failure that looks like success: two entries on one account
    // means the second re-roll destroys the first character.
    for (const k of ['agent', 'account', 'name']) {
      if (!c[k]) continue;
      const key = k === 'name' ? c[k].toLowerCase() : c[k];
      if (seen[k].has(key)) problems.push(`${who}: ${k} "${c[k]}" is used twice`);
      seen[k].set(key, who);
    }
    if (c.place && c.place.room == null)
      problems.push(`${who}: place has no room`);
    if (c.place?.at && (!Array.isArray(c.place.at) || c.place.at.length !== 2))
      problems.push(`${who}: place.at must be [row, col]`);
  }
  return problems;
}

export function loadSpec(path) {
  const spec = JSON.parse(readFileSync(path, 'utf8'));
  const problems = validate(spec);
  if (problems.length) {
    const e = new Error(`${problems.length} problem(s) with ${path}:\n  ` + problems.join('\n  '));
    e.problems = problems;
    throw e;
  }
  return spec;
}

// ------------------------------------------------------------------ broker rpc

async function rpc(port, name, args, timeoutMs = 180000) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
                                params: { name, arguments: args } });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: ctl.signal });
  } finally { clearTimeout(t); }
  const j = await res.json();
  if (j.error) throw new Error(`${name}: ${j.error.message}`);
  const text = j.result?.content?.[0]?.text ?? '';
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (j.result?.isError) throw new Error(`${name}: ${String(text).slice(0, 300)}`);
  return parsed;
}

async function brokerAlive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const env = spec => ({ ...process.env,
                       M59_HOST: spec.server?.host ?? '127.0.0.1',
                       M59_ADMIN_PORT: String(spec.server?.admin ?? 19998) });

// ------------------------------------------------------------------ verbs

export async function up(spec, { log = console.log } = {}) {
  const chars = expand(spec);
  const port = Number(spec.broker?.http ?? 8901);
  const opts = { env: env(spec) };

  const health = await brokerAlive(port);
  if (!health)
    throw new Error(`no broker on 127.0.0.1:${port}. Start one first:\n` +
      `  node tools/m59-service.mjs start --fleet ${spec.fleet ?? 'test'} ` +
      `--http ${port} --dashboard ${spec.broker?.dashboard ?? port + 1}`);
  if (spec.fleet && health.fleet && health.fleet !== spec.fleet)
    throw new Error(`the broker on ${port} is holding the "${health.fleet}" fleet, ` +
                    `not "${spec.fleet}" — that is the mismatch that operates on the wrong fleet quietly`);

  // 1. Accounts. A duplicate creates nothing and changes no password, so this is safe
  //    to re-run; the two replies that matter are exact (blakserv/adminfn.c).
  log(`accounts: ${chars.length}`);
  const made = await dm.dm(chars.map(c => `create automated ${c.account} ${c.password}`),
                           { timeoutMs: 60000, ...opts });
  const blocks = dm.split(made, chars.map(c => `create automated ${c.account} ${c.password}`));
  const report = [];
  chars.forEach((c, i) => {
    const b = blocks[i] || '';
    const state = /Created account\s+\d+/i.test(b) ? 'created'
                : /already exists/i.test(b) ? 'existed'
                : 'UNRECOGNISED';
    report.push({ agent: c.agent, account: state });
    if (state === 'UNRECOGNISED') log(`  ${c.account}: unrecognised reply — ${b.trim().slice(0, 120)}`);
  });

  // 2. Characters. Join, then re-roll ONLY if the name is not already right.
  for (const [i, c] of chars.entries()) {
    const line = report[i];
    try {
      const joined = await rpc(port, 'join', {
        agent: c.agent, account: c.account, password: c.password,
        host: spec.server?.host ?? '127.0.0.1', port: spec.server?.port ?? 5959 });
      line.joined = true;
      const now = joined?.character ?? joined?.name ?? null;
      const already = String(now ?? '').toLowerCase() === String(c.name).toLowerCase();
      if (already) { line.character = 'already ' + c.name; }
      else {
        const r = await rpc(port, 'reroll', { action: 'reroll', agent: c.agent, name: c.name,
          stats: c.roll ?? 'melee', loadout: c.loadout ?? 'selfSufficient', confirm: true });
        // The broker's own verdict, not a fresh comparison here — a second opinion could
        // reintroduce the exact bug that flag exists to prevent.
        line.character = r?.done && r?.stats_readable && r?.stats_as_asked && !r?.looks_like_the_junk_default
          ? 'rolled ' + c.name : `FAILED: ${r?.verdict ?? 'no character came back'}`;
      }
    } catch (e) { line.character = `FAILED: ${e.message}`; }
    log(`  ${c.agent.padEnd(10)} ${line.account.padEnd(9)} ${line.character ?? ''}`);
  }

  // 3. The kit. Resolved by NAME inside m59-dm, in the same batch that uses the ids.
  for (const [i, c] of chars.entries()) {
    if (!c.kit) continue;
    const r = await dm.kit(c.name, c.kit, opts);
    report[i].kit = r.ok ? `${r.commands} commands` : r.why;
    if (c.kit.vigor != null) await vigor(c.name, c.kit.vigor, opts);
    log(`  kit ${c.name.padEnd(12)} ${report[i].kit}`);
  }

  // 4. Placement and keepers.
  Object.assign(report, await place(spec, { log, report }));
  await keepers(spec, port, { log });
  return report;
}

// Vigor is not part of `kit` in m59-dm because it is not a grant, it is a reset — and
// piExertion has to go with it or the accumulated tenth-of-a-point balance eats straight
// back into the number that was just set.
export async function vigor(name, value, opts = {}) {
  const ids = await dm.resolve([name], opts);
  const obj = ids[name];
  if (obj == null) return { ok: false, why: `no character called ${name}` };
  const v = Math.max(1, Math.min(dm.MAX_VIGOR, Number(value)));
  await dm.dm([dm.setProp(obj, 'piVigor', v), dm.setProp(obj, 'piExertion', 0),
               `send object ${obj} NewVigor`], opts);
  return { ok: true, vigor: v };
}

// MAX MANA IS DERIVED, AND THAT IS WHY IT IS RE-APPLIED ON EVERY RESET RATHER THAN GRANTED
// ONCE.
//
// piMax_Mana looks like a stored property — it is declared at 20, and the only thing that
// visibly writes it is GainMaxMana. It is not. `ComputeMaxMana` (player.kod:6116) throws
// the number away and rebuilds it from
//
//     GetInitialMaxMana = 15 + mysticism/5
//
// plus melded mana nodes, worn items and enchantments; and it runs on login, on an
// equipment change and on an enchantment change. So a character set to 200 reads 200 for
// as long as you watch it and comes back from the next relog at 25 — which is exactly
// what happened here, after this file's author had written down that it would stick.
//
// The DURABLE lever is mana nodes (piNodelist), which is what ComputeMaxMana adds back and
// what tools/m59-mananode.mjs exists to earn. That is a real journey per character. For a
// test character the honest answer is that the ceiling is the test bed's to maintain, so
// `reset` re-asserts it before healing — and `heal` fills to whatever ceiling it then
// finds, which is why the order is ceilings first.
export async function ceilings(spec, { log = console.log } = {}) {
  const opts = { env: env(spec) };
  const chars = expand(spec).filter(c => c.kit?.mana != null);
  if (!chars.length) return [];
  const ids = await dm.resolve(chars.map(c => c.name), opts);
  const cmds = [];
  for (const c of chars) {
    const obj = ids[c.name];
    if (obj == null) { log(`  mana ${c.name}: not on this server`); continue; }
    cmds.push(...dm.manaCmds(obj, c.kit.mana), `send object ${obj} NewMana`);
  }
  await dm.dm(cmds, opts);
  return chars.map(c => ({ name: c.name, max_mana: c.kit.mana }));
}

export async function place(spec, { log = console.log } = {}) {
  const chars = expand(spec).filter(c => c.place?.room != null);
  const opts = { env: env(spec) };
  const out = [];
  // Grouped by room and square, so a squad sharing a destination is one batch.
  const groups = new Map();
  for (const c of chars) {
    const key = `${c.place.room}:${(c.place.at ?? []).join(',')}`;
    if (!groups.has(key)) groups.set(key, { room: c.place.room, at: c.place.at, who: [] });
    groups.get(key).who.push(c.name);
  }
  for (const g of groups.values()) {
    const r = await dm.relocate(g.who, g.room,
                                { row: g.at?.[0], col: g.at?.[1], verify: true }, opts);
    out.push(r);
    for (const [who, how] of Object.entries(r.moved ?? {})) log(`  place ${who.padEnd(12)} ${how}`);
  }
  return out;
}

export async function reset(spec, { log = console.log } = {}) {
  const chars = expand(spec);
  const opts = { env: env(spec) };
  // Ceilings BEFORE the refill: heal fills to whatever maximum it finds, so re-asserting
  // a mana ceiling afterwards would leave the character at the old one until something
  // else topped it up.
  const raised = await ceilings(spec, { log });
  const healed = await dm.heal(chars.map(c => c.name), opts);
  log(`healed ${healed.healed.length}${healed.missing.length ? `, missing ${healed.missing.join(', ')}` : ''}`);
  // Vigor last, and only when a spec asks for something other than full: heal already
  // takes it to MAX_VIGOR, so this exists for a scenario that wants a character tired.
  for (const c of chars) {
    if (c.kit?.vigor != null && Number(c.kit.vigor) !== dm.MAX_VIGOR)
      await vigor(c.name, c.kit.vigor, opts);
  }
  const placed = await place(spec, { log });
  return { ceilings: raised, healed, placed };
}

async function keepers(spec, port, { log = console.log } = {}) {
  for (const c of expand(spec)) {
    if (!c.keeper) continue;
    try {
      const r = await rpc(port, 'autopilot', { agent: c.agent, action: 'start', ...c.keeper });
      log(`  keeper ${c.agent.padEnd(10)} ${r?.mode ?? 'started'}`);
    } catch (e) { log(`  keeper ${c.agent.padEnd(10)} FAILED: ${e.message}`); }
  }
}

export async function status(spec, { log = console.log } = {}) {
  const chars = expand(spec);
  const opts = { env: env(spec) };
  const ids = await dm.resolve(chars.map(c => c.name), opts);
  const port = Number(spec.broker?.http ?? 8901);
  const health = await brokerAlive(port);
  log(`broker ${health ? `up, holding "${health.fleet}" with ${health.sessions?.length ?? 0} session(s)`
                       : `down on ${port}`}`);
  for (const c of chars) {
    const obj = ids[c.name];
    log(`  ${c.name.padEnd(12)} ${obj == null ? 'not on this server' : `object ${obj}`}`);
  }
  return { broker: health, characters: ids };
}

// ------------------------------------------------------------------ CLI

async function main(argv) {
  const [verb, path] = argv;
  if (!verb || !path) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('\n').filter(l => l.startsWith('//')).slice(0, 8).join('\n'));
    return 2;
  }
  let spec;
  try { spec = loadSpec(path); }
  catch (e) { console.error(e.message); return 2; }

  if (verb === 'plan') {
    const chars = expand(spec);
    console.log(`${chars.length} character(s), fleet "${spec.fleet ?? '(unnamed)'}", ` +
                `${spec.server?.host ?? '127.0.0.1'}:${spec.server?.port ?? 5959}`);
    for (const c of chars)
      console.log(`  ${c.agent.padEnd(10)} ${c.name.padEnd(12)} ${(c.roll ?? 'melee').padEnd(9)}` +
                  `${c.place ? ` room ${c.place.room}${c.place.at ? ` at ${c.place.at.join(',')}` : ''}` : ''}` +
                  `${c.keeper ? `  keeper ${c.keeper.mode ?? 'on'}` : ''}`);
    console.log('\nvalid. Nothing was created.');
    return 0;
  }
  if (verb === 'up')     { await up(spec); return 0; }
  if (verb === 'place')  { await place(spec); return 0; }
  if (verb === 'reset')  { await reset(spec); return 0; }
  if (verb === 'status') { await status(spec); return 0; }

  console.error(`unknown verb: ${verb}`);
  return 2;
}

const isEntryPoint = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main(process.argv.slice(2)).then(c => process.exit(c)).catch(e => {
    console.error(e.message); process.exit(1);
  });
}
