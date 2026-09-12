#!/usr/bin/env node
// THE SCRATCHPAD, AND THE THREE THINGS IT MUST NEVER GET WRONG. Offline: no broker, no socket,
// no fleet. Writes pads into a temp directory and points loadPads at them.
//
//   node tools/m59-fleetscratch-test.mjs
//
// The three:
//
//   1. A PAD IS INVISIBLE TO EVERYTHING THAT RUNS ERRANDS BY NAME. It is the strongest of the
//      three mechanisms keeping a half-written pad away from a keeper, and it is a property of
//      where the files are — so it is the one most easily lost by a later convenience.
//   2. UNKNOWN IS NOT UNMET. An absent cache and a character that genuinely lacks the ability are
//      the same silence from here, and scoring the first as the second produces confident wrong
//      answers. (An earlier version of this note said the books cover "4 of 37 characters" --
//      wrong, from the wrong roster file; it is 21 of 22 on this machine. The mechanism is the
//      argument, not the count. See m59-padcheck.mjs.)
//   3. A MISSPELLED ABILITY IS REFUSED AT LOAD. It cannot be allowed to evaluate, because it
//      evaluates to false for everyone — the same failure as a skill named "short sword"
//      instead of "short sword fighting", which reported 0 of 21 and looked like a result.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPads } from './m59-fleetscratch.mjs';
import { preflight, formatPreflight, checkDeclaredAbilities,
         observedFor, characterFor, knows, knowsAny, MET, UNKNOWN,
         ACT_HAZARDS, actHazards, formatActHazards, unknownBecause,
         parseFindOutput, hitsAmong, consultCorpus, formatConsults,
         declarationsOf, LAB_REQUIREMENT,
         worldReader, WORLD_READ, brokerReachingSteps, formatBrokerReach,
         assertShape, fieldOf, READ_SHAPES, MISPLACED_FIELDS, PROXY_DROPS,
         tally, formatTally,
         handle, isHandle, usableHandle, bumpEpoch, currentEpoch,
         LEDGER_TRUST, tagRow, joinable, killerIsMeaningful } from './m59-padcheck.mjs';
import { loadFleetScripts } from './m59-fleetlib.mjs';

const NL = String.fromCharCode(10);
let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};

const root = mkdtempSync(join(tmpdir(), 'm59-scratch-'));
const padDir = join(root, 'pads');
mkdirSync(padDir);
const pads = () => loadPads({ dir: padDir });

// An observer the test controls, so nothing here depends on which ability books happen to be on
// this machine. Same injection the rest of this repository uses for `fleetScript` and drivers.
const fakeObserver = (books) => (agent) => {
  const entry = books[agent];
  if (!entry) return { agent, character: null, known: null, readAt: null };
  return { agent, character: entry.character, readAt: '2026-09-11',
           known: entry.known === null ? null
                : new Map(entry.known.map(n => [n.toLowerCase(), { group: 'spells', value: 1 }])) };
};

const padSrc = (body) => `export const script = ${body};\n`;

console.log('\na pad loads, and is NOT visible to the fleetscript loader');
writeFileSync(join(padDir, 'probe.mjs'),
  padSrc("{ name: 'probe', describe: 'a pad', async steps() { return [{ do: 'walk', to: 39 }]; } }"));
{
  const { pads: found, problems } = await pads();
  ok('loadPads finds it', found.has('probe'));
  ok('and reports no problem', problems.length === 0, JSON.stringify(problems));
  ok('its source is "pad", not public or local', found.get('probe').source === 'pad');
  // THE ISOLATION. loadFleetScripts with its DEFAULTS must not see the pad dir at all, which is
  // what makes a pad unreachable from the fleet REPL, a keeper, a DUM bot or cron.
  const { scripts } = await loadFleetScripts();
  ok('the default fleetscript loader cannot see it', !scripts.has('probe'));
  ok('and it did not accidentally widen to the pad directory',
     ![...scripts.values()].some(s => String(s.file).includes('fleetscratch')));
}

console.log('\nthe three verdicts, and only an unmet REQUIREMENT refuses');
{
  const pad = {
    requires: [{ what: 'knows bless', check: knows('bless') }],
    capabilities: [{ what: 'knows enchant weapon', check: knows('enchant weapon') }],
    suggests: [{ what: 'an escort', check: () => null }],
  };
  const observer = fakeObserver({
    t1: { character: 'Able', known: ['bless', 'enchant weapon'] },
    t2: { character: 'Baker', known: ['bless'] },
    t3: { character: 'Charlie', known: [] },
    t4: { character: 'Delta', known: null },          // no book at all
  });
  const rows = preflight(pad, ['t1', 't2', 't3', 't4'], { observer });
  const row = (a, what) => rows.find(r => r.agent === a && r.what === what);

  ok('a met requirement is met', row('t1', 'knows bless').verdict === 'met');
  ok('and does not refuse', row('t1', 'knows bless').refuse === false);
  ok('an unmet requirement is unmet', row('t3', 'knows bless').verdict === 'unmet');
  ok('AND IT REFUSES', row('t3', 'knows bless').refuse === true);
  ok('and the refusal says which character and what', /Charlie/.test(row('t3', 'knows bless').why),
     row('t3', 'knows bless').why);

  ok('an unmet CAPABILITY is reported', row('t2', 'knows enchant weapon').verdict === 'unmet');
  ok('and does NOT refuse — the pad routes around it',
     row('t2', 'knows enchant weapon').refuse === false);

  ok('a suggestion never refuses', row('t1', 'an escort').refuse === false);

  // 2. UNKNOWN IS NOT UNMET.
  ok('a character with no book is UNKNOWN, not unmet', row('t4', 'knows bless').verdict === 'unknown');
  ok('AND UNKNOWN DOES NOT REFUSE', row('t4', 'knows bless').refuse === false);
  ok('and it says why it could not answer',
     /no ability book for Delta/.test(row('t4', 'knows bless').why ?? ''),
     row('t4', 'knows bless').why);
}

console.log('\na handle that is not in the roster is unknown, never "knows nothing"');
{
  const pad = { requires: [{ what: 'knows bless', check: knows('bless') }] };
  const rows = preflight(pad, ['not-a-handle'], { observer: fakeObserver({}) });
  ok('the verdict is unknown', rows[0].verdict === 'unknown');
  ok('it does not refuse', rows[0].refuse === false);
  ok('and the reason names the roster, not the character',
     /not in this fleet's roster/.test(rows[0].why), rows[0].why);
  // NAME THE FILE. "not in this fleet's roster" and "not in the roster THIS CHECKOUT reads" are
  // the same sentence about two very different facts — the Marco Polo session hit exactly that,
  // and the same confusion cost this machine a prod outage via keeper-bands.json the same day.
  const named = preflight({ requires: [{ what: 'x', check: knows('bless') }] }, ['nobody'],
    { observer: (a) => ({ agent: a, character: null, known: null,
                          rosterPath: 'C:/somewhere/prod.json', rosterSize: 23 }) });
  ok('when the observer knows the path, the reason names it',
     /C:\/somewhere\/prod\.json/.test(named[0].why), named[0].why);
  ok('with how many handles it held', /\(23 handles\)/.test(named[0].why));
  ok('and it says the fleet may be running from another',
     /not necessarily the one the fleet is running from/.test(named[0].why));
  ok('and names the override', /M59_STATE_FILE/.test(named[0].why));
  const missing = preflight({ requires: [{ what: 'x', check: knows('bless') }] }, ['nobody'],
    { observer: (a) => ({ agent: a, character: null, known: null,
                          rosterPath: 'C:/gone.json', rosterWhy: 'does not exist' }) });
  ok('a roster file that is absent says so rather than blaming the handle',
     /C:\/gone\.json\) does not exist/.test(missing[0].why), missing[0].why);
  // The live observer, against a handle this machine certainly does not have.
  ok('characterFor returns null for an unknown handle',
     characterFor('zz-not-a-handle') === null);
  const obs = observedFor('zz-not-a-handle');
  ok('and observedFor reports no character rather than an empty book',
     obs.character === null && obs.known === null);
}

console.log('\na check that throws is UNKNOWN — it told us nothing about the character');
{
  const pad = { requires: [{ what: 'explodes', check: () => { throw new Error('boom'); } }] };
  const rows = preflight(pad, ['t1'], { observer: fakeObserver({ t1: { character: 'Able', known: [] } }) });
  ok('the verdict is unknown, not unmet', rows[0].verdict === 'unknown');
  ok('so it does not refuse an errand on the strength of a bug',
     rows[0].refuse === false);
  ok('and the error is carried through', /boom/.test(rows[0].why ?? ''), rows[0].why);
}

console.log('\nknowsAny is satisfied by any one of them');
{
  const check = knowsAny(['minor heal', 'bless']);
  ok('one of two is enough',
     check(fakeObserver({ a: { character: 'A', known: ['bless'] } })('a')) === MET);
  ok('neither is unmet',
     typeof check(fakeObserver({ a: { character: 'A', known: ['punch'] } })('a')) === 'string');
  // A BARE null WAS THE BUG. The helpers now return a typed unknown carrying the reason, because
  // the check is the only code that knows why it could not answer -- see unknownBecause.
  {
    const r = check(fakeObserver({ a: { character: 'A', known: null } })('a'));
    ok('no book is unknown', r !== MET && typeof r !== 'string' && r !== undefined);
    ok('and it says the book is what is missing', /no ability book for A/.test(r.__padcheckUnknown));
    ok('and its cause is the one the summary can act on', r.__padcheckCause === 'no-book');
  }
  ok('and the unmet message lists what it wanted',
     /minor heal, bless/.test(check(fakeObserver({ a: { character: 'A', known: [] } })('a'))));
}

console.log('\n3. A MISSPELLED ABILITY IS REFUSED AT LOAD, not evaluated against everybody');
{
  ok('a real spell name passes',
     checkDeclaredAbilities({ requires: [{ what: 'x', abilities: ['bless'] }] }).length === 0);
  const bad = checkDeclaredAbilities({ requires: [{ what: 'x', abilities: ['shalille'] }] });
  ok('a misspelling is refused', bad.length === 1, JSON.stringify(bad));
  ok('and the refusal says it is not an ability this game has',
     /not a skill or spell this game has/.test(bad[0] ?? ''), bad[0]);
  // The school is not a spell, and declaring it is the commonest version of this mistake.
  ok("the school \"shal'ille\" is not an ability name either",
     checkDeclaredAbilities({ requires: [{ what: 'x', abilities: ["shal'ille"] }] }).length === 1);
  ok('a capability and a suggestion are checked the same way',
     checkDeclaredAbilities({ capabilities: [{ what: 'x', abilities: ['nope'] }],
                              suggests: [{ what: 'y', abilities: ['also nope'] }] }).length === 2);

  // AND IT HAPPENS AT LOAD. A pad with a bad name must be a PROBLEM on `list`, never a pad that
  // quietly reports the whole fleet ineligible.
  writeFileSync(join(padDir, 'typo.mjs'), padSrc(
    "{ name: 'typo', requires: [{ what: 'shalille', abilities: ['shalille'], check: () => true }]," +
    " async steps() { return []; } }"));
  const { pads: found, problems } = await pads();
  ok('the pad is not loaded', !found.has('typo'));
  ok('and it is reported as a problem instead',
     problems.some(p => /not a skill or spell/.test(p.why)), JSON.stringify(problems));
  rmSync(join(padDir, 'typo.mjs'));
}

console.log('\nthe rendered preflight is readable, and names the refusals');
{
  const pad = {
    requires: [{ what: 'knows bless', why: 'it loops for ever without it',
                 check: knows('bless') }],
  };
  const observer = fakeObserver({ t1: { character: 'Able', known: ['bless'] },
                                  t3: { character: 'Charlie', known: [] },
                                  t4: { character: 'Delta', known: null } });
  const text = formatPreflight(preflight(pad, ['t1', 't3', 't4'], { observer }),
                               { agents: ['t1', 't3', 't4'] });
  ok('it counts met, unmet and unknown', /1 met, 1 unmet, 1 unknown of 3/.test(text), text);
  ok('it carries the declared reason', /it loops for ever without it/.test(text));
  ok('it names the refused agent', /REFUSAL\(S\): t3/.test(text), text);
  ok('it does not list the agent that passed', !/ok  t1/.test(text));
  ok('and it says unknown is neither permission nor refusal',
     /not permission/.test(text) && /not a refusal/.test(text));
}

console.log('\na pad with no declarations is runnable and says so');
{
  const text = formatPreflight(preflight({}, ['t1']), { agents: ['t1'] });
  ok('it does not pretend to have checked anything', /declares no requirements/.test(text), text);
}

console.log('\nthe committed example pad is a real pad, and lives BESIDE the enumerated dir');
{
  // It imports from ../tools, so it only loads from its own place in substrate/.
  const mod = await import('../substrate/fleetscratch.example.mjs');
  ok('it exports a script', !!mod.script);
  ok('with a steps function', typeof mod.script.steps === 'function');
  ok('and every ability it names is real',
     checkDeclaredAbilities(mod.script).length === 0,
     JSON.stringify(checkDeclaredAbilities(mod.script)));
  const steps = await mod.script.steps({ home: 39 });
  ok('its steps compile', Array.isArray(steps) && steps.length === 2, JSON.stringify(steps));
  ok('and it is not in the pad directory the tools enumerate',
     !(await pads()).pads.has('example-pad'));
}

console.log('\n' + "act() hazards are found on the VERB, with no world read");
{
  const steps = [{ do: 'walk', to: 39 },
                 { do: 'act', tool: 'fight', args: { target: 'ghost' } },
                 { do: 'act', tool: 'look', args: {} },
                 { do: 'act', tool: 'walk_to', args: { col: 1, row: 2 } }];
  const hits = actHazards(steps);
  ok('both known hazards are found', hits.length === 2, JSON.stringify(hits.map(h => h.tool)));
  ok('and they carry the step index', hits[0].index === 1 && hits[1].index === 3);
  ok('an act verb with no known hazard is not flagged', !hits.some(h => h.tool === 'look'));
  ok('a pad with no act steps has none', actHazards([{ do: 'walk', to: 39 }]).length === 0);
  ok('and neither does an empty plan', actHazards([]).length === 0 && actHazards().length === 0);

  const text = formatActHazards(hits);
  ok('the render names the verb and the step', /step 1  act\('fight'\)/.test(text), text);
  ok('it carries the measurement, not just the claim', /233 of 233 health/.test(text));
  ok('it says what to do instead', /keeper-process.mjs:1861/.test(text));
  ok('and it says out loud that it warns rather than refuses',
     /WARN rather than refuse/.test(text));
  ok('nothing renders for a clean plan', formatActHazards([]) === '');
}

console.log('\n' + "every hazard entry is complete — a warning that cannot say why gets deleted");
{
  for (const [tool, h] of Object.entries(ACT_HAZARDS)) {
    ok(`${tool} says what goes wrong`, typeof h.what === 'string' && h.what.length > 20);
    ok(`${tool} cites the code`, /\.mjs:\d+/.test(h.why), h.why);
    ok(`${tool} carries a dated measurement`, /20\d\d-\d\d-\d\d/.test(h.measured), h.measured);
    ok(`${tool} says what to do instead`, typeof h.instead === 'string' && h.instead.length > 20);
  }
}

console.log('\na FLEET-scoped entry is one fact, evaluated once');
{
  const pad = {
    capabilities: [
      { what: 'the fleet has a caster', scope: 'fleet',
        check: ({ observations }) =>
          [...observations.values()].some(o => o.known?.has('enchant weapon'))
            ? MET : 'nobody in the fleet knows enchant weapon' },
      { what: 'wields a magic weapon', check: knows('bless') },
    ],
  };
  const observer = fakeObserver({
    t1: { character: 'Able', known: ['enchant weapon'] },
    t2: { character: 'Baker', known: ['bless'] },
    t3: { character: 'Charlie', known: [] },
  });
  const rows = preflight(pad, ['t1', 't2', 't3'], { observer });
  const fleetRows = rows.filter(r => r.what === 'the fleet has a caster');
  ok('it produces ONE row, not one per agent', fleetRows.length === 1, String(fleetRows.length));
  ok('that row names no agent', fleetRows[0].agent === null);
  ok('its scope is fleet', fleetRows[0].scope === 'fleet');
  ok('and the check saw every observation', fleetRows[0].verdict === 'met');
  ok('per-agent entries are still per agent',
     rows.filter(r => r.what === 'wields a magic weapon').length === 3);

  // THE RENDER MUST NOT INVENT A DISTRIBUTION for a fact that has none.
  const text = formatPreflight(rows, { agents: ['t1', 't2', 't3'] });
  ok('a fleet fact renders as one verdict, not "1 of 1"',
     /the fleet has a caster  —  MET for the fleet/.test(text), text);
  ok('and it never claims "of 3" for it', !/the fleet has a caster  —  \d+ met/.test(text));
}

console.log('\na fleet-scoped REQUIREMENT refuses, and says THE FLEET');
{
  const pad = { requires: [{ what: 'somebody can cast it', scope: 'fleet',
                             check: () => 'nobody in the roster knows it' }] };
  const rows = preflight(pad, ['t1', 't2'], { observer: fakeObserver({}) });
  ok('one row', rows.length === 1);
  ok('it refuses', rows[0].refuse === true);
  const text = formatPreflight(rows, { agents: ['t1', 't2'] });
  ok('and the render says THE FLEET rather than a handle', /NO  THE FLEET/.test(text), text);
}

console.log('\n`breaks`: a fact that destroys another answer makes it UNKNOWN, not unmet');
{
  // The raid's case: two weapons of one name make "wields a magic weapon" unanswerable, because
  // equipment() answers by name only.
  const pad = {
    requires: [{ what: 'exactly one weapon of the wielded name',
                 breaks: ['wields a magic weapon'],
                 check: (obs) => obs.known?.has('duplicate') ? 'two swords named alike' : MET }],
    capabilities: [{ what: 'wields a magic weapon', check: knows('bless') }],
  };
  const observer = fakeObserver({
    t1: { character: 'Able', known: ['bless'] },                 // armed, no duplicate
    t2: { character: 'Baker', known: ['bless', 'duplicate'] },   // armed BUT unanswerable
    t3: { character: 'Charlie', known: ['duplicate'] },          // unarmed AND unanswerable
  });
  const rows = preflight(pad, ['t1', 't2', 't3'], { observer });
  const armed = a => rows.find(r => r.agent === a && r.what === 'wields a magic weapon');

  ok('an agent with no duplicate keeps its real answer', armed('t1').verdict === 'met');
  ok('an agent WITH a duplicate goes to unknown', armed('t2').verdict === 'unknown');
  ok('and the reason names the fact that took the answer away',
     /unanswerable: exactly one weapon of the wielded name/.test(armed('t2').why), armed('t2').why);
  ok('and carries the breaker\u2019s own why', /two swords named alike/.test(armed('t2').why));
  ok('an unmet answer is also destroyed rather than kept', armed('t3').verdict === 'unknown');
  ok('a broken row does NOT refuse — unknown never refuses', armed('t2').refuse === false);

  // THE BREAKER'S OWN TIER IS WHAT BLOCKS. Declared as a requirement, it refuses on its own
  // account, which is how the duplicate case stops an errand without inventing a fourth tier.
  const dup = a => rows.find(r => r.agent === a && r.what.startsWith('exactly one'));
  ok('the breaker itself refuses, because it is declared a requirement', dup('t2').refuse === true);
  ok('and it does not refuse for an agent that is clean', dup('t1').refuse === false);
  ok('only the breaking agent is affected, not the whole fleet',
     armed('t1').verdict === 'met' && armed('t2').verdict === 'unknown');
}

console.log('\na FLEET-scoped breaker breaks every agent');
{
  const pad = {
    suggests: [{ what: 'the equipment read is trustworthy', scope: 'fleet',
                 breaks: ['armed'], check: () => 'equipment() answers by name only' }],
    capabilities: [{ what: 'armed', check: knows('bless') }],
  };
  const observer = fakeObserver({ t1: { character: 'Able', known: ['bless'] },
                                  t2: { character: 'Baker', known: ['bless'] } });
  const rows = preflight(pad, ['t1', 't2'], { observer });
  const armed = rows.filter(r => r.what === 'armed');
  ok('every agent goes unknown', armed.length === 2 && armed.every(r => r.verdict === 'unknown'),
     JSON.stringify(armed.map(r => r.verdict)));
  ok('and a suggestion-tier breaker still refuses nothing',
     rows.every(r => r.refuse === false));
}

console.log('\nbreaks naming an entry that does not exist changes nothing');
{
  const pad = {
    requires: [{ what: 'a', breaks: ['no such entry'], check: () => 'nope' }],
    capabilities: [{ what: 'b', check: () => MET }],
  };
  const rows = preflight(pad, ['t1'], { observer: fakeObserver({ t1: { character: 'A', known: [] } }) });
  ok('the other entry keeps its answer', rows.find(r => r.what === 'b').verdict === 'met');
  ok('and the breaker still refuses on its own account',
     rows.find(r => r.what === 'a').refuse === true);
}

console.log('\nan UNKNOWN carries ITS OWN cause, and never borrows one');
{
  // The bug: every silent unknown was reported as a missing ability book, including for entries
  // that never touched abilities, and the summary told the reader to refresh books that could not
  // have changed the answer. Reported 2026-09-11 against a raid declaring "a weapon in hand".
  const pad = {
    requires: [
      { what: 'a weapon in hand', check: () => null },                 // nothing to do with books
      { what: 'knows bless', check: knows('bless') },                  // a real book reader
      { what: 'the room is enterable', scope: 'fleet', check: () => null },
    ],
  };
  const observer = fakeObserver({ t1: { character: 'Able', known: null } });
  const rows = preflight(pad, ['t1'], { observer });
  const row = w => rows.find(r => r.what === w);

  ok('a non-ability check is NOT blamed on the ability book',
     !/ability book/.test(row('a weapon in hand').why), row('a weapon in hand').why);
  ok('it says a live read is what would answer it',
     /only a live read can answer it/.test(row('a weapon in hand').why));
  ok('and its cause is needs-live, not no-book', row('a weapon in hand').cause === 'needs-live');
  ok('an actual book reader IS blamed on the book',
     /no ability book for Able/.test(row('knows bless').why), row('knows bless').why);
  ok('and its cause is no-book', row('knows bless').cause === 'no-book');

  const text = formatPreflight(rows, { agents: ['t1'] });
  ok('the summary groups the book case separately',
     /1 want an ability book — run m59-abilities.mjs/.test(text), text);
  ok('and names the live-read cases as unfixable by a refresh',
     /read something no cache on disk holds/.test(text), text);
  ok('it no longer tells everyone to refresh the ability books',
     !/Decide, or refresh the ability books first/.test(text));
}

console.log('\nunknownBecause is how a pad says why, and a bad handle is its own cause');
{
  const pad = { requires: [{ what: 'x',
    check: () => unknownBecause('the maintenance socket is not listening', 'needs-live') }] };
  const rows = preflight(pad, ['t1'], { observer: fakeObserver({ t1: { character: 'A', known: [] } }) });
  ok('the reason survives to the row', /maintenance socket/.test(rows[0].why), rows[0].why);
  ok('and so does the cause', rows[0].cause === 'needs-live');

  const off = preflight({ requires: [{ what: 'y', check: knows('bless') }] }, ['nobody'],
                        { observer: fakeObserver({}) });
  ok('an unknown handle is no-roster, not no-book', off[0].cause === 'no-roster', off[0].cause);
  const text = formatPreflight(off, { agents: ['nobody'] });
  ok('and the summary says there is nothing to run for it',
     /not in this fleet's roster/.test(text), text);
}

console.log('\nthe render is the summary plus the EXCEPTIONS, not 201 lines');
{
  const agents = Array.from({ length: 21 }, (_, i) => `s${String(i + 1).padStart(2, '0')}`);
  const books = {};
  for (const a of agents) books[a] = { character: a.toUpperCase(), known: [] };
  const pad = { capabilities: [{ what: 'armed', check: knows('bless') }] };
  const rows = preflight(pad, agents, { observer: fakeObserver(books) });

  const brief = formatPreflight(rows, { agents });
  const briefLines = brief.split('\n').filter(l => /^      /.test(l)).length;
  ok('21 failures do not print 21 lines', briefLines <= 5, `${briefLines} rows`);
  ok('it says how many it held back', /and 17 more like it — add all=1 for every row/.test(brief),
     brief);
  ok('the count is still exact in the summary', /0 met, 21 unmet, 0 unknown of 21/.test(brief));

  const full = formatPreflight(rows, { agents, all: true });
  ok('all=1 prints every row', full.split('\n').filter(l => /^      /.test(l)).length === 21);
  ok('and then says nothing about holding rows back', !/more like it/.test(full));
}

console.log('\na SYNCHRONOUS steps() is as valid as an async one');
{
  // A fleetscript's steps may return an array directly -- several committed ones do -- and the
  // promotion story is that a pad has the identical shape. Calling .catch on an array threw
  // "r.pad.steps(...).catch is not a function" AFTER the check had printed, so the useful output
  // was followed by an error that read as the check failing. Reported 2026-09-11.
  writeFileSync(join(padDir, 'syncpad.mjs'), padSrc(
    "{ name: 'syncpad', params: { agents: { type: 'agents', required: true } }," +
    " steps() { return [{ do: 'walk', to: 39 }]; } }"));
  const { pads: found, problems } = await pads();
  ok('a sync pad loads', found.has('syncpad'), JSON.stringify(problems));
  const steps = await Promise.resolve(found.get('syncpad').steps({}));
  ok('and its steps normalise through Promise.resolve', Array.isArray(steps) && steps[0].to === 39);
  ok('and the hazard scan takes them as they are', actHazards(steps).length === 0);
  rmSync(join(padDir, 'syncpad.mjs'));
}

console.log('\nthe corpus lookup applies the CORPUS\u2019S OWN coverage rule, not the score');
{
  // Real `m59.py find` output. The rule measured there: true hits land at 59-99 with ALL terms
  // covered, and a question the corpus does not cover scored 34 with 1 of 3. One shared word with a
  // big report inflates the score, so partial coverage is a miss however high it ranks.
  const out = [
    ' 244  6/7 terms    reports/ghost-of-farnohl-tactics.md',
    "      Ghost of Far'Nohl: fireball rules, kiting math, and what to hit it with",
    '      ~ What weapon should I use against the Ghost of Far\'Nohl?',
    '',
    '  99  1/7 terms    reports/vigor-food-and-rest.md',
    '      Vigor, food and rest',
    '',
    '  34  3/3 terms    reports/tiny-report.md',
    '      A report that matches everything and says nothing',
  ].join('\n');

  const rows = parseFindOutput(out);
  ok('it parses every row', rows.length === 3, String(rows.length));
  ok('it reads the score', rows[0].score === 244);
  ok('it reads the coverage', rows[0].covered === 6 && rows[0].total === 7);
  ok('and it takes the title from the following line',
     /fireball rules/.test(rows[0].title), rows[0].title);

  const hits = hitsAmong(rows);
  ok('near-full coverage with a high score is a hit',
     hits.some(h => /ghost-of-farnohl/.test(h.file)));
  ok('a HIGH SCORE with 1 of 7 terms is NOT a hit — this is the whole rule',
     !hits.some(h => /vigor-food-and-rest/.test(h.file)));
  ok('and full coverage below the score floor is not either',
     !hits.some(h => /tiny-report/.test(h.file)));
  ok('so exactly one row survives', hits.length === 1, JSON.stringify(hits.map(h => h.file)));
}

console.log('\nconsultCorpus injects its runner, so no test needs a corpus on disk');
{
  const asked = [];
  const run = (term) => {
    asked.push(term);
    return term.includes('ghost')
      ? ' 244  6/6 terms    reports/ghost-of-farnohl-tactics.md\n      The ghost report\n'
      : '  12  1/4 terms    reports/unrelated.md\n      Something else\n';
  };
  const r = consultCorpus({ consults: ['the ghost of far\'nohl', 'breeding chickens'] }, { run });
  ok('every declared term is asked', asked.length === 2);
  ok('the one with a report comes back with a hit',
     r.rows.find(x => /ghost/.test(x.term)).hits.length === 1);
  ok('the one without comes back empty rather than with a weak match',
     r.rows.find(x => /chickens/.test(x.term)).hits.length === 0);

  const text = formatConsults(r);
  ok('the render leads with read-it-before-deriving-it',
     /ALREADY HAS SOMETHING ABOUT THIS/.test(text), text);
  ok('it names the report file', /ghost-of-farnohl-tactics\.md/.test(text));
  ok('AND IT STILL REPORTS THE TERM THAT FOUND NOTHING',
     /nothing for "breeding chickens"/.test(text), text);
  ok('telling the reader they are the first', /you are the first/.test(text));
}

console.log('\na pad that declares no consults, and a machine with no corpus, both say so');
{
  ok('no consults is stated, not silently skipped',
     /declares no `consults`/.test(formatConsults(consultCorpus({}, { dir: null }))));
  const noDir = consultCorpus({ consults: ['x'] }, { dir: null });
  ok('no M59_RESEARCH_DIR is not an error', noDir.asked === false);
  ok('and it says how to turn the lookup on',
     /M59_RESEARCH_DIR/.test(formatConsults(noDir)), formatConsults(noDir));
  const badDir = consultCorpus({ consults: ['x'] }, { dir: 'Z:/no/such/checkout' });
  ok('a path that does not exist is reported rather than thrown',
     badDir.asked === false && /does not exist/.test(badDir.why), badDir.why);
}

console.log('\na find that throws is reported per term, not fatal');
{
  const r = consultCorpus({ consults: ['a', 'b'] }, {
    run: (t) => { if (t === 'a') throw new Error('python not found'); return ' 99  2/2 terms    reports/b.md\n      B\n'; } });
  ok('the failing term is recorded', /python not found/.test(r.rows[0].failed));
  ok('the other term still answered', r.rows[1].hits.length === 1);
  ok('and the render says which could not be asked',
     /"a" could not be asked: python not found/.test(formatConsults(r)), formatConsults(r));
}

console.log('\n`needs-contact` is a cause, not a fifth tier');
{
  // "Swing once and read the sentence" cannot run until the fleet is in the boss's room, which is
  // after the checkpoint that would gate entry. That does not need a new concept: it is an unknown
  // with a cause, and the summary says it will resolve rather than leaving a reader to chase it.
  const pad = { capabilities: [{ what: 'the enchantment is live',
    check: () => unknownBecause('only answerable in contact — swing once and read the sentence',
                                'needs-contact') }] };
  const rows = preflight(pad, ['t1'], { observer: fakeObserver({ t1: { character: 'A', known: [] } }) });
  ok('it is unknown', rows[0].verdict === 'unknown');
  ok('it does not refuse', rows[0].refuse === false);
  ok('the cause survives', rows[0].cause === 'needs-contact');
  const text = formatPreflight(rows, { agents: ['t1'] });
  ok('and the summary says it resolves during the errand',
     /resolve during the errand/.test(text), text);
  ok('rather than sending anyone to refresh an ability book', !/ability book/.test(text));
}

console.log(NL + 'A GEOMETRIC PAD HAS NOTHING TO PUT IN `requires`, AND MUST NOT READ AS FORGETFUL');
{
  // Reported by the Marco Polo session, 2026-09-12: a rail-following pad declares nothing about
  // what a character KNOWS, because what can go wrong is the ground. Its checkpoint's `holds` is
  // doing that job, and "(this pad declares no requirements)" read like a gap it had left.
  const withCp = formatPreflight([], { agents: ['hk2'], checkpoints: 1 });
  ok('it says there are no ABILITY requirements, not no requirements',
     /no ability requirements/.test(withCp), withCp);
  ok('it counts the checkpoints that will be asked',
     /1 checkpoint\(s\) will be asked at run time/.test(withCp), withCp);
  ok('and says that is where the risk is',
     /where this pad's risk actually is/.test(withCp), withCp);

  // A pad with NEITHER is a different thing and still gets told.
  const bare = formatPreflight([], { agents: ['hk2'], checkpoints: 0 });
  ok('a pad with neither is told nothing will be checked',
     /no requirements and no checkpoints/.test(bare), bare);
  ok('and it does not claim a checkpoint it does not have', !/will be asked/.test(bare));
}

console.log('\n`lab: true` injects REQUIRES: LOCALADMIN, and refuses off a lab box');
{
  const pad = { lab: true, requires: [{ what: 'something else', check: () => MET }] };
  const decl = declarationsOf(pad);
  ok('the lab requirement is prepended', decl.requires[0] === LAB_REQUIREMENT);
  ok('the pad keeps its own requirements', decl.requires.length === 2);
  ok('it is fleet-scoped — the socket is not per character',
     LAB_REQUIREMENT.scope === 'fleet');
  ok('a pad without lab:true is untouched', declarationsOf({ requires: [] }).requires.length === 0);
  ok('and a pad with no declarations at all survives', !!declarationsOf(undefined));

  // The check reads the live env, so drive it through the env the way the real one is read.
  const was = process.env.M59_ADMIN_HOST;
  try {
    process.env.M59_ADMIN_HOST = '127.0.0.1';
    ok('loopback satisfies it', LAB_REQUIREMENT.check({}) === MET);
    process.env.M59_ADMIN_HOST = '10.0.0.7';
    const why = LAB_REQUIREMENT.check({});
    ok('a remote admin host does not', typeof why === 'string');
    ok('and the refusal says you should not take DM rights there',
       /should not try to take them/.test(why), why);
  } finally {
    if (was === undefined) delete process.env.M59_ADMIN_HOST;
    else process.env.M59_ADMIN_HOST = was;
  }
}

console.log('\na lab pad refuses through the ordinary preflight, as a REQUIREMENT');
{
  const was = process.env.M59_ADMIN_HOST;
  process.env.M59_ADMIN_HOST = '10.0.0.7';
  try {
    const rows = preflight({ lab: true }, ['t1'],
                           { observer: fakeObserver({ t1: { character: 'A', known: [] } }) });
    const lab = rows.find(r => /LOCALADMIN/.test(r.what));
    ok('the row is there', !!lab);
    ok('it is unmet', lab.verdict === 'unmet');
    ok('AND IT REFUSES — a half-configured lab is worse than none', lab.refuse === true);
    ok('it renders as a fleet fact, not per character', lab.scope === 'fleet');
    const text = formatPreflight(rows, { agents: ['t1'] });
    ok('and the render says THE FLEET', /NO  THE FLEET/.test(text), text);
  } finally {
    if (was === undefined) delete process.env.M59_ADMIN_HOST;
    else process.env.M59_ADMIN_HOST = was;
  }
}

console.log('\nsetup and teardown are declared, and a misspelled ability in a lab pad still fails load');
{
  writeFileSync(join(padDir, 'labpad.mjs'), padSrc(
    "{ name: 'labpad', lab: true," +
    " requires: [{ what: 'knows nope', abilities: ['nope'], check: () => true }]," +
    " async setup() {}, async teardown() {}, async steps() { return []; } }"));
  const { pads: found, problems } = await pads();
  ok('the lab pad with a bad ability name does not load', !found.has('labpad'));
  ok('and the reason is the ability, not the lab flag',
     problems.some(p => /not a skill or spell/.test(p.why)), JSON.stringify(problems));
  rmSync(join(padDir, 'labpad.mjs'));

  writeFileSync(join(padDir, 'goodlab.mjs'), padSrc(
    "{ name: 'goodlab', lab: true, async setup() {}, async teardown() {}," +
    " params: { agents: { type: 'agents', required: true } }, async steps() { return []; } }"));
  const r2 = await pads();
  const p2 = r2.pads.get('goodlab');
  ok('a well-formed lab pad loads', !!p2);
  ok('and carries both phases', typeof p2.setup === 'function' && typeof p2.teardown === 'function');
  rmSync(join(padDir, 'goodlab.mjs'));
}

console.log(NL + 'A PREDICATE MAY LOOK AND MAY NOT ACT');
{
  // The gap the Marco Polo session hit: a checkpoint's `holds` is asked "is he in room 49, whole,
  // not travelling" and the ctx had no way to ask the broker anything, so their pad carried its
  // own JSON-RPC helper — which works, and which every pad would then copy slightly differently.
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(JSON.parse(opts.body).params);
    return { json: async () => ({ result: { content: [{ text: '{"room":{"num":49}}' }] } }) };
  };
  const read = worldReader({ url: 'http://127.0.0.1:1/x', fetchImpl });

  const got = await read('look', { agent: 'hk2' });
  ok('a world read reaches the broker', got.room.num === 49, JSON.stringify(got));
  ok('with the tool and arguments intact',
     calls[0].name === 'look' && calls[0].arguments.agent === 'hk2', JSON.stringify(calls[0]));

  // AND REFUSES ANYTHING THAT IS NOT A READ, before it opens a socket.
  const before = calls.length;
  let why = null;
  try { await read('travel', { agent: 'hk2', to: 45 }); } catch (e) { why = e.message; }
  ok('a mutation is refused', !!why);
  ok('NOTHING WAS SENT', calls.length === before, String(calls.length - before));
  ok('and the refusal says why a predicate may not act',
     /may LOOK and may not ACT/.test(why), why);
  ok('and lists what is allowed', /Allowed: fleet, look, status/.test(why), why);

  ok('the allowlist covers what a world predicate actually needs',
     ['look', 'status', 'inventory', 'equipment', 'abilities'].every(t => WORLD_READ.includes(t)));
  ok('and does not include a single mutation',
     !['travel', 'fight', 'attack', 'cast', 'drop_all', 'buy'].some(t => WORLD_READ.includes(t)));
}

console.log(NL + 'THE GUARANTEES STOP AT THE STEP BOUNDARY, AND THE AUDIT SAYS SO');
{
  // Their framing, which I took: a pad still only emits steps[], but a verify BODY is arbitrary
  // code and a fine rail genuinely needs a loop the step vocabulary does not have. Do not close
  // the hole — count it.
  const steps = [
    { do: 'walk', to: 49 },
    { do: 'verify', fn: async ({ agent }) => (await call('status', { agent })).room === 49,
      why: 'arrived at 49' },
    { do: 'verify', fn: async ({ agent, observe }) => (await observe(agent)).room === 49,
      why: 'arrived, through the compiler' },
  ];
  const hits = brokerReachingSteps(steps);
  ok('a verify that calls the broker directly is spotted', hits.length === 1, JSON.stringify(hits));
  ok('by index', hits[0].index === 1);
  ok('and it carries the step reason so it is findable', /arrived at 49/.test(hits[0].why));
  ok('a verify using the compiler helpers is NOT flagged',
     !hits.some(h => h.index === 2), JSON.stringify(hits));
  ok('a plain step is not flagged', !hits.some(h => h.index === 0));
  ok('and a clean plan reports nothing at all', brokerReachingSteps([{ do: 'walk', to: 1 }]).length === 0);

  const text = formatBrokerReach(hits);
  ok('the render says the guarantees do not apply below the boundary',
     /guarantees do not apply/.test(text), text);
  ok('it names what is lost', /no cancel-before-send/.test(text) && /no read-back/.test(text));
  ok('it says this is an AUDIT and not a refusal', /AUDIT, not a refusal/.test(text));
  ok('it admits the heuristic is fooled by indirection',
     /through an imported helper is not/.test(text), text);
  ok('and says absence is not evidence of absence',
     /Absence here is not evidence of absence/.test(text));
  ok('nothing renders for a clean plan', formatBrokerReach([]) === '');
}

console.log(NL + 'THE DISHONEST ANSWER: a wrongly-typed reply that formats perfectly');
{
  // Three of these in one day across two sessions. None was an empty result — each was an
  // accessor confidently answering about a field that was not there.
  const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };

  // health.fleet is the string "prod", read as an agent list.
  let why = threw(() => assertShape('fleet', 'prod'));
  ok('a string where an object was expected is refused', !!why);
  ok('and it quotes what it got', /"prod"/.test(why), why);
  ok('and says why undefined is the danger',
     /formats perfectly and means nothing/.test(why), why);

  ok('an array is refused too', /an array/.test(threw(() => assertShape('status', [1, 2]))));
  ok('null is refused', !!threw(() => assertShape('status', null)));

  // An object that is simply not that tool's reply.
  why = threw(() => assertShape('status', { error: 'no such agent' }));
  ok('another tool\u2019s answer is refused', !!why);
  ok('it lists what a status should carry', /hp, vitals, where/.test(why), why);
  ok('and what actually arrived', /keys present: error/.test(why), why);

  // DELIBERATELY LOOSE: one recognisable key is enough, so an added field never breaks it.
  ok('a real status passes', !threw(() => assertShape('status', { hp: { value: 40, max: 44 } })));
  ok('and so does one with fields we have never seen',
     !threw(() => assertShape('status', { hp: {}, brand_new_field: 1 })));
  ok('a tool we claim no shape for is passed through',
     assertShape('who_buys', 'anything') === 'anything');
}

console.log(NL + 'fieldOf REFUSES a path that is not there, and says where it lives');
{
  const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };
  const status = { hp: { value: 40, max: 44 }, where: { num: 49 } };

  ok('a present path reads', fieldOf(status, 'hp.value') === 40);
  ok('a nested one too', fieldOf(status, 'where.num') === 49);

  // THE INCIDENT: status.wielding does not exist; wielding is on the equipment reply.
  const why = threw(() => fieldOf(status, 'wielding', { from: 'status' }));
  ok('an absent field is refused rather than undefined', !!why);
  ok('it says what the object DOES carry', /hp, where/.test(why), why);
  ok('AND WHERE THE FIELD ACTUALLY LIVES',
     /the `equipment` reply/.test(why) && /m59-broker\.mjs:11711/.test(why), why);
  ok('and names the consequence',
     /a read about nothing becomes a finding/.test(why), why);
  // A caller that does not say which reply it is reading still gets the pointer, because the
  // field name is unambiguous across the table.
  ok('and it finds the hint without being told the tool',
     /the `equipment` reply/.test(threw(() => fieldOf(status, 'wielding'))),
     threw(() => fieldOf(status, 'wielding')));

  ok('status.gold is known to be always null', /ALWAYS null/.test(MISPLACED_FIELDS['status.gold']));
  ok('and look.exits is known to be an absence',
     /not a measurement/.test(MISPLACED_FIELDS['look.exits']));

  ok('orNull is available for a genuinely optional field',
     fieldOf(status, 'busy', { orNull: true }) === null);
  ok('and a deep miss reports the level it stopped at',
     /hp carries value, max/.test(threw(() => fieldOf(status, 'hp.regen.rate'))),
     threw(() => fieldOf(status, 'hp.regen.rate')));
}

console.log(NL + 'A COUNT CARRIES ITS UNSHAPED INPUTS — the formatter rule');
{
  const rows = [{ name: 'Kermit', hp: { value: 44 } }, { name: 'Pepe', hp: { value: 60 } },
                { name: 'Statler' }, { name: 'Waldorf' }];
  const t = tally(rows, (r) => fieldOf(r, 'hp.value') > 0);
  ok('it counts what it could read', t.counted === 2, String(t.counted));
  ok('it keeps the total', t.total === 4);
  ok('and it keeps what it could NOT read', t.unshaped.length === 2, JSON.stringify(t.unshaped));

  const text = formatTally(t, 'in game');
  ok('the count is still shown — hiding it would be its own lie',
     /^2 of 4 in game/.test(text), text);
  ok('BUT IT ARRIVES WITH THE REASON', /\(2 unshaped:/.test(text), text);
  ok('naming the field that was not there', /"hp\.value" is not there/.test(text), text);

  const clean = formatTally(tally(rows.slice(0, 2), (r) => fieldOf(r, 'hp.value') > 0), 'in game');
  ok('a clean tally is just the count', clean === '2 of 2 in game', clean);
}

console.log(NL + 'THE SECOND AXIS: the reply can be right and the PATH can have dropped it');
{
  const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };
  // KeeperProxy rebuilds equipped items from names alone (m59-broker.mjs:1892), so a field can
  // exist in the serializer, work read straight off the keeper, and be missing through the broker
  // for every prod character — because all of them are keeper-backed.
  const equipment = { known: true, equipped: [{ id: -1, name: 'short sword', nameRsc: 'short sword' }] };
  const why = threw(() => fieldOf(equipment, 'equipped.0.rarity', { from: 'equipment' }));
  ok('a field the rebuild dropped is refused', !!why);
  ok('AND IT NAMES THE PATH, not just the field', /note the PATH/.test(why), why);
  ok('saying the rebuild is the cause and not the server',
     /it is the rebuild, not the server/.test(why), why);
  ok('and carries the remedy sentence',
     /through the BROKER on a keeper-backed character/.test(why), why);
  ok('a reply with no known proxy drop does not get the note',
     !/note the PATH/.test(threw(() => fieldOf({ hp: {} }, 'wielding', { from: 'status' }))));
  ok('PROXY_DROPS names the reply it is about', 'equipment' in PROXY_DROPS);
}

console.log(NL + 'AN ID IS A HANDLE THAT EXPIRES, NOT A NUMBER');
{
  const threw = (f) => { try { f(); return null; } catch (e) { return e.message; } };

  const h = handle(7124, { from: "read('look')" });
  ok('a handle knows its id', h.id === 7124);
  ok('and where it came from', /look/.test(h.from));
  ok('and which read it belongs to', h.epoch === currentEpoch());
  ok('it is usable right away', usableHandle(h) === 7124);
  ok('isHandle tells one from a number', isHandle(h) && !isHandle(7124));

  // A BARE NUMBER IS REFUSED, because a number cannot say when it was read.
  const bare = threw(() => usableHandle(7124));
  ok('a bare id is refused', !!bare);
  ok('and the refusal carries the recycling rate',
     /23% named a different object within/.test(bare), bare);

  // SYNTHETIC IDS ARE NOT IDS.
  const syn = handle(-1, { from: "read('equipment')" });
  ok('a negative id is marked synthetic', syn.synthetic === true);
  const synWhy = threw(() => usableHandle(syn));
  ok('and refused', !!synWhy);
  // Asserts the SYMBOL, not a line number: the same line is :1892 here and :1897 in prod-deploy,
  // and a harness citation has no repo_commit to pin it the way a corpus citation does.
  ok('naming KeeperProxy.equipment rather than a checkout-relative line',
     /KeeperProxy\.equipment/.test(synWhy), synWhy);
  ok('and saying it is a counter rather than an id',
     /a counter, not an object id/.test(synWhy), synWhy);

  // THE EPOCH IS THE WHOLE MECHANISM: one tick per world read.
  bumpEpoch();
  const stale = threw(() => usableHandle(h));
  ok('a handle held across ONE world read is refused', !!stale);
  ok('it says how many reads ago', /1 world read\(s\) ago/.test(stale), stale);
  ok('and names the look_at observation that motivates it',
     /PREVIOUS call's object carrying its own wrong id/.test(stale), stale);
  ok('and tells you the fix', /Read it again/.test(stale));

  // A fresh handle after the tick is fine — the rule is "re-read", not "never hold".
  ok('re-reading gives a usable one', usableHandle(handle(7124, { from: 'x' })) === 7124);
}

console.log(NL + 'LEDGER ROWS ARE TAGGED AT THE SEAM — three trusts wearing one `type`');
{
  // The trap, verified in m59-ledger.mjs: recordSample DERIVES events and writes them through
  // recordEvent, so `type: 'event'` does not mean observed. Tagging keys on the kind, and on the
  // row itself where one kind splits.
  const killed = tagRow({ kind: 'killed', character: 'hk2', t: 1 });
  ok('a kill is observed', killed.trust === 'observed');
  ok('and says who saw it', /autopilot/.test(killed.trust_why), killed.trust_why);

  const lost = tagRow({ kind: 'level_lost', from: 44, to: 43 });
  ok('a level change is SAMPLED despite being written as an event',
     lost.trust === 'sampled', JSON.stringify(lost));
  ok('and says it came from comparing two polls',
     /comparing two polls/.test(lost.trust_why), lost.trust_why);

  // `died` SPLITS, which is why this tags rows and not kinds.
  const reconstructed = tagRow({ kind: 'died', killed_by: 'a troll', room: 599 });
  ok('a reconstructed death is sampled', reconstructed.trust === 'sampled');
  ok('and names the honest half — trustworthy fields, poller\u2019s clock',
     /the clock is the poller/.test(reconstructed.trust_why), reconstructed.trust_why);

  const inferred = tagRow({ kind: 'died', note: 'inferred from sampling', was_in: 'somewhere' });
  ok('AN INFERRED DEATH IS A DIFFERENT TRUST ENTIRELY', inferred.trust === 'inferred');
  ok('and says what a null killer means there',
     /NOBODY WATCHED, not "nothing killed it"/.test(inferred.trust_why), inferred.trust_why);

  const unknown = tagRow({ kind: 'grind_suppressed' });
  ok('a kind with no rule is UNKNOWN, not assumed', unknown.trust === 'unknown');
  ok('and says to add it rather than guess', /add it to LEDGER_TRUST/.test(unknown.trust_why));
}

console.log(NL + 'killerIsMeaningful refuses the rows where a null killer means nobody watched');
{
  ok('a reconstructed death has a meaningful killer field',
     killerIsMeaningful(tagRow({ kind: 'died', killed_by: null })) === true);
  ok('an INFERRED one does not',
     killerIsMeaningful(tagRow({ kind: 'died', note: 'inferred from sampling' })) === false);
  ok('and neither does a detail_missing row',
     killerIsMeaningful(tagRow({ kind: 'died', detail_missing: true })) === false);
}

console.log(NL + 'joinable() REFUSES the correlation that reads as a finding');
{
  ok('two observed kinds may be correlated', joinable('killed', 'killed').ok === true);

  // The published-then-retracted causal claim, refused at the seam.
  const j = joinable('died', 'level_lost');
  ok('died with level_lost is refused', j.ok === false);
  ok('it names BOTH kinds and their trust',
     /died is sampled/.test(j.why) && /level_lost is sampled/.test(j.why), j.why);
  ok('it states the resolution in minutes', /about 5 minutes/.test(j.why), j.why);
  ok('it says why ordering is unsupported',
     /a claim about ordering the data cannot support/.test(j.why));
  ok('AND IT NAMES THE ALTERNATIVE',
     /Count per character over a window instead/.test(j.why), j.why);

  ok('one observed and one sampled is still refused', joinable('killed', 'level_lost').ok === false);
  const un = joinable('killed', 'grind_suppressed');
  ok('an unknown kind is refused rather than guessed', un.ok === false);
  ok('and says it is refusing rather than guessing at the clock',
     /refusing rather than\s+guessing at its clock/.test(un.why.replace(/\s+/g, ' ')) ||
     /refusing rather than guessing/.test(un.why.replace(/\s+/g, ' ')), un.why);

  const slow = joinable('died', 'level_lost', { pollMs: 60 * 60_000 });
  ok('the stated resolution follows the poll interval', /about 60 minutes/.test(slow.why), slow.why);
}

console.log(NL + 'the ledger read is LOCAL, allowlisted, and comes back tagged');
{
  ok('it is on the allowlist', WORLD_READ.includes('ledger'));
  // It must not be reachable as a broker call — the ledger is a file, and routing it through
  // fetch would have invented a tool the broker does not have.
  const reader = worldReader({ url: 'http://127.0.0.1:1/x',
                               fetchImpl: async () => { throw new Error('the socket was used'); } });
  const got = await reader('ledger', { sinceMs: 1000 });
  ok('reading it opens no socket', !!got, JSON.stringify(got).slice(0, 80));
  ok('the reply says every row is tagged', got.tagged === true);
  ok('and tells the caller to use joinable before correlating',
     /joinable\(\) before correlating/.test(got.note), got.note);
  ok('rows is an array even on an empty ledger', Array.isArray(got.rows));
  ok('and every row that came back carries a trust',
     got.rows.every(r => typeof r.trust === 'string'), JSON.stringify(got.rows.slice(0, 2)));
}

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
