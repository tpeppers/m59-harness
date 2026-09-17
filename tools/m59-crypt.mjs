#!/usr/bin/env node
//
// MOVE A CHARACTER TO THE MARION CRYPTS THE DAY IT EARNS ITS PLACE THERE.
//
//   node tools/m59-crypt.mjs                # who is ready, who is short, and of what
//   node tools/m59-crypt.mjs --apply        # relocate and re-task the ready ones
//   node tools/m59-crypt.mjs --agents t1,t2 # just these
//
// WHY THIS IS A SWEEP RATHER THAN A ONE-OFF. The three skills arrive at different times
// for different characters — a teacher trip can fail on one hop and succeed on the next —
// so "everyone who qualifies" is a set that grows over hours. Run it again and it picks up
// whoever has qualified since; a character already in the crypt is left alone.
//
// THE GATE IS ALL THREE LEVEL-2 WEAPONCRAFT SKILLS, and the names are the ones the GAME
// uses. That is not pedantry: the skill is **brawling**, not "brawl", and a name nothing
// answers to is indistinguishable from a skill nobody has learned — both read as absent.
// Gating on the wrong spelling silently qualifies nobody, for ever, and looks exactly like
// a fleet that is simply behind on its training.
//
// THE ROOM PIN IS A SAFETY PROPERTY, NOT A PREFERENCE. Room 2602, "Affirmation of the
// Forsaken", is one door off the crypt and generates thrashers at level 150 with a cap of
// fifteen. Eight characters of this fleet once stood in it and lived only because nothing
// had spawned yet. So `roam` is false and the room is pinned; a character that wanders out
// of 2600/2601 looking for prey is the failure this exists to prevent.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const APPLY = !!arg('apply', false);
const ONLY = arg('agents', null);
const PORT = Number(arg('port', process.env.M59_HTTP_PORT || 8901));

// The game's own names. See WEAPON_PROFICIENCY in m59-skills.mjs for why these are taken
// from the catalogue rather than guessed at.
export const CRYPT_SKILLS = ['dodge', 'brawling', 'short sword fighting'];

// 2600 generates spectral mummies at 100% with a cap of ten; statues respawn in both. 2601
// is the quieter of the two and is the default for the statue shift.
export const CRYPT_ROOMS = { mummies: 2600, statues: 2601 };
export const THRASHER_ROOM = 2602;

const ABILITY_DIR = process.env.M59_ABILITY_DIR ||
  join(fileURLToPath(new URL('../substrate/abilities', import.meta.url)));

export function skillsOf(character, dir = ABILITY_DIR) {
  const f = join(dir, `${character}.json`);
  if (!existsSync(f)) return null;
  try { return Object.keys(JSON.parse(readFileSync(f, 'utf8')).skills || {}); }
  catch { return null; }
}

/**
 * What this character is still short of.
 *
 * Returns null when nobody has READ its abilities, which is not the same as knowing none —
 * the numbers are pushed and cached once after login, so a missing file means the reading
 * never happened. Treating that as "knows nothing" would re-task a qualified character to
 * the wrong shift; treating it as "knows everything" would send an unqualified one to fight
 * level-75 statues. So it is reported as unknown and left alone.
 */
export function shortfallFor(character, dir = ABILITY_DIR) {
  const known = skillsOf(character, dir);
  if (!known) return { known: false, missing: null };
  return { known: true, missing: CRYPT_SKILLS.filter(s => !known.includes(s)) };
}

// Over the broker's stdio MCP, through the attach forwarder, because that is the only
// surface that exposes the tools — the HTTP side serves boards and the RTS read, and a
// POST to an unknown path there answers 202 with an empty body, which parses as a broken
// reply rather than as "no such endpoint".
let mcp = null, nextId = 1, pending = new Map();
function connect() {
  if (mcp) return mcp;
  const here = fileURLToPath(new URL('./m59-mcp-attach.mjs', import.meta.url));
  const child = spawn(process.execPath, [here, '--port', String(PORT)],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf(String.fromCharCode(10))) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); p(m); }
    }
  });
  const send = (o) => new Promise(res => { pending.set(o.id, res); child.stdin.write(JSON.stringify(o) + String.fromCharCode(10)); });
  mcp = { child, send };
  return mcp;
}
const rpc = (method, params) => {
  const c = connect();
  return c.send({ jsonrpc: '2.0', id: nextId++, method, params });
};
let ready = null;
const call = async (tool, args) => {
  ready ??= rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'm59-crypt', version: '1' } });
  await ready;
  const m = await rpc('tools/call', { name: tool, arguments: args });
  if (m.error) throw new Error(`${tool}: ${m.error.message ?? 'refused'}`);
  const text = m.result?.content?.[0]?.text;
  try { return JSON.parse(text); } catch { return { raw: text }; }
};
const closeMcp = () => { try { mcp?.child.kill(); } catch { /* already gone */ } };

// The orders a crypt character runs on. Written here rather than in a doctrine because the
// room pin and `roam:false` are the safety half and must not be separable from the rest.
export const cryptOrders = (agent) => ({
  agent, action: 'start',
  hunt: 'statue',
  assigned_room: CRYPT_ROOMS.statues,
  roam: false,
  purpose: 'equip',
  goals: [{ kind: 'hp' }],
});

async function main() {
  const health = await fetch(`http://127.0.0.1:${PORT}/health`).then(r => r.json())
    .catch(() => null);
  if (!health?.ok) {
    console.error(`no broker on ${PORT} — start one first`);
    process.exit(1);
  }
  const board = await call('fleet', {});
  let rows = (board.fleet || []).filter(r => r.character);
  if (ONLY && ONLY !== true) {
    const want = new Set(String(ONLY).split(',').map(s => s.trim()));
    rows = rows.filter(r => want.has(r.agent));
  }

  const ready = [], short = [], unread = [], already = [];
  for (const r of rows) {
    const s = shortfallFor(r.character);
    if (!s.known) { unread.push(r); continue; }
    if (s.missing.length) { short.push({ r, missing: s.missing }); continue; }
    if (r.assigned_room === CRYPT_ROOMS.statues || r.assigned_room === CRYPT_ROOMS.mummies) {
      already.push(r); continue;
    }
    ready.push(r);
  }

  console.log(`${rows.length} character(s): ${ready.length} to relocate, ${already.length} already in the crypts, ` +
              `${short.length} still training, ${unread.length} unread`);
  for (const { r, missing } of short.sort((a, b) => a.missing.length - b.missing.length))
    console.log(`  ${r.character.padEnd(10)} short of: ${missing.join(', ')}`);
  for (const r of unread)
    console.log(`  ${r.character.padEnd(10)} abilities never read — left alone rather than guessed at`);
  for (const r of already)
    console.log(`  ${r.character.padEnd(10)} already pinned to ${r.assigned_room}`);

  if (!ready.length) { console.log('nothing to relocate'); return; }
  if (!APPLY) {
    for (const r of ready)
      console.log(`  would relocate ${r.character} (${r.agent}) -> room ${CRYPT_ROOMS.statues}, hunt statue, roam off`);
    console.log('\n--apply to do it');
    return;
  }

  for (const r of ready) {
    try {
      await call('autopilot', cryptOrders(r.agent));
      // The pin is orders; the WALK is a separate thing and is allowed to fail without
      // losing the orders. A character re-tasked but not yet moved will route itself.
      const trip = await call('travel', { agent: r.agent, to: CRYPT_ROOMS.statues })
        .catch(e => ({ arrived: false, reason: e.message }));
      console.log(`  ${r.character.padEnd(10)} re-tasked${trip?.arrived ? ' and walked there' :
        ` (orders set; walk did not finish: ${trip?.reason ?? 'unknown'})`}`);
    } catch (e) {
      console.log(`  ${r.character.padEnd(10)} FAILED: ${e.message}`);
    }
  }
}

if (import.meta.url.endsWith(String(process.argv[1]).replace(/\\/g, '/')))
  main().then(closeMcp, e => { closeMcp(); console.error(e.message); process.exit(1); });
