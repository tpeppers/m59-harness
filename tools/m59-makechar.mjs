#!/usr/bin/env node
// ONE CHARACTER, ON A SERVER YOU HAVE AN ACCOUNT ON AND NO ADMIN SOCKET.
//
//   node tools/m59-makechar.mjs --host 1.2.3.4 --port 5959 --account hk1 \
//        --name "Loial the Ogier" --stats 50/40/40/19/50/1 \
//        --spells "minor heal,detect evil,remove curse"          # plans, sends nothing
//   ...same, plus --apply                                        # actually creates it
//
// THE GAP THIS FILLS, and it is a real one.
//
//   m59-makefleet.mjs  needs the MAINTENANCE SOCKET, because it makes the account too. A
//                      remote server never gives you one — accounts there are issued by its
//                      operator, which is exactly the case this handles.
//   the `reroll` tool  needs a BROKER, and the broker you can reach is whichever one holds
//                      that fleet — running whatever code IT was deployed with. A character's
//                      face and attributes are fixed at creation and can never be changed,
//                      so creating through a broker that predates a fix means living with
//                      the old behaviour for the life of the character.
//
// So this is the third case: my code, my client, their server, an account that already
// exists. It sends BP_NEW_CHARINFO over an ordinary game connection, the same way the real
// client does, and nothing else.
//
// IT DOES NOT REGISTER THE CHARACTER ANYWHERE. Creating and rostering are different acts
// with different risks — the roster is the only record of a password — so this prints the
// `join` that adds it and leaves that to you.
//
// PLANS BY DEFAULT. `--apply` is required to send anything, because the server accepts an
// illegal request and silently replaces the character rather than refusing (see
// m59-newchar.mjs), and there is no undo: attributes never move and the face is permanent.
//
// AND IT READS THE CHARACTER BACK. `created: true` is what the server said; the stats and
// spells it actually holds are what happened. Everything this repository knows about this
// game says those are different questions.

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { M59Client } from './m59-client.mjs';
import { planCharacter, STAT_ORDER } from './m59-newchar.mjs';
import { describeAppearance } from './m59-appearance.mjs';
import { loadResources } from './m59-rsc.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = n => argv.includes(`--${n}`);
const die = (m, c = 1) => { console.error(m); process.exit(c); };

if (has('help') || !argv.length) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8')
    .split('\n').slice(1, 8).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const HOST = arg('host') || process.env.M59_HOST || '127.0.0.1';
const PORT = Number(arg('port') || process.env.M59_PORT || 5959);
const ACCOUNT = arg('account') || die('--account is required');
const NAME = arg('name') || die('--name is required');
const APPLY = has('apply');

// THE PASSWORD NEVER COMES OFF THE COMMAND LINE.
//
// A command line is visible to every process on the machine, lands in shell history, and
// ends up in the transcript of whatever agent ran it. The roster files and the environment
// are the two places a credential may live; this reads the environment, and says so.
const PASSWORD = process.env.M59_MAKECHAR_PASSWORD;
if (!PASSWORD)
  die('set M59_MAKECHAR_PASSWORD in the environment — this tool will not take a password\n' +
      'on the command line, because a command line is readable by every process on the box\n' +
      'and ends up in shell history and in agent transcripts.');

function parseStats(v) {
  if (!v) return 'caster';
  if (!v.includes('/')) return v;
  const n = v.split('/').map(x => Number(x.trim()));
  if (n.length !== 6) die(`--stats needs six numbers (${STAT_ORDER.join('/')}), got ${n.length}`);
  return Object.fromEntries(STAT_ORDER.map((k, i) => [k, n[i]]));
}

// GENDER, WHICH THE PLANNER ALWAYS TOOK AND THIS CLI NEVER PASSED.
//
// `planCharacter` has accepted `gender` from the start and `m59-appearance.mjs` carries a
// full female part table — ten hair styles against the male seven — and none of it was
// reachable from here, so every character this tool ever made was male by omission. That is
// the same shape as the default face itself: nobody chose, and the silence was read as a
// preference. The allowed parts differ per gender and the server SUBSTITUTES a disallowed
// one silently, so this has to be decided before the face is picked, not after.
const GENDER = /^f/i.test(String(arg('gender') || '')) ? 2 : 1;

const spells = (arg('spells') || '').split(',').map(x => x.trim()).filter(Boolean);
const waive = (arg('waive') || '').split(',').map(x => x.trim()).filter(Boolean);
const look = arg('look');
const plan = planCharacter({
  name: NAME,
  gender: GENDER,
  stats: parseStats(arg('stats')),
  loadout: spells.length ? { spells, why: 'named on the command line' } : (arg('loadout') || 'selfSufficient'),
  skills: (arg('skills') || '').split(',').map(x => x.trim()).filter(Boolean),
  appearance: look === 'default' ? 'default'
    : (arg('hair') || arg('skin')) ? { hair: arg('hair'), skin: arg('skin') } : null,
  unsafe: waive.length ? { reason: arg('reason') ?? '', waives: waive } : null,
});

console.log(`server   ${HOST}:${PORT}`);
console.log(`account  ${ACCOUNT}`);
console.log(`name     ${plan.name}`);
console.log(`stats    ${STAT_ORDER.map(k => `${k.slice(0, 3)} ${plan.stats[k]}`).join('  ')}`);
console.log(`         total ${plan.stat_total}/200, max-health ceiling ${plan.max_health_ceiling}`);
console.log(`look     ${GENDER === 2 ? 'female' : 'male'} — ${describeAppearance(plan.appearance)}`);
console.log(`karma    starts at ${plan.starting_karma}`);
for (const s of plan.spells)
  console.log(`spell    ${String(s.name).padEnd(14)} ${s.school} lvl ${s.level}, ${s.cost}pts` +
    (s.castable_when_new ? '  castable now' : `  needs karma ${s.required_karma}`));
console.log(`abilities ${plan.ability_cost}/${plan.ability_budget} points`);
for (const w of plan.warnings ?? []) console.log(`  ~ ${w}`);
for (const w of plan.problems) console.log(`  ! ${w}`);

if (!plan.ok) die('\nrefusing: fix the above, or waive it by name with --waive <guarantee> --reason "..."', 2);
if (!APPLY) { console.log('\n(plan only — pass --apply to create it. There is no undo.)'); process.exit(0); }

// ---------------------------------------------------------------- the creation

const resources = loadResources();
const client = new M59Client({ host: HOST, port: PORT, resources });
let sent = null, newId = null, refused = false, notFirstTime = null;

client.onCharacters = (list) => {
  if (sent) return;
  // The server refuses any character that is not IsFirstTime (system.kod:3725), and the
  // list says which one that is: the low bit of `flags`. Choosing by name or position
  // sends a valid id for a character it will not re-roll, and the refusal is SILENT.
  const firstTime = (list || []).filter(x => x.flags & 1);
  if (!firstTime.length) { notFirstTime = (list || []).map(x => x.name); return; }
  const pick = firstTime[0];
  sent = { id: pick.id, name: pick.name };
  client.newCharInfo({
    user: pick.id, name: plan.name,
    gender: plan.appearance?.gender ?? 1,
    faceparts: plan.appearance?.faceparts ?? [],
    hair: plan.appearance?.hair ?? 0,
    skin: plan.appearance?.skin ?? 0,
    stats: plan.stat_list, spells: plan.spell_nums, skills: plan.skills ?? [],
  });
};
const priorEmit = client.emit?.bind(client);
client.emit = (kind, data) => {
  if (kind === 'charinfo-ok' && data?.id != null) { newId = data.id; client.useCharacter(data.id); }
  if (kind === 'charinfo-not-ok') refused = true;
  return priorEmit(kind, data);
};

try {
  await client.login(ACCOUNT, PASSWORD);
} catch (e) {
  die(`login failed: ${e.message}\n(the account and password are the operator's; nothing was sent)`);
}

await new Promise(r => setTimeout(r, 2500));

if (notFirstTime) {
  console.log('\nNOTHING WAS SENT. No character on this account is available for creation.');
  console.log(`  characters: ${notFirstTime.join(', ')}`);
  console.log('  A character becomes available only after a suicide, and user.kod:32 sets');
  console.log('  SUICIDE_REPEAT_TIME = 600 — one per character per ten minutes.');
  try { client.sock?.destroy(); } catch {}
  process.exit(1);
}
if (refused) { console.log('\nthe server sent CHARINFO_NOT_OK — nothing was created'); process.exit(1); }
if (!newId) { console.log('\nno CHARINFO_OK came back; nothing is proven either way'); process.exit(1); }

console.log(`\ncreated: object ${newId} (replacing the first-time placeholder ${sent?.name})`);

// ---------------------------------------------------------------- read it back
//
// The server said yes. What it actually made is a different question, and this game answers
// it by substitution rather than by refusal — an over-budget request becomes 3/1/4/1/5/9, a
// spell above level 2 is dropped with its points spent, a disallowed face part is swapped.
// So ask the character.
// `stats()` on the raw client is a SEND, not a promise — the reply arrives as a push and
// lands in statsById. Awaiting it threw `Cannot read properties of undefined (reading
// 'catch')` AFTER the character was already made, which is the worst place to crash: the
// irreversible half had happened and the half that checks it had not.
try { client.stats(1); client.stats(2); } catch { /* the wait below is the real read */ }
await new Promise(r => setTimeout(r, 2500));

const got = {};
for (const k of STAT_ORDER) {
  const v = client.statsById?.get?.(k)?.value;
  if (Number.isFinite(v)) got[k] = v;
}
const asAsked = STAT_ORDER.every(k => got[k] === undefined || got[k] === plan.stats[k]);
console.log('stats back:', STAT_ORDER.map(k => `${k.slice(0, 3)} ${got[k] ?? '?'}`).join('  '),
            asAsked ? ' — as asked' : '  *** NOT AS ASKED ***');
if (!asAsked)
  console.log('  the server substituted. 3/1/4/1/5/9 means it read the request as malformed.');

const spellNames = (client.spells ?? []).map(s => s.name ?? s).filter(Boolean);
if (spellNames.length) {
  console.log('spells back:', spellNames.join(', '));
  const missing = plan.spells.map(s => s.name).filter(n => !spellNames.some(g => String(g).toLowerCase() === n));
  if (missing.length) console.log(`  *** MISSING: ${missing.join(', ')} — asked for and not granted ***`);
} else {
  console.log('spells back: not reported on this connection — check with `status` through a broker');
}

console.log('\nNOT rostered. This tool creates; it does not write credentials anywhere.');
console.log('To register it with the broker holding that fleet (which also proves the login):');
console.log(`  join {agent: "${ACCOUNT}", account: "${ACCOUNT}", password: <the password>,`);
console.log(`        character: "${plan.name}", host: "${HOST}", port: ${PORT}}`);
console.log('Then rotate the password off the one you were given:');
console.log(`  node tools/m59-rotate.mjs secure ${ACCOUNT} --apply`);

try { client.sock?.destroy(); } catch {}
process.exit(0);
