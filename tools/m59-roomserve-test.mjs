#!/usr/bin/env node
// THE GEOMETRY MAPS SITE, AND THE KEY THAT OPENS IT — offline, no socket bound, no roster.
//
//   node tools/m59-roomserve-test.mjs
//
// WHAT THIS PINS. `m59-roomserve.mjs` serves every room by number on 8977 with an index at `/`,
// and the operator asked for it on the fleet terminal's `G` key, the way `F` opens Field
// Command. Making that possible meant the file had to become IMPORTABLE, and it was not:
// `server.listen` ran at the top level, so importing it BOUND THE PORT, and `--help` called
// `process.exit(0)` on whatever argv the importer happened to have.
//
// That is the trap CLAUDE.md already records against the broker — "importing runs it: it tries
// to take the fleet lock and start rejoin timers" — and the fix m59-supervise.mjs already took.
// It is pinned by SOURCE rather than by behaviour on purpose: the failure is that a side effect
// happens at import, and a test that imports the module to check it has already paid the cost.
//
// The other half is the field-name bug I made writing the key, which is the one worth having:
// a feature that looks implemented and silently never fires.
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (what, cond, extra) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? '  — ' + extra : ''}`); }
};

const SERVE = readFileSync(new URL('./m59-roomserve.mjs', import.meta.url), 'utf8');
const TUI = readFileSync(new URL('./m59-tui.mjs', import.meta.url), 'utf8');
// Code, not prose: several assertions in this repository have matched the comment that
// explains a fix and reported a false failure against themselves.
const code = (src) => src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const SERVE_CODE = code(SERVE), TUI_CODE = code(TUI);

console.log('');
console.log('importing the server does not START one');
{
  ok('listen is guarded on being the entry point',
     /if \(IS_ENTRY\) \{[\s\S]{0,200}server\.listen\(PORT/.test(SERVE_CODE));
  ok('and there is no unguarded top-level listen left',
     !/^server\.listen\(/m.test(SERVE_CODE));
  // ORDER MATTERS AND IS THE SUBTLE HALF. `--help` calls process.exit(0). If IS_ENTRY were
  // computed after it, importing this file from a process whose argv happened to carry --help
  // would exit the importer — which for the TUI means the terminal vanishes on a keypress.
  ok('IS_ENTRY is computed BEFORE the --help block that exits',
     SERVE_CODE.indexOf('const IS_ENTRY') > 0 &&
     SERVE_CODE.indexOf('const IS_ENTRY') < SERVE_CODE.indexOf("argv.includes('--help')"));
  ok('and --help only fires as the entry point',
     /IS_ENTRY && argv\.includes\('--help'\)/.test(SERVE_CODE));
}

console.log('');
console.log('the site can be asked about, and the answer has THREE shapes');
{
  ok('status and start are exported', /export async function status\(\)/.test(SERVE_CODE) &&
                                      /export async function start\(/.test(SERVE_CODE));
  // A PORT THAT ANSWERS IS NOT AN ANSWER. Ours running, somebody else's server on the port,
  // and the port refusing are three different problems and only one is fixed by starting ours.
  // This is m59-which.mjs's INDETERMINATE verdict in miniature.
  ok('it distinguishes ours from somebody else serving the same site',
     /running: true, ours: true/.test(SERVE_CODE) && /running: true, ours: false/.test(SERVE_CODE));
  ok('and a port answering with something else is BLOCKED, not running',
     /blocked: true/.test(SERVE_CODE));
  ok('identity is the page title, not the port',
     /body\.includes\(TITLE\)/.test(SERVE_CODE));
  ok('and TITLE is exported so the caller can name it too',
     /export const TITLE = 'Geometry Debug Maps'/.test(SERVE_CODE));
  // The marker only works if the page actually carries it.
  ok('the index really serves that title, or the check can never pass',
     /'<title>' \+ TITLE \+ '<\/title>/.test(SERVE_CODE),
     'the index line concatenates the meta tag onto the closing tag, so do not require a '
     + 'standalone quote after </title>');
  ok('start waits for the PAGE rather than for the process',
     /const s = await status\(\);[\s\S]{0,120}if \(s\.running\)/.test(SERVE_CODE));
  ok('and it spawns the node that is running us, not whatever is on PATH',
     /spawn\(process\.execPath/.test(SERVE_CODE));
}

console.log('');
console.log('G is wired on the fleet terminal, at every key site F is');
{
  ok('the TUI imports the server rather than shelling out',
     /import \* as maps from '\.\/m59-roomserve\.mjs'/.test(TUI_CODE));
  ok('there is a handler', /async function geometryMaps\(\)/.test(TUI_CODE));
  // TWO KEY SITES, because the TUI reads keys in two places and a key added to one of them
  // works in half the states the terminal can be in.
  const gKeys = (TUI_CODE.match(/str === 'G' \|\| str === 'g'/g) ?? []).length;
  const fKeys = (TUI_CODE.match(/str === 'F' \|\| str === 'f'/g) ?? []).length;
  ok('and it is bound wherever F is bound', gKeys === fKeys && gKeys >= 2,
     `G at ${gKeys} site(s), F at ${fKeys}`);
  ok('the footer offers it', /G geometry/.test(TUI_CODE));
  ok('it ensures before it opens, like F does',
     /await maps\.start\(/.test(TUI_CODE) && /openBrowser\(url\)/.test(TUI_CODE));
  ok("and it says when the port is somebody else's",
     /this checkout did not start it/.test(TUI_CODE));
}

console.log('');
console.log('`room_num` IS THE NUMBER AND `room` IS THE NAME');
{
  // THE BUG THIS PINS, made writing the key above. The handler opens the room under the cursor
  // and the first version read `cur.room ?? cur.room_num`. A fleet row carries
  // `room: "Castle Victoria"` and `room_num: 38` — measured live — so `??` always took the
  // NAME, `Number()` made NaN, and it fell through to the index every single time. A feature
  // that looks implemented, never fires, and produces no error to notice.
  //
  // The TUI itself prints both side by side (`${r.room} [room ${r.room_num}]`), which is what
  // settled it. Same family as the memory note about naming the space in the field.
  const fn = TUI_CODE.slice(TUI_CODE.indexOf('async function geometryMaps()'),
                            TUI_CODE.indexOf('async function geometryMaps()') + 2000);
  ok('the handler reads room_num', /Number\(cur\?\.room_num/.test(fn));
  ok('and never falls back to `room`, which is a name and can only make NaN',
     !/cur\?\.room\b\s*\?\?/.test(fn));
  ok('a row with no room at all still opens the index rather than /NaN',
     /Number\.isFinite\(room\) && room > 0/.test(fn));
  // And the display line that proves the two fields are different things is still there.
  ok('the TUI still shows both fields, which is the evidence for this assertion',
     /\$\{r\.room \?\? '\?'\} \[room \$\{r\.room_num \?\? '\?'\}\]/.test(TUI));
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
