// THE CONTRACT TEST FOR A FILE WHOSE WHOLE JOB IS TO BE EDITED IN A HURRY.
//
// `m59-tuning.mjs` exists because the operator reversed the player-defence decision three
// times in two hours and two of those reversals were shipped by editing the keeper and
// restarting a broker holding twenty-one irreplaceable sessions. A config surface built for
// that moment is one somebody edits at speed, under pressure, and sometimes wrongly - so
// every assertion here is about what happens when the edit is WRONG, because a tuning file
// that silently does nothing is indistinguishable from one that worked.
//
// Runs entirely against scratch files. It never reads the real substrate/tuning.json, which
// a live operator may be editing while this runs.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTuning, tuningFor, setTuning, unsetTuning, TUNABLES } from './m59-tuning.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log(`  ok   ${name}`)) : (fail++, console.log(`  FAIL ${name}`)); };
const group = n => console.log(`\n${n}`);
const has = (arr, re) => (arr || []).some(p => re.test(`${p.where} ${p.why}`));

const dir = mkdtempSync(join(tmpdir(), 'm59-tuning-'));
let n = 0;
const write = (obj) => { const f = join(dir, `t${++n}.json`);
  writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };
const missing = join(dir, 'does-not-exist.json');

group('property 1 - silence means the profile, never an empty policy');
ok('an absent file yields no overrides', Object.keys(tuningFor({ file: missing }).overrides).length === 0);
ok('and says so rather than pretending it read something', /no tuning file/.test(loadTuning(missing).why));
ok('an empty object yields no overrides',
   Object.keys(tuningFor({ file: write({}) }).overrides).length === 0);
ok('empty blocks yield no overrides',
   Object.keys(tuningFor({ file: write({ defaults: {}, profiles: {}, characters: {} }) }).overrides).length === 0);

group('property 2 - a file that will not parse is NOT an empty file');
const broken = write('{ "defaults": { "flee_below": 0.5 ');
ok('it yields no overrides', Object.keys(tuningFor({ file: broken }).overrides).length === 0);
ok('and it is LOUD about keeping the profile', /KEEPING THE PROFILE/.test(loadTuning(broken).why));
ok('and the problem names the file', has(tuningFor({ file: broken }).problems, /not valid JSON/));
ok('it does not throw', (() => { try { tuningFor({ file: broken }); return true; } catch { return false; } })());

group('property 3 - an unusable value keeps the profile, it does not unset it');
const pct = write({ defaults: { flee_below: 60 } });          // somebody typed a percentage
ok('flee_below 60 is refused, not applied as 6000%', tuningFor({ file: pct }).overrides.flee_below === undefined);
ok('and it is reported', has(tuningFor({ file: pct }).problems, /unusable value/));
ok('and the report says the profile is kept', has(tuningFor({ file: pct }).problems, /not unsetting/));
ok('a string where a boolean belongs is refused',
   tuningFor({ file: write({ defaults: { defend_chase: 'yes' } }) }).overrides.defend_chase === undefined);
ok('a negative pull_within is refused',
   tuningFor({ file: write({ defaults: { pull_within: -5 } }) }).overrides.pull_within === undefined);
ok('a weapon_priority holding a number is refused whole',
   tuningFor({ file: write({ defaults: { weapon_priority: ['mace', 7] } }) }).overrides.weapon_priority === undefined);
ok('flee_below 0 is refused - a threshold of zero is never what anybody means',
   tuningFor({ file: write({ defaults: { flee_below: 0 } }) }).overrides.flee_below === undefined);
ok('but flee_below 1 is fine', tuningFor({ file: write({ defaults: { flee_below: 1 } }) }).overrides.flee_below === 1);

group('property 4 - an unrecognised key is reported, never applied and never dropped');
const typo = write({ defaults: { defend_chace: true, flee_below: 0.5 } });
ok('the typo does not become a setting', tuningFor({ file: typo }).overrides.defend_chace === undefined);
ok('it is named', has(tuningFor({ file: typo }).problems, /defend_chace/));
ok('the known list is offered', has(tuningFor({ file: typo }).problems, /defend_chase/));
ok('and the GOOD key beside it still applies - one typo does not void the file',
   tuningFor({ file: typo }).overrides.flee_below === 0.5);

group('layering - least specific first, so a character beats a profile beats a default');
const layered = write({
  defaults:   { flee_below: 0.5, defend_chase: true },
  profiles:   { town_safe_farming: { flee_below: 0.6 } },
  characters: { Camilla: { flee_below: 0.7 } },
});
ok('defaults alone', tuningFor({ file: layered }).overrides.flee_below === 0.5);
ok('a profile beats the default',
   tuningFor({ file: layered, profile: 'town_safe_farming' }).overrides.flee_below === 0.6);
ok('a character beats the profile',
   tuningFor({ file: layered, profile: 'town_safe_farming', character: 'Camilla' }).overrides.flee_below === 0.7);
ok('an untouched key still comes from defaults',
   tuningFor({ file: layered, character: 'Camilla' }).overrides.defend_chase === true);
ok('the source of each value is reported, so an operator can see WHICH line won',
   tuningFor({ file: layered, character: 'Camilla' }).sources.flee_below === 'characters.Camilla');
ok('a character nobody wrote a line for gets the defaults',
   tuningFor({ file: layered, character: 'Nobody' }).overrides.flee_below === 0.5);

group('writing - validated BEFORE the write, so a refusal changes nothing');
const wf = write({});
ok('a good set lands', setTuning({ key: 'defend_chase', value: false, file: wf }).ok);
ok('and is readable straight back', tuningFor({ file: wf }).overrides.defend_chase === false);
ok('an unknown key is refused', !setTuning({ key: 'nonsense', value: 1, file: wf }).ok);
ok('an unusable value is refused', !setTuning({ key: 'flee_below', value: 60, file: wf }).ok);
ok('and the refusals left the good value alone', tuningFor({ file: wf }).overrides.defend_chase === false);
ok('a per-character set goes to its own bucket',
   setTuning({ key: 'weapon_priority', value: ['mace'], character: 'Camilla', file: wf }).where === 'characters.Camilla');
ok('and does not leak into the defaults', tuningFor({ file: wf }).overrides.weapon_priority === undefined);
ok('but is seen for that character',
   (tuningFor({ file: wf, character: 'Camilla' }).overrides.weapon_priority || [])[0] === 'mace');
ok('unset removes it', unsetTuning({ key: 'weapon_priority', character: 'Camilla', file: wf }).ok);
ok('and it is gone', tuningFor({ file: wf, character: 'Camilla' }).overrides.weapon_priority === undefined);
ok('writing over an unparseable file is REFUSED rather than clobbering it',
   !setTuning({ key: 'defend_chase', value: true, file: broken }).ok);

group('the surface itself');
ok('defend_chase is a tunable - the setting whose absence caused this file', !!TUNABLES.defend_chase);
ok('defend_against_players is a tunable', !!TUNABLES.defend_against_players);
ok('every tunable explains itself, for the human or agent about to flip it',
   Object.values(TUNABLES).every(s => typeof s.why === 'string' && s.why.length > 20));
ok('every tunable can refuse a value', Object.values(TUNABLES).every(s => typeof s.check === 'function'));
ok('flee_below warns that it is a FLOOR and can be inert',
   /floor|inert|Math\.max/i.test(TUNABLES.flee_below.why));
ok('fight_above_vigor says the explicit value overrides keeper defaults',
   /explicit|overrides/i.test(TUNABLES.fight_above_vigor.why));

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
