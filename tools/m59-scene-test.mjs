#!/usr/bin/env node
// A SCENE: WHAT IT MAY CLAIM, AND THE ORDER IT REBUILDS IN. Offline: no server, no DM socket,
// no broker. Every plan here is computed and printed, never sent.
//
//   node tools/m59-scene-test.mjs
//
// Three things this pins, all of which are the difference between a reproduction and a story:
//
//   1. AN ESTIMATE STAYS AN ESTIMATE. A monster's hit points are never on the wire; what we have
//      is an inference. Saving it is the point, and losing the fact that it IS one is how a
//      guess gets promoted to a measurement by the act of being written to disk.
//   2. THE SCENE COMES UP HELD, AND THE HOLD IS FIRST. A monster already acting while you place
//      the other eleven is not a reconstruction.
//   3. PUBLISHING DROPS SECRETS AND PINS CODE. A scene nobody else can check out is a
//      screenshot, and one with account material in it is worse than a screenshot.
import { makeScene, loadPlan, releasePlan, sceneConfidence, formatConfidence,
         scrubScene, publishBlockers, sceneProvenance,
         observed, estimated, unknownField, field,
         HOLD_MSG, RELEASE_MSG, SCENE_SCHEMA, assertLab,
         captureRoom, classify, executeLoad, executeRelease, sceneRunner,
         loadPlan as planOf } from './m59-scene.mjs';

const NL = String.fromCharCode(10);
let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};

const scene = () => makeScene({
  name: 'feast-hall',
  capturedFrom: 'prod',
  provenance: { harness: { root: '/h', commit: 'aaaa111', dirty: false },
                server:  { root: '/s', commit: 'bbbb222', dirty: false },
                dumbot:  { root: '/d', commit: 'cccc333', dirty: false } },
  room: { num: 40, name: observed("The Duke's Feast Hall") },
  actors: [
    { kind: 'player', name: 'Kermit', object: 7124,
      at: observed({ row: 12, col: 18 }),
      vitals: { hp: observed({ value: 44, max: 44 }), mana: observed({ value: 20, max: 25 }) },
      stats: observed({ might: 30 }) },
    { kind: 'monster', name: 'ghost of Far\u2019Nohl', object: 7605,
      at: observed({ row: 14, col: 20 }),
      // THE WHOLE POINT: never on the wire, inferred from watching it take damage.
      vitals: { hp: estimated({ value: 233, max: 233 }), mana: unknownField() } },
    { kind: 'item', name: 'oak table', object: 7700, at: observed({ row: 13, col: 19 }) },
  ],
});

console.log('\na scene is well formed, and refuses to be made without its identity');
{
  const s = scene();
  ok('it carries the schema', s.schema === SCENE_SCHEMA);
  ok('it records where it came from', s.captured.from === 'prod' && !!s.captured.at);
  ok('a capture may only claim "recorded"', s.certification.tier === 'recorded');
  ok('and claims no reality until one can be set', s.certification.reality === null);
  const threw = f => { try { f(); return null; } catch (e) { return e.message; } };
  ok('a scene with no name is refused', /needs a name/.test(threw(() => makeScene({ room: { num: 1 } }))));
  ok('a scene with no room is refused', /needs a room/.test(threw(() => makeScene({ name: 'x' }))));
}

console.log('\n1. AN ESTIMATE STAYS AN ESTIMATE');
{
  const c = sceneConfidence(scene());
  ok('observed fields are counted', c.observed === 7, String(c.observed));
  ok('the estimated hit points are counted separately', c.estimated === 1, String(c.estimated));
  ok('and the unreadable mana is neither', c.unknown === 1, String(c.unknown));
  const text = formatConfidence(c);
  ok('the render says how much is inference', /1 value\(s\) are OUR INFERENCE/.test(text), text);
  ok('and says why that matters for a rebuild',
     /never on the wire/.test(text) && /only as good as/.test(text));

  // The plan must carry the flag through to the operator, not just the file.
  const step = loadPlan(scene()).find(s => /health for ghost/.test(s.why));
  ok('the load plan marks an estimated health command', step?.estimated === true, JSON.stringify(step));
  ok('and says so in the human line', /\(ESTIMATED\)/.test(step?.why ?? ''), step?.why);

  const clean = formatConfidence(sceneConfidence(makeScene({
    name: 'n', room: { num: 1, name: observed('x') }, actors: [] })));
  ok('a scene with nothing inferred says so instead', /every captured field was read/.test(clean));
}

console.log('\n2. THE SCENE COMES UP HELD, AND EVERY HOLD PRECEDES EVERY PLACEMENT');
{
  const steps = loadPlan(scene());
  const holds = steps.map((s, i) => ({ i, s })).filter(x => x.s.cmd.includes(HOLD_MSG));
  const moves = steps.map((s, i) => ({ i, s })).filter(x => /^place /.test(x.s.why));
  ok('every animate actor is held', holds.length === 2, String(holds.length));
  ok('the item is NOT held — it has no clocks to stop',
     !holds.some(h => /table/.test(h.s.actor)));
  ok('EVERY hold comes before EVERY placement',
     Math.max(...holds.map(h => h.i)) < Math.min(...moves.map(m => m.i)),
     `last hold ${Math.max(...holds.map(h => h.i))}, first move ${Math.min(...moves.map(m => m.i))}`);
  ok('the item is still placed', moves.some(m => /table/.test(m.s.actor)));
  ok('the hold is the real kod message', holds[0].s.cmd.includes('ClearBasicTimers'));

  const running = loadPlan(scene(), { pause: false });
  ok('pause:false holds nothing', !running.some(s => s.cmd.includes(HOLD_MSG)));
  ok('but still places everybody', running.filter(s => /^place /.test(s.why)).length === 3);

  const rel = releasePlan(scene());
  ok('release is a separate plan', rel.length === 2 && rel.every(s => s.cmd.includes(RELEASE_MSG)));
  ok('and it does not release the furniture', !rel.some(s => /table/.test(s.actor)));
}

console.log('\nthe plan is PURE — computing it sends nothing and needs no server');
{
  // If this ever opens a socket the test suite stops being offline, which is the property that
  // makes it runnable at all. Asserted by the plan being a plain array of strings.
  const steps = loadPlan(scene());
  ok('every step is a command string', steps.every(s => typeof s.cmd === 'string'));
  ok('every step says which actor it is for', steps.every(s => typeof s.actor === 'string'));
  ok('and why', steps.every(s => typeof s.why === 'string' && s.why.length > 3));
}

console.log('\n3. PUBLISHING DROPS SECRETS, ALIASES NAMES, AND DEMANDS PINNED CODE');
{
  const dirty = makeScene({
    name: 'leaky', room: { num: 40 },
    provenance: { harness: { root: '/h', commit: 'aaaa111', dirty: true },
                  server: { root: '/s', commit: null, dirty: null, why: 'not a git checkout' } },
    actors: [{ kind: 'player', name: 'Kermit', object: 1,
               credentials: { account: 'tp-01', password: 'hunter2' },
               at: observed({ row: 1, col: 1 }) }],
  });

  const out = scrubScene(dirty);
  const json = JSON.stringify(out);
  ok('the password is GONE, not masked', !/hunter2/.test(json) && !/password/.test(json), json);
  // Asserted against the ACTOR, not the whole document: the scrubbed file keeps an audit note
  // naming the key patterns it dropped, and that note necessarily contains the words. A scrub
  // that could not say what it removed would be worse than one whose receipt mentions "account".
  const actorJson = JSON.stringify(out.actors);
  ok('the account key is gone too',
     !/tp-01/.test(actorJson) && !/account/.test(actorJson), actorJson);
  ok('the whole credentials block went, not just its leaves',
     !/credential/.test(actorJson), actorJson);
  ok('but the receipt still names what was dropped',
     /account/.test(out.published.dropped_keys));
  ok('the character name is aliased', !/Kermit/.test(json) && /actor1/.test(json), json);
  ok('and the scene says it was scrubbed and how', out.published?.names === 'aliased');
  ok('--keep-names keeps them', /Kermit/.test(JSON.stringify(scrubScene(dirty, { keepNames: true }))));

  const blockers = publishBlockers(dirty);
  ok('a DIRTY tree blocks publication',
     blockers.some(b => /harness was captured from a DIRTY/.test(b)), JSON.stringify(blockers));
  ok('an unpinned repository blocks publication',
     blockers.some(b => /server has no pinned commit/.test(b)));
  ok('a fully pinned clean scene has no blockers',
     publishBlockers(scene()).length === 0, JSON.stringify(publishBlockers(scene())));
}

console.log('\nprovenance pins three repositories and says when it cannot');
{
  const p = sceneProvenance({ serverRoot: 'Z:/nope', dumbotRoot: null });
  ok('the harness resolves to a real commit', typeof p.harness.commit === 'string');
  ok('a missing server checkout is reported, not guessed',
     p.server.commit === null && /not found/.test(p.server.why), JSON.stringify(p.server));
  ok('a missing dumbot is reported the same way', p.dumbot.commit === null);
  ok('and dirtiness is recorded rather than ignored', 'dirty' in p.harness);
}

console.log('\na rebuild refuses to point anywhere but a lab');
{
  const threw = (env) => { try { assertLab(env); return null; } catch (e) { return e.message; } };
  ok('loopback is allowed', threw({ M59_ADMIN_HOST: '127.0.0.1' }) === null);
  ok('localhost is allowed', threw({ M59_ADMIN_HOST: 'localhost' }) === null);
  const why = threw({ M59_ADMIN_HOST: '10.0.0.7' });
  ok('anything else is refused', !!why);
  ok('and the refusal explains that a rebuild is fiat, not play',
     /by fiat/.test(why) && /incident/.test(why), why);
}

console.log('\nTHE READER: what a client can actually see');
{
  // A real `look` payload, in the shape keeperView -> renderProjection produces
  // (m59-render-projection.mjs:88-110). Note what is NOT in it: no hit points on anything, no
  // `kind`, and exits that keeperView returns as [] unconditionally.
  const LOOK = {
    room: { num: 40, name: "The Duke's Feast Hall" },
    you: { col: 18, row: 12 },
    exits: [],
    objects: [
      { id: 7605, name: 'ghost of Far\u2019Nohl', col: 20, row: 14, distance: 2,
        facing: 'north', can: ['attack', 'look'], is_player: false },
      { id: 7124, name: 'Kermit', col: 19, row: 12, distance: 1,
        can: ['look'], is_player: true },
      { id: 7700, name: 'oak table', col: 19, row: 13, distance: 1,
        can: ['look'], is_player: false },
      { id: 7701, name: 'shilling', col: 21, row: 13, distance: 3,
        can: ['look'], is_player: false, amount: 240 },
    ],
  };
  const reads = [];
  const read = async (tool, args) => {
    reads.push(tool);
    if (tool === 'look') return LOOK;
    if (tool === 'status') return { name: 'Pepe', hp: { value: 40, max: 44 },
                                    mana: { value: 12, max: 25 }, vigor: { value: 150, max: 200 } };
    if (tool === 'inventory') return { items: [{ name: 'short sword' }] };
    if (tool === 'equipment') return { weapon: 'short sword' };
    throw new Error(`unexpected tool ${tool}`);
  };

  const sc = await captureRoom({ agent: 't2', read, name: 'feast', capturedFrom: 'prod',
                                 ours: ['Kermit'],
                                 provenance: { harness: { commit: 'a', dirty: false } } });

  ok('it read the room from look', sc.room.num === 40);
  ok('and the room name is observed', sc.room.name.how === 'observed');
  ok('it captured every object plus the looking character', sc.actors.length === 5,
     String(sc.actors.length));

  const by = n => sc.actors.find(a => a.name === n);
  ok('the looking character is read DEEPLY', by('Pepe').vitals.hp.how === 'observed');
  ok('with inventory and equipment', by('Pepe').inventory.how === 'observed' &&
     by('Pepe').equipment.how === 'observed');
  ok('and is marked as ours', by('Pepe').mine === true);

  // THE CLASSIFICATION IS AN INFERENCE AND IS MARKED AS ONE.
  ok('an attackable non-player is a monster', by('ghost of Far\u2019Nohl').kind === 'monster');
  ok('a player is a player', by('Kermit').kind === 'player');
  ok('a non-attackable object is an item', by('oak table').kind === 'item');
  ok('and the classification records that it was INFERRED',
     by('oak table').kind_source.how === 'estimated', JSON.stringify(by('oak table').kind_source));

  // THE HEADLINE: no hit points on the wire.
  ok('a monster has NO hit points, because none were sent',
     by('ghost of Far\u2019Nohl').vitals.hp.how === 'unknown');
  ok('an item is not given vitals at all', by('oak table').vitals === undefined);
  ok('another player in the room is shallow — position only',
     by('Kermit').vitals.hp.how === 'unknown' && by('Kermit').at.how === 'observed');
  ok('but one of ours is flagged so a deeper read could be added', by('Kermit').mine === true);
  ok('a stack keeps its amount', by('shilling').amount.v === 240);

  // EXITS ARE REFUSED, NOT CAPTURED.
  ok('exits are not captured at all', !('exits' in sc));
  ok('and the scene says why in its notes',
     sc.notes.some(n => /exits are NOT captured/.test(n)), JSON.stringify(sc.notes));
  ok('object ids are recorded as a breadcrumb', by('Kermit').object_at_capture === 7124);
  ok('and the notes say they are not a key',
     sc.notes.some(n => /not a key/.test(n)));

  ok('it made exactly the four reads it needed',
     reads.join(',') === 'look,status,inventory,equipment', reads.join(','));

  // The confidence counter is what makes the shallowness visible instead of silent.
  const c = sceneConfidence(sc);
  ok('and the unknowns are counted rather than hidden', c.unknown > 0 && c.observed > 0,
     JSON.stringify(c));
}

console.log('\nthe HP estimate is a HOOK, and it defaults to unknown rather than to a number');
{
  const LOOK = { room: { num: 40 }, you: { col: 1, row: 1 },
                 objects: [{ id: 1, name: 'ghost', col: 2, row: 2, can: ['attack'], is_player: false }] };
  const read = async (t) => t === 'look' ? LOOK : (t === 'status' ? { name: 'me' } : null);

  const none = await captureRoom({ agent: 't1', read });
  ok('with no estimator the monster hp is unknown',
     none.actors[1].vitals.hp.how === 'unknown');

  const withEst = await captureRoom({ agent: 't1', read,
    hpEstimate: async (name) => (name === 'ghost' ? { value: 233, max: 233 } : null) });
  ok('with one it is recorded as ESTIMATED, never observed',
     withEst.actors[1].vitals.hp.how === 'estimated', JSON.stringify(withEst.actors[1].vitals.hp));
  ok('and the value comes through', withEst.actors[1].vitals.hp.v.value === 233);

  const thrower = await captureRoom({ agent: 't1', read,
    hpEstimate: async () => { throw new Error('telemetry is down'); } });
  ok('an estimator that throws yields unknown, not a crash',
     thrower.actors[1].vitals.hp.how === 'unknown');
}

console.log('\nthe reader refuses rather than guessing');
{
  const threw = async (f) => { try { await f(); return null; } catch (e) { return e.message; } };
  ok('no agent is refused', /needs an agent/.test(await threw(() => captureRoom({ read: async () => ({}) }))));
  ok('no read function is refused', /needs a read/.test(await threw(() => captureRoom({ agent: 't1' }))));
  ok('and a look that cannot name the room is refused, not defaulted to 0',
     /could not tell what room/.test(await threw(() =>
       captureRoom({ agent: 't1', read: async () => ({ objects: [] }) }))));
}

console.log('\nclassify is the whole monster/furniture distinction, and it is affordance-based');
{
  ok('attackable -> monster', classify({ can: ['attack', 'look'] }) === 'monster');
  ok('is_player wins over affordances', classify({ is_player: true, can: ['attack'] }) === 'player');
  ok('no affordances at all -> item', classify({}) === 'item');
  ok('look-only -> item', classify({ can: ['look'] }) === 'item');
}

console.log(NL + 'THE EXECUTOR RESOLVES NAMES AGAIN, AND NEVER ADDRESSES A CAPTURED ID');
{
  // A scene an hour old carries ids the server has since renumbered. The executor must resolve
  // the NAMES it recorded and address those; object_at_capture is a breadcrumb only.
  const sc = makeScene({
    name: 'x', room: { num: 40 },
    provenance: { harness: { commit: 'a', dirty: false } },
    actors: [
      { kind: 'player', name: 'Kermit', object_at_capture: 7124, at: observed({ row: 1, col: 2 }) },
      { kind: 'monster', name: 'ghost', object_at_capture: 7605, at: observed({ row: 3, col: 4 }),
        vitals: { hp: estimated({ value: 233, max: 233 }) } },
    ],
  });
  const sent = [];
  // A fake DM socket: `show name X` resolves, everything else is recorded and accepted.
  // ECHOES EACH COMMAND, because m59-dm's split() locates a reply by finding the command text
  // in the stream. A fake that returned bare replies parses as "nothing was found for anybody".
  const reply = (c) => {
    const n = /^show name (.+)$/.exec(c);
    if (n) return n[1] === 'Kermit' ? 'object 9001 Kermit'
         : n[1] === 'ghost' ? 'object 9002 ghost' : 'not found';
    if (/^show room 40$/.test(c)) return 'object 9040 The Feast Hall';
    return 'ok';
  };
  const dmFn = async (cmds) => {
    sent.push(...cmds);
    return cmds.map(c => `${c}${NL}${reply(c)}`).join(NL);
  };
  const r = await executeLoad(sc, { dmFn, env: { M59_ADMIN_HOST: '127.0.0.1' } });

  ok('it sent commands', r.sent > 0, JSON.stringify(r));
  const body = sent.filter(c => !/^show /.test(c)).join(' | ');
  ok('THE CAPTURED IDS NEVER APPEAR', !/7124|7605/.test(body), body);
  ok('the resolved ids do', /9001/.test(body) && /9002/.test(body), body);
  // Three COMMANDS, not three estimates: healthCmds emits several for one value. The count is of
  // commands built from an estimated field, which is what the operator is being warned about.
  ok('and it counted the estimated commands so the operator sees them',
     r.estimatedCommands === 3, String(r.estimatedCommands));
  ok('every one of them is a health command for the ghost',
     sent.filter(c => !/^show /.test(c)).filter(c => /9002/.test(c)).length >= 3);

  // Every hold still precedes every placement, now through real ids.
  const holdAt = body.indexOf('ClearBasicTimers');
  const moveAt = body.indexOf('9040');
  ok('the holds are still first, now through resolved ids',
     holdAt >= 0 && moveAt > holdAt, `hold@${holdAt} move@${moveAt} :: ${body.slice(0, 160)}`);
}

console.log(NL + 'A SCENE HALF-REBUILT IS WORSE THAN ONE NOT REBUILT');
{
  const sc = makeScene({ name: 'x', room: { num: 40 },
    provenance: { harness: { commit: 'a', dirty: false } },
    actors: [{ kind: 'player', name: 'Kermit', at: observed({ row: 1, col: 2 }) },
             { kind: 'monster', name: 'a ghost long gone', at: observed({ row: 3, col: 4 }) }] });
  const sent = [];
  const dmFn = async (cmds) => {
    sent.push(...cmds);
    return cmds.map(c => `${c}${NL}` +
      (/^show name Kermit$/.test(c) ? 'object 9001 Kermit' : 'not found')).join(NL);
  };
  const r = await executeLoad(sc, { dmFn, env: { M59_ADMIN_HOST: '127.0.0.1' } });
  ok('it refuses when an actor is missing', r.ok === false);
  ok('it names which', r.missing.includes('a ghost long gone'), JSON.stringify(r.missing));
  ok('and says why a partial rebuild is the worse outcome',
     /looks like the whole/.test(r.why), r.why);
  ok('NOTHING BUT THE RESOLVE WAS SENT', sent.every(c => /^show /.test(c)), sent.join(' | '));
}

console.log(NL + 'the executor refuses off a lab, before it resolves anything');
{
  const sc = makeScene({ name: 'x', room: { num: 40 },
    provenance: { harness: { commit: 'a', dirty: false } },
    actors: [{ kind: 'player', name: 'K', at: observed({ row: 1, col: 1 }) }] });
  let called = 0;
  const dmFn = async () => { called++; return 'ok'; };
  let why = null;
  try { await executeLoad(sc, { dmFn, env: { M59_ADMIN_HOST: '10.0.0.7' } }); }
  catch (e) { why = e.message; }
  ok('it throws', !!why);
  ok('and the DM socket was never touched', called === 0);
  ok('the refusal explains a rebuild is fiat', /by fiat/.test(why), why);
}

console.log(NL + 'release is its own verb and skips whoever is gone');
{
  const sc = makeScene({ name: 'x', room: { num: 40 },
    provenance: { harness: { commit: 'a', dirty: false } },
    actors: [{ kind: 'monster', name: 'ghost', at: observed({ row: 1, col: 1 }) },
             { kind: 'monster', name: 'vanished', at: observed({ row: 2, col: 2 }) },
             { kind: 'item', name: 'table', at: observed({ row: 3, col: 3 }) }] });
  const sent = [];
  const dmFn = async (cmds) => {
    sent.push(...cmds);
    return cmds.map(c => `${c}${NL}` +
      (/^show name ghost$/.test(c) ? 'object 9002 ghost' : 'not found')).join(NL);
  };
  const r = await executeRelease(sc, { dmFn, env: { M59_ADMIN_HOST: '127.0.0.1' } });
  ok('it releases the one it found', r.sent === 1, JSON.stringify(r));
  ok('it reports who was skipped', r.skipped.includes('vanished'));
  const body = sent.filter(c => !/^show /.test(c)).join(' | ');
  ok('with the real message', /StartBasicTimers/.test(body), body);
  ok('and it does not release the furniture', !/table/.test(body));
}

console.log(NL + 'sceneRunner is what reach() hands declarative strategies to');
{
  const runner = sceneRunner({ env: { M59_ADMIN_HOST: '127.0.0.1' },
                               spawn: async (tool, args) => ({ code: 0, out: `${tool} ${args.join(' ')} ok` }) });
  const shadow = await runner('shadow', 'dress');
  ok('shadow spawns m59-shadow.mjs', /m59-shadow\.mjs dress ok/.test(shadow.out), shadow.out);

  const failing = sceneRunner({ env: { M59_ADMIN_HOST: '127.0.0.1' },
                                spawn: async () => ({ code: 2, out: 'dress failed: no snapshot' }) });
  let why = null;
  try { await failing('shadow', 'dress'); } catch (e) { why = e.message; }
  ok('a non-zero exit is an error, not a silent pass', !!why);
  ok('and it carries the tail of what the tool said', /no snapshot/.test(why), why);

  let unknown = null;
  try { await runner('played', 'x'); } catch (e) { unknown = e.message; }
  ok('it refuses a strategy it does not carry out', /does not carry out "played"/.test(unknown), unknown);

  let offLab = null;
  try { await sceneRunner({ env: { M59_ADMIN_HOST: '10.0.0.7' } })('shadow', 'dress'); }
  catch (e) { offLab = e.message; }
  ok('and shadow refuses off a lab too', /refusing to load a scene/.test(offLab), offLab);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
