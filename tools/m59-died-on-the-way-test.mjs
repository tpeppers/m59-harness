// A DEATH ENDS THE JOURNEY. Offline, source-shape: Session.travel's own Underworld escape (leaveTheUnderworld) used to
// hand back to the loop, which re-planned to the old destination at post-death health. Scooter (t21), Ko'catan 2125,
// 2026-10-27 16:20, died on a survival_exit journey to 2115; once the rip lands an island death in the Aerie Guest
// House, that resumed journey would walk the body back into the jungle at ~7/93.
//
//   node tools/m59-died-on-the-way-test.mjs
import { readFileSync } from 'node:fs';
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log(`ok ${pass + fail} - ${n}`); } else { fail++; console.log(`FAIL ${n}`); } };
const src = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
const leave = src.slice(src.indexOf('const leaveTheUnderworld = async () =>'), src.indexOf('let escapedAfterDeath = false;'));
ok(leave.length > 0, 'leaveTheUnderworld precedes the escapedAfterDeath declaration');
ok(/if \(out\?\.left\) \{ escapedAfterDeath = true; return true; \}/.test(leave), 'a session escape marks the death');
ok(/if \(r\?\.left\) escapedAfterDeath = true;/.test(leave), 'the skills escape marks the death too');
const loopTop = src.indexOf('if (escapedAfterDeath)');
const here = src.indexOf('const here = this.world.room;', loopTop);
ok(loopTop > 0 && here > loopTop && here - loopTop < 600, 'the loop checks the death before reading the room or re-planning');
ok(/reason: 'died_on_the_way: /.test(src.slice(loopTop, here)) && /died_on_the_way: true/.test(src.slice(loopTop, here)),
   'and reports died_on_the_way instead of walking on');
ok(/arrived: false/.test(src.slice(loopTop, here)), 'never as an arrival');
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
