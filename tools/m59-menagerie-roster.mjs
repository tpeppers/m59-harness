// WHICH CHARACTERS ARE THE FLEET, AND WHICH ONES ARE ONLY RIDING ALONG.
//
// The fleet is the thing the operator means. "Send everyone to Castle Victoria" is a
// sentence about twenty-one Muppets, and it has to keep being a sentence about
// twenty-one Muppets on the day a second population of characters starts sharing their
// broker, their keeper band, their safe-spot book and their grudge book.
//
// That second population is the MENAGERIE. Its members are HOSTS: characters that exist
// to run a script — a merchant standing in Tos selling the fleet's excess gear, talking
// to whoever talks to it — rather than to be commanded. They are on the same server as
// the fleet, they are logged in by the same broker, and they must never once be included
// in a fleet instruction.
//
// THE SEPARATION IS A FILE, NOT A NAMING CONVENTION.
//
// This repository already learned that lesson one layer up, in m59-which.mjs: "a fleet is
// its ROSTER FILE and never its name", because two checkouts can each hold a fleet called
// `prod` and they are not the same characters. The same argument applies here with the
// consequences reversed — one broker, two rosters — so a host is a host because of the
// FILE its credentials were loaded from, and for no other reason. Not a name prefix, not
// a flag inside the fleet roster, not a convention. A prefix is a thing somebody renames;
// a flag inside the fleet roster is a thing a fleet-wide write clobbers, and the fleet
// roster is written by a dozen code paths including every keeper that starts.
//
// So the menagerie roster sits BESIDE the fleet roster and is derived from it:
//
//     substrate/fleets/shadow.json     ->  substrate/fleets/shadow.menagerie.json
//     substrate/fleet-state.json       ->  substrate/fleet-state.menagerie.json
//
// Derived rather than configured, because a menagerie pointed at the wrong fleet is
// exactly the failure this whole file exists to prevent, and a path somebody types is a
// path somebody mistypes. `M59_STATE_FILE` moves both together, which is what makes this
// testable without a fleet.
//
// It cannot be addressed as a fleet in its own right: `--fleet shadow.menagerie` is
// refused by the name validator in m59-fleetpath.mjs (`NAME_OK` allows no dot), so there
// is no spelling of a fleet command that resolves a menagerie roster as the fleet.
//
// And it is a roster, so it holds passwords, so it is gitignored — the existing
// `/substrate/fleets/` rule already covers the named case and .gitignore carries the
// unnamed one.
//
// `node tools/m59-menagerie-test.mjs` is the guard.

import { readFileSync, existsSync } from 'node:fs';

// The roster shape is the fleet's own — `{ agent: { credentials, autopilot } }` — because
// the broker's plumbing (join, keeper spawn, rejoin, account leases) has to serve both and
// a second shape would mean a second copy of all of it. A host entry adds ONE key:
//
//   "shadowb19": {
//     "credentials": { "account": "...", "password": "...", "host": "...", "port": 15959,
//                      "character": "Sssss" },
//     "host": { "script": "merchant-tos", "station": { "room": 54, "col": 30, "row": 22 } }
//   }
//
// `host` is what the menagerie runtime reads. Everything else is what the broker reads.

export function menageriePathFor(stateFile) {
  const s = String(stateFile ?? '');
  if (!s) throw new Error('menageriePathFor needs the fleet roster path');
  return s.replace(/\.json$/i, '') + '.menagerie.json';
}

// A menagerie path is recognisable on sight, which matters for every tool that
// enumerates roster files and would otherwise offer one as a fleet.
export const isMenageriePath = p => /\.menagerie\.json$/i.test(String(p ?? ''));

// PARSE FAILURE IS NOT AN EMPTY MENAGERIE.
//
// This is the rule m59-localpolicy.mjs already applies to policy files, and it matters
// more here: an unreadable menagerie roster that answered "no hosts" would hand every
// host name straight back to the fleet's command surface — the refusal below is driven by
// this set, so an empty set is an OPEN DOOR. A file that exists and will not parse is
// therefore an error the caller has to deal with, and only a file that is genuinely
// absent is an empty menagerie.
export function loadMenagerie(path, { required = false } = {}) {
  if (!existsSync(path)) {
    if (required) throw new Error(`no menagerie roster at ${path}`);
    return { path, present: false, hosts: new Map(), names: new Set() };
  }
  let parsed;
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e) { throw new Error(`menagerie roster ${path} could not be read: ${e.message}`); }
  try { parsed = JSON.parse(raw); }
  catch (e) {
    throw new Error(`menagerie roster ${path} will not parse (${e.message}) — this is NOT ` +
                    `an empty menagerie: every host in it would fall back to the fleet's ` +
                    `command surface. Fix the file or move it aside.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`menagerie roster ${path} is not an object of agent -> entry`);

  const hosts = new Map();
  for (const [agent, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== 'object') continue;
    hosts.set(agent, entry);
  }
  return { path, present: true, hosts, names: new Set(hosts.keys()) };
}

// WHO IS WHO, given both rosters.
//
// Returns the names on each side and — the field worth reading — `overlap`: agents that
// appear in BOTH files. That is a corrupted split rather than a curiosity, because the
// two files are written by different processes and whichever wrote last decides what the
// character is. It is reported rather than silently resolved, for the same reason the
// keeper band registry refuses a duplicate fleet key instead of keeping the last one.
export function splitRosters(fleetNames, hostNames) {
  const fleet = new Set(fleetNames ?? []);
  const hosts = new Set(hostNames ?? []);
  const overlap = [...hosts].filter(n => fleet.has(n));
  return {
    fleet: [...fleet].filter(n => !hosts.has(n)),
    hosts: [...hosts],
    overlap,
    ok: overlap.length === 0,
  };
}

// The sentence a tool prints when it has just excluded hosts from something.
//
// SAY IT, ALWAYS. Silence is the default failure mode of this game and this is the exact
// shape of it: a fleet command that quietly acts on 20 of 22 characters looks identical to
// one that acted on all of them, and the difference only becomes visible when somebody
// wonders why the merchant never went to Castle Victoria. Every surface that filters hosts
// out says how many it filtered and what reaches them.
export function excludedNote(count, { verb = 'excluded' } = {}) {
  if (!count) return null;
  return `${count} menagerie host(s) ${verb} — hosts are not the fleet and are not ` +
         `commandable from here. Use: node tools/m59-menagerie.mjs status`;
}

// WHAT A HOST ENTRY SAYS ABOUT ITSELF, validated.
//
// A host with no script is a character logged in and standing still for ever, which is
// both useless and invisible — it looks exactly like a healthy one. So the script name is
// required, and the station is required, because "where does this character live" is the
// one question the conversion path (enlist) exists to answer.
export function hostConfig(entry, agent = '?') {
  const h = entry?.host;
  if (!h || typeof h !== 'object')
    return { ok: false, why: `${agent}: roster entry has no "host" block` };
  const script = typeof h.script === 'string' ? h.script.trim() : '';
  if (!script) return { ok: false, why: `${agent}: host.script is required` };
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(script))
    return { ok: false, why: `${agent}: host.script ${JSON.stringify(script)} is not a plain name` };
  const st = h.station;
  const room = Number(st?.room);
  if (!Number.isSafeInteger(room) || room <= 0)
    return { ok: false, why: `${agent}: host.station.room is required — where does this host live?` };
  return {
    ok: true,
    script,
    station: {
      room,
      // A station's square is optional: standing anywhere in the right room is a working
      // merchant, and a col/row that is wrong for the room is worse than none at all.
      col: Number.isSafeInteger(Number(st.col)) ? Number(st.col) : null,
      row: Number.isSafeInteger(Number(st.row)) ? Number(st.row) : null,
    },
    label: typeof h.label === 'string' ? h.label : null,
  };
}
