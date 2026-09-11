// WHICH CHECKOUT CLAIMS WHICH KEEPER PORTS, AND WHO IS ACTUALLY ANSWERING ON THEM.
//
//   node tools/m59-bands.mjs              every band registry on this machine, collisions first
//   node tools/m59-bands.mjs --json       the same, for a launcher
//   node tools/m59-bands.mjs --no-probe   paper only: read the files, open no socket
//
// WHY THIS EXISTS. `substrate/keeper-bands.json` is per-checkout and gitignored, so each
// checkout's registry is authoritative for itself and INVISIBLE TO EVERY OTHER ONE. Two
// checkouts can therefore assign the same 100-port band and neither can tell. That is not a
// hypothetical: on 2026-09-11 a lab worktree's `shadow-ab` and the deploy's `prod` both held
// 9011, shadow-ab's keepers spawned onto 9011-9031, prod's 23 keepers were displaced, and
// `m59-which` reported "nothing is holding a fleet" while ports 9013/9022/9028 answered as
// three of prod's characters.
//
// `allocateKeeperBand` DOES take a lock before it writes — and the lock is inside the same
// `substrate/` as the registry it guards, so it is exactly as per-checkout as the file. This
// is the run-lock flaw (CLAUDE.md, "BUT THAT LOCK DOES NOT SPAN CHECKOUTS") wearing a
// different hat, and it is worse: the run lock's failure is a refused start, and this one's is
// one fleet's broker commanding another fleet's characters.
//
// WHAT IT WILL NOT DO. It allocates nothing, writes nothing, and starts no broker — a tool
// that repaired a collision would have to decide which fleet moves, and that decision belongs
// to whoever is watching the fleet that goes down. It names the two files and the ports.
//
// It prints AGENT SLOTS and never character names, following `m59-fleets.mjs`: the rosters it
// walks past are the credential store, and a keeper's `/live` tuple carries the character.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import { KEEPER_BAND_WIDTH } from './runtime/keeper-bands.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_LEAF = join('substrate', 'keeper-bands.json');

/** A band is 100 ports wide, so a base names exactly `base .. base + 99`. */
export const bandOf = (base) => ({ base, end: base + KEEPER_BAND_WIDTH - 1 });

/**
 * Normalise one registry file into claims. The on-disk shape is the legacy
 * `{ "fleet-name": numericBase }`; anything else in it is reported rather than dropped,
 * because a key that silently does nothing is how a setting stays broken for a year.
 */
export function claimsFrom(registry, json) {
  const claims = [], rejected = [];
  for (const [fleet, base] of Object.entries(json ?? {})) {
    const n = Number(base);
    if (!Number.isSafeInteger(n) || n < 1 || n + KEEPER_BAND_WIDTH - 1 > 65535) {
      rejected.push({ registry, fleet, value: base });
      continue;
    }
    claims.push({ registry, fleet, ...bandOf(n) });
  }
  claims.sort((a, b) => a.base - b.base || a.fleet.localeCompare(b.fleet));
  return { claims, rejected };
}

/** Two bands overlap when neither ends before the other begins. */
export const overlaps = (a, b) => a.base <= b.end && b.base <= a.end;

/**
 * Collisions BETWEEN REGISTRIES only, and there are exactly TWO KINDS. Getting this wrong
 * buries the finding: the first cut of this tool reported every pair, and `boscontrol` sitting
 * at 9311 in five checkouts produced ten "collisions" that were five checkouts AGREEING.
 *
 *   CONTENTION   — two DIFFERENT fleets over the same ports. This is the outage: two brokers
 *                  spawn keepers into one range and the loser's broker commands the winner's
 *                  characters. `prod` 9011 against `shadow-ab` 9011, 2026-09-11.
 *   DISAGREEMENT — ONE fleet name with different bands in different checkouts. Nothing
 *                  collides on the wire, but "the prod keepers" means different ports
 *                  depending on which directory you ran the command from, and the checkout
 *                  holding the stale number addresses whoever else is down there.
 *
 * The same fleet at the same base in many checkouts is agreement and is reported as neither.
 */
export function collisions(claims) {
  const out = [];
  const byFleet = new Map();
  for (const c of claims) {
    if (!byFleet.has(c.fleet)) byFleet.set(c.fleet, []);
    byFleet.get(c.fleet).push(c);
  }

  // DISAGREEMENT: one name, more than one base.
  for (const [fleet, list] of byFleet) {
    const bases = [...new Set(list.map(c => c.base))];
    if (bases.length < 2) continue;
    out.push({ kind: 'DISAGREEMENT', fleet, claims: list.slice().sort((a, b) => a.base - b.base),
               from: Math.min(...bases), to: Math.max(...bases) + KEEPER_BAND_WIDTH - 1 });
  }

  // CONTENTION: different names, overlapping ports, in different files. Grouped by the
  // contested range so one conflict is one row however many checkouts hold a copy of it.
  const groups = new Map();
  for (let i = 0; i < claims.length; i++)
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i], b = claims[j];
      if (a.fleet === b.fleet || a.registry === b.registry || !overlaps(a, b)) continue;
      const from = Math.max(a.base, b.base), to = Math.min(a.end, b.end);
      const key = `${from}-${to}:${[a.fleet, b.fleet].sort().join('|')}`;
      if (!groups.has(key)) groups.set(key, { kind: 'CONTENTION', from, to, claims: [] });
      for (const c of [a, b])
        if (!groups.get(key).claims.some(x => x.registry === c.registry && x.fleet === c.fleet))
          groups.get(key).claims.push(c);
    }
  out.push(...groups.values());
  return out.sort((x, y) => x.from - y.from || x.kind.localeCompare(y.kind));
}

/**
 * A collision is PAPER until something answers inside the contested range. Once a keeper is
 * there it is LIVE, and the agent slots say whose it is — which is the whole question, because
 * a broker that lost a port guesses one and commands whoever is on it.
 */
export function verdict(collision, occupants) {
  const bands = collision.kind === 'CONTENTION'
    ? [{ base: collision.from, end: collision.to }]
    : collision.claims.map(c => ({ base: c.base, end: c.end }));
  const inside = occupants.filter(o => bands.some(b => o.port >= b.base && o.port <= b.end));
  if (!inside.length) return { verdict: `${collision.kind} (on paper)`, occupants: [], slots: [] };
  const slots = [...new Set(inside.map(o => o.agent))];
  return { verdict: `${collision.kind} — LIVE`, occupants: inside, slots };
}

/** Every worktree of this repository, plus this checkout, plus anything named on the CLI. */
export function discoverCheckouts(extra = []) {
  const roots = new Set([REPO, ...extra.map(p => resolve(p))]);
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'],
                             { cwd: REPO, encoding: 'utf8', timeout: 30_000 });
    for (const line of out.split(/\r?\n/))
      if (line.startsWith('worktree ')) roots.add(resolve(line.slice(9).trim()));
  } catch { /* not a git tree, or git is unavailable: the CLI roots still stand */ }
  return [...roots].sort();
}

export function readRegistries(checkouts) {
  const found = [], missing = [];
  for (const root of checkouts) {
    const path = join(root, REGISTRY_LEAF);
    if (!existsSync(path)) { missing.push(root); continue; }
    try {
      found.push({ checkout: root, registry: path, json: JSON.parse(readFileSync(path, 'utf8')) });
    } catch (e) {
      found.push({ checkout: root, registry: path, json: null, error: String(e?.message ?? e) });
    }
  }
  return { found, missing };
}

/**
 * Ask a port who is on it. Deliberately NOT `probeKeeperLive`, which returns null for an agent
 * the caller did not expect — here the stranger IS the finding.
 */
export async function probePort(port, { timeoutMs = 1200 } = {}) {
  for (const path of ['/live', '/health']) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: ctl.signal });
      if (!r.ok) continue;
      const j = await r.json();
      const agent = j?.agent ?? j?.name ?? null;
      if (!agent) continue;
      // The character NAME is deliberately dropped here and never returned.
      return { port, agent: String(agent), pid: Number(j?.pid) || null,
               in_game: j?.in_game === true, source: path };
    } catch { /* silence is a question, not an answer */ } finally { clearTimeout(t); }
  }
  return null;
}

export async function probeRange(from, to, opts = {}) {
  const ports = [];
  for (let p = from; p <= to; p++) ports.push(p);
  const seen = [];
  // Small fixed fan-out: a contested range is 100 ports and this runs on an operator's machine
  // while a fleet is possibly already in trouble.
  const width = 16;
  for (let i = 0; i < ports.length; i += width) {
    const batch = await Promise.all(ports.slice(i, i + width).map(p => probePort(p, opts)));
    for (const r of batch) if (r) seen.push(r);
  }
  return seen;
}

async function main(argv) {
  const json = argv.includes('--json');
  const probe = !argv.includes('--no-probe');
  const extra = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--root' && argv[i + 1]) extra.push(argv[++i]);

  const { found, missing } = readRegistries(discoverCheckouts(extra));
  const all = [], rejected = [], broken = [];
  for (const f of found) {
    if (f.json == null) { broken.push(f); continue; }
    const { claims, rejected: bad } = claimsFrom(f.registry, f.json);
    all.push(...claims); rejected.push(...bad);
  }
  const hits = collisions(all);

  const decided = [];
  const scanned = new Map();                      // port range -> occupants, probed once
  for (const c of hits) {
    const ranges = c.kind === 'CONTENTION'
      ? [[c.from, c.to]]
      : c.claims.map(x => [x.base, x.end]);
    const occ = [];
    for (const [from, to] of ranges) {
      const key = `${from}-${to}`;
      if (!scanned.has(key)) scanned.set(key, probe ? await probeRange(from, to) : []);
      for (const o of scanned.get(key)) if (!occ.some(x => x.port === o.port)) occ.push(o);
    }
    decided.push({ ...c, ...verdict(c, occ), probed: probe });
  }

  if (json) {
    console.log(JSON.stringify({ registries: found.map(f => ({ checkout: f.checkout, registry: f.registry,
      claims: f.json ? claimsFrom(f.registry, f.json).claims : null, error: f.error ?? null })),
      collisions: decided, rejected, checkouts_without_a_registry: missing.length }, null, 2));
    return decided.some(d => d.verdict.endsWith('LIVE')) ? 1 : 0;
  }

  console.log(`${found.length} band registr${found.length === 1 ? 'y' : 'ies'} on this machine ` +
              `(${missing.length} checkout(s) have none), ${all.length} claim(s)\n`);
  for (const f of found) {
    const rel = f.checkout === REPO ? `${f.checkout}   <- this checkout` : f.checkout;
    if (f.json == null) { console.log(`  ${rel}\n      UNREADABLE: ${f.error}`); continue; }
    const { claims } = claimsFrom(f.registry, f.json);
    console.log(`  ${rel}`);
    for (const c of claims) console.log(`      ${String(c.base).padStart(5)}-${c.end}  ${c.fleet}`);
  }

  if (!decided.length) {
    console.log(`\nEvery registry that names a fleet agrees with every other on its band.`);
    return 0;
  }

  const live = decided.filter(d => d.verdict.endsWith('LIVE'));
  console.log(`\n${decided.length} conflict(s), ${live.length} of them LIVE. No lock spans these files:\n`);
  for (const d of decided) {
    const head = d.kind === 'CONTENTION'
      ? `ports ${d.from}-${d.to} claimed by ${[...new Set(d.claims.map(c => c.fleet))].join(' and ')}`
      : `fleet "${d.fleet}" has ${new Set(d.claims.map(c => c.base)).size} different bands`;
    console.log(`  ${d.verdict}  —  ${head}`);
    for (const c of d.claims)
      console.log(`      ${String(c.base).padStart(5)}-${c.end}  "${c.fleet}"   ${c.registry}` +
                  (c.registry.startsWith(REPO) ? '   <- this checkout' : ''));
    if (!d.probed) { console.log(`      (not probed)`); continue; }
    if (!d.occupants.length) { console.log(`      nothing is answering on those ports.`); continue; }
    console.log(`      ANSWERING NOW: ${d.occupants.length} keeper(s) — slots ${d.slots.slice(0, 8).join(', ')}` +
                (d.slots.length > 8 ? ` (+${d.slots.length - 8})` : ''));
    for (const o of d.occupants.slice(0, 4))
      console.log(`        ${o.port}  agent ${o.agent}  pid ${o.pid ?? '?'}${o.in_game ? '  in game' : ''}`);
    if (d.occupants.length > 4) console.log(`        ... and ${d.occupants.length - 4} more`);
    if (d.kind === 'DISAGREEMENT')
      console.log(`      A command for "${d.fleet}" addresses different ports depending on the\n` +
                  `      directory you ran it from. The checkout holding the stale number reaches\n` +
                  `      whoever else is on those ports.`);
  }
  for (const r of rejected)
    console.log(`\n  unusable base ${JSON.stringify(r.value)} for "${r.fleet}" in ${r.registry}`);
  console.log(`\nWhoever moves must edit their OWN substrate/keeper-bands.json and restart that\n` +
              `broker. This tool changes nothing: which fleet moves is a decision for whoever is\n` +
              `watching the one that would go down.`);
  return decided.some(d => d.verdict.endsWith('LIVE')) ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1]?.endsWith(`${sep}m59-bands.mjs`)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
