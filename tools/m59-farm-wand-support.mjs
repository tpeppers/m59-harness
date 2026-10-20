// Adapter for the same guarded support sender outside a PvP body override.
// No policy here: absent an enabled healingWand hook, the old self helper wins.
import { CombatSupport } from './m59-combat-support.mjs';
export class FarmWandSupport {
  constructor(ap) {
    this.ap = ap;
    const s = ap.s;
    this.mode = { s, active: null, agentId: s.name, now: () => Date.now(),
      isOurs: name => s.combat?.isOurs(name) ?? false,
      personalThreatStatus: () => s.combat?.personalThreatStatus() ?? { level: 'quiet' },
      combatStrategies: () => s.combat?.combatStrategies() ?? Promise.resolve(null),
      record: (_kind, o) => ap.note('healing wand support', o.lastSupport) };
    this.support = new CombatSupport(this.mode);
  }
  snapshot() { return this.support.snapshot(); }
  async tick({ allowed, cancelled }) {
    const m = this.mode, s = m.s, c = s.client;
    const loaded = await m.combatStrategies();
    if (!loaded?.strategies?.some(st => st.enabled && typeof st.healingWand === 'function')) return false;
    if (!allowed() || cancelled()) return true;
    let o = m.active;
    if (!o || o.client !== c || o.room !== c.room?.id || o.generation !== s.movementGeneration) {
      o = m.active = { client: c, room: c.room?.id, body: c.selfId, generation: s.movementGeneration,
        farming: true, phase: 'farming', phaseRevision: 0 };
    }
    o.allowed = () => allowed() && !cancelled() && s.client === c && c.selfId === o.body &&
      c.room?.id === o.room && s.movementGeneration === o.generation && !s.combat?.active;
    o.baseBelow = this.ap.policy?.healWandBelow ?? 0;
    this.support.offer(o); // inspection is asynchronous; attacks/movement continue
    return true;
  }
}
