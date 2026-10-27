#!/usr/bin/env node
// ARRIVING ON THE ISLAND TO STAY -- offline, against a fake broker; the jungle guard's classifier is the real one.
//
//   node tools/m59-island-arrive-test.mjs
//
// Operator, 2026-10-27: "People who arrive at the island should vault anything they can't bring into the jungle and
// prepare to start carefully farming Avar warriors". What this pins:
//   * both vaultmen are recognised (Obert Cair'bre, and Itzal cha'Nosak in the Ko'catan bank, 2005) -- every reader used
//     to match only Obert, and would have answered "no vaultman in this room" in front of the island's;
//   * vaultForJungle walks to 2005, deposits by name what the guard refuses with a keep count for the copies that may
//     go through, takes worn spares off first, and reads the pack back; anything left refusable is an error;
//   * a posture can select by room (`rooms`, `room_range`), and an unknown room is not a match;
//   * island-arrive refuses thresholds that make no sense, and assigns the farm only after the vault.
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++; else fail++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' -- ' + detail : ''}`);
};
const V = await import('./m59-vaults.mjs');
const I = await import('./m59-island-chalice.mjs');
const P = await import('./m59-posture.mjs');

console.log('the vaultmen');
ok("Obert Cair'bre and Itzal cha'Nosak are both vaultmen", V.isVaultmanName("Obert Cair'bre") && V.isVaultmanName("Itzal cha'Nosak"));
ok('a shopkeeper is not', !V.isVaultmanName('Xacal ko\'Ixca'));
ok("the Ko'catan vault is room 2005", V.vaultIn(2005)?.npc === "Itzal cha'Nosak" && I.KOCATAN_VAULT === 2005);

console.log('vaulting what the jungle refuses');
function fake({ start = 2001, items, equipped = [], refuseVault = false } = {}) {
  const st = { room: start, items: items.map(x => ({ ...x })), equipped: [...equipped], log: [] };
  const call = async (name, a = {}) => {
    st.log.push(name);
    if (name === 'look') return { room: { num: st.room }, you: { row: 5, col: 5 }, hp: { value: 80, max: 80 }, objects: [] };
    if (name === 'inventory') return { items: st.items.map(x => ({ ...x })) };
    if (name === 'equipment') return { known: true, equipped: st.items.filter(x => st.equipped.includes(x.id)).map(x => ({ id: x.id, name: x.name })) };
    if (name === 'act' && a.verb === 'unuse') { st.equipped = st.equipped.filter(id => id !== a.target); return { ok: true }; }
    if (name === 'vault') {
      if (refuseVault) return { ok: false, reason: 'no vaultman in this room' };
      const keep = { ...(a.keep ?? {}) }, out = [];
      st.items = st.items.filter(x => {
        if (!a.items.some(n => n.toLowerCase() === x.name.toLowerCase())) return true;
        if ((keep[x.name] ?? 0) > 0) { keep[x.name]--; return true; }
        out.push(x.name); return false;
      });
      return { ok: true, deposited: out };
    }
    throw new Error(`fake broker: ${name}`);
  };
  return { st, ctx: { agent: 't12', call, state: {} } };
}
// ordinaryHop is real routing; the vault walk is replaced by standing in 2005 already, and one case starts outside.
{
  const f = fake({ start: 2005, items: [
    { id: 1, name: 'long sword' }, { id: 2, name: 'long sword' }, { id: 3, name: 'long sword' },
    { id: 4, name: 'leather armor' }, { id: 5, name: 'chain armor' }, { id: 6, name: 'emerald', amount: 5 }],
    equipped: [5] });
  const rec = {};
  const r = await I.vaultForJungle(f.ctx, { record: rec }).catch(e => ({ error: e.message }));
  const names = f.st.items.map(x => x.name);
  ok('it deposits what the guard refuses and keeps what may go through', r?.ok === true
     && names.filter(n => n === 'long sword').length === 2 && names.filter(n => /armor/.test(n)).length === 1 && names.includes('emerald'),
     JSON.stringify({ r, names }));
  ok('worn protection is kept before a spare (the chain stays on, the leather is vaulted)', names.includes('chain armor') && !names.includes('leather armor'), names.join(', '));
  ok('the plan and the reply are on the record', rec.vault?.done === true && rec.vault.planned.length === 2, JSON.stringify(rec.vault));
}
{
  const f = fake({ start: 2005, items: [{ id: 1, name: 'long sword' }] });
  const r = await I.vaultForJungle(f.ctx).catch(e => ({ error: e.message }));
  ok('nothing to vault: done, no vault call', r?.ok === true && r.vaulted.length === 0 && !f.st.log.includes('vault'));
}
{
  const f = fake({ start: 2005, items: [{ id: 1, name: 'long sword' }, { id: 2, name: 'long sword' }, { id: 3, name: 'long sword' }], refuseVault: true });
  const r = await I.vaultForJungle(f.ctx).catch(e => ({ error: e.message }));
  ok('a vault refusal is an error, not a shrug', /vault_refused/.test(r?.error ?? ''), r?.error);
}
{
  const f = fake({ start: 599, items: [] });
  const r = await I.vaultForJungle(f.ctx).catch(e => ({ error: e.message }));
  ok('off the island it refuses rather than walking somewhere', /requires_island/.test(r?.error ?? ''));
}

console.log('a posture by room');
const units = [{ agent: 'a', room: 2001 }, { agent: 'b', room: 2115 }, { agent: 'c', room: 370 }, { agent: 'd', room: null }];
ok('room_range [2000, 2699] picks the island', P.selectUnits({ who: { room_range: [2000, 2699] } }, units).map(u => u.agent).join() === 'a,b');
ok('rooms [370] picks the inn', P.selectUnits({ who: { rooms: [370] } }, units).map(u => u.agent).join() === 'c');
ok('an unknown room is not a match', !P.selectUnits({ who: { room_range: [0, 99999] } }, units).some(u => u.agent === 'd'));

console.log('island-arrive');
{
  const { script } = await import('./fleetscripts/island-arrive.mjs');
  let why = null; try { await script.steps({ agents: ['t12'], strategy: 'x', restBelow: 0.5, fleeBelow: 0.6 }); } catch (e) { why = e.message; }
  ok('a log-off line above the rest line is refused', /fleeBelow must be under restBelow/.test(why ?? ''));
  const steps = await script.steps({ agents: ['t12'], strategy: 'kocatan-avar-warriors', restBelow: 0.8, fleeBelow: 0.45 });
  ok('vault first, then the farm order', steps.length === 3 && /vault/i.test(steps[1].why) && /farm order/.test(steps[2].why), steps.map(s => s.why ?? s.tool).join(' | '));
  ok('vault only, with no strategy', (await script.steps({ agents: ['t12'], restBelow: 0.8, fleeBelow: 0.45 })).length === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
