// WHAT m59-service.mjs WILL ACCEPT ON ITS COMMAND LINE, AS A PURE FUNCTION.
//
//   import { checkServiceArgs, serviceUsage } from './m59-service-args.mjs';
//   checkServiceArgs(['restart-keepers', '--fleet', 'prod', '--only', 't17'])
//   // -> { ok: false, errors: ['... unknown flag --only — did you mean --agents? ...'] }
//
// A FLAG THE SERVICE DOES NOT KNOW IS A REFUSAL, NOT A NO-OP. The service reads its argv with
// `arg('--agents')` and `has('--cold')`, which answer "not given" for anything they were not
// asked about — so a misspelt filter silently becomes NO filter, and every command here acts on
// a whole fleet.
//
//   * 2026-10-31 19:52Z: `restart-keepers --fleet prod --only t17`, meant for one keeper.
//     `--only` is not a flag (the filter is `--agents`), so it was ignored, the agent list was
//     null, and all 24 production keepers were handed off.
//   * 2026-10-21: `--help`, which nothing read, so a request for usage ran a real restart.
//
// So every subcommand lists the flags it actually reads, and anything else — an unknown flag,
// a flag given twice, a value-flag with no value, a stray word (`restart-keepers t17` is the
// same mistake without the dashes) — is refused before m59-service.mjs resolves a fleet, let
// alone touches one. `--help` / `-h` prints usage and does nothing else.
//
// Its own module, and import-safe, so the test can exercise it without loading the service:
// m59-service.mjs runs its main on import, and its main talks to a live broker.

// Flags that take a value, and what the value has to be. Everything else is a switch.
const VALUE_FLAGS = {
  '--fleet':       { hint: '<name>' },               // `-` is the unnamed fleet, on purpose
  '--http':        { hint: '<port>', int: [1, 65535] },
  '--dashboard':   { hint: '<port>', int: [1, 65535] },
  // An EMPTY list is the dangerous case: restartKeepers reads `agents: []` as "everyone".
  '--agents':      { hint: '<a,b,...>', list: true },
  // The same three as RESTART_MODES in m59-keeper-restart.mjs (the test pins that). Its own
  // reading of an unrecognised mode is a warning and `auto`, which is too late to be a refusal.
  '--mode':        { hint: '<auto|handoff|logoff>', oneOf: ['auto', 'handoff', 'logoff'] },
  '--concurrency': { hint: '<n>', int: [1, 1000] },
  '--lines':       { hint: '<n>', int: [0, 1e9] },  // 0 has always meant "the whole log"
};

// WHAT EACH SUBCOMMAND READS, read off m59-service.mjs rather than guessed. `restart` carries
// `start`'s flags because a cold restart (or a broker too old for the handover) ends in cmdStart.
const START = ['--fleet', '--http', '--dashboard', '--no-ui', '--require-map', '--in-process',
               '--no-resume', '--no-rejoin', '--staged'];
export const SERVICE_FLAGS = Object.freeze({
  'start':           START,
  'stop':            ['--fleet', '--http', '--dashboard', '--no-ui', '--force'],
  'restart':         [...START, '--cold', '--force'],
  'restart-keepers': ['--fleet', '--http', '--agents', '--mode', '--concurrency'],
  'status':          ['--fleet', '--http', '--dashboard'],
  'logs':            ['--fleet', '--lines', '--follow'],
});
export const GOAP_FLAGS = Object.freeze({
  'start':   ['--fleet'],
  'stop':    ['--fleet'],
  'restart': ['--fleet'],
  'status':  ['--fleet'],
  'logs':    ['--fleet', '--lines', '--follow'],
});

const HELP = ['--help', '-h'];

// Words people reach for. Only suggested when the target is a flag of the command at hand.
const ALIASES = {
  '--only': '--agents', '--agent': '--agents', '--keeper': '--agents', '--keepers': '--agents',
  '--who': '--agents', '--port': '--http', '--rpc': '--http', '--dash': '--dashboard',
  '--tail': '--lines', '-n': '--lines', '-f': '--follow',
};

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

const show = (f) => VALUE_FLAGS[f] ? `${f} ${VALUE_FLAGS[f].hint}` : f;
const label = (goap, cmd) => (goap ? `goap ${cmd}` : cmd);

function suggest(flag, accepted, goap, cmd) {
  const eq = flag.indexOf('=');
  if (eq > 0 && accepted.includes(flag.slice(0, eq)))
    return `write "${flag.slice(0, eq)} ${flag.slice(eq + 1)}" — a "=" form is not read`;
  const alias = ALIASES[flag];
  if (alias && accepted.includes(alias)) return `did you mean ${alias}?`;
  const near = accepted.map(f => [f, distance(flag, f)]).filter(([, n]) => n <= 2).sort((x, y) => x[1] - y[1]);
  if (near.length) return `did you mean ${near[0][0]}?`;
  const table = goap ? GOAP_FLAGS : SERVICE_FLAGS;
  const elsewhere = Object.keys(table).filter(k => table[k].includes(flag));
  if (elsewhere.length)
    return `${flag} is a flag of ${elsewhere.map(k => label(goap, k)).join(', ')}, not ${label(goap, cmd)}`;
  return null;
}

// -> { ok, help, goap, cmd, errors: [string] }. Never throws, never reads anything but argv.
export function checkServiceArgs(argv) {
  argv = (argv ?? []).map(String);
  if (argv.some(a => HELP.includes(a))) return { ok: true, help: true, goap: false, cmd: null, errors: [] };

  // Walk once, letting a value-flag consume its value, so `--fleet prod` is never a word.
  const positional = [], flags = [], problems = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('-')) { positional.push(a); continue; }
    if (VALUE_FLAGS[a]) {
      const v = argv[i + 1];
      if (v == null || v.startsWith('--')) { flags.push({ flag: a, missing: true }); continue; }
      flags.push({ flag: a, value: v }); i++;
      continue;
    }
    flags.push({ flag: a });
  }

  const goap = positional[0] === 'goap';
  const words = goap ? positional.slice(1) : positional;
  const cmd = words[0] ?? 'status';
  const table = goap ? GOAP_FLAGS : SERVICE_FLAGS;
  const usageLine = goap
    ? 'usage: m59-service.mjs goap start|stop|restart|status|logs [--fleet <name>]'
    : 'usage: m59-service.mjs start|stop|restart|restart-keepers|status|logs [--fleet <name>]';
  if (!Object.hasOwn(table, cmd))
    return { ok: false, help: false, goap, cmd,
             errors: [goap ? `unknown goap command "${cmd}"` : `unknown command "${cmd}"`, usageLine] };

  const accepted = table[cmd];
  const seen = new Set();
  for (const { flag, value, missing } of flags) {
    if (!accepted.includes(flag)) {
      const hint = suggest(flag, accepted, goap, cmd);
      problems.push(`unknown flag ${flag}${hint ? ` — ${hint}` : ''}`);
      continue;
    }
    if (seen.has(flag)) { problems.push(`${flag} given twice — only the first would be read`); continue; }
    seen.add(flag);
    const spec = VALUE_FLAGS[flag];
    if (!spec) continue;
    if (missing) { problems.push(`${flag} needs a value: ${show(flag)}`); continue; }
    if (spec.int) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < spec.int[0] || n > spec.int[1])
        problems.push(`${flag} ${value} is not a whole number from ${spec.int[0]} to ${spec.int[1]}`);
    } else if (spec.list) {
      if (!value.split(',').map(x => x.trim()).filter(Boolean).length)
        problems.push(`${flag} "${value}" names nobody — an empty list would mean every keeper`);
    } else if (spec.oneOf && !spec.oneOf.includes(value.trim().toLowerCase())) {
      problems.push(`${flag} ${value} is not one of ${spec.oneOf.join(', ')}`);
    }
  }
  for (const w of words.slice(1))
    problems.push(`unexpected argument "${w}" — ${label(goap, cmd)} takes no words after the command` +
                  (accepted.includes('--agents') ? ' (one keeper is --agents <name>)' : ''));
  if (!problems.length) return { ok: true, help: false, goap, cmd, errors: [] };
  return { ok: false, help: false, goap, cmd, errors: [
    `m59-service: refusing ${label(goap, cmd)}; nothing was done.`,
    ...problems.map(p => `  ${p}`),
    `  ${label(goap, cmd)} accepts: ${accepted.map(show).join('  ')}`,
    '  node tools/m59-service.mjs --help for usage.',
  ] };
}

export function serviceUsage() {
  const lines = ['usage: node tools/m59-service.mjs <command> [flags]', ''];
  for (const [cmd, flags] of Object.entries(SERVICE_FLAGS))
    lines.push(`  ${cmd.padEnd(16)} ${flags.map(show).join('  ')}`);
  lines.push('');
  for (const [cmd, flags] of Object.entries(GOAP_FLAGS))
    lines.push(`  goap ${cmd.padEnd(11)} ${flags.map(show).join('  ')}`);
  lines.push('', 'No command means status. Any other flag or word is refused before anything acts;',
             '--help / -h prints this and does nothing else.');
  return lines.join('\n');
}
