#!/usr/bin/env node
// AHEAD BY HASH IS NOT AHEAD BY WORK — offline, no git, no socket, no roster:
//
//   node tools/m59-deploy-drift-test.mjs
//
// WHAT THIS PINS. `m59-deploy.mjs --verify` is the thing standing between a `--cut` and burying
// somebody's work, and on 2026-09-11 it announced:
//
//   * prod is 37 commit(s) AHEAD of main. A deploy is never ahead of the trunk — that work
//     is stranded until somebody notices and adopts it by hand.
//
// Nothing was stranded. Prod was 2 commits ahead of `origin/main`, both cherry-equivalent to
// commits already pushed; the 37 came from comparing against the LOCAL `main` ref, which was
// itself a partly-duplicated line 46 commits behind origin. `rev-list --left-right` answers
// "does prod hold a commit OBJECT this ref cannot reach", and on a machine where several
// sessions rebase the same work onto origin at once, that comes apart from "does prod hold a
// CHANGE nothing else holds" every single day — always in the direction that cries wolf.
//
// A refusal that fires on a healthy tree daily is a refusal people learn to type past, and the
// next real one reads identically. So the check has to be able to come down, which means asking
// `git cherry` about patches and asking BOTH refs when they disagree.
//
// The decision is a pure function here rather than inline in the tool because m59-deploy.mjs
// RUNS ON IMPORT — same reason `nextDeployTag` was carved out after it cut a rollback that
// rolled forward. `cherry` is injected, so every case below is a fixture and none of them can
// reach this machine's git.
import { strandedCommits } from './m59-deploy-drift.mjs';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
};
const eq = (label, got, want) =>
  ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);

// `git cherry` output: one line per commit, `- <sha>` when the base already has an equivalent
// change and `+ <sha>` when it does not.
const cherryFrom = (table) => (base, head) =>
  Object.prototype.hasOwnProperty.call(table, base) ? table[base] : null;

console.log('\nthe false alarm that prompted this');
{
  // The measured shape: prod ahead of the local ref by 37 commits, every one of them a change
  // origin already carries under another hash.
  const got = strandedCommits({
    prodHead: 'prod', trunkHead: 'localmain', trunkRef: 'main', remoteRef: 'origin/main',
    cherry: cherryFrom({
      localmain: ['a', 'b'].map(s => `+ ${s}`).join('\n'),   // the local line cannot see them
      'origin/main': '- a\n- b',                             // but origin has both changes
    }),
  });
  eq('a rebase elsewhere strands nothing', got, []);
}

console.log('\nand the emergency it must still raise');
{
  const got = strandedCommits({
    prodHead: 'prod', trunkHead: 'localmain', trunkRef: 'main', remoteRef: 'origin/main',
    cherry: cherryFrom({ localmain: '+ a\n+ b', 'origin/main': '- a\n+ b' }),
  });
  // `b` is on NEITHER ref. That is a change that exists only in the production worktree, and it
  // dies the moment somebody checks out the next tag.
  eq('a change missing from both refs is stranded', got, ['b']);

  eq('and so is every one of them when origin has none',
     strandedCommits({
       prodHead: 'prod', trunkHead: 'localmain', trunkRef: 'main', remoteRef: 'origin/main',
       cherry: cherryFrom({ localmain: '+ a\n+ b', 'origin/main': '+ a\n+ b' }),
     }), ['a', 'b']);
}

console.log('\none ref, or two names for one ref');
{
  eq('no remote at all: the local ref is the whole trunk',
     strandedCommits({ prodHead: 'prod', trunkHead: 'main', trunkRef: 'main', remoteRef: null,
                       cherry: cherryFrom({ main: '+ a' }) }), ['a']);
  // `resolveTrunk` returns ref 'origin/main' when the local branch is stale or absent. Asking
  // the same ref twice and intersecting would be harmless but pointless; asserting it here
  // because the SHORTCUT is what keeps a second identical git call off every --verify.
  eq('trunkRef already IS origin: not consulted twice',
     strandedCommits({ prodHead: 'prod', trunkHead: 'x', trunkRef: 'origin/main',
                       remoteRef: 'origin/main', cherry: cherryFrom({ x: '+ a' }) }), ['a']);
  eq('nothing ahead by patch, single ref',
     strandedCommits({ prodHead: 'prod', trunkHead: 'main', trunkRef: 'main', remoteRef: null,
                       cherry: cherryFrom({ main: '- a\n- b' }) }), []);
}

console.log('\nand what it does when it CANNOT say');
{
  // THE RULE FROM docs/m59-git-process.md: a guarantee that cannot be evaluated refuses. It does
  // not quietly pass. Breaking it is how the pre-commit hook sat inert for an afternoon while
  // reporting nothing wrong — an inert guard and a satisfied one look identical from outside.
  eq('git cherry could not run: null, never []',
     strandedCommits({ prodHead: 'prod', trunkHead: 'main', trunkRef: 'main', remoteRef: null,
                       cherry: () => null }), null);

  // The second opinion failing must not CLEAR the first one's finding.
  eq('origin unreadable leaves the alarm where it was',
     strandedCommits({
       prodHead: 'prod', trunkHead: 'localmain', trunkRef: 'main', remoteRef: 'origin/main',
       cherry: cherryFrom({ localmain: '+ a\n+ b' }),   // origin/main absent -> null
     }), ['a', 'b']);
}

console.log('\nparsing what git actually prints');
{
  eq('blank lines and trailing newline do not become commits',
     strandedCommits({ prodHead: 'prod', trunkHead: 'main', trunkRef: 'main', remoteRef: null,
                       cherry: () => '+ a\n\n- b\n' }), ['a']);
  eq('empty output is "nothing stranded", not "cannot say"',
     strandedCommits({ prodHead: 'prod', trunkHead: 'main', trunkRef: 'main', remoteRef: null,
                       cherry: () => '' }), []);
  // A `-` sha must never be read as stranded: that is the whole false alarm, inverted.
  eq('every line a minus: nothing stranded',
     strandedCommits({ prodHead: 'prod', trunkHead: 'main', trunkRef: 'main', remoteRef: null,
                       cherry: () => '- a\n- b\n- c' }), []);
}

console.log('\nand a patch-id is STILL a hash, so subjects get the last word');
{
  // MEASURED AN HOUR AFTER THE FIRST FIX. `git cherry` compares patch-ids, and a patch rebased
  // onto different surrounding lines has a different patch-id -- so a commit that landed hours
  // ago still reads `+`. Seven commits sat only on local `main`, cherry called all seven
  // missing, and comparing SUBJECTS against origin (rule 5's own prescription, from the night 27
  // of 29 turned out to be duplicates) showed FIVE were already there. Cherry-picking the first
  // hit a conflict, which is what re-landing a landed change looks like from the inside.
  const seen = new Set(['a', 'c']);
  eq('a rebased commit whose subject is already on origin is not stranded',
     strandedCommits({
       prodHead: 'prod', trunkHead: 'main', trunkRef: 'main', remoteRef: null,
       cherry: cherryFrom({ main: '+ a\n+ b\n+ c' }),
       subjectSeen: (sha) => seen.has(sha),
     }), ['b']);

  // IT ONLY EVER NARROWS. A subject nobody has seen cannot ADD a commit to the list, and the
  // refs above still decide what is a candidate at all.
  eq('it cannot widen: a commit cherry called present stays off the list',
     strandedCommits({
       prodHead: 'prod', trunkHead: 'main', trunkRef: 'main', remoteRef: null,
       cherry: cherryFrom({ main: '- a\n- b' }),
       subjectSeen: () => false,
     }), []);

  // `null` = cannot say. Same rule as everywhere else here: it does not clear the alarm.
  eq('an unevaluable subject check leaves the commit stranded',
     strandedCommits({
       prodHead: 'prod', trunkHead: 'main', trunkRef: 'main', remoteRef: null,
       cherry: cherryFrom({ main: '+ a' }),
       subjectSeen: () => null,
     }), ['a']);

  eq('omitting it entirely behaves exactly as before',
     strandedCommits({
       prodHead: 'prod', trunkHead: 'main', trunkRef: 'main', remoteRef: null,
       cherry: cherryFrom({ main: '+ a' }),
     }), ['a']);

  // And it applies after the two-ref intersection, not instead of it.
  eq('it narrows the result of the both-refs intersection too',
     strandedCommits({
       prodHead: 'prod', trunkHead: 'localmain', trunkRef: 'main', remoteRef: 'origin/main',
       cherry: cherryFrom({ localmain: '+ a\n+ b', 'origin/main': '+ a\n+ b' }),
       subjectSeen: (sha) => sha === 'a',
     }), ['b']);
}

console.log('\nthe tool is wired to this module rather than keeping its own copy');
{
  const src = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('./m59-deploy.mjs', import.meta.url), 'utf8'));
  ok('m59-deploy.mjs imports it', /from '\.\/m59-deploy-drift\.mjs'/.test(src));
  ok('and calls it', /strandedCommits\(\{/.test(src));
  ok('and no longer counts raw rev-list output as stranded work',
     !/prod is \$\{s\.ahead\} commit\(s\) AHEAD/.test(src));
  // A second opinion nothing calls is not a second opinion.
  ok('and the subject second opinion is actually connected', /subjectSeen:/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
