#!/usr/bin/env node
// LEND A CHARACTER BY ITS PASSWORD, AND TAKE IT BACK WHEN YOU COME HOME.
//
//   node tools/m59-rotate.mjs plan    t1                     # what would happen. Changes nothing
//   node tools/m59-rotate.mjs lend    t1 --for 6h --apply    # rotate to a temporary password
//   node tools/m59-rotate.mjs reclaim t1 --apply             # bump the borrower, rotate back
//   node tools/m59-rotate.mjs secure  t1 --apply             # replace a known password with a generated one
//   node tools/m59-rotate.mjs list                           # what is currently lent, and until when
//   node tools/m59-rotate.mjs due --apply                    # reclaim everything past its deadline
//
// THE OTHER HALF OF `m59-handoff.mjs`, AND THE OPPOSITE TRADE.
//
// A grant keeps the socket here and hands out authority: the borrower never holds a
// credential, revocation is total, and my broker must stay up for them to play at all.
// This hands out a CREDENTIAL instead. The borrower logs in themselves, so they keep
// playing when this machine sleeps — and that is the whole point — but they hold a working
// password for the window, and there is no protocol-level way to stop them changing it.
//
// Reclaim works because Meridian allows ONE CONNECTION PER CHARACTER: logging in bumps
// whoever is on. So coming home is "log in, then immediately rotate back", and the borrower
// is off the moment the login lands.
//
// THE REAL PASSWORD NEVER LEAVES THIS MACHINE. What is handed over is a temporary one, and
// `--for` writes down when it stops being yours to forget about.
//
// WHY THE WRITE ORDER IS THE WHOLE DESIGN.
//
// The roster is the ONLY record of an account's password — no reset, no email, nothing to
// ask the server. So the dangerous moment is not the network call, it is the gap between
// "the server accepted the change" and "the new password reached the disk". A crash there
// loses the character permanently.
//
// So this never holds one password in its hand. It writes a PENDING record carrying BOTH
// the old and the new before it sends anything, and collapses it only after the server has
// confirmed. Crash at any instant and the file names both candidates, and one of them
// works. `list` reports a stuck pending record as exactly that.
//
// AND THE RUNNING BROKER IS A SECOND WRITER. It rewrites the roster from its own memory
// (see the resume notes in CLAUDE.md), so a change written only to disk gets overwritten by
// the old password minutes later, and the fleet then cannot log in at all. Every rotation
// therefore ends by telling the broker through `join`, which both proves the new password
// works and puts it in the memory the broker saves from.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { M59Client } from './m59-client.mjs';
import { fleetName, stateFileFor } from './m59-fleetpath.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'list';
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);
const APPLY = has('--apply');
const BROKER = Number(arg('--broker-port', process.env.M59_BROKER_PORT || 8901));

// fleetName takes the argv ARRAY. Same resolution order as every other fleet tool:
// --fleet, then M59_FLEET, then substrate/fleet-default.
const FLEET = fleetName(argv);
const ROSTER = stateFileFor(FLEET);

const readRoster = () => JSON.parse(readFileSync(ROSTER, 'utf8'));
// The roster is the only copy. Write it whole, and never from a partial view.
const writeRoster = (r) => writeFileSync(ROSTER, JSON.stringify(r, null, 2), { mode: 0o600 });

// Pronounceable enough to read down a voice call, long enough not to be guessed. Meridian
// passwords are compared as an MD5 of the bytes, so the alphabet only has to survive being
// typed and pasted.
const tempPassword = () =>
  'lend-' + randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);

function parseDuration(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*(m|h|d)?$/i);
  if (!m) return null;
  const mult = { m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] || 'h').toLowerCase()];
  const ms = Number(m[1]) * mult;
  return ms > 0 ? ms : null;
}

const brokerCall = (name, args) => fetch(`http://127.0.0.1:${BROKER}/`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
}).then(r => r.json()).then(j => { try { return JSON.parse(j.result.content[0].text); } catch { return {}; } });

// THE BROKER ON THIS PORT MUST BE HOLDING THE FLEET WE ARE ROTATING.
//
// Not a formality. `--broker-port` defaults to 8901, which on this machine is prod, while
// `--fleet` may name something else entirely — so rotating a test fleet would have called
// `join` on the PROD broker with a foreign account and quietly added a stranger's session
// to the live fleet. The broker reports the roster path it holds; compare against the one
// we are editing, which is the same identity check m59-which.mjs makes and for the same
// reason: passing the wrong fleet operates on the wrong fleet, silently.
const norm = (p) => String(p || '').split('\\').join('/').toLowerCase();
const sameFile = (a, b) => norm(a) === norm(b);

const brokerHoldsThisFleet = async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${BROKER}/health`, { signal: AbortSignal.timeout(2500) });
    const h = await r.json();
    if (h?.ok !== true) return { up: false };
    if (!sameFile(h.state, ROSTER))
      return { up: true, mine: false, holding: h.state };
    return { up: true, mine: true };
  } catch { return { up: false }; }
};

/**
 * Change the password on the server, with the roster written safely around it.
 *
 * `from` is what the account currently uses; `to` is what it should use next. Both are on
 * disk together for the whole flight, so no crash can leave a character unreachable.
 */
async function rotate(agent, from, to, { lentTo = null, revertAt = null } = {}) {
  const roster = readRoster();
  const entry = roster[agent];
  if (!entry?.credentials) throw new Error(`no such agent ${agent} in ${ROSTER}`);
  const c = entry.credentials;

  // ---- 1. PENDING FIRST. Both passwords on disk before a single byte goes out.
  c.pending_password = to;
  c.rotation = { state: 'pending', started_at: Date.now(), from_kind: lentTo ? 'own' : 'temporary',
                 lent_to: lentTo, revert_at: revertAt };
  writeRoster(roster);
  console.log('  roster: pending record written (both passwords on disk)');

  // ---- 2. The change itself, on a connection of our own. This BUMPS the broker's session
  // for this character — one connection per character — which is expected and is also how
  // `reclaim` throws the borrower off.
  const client = new M59Client({ host: c.host, port: c.port });
  let accepted = false;
  try {
    await client.login(c.account, from);
    accepted = await client.changePassword(from, to);
  } finally {
    try { client.close?.(); client.sock?.destroy?.(); } catch { /* best effort */ }
  }
  if (!accepted) {
    // The server said no. The account still uses `from`, so drop the pending record and
    // leave the roster exactly as it was.
    const back = readRoster();
    delete back[agent].credentials.pending_password;
    delete back[agent].credentials.rotation;
    writeRoster(back);
    throw new Error('the server refused the password change — nothing was altered');
  }
  console.log('  server: password changed (PASSWORD_OK)');

  // ---- 3. COMMIT. The account uses `to` from here on; keep the old one under `previous`
  // for one cycle, because a rotation that is wrong is discovered by trying the other one.
  const after = readRoster();
  const ac = after[agent].credentials;
  ac.previous_password = from;
  ac.password = to;
  delete ac.pending_password;
  ac.rotation = { state: 'done', at: Date.now(), lent_to: lentTo, revert_at: revertAt };
  writeRoster(after);
  console.log(`  roster: committed${revertAt ? `, revert due ${new Date(revertAt).toISOString().slice(0, 16)}` : ''}`);

  // ---- 4. TELL THE BROKER, which is the second writer and would otherwise overwrite the
  // file from memory with the old password. This also proves the new one actually works.
  const b = await brokerHoldsThisFleet();
  if (b.up && !b.mine) {
    console.log(`  broker: the one on ${BROKER} holds ${b.holding}, NOT this fleet — not telling it.`);
    console.log('          Point --broker-port at the broker for this fleet, or restart it,');
    console.log('          or it will overwrite the roster from memory with the old password.');
  } else if (b.up) {
    const j = await brokerCall('join', { agent, account: c.account, password: to,
                                         character: c.character, host: c.host, port: c.port });
    const ok = !j?.error && (j?.room || j?.character || j?.note);
    console.log(`  broker: ${ok ? 'rejoined on the new password' : `could not rejoin — ${JSON.stringify(j).slice(0, 120)}`}`);
    if (!ok) console.log('  NOTE: the password IS changed. Both values are in the roster; ' +
                         'restart the broker if it will not take the new one.');
  } else {
    console.log('  broker: not running — nothing to tell. It will read the roster on next start.');
  }
  return true;
}

function lentRows() {
  const roster = readRoster();
  return Object.entries(roster)
    .map(([agent, e]) => ({ agent, c: e?.credentials ?? {} }))
    .filter(x => x.c.rotation && (x.c.rotation.lent_to || x.c.rotation.state === 'pending'));
}

// ---------------------------------------------------------------------------

if (cmd === 'list') {
  const rows = lentRows();
  console.log(`fleet ${FLEET} — ${ROSTER}`);
  if (!rows.length) { console.log('nothing is lent. Every character uses its own password.'); process.exit(0); }
  for (const { agent, c } of rows) {
    const r = c.rotation;
    const due = r.revert_at ? new Date(r.revert_at).toISOString().slice(0, 16) : '—';
    const overdue = r.revert_at && Date.now() > r.revert_at;
    console.log(`${agent.padEnd(5)} ${String(c.character ?? '?').padEnd(9)} ` +
                `${String(r.state).padEnd(8)} to=${String(r.lent_to ?? '—').padEnd(14)} ` +
                `revert ${due}${overdue ? '  ** OVERDUE **' : ''}`);
    if (r.state === 'pending')
      console.log('      PENDING — a rotation did not finish. Both passwords are on disk; ' +
                  'try each with `plan` before doing anything else.');
  }

} else if (cmd === 'plan') {
  const agent = argv[1];
  const roster = readRoster();
  const c = roster[agent]?.credentials;
  if (!c) { console.error(`no such agent ${agent}`); process.exit(2); }
  console.log(`fleet ${FLEET}, agent ${agent} (${c.character ?? '?'}) on ${c.host}:${c.port}`);
  console.log(`  account            ${c.account}`);
  console.log(`  password           ${'*'.repeat(8)} (never printed, never leaves this machine)`);
  console.log(`  previous on file   ${c.previous_password ? 'yes' : 'no'}`);
  console.log(`  rotation           ${c.rotation ? JSON.stringify(c.rotation) : 'none — not lent'}`);
  const pb = await brokerHoldsThisFleet();
  console.log(`  broker on ${BROKER}      ${!pb.up ? 'down' : pb.mine ? 'holds this fleet (will be told via join)'
    : `HOLDS ANOTHER FLEET (${pb.holding}) — will not be told`}`);
  console.log('\nlend    rotates to a fresh temporary password and prints it ONCE');
  console.log('reclaim logs in on the temporary password, bumping the borrower, and rotates back');

} else if (cmd === 'secure') {
  // TURN A KNOWN PASSWORD INTO ONE NOBODY HAS SEEN.
  //
  // `lend` and `reclaim` are about handing a credential out and taking it back. This is the
  // other reason to rotate: an account arrived with a password somebody typed into a chat
  // window, an issue, or an agent transcript — `hk1/hk1` — and it should not stay that way.
  // It is the same crash-safe write order, without the lending bookkeeping.
  //
  // THE NEW PASSWORD IS NEVER PRINTED AND NEVER TAKEN ON THE COMMAND LINE. It is generated
  // here, written to the roster (which is the only place it will ever exist), and the
  // account is left holding it. That is the operator's "standard proper form": a command
  // line is readable by every process on the machine and lands in shell history and in the
  // transcript of whatever agent ran it.
  const agent = argv[1];
  const roster = readRoster();
  const c = roster[agent]?.credentials;
  if (!c) { console.error(`no such agent ${agent} in ${ROSTER}`); process.exit(2); }
  if (c.rotation?.lent_to) {
    console.error(`${agent} is lent to "${c.rotation.lent_to}" — reclaim it before securing it.`);
    process.exit(2);
  }
  const to = tempPassword();
  if (!APPLY) {
    console.log(`would secure ${agent} (${c.character}) on ${c.host}:${c.port}`);
    console.log('  rotate to a freshly generated password, recorded ONLY in the roster');
    console.log(`  roster: ${ROSTER}`);
    console.log('  the new password is never printed and never passed on a command line');
    console.log('\nnothing was changed. Add --apply.');
    process.exit(0);
  }
  console.log(`securing ${agent} (${c.character})`);
  await rotate(agent, c.password, to);
  console.log(`\n  account   ${c.account}`);
  console.log('  password  <generated; written to the roster, not shown>');
  console.log(`  roster    ${ROSTER}`);
  console.log('\nThat file is the ONLY record of it — there is no reset and no email on the');
  console.log('account. The previous password is kept under `previous_password` for one cycle,');
  console.log('because a rotation that went wrong is discovered by trying the other one.');

} else if (cmd === 'lend') {
  const agent = argv[1];
  const roster = readRoster();
  const c = roster[agent]?.credentials;
  if (!c) { console.error(`no such agent ${agent}`); process.exit(2); }
  if (c.rotation?.lent_to) {
    console.error(`${agent} is already lent to "${c.rotation.lent_to}". Reclaim it first.`);
    process.exit(2);
  }
  const forMs = parseDuration(arg('--for'));
  if (arg('--for') && forMs === null) { console.error('--for wants 6h, 90m, 2d'); process.exit(2); }
  const to = arg('--to-password') || tempPassword();
  const who = arg('--to', 'a borrower');
  const revertAt = forMs ? Date.now() + forMs : null;

  if (!APPLY) {
    console.log(`would lend ${agent} (${c.character}) to "${who}"`);
    console.log(`  rotate to a fresh temporary password${forMs ? `, reverting after ${arg('--for')}` : ', with NO deadline'}`);
    console.log(`  the borrower connects with account ${c.account} and that password`);
    if (!forMs) console.log('  consider --for: without it nothing takes the character back on its own');
    console.log('\nnothing was changed. Add --apply.');
    process.exit(0);
  }
  console.log(`lending ${agent} (${c.character}) to "${who}"`);
  await rotate(agent, c.password, to, { lentTo: who, revertAt });
  console.log(`\n  account   ${c.account}`);
  console.log(`  password  ${to}`);
  console.log(`  server    ${c.host}:${c.port}`);
  console.log('\nThat is a TEMPORARY password. Your real one never left this machine.');
  console.log(`Take it back with:  node tools/m59-rotate.mjs reclaim ${agent} --apply`);
  console.log('Reclaiming logs in, which bumps them off — one connection per character.');
  if (revertAt) console.log(`Deadline recorded. \`m59-rotate.mjs due --apply\` reclaims anything past it.`);

} else if (cmd === 'reclaim') {
  const agent = argv[1];
  const roster = readRoster();
  const c = roster[agent]?.credentials;
  if (!c) { console.error(`no such agent ${agent}`); process.exit(2); }
  if (!c.rotation?.lent_to && !has('--force')) {
    console.error(`${agent} is not marked as lent. --force to rotate anyway.`);
    process.exit(2);
  }
  const back = arg('--to-password') || tempPassword();
  if (!APPLY) {
    console.log(`would reclaim ${agent} (${c.character}) from "${c.rotation?.lent_to ?? '?'}"`);
    console.log('  log in on the current password — this bumps the borrower off');
    console.log('  then rotate immediately to a fresh password they have never seen');
    console.log('\nnothing was changed. Add --apply.');
    process.exit(0);
  }
  console.log(`reclaiming ${agent} (${c.character})`);
  try {
    // A FRESH password, not the old one. They saw the lent value; anything they have seen
    // is burned, and reusing the original would hand it back to them for next time.
    await rotate(agent, c.password, back, { lentTo: null, revertAt: null });
    const done = readRoster();
    delete done[agent].credentials.rotation;
    writeRoster(done);
    console.log('\nreclaimed. The borrower is off and their password is dead.');
  } catch (e) {
    console.error(`\nRECLAIM FAILED: ${e.message}`);
    console.error('If the login was REJECTED, they changed the password and the account is');
    console.error('gone — there is no reset and no email. That is the risk this trade carries.');
    process.exit(1);
  }

} else if (cmd === 'due') {
  const rows = lentRows().filter(({ c }) => c.rotation?.revert_at && Date.now() > c.rotation.revert_at);
  if (!rows.length) { console.log('nothing is overdue.'); process.exit(0); }
  console.log(`${rows.length} overdue:`);
  for (const { agent, c } of rows) console.log(`  ${agent} (${c.character}) lent to ${c.rotation.lent_to}`);
  if (!APPLY) { console.log('\nnothing was changed. Add --apply to reclaim them.'); process.exit(0); }
  for (const { agent, c } of rows) {
    console.log(`\nreclaiming ${agent}`);
    try {
      await rotate(agent, c.password, tempPassword(), { lentTo: null, revertAt: null });
      const done = readRoster();
      delete done[agent].credentials.rotation;
      writeRoster(done);
    } catch (e) { console.error(`  FAILED ${agent}: ${e.message}`); }
  }

} else {
  console.error(`unknown command "${cmd}". Try: plan | lend | reclaim | list | due`);
  process.exit(2);
}
