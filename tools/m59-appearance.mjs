// WHAT A CHARACTER LOOKS LIKE, AND WHY THEY HAVE ALL LOOKED THE SAME.
//
// `BP_NEW_CHARINFO` carries a face: five resource ids (head, hair, eyes, nose, mouth), a
// hair-colour palette translation and a skin translation. `joinAsNewCharacter` never sent
// any of them, so they defaulted to `[]`, 0, 0 — and a face-part list whose length is not
// exactly five is the "hacking the protocol" branch in the server, which replaces the whole
// thing with the DEFAULT MALE FACE (player.kod:1997-2003):
//
//     lFaceparts = [charinfo_head_ax_icon, charinfo_hair_ac_icon, charinfo_eyes_ax_icon,
//                   charinfo_nose_ax_icon, charinfo_mouth_ax_icon];
//
// Every character this repository has ever made is therefore the same man. Not by choice —
// nobody chose at all, and the silence was read as a preference. That is the operator's
// complaint and it is a fair one.
//
// THE SERVER NEVER SAYS NO, HERE EITHER. An invalid part is not refused: it is passed
// through `RestrictToResourceList` (player.kod:2008-2021), which quietly substitutes the
// first allowed value. A hair colour outside the accepted set is silently replaced, and a
// bad skin translation becomes PT_BLUE_TO_SKIN3. So a wrong number does not produce an
// error, it produces a different face — which is exactly why the tables below are extracted
// from the server's own source rather than guessed.
//
// EVERY VALUE HERE IS FROM THE KOD:
//   kod/util/system.kod:1808-1860   GetAllowed{Head,Hair,Eye,Nose,Mouth}Icons, per gender
//   kod/kodbase.txt:287+            the `charinfo_*_icon` resource numbers
//   player.kod:2026-2055            which hair and skin translations are accepted
//   kod/include/blakston.khd:235+   the PT_* palette translation values
//
// `node tools/m59-appearance-test.mjs` is the guard.

export const GENDER_MALE = 1;
export const GENDER_FEMALE = 2;

// Head has exactly one option per gender. It is in the table anyway, because the packet
// wants five parts and a list with a hole in it is the default-face branch.
const HEAD = { [GENDER_MALE]: [20068], [GENDER_FEMALE]: [20069] };

const HAIR = {
  // cd, ac, ba, ad, bb, bald, xa
  [GENDER_MALE]: [20093, 20090, 20091, 20096, 20097, 20104, 20102],
  // cd, bc, ca, db, bd, cb, dc, dr, xb, bald
  [GENDER_FEMALE]: [20093, 20092, 20094, 20095, 20098, 20099, 20100, 20101, 20103, 20104],
};
const EYES  = { [GENDER_MALE]: [20070, 20071, 20072, 20073], [GENDER_FEMALE]: [20074, 20075, 20076] };
const NOSE  = { [GENDER_MALE]: [20083, 20084, 20085],        [GENDER_FEMALE]: [20086, 20087, 20088] };
const MOUTH = { [GENDER_MALE]: [20077, 20078, 20079],        [GENDER_FEMALE]: [20080, 20081, 20082] };

// Readable names, so a roster row and a log line can say "hair: bald" rather than 20104.
export const PART_NAMES = new Map([
  [20068, 'head ax'], [20069, 'head kx'],
  [20090, 'hair ac'], [20091, 'hair ba'], [20092, 'hair bc'], [20093, 'hair cd'],
  [20094, 'hair ca'], [20095, 'hair db'], [20096, 'hair ad'], [20097, 'hair bb'],
  [20098, 'hair bd'], [20099, 'hair cb'], [20100, 'hair dc'], [20101, 'hair dr'],
  [20102, 'hair xa'], [20103, 'hair xb'], [20104, 'bald'],
  [20070, 'eyes ax'], [20071, 'eyes bx'], [20072, 'eyes cx'], [20073, 'eyes dx'],
  [20074, 'eyes kx'], [20075, 'eyes lx'], [20076, 'eyes mx'],
  [20083, 'nose ax'], [20084, 'nose bx'], [20085, 'nose cx'],
  [20086, 'nose kx'], [20087, 'nose lx'], [20088, 'nose mx'],
  [20077, 'mouth ax'], [20078, 'mouth bx'], [20079, 'mouth cx'],
  [20080, 'mouth kx'], [20081, 'mouth lx'], [20082, 'mouth mx'],
]);

// The exact set player.kod:2026 will accept for hair. Anything else is silently replaced,
// so offering a wider palette here would be offering a lie. 0 means "no translation".
export const HAIR_COLOURS = new Map([
  ['natural', 0x0000], ['orange', 0x000A], ['red', 0x0012], ['light sky', 0x0016],
  ['skin1', 0x001A], ['skin2', 0x001B], ['skin3', 0x001C], ['skin4', 0x001D], ['skin5', 0x001E],
  ['kobold orange', 0x0022], ['kobold red', 0x002A], ['grey', 0x002B], ['black', 0x002C],
  ['blond', 0x002F], ['platinum blond', 0x0030],
]);

// PT_BLUE_TO_SKIN1..4 (blakston.khd). player.kod:2054 replaces anything else with SKIN3.
export const SKINS = new Map([['skin1', 1], ['skin2', 2], ['skin3', 3], ['skin4', 4]]);

// THE FACE EVERY CHARACTER HAS HAD SO FAR. Kept so `isDefaultFace` can name it, which is
// the whole point of this module existing.
export const DEFAULT_MALE_FACE = Object.freeze([20068, 20090, 20070, 20083, 20077]);

export const allowedParts = (gender = GENDER_MALE) => ({
  head: HEAD[gender] ?? HEAD[GENDER_MALE],
  hair: HAIR[gender] ?? HAIR[GENDER_MALE],
  eyes: EYES[gender] ?? EYES[GENDER_MALE],
  nose: NOSE[gender] ?? NOSE[GENDER_MALE],
  mouth: MOUTH[gender] ?? MOUTH[GENDER_MALE],
});

export const isDefaultFace = (faceparts) =>
  Array.isArray(faceparts) && faceparts.length === 5 &&
  faceparts.every((v, i) => v === DEFAULT_MALE_FACE[i]);

// PICK ONE, AT RANDOM, WHEN NOBODY CHOSE.
//
// The operator's instruction, and the right default: silence used to mean "the same man
// again", which is a choice nobody made. Now silence means a face. The rng is injectable so
// the test can pin an exact face without pinning Math.random.
export function randomAppearance(gender = GENDER_MALE, rng = Math.random) {
  const pick = a => a[Math.floor(rng() * a.length) % a.length];
  const p = allowedParts(gender);
  const colours = [...HAIR_COLOURS.values()];
  const skins = [...SKINS.values()];
  return {
    gender,
    faceparts: [pick(p.head), pick(p.hair), pick(p.eyes), pick(p.nose), pick(p.mouth)],
    hair: pick(colours),
    skin: pick(skins),
  };
}

// NAME A FACE, so what was chosen can be written into a roster and read back by a human.
export function describeAppearance(a) {
  if (!a?.faceparts?.length) return 'default (nobody chose)';
  const name = v => PART_NAMES.get(v) ?? `#${v}`;
  const colour = [...HAIR_COLOURS].find(([, v]) => v === a.hair)?.[0] ?? `#${a.hair}`;
  const skin = [...SKINS].find(([, v]) => v === a.skin)?.[0] ?? `#${a.skin}`;
  return `${a.faceparts.map(name).join(', ')}; hair ${colour}; skin ${skin}`;
}

// VALIDATE BEFORE SENDING, because the server validates by SUBSTITUTING.
//
// Returns the appearance it would actually produce plus a list of problems. A caller that
// wants a specific face has to be told when it will not get one — the alternative is
// discovering it by looking at the character, which is how nobody noticed for a year that
// every character was the same man.
export function checkAppearance(a, gender = GENDER_MALE) {
  const problems = [];
  if (!a) return { ok: true, problems, appearance: null };     // absent means "randomise"
  const p = allowedParts(gender);
  const parts = Array.isArray(a.faceparts) ? a.faceparts : [];
  if (parts.length !== 5)
    problems.push(`faceparts must be exactly 5 (head, hair, eyes, nose, mouth); got ` +
      `${parts.length}. The server replaces a wrong-length list with the DEFAULT MALE FACE ` +
      `and does not say so (player.kod:1997).`);
  else {
    const slots = [['head', p.head], ['hair', p.hair], ['eyes', p.eyes],
                   ['nose', p.nose], ['mouth', p.mouth]];
    for (const [i, [slot, allowed]] of slots.entries())
      if (!allowed.includes(parts[i]))
        problems.push(`${slot} ${parts[i]} is not allowed for this gender — the server ` +
          `substitutes silently. Allowed: ${allowed.join(', ')}`);
  }
  if (a.hair != null && ![...HAIR_COLOURS.values()].includes(a.hair))
    problems.push(`hair colour ${a.hair} is not one the server accepts; it will be replaced ` +
      `(player.kod:2026). Use one of: ${[...HAIR_COLOURS.keys()].join(', ')}`);
  if (a.skin != null && ![...SKINS.values()].includes(a.skin))
    problems.push(`skin ${a.skin} is not 1..4; the server replaces it with 3 (player.kod:2054)`);
  return { ok: problems.length === 0, problems, appearance: a };
}

// Resolve a human's request into what will be sent: a name from the tables, an explicit
// number, or nothing at all — which randomises.
export function resolveAppearance(want, gender = GENDER_MALE, rng = Math.random) {
  if (!want || want === 'random') return randomAppearance(gender, rng);
  if (want === 'default')
    return { gender, faceparts: [...DEFAULT_MALE_FACE], hair: 0, skin: 3 };
  const base = randomAppearance(gender, rng);
  const hair = typeof want.hair === 'string' ? HAIR_COLOURS.get(want.hair.toLowerCase()) : want.hair;
  const skin = typeof want.skin === 'string' ? SKINS.get(want.skin.toLowerCase()) : want.skin;
  return {
    gender,
    faceparts: Array.isArray(want.faceparts) && want.faceparts.length === 5
      ? want.faceparts.map(Number) : base.faceparts,
    hair: hair ?? base.hair,
    skin: skin ?? base.skin,
  };
}
