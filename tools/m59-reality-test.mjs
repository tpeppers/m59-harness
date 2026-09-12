#!/usr/bin/env node
// WHICH REALITY, AND WHAT HAPPENED ACROSS SEVERAL. Offline: no server, no DM socket.
//
//   node tools/m59-reality-test.mjs
//
// The rule this file exists to defend: AN UNPATCHED SERVER IS NOT AN ERROR. The stock blakserv
// never calls srand, so its rand() stream is identical every boot — one reality, and a perfectly
// good one. A harness that demanded the seed patch in order to function would have made every
// stock server useless for no gain, so every path here degrades to "unseeded" and carries on.
import { readSeed, realityLabel, surveyOutcomes, formatSurvey,
         SEED_COMMAND, UNSEEDED } from './m59-reality.mjs';

const NL = String.fromCharCode(10);
let pass = 0, fail = 0;
const ok = (what, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? ` — ${extra}` : ''}`); }
};
const LAB = { M59_ADMIN_HOST: '127.0.0.1' };

console.log(NL + 'AN UNPATCHED SERVER ANSWERS THE QUESTION RATHER THAN FAILING IT');
{
  // What a stock blakserv actually says to a command it does not have.
  const unpatched = async () => 'Unknown command simseed. Type ? for help.';
  const s = await readSeed({ dmFn: unpatched, env: LAB });
  ok('it is not patched', s.patched === false);
  ok('the seed is 0', s.seed === UNSEEDED);
  ok('AND IT IS REACHABLE — the server answered, it just did not know the word',
     s.reachable === true);
  ok('the reason says unpatched, not broken',
     /does not know/.test(s.why) && /one reality/.test(s.why), s.why);
  ok('and the label is honest about what that means',
     realityLabel(s) === 'unseeded (stock stream)', realityLabel(s));
}

console.log(NL + 'a patched server reports its seed');
{
  const patched = async (cmds) => {
    ok('it asked the right command', cmds[0] === SEED_COMMAND, cmds[0]);
    return 'SimSeed -----------------------------------' + NL + 'seeded 4242';
  };
  const s = await readSeed({ dmFn: patched, env: LAB });
  ok('patched', s.patched === true);
  ok('with the seed', s.seed === 4242);
  ok('and the label names the reality', realityLabel(s) === 'seed 4242');
}

console.log(NL + 'patched but switched off is its own answer, and is NOT a seeded reality');
{
  const off = async () => 'SimSeed' + NL + 'seeded 0 (unseeded: the stock rand() stream)';
  const s = await readSeed({ dmFn: off, env: LAB });
  ok('the patch is detected', s.patched === true);
  ok('but the seed is 0', s.seed === UNSEEDED);
  ok('and the label does not claim a reality',
     realityLabel(s) === 'unseeded (patch present, seeding off)', realityLabel(s));
  ok('the reason distinguishes it from an unpatched server',
     /seeding is off/.test(s.why), s.why);
}

console.log(NL + 'an unreachable or remote socket degrades rather than throwing');
{
  const s = await readSeed({ dmFn: async () => { throw new Error('ECONNREFUSED'); }, env: LAB });
  ok('a dead socket does not throw', s.patched === false && s.reachable === false);
  ok('and says what went wrong', /ECONNREFUSED/.test(s.why), s.why);

  const remote = await readSeed({ env: { M59_ADMIN_HOST: '10.0.0.7' } });
  ok('a remote host is refused without opening anything', remote.reachable === false);
  ok('and the reason is the right one — production is never seeded',
     /production is never seeded/.test(remote.why), remote.why);
}

console.log(NL + 'the survey counts REALITIES, not runs');
{
  const s = surveyOutcomes([
    { seed: 1, outcome: 'fleet' }, { seed: 2, outcome: 'ghost' },
    { seed: 3, outcome: 'fleet' }, { seed: 4, outcome: 'fleet' },
  ]);
  ok('it totals the runs', s.total === 4);
  ok('and the distinct realities', s.realities === 4);
  ok('the winner leads', s.rows[0].outcome === 'fleet' && s.rows[0].count === 3);
  ok('with its seeds kept', s.rows[0].seeds.join(',') === '1,3,4');
  ok('it is not decided', s.decided === false);

  // Ten runs on one seed is ONE reality sampled ten times — depth, not breadth.
  const deep = surveyOutcomes(Array.from({ length: 10 }, () => ({ seed: 7, outcome: 'fleet' })));
  ok('ten runs on one seed is one reality', deep.realities === 1 && deep.total === 10);
  ok('and a single outcome is decided', deep.decided === true);
}

console.log(NL + 'the sentence the operator asked for');
{
  const runs = [
    { seed: 11, outcome: 'fleet' }, { seed: 12, outcome: 'ghost' },
    { seed: 13, outcome: 'fleet' }, { seed: 14, outcome: 'ghost' },
    { seed: 15, outcome: 'fleet' }, { seed: 16, outcome: 'ghost' },
    { seed: 17, outcome: 'fleet' }, { seed: 18, outcome: 'ghost' },
    { seed: 19, outcome: 'fleet' }, { seed: 20, outcome: 'ghost' },
  ];
  const text = formatSurvey({
    scenario: 'Ghost of Far’Nohl', runs, seeded: true,
    provenance: { harness: { commit: 'aaaa1111bbbb2222', dirty: false },
                  server: { commit: 'cccc3333dddd4444', dirty: false },
                  dumbot: { commit: null, dirty: null, why: 'checkout not found' } },
  });
  ok('it leads with who won and how often',
     /won 5 of 10/.test(text), text.split(NL)[0]);
  ok('AND IT CALLS A 5-5 SPLIT CLOSE', /A CLOSE ONE/.test(text), text.split(NL)[0]);
  ok('every outcome lists its seeds', /seeds: 11, 13, 15, 17, 19/.test(text), text);
  ok('it reports the breadth', /10 realities, one run each/.test(text), text);
  ok('and it prints the git sha of all three repositories',
     /harness  aaaa1111bbbb/.test(text) && /server   cccc3333dddd/.test(text), text);
  ok('an unpinned repository is called UNPINNED, not omitted',
     /dumbot   UNPINNED/.test(text), text);

  const decided = formatSurvey({ scenario: 'x', runs: runs.map(r => ({ ...r, outcome: 'fleet' })) });
  ok('a sweep is not called close', !/A CLOSE ONE/.test(decided));
  ok('and says it every time', /fleet every time — 10 of 10/.test(decided), decided);
}

console.log(NL + 'ONE REALITY IS REPORTED AS ONE REALITY, and says how to get more');
{
  const runs = Array.from({ length: 6 }, (_, i) => ({ seed: 0, outcome: i < 4 ? 'fleet' : 'ghost' }));
  const text = formatSurvey({ scenario: 'x', runs, seeded: false });
  ok('it says one reality', /ONE REALITY/.test(text), text);
  ok('and that the runs were samples of it, not realities',
     /6 samples of one reality/.test(text), text);
  ok('and names the patch that would vary it',
     /server-patches\/deterministic-seed/.test(text), text);
  ok('a dirty repository is flagged as uncheckoutable',
     /DIRTY/.test(formatSurvey({ scenario: 'x', runs,
       provenance: { harness: { commit: 'abc123abc123', dirty: true } } })));
}

console.log(NL + 'no runs is not a crash');
{
  ok('it says so plainly', /no runs/.test(formatSurvey({ scenario: 'x', runs: [] })));
  const s = surveyOutcomes([]);
  ok('and the fold is empty rather than undefined', s.total === 0 && s.rows.length === 0);
}

console.log(NL + `${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
