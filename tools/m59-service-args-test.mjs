#!/usr/bin/env node
// m59-service.mjs REFUSES A FLAG IT DOES NOT READ. Offline: no socket, no broker, no roster.
//
//   node tools/m59-service-args-test.mjs
//
// 2026-10-31 19:52Z: `restart-keepers --fleet prod --only t17` was meant for one keeper.
// `--only` is not a flag, `arg('--agents')` answered null, and all 24 production keepers were
// handed off. 2026-10-21: `--help` was not a flag either, so a request for usage ran a restart.
//
// The decision is `checkServiceArgs` in m59-service-args.mjs, a pure function, exercised here
// directly. m59-service.mjs runs its main on import and its main talks to a broker, so it is
// READ AS SOURCE (as m59-prodwatch-test does) to pin that the check runs first and that every
// flag the service reads is one the check accepts.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkServiceArgs, serviceUsage, SERVICE_FLAGS, GOAP_FLAGS } from './m59-service-args.mjs';
import { RESTART_MODES } from './m59-keeper-restart.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};
const check = (s) => checkServiceArgs(s.split(' ').filter(Boolean));
const text = (r) => r.errors.join('\n');

console.log('the incident: --only is not a flag');
{
  const r = check('restart-keepers --fleet prod --only t17');
  ok('restart-keepers --only t17 is REFUSED', !r.ok && !r.help);
  ok('...naming the bad flag', /unknown flag --only/.test(text(r)), text(r));
  ok('...and suggesting --agents', /--only — did you mean --agents\?/.test(text(r)), text(r));
  ok('...listing what restart-keepers accepts', /restart-keepers accepts: .*--agents <a,b,\.\.\.>/.test(text(r)));
  ok('...and saying nothing was done', /nothing was done/.test(text(r)));
  ok('the word after it is refused too, not taken as the command', /unexpected argument "t17"/.test(text(r)));
  const good = check('restart-keepers --fleet prod --agents t17');
  ok('the flag that was meant, --agents t17, is accepted', good.ok && good.cmd === 'restart-keepers');
  ok('restart-keepers t17 (no flag at all) is refused, and points at --agents',
     !check('restart-keepers t17').ok && /--agents <name>/.test(text(check('restart-keepers t17'))));
}

console.log('\n--help is usage and nothing else');
{
  for (const s of ['--help', '-h', 'restart-keepers --help', 'restart -h --fleet prod',
                   'restart-keepers --fleet prod --only t17 --help', 'goap start --help'])
    ok(`"${s}" asks for help only`, check(s).ok && check(s).help === true && check(s).cmd === null);
  const u = serviceUsage();
  ok('usage names every subcommand',
     Object.keys(SERVICE_FLAGS).every(k => u.includes(`  ${k} `)) && Object.keys(GOAP_FLAGS).every(k => u.includes(`goap ${k}`)));
  ok('usage shows the agent filter by its real name', /restart-keepers +.*--agents <a,b,\.\.\.>/.test(u));
}

console.log('\nevery flag each subcommand reads is accepted');
{
  const sample = { '--fleet': 'prod', '--http': '8901', '--dashboard': '8902', '--agents': 't1,t2',
                   '--mode': 'handoff', '--concurrency': '2', '--lines': '80' };
  const withAll = (prefix, flags) => [...prefix, ...flags.flatMap(f => sample[f] ? [f, sample[f]] : [f])];
  for (const [cmd, flags] of Object.entries(SERVICE_FLAGS)) {
    for (const f of flags) {
      const r = checkServiceArgs([cmd, f, ...(sample[f] ? [sample[f]] : [])]);
      ok(`${cmd} ${f}`, r.ok && r.cmd === cmd && !r.goap, text(r));
    }
    const all = checkServiceArgs(withAll([cmd], flags));
    ok(`${cmd} with all of them at once`, all.ok, text(all));
  }
  for (const [cmd, flags] of Object.entries(GOAP_FLAGS)) {
    const r = checkServiceArgs(withAll(['goap', cmd], flags));
    ok(`goap ${cmd} ${flags.join(' ')}`, r.ok && r.goap && r.cmd === cmd, text(r));
  }
  ok('no command is status', check('').ok && check('').cmd === 'status' && check('--fleet prod').cmd === 'status');
  ok('bare goap is goap status', check('goap').ok && check('goap').goap && check('goap').cmd === 'status');
  ok('--fleet - (the unnamed fleet) is a value, not a flag', check('restart --fleet -').ok);
  ok('a flag value before the command is skipped, not read as the command',
     check('--fleet prod restart').cmd === 'restart' && check('--fleet prod restart').ok);
  ok('--lines 0 still means the whole log', check('logs --lines 0').ok);
  ok('every --mode RESTART_MODES knows is accepted, and only those',
     RESTART_MODES.every(m => check(`restart-keepers --mode ${m}`).ok) && !check('restart-keepers --mode logof').ok);
}

console.log('\nthe command lines other tools already send still pass');
{
  for (const s of [
    'restart --fleet -',                                                          // the broker's restart button
    'stop --fleet -',
    'start --fleet prod',                                                         // custody, setup, menagerie
    'start',
    'start --fleet shadow --http 8971 --dashboard 8972',                          // shadow-clone, flee-to-inns
    'start --fleet shadow --http 8971 --dashboard 8972 --no-resume --no-rejoin',  // shadow-run construction
    'stop --fleet shadow --http 8971 --dashboard 8972 --force',                   // shadow-clone, shadow-run
    'restart --fleet shadow --http 8971 --dashboard 8972',                        // shuttle-run, trace docs
    'restart --fleet prod --force',                                               // m59-update
    'restart-keepers --fleet prod',                                               // m59-deploy
    'start --http 8981 --dashboard 8982 --no-ui',                                 // lab-command example
    'start --staged --fleet prod', 'restart --cold --fleet prod', 'logs --fleet prod --lines 80 --follow',
    'status --fleet shadow --http 8971',
  ]) ok(s, check(s).ok, text(check(s)));
}

console.log('\nthe other ways a flag used to be silently dropped');
{
  const r1 = check('restart-keepers --fleet prod --cold');
  ok('a flag of another subcommand is refused and says whose it is',
     !r1.ok && /--cold is a flag of restart, not restart-keepers/.test(text(r1)), text(r1));
  ok('a near miss is suggested (--agnets)', /did you mean --agents\?/.test(text(check('restart-keepers --agnets t1'))));
  ok('--port suggests --http', /did you mean --http\?/.test(text(check('status --port 8903'))));
  const eq = check('restart-keepers --fleet=prod');
  ok('--fleet=prod is refused (arg() never read that form, so it meant the DEFAULT fleet)',
     !eq.ok && /write "--fleet prod"/.test(text(eq)), text(eq));
  ok('a flag given twice is refused (only the first was read)',
     !check('restart-keepers --agents t1 --agents t2').ok && /given twice/.test(text(check('restart-keepers --agents t1 --agents t2'))));
  ok('--agents with no value is refused (it used to mean everyone)',
     !check('restart-keepers --agents').ok && /--agents needs a value/.test(text(check('restart-keepers --agents'))));
  ok('--agents followed by another flag is refused, not read as an agent called --fleet',
     !check('restart-keepers --agents --fleet prod').ok);
  ok('--agents , names nobody and is refused', !check('restart-keepers --agents ,').ok &&
     /names nobody/.test(text(check('restart-keepers --agents ,'))));
  ok('a port that is not a number is refused', !check('stop --http abc').ok && !check('stop --dashboard 0').ok);
  ok('--concurrency 0 is refused', !check('restart-keepers --concurrency 0').ok);
  ok('a lone - is refused', !check('status -').ok);
  ok('an unknown flag on status is refused too (read-only is no excuse)', !check('status --verbose').ok);
  ok('logs does not read the ports, so it refuses them', !check('logs --http 8903').ok);
  ok('goap refuses a broker flag', !check('goap start --force').ok);
  const u = check('reboot');
  ok('an unknown command keeps its old wording', !u.ok && u.errors[0] === 'unknown command "reboot"', text(u));
  ok('...and goap too', check('goap reboot').errors[0] === 'unknown goap command "reboot"');
  ok('a stray word after the command is refused', !check('stop now').ok);
}

console.log('\nm59-service.mjs, read as source: the check runs first and covers what it reads');
{
  const src = readFileSync(join(HERE, 'm59-service.mjs'), 'utf8');
  const at = (re) => { const m = re.exec(src); return m ? m.index : -1; };
  const checkAt = at(/const ARGS = checkServiceArgs\(argv\);/);
  ok('the service calls checkServiceArgs(argv)', checkAt > 0);
  ok('...before it resolves a fleet', checkAt > 0 && checkAt < at(/fleetName\(argv\)/));
  ok('...before its first await', checkAt > 0 && checkAt < at(/\bawait\b/));
  ok('help exits 0 and a refusal exits non-zero, both before anything else',
     /if \(ARGS\.help\) \{ console\.log\(serviceUsage\(\)\); process\.exit\(0\); \}/.test(src) &&
     /if \(!ARGS\.ok\) \{[^}]*process\.exit\(2\); \}/.test(src));
  ok('the dispatch uses the checked command, not a second parse',
     /const cmd = ARGS\.cmd;/.test(src) && /const goapMode = ARGS\.goap;/.test(src) && !/argv\.find\(/.test(src));
  // Every flag the service reads must be accepted somewhere, or adding one to the service
  // and forgetting the table would make the new flag a refusal.
  const read = new Set(['--fleet']);   // via fleetName(argv)
  for (const m of src.matchAll(/(?:\barg|\bhas|process\.argv\.includes)\('(-[^']+)'/g)) read.add(m[1]);
  const known = new Set([...Object.values(SERVICE_FLAGS), ...Object.values(GOAP_FLAGS)].flat());
  const missing = [...read].filter(f => !known.has(f));
  ok(`every flag the service reads is accepted somewhere (${read.size} read)`, !missing.length, missing.join(' '));
  const unread = [...known].filter(f => !read.has(f));
  ok('and nothing is accepted that the service never reads', !unread.length, unread.join(' '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
