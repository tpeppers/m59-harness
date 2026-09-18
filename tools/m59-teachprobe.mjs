#!/usr/bin/env node
// ASK A TEACHER ABOUT ONE ABILITY AND PRINT EXACTLY WHAT IT SAYS — with its own client.
//
//   node tools/m59-teachprobe.mjs --fleet arena --agent arena1 --room 801 \
//        --npc "Qerti'nya" --ask "night vision" --ask "bless"
//
// WHAT IT IS FOR. Saying an ability's NAME to a teacher is a bare `CanDoTeach`
// (monster.kod:5711-5733 registers the trigger, library.kod:2868-2872 runs it): no money
// moves, no state changes, and the sentence that comes back is the only thing in the game
// that distinguishes "you are not a disciple" from "you are four percent short" from "you
// already have it". `tools/fleetscripts/disciple-quest.mjs` depends on it entirely.
//
// SO IT NEEDS TO BE ASKABLE WITHOUT A BROKER. A fleet's keepers run whatever code the broker's
// checkout has, so on a machine with several checkouts the answer to "does the probe work"
// depends on which one started the broker — and that is exactly the question you are asking
// when the probe has just gone silent. This logs in one spare character with THIS checkout's
// client and prints what arrives, so the reading is about the server and this code and nothing
// else.
//
// IT TAKES A CHARACTER'S ONE CONNECTION. Logging in bumps whatever holds it, so point it at a
// fleet nobody is playing — `arena`, `localtest` — and never at a slot a keeper is on.
//
// THE DEFECT IT WAS WRITTEN FOR, 2026-09-18. Priestess Qerti'nya answered `bless` and
// `create food` and was SILENT on `night vision`, `discordance`, `killing fields` and
// `anti-magic aura` — every ability above the disciple gate. She was answering all of them.
// `CanDoTeach` sends the refusal as `#string=vrTeach_quest_needed, #parm1=<ability name>`
// (monster.kod:4511) and on a Temples teacher that string is `priestess_teach_quest_needed`
// (temples.kod:18), which contains NO `%s`. Four bytes of unread parameter therefore sat in
// the buffer, `parseSaid` reported `exact: false`, and `M59Client.check` dropped the whole
// message. The gate's own announcement was the one sentence this harness could not hear.
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { M59Client } from './m59-client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const all = n => argv.reduce((a, v, i) => (v === n ? [...a, argv[i + 1]] : a), []);

/** One maintenance-socket command, for the teleport. Loopback only, like every DM path here. */
const adminOnce = (cmd, host, port) => new Promise(res => {
  const s = net.connect(Number(port), host);
  let out = '', t = null;
  const finish = () => { try { s.destroy(); } catch { /* gone */ } res(out); };
  s.setTimeout(8000, finish);
  s.on('connect', () => { s.write(cmd + '\r\n'); t = setTimeout(finish, 1200); });
  s.on('data', d => { out += d; clearTimeout(t); t = setTimeout(finish, 1200); });
  s.on('error', finish);
});

async function main() {
  const fleet = arg('--fleet', 'arena');
  const agent = arg('--agent', null);
  const npc = arg('--npc', null);
  const room = arg('--room', null);
  const asks = all('--ask');
  const listenMs = Number(arg('--listen', 6000));
  const adminPort = Number(arg('--admin-port', process.env.M59_ADMIN_PORT || 19998));

  if (!agent || !asks.length) {
    console.error('usage: m59-teachprobe.mjs --fleet arena --agent arena1 [--room 801] ' +
                  '[--npc "Qerti\'nya"] --ask "<ability>" [--ask ...]');
    return 2;
  }

  const rosterPath = process.env.M59_STATE_FILE ||
    join(REPO, 'substrate', 'fleets', `${fleet}.json`);
  let roster;
  try { roster = JSON.parse(readFileSync(rosterPath, 'utf8')); }
  catch (e) { console.error(`cannot read roster ${rosterPath}: ${e.message}`); return 1; }
  const cred = roster[agent]?.credentials;
  if (!cred) { console.error(`no slot "${agent}" in ${rosterPath}`); return 1; }
  const host = cred.host ?? '127.0.0.1';

  // NEVER PRINT THE CREDENTIAL. The roster is the only record of these passwords.
  console.log(`probing as ${cred.character} (${fleet}/${agent}) on ${host}:${cred.port}`);

  const c = new M59Client({ verbose: false });
  await c.login(cred.account, cred.password);
  await sleep(1500);

  if (room) {
    // Straight into the room, beside the teacher. This removes the walk, which is noise for
    // the question being asked, and changes nothing about what the teacher will say.
    await adminOnce(`send object ${room} NewHold what OBJECT ${c.selfId} ` +
                    `new_row INT ${Number(arg('--row', 13))} new_col INT ${Number(arg('--col', 23))}`,
                    host, adminPort);
    await sleep(1500);
  }

  let worst = 0;
  for (const ask of asks) {
    // The client has no listener registration — it has a monotonic event stream, which is
    // better here: a mark before the say makes the window exactly this exchange.
    const since = c.evSeq;
    const errsBefore = c.parseErrors.length;
    await c.say(ask);
    await sleep(listenMs);
    const replies = c.eventsSince(since)
      .filter(e => e.kind === 'said' || e.kind === 'message')
      .map(e => ({ kind: e.kind, who: e.name ?? null, text: String(e.text ?? '') }))
      .filter(h => !/^You say/.test(h.text));
    const dropped = c.parseErrors.slice(errsBefore);
    console.log(`\n  say "${ask}"`);
    if (replies.length) for (const r of replies)
      console.log(`    ${r.kind}${r.who ? ` [${r.who}]` : ''}: ${r.text}`);
    else console.log('    (nothing came back)');
    // A DROPPED PACKET IS NOT SILENCE, AND SAYING SO IS THE WHOLE POINT OF THIS TOOL.
    if (dropped.length) {
      worst = 1;
      for (const d of dropped) console.log(`    DROPPED ${d.what}: ${d.why}`);
    }
    if (!replies.length && !dropped.length)
      console.log('    — and nothing was dropped either, so that really is silence');
  }

  try { c.close?.(); } catch { /* already gone */ }
  return worst;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href)
  process.exit(await main());
