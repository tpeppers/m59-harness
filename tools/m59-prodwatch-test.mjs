#!/usr/bin/env node
// THE OUTAGE ALARM, AND THE BUG THAT MADE ONE NECESSARY. Offline: no socket, no broker,
// no roster.
//
//   node tools/m59-prodwatch-test.mjs
//
// Two halves, and they are the two halves of one incident on 2026-09-16.
//
//   * `m59-service.mjs stop --fleet shadow-ab --http 8903` quiesced PRODUCTION, because
//     `--http` moved the port that is CHECKED and `--dashboard` kept its own separate
//     default of 8902, which is the port that is OBEYED. Every line it printed named the
//     lab broker. Twenty-three characters stood still for twenty-five minutes.
//   * Nothing noticed. The only reason anybody found out was an unrelated command failing
//     with ECONNREFUSED, and in-game penalties land at ten minutes.
//
// So: pin the port pairing and the identity check by reading the source (m59-service.mjs
// runs its main on import, so it cannot be imported — the same reason m59-loadout-test
// reads m59-broker.mjs as text), and pin the alarm's decision as a pure function.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verdict, DEFAULT_ALERT_MS, DEFAULT_PENALTY_MS } from './m59-prodwatch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const ROSTER = process.platform === 'win32' ? 'C:\\repo\\substrate\\fleets\\prod.json'
                                            : '/repo/substrate/fleets/prod.json';
const upHealth = { ok: true, state: ROSTER, fleet: 'prod', pid: 4580 };

console.log('what counts as up');
{
  ok('a broker holding OUR roster file is up', verdict({ health: upHealth, roster: ROSTER }).up);
  ok('...and the same path in a different case or shape still counts',
     verdict({ health: { ok: true, state: ROSTER.toUpperCase() }, roster: ROSTER }).up);

  // THE LABEL PROVES NOTHING. Two checkouts can each hold a fleet called "prod".
  const other = ROSTER.replace('repo', 'other-checkout');
  const v = verdict({ health: { ok: true, state: other, fleet: 'prod' }, roster: ROSTER });
  ok('A BROKER CALLING ITSELF "prod" WHILE HOLDING ANOTHER ROSTER IS NOT OUR FLEET UP',
     !v.up && v.state === 'foreign');
  ok('...and it says whose roster it found, so the next step is obvious', v.holder === other);

  ok('a broker that answers without ok is down', verdict({ health: { ok: false }, roster: ROSTER }).state === 'down');
}

console.log('\nsilence is an alarm here, not a question');
{
  const v = verdict({ health: null, roster: ROSTER });
  ok('nothing answering counts as DOWN for the clock', !v.up);
  // m59-which.mjs answers INDETERMINATE and stops, because guessing the wrong fleet is worse
  // than refusing. This tool is asked whether anybody is driving, where a missed outage costs
  // in-game penalties — so it leans the other way, and keeps the distinction in the label.
  ok('...but it is reported as `unreachable`, not `down`, so the distinction survives',
     v.state === 'unreachable');
}

console.log('\nthe clock, and the ten-minute line');
{
  const t0 = 1_000_000;
  const fresh = verdict({ health: null, roster: ROSTER, downSince: null, now: t0 });
  ok('the first failed check starts the clock at now', fresh.down_since === t0 && fresh.down_for_ms === 0);
  ok('and does not alarm immediately', !fresh.alert && !fresh.penalty);

  const carried = (ms) => verdict({ health: null, roster: ROSTER, downSince: t0, now: t0 + ms });
  ok('the clock is CARRIED between checks, or a cron job never reaches three minutes',
     carried(60_000).down_for_ms === 60_000 && carried(60_000).down_since === t0);
  ok('under three minutes is quiet', !carried(DEFAULT_ALERT_MS - 1).alert);
  ok('THREE MINUTES ALERTS — a third of the budget, with time left to act',
     carried(DEFAULT_ALERT_MS).alert && !carried(DEFAULT_ALERT_MS).penalty);
  ok('TEN MINUTES IS WHERE THE GAME STARTS CHARGING US', carried(DEFAULT_PENALTY_MS).penalty);
  ok('and before that it counts down to it, rather than only saying "down"',
     carried(DEFAULT_ALERT_MS).penalty_in_ms === DEFAULT_PENALTY_MS - DEFAULT_ALERT_MS);

  ok('coming back up clears the clock', verdict({ health: upHealth, roster: ROSTER, downSince: t0, now: t0 + 9e5 }).down_since === null);
}

console.log('\nthe bug that caused the outage — m59-service.mjs, read as source');
{
  const src = readFileSync(join(HERE, 'm59-service.mjs'), 'utf8');

  // THE ONE LINE. `--http` must carry the dashboard with it, or the port that is checked and
  // the port that is obeyed come apart, which is exactly what happened.
  ok('THE DASHBOARD DEFAULT FOLLOWS THE RPC PORT, so --http alone cannot split them',
     /--dashboard'?\s*,\s*HTTP_PORT\s*\+\s*1/.test(src),
     'a literal 8902 default here is the prod outage of 2026-09-16');
  ok('...and the ordinary pairing is unchanged: no --http still means 8901/8902',
     /--http'?\s*,\s*8901/.test(src));

  // And the belt to that pair of braces: even on a non-adjacent pair, do not quiesce a
  // dashboard that names a different process than the broker we verified.
  ok('the quiesce target is checked against the broker that was identified',
     /dashboard on \$\{DASH_PORT\} belongs to pid/.test(src) &&
     /Number\(dashId\.pid\)\s*!==\s*Number\(found\.pid\)/.test(src));
  ok('a dashboard too old to say whose it is is allowed through with a word, not refused',
     /does not say whose it is/.test(src));
  // Match the CALL SITE, not the first mention: the incident is described in a comment at
  // the top of that file, so `indexOf('/control/quiesce')` finds the prose and the ordering
  // assertion passes or fails for the wrong reason.
  ok('the refusal happens BEFORE the quiesce is actually sent',
     src.indexOf('belongs to pid') < src.search(/http:\/\/127\.0\.0\.1:\$\{DASH_PORT\}\/control\/quiesce/));
}

console.log('\nand the half that lets that check exist — m59-broker.mjs dashboard /health');
{
  const src = readFileSync(join(HERE, 'm59-broker.mjs'), 'utf8');
  ok('the dashboard reports the identity triple, not just {ok, view, readonly}',
     /view: 'dashboard', readonly: true,\s*\n\s*pid: id\.pid, fleet: id\.fleet/.test(src));
  ok('...taken from brokerHealth(), so there is one answer to "which broker is this"',
     /const id = brokerHealth\(\);/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
