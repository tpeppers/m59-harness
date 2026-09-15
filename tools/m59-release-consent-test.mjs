#!/usr/bin/env node
// COMMITTING IS THE SIGN-OFF — offline, no git, no socket, no roster:
//
//   node tools/m59-release-consent-test.mjs
//
// WHAT THIS PINS, AND THE DEADLOCK IT REPLACED. `m59-deploy.mjs --cut` used to refuse an
// unpushed trunk with the sentence *"on a machine with many worktrees that work is usually
// somebody else's. Push it first"*. That is accurate and it is a trap: the authors here are
// mostly sessions, and a session that has ended cannot consent to anything, so "ask the author
// first" resolves to "never ship it". On 2026-09-11 it held a roll over seven perfectly good
// commits — four of them movement and guild fixes — whose authors were unreachable BY
// CONSTRUCTION. The work then waits for a batch reconciliation, which rule 5 exists to say is
// the worse failure of the two.
//
// So the default is inverted: landing a commit IS consent for anyone to push, rebase,
// cherry-pick, merge and tag it, at any moment, with nobody consulted. The absence of a hold is
// the consent, which is what makes the common path free.
//
// THE ASYMMETRY IS THE WHOLE DESIGN, and it is why the parser is loose. Reading a typo'd hold as
// CONSENT ships something its author tried to stop — silently, in front of twenty-one characters
// on a shared server, with no way for anyone to notice. Reading a stray line as a hold costs one
// person one minute. So anything reaching for the concept and missing is refused, and refused
// with a DIFFERENT sentence so it can be fixed rather than argued with. Rule 4: a guarantee that
// cannot be evaluated refuses.
import { parseHold, holdsIn, holdRefusals } from './m59-release-consent.mjs';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
};

console.log('\nthe common path is silence, and silence is YES');
{
  const ordinary = parseHold('Fix the thing\n\nA body that says nothing about releases.\n\n' +
                             'Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n' +
                             'Claude-Session: https://claude.ai/code/session_01abc');
  ok('an ordinary commit is releasable', !ordinary.held && !ordinary.malformed);
  // The session trailer is for CLOSING OUT work — asking what somebody meant. It was never a
  // gate on shipping, and must not become one by accident.
  ok('a Claude-Session trailer is not a hold', !ordinary.held);
  ok('an empty message is releasable', !parseHold('').held);
  ok('null/undefined do not throw', !parseHold(undefined).held && !parseHold(null).held);
  // The words appearing in prose must not seize a roll.
  ok('prose about releases is not a hold',
     !parseHold('Do not release the lock until the keeper answers; see the release notes').held);
}

console.log('\nand a hold is a sentence, not a checkbox');
{
  const h = parseHold('Land the packet change\n\n' +
                      'Release-Hold: the matching keeper change is not landed; this alone logs out t9\n');
  ok('a well-formed hold is held', h.held && !h.malformed);
  ok('and the reason is carried, because the refusal quotes it',
     h.reason === 'the matching keeper change is not landed; this alone logs out t9', h.reason);

  ok('case and spacing do not matter',
     parseHold('release-hold:   still waiting on the schema').reason === 'still waiting on the schema');
  ok('the other obvious spelling works too',
     parseHold('Do-Not-Release: half a protocol change').held);
  ok('flush left is what counts',
     parseHold('subject\n\nRelease-Hold: written at column 0, the way git reads a trailer').held);
  ok('the first well-formed reason wins over a later bare one',
     parseHold('Release-Hold: the real reason\nRelease-Hold:').reason === 'the real reason');
}

console.log('\nreaching for it and missing REFUSES — the asymmetry');
{
  for (const [label, msg] of [
    ['a bare trailer with no reason', 'subject\n\nRelease-Hold:'],
    ['no colon at all', 'subject\n\nRelease-Hold'],
    ['a space instead of a hyphen', 'subject\n\nRelease Hold:'],
    ['underscored', 'subject\n\nrelease_hold:   '],
  ]) {
    const h = parseHold(msg);
    ok(label + ' is held', h.held);
    ok(label + ' is reported as malformed, not as a decision', h.malformed);
  }
  // THE DIRECTION THAT MATTERS. If any of the above were read as consent, the commit ships.
  ok('none of those parse as releasable',
     ['subject\n\nRelease-Hold:', 'subject\n\nRelease Hold:'].every(m => parseHold(m).held));
}

console.log('\nan EXAMPLE is not a decision — the commit that held itself');
{
  // THIS HAPPENED, TEN MINUTES AFTER THE FEATURE LANDED. The commit introducing holds quoted the
  // trailer in its own message to explain it, and `--verify` immediately refused to release that
  // commit — correctly, by the rule as written. Left alone, every commit that documents this
  // would block itself, and a refusal that fires on a healthy tree is one people learn to type
  // past, which is the failure this entire file exists to avoid.
  //
  // Git's own convention settles it: a trailer is flush left. Somebody holding a commit writes
  // it at column 0; somebody quoting it indents or fences it, without being taught to.
  ok('an indented example does not hold the commit',
     !parseHold('subject\n\n    Release-Hold: the keeper half is not landed\n').held);
  ok('nor does a tab-indented one',
     !parseHold('subject\n\n\tRelease-Hold: quoted in a mail reply').held);
  ok('nor one inside a fenced block',
     !parseHold('subject\n\n```\nRelease-Hold: shown as an example\n```\n').held);
  // The real one, in the same message as the example, must still win.
  ok('a real flush-left hold alongside an indented example still holds',
     parseHold('subject\n\n    Release-Hold: an example\n\nRelease-Hold: the actual reason\n')
       .reason === 'the actual reason');
  // And the prose case from above must not have regressed while fixing this.
  ok('prose is still not a hold',
     !parseHold('Do not release the lock until the keeper answers').held);
}

console.log('\nover a range of commits');
{
  const range = [
    { sha: 'aaaaaaaaaaaa', subject: 'ordinary work', body: 'nothing to see' },
    { sha: 'bbbbbbbbbbbb', subject: 'the held one', body: 'Release-Hold: schema migration is on another branch' },
    { sha: 'cccccccccccc', subject: 'more ordinary work', body: '' },
    { sha: 'dddddddddddd', subject: 'the typo', body: 'Release-Hold' },
  ];
  const holds = holdsIn(range);
  ok('only the ones that say so are held', holds.length === 2, String(holds.length));
  ok('shas are shortened for a refusal line', holds[0].sha === 'aaaaaaaaa'.slice(0, 0) + 'bbbbbbbbb',
     holds[0].sha);
  ok('an empty range holds nothing', holdsIn([]).length === 0);
  ok('an undefined range does not throw', holdsIn(undefined).length === 0);

  const said = holdRefusals(holds);
  ok('a refusal QUOTES the reason, so the next person can act on it',
     said[0].includes('schema migration is on another branch'), said[0].slice(0, 70));
  ok('and names the commit', said[0].includes('bbbbbbbbb'));
  // Two different sentences on purpose: one is somebody's decision, the other is a mistake.
  ok('a malformed hold gets a DIFFERENT sentence, about fixing the message',
     said[1].includes('gives no reason') && said[1].includes('amend'), said[1].slice(0, 70));
  ok('the decision sentence says the rest is pre-authorised',
     said[0].includes('pre-authorised'));
}

console.log('\na hold written in the subject still counts');
{
  // A parser that only honours a well-placed trailer is one that ignores the message on a
  // technicality — and the person who wrote it believes they have stopped the release.
  ok('subject line is searched too',
     holdsIn([{ sha: 'e'.repeat(12), subject: 'Release-Hold: do not ship, mid-refactor', body: '' }]).length === 1);
}

console.log('\nthe tool is wired to this module rather than keeping its own copy');
{
  const src = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('./m59-deploy.mjs', import.meta.url), 'utf8'));
  ok('m59-deploy.mjs imports it', /from '\.\/m59-release-consent\.mjs'/.test(src));
  ok('and refuses on holds', /holdRefusals\(s\.holds\)/.test(src));
  // The sentence that caused the deadlock must not still be PRINTED. It survives in a comment
  // on purpose -- naming the incident is why the refusals here do not get deleted by the next
  // person in a hurry -- so strip the comments before looking.
  const code = src.split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
  ok('and no longer tells anyone to go and find the author',
     !/usually somebody else/.test(code));
  ok('the refusal says the opposite instead',
     /needs no author/.test(code) && /sign-off/.test(code));
  ok('--push exists, and checks holds before pushing',
     /doPush/.test(src) && /refusing to push/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
