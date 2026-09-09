// WHAT A HOST DOES, AS A FILE ON DISK.
//
// A host is a character that runs a script. The script is data, not code, and it lives in
// `substrate/menagerie/scripts/<name>.json` — one file per behaviour, reloaded when its
// mtime changes, so changing what a merchant says is an edit and not a restart.
//
// IT IS DATA ON PURPOSE, AND THE REASON IS THE SAME ONE THE DUM BOT EXISTS FOR.
//
// This repository's boundary doctrine splits behaviour by CLOCK: anything that has to be
// right within a second stays in the harness, anything re-decidable in five minutes
// belongs to whoever the operator pointed at the fleet. A host is the far end of that
// spectrum — a merchant's whole job is decided in advance and re-decided never — so its
// behaviour is a table rather than a program. A table cannot loop, cannot allocate, cannot
// hold a socket, and cannot be halfway through something when the process dies.
//
// And there is no language model anywhere in this file, for the same reason there is none
// in m59-chatter.mjs: the input is a sentence typed by a stranger who may be trying to
// make the thing reading it do something. A lookup table cannot be injected. What a host
// says to a player is a string an operator wrote, chosen by a regular expression an
// operator wrote, and that is the whole of it.
//
// `node tools/m59-menagerie-script-test.mjs` is the guard.

// A pattern from disk is compiled once at load and bounded, because a script is an
// operator's file and an operator's typo should be a refused load rather than a host that
// stops answering anybody. Length is a crude proxy for catastrophic backtracking and it is
// the right kind of crude: it refuses the shapes nobody writes on purpose.
const MAX_PATTERN = 200;
const MAX_LINE = 400;            // what the game will actually carry in one say
const MAX_LINES = 24;

const arr = v => Array.isArray(v) ? v : (v == null ? [] : [v]);
const str = v => typeof v === 'string' ? v.trim() : '';

function compile(pattern, where, problems) {
  const p = str(pattern);
  if (!p) { problems.push(`${where}: empty pattern`); return null; }
  if (p.length > MAX_PATTERN) {
    problems.push(`${where}: pattern is ${p.length} characters (max ${MAX_PATTERN})`);
    return null;
  }
  try { return new RegExp(p, 'i'); }
  catch (e) { problems.push(`${where}: ${e.message}`); return null; }
}

function lines(value, where, problems) {
  const out = [];
  for (const l of arr(value)) {
    const s = str(l);
    if (!s) continue;
    if (s.length > MAX_LINE) { problems.push(`${where}: a line is ${s.length} characters (max ${MAX_LINE})`); continue; }
    out.push(s);
  }
  if (out.length > MAX_LINES) problems.push(`${where}: ${out.length} lines (max ${MAX_LINES})`);
  return out.slice(0, MAX_LINES);
}

// PARSE, VALIDATE AND REPORT — never throw, never half-load.
//
// A script that will not parse must leave the host doing what it was already doing, which
// is this repository's standing rule for every file that carries orders ("silence means the
// behaviour that was already there, never an empty policy"). So this returns a result with
// `ok` and `problems` rather than throwing, and the runtime keeps the last good version.
export function parseScript(raw, name = '?') {
  const problems = [];
  let doc = raw;
  if (typeof raw === 'string') {
    try { doc = JSON.parse(raw); }
    catch (e) { return { ok: false, name, problems: [`will not parse: ${e.message}`] }; }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc))
    return { ok: false, name, problems: ['a script is a JSON object'] };

  const kind = str(doc.kind) || 'idle';
  if (!['merchant', 'crier', 'idle'].includes(kind))
    problems.push(`kind ${JSON.stringify(kind)} is not one of merchant, crier, idle`);

  // Dialogue: the ordered table. First match wins, which is the same rule m59-chatter.mjs
  // uses and for the same reason — the specific patterns go before the loose ones and the
  // operator controls the order by controlling the file.
  const dialogue = [];
  for (const [i, rule] of arr(doc.dialogue).entries()) {
    const where = `dialogue[${i}]`;
    const re = compile(rule?.when, where, problems);
    const say = lines(rule?.say, where, problems);
    if (!re) continue;
    if (!say.length) { problems.push(`${where}: matches but says nothing`); continue; }
    dialogue.push({ intent: str(rule.intent) || `rule${i}`, re, say, ends: rule.ends === true });
  }

  const broadcast = {
    every_s: Math.max(30, Number(doc.broadcast?.every_s) || 240),
    lines: lines(doc.broadcast?.lines, 'broadcast', problems),
  };

  // The routine: what the host does when nobody is talking to it. A bounded, ordered list
  // of steps, cycled. `stand` is the default and the safe one.
  const routine = [];
  for (const [i, step] of arr(doc.routine).entries()) {
    const where = `routine[${i}]`;
    const act = str(step?.do);
    if (!['stand', 'broadcast', 'patrol'].includes(act)) {
      problems.push(`${where}: "${act}" is not one of stand, broadcast, patrol`); continue;
    }
    const seconds = Math.max(5, Number(step?.seconds) || 60);
    const to = step?.to && Number.isSafeInteger(Number(step.to.col)) &&
               Number.isSafeInteger(Number(step.to.row))
      ? { col: Number(step.to.col), row: Number(step.to.row) } : null;
    if (act === 'patrol' && !to) { problems.push(`${where}: patrol needs to:{col,row}`); continue; }
    routine.push({ do: act, seconds, to });
  }
  if (!routine.length) routine.push({ do: 'stand', seconds: 120, to: null });

  const shop = parseShop(doc.shop, problems);

  return {
    ok: problems.length === 0,
    name: str(doc.name) || name,
    kind, dialogue, broadcast, routine, shop,
    greeting: lines(doc.say?.greeting, 'say.greeting', problems),
    problems,
  };
}

function parseShop(raw, problems) {
  if (!raw || typeof raw !== 'object') return null;
  const ratio = (v, d, where) => {
    if (v == null) return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > 10) { problems.push(`shop.${where}: ${v} is not a sane ratio`); return d; }
    return n;
  };
  return {
    // What the host asks for its stock, and what it offers for yours, both as multiples of
    // the estimated value. A merchant that buys at more than it sells for is a bug the
    // operator will not notice until the purse is empty, so it is checked here.
    sell_markup: ratio(raw.sell_markup, 1.25, 'sell_markup'),
    buy_markdown: ratio(raw.buy_markdown, 0.6, 'buy_markdown'),
    haggle: {
      // How far down from the asking price the host will actually go, and in how many
      // rounds. Below the floor it refuses, and it says so rather than going quiet.
      min_ratio: ratio(raw.haggle?.min_ratio, 0.85, 'haggle.min_ratio'),
      max_rounds: Math.max(0, Math.min(5, Number(raw.haggle?.max_rounds) || 2)),
    },
    // THE FLEET'S OWN CHARACTERS TRADE FREE WHEN THE SHOP IS DOING WELL.
    //
    // The operator's rule: "maybe buy/sells are free when the shop is doing well, but if
    // sales aren't happening we gotta pay, too". A number rather than a flag, so the
    // behaviour is continuous and legible: above this many shillings taken, fleet
    // characters are not charged.
    free_for_fleet_above: Math.max(0, Number(raw.free_for_fleet_above) || 0),
    wants: arr(raw.wants).map(str).filter(Boolean),
    refuses: arr(raw.refuses).map(str).filter(Boolean),
  };
}

// If the two ratios cross, the shop loses money on every transaction and looks busy doing
// it. Reported by `scripts`, not enforced — an operator may genuinely want a loss leader.
export function shopWarnings(shop) {
  if (!shop) return [];
  const out = [];
  if (shop.buy_markdown >= shop.sell_markup)
    out.push(`buys at ${shop.buy_markdown}x and sells at ${shop.sell_markup}x — it loses ` +
             `money on every item that passes through it`);
  if (shop.haggle.min_ratio > 1)
    out.push(`haggle.min_ratio is ${shop.haggle.min_ratio} — it will never accept an offer`);
  return out;
}

// WHAT TO SAY, given what was said.
//
// Returns the matched rule and one line from it, or null to let the caller escalate. The
// line is chosen by a counter rather than at random so that a host asked the same question
// twice does not answer identically — a bot that repeats itself word for word is the
// single clearest tell there is, and rotating costs nothing.
export function respondTo(script, said, { turn = 0 } = {}) {
  const text = String(said ?? '');
  if (!text.trim() || !script?.dialogue?.length) return null;
  for (const rule of script.dialogue) {
    if (!rule.re.test(text)) continue;
    return { intent: rule.intent, say: rule.say[turn % rule.say.length], ends: rule.ends };
  }
  return null;
}

// THE HAGGLE, AS ARITHMETIC.
//
// A player offers a number. The host accepts it, counters, or refuses — and the decision is
// pure, so it can be checked without a game. `rounds` is how many times this player has
// already been countered, which is what stops a negotiation going on for ever: at
// max_rounds the host takes the best offer on the table or ends it.
export function haggle({ asking, offered, shop, rounds = 0 }) {
  const ask = Number(asking);
  const bid = Number(offered);
  if (!Number.isFinite(ask) || ask <= 0) return { verdict: 'refuse', why: 'nothing is priced' };
  if (!Number.isFinite(bid) || bid < 0) return { verdict: 'counter', price: Math.round(ask), why: 'no offer made' };

  const floor = Math.ceil(ask * shop.haggle.min_ratio);
  if (bid >= ask) return { verdict: 'accept', price: Math.round(bid), why: 'at or above asking' };
  if (bid >= floor) return { verdict: 'accept', price: Math.round(bid), why: 'above the floor' };
  if (rounds >= shop.haggle.max_rounds)
    return { verdict: 'refuse', price: floor, why: `no lower than ${floor}` };

  // Meet in the middle, but never below the floor, and never below what was offered.
  const counter = Math.max(floor, Math.round((ask + bid) / 2));
  return { verdict: 'counter', price: counter, why: `round ${rounds + 1} of ${shop.haggle.max_rounds}` };
}

// WHAT THIS ITEM IS WORTH TO THIS SHOP, and whether it wants it at all.
//
// `wants` and `refuses` are substring lists rather than an item taxonomy on purpose: a
// merchant script is an operator's note about what to stock, not a model of the game's
// item tree. `refuses` wins, because the thing an operator most needs to be able to say is
// "never take one of these".
export function priceFor(item, { shop, estimate }) {
  const name = String(item?.name ?? item ?? '').toLowerCase();
  if (!name) return { ok: false, why: 'no item named' };
  for (const r of shop.refuses)
    if (name.includes(r.toLowerCase())) return { ok: false, why: `does not deal in ${r}` };
  if (shop.wants.length && !shop.wants.some(w => name.includes(w.toLowerCase())))
    return { ok: false, why: 'not what this shop deals in' };
  const base = Number(estimate);
  if (!Number.isFinite(base) || base <= 0) return { ok: false, why: 'no value estimate for it' };
  return {
    ok: true,
    buy: Math.max(1, Math.round(base * shop.buy_markdown)),   // what the host pays you
    sell: Math.max(1, Math.round(base * shop.sell_markup)),   // what the host charges you
  };
}

// WHICH STEP OF THE ROUTINE IS DUE.
//
// The routine is a cycle of steps with durations. This is a pure function of the elapsed
// time so the runtime holds no schedule state of its own — a driver that crashes and comes
// back resumes at the right place instead of restarting the cycle, and the whole thing can
// be tested by passing it a number.
export function stepAt(script, elapsedMs) {
  const steps = script?.routine ?? [];
  if (!steps.length) return { do: 'stand', seconds: 120, to: null, index: 0 };
  const total = steps.reduce((n, s) => n + s.seconds, 0) * 1000;
  let t = ((Number(elapsedMs) || 0) % total + total) % total;
  for (const [index, s] of steps.entries()) {
    if (t < s.seconds * 1000) return { ...s, index };
    t -= s.seconds * 1000;
  }
  return { ...steps[0], index: 0 };
}

// A committed example, so `scripts` has something to validate against and a new operator
// has something to copy. The real ones live in substrate/menagerie/scripts/ and are
// gitignored, because a script is an INSTRUCTION TO A CHARACTER rather than a description
// of one — the same argument this repository already makes for loadouts and playbooks.
export const EXAMPLE_MERCHANT = {
  name: 'merchant-tos',
  kind: 'merchant',
  say: { greeting: ['Well met. I buy and sell — ask me what I have.'] },
  broadcast: {
    every_s: 240,
    lines: [
      'Arms and armour, bought and sold — right here.',
      'Fair prices paid for anything you have no use for.',
    ],
  },
  dialogue: [
    { intent: 'wares', when: '\\b(what|wares|stock|sell(ing)?|buy(ing)?|shop|trade)\\b',
      say: ['I deal in arms and armour. Show me what you have and I will name a price.'] },
    { intent: 'price', when: '\\b(how much|price|cost|worth)\\b',
      say: ['Hand it to me and I will tell you what it is worth.'] },
    { intent: 'haggle', when: '\\b(too much|too dear|lower|discount|deal|cheap)\\b',
      say: ['Make me an offer and I will consider it.'] },
    { intent: 'thanks', when: '\\b(thank|thanks|cheers|ta)\\b',
      say: ['A pleasure. Come back when you have more.'], ends: true },
  ],
  routine: [
    { do: 'stand', seconds: 240 },
    { do: 'broadcast', seconds: 5 },
  ],
  shop: {
    sell_markup: 1.25,
    buy_markdown: 0.6,
    haggle: { min_ratio: 0.85, max_rounds: 2 },
    free_for_fleet_above: 5000,
    refuses: ['amulet of shadows', 'ring of lethargy'],
  },
};
