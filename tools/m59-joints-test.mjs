#!/usr/bin/env node
// THE JOINTS, THE RPG VOCABULARY, POSTURES AND OPERATIONS. Offline: opens no socket, joins nobody.
//
// The first section is the compatibility promise and the reason this file exists: WITH NO PAK, EVERY JOINT
// ANSWERS DEFAULT AND EVERY CALL SITE BEHAVES AS IT DID BEFORE JOINTS EXISTED. It should fail the day somebody
// makes a joint's default do something.
import { readToolSource } from './autopilot/source.mjs';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JOINTS, JointHost, validateJointDecision, evaluate, runHandler, resolvePaks, dryRun, checkPak } from './m59-joints.mjs';
import { sheetOf, effectKind } from './rpg/sheet.mjs';
import { timerOf, beat } from './rpg/timers.mjs';
import { readOurBlow, elementOf } from './rpg/damage.mjs';
import { crossingCost } from './rpg/hazards.mjs';
import { assessCreature, isAnonymous } from './rpg/suspicion.mjs';
import { doorsBetween, postsAround, assignPosts } from './rpg/doors.mjs';
import { postRequest, openRequests, claimRequest, finishRequest, board } from './rpg/requests.mjs';
import { planPosture, readBack, restoreOrders, unrestorable, selectUnits, sameValue, policyKeyOf } from './m59-posture.mjs';
import { checkOperation, decide, dryTimeline, fillRoles, transition } from './m59-operation.mjs';
import { groundEffectOnSegment, groundEffectSquares } from './m59-ground-effects.mjs';
import { combatTarget, suspectedPlayer } from './m59-combat-mode.mjs';
import { OF, PF } from './m59-parse.mjs';
import examplePak from '../substrate/paks.example/example-hazard-crossing.mjs';

let passed = 0, failed = 0;
const ok = (what, cond) => { if (cond) { passed++; console.log('  ok  ', what); } else { failed++; console.log('  FAIL', what); } };
const section = t => console.log(`\n${t}`);

// ------------------------------------------------------------------------------------------------------
section('no pak: every joint answers default');
{
  const host = new JointHost({ fleet: 'nofleet', env: { M59_PAK_FILE: '/nonexistent/paks.json', M59_PAK_DIR: '/nonexistent' } });
  await host.refresh();
  for (const j of Object.keys(JOINTS)) {
    ok(`${j}: not handled`, !host.handles(j));
    ok(`${j}: ask is null`, host.ask(j, { self: { health_pct: 10 } }) === null);
  }
  ok('status reports no paks', host.status().paks.length === 0);
}

section('the call sites are guarded by `handles`, so an absent host is the old code path');
{
  const cm = readFileSync(new URL('./m59-combat-mode.mjs', import.meta.url), 'utf8');
  const game = readFileSync(new URL('./m59-game.mjs', import.meta.url), 'utf8');
  for (const j of ['combat.blocked', 'combat.channel', 'combat.outcome', 'threat.classify'])
    ok(`combat-mode asks ${j} only after handles('${j}')`, cm.includes(`handles?.('${j}')`));
  ok('Session.hazardOptions returns {} with no movement.hazard pak', /if \(!this\.joints\?\.handles\?\.\('movement\.hazard'\)\) return \{\};/.test(game));
  ok('the combat event loop skips joints entirely with no paks', /if \(this\.s\.joints\?\.paks\?\.length\)/.test(cm));
  const ap = readToolSource(new URL('./m59-autopilot.mjs', import.meta.url), 'utf8');
  ok('upkeep.curse returns before asking with no pak', /if \(!joints\?\.handles\?\.\('upkeep\.curse'\)\) return null;/.test(ap));
}

section('ground effects: crossable only when a pak says so');
{
  const fire = { id: 9, flags: 3, name: 'wall of fire', row: 5, col: 5 };   // MOVEON_NOTIFY
  const client = { room: { objects: new Map([[9, fire]]) }, rsc: { get: () => null } };
  const from = { row: 5, col: 4 }, to = { row: 5, col: 6 };
  ok('no option: the step is blocked by the firewall', groundEffectOnSegment(client, from, to)?.kind === 'firewall');
  ok('no option: the square is avoided', groundEffectSquares(client).has('5,5'));
  ok('crossable says yes: the step passes', groundEffectOnSegment(client, from, to, { crossable: () => true }) === null);
  ok('crossable says yes: the square is not avoided', !groundEffectSquares(client, { crossable: () => true }).has('5,5'));
  ok('crossable says no: blocked as before', groundEffectOnSegment(client, from, to, { crossable: () => false })?.kind === 'firewall');
}

section('the real Session: a firewall step is refused, unless a pak answers cross');
{
  const { Session } = await import('./m59-game.mjs');
  const fire = { id: 9, flags: 3, name: 'wall of fire', row: 5, col: 5 };
  const s = Object.create(Session.prototype);
  s.client = { room: { objects: new Map([[9, fire]]) }, rsc: { get: () => null }, vitals: () => ({ health: { value: 100, max: 100, pct: 100 } }) };
  s.world = { room: { num: 38 } };
  const from = { row: 5, col: 4 }, to = { row: 5, col: 6 };
  ok('no host at all: blocked', s.groundEffectBlock(from, to)?.reason === 'ground_effect_blocked');
  s.joints = new JointHost();
  ok('a host with no paks: blocked', s.groundEffectBlock(from, to)?.reason === 'ground_effect_blocked');
  let asked = null;
  s.joints.use([{ pak: { name: 'crosser', joints: { 'movement.hazard': f => { asked = f; return f.effect.kind === 'firewall' && f.hazard.worst_hit === 16 ? { do: 'cross' } : null; } } } }]);
  s._hazardAnswers = null;
  ok('a pak answering cross: the step passes', s.groundEffectBlock(from, to) === null);
  ok('the pak saw the priced hazard and the sheet', asked?.hazard?.element === 'fire' && asked?.self?.health_pct === 100 && asked?.purpose === 'step');
}

section('validation: a closed set of answers');
{
  ok('null is default', validateJointDecision('movement.hazard', null).decision === null);
  ok('cross is accepted', validateJointDecision('movement.hazard', { do: 'cross' }).decision?.do === 'cross');
  const bad = validateJointDecision('movement.hazard', { do: 'teleport' });
  ok('an unknown verb is silence with an error', bad.decision === null && /unknown answer/.test(bad.error));
  ok('withdraw refuses a room 1', validateJointDecision('combat.blocked', { do: 'withdraw', room: 1 }).decision === null);
  ok('hold is bounded to 10s', validateJointDecision('combat.blocked', { do: 'hold', ms: 99_999 }).decision.ms === 10_000);
  ok('adjust needs a channel', validateJointDecision('combat.outcome', { do: 'adjust', weight: -5 }).decision === null);
  ok('treat_as_player has a bounded ttl', validateJointDecision('threat.classify', { do: 'treat_as_player', ttl_ms: 1 }).decision.ttl_ms === 5000);
  const also = validateJointDecision('combat.outcome', { do: 'adjust', channel: 'wand:x', weight: -1, also: [{ do: 'request', service: 'purge', target: 'X' }, { do: 'shout' }] });
  ok('also: request kept, an unknown action reported', also.decision.also.length === 1 && /unknown action/.test(also.error));
  ok('a joint that does not exist', validateJointDecision('nope', { do: 'x' }).error.includes('no joint'));
}

section('the condition language');
{
  const f = { self: { health_pct: 40, resist: { fire: 50 }, buff_names: ['bless'] }, effect: { kind: 'firewall' }, list: [1, 2] };
  ok('>=', evaluate(['self.health_pct', '>=', 40], f).pass);
  ok('== is case-insensitive for strings', evaluate(['effect.kind', '==', 'FIREWALL'], f).pass);
  ok('has on a list', evaluate(['self.buff_names', 'has', 'bless'], f).pass);
  ok('in', evaluate(['effect.kind', 'in', ['web', 'firewall']], f).pass);
  ok('missing', evaluate(['self.nothing', 'missing'], f).pass);
  ok('all fails on the first false clause and says which', (() => { const r = evaluate({ all: [['self.health_pct', '>', 10], ['self.resist.fire', '>', 60]] }, f); return !r.pass && /resist\.fire/.test(r.why); })());
  ok('any / not', evaluate({ any: [['list.0', '==', 9], { not: ['list.1', '==', 9] }] }, f).pass);
  ok('$options in a value', evaluate(['self.health_pct', '<', '$options.floor'], f, { options: { floor: 50 } }).pass);
  let threw = false; try { evaluate(['a', '~~', 1], f); } catch { threw = true; }
  ok('an unknown operator throws (and checkPak reports it)', threw);
  const r = runHandler([{ name: 'a', when: ['self.health_pct', '>', 90], then: { do: 'cross' } }, { name: 'b', then: () => null }, { name: 'c', then: { do: 'avoid' } }], f);
  ok('first match wins; a rule answering null lets the next try', r.raw.do === 'avoid' && r.trace.map(t => t.fired).join() === 'false,false,true');
}

section('the host: strikes, follow-ups, records, branches');
{
  const requests = [], records = [];
  let now = 1000;
  const host = new JointHost({ now: () => now, effects: { request: r => requests.push(r), record: r => records.push(r) } });
  host.use([
    { pak: { name: 'thrower', joints: { 'movement.hazard': () => { throw new Error('boom'); } } } },
    { pak: { name: 'promiser', joints: { 'combat.channel': async () => ({ do: 'skip', channels: ['x'] }) } } },
    { pak: { name: 'answerer', options: { t: 1 }, joints: {
      'movement.hazard': (f, ctx) => { ctx.branch('why', { kind: f.effect.kind }); return { do: 'cross', also: [{ do: 'request', service: 'purge', target: 'M' }] }; },
      'combat.channel': { name: 'never', when: () => false, then: null } } } },
  ]);
  const a = host.ask('movement.hazard', { effect: { kind: 'firewall' } });
  ok('a throwing pak is skipped and the next one answers', a?.do === 'cross' && a.pak === 'answerer');
  ok('the throw is a strike', host.paks[0].strikes === 1);
  host.ask('movement.hazard', { effect: { kind: 'firewall' } }); host.ask('movement.hazard', { effect: { kind: 'firewall' } });
  ok('three strikes stand it down', host.paks[0].strikes === 3 && host.status().paks[0].loaded === false);
  ok('a follow-up request was performed by the host', requests.length === 3 && requests[0].service === 'purge' && requests[0].pak === 'answerer');
  ok('every answer is recorded with its branch', records.length === 3 && records[0].branches[0].name === 'why');
  ok('a promise is a strike, never an answer', host.ask('combat.channel', {}) === null && host.paks[1].strikes === 1);
  ok('facts are frozen', (() => { let saw = null; const h = new JointHost(); h.use([{ pak: { name: 'p', joints: { 'movement.hazard': f => { saw = Object.isFrozen(f.effect); return null; } } } }]); h.ask('movement.hazard', { effect: { kind: 'x' } }); return saw === true; })());
  const slow = new JointHost({ now: (() => { let t = 0; return () => (t += 100); })() });
  slow.use([{ pak: { name: 'slow', joints: { 'movement.hazard': () => ({ do: 'cross' }) } } }]);
  ok('over the time budget is silence and a strike', slow.ask('movement.hazard', {}) === null && slow.paks[0].strikes === 1);
}

section('assignment: precedence, enable, disable');
{
  const book = { enabled: ['a', { pak: 'b', options: { x: 1 } }], agents: { t9: { disable: ['a'] } }, characters: { Loial: { disable: '*' }, Kermit: { enable: ['c'] } } };
  ok('fleet list in order', resolvePaks(book).map(p => p.pak).join() === 'a,b');
  ok('an agent can disable one', resolvePaks(book, { agent: 't9' }).map(p => p.pak).join() === 'b');
  ok('"*" disables all', resolvePaks(book, { character: 'loial' }).length === 0);
  ok('a character can add one after the fleet\'s', resolvePaks(book, { character: 'Kermit' }).map(p => p.pak).join() === 'a,b,c');
  ok('options travel', resolvePaks(book)[1].options.x === 1);
  ok('no book is no paks', resolvePaks(null).length === 0);
}

section('the example pak: loads, and its own scenarios pass');
{
  const { errors } = checkPak({ default: examplePak });
  ok('checkPak is clean', errors.length === 0);
  const rows = dryRun(examplePak);
  ok('every scenario passes', rows.length >= 3 && rows.every(r => r.pass === true));
  ok('the dry run carries the branch the rule recorded', rows[0].branches?.[0]?.name === 'crossing');
  ok('checkPak reports an unknown joint', checkPak({ default: { name: 'x', joints: { 'no.such': [] } } }).errors.some(e => /unknown joint/.test(e)));
}

// ------------------------------------------------------------------------------------------------------
section('rpg/sheet: a curse is not a debuff');
{
  const now = 50_000;
  const c = {
    vitals: () => ({ health: { value: 40, max: 80, pct: 50 } }),
    enchantments: () => [{ id: 1, type: 1, name: 'bless', at: 1000 }, { id: 2, type: 1, name: 'poison', at: 2000 }, { id: 3, type: 1, name: 'withstand fire', at: 3000 }],
    equipment: () => ({ known: true, equipped: [{ id: 10, name: 'cursed mace' }, { id: 11, name: 'ring of shock resistance' }], fresh_ms: 5 }),
    inventory: [{ id: 10, name: 'cursed mace' }, { id: 11, name: 'ring of shock resistance' }, { id: 12, name: 'ring of fire resistance' }],
  };
  const s = sheetOf(c, { now });
  ok('bless is a buff, poison a debuff (from the kod catalogue)', s.buff_names.includes('bless') && s.debuff_names.includes('poison'));
  ok('the curse is NOT in debuffs', !s.debuff_names.some(n => /curse/.test(n)));
  ok('the curse is its own answer, from the cursed name', s.curse.state === 'cursed' && s.curse.items.includes('cursed mace'));
  ok('the cure is cast on the PLAYER', s.curse.cure.target === 'player' && s.curse.cure.spell === 'remove curse');
  ok('withstand fire resists fire (conservative minimum 25)', s.resist.fire === 25);
  ok('a WORN shock ring resists shock 50', s.resist.shock === 50);
  ok('a fire ring in the PACK resists nothing', !s.resist_sources.fire.some(x => x.source === 'ring of fire resistance'));
  ok('ages are measured', s.buffs[0].age_ms === 49_000);
  const blank = sheetOf({ equipment: () => ({ known: false, equipped: [] }) });
  ok('nothing read yet is UNKNOWN, not none', blank.curse.state === 'unknown');
  const clean = sheetOf({ equipment: () => ({ known: true, equipped: [{ id: 1, name: 'long sword' }] }), inventory: [{ id: 1, name: 'long sword' }] });
  ok('read and clean is none_known', clean.curse.state === 'none_known');
  const heard = sheetOf({ equipment: () => ({ known: true, equipped: [] }) }, { heard: [{ text: 'The mace seems to cling to your hand!' }] });
  ok('a cling heard is a curse', heard.curse.state === 'cursed' && heard.curse.evidence[0].signal === 'clings');
  ok('suspected stays suspected', sheetOf({ equipment: () => ({ known: true, equipped: [] }) }, { curseSuspect: { name: 'mace', certain: false } }).curse.state === 'suspected');
  ok('effectKind: an unknown name is unknown, never guessed', effectKind('glorpification') === 'unknown');
}

section('rpg/timers: one shared timer, and three wands outside it');
{
  ok('melee is 1000 on the attack timer', timerOf('melee').ms === 1000 && timerOf('melee').timer === 'attack');
  ok('a lightning wand is lightning bolt\'s 2000', timerOf('wand:lightning wand').ms === 2000);
  ok('vampiric shock has no timer', timerOf('wand:wand of vampiric shock').timer === 'none');
  ok('the healing wand has no timer', timerOf('wand:wand of healing').timer === 'none');
  ok('hold is a 2 s spell', timerOf('spell:hold').ms === 2000);
  const b = beat({ now: 1000, attack_ready_at: 1500, channels: ['melee', 'wand:wand of healing'] });
  ok('mid-cooldown: the heal wand can go, melee cannot', b.free_channels.includes('wand:wand of healing') && !b.timed_ready.length);
  ok('using the heal wand does not move the next swing', b.after['wand:wand of healing'] === 1500);
}

section('rpg/damage: reading our own blow back');
{
  const j = readOurBlow('Your lightning bolt jolts Morpheus.');
  ok('jolts is a shock nick (band 1)', j.band === 1 && j.element === 'shock' && j.target === 'Morpheus' && j.with === 'lightning bolt');
  ok('fries is band 3', readOurBlow('Your lightning bolt fries Morpheus.').band === 3);
  ok('"runs through" (two words) is thrust band 4', readOurBlow('Your spear runs through the orc.').band === 4);
  ok('color codes are stripped', readOurBlow('~bYour fireball chars the orc.').element === 'fire');
  const l = readOurBlow('Morpheus laughs off your pitiful blow.');
  ok('laughs off: resisted over 60%', l.kind === 'resisted' && l.resisted === 'laughs' && l.min_resist === 61 && l.target === 'Morpheus');
  ok('shrugs off: over 20%', readOurBlow('Morpheus shrugs off your attack.').resisted === 'shrugs');
  ok('somebody else\'s line is not ours', readOurBlow('The orc hits you with its claws.') === null);
  ok('elementOf a wand', elementOf('lightning wand') === 'shock');
}

section('rpg/hazards: pricing a wall of fire');
{
  const bare = crossingCost({ kind: 'firewall' }, { health: 100 });
  ok('one square bare: worst 16, at least 1', bare.worst_hit === 16 && bare.ticks === 1);
  const ring = crossingCost({ kind: 'firewall' }, { health: 100, resist: { fire: 50 } });
  ok('with the ring: worst 8', ring.worst_hit === 8);
  ok('100% still costs 1 a tick', crossingCost({ kind: 'firewall' }, { resist: { fire: 100 } }).worst_hit === 1);
  ok('standing in it 3 s is more ticks', crossingCost({ kind: 'firewall' }, {}, { dwell_ms: 3000 }).ticks === 3);
  ok('an unpriced cloud is null', crossingCost({ kind: 'fog' }, {}) === null);
}

section('rpg/suspicion: morph and anonymity');
{
  ok('a creature with a murderer mark is near-certain', assessCreature({ flags: OF.ATTACKABLE | PF.KILLER, name: 'orc' }, {}).score >= 0.9);
  ok('a creature that spoke', assessCreature({ flags: OF.ATTACKABLE }, { name: 'troll', events: [{ kind: 'spoke', text: 'hi' }] }).suspect);
  const spawns = { rooms: { '38': [{ creature: 'skeleton', cls: 'Skeleton' }] } };
  const imp = assessCreature({ flags: OF.ATTACKABLE }, { name: 'orc', room: 38, spawns });
  ok('a creature the room cannot spawn is evidence, alone not proof', imp.spawnable_here === false && imp.score === 0.5);
  ok('a local monster is nothing', assessCreature({ flags: OF.ATTACKABLE }, { name: 'skeleton', room: 38, spawns }).score === 0);
  ok('a player is never a suspect', assessCreature({ flags: OF.PLAYER }, {}).suspect === false);
  ok('anonymous: a player with no name', isAnonymous({ flags: OF.PLAYER, name: '' }) && !isAnonymous({ flags: OF.PLAYER, name: 'Kermit' }));
}

section('combat targeting: a suspect is a player for its own id only');
{
  const orc1 = { id: 5, flags: OF.ATTACKABLE, name: 'orc' }, orc2 = { id: 6, flags: OF.ATTACKABLE, name: 'orc' };
  const anon = { id: 7, flags: OF.PLAYER | OF.ATTACKABLE, name: '' };
  const client = { selfId: 1, room: { objects: new Map([[5, orc1], [6, orc2], [7, anon]]) }, rsc: { get: () => null } };
  ok('an unmarked orc is not a player target', combatTarget(client, 'orc') === null);
  client.suspectedPlayers = new Map([[5, { id: 5, until: Date.now() + 60_000 }]]);
  ok('the marked orc is, by name, and only that one', combatTarget(client, 'orc')?.id === 5);
  ok('#id names it', combatTarget(client, '#5')?.id === 5);
  ok('#id names the anonymous player', combatTarget(client, '#7')?.id === 7);
  client.suspectedPlayers.set(5, { id: 5, until: Date.now() - 1 });
  ok('an expired mark is gone', suspectedPlayer(client, 5) === null && combatTarget(client, 'orc') === null);
}

section('opener safety net: a spell refused for karma is passed over for the rest of the fight');
{
  const { CombatMode } = await import('./m59-combat-mode.mjs');
  const rec = [];
  const fake = { active: { id: 'f' }, now: () => 1, record: e => rec.push(e), s: { world: { room: { num: 38 } } } };
  CombatMode.prototype.hear.call(fake, { kind: 'message', text: 'You are not vile enough to cast hold!' });
  ok('the refusal is recorded on the fight', fake.active.karmaRefused?.get('hold')?.kind === 'vile' && rec.includes('opener_karma_refused'));
  CombatMode.prototype.hear.call(fake, { kind: 'message', text: 'You are not worthy to cast holy touch!' });
  ok('and the Shal\'ille one', fake.active.karmaRefused?.has('holy touch'));
  const none = { active: null, now: () => 1, record: () => {}, s: { world: { room: { num: 38 } } } };
  CombatMode.prototype.hear.call(none, { kind: 'message', text: 'You are not vile enough to cast hold!' });
  ok('with no fight on, nothing is held against the next one', none.active === null);
  const cm = readFileSync(new URL('./m59-combat-mode.mjs', import.meta.url), 'utf8');
  ok('pvpOpener passes over a karma-refused cast and asks the next strategy', /if \(name && o\.karmaRefused\?\.has\(name\)\) \{[\s\S]{0,200}continue;/.test(cm));
  ok('the opener ctx carries karma and the fight', /karma: \(\(\) => \{ const k = c\.stat\?\.\('karma'\)/.test(cm) && /fight: o\.pvp\?\.decision_id/.test(cm));
}

section('rpg/doors: the doors between 38 and 39, from the map');
{
  const d = doorsBetween(38, 39);
  ok('the east stairs land on 39 r8c28 (the hand-written cv-east-stairs)', d.some(x => x.to === 39 && x.arrive.row === 8 && x.arrive.col === 28));
  ok('and the way back lands in 38', d.some(x => x.to === 38));
  const posts = postsAround(d.find(x => x.to === 39 && x.arrive.col === 28));
  ok('no post is the landing square', !posts.some(p => p.row === 8 && p.col === 28));
  const ring = assignPosts(['a', 'b', 'c'], d);
  ok('guards are dealt across doors before doubling up', new Set(ring.map(r => r.door)).size === Math.min(3, d.length));
  const front = doorsBetween(2, 38).find(x => x.to === 38);
  ok('the front door lands on 38 r15c17 (the hand-written cv-front-door)', front.arrive.row === 15 && front.arrive.col === 17);
}

section('rpg/requests: the service board');
{
  const file = join(mkdtempSync(join(tmpdir(), 'm59-req-')), 'requests.jsonl');
  const a = postRequest({ service: 'purge', target: 'Morpheus', from: 'Kermit', file, now: 1000, ttl_ms: 60_000 });
  const b = postRequest({ service: 'purge', target: 'morpheus', from: 'Piggy', file, now: 2000, ttl_ms: 60_000 });
  ok('asking again refreshes, never duplicates', b.refreshed && b.id === a.id && openRequests({ service: 'purge', file, now: 3000 }).length === 1);
  claimRequest({ id: a.id, by: 't8', file, now: 3000 });
  ok('a claim hides it from unclaimed', openRequests({ service: 'purge', file, now: 4000, unclaimed: true }).length === 0);
  const c = postRequest({ service: 'mend', target: 'Rizzo', file, now: 1000, ttl_ms: 600_000 });
  claimRequest({ id: c.id, by: 't9', file, now: 2000 });
  ok('a claim lapses after CLAIM_MS and the request is takeable again',
    openRequests({ service: 'mend', file, now: 30_000, unclaimed: true }).length === 0 &&
    openRequests({ service: 'mend', file, now: 2000 + 61_000, unclaimed: true }).length === 1);
  finishRequest({ id: a.id, by: 't8', file, now: 5000, outcome: 'cast' });
  ok('done is done', board({ file, now: 6000 })[0].state === 'done');
  postRequest({ service: 'remove curse', target: 'Gonzo', file, now: 1000, ttl_ms: 5000 });
  ok('an old request expires', openRequests({ service: 'remove curse', file, now: 10_000 }).length === 0);
}

// ------------------------------------------------------------------------------------------------------
section('postures: the save, the read-back, the restore');
{
  const posture = { name: 'p', who: { exclude: ['hk3'], min_max_health: 30 }, orders: { assigned_room: 38, town_trips: false, confine_rooms: [38] } };
  const units = [{ agent: 't1', max_health: 80 }, { agent: 't2', max_health: 20 }, { agent: 'hk3', max_health: 90 },
    { agent: 't4', max_health: 90, host: true }, { agent: 't5', max_health: 90, piloted: true }];
  ok('who: excluded, too frail, a host and a piloted character are all left alone', selectUnits(posture, units).map(u => u.agent).join() === 't1');
  const plan = planPosture(posture, units, { t1: { assignedRoom: 599, townTrips: true } });
  ok('the before is what the keeper had; an unreported key is marked absent', plan[0].before.assigned_room === 599 && plan[0].before.confine_rooms.absent);
  ok('release restores what was there', JSON.stringify(restoreOrders(plan[0].before)) === JSON.stringify({ assigned_room: 599, town_trips: true }));
  ok('and NAMES what it cannot restore, rather than sending null', unrestorable(plan[0].before).join() === 'confine_rooms');
  ok('read-back: all taken is no misses', readBack(posture, plan[0].orders, { assignedRoom: 38, townTrips: false, confineRooms: [38] }).length === 0);
  ok('read-back: a dropped key is named', readBack(posture, plan[0].orders, { assignedRoom: 38, townTrips: true, confineRooms: [38] })[0].key === 'town_trips');
  ok('[] and null are both none', sameValue([], null) && !sameValue([38], null));
  ok('the broker\'s own key convention', policyKeyOf('pvp_return_delay_ms') === 'pvpReturnDelayMs');
}

section('operations: phases, expectations that can be wrong, roles');
{
  const op = JSON.parse(readFileSync(new URL('../substrate/operations.example/example-door-ambush.json', import.meta.url), 'utf8'));
  ok('the example is valid', checkOperation(op).length === 0);
  ok('quiet: the waiting phase', decide(op, { enemy: { seen: false } }).phase === 'waiting');
  const arrive = decide(op, { enemy: { seen: true, engaged_with: 0, standing_ms: 0 } });
  ok('he arrives: expect a run for the door, melee heads him off', arrive.phase === 'fight' && arrive.orders.melee.go === 'doors' && arrive.expectations[0].standing === 'anticipated');
  const slug = decide(op, { enemy: { seen: true, engaged_with: 1, standing_ms: 5000 } });
  ok('he stops to fight: the expectation is invalidated and melee assists', slug.expectations[0].standing === 'invalidated' && slug.orders.melee.assist);
  ok('a timeline reports each change', dryTimeline(op, op.timeline).filter(r => r.changed).length === 3);
  const roles = fillRoles(op, [{ agent: 't1', channels: ['bow'] }, { agent: 't2', channels: ['melee'] }, { agent: 't3', channels: ['melee'] }]);
  ok('roles fill in order; archers take the bowman', roles.roles.archers.join() === 't1' && roles.roles.melee.join() === 't2,t3');
  ok('a short role is reported', fillRoles(op, [{ agent: 't1', channels: ['bow'] }]).short.some(s => s.role === 'melee'));
  ok('approval states: proposed -> approved -> running', transition(transition(op, 'approve'), 'start').state === 'running');
  let threw = false; try { transition(op, 'start'); } catch { threw = true; }
  ok('a proposed plan cannot start without approval', threw);
  ok('a bad role in a phase is named', checkOperation({ ...op, phases: [{ name: 'x', posts: { wizards: { zone: 'doors' } } }] }).some(e => /unknown role/.test(e)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
