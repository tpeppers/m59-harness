// Pure projection of structured activity receipts into the operations boards.
export function mergeActivityCasts(native, training, keeper) {
  if (!native.length) return training.length ? training : keeper;
  const result = native.map(r => ({ ...r })), matched = new Set();
  for (const row of training) {
    const candidates = result.map((r, i) => ({ r, i, distance: Math.abs((r.t ?? r.at) - (row.t ?? row.at)) }))
      .filter(({ r, i, distance }) => i < native.length && !matched.has(i) && distance <= Math.max(15000, (r.cast_time_ms ?? 0) * 1.5 + 15000) &&
        (!r.run || !row.run || r.run === row.run || r.parent_run === row.run || r.source === row.code?.tool || distance <= 15000))
      .sort((a, b) => a.distance - b.distance);
    const candidate = candidates[0];
    if (!candidate) { result.push(row); continue; }
    matched.add(candidate.i);
    if (candidate.r.outcome === 'unknown' && row.outcome && row.outcome !== 'unknown') {
      candidate.r.outcome = row.outcome; candidate.r.evidence = 'verified training receipt';
    }
  }
  return [...result, ...keeper]; // keeper-origin practice uses a different path from broker casts
}

export function activityReport(rows = [], { characters = [], now = Date.now(), fleet = null } = {}) {
  const names = new Map(characters.map(p => [p.agent, p.character]));
  const ours = rows.filter(r => r && r.format === 'm59-activity/1' && names.get(r.agent) === r.character && Number.isFinite(r.at) && r.at <= now && (fleet == null || r.fleet === (fleet || 'default')));
  const unique = [...new Map(ours.filter(r => r.id).map(r => [r.id, r])).values()].sort((a, b) => a.at - b.at);
  const runs = new Map();
  for (const r of unique) {
    if (!r.run) continue;
    const id = `${r.run}|${r.agent}`, run = runs.get(id) ?? { id, run: r.run, agent: r.agent, character: r.character, script: r.script, domains: new Set(), rows: [] };
    (r.domains ?? []).forEach(d => run.domains.add(d));
    if (r.kind === 'transfer' && r.travels !== 'neither') run.domains.add('courier');
    run.rows.push(r); runs.set(id, run);
  }
  const trips = [], active = [], training = [];
  for (const run of runs.values()) {
    const start = run.rows.find(r => r.kind === 'run_start'), end = run.rows.filter(r => r.kind === 'run_end').at(-1);
    if (start) training.push({ ...start, t: start.at });
    for (const gate of run.rows.filter(r => r.kind === 'gate' && start?.goals?.until === r.goal))
      training.push({ kind: 'run_start', agent: run.agent, character: run.character, run: run.run, t: gate.at, goals: start.goals, gate: { known: true, have: gate.have, need: gate.need, gap: gate.gap, open: gate.open } });
    if (end) training.push({ ...end, t: end.at });
    if (!run.domains.has('courier')) continue;
    if (start && !end) { active.push({ id: run.id, agent: run.agent, character: run.character, script: run.script, started: start.at,
      lastAt: run.rows.at(-1).at, stale: now - run.rows.at(-1).at > 180000 }); continue; }
    if (!start || !end) continue;
    const stepStarts = new Map(), legs = [];
    let from = start.room ?? run.rows.find(r => r.kind === 'run_plan')?.room ?? null;
    for (const r of run.rows) {
      if (r.kind === 'step_start') stepStarts.set(r.index, r);
      if (r.kind === 'step_end' && r.step === 'walk') {
        const s = stepStarts.get(r.index);
        legs.push({ from, to: r.to, ok: r.ok, secs: (r.duration_ms ?? (s ? r.at - s.at : 0)) / 1000, why: r.why });
        if (r.ok) from = r.to;
      }
    }
    trips.push({ kind: 'lap_end', run: run.id, agent: run.agent, character: run.character, script: run.script, t: end.at,
      started_at: start.at, duration_ms: Math.max(0, end.at - start.at), completed: end.ok === true && !end.interrupted,
      why: end.why, legs, native: true, run_key: run.run });
  }
  const transfers = unique.filter(r => r.kind === 'transfer').map(r => ({ ...r, dir: 'delivery', native: true, kind: 'transfer', t: r.at }));
  for (const t of transfers) if (!t.run && t.travels !== 'neither') trips.push({ kind: 'lap_end', run: `transfer:${t.id}`, agent: t.agent,
    character: t.character, script: 'supply transfer', t: t.at, duration_ms: t.duration_ms, completed: t.ok === true, why: t.why, native: true });
  const stock = unique.filter(r => ['stock', 'purchase_observed'].includes(r.kind)).map(r => ({ at: r.at, agent: r.agent, character: r.character,
    source: r.tool ?? 'inventory gain after purchase', script: r.script ?? null, items: r.items ?? r.gained ?? [], verified: r.verified ?? null, ok: r.ok ?? null }));
  return { trips, active, transfers, stock, training, casts: unique.filter(r => r.kind === 'cast').map(r => ({ ...r, t: r.at })), rows: unique.length };
}
