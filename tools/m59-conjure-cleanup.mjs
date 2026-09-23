import { dropSpec } from './m59-parse.mjs';

// Only a fresh, item-matched LOOK proves IA_MADE. Names cannot distinguish
// an orc drop from a summon. Never treat a timeout as permission to discard it.
export async function clearConjureHoard(s, candidates, {
  eligible, cancelled = () => false, maxInspections = 12,
} = {}) {
  const c = s.client, dropped = [], ordinary = [], unresolved = [];
  const held = id => (c.inventory ?? []).find(o => o.id === id);
  for (const item of candidates.slice(0, maxInspections)) {
    if (cancelled()) return { cleared: false, dropped, ordinary, unresolved, cancelled: true };
    if (!held(item.id)) continue;
    let description = null;
    for (let attempt = 0; attempt < 2 && description == null; attempt++) {
      const since = c.evSeq;
      await s.pacer.submit('look', () => c.look(item.id));
      const reply = await c.waitFor({ since, kinds: ['look'], timeoutMs: 1500,
        match: e => e.id === item.id });
      description = reply?.events?.find(e => e.id === item.id)?.description ?? null;
      if (cancelled()) return { cleared: false, dropped, ordinary, unresolved, cancelled: true };
    }
    if (typeof description !== 'string' || !description.trim()) { unresolved.push(item.id); continue; }
    if (!/\bshimmers insubstantially\b/i.test(description)) { ordinary.push(item.id); continue; }
    if (!eligible(item)) { unresolved.push(item.id); continue; }
    const since = c.evSeq;
    let sent = false;
    await s.pacer.submit('drop', () => {
      if (!cancelled() && held(item.id) && eligible(item)) {
        sent = true;
        return c.drop([dropSpec(held(item.id))]);
      }
    });
    if (sent) {
      await c.waitFor({ since, kinds: ['inventory', 'inventory-remove'], timeoutMs: 1500 });
      const refreshed = c.evSeq;
      await s.pacer.submit('read', () => c.requestInventory());
      await c.waitFor({ since: refreshed, kinds: ['inventory'], timeoutMs: 1500 });
    }
    if (!held(item.id)) dropped.push(item.id);
    else unresolved.push(item.id);
  }
  unresolved.push(...candidates.slice(maxInspections).filter(o => held(o.id)).map(o => o.id));
  return { cleared: unresolved.length === 0 && !cancelled(), dropped, ordinary, unresolved };
}
