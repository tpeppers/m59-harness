// THE PVP TELEMETRY: WHAT EACH OF OURS DID IN A FIGHT, WHERE IT STOOD, AND WHAT THE SERVER SAID BACK.
//
// tools/m59-pvp.mjs groups contact into battles. That record answered "who died" and "who hit
// whom" and nothing about intent: on 2026-10-17 the Morpheus fight read
//
//     Camilla opener_cast / Zoot turns on Morpheus / Zoot: Morpheus maims you … / Janice opener_cast
//
// and could not say whether Janice's hold landed, fizzled, or never went out. The answer was on
// disk the whole time, in the fight-message side file nothing read: Camilla's hold landed twice
// ("Morpheus is now held in place by a magical force."), Janice, Beaker and Robin each spent a
// cast on "Morpheus is already held.", and Janice's mage rite tried to put a broken leather armor
// back on ("You can't use the leather armor--it's broken."). This module joins the three halves:
//
//   ACTIONS   substrate/pvp/<fleet>/actions-<day>.jsonl, written by each keeper during a PvP window
//             (m59-combat-mode.mjs noteFightAction): every attack, cast, use, unuse, apply and
//             activate the client SENT — whoever sent it — with a location stamp, and every map
//             change. One line per packet, so an attack attempt is a line.
//   MESSAGES  messages-<day>.jsonl — every server sentence heard during the window, classified
//             here against the kod's own strings (spell.kod, the spell files, player.kod).
//   TAUNTS    substrate/victory-taunt.jsonl — the line broadcast after a won battle.
//
// THE LOCATION STAMP is the standard one: map number, coarse square, and the fine offset inside it
// in KOD units (64 to the square), e.g. `m38 r15c17 +12/+40`. A bare pair is never written
// (docs/m59-coordinates.md): `+12/+40` is always x-offset then y-offset and says so in its fields.
//
// Pure: no file is read here except by the readers at the bottom, and every reader takes its dir.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FINE = 64;   // KOD fine units per square (blakston.khd:1163) — what the wire's x,y are in

/** A body's place as the standard stamp, or null. `p` carries KOD fine x,y (and optionally row/col). */
export function locStamp(map, p) {
  if (!p) return null;
  const x = Number(p.x), y = Number(p.y);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    const row = Math.floor(y / FINE), col = Math.floor(x / FINE);
    return { map: map ?? null, row, col, x, y, fx: x - col * FINE, fy: y - row * FINE };
  }
  if (Number.isFinite(p.row) && Number.isFinite(p.col)) return { map: map ?? null, row: p.row, col: p.col, x: null, y: null, fx: null, fy: null };
  return null;
}
export function locText(l) {
  if (!l) return '?';
  const m = l.map != null ? `m${l.map} ` : '';
  const f = l.fx != null ? ` +${l.fx}/+${l.fy}` : '';
  return `${m}r${l.row}c${l.col}${f}`;
}
/** Distance in squares between two stamps on the same map, or null. */
export function squaresBetween(a, b) {
  if (!a || !b || a.map !== b.map) return null;
  if (a.x != null && b.x != null) return Math.round(Math.hypot(a.x - b.x, a.y - b.y) / FINE * 10) / 10;
  return Math.round(Math.hypot(a.row - b.row, a.col - b.col) * 10) / 10;
}

// ------------------------------------------------------------------ what a server sentence means

const clean = t => String(t ?? '').replace(/~[A-Za-z]/g, '').trim();
const art = '(?:an? |the )?';

// The kod's own strings. Each class names what it says about the CASTER's last spell.
const RULES = [
  // landed: "<target> is now held in place by a magical force." (hold.kod hold_caster), "is now blind."...
  { cls: 'spell_landed', re: new RegExp(`^${art}(.+?) is now (held in place by a magical force|blind|dazzled|deaf|slowed|paralyzed|confused|weakened|cursed|frozen|poisoned|blinded)\\b`, 'i'),
    take: m => ({ target: m[1], effect: m[2].toLowerCase() }) },
  { cls: 'spell_upkeep', re: /^You sense a force struggling to break free of your magic\./i },
  { cls: 'spell_already', re: new RegExp(`^${art}(.+?) is already (held|blind|dazzled|deaf|slowed|[a-z ]+?)\\.$`, 'i'),
    take: m => ({ target: m[1], effect: m[2].toLowerCase() }) },
  { cls: 'spell_already', re: /^This spell is already in effect here\./i },
  { cls: 'spell_resisted', re: new RegExp(`^${art}(.+?) resists (your spell|your attempts to enchant it)`, 'i'), take: m => ({ target: m[1] }) },
  { cls: 'spell_resisted', re: /^You sense a force resisting your/i },
  { cls: 'spell_failed', re: /^You were unsuccessful in casting (.+?)\.$/i, take: m => ({ spell: m[1].toLowerCase() }) },
  { cls: 'spell_no_mana', re: /^You don't have enough mana to cast (.+?)!$/i, take: m => ({ spell: m[1].toLowerCase() }) },
  { cls: 'spell_no_reagents', re: /^You don't have the reagents to cast (.+?)!$/i, take: m => ({ spell: m[1].toLowerCase() }) },
  { cls: 'spell_too_tired', re: /^You are too tired to cast (.+?)!$/i, take: m => ({ spell: m[1].toLowerCase() }) },
  { cls: 'spell_bad_target', re: /^You can't cast (.+?) on (.+?)!$/i, take: m => ({ spell: m[1].toLowerCase(), target: m[2] }) },
  { cls: 'spell_bad_place', re: /^You can't cast (.+?) here\.$/i, take: m => ({ spell: m[1].toLowerCase() }) },
  { cls: 'spell_no_targets', re: /^There are no proper targets for (.+?)\.$/i, take: m => ({ spell: m[1].toLowerCase() }) },
  { cls: 'spell_out_of_range', re: /^(.+?) is out of range\.$/i, take: m => ({ target: m[1] }) },
  { cls: 'spell_resting', re: /^You can't cast spells while resting!/i },
  { cls: 'spell_too_soon', re: /^You've attacked a player too recently\./i },
  { cls: 'spell_silenced', re: /^Your words catch in your throat/i },
  { cls: 'spell_forgot', re: /can't quite remember this spell|Klaatu/i },
  { cls: 'spell_trance', re: /^You (?:start to cast|focus your whole will on casting) (.+?)\.$/i, take: m => ({ spell: m[1].toLowerCase() }) },
  { cls: 'spell_cast', re: /^You cast (.+?) on (.+?)\.$/i, take: m => ({ spell: m[1].toLowerCase(), target: m[2] }) },
  { cls: 'spell_advanced', re: /^You advanced in (.+?)!/i, take: m => ({ spell: m[1].toLowerCase() }) },
  // someone else's cast, as the room sees it (spell.kod:110-112)
  { cls: 'cast_seen', re: new RegExp(`^${art}(.+?) murmurs something under \\w+ breath and (?:points a finger at ${art}(.+?)|makes a mystical gesture)\\.$`, 'i'),
    take: m => ({ caster: m[1], target: m[2] ?? null }) },
  // gear
  { cls: 'gear_broken', re: /^You can't use (?:an? |the )?(.+?)--it's broken\./i, take: m => ({ item: m[1] }) },
  { cls: 'gear', re: /^You (?:are now (?:wielding|wearing)|wield|put on|take off|remove|stop wielding|unwield)\b(.*)$/i, take: m => ({ item: m[1].trim().replace(/\.$/, '') || null }) },
  // wands (the vampiric/drain wands the fleet volleys with)
  { cls: 'wand_pulse', re: /^The wand pulses once in your hand\./i },
  { cls: 'wand_hit', re: /^You cackle with glee as (.+?)'s life force is sucked away\./i, take: m => ({ target: m[1] }) },
  { cls: 'wand_dodged', re: /^(.+?) narrowly dodges your (\w+) attack\./i, take: m => ({ target: m[1], effect: m[2] }) },
  { cls: 'no_effect', re: /^(.+?) laughs off your pitiful blow\./i, take: m => ({ target: m[1] }) },
  // ours, defending
  { cls: 'defended', re: /^You (dodge|block|parry|avoid) /i, take: m => ({ effect: m[1].toLowerCase() }) },
  { cls: 'swing_in_hit', re: /^(.+?) (\w+) you with (?:his|her|its|their) (.+?)\.$/i, take: m => ({ attacker: m[1], verb: m[2], weapon: m[3] }) },
  { cls: 'kill', re: /^You killed (.+?)\.$/i, take: m => ({ target: m[1] }) },
  { cls: 'improved', re: /^You have improved in the art of (.+?)\.$/i, take: m => ({ skill: m[1] }) },
  { cls: 'door', re: /^You open the door and walk through\./i },
  // swings (stroke.kod) — the outcome rows already carry these; classified so they can be counted
  { cls: 'swing_out_hit', re: /^Your .+? (?:hits|\w+s) .+/i },
  { cls: 'swing_out_miss', re: /^You miss|^Your .+? misses /i },
  { cls: 'swing_out_of_range', re: /out of range/i },
  { cls: 'cant_see', re: /^You can't see your selected target/i },
  { cls: 'refused', re: /^(?:Only those in guilds|You can't attack|You are not allowed|The safety|Your safety)/i },
  { cls: 'death', re: /^###/ },
];

/** One server sentence -> { cls, ...fields }, or { cls: 'other' }. */
export function classifyMessage(text) {
  const t = clean(text);
  for (const r of RULES) {
    const m = r.re.exec(t);
    if (m) return { cls: r.cls, ...(r.take ? r.take(m) : {}) };
  }
  return { cls: 'other' };
}

// A cast's own reply arrives within the spell timer; the first classified spell line the CASTER
// hears after sending it is the answer. A trance line is not an answer — its result follows it.
const CAST_REPLY_MS = 2500;
const SPELL_REPLY = new Set(['spell_landed', 'spell_already', 'spell_resisted', 'spell_failed', 'spell_no_mana',
  'spell_no_reagents', 'spell_too_tired', 'spell_bad_target', 'spell_bad_place', 'spell_no_targets', 'spell_out_of_range',
  'spell_resting', 'spell_too_soon', 'spell_silenced', 'spell_forgot', 'spell_cast']);
export const OUTCOME_LABEL = {
  spell_landed: 'landed', spell_already: 'wasted (already in effect)', spell_resisted: 'resisted', spell_failed: 'failed by chance',
  spell_no_mana: 'no mana', spell_no_reagents: 'no reagents', spell_too_tired: 'too tired', spell_bad_target: 'bad target',
  spell_bad_place: 'not castable here', spell_no_targets: 'no proper target', spell_out_of_range: 'out of range',
  spell_resting: 'refused while resting', spell_too_soon: 'refused: attacked a player too recently', spell_silenced: 'silenced',
  spell_forgot: 'forgotten', spell_cast: 'cast', no_reply: 'no reply heard',
};

const norm = n => String(n ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * One battle's telemetry. `battle` is a summarized battle from m59-pvp.mjs (start, end, ours, rooms);
 * actions, messages and taunts are the side-file rows. Returns what the page and the CLI draw.
 */
export function battleTelemetry(battle, { actions = [], messages = [], taunts = [], padMs = 30_000, isOurs = null } = {}) {
  const lo = battle.start - padMs, hi = battle.end + padMs;
  const ours = new Set((battle.ours ?? []).map(o => norm(o.name)));
  const rooms = new Set(battle.rooms ?? []);
  const inBattle = r => r.at >= lo && r.at <= hi &&
    (ours.has(norm(r.observer)) || (r.room != null && rooms.has(r.room)) || (r.loc?.map != null && rooms.has(r.loc.map)) ||
     (r.verb === 'traverse' && (rooms.has(r.from) || rooms.has(r.to))));
  const acts = actions.filter(inBattle).sort((a, b) => a.at - b.at);
  // Speech (kind 'said', m59-pvp-callout.mjs) is chat, never a game sentence: it is not classified.
  const heard = messages.filter(inBattle).map(m => ({ ...m, ...(m.kind === 'said' ? { cls: 'chat' } : classifyMessage(m.text)) })).sort((a, b) => a.at - b.at);

  // Every cast, joined to its reply. A fight from before the actions file existed still has its
  // opener's `opener_cast` milestone, written in the same tick the cast packet went out, so those
  // stand in as casts (marked `inferred`) — enough to say what became of every opener hold.
  const sent = acts.filter(a => a.verb === 'cast');
  for (const e of battle.events ?? []) {
    if (e.kind !== 'combat' || e.event !== 'opener_cast' || !e.observer) continue;
    if (sent.some(a => norm(a.observer) === norm(e.observer) && Math.abs(a.at - e.at) < 400)) continue;
    sent.push({ kind: 'action', verb: 'cast', at: e.at, observer: e.observer, room: e.room ?? null, loc: e.loc ?? null,
      spell: e.opener ?? e.detail?.spell ?? null, target_name: e.target ?? null, phase: e.detail?.phase ?? null,
      intent: 'pvp opener', inferred: true });
  }
  sent.sort((a, b) => a.at - b.at);
  const casts = [];
  for (const a of sent) {
    const reply = heard.find(m => norm(m.observer) === norm(a.observer) && m.at >= a.at && m.at - a.at <= CAST_REPLY_MS &&
      SPELL_REPLY.has(m.cls) && !(m.spell && a.spell && m.spell !== a.spell.toLowerCase()) && !m.used);
    if (reply) reply.used = true;
    casts.push({ ...a, outcome: reply?.cls ?? 'no_reply', reply: reply?.text ?? null, reply_ms: reply ? reply.at - a.at : null });
  }
  // Per character: what it sent, and what came of it.
  const per = new Map();
  const me = n => { const k = norm(n); if (!per.has(k)) per.set(k, { name: n, attacks: 0, vetoed: 0, casts: 0, landed: 0, wasted: 0, failed: 0, no_reply: 0, gear: 0, gear_broken: 0, said: 0, callouts: 0, maps: [], spells: {} }); return per.get(k); };
  for (const a of acts) {
    const p = me(a.observer);
    if (a.verb === 'attack') { p.attacks++; if (a.vetoed) p.vetoed++; }
    if (a.verb === 'use' || a.verb === 'unuse') p.gear++;
    if (a.verb === 'say') { p.said++; if (a.callout) p.callouts++; }
    if (a.verb === 'traverse' && a.to != null && p.maps.at(-1) !== a.to) { if (!p.maps.length && a.from != null) p.maps.push(a.from); p.maps.push(a.to); }
    if (a.loc?.map != null && !p.maps.length) p.maps.push(a.loc.map);
  }
  for (const c of casts) {
    const p = me(c.observer); p.casts++;
    const s = (p.spells[c.spell ?? '?'] ??= { sent: 0, outcomes: {} });
    s.sent++; s.outcomes[c.outcome] = (s.outcomes[c.outcome] ?? 0) + 1;
    if (c.outcome === 'spell_landed' || c.outcome === 'spell_cast') p.landed++;
    else if (c.outcome === 'spell_already') p.wasted++;
    else if (c.outcome === 'no_reply') p.no_reply++;
    else p.failed++;
  }
  for (const m of heard) if (m.cls === 'gear_broken') me(m.observer).gear_broken++;
  for (const e of battle.events ?? []) {
    if (e.context || e.kind !== 'combat' || !e.observer || e.room == null) continue;
    const p = me(e.observer);
    if (!p.maps.length) p.maps.push(e.room);
  }

  // A third-person line is heard by everyone in the room; the timeline keeps it once.
  const seen = new Map();
  const lines = [];
  const saidBy = acts.filter(a => a.verb === 'say');
  for (const m of heard) {
    if (m.cls === 'death') continue;            // the battle already has its deaths
    if (m.cls === 'chat') {
      // One of ours, heard saying what its own action row already says: the echo, not a second line.
      if (saidBy.some(a => norm(a.observer) === norm(m.speaker) && a.text === m.text && Math.abs(m.at - a.at) <= 3000)) continue;
      const k = `said|${norm(m.speaker)}|${m.text}`, twin = seen.get(k);
      if (twin && m.at - twin.at <= 1500) { if (!twin.heard_by.includes(m.observer)) twin.heard_by.push(m.observer); continue; }
      const row = { ...m, heard_by: [m.observer] };
      seen.set(k, row); lines.push(row); continue;
    }
    const third = m.cls === 'cast_seen' || (m.cls === 'other' && !/\b(you|your|yours)\b/i.test(m.text));
    const key = third ? m.text : null;
    const twin = key ? seen.get(key) : null;
    if (twin && m.at - twin.at <= 1500) { if (!twin.heard_by.includes(m.observer)) twin.heard_by.push(m.observer); continue; }
    const row = { ...m, heard_by: [m.observer] };
    if (key) seen.set(key, row);
    lines.push(row);
  }
  const taunt = taunts.filter(t => t.battle === battle.id).at(-1) ?? null;
  return {
    actions: [...acts, ...sent.filter(a => a.inferred)].sort((a, b) => a.at - b.at), casts, messages: lines,
    characters: [...per.values()].sort((a, b) => a.name.localeCompare(b.name)),
    traversals: acts.filter(a => a.verb === 'traverse'),
    // Every word said: ours (action rows, callouts marked) and theirs (heard), in time order.
    speech: [...saidBy.map(a => ({ at: a.at, speaker: a.observer, ours: true, say_type: a.say_type ?? 'say', text: a.text ?? '', room: a.room ?? null, callout: a.callout ?? null })),
      ...lines.filter(m => m.cls === 'chat').map(m => ({ at: m.at, speaker: m.speaker, ours: false, say_type: m.say_type ?? 'say', text: m.text, room: m.room ?? null, heard_by: m.heard_by }))]
      .sort((a, b) => a.at - b.at),
    taunt: taunt ? { at: taunt.at, character: taunt.spoke?.character ?? null, line: taunt.spoke?.line ?? null,
      why: taunt.spoke?.why ?? null, killer: taunt.killer ?? null, tried: taunt.tried ?? [] } : null,
  };
}

/** One telemetry row as a line of text: what the CLI prints and the page's timeline cell says. */
export function describeAction(a) {
  const where = a.loc ? ` @ ${locText(a.loc)}` : '';
  const tgt = a.target_name ? ` → ${a.target_name}${a.target_loc ? ` @ ${locText(a.target_loc)}` : ''}${a.dist != null ? ` (${a.dist} sq)` : ''}` : '';
  const why = [a.phase, a.intent].filter(Boolean).join(' / ');
  const tail = `${why ? ` [${why}]` : ''}${a.via ? ` <${a.via}>` : ''}`;
  switch (a.verb) {
    case 'attack': return `${a.observer} swings${a.vetoed ? ' (vetoed, not sent)' : ''}${tgt}${where}${tail}`;
    case 'cast': return `${a.observer} casts ${a.spell ?? '?'}${tgt}${where}${a.mana != null ? ` mana ${a.mana}${a.max_mana ? `/${a.max_mana}` : ''}` : ''}${a.rite ? ` rite:${a.rite}` : ''}${tail}` +
      (a.outcome ? ` ⇒ ${OUTCOME_LABEL[a.outcome] ?? a.outcome}${a.reply ? ` ("${a.reply}"${a.reply_ms != null ? `, ${a.reply_ms}ms` : ''})` : ''}` : '');
    case 'use': return `${a.observer} puts on / uses ${a.item_name ?? `#${a.item}`}${where}${tail}`;
    case 'unuse': return `${a.observer} takes off ${a.item_name ?? `#${a.item}`}${where}${tail}`;
    case 'apply': return `${a.observer} applies ${a.item_name ?? `#${a.item}`}${tgt}${where}${tail}`;
    case 'activate': return `${a.observer} activates ${a.item_name ?? `#${a.item}`}${where}${tail}`;
    case 'say': return `${a.observer} ${a.say_type === 'yell' ? 'yells' : a.say_type === 'broadcast' ? 'broadcasts' : 'says'} "${a.text ?? ''}"` +
      `${a.callout ? ` (callout: ${a.callout.player} entered the map${a.callout.basis ? `, ${a.callout.basis}` : ''})` : ''}${where}`;
    case 'traverse': return `${a.observer} crosses map ${a.from ?? '?'} → ${a.to ?? '?'}${a.loc ? ` arriving @ ${locText(a.loc)}` : ''}`;
    default: return `${a.observer} ${a.verb}${where}`;
  }
}

// ------------------------------------------------------------------ readers

function jsonl(text) {
  const out = [];
  for (const line of String(text).split('\n')) { if (!line) continue; try { out.push(JSON.parse(line)); } catch {} }
  return out;
}
const dayOf = at => new Date(at).toISOString().slice(0, 10);
function days(since, until) {
  const out = [];
  for (let t = Date.parse(dayOf(since) + 'T00:00:00Z'); t <= until; t += 86_400_000) out.push(dayOf(t));
  return out;
}
/** Rows of one side file (`actions`, `messages`) between two times. */
export function readSide(prefix, { dir, since = 0, until = Date.now() } = {}) {
  const out = [];
  for (const d of days(since, until)) {
    const f = join(dir, `${prefix}-${d}.jsonl`);
    if (!existsSync(f)) continue;
    try { for (const r of jsonl(readFileSync(f, 'utf8'))) if (r.at >= since && r.at <= until) out.push(r); } catch {}
  }
  return out;
}
export function readTaunts(file, { since = 0, until = Date.now() } = {}) {
  try { return jsonl(readFileSync(file, 'utf8')).filter(r => r.at >= since && r.at <= until + 3_600_000); } catch { return []; }
}

// Swings are already in the battle as `pvp_outcome` rows; their server sentences would say it twice.
const QUIET = new Set(['swing_out_hit', 'swing_out_miss']);

/** The battle's own events and its telemetry, as one time-ordered list for a timeline. */
export function battleTimeline(b) {
  const tm = b.telemetry;
  if (!tm) return b.events;
  const castAt = new Map(tm.casts.map(c => [`${c.observer}|${c.at}`, c]));
  const rows = [
    ...b.events,
    ...tm.actions.map(a => ({ ...(castAt.get(`${a.observer}|${a.at}`) ?? a), kind: 'action' })),
    ...tm.messages.filter(m => !QUIET.has(m.cls)).map(m => ({ ...m, kind: 'heard' })),
    ...(tm.taunt?.line ? [{ kind: 'taunt', at: tm.taunt.at, ...tm.taunt }] : []),
  ];
  return rows.sort((x, y) => x.at - y.at);
}

/** A battle as plain text, one line per row: the CLI's `--battle`. */
export function battleText(b, { describeEvent = e => `${e.kind} ${e.event ?? ''}` } = {}) {
  const t0 = b.start;
  const out = [];
  for (const e of battleTimeline(b)) {
    const off = ((e.at - t0) / 1000).toFixed(3);
    const ts = new Date(e.at).toISOString().slice(11, 23);
    const body = e.kind === 'action' ? describeAction(e)
      : e.kind === 'heard' && e.cls === 'chat' ? `${e.speaker ?? '?'} ${e.say_type === 'yell' ? 'yells' : e.say_type === 'broadcast' ? 'broadcasts' : 'says'} "${e.text}"  (heard by ${e.heard_by?.join(', ') ?? e.observer})`
      : e.kind === 'heard' ? `${e.heard_by?.length > 1 ? `${e.heard_by.length} hear` : `${e.observer} hears`}: ${e.text}${e.cls !== 'other' ? `  [${e.cls}]` : ''}`
      : e.kind === 'taunt' ? `📣 ${e.character} broadcasts "${e.line}" (${e.why})`
      : describeEvent(e);
    out.push(`${ts}Z ${off.startsWith('-') ? '' : '+'}${off}s ${e.room != null ? `m${e.room}`.padEnd(5) : '     '} ${body}`);
  }
  return out.join('\n');
}
