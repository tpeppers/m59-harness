#!/usr/bin/env node
// Offline. Reads source only; spawns nothing, opens no socket, touches no roster.
//
//   node tools/m59-nowindow-test.mjs
//
// A FLEET TOOL MUST NEVER POP A CONSOLE WINDOW ON THE OPERATOR'S DESKTOP.
//
// The broker runs detached with `stdio: 'ignore'`, so it has NO CONSOLE. On Windows a console
// program spawned by a parent with no console does not inherit one — it gets a brand new
// window. `windowsHide: true` (CREATE_NO_WINDOW) is the only thing that stops it, and Node's
// default is false.
//
// So every `execFileSync('powershell', ...)` anywhere under the broker or a keeper flashes a
// window, and the fleet does this per character. The operator's report, 2026-09-17: *"something
// like 23 powershell windows get opened, maybe a 0.5-2s delay between them, so I just experience
// like a 15-30s delay of my desktop being relatively unusable (they pull focus, kicking me out
// of games or away from being able to type)"* — a keeper storm, every restart, and the fleet
// restarts about fourteen times a day.
//
// MEASURED rather than assumed: a detached console-less node process running three unhidden
// `powershell` children took the machine's conhost count 63 -> 65; the same children with
// `windowsHide: true` left it at 63. That is the whole mechanism.
//
// WHY THIS IS A TEST AND NOT A FIXED BUG. It was fixed at fifty call sites across twenty-nine
// files, and the fifty-first is one `execFileSync` away — the keeper spawn had carried the
// right option, with a comment explaining it, since the first time a full fleet buried the
// desktop, and the habit still did not spread. A rule you have to remember is a rule you
// forget, so this refuses the next one instead.
//
// `windowsHide` is inert where a console IS inherited, so setting it costs nothing and is
// never the wrong answer for a fleet tool. The one case where a window genuinely helps —
// watching a single keeper's log scroll live — keeps its named escape hatch,
// `M59_KEEPER_WINDOWS=1`, which is why the assertion accepts any expression rather than
// demanding the literal `true`.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = join(dirname(fileURLToPath(import.meta.url)));
let n = 0;
const ok = (c, why) => { n++; assert.ok(c, why); };

// Anything that starts a PROGRAM. A bare `exec(...)` on some local helper is not one of these,
// which is why the call text has to name an executable or `process.execPath`.
const CALL = /\b(execFileSync|spawnSync|execFile|spawn|execSync|exec)\s*\(/g;
const LAUNCHES = /(process\.execPath|['"`](powershell|pwsh|cmd|cmd\.exe|node|npm|git|docker|tar|ssh)['"`.])/;

// The last top-level argument, when it is an object literal. Walks the call tracking depth,
// strings and comments, because a regex cannot tell `{` in a string from `{` in an options
// object and would report the wrong span on half of these.
export function optionsSpan(s, openParen) {
  let depth = 0, i = openParen, inStr = null, esc = false, argStart = null;
  while (i < s.length) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === inStr) inStr = null;
      i++; continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; i++; continue; }
    if (ch === '/' && s[i + 1] === '/') { const j = s.indexOf('\n', i); i = j < 0 ? s.length : j; continue; }
    if (ch === '/' && s[i + 1] === '*') { const j = s.indexOf('*/', i); i = j < 0 ? s.length : j + 2; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; if (depth === 1 && ch === '(') argStart = i + 1; i++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) {
        const arg = s.slice(argStart, i);
        const trimmed = arg.replace(/^\s+/, '');
        return trimmed.startsWith('{') ? [argStart + (arg.length - trimmed.length), i] : null;
      }
      i++; continue;
    }
    if (ch === ',' && depth === 1) { argStart = i + 1; i++; continue; }
    i++;
  }
  return null;
}

const offenders = [];
let checked = 0;
for (const f of readdirSync(TOOLS).filter(x => x.endsWith('.mjs') && !x.endsWith('-test.mjs'))) {
  const s = readFileSync(join(TOOLS, f), 'utf8');
  CALL.lastIndex = 0;
  let m;
  while ((m = CALL.exec(s))) {
    const open = s.indexOf('(', m.index);
    const span = optionsSpan(s, open);
    // No options object at all is not reported: those are overwhelmingly `exec(x)` helpers,
    // and a launcher with no options is rare enough to catch by eye. This pins the shape that
    // actually recurs — an options object somebody wrote and left this out of.
    if (!span) continue;
    const call = s.slice(m.index, span[1]);
    if (!LAUNCHES.test(call)) continue;
    checked++;
    if (/windowsHide/.test(s.slice(span[0], span[1]))) continue;
    offenders.push(`${f}:${s.slice(0, m.index).split('\n').length}  ${m[1]}`);
  }
}

ok(checked > 30, `the scanner found only ${checked} program launches, which means it stopped `
   + 'matching rather than that the tools stopped spawning — a guard that checks nothing passes');
ok(offenders.length === 0,
   'every program a fleet tool launches must pass windowsHide, or a console-less parent (the '
   + 'detached broker) gives it a new window on the operator\'s desktop:\n  '
   + offenders.join('\n  '));

// The keeper's named escape hatch is the reason this accepts an expression rather than `true`.
{
  const broker = readFileSync(join(TOOLS, 'm59-broker.mjs'), 'utf8');
  ok(/windowsHide:\s*process\.env\.M59_KEEPER_WINDOWS\s*!==\s*'1'/.test(broker),
     'M59_KEEPER_WINDOWS=1 must still bring a keeper\'s window back — watching one keeper\'s '
     + 'log scroll live is a genuinely good way to debug it, and it was the DEFAULT that was '
     + 'wrong, never the option');
}

console.log(`m59-nowindow-test: ${n} assertions passed (${checked} program launches checked)`);
