// IS THIS WEAPON MAGIC? — the one question a troll asks, answered from what the server says.
//
// Pure: no socket, no clock of its own, no file. The keeper feeds it look text and message
// lines; `m59-weapon-magic-test.mjs` pins it.
//
// WHY IT EXISTS. Trolls resist ATCK_WEAP_NONMAGIC 80 (troll.kod:64-67, and the Guardian in
// stntroll.kod:75-78), so every mundane sword, axe, hammer and mace lands a fifth of its damage.
// Kraanan's `enchant weapon` clears that flag and sets ATCK_WEAP_MAGIC (waench.kod:108-109),
// which is a five-fold difference, and a troll station is only survivable on the magic side.
//
// AND NOTHING ON THE WIRE SAYS SO. An enchantment does not rename the weapon in the inventory
// list, and it does not move the rarity grade: `WeapAttEnchanted` inherits
// GetRarityCountModifier = 0 (itematt.kod:587), so an enchanted long sword is a "normal" long
// sword to every field this harness already reads. The owner is not told when somebody ELSE
// dedicates it, either — "Your %s is now dedicated to Kraanan." goes to the CASTER
// (enchwp.kod:19). Exactly two things do say it:
//
//   the item's LOOK text     "This weapon has been dedicated to Kraanan's glory."  (waEnchanted)
//   the owner, at the lapse  "Your %s suddenly seems a little more... ordinary."   (waEnchant_gone)
//
// So magic is a READING, with a time and a source, and never an assumption. `null` means
// nobody has looked, which is not the same as mundane — the same rule the chest cache follows.
//
// THE CONJURED FLAG RIDES ALONG FOR FREE. A Create Weapon result carries IA_MADE, whose look
// text is "It shimmers insubstantially." (iamade.kod). A made weapon cannot be given to an NPC
// (item.kod:1110-1126) — so no merchant buys it — and it deletes itself after power x 2
// minutes. Telling a real long sword from a conjured one is the difference between money and
// nothing, and the look that answers "magic?" answers "made?" in the same breath.

const norm = s => String(s ?? '').trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ');

// BORN MAGIC: the class sets ATCK_WEAP_MAGIC itself (mystswrd.kod:57, spirhamm.kod:58,
// riijaswd.kod:62). No reading needed, no lapse possible.
export const BORN_MAGIC = Object.freeze(['mystic sword', 'spiritual hammer', 'sword of riija']);

// NEVER NONMAGIC: these classes simply do not carry the flag, so a NONMAGIC resistance never
// matches them. Not "magic", but the troll cannot tell the difference. The nerudite sword is
// better than that: trolls take -80 from ATCK_WEAP_NERUDITE (troll.kod:66), 180%.
export const UNFLAGGED = Object.freeze(['nerudite sword', 'sword of the hunt',
  'bow', 'crossbow', 'longbow', 'battle bow', 'magic bow', 'nerudite bow', 'practice bow']);

export const ENCHANTED_DESC = /dedicated to Kraanan'?s glory/i;
export const MADE_DESC = /shimmers insubstantially/i;
export const LAPSE_MSG = /^\s*Your (.+?) suddenly seems a little more\.{2,3}\s*ordinary\.?\s*$/i;
export const DEDICATED_MSG = /^\s*Your (.+?) is now dedicated to Kraanan\.?\s*$/i;

/**
 * One weapon, classified. `look` is the description text if somebody has read it.
 *
 *   class              born_magic | unflagged | enchanted | mundane | unknown
 *   bypasses_nonmagic  true | false | null   (null: nobody has looked)
 *   made               true | false | null   (a conjured weapon; null: nobody has looked)
 */
export function classifyWeapon({ name, look = null } = {}) {
  const n = norm(name);
  const text = look == null ? null : String(look);
  const made = text == null ? null : MADE_DESC.test(text);
  if (BORN_MAGIC.includes(n)) return { name: n, class: 'born_magic', bypasses_nonmagic: true, made };
  if (UNFLAGGED.includes(n)) return { name: n, class: 'unflagged', bypasses_nonmagic: true, made,
    ...(n === 'nerudite sword' ? { troll_weakness: true } : {}) };
  if (text == null) return { name: n, class: 'unknown', bypasses_nonmagic: null, made };
  return ENCHANTED_DESC.test(text)
    ? { name: n, class: 'enchanted', bypasses_nonmagic: true, made }
    : { name: n, class: 'mundane', bypasses_nonmagic: false, made };
}

/** The weapon a lapse or a dedication sentence names, or null when the line is neither. */
export function lapsedWeapon(line) {
  const m = LAPSE_MSG.exec(String(line ?? ''));
  return m ? norm(m[1]) : null;
}
export function dedicatedWeapon(line) {
  const m = DEDICATED_MSG.exec(String(line ?? ''));
  return m ? norm(m[1]) : null;
}

/**
 * THE READING BOOK: one keeper's memory of what it has seen, keyed by object id.
 *
 * An id is a handle that the server renumbers on a save (CLAUDE.md), so the book never
 * trusts one across a change of NAME: a reading whose recorded name differs from the item now
 * wearing that id is discarded rather than believed. The inventory is the authority for what
 * exists; the book only says what was learned about it.
 */
export class WeaponMagicBook {
  constructor({ now = () => Date.now(), maxAgeMs = 45 * 60_000 } = {}) {
    this.now = now;
    this.maxAgeMs = maxAgeMs;          // a positive reading older than this is re-asked
    this.readings = new Map();         // id -> { name, class, bypasses_nonmagic, made, at, source }
  }

  record(id, name, look, source = 'look') {
    if (id == null) return null;
    const r = { ...classifyWeapon({ name, look }), at: this.now(), source };
    this.readings.set(Number(id), r);
    return r;
  }

  /** A lapse names a weapon by NAME, so every reading of that name is suspect: re-ask them. */
  lapse(name) {
    const n = norm(name);
    const hit = [];
    for (const [id, r] of this.readings) {
      if (r.name === n && r.class === 'enchanted') {
        this.readings.set(id, { ...r, class: 'unknown', bypasses_nonmagic: null,
                                at: this.now(), source: 'lapse' });
        hit.push(id);
      }
    }
    return hit;
  }

  /** Drop readings for ids no longer carried, and for ids now wearing a different name. */
  reconcile(items = []) {
    const live = new Map(items.filter(i => i?.id != null).map(i => [Number(i.id), norm(i.name)]));
    for (const [id, r] of this.readings)
      if (!live.has(id) || live.get(id) !== r.name) this.readings.delete(id);
  }

  /**
   * Which weapons in this pack need a look now. Born-magic and unflagged classes never do.
   * An enchanted reading goes stale after maxAgeMs, because enchantments end and the lapse
   * sentence goes only to whoever holds the weapon at that moment.
   */
  needsLook(items = [], isWeapon = defaultIsWeapon) {
    const t = this.now();
    return items.filter(i => i?.id != null && isWeapon(i.name)).filter(i => {
      const n = norm(i.name);
      if (BORN_MAGIC.includes(n) || UNFLAGGED.includes(n)) return false;
      const r = this.readings.get(Number(i.id));
      if (!r || r.name !== n || r.class === 'unknown') return true;
      return r.class === 'enchanted' && t - r.at > this.maxAgeMs;
    });
  }

  /** What a board and a bot read: the wielded weapon's verdict and how many magic spares. */
  summary(items = [], wieldedId = null, isWeapon = defaultIsWeapon) {
    const weapons = items.filter(i => i?.id != null && isWeapon(i.name));
    const verdict = i => {
      const n = norm(i.name);
      if (BORN_MAGIC.includes(n) || UNFLAGGED.includes(n)) return classifyWeapon({ name: n });
      const r = this.readings.get(Number(i.id));
      return r && r.name === n ? r : { name: n, class: 'unknown', bypasses_nonmagic: null, made: null };
    };
    const rows = weapons.map(i => {
      const v = verdict(i);
      return { id: Number(i.id), name: v.name, class: v.class, bypasses_nonmagic: v.bypasses_nonmagic,
               made: v.made ?? null, wielded: wieldedId != null && Number(i.id) === Number(wieldedId),
               at: v.at ?? null, source: v.source ?? (v.class === 'unknown' ? null : 'class') };
    });
    const wielded = rows.find(r => r.wielded) ?? null;
    const spares = rows.filter(r => !r.wielded);
    return {
      wielded: wielded ? { name: wielded.name, class: wielded.class,
                           bypasses_nonmagic: wielded.bypasses_nonmagic, made: wielded.made } : null,
      magic_spares: spares.filter(r => r.bypasses_nonmagic === true).length,
      unknown: rows.filter(r => r.bypasses_nonmagic == null).length,
      weapons: rows,
    };
  }
}

const WEAPONISH = /\b(sword|axe|hammer|mace|scimitar|dagger|blade|bow|crossbow)\b/i;
export const defaultIsWeapon = name => WEAPONISH.test(String(name ?? ''));

/**
 * THE SWAP A KEEPER MAKES AT ONE SECOND: the wielded weapon is known mundane (or just lapsed)
 * and a carried weapon is known to bypass NONMAGIC. Returns the id to wield, or null.
 *
 * `rank(name)` is the character's own weapon priority (lower is better), so the swap stays
 * inside the family the character trains: a magic weapon is preferred over a mundane one of
 * the SAME rank, and never over a better-ranked one. That is the operator's rule — "they would
 * not want swords to be forced" — expressed as a tie-break rather than a ranking.
 */
export function magicSwap(summary, rank = () => 0) {
  const w = summary?.weapons ?? [];
  const cur = w.find(r => r.wielded);
  if (cur && cur.bypasses_nonmagic === true) return null;
  const curRank = cur ? rank(cur.name) : Number.POSITIVE_INFINITY;
  const best = w.filter(r => !r.wielded && r.bypasses_nonmagic === true)
    .sort((a, b) => rank(a.name) - rank(b.name) || a.id - b.id)[0];
  if (!best) return null;
  return rank(best.name) <= curRank ? best.id : null;
}
