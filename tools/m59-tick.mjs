#!/usr/bin/env node
// m59-tick.mjs -- THE REAL-TIME CORE: sense, decide, actuate, at a fixed rate.
//
// This is the second driver model in this repository and it exists alongside the first,
// which is untouched. m59-autopilot.mjs and everything under it keep working exactly as
// they do; nothing here is on their path.
//
// ---------------------------------------------------------------------------
// WHAT WAS WRONG WITH THE FIRST ONE
// ---------------------------------------------------------------------------
//
// The keeper is a blocking RPC script wearing an agent's clothes:
//
//     loop {
//       ws   = evaluate(client)     // sense
//       plan = planFor(ws)          // decide
//       await stepPlan(...)         // act -- BLOCKS, seconds at a time
//     }
//
// Sensing happens only at the top of a pass and the act phase blocks the next one, so
// HOW OFTEN THE AGENT LOOKS AT THE WORLD IS DECIDED BY HOW LONG IT SPENT NOT LOOKING.
// Measured on this fleet: median pass 80ms, p99 16.6s, worst 207s, and 82% of deaths
// had the keeper blind at the moment of death.
//
// The tell that this is a habit rather than a necessity is that THE SENSOR DATA IS
// ALREADY FREE. The server pushes it, unasked:
//
//     BP_MOVE      our own position, written into room.objects, `predicted` cleared
//     BP_STAT      health, mana, vigor, ability levels
//     BP_USE_LIST  equipment, whole; BP_USE/BP_UNUSE one line per change
//
// `client.vitals()` and `client.self` are in-memory reads of pushed state. They cost
// nothing and block on nothing. `Session.perception()` and `Session.snapshot()` are
// likewise synchronous -- not even async. Yet the old model asks the server for things
// it has already been told: `confirmPosition()` sends roomContents() and blocks up to
// eight seconds to learn a position that arrived by push before the request went out.
//
// THE PROOF THAT THIS MODEL WORKS IS ALREADY IN THE TREE. m59-watchdog.mjs is a fixed
// 500ms timer that reads pushed state, blocks on nothing, and is the only thing still
// awake while a pass is stuck. It had to be invented as a RESCUE for the main loop --
// and you do not need a rescue for a loop that is already sampling at a fixed rate.
//
// ---------------------------------------------------------------------------
// THE FIVE RULES
// ---------------------------------------------------------------------------
//
// 1. A TICK NEVER AWAITS AN ACTUATION. Commands go into the paced outbound queue and
//    the tick returns. If a tick ever awaits a reply, this is the old model again with
//    a timer bolted on.
//
// 2. THE SENSOR NEVER SENDS. Reading the world is free by construction. Anything that
//    needs a request (a shop list, a fresh inventory) is a COMMAND whose answer arrives
//    later as pushed state and is read by a later tick -- never waited for.
//
// 3. EFFECTS ARE OBSERVED, NOT RETURNED. The actuator reports what it SENT. Whether it
//    worked is answered by the next tick reading pushed state. This is the whole of the
//    "no error has never meant success" rule, made structural instead of remembered:
//    there is no return value to misread, because there is no return value.
//
// 4. THE TICK RATE IS FIXED AND INDEPENDENT OF THE SERVER. Latency changes how long a
//    command takes to land. It must not change how often we look.
//
// 5. A SLOW DECIDE SKIPS, IT DOES NOT QUEUE. If deciding overruns the interval the tick
//    is dropped rather than run late, because a backlog of stale decisions is worse
//    than a missed one -- the world has moved and the decision was made against a world
//    that is gone.
//
// ---------------------------------------------------------------------------
// WHAT WE ACCEPT, EXPLICITLY
// ---------------------------------------------------------------------------
//
// ONE TICK OF STALENESS. The old model blocked to confirm a position before validating
// the next step against local collision geometry. Here the validator reads the latest
// PUSHED position, which may be one tick old. That is a deliberate trade and the server
// is the reason it is safe: it is the collision authority, it silently refuses an
// illegal move, and a refusal costs a tick rather than a character.

import { escapeGroundEffect } from './m59-combat-mode.mjs';
import { effectsAt } from './m59-ground-effects.mjs';
import { withBodyCommand, bodyAuthority } from './m59-body-command.mjs';

const DEFAULT_HZ = 10;
// LIVENESS: the keepalive sends an inventory request every 20s and the server
// replies. A live in-game session therefore receives a byte from the server at
// least every 20s (and far more often in a busy room). If nothing arrives for
// this long while we still believe we are in game, the connection is stale —
// a "ghost" (the client replays its last copy of the world while the server has
// moved on or dropped us). 45s = more than two missed keepalive replies. Shorter
// risks a false positive on a quiet room; longer leaves the ghost running long
// enough to swing at phantoms, as happened to JayB in the Mausoleum.
const LIVENESS_STALE_MS = 45_000;
// FACE coalescing tolerance (degrees). The combat controller re-issues face() every tick
// to keep the weapon on target; we only send a NEW face when the heading changes by more
// than this. Small enough to track a turning target, large enough to suppress the per-tick
// re-issue that pushed us over the server's 5-packet/s throttle. See docs/packet-throttle.md.
const FACE_EPS = 5;

// ---------------------------------------------------------------------------
// SENSOR -- free, synchronous, sends nothing
// ---------------------------------------------------------------------------
export class Sensor {
  constructor(session) { this.session = session; this.lastAt = 0; }

  // ONE FRAME OF THE WORLD, read from state the server already pushed.
  //
  // Deliberately built from `snapshot()` and `perception()` and NOT from `view()`:
  // view() runs A* for every object and exit, which is a tactical query and not a
  // sensor read. A sensor that got slower as the room got busier would put us back
  // where we started.
  read() {
    const s = this.session, c = s?.client;
    const at = Date.now();
    // HOW LONG SINCE WE LAST LOOKED, in wall clock. NOT for integrating anything -- the
    // server owns position and pushes it, and keeping our own dead-reckoned copy would
    // be a second, wrong world. It is here so a decider can tell a healthy cadence from
    // a degraded one: a frame that arrives 2s after the last means we were blind for 2s,
    // and some decisions (engaging, committing to a walk) deserve to know that.
    const dt = this.lastAt ? at - this.lastAt : null;
    this.lastAt = at;
    if (!c || s.live !== true || c.state !== 'game')
      return { in_game: false, at, dt_ms: dt };
    const me = c.self;
    return {
      at,
      dt_ms: dt,
      in_game: true,
      agent: s.name ?? null,
      character: c.me?.name ?? null,
      selfId: c.selfId ?? null,
      // THE NAME IS CARRIED BECAUSE THE NUMBER LIES. A live room id can collide with
      // an unrelated map number -- JayB stood in "Raza" reporting id 2013, which is a
      // real map room called "The East Tower" -- so anything routing off the raw number
      // plans from the wrong room and says nothing. The name is the server's own word
      // and is what resolves it. See resolveRoomNum in m59-route.mjs.
      room: { id: c.room?.id ?? null, num: c.room?.num ?? null,
              name: c.roomNameRsc ? (c.rsc?.get?.(c.roomNameRsc) ?? null) : (c.room?.name ?? null) },
      // The position the SERVER last told us, and whether it is our own guess.
      // `predicted` is cleared by the BP_MOVE handler, so this distinguishes "the
      // server said so" from "we think so", which a decider is entitled to know.
      position: me ? { col: me.col, row: me.row, x: me.x, y: me.y,
                       predicted: me.predicted === true } : null,
      vitals: c.vitals?.() ?? null,
      objects: c.room?.objects ?? null,
      inventory: c.inventory ?? null,
      equipment: c.equipment?.() ?? null,
      evSeq: c.evSeq ?? 0,
    };
  }
}

// ---------------------------------------------------------------------------
// ACTUATOR -- fire and forget, paced, never awaited by a tick
// ---------------------------------------------------------------------------
//
// Every method here returns IMMEDIATELY. The Pacer is already an independent queue --
// `submit()` returns a promise and pumps on its own -- so the change is simply that
// nobody awaits it. What each call returns is a record of what was SENT.
export class Actuator {
  constructor(session) {
    this.session = session;
    this.sent = [];            // a small ring, for the record and for tests
    this.walking = null;       // the one outstanding walk, if any
    this.maxSent = 64;
  }

  get depth() { return this.session?.pacer?.depth ?? 0; }

  // The one place a command reaches the wire. `kind` feeds the Pacer's per-kind
  // spacing, which is how the door settle and the move interval are honoured.
  _send(kind, fn, minGapMs = 0) {
    const rec = { kind, at: Date.now(), ok: null };
    this.sent.push(rec);
    if (this.sent.length > this.maxSent) this.sent.shift();
    try {
      const p = this.session.pacer.submit(kind, fn, minGapMs);
      // NOT AWAITED. The catch is attached so a refusal cannot become an unhandled
      // rejection and take the process down -- it is bookkeeping, not a result.
      Promise.resolve(p).then(() => { rec.ok = true; }, (e) => { rec.ok = false; rec.why = e?.message; });
    } catch (e) { rec.ok = false; rec.why = e?.message; }
    return rec;
  }

  // -- movement.
  //
  // Both movement entry points take 1-based KOD squares in public (col,row) order.
  //
  // `step` is a RAW square request: it goes to the wire as-is, and the server is the
  // collision authority. Right for a short hop you have already reasoned about.
  step(col, row, { minGapMs = 250 } = {}) {
    const c = this.session.client;
    return this._send('move', () => c.moveToSquare(col, row), minGapMs);
  }

  // `walk` is the COLLISION-AWARE MOVER, fired and not awaited.
  //
  // Session.walkTo/stepFine already know how to get past an obstacle -- "WHEN BLOCKED,
  // SLIDE: a locally clipped step usually means the straight line touched rock, not that
  // the way is shut, and fanning the heading out to either side is what hugging the wall
  // actually is". Reimplementing that as `me.col + sign(target.col - me.col)` is a
  // BEELINE, and a beeline walks into the fence and stands there: watched live, JayB
  // aiming at a staging square 16 steps away, refused every time, never moving.
  //
  // So the pathing is not rewritten -- it is reused, without being waited for.
  //
  // ONE OUTSTANDING MOVE AT A TIME. walkTo is a long operation (it may confirm position,
  // which is bounded at 8s), so issuing a fresh one every tick would stack dozens of
  // overlapping walks fighting over the same body. While one is in flight this reports
  // `sent: false, why: 'a move is already in flight'` -- an honest refusal the caller
  // can see, not a silent drop.
  walk(col, row, { maxSteps = 1 } = {}) {
    const rec = { kind: 'walk', at: Date.now(), ok: null, to: { col, row } };
    if (this.walking) { rec.ok = false; rec.why = 'a move is already in flight'; return rec; }
    if (typeof this.session.walkTo !== 'function') {
      rec.ok = false; rec.why = 'no walker on this session'; return rec;
    }
    this.sent.push(rec);
    if (this.sent.length > this.maxSent) this.sent.shift();
    this.walking = rec;
    Promise.resolve(this.session.walkTo(col, row, { maxSteps }))
      .then(r => { rec.ok = r?.arrived !== false; rec.result = r; },
            e => { rec.ok = false; rec.why = e?.message; })
      .finally(() => { this.walking = null; });
    return rec;
  }
  face(degrees) {
    const c = this.session.client;
    // FACE COALESCING (the packet-throttle fix, docs/packet-throttle.md). The combat
    // controller calls face() every tick (10Hz) to keep the weapon on target. Re-submitting
    // an unchanged heading 10x/second is pure production noise that pushed us over the
    // server's 5/s throttle. We only send a face when it actually changes the heading by
    // more than FACE_EPS — the first face, or a real turn.
    const norm = d => ((d % 360) + 360) % 360;
    if (this._lastFace != null) {
      const a = norm(this._lastFace), b = norm(degrees);
      const diff = Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
      if (diff <= FACE_EPS) return { kind: 'face', at: Date.now(), ok: true, coalesced: true };
    }
    this._lastFace = degrees;
    // Combat-facing lock (docs/packet-throttle.md). When we face a target to swing, the
    // session's turn-before-move in walkTo must NOT re-face us to the movement heading —
    // that was overriding the combat facing and making the character oscillate between
    // "face the mummy" (180°) and "face the walk direction" (270°), so every swing
    // whiffed (the server rejects a melee hit on a target behind the facing line).
    // Record the facing so walkTo's turn-before-move skips its re-face for a short while.
    if (this.session && this.session.client) {
      this.session.client._combatFacing = { deg: degrees, at: Date.now() };
    }
    // BYPASS THE PACER for combat faces. The face goes out directly so it doesn't
    // queue behind move/turn packets. The coalescing above (FACE_EPS) already
    // suppresses most faces; the ones that get through are heading changes that
    // matter (target moved). Sending them directly keeps the swing+face pair
    // atomic and at the correct rate.
    try {
      bodyAuthority(this.session).guard();
      c.face(degrees);
      return { kind: 'face', at: Date.now(), ok: true };
    } catch (e) {
      return { kind: 'face', at: Date.now(), ok: false, why: e?.message };
    }
  }
  go() {
    const c = this.session.client;
    return this._send('move', () => c.go(), 0);
  }

  // -- combat
  swing(targetId) {
    const c = this.session.client;
    // BYPASS THE PACER. The pacer's async pump loop interacts badly with the
    // 10hz tick loop: attacks get queued behind move/turn/read packets and
    // the effective swing rate drops to 1 per 3.5s. The CombatController
    // already paces swings at SWING_MS (1000ms) — that IS the rate limiter.
    // The server's 5/s throttle is safe: in combat the character produces
    // ~1 attack/s + occasional moves = well under 5/s. Direct send skips
    // the queue entirely; the packet goes out on the next socket flush.
    try {
      bodyAuthority(this.session).guard();
      c.attack(targetId);
      return { kind: 'attack', at: Date.now(), ok: true };
    } catch (e) {
      return { kind: 'attack', at: Date.now(), ok: false, why: e?.message };
    }
  }

  // -- posture. Sitting down IS the behaviour when recovering; it is not a stall.
  rest()  { const c = this.session.client; return this._send('rest',  () => c.rest()); }
  stand() { const c = this.session.client; return this._send('stand', () => c.stand()); }

  // -- objects
  use(id)        { const c = this.session.client; return this._send('use',  () => c.use(id)); }
  unuse(id)      { const c = this.session.client; return this._send('use',  () => c.unuse(id)); }
  pickUp(id)     { const c = this.session.client; return this._send('get',  () => c.get(id)); }
  drop(ids)      { const c = this.session.client; return this._send('drop', () => c.drop([].concat(ids))); }
  // Eating is APPLY onto ourselves -- `use` on a loaf does nothing at all (food.kod:56).
  eat(id)        { const c = this.session.client; return this._send('act',  () => c.apply(id, c.selfId)); }
  cast(spellId, targets = []) {
    const c = this.session.client;
    return this._send('cast', () => c.cast(spellId, targets), 1050);
  }

  // -- trade
  openShop(merchantId) { const c = this.session.client; return this._send('buy',   () => c.buy(merchantId)); }
  offer(id, items)     { const c = this.session.client; return this._send('trade', () => c.offer(id, items)); }
  acceptOffer()        { const c = this.session.client; return this._send('trade', () => c.acceptOffer()); }

  // -- REQUESTS ARE COMMANDS, NOT QUESTIONS.
  //
  // The reply arrives as pushed state and a later tick reads it. Nothing here waits.
  // This is rule 2, and it is the one that is easiest to break by accident: the moment
  // somebody awaits one of these to "just get the inventory", the tick blocks again.
  requestInventory() { const c = this.session.client; return this._send('read', () => c.requestInventory()); }
  requestRoom()      { const c = this.session.client; return this._send('read', () => c.roomContents()); }
}

// ---------------------------------------------------------------------------
// TICK LOOP
// ---------------------------------------------------------------------------
export class TickLoop {
  /**
   * @param {object}   session  the Session (connection, pacer, pushed state)
   * @param {function} decide   (frame, actuator, ctx) -> void. SYNCHRONOUS by contract:
   *                            it may inspect the frame and call the actuator, and it
   *                            must not await anything. Returning a promise is treated
   *                            as a programming error and reported once.
   * @param {number}   hz       ticks per second
   */
  constructor({ session, decide, hz = DEFAULT_HZ, onError = null, onSessionDead = null }) {
    if (!session) throw new Error('TickLoop: no session');
    if (typeof decide !== 'function') throw new Error('TickLoop: no decide()');
    this.session = session;
    this.decide = decide;
    this.intervalMs = Math.max(10, Math.round(1000 / hz));
    this.sensor = new Sensor(session);
    this.actuator = new Actuator(session);
    this.onError = onError;
    // Called when the liveness guard decides the session is a ghost (no server data
    // for LIVENESS_STALE_MS while in-game). The keeper uses this to force a rejoin.
    this.onSessionDead = onSessionDead;
    this.timer = null;
    this.busy = false;
    this._frozen = false;  // set true by the cast override to hold the character still
    this._livenessFlagged = false;
    this.stats = { ticks: 0, skipped: 0, errors: 0, awaited: 0,
                   longest_decide_ms: 0, lastError: null, stale_sessions: 0 };
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
    // A separate, un-unref'd watchdog: if the main tick timer stops firing (an
    // unref'd timer can be starved), this one detects the silence and restarts the
    // loop. This is the fix for the "0% CPU, no log" stall — the tick loop silently
    // stops and nothing notices. The watchdog is un-unref'd so it always runs.
    this._watchdog = setInterval(() => {
      const now = Date.now();
      if (now - (this._lastTickAt ?? now) > 5000) {
        console.error(`[tick-watchdog] tick loop silent for ${Math.round((now - this._lastTickAt)/1000)}s (busy=${this.busy}, longest=${this.stats.longest_decide_ms}ms) — forcing recovery`);
        this._lastTickAt = now;
        // A decide() that has been running for > 5s is hung (decides should be < 50ms).
        // The busy flag is stuck true, so every tick is skipped and the loop silently
        // dies. Force-reset it so the next tick can run. We cannot interrupt the hung
        // synchronous call, but we CAN ensure the NEXT tick proceeds once it returns
        // (or never does — in which case the liveness guard will exit the keeper).
        if (this.busy) {
          console.error(`[tick-watchdog] forcing busy=false (a decide was hung for ${Math.round((now - this._lastTickAt)/1000)}s)`);
          this.busy = false;
        }
        // The timer may have been cleared or starved. Restart it.
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        this.timer = setInterval(() => this.tick(), this.intervalMs);
        this.timer.unref?.();
        // Also fire one tick immediately to unstick.
        try { this.tick(); } catch (e) { console.error(`[tick-watchdog] immediate tick failed: ${e?.message}`); }
      }
    }, 3000);
    // NOT unref'd: the watchdog must always fire, even if the main tick timer is
    // starved. This is deliberate — it keeps the process alive while it is supposed
    // to be playing. (The HTTP server also keeps the process alive, but the watchdog
    // is the explicit guarantee.)
    return this;
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    if (this.session.combat?.active) { void this.session.combat.tick(); return; }
    // RULE 5: overrun SKIPS. A decide that is still running means the world has moved
    // under the one in progress; running a second against an older frame would build a
    // backlog of decisions about a world that is gone.
    if (this.busy) { this.stats.skipped++; return; }
    // FROZEN: a cast in progress (blink, zap, ...) needs concentration. Any move or
    // turn packet we send would interrupt the cast and make it fail. While _frozen is
    // set (by the /action cast override), the tick loop does NOTHING — no decide,
    // no actuate — so the character stands perfectly still until the cast resolves.
    if (this._frozen && !effectsAt(this.session.client, this.session.client?.self).length) { return; }
    this.busy = true;
    const t0 = Date.now();
    // DIAGNOSTIC: a heartbeat so a silent stall is visible. A tick loop that has stopped
    // producing decide() calls (0% CPU, no log) is otherwise indistinguishable from a
    // healthy idle. Log the stats every 50 ticks and on the first 10s of silence.
    const now = Date.now();
    this._lastTickAt = now;
    if (this.stats.ticks > 0 && now - (this._lastBeatAt ?? 0) > 10000) {
      this._lastBeatAt = now;
      const staleRx = this.session.client?.lastRxAt ? Math.round((now - this.session.client.lastRxAt)/1000) : -1;
      console.error(`[tick-alive] ticks=${this.stats.ticks} skipped=${this.stats.skipped} errors=${this.stats.errors} longest=${this.stats.longest_decide_ms}ms staleRx=${staleRx}s busy=${this.busy}`);
    }
    try {
      const frame = this.sensor.read();
      if (!frame.in_game) return;
      // LIVENESS GUARD: a live in-game session receives server data continuously
      // (the keepalive reply alone guarantees one per 20s). If no byte has
      // arrived for LIVENESS_STALE_MS, the session is a ghost — the client is
      // replaying stale in-memory state while the server has moved on or dropped
      // us. The character still reports "in game" and a frozen position, which is
      // exactly the signature JayB showed: 0% CPU, "fighting mummies" at a fixed
      // (col,row,degrees), invisible to anyone actually on the server. Flag it
      // once and ask the keeper to rejoin.
      const c = this.session.client;
      const lastRx = c?.lastRxAt ?? 0;
      // DIAGNOSTIC: log the guard's decision every 5s so a non-firing guard is visible.
      if (now - (this._lastGuardLogAt ?? 0) > 5000) {
        this._lastGuardLogAt = now;
        console.error(`[liveness-guard] lastRx=${lastRx} age=${lastRx?Math.round((now-lastRx)/1000):'-1'}s threshold=${LIVENESS_STALE_MS/1000}s inGame=${frame.in_game} wouldFire=${lastRx > 0 && now - lastRx > LIVENESS_STALE_MS}`);
      }
      if (lastRx > 0 && Date.now() - lastRx > LIVENESS_STALE_MS) {
        if (!this._livenessFlagged) {
          this._livenessFlagged = true;
          this.stats.stale_sessions++;
          const staleMs = Date.now() - lastRx;
          try {
            this.onError?.(new Error(`session stale: no server data for ${Math.round(staleMs/1000)}s while in game`));
            this.onSessionDead?.({ staleMs });
          } catch { /* the reporter is not allowed to matter */ }
        }
        return;  // do not decide against a dead session
      }
      this._livenessFlagged = false;
      if (effectsAt(c, c.self).length) {
        if (!this._escapingGround) this._escapingGround = withBodyCommand(this.session,
          () => escapeGroundEffect(this.session)).catch(e => { this.stats.lastError = e.message; })
          .finally(() => { this._escapingGround = null; });
        return;
      }
      // POSITION RECOVERY: the character is in-game but has no position (the room
      // contents were read but our own object isn't in them, or a room change dropped
      // us, or the client lost its self reference entirely after a transition). Without
      // a position the decider can do nothing — it idles in a "hunt / exhausted 5 nodes"
      // loop. Re-request the room contents (throttled) to re-establish the position. The
      // server pushes them back and c.self / c.selfId come back.
      //
      // The gate was `frame.selfId != null && !frame.position` — it only recovered the
      // "have the id, lost the position" case. A character can lose BOTH the id and the
      // position (a room transition that resets the self reference), and then this guard
      // never fires and the character sits positionless for ever, flapping between
      // "equip" and "travel" doing nothing (JayB in Raza, 2026). Recover whenever we are
      // in-game with a room but no position, whether or not the self id survived.
      if (frame.in_game && frame.room && (frame.room.id != null || frame.room.num != null) && !frame.position) {
        const now = Date.now();
        if (!this._lastPosRecovery || now - this._lastPosRecovery > 3000) {
          this._lastPosRecovery = now;
          try {
            this.session.client.roomContents?.();
          } catch { /* best effort */ }
        }
      }
      const out = withBodyCommand(this.session, () => this.decide(frame, this.actuator, this));
      // RULE 1, ENFORCED RATHER THAN TRUSTED. A decide that returns a promise is doing
      // something asynchronous, which is the exact habit this model exists to remove.
      // It is reported and NOT awaited -- awaiting it here would quietly reintroduce
      // the blocking loop while every counter still said "tick".
      if (out && typeof out.then === 'function') {
        this.stats.awaited++;
        this.stats.lastError = 'decide() returned a promise; a tick must not await';
        Promise.resolve(out).catch(() => {});
      }
    } catch (e) {
      this.stats.errors++;
      this.stats.lastError = e?.message ?? String(e);
      // Log the first 3 errors so a crashing decide is visible in the keeper log.
      if (this.stats.errors <= 3) {
        console.error(`[tick-ERROR] #${this.stats.errors}: ${e?.message}\n${e?.stack?.split('\n').slice(0,4).join('\n')}`);
      }
      // A throwing decide must not kill the timer. That is how a guard dies silently.
      try { this.onError?.(e); } catch { /* the reporter is not allowed to matter */ }
    } finally {
      const ms = Date.now() - t0;
      if (ms > this.stats.longest_decide_ms) this.stats.longest_decide_ms = ms;
      if (ms > 2000) console.error(`[slow-tick] tick ${this.stats.ticks + 1} took ${ms}ms`);
      this.stats.ticks++;
      this.busy = false;
    }
  }
}
