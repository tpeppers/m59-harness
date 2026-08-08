#!/usr/bin/env node
// CHARACTER DESCRIPTIONS — the prose another player gets when they look at one of ours.
//
//   node tools/m59-describe.mjs                       what we have set, per character
//   node tools/m59-describe.mjs --set Kermit "..."    one character
//   node tools/m59-describe.mjs --apply bios.json     a whole fleet from a file
//   node tools/m59-describe.mjs --reapply             send the record again, after a re-roll
//   node tools/m59-describe.mjs --clear Kermit        blank it (NOT the default text — see below)
//
// A description is `psPlayerDescription` on the player object. It is set with
// BP_CHANGE_DESCRIPTION (126), it is saved with the character, and it REPLACES the
// look text rather than adding to it — Player.ShowDesc (player.kod:1521) sends it
// under the "%q" resource and returns before the default prose is built. A character
// with one set no longer announces its level and guild to anyone who looks.
//
// A DESCRIPTION CAN BE READ BACK, AND THE WAY TO DO IT IS TO LOOK AT THE CHARACTER —
// including looking at itself, which is exactly what the real client's right-click-your-
// own-face dialog does. I got this wrong first time round: `look_at` on a player was
// timing out and blaming OF_NOEXAMINE, and I took that for proof the protocol had no
// answer. It has one, and it is a different packet — `Player.TryLook` (user.kod:4374)
// diverts to `SendLookPlayer`, which replies with BP_USERCOMMAND / UC_LOOK_PLAYER
// rather than BP_LOOK. This client did not parse incoming BP_USERCOMMAND at all, so
// the reply was being dropped in silence, and a packet nobody parses is indistinguishable
// from a packet nobody sends.
//
// What is still true is that the server never volunteers one and the read costs a
// round trip and a character standing in the right place. So what we sent is written
// to substrate/descriptions/<character>.json at the moment of sending, and `--verify`
// goes and looks — the record is the claim, the look is the evidence.
//
// CLEARING IS NOT UNDOING. `UserChangeDescription` (user.kod:4444) reads a NIL string
// as "keep the one you have", and an empty string is not nil — so `--clear` leaves the
// character with a blank bio rather than the default prose, and there is no way back
// short of a re-roll. The real client does exactly the same thing with an emptied box.
//
// Until something looks, everything this file reports is WHAT WE SENT, not what the
// server holds. The two can differ: CleanseString (system.kod:5687) substitutes swear
// words before storing, and a re-roll starts the character over with whatever
// BP_NEW_CHARINFO carried. `verified` is set only when someone has actually looked and
// the text came back matching, which is what --verify records.
//
// TWO THINGS SILENTLY MANGLE A DESCRIPTION, AND BOTH ARE ON OUR SIDE.
//
//   The wire is Latin-1. `pstr` in m59-client.mjs is Buffer.from(s, 'latin1'), which
//   for anything outside U+00FF keeps the LOW BYTE: an em dash (U+2014) goes out as
//   0x14, a control character. So "he said — quietly" arrives with a hole in it and
//   nothing errors. cleanDescription folds the punctuation a human actually types
//   (curly quotes, dashes, ellipsis) down to ASCII first, and drops what it cannot
//   fold rather than sending a byte that means something else.
//
//   The cap is 1000 (MAX_DESCRIPTION, clientd3d/object.h:30). The server's parser
//   takes a 2-byte length and will carry more, but the real client's edit box will
//   not, so a longer one is a description no human can correct.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export const DESC_DIR = process.env.M59_DESC_DIR || here('../substrate/descriptions');

// clientd3d/object.h:30 — the client's own edit box limit, and therefore the longest
// description a human at a keyboard could ever have written.
export const MAX_DESCRIPTION = 1000;

const safeName = (s) => String(s || 'unknown').replace(/[^A-Za-z0-9_-]/g, '');
const fileFor = (character) => join(DESC_DIR, `${safeName(character)}.json`);

// Enough to see what a character has been called without the file growing forever.
const MAX_HISTORY = 50;

// ------------------------------------------------------------------ the text
//
// The characters people actually paste in — smart quotes out of a document, an em
// dash out of a chat client — mapped to what Latin-1 can carry. Anything not here
// and not printable ASCII is dropped with a note rather than guessed at.
const FOLD = new Map(Object.entries({
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-',
  '…': '...', '′': "'", '″': '"', ' ': ' ',
  '•': '*', '‹': '<', '›': '>', '«': '<<', '»': '>>',
}));

// Fold, drop, cap. Returns the text to send plus every change made to it, so a caller
// can report "this is not quite what you asked for" instead of discovering it in game.
export function cleanDescription(raw) {
  const changes = [];
  let s = String(raw ?? '');

  // Line endings first: CRLF would otherwise leave a stray CR to be dropped as a
  // control character, and the count would read as damage.
  if (/\r/.test(s)) { s = s.replace(/\r\n?/g, '\n'); changes.push('normalised line endings'); }

  // What survives: printable ASCII, tab and newline, and the printable half of
  // Latin-1 above U+00A0 — é and ñ go out as one byte each and arrive intact. What
  // does not: U+007F-U+009F, which are the C1 control block on the wire even though
  // the client's CP1252 font draws glyphs there, and everything above U+00FF, whose
  // low byte would be some unrelated control character.
  let folded = 0, dropped = [];
  s = [...s].map(ch => {
    if (FOLD.has(ch)) { folded++; return FOLD.get(ch); }
    const cp = ch.codePointAt(0);
    if (ch === '\n' || ch === '\t') return ch;
    if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return ch;
    dropped.push(ch);
    return '';
  }).join('');
  if (folded) changes.push(`folded ${folded} character(s) to ASCII`);
  if (dropped.length)
    changes.push(`dropped ${dropped.length} character(s) the Latin-1 wire cannot carry: ` +
                 [...new Set(dropped)].join(' '));

  s = s.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();

  if (Buffer.byteLength(s, 'latin1') > MAX_DESCRIPTION) {
    s = s.slice(0, MAX_DESCRIPTION);
    changes.push(`truncated to ${MAX_DESCRIPTION} characters`);
  }
  return { text: s, changes };
}

// ------------------------------------------------------------------ the record

export function emptyBook(character) {
  return { character: character ?? null, version: 1, description: null, sent_at: null,
           verified: false, verified_at: null, history: [] };
}

export function loadBook(character) {
  try { return { ...emptyBook(character), ...JSON.parse(readFileSync(fileFor(character), 'utf8')) }; }
  catch { return emptyBook(character); }
}

export function saveBook(book) {
  if (!book?.character) return null;                  // never write an "unknown.json"
  try {
    mkdirSync(DESC_DIR, { recursive: true });
    const f = fileFor(book.character);
    writeFileSync(f, JSON.stringify(book, null, 2));
    return f;
  } catch { return null; }                            // a failed write must not stop play
}

export const listCharacters = () => {
  try { return readdirSync(DESC_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort(); }
  catch { return []; }
};

// What was sent, written down at the moment of sending. `at` is a parameter rather
// than the clock so a backfill from a recording files entries under the time they
// actually happened.
export function noteDescription(character, text, { at = Date.now(), agent = null } = {}) {
  if (!character) return null;
  const book = loadBook(character);
  const changed = book.description !== text;
  book.description = text;
  book.sent_at = at;
  book.agent = agent ?? book.agent ?? null;
  // A new text has not been seen by anyone yet, whatever the old one had earned.
  if (changed) { book.verified = false; book.verified_at = null; }
  book.history = [...(book.history || []), { at, text, agent }].slice(-MAX_HISTORY);
  saveBook(book);
  return book;
}

// Someone looked, and this is the prose that came back. Only an exact match counts:
// a near match means CleanseString rewrote us, and that is worth seeing rather than
// rounding off.
export function noteObserved(character, seen, { at = Date.now(), by = null } = {}) {
  if (!character) return null;
  const book = loadBook(character);
  book.observed = seen ?? null;
  book.observed_at = at;
  book.observed_by = by;
  book.verified = seen != null && book.description != null && seen === book.description;
  book.verified_at = book.verified ? at : null;
  saveBook(book);
  return book;
}

// ------------------------------------------------------------------ the broker
//
// The same JSON-RPC port m59-mcp-attach.mjs forwards to. This holds no sessions and
// takes no lock — it asks the process that already has the fleet.

const argv = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const HOST = arg('--host', process.env.M59_BROKER_HOST || '127.0.0.1');
const PORT = Number(arg('--port', process.env.M59_BROKER_PORT || 8901));

export async function callTool(name, args, { host = HOST, port = PORT } = {}) {
  const res = await fetch(`http://${host}:${port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                           params: { name, arguments: args } }),
  });
  const body = JSON.parse(await res.text());
  const text = body?.result?.content?.[0]?.text ?? '';
  if (body?.result?.isError) throw new Error(text || 'tool error');
  try { return JSON.parse(text); } catch { return { text }; }
}

// agent name -> character name, from the process that actually holds them. Both are
// accepted on the command line because a human thinks "Kermit" and the broker thinks
// "t1", and getting that wrong writes the wrong character's bio.
export async function fleetRoster(opts) {
  const f = await callTool('fleet', {}, opts);
  // The row's field is `character` — `name` on a fleet row is the ROOM's name, and
  // reading the wrong one gives a roster of `undefined`s that matches nobody.
  return (f.fleet || []).map(r => ({
    agent: r.agent, character: r.character,
    room: r.room?.num ?? r.room?.name ?? r.room ?? null,
    roomName: r.room?.name ?? (typeof r.room === 'string' ? r.room : null),
  }));
}

export function resolveAgent(roster, who) {
  const w = String(who).toLowerCase();
  const hit = roster.find(r => String(r.agent).toLowerCase() === w) ||
              roster.find(r => String(r.character).toLowerCase() === w);
  if (!hit) throw new Error(`no character or agent called "${who}" — the broker is holding ` +
                            roster.map(r => `${r.character} (${r.agent})`).join(', '));
  return hit;
}

// ------------------------------------------------------------------ the cli

async function main() {
  const setWho = arg('--set', null);
  const clearWho = arg('--clear', null);
  const applyFile = arg('--apply', null);

  if (applyFile) {
    // { "Kermit": "...", "t2": "..." } — keyed by whichever name the author had.
    const wanted = JSON.parse(readFileSync(applyFile, 'utf8'));
    const roster = await fleetRoster();
    const rows = [];
    for (const [who, text] of Object.entries(wanted)) {
      try {
        const { agent, character } = resolveAgent(roster, who);
        const r = await callTool('describe', { agent, text });
        rows.push({ character, agent, ok: !!r.sent, sent: r.sent, changes: r.changes || [] });
      } catch (e) { rows.push({ character: who, ok: false, error: e.message }); }
    }
    for (const r of rows)
      console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${String(r.character).padEnd(10)} ` +
                  `${r.ok ? JSON.stringify(r.sent) : r.error}` +
                  `${r.changes?.length ? `  [${r.changes.join('; ')}]` : ''}`);
    console.log(`\n${rows.filter(r => r.ok).length}/${rows.length} set`);
    return;
  }

  // THE ONLY HONEST CHECK: ask the server. Every character looks at ITSELF, which the
  // protocol allows and the real client does on every right-click of your own portrait,
  // so this needs nobody to be standing anywhere in particular and covers the whole
  // fleet rather than whichever pairs happen to share a room.
  if (argv.includes('--verify')) {
    const roster = await fleetRoster();
    let good = 0, bad = 0;
    // A character the broker has not finished logging in has no name yet, and skipping
    // it silently would report "3 of 3 verified" over a fleet of twenty-one.
    const notInGame = roster.filter(r => !r.character).map(r => r.agent);
    const quiet = [];
    for (const r of roster) {
      if (!r.character) continue;
      try {
        // A CHARACTER IN A FIGHT ANSWERS LATE, AND THAT IS NOT AN EMPTY DESCRIPTION.
        // The look goes through the same one-action-a-second pacer as everything else,
        // so behind a combat round the reply can miss the wait — and on the first pass
        // over a busy fleet several do, a different several each time. Ask twice.
        let seen = await callTool('look_at', { agent: r.agent, target: r.character });
        if (seen.description == null)
          seen = await callTool('look_at', { agent: r.agent, target: r.character });
        // NO REPLY IS NOT EVIDENCE OF NO DESCRIPTION. Recording a timeout as an
        // observation would overwrite a confirmed reading with a silence.
        if (seen.description == null) {
          quiet.push(r.character);
          console.log(`----  ${r.character.padEnd(10)} no reply — busy, not necessarily blank`);
          continue;
        }
        const book = noteObserved(r.character, seen.description, { by: r.agent });
        if (book.verified) good++; else bad++;
        console.log(`${book.verified ? 'ok  ' : 'DIFF'} ${r.character.padEnd(10)} ` +
                    `${JSON.stringify(seen.description)}`);
      } catch (e) { bad++; console.log(`FAIL ${r.character.padEnd(10)} ${e.message}`); }
    }
    console.log(`\n${good} match the record, ${bad} do not, out of ${roster.length} in the roster.`);
    if (quiet.length)
      console.log(`no reply twice — ask again when they are not fighting: ${quiet.join(', ')}`);
    if (notInGame.length)
      console.log(`not asked — not in game yet: ${notInGame.join(', ')}`);
    return;
  }

  // A re-roll starts a character over with whatever BP_NEW_CHARINFO carried, which is
  // nothing — so a fleet that has been re-rolled has lost every description and there
  // is no server-side copy to notice that from. The books are the source: send them
  // all again. Idempotent, because setting a description to what it already is costs
  // one packet and changes nothing.
  if (argv.includes('--reapply')) {
    const roster = await fleetRoster();
    let done = 0;
    for (const character of listCharacters()) {
      const b = loadBook(character);
      if (!b.description) { console.log(`skip ${character} — nothing recorded`); continue; }
      try {
        const { agent } = resolveAgent(roster, character);
        await callTool('describe', { agent, text: b.description });
        console.log(`ok   ${character.padEnd(10)} ${JSON.stringify(b.description)}`);
        done++;
      } catch (e) { console.log(`FAIL ${character.padEnd(10)} ${e.message}`); }
    }
    console.log(`\n${done} re-sent from the record`);
    return;
  }

  if (setWho || clearWho) {
    const roster = await fleetRoster();
    const { agent, character } = resolveAgent(roster, setWho || clearWho);
    if (clearWho) {
      const r = await callTool('describe', { agent, clear: true });
      console.log(`${character} (${agent}) cleared — back to the default look text`);
      return void r;
    }
    // Everything after the name, so the text needs no quoting gymnastics.
    const i = argv.indexOf('--set');
    const text = argv.slice(i + 2).filter(a => !a.startsWith('--')).join(' ');
    if (!text) { console.error('nothing to set — usage: --set <character> <text>'); process.exit(2); }
    const r = await callTool('describe', { agent, text });
    console.log(`${character} (${agent}): ${JSON.stringify(r.sent)}`);
    if (r.changes?.length) console.log(`  changed on the way: ${r.changes.join('; ')}`);
    return;
  }

  // Default: what we have written down. Offline — it reads the files, not the fleet.
  const names = listCharacters();
  if (!names.length) {
    console.log(`nothing recorded in ${DESC_DIR}`);
    console.log('set one with:  node tools/m59-describe.mjs --set <character> "..."');
    return;
  }
  for (const n of names) {
    const b = loadBook(n);
    const age = b.sent_at ? `${Math.round((Date.now() - b.sent_at) / 60000)}m ago` : 'never';
    console.log(`${n.padEnd(10)} ${b.verified ? 'seen ' : 'sent '} ${age.padEnd(10)} ${JSON.stringify(b.description)}`);
  }
  console.log(`\n${names.length} recorded. A "sent" row is what we wrote down; a "seen" row is ` +
              `one the server has since confirmed by being looked at. --verify asks again.`);
}

// Importing this module must not run the CLI — the broker imports it for the store.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch(e => { console.error(`error: ${e.message}`); process.exit(1); });
