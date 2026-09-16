#!/usr/bin/env node
// WHAT THIS PINS: that a devnote reaches the errand that needs it, and that a superseded one
// does not. Offline — writes to a temp file, opens no socket, touches no roster.
//
//   node tools/m59-devnote-test.mjs
import { addDevnote, readDevnotes, matchDevnotes, formatDevnote } from './m59-devnote.mjs';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0, failed = 0;
const ok = (cond, what) => { if (cond) { passed++; console.log(`  ok   ${what}`); }
                             else { failed++; console.log(`  FAIL ${what}`); } };

const dir = mkdtempSync(join(tmpdir(), 'devnote-'));
const file = join(dir, 'devnotes.jsonl');
try {
  console.log('\nwriting');
  const a = addDevnote({ title: 'Icky cave will not fight', text: 'the keeper idles',
                         rooms: '27', tags: 'combat', touches: 'tools/m59-autopilot.mjs',
                         evidence: '8 orcs, 4.5 min, 0 kills' }, { file });
  ok(!!a.id, 'a note gets an id');
  ok(a.rooms[0] === 27, 'rooms are numbers, not strings — they are matched against step targets');
  ok(a.tags[0] === 'combat', 'a leading # on a tag is stripped so #combat and combat are one tag');
  addDevnote({ title: 'Brax movement', text: 'TODO: fix movement here', rooms: '828',
               tags: 'movement' }, { file });
  addDevnote({ title: 'No evidence here', text: 'a suspicion', tags: 'combat' }, { file });

  let notes = readDevnotes({ file });
  ok(notes.length === 3, 'every note reads back');
  ok(notes[0].title === 'No evidence here', 'newest first — the last thing learned is the first thing shown');

  console.log('\nrefusing a note nobody can use');
  let threw = null;
  try { addDevnote({ text: 'no title' }, { file }); } catch (e) { threw = e.message; }
  ok(/title/.test(threw ?? ''), 'a note with no title is refused');
  threw = null;
  try { addDevnote({ title: 'no body' }, { file }); } catch (e) { threw = e.message; }
  ok(/text/.test(threw ?? ''), 'and so is one with no text');

  console.log('\nreaching the errand that needs it');
  ok(matchDevnotes(notes, { rooms: [27] }).length === 1, 'a room match finds the note for that room');
  ok(matchDevnotes(notes, { rooms: [27] })[0].title === 'Icky cave will not fight', 'and it is the right one');
  ok(matchDevnotes(notes, { rooms: [113] }).length === 0, 'a room with no notes gets none');
  ok(matchDevnotes(notes, { rooms: [27, 828] }).length === 2, 'an errand walking two rooms sees both');
  ok(matchDevnotes(notes, { tags: ['combat'] }).length === 2, 'a tag match finds every note under it');
  ok(matchDevnotes(notes, { tags: ['#combat'] }).length === 2, 'and the # is optional on the asking side too');
  // Callers know a tool by its name; a note is filed against its path.
  ok(matchDevnotes(notes, { touches: ['m59-autopilot.mjs'] }).length === 1,
     'a bare tool name matches a note filed against its full path');
  ok(matchDevnotes(notes, { touches: ['tools/m59-autopilot.mjs'] }).length === 1, 'and the full path matches too');
  ok(matchDevnotes(notes, {}).length === 0,
     'asking for nothing returns nothing — an errand with no rooms is not shown every note ever written');

  console.log('\nbeing wrong, later');
  const old = notes.find(n => n.title === 'Brax movement');
  addDevnote({ title: 'Brax movement was the wrong room', text: 'it is 830, not 828',
               rooms: '830', tags: 'movement', supersedes: old.id }, { file });
  notes = readDevnotes({ file });
  ok(!notes.some(n => n.id === old.id), 'a superseded note stops being handed out');
  ok(matchDevnotes(notes, { rooms: [828] }).length === 0, 'so the old room no longer carries wrong advice');
  ok(matchDevnotes(notes, { rooms: [830] }).length === 1, 'and the correction is what a walk there sees');

  console.log('\nprinting');
  const text = formatDevnote(notes.find(n => n.title === 'Icky cave will not fight'));
  ok(/room 27/.test(text), 'the rendering says which room it is about');
  ok(/evidence: 8 orcs/.test(text), 'and carries the evidence');
  const bare = formatDevnote(notes.find(n => n.title === 'No evidence here'));
  ok(/\(no evidence recorded\)/.test(bare),
     'a note with no measurement SAYS so rather than looking like one that has some');

  console.log('\na torn file is not an empty one');
  appendFileSync(file, '{not json\n');
  ok(readDevnotes({ file }).length === notes.length, 'one bad line does not hide every other note');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
