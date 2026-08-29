// AN AGENT NAME THAT NOBODY ANSWERS TO IS A TYPO, NOT A CHARACTER.
//
// The broker's `session()` used to mint a bare `Session` for whatever string it was
// handed. A missing name was already guarded — that fix is in m59-broker.mjs and its
// comment explains why ("a phantom keyed `undefined` — never in game, never doing
// anything, and counted"). A name that is PRESENT and WRONG went straight through it.
//
// What that costs, measured on fleet `lan` 2026-08-29: one call naming the CHARACTER
// (`JohnsSlave`) instead of the AGENT (`psycho`) minted a session that can never be in
// game, because nothing will ever try to join a name the roster does not know. Every
// later call against it threw `agent "JohnsSlave" is not in game — call join first`,
// which is a sentence about a CONNECTION and the fault was a NAME. The phantom then
// inflated `sessions.size`, added an `in_game: false` row to `fleet`, and made
// `m59-service.mjs status` print "1 character(s) are not in game — the broker rejoins
// them on its own; watch the log" — a recovery that is structurally impossible, because
// the 45s rejoin sweep iterates the ROSTER and the phantom is not in it. One typo
// degraded every health check for the life of the broker process.
//
// So the decision lives here, on its own, as a pure function: m59-broker.mjs cannot be
// imported without starting a broker, and a rule that cannot be asked a question offline
// is how the null-name half of this bug went a year without its sibling being noticed.
//
// `node tools/m59-phantom-test.mjs` is the guard.

// How many roster names an error message will list before it summarises. Twenty-one is
// prod and thirty-seven is the old local fleet; both should print in full, because the
// whole value of the message is being able to see the name you meant.
const NAME_LIST_CAP = 40;

const same = (a, b) =>
  typeof a === 'string' && typeof b === 'string' &&
  a.toLowerCase() === b.toLowerCase();

// The roster, in the only shape this file needs: which agent, and which character that
// agent plays. Accepts the broker's `fleetState` Map directly, an array of rows, or
// anything iterable of `[agent, entry]` pairs.
export function rosterRows(roster) {
  if (!roster) return [];
  const out = [];
  const push = (agent, character) => {
    if (typeof agent === 'string' && agent) out.push({ agent, character: character ?? null });
  };
  if (typeof roster[Symbol.iterator] === 'function' && !Array.isArray(roster)) {
    for (const [agent, entry] of roster) push(agent, entry?.credentials?.character ?? entry?.character);
    return out;
  }
  for (const r of roster) {
    if (Array.isArray(r)) push(r[0], r[1]?.credentials?.character ?? r[1]?.character);
    else if (r && typeof r === 'object') push(r.agent, r.credentials?.character ?? r.character);
    else push(r, null);
  }
  return out;
}

// THE MESSAGE IS THE FIX, as much as the refusal is.
//
// The operator's next action is entirely decided by which of three things this was: a
// character name where an agent name goes (by far the commonest — the fleet page prints
// both), a genuine typo, or a first-time join that has not been given credentials yet.
// So the message answers all three rather than saying "unknown agent" and stopping.
export function unknownAgentMessage(name, roster = []) {
  const rows = rosterRows(roster);
  const head = `unknown agent "${name}" — no session was created for it`;
  if (!rows.length)
    return `${head}. This broker holds no roster, so there is nothing to match it against; ` +
           `a first-time join passes account and password.`;
  const byCharacter = rows.find(r => same(r.character, name));
  const names = rows.map(r => r.agent);
  const listed = names.length <= NAME_LIST_CAP
    ? names.join(', ')
    : `${names.slice(0, NAME_LIST_CAP).join(', ')} … and ${names.length - NAME_LIST_CAP} more`;
  return head +
    (byCharacter
      ? `. "${name}" is the CHARACTER of agent "${byCharacter.agent}" — pass agent:"${byCharacter.agent}". `
      : `. ` ) +
    `Roster agents (${names.length}): ${listed}.` +
    (byCharacter ? '' : ' To introduce a new one, call `join` with account and password.');
}

// WHAT `session(name)` SHOULD DO, WITHOUT A BROKER TO ASK.
//
//   held         — a session already exists under this name; hand it back
//   keeper       — the name is a keeper-backed agent; build the KeeperProxy
//   bare         — mint a bare Session: a roster agent that has not joined yet, or a
//                  caller that is deliberately introducing a new one (`create`)
//   refuse       — nobody answers to this name; `error` says so and names the roster
//
// `create` is the whole of the exception, and it is deliberately narrow: `join` and
// `create_character` are the two tools whose JOB is to introduce a name the broker has
// never seen. Every other tool asking for a name nobody knows is a typo, and the cost of
// treating it as one is a single failed call instead of a degraded fleet board.
export function resolveAgentName(name, {
  held = false, keeperBacked = false, inRoster = false, create = false, roster = [],
} = {}) {
  if (name == null || name === '')
    return { action: 'refuse', error: 'no agent named — every fleet tool takes an `agent`' };
  if (typeof name !== 'string')
    return { action: 'refuse', error: `agent must be a name, got ${typeof name}` };
  if (held) return { action: 'held' };
  if (keeperBacked) return { action: 'keeper' };
  if (inRoster || create) return { action: 'bare' };
  return { action: 'refuse', error: unknownAgentMessage(name, roster) };
}
