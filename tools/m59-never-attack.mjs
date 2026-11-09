import { BP } from './m59-client.mjs';
import { catalogueEntry } from './m59-deskpractice.mjs';
import { isHealingWand } from './m59-healing-wands.mjs';

const ID_MASK = 0x0fffffff;
function offensiveSpell(name) {
  const spell = catalogueEntry(name);
  if (spell?.parent === 'TouchAttackSpell') return true;
  return typeof spell?.harmful === 'boolean' ? spell.harmful : null;
}

function benignItem(name) {
  if (!name) return false;
  if (!/\b(?:wand|scroll)\b/.test(name)) return true;
  if (isHealingWand(name) || name === 'wand of identification') return true;
  const spell = /^(?:wand|scroll) of (.+)$|^(.+) (?:wand|scroll)$/.exec(name);
  return !!spell && offensiveSpell(spell[1] ?? spell[2]) === false;
}

// This is the last check before a Session's game packet reaches the socket.
export function guardNeverAttackPacket(c, neverAttack, op, parts) {
  if (neverAttack !== true) return;
  if (op === BP.REQ_ATTACK || op === BP.REQ_SHOOT)
    throw new Error('never_attack: physical attacks are disabled for this character');
  const isCast = op === BP.REQ_CAST;
  if (!isCast && op !== BP.REQ_APPLY && op !== BP.REQ_ACTIVATE && op !== BP.REQ_USE) return;
  const first = Buffer.isBuffer(parts[0]) && parts[0].length >= 4 ? parts[0] : Buffer.concat(parts);
  if (first.length < 4) throw new Error('never_attack: cannot verify the spell or item');
  const id = first.readUInt32LE(0) & ID_MASK;
  const entries = isCast ? c.spells : c.inventory;
  const entry = entries?.find(o => (o.id & ID_MASK) === id) ??
    (op === BP.REQ_ACTIVATE ? c.room?.objects?.get?.(id) : null);
  const name = String(c.rsc?.get?.(entry?.nameRsc) ?? entry?.name ?? '').trim().toLowerCase();
  if (isCast) {
    const offensive = offensiveSpell(name);
    if (offensive === true) throw new Error(`never_attack: ${name} is offensive`);
    if (offensive === false) return;
  } else if (benignItem(name)) {
    return;
  }
  throw new Error(`never_attack: cannot confirm a benign effect for ${name || `#${id}`}`);
}
