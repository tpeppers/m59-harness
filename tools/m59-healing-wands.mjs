// HealWand/SpecialWand KOD: APPLY to self, 2–10 HP, five initial charges.
// Charges are not on the wire. Only a fresh LOOK can prove exhaustion.
import { dropSpec } from './m59-parse.mjs';

export const isHealingWand = name => /^wand of healing$/i.test(String(name ?? '').trim());
export function healingWandState(description) {
  const text = String(description ?? '').replace(/~[a-z]/gi, '').replace(/\s+/g, ' ').trim();
  if (text === 'The once pristine wand is now a blackened mess.') return 'empty';
  if (text.startsWith('This wand is almost comically decorated by obviously fake gems.')
      && text.includes('warm to the touch.')) return 'charged';
  return 'unknown';
}

// One bounded operation per turn. A failed LOOK/application never monopolizes survival.
// State belongs to a connection, not an object ID that might be reused after reconnect.
export class HealingWands {
  constructor() { this.client = null; this.entries = new Map(); this.nextUse = 0; this.busy = false; }

  async tick(s, { below = 0, allowed = () => true, cancelled = () => false, note = () => {} } = {}) {
    if (this.busy || !Number.isFinite(below) || below <= 0 || below > 1 || !allowed() || cancelled()) return null;
    const c = s.client;
    const health = () => c?.vitals?.()?.health;
    const alive = () => { const h = health(); return h?.max > 0 && h.value > 0; };
    const valid = () => s.client === c && s.live !== false && c?.state === 'game'
      && alive() && allowed() && !cancelled();
    if (!valid()) return null;
    if (this.client !== c) { this.client = c; this.entries.clear(); this.nextUse = 0; }
    const pack = () => (c.inventory ?? []).filter(o => isHealingWand(c.rsc.get(o.nameRsc)));
    const present = id => pack().find(o => o.id === id);
    const wands = pack();
    for (const id of this.entries.keys()) if (!present(id)) this.entries.delete(id);
    const low = () => { const h = health(); return h?.max > 0 && h.value > 0 && h.value / h.max < below; };
    const now = Date.now();
    // Prefer a wand we have already inspected; inspect unknowns while healthy too.
    const wand = (low() && now >= this.nextUse
      ? wands.find(o => this.entries.get(o.id)?.state === 'charged') : null)
      ?? wands.find(o => now >= (this.entries.get(o.id)?.retryAt ?? 0));
    if (!wand) return null;
    this.busy = true;
    try {
      let state = this.entries.get(wand.id)?.state;
      if (state !== 'charged' || !low()) {
        const since = c.evSeq;
        if (!Number.isFinite(since)) return null;
        let looked = false;
        await s.pacer.submit('look', () => {
          if (valid() && present(wand.id)) { c.look(wand.id); looked = true; }
        });
        if (!looked) return null;
        const reply = await c.waitFor({ kinds: ['look'], since, timeoutMs: 600,
          match: e => e.id === wand.id });
        const description = reply?.events?.find(e => e.id === wand.id && e.seq > since)?.description;
        state = healingWandState(description);
        this.entries.set(wand.id, { state, retryAt: Date.now() + 30_000 });
        if (!valid() || !present(wand.id)) return null;
        if (state === 'empty') {
          let sent = false;
          await s.pacer.submit('drop', () => {
            const item = present(wand.id);
            if (valid() && item) { c.drop([dropSpec(item)]); sent = true; }
          });
          if (sent) { const r = { action: 'drop_empty', id: wand.id, sent: true }; note(r); return r; }
          return null;
        }
      }
      if (state !== 'charged' || !low() || Date.now() < this.nextUse) return null;
      let sent = false;
      const before = health().value;
      await s.pacer.submit('act', () => {
        if (valid() && present(wand.id) && low()) {
          c.apply(wand.id, c.selfId); sent = true;
        }
      }, 1050);
      if (!sent) return null;
      this.nextUse = Date.now() + 2000;
      // Next LOOK detects the last charge without guessing from local use counts.
      this.entries.set(wand.id, { state: 'unknown', retryAt: this.nextUse });
      const r = { action: 'apply_self', id: wand.id, sent: true, health_before: before, below };
      note(r);
      return r;
    } finally { this.busy = false; }
  }
}
