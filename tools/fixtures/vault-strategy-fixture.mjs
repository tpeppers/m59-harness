// A minimal stand-in for a fleet's substrate/dumbot/vault-strategy.mjs, for the offline
// fleetscript tests. Real fleets keep theirs in substrate/ and gitignore it; this exists so
// the eviction path is testable on a machine that has no fleet at all.
export const CAPS = Object.freeze({ 'orc tooth': 100, 'inky-cap mushroom': 50 });
export const BULK = Object.freeze({ 'orc tooth': 3, 'inky-cap mushroom': 10 });

export function evictionPlan(items = []) {
  const plan = [];
  for (const i of items) {
    const name = String(i.name || '').toLowerCase();
    const amount = i.amount ?? 1;
    const cap = CAPS[name];
    if (!cap || amount <= cap) continue;
    plan.push({ name: i.name, amount, evict: amount - cap,
                freed: (BULK[name] ?? 0) * (amount - cap),
                disposition: /inky-?cap/i.test(name) ? 'carry' : 'sell',
                why: `over the ${cap}-piece cap` });
  }
  return { plan, pct: 12, freed: plan.reduce((n, r) => n + r.freed, 0) };
}
