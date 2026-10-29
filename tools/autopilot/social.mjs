// SOCIAL: healing others, donations, sharing reagents, buffs, rescue to a shop.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 21 methods: social, static HEALS, activeSelfHealing, tryActiveSelfHeal, healObservedFleetmate,
//   medic, static DONATION_TAKES, static DONATION_SHEDS, bulkFree, shedForDonation,
//   acceptDonations, acceptNeededGift, isServicePost, shareSpareReagents, static BUFFS, static
//   ROOM_ENCHANTS, buffFloorMs, reagentOnHand, rescueToShop, drinkAtPoolOfVigor, kocatanGateRefusal,
//   gateLootCap, kocatanGateVault
import { allyVerdict } from '../m59-ally.mjs';
import { withCastRite } from '../m59-castrite.mjs';
import { sameName } from '../m59-chalice.mjs';
import { arenaCall } from '../m59-chatter.mjs';
import { readFleetHealth } from '../m59-fleet-health.mjs';
import { unwrapSpeech } from '../m59-inbox.mjs';
import { claimGift, releaseGift } from '../m59-interest-store.mjs';
import { keeperOrigin } from '../m59-move-origin.mjs';
import { isVaultmanName } from '../m59-vaults.mjs';
import { OF, dropSpec } from '../m59-parse.mjs';
import { KOCATAN_SMITHY, gateClearPlan, gateStation } from '../m59-kocatan-gate.mjs';
import * as party from '../m59-party.mjs';
import { GATE_LIMITS, KOCATAN_VAULT, POOL_OF_VIGOR, POOL_DRINK_SAID, inPool, jungleStashPlan, jungleItemClassifier } from '../m59-island-chalice.mjs';
import { normalizeTradeGoods, noteReceived, tradeGoodsFit } from '../m59-loot-eject.mjs';
import * as pvpGear from '../m59-pvp-gear.mjs';
import { affordablePoisonCure, castRecoveryCure } from '../m59-recovery-cure.mjs';
import { affordableHeal, castRecoveryHeal, healAllowed, healReadiness } from '../m59-recovery-heal.mjs';
import { normalizeShare, planGift } from '../m59-sharing.mjs';
import * as skills from '../m59-skills.mjs';
import { huntLabel } from '../m59-spawns.mjs';
import * as wandDuty from '../m59-wand-duty.mjs';
import { Autopilot, healAllowOf, pct } from '../m59-autopilot.mjs';

export class SocialPart {
  // @part 1


  // BE ANSWERABLE. A character that never replies is not just rude, it is a dead
  // end: someone offering a newly-killed bot a weapon has no way to tell whether
  // anyone is home, and gives up. Two things are worth doing every pass, both
  // cheap because they read state we already have.
  async social() {
    const s = this.s, c = s.need();

    // 1. Take gifts. A trade where the other side has put something up and we have
    //    put up nothing is a hand-out, and the way to accept one is to counter with
    //    nothing — countering is what grants the other side permission to accept.
    //    Only ever counter EMPTY, so this can never give our own things away.
    const t = c.trade;
    // EXCEPT A SECOND CHALICE: accepting it destroys one of the two (chalice.kod NewOwner).
    if (t && t.withId && (t.theirs?.length) && !(t.ours?.length) && this.offerWouldDoubleChalice(t)) {
      if (this._secondCupDeclined !== t.revision) {
        this._secondCupDeclined = t.revision;
        await s.pacer.submit('trade', () => c.cancelOffer()).catch(() => {});
        this.note('declined a chalice', { from: t.withName, why: 'already carrying one — two cups are better than one poured together' });
      }
    } else if (t && t.withId && (t.theirs?.length) && !(t.ours?.length)) {
      try {
        await s.pacer.submit('trade', () => c.counterOffer([]));
        this.note('accepted a gift', { from: t.withName,
                                       items: t.theirs.map(i => i.name + (i.amount > 1 ? ` x${i.amount}` : '')) });
        this.progress('someone gave us something');
        // Put it to use immediately — a donated sword is no help in the pack.
        await skills.equipBest(s, { priority: this.weaponPriorityNow(), banned: this.bannedWeaponsNow() }).catch(() => {});
      } catch (e) { this.note('could not accept a gift', { why: e.message }); }
    }

    // 2. Answer anyone who says our name. Rate-limited, because the reply goes to
    //    the whole room and a keeper that chatters every eight seconds is worse
    //    than one that says nothing.
    const evs = c.eventsSince(this.socialCursor || 0).filter(e => e.kind === 'said');
    this.socialCursor = c.evSeq;
    const myName = (c.me?.name || '').toLowerCase();
    if (!myName) return;
    // THE ANSWER BELOW IS A STATUS REPORT, SO IT IS FOR THE OPERATOR AND NOBODY ELSE.
    //
    // It recites what this character hunts, its health and whether it is stuck. Said to the
    // room, that narrates the fleet to whoever is standing there — and it did, on prod, on
    // 2026-09-30: an NPC's line happened to contain a character's name, and the character
    // answered it with its quarry and hit points, during a guild war in which three players
    // have been hunting this fleet by name. So only speech from one of OUR characters counts
    // as asking — which, since the bots never ask, means the operator piloting one. A
    // stranger, a player or an NPC gets silence: the answer that was always available.
    const toMe = evs.filter(e => e.speaker !== c.selfId &&
                                 String(e.text || '').toLowerCase().includes(myName) &&
                                 e.name && String(e.name).toLowerCase() !== myName &&
                                 party.isFleetmate(e.name));
    if (!toMe.length) return;

    // BEING CALLED INTO THE RING IS NOT SMALL TALK, AND THIS RAN FIRST.
    //
    // Saying a character's name in an arena on a local server means "enter the bout" —
    // m59-chatter.mjs owns that reply, because speech is the chatter's job and it is the
    // layer with the budget, the frozen check and the tests. But this responder reads the
    // event stream directly, matches the name as a SUBSTRING, and got there first: asked
    // to challenge, Alpha answered "Alpha: not hunting anything, 88/50 health."
    //
    // So the keeper stands down rather than duplicating the answer. `arenaCall` is
    // imported rather than restated so there is one definition of when this applies.
    const called = toMe.some(e => arenaCall({
      text: unwrapSpeech(String(e.text || '')).said,
      character: c.me?.name, roomNum: s.view?.()?.room?.num ?? null,
      host: s.credentials?.host ?? null,
    }));
    if (called) {
      this.note('called into the ring', { by: toMe[toMe.length - 1].text?.slice(0, 80),
                                          note: 'left to the chatter, which answers with `challenge`' });
      return;
    }

    if (Date.now() - (this.lastReply || 0) < 25000) return;
    this.lastReply = Date.now();

    const v = c.vitals();
    const hp = v.health ? `${v.health.value}/${v.health.max}` : '?';
    const wielding = (c.inventory || []).length ? '' : ' I have nothing on me.';
    const what = this.policy.hunt ? `hunting ${huntLabel(this.policy.hunt)}` : 'not hunting anything';
    const stalled = this.stalledSince ? ` I am stuck: ${this.stalledWhy}.` : '';
    const reply = `${c.me.name}: ${what}, ${hp} health.${wielding}${stalled} ` +
                  (this.needsRecovery || !(c.inventory || []).length
                    ? 'Gear or shillings would help enormously.'
                    : 'Thanks for asking.');
    try {
      await s.pacer.submit('say', () => c.say(reply));
      this.note('answered someone', { heard: toMe[toMe.length - 1].text?.slice(0, 80), said: reply });
    } catch (e) { this.note('could not answer', { why: e.message }); }
  }

  // Rearm after dying, and if we cannot, say so out loud where people are.
  //
  // Dying drops everything, so the character wakes with nothing. First try the
  // obvious: re-wield whatever survived. If there is genuinely no weapon, ask —
  // broadcasting for a hand-out at an inn is what a newly-dead player actually
  // does, and in a world with other agents in it, it is a strategy rather than a
  // gesture. Kept to one message per death: the same channel carries a mana cost
  // and a social one.
  // Heal whoever else is standing here, if we can.
  //
  // Minor heal (heal.kod:100) is worth far more in this fleet than its name suggests:
  //     iHeal = random(1,5) + (power+1)/20 + target_karma/20, bounded to 10
  //     ... PLUS random(2,5) again if the target is not yet PKILL_ENABLE
  // Every character here is under 30 base health, so every one of them qualifies for
  // that newbie bonus — up to ten points for three mana and one herb. It also pays
  // the CASTER: healing someone whose karma is higher than yours awards karma, which
  // is exactly the direction a Shal'ille student needs to move.
  //
  // And casting is how abilities improve at all, so a Shal'ille character with a
  // wounded ally in the room has a move that heals the ally, trains the spell, and
  // raises its own karma in one action. There is no reason not to take it.
  // THE HEAL LADDER, HIGHEST FIRST — and which rung is cast is the whole point.
  //
  // Shal'ille has three: minor heal at level 1 (3 mana, 1 herb), hospice at level 3 (10 mana
  // and 3 herbs), major heal at level 5 (20 mana, 5 herbs). This used to match `/^(minor heal|heal)$/` and so
  // always cast the LEVEL ONE spell, whatever the caster knew.
  //
  // That is not a style point. `PlayerCanLearn` gates level N on the best THREE abilities at
  // level N-1, so for a character whose goal is the next school level, practice on a level-1
  // spell contributes exactly NOTHING to the gate. Loial the Ogier, 2026-09-09: hospice 25,
  // cure disease 19, identify 17 against the 115 that "forces of light" wants — and a medic
  // pass that healed allies all day with minor heal would have moved none of it. Casting the
  // best rung instead turns every hurt fleet-mate into practice at the level that counts, and
  // needs no amulet, no dedicated patient and no second character held still for it.
  static HEALS = Object.freeze([
    // EVERY RUNG TAKES HERBS (heal.kod, hospice.kod, majheal.kod via substrate/m59-spells.json).
    // Minor and major heal were listed with none, so a caster out of herbs sent casts the server
    // refused in silence — which is exactly what the reagent check below exists to prevent.
    { name: 'major heal', mana: 20, reagents: [['herb', 5]] },
    { name: 'hospice',    mana: 10, reagents: [['herb', 3]] },
    { name: 'minor heal', mana: 3,  reagents: [['herb', 1]] },
  ]);

  // Protected self recovery can run while a normal road job awaits movement.
  // The cast shares pacing/rite holds; it never selects a new destination.
  activeSelfHealing(trigger='health_push'){
    if(this._activeSelfHealPromise)return trigger.startsWith('login_ready')?this._activeSelfHealPromise:Promise.resolve(false);
    const pending=this.tryActiveSelfHeal(trigger);let tracked;
    tracked=Promise.resolve(pending).finally(()=>{if(this._activeSelfHealPromise===tracked)this._activeSelfHealPromise=null;});
    this._activeSelfHealPromise=tracked;return tracked;
  }
  async tryActiveSelfHeal(trigger='health_push'){
    const s=this.s,c=s?.client,v=c?.vitals?.(),hp=pct(v?.health),now=Date.now(),cure=affordablePoisonCure(c);
    if(this.stopping||!c?.combatReady||c.state!=='game'||!(hp>0&&(hp<0.9||cure))||s.live===false||this._activeSelfHealPending||s._rite||s.combat?.active||this.checkFreeze()||
      this.inert&&!this.inert.travelling||['survival','recovery','combat'].some(k=>this.facultyHeld(k))||now-(this._recoveryHealAt??0)<3000)return false;
    const readiness=healReadiness(c,{allow:healAllowOf(this)}),{inventory_at,spells_at,...resources}=readiness,key=JSON.stringify([c.loginStartedAt,hp,inventory_at!=null,spells_at!=null,resources]);
    if(this._healReadinessKey!==key){this._healReadinessKey=key;c.observeSessionEvidence?.({kind:'action',opcode:'HEAL_CHECK',reason:JSON.stringify({trigger,...readiness})});}
    if(!readiness.affordable&&!cure)return false;
    const generation=s.movementGeneration,self=c.selfId,room=c.room?.id;
    const cancelled=()=>this.stopping||s.client!==c||!c.combatReady||c.state!=='game'||s.live===false||this.inert&&!this.inert.travelling||c.selfId!==self||c.room?.id!==room||s.movementWasCancelled?.(generation)||s.combat?.active||this.checkFreeze()||['survival','recovery','combat'].some(k=>this.facultyHeld(k));
    this._activeSelfHealPending=true;this._recoveryHealAt=now;
    try{const result=await (cure?castRecoveryCure:castRecoveryHeal)(s,{shouldCancel:cancelled,allow:healAllowOf(this)});this.note('active self heal',{trigger,...readiness,...result});
      c.observeSessionEvidence?.({kind:'action',opcode:'HEAL_RESULT',reason:JSON.stringify({trigger,...result})});
      if(result.cast)this.recordCast(result.spell,{ok:result.confirmed,...result});else if(this._recoveryHealAt===now)this._recoveryHealAt=0;return result.cast;
    }finally{this._activeSelfHealPending=false;}
  }

  // Health reports come from the ally's own socket, scoped to endpoint and body.
  // Stale or unobserved allies never acquire an invented HP value.
  async healObservedFleetmate() {
    const s=this.s,c=s.client,now=Date.now(),credentials=s.credentials;
    if(!['farm','idle'].includes(this.mode)||this.facultyHeld('work')||s.combat?.active||!c?.combatReady||!credentials||this.checkFreeze()||s._rite
       ||!(pct(c.vitals()?.health)>=0.9)||!affordableHeal(c,{allow:healAllowOf(this)})||now-(this._observedAllyHealAt??0)<3000)return false;
    const candidates=[...c.room.objects.values()].filter(o=>o.id!==c.selfId&&(o.flags&OF.PLAYER)&&
      allyVerdict({name:c.rsc.get(o.nameRsc)??'',flags:o.flags},{friends:this.policy?.buffAllies?.friends??[]}).ally)
      .map(o=>({o,report:readFleetHealth({...credentials,character:c.rsc.get(o.nameRsc)},{room:s.world?.room?.num,bodyId:o.id,now})}))
      .filter(({report:r})=>r&&r.health.value/r.health.max<0.9&&r.health.max-r.health.value>=3)
      .sort((a,b)=>a.report.health.value/a.report.health.max-b.report.health.value/b.report.health.max);
    const target=candidates[0];if(!target)return false;
    const generation=s.movementGeneration,bodyId=c.selfId,room=c.room.id;
    const cancelled=()=>s.client!==c||c.selfId!==bodyId||c.room.id!==room||s.movementWasCancelled?.(generation)||!['farm','idle'].includes(this.mode)||this.facultyHeld('work')||s.combat?.active||this.checkFreeze()||!(pct(c.vitals()?.health)>=0.9)||
      !(() => {const r=readFleetHealth({...credentials,character:target.report.character},{room:s.world?.room?.num,bodyId:target.o.id});return r&&r.health.value/r.health.max<0.9&&r.health.max-r.health.value>=3;})()||
      String(c.rsc.get(c.room.objects.get(target.o.id)?.nameRsc)??'').trim().toLowerCase()!==target.report.character.trim().toLowerCase()||
      !allyVerdict({name:c.rsc.get(c.room.objects.get(target.o.id)?.nameRsc)??'',flags:c.room.objects.get(target.o.id)?.flags??0},{friends:this.policy?.buffAllies?.friends??[]}).ally;
    this._observedAllyHealAt=now;
    const result=await castRecoveryHeal(s,{targetId:target.o.id,targetHealth:target.report.health,shouldCancel:cancelled,allow:healAllowOf(this)});
    const afterReport=readFleetHealth({...credentials,character:target.report.character},{room:s.world?.room?.num,bodyId:target.o.id});
    result.target_report_before_at=target.report.at;
    if(afterReport&&afterReport.at>=target.report.at){result.target_health_after=afterReport.health;result.target_report_after_at=afterReport.at;}
    c.observeSessionEvidence?.({kind:'action',opcode:'HEAL_RESULT',reason:JSON.stringify({trigger:'observed_fleetmate',...result})});
    this.note('observed ally heal',{target:target.report.character,report_age_ms:now-target.report.at,...result});
    if(result.cast){this.lastHealAt=now;this.recordCast(result.spell,{ok:result.confirmed,target:target.report.character,...result});}
    return result.cast;
  }

  async medic() {
    const s = this.s, c = s.need();
    const MEDIC_GAP_MS = 45_000;
    if (this.lastHealAt && Date.now() - this.lastHealAt < MEDIC_GAP_MS) return;

    // Pick the best rung this character HOLDS and can actually pay for, then fall down the
    // ladder. Reagents are checked before the cast for the same reason buffAllies checks
    // them: a cast that cannot pay them is refused server-side and, from here, looks exactly
    // like a cast that landed.
    const mana = c.vitals()?.mana;
    let spell = null, rung = null;
    const tried = [];
    for (const h of Autopilot.HEALS) {
      if (!healAllowed(h.name, healAllowOf(this))) continue;
      const found = (c.spells || [])
        .find(sp => String(c.rsc.get(sp.nameRsc) || '').toLowerCase() === h.name);
      if (!found) continue;
      if (mana && mana.value < h.mana + 1) { tried.push(`${h.name} (needs ${h.mana + 1} mana)`); continue; }
      const short = h.reagents.filter(([n, k]) => this.reagentOnHand(n) < k);
      if (short.length) { tried.push(`${h.name} (short ${short.map(([n]) => n).join(', ')})`); continue; }
      spell = found; rung = h; break;
    }
    if (!spell)
      return this.declinedCast('heal', tried.length ? `cannot pay for any heal: ${tried.join('; ')}`
                                                    : 'the character does not have the spell',
                               { mana: mana?.value ?? null });

    // Another player, not us, not a monster.
    // Raw room objects carry flags, not the snapshot's derived booleans — `is_player`
    // is computed in the world model and does not exist here.
    //
    // AND A FULL-HEALTH TARGET IS A WASTED PASS THAT SAYS NOTHING. `hospice.kod:88`
    // CanPayCosts returns FALSE when the target is already at full health, before any
    // message, so the cast simply does not happen: no mana, no reagent, no practice. We
    // cannot see another player's health from a room object — the wire does not carry it —
    // so the only honest way to learn it is to try and watch the mana. A target that costs
    // nothing is remembered as unhurt and skipped for a while, which lets the next pass try
    // somebody else instead of re-picking the same healthy body for ever.
    // THE MOST WOUNDED FIRST — AS CLOSE AS A KEEPER CAN GET TO IT, WHICH IS NOT ALL THE WAY.
    //
    // The operator asked for "always pick the most wounded" and a keeper cannot read another
    // player's health: the wire does not carry it, and `m59-party.mjs`'s health board is a
    // module-level Map, so every keeper PROCESS has its own copy of it — it stopped being a
    // cross-character source the day keepers moved out of the broker, the same casualty as
    // the fleet-mate check (see docs/m59-keeper.md). Anything here claiming to rank by health
    // would be ranking by null.
    //
    // What IS knowable is what our own casts told us. A cast that spends nothing proves the
    // target was whole (hospice.kod:88), so each body carries a timestamp of when it was last
    // PROVEN whole. Ordering by that — never-tried first, then longest-ago — converges on the
    // wounded and self-corrects: somebody healed five minutes ago and since chewed on by a
    // spider sorts back to the front, and somebody standing at full health all afternoon sorts
    // to the back and stays there.
    //
    // A real most-wounded pick needs the health the BROKER already has for every character,
    // so it belongs in a driver outside the keeper — which is what m59-shalille-train.mjs does when
    // it chooses its patient. Written down rather than faked.
    this._unhurtUntil ||= new Map();
    this._provenWholeAt ||= new Map();
    const now = Date.now();
    // AN ALLY, NOT ANY PLAYER -- the same rule and the same incident as buffAllies: healing a
    // player who is killing the fleet is the worst cast a keeper can make. See m59-ally.mjs.
    const candidates = [...c.room.objects.values()]
      .filter(o => o.id !== c.selfId && (o.flags & OF.PLAYER) &&
                   allyVerdict({ name: c.rsc.get(o.nameRsc) || '', flags: o.flags },
                               { friends: this.policy?.buffAllies?.friends ?? [] }).ally)
      .map(o => ({...o, healthReport: s.credentials ? readFleetHealth({...s.credentials,character:c.rsc.get(o.nameRsc)},{room:s.world?.room?.num,bodyId:o.id,now}) : null}))
      .filter(o => !o.healthReport || o.healthReport.health.value < o.healthReport.health.max)
      .sort((a,b) => (a.healthReport ? a.healthReport.health.value/a.healthReport.health.max : 1) -
                    (b.healthReport ? b.healthReport.health.value/b.healthReport.health.max : 1) ||
                    (this._provenWholeAt.get(a.id)??0)-(this._provenWholeAt.get(b.id)??0));
    const other = candidates.find(o => o.healthReport || !(this._unhurtUntil.get(o.id) > now)) ?? null;
    if (!other)
      return this.declinedCast(rung.name, candidates.length
        ? 'everyone here read as unhurt on a recent pass'
        : 'no ally in the room to heal');

    this.lastHealAt = Date.now();
    const manaBefore = c.vitals()?.mana?.value ?? null;
    await withCastRite(s, { spell, targets: [other.id], why: 'medic' }, () => s.pacer.submit('cast', () => {
      const r=s.credentials ? readFleetHealth({...s.credentials,character:c.rsc.get(other.nameRsc)},{room:s.world?.room?.num,bodyId:other.id}) : null;
      if(other.healthReport && (!r || r.health.value>=r.health.max)) return;
      c.cast(spell.id,[other.id]);
    }, 1050));
    const ev = await c.waitFor({ kinds: ['message', 'stat'], timeoutMs: 3000 }).catch(() => ({ events: [] }));
    // A CAST THAT SPENT NO MANA DID NOT HAPPEN, and here it usually means the target was
    // already whole. Remember that for a few minutes so the next pass tries somebody else.
    const manaAfter = c.vitals?.()?.mana?.value ?? null;
    const spent = manaBefore != null && manaAfter != null ? manaBefore - manaAfter : null;
    const landed = !(spent === 0);
    if (!landed) {
      this._unhurtUntil.set(other.id, Date.now() + 5 * 60_000);
      // Proven whole just now, so it sorts to the BACK of the next pass's queue.
      this._provenWholeAt.set(other.id, Date.now());
    }
    if (landed) this.tally.heals_given = (this.tally.heals_given || 0) + 1;
    // A heal cast on someone else has no inventory diff to prove it landed, so `ok`
    // here means "the cast went out", not "they were healed". Said plainly rather than
    // borrowing the confidence the creation spells earn from a changed pack — and where the
    // mana says nothing was spent, it does not even claim that much.
    this.recordCast(c.rsc.get(spell.nameRsc) || 'heal', {
      ok: landed, target: c.rsc.get(other.nameRsc),
      why: landed ? 'a wounded ally in the room: heals them, trains the spell, raises our karma'
                  : 'nothing was spent — the target was already whole, so no practice either',
      mana_before: manaBefore, mana_after: manaAfter, mana_spent: spent });
    this.note('healed someone', {
      target: c.rsc.get(other.nameRsc), spell: c.rsc.get(spell.nameRsc),
      said: ev.events?.filter(e => e.text).map(e => e.text).slice(0, 2),
      why: 'heals them, trains the spell, and raises our karma if theirs is higher' });
    this.progress('cast a heal on an ally');
  }



  // ACCEPT REAGENTS FROM A FLEETMATE WITHOUT BEING ASKED TWICE.
  //
  // The point of this is to turn a two-sided coordination problem into a one-sided one.
  // A fleetmate that wants a buff should be able to walk over, push the reagents across,
  // and leave — with nobody having to agree on timing, and no message sent. The service
  // provider's whole job here is to say yes.
  //
  // THE WIRE PROTOCOL ALREADY MAKES THAT THE EASY HALF. From the OFFER handler in
  // m59-client.mjs: "This is the only unsolicited message that requires a reply to make
  // progress: until we counteroffer, the other side cannot accept, and the trade sits
  // open." So the obligation on this side is a COUNTEROFFER THAT MAY BE EMPTY — a
  // mechanical reply with nothing in it and no judgement required. That is exactly what
  // can be automated, and it is why this works.
  //
  // THREE REFUSALS, and they are the whole safety of it:
  //
  //   not a fleetmate      this is a shared server. `party.isFleetmate` is answered from
  //                        the roster the broker actually loaded, and it is the same test
  //                        the grudge book uses. A stranger offering junk to a caster
  //                        whose pack is already 98% full is a denial of service, not a
  //                        donation.
  //   something unwanted   every item offered has to be on the take list. Accepting a
  //                        mixed pile means accepting whatever else was in it.
  //   nothing to gain      an empty offer is somebody opening a trade window, not giving.
  //
  // Anything refused is CANCELLED rather than ignored, because an open trade blocks the
  // other side from doing anything else with that window.
  static DONATION_TAKES = ['orc tooth', 'sapphire', 'mushroom', 'elderberry', 'herb'];
  static DONATION_SHEDS = ['mushroom'];

  /**
   * Bulk headroom, or null when the pack cannot be measured.
   *
   * `carryCapacity` withholds `room_for` whenever anything in the pack is unweighed, and
   * that silence is load-bearing: an unknown load must not be read as a full one. Every
   * caller here treats null as "carry on", certainty in one direction only -- the same
   * rule the create-weapon path already follows.
   */
  bulkFree() {
    const cap = skills.carryCapacity(this.s?.client);
    const room = cap?.room_for?.bulk;
    return Number.isFinite(room) ? room : null;
  }

  /**
   * PUT DOWN THE CHEAP BULKY THING TO MAKE ROOM FOR THE USEFUL ONE.
   *
   * m59-almoner.mjs has the same idea behind `--drop-for-space`, disarmed, and its comment
   * says precisely why it stayed off: "Re-arming by default needs a POSITIVE full-pack
   * signal — `pack.percent` would be it, and it reads null fleet-wide here because
   * `carryCapacity` cannot see MIGHT." The keeper is where that signal exists: its own
   * carry block reports `load` and `room_for` with `exact: true`, computed from
   * `1700 + might * 20` (player.kod:10456). So this is the same fallback moved to the one
   * place that can tell a full pack from an unreadable one.
   *
   * Mushrooms are the right thing to shed: they are the bulky, cheap half of the reagent
   * pile, and this caster is standing in a room that produces them. It is still SPENDING
   * money to buy pack space, so it happens only when the space is actually needed.
   *
   * THE FLOOR IS NOT A SAFE. `farmCleanup` sweeps floor items before sell-bound
   * departures, and on a shared server another player can simply take them. Treat a
   * dropped stack as spent, not stored -- which is why only the cheapest kind goes down.
   */
  async shedForDonation(need = 0) {
    const c = this.s?.client;
    const sheds = [].concat(this.policy.acceptDonations?.drop_for_space
                            ?? Autopilot.DONATION_SHEDS).map(x => String(x).toLowerCase());
    if (!sheds.length) return { shed: false, why: 'nothing is listed as sheddable' };
    const held = (c?.inventory || []).filter(o => {
      const n = String(c.rsc.get(o.nameRsc) || '').toLowerCase();
      return sheds.some(s => n.includes(s));
    });
    if (!held.length) return { shed: false, why: 'holding none of the sheddable kinds' };
    const target = held[0];
    const name = c.rsc.get(target.nameRsc) || 'reagent';
    await this.s.pacer.submit('act', () => c.drop(target.id)).catch(() => {});
    this.note('shed a reagent to make room for a donation', {
      dropped: name, bulk_free_before: need,
      why: 'providing the service matters more than the stack, and the floor is not a safe: '
         + 'farm cleanup sweeps it and another player can take it' });
    return { shed: true, dropped: name };
  }

  async acceptDonations(cfgIn = null) {
    const cfg = cfgIn ?? this.policy.acceptDonations;
    if (!cfg || cfg.enabled === false) return;
    const c = this.s?.client;
    const t = c?.trade;
    if (!t || t.role !== 'recipient') return;              // nobody is offering us anything
    if (this._donationSeen === t.revision) return;          // already dealt with this one
    this._donationSeen = t.revision;

    const takes = [].concat(cfg.reagents ?? Autopilot.DONATION_TAKES)
      .map(x => String(x).trim().toLowerCase()).filter(Boolean);
    // WHATEVER THIS CHARACTER NEEDS RIGHT NOW is always on the take list (m59-sharing.mjs): a desk
    // configured for emeralds that runs out of herbs takes the herbs a fleetmate brings.
    for (const k of (this._needsNow?.keys?.() ?? [])) if (!takes.includes(k)) takes.push(String(k).toLowerCase());
    // CHALICE FARMING PASSES THROUGH HERE BOTH WAYS: the cup itself, handed between the
    // holder and the alternate, and the traveller's tip. Refusing either would cancel a
    // hand-off the fleet arranged, with every log on both sides reading "declined".
    if (this.chaliceCfg) takes.push('chalice', 'shilling', ...Object.keys(this.chaliceCfg.holder_supply ?? {}));
    // THE WAND BANK'S PICKUP OFFER is wanted, and refusing it here would cancel the hand-out.
    if (this.wandDutyCfg && wandDuty.sameName(t.withName, this.wandDutyCfg.holder)) takes.push('wand');
    const offered = (t.theirs || []).map(i => String(i.name || '').toLowerCase());

    const refuse = async (why) => {
      // THE DEFAULT PATH NEVER CANCELS: an offer it does not recognise may belong to another flow
      // (a supply exchange, a person trading by hand), so it is left exactly as it was.
      if (cfg._default) return { accepted: false, why, left_open: true };
      await this.s.pacer.submit('act', () => c.cancelOffer()).catch(() => {});
      this.note('declined a trade', { from: t.withName, offered: t.theirs, why });
      return { accepted: false, why };
    };

    if (!offered.length) return refuse('an empty offer is a trade window, not a donation');
    // A SECOND CUP IS NEVER ACCEPTED, from anybody: chalice.kod NewOwner pours it into ours and
    // deletes it. The giver's keeper should not have offered (chaliceGive), but a register can be stale.
    if (this.offerWouldDoubleChalice(t))
      return refuse('already carrying a chalice — a second would be poured into it and destroyed');
    // EXPECTED INCOMING IS ALWAYS TAKEN (m59-pvp-gear.mjs): the PvP kit this character does not
    // carry yet, and the fleet's expect_incoming list. The operator hands characters their kit
    // and they take it -- whoever is handing it over, and whatever the take list says.
    const expected = pvpGear.offerIsExpected(c, t.theirs || []);
    if (!expected && !party.isFleetmate(t.withName))
      return refuse(`${t.withName} is not on the fleet roster — this is a shared server`);
    // TRADE GOODS (m59-loot-eject.mjs): a station or courier takes a fleetmate's sale pile, whatever it is, as long as
    // its pack keeps `keep_free` empty afterwards -- the station's own service comes first. `from` limits the givers.
    let tradeGoods = null;
    try { tradeGoods = normalizeTradeGoods(cfg.trade_goods); } catch { tradeGoods = null; }
    const tradeGoodsApply = !!tradeGoods && !expected && (!tradeGoods.from || tradeGoods.from.includes(String(t.withName).toLowerCase()));
    if (tradeGoodsApply) {
      const fit = tradeGoodsFit({ offered: t.theirs || [], cap: skills.carryCapacity(c), keepFree: tradeGoods.keep_free });
      if (!fit.fits) return refuse(`no room for trade goods: ${fit.why}`);
    }
    const unwanted = expected || tradeGoodsApply ? [] : offered.filter(n => !takes.some(w => n.includes(w)));
    if (unwanted.length)
      return refuse(`offered something not on the take list: ${[...new Set(unwanted)].join(', ')}`);

    // ROOM FIRST, THEN YES. Accepting into a pack with no space is the failure `supply`
    // reports as "a receiver that can give but not receive", and from outside it is
    // indistinguishable from an accept that worked: nothing arrives and no count rises.
    const free = this.bulkFree();
    const floor = Number(cfg.min_bulk_free ?? 40);
    if (free !== null && free < floor) await this.shedForDonation(free);

    // The empty counteroffer is the whole mechanism: it gives nothing and it is what
    // unblocks the other side. Then accept.
    const before = c.evSeq;
    await this.s.pacer.submit('act', () => c.counterOffer([])).catch(() => {});
    await c.waitFor({ since: before, kinds: ['trade', 'message'], timeoutMs: 2500 })
      .catch(() => ({ events: [] }));
    await this.s.pacer.submit('act', () => c.acceptOffer()).catch(() => {});
    this.tally.donations_taken = (this.tally.donations_taken || 0) + 1;
    // A STATION REMEMBERS WHAT IT WAS GIVEN AS TRADE GOODS, by name, so it passes on those and never its own kit.
    if (tradeGoodsApply) { try { noteReceived(String(this.s.name ?? ''), t.theirs || []); } catch {} }
    this.note('accepted a donation', {
      from: t.withName, took: t.theirs,
      why: 'a fleetmate paying for a service in advance: accept now, cast at the next '
         + 'opportunity, so the donor never has to coordinate a moment with us' });
    this.progress(`took reagents from ${t.withName}`);
    return { accepted: true, from: t.withName, took: t.theirs };
  }

  // ACCEPT WHAT WE NEED, WITH NO POLICY. A fleetmate's offer made only of things this keeper has on
  // the board as a need is taken; anything else is left open (acceptDonations, cfg._default).
  async acceptNeededGift() {
    const t = this.s?.client?.trade;
    if (!t || t.role !== 'recipient') return null;
    if (this.policy.acceptDonations) return this.acceptDonations();
    const needs = [...(this._needsNow?.keys?.() ?? [])].map(k => String(k).toLowerCase());
    if (!needs.length) return null;
    return this.acceptDonations({ enabled: true, reagents: needs, drop_for_space: [], _default: true });
  }

  /** A desk, a chalice holder or a posted room caster: worth a giver's short walk (m59-sharing.mjs). */
  isServicePost() {
    if (this.chaliceCfg || this.policy.roomEnchant) return true;
    const d = this.policy.acceptDonations;
    return !!d && d.enabled !== false && this.mode !== 'farm';
  }

  // HAND SPARE REAGENTS TO WHOEVER NEARBY HAS RUN OUT. On by default; `shareSpare: false` turns it off.
  // Spare is what this keeper would sell: above its own floor and its own needs, and not on its
  // sale-protected list. The decision is planGift (m59-sharing.mjs); this half claims, walks, offers
  // and counts what actually left the pack. Returns true when it walked or traded this pass.
  async shareSpareReagents() {
    const cfg = normalizeShare(this.policy.shareSpare);
    if (!cfg.enabled) return false;
    const now = Date.now();
    if (now - (this._shareAt ?? 0) < cfg.every_ms) return false;
    this._shareAt = now;
    const c = this.s?.client;
    if (!c || !this.running || this.inert || c.trade) return false;
    if (this.facultyHeld('economy')) return false;           // a bot holds trading
    const v = c.vitals?.();
    if (!(v?.health?.max > 0) || v.health.value / v.health.max < 0.8) return false;
    if ((this.frozenUntil && now < this.frozenUntil) || this.threat?.()?.landing > 0) return false;
    const here = this.s.world?.room?.num;
    if (here == null) return false;
    const walkOk = cfg.walk_for !== 'none' && cfg.radius > 0 && !this.facultyHeld('movement');
    const rooms = walkOk ? this.deliveryNeighbourhood(here, { radius_rooms: cfg.radius }) : new Map([[Number(here), 0]]);
    const me = this.name ?? this.s.name;
    const demands = skills.interest.demandsNear(rooms, { except: me, farmingOnly: false, maxAgeMs: 120_000 });
    if (!demands.length) return false;
    const kinds = [...new Set(demands.flatMap(d => Object.keys(d.needs)))];
    const have = Object.fromEntries(kinds.map(k => [k, this.countOfKind(k)]));
    const keep = Object.fromEntries(kinds.map(k => [k, this.ownFloorFor(k) + (this._needsNow?.get?.(k) ?? 0)]));
    this._shareBackoff ??= new Map();
    const { gift } = planGift({ demands, have, keep, protectedNames: this.saleProtectedNames(), here,
      cfg: walkOk ? cfg : { ...cfg, walk_for: 'none' }, backoff: this._shareBackoff, now });
    if (!gift) return false;
    const claimed = Object.keys(gift.give).filter(k => claimGift(me, gift.needer, k));
    if (!claimed.length) return false;
    const backoff = (why) => { this._shareBackoff.set(gift.needer, Date.now() + cfg.backoff_ms);
      this.note('spare reagents not delivered', { to: gift.character, room: gift.room, why }); };
    try {
      if (gift.room !== here) {
        this.doing = 'travelling';
        const walked = await this.travel(gift.room, { origin: keeperOrigin('share_spare'), maxHops: cfg.radius })
          .catch(error => ({ arrived: false, reason: error.message }));
        if (!walked?.arrived) { backoff(walked?.reason ?? 'the walk did not arrive'); return true; }
      }
      const wanted = Object.fromEntries(claimed.map(k => [k, gift.give[k]]));
      const r = await this.giveFarmReagents({ character: gift.character }, wanted)
        .catch(error => ({ gave: {}, why: error.message }));
      if (!Object.keys(r?.gave ?? {}).length) { backoff(r?.why ?? 'nothing left the pack'); return true; }
      this.tally.gifts_given = (this.tally.gifts_given || 0) + 1;
      this.note('gave spare reagents to an ally', { to: gift.character, room: gift.room, gave: r.gave,
        service: gift.service, why: 'they ran short and this pack held them beyond its own needs; '
          + 'a reagent handed to a crewmate is not bought back at the spread' });
      try { this.ledgerEvent('gift', { to: gift.needer, character: gift.character, gave: r.gave,
        room: this.s.world?.room?.num ?? null, walked: gift.room !== here }); } catch {}
      this.progress(`gave ${Object.entries(r.gave).map(([k, n]) => n + ' ' + k).join(', ')} to ${gift.character}`);
      return true;
    } finally {
      for (const k of claimed) releaseGift(me, gift.needer, k);
    }
  }

  // BUFF WHOEVER ELSE IS STANDING HERE. A caster's second job.
  //
  // Same shape as medic() above and for the same reason: a character with a spell and an
  // ally in the room has a move that helps the ally AND trains the spell, and casting is
  // the only way a spell ability moves at all.
  //
  // What these two are actually worth, which is not obvious from their names:
  //
  //   super strength  AddMight(spellPower/5 + 1) for 300 + 6*power seconds
  //                   (persench/strength.kod:67-84). Might is BRAWLING'S REQUISITE STAT,
  //                   read live (brawling.kod:47-50), and the requisite stat enters skill
  //                   improvement twice — `increase_chance = 60 + stat` and the soft cap at
  //                   `2*stat - 1`, above which the chance is divided by five
  //                   (skill.kod:395-439). On a might-25 character a mature +11 lifts the
  //                   base chance 85 -> 96 and moves the soft cap 49 -> 71. That is the
  //                   difference between a bare-handed grind that arrives and one that does
  //                   not, and it is why this is worth a keeper pass.
  //   bless           +spellPower on the hit roll (persench/bless.kod:105-113). More landed
  //                   swings is more improvement rolls, because nothing improves until the
  //                   75-swing counter pays out (player.kod:4536-4537).
  //
  // Deliberately NOT enchant weapon, which is the third of the Kraanan level-2 set: it
  // takes a `&weapon` target rather than a `&User` (enchwp.kod:82-110), so it cannot buff
  // an ally in place — the weapon has to change hands first. A different errand entirely.
  //
  // ORDER IS SUPER STRENGTH FIRST because its duration is an order of magnitude longer
  // (300 + 6*power against bless's 40 + 6*power, both then halved by a Random), so it is
  // the one that stays up between casts rather than the one that needs chasing.
  static BUFFS = [
    { name: 'super strength', mana: 10, base: 300,
      reagents: [['mushroom', 2], ['orc tooth', 1]] },
    { name: 'bless', mana: 6, base: 40,
      reagents: [['mushroom', 2], ['sapphire', 2]] },
  ];

  /**
   * ROOM ENCHANTMENTS ARE A DIFFERENT ANIMAL FROM THE BUFFS ABOVE, and conflating the two is
   * the mistake this table exists to prevent.
   *
   *   A BUFF IS CAST AT A PERSON.  `c.cast(spell.id, [target.id])`, one recipient, and
   *                               `buffAllies` tracks who is still inside the window.
   *   AN ENCHANTMENT IS CAST AT THE ROOM.  `c.cast(spell.id, [])` with NO target at all --
   *                               forceslt.kod:94 calls `RoomStartEnchantment` on oRoom --
   *                               and it covers everyone standing there, including people
   *                               who walk in afterwards.
   *
   * Pointing `buffAllies` at one would send a targeted cast for an untargeted spell, which
   * is the shape of the bug that made every keeper-proxied buff land on the caster.
   *
   * DURATION DOES NOT RANDOMISE HERE, unlike the personal buffs. forceslt.kod:160 is
   * `6 * (power/3 + 1)` seconds handed straight to RoomStartEnchantment, with no
   * `Random(d/2, d)` wrapper -- so the full duration is promised and the recast timer does
   * not need halving. That is why `holdMs` below is not divided by two and `buffFloorMs` is.
   *
   * Reagents are the operator's, out of the caster's own pack, and the pairing matters:
   * 2 elderberry AND 1 emerald per cast (forceslt.kod:57-58). A caster holding 32 emeralds
   * and 24 elderberries gets TWELVE casts, not thirty-two -- the elderberries bind first,
   * which is the opposite of what the gem count suggests, so it is worth saying out loud
   * when the supply runs down.
   */
  static ROOM_ENCHANTS = [
    { name: 'forces of light', mana: 15,
      reagents: [['elderberry', 2], ['emerald', 1]],
      // forceslt.kod:160. Power is about half the ability percent (spell.kod:2066).
      durationMs: (power) => 6 * (Math.floor(Math.max(0, power) / 3) + 1) * 1000 },
  ];

  /**
   * The GUARANTEED remaining life of a cast, in ms — `Random(d/2, d)` means only d/2 is
   * promised, so that is what a recast timer may assume. Spell power is about half the
   * skill percent (spell.kod:2066), which is the only input we can read locally.
   */
  buffFloorMs(buff, ability) {
    const power = Math.max(0, Math.floor(Number(ability || 0) / 2));
    return ((buff.base + 6 * power) * 1000) / 2;
  }

  /**
   * How many of a named reagent are in the pack. Substring, because the server names vary.
   *
   * NOT `reagentCount` — that name is taken, by the no-argument create-food version above
   * that answers `{elderberry, herbs}`. A second definition of it would have shadowed the
   * first and handed every create-food check a number where it expected an object.
   * m59-shadowed-method-test.mjs caught exactly that, which is what it is for.
   */
  reagentOnHand(name) {
    const c = this.s?.client;
    const want = String(name).toLowerCase();
    let n = 0;
    for (const o of (c?.inventory || [])) {
      const nm = String(c.rsc.get(o.nameRsc) || '').toLowerCase();
      if (nm.includes(want)) n += Number(o.amount ?? 1) || 1;
    }
    return n;
  }

  /**
   * KEEP A ROOM ENCHANTMENT STANDING, for as long as the reagents last.
   *
   * The job is one sentence: stand still, and recast when it lapses. `forces of light` makes
   * everyone in the room miss less, which is what feeds the 75-swing improvement counter, so
   * one posted caster raises the earning rate of every farmer standing with it.
   *
   * THREE THINGS THIS DELIBERATELY DOES NOT DO.
   *
   *   IT DOES NOT MOVE. No target to approach and no reason to leave; the caller posts the
   *   character on a safe square and the whole value is that it stays there. Nothing here
   *   calls a walker.
   *
   *   IT DOES NOT NEED AN AUDIENCE. `buffAllies` returns early when nobody else is in the
   *   room, because a personal buff needs a recipient. A room enchantment does not -- it
   *   covers whoever walks in next, and a caster that stopped when the room emptied would
   *   drop the enchantment precisely as the farmers came back from a town trip.
   *
   *   IT DOES NOT GUESS THAT THE CAST LANDED. The room's own enchantment state is not on the
   *   wire in a form this can read, so the recast timer is driven from OUR last successful
   *   cast plus the kod duration. That is an assumption and it is a conservative one: a
   *   `margin_ms` shaves the window so a lapse is re-covered rather than left to the operator
   *   to notice. The failure it cannot see is a cast the server refused silently, which is
   *   why reagents and mana are both checked BEFORE sending rather than inferred after.
   */
  /**
   * START A SHOPPING TRIP BY RESCUING HOME INSTEAD OF WALKING IT.
   *
   * The operator's case, and it is a good one: the town trip is where this fleet loses
   * people — 1,330 of 2,859 postmortems died `travelling` — and half of that road is the
   * OUTBOUND leg. `rescue` costs one emerald and deletes it. Time saved is a bonus; the
   * danger halved is the point.
   *
   * ============================================================ WHEN IT IS LEGAL
   *
   * RESCUE DOES NOT GO WHERE YOU ASK. It has no destination argument at all, and rescue.kod
   * picks one in a fixed precedence that most callers never read:
   *
   *   1. THE GUILD HALL — if guilded, the guild HAS a hall, you are not already in it, and
   *      it is in the SAME REGION as you (rescue.kod:124-136).
   *   2. Ko'catan Inn — if you are in the Kocatan region, or in RID_ORC_CAVE5_EXT (:142).
   *   3. The Pool of Vigor — if you are in the orc caves (:153).
   *   4. ONLY THEN `AdminGoToSafety`, the home room (:163).
   *
   * So "rescue takes me home" is the DEFAULT BRANCH, not the rule, and three things above it
   * silently win. The guild one matters most here: this fleet is twenty-one characters in one
   * guild whose stated next goal is a hall. The day that hall exists, every rescue cast in its
   * region stops going home — and a shopping trip that teleports to the guild hall instead of
   * the market is a trip that quietly does nothing.
   *
   * THEREFORE THIS VERIFIES RATHER THAN PREDICTS. We cannot read guild-hall-in-region from
   * here, so the contract is: cast, wait, and CHECK THE ROOM. If it did not land in
   * `home_room`, say so plainly and let the caller walk. A wrong guess costs one emerald and
   * a log line; predicting confidently would cost a shopping trip nobody notices failing.
   *
   * AND RESCUE IS DELAYED, NOT INSTANT. It lands 15-25 seconds after the cast, the reply
   * carries no message, and `mana_spent` lies — so the only honest verdict is the room, read
   * afterwards. That is already written down in this repository and is why this polls.
   */
  async rescueToShop() {
    const cfg = this.policy.rescueShopping;
    if (!cfg?.enabled) return { ok: false, why: 'rescue shopping is not enabled' };
    const home = Number(cfg.home_room);
    if (!Number.isFinite(home))
      return { ok: false, why: 'rescue shopping needs home_room — the town the trip starts in' };

    const s = this.s, c = s.need();
    const here = s.world?.room?.num ?? c.room?.num ?? null;
    if (Number(here) === home) return { ok: true, already: true, room: home };

    const spell = (c.spells || [])
      .find(sp => String(c.rsc.get(sp.nameRsc) || '').toLowerCase() === 'rescue');
    if (!spell) return { ok: false, why: 'this character does not know rescue' };

    // THE RESERVE IS WHAT MAKES THIS POSSIBLE, so it is checked here and protected elsewhere.
    // One emerald is consumed per cast (rescue.kod:56). `reserve` is the number that must
    // SURVIVE the trip — sells and drops are what threaten it, which is `protect_items`'
    // job, not this one's. Here it only decides whether we can afford to go at all.
    const reserve = Number.isFinite(Number(cfg.reserve)) ? Math.max(0, Number(cfg.reserve)) : 0;
    const emeralds = this.reagentOnHand('emerald');
    if (emeralds < 1 + reserve)
      return { ok: false, why: 'no emerald to spend on the rescue',
               have: emeralds, needs: 1 + reserve,
               note: 'buy emeralds on the next trip that DOES walk — the reserve is what ' +
                     'keeps this option open, and it is the first thing a sell pass takes' };

    await withCastRite(s, { spell, targets: [], why: 'rescueToShop' }, () => s.pacer.submit('cast', () => c.cast(spell.id, []), 1050));

    // POLL THE ROOM. Not the reply, which says nothing useful, and not mana, which lies.
    const waitMs = Math.max(5000, Math.min(60_000, Number(cfg.wait_ms) || 30_000));
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, 2000));
      const at = s.world?.room?.num ?? c.room?.num ?? null;
      if (Number(at) === home) {
        this.tally.rescue_shopping = (this.tally.rescue_shopping || 0) + 1;
        this.note('rescued to the shopping town instead of walking',
          { room: home, emeralds_left: this.reagentOnHand('emerald') });
        return { ok: true, room: home, walked: false };
      }
      if (at != null && Number(at) !== Number(here)) {
        // It landed SOMEWHERE ELSE — the guild hall, Ko'catan, the Pool of Vigor. That is
        // rescue working correctly and this rule being inapplicable, so it is reported as a
        // fact about the world rather than as a failure.
        this.note('rescue did not go to the shopping town', { landed_in: at, wanted: home,
          why: 'rescue.kod prefers a guild hall in the same region, then Ko\'catan, then the ' +
               'Pool of Vigor, and only then the home room. One of those won.' });
        return { ok: false, landed_in: at, why: 'rescue landed somewhere that is not the shopping town' };
      }
    }
    return { ok: false, why: 'rescue did not land within ' + waitMs + 'ms — it is delayed 15-25s, ' +
                             'so this is either a slow land or a refused cast that said nothing' };
  }

  // THE POOL OF VIGOR, FOR ANYONE STANDING BESIDE IT. Operator, 2026-10-27: "It should also drink from the pool of vigor if
  // in that room". 2510 "A spring of vitality" (orccav5x.kod): standing in the pool (rows 42-46, cols 19-25) and pressing
  // GO is a drink -- SomethingTryGo -> UserDrink, said as "You drink from the life-giving waters" -- until the stomach is
  // full, which refuses SILENTLY, so a GO with no drink line ends it. Free vigor above the resting cap of 80. Only when the
  // body is quiet (health over half, nothing landing, no trade, nobody else holding the legs), at most every minute.
  async drinkAtPoolOfVigor() {
    const s = this.s, c = s?.client;
    if (!c || !this.running || this.inert || c.trade) return false;
    if ((s.world?.room?.num ?? c.room?.num) !== POOL_OF_VIGOR.room) return false;
    const now = Date.now();
    if (now - (this._poolDrinkAt ?? 0) < 60_000) return false;
    const v = c.vitals?.();
    const vigor = Number(v?.vigor?.value), cap = Math.min(200, Number(v?.vigor?.scale_max ?? v?.vigor?.max ?? 200) || 200);
    if (!Number.isFinite(vigor) || vigor >= cap) return false;
    if (!(v?.health?.max > 0) || v.health.value / v.health.max < 0.5) return false;
    if ((this.frozenUntil && now < this.frozenUntil) || this.threat?.()?.landing > 0) return false;
    if (this.facultyHeld?.('movement')) return false;
    this._poolDrinkAt = now;
    const me = () => ({ row: c.self?.row, col: c.self?.col });
    if (!inPool(me())) {
      await s.walkTo(POOL_OF_VIGOR.aim.col, POOL_OF_VIGOR.aim.row, { maxSteps: 60, hardCap: 80 }).catch(() => {});
      if (!inPool(me())) { this.note('could not stand in the pool of vigor', { at: me() }); return false; }
    }
    let drinks = 0;
    for (; drinks < 12; drinks++) {
      const since = c.evSeq;
      await s.pacer.submit('act', () => c.go()).catch(() => {});
      const w = await c.waitFor({ since, kinds: ['message'], timeoutMs: 2500,
        match: e => POOL_DRINK_SAID.test(String(e.text ?? '')) }).catch(() => ({ events: [] }));
      if (!(w.events ?? []).some(e => POOL_DRINK_SAID.test(String(e.text ?? '')))) break;   // stomach full
      const now2 = Number(c.vitals?.()?.vigor?.value);
      if (Number.isFinite(now2) && now2 >= cap) { drinks++; break; }
    }
    this.note('drank from the pool of vigor', { drinks, vigor_before: vigor, vigor_after: c.vitals?.()?.vigor?.value ?? null,
      why: 'free vigor while standing at the spring (operator: "drink from the pool of vigor if in that room")' });
    if (drinks) this.progress(`drank ${drinks} time(s) from the pool of vigor`);
    return drinks > 0;
  }

  // WOULD THE KO'CATAN GUARD STOP THIS JOURNEY? Null when the route does not cross the East Tower into the jungle (2013 ->
  // 2115), or the pack passes the guard's own rule (kocatwn.kod CanPass, the same rule jungleStashPlan plans with: at most
  // two weapons, one armour, shield, helmet and gauntlets, no alcohol, no nerudite). Otherwise { why, over }.
  kocatanGateRefusal(room) {
    try {
      const s = this.s, c = s?.client;
      const here = Number(s?.world?.room?.num);
      if (!(here >= 2000 && here <= 2099) || !(Number(room) >= 2100 && Number(room) <= 2699)) return null;
      const r = s.world?.route?.(Number(room));
      const crosses = (r?.hops ?? []).some(h => Number(h?.from) === 2013 && Number(h?.to) === 2115);
      if (!crosses) return null;
      const eq = c?.equipment?.();
      if (eq?.known !== true) return null;                        // unreadable is not a refusal: the guard will say
      const items = (c.inventory ?? []).map(o => ({ id: o.id, name: c.rsc?.get?.(o.nameRsc) || o.name || '', amount: o.amount }));
      const plan = jungleStashPlan(items, { equipped: eq.equipped ?? [], classify: jungleItemClassifier() });
      const over = plan.drop.filter(i => i.category && i.category !== 'unknown');
      if (!over.length) return null;
      return { why: `the guard at the East Tower refuses ${over.map(i => `${i.name} (${i.category})`).join(', ')}; sell or vault them at Ko'catan (2005) first`,
               over: over.map(i => ({ id: i.id, name: i.name, category: i.category, was_equipped: !!i.was_equipped })) };
    } catch { return null; }
  }

  // THE GATE AS A LOOT CAP, handed to the session's looter while on the island (m59-game setGateCap). The classifier is the
  // guard's own (jungleItemClassifier, from the kod class tree); a name it cannot place is not capped.
  gateLootCap() {
    if (!this._gateClassify) {
      const byItem = jungleItemClassifier(), memo = new Map();
      this._gateClassify = name => {
        const k = String(name ?? '').toLowerCase().trim();
        if (!memo.has(k)) { let cat = null; try { cat = byItem({ name: k }); } catch {} memo.set(k, cat === 'unknown' ? null : cat); }
        return memo.get(k);
      };
    }
    return { classify: this._gateClassify, limits: GATE_LIMITS };
  }

  // WHEN SELLING DID NOT CLEAR THE GATE, VAULT WHAT IT STILL REFUSES. The first refusal opens a sell trip at Ixla's smithy
  // (travel.mjs); a smith refuses what he cannot use (an unidentified piece, ore), so a pack can come back from the counter
  // still refused, and the farmer stood in town for ever (operator, 2026-10-27: "handle the armors"). The Ko'catan vault
  // (2005) is inside the town, so the walk never meets the gate; the excess goes in by exact id -- a name cannot tell the
  // spare chain armor from the worn one -- and is kept there, never dropped (unread magic is worth revealing).
  async kocatanGateVault(gate) {
    const ids = (gate?.over ?? []).filter(i => !i.was_equipped && i.id != null).map(i => Number(i.id));
    if (!ids.length) return { vaulted: false, why: 'nothing over the limit that is not worn' };
    if (Number(this.s.world?.room?.num) !== KOCATAN_VAULT) {
      const walked = await this.travel(KOCATAN_VAULT, { origin: keeperOrigin('gate_vault'), maxHops: 12 }).catch(e => ({ arrived: false, reason: e.message }));
      if (!walked?.arrived) return { vaulted: false, why: `could not reach the Ko'catan vault: ${walked?.reason ?? 'unknown'}` };
    }
    const c = this.s.client;
    const vaultman = [...(c?.room?.objects?.values?.() ?? [])].find(o => isVaultmanName(c.rsc.get(o.nameRsc)));
    if (!vaultman) return { vaulted: false, why: "the Ko'catan vaultman is not at his counter" };
    const r = await skills.depositInVault(this.s, { vaultman: vaultman.id, ids }).catch(e => ({ deposited: [], error: e.message }));
    this.note("vaulted what the Ko'catan gate refuses", { ids, deposited: r.deposited ?? [], refused: r.refused ?? [], error: r.error ?? null });
    return { vaulted: !!r.deposited?.length, result: r };
  }

  // SELL / VAULT / DROP UNTIL THE GATE PASSES (m59-kocatan-gate.mjs has the argument). Called as the last step of an island
  // town trip and on a gate refusal. Does nothing unless this character stands in Ko'catan town, its farm lies past the
  // East Tower, and the guard rule refuses the pack. Never touches a worn piece; never pays the corrupt captain.
  async kocatanGateClear({ trigger = 'town trip', room = null } = {}) {
    if (this.policy.kocatanGateClear === false) return { cleared: false, why: 'switched off (policy kocatanGateClear)' };
    const station = room != null ? Number(room) : gateStation(this.policy);
    if (station == null) return { cleared: false, why: 'no farm past the gate' };
    let gate = this.kocatanGateRefusal(station);
    if (!gate) return { cleared: true, why: 'the pack already passes the gate' };
    const s = this.s, c = s.need(), done = { sold: [], vaulted: [], dropped: [], left: [] };
    const live = id => (c.inventory ?? []).find(o => o.id === id);
    const plan = gateClearPlan(gate.over.map(i => ({ ...i, rarity: live(i.id)?.rarity ?? 0 })),
                               { protect: this.saleProtectedNames?.() ?? [] });
    // SELL plain loot at the smithy. One item at a time, price asked first: a refusal is a sentence, not an error.
    if (plan.sell.length) {
      const walked = Number(this.s.world?.room?.num) === KOCATAN_SMITHY ? { arrived: true }
        : await this.travel(KOCATAN_SMITHY, { origin: keeperOrigin('gate_clear'), maxHops: 12 }).catch(e => ({ arrived: false, reason: e.message }));
      const buyer = walked?.arrived
        ? [...(c.room?.objects?.values?.() ?? [])].find(o => skills.trustedBuyer(c.rsc.get(o.nameRsc))) : null;
      for (const item of buyer ? plan.sell : []) {
        const it = live(item.id);
        if (!it) continue;
        const offer = { ...it, amount: it.amount > 0 ? it.amount : 0 };
        const q = await s.sellOne(buyer.id, offer, false).catch(() => null);
        if (!(q?.offered_price > 0)) continue;
        const d = await s.sellOne(buyer.id, offer, true).catch(() => null);
        if (d?.sold) done.sold.push({ name: item.name, price: d.offered_price });
        await new Promise(r => setTimeout(r, 900));
      }
      if (done.sold.length) this.tradeFact?.({ earned: done.sold.reduce((n, x) => n + (x.price || 0), 0), sold: done.sold });
    }
    // VAULT what is worth keeping and whatever the smithy would not buy.
    gate = this.kocatanGateRefusal(station);
    if (gate) {
      const v = await this.kocatanGateVault(gate).catch(e => ({ vaulted: false, why: e.message }));
      done.vaulted = v?.result?.deposited ?? [];
    }
    // DROP what is still over the limit: refused by both (a conjured weapon), and not worn. Plain (rarity 0) only: the
    // vaultman also refuses a purse that cannot pay his fee, and unread magic is never thrown away for that -- it stays,
    // named in `left`, and the refusal ladder in travel() gets another go later.
    gate = this.kocatanGateRefusal(station);
    if (gate) {
      const worn = skills.equippedNow(c);
      for (const item of gate.over) {
        const it = live(item.id);
        if (!it || item.was_equipped || !worn || worn.has(it.id) || Number(it.rarity) > 0) { done.left.push(item.name); continue; }
        await s.pacer.submit('drop', () => c.drop([dropSpec(it)])).catch(() => {});
        done.dropped.push(item.name);
      }
      await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
      await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => null);
    }
    gate = this.kocatanGateRefusal(station);
    this.note("cleared the pack for the Ko'catan gate", { trigger, station, ...done, still_refused: gate?.why ?? null });
    return { cleared: !gate, ...done, still_refused: gate?.why ?? null };
  }
  // @end 1
}
