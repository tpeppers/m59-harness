// THE HUMAN DESK, BROKER HALF: WHAT A PERSON TELLS A BOT ABOUT SERVICES.
//
// Operator, 2026-09-25 (m59-research design/research-spec-human-service-bot.md). Two directions,
// both arriving as a tell from a character a person is playing here:
//
//   TO A SERVER (a bot on the desk):   "services?"  -> the menu, from the server's own facts
//                                      "Remove Curse" -> a ticket, as if a keeper had asked
//                                      "cancel"     -> withdraw what this person asked for
//   TO A REQUESTER (a bot waiting on   "hold on"    -> it waits longer, up to a cap
//   a person who is serving):          "not now"    -> it walks at once
//                                      "done"       -> served; forces of light counts as lit
//
// The broker is the only process that can tell a person from a name — `pilotedSpeaker`, a
// live local pid — so only the broker calls this, and only with lines that passed that test.
// Everything here is decided from the chalice store and written back to it; the keepers pick
// the tickets up exactly as they pick up each other's.
//
// Every command is a ledger row (`kind: chalice`, `what: desk_*`), because "is the operator
// still blocking the fleet" has to be answerable afterwards from the record alone.

import {
  CHALICE_DEFAULTS, formatDeskMenu, parseDeskReply, parseDeskRequest, sameName,
  serviceReplyText,
} from './m59-chalice.mjs';

const live = t => !['done', 'abandoned'].includes(t.status);
// A person who says "done" about forces of light has cast it; the holder's clock is the one
// the occupants read, so it is given a minute — short enough that a wrong "done" costs little.
export const FOL_DONE_MS = 60_000;
// A menu older than this is said to be, rather than presented as current.
const MENU_STALE_MS = 5 * 60_000;

const ago = (ms) => (ms < 90_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);

export class DeskChat {
  /**
   * @param store   a ChaliceStore
   * @param reply   async (bot, speakerId, text) — a private tell back, as that bot
   * @param record  (character, detail) — a ledger row; the broker passes recordEvent
   * @param log     (line) — the broker's stderr
   * @param cfg     the chalice numbers this desk honours (hold and wait caps)
   * @param roomName (num) -> string|null, for replies a person can act on
   * @param isFleetmate (name) -> bool. REQUIRED IN SPIRIT: the default answers no for everyone,
   *        so a desk wired without a roster serves nobody rather than everybody.
   */
  constructor({ store, reply = async () => {}, record = () => {}, log = () => {},
                cfg = CHALICE_DEFAULTS, roomName = () => null, now = Date.now,
                isFleetmate = () => false } = {}) {
    Object.assign(this, { store, reply, record, log, cfg, roomName, now, isFleetmate });
  }

  /** The server's own numbers where it published them, else this desk's defaults. */
  limits(server) {
    let published = null;
    try { published = this.store.desk()?.[String(server ?? '').trim().toLowerCase()]?.limits ?? null; } catch {}
    return { ...this.cfg, ...(published ?? {}) };
  }

  where(room) {
    if (room == null) return 'my post';
    const name = (() => { try { return this.roomName(room); } catch { return null; } })();
    return name ? `${name} (${room})` : `room ${room}`;
  }

  /**
   * One line from a person. `bot`/`botName`: the agent and character that heard it. `from`:
   * the character the person is playing. `speaker`: its object id, for the reply.
   * True when it was a desk command and has been handled; false lets it fall through.
   */
  async handle({ bot, botName, from, speaker, text }) {
    if (!botName || !from || sameName(botName, from)) return false;
    // FLEETMATES ONLY (operator, 2026-09-25). The caller already requires a local pilot, which
    // is one of our characters; this is the second, independent gate, on the ROSTER, so an NPC
    // or a stranger's character can never file a ticket, hold a traveller or read the menu —
    // whatever the pilot check ever comes to accept. Both ends must be ours.
    let mates = false;
    try { mates = !!this.isFleetmate(from) && !!this.isFleetmate(botName); } catch { mates = false; }
    if (!mates) {
      this.log(`[desk] ignored "${String(text).slice(0, 40)}" from ${from} to ${botName} — not a fleetmate`);
      return false;
    }
    const now = this.now();
    const state = this.store.read();
    const say = (line) => this.reply(bot, speaker, serviceReplyText(line)).catch(e =>
      this.log(`[desk] reply from ${botName} to ${from} failed: ${e.message}`));

    // 1. THE PERSON IS SERVING, AND THIS BOT IS WAITING ON THEM.
    const waiting = state.tickets.filter(t => live(t) && sameName(t.traveller, botName)
      && sameName(t.human_server, from));
    if (waiting.length) {
      const r = parseDeskReply(text);
      if (r) return this.answer(r, { bot, botName, from, waiting, say, now });
    }

    // 2. THIS BOT IS A DESK, AND THE PERSON IS ASKING IT FOR SOMETHING.
    const desk = state.desk?.[String(botName).trim().toLowerCase()];
    if (!desk) return false;
    const r = parseDeskRequest(text);
    if (!r) return false;
    return this.request(r, { bot, botName, from, desk, say, now, state });
  }

  async answer(r, { botName, from, waiting, say, now }) {
    const kinds = [...new Set(waiting.map(t => t.kind))];
    if (r.kind === 'hold') {
      const lim = this.limits(from);
      const held = this.store.hold(botName, { by: from, ms: lim.human_hold_ms,
                                              maxMs: lim.human_max_wait_ms }, now);
      const until = Math.max(0, ...held.map(t => t.hold_until ?? 0));
      this.record(botName, { what: 'desk_hold', by: from, services: kinds, holds: held[0]?.holds ?? 1,
                             until_ms: until - now, human: true });
      this.log(`[desk] ${from} -> ${botName}: hold on (${kinds.join(', ')}), waiting ${ago(until - now)} more`);
      await say(`waiting for you — ${ago(until - now)} more`);
      return true;
    }
    if (r.kind === 'decline') {
      const closed = this.store.closeFrom(botName, 'abandoned',
        { by: from, note: `declined by ${from}` }, now);
      this.record(botName, { what: 'desk_declined', by: from, services: closed.map(t => t.kind), human: true });
      this.log(`[desk] ${from} -> ${botName}: not now (${closed.map(t => t.kind).join(', ')}) — it walks`);
      await say('ok — making my own way');
      return true;
    }
    // done
    const closed = this.store.closeFrom(botName, 'done', { by: from, note: `${from} said done` }, now);
    const fol = closed.find(t => t.kind === 'fol');
    if (fol) try { this.store.litFol({ room: fol.room, until: now + FOL_DONE_MS, by: from }, now); } catch {}
    this.record(botName, { what: 'desk_done', by: from, services: closed.map(t => t.kind), human: true });
    this.log(`[desk] ${from} -> ${botName}: done (${closed.map(t => t.kind).join(', ')})`);
    return true;
  }

  async request(r, { botName, from, desk, say, now, state }) {
    const stale = now - (desk.at ?? 0) > MENU_STALE_MS ? ` (as of ${ago(now - (desk.at ?? 0))} ago)` : '';
    if (r.kind === 'menu') {
      this.record(from, { what: 'desk_menu', server: botName, menu: desk.menu, human: true });
      this.log(`[desk] ${from} asked ${botName} for services`);
      await say(`${formatDeskMenu(desk.menu) || 'nothing right now'}${stale} — tell me one`);
      return true;
    }
    if (r.kind === 'cancel') {
      const closed = this.store.closeFrom(from, 'abandoned',
        { by: from, note: 'withdrawn by the requester' }, now);
      this.record(from, { what: 'desk_cancel', server: botName, services: closed.map(t => t.kind), human: true });
      this.log(`[desk] ${from} withdrew ${closed.length} request(s) from ${botName}`);
      await say(closed.length ? `withdrawn: ${closed.map(t => t.kind).join(', ')}` : 'nothing to withdraw');
      return true;
    }
    const entry = (desk.menu ?? []).find(m => m.kind === r.kind);
    if (!entry) {
      await say(`I do not offer that — ${formatDeskMenu(desk.menu)}`);
      return true;
    }
    if (!entry.ok) {
      this.record(from, { what: 'desk_refused', server: botName, service: r.kind, why: entry.why, human: true });
      this.log(`[desk] ${from} asked ${botName} for ${entry.label}: unavailable (${entry.why})`);
      await say(`${entry.label} is unavailable: ${entry.why}${stale}`);
      return true;
    }
    const room = r.kind === 'fol' ? (r.room ?? desk.fol_room ?? null) : (desk.room ?? null);
    const prior = state.tickets.find(t => live(t) && t.kind === r.kind && sameName(t.traveller, from));
    const t = this.store.request(from, { room, kind: r.kind, human: true,
                                         ttlMs: this.limits(botName).ticket_ttl_ms }, now);
    if (prior || t.existing) {
      await say(`${entry.label} is already queued (${ago(now - (t.at ?? now))} ago)`);
      return true;
    }
    this.record(from, { what: 'desk_request', server: botName, service: r.kind, ticket: t.id, room, human: true });
    this.log(`[desk] ${from} asked ${botName} for ${entry.label} — ticket ${t.id}`);
    const at = this.where(desk.room);
    const how = {
      ride: `meet me at ${at}; I will offer it — counter with nothing, then use it and drop it`,
      uncurse: `come and stand by me at ${at}`,
      reveal: `drop the items at my feet at ${at}`,
      fol: `lighting ${this.where(room)}`,
    }[r.kind];
    await say(`${entry.label} queued — ${how}. "cancel" withdraws it`);
    return true;
  }
}
