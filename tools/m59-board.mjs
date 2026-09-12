#!/usr/bin/env node
// THE CORK BOARD: EVERY SCRATCHPAD DRIVING THIS FLEET, AND WHAT OTHER SESSIONS THINK OF IT.
//
//   node tools/m59-board.mjs list
//   node tools/m59-board.mjs post badlands-rail --for "fine rail into 45" --agents hk2
//   node tools/m59-board.mjs note badlands-rail "walkFine is broker-side; prod-deploy lacks it"
//   node tools/m59-board.mjs strike badlands-rail --why promoted
//   node tools/m59-board.mjs check
//
// A PAD MUST BE ON THE BOARD BEFORE IT MAY RUN. That is the whole mechanism and it buys three
// things, in the order the operator asked for them:
//
//   1. YOU CAN SEE WHAT IS DRIVING THE FLEET. A pad is invisible to `list` in the fleet REPL by
//      design, and untracked by git by design. Both of those are correct and together they made
//      scratchpads unobservable: on 2026-09-11/12 two sessions built a tool called FleetScratch
//      from the same operator ask, all night, without seeing each other. Neither was careless.
//      There was nowhere to look.
//   2. YOU CAN SEE WHEN YOU ARE LEANING ON THEM. A pad is WIP by definition -- it has no
//      provenance pin, no recipe and no test. One that has been on the board for three weeks is
//      not a scratchpad any more, it is production with none of production's guarantees, and
//      `check` says so by age rather than waiting for somebody to notice.
//   3. THEY CAN COORDINATE. Two pads driving the same character is a collision `check` reports,
//      and any session may pin a NOTE to any pad. That second half is the cork board rather than
//      a lock table: the thing that would have saved that night was not a mutex, it was somewhere
//      to leave "I am in this too, and here is what I learned".
//
// ============================================================ WHERE THE BOARD LIVES, AND WHY
//
// BESIDE THE ROSTER, AND THE ROSTER IS PER CHECKOUT -- so the default board is per checkout too,
// and that is exactly the trap m59-runlock.mjs already documents: "a tool run from a clone and
// one run from prod-deploy take two DIFFERENT locks, see each other as absent, and both drive".
// A board with that failure mode would be worse than none, because it would look like
// coordination.
//
// So the board follows the runlock's own convention rather than inventing a second one:
//
//     M59_BOARD_DIR  -- an explicit board directory, or
//     M59_RUNLOCK_DIR -- the directory a shared lock already points at, or
//     REPO/substrate  -- this checkout, which coordinates nothing outside it
//
// Falling through to the runlock's directory is the point: a machine that has already pointed its
// checkouts at one lock directory gets a shared board for free and cannot end up with a shared
// lock and a private board. And `list` PRINTS THE PATH IT READ, every time, because "nothing is
// posted" and "nothing is posted HERE" are the same sentence about two different facts -- the
// lesson from `check` naming the roster it read, one week old and already paid for twice.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fleetName } from './m59-fleetpath.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
export const BOARD_SCHEMA = 'm59-scratchpad-board/v1';

/** Where the board is, and which of the three rules decided it. */
export function boardDir(env = process.env) {
  if (env.M59_BOARD_DIR) return { dir: env.M59_BOARD_DIR, by: 'M59_BOARD_DIR' };
  if (env.M59_RUNLOCK_DIR) return { dir: env.M59_RUNLOCK_DIR, by: 'M59_RUNLOCK_DIR' };
  return { dir: join(REPO, 'substrate'), by: 'this checkout (coordinates nothing outside it)' };
}

export function boardFile(fleet = fleetName(), env = process.env) {
  const { dir, by } = boardDir(env);
  return { path: join(dir, `${String(fleet).replace(/[^\w.-]/g, '_')}.scratchpads.json`), by, dir };
}

export function readBoard(fleet = fleetName(), env = process.env) {
  const { path, by, dir } = boardFile(fleet, env);
  if (!existsSync(path))
    return { schema: BOARD_SCHEMA, fleet, pads: [], path, by, dir, fresh: true };
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    return { ...doc, pads: doc.pads ?? [], path, by, dir, fresh: false };
  } catch (e) {
    // A BOARD THAT WILL NOT PARSE IS NOT AN EMPTY BOARD. Same rule as the policy files: silence
    // means what was already there, never "nothing is posted".
    return { schema: BOARD_SCHEMA, fleet, pads: null, path, by, dir, fresh: false,
             why: `the board will not parse (${e.message}) — treat it as UNREADABLE, not empty` };
  }
}

export function writeBoard(board, env = process.env) {
  const { path, dir } = boardFile(board.fleet, env);
  mkdirSync(dir, { recursive: true });
  const { path: _p, by: _b, dir: _d, fresh: _f, why: _w, ...doc } = board;
  writeFileSync(path, JSON.stringify({ ...doc, schema: BOARD_SCHEMA }, null, 2));
  return path;
}

const nowISO = () => new Date().toISOString();
export const ageDays = (iso, now = Date.now()) =>
  Math.floor((now - Date.parse(iso)) / 86_400_000);

/**
 * Pin a pad to the board.
 *
 * `by` and `for` are required and are not ceremony: a pin with no author and no purpose is a pin
 * nobody can act on, which is the state the board exists to end. `agents` is what makes collisions
 * visible, so a pad that declines to say is pinned but cannot be checked against anybody.
 */
export function post(board, { name, by, purpose, agents = [], checkout = REPO,
                              at = nowISO() } = {}) {
  if (!name) throw new Error('a pin needs the pad name');
  if (!by) throw new Error('a pin needs `by` — which session or person is driving it');
  if (!purpose) throw new Error(
    'a pin needs `--for` — one line on what this pad is for. A pin nobody can act on is the ' +
    'state the board exists to end.');
  const pads = (board.pads ?? []).filter(p => p.name !== name);
  const prior = (board.pads ?? []).find(p => p.name === name);
  pads.push({ name, by, at, purpose, agents: [].concat(agents).filter(Boolean), checkout,
              notes: prior?.notes ?? [] });
  return { ...board, pads };
}

/** Leave a note for whoever is driving that pad. The cork-board half. */
export function note(board, name, { by, text, at = nowISO() } = {}) {
  const pad = (board.pads ?? []).find(p => p.name === name);
  if (!pad) throw new Error(`nothing named "${name}" is on this board — post it first, or check ` +
                            `the name against \`list\``);
  if (!by || !text) throw new Error('a note needs `by` and the text');
  pad.notes = [...(pad.notes ?? []), { by, at, text }];
  return board;
}

export function strike(board, name, { why = null } = {}) {
  const had = (board.pads ?? []).some(p => p.name === name);
  if (!had) throw new Error(`nothing named "${name}" is on this board`);
  return { ...board, pads: board.pads.filter(p => p.name !== name),
           struck: [...(board.struck ?? []),
                    { name, at: nowISO(), why }].slice(-50) };
}

/** Is this pad allowed to run? The gate. */
export function isPosted(board, name) {
  if (board.pads === null) return { ok: false, why: board.why };
  const pad = (board.pads ?? []).find(p => p.name === name);
  if (pad) return { ok: true, pad };
  return { ok: false, pad: null,
           why: `"${name}" is not on the scratchpad board for fleet "${board.fleet}".\n` +
                `  board: ${board.path}\n` +
                `  A pad must be pinned before it may drive anything — so that somebody can see ` +
                `what is driving the fleet, so two sessions do not build the same thing twice, ` +
                `and so anybody can leave you a note.\n` +
                `  node tools/m59-board.mjs post ${name} --by "<who you are>" ` +
                `--for "<one line>" --agents <a,b>` };
}

// ------------------------------------------------------------------ what the board notices
//
// STALENESS IS THE RELIANCE SIGNAL, and it is the second thing the operator asked for. A pad has
// no provenance pin, no recipe and no test — that is what makes it a pad. One still pinned three
// weeks later is production without production's guarantees, and nobody notices, because it works.
export const NUDGE_DAYS = 7;
export const STALE_DAYS = 21;

export function checkBoard(board, { now = Date.now() } = {}) {
  const pads = board.pads ?? [];
  const aged = pads.map(p => ({ ...p, age: ageDays(p.at, now) }));

  // COLLISIONS: two pads pinned against one character. Not a refusal — an operator may genuinely
  // want two views of one body — but it is never something to discover afterwards.
  const byAgent = new Map();
  for (const p of aged)
    for (const a of p.agents ?? []) {
      if (!byAgent.has(a)) byAgent.set(a, []);
      byAgent.get(a).push(p.name);
    }
  const collisions = [...byAgent.entries()].filter(([, ns]) => ns.length > 1)
    .map(([agent, names]) => ({ agent, names }));

  // TWO CHECKOUTS ON ONE BOARD is the good case — it means the board is doing its job — but it is
  // worth naming, because the files those pads import have already diverged once.
  const checkouts = [...new Set(aged.map(p => p.checkout).filter(Boolean))];

  return {
    pads: aged,
    nudge: aged.filter(p => p.age >= NUDGE_DAYS && p.age < STALE_DAYS),
    stale: aged.filter(p => p.age >= STALE_DAYS),
    collisions, checkouts,
    unanswered: aged.filter(p => (p.notes ?? []).length > 0),
  };
}

export function formatBoard(board, { now = Date.now() } = {}) {
  const out = [`scratchpad board — fleet "${board.fleet}"`,
               `  ${board.path}`,
               `  (location chosen by: ${board.by})`];
  if (board.pads === null) { out.push('', `  ${board.why}`); return out.join('\n'); }
  if (!board.pads.length) {
    out.push('', '  nothing is pinned HERE — which is not the same as nothing being pinned.',
             '  If another checkout drives this fleet, point both at one directory:',
             '    M59_BOARD_DIR=<shared>   (or share M59_RUNLOCK_DIR, which this falls back to)');
    return out.join('\n');
  }
  const c = checkBoard(board, { now });
  out.push('');
  for (const p of c.pads) {
    const mark = p.age >= STALE_DAYS ? 'STALE' : p.age >= NUDGE_DAYS ? 'aging' : '     ';
    out.push(`  ${mark} ${p.name.padEnd(20)} ${p.purpose}`);
    out.push(`        ${p.by} · ${p.age} day(s) · ${(p.agents ?? []).join(', ') || 'no agents declared'}`);
    if (p.checkout && c.checkouts.length > 1) out.push(`        in ${p.checkout}`);
    for (const n of p.notes ?? [])
      out.push(`        note · ${n.by}: ${n.text}`);
  }
  if (c.collisions.length) {
    out.push('');
    for (const x of c.collisions)
      out.push(`  COLLISION  ${x.agent} is claimed by ${x.names.join(' and ')}`);
  }
  if (c.stale.length) {
    out.push('');
    out.push(`  ${c.stale.length} pad(s) pinned ${STALE_DAYS}+ days. A pad has no provenance pin, ` +
             `no recipe and no test —`);
    out.push(`  one this old is production without production's guarantees. Promote it or strike it.`);
  }
  if (c.checkouts.length > 1) {
    out.push('');
    out.push(`  ${c.checkouts.length} checkouts share this board, which is the board working. ` +
             `Note that`);
    out.push(`  m59-fleetlib.mjs has already diverged between checkouts once — a pad that imports`);
    out.push(`  it is not importing the same file in both.`);
  }
  return out.join('\n');
}

// ------------------------------------------------------------------ CLI
const invokedDirectly = process.argv[1] &&
  basename(process.argv[1]).replace(/\.mjs$/, '') === 'm59-board';
if (invokedDirectly) {
  const [action, target, ...rest] = process.argv.slice(2);
  const arg = (k, d = null) => {
    const i = rest.indexOf(`--${k}`);
    return i >= 0 ? (rest[i + 1] ?? true) : d;
  };
  try {
    const fleet = arg('fleet', fleetName());
    let board = readBoard(fleet);
    if (action === 'list' || !action) {
      console.log(formatBoard(board));
    } else if (action === 'post') {
      board = post(board, { name: target, by: arg('by'), purpose: arg('for'),
                            agents: String(arg('agents', '')).split(/[\s,]+/).filter(Boolean) });
      console.log(`pinned ${target} to ${writeBoard(board)}`);
    } else if (action === 'note') {
      const text = rest.filter(r => !r.startsWith('--') &&
                                    rest[rest.indexOf(r) - 1]?.startsWith('--') !== true).join(' ');
      board = note(board, target, { by: arg('by', 'anonymous'), text: arg('text', text) });
      console.log(`noted on ${target} in ${writeBoard(board)}`);
    } else if (action === 'strike') {
      board = strike(board, target, { why: arg('why') });
      console.log(`struck ${target} from ${writeBoard(board)}`);
    } else if (action === 'check') {
      const c = checkBoard(board);
      console.log(formatBoard(board));
      process.exitCode = c.collisions.length || c.stale.length ? 1 : 0;
    } else {
      console.log('usage: m59-board.mjs list | post <pad> --by W --for X --agents a,b | ' +
                  'note <pad> --by W --text X | strike <pad> | check');
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(`m59-board: ${e.message}`);
    process.exitCode = 1;
  }
}
