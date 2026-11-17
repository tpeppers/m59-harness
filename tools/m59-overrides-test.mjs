// OFFLINE: m59-overrides.mjs -- the operator override that `m59-jobs cancel --agents` sets and liveStart refuses on.
// Pins: an override expires on its own clock; a body not named is untouched; an absent file is no override; a file that will
// not parse THROWS (liveStart refuses on it, rather than reading it as "nobody held"); clear lifts only what it names; the
// refusal names the body, who set it and how to lift it; and liveStart actually consults it before anything else.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { overridesPath, readOverrides, activeOverrides, overridden, overrideRefusal, setOverrides, clearOverrides, DEFAULT_HOLD_MIN } from './m59-overrides.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else { fail++; console.log(`FAIL ${name} ${detail}`); } };

const dir = mkdtempSync(join(tmpdir(), 'm59-overrides-'));
const p = overridesPath(dir, 'prod');
ok('path is per fleet', p.endsWith('overrides-prod.json'));
let threw = false; try { overridesPath(dir, '../x'); } catch { threw = true; }
ok('a fleet name with a path in it is refused', threw);

ok('absent file is no override', Object.keys(readOverrides(p)).length === 0);

const t0 = 1_800_000_000_000;
setOverrides(p, ['t11', 't13'], { minutes: 15, by: 'test', why: 'doomed chain', now: t0 });
ok('both held right after', overridden(readOverrides(p), ['t11', 't13', 't2'], t0 + 1000).map(o => o.agent).join() === 't11,t13');
ok('a body not named is untouched', overridden(readOverrides(p), ['t2'], t0 + 1000).length === 0);
ok('still held at 14 min', overridden(readOverrides(p), ['t11'], t0 + 14 * 60000).length === 1);
ok('expired at 15 min', overridden(readOverrides(p), ['t11'], t0 + 15 * 60000).length === 0);
ok('default hold is 15 min', DEFAULT_HOLD_MIN === 15);

const r = overrideRefusal(overridden(readOverrides(p), ['t11'], t0 + 60000)[0], t0 + 60000);
ok('refusal names the body', /t11 is under an operator override/.test(r), r);
ok('refusal says who and why', /set by test: doomed chain/.test(r), r);
ok('refusal says how to lift it', /override clear --agents t11/.test(r), r);
ok('refusal counts the minutes left', /14 more min/.test(r), r);

const cleared = clearOverrides(p, ['t11'], { now: t0 + 2000 });
ok('clear lifts what it names', cleared.join() === 't11' && overridden(readOverrides(p), ['t11'], t0 + 3000).length === 0);
ok('clear leaves the rest', overridden(readOverrides(p), ['t13'], t0 + 3000).length === 1);

setOverrides(p, ['t5'], { minutes: 1, now: t0 + 20 * 60000 });
ok('expired entries are pruned on write', !('t13' in readOverrides(p)) && 't5' in readOverrides(p));
ok('activeOverrides filters by clock', Object.keys(activeOverrides(readOverrides(p), t0 + 22 * 60000)).length === 0);

writeFileSync(p, '{ not json');
threw = false; try { readOverrides(p); } catch { threw = true; }
ok('a file that will not parse throws (is not "nobody held")', threw);

// liveStart consults it FIRST, from this checkout's substrate, and refuses when it cannot be read.
const src = readFileSync(fileURLToPath(new URL('./m59-fleetscript.mjs', import.meta.url)), 'utf8');
const gate = src.slice(src.indexOf('async function liveStartGate('));
ok('liveStart reads the override before the board', gate.indexOf('readOverrides(overridesPath(') > 0 &&
   gate.indexOf('readOverrides(overridesPath(') < gate.indexOf('let verdict = await boardCheck();'));
ok('liveStart refuses an unreadable override file', /the override file could not be read/.test(gate));
const jobs = readFileSync(fileURLToPath(new URL('./m59-jobs.mjs', import.meta.url)), 'utf8');
ok('cancel --agents releases the lease and the trade, then holds', /action: 'free'/.test(jobs) && /action: 'cancel'/.test(jobs) && /setOverrides\(OVERRIDES\(\)/.test(jobs));

console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
