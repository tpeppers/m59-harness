// SPOILED POTIONS ARE DROPPED, ON A TIMER, BY LOOKING. Operator, 2026-10-20: "the potions spiders drop can be useful in
// PvP for up to 24 hours, put in something so the bot will discard potions after they go bad (can time a check, but
// also always check before drinking)".
//
// The kod (spelitem.kod): every spell item starts a go-bad timer at construction, GO_BAD_TIME = 24 h, unless it was
// made labelled (shop stock and distilled potions never go bad). Only a shop pauses it; a pack or a vault does not.
// When it fires, pbBad = TRUE and the LOOK text becomes the class's vrBadDesc (potion.kod: "a glass vial of slightly
// cloudy colored liquid. A slight whiff of it is enough to turn your stomach."), and drinking one does
// viGoBadDamage (5-10+) instead of the spell. Nothing on the wire says how old a potion is, so the only proof is the
// look, and m59-potions.mjs already compiles every class's fresh and spoiled descriptions from the kod.
//
// THE TIMED CHECK is this: one potion LOOKed per keeper tick at most, each potion again every SWEEP_MS, and a potion
// whose description is the spoiled one is dropped. THE CHECK BEFORE DRINKING already exists and is not this file:
// m59-combat-fallback.mjs looks at the exact item and requires an affirmatively fresh description within
// CONDITION_MAX_AGE_MS before it uses one. An unknown description is left alone here (never dropped on a guess) and
// is refused there (never drunk on a guess).
import { dropSpec } from './m59-parse.mjs';
import { potionCatalogue, potionCondition } from './m59-potions.mjs';

export const SWEEP_MS = 15 * 60_000;
const LOOK_TIMEOUT_MS = 800;

// A pack row is a potion we can judge when its name is one of the compiled potion identities.
export const potionEntry = (catalogue, name) => catalogue.get(String(name ?? '').trim().toLowerCase()) ?? null;

export class PotionFreshness {
  constructor({ catalogue = potionCatalogue, now = () => Date.now(), sweepMs = SWEEP_MS } = {}) {
    this.catalogue = catalogue; this.now = now; this.sweepMs = sweepMs;
    this.client = null; this.checked = new Map(); this.busy = false;
  }
  // -> null when nothing was due, or { action: 'fresh' | 'spoiled_dropped' | 'unknown', id, name, reason }
  async tick(s, { allowed = () => true, note = () => {} } = {}) {
    if (this.busy || !allowed()) return null;
    const c = s.client;
    const valid = () => s.client === c && s.live !== false && c?.state === 'game' && allowed();
    if (!valid() || !Array.isArray(c.inventory)) return null;
    if (this.client !== c) { this.client = c; this.checked.clear(); }   // ids are a connection's handles, not names
    const cat = this.catalogue();
    const potions = c.inventory.map(o => ({ o, name: c.rsc?.get?.(o.nameRsc) ?? o.name, p: null }))
      .map(x => ({ ...x, p: potionEntry(cat, x.name) })).filter(x => x.p);
    for (const id of this.checked.keys()) if (!potions.some(x => x.o.id === id)) this.checked.delete(id);
    const t = this.now();
    const due = potions.find(x => t - (this.checked.get(x.o.id) ?? -Infinity) >= this.sweepMs);
    if (!due) return null;
    this.busy = true;
    try {
      const since = c.evSeq; if (!Number.isFinite(since)) return null;
      let looked = false;
      await s.pacer.submit('look', () => { if (valid() && c.inventory.some(o => o.id === due.o.id)) { c.look(due.o.id); looked = true; } });
      if (!looked) return null;
      const reply = await c.waitFor({ kinds: ['look'], since, timeoutMs: LOOK_TIMEOUT_MS, match: e => e.id === due.o.id });
      const description = reply?.events?.find(e => e.id === due.o.id && e.seq > since)?.description;
      this.checked.set(due.o.id, this.now());
      if (description == null) return null;   // no reply is not a verdict; try again next sweep
      const condition = potionCondition(due.p, description);
      if (condition.reason !== 'spoiled') {
        const r = { action: condition.safe ? 'fresh' : 'unknown', id: due.o.id, name: due.name, reason: condition.reason };
        if (!condition.safe) note(r);
        return r;
      }
      let sent = false;
      await s.pacer.submit('drop', () => {
        const item = c.inventory.find(o => o.id === due.o.id);
        if (valid() && item) { c.drop([dropSpec(item)]); sent = true; }
      });
      const r = { action: sent ? 'spoiled_dropped' : 'spoiled_kept', id: due.o.id, name: due.name, reason: 'spoiled' };
      note(r);
      return r;
    } finally { this.busy = false; }
  }
}
