// ANSWERING WHERE, AND HEARING AN ALARM.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 2 methods: answerWhere, hearAlarm
import * as grudge from '../m59-grudge.mjs';
import { inboxIfAny } from '../m59-inbox.mjs';
import * as party from '../m59-party.mjs';

export class HeardPart {
  // @part 1

  // TELL PEOPLE WHERE THE BODY IS.
  //
  // A death is broadcast to the whole world ("### Yorick was just killed by a
  // troll."), and the usual reply is somebody asking "where?". The dead player is
  // the one person who cannot answer at scale: dying costs all your mana, and a
  // broadcast costs mana. But a TELL is cheap, and whoever asked still has theirs —
  // so the protocol players actually use is: the corpse tells one person, that
  // person broadcasts, and the room fills up.
  //
  // Everything needed is already recorded. `lastDeath` has the room and the health
  // trail; all that was missing was answering the question.
  async answerWhere() {
    const s = this.s, c = s.need();
    const box = inboxIfAny(this.s.name);
    if (!box || !this.lastDeath) return;

    // Anything recent that reads like someone asking after the body.
    const since = this.lastDeath.at - 60_000;
    // ONLY TO OUR OWN. The answer names the room, the square and what killed us, which is a
    // report on the fleet; a stranger asking "where?" after a death broadcast is as likely to
    // be the killer as a rescuer. Same rule as social(): a fleetmate, i.e. the operator.
    const asks = box.select({ since, limit: 20 })
      .filter(m => /\bwhere\b|\bwhere\?|what room|which room|loc\b|location/i.test(m.text || ''))
      .filter(m => party.isFleetmate(m.from ?? m.from_name ?? null));
    for (const m of asks) {
      if (this.answered?.has(m.id)) continue;
      (this.answered ??= new Set()).add(m.id);
      const d = this.lastDeath;
      const where = d.died_in || 'somewhere I could not name';
      const at = d.room_num != null ? ` (room ${d.room_num})` : '';
      const spot = d.at_col != null ? `, around col ${d.at_col} row ${d.at_row}` : '';
      const text = `${where}${at}${spot}. Killed by ${d.killed_by?.join(' and ') || 'something'}. ` +
                   `I have no mana to broadcast it — please pass it on if you would.`;
      try {
        await s.pacer.submit('say', () => c.tell(m.from_id ?? m.fromId, text));
        this.note('told someone where the body is', { to: m.from ?? m.from_name, where, text });
        this.progress('answered a where');
      } catch (e) {
        this.note('could not answer where', { why: e.message });
      }
    }
  }

  /**
   * A FLEETMATE CALLING FOR HELP, AND THE ONLY ROUTE THAT WORKS FOR A PILOTED CHARACTER.
   *
   * THE PROBLEM THIS SOLVES, STATED HONESTLY. When a human logs in on one of ours, the
   * server hands them the single connection that character is allowed and the broker is
   * bumped off it. From that moment the harness has NO connection to that character:
   * `checkAttackedByPlayer` cannot fire for it, because there is no keeper, no health
   * reading, and no room view. And a fleetmate standing right next to them cannot see it
   * either — a bystander is sent no packet when one player hits another, so "Scooter is
   * losing health" is not observable by anybody but Scooter.
   *
   * So the character the operator is actually playing is the LEAST defended thing in the
   * fleet, which is exactly backwards. There are only two ways round it: play through
   * `m59-proxy.mjs`, which keeps the harness in the stream and makes all of this
   * automatic, or have the person say something. This is the second one, because it
   * needs no change to how the game is launched.
   *
   * WHY A SPOKEN NAME IS SAFE HERE, when it would not be from a stranger:
   *
   *   - the speaker must be ONE OF OURS, checked against the roster rather than against
   *     the runtime party map (see the note on `setRosterSource` — the map is empty for
   *     the first seconds after a restart, which is when this would be worst);
   *   - the channel must be a guild tell or a direct tell, never open room speech, so a
   *     stranger cannot put a name in our book by shouting it;
   *   - and it grants a GRUDGE, not an attack. The live `PF_KILLER`/`PF_OUTLAW` check
   *     still stands between the grudge and any swing, and so does the server's own
   *     safety. Naming an innocent achieves nothing at all.
   *
   * The alarm is deliberately a plain sentence a person can type in a hurry.
   */
  async hearAlarm() {
    if (this.policy.defendAgainstPlayers !== true) return null;
    const box = inboxIfAny(this.s.name);
    if (!box) return null;
    const since = Date.now() - 120_000;
    const heard = box.select({ since, limit: 30 });
    let acted = 0;
    for (const m of heard) {
      if (this.alarmsSeen?.has(m.id)) continue;
      (this.alarmsSeen ??= new Set()).add(m.id);
      // GUILD OR A DIRECT TELL ONLY. `say` reaches the whole room, which is precisely
      // where a stranger stands.
      if (m.channel !== 'guild' && m.channel !== 'group' && m.channel !== 'group-one') continue;
      if (!party.isFleetmate(m.speaker_name)) continue;
      const said = String(m.text || '');
      // "help <name>" / "murderer <name>" / "attacking me <name>" — the word, then who.
      const hit = /\b(?:help|murderer|killer|attacked by|attacking me)\b[\s:,-]*(.{2,32})$/i.exec(said.trim());
      if (!hit) continue;
      const named = hit[1].trim().replace(/[.!?,]+$/, '');
      if (!named || party.isFleetmate(named)) continue;   // never against one of ours
      grudge.recordAttack(named, { who: `${m.speaker_name} (called for help)`,
                                   room: this.s.world?.room?.num ?? null });
      acted++;
      this.note('a fleetmate called for help', {
        from: m.speaker_name, channel: m.channel, named, said,
        why: 'a piloted character has no keeper and cannot report an attack itself, so ' +
             'the person driving it is the only witness there is',
        note: 'this grants a GRUDGE and never an attack — the live murderer flag and the ' +
              'server\'s own safety both still stand in the way of a swing',
      });
    }
    return acted ? { grudges: acted } : null;
  }
  // @end 1
}
