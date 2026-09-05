#!/usr/bin/env node
// REBUILD A PROD CHARACTER ON THE LOCAL SERVER, WHERE WE ARE ADMIN.
//
//   node tools/m59-mirror.mjs plan                      what it would send, touching nothing
//   node tools/m59-mirror.mjs plan --character Animal
//   node tools/m59-mirror.mjs commands --character Animal   just the console lines
//   node tools/m59-mirror.mjs apply --object 1234 --character Animal --i-mean-it
//
// m59-sheet.mjs is the export; this is the import. Prod is a server we do not run and
// cannot snapshot — see the header of m59-sheet.mjs for why the savegame checkpoint does
// not cover it. Locally we ARE the admin, so a mirror does not have to be earned: the
// maintenance socket can set the values directly.
//
// THIS DOES NOT RE-ROLL ANYTHING. An earlier draft recreated characters through `reroll`
// and then reported everything that could not carry over, because attributes are fixed at
// creation. That was the wrong shape for a server we administer: re-rolling SUICIDES the
// character to get a fresh one, and here there is nothing to work around — blakserv's
// admin console will set the properties on the character that already exists.
//
// THE TWO LEVERS, both from the server's own source:
//
//   set object <id> <property> INT <value>          adminfn.c:396 (AdminSetObject)
//     Attributes live on the player object as piMight, piIntellect, piStamina,
//     piAgility, piMysticism and piAim (player.kod:796-801). These are the part that
//     cannot be earned at all — fixed at creation, never move — so they are the part a
//     mirror most needs and the part `set` handles exactly.
//
//   send object <id> ChangeSkillAbility ...         adminfn.c:433 (AdminSendObject)
//     Skills and spells are LIST nodes (plSkills / plSpells, player.kod:767-770), not
//     properties, so `set object` cannot reach them. The kod exposes the mutator, and it
//     already has a DM door in its signature:
//       ChangeSkillAbility(Skill_num, amount, report, refigureschools, bDM)
//                                                            player.kod:7290
//     bDM is the flag that says this is an administrator setting a value rather than a
//     character earning one.
//
// It emits commands rather than running them by default, because the thing that reads
// them should be able to check them first — these set a character's permanent statistics
// on a server, and a typo in a property name is silently accepted by `set object`.
//
// ============================================================================
// IT REFUSES ANY TARGET THAT IS NOT LOOPBACK, AND CHECKS TWICE.
// ============================================================================
//
// The first check is the maintenance host it was told to talk to. The second is what the
// broker's characters are actually connected to, read back from that broker — and the
// second is the one that matters, because a broker on 127.0.0.1:8901 is EXACTLY what prod
// looks like from this machine. The broker is local; the server is not. Every one of the
// fleet's connections is outbound to 76.214.42.186. A check that only looked at the URL
// would pass on the single configuration this exists to prevent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHEET_DIR } from './m59-sheet.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');

// The six, and the property each lands on. player.kod:796-801.
export const ATTR_PROPERTY = {
  might: 'piMight', intellect: 'piIntellect', stamina: 'piStamina',
  agility: 'piAgility', mysticism: 'piMysticism', aim: 'piAim',
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
export function isLoopbackHost(host) {
  return !!host && LOOPBACK.has(String(host).trim().toLowerCase());
}
export function brokerHostOf(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

// Both gates as one answer. An empty session list is not permission, it is an unknown.
export function refuseUnlessLocal({ brokerUrl, sessionHosts }) {
  const bh = brokerHostOf(brokerUrl);
  if (!isLoopbackHost(bh))
    return `the broker at ${brokerUrl} is not on loopback (${bh ?? 'unparseable'})`;
  if (!Array.isArray(sessionHosts))
    return 'could not read what that broker\'s sessions are connected to';
  const remote = [...new Set(sessionHosts.filter(h => !isLoopbackHost(h)))];
  if (remote.length)
    return `that broker's characters are connected to ${remote.join(', ')} — a LOCAL broker ` +
           'holding a REMOTE fleet is exactly what prod looks like from here';
  if (!sessionHosts.length)
    return 'that broker is holding no sessions, so there is nothing to prove it is local';
  return null;
}

export function readSheets({ character = null } = {}) {
  let files = [];
  try { files = fs.readdirSync(SHEET_DIR).filter(f => f.endsWith('.json')); }
  catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SHEET_DIR, f), 'utf8'));
      if (character && s.character !== character) continue;
      out.push(s);
    } catch { /* a half-written sheet is skipped, not fatal */ }
  }
  return out.sort((a, b) => (b.level ?? 0) - (a.level ?? 0));
}

// ---------------------------------------------------------------- ability numbers
//
// THE SHEET'S `id` IS AN OBJECT ID ON THE SERVER IT WAS READ FROM, NOT A SKILL NUMBER,
// AND IT DOES NOT TRAVEL.
//
// This file used to send `ChangeSkillAbility Skill_num INT <sheet.id>` on the strength of
// "the server itself gave us that number, so it cannot be wrong". It is wrong twice over.
// `ChangeSkillAbility` looks its argument up with `FindSkillByNum` (player.kod:7294), which
// wants the kod SKILL NUMBER — SKID_BLOCK is 404, SKID_PROFICIENCY_MACE is 452 — while the
// sheet records the id of the skill OBJECT, which is in the thousands and is reissued by
// `save game`. And the same ability has different object ids on different servers: `relay`
// read back as 3706 on prod and 3707 on the local server on 2026-09-05.
//
// Measured on the local server that day, against Aaaa (object 7297):
//
//     send object 7297 AddSkill num INT 452 iability INT 53 bDM INT 1   -> INT 1
//     send object 7297 AddSkill num INT 401 iability INT 42 bDM INT 1   -> INT 1
//     send object 7297 AddSkill num INT 3739 iability INT 99 bDM INT 1  -> INT 0
//
// and `plSkills` came back holding 45253 and 40142 — the compound is num*100 + ability, so
// both landed with the percentage asked for. The third, the sheet's own id, returned FALSE
// and did nothing. A silent 0 in the middle of a batch is exactly the failure this
// repository keeps paying for, so the numbers are resolved BY NAME against the kod the
// local server was built from.
//
// `AddSkill` rather than `ChangeSkillAbility` because the character being mirrored usually
// does not have the skill at all, and AddSkill sets the ability on the way in
// (player.kod:7448); ChangeSkillAbility on a skill nobody has is a no-op.
let NUMBERS = null;
export function abilityNumbers(root = process.env.M59_ROOT || 'C:/code/meridian59') {
  if (NUMBERS) return NUMBERS;
  const K = new Map();
  const inc = path.join(root, 'kod', 'include');
  for (const f of fs.readdirSync(inc).filter(x => x.endsWith('.khd'))) {
    const txt = fs.readFileSync(path.join(inc, f), 'utf8');
    for (const m of txt.matchAll(/^\s*([A-Z][A-Z_0-9]*)\s*=\s*(\d+)\s*$/gm)) K.set(m[1], Number(m[2]));
  }
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.kod')) files.push(p);
    }
  })(path.join(root, 'kod', 'object', 'passive'));

  const skills = {}, spells = {};
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    // `viSkill_Num` and `viSkill_num` both occur in the tree — slash.kod:36 is the capital.
    const numM = /vi(Skill|Spell)_num\s*=\s*([A-Z][A-Za-z_0-9]*)/i.exec(t);
    const nameRes = /vrName\s*=\s*(\w+)/.exec(t);
    if (!numM || !nameRes) continue;
    const lit = new RegExp('^\\s*' + nameRes[1] + '\\s*=\\s*"([^"]+)"', 'mi').exec(t);
    if (!lit) continue;
    const num = K.get(numM[2].toUpperCase());
    if (num == null) continue;
    (/skill/i.test(numM[1]) ? skills : spells)[lit[1].toLowerCase()] = num;
  }
  NUMBERS = { skills, spells };
  return NUMBERS;
}

// ---------------------------------------------------------------- filling the gaps
//
// A FRESH SHEET IS NOT THE FULLEST SHEET, AND THE MIRROR IS WHERE THAT GETS RESOLVED.
//
// Two of the three things a mirror needs come back EMPTY from a live capture, because
// both are pushed rather than polled: `status.attributes` is `{}` unless the server
// happened to push a stat block since the keeper connected, and `abilities` answers
// `"ability": null` with its own warning that the server sent 0 ability slots. A capture
// taken today is therefore missing numbers a capture from August has.
//
// So the importer fills them, from the best source for each, and says which:
//
//   attributes — the newest sheet or checkpoint that has them. Attributes are fixed at
//                creation (player.kod:796-801), so age does not decay this one: a reading
//                from August is exactly as true as one from today.
//   abilities  — substrate/abilities/<name>.json, which the KEEPER writes and which holds
//                both the last value seen and the best ever. `ability` is preferred and
//                `best` is the fallback, because a percentage that was seen once is a
//                percentage the character had.
//
// This does not touch m59-sheet.mjs. The export writes down what it saw and marks what it
// did not; deciding what to do about a null is the importer's job, and doing it here keeps
// one sheet format rather than two.
export function enrichSheet(sheet) {
  const filled = { ...sheet, attributes: { ...(sheet.attributes ?? {}) } };
  const from = [];

  const needAttrs = Object.keys(ATTR_PROPERTY).some(k => !Number.isFinite(filled.attributes[k]));
  if (needAttrs) {
    const pool = [];
    const cdir = path.join(SHEET_DIR, 'checkpoints');
    try {
      for (const f of fs.readdirSync(cdir).filter(x => x.startsWith(`${sheet.character}-`)))
        pool.push(path.join(cdir, f));
    } catch { /* no checkpoints */ }
    pool.sort();                                   // the names carry an ISO stamp
    for (const p of pool.reverse()) {
      let s = null;
      try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
      if (!Object.keys(ATTR_PROPERTY).every(k => Number.isFinite(s.attributes?.[k]))) continue;
      for (const k of Object.keys(ATTR_PROPERTY))
        if (!Number.isFinite(filled.attributes[k])) filled.attributes[k] = s.attributes[k];
      from.push(`attributes from ${path.basename(p)}`);
      break;
    }
  }

  const cache = (() => {
    try { return JSON.parse(fs.readFileSync(
      path.join(REPO, 'substrate', 'abilities', `${sheet.character}.json`), 'utf8')); }
    catch { return null; }
  })();
  for (const kind of ['skills', 'spells']) {
    filled[kind] = (sheet[kind] ?? []).map(row => {
      if (Number.isFinite(row.ability) && row.ability > 0) return row;
      const c = cache?.[kind]?.[row.name];
      const v = Number.isFinite(c?.ability) && c.ability > 0 ? c.ability
              : Number.isFinite(c?.best) && c.best > 0 ? c.best
              : Number.isFinite(row.best_ever) ? row.best_ever : null;
      return v == null ? row : { ...row, ability: v, ability_from: c ? 'ability cache' : 'best_ever' };
    });
    const filledCount = filled[kind].filter(r => r.ability_from).length;
    if (filledCount) from.push(`${filledCount} ${kind} from the ability cache`);
  }
  filled.enriched_from = from;
  return filled;
}

// The console lines that would make object `objectId` match this sheet.
//
// `objectId` is the LOCAL character's object id, not the one in the sheet — the sheet
// records prod's id and it means nothing on another server. Object ids are also reissued
// by `save game`, so this is asked for per run rather than remembered.
// WHAT THE CHARACTER ALREADY HAS, DECODED. `plSkills` and `plSpells` are lists of one
// integer per ability and the integer is `num * 100 + ability` — 45253 is skill 452 at 53%.
// Measured on the local server, 2026-09-05.
export function decodeAbilityList(raw) {
  const out = {};
  for (const m of String(raw).matchAll(/INT (\d+)/g)) {
    const n = Number(m[1]);
    out[Math.floor(n / 100)] = n % 100;
  }
  return out;
}

export function commandsFor(sheet, objectId, { numbers = null, health = true, current = null } = {}) {
  const lines = [];
  const notes = [];
  const a = sheet.attributes ?? {};
  const N = numbers ?? abilityNumbers();

  for (const [k, prop] of Object.entries(ATTR_PROPERTY)) {
    const v = a[k];
    if (!Number.isFinite(v)) { notes.push(`no ${k} in the sheet — left alone`); continue; }
    lines.push(`set object ${objectId} ${prop} INT ${v}`);
  }

  // ADD IS FOR ONE THEY DO NOT HAVE; CHANGE IS FOR ONE THEY DO, AND `amount` IS A DELTA.
  //
  // `AddSkill`/`AddSpell` return FALSE for an ability already in the list and change
  // nothing — which is how all 21 characters kept their own spell percentages through a
  // mirror that reported success (they were created with the same five spells). And when
  // it does route through `ChangeSkillAbility`, `amount` is ADDED, not assigned
  // (player.kod:7429): re-mirroring a skill at 58 onto one already at 53 gave 99, the cap,
  // not 58. So an ability the character already has is set with an explicit difference.
  for (const kind of ['skills', 'spells']) {
    const table = N[kind];
    const add = kind === 'skills' ? 'AddSkill' : 'AddSpell';
    const change = kind === 'skills' ? 'ChangeSkillAbility' : 'ChangeSpellAbility';
    const key = kind === 'skills' ? 'Skill_num' : 'spell_num';
    const have = current?.[kind] ?? null;
    for (const row of sheet[kind] || []) {
      const want = row.ability;
      if (!Number.isFinite(want) || want <= 0) continue;
      const num = table[String(row.name ?? '').toLowerCase()];
      if (num == null) { notes.push(`${row.name}: no ${kind.slice(0, -1)} of that name in the local kod — skipped`); continue; }
      const now = have?.[num];
      const tail = `   # ${kind.slice(0, -1)}: ${row.name} ${want}%`;
      if (!Number.isFinite(now)) {
        lines.push(`send object ${objectId} ${add} num INT ${num} iability INT ${want} bDM INT 1${tail}`);
      } else if (now !== want) {
        // ChangeSkillAbility takes bDM; ChangeSpellAbility's signature has no such
        // parameter (player.kod:6722), so it is not sent one.
        const dm = kind === 'skills' ? ' refigureschools INT 1 bDM INT 1' : '';
        lines.push(`send object ${objectId} ${change} ${key} INT ${num} amount INT ${want - now} ` +
                   `report INT 0${dm}${tail} (was ${now}%)`);
      }
    }
  }

  // MAXIMUM HEALTH *IS* THE LEVEL, and on a server we administer it is a property like any
  // other. This file used to refuse it on the grounds that a level is earned — true of a
  // character being brought up, and beside the point for a mirror whose whole job is to
  // make the local copy read the same as the original. `piBase_Max_Health` is the one the
  // damage cap and the advancement check work from (player.kod:4612), so setting
  // `piMax_Health` alone would leave a character that looks right and takes damage like
  // its old self.
  if (health && Number.isFinite(sheet.level)) {
    for (const prop of ['piBase_Max_Health', 'piMax_Health', 'piHealth'])
      lines.push(`set object ${objectId} ${prop} INT ${sheet.level}`);
  } else if (Number.isFinite(sheet.level)) {
    notes.push(`level ${sheet.level} left alone (health: false)`);
  }
  notes.push('karma, money, items and room are not touched — they are not part of what ' +
             'makes this character this character.');
  return { lines, notes };
}

async function rpc(brokerUrl, name, args = {}, ms = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(brokerUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
                             params: { name, arguments: args } }),
    });
    const j = await r.json();
    if (j.result?.isError) throw new Error(j.result.content[0].text);
    return JSON.parse(j.result.content[0].text);
  } finally { clearTimeout(t); }
}

// What the target broker's characters are connected to. Read from the broker rather than
// from any file here, because the question is about the running thing.
// A HOST IS A STRING OR AN {host,port}, AND THE OLD READER TURNED THE SECOND INTO
// "[object Object]" — which fails the loopback check, so it refused a genuinely local
// fleet rather than approving a remote one. Safe direction, still wrong. `/health` is
// asked FIRST now because `session_game_servers` names the host of every session
// individually, which is the strict form of the question this guard exists to ask.
const hostOf = v => (v && typeof v === 'object' ? v.host : String(v ?? '').split(':')[0]) || null;

export async function sessionHostsOf(brokerUrl) {
  try {
    const h = await (await fetch(new URL('/health', brokerUrl))).json();
    const per = Object.values(h.session_game_servers ?? {}).map(hostOf).filter(Boolean);
    if (per.length) return per;
    const g = hostOf(h.game_server ?? h.server);
    if (g) return [g];
  } catch { /* fall through to the fleet rows */ }
  const f = await rpc(brokerUrl, 'fleet', {});
  return (f.fleet || []).map(r => hostOf(r.host ?? r.credentials?.host)).filter(Boolean);
}

// ---------------------------------------------------------------------- cli
if (process.argv[1] && path.basename(process.argv[1]) === 'm59-mirror.mjs') {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'plan';
  const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const only = arg('--character');
  const brokerUrl = arg('--broker', 'http://127.0.0.1:8899');
  const objectId = arg('--object');

  const sheets = readSheets({ character: only });
  if (!sheets.length) {
    console.error(`no sheets in ${path.relative(REPO, SHEET_DIR)} — run: node tools/m59-sheet.mjs`);
    process.exit(1);
  }

  if (cmd === 'plan' || cmd === 'commands') {
    const id = objectId ?? '<LOCAL-OBJECT-ID>';
    for (const s of sheets) {
      const { lines, notes } = commandsFor(enrichSheet(s), id);
      if (cmd === 'commands') { lines.forEach(l => console.log(l)); continue; }
      const a = s.attributes ?? {};
      console.log(`\n=== ${s.character} (level ${s.level ?? '?'}, sheet ${s.captured_at_iso ?? '?'}) ===`);
      console.log(`  attributes  ${Object.keys(ATTR_PROPERTY).map(k => `${k[0]}${k[1]}:${a[k] ?? '?'}`).join(' ')}`);
      console.log(`  ${lines.length} console line(s) to make a local character match`);
      for (const n of notes) console.log(`  note: ${n}`);
    }
    if (cmd === 'plan') {
      console.log(`\n${sheets.length} sheet(s). To see the lines:`);
      console.log('  node tools/m59-mirror.mjs commands --character <name> --object <local object id>');
      console.log('Find the local object id with the admin console: `show object <id>`, or from');
      console.log('the broker\'s `status` for that character on the LOCAL server.');
    }
    process.exit(0);
  }

  if (cmd === 'apply' || cmd === 'fleet') {
    const dryRun = argv.includes('--plan');
    if (!dryRun && !argv.includes('--i-mean-it')) {
      console.error('This writes permanent statistics onto characters. Re-run with --i-mean-it,');
      console.error('or with --plan to see the pairing and the line counts and change nothing.');
      process.exit(2);
    }
    let hosts = null;
    try { hosts = await sessionHostsOf(brokerUrl); }
    catch (e) { console.error(`cannot reach a broker at ${brokerUrl}: ${e.message}`); process.exit(1); }
    const refusal = refuseUnlessLocal({ brokerUrl, sessionHosts: hosts });
    if (refusal) {
      console.error('REFUSING TO APPLY.');
      console.error(`  ${refusal}`);
      console.error('');
      console.error('  This sets permanent statistics through the maintenance socket. Against prod');
      console.error('  it would rewrite live characters on a server shared with other people.');
      process.exit(2);
    }
    console.error(`target looks local (broker ${brokerHostOf(brokerUrl)}, sessions on ` +
                  `${[...new Set(hosts)].join(', ')})`);

    // WHO IS BEING MIRRORED ONTO WHOM. Prod's agents are t1..t21 and the local fleet's are
    // shadow01..shadow21; pairing is by that number and nothing else, so it is stable
    // across renames and says what it did before it does it.
    const local = await (await fetch(new URL('/health', brokerUrl))).json();
    const localChar = local.session_characters ?? {};
    const numOf = a => Number(String(a).replace(/^\D+/, ''));
    const pairs = [];
    if (cmd === 'apply') {
      if (!only) { console.error('apply needs --character <prod name>'); process.exit(2); }
      const to = arg('--local');
      const sheet = sheets[0];
      if (!to && !objectId) { console.error('apply needs --local <local character> or --object <id>'); process.exit(2); }
      pairs.push({ sheet, to: to ?? null, objectId });
    } else {
      const byNum = new Map(Object.entries(localChar).map(([a, c]) => [numOf(a), c]));
      for (const s of readSheets({})) {
        const to = byNum.get(numOf(s.agent));
        if (!to) { console.error(`no local character paired with ${s.agent} (${s.character}) — skipped`); continue; }
        pairs.push({ sheet: s, to, objectId: null });
      }
    }
    if (!pairs.length) { console.error('nothing to mirror'); process.exit(1); }

    const numbers = abilityNumbers();
    const dm = await import('./m59-dm.mjs');
    // RESOLVED IN THE SAME RUN THAT USES THEM. `save game` reissues object ids.
    const names = pairs.map(p => p.to).filter(Boolean);
    const resolved = names.length ? await dm.resolve(names) : {};
    for (const p of pairs) if (!p.objectId) p.objectId = resolved[p.to] ?? null;

    // WHAT EACH CHARACTER ALREADY HAS, so an ability it holds is CHANGED by a difference
    // rather than ADDED to. Read per character in the run that uses it.
    const currentOf = async oid => {
      const head = await dm.dm([`show object ${oid}`]);
      const out = {};
      for (const [kind, prop] of [['skills', 'plSkills'], ['spells', 'plSpells']]) {
        const id = new RegExp(prop + '\\s+= LIST (\\d+)').exec(head)?.[1];
        out[kind] = id ? decodeAbilityList(await dm.dm([`show list ${id}`])) : {};
      }
      return out;
    };

    for (const p of pairs) {
      const { to, objectId: oid } = p;
      const sheet = enrichSheet(p.sheet);
      if (oid == null) { console.log(`${sheet.character} -> ${to}: NOT ON THIS SERVER, skipped`); continue; }
      const current = dryRun ? null : await currentOf(oid);
      const { lines } = commandsFor(sheet, oid, { numbers, current });
      const cmds = lines.map(l => l.split('   #')[0]);
      if (dryRun) {
        console.log(`${sheet.character} (lvl ${sheet.level}) -> ${to} [${oid}]: ${cmds.length} line(s), ` +
                    `${(sheet.skills || []).filter(r => r.ability > 0).length} skill(s), ` +
                    `${(sheet.spells || []).filter(r => r.ability > 0).length} spell(s)` +
                    (sheet.enriched_from.length ? `  [${sheet.enriched_from.join('; ')}]` : ''));
        continue;
      }
      const out = await dm.dm(cmds);
      // A REPLY OF INT 0 IS A REFUSAL AND THERE IS NO OTHER SIGN OF ONE. Counted per line.
      const blocks = dm.split(out, cmds);
      const refused = [];
      cmds.forEach((c, i) => { if (/^send /.test(c) && /:\s*INT 0\b/.test(blocks[i] || '')) refused.push(lines[i]); });
      // Read the character back rather than trust the batch.
      const back = await dm.dm([`show object ${oid}`]);
      const g = re => { const m = re.exec(back); return m ? Number(m[1]) : null; };
      const skillList = /plSkills\s+= LIST (\d+)/.exec(back)?.[1];
      const spellList = /plSpells\s+= LIST (\d+)/.exec(back)?.[1];
      const count = async id => {
        if (!id) return 0;
        const raw = await dm.dm([`show list ${id}`]);
        return [...String(raw).matchAll(/INT \d+/g)].length;
      };
      console.log(`${sheet.character} -> ${to} [${oid}]: hp ${g(/piMax_Health\s+= INT (\d+)/)}` +
        ` (wanted ${sheet.level}), might ${g(/piMight\s+= INT (-?\d+)/)}` +
        ` (wanted ${sheet.attributes?.might ?? '?'}), ${await count(skillList)} skill(s)` +
        ` of ${(sheet.skills || []).length}, ${await count(spellList)} spell(s)` +
        ` of ${(sheet.spells || []).length}` + (refused.length ? `  REFUSED ${refused.length}` : ''));
      for (const r of refused) console.log(`    refused: ${r}`);
    }
    if (!dryRun) {
      console.log('');
      console.log('Abilities are PUSHED, not polled: a keeper that was already connected still holds');
      console.log('the ability list it was handed at login, so `abilities` will read stale until that');
      console.log('keeper reconnects. The SERVER is what fights, so combat is already correct.');
    }
    process.exit(0);
  }

  console.error(`unknown command "${cmd}" — use plan, commands, apply or fleet`);
  process.exit(1);
}
