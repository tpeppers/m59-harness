// NO TOWN TRIP WHILE A HEALING SESSION IS OPEN. Offline: a temp dir for the session files, no socket.
//
//   node tools/m59-heal-before-trip-test.mjs
//
// 2026-10-27 09:03Z: Beaker played dead once (08:58), came back at 68/80, and a bank trip walked him across 2115 at
// its cap of twelve avars, unarmed, with the session's one logoff already spent. The operator's rule is one play-dead
// "per healing session on a single safe spot until healed full", so the trip opener (shopping.mjs bankRun) waits for the
// session to close. Pins: the gate is in bankRun ahead of every opener, and readSession answers open/closed the way
// the gate needs.
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { readSession, noteLogoff, closeIfHealed, SESSION_MIN_MS } from './m59-healing-session.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log(`  FAIL ${name}`); } };

const dir = fs.mkdtempSync(join(os.tmpdir(), 'm59-heal-trip-'));
const t0 = Date.now();
ok(readSession('t6', { dir, now: t0 }) === null, 'no session: trips may open');
noteLogoff('t6', { why: 'logging off rather than dying', room: 2115, dir, now: t0 });
ok(!!readSession('t6', { dir, now: t0 + 1000 }), 'after a logoff the session is open: trips wait');
ok(!!closeIfHealed('t6', { hp: 68, max: 80, dir, now: t0 + SESSION_MIN_MS + 1000 }), 'hurt (68/80) past the minimum: still open');
ok(!!closeIfHealed('t6', { hp: 80, max: 80, dir, now: t0 + 1000 }), 'full health inside the minimum: still open');
ok(closeIfHealed('t6', { hp: 80, max: 80, dir, now: t0 + SESSION_MIN_MS + 1000 }) === null, 'full health past the minimum: closed');
ok(readSession('t6', { dir, now: t0 + SESSION_MIN_MS + 2000 }) === null, 'closed: trips may open again');
fs.rmSync(dir, { recursive: true, force: true });

const src = fs.readFileSync(new URL('./autopilot/shopping.mjs', import.meta.url), 'utf8');
const body = src.slice(src.indexOf('async bankRun()'));
const gate = body.indexOf("if (readSession(String(this.s?.name ?? ''))) return false;");
ok(gate > 0, 'bankRun gates on readSession');
ok(gate > 0 && gate < body.indexOf('this.operatorTripRequest'), 'the gate runs before an asked-for trip opens');
ok(gate > 0 && gate < body.indexOf('openTownTrip') || body.indexOf('openTownTrip') < 0, 'the gate runs before any trip opens');

console.log(`m59-heal-before-trip-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
