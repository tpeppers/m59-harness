// Observed personal danger. Never authorizes a target or changes combat policy.
import { parsePlayerCombat } from './m59-player-evidence.mjs';
import { loadCatalogue } from './m59-deskpractice.mjs';
import { OF } from './m59-parse.mjs';
const textKey = text => String(text ?? '').replace(/~[A-Za-z]/g, '').replace(/\s+/g, ' ').trim();
// Victim-only resources: Hold.hold_on and FreeAction.evade/resist. Enfeeble's
// identical caster/victim sentence is deliberately excluded; its personal
// effect icon supplies evidence without mistaking our own cast for an attack.
const TARGET_EFFECT_MESSAGES = new Map([
  ['A magical tingling pulses through your body. You are unable to move.', 'hold'],
  ['You evade an attempt to restrict your movement.', 'hold'],
  ["You can feel Kraanan's magic working to free you.", 'hold'],
]);
// These icons come from Sickness/Disease objects rather than the Spell tree:
// sickness/poison.kod, sickness/disease/palsy.kod and dementia.kod.
const SICKNESS_EFFECTS = new Set(['poison', 'palsy', 'dementia']);

export class PersonalThreat {
  constructor({ now = Date.now, catalogue = loadCatalogue } = {}) {
    this.now = now; this.spells = catalogue(); this.serial = 0; this.reset();
  }
  reset() { this.episode = null; this.firstAt = null; this.lastAt = null; this.count = 0; this.evidence = null; }
  note(evidence, { engaged = false } = {}) {
    const now = this.now();
    if (!this.episode || !engaged && now - this.lastAt >= 30000) {
      this.reset(); this.episode = ++this.serial; this.firstAt = now;
    }
    this.lastAt = now; this.count++;
    this.evidence = { ...evidence, at: now };
  }
  observe(ev, client, { engaged = false, skipCombat = false } = {}) {
    if (ev.kind === 'disconnected' ||
        ev.kind === 'stat' && ev.name === 'health' && ev.value === 0) { this.reset(); return; }
    if (ev.kind === 'enchantment' && ev.added?.type === 1) {
      const name = String(ev.added.name ?? '').trim().toLowerCase();
      if (this.spells.get(name)?.harmful === true || SICKNESS_EFFECTS.has(name))
        this.note({ kind: 'harmful_effect', effect: name, attacker: null }, { engaged });
    }
    if (ev.kind !== 'message' || !ev.text) return;
    const targeted = TARGET_EFFECT_MESSAGES.get(textKey(ev.text));
    if (targeted) {
      this.note({ kind: 'hostile_spell_effect', effect: targeted, attacker: null }, { engaged }); return;
    }
    const attempted = /^(.+?) tried to cast (.+?) on you\.$/i.exec(ev.text.trim());
    if (skipCombat && !attempted) return; // CombatMode reuses its existing incoming-hit parse.
    const names = [...(client.room?.objects?.values?.() ?? [])]
      .filter(o => o.id !== client.selfId && (o.flags & OF.PLAYER))
      .map(o => client.rsc?.get?.(o.nameRsc) ?? o.name).filter(Boolean);
    for (const p of client.playersOnline?.values?.() ?? []) if (p.id !== client.selfId && p.name) names.push(p.name);
    const hit = skipCombat ? null : parsePlayerCombat(ev.text, names);
    if (hit?.direction === 'incoming') {
      this.note({ kind: hit.outcome === 'hit' ? 'player_hit' : 'player_miss', attacker: hit.character }, { engaged });
      return;
    }
    // PersonalEnchantment_Target_Already_Enchanted_rsc: an attempted hostile
    // effect still targeted us, even though it could not replace an existing one.
    const effect = attempted?.[2].toLowerCase().replace(/^(?:a|an|the) /, '');
    if (attempted && names.some(n => n.toLowerCase() === attempted[1].toLowerCase()) &&
        this.spells.get(effect)?.harmful === true)
      this.note({ kind: 'hostile_spell_attempt', effect, attacker: attempted[1] }, { engaged });
  }
  snapshot({ engaged = false } = {}) {
    const under = this.episode != null && (engaged || this.now() - this.lastAt < 30000);
    return { level: under ? 'under_attack' : engaged ? 'engaged' : 'quiet',
      severity: under ? 2 : engaged ? 1 : 0, episode: under ? this.episode : null,
      first_personal_at: under ? this.firstAt : null, last_personal_at: under ? this.lastAt : null,
      personal_events: under ? this.count : 0, evidence: under ? structuredClone(this.evidence) : null };
  }
}
