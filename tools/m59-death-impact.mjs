// Max-health cost is evidence, not an inference from the character's level.
const finite = n => typeof n === 'number' && Number.isFinite(n);

export function deathImpact(record = {}) {
  const summary = record.summary ?? record;
  const before = summary.max_hp_before ?? summary.level ?? record.vitals?.level ?? null;
  const after = summary.max_hp_after ?? null;
  const explicit = summary.max_hp_lost;
  const loss = finite(explicit) && explicit >= 0 ? explicit
    : finite(before) && before > 0 && finite(after) && after > 0 && before >= after ? before - after : null;
  return { category: loss === null ? 'unknown' : loss > 0 ? 'true_deaths' : 'no_hp_loss',
    max_hp_lost: loss, before, after, under_30: finite(before) ? before < 30 : null };
}

// The sampler can notice death before its asynchronous post-mortem has finished.
// Join the later HP result by exact death identity, never by temporal proximity.
export function withDeathCosts(events = []) {
  const costs = new Map();
  const key = e => `${e.character}\0${e.death_at}`;
  for (const e of events) if (e.kind === 'death_cost' && finite(e.death_at)) costs.set(key(e), e);
  return events.map(e => {
    const cost = e.kind === 'died' && finite(e.death_at) ? costs.get(key(e)) : null;
    return cost ? { ...e, max_hp_before: cost.max_hp_before, max_hp_after: cost.max_hp_after,
      max_hp_lost: cost.max_hp_lost } : e;
  });
}

export const emptyDeathCounts = () => ({ true_deaths: 0, no_hp_loss: 0, unknown: 0,
  under_30: 0, hp_lost: 0, total: 0 });

export function countDeathImpacts(records = []) {
  const counts = emptyDeathCounts();
  for (const record of records) {
    const impact = record.impact ?? deathImpact(record);
    counts[impact.category]++;
    counts.total++;
    if (impact.under_30) counts.under_30++;
    counts.hp_lost += impact.max_hp_lost ?? 0;
  }
  return counts;
}
