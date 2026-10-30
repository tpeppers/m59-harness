// Network work stays in existing keeper service passes; reads never send game packets.
import * as skills from './m59-skills.mjs';
import { keepTest, saleAllowance } from './m59-loadout.mjs';
import { intentForSession, saleBlocked } from './m59-inventory-intent.mjs';
import { lootPolicyDiagnostics, policyChain, observedLootItem } from './m59-loot-policies.mjs';

export function lootPolicyStatus(ap) {
  const s = ap.s, c = s.client;
  if (!s.lootPolicyStore) return { protocol: 1, available: false };
  try {
    const snap = s.lootPolicyStore.snapshot();
    const context = { character: c?.me?.name || '', guild: c?.guild?.id ?? null };
    const legacy = { vaultItems: ap.policy.vaultItems, protectedItems: ap.policy.protectedItems,
      lootOnly: ap.policy.lootOnly, lootIgnore: ap.lootIgnoreList(), townTrips: ap.policy.townTrips,
      sources: ap.policySources?.snapshot?.() ?? {} };
    return { protocol: 1, available: true, revision: snap.revision, guild: context.guild,
      chain: policyChain(snap.effective, context).map(p => ({ id: p.id, name: p.name, scope: p.scope, source: snap.provenance.profiles[p.id] })),
      diagnostics: [...snap.warnings, ...lootPolicyDiagnostics(snap.effective, context, legacy)],
      legacy,
      inventory: (c?.inventory || []).slice(0, 128).map(o => ({ id: o.id, ...observedLootItem(c, o), amount: o.amount || 1,
        decision: s.lootDisposition(o), blocked: dispositionBlock(ap, o) })) };
  } catch (e) { return { protocol: 1, available: false, error: e.message }; }
}
export function dispositionNames(ap, action = null) {
  const c = ap.s.client;
  return [...new Set((c?.inventory || []).filter(o => {
    const d = ap.s.lootDisposition?.(o); return d && (action ? d.action === action : d.action !== 'sell');
  }).map(o => c.rsc.get(o.nameRsc) || '').filter(Boolean))];
}
export function dispositionBlock(ap, item) {
  const s = ap.s, c = s.client, name = c?.rsc.get(item.nameRsc) || '';
  const decision = s.lootDisposition?.(item);
  if (!decision) return null;
  if (decision.error || decision.needs_inspection) return decision.reason;
  if (skills.isUnrevealed(item)) return 'Unidentified item — retain until identified';
  if (skills.isCursedItem(c, item, name)) return 'Cursed item';
  if (/^(shillings?|coins?)$/i.test(name)) return 'Money';
  if (c.using?.has(item.id)) return 'Equipped or in use';
  const equipment = skills.merchantEquipmentPlan(c, { maxWeapons: ap.policy.maxWeapons, weaponPriority: ap.weaponPriorityNow() });
  if (!equipment.verified) return 'Equipment state unknown';
  if (equipment.keep.has(item.id)) return equipment.keep.get(item.id);
  if (skills.itemIsProtected(name, [...(ap.policy.protectedItems || []), ...ap.inheritedProtectedNames()])) return 'Protected equipment, cargo or guild stock';
  const pack = (c.inventory || []).map(o => ({ name: c.rsc.get(o.nameRsc) || '', amount: o.amount || 1 }));
  if (keepTest(ap.loadout(), pack)?.(name)) return 'Loadout keep rule';
  if (saleAllowance(ap.loadout(), name, pack).amount < (item.amount || 1)) return 'Carry reserve (partial-stack disposal is not enabled)';
  try {
    const intent = intentForSession(s, { id: item.id, name });
    if (intent?.state === 'keep' && !(decision.action === 'vault' && intent.purpose === 'vault')) return 'Per-item operator keep intent';
  } catch { return 'Item intent unavailable'; }
  return null;
}
export async function inspectDispositionQuality(ap) {
  const items = (ap.s.client?.inventory || []).filter(o => ap.s.lootDisposition?.(o)?.needs_inspection);
  if (items.length) await skills.inspectForBroken(ap.s, items.slice(0, 12).map(o => o.id));
}
export async function dropTownDispositions(ap, allowedRooms) {
  const s = ap.s, c = s.client;
  const wanted = (c?.inventory || []).filter(o => s.lootDisposition?.(o)?.action === 'drop_town');
  if (!wanted.length) return { dropped: [] };
  if (!allowedRooms.includes(Number(s.world?.room?.num)) || s.combat?.active || ap.travelInterrupted()) {
    ap.note('loot policy town drop held', { why: 'not at a verified town-service room or keeper is interrupted' });
    return { held: true };
  }
  await inspectDispositionQuality(ap);
  const dropped = [], held = [];
  for (const old of wanted) {
    const item = c.inventory.find(o => o.id === old.id && o.nameRsc === old.nameRsc);
    if (!item || s.lootDisposition(item)?.action !== 'drop_town') continue;
    const blocked = dispositionBlock(ap, item) || saleBlocked(s, { id: item.id, name: c.rsc.get(item.nameRsc) }, { dispositionAction: 'drop_town' });
    if (blocked) { held.push({ name: c.rsc.get(item.nameRsc), why: blocked }); continue; }
    const before = item.amount || 1, room = s.world.room.num;
    await s.pacer.submit('drop', () => {
      if (s.world.room.num !== room || s.combat?.active || ap.travelInterrupted() ||
          s.lootDisposition(item)?.action !== 'drop_town' || dispositionBlock(ap, item)) throw new Error('Town drop preconditions changed');
      return c.drop([item.amount > 0 ? { id: item.id, amount: item.amount } : item.id]);
    });
    await s.pacer.submit('read', () => c.requestInventory());
    const reply = await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 });
    if (reply.timedOut) { held.push({ name: c.rsc.get(item.nameRsc), why: 'Drop receipt unknown; not retried' }); break; }
    const now = c.inventory.find(o => o.id === item.id), amount = before - (now ? now.amount || 1 : 0);
    if (amount > 0) { dropped.push({ name: c.rsc.get(item.nameRsc), amount }); s._shedIds ??= new Map(); s._shedIds.set(item.id, Date.now()); }
    else held.push({ name: c.rsc.get(item.nameRsc), why: 'Server did not confirm a drop' });
  }
  ap.note('loot policy town drop', { dropped, held }); return { dropped, held };
}
