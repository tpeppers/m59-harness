// THE FLEET NEVER MEANS THE MENAGERIE. THIS IS WHERE THAT IS TRUE.
//
// The whole point of a menagerie is that "send everyone to Castle Victoria" is a sentence
// about the fleet and about nothing else. That guarantee cannot live in documentation,
// because the failure it prevents is somebody — a person at 02:00, or a language model
// reading an ambiguous instruction — doing the obvious thing with the obvious tool. It
// has to live at a door.
//
// There is exactly one door: `callTool` in m59-broker.mjs. Every MCP request, over both
// transports, goes through it, and so does nothing else. So the rule is enforced there,
// once, and decided HERE so it can be asked a question without starting a broker — the
// same argument m59-agent-name.mjs makes for the same reason, and the reason its sibling
// bug went a year unnoticed.
//
// WHAT THE RULE IS
//
//   A tool call that names a host AS ITS SUBJECT is refused. Every tool. Reads included.
//
// The qualifier is doing real work and there is exactly one exemption to it: a fleet
// character may ADDRESS a host (`say --to`), because there the host is the audience and the
// fleet character is the subject. See ADDRESSEE_FIELDS, which is a one-entry table rather
// than a rule, because the same word means "subject" one tool over.
//
// Reads included is deliberate and it is the part that will look excessive. The argument:
// an allowlist of "harmless" tools is a thing that grows, and it grows by exactly the
// reasoning that produced this feature — "well, THIS one is only looking". Meanwhile the
// cost of the strict rule is nearly zero, because the enumeration surfaces already hide
// hosts, so the only way to name one from MCP is to know its name already, and anyone who
// knows its name can run one CLI command. A rule with no exceptions is a rule that is
// still true in six months.
//
// WHAT THIS IS NOT
//
// It is not a security boundary and must never be described as one. The menagerie runtime
// reaches these same characters through the same broker, and anything that can read a file
// on this machine can do what the runtime does. This stops the MISTAKE — the fleet-wide
// instruction that sweeps up a merchant standing in Tos — and that is the entire
// requirement. An operator who deliberately wants a host does not have to fight it; they
// have to say so somewhere else, which is the point.
//
// `node tools/m59-menagerie-test.mjs` is the guard on the guard.

// Fields whose value is prose a human typed, not an identifier. A fleet character saying
// "go and see Sssss, he buys armour" must not be refused because a host is named in the
// sentence. Matching is whole-string equality everywhere else, so this list only has to
// cover fields where a bare name could legitimately BE the whole message.
const FREE_TEXT_FIELDS = new Set([
  'text', 'message', 'say', 'said', 'reason', 'note', 'description', 'label',
  'prompt', 'body', 'comment', 'why',
]);

// AN AUDIENCE IS NOT A SUBJECT.
//
// The guard's question is "is a host being COMMANDED", and for almost every tool the
// answer is "yes, if it is named at all". Speech is the exception, and it is not a corner
// case — it is half the point of having a merchant.
//
//     say { agent: 'shadowb01', type: 'tell', to: 'Ssss', text: 'what do you sell?' }
//
// Here the character being commanded is `shadowb01`, a fleet character, and the host is who
// it is TALKING TO. Refusing that would forbid the fleet from trading with its own
// merchant, which is the reason the merchant exists. Measured live on shadow, 2026-09-09,
// where the first version of this guard refused exactly that call.
//
// The exemption is per TOOL and per FIELD, and deliberately tiny, because the same word
// means different things one tool over: `to` on `supply` is the character that RECEIVES the
// goods — a subject, and a host named there is being driven — while `to` on `travel` is a
// room number. So this is a table with one entry rather than a rule about the word "to",
// and adding a second entry should require the same argument this one carries.
//
// The host's ANSWER is still entirely its own: what it says back is decided by its script,
// through its own inbox, by the menagerie runtime. Nothing here lets a fleet caller put
// words in a host's mouth.
const ADDRESSEE_FIELDS = new Map([
  ['say', new Set(['to'])],
]);

// A menagerie caller is the runtime that OWNS the hosts. It proves it with a token the
// broker minted at startup and wrote to a file only a local process can read — the same
// trust model as the RTS read token, and for the same reason: this transport has no
// authentication of its own, so authority must be carried, not inferred from reachability.
export function isMenagerieCaller(caller) {
  return caller?.menagerie === true;
}

// EVERY STRING IN THE ARGUMENTS, so a tool added next month is covered without anybody
// remembering to add it here.
//
// The alternative — a list of parameter names that mean "an agent" — is a list that was
// already wrong when this was written: the obvious `agent` is joined by `agents` (an array
// of objects, in commander_claim), `partner`, `farmer`, `target`, and the two ends of a
// supply. A guard that has to be taught each new one fails open on the one nobody taught
// it, and failing open here means a host takes a fleet order.
function* strings(value, key = null, depth = 0, exempt = null) {
  if (depth > 6) return;                       // bounded; args are small and not cyclic
  if (typeof value === 'string') {
    if (!FREE_TEXT_FIELDS.has(key) && !exempt?.has(key)) yield value;
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) yield* strings(v, key, depth + 1, exempt);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) yield* strings(v, k, depth + 1, exempt);
  }
}

// The names that mean a host: its AGENT name and its CHARACTER name, both, because the
// fleet page prints both and naming the character where the agent goes is this
// repository's single commonest identifier mistake (see m59-agent-name.mjs).
export function hostNameIndex(hosts) {
  const index = new Map();                     // lowercased name -> { agent, character }
  const add = (name, agent, character) => {
    if (typeof name === 'string' && name.trim())
      index.set(name.trim().toLowerCase(), { agent, character });
  };
  const entries = hosts instanceof Map ? hosts.entries() : Object.entries(hosts ?? {});
  for (const [agent, entry] of entries) {
    const character = entry?.credentials?.character ?? entry?.character ?? null;
    add(agent, agent, character);
    add(character, agent, character);
  }
  return index;
}

// THE DECISION.
//
//   { action: 'allow' }                     nothing in this call names a host
//   { action: 'allow', menagerie: true }    it does, and the caller owns the menagerie
//   { action: 'refuse', error, host }       it does, and the caller is the fleet's
//
// `hosts` is the menagerie roster (a Map or a plain object). An EMPTY menagerie allows
// everything, which is correct and is also why loadMenagerie() refuses to treat an
// unparseable roster as empty: a menagerie that fails to load is an open door, so it must
// fail loudly at load rather than quietly here.
export function guardToolCall({ tool, args, caller, hosts, index = null } = {}) {
  const names = index ?? hostNameIndex(hosts);
  if (!names.size) return { action: 'allow' };

  let hit = null;
  for (const s of strings(args, null, 0, ADDRESSEE_FIELDS.get(tool))) {
    const found = names.get(s.trim().toLowerCase());
    if (found) { hit = { named: s, ...found }; break; }
  }
  if (!hit) return { action: 'allow' };
  if (isMenagerieCaller(caller)) return { action: 'allow', menagerie: true, host: hit.agent };

  return {
    action: 'refuse',
    host: hit.agent,
    error:
      `"${hit.named}" is a MENAGERIE HOST, not a fleet character, and hosts are not ` +
      `commandable from here.\n` +
      `  tool        ${tool ?? '?'}\n` +
      `  host        ${hit.agent}${hit.character ? ` (character ${hit.character})` : ''}\n` +
      `A host runs a script on disk and is driven by the menagerie runtime, which holds ` +
      `the only credential for it. The fleet's tools refuse every host by name so that a ` +
      `fleet-wide instruction cannot pick one up by accident — which is the whole reason ` +
      `the menagerie exists.\n` +
      `To look at it:      node tools/m59-menagerie.mjs status\n` +
      `To change what it does:  edit its script under substrate/menagerie/scripts/\n` +
      `To take it back into the fleet:  node tools/m59-menagerie.mjs discharge ${hit.agent}`,
  };
}

// WHAT A FLEET SURFACE SHOWS.
//
// Hosts are removed from every fleet listing, and the count of what was removed is
// returned with them, because a listing that silently drops rows is the failure this
// repository has paid for more than once — a board that is quietly about less than you
// think reads exactly like a healthy one.
export function withoutHosts(rows, hostNames, nameOf = r => r) {
  const hidden = new Set([...(hostNames ?? [])].map(n => String(n).toLowerCase()));
  if (!hidden.size) return { rows, hiddenCount: 0 };
  const kept = [];
  let hiddenCount = 0;
  for (const r of rows) {
    const name = String(nameOf(r) ?? '').toLowerCase();
    if (name && hidden.has(name)) { hiddenCount++; continue; }
    kept.push(r);
  }
  return { rows: kept, hiddenCount };
}

// "DO NOT SHOOT" IS A DIFFERENT QUESTION FROM "OBEY A FLEET ORDER", AND THEY HAVE
// DIFFERENT ANSWERS.
//
// This is the one place the split deliberately does NOT apply, and getting it backwards
// is expensive in a way that is worth spelling out. `fleetCharacters()` in the broker
// answers "which characters on this server are ours" and it feeds the party module, the
// grudge book and the fleetmate check. A host excluded from THAT set is a stranger to
// twenty-one armed characters standing in the same town — and this repository has already
// killed one of its own that way (Statler, 2026-08-27: a keeper process that could not see
// its own roster called the whole fleet strangers, and a fleet-mate turned red by hand was
// then shot by everyone with a false grudge).
//
// So: hosts are OURS for every purpose that decides whether to attack, heal, buff or
// step around a body. They are NOT ours for any purpose that decides who obeys an
// instruction. Two questions, two answers, one function each, and this is the name of
// the first one.
export const alliedCharacters = (fleetChars, hostChars) =>
  new Set([...(fleetChars ?? []), ...(hostChars ?? [])]);
