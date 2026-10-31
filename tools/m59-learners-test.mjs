#!/usr/bin/env node
// m59-learners-test.mjs — offline. Who can learn a spell OR a skill, and the pace estimate.
//
// Pins: a skill resolves to kind 'skills' and is answered (archery said "no catalogue row" when the
// tool hardcoded spells); a spell still works through the old m59-spell-learners name; the replay
// of `have` counts only the best three (a gain in the fourth-best moves nothing); a full book cuts
// the window to its oldest row; no gain is no ETA rather than infinity or zero.
import { standing, trend, kindOf, abilitiesAt, plannerCatalogue } from './m59-learners.mjs';
import * as shim from './m59-spell-learners.mjs';
import { learningConstants } from './m59-loadout.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };

const catalogue = plannerCatalogue(), constants = learningConstants();
const H = 3600_000, now = 1_800_000_000_000;
const gonzo = { skills: [
  { name: 'fire', ability: 44 }, { name: 'parry', ability: 99 }, { name: 'second wind', ability: 60 },
  { name: 'slash', ability: 99 }, { name: 'dodge', ability: 99 }, { name: 'block', ability: 99 } ], spells: [] };

ok(kindOf(catalogue, 'archery') === 'skills', 'archery is a skill');
ok(kindOf(catalogue, 'Enchant Weapon') === 'spells', 'enchant weapon is a spell, case-insensitively');
ok(kindOf(catalogue, 'no such thing') === null, 'unknown name has no kind');

const a = standing({ abilities: gonzo, intellect: 15, name: 'archery', catalogue, constants });
ok(a.kind === 'skills' && a.why === null, `archery answered as a skill: ${JSON.stringify(a)}`);
ok(a.have === 203, `have = 99 + 60 + 44, got ${a.have}`);
ok(a.short === Math.max(0, a.need - a.have) && a.can === (a.have >= a.need), 'short is need - have');
ok(/fire 44/.test(a.below) && /second wind 60/.test(a.below), `below names the three: ${a.below}`);

const s = shim.standing({ abilities: { spells: [{ name: 'create food', ability: 80 }], skills: [] },
                          intellect: 20, spell: 'enchant weapon', catalogue, constants });
ok(s.kind === 'spells' && s.why === null && s.have === 80, `old shim, old 'spell' argument: ${JSON.stringify(s)}`);

// Fire 34 -> 44 over the last ten hours: have 193 -> 203, one point an hour.
const hist = Array.from({ length: 10 }, (_, i) =>
  ({ kind: 'skill', name: 'fire', from: 34 + i, to: 35 + i, by: 1, at: now - (9.5 - i) * H }));
const back = abilitiesAt(gonzo, hist, now - 24 * H);
ok(back.skills.find(x => x.name === 'fire').ability === 34, 'replay rewinds fire to 34');
ok(back.skills.find(x => x.name === 'parry').ability === 99, 'replay leaves parry alone');
const t = trend({ abilities: gonzo, intellect: 15, name: 'archery', catalogue, constants, history: hist,
                  now, windowMs: 10 * H, margin: 16 });
ok(t.have_then === 193 && Math.abs(t.rate - 1) < 1e-9, `rate 1/h, got have_then ${t.have_then} rate ${t.rate}`);
ok(t.can ? t.eta === 0 : Math.abs(t.eta - t.short) < 1e-9, `eta = short / rate: ${t.eta} vs ${t.short}`);
ok(Math.abs(t.eta_margin - (t.need + 16 - t.have)) < 1e-9, 'eta+margin = (need + margin - have) / rate');

// A gain in a fourth-best weaponcraft-4 ability (scimitar 10 -> 20) moves nothing.
const withScim = { ...gonzo, skills: [...gonzo.skills, { name: 'scimitar wielding', ability: 20 }] };
const scim = Array.from({ length: 10 }, (_, i) =>
  ({ kind: 'skill', name: 'scimitar wielding', by: 1, at: now - (9 - i) * H }));
const t4 = trend({ abilities: withScim, intellect: 15, name: 'archery', catalogue, constants, history: scim, now, windowMs: 24 * H });
ok(t4.rate === 0 && t4.eta === null || t4.can, `fourth-best gains are no pace: rate ${t4.rate} eta ${t4.eta}`);

// A full book cuts the window to its oldest row.
const full = trend({ abilities: gonzo, intellect: 15, name: 'archery', catalogue, constants, history: hist,
                     now, windowMs: 24 * H, maxHistory: 10 });
ok(full.truncated && Math.abs(full.hours - 9.5) < 1e-6 && full.have_then === 193, `truncated window: ${full.hours}h`);
const notFull = trend({ abilities: gonzo, intellect: 15, name: 'archery', catalogue, constants, history: hist,
                        now, windowMs: 24 * H, maxHistory: 400 });
ok(!notFull.truncated && notFull.hours === 24, 'a book that is not full keeps the whole window');

// Atrophy reads as a negative rate and no ETA.
const decay = [{ kind: 'skill', name: 'fire', by: -2, at: now - H }];
const d = trend({ abilities: gonzo, intellect: 15, name: 'archery', catalogue, constants, history: decay, now, windowMs: 4 * H });
ok(d.rate < 0 && (d.eta === null || d.can), `decay: rate ${d.rate} eta ${d.eta}`);

// Known is known; no pace asked.
const k = trend({ abilities: { ...gonzo, skills: [...gonzo.skills, { name: 'archery', ability: 1 }] }, intellect: 15,
                  name: 'archery', catalogue, constants, history: hist, now });
ok(k.known && k.eta === null, 'already known');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
