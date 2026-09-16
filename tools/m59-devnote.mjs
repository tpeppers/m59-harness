#!/usr/bin/env node
// A NOTE THAT FINDS YOU, INSTEAD OF ONE YOU HAVE TO REMEMBER TO GO AND READ.
//
//   node tools/m59-devnote.mjs add --title "Safe-wall idling in Icky" \
//        --rooms 27 --tags combat --touches tools/m59-autopilot.mjs \
//        --text "..." --evidence "..."
//   node tools/m59-devnote.mjs list                      everything, newest first
//   node tools/m59-devnote.mjs list --room 27            just this room
//   node tools/m59-devnote.mjs match --rooms 27,113      what a script touching those would see
//
// ============================================================ WHY THIS IS NOT `#movement`
//
// `#movement` is a COMMIT TAG and it does one job: it declares an EPOCH, so evidence
// recorded before it resets rather than being averaged into evidence recorded after. It
// answers "is this measurement still about the code in play". It says nothing to the next
// person about what they are walking into.
//
// A devnote is the other half, and this repository already proves it is needed: CLAUDE.md's
// own trap list says *"The point is not that the traps are undocumented. They are all
// documented, in this file, and they were still walked into — a rule you have to remember is
// a rule you forget at 02:00 with a character dying."* The answer there was to turn rules
// into refusals in `m59-fleetscript.mjs`. But not every finding is a refusal. Some are just
// *"this room does not behave the way the tool says it does"*, and those have nowhere to live
// except a paragraph in a document nobody opens while debugging that room.
//
// So a devnote is addressed to a PLACE, a TOOL or a TAG rather than to a reader, and
// `fleetScript` prints the ones that match the errand it is about to run — at the moment the
// errand is compiled, before anything walks. The note arrives because you are about to need
// it, which is the only delivery mechanism that has ever worked here.
//
// ============================================================ WHAT MAKES A GOOD ONE
//
// The same bar the critic applies: an observation is not a finding. "The keeper would not
// fight" is inadmissible; "with 8 orcs in room 27 the body shuffled r25c29-r25c31 for 4.5
// minutes with combat never active, and pull_to_safe_wall:false was coerced back on" is a
// devnote, because the next person can check it in one read.
//
// `evidence` is therefore a separate field from `text` and is meant to carry the measurement.
// A note with no evidence is still accepted — a suspicion recorded is better than a suspicion
// lost — but it says `(no evidence recorded)` when it prints, which is the honest label.
//
// ============================================================ WHERE THEY LIVE
//
// `docs/devnotes.jsonl`, COMMITTED, one JSON object per line, appended and never edited. A
// devnote is a fact about the world or the code, so it is everybody's — unlike a loadout or a
// threshold, which are orders and belong to the machine that owns the roster. Append-only for
// the same reason the mindmap's log is: the record of how the understanding moved IS the
// finding, so a note that turns out to be wrong gets a LATER note saying so (`--supersedes`)
// rather than being quietly edited into looking right.
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
export const DEVNOTES = join(REPO, 'docs', 'devnotes.jsonl');

const norm = (s) => String(s ?? '').trim().toLowerCase();
const asList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(','))
  .map(x => String(x).trim()).filter(Boolean);

/** Read every note. A malformed line is skipped rather than fatal: one bad append must not
 *  make every other note unreadable, and the file is append-only from several sessions. */
export function readDevnotes({ file = DEVNOTES } = {}) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  // A superseded note is kept in the file and hidden from reads, so the history survives
  // without the wrong advice being handed to the next script that touches the room.
  const dead = new Set(out.flatMap(n => asList(n.supersedes)));
  return out.filter(n => !dead.has(String(n.id))).reverse();
}

/**
 * The notes an errand should see. Matching is deliberately GENEROUS — a note you did not
 * need costs one line, and a note you needed and did not get costs a session.
 */
export function matchDevnotes(notes, { rooms = [], tags = [], touches = [] } = {}) {
  const wantRooms = new Set(asList(rooms).map(Number).filter(Number.isFinite));
  const wantTags = new Set(asList(tags).map(n => norm(n).replace(/^#/, '')));
  const wantTouch = asList(touches).map(norm);
  if (!wantRooms.size && !wantTags.size && !wantTouch.length) return [];
  return notes.filter(n => {
    if (asList(n.rooms).map(Number).some(r => wantRooms.has(r))) return true;
    if (asList(n.tags).some(t => wantTags.has(norm(t).replace(/^#/, '')))) return true;
    // A file match is a SUFFIX match so `m59-autopilot.mjs` finds a note filed against
    // `tools/m59-autopilot.mjs` — callers know a tool by its name, not by its path.
    if (asList(n.touches).some(f => wantTouch.some(w => norm(f).endsWith(w) || w.endsWith(norm(f))))) return true;
    return false;
  });
}

export function addDevnote(note, { file = DEVNOTES } = {}) {
  const title = String(note.title ?? '').trim();
  if (!title) throw new Error('a devnote needs a --title: a note nobody can scan is one nobody reads');
  const text = String(note.text ?? '').trim();
  if (!text) throw new Error('a devnote needs --text');
  const row = {
    id: note.id ?? randomUUID().slice(0, 8),
    at: note.at ?? new Date().toISOString(),
    title, text,
    evidence: String(note.evidence ?? '').trim() || null,
    rooms: asList(note.rooms).map(Number).filter(Number.isFinite),
    tags: asList(note.tags).map(t => norm(t).replace(/^#/, '')),
    touches: asList(note.touches),
    supersedes: asList(note.supersedes),
  };
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(row) + '\n');
  return row;
}

/** One note, rendered for a terminal that is about to drive a fleet. Short on purpose. */
export function formatDevnote(n, { indent = '  ' } = {}) {
  const where = [
    n.rooms?.length ? `room ${n.rooms.join(', ')}` : null,
    n.tags?.length ? n.tags.map(t => `#${t}`).join(' ') : null,
  ].filter(Boolean).join('  ');
  const lines = [`${indent}DEVNOTE ${n.title}${where ? `  (${where})` : ''}`];
  for (const l of String(n.text).split(/\n/)) lines.push(`${indent}  ${l}`);
  lines.push(`${indent}  evidence: ${n.evidence ?? '(no evidence recorded)'}`);
  lines.push(`${indent}  ${String(n.at).slice(0, 19)}  ${n.id}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- cli
if (import.meta.filename === process.argv[1]) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'list';
  const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

  if (cmd === 'add') {
    const row = addDevnote({
      title: arg('--title'), text: arg('--text'), evidence: arg('--evidence'),
      rooms: arg('--rooms', ''), tags: arg('--tags', ''), touches: arg('--touches', ''),
      supersedes: arg('--supersedes', ''),
    });
    console.log(`added ${row.id}`);
    console.log(formatDevnote(row));
    process.exit(0);
  }

  const notes = readDevnotes();
  if (cmd === 'match') {
    const hits = matchDevnotes(notes, { rooms: arg('--rooms', ''), tags: arg('--tags', ''),
                                        touches: arg('--touches', '') });
    for (const n of hits) console.log(formatDevnote(n) + '\n');
    console.log(`${hits.length} of ${notes.length} note(s) match`);
    process.exit(0);
  }

  const room = arg('--room'), tag = arg('--tag');
  const shown = (room || tag)
    ? matchDevnotes(notes, { rooms: room ?? '', tags: tag ?? '' })
    : notes;
  for (const n of shown) console.log(formatDevnote(n) + '\n');
  console.log(`${shown.length} devnote(s)${notes.length !== shown.length ? ` of ${notes.length}` : ''}`);
}
