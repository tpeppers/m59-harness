// node tools/m59-practicebow-test.mjs — offline. The decisions of tools/fleetscripts/practice-bow.mjs
// (tools/m59-practicebow.mjs), the Mend desk service it relies on (tools/m59-chalice.mjs), and the
// compiled step list.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.M59_CHALICE_DIR = mkdtempSync(join(tmpdir(), 'pbow-chalice-'));
process.env.M59_FLEET = 'pbowtest';

const pb = await import('./m59-practicebow.mjs');
const { deskMenu, parseDeskRequest, normalizeChalice, chaliceStoreFor } = await import('./m59-chalice.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = t => console.log(`\n${t}`);

section('which skills are goals');
{
  const both = pb.bowSkillState([{ name: 'fire', ability: 40 }, { name: 'archery', ability: 12 }, { name: 'dodge', ability: 99 }]);
  ok('both held, both training', both.training.join() === 'fire,archery' && !both.done);
  const fireOnly = pb.bowSkillState([{ name: 'fire', ability: 99 }]);
  ok('fire 99 without archery is DONE — archery is not a goal it lacks', fireOnly.done && !fireOnly.none);
  const zero = pb.bowSkillState([{ name: 'fire', ability: 99 }, { name: 'archery', ability: 0 }]);
  ok('archery at 0 counts as not held', zero.done && !('archery' in zero.held));
  const half = pb.bowSkillState([{ name: 'fire', ability: 99 }, { name: 'archery', ability: 50 }]);
  ok('fire done, archery 50 keeps going on archery', !half.done && half.training.join() === 'archery');
  const unread = pb.bowSkillState([{ name: 'fire', ability: null }, { name: 'archery', ability: 99 }]);
  ok('a listed skill with no number is held, unknown, and never done', !unread.done && unread.unknown.join() === 'fire' && unread.training.join() === 'fire');
  ok('neither held is "none"', pb.bowSkillState([{ name: 'slash', ability: 30 }]).none);
  ok('skills=fire ignores archery', pb.bowSkillState([{ name: 'fire', ability: 99 }, { name: 'archery', ability: 10 }], { only: ['fire'] }).done);
}

section('the advancement window');
{
  const now = 10_000_000;
  const recent = Array.from({ length: 10 }, (_, i) => ({ name: 'fire', by: 1, at: now - (20 - i) * 60_000 }));
  const g = pb.gainsInWindow(recent, now);
  ok('10 points inside 22 minutes is capped', g.capped && g.points === 10);
  ok('it resumes 22 minutes after the oldest', g.resumeAt === now - 20 * 60_000 + 22 * 60_000);
  ok('losses are not gains', !pb.gainsInWindow([...recent.slice(0, 9), { by: -2, at: now }], now).capped);
  ok('old gains fall out', !pb.gainsInWindow(recent.map(h => ({ ...h, at: h.at - 3 * 60_000 })), now).capped);
}

section('reading the bow');
{
  const d = s => pb.bowBand(`The practice bow${s}`);
  ok('flawless is top', d(' is in flawless condition.') === 'top');
  ok('repaired before is top', d(' is in excellent condition, but has been repaired before.') === 'top');
  ok('slightly worn is good', d(' is slightly worn but in generally good condition.') === 'good');
  ok('crack and fray is med', d(' is starting to crack and fray but is still effective.') === 'med');
  ok('well worn is poor', d(' is well worn and may not last much longer.') === 'poor');
  ok('broken is broken', d(' is broken and in pieces.') === 'broken');
  ok('unknown text is null, never a band', pb.bowBand('A bow.') === null);
  ok('poor is at or below poor', pb.bandAtOrBelow('poor', 'poor') && !pb.bandAtOrBelow('med', 'poor'));
  ok('med mends at mend_at=med', pb.bandAtOrBelow('med', 'med'));
  const items = [{ id: 5, name: 'long bow' }, { id: 7, name: 'practice bow' }, { id: 9, name: 'arrows', amount: 30 },
                 { id: 10, name: 'nerudite arrows', amount: 5 }, { id: 11, name: 'short sword' }];
  ok('the practice bow is found, not the long bow', pb.findBow(items).id === 7);
  ok('no practice bow is no bow', pb.findBow(items.filter(i => i.id !== 7)) === null);
  ok('bow=long bow finds it', pb.findBow(items, 'long bow').id === 5);
  ok('arrows of every kind are counted', pb.arrowCount(items) === 35);
  ok('a melee weapon is found for the arrow fight', pb.findMelee(items).id === 11);
  ok('retire a bow that wore out in 50 shots', pb.shouldRetire(50, 80) && !pb.shouldRetire(500, 80) && !pb.shouldRetire(50, 0));
}

section('what to shoot');
{
  const best = pb.loadBestiary();
  ok('battered skeleton is level 60', best.get('battered skeleton')?.level === 60);
  ok('tusked skeleton is level 100', best.get('tusked skeleton')?.level === 100);
  ok('zombie is level 55', best.get('zombie')?.level === 55);
  const throne = [{ id: 1, name: 'zombie', distance: 2 }, { id: 2, name: 'tusked skeleton', distance: 9 }];
  ok('fire 58: the zombie (55) teaches nothing, the tusked skeleton does',
     pb.pickTarget(throne, best, { fire: 58 }).target?.name === 'tusked skeleton');
  ok('fire 40: the weaker zombie is enough', pb.pickTarget(throne, best, { fire: 40 }).target?.name === 'zombie');
  const upstairs = [{ id: 3, name: 'battered skeleton' }, { id: 4, name: 'zombie' }];
  const capped = pb.pickTarget(upstairs, best, { fire: 60 });
  ok('fire 60 upstairs: the room cannot teach, and says what is strongest', !capped.target && /battered skeleton \(level 60\)/.test(capped.why));
  ok('fire 59 upstairs still has a target', pb.pickTarget(upstairs, best, { fire: 59 }).target?.name === 'battered skeleton');
  ok('both skills: a target above BOTH first', pb.pickTarget(throne, best, { fire: 70, archery: 30 }).target?.name === 'tusked skeleton');
  ok('both skills: one above the lower only, when nothing teaches both',
     pb.pickTarget(upstairs, best, { fire: 70, archery: 30 }).teaches === 'some');
  const tids = pb.arrowTreasures();
  ok('arrow treasures are the six from treasure.json', ['TID_SKELETON2', 'TID_SKELETON3', 'TID_SKELETON4', 'TID_BLACK_SPIDER', 'TID_AVAR_CHIEF', 'TID_ORC_CHIEF'].every(t => tids.has(t)));
  ok('arrow droppers upstairs: the battered skeleton, not the zombie',
     pb.arrowDroppersIn(upstairs, best, tids).map(m => m.name).join() === 'battered skeleton');
  const look = { objects: [{ id: 1, name: 'zombie', can: ['look', 'attack'] }, { id: 2, name: 'Loial', is_player: true, can: ['attack'] },
                           { id: 3, name: 'arrows', can: ['get'] }] };
  ok('monsters are attackable non-players', pb.monstersIn(look).map(m => m.name).join() === 'zombie');
}

section('the Mend desk');
{
  const cfg = normalizeChalice({ holder: 'Loial', station_room: 2 });
  ok('mend is on by default', cfg.mend === true);
  const noSpell = deskMenu({ cfg, have: { sapphire: 5, 'orc tooth': 5 } });
  ok('a server that never learned Mend does not list it', !noSpell.some(m => m.kind === 'mend'));
  const short = deskMenu({ cfg, have: { sapphire: 0, 'orc tooth': 5 }, knows: { mend: true } });
  ok('no sapphire: listed, unavailable', short.find(m => m.kind === 'mend')?.ok === false);
  const kept = deskMenu({ cfg, have: { sapphire: 1, 'orc tooth': 3 }, floor: { 'orc tooth': 3 }, knows: { mend: true } });
  ok('teeth held back for the reserve are not spare', kept.find(m => m.kind === 'mend')?.ok === false);
  const ready = deskMenu({ cfg, have: { sapphire: 1, 'orc tooth': 1 }, knows: { mend: true } });
  ok('one of each: available', ready.find(m => m.kind === 'mend')?.ok === true);
  ok('mend=false hides it', !deskMenu({ cfg: normalizeChalice({ holder: 'L', mend: false }), have: { sapphire: 1, 'orc tooth': 1 }, knows: { mend: true } }).some(m => m.kind === 'mend'));
  ok('a person may ask for "mend" or "repair"', parseDeskRequest('mend')?.kind === 'mend' && parseDeskRequest('Repair!')?.kind === 'mend');
  ok('"mend my bow later" is chat', parseDeskRequest('mend my bow later') === null);

  const now = Date.now();
  const desks = { loial: { server: 'Loial', room: 2, at: now, menu: ready },
                  rizzo: { server: 'Rizzo', room: 2, at: now, menu: short } };
  ok('the desk that can mend now is picked', pb.pickMendDesk(desks, null, { now }).desk?.name === 'Loial');
  ok('a named desk that cannot says why', /cannot now/.test(pb.pickMendDesk(desks, 'Rizzo', { now }).why));
  ok('a stale desk is nobody', pb.pickMendDesk({ loial: { ...desks.loial, at: now - 3600_000 } }, null, { now }).desk === null);

  const store = chaliceStoreFor({ fleet: 'pbowtest' });
  const t = store.request('Archer', { room: 2, kind: 'mend', items: [{ id: 77, name: 'practice bow' }] });
  const claimed = store.claimNext('Loial', { kind: 'mend' });
  ok('a keeper-filed mend ticket can be claimed (not human-only)', claimed?.id === t.id && claimed.items[0].id === 77);
  ok('the archer cannot claim its own', store.claimNext('Archer', { kind: 'mend' }) === null);
  store.mark(t.id, 'done', { note: 'mend cast on 1 of 1', mended: 1 });
  ok('the requester reads mended back off the ticket', store.ticket(t.id)?.mended === 1);
}

section('the compiled plan');
{
  const { script } = await import('./fleetscripts/practice-bow.mjs');
  const p = { agent: 'a1', agents: ['a1'], room: 39, desk_room: 2, skills: 'fire,archery', bow: 'practice bow', mend_at: 'poor',
              arrows_min: 15, arrows_to: 80, burst: 20, reach: 10, abort_below: 0.5, retire_swings: 80,
              mend_wait_s: 600, hours: 24, cycles: 3 };
  const steps = await script.steps(p);
  const kinds = steps.map(s => s.do === 'verify' ? (s.label ?? 'verify') : `walk:${typeof s.to === 'function' ? 'fn' : s.to}`);
  ok('plan, walk to the practice room, then train/desk/mend/back per cycle',
     kinds.join(' ') === 'plan walk:39 train 1 walk:fn mend 1 walk:39 train 2 walk:fn mend 2 walk:39 train 3 walk:fn mend 3 walk:39', kinds.join(' '));
  const dyn = steps.find(s => s.do === 'walk' && typeof s.to === 'function');
  ok('the dynamic walk names both rooms as candidates', dyn.candidates.join() === '39,2');
  ok('it goes to the desk only when due', dyn.to({ pb: { needMend: true } }) === 2 && dyn.to({ pb: { needMend: false } }) === 39 && dyn.to({}) === 39);
  ok('a finished archer never walks to the desk', dyn.to({ pb: { needMend: true, done: true } }) === 39);
  const same = await script.steps({ ...p, desk_room: 39 });
  ok('desk in the practice room: no walks between', same.filter(s => s.do === 'walk').length === 1);
  const noDesk = await script.steps({ ...p, desk_room: null });
  ok('no desk known: train steps only (the mend band then stops the run with the reason)',
     noDesk.filter(s => s.do === 'walk').length === 1 && noDesk.filter(s => s.label?.startsWith('mend')).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
