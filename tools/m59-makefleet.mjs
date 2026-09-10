#!/usr/bin/env node
// MAKE A FLEET FROM NOTHING. Zero dependencies.
//
//   node tools/m59-makefleet.mjs --count 10
//   node tools/m59-makefleet.mjs --count 10 --dry-run     plan only, touch nothing
//   node tools/m59-makefleet.mjs --count 4 --prefix crew  a second batch
//
// THE PATH IS THREE STEPS AND EVERY ONE OF THEM IS LOAD-BEARING.
//
// 1. `create automated <acct> <pw>` on the maintenance socket makes an account and a
//    character together. That character has ZERO in every attribute. Attributes are
//    fixed at creation and never move, and stamina IS the max-health ceiling
//    (101 + stamina), so it is permanently capped at 102 max health and permanently
//    bad at everything. It is a placeholder, not a character.
//
//    The reply includes the user object ID: `<acct_id> <obj_id> User <name>`.
//    We immediately zero piLastLoginTime AND piLast_Restart_time on that object via
//    the admin socket, which makes IsFirstTime() return true (user.kod:558 checks both).
//
// 2. `reroll` with credentials passed inline (no prior join). Since the session has
//    never logged in, s.client is null, the suicide is skipped, and joinAsNewCharacter
//    connects fresh, sees flags=1 in BP_CHARACTERS, and sends BP_NEW_CHARINFO.
//
// THE SERVER NEVER SAYS NO. Over budget, out of range, wrong list length — none of it
// is refused. It silently stamps 3/1/4/1/5/9 and the default face on you, and you find
// out weeks later when the character cannot get past level 15. So every character is
// verified after the fact against what was asked for, and a mismatch is reported as a
// failure rather than counted as a success.
//
// WHY NOT JOIN+SUICIDE? PerformSuicide (user.kod:1447) sets piLastLoginTime=0 but also
// piLast_Restart_time=GetTime(). IsFirstTime checks BOTH (user.kod:558), so a suicided
// character is never first-time. Zeroing both fields via admin socket before any login
// is the only path that works without editing the server.

import net from 'node:net';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { STAT_PRESETS, planCharacter } from './m59-newchar.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const ROSTER_FILE = join(REPO, 'substrate', 'fleet-accounts.json');

const ADMIN_HOST = process.env.M59_HOST || '127.0.0.1';
const ADMIN_PORT = Number(process.env.M59_ADMIN_PORT || 9998);

// ------------------------------------------------------------------ names
//
// Must satisfy the server's name rule (player.kod, mirrored in m59-newchar.mjs):
// a letter, then 1..15 more of letter, apostrophe, space or hyphen.
// THE NATO PHONETIC ALPHABET, AND IT IS A PRIVACY DECISION RATHER THAN A STYLE ONE.
//
// A character called Delta names nobody. The set is fixed, public, and chosen precisely
// because it carries no information — so a roster built from it can be discussed in a
// commit message, a test fixture or a bug report without leaking which accounts exist on
// whose machine. `tools/dum-guard.mjs` exempts exactly this list for that reason.
//
// It is unconditional here because this tool can only ever build a fleet on the TEST
// server: characters are created over the maintenance socket, which is unauthenticated
// and IP-restricted to loopback, so a remote server's accounts are issued by its operator
// and never by this. There is no second case to branch on.
//
// Past twenty-six, names repeat with a suffix. The server's rule (player.kod, mirrored in
// m59-newchar.mjs) is a letter then 1..15 more of letter, apostrophe, space or hyphen —
// so "Bravo Two" is legal at nine characters and the longest here stays inside sixteen.
const NATO = [
  'Alfa', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel',
  'India', 'Juliett', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa',
  'Quebec', 'Romeo', 'Sierra', 'Tango', 'Uniform', 'Victor', 'Whiskey', 'Xray',
  'Yankee', 'Zulu',
];
const SUFFIX = ['', ' Two', ' Three', ' Four', ' Five', ' Six'];
const NAMES = SUFFIX.flatMap(suffix => NATO.map(name => `${name}${suffix}`));

// ------------------------------------------------------------------ mix
//
// Roughly half melee, because melee is what farms; a third casters, because the two
// spells that stop a fleet stalling — create weapon and create food — have to come
// from somewhere and both are karma-free. The pattern repeats for any count.
const MIX = ['melee', 'melee', 'caster', 'melee', 'archer',
             'melee', 'caster', 'balanced', 'melee', 'caster'];

// ------------------------------------------------------------------ admin socket

function admin(cmds, settle = 1200) {
  const list = Array.isArray(cmds) ? cmds : [cmds];
  return new Promise((resolve, reject) => {
    const s = net.connect(ADMIN_PORT, ADMIN_HOST);
    let buf = '';
    const bail = setTimeout(() => { s.destroy(); resolve(buf); }, 20000 + settle);
    s.on('connect', () => {
      let i = 0;
      const t = setInterval(() => {
        if (i < list.length) s.write(list[i++] + '\r\n');
        else { clearInterval(t); setTimeout(() => s.end(), settle); }
      }, 400);
    });
    s.on('data', d => { buf += d; });
    s.on('close', () => { clearTimeout(bail); resolve(buf); });
    s.on('error', e => { clearTimeout(bail); reject(e); });
  });
}

const clean = out => String(out).split(/\r?\n/)
  .filter(l => l.trim() && l.trim() !== '>')
  .map(l => l.replace(/^>\s?/, '')).join('\n');

// ------------------------------------------------------------------ broker

async function rpc(port, name, args, timeoutMs = 120000) {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
    params: { name, arguments: args },
  });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body, signal: ctl.signal,
    });
  } finally { clearTimeout(t); }
  const j = await res.json();
  if (j.error) throw new Error(`${name}: ${j.error.message}`);
  const text = j.result?.content?.[0]?.text ?? '';
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (j.result?.isError) throw new Error(`${name}: ${text.slice(0, 300)}`);
  return parsed;
}

async function brokerAlive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

// ------------------------------------------------------------------ roster file

function loadRoster() {
  try { return JSON.parse(readFileSync(ROSTER_FILE, 'utf8')); }
  catch { return { note: 'Account credentials for a locally created fleet. Gitignored.', accounts: {} }; }
}

function saveRoster(r) {
  mkdirSync(dirname(ROSTER_FILE), { recursive: true });
  writeFileSync(ROSTER_FILE, JSON.stringify(r, null, 2));
}

// ------------------------------------------------------------------ main

// SIX NUMBERS, IN THE ORDER THE GAME USES, or a preset name.
//
// `--stats 50/40/40/19/50/1` is might/intellect/stamina/agility/mysticism/aim - STAT_ORDER
// in m59-newchar.mjs, which is also the order the wire wants. Parsed here and VALIDATED by
// planCharacter, never by this function: the whole reason that planner exists is that the
// server accepts an illegal request and silently replaces the character with 3/1/4/1/5/9,
// and a second opinion here about what is legal is how the two quietly drift apart.
function parseStats(value) {
  if (typeof value !== 'string' || !value.includes('/')) return value;
  const n = value.split('/').map(x => Number(x.trim()));
  if (n.length !== 6 || n.some(x => !Number.isInteger(x))) return value;   // let the planner refuse it
  const [might, intellect, stamina, agility, mysticism, aim] = n;
  return { might, intellect, stamina, agility, mysticism, aim };
}

function parseArgs(argv) {
  const a = { count: 10, prefix: 'fleet', broker: 8901, loadout: 'selfSufficient',
              dryRun: false, stats: null, name: null, account: null, spells: null,
              look: null, hair: null, skin: null, waive: null, reason: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--count' || v === '-n') a.count = Number(argv[++i]);
    else if (v === '--prefix') a.prefix = argv[++i];
    else if (v === '--broker') a.broker = Number(argv[++i]);
    else if (v === '--loadout') a.loadout = argv[++i];
    else if (v === '--stats') a.stats = argv[++i];
    // ONE BESPOKE CHARACTER, THROUGH THE SAME THREE STEPS.
    //
    // A fleet is a batch of interchangeable NATO-named characters and that is the common
    // case. But the create / zero-first-time / reroll dance is identical for one deliberate
    // character with a chosen name, chosen numbers and chosen spells - a merchant, a banker,
    // a menagerie host - and writing that path a second time elsewhere is how the second
    // copy rots. Every guard still applies: the plan is checked before the account is made,
    // because the server accepts an illegal request and silently stamps 3/1/4/1/5/9 on it.
    else if (v === '--name') a.name = argv[++i];
    // APPEARANCE. Omitted means RANDOM, which is the point: every character made here
    // before today was the identical default man, because nobody passed a face and the
    // server reads an absent one as a request for its default. `--look default` asks for
    // that old face on purpose; `--hair`/`--skin` name a colour from m59-appearance.mjs.
    else if (v === '--look') a.look = argv[++i];
    else if (v === '--hair') a.hair = argv[++i];
    else if (v === '--skin') a.skin = argv[++i];
    else if (v === '--waive') a.waive = String(argv[++i]).split(',').map(x => x.trim()).filter(Boolean);
    else if (v === '--reason') a.reason = argv[++i];
    else if (v === '--account') a.account = argv[++i];
    else if (v === '--spells') a.spells = String(argv[++i]).split(',').map(x => x.trim()).filter(Boolean);
    else if (v === '--dry-run' || v === '-d') a.dryRun = true;
    else if (v === '--help' || v === '-h') a.help = true;
    else { console.error(`unknown argument: ${v}`); process.exit(2); }
  }
  return a;
}

// ONE ACCOUNT NAME FROM THE ROSTER THE BROKER IS ACTUALLY HOLDING.
//
// Read from the broker rather than from a path this tool guesses, because which roster is in
// play is the broker's answer and not ours. Returns null when it cannot be read, and the
// caller says so out loud rather than proceeding as though the check had passed - "I could
// not ask" and "the answer was yes" must never look the same.
async function rosterWitness(brokerPort) {
  try {
    const r = await fetch(`http://127.0.0.1:${brokerPort}/health`, { signal: AbortSignal.timeout(4000) });
    const h = await r.json();
    if (!h?.state) return null;
    const roster = JSON.parse(readFileSync(h.state, 'utf8'));
    for (const entry of Object.values(roster)) {
      const acct = entry?.credentials?.account;
      if (typeof acct === 'string' && acct) return acct;
    }
  } catch { /* unreadable - reported as unknown by the caller, never as ok */ }
  return null;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  a.stats = parseStats(a.stats);
  // A named character is ONE character. `--name` with `--count 10` asks for ten characters
  // sharing a name, which the server would happily accept and which is never what is meant.
  if (a.name) a.count = 1;
  if (a.spells) a.loadout = { spells: a.spells, why: 'named on the command line' };
  if (a.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('\n').filter(l => l.startsWith('//')).slice(0, 12).join('\n'));
    return 0;
  }
  if (!Number.isInteger(a.count) || a.count < 1 || a.count > NAMES.length) {
    console.error(`--count must be 1..${NAMES.length}`);
    return 2;
  }

  // What we are about to make.
  const plan = [];
  for (let i = 0; i < a.count; i++) {
    plan.push({
      account: a.account || `${a.prefix}${String(i + 1).padStart(2, '0')}`,
      name: a.name || NAMES[i],
      stats: a.stats || MIX[i % MIX.length],
    });
  }

  const loadoutLabel = typeof a.loadout === 'string' ? a.loadout : (a.loadout.spells || []).join(', ');
  console.log(`fleet of ${a.count}, loadout ${loadoutLabel}\n`);
  for (const p of plan) {
    const s = typeof p.stats === 'string' ? STAT_PRESETS[p.stats] : p.stats;
    console.log(`  ${p.account.padEnd(10)} ${p.name.padEnd(12)} ${(typeof p.stats === 'string' ? p.stats : 'custom').padEnd(9)}` +
      (s ? ` mig ${s.might} int ${s.intellect} sta ${s.stamina} agi ${s.agility} mys ${s.mysticism} aim ${s.aim}` : ''));
    // CHECKED BEFORE ANY ACCOUNT EXISTS, because past here the server accepts whatever it
    // is sent and says nothing at all about what it did with it.
    const appearance = a.look === 'default' ? 'default'
      : (a.hair || a.skin || a.look) ? { hair: a.hair, skin: a.skin } : null;   // null = randomise
    const unsafe = a.waive ? { reason: a.reason ?? '', waives: a.waive } : null;
    const check = planCharacter({ name: p.name, stats: p.stats, loadout: a.loadout,
                                  appearance, unsafe });
    p.plan = check;
    for (const why of check.problems) console.log(`    ! ${why}`);
    for (const why of check.warnings ?? []) console.log(`    ~ ${why}`);
    if (!check.ok) { console.error('refusing: fix the above. Nothing was created.'); return 2; }
    console.log(`    look  ${check.appearance_text}`);
    for (const sp of check.spells ?? [])
      console.log(`    spell ${String(sp.name).padEnd(14)} ${sp.school} lvl ${sp.level}, ${sp.cost}pts` +
        (sp.castable_when_new ? '' : `  - NOT castable when new: needs karma ${sp.required_karma}`));
  }
  const counts = plan.reduce((m, p) => {
    const k = typeof p.stats === 'string' ? p.stats : 'custom';
    m[k] = (m[k] || 0) + 1; return m;
  }, {});
  console.log(`\n  ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  // SAY WHAT THE STAMINA ACTUALLY BUYS, rather than asserting the preset's answer.
  //
  // Every preset spends 50 on stamina because max health is 101 + stamina and the whole
  // fleet is measured in max health gained per hour, so 50 buys the highest ceiling the
  // game allows and any point spent elsewhere is a point off the number being farmed. A
  // CUSTOM build may legitimately trade that away - a merchant that never fights is not
  // farming anything - but this used to claim the 151 ceiling unconditionally, which is a
  // false statement about a character whose attributes can never be changed afterwards.
  const staminas = [...new Set(plan.map(p => (typeof p.stats === 'string' ? STAT_PRESETS[p.stats] : p.stats)?.stamina))];
  for (const st of staminas)
    console.log(`  stamina ${st} -> max-health ceiling ${101 + Number(st)}` +
      (Number(st) === 50 ? '  (the cap; the most the game will ever allow)'
                         : `  ${50 - Number(st)} below the cap, and attributes NEVER move`));
  console.log('');

  if (a.dryRun) { console.log('--dry-run: nothing was created.'); return 0; }

  // Both ends have to be up before anything is created, or we leave half a fleet.
  if (!await brokerAlive(a.broker)) {
    console.error(`no broker on 127.0.0.1:${a.broker}.\n` +
      `  start one first:  node tools/m59-broker.mjs --http ${a.broker} --dashboard 8902`);
    return 1;
  }
  try {
    const status = clean(await admin('show status', 800));
    if (!status.trim()) throw new Error('no reply');
  } catch (e) {
    console.error(`no maintenance socket on ${ADMIN_HOST}:${ADMIN_PORT} (${e.message}).\n` +
      `  the server must be running, and 9998 published on loopback.`);
    return 1;
  }
  // IS THIS MAINTENANCE SOCKET THE SAME SERVER AS THAT BROKER'S GAME SERVER?
  //
  // A maintenance port that answers is not evidence that it answers for the RIGHT server,
  // and this machine runs more than one blakserv at once. Measured 2026-09-09: two
  // instances, started two minutes apart, on maintenance ports 9998 and 19998 with entirely
  // separate account databases. This tool defaulted to 9998, so `create automated` made the
  // account on the wrong server and reported success; the reroll then failed against the
  // right one with `login rejected - wrong username or password`. The account and the
  // password were both real. They were real somewhere else.
  //
  // Same doctrine as m59-which.mjs, one port over: a broker is ours only when its /health
  // state path IS our roster, never when a label or a reachable port merely matches. So this
  // is a FACT ABOUT THE DATA rather than about the ports - does this maintenance socket know
  // an account the broker's own roster names? Nothing else correlates the two, and a wrong
  // answer is silent in both directions.
  const witness = await rosterWitness(a.broker);
  if (witness) {
    const seen = clean(await admin(`show account ${witness}`, 1200));
    if (/cannot find account/i.test(seen)) {
      console.error(`WRONG SERVER: the maintenance socket on ${ADMIN_HOST}:${ADMIN_PORT} has never`);
      console.error(`heard of "${witness}", an account in the roster the broker on 127.0.0.1:${a.broker}`);
      console.error('is holding. They are two different blakserv instances.');
      console.error('');
      console.error('Creating here would make the account on the wrong server, print "Created');
      console.error('account", and then fail to log in against the right one.');
      console.error('  point it at the right one:  M59_ADMIN_PORT=<port> node tools/m59-makefleet.mjs ...');
      return 1;
    }
    console.log(`  maintenance ${ADMIN_HOST}:${ADMIN_PORT} agrees with the broker's roster (knows ${witness})`);
  } else {
    console.log('  NOTE: could not read the broker roster, so nothing here can tell you whether');
    console.log(`  ${ADMIN_HOST}:${ADMIN_PORT} is the same server that broker plays on.`);
  }

  const roster = loadRoster();
  const made = [], failed = [], skipped = [];

  for (const p of plan) {
    const known = roster.accounts[p.account];
    const password = known?.password || randomBytes(9).toString('base64url');
    const agent = p.account;
    process.stdout.write(`${p.account} → ${p.name} (${p.stats}) `);

    try {
      // 1. account + placeholder character. The two replies that matter are exact
      //    (blakserv/adminfn.c AdminCreateAutomated): "Created account <n>." on
      //    success, "Account name <x> already exists" on a duplicate — and a
      //    duplicate creates nothing and changes no password, so re-running this
      //    is safe. Anything else is a reply we do not understand, and guessing
      //    which of the two it meant is how you end up locked out of an account.
      const out = clean(await admin([`create automated ${p.account} ${password}`], 1500));
      const created = /Created account\s+\d+/i.test(out);
      const existed = /already exists/i.test(out);
      if (!created && !existed) {
        console.log(`FAILED — unrecognised reply: ${out.slice(0, 120) || '(silence)'}`);
        failed.push({ ...p, why: `unrecognised reply to create automated: ${out.slice(0, 120)}` });
        continue;
      }
      if (existed && !known) {
        // The account is there but we have no password for it: we cannot log in, and
        // guessing is worse than stopping.
        console.log(`skip — account exists and its password is not in ${ROSTER_FILE}`);
        skipped.push({ ...p, why: 'pre-existing account, password unknown' });
        continue;
      }
      if (!existed) {
        roster.accounts[p.account] = { password, created: new Date().toISOString() };
        saveRoster(roster);
      }

      // 2. Zero both login-time fields so IsFirstTime() returns true (user.kod:558).
      //    AdminShowOneUser (blakserv/adminfn.c:1652) prints: "<acct_id> <obj_id> <class> <name>".
      //    PerformSuicide sets piLastLoginTime=0 but piLast_Restart_time=GetTime(),
      //    so suicide alone is never first-time. Admin socket is the only clean path.
      {
        // For a fresh account, the object id is in the create automated reply.
        // For an existing account, look it up via `show account <name>`.
        let rawForObjId = out;
        if (existed) rawForObjId = clean(await admin([`show account ${p.account}`], 800));
        const objMatch = rawForObjId.match(/^\s*\d+\s+(\d+)\s+\w+/m);
        if (!objMatch) {
          console.log(`FAILED — could not find object id (reply: ${rawForObjId.slice(0, 120)})`);
          failed.push({ ...p, why: 'could not parse user object id' });
          continue;
        }
        const objId = objMatch[1];
        process.stdout.write('zero-first-time ');
        await admin([
          `set object ${objId} piLastLoginTime INT 0`,
          `set object ${objId} piLast_Restart_time INT 0`,
        ], 1000);
      }

      // 3. Replace the zeroed placeholder with a real character. Credentials are
      //    passed inline so the broker sets them without a join — joinAsNewCharacter
      //    then connects fresh and sees flags=1 in BP_CHARACTERS.
      process.stdout.write('reroll ');
      const r = await rpc(a.broker, 'reroll', {
        action: 'reroll', agent, name: p.name,
        stats: p.stats, loadout: a.loadout, confirm: true,
        account: p.account, password,
        host: process.env.M59_HOST || undefined,
        port: process.env.M59_PORT ? Number(process.env.M59_PORT) : undefined,
      });

      // ABSENCE IS NOT AGREEMENT. The broker already compares every stat against
      // what was asked and refuses to call an unreadable character a pass, so the
      // verdict to trust is its `stats_as_asked` — not a fresh comparison here that
      // could reintroduce the exact bug that flag exists to prevent.
      if (!r?.done) {
        console.log(`FAILED — no character came back. ${r?.verdict || ''}`.trim());
        failed.push({ ...p, why: r?.verdict || 'reroll reported no character' });
        continue;
      }
      if (r.looks_like_the_junk_default) {
        console.log('FAILED — the server substituted its 3/1/4/1/5/9 junk character');
        failed.push({ ...p, why: 'server substituted the junk default' });
        continue;
      }
      if (!r.stats_readable || !r.stats_as_asked) {
        console.log(`FAILED — ${r.verdict}`);
        failed.push({ ...p, why: r.verdict });
        continue;
      }
      roster.accounts[p.account].character = p.name;
      roster.accounts[p.account].stats = p.stats;
      saveRoster(roster);
      // Report the CEILING, not max_health_now. A level-1 character has about 20
      // max health whatever its stamina, so printing that reads like the stats
      // did not take — the number that says they did is 101 + stamina, which is
      // what this character can eventually reach and can never exceed.
      console.log(`ok — stamina ${r.stamina_now}, ceiling ${101 + Number(r.stamina_now)} max health`);
      made.push(p);
    } catch (e) {
      console.log(`FAILED — ${e.message}`);
      failed.push({ ...p, why: e.message });
    }
  }

  // Without this the whole fleet evaporates on the next server restart.
  if (made.length) {
    process.stdout.write('\nsaving game... ');
    await admin('save game', 4000);
    console.log('done');
  }

  console.log(`\n${made.length} made, ${failed.length} failed, ${skipped.length} skipped`);
  if (made.length) console.log(`credentials: ${ROSTER_FILE} (gitignored)`);
  for (const f of failed) console.log(`  FAILED ${f.account} ${f.name}: ${f.why}`);
  for (const s of skipped) console.log(`  skipped ${s.account}: ${s.why}`);
  if (made.length) {
    console.log(`\nnext:  node tools/m59-fleet.mjs            list them`);
    console.log(`       http://127.0.0.1:8902/fleet        the fleet page`);
  }
  return failed.length ? 1 : 0;
}

main().then(c => process.exit(c)).catch(e => { console.error(e); process.exit(1); });
