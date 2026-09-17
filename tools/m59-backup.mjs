#!/usr/bin/env node
// BACK UP THE THINGS THAT CANNOT BE REBUILT.
//
//   node tools/m59-backup.mjs                  back up to every configured destination
//   node tools/m59-backup.mjs --list           what backups exist, and where
//   node tools/m59-backup.mjs --credentials-only     rosters and shortcuts, nothing bulky
//   node tools/m59-backup.mjs --no-sheets      skip the live character export
//   node tools/m59-backup.mjs --to D:\somewhere      one destination, instead of the defaults
//   node tools/m59-backup.mjs --verify <path>  re-hash a backup against its own manifest
//
// WHAT IS ACTUALLY AT RISK HERE, IN ORDER.
//
// 1. THE ROSTERS ARE THE ONLY RECORD OF THE ACCOUNT PASSWORDS. `substrate/fleets/<name>.json`
//    and `substrate/fleet-state.json` are it. There is no password reset, no email on the
//    account, and no way to ask the server. Lose the file and the characters are gone —
//    not deleted, just permanently unreachable, still standing in the world. Every other
//    thing in this backup could be rebuilt with enough time. These cannot be rebuilt at all.
//
// 2. THE CHARACTER SHEETS ARE THE ONLY SNAPSHOT OF THE FLEET, because the checkpoint
//    mechanism does not cover `prod`. m59-shutdown.mjs copies the SERVER's savegame aside,
//    and prod's server is somebody else's machine — every connection is outbound and there
//    is nothing local to copy. Run against prod it copies a stale save from an unrelated
//    local install and reports success. See m59-sheet.mjs, which exists for this reason.
//
// 3. The derived records — abilities, banks, tougher, descriptions, history, postmortems.
//    Each is a long observation that cannot be backfilled: an ability book is built from
//    pushes nobody re-sends, a bank balance is prose an NPC said once, a max-health gain is
//    an announcement that arrives inside a killing blow. Losing them loses the evidence,
//    not the fleet.
//
// FOUR RULES THIS FILE ENFORCES RATHER THAN TRUSTS.
//
// * A BACKUP WITH NO ROSTER IN IT IS REFUSED. The failure that matters is not a crash — it
//   is a backup that runs nightly, reports success, and contains everything except the one
//   file nobody can regenerate. If no roster was found, that is an error, not a warning.
// * NOTHING IS WRITTEN INSIDE THE REPOSITORY. A destination under the repo root is refused
//   outright: it would either be committed (plaintext passwords in git, permanently) or
//   gitignored and then deleted by the next clean.
// * WHAT WAS WRITTEN IS READ BACK. Every file is hashed on the way in and re-hashed from
//   the destination afterwards. A backup nobody has read is a hope, and the moment you
//   find out is the moment you needed it.
// * THE FILES ARE LOCKED DOWN. They carry plaintext passwords, so the backup directory is
//   restricted to the current user — icacls on Windows, 0700 elsewhere — exactly as
//   shortcuts/ and the rosters themselves already are.
//
// AND NOTHING FROM INSIDE A ROSTER IS EVER PRINTED. This tool reports counts, sizes and
// hashes. Anything that would put a password in a terminal, a log or a transcript is a bug.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const REPO = path.resolve(here('..'));

// WHERE BACKUPS GO. Two by default, on two different physical disks, because a backup on
// the same drive as the original protects against exactly one failure mode (somebody
// deleting the file) and not the one that takes the drive with it.
export const DEFAULT_DESTS = (process.env.M59_BACKUP_DIRS ||
  'C:\\m59\\backups;D:\\m59\\backups').split(/[;,]/).map(s => s.trim()).filter(Boolean);

// ------------------------------------------------------------------ what goes in
//
// Declared as data rather than as a sequence of copies, so `--list`, the manifest and the
// restore tool all read the same description of what a backup IS. A category added here
// shows up in all three.
//
// `required` is the flag that turns a quiet omission into a refusal.
export const CATEGORIES = [
  { key: 'credentials', required: true, bulky: false,
    what: 'THE ONLY RECORD OF THE ACCOUNT PASSWORDS — there is no reset and no way to ask ' +
          'the server. Everything else here can be rebuilt; this cannot.',
    entries: [
      { from: 'substrate/fleets', to: 'credentials/fleets', kind: 'dir', roster: true,
        note: 'one roster per named fleet' },
      { from: 'substrate/fleet-state.json', to: 'credentials/fleet-state.json', kind: 'file', roster: true,
        note: 'the unnamed fleet, as it always was' },
      { from: 'substrate/fleet-accounts.json', to: 'credentials/fleet-accounts.json', kind: 'file', roster: true,
        note: 'passwords for characters m59-makefleet.mjs created' },
      { from: 'substrate/fleet-default', to: 'credentials/fleet-default', kind: 'file',
        note: 'which fleet this checkout means when nothing says' },
      { from: 'shortcuts', to: 'credentials/shortcuts', kind: 'dir',
        note: 'click-to-play shortcuts — each one carries a password on a command line' },
    ] },
  { key: 'sheets', required: false, bulky: false,
    what: 'Every character as completely as a client can observe itself. The only snapshot ' +
          'of prod, whose server we do not run and cannot checkpoint.',
    entries: [{ from: 'substrate/sheets', to: 'sheets', kind: 'dir' }] },
  { key: 'records', required: false, bulky: false,
    what: 'The long observations. None can be backfilled — an ability book is built from ' +
          'pushes nobody re-sends, a balance is prose an NPC said once.',
    entries: [
      { from: 'substrate/abilities', to: 'records/abilities', kind: 'dir' },
      { from: 'substrate/banks', to: 'records/banks', kind: 'dir' },
      { from: 'substrate/tougher', to: 'records/tougher', kind: 'dir' },
      { from: 'substrate/descriptions', to: 'records/descriptions', kind: 'dir' },
      { from: 'substrate/safespots.json', to: 'records/safespots.json', kind: 'file' },
      { from: 'substrate/m59-safespots.json', to: 'records/m59-safespots.json', kind: 'file' },
    ] },
  { key: 'history', required: false, bulky: true,
    what: 'The ledger and the post mortems. Large, and the part most likely to be skipped ' +
          'on a fast backup — so it is its own category rather than a silent inclusion.',
    entries: [
      { from: 'substrate/history', to: 'history/history', kind: 'dir' },
      { from: 'substrate/postmortems', to: 'history/postmortems', kind: 'dir' },
      { from: 'substrate/hits', to: 'history/hits', kind: 'dir' },
    ] },
];

// ------------------------------------------------------------------ small helpers

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
export const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
const human = (n) => n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(0)}K` : `${(n / 1048576).toFixed(1)}M`;

// A destination inside the repository is refused, not corrected. Silently relocating it
// would put the backup somewhere the caller does not think it is; refusing says why.
export function checkDestination(dest, repo = REPO) {
  const abs = path.resolve(dest);
  const rel = path.relative(repo, abs);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)))
    throw new Error(`refusing to back up into the repository itself (${abs}). These files ` +
                    `carry plaintext passwords: inside the repo they are either committed ` +
                    `or gitignored and then deleted by the next clean. Pick a path outside ` +
                    `${repo}.`);
  return abs;
}

// A LOCK FILE IS NEVER WORTH BACKING UP AND IS ACTIVELY HARMFUL TO RESTORE.
//
// `substrate/fleets/prod.json.lock` sits beside the roster and names the PID that owns
// that fleet. Restored onto a machine where that pid means nothing — or means some other
// process — it is a stale claim on a fleet, and the broker's whole protection against two
// brokers holding one roster is that file. So it is excluded on the way IN, where it can
// be reasoned about once, rather than on the way out.
//
// It was also being counted as a roster, which is the worse half: the "refuse a backup
// with no roster in it" guard is the safety property of this tool, and a directory
// containing nothing but a lock file would have satisfied it.
const NEVER_BACKED_UP = /(^|[\\/])[^\\/]*\.lock$/i;

// Walk a file or directory into a flat list of {abs, rel} to copy. Directories recurse.
// `.prev` and `.rescue-*` copies of a roster ARE kept — they are additional copies of the
// only file that cannot be regenerated, which is exactly what a backup is for.
function collect(fromAbs, toRel) {
  const out = [];
  let st;
  try { st = fs.statSync(fromAbs); } catch { return out; }
  if (NEVER_BACKED_UP.test(fromAbs)) return out;
  if (st.isFile()) { out.push({ abs: fromAbs, rel: toRel, size: st.size }); return out; }
  if (!st.isDirectory()) return out;
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name), r = `${rel}/${e.name}`;
      if (NEVER_BACKED_UP.test(e.name)) continue;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) out.push({ abs, rel: r, size: fs.statSync(abs).size });
    }
  };
  walk(fromAbs, toRel);
  return out;
}

// PLAINTEXT PASSWORDS, SO THE DIRECTORY IS THE CURRENT USER'S AND NOBODY ELSE'S.
// Best-effort and reported rather than fatal: a backup that exists with loose permissions
// still beats no backup, but you should be told which you got.
function lockDown(dir) {
  try {
    if (process.platform === 'win32') {
      const who = process.env.USERNAME ? `${process.env.USERDOMAIN || os.hostname()}\\${process.env.USERNAME}` : null;
      if (!who) return 'no USERNAME in the environment — permissions left as inherited';
      // /inheritance:r drops inherited ACEs, so "Users" cannot read it afterwards.
      execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', `${who}:(OI)(CI)F`],
                   { stdio: 'pipe' });
      return `restricted to ${who}`;
    }
    fs.chmodSync(dir, 0o700);
    return 'mode 0700';
  } catch (e) { return `COULD NOT RESTRICT: ${e.message.split('\n')[0]}`; }
}

// The character export, refreshed before it is copied. Deliberately best-effort: it needs
// a live broker, and a backup that refuses to run because the fleet is down would be
// missing exactly when the rosters most need copying.
function refreshSheets() {
  const tool = path.join(REPO, 'tools', 'm59-sheet.mjs');
  if (!fs.existsSync(tool)) return { ran: false, why: 'm59-sheet.mjs is not in this checkout' };
  try {
    execFileSync(process.execPath, [tool, '--checkpoint'],
                 { windowsHide: true, cwd: REPO, stdio: 'pipe', timeout: 180_000 });
    return { ran: true };
  } catch (e) {
    // The usual cause is no broker. Say so plainly — the sheets already on disk are still
    // copied, they are just as old as the last time one was taken.
    return { ran: false, why: (e.stderr?.toString() || e.message).split('\n')[0].slice(0, 160) };
  }
}

const gitCommit = () => {
  try { return execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { windowsHide: true, stdio: 'pipe' })
    .toString().trim(); } catch { return null; }
};

// ------------------------------------------------------------------ the backup

export function planBackup({ categories = null, repo = REPO } = {}) {
  const want = categories ?? CATEGORIES.map(c => c.key);
  const files = [], missing = [], chosen = [];
  let rosters = 0;
  for (const cat of CATEGORIES) {
    if (!want.includes(cat.key)) continue;
    chosen.push(cat.key);
    for (const e of cat.entries) {
      const found = collect(path.join(repo, e.from), e.to);
      if (!found.length) { missing.push(e.from); continue; }
      if (e.roster) rosters += found.length;
      for (const f of found) files.push({ ...f, category: cat.key, roster: !!e.roster });
    }
  }
  return { files, missing, categories: chosen, rosters,
           bytes: files.reduce((t, f) => t + f.size, 0) };
}

export function runBackup({ dests = DEFAULT_DESTS, categories = null, refresh = true,
                            repo = REPO, now = new Date() } = {}) {
  const sheets = refresh && (categories ?? CATEGORIES.map(c => c.key)).includes('sheets')
    ? refreshSheets() : { ran: false, why: 'not requested' };

  const plan = planBackup({ categories, repo });

  // THE REFUSAL THAT MATTERS. A backup missing the rosters is worse than no backup,
  // because it looks like one — it would run nightly, report success, and be empty of the
  // only thing that cannot be rebuilt.
  if (!plan.rosters)
    throw new Error('REFUSING: no roster found under substrate/fleets/ or substrate/fleet-state.json. ' +
                    'Those files are the only record of the account passwords, and a backup ' +
                    'without them is not a backup. Check you are in the right checkout.');

  const name = `m59-backup-${stamp(now)}`;

  // READ EACH SOURCE ONCE AND WRITE THOSE SAME BYTES TO EVERY DESTINATION.
  //
  // The obvious shape — loop destinations, re-read the sources for each — is wrong on a
  // LIVE fleet, and the verify pass is what caught it. `substrate/hits/<name>.json` is
  // rewritten by the running broker every few seconds, so the second destination got
  // different bytes from the first while the manifest carried the first destination's
  // hash, and two files failed to verify on D: that were perfectly intact.
  //
  // Reading once also makes the copies mean what two copies should mean: byte-identical
  // snapshots of one moment, not two snapshots of two moments that happen to be nearby.
  // A file is held in memory only for as long as it takes to write it everywhere.
  const roots = dests.map(d => checkDestination(d, repo));
  const results = roots.map(root => ({ dest: root, dir: path.join(root, name),
                                       wrote: 0, bytes: 0, failed: [], verified: 0, mismatched: [] }));
  for (const r of results) {
    try { fs.mkdirSync(r.dir, { recursive: true }); }
    catch (e) { r.error = e.message; }
  }

  for (const f of plan.files) {
    let buf;
    try { buf = fs.readFileSync(f.abs); }
    catch (e) { for (const r of results) r.failed.push(`${f.rel}: ${e.message}`); continue; }
    // The size and hash of what was ACTUALLY read, not the stat taken when the plan was
    // built. On a live fleet those differ — the broker rewrites hits/ and the ledger
    // while this runs — and a manifest that describes the plan rather than the bytes is
    // a manifest a restore cannot check against.
    f.sha256 = sha256(buf);
    f.size = buf.length;
    for (const r of results) {
      if (r.error) continue;
      const target = path.join(r.dir, ...f.rel.split('/'));
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buf);
        r.wrote++; r.bytes += buf.length;
      } catch (e) { r.failed.push(`${f.rel}: ${e.message}`); }
    }
  }

  for (const r of results) {
    const dir = r.dir;
    if (r.error) continue;
    try {

      const manifest = {
        _what: 'A backup of the m59-harness fleet: the account rosters (which are the ONLY ' +
               'record of the passwords), the character export, and the records that cannot ' +
               'be backfilled. Restore with tools/m59-restore.mjs.',
        _warning: 'THIS DIRECTORY CONTAINS PLAINTEXT ACCOUNT PASSWORDS. Do not commit it, ' +
                  'do not put it on shared storage, do not paste its contents.',
        version: 1,
        at: now.toISOString(),
        host: os.hostname(),
        repo,
        git_commit: gitCommit(),
        categories: plan.categories,
        sheets_refreshed: sheets.ran,
        ...(sheets.ran ? {} : { sheets_not_refreshed_because: sheets.why }),
        rosters: plan.rosters,
        counts: { files: r.wrote, bytes: r.bytes },
        missing: plan.missing,
        // Hash per file, so a restore can prove the bytes it is about to put back are the
        // bytes that were taken. A backup nobody can verify is a backup nobody should trust.
        files: plan.files.map(f => ({ path: f.rel, size: f.size, sha256: f.sha256,
                                      category: f.category, ...(f.roster ? { roster: true } : {}) })),
      };
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1));

      // READ IT BACK. Everything above proves we issued writes; this proves the bytes
      // arrived. The two are not the same on a removable disk or a full one.
      for (const f of manifest.files) {
        const target = path.join(dir, ...f.path.split('/'));
        try {
          if (sha256(fs.readFileSync(target)) === f.sha256) r.verified++;
          else r.mismatched.push(f.path);
        } catch (e) { r.mismatched.push(`${f.path}: ${e.message}`); }
      }
      r.permissions = lockDown(dir);
      r.ok = r.failed.length === 0 && r.mismatched.length === 0;
    } catch (e) {
      r.ok = false; r.error = e.message;
    }
  }

  return { name, plan, sheets, results,
           ok: results.some(r => r.ok), all_ok: results.every(r => r.ok) };
}

// Every backup at a destination, newest first. Reads each manifest, so a directory that
// is not a backup is simply not listed.
export function listBackups(dests = DEFAULT_DESTS) {
  const out = [];
  for (const dest of dests) {
    let names = [];
    try { names = fs.readdirSync(dest); } catch { continue; }
    for (const n of names) {
      const m = path.join(dest, n, 'manifest.json');
      try {
        const j = JSON.parse(fs.readFileSync(m, 'utf8'));
        out.push({ dir: path.join(dest, n), dest, name: n, at: j.at, rosters: j.rosters,
                   files: j.counts?.files ?? j.files?.length ?? 0, bytes: j.counts?.bytes ?? 0,
                   categories: j.categories ?? [], git_commit: j.git_commit ?? null });
      } catch { /* not a backup, or half-written */ }
    }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// Re-hash a backup against its own manifest. The answer to "is the thing on that disk
// still what it says it is", which is worth asking before you need it rather than after.
export function verifyBackup(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const bad = [], missing = [];
  let ok = 0;
  for (const f of manifest.files || []) {
    const target = path.join(dir, ...f.path.split('/'));
    let buf;
    try { buf = fs.readFileSync(target); } catch { missing.push(f.path); continue; }
    if (sha256(buf) === f.sha256) ok++; else bad.push(f.path);
  }
  return { dir, at: manifest.at, checked: (manifest.files || []).length, ok, bad, missing,
           intact: bad.length === 0 && missing.length === 0, manifest };
}

// ---------------------------------------------------------------------- the CLI

const isMain = process.argv[1] &&
  path.basename(process.argv[1]) === 'm59-backup.mjs';

if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes('--' + n);
  const many = (n) => argv.reduce((acc, a, i) => (a === '--' + n && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);

  const dests = many('to').length ? many('to') : DEFAULT_DESTS;

  if (flag('list')) {
    const rows = listBackups(dests);
    if (!rows.length) {
      console.log(`no backups under ${dests.join(' or ')}`);
      console.log('make one with: node tools/m59-backup.mjs');
      process.exit(0);
    }
    console.log('when                      files    size  rosters  categories                dir');
    for (const b of rows)
      console.log(`${String(b.at).slice(0, 19).replace('T', ' ')}  ${String(b.files).padStart(6)}  ` +
                  `${human(b.bytes).padStart(6)}  ${String(b.rosters).padStart(7)}  ` +
                  `${b.categories.join(',').padEnd(24)}  ${b.dir}`);
    console.log(`\n${rows.length} backup(s) across ${new Set(rows.map(r => r.dest)).size} destination(s).`);
    console.log('Restore one with: node tools/m59-restore.mjs --from <dir>');
    process.exit(0);
  }

  if (flag('verify')) {
    const dir = argv[argv.indexOf('--verify') + 1];
    if (!dir) { console.error('usage: --verify <backup directory>'); process.exit(1); }
    const v = verifyBackup(dir);
    console.log(`${v.dir}\n  taken ${v.at}\n  ${v.ok} of ${v.checked} file(s) match their recorded hash`);
    if (v.bad.length) console.log(`  ${v.bad.length} CHANGED: ${v.bad.slice(0, 8).join(', ')}`);
    if (v.missing.length) console.log(`  ${v.missing.length} MISSING: ${v.missing.slice(0, 8).join(', ')}`);
    console.log(v.intact ? '  intact' : '  NOT INTACT — do not rely on this one');
    process.exit(v.intact ? 0 : 1);
  }

  const categories = flag('credentials-only') ? ['credentials']
    : CATEGORIES.map(c => c.key).filter(k => !(k === 'sheets' && flag('no-sheets'))
                                          && !(k === 'history' && flag('no-history')));

  console.log(`backing up [${categories.join(', ')}] to:`);
  for (const d of dests) console.log(`  ${d}`);

  let out;
  try { out = runBackup({ dests, categories }); }
  catch (e) { console.error('\n' + e.message); process.exit(1); }

  if (!out.sheets.ran && categories.includes('sheets'))
    console.log(`\nnote: the character export was NOT refreshed (${out.sheets.why}).\n` +
                `      The sheets already on disk are copied regardless — they are just as\n` +
                `      old as the last time one was taken. Start the broker and re-run to\n` +
                `      capture the fleet as it is now.`);

  console.log(`\n${out.name}`);
  for (const r of out.results) {
    if (r.error) { console.log(`  FAILED  ${r.dest}\n          ${r.error}`); continue; }
    console.log(`  ${r.ok ? 'ok    ' : 'PROBLEM'}  ${r.dir}`);
    console.log(`          ${r.wrote} file(s), ${human(r.bytes)}, ${r.verified} verified by hash`);
    console.log(`          ${r.permissions}`);
    if (r.failed.length) console.log(`          ${r.failed.length} FAILED TO COPY: ${r.failed.slice(0, 4).join('; ')}`);
    if (r.mismatched.length) console.log(`          ${r.mismatched.length} DID NOT VERIFY: ${r.mismatched.slice(0, 4).join('; ')}`);
  }
  if (out.plan.missing.length)
    console.log(`\n  not present in this checkout (fine — not every fleet has every file):\n` +
                `    ${out.plan.missing.join(', ')}`);

  console.log(`\n${out.plan.rosters} roster file(s) backed up — those are the only record of the ` +
              `account passwords.`);
  console.log('THESE DIRECTORIES HOLD PLAINTEXT PASSWORDS. Do not commit them, do not sync them ' +
              'to shared storage.');
  if (!out.all_ok) {
    console.error('\nAt least one destination did not come out clean. Read the lines above ' +
                  'before treating this as backed up.');
    process.exit(1);
  }
  process.exit(0);
}
