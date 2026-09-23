// Advancement names no victim. Infer it from the body's adjacent combat prose.
import { classifyCombatLine, stripCodes } from './m59-combatlog.mjs';

export const TOUGHER_MESSAGE_WINDOW_MS = 2000;

export function tougherCombatMessage(event, character) {
  if (event.kind !== 'message') return null;
  const text = stripCodes(event.text);
  const combat = classifyCombatLine(text);
  if (combat?.other && (combat.kind === 'kill' || combat.kind === 'my-swing'))
    return { ...event, creature: combat.other, evidence_kind: combat.kind === 'kill' ? 'kill' : 'attack' };
  // player.kod, punch.kod, kick.kod, thrust.kod and bkdagger.kod.
  const patterns = [
    /^You have slain (?:the |an? )?(.+?)(?: with your black dagger)?[.!]$/i,
    /^(?:The |An? )?(.+?) crumples to the ground, never to rise again\.$/i,
    /^(?:The |An? )?(.+?) is knocked to the ground by your kick - and doesn't get up\.$/i,
    /^With a quick thrust, you finish off (?:the |an? )?(.+?)\.$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return { ...event, creature: match[1], evidence_kind: 'kill' };
  }
  const named = text.match(/^(.+?) has slain (?:the |an? )?(.+?)[.!]$/i);
  // A nearby player's kill announcement must not claim this body's gain.
  if (named && named[1].toLowerCase() === String(character).toLowerCase())
    return { ...event, creature: named[2], evidence_kind: 'kill' };
  return null;
}

export function guessTougherCreature(messages, gain) {
  const nearest = messages.filter(m => Math.abs(m.at - gain.at) <= TOUGHER_MESSAGE_WINDOW_MS)
    .sort((a, b) => Math.abs(a.at - gain.at) - Math.abs(b.at - gain.at) ||
      // Within one millisecond, sequence order separates two attacks on different mobs.
      (Number.isFinite(gain.seq) && Number.isFinite(a.seq) && Number.isFinite(b.seq)
        ? Math.abs(a.seq - gain.seq) - Math.abs(b.seq - gain.seq) : 0) ||
      (a.evidence_kind === 'kill' ? -1 : 0) - (b.evidence_kind === 'kill' ? -1 : 0))[0];
  if (!nearest) return null;
  return { creature: nearest.creature, attributed: 'guessed from adjacent combat message',
    attribution: { source: 'combat_message', guessed: true, kind: nearest.evidence_kind,
      text: nearest.text, at: nearest.at, seq: nearest.seq ?? null,
      distance_ms: Math.abs(nearest.at - gain.at) } };
}
