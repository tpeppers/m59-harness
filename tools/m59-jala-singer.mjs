// A JALA SINGER IS ARMED WITH ITS INSTRUMENT. Pure, no socket: pass-combat.mjs exempts such a character from the arming
// ladder in a sanctuary (2026-11-14, Loial: jala.kod CanPayCosts refuses every song without an instrument in use,
// and isArmed does not count an instrument as a weapon). m59-jala-singer-test.mjs pins it.
import { normalizePractice } from './m59-deskpractice.mjs';
// Holding an instrument, and the practice drill names a Jala song this character knows.
export function jalaSinger(ap) {
  const c = ap?.s?.client;
  const eq = c?.equipment?.();
  if (!eq || eq.known === false) return false;
  const nameOf = o => String(o?.name ?? c?.rsc?.get?.(o?.nameRsc) ?? '');
  if (!(eq.equipped || []).some(o => /\b(lute|flute|drum|horn|harp|lyre|instrument)\b/i.test(nameOf(o)))) return false;
  const drill = normalizePractice(ap.policy?.practiceSpells)?.spells ?? [];
  const known = new Map((typeof c.spells === 'function' ? c.spells() : c.spells ?? [])
    .map(sp => [String(sp?.name ?? c?.rsc?.get?.(sp?.nameRsc) ?? '').toLowerCase(), sp]));   // the live client carries nameRsc, not name
  return drill.some(entry => {
    const sp = known.get(String(entry?.name ?? entry ?? '').toLowerCase());
    return sp && (sp.school === 6 || /jala/i.test(String(sp.school ?? '')));
  });
}
