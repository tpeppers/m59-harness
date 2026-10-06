#!/usr/bin/env node
// THE SWARM DRIVER: who is in the swarm, holding them, and walking them home when it ends.
//
//   node tools/m59-swarm.mjs start  --leader t21 [--fleet prod]   # the terminal's S key runs this
//   node tools/m59-swarm.mjs status [--fleet prod]
//   node tools/m59-swarm.mjs stop   [--fleet prod]                # members walk back where they joined
//   node tools/m59-swarm.mjs stop   --here [--fleet prod]         # released where they stand
//
// The argument for the whole feature is in m59-swarm-follow.mjs. This process owns the
// MINUTE-SCALE half: membership and the claims. Every member's keeper does the moving.
//
// MEMBERSHIP. Whoever is in the leader's room when the swarm starts, plus any fleet character
// who later walks into the room he is in -- both are the same rule, applied every two seconds
// to the keepers' sightings: a keeper that sees the leader, and is eligible, joins. Eligible
// excludes a maximum health under 30, menagerie hosts, war noncombatants and characters held
// by a human client, and every refusal is logged once with its reason.
//
// THE CLAIM IS movement+work, never the survival floor, held by `swarm/<leader>@terminal` with a
// heartbeat. A driver that dies stops renewing, and within one lease every member is its
// keeper's again, standing wherever it was -- the safe direction to fail in.
//
// THE END. When the leader's client exits (his pilot claim is released) or `stop` is asked, the
// phase becomes `returning`: each member's keeper, still held, walks back to the room it joined
// from -- the operator's choice, so a lockdown posture resumes exactly where it was -- and is
// released on arrival, or after RETURN_MS wherever it got to. `stop --here` releases at once.

import { appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HEARTBEAT_MS, LEASE_MS, SWARM_MIN_MAX_HEALTH, eligibility, holderFor, leaderRoom, readSightings,
  readState, statePath, writeState,
} from './m59-swarm-follow.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const has = name => argv.includes(name);
const FLEET = opt('--fleet', process.env.M59_FLEET || 'prod');
if (opt('--url')) process.env.M59_CONTROL_URL = opt('--url');
const { call } = await import('./m59-fleetscript.mjs');

const TICK_MS = 2_000;
// The line, and whether the swarm ends with the leader's client. Both overridable for a LAB, where
// the characters are 20-health placeholders and the leader is a keeper being commanded, not a human.
const MIN_MAX_HEALTH = Number(opt('--min-max-health', SWARM_MIN_MAX_HEALTH));
const UNTIL_STOP = has('--until-stop');
const RETURN_MS = Number(process.env.M59_SWARM_RETURN_MS || 10 * 60_000);
const LEADER_GONE_MS = 10_000;
const LOG = join(HERE, '..', 'substrate', `swarm-${FLEET}.log`);
const log = line => {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
  try { appendFileSync(LOG, text + '\n'); } catch { /* the log is a courtesy */ }
};
// A state write that fails is one missed beat, never the driver's death: the keepers keep the
// last state they read, and the next tick writes again.
const save = state => { try { writeState(FLEET, state); return true; }
                        catch (e) { log(`  state write failed (${e.code ?? e.message}); retrying next tick`); return false; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };

async function claim(agent, holder) {
  const r = await call('autopilot', { agent, action: 'claim', faculties: ['movement', 'work'], by: holder,
    lease_ms: LEASE_MS, why: `swarm: following ${holder.slice(6, holder.indexOf('@'))}` }, 15_000).catch(e => ({ error: e.message }));
  // `claimFaculties` answers {granted, refused}; both faculties granted is the only success.
  const granted = new Set(r?.granted ?? []);
  return { ok: granted.has('movement') && granted.has('work'), r };
}
const heartbeat = (agent, holder) =>
  call('autopilot', { agent, action: 'heartbeat', by: holder, lease_ms: LEASE_MS }, 15_000).catch(e => ({ error: e.message }));
const release = (agent, holder) =>
  call('autopilot', { agent, action: 'yield', faculties: ['movement', 'work'], by: holder }, 15_000).catch(e => ({ error: e.message }));

async function leaderPiloted(leader) {
  const r = await call('pilot', { action: 'status' }, 15_000).catch(() => null);
  const rows = r?.piloted ?? [];
  return rows.some(p => p.agent === leader && p.alive !== false);
}

async function run(leader) {
  const holder = holderFor(leader);
  const started = Date.now();
  let state = { format: 'm59-swarm/1', fleet: FLEET, leader, holder, driver_pid: process.pid, started_at: started,
                phase: 'following', formation: 'wedge', min_max_health: MIN_MAX_HEALTH,
                members: {}, leader_room: null, leader_room_at: null };
  writeState(FLEET, state);
  log(`swarm on: leader ${leader}; members join from his room (max health >= ${MIN_MAX_HEALTH})` +
      (UNTIL_STOP ? '; ends only on stop' : '; ends when his client closes'));
  const refusedOnce = new Map();
  let lastBeat = 0, leaderSeenPilotedAt = Date.now(), returningSince = null;

  for (;;) {
    await new Promise(r => setTimeout(r, TICK_MS));
    const disk = readState(FLEET);
    if (disk?.stop_requested && state.phase === 'following') {
      state.phase = disk.stop_here ? 'releasing' : 'returning';
      log(`stop asked: ${state.phase === 'returning' ? 'members walk back where they joined' : 'released where they stand'}`);
    }
    const now = Date.now();
    const sightings = readSightings(FLEET, { now });

    if (state.phase === 'following') {
      if (UNTIL_STOP || await leaderPiloted(leader)) leaderSeenPilotedAt = now;
      else if (now - leaderSeenPilotedAt > LEADER_GONE_MS && now - started > LEADER_GONE_MS) {
        state.phase = 'returning';
        log(`the leader's client is gone: members walk back where they joined`);
      }
      const lr = leaderRoom(sightings);
      if (lr != null) { state.leader_room = lr; state.leader_room_at = now; }
      for (const s of sightings) {
        if (!s.sees_leader || state.members[s.agent]) continue;
        const e = eligibility(s, { minMaxHealth: MIN_MAX_HEALTH, leader });
        if (!e.ok) {
          if (refusedOnce.get(s.agent) !== e.why) log(`  ${s.agent} not joining: ${e.why}`);
          refusedOnce.set(s.agent, e.why);
          continue;
        }
        const c = await claim(s.agent, holder);
        if (!c.ok) { log(`  ${s.agent} could not be claimed: ${JSON.stringify(c.r).slice(0, 160)}`); continue; }
        state.members[s.agent] = { joined_at: now, home_room: Number(s.room), character: s.character ?? null };
        log(`  ${s.agent} joined from room ${s.room}`);
      }
      // A member whose maximum health fell under the line leaves, where it stands.
      for (const s of sightings) {
        if (!state.members[s.agent] || Number(s.max_health) >= MIN_MAX_HEALTH) continue;
        await release(s.agent, holder);
        log(`  ${s.agent} left: max health ${s.max_health} is under ${MIN_MAX_HEALTH}`);
        delete state.members[s.agent];
      }
    }

    if (now - lastBeat >= HEARTBEAT_MS || state.phase !== 'following') {
      lastBeat = now;
      for (const agent of Object.keys(state.members)) {
        const r = await heartbeat(agent, holder);
        // `heartbeatFaculties` answers {renewed}; nothing renewed means the keeper restarted and
        // lost the claim (or a newer holder took it), so ask again.
        if (!(r?.renewed?.length >= 2)) {
          const c = await claim(agent, holder);       // a keeper that restarted lost the claim
          if (!c.ok) log(`  ${agent}: heartbeat and re-claim both failed`);
        }
      }
    }

    if (state.phase === 'releasing') {
      for (const agent of Object.keys(state.members)) await release(agent, holder);
      state.members = {};
    } else if (state.phase === 'returning') {
      returningSince ??= now;
      const byAgent = new Map(sightings.map(s => [s.agent, s]));
      for (const [agent, m] of Object.entries(state.members)) {
        const home = Number(byAgent.get(agent)?.room) === Number(m.home_room);
        if (home || now - returningSince > RETURN_MS) {
          await release(agent, holder);
          log(`  ${agent} released ${home ? `home in ${m.home_room}` : `after ${Math.round(RETURN_MS / 60000)} min, not home`}`);
          delete state.members[agent];
        }
      }
    }
    save(state);
    if (state.phase !== 'following' && !Object.keys(state.members).length) {
      state.ended_at = Date.now();
      save(state);
      log('swarm ended');
      return 0;
    }
  }
}

const cmd = argv[0];
if (cmd === 'start') {
  const leader = opt('--leader');
  if (!leader) { console.error('usage: m59-swarm.mjs start --leader <agent> [--fleet <name>]'); process.exit(2); }
  const prior = readState(FLEET);
  if (prior && !prior.ended_at && prior.driver_pid && alive(prior.driver_pid)) {
    console.error(`a swarm is already running (leader ${prior.leader}, driver pid ${prior.driver_pid}); stop it first`);
    process.exit(1);
  }
  process.exit(await run(leader));
} else if (cmd === 'stop') {
  const s = readState(FLEET);
  if (!s || s.ended_at) { console.log('no swarm is running'); process.exit(0); }
  writeState(FLEET, { ...s, stop_requested: Date.now(), stop_here: has('--here') });
  console.log(`asked the swarm (leader ${s.leader}) to stop: ${has('--here') ? 'released where they stand' : 'members walk back where they joined'}`);
} else if (cmd === 'status') {
  const s = readState(FLEET);
  if (!s) { console.log(`no swarm state at ${statePath(FLEET)}`); process.exit(0); }
  console.log(JSON.stringify({ leader: s.leader, phase: s.ended_at ? 'ended' : s.phase, driver_alive: alive(s.driver_pid),
    leader_room: s.leader_room, members: s.members }, null, 2));
} else {
  console.error('usage: m59-swarm.mjs start --leader <agent> | stop [--here] | status   [--fleet <name>] [--url <broker>]');
  process.exit(2);
}
