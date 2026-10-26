// THE GUILD HALL: chests, the vault, the stockpile.
//
// PART OF THE KEEPER. These are methods of `Autopilot` (tools/m59-autopilot.mjs), moved here
// verbatim so the keeper reads as a set of faculties instead of one 33,000-line class. They are
// installed onto Autopilot.prototype by `installParts` (tools/autopilot/parts.mjs) right after
// the class is defined, so `this` is the keeper exactly as before. Do not import this file
// directly: import tools/m59-autopilot.mjs, which loads it. `autopilotSource()`
// (tools/autopilot/source.mjs) rebuilds the original single-file text for source-shape tests;
// the `@part` markers are what it splices on.
//
// 11 methods: hallPostTo, reachHallChests, recordHallRun, sayHallPassword, refreshChestCache,
//   refreshVaultCache, vaultRunIfPassing, withdrawFromStockpile, takeFromChest, hallWithdraw,
//   hallMove
import { guildPassage, hallPost } from '../m59-guild-passage.mjs';
import { SAID_NOTE, hallPassword, inFoyer } from '../m59-hallsecret.mjs';
import { norm } from '../m59-loadout.mjs';
import { keeperOrigin } from '../m59-move-origin.mjs';
import { affordances, dropSpec as dropSpecFor } from '../m59-parse.mjs';
import * as skills from '../m59-skills.mjs';
import { StockpileBook, canEnterHall, savingsOf, sourcePlan } from '../m59-stockpile.mjs';
import { BOOKMAKERS_HALL_ROOM, STOCKPILE_GET_REACH, STOCKPILE_WALK_WITHIN, StorageCache, chestKey } from '../m59-storage.mjs';
import { detailSettings, saveVaultSnapshot } from '../m59-strategy-stats.mjs';
import { BARLOQUE_VAULT, GUILD_CHEST_SECTION, TITHE_FLEET } from '../m59-autopilot.mjs';

export class HallPart {
  // @part 1

  /**
   * Get to where the chests can actually be seen: out of the foyer, password spoken, door
   * given time to open, room read back.
   *
   * Returns { ok, why, at, said, chests } and NEVER throws -- the caller records it.
   */
  /**
   * Get to where the chests can actually be seen, using the passage routine that was worked
   * out on a live fleet rather than a fresh guess.
   *
   * `guildPassage` (m59-guild-passage.mjs) knows the hall's sections and each door's exact
   * trigger square, waits on the server's own `sector-height` events rather than a guessed
   * delay -- a guild door animates, and a read taken mid-swing sees a shut door -- retries
   * three times per leg, and says the password only at the secret door's trigger. Section 4
   * is the chest side; the coop runtime asks for the same one.
   *
   * Returns { ok, why, chests, steps } and NEVER throws: the caller records it.
   */
  // THE VAULT BROKER'S POSTS: 'booth' (the window to the foyer), 'chests', 'inside'. Never through
  // the main door; see hallPost. Refuses outside the hall.
  async hallPostTo(where) {
    const roomNum = Number(this.s.world?.room?.num ?? NaN);
    if (roomNum !== BOOKMAKERS_HALL_ROOM)
      return { ok: false, why: `not in the hall (room ${roomNum}, want ${BOOKMAKERS_HALL_ROOM})` };
    const r = await hallPost(this, where, () => this.travelInterrupted?.() ?? false)
      .catch(e => ({ ok: false, why: e?.message ?? String(e) }));
    this.note('hall post', { where, ...r });
    return r;
  }

  async reachHallChests() {
    const s = this.s, c = s.need();
    const steps = [];
    try {
      await guildPassage(this, GUILD_CHEST_SECTION, () => false);
      steps.push({ step: 'guild_passage', ok: true, to_section: GUILD_CHEST_SECTION });
    } catch (e) {
      const why = e?.message ?? String(e);
      steps.push({ step: 'guild_passage', ok: false, why });
      return { ok: false, why, steps,
               at: { row: c.self?.row ?? null, col: c.self?.col ?? null } };
    }
    await s.pacer.submit('read', () => c.roomContents()).catch(() => {});
    await c.waitFor({ kinds: ['room-contents'], timeoutMs: 3000 }).catch(() => {});
    const chests = [...(c.room?.objects?.values?.() ?? [])]
      .filter(o => /chest/i.test(c.rsc.get(o.nameRsc) || '')).length;
    steps.push({ step: 'read_room', chests_visible: chests });
    return { ok: chests > 0, why: chests ? null : 'through the passage but no chest is visible',
             chests, steps, at: { row: c.self?.row ?? null, col: c.self?.col ?? null } };
  }

  /**
   * Write down what a guild-hall run actually did, on disk, either side of the deposit.
   *
   * ALWAYS, not only on success. The runs worth reading are the ones that moved nothing — a
   * door that did not open, and a `put` that completed its handshake and moved nothing, look
   * identical from a chest that simply never changed. Until this existed that was the only
   * view anyone had, which is why three chests sat at 3394/4570/305 bulk for days with nobody
   * able to say why. `this.note()` goes to an in-memory buffer a keeper restart empties.
   */
  recordHallRun({ before, after, want, contributed, done, hall }) {
    try {
      const moved = {};
      for (const item of new Set([...Object.keys(before?.pack ?? {}), ...Object.keys(after?.pack ?? {})])) {
        const d = (before?.pack?.[item] ?? 0) - (after?.pack?.[item] ?? 0);
        if (d) moved[item] = d;
      }
      const chestDelta = {};
      for (const slot of new Set([...Object.keys(before?.chests ?? {}), ...Object.keys(after?.chests ?? {})])) {
        const b = before?.chests?.[slot] ?? { rows: 0, bulk: 0 };
        const a = after?.chests?.[slot] ?? { rows: 0, bulk: 0 };
        if (a.bulk !== b.bulk || a.rows !== b.rows)
          chestDelta[slot] = { bulk: a.bulk - b.bulk, rows: a.rows - b.rows, now: a };
      }
      this.detailEvent('guild_chest', 'run', {
        ended_at: Date.now(), planned: want?.total ?? 0, contributed,
        // THE TWO HALVES THE OPERATOR ASKED FOR, verbatim rather than summarised.
        pack_before: before?.pack ?? null, pack_after: after?.pack ?? null,
        chests_before: before?.chests ?? null, chests_after: after?.chests ?? null,
        pack_delta: moved, chest_delta: chestDelta,
        // AND WHY, which was missing entirely: the passage, each leg with its own verdict.
        hall: hall ?? null,
        per_chest: done,
        // A run that planned something and moved nothing is the interesting one; say so in a
        // field rather than making every reader derive it. That is the exact signature a
        // bare-id put on a stack produces.
        moved_nothing: (want?.total ?? 0) > 0 && !contributed,
      });
    } catch { /* a record must never cost the deposit it is describing */ }
  }

  async sayHallPassword() {
    const word = hallPassword(TITHE_FLEET);
    if (!word) {
      this.note('no hall password recorded for this fleet', {
        why: 'the chests sit behind a secret door that only opens for a spoken password, and ' +
             'none is recorded. Record it with: node tools/m59-hallsecret.mjs set ' +
             '--fleet <name> --password <word>. Until then every chest read finds nothing ' +
             'and looks exactly like an empty hall.' });
      return { ok: false, why: 'no password recorded' };
    }
    const c = this.s.need();
    const me = this.s?.client?.self ?? null;
    const row = me?.row ?? me?.y ?? null, col = me?.col ?? me?.x ?? null;
    const foyer = inFoyer(row, col);
    if (foyer === true) {
      // REFUSED IN SILENCE, and doubly so: the foyer is also the hall's silence area, so the
      // say would not even be heard by anyone inside. Better to say why than to speak the
      // password into a room where it can be overheard and cannot work.
      this.note('standing in the guild hall foyer, where the password does nothing', {
        at: `r${row}c${col}`,
        why: 'InFoyer (ghall.kod:896) refuses the door for anyone in the foyer box and muffles ' +
             'speech across it — move into the hall proper before saying it' });
      return { ok: false, why: 'in the foyer', at: { row, col } };
    }
    // `foyer === null` means the position is unreadable. Saying it anyway is the right call:
    // the cost of a wasted say is one packet, and refusing on an unknown position would strand
    // the errand every time a snapshot arrived thin.
    await this.s.pacer.submit('say', () => c.say(word, 1)).catch(() => {});
    this.note(SAID_NOTE, {
      at: row == null ? null : `r${row}c${col}`,
      position_known: foyer !== null,
      why: 'opens the secret door for FIVE SECONDS (guildh14.kod:43) — whatever needs to be ' +
           'through the wall has to be beside it already' });
    return { ok: true, said_at: Date.now() };
  }

  // READ THE CHEST BACK AND WRITE IT DOWN, because nothing else ever will.
  //
  // `StorageCache.writeChest` had ONE caller in the repository: the broker's `container`
  // tool, invoked by hand with an explicit slot. So every automated deposit and withdrawal
  // left the board showing a reading somebody took by hand at some point, over a timestamp
  // that makes it look like a current fact. The vault half has always done this properly --
  // `refreshVaultCache` runs straight after the deposit -- and the chests never got it.
  //
  // Chest contents are NOT pushed by the server. There is no event, no subscription and no
  // way to learn them except asking while standing there, which is exactly why the one
  // moment a character IS standing there is the moment that must not be wasted.
  //
  // Never allowed to break the errand. A cache is a convenience; the reagents are the job.
  async refreshChestCache(chest, slot, { store = null, why = null } = {}) {
    const c = this.s.need();
    try {
      const since = c.evSeq;
      await this.s.pacer.submit('read', () => c.contents(chest.id));
      const reply = await c.waitFor({ since, kinds: ['container', 'message'], timeoutMs: 5000 })
        .catch(() => ({ events: [] }));
      const box = (reply.events ?? []).find(e => e.kind === 'container' && e.id === chest.id)
               ?? (reply.events ?? []).find(e => e.kind === 'container');
      if (!box) {
        // A CONTAINER ANSWERS THIS AND ANYTHING ELSE SAYS WHY OUT LOUD. Recording an empty
        // list here would turn "it would not tell us" into "the chest is empty", which is
        // the single worst thing this cache could claim: the stockpile reads it to decide
        // whether to walk to a merchant.
        this.note('could not read a guild chest back after touching it', { slot,
          said: (reply.events ?? []).filter(e => e.text).map(e => String(e.text)).slice(0, 3),
          why: 'no contents came back — the cache keeps its previous reading rather than ' +
               'recording an empty one, because "it would not say" is not "it is empty"' });
        return null;
      }
      const items = (box.items ?? []).map(o => ({ id: o.id, name: o.name, amount: o.amount || 1 }));
      // FILED UNDER THE SQUARE WE JUST READ IT AT, never under a number decided elsewhere.
      (store ?? new StorageCache()).writeChest(chest.key ?? chestKey(chest), {
        object_id: chest.id, room: this.s.world?.room?.num ?? c.room?.id ?? null,
        items, by: c.me?.name ?? this.name ?? this.s.name });
      this.note('refreshed the guild chest cache', { slot, stacks: items.length, why });
      return items;
    } catch (error) {
      this.note('could not refresh the guild chest cache', { slot, why: error.message });
      return null;
    }
  }

  async refreshVaultCache(vaultman) {
    const settings = detailSettings(this.policy, 'vault_accumulation');
    const c = this.s.need();
    const since = c.evSeq;
    await this.s.pacer.submit('buy', () => c.buy(vaultman.id ?? vaultman));
    const response = await c.waitFor({ since, kinds: ['shop', 'message'], timeoutMs: 4000 })
      .catch(() => ({ events: [] }));
    const shop = response.events?.find(event => event.kind === 'shop');
    if (!shop) {
      this.detailEvent('vault_accumulation', 'snapshot-failed', {
        why: 'the vaultman did not open a buy list after the deposit',
        messages: response.events?.filter(event => event.text).map(event => event.text).slice(0, 4),
      });
      return null;
    }
    const snapshot = { at: Date.now(), vaultman: shop.seller ?? null,
      items: (shop.items ?? []).map(item => ({ name: item.name, amount: item.amount ?? 1,
        cost: item.cost ?? null })) };
    const who = c.me?.name;
    saveVaultSnapshot(who, snapshot);
    // AND INTO THE ONE STORE THE BOARDS AND TOOLS READ. These were two homes for the same
    // quantity — the keeper wrote strategy-stats/vault-latest/ and the economy board read
    // storage/vaults/ — so a fleet whose vaults were being cached every trip rendered a
    // page of "never read". Same reading, written once to each, rather than a second
    // measurement that can disagree with the first.
    try { new StorageCache().writeVault(who, snapshot.items, { at: snapshot.at }); }
    catch { /* the record is a convenience; never let it interrupt the errand */ }
    if (settings) this.detailEvent('vault_accumulation', 'snapshot', snapshot);
    return snapshot;
  }

  async vaultRunIfPassing() {
    const wanted = Array.isArray(this.policy.vaultItems)
      ? this.policy.vaultItems.map(String).filter(Boolean) : [];
    if (!wanted.length) return false;
    const c = this.s.client;
    if (!c || !(c.inventory || []).some(o => skills.itemIsProtected(c.rsc.get(o.nameRsc), wanted)))
      return false;
    if (Date.now() - (this.vaultTripAt ?? 0) < 300_000) return false;
    const route = this.s.world?.route?.(BARLOQUE_VAULT.room);
    if (!route?.found || route.hops.length > 4) return false;
    this.vaultTripAt = Date.now();
    this.doing = 'travelling';
    if (this.s.world?.room?.num !== BARLOQUE_VAULT.room) {
      const walked = await this.travel(BARLOQUE_VAULT.room, { origin: keeperOrigin('vault_run'),
        maxHops: Math.max(6, (route?.hops?.length ?? 2) + 3),
      }).catch(e => ({ arrived: false, reason: e.message }));
      if (!walked.arrived) {
        this.note('could not reach the Barloque vault', { protected: wanted,
          why: walked.reason || 'the short town route did not complete' });
        return true;
      }
    }
    const vaultman = [...c.room.objects.values()].find(o =>
      /obert cair|vaultman/i.test(c.rsc.get(o.nameRsc) || '') &&
      affordances(o.flags).includes('buy'));
    if (!vaultman) {
      this.note('the Barloque vaultman was not at his counter', { room: BARLOQUE_VAULT.room,
        protected: wanted, why: 'deposit packets are never aimed at an inferred NPC' });
      return true;
    }
    this.doing = 'trading';
    const result = await skills.depositInVault(this.s, { vaultman: vaultman.id, items: wanted })
      .catch(e => ({ deposited: [], error: e.message }));
    if (result.deposited?.length) this.tradeFact({ deposited: result.deposited });
    this.detailEvent('vault_accumulation', 'deposit', {
      deposited: result.deposited ?? [], refused: result.refused ?? [],
      messages: result.said ?? [], error: result.error ?? null,
    });
    if (result.deposited?.length) {
      this.tally.vaulted = (this.tally.vaulted || 0) +
        result.deposited.reduce((n, item) => n + item.amount, 0);
      this.note('stored protected items in the Barloque vault', {
        deposited: result.deposited, said: result.said,
        why: 'the town loop was already passing within four rooms of the vault' });
      this.progress('vaulted collection items');
    } else this.note('the vault accepted none of the protected items', {
      protected: wanted, refused: result.refused, said: result.said, why: result.error });
    await this.refreshVaultCache(vaultman).catch(error => this.note('could not refresh the vault cache', {
      why: error.message, after: result.deposited ?? [],
    }));
    return true;
  }

  // The reagent half, at the counter that actually stocks them. Runs after the food leg
  // because a character with nothing to eat now needs bread now; reagents are for the next
  // hour. Both are one trip and the walk between them is a single room.
  // TAKE WHAT THE FLEET ALREADY OWNS BEFORE BUYING MORE OF IT.
  //
  // This is the half the chests never had. The outbound side has worked for a while —
  // `guildKeepTest` marks an item the guild is short of as keep-not-sell and
  // `contributeGuildWants` deposits it — but nothing ever consulted a chest before walking to
  // the apothecary, so a character needing elderberry walked past three hundred of them and
  // bought more. Every unit moved chest -> pack instead of merchant -> pack saves the SPREAD:
  // the buy price avoided AND the sell price forgone, which is the number the 12,000-a-day
  // hall has to be paid for in.
  //
  // Returns what it managed to take, so the caller buys only the remainder.
  async withdrawFromStockpile(need = []) {
    if (!need.length) return { took: [], saved: 0 };
    const store = new StorageCache();
    const chests = store.allChests();
    const available = chests.some(ch => ch && !ch.never_opened);
    const plan = sourcePlan({ need, chests, available,
                              why: 'no chest has ever been opened, so what they hold is unknown' });
    if (!plan.fromChest.length) return { took: [], saved: 0, why: plan.why };

    // THE DOOR IS RANK, NOT MEMBERSHIP. CanEnter (ghall.kod:1039) admits members and allies at
    // rank >= SIR and refuses apprentices by name, so a character that has just been inducted
    // would walk to Barloque and be turned away with no message at all. Check before walking.
    const g = this.s.client?.guild ?? null;
    const door = canEnterHall({ guildId: g?.id ?? null, rank: g?.rank ?? null,
                                hallGuildId: g?.id ?? null });
    if (!door.ok) { this.note('cannot use the stockpile', { why: door.why }); return { took: [], saved: 0, why: `cannot use the stockpile: ${door.why}` }; }

    // A `const before = snapshot();` STOOD HERE from 5a487a5 (2026-09-17) until 2026-09-25, copied
    // from the deposit run -- where `snapshot` is a local of THAT method. Here it was undefined,
    // so every withdrawal that found something to take threw a ReferenceError before its first
    // step: the fleet's own elderberry/herb draws, standing-order funding and every restock for
    // Loial, for eight days. The value was never read. Found by running this against prod's
    // chest cache with travel stubbed out.
    this.doing = 'travelling';
    const trip = await this.travel(BOOKMAKERS_HALL_ROOM, { origin: keeperOrigin('stockpile_withdraw'), maxHops: 14 })
      .catch(error => ({ arrived: false, reason: error.message }));
    if (!trip.arrived) {
      this.note('could not reach the stockpile', { why: trip.reason || 'travel refused' });
      return { took: [], saved: 0, why: `could not reach the stockpile: ${trip.reason || 'travel refused'}` };
    }

    this.doing = 'trading';
    const s = this.s, c = s.need();
    // EVERY WAY OUT THAT TAKES NOTHING SAYS WHY. This returned `{ took: [] }` bare from six
    // places, and the chalice restock filed all of them as "the chests gave nothing": 203 of 234
    // cargo draws from 2026-10-01 to -04, the chests holding 1,255 orc teeth and 401 purple
    // mushrooms throughout, and not one row able to say which branch it was.
    const misses = [];
    // THE WALL COMES BEFORE THE CHESTS. Room contents list what is IN the room, so a chest
    // behind a shut secret door still appears here — which is exactly why this is not
    // optional and not conditional on "can I see a chest". The reachability, not the
    // visibility, is what the password buys.
    // THE FOYER IS WHERE THE PASSWORD DOES NOTHING, AND IT IS WHERE ARRIVALS LAND.
    //
    // `InFoyer` (ghall.kod:896-913) refuses the door for anyone inside the box and ALSO
    // muffles speech across it, so a character standing there is not merely failing to open
    // the door -- nobody in the hall proper can hear it at all. The Bookmaker's hall declares
    // that box as rows 2-3, cols 26-39 (guildh14.kod:145-148) and the chests are at rows
    // 18-20, so the whole of a deposit happens on the far side of a door that will not open
    // for the square you arrive on.
    //
    // `sayHallPassword` already DETECTED this and returned { ok:false, why:'in the foyer' }.
    // The caller then threw the result away with .catch(() => {}), read an empty room, found
    // no chests, and recorded a tidy "no chest stands on that square" for each one. Measured
    // 2026-09-17: three chests holding 3394/4570/305 bulk, unchanged for days, while the
    // planner wanted 45 orc teeth into the first of them on every town trip.
    //
    // So: step out of the box first, then speak, then WAIT -- a guild door is slower than an
    // ordinary one and the read that follows is what decides whether any chest exists.
    const hall = await this.reachHallChests().catch(e => ({ ok: false, why: e?.message ?? String(e) }));
    // THE OTHER TWO CHEST PATHS STOP HERE WHEN THE PASSAGE FAILED, and this one walked on to ask
    // chests on the far side of a shut door. Said, and given up, rather than read as empty chests.
    if (!hall.ok) {
      this.note('could not reach the hall chests', { why: hall.why, steps: hall.steps });
      return { took: [], saved: 0, why: `could not reach the hall chests: ${hall.why ?? 'the passage did not open'}` };
    }
    // EVERY CHEST IN THIS ROOM, EACH NAMED BY ITS OWN SQUARE. No mapping, no ordering and no
    // completeness requirement: the name is read off the object, so a chest seen at r18c6 is
    // r18c6 and a reading that shows two chests is a reading of two chests. An object id is
    // a handle the server recycles — 23% of stored ids named a different object three days
    // later — and nothing here uses one to address anything.
    const here = new Map();
    for (const o of c.room?.objects?.values?.() ?? []) {
      if (!/chest/i.test(c.rsc.get(o.nameRsc) || '')) continue;
      const key = chestKey(o);
      // A chest whose position did not arrive cannot be named, and an unnamed chest must not
      // be guessed at — that is the whole mis-filing hazard, in one branch.
      if (!key) { this.note('a chest here has no readable position', { id: o.id }); continue; }
      here.set(key, { id: o.id, row: o.row, col: o.col, key });
    }

    const book = new StockpileBook({ fleet: TITHE_FLEET });
    const took = [];
    let saved = 0;
    for (const want of plan.fromChest) {
      const target = here.get(String(want.slot)) ?? null;
      if (!target) {
        // THIS USED TO BE A BARE `continue` -- the one branch that said nothing at all. A
        // character walks to Barloque, finds no chest where the stockpile expected one, and
        // buys from the merchant anyway while three hundred elderberry sit a metre away.
        this.note('no chest stands on that square', { chest: want.slot,
          chests_in_room: [...here.keys()],
          why: 'the stockpile expected a chest at that square and this room has none there' });
        misses.push(`no chest at ${want.slot} (room has ${[...here.keys()].join(', ') || 'none'})`);
        continue;
      }

      // WITHIN SEVEN SQUARES, OR THE SERVER WILL NOT HAND IT OVER. UserGet (user.kod) refuses a
      // get whose item is more than 7 squares away, row distance plus column distance, and says
      // so only as `user_err_get_dist` spoken to the player -- nothing on the wire. A PUT has no
      // such check (storebox ReqNewHold), which is why a chalice rider landing at r7c4 deposited
      // its money into r18c2 and then took nothing out of the same chest: Animal, 2026-10-04,
      // 13 squares away. The armour and stash paths always walked within 5 first (`nearChest`);
      // this one never did, and drew only when a rider happened to arrive close enough.
      const dist = () => { const me = c.self;
        return me ? Math.abs(me.row - target.row) + Math.abs(me.col - target.col) : Infinity; };
      if (dist() > STOCKPILE_WALK_WITHIN)
        await s.walkTo(target.col, target.row, { maxSteps: 40, hardCap: 50 }).catch(() => {});
      if (dist() > STOCKPILE_GET_REACH) {
        const d = dist();
        this.note('could not get within reach of the chest', { chest: want.slot, squares: d,
          why: `the server refuses a get from more than ${STOCKPILE_GET_REACH} squares` });
        misses.push(`${want.slot} is ${d} squares away and the walk did not close it (a get reaches ${STOCKPILE_GET_REACH})`);
        continue;
      }

      const before0 = c.evSeq;
      await s.pacer.submit('read', () => c.contents(target.id)).catch(() => {});
      const reply = await c.waitFor({ since: before0, kinds: ['container', 'message'],
                                      timeoutMs: 5000 }).catch(() => null);
      const box = (reply?.events ?? []).find(e => e.kind === 'container');
      const inside = (box?.items ?? []).filter(o => norm(o.name) === norm(want.item));
      if (!box) { misses.push(`${want.slot} did not answer a contents request`); continue; }
      if (!inside.length) { misses.push(`${want.slot} holds no ${want.item} (the cache said it did)`); continue; }
      const tookBefore = took.length;
      await this.takeFromChest({ target, want, inside, onTook: (moved) => {
        // PRICES ARE OBSERVED, NEVER ASSUMED — a missing one contributes zero rather than a
        // guess, because a ledger that guessed would always justify the hall it is judging.
        const entry = savingsOf({ item: want.item, amount: moved,
                                  buyPrice: this.policy.reagentBuyPrice ?? null,
                                  sellPrice: this.policy.reagentSellPrice ?? null });
        book.record({ ...entry, to: this.name ?? s.name, from: `chest ${want.slot}` });
        saved += entry.saved;
        took.push({ item: want.item, amount: moved, slot: want.slot });
      } });
      if (took.length === tookBefore)
        misses.push(`${want.slot}: the get moved nothing into the pack (${dist()} squares away)`);
      // WHAT IS LEFT IN THERE, read back now rather than guessed at by subtraction. The
      // reading taken above is already stale -- we have just emptied part of it -- and
      // subtracting what we took would quietly diverge from the chest every time another
      // character deposited between the two moments.
      if (took.some(t => t.slot === want.slot))
        await this.refreshChestCache(target, want.slot, { store, why: 'withdrew' });
    }
    if (took.length) this.note('took reagents from the guild stockpile instead of buying', {
      took, saved, note: 'saved = buy price avoided + sell price forgone' });
    return { took, saved, ...(misses.length ? { why: misses.join('; ') } : {}) };
  }

  /**
   * TAKE `want.amount` OF `want.item` OUT OF ONE CHEST, and only that. Calls `onTook(n)` for
   * every stack that actually arrived, measured in the pack. Split out of
   * withdrawFromStockpile so the whole-stack put-back can be tested on its own.
   */
  async takeFromChest({ target, want, inside, onTook = () => {} }) {
    const s = this.s, c = s.need();
    let left = want.amount;
    // COUNT THE THING THAT WAS ASKED FOR. This read `reagentCount()` and mapped every item
    // that was not elderberry onto HERBS, so a shilling draw measured the herb count, saw
    // nothing move, and stopped — Rowlf's weaponcraft order on 2026-09-25 logged
    // `drew: 6000` and left him holding 400 beside 75,000 in the chest.
    const same = (a, b) => { const x = norm(a), y = norm(b);
      return x === y || x === y + 's' || x + 's' === y; };
    const held = () => this.packAsItems().filter(x => same(x.name, want.item))
      .reduce((t, x) => t + (Number(x.amount) || 1), 0);
    for (const item of inside) {
      if (left <= 0) break;
      const had = held();
      // ASK FOR WHAT IS WANTED, NOT THE STACK. BP_REQ_GET_FROM_CONTAINER carries a count after a
      // number-tagged id (user.kod:977 passes it to UserGet as #number, which Splits the stack,
      // user.kod:3669); the ground get, BP_REQ_GET, drops it (user.kod:969). hallWithdraw has
      // asked this way since de163e8; this path still took the whole 75,000 and put 70,000 back.
      // A client without the opcode falls back to the whole-stack get and the put-back below.
      const n = Math.min(left, Number(item.amount) || 1);
      const spec = this.dropSpec(item, Number(item.amount) >= 1 ? n : null);
      await s.pacer.submit('trade', () => (typeof c.getFromContainer === 'function'
        ? c.getFromContainer(spec) : c.get(item.id))).catch(() => {});
      await new Promise(r => setTimeout(r, 400));
      await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
      await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
      // WHAT ARRIVED IN THE PACK, not what the get was asked for. A container refusal here
      // is a sentence spoken to the room and never an error on the wire, so a `get` that
      // reports nothing is not a `get` that worked — the same rule the deposit half follows.
      let moved = Math.max(0, held() - had);
      if (!moved) break;                       // it refused; stop hammering the chest
      // MORE THAN WAS ASKED FOR STILL GOES BACK. The counted get should make this unreachable,
      // but the fallback above takes whole stacks, and the guild's money is one stack of 75,000:
      // taking it to buy a 6,000 lesson would walk the entire treasury down a road. The surplus
      // goes back into the same chest before this character leaves the hall, and it is measured
      // leaving the pack rather than assumed to have.
      if (moved > left) {
        const surplus = moved - left;
        const stack = (c.inventory || []).filter(o => same(c.rsc.get(o.nameRsc) || '', want.item))
          .sort((a, b) => (Number(b.amount) || 1) - (Number(a.amount) || 1))[0];
        const beforePut = held();
        if (stack) {
          await s.pacer.submit('trade', () => c.put(this.dropSpec(stack, Math.min(surplus, stack.amount || 1)), target.id)).catch(() => {});
          await new Promise(r => setTimeout(r, 400));
          await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
          await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
        }
        const returned = Math.max(0, beforePut - held());
        moved -= returned;
        this.note(returned >= surplus ? 'put the rest of the stack back in the chest'
                                      : 'COULD NOT put the rest of the stack back', {
          item: want.item, wanted: left, took: moved + returned, returned, chest: want.slot,
          why: 'the chest handed over more than was asked for; only what the errand needs leaves the hall' });
      }
      left -= moved;
      onTook(moved);
    }
    return left;
  }

  /**
   * TAKE NAMED ITEMS OUT OF THE HALL'S CHESTS, FOR AN ERRAND THAT IS ALREADY STANDING IN 714.
   *
   * `withdrawFromStockpile` is the keeper's own restock and cannot serve an errand: it travels
   * on its own, reads only its own wants, and measures what arrived with `reagentCount()`, which
   * knows elderberry and herbs and nothing else — a tooth taken reads as "nothing moved" and it
   * stops after one. The ghost raid needs orc teeth, emeralds and sapphires out of the same
   * chests (162 teeth sat in r18c2 on 2026-09-25 while the whole fleet carried three).
   *
   * So this does only the in-room half: through the passage to the chests, then for each want,
   * exactly the amount still wanted, stack by stack, through the counted container get
   * (BP_REQ_GET_FROM_CONTAINER), until the pack holds the amount more than it did. WHAT ARRIVED IN THE PACK decides, never the get — a container refusal is a
   * sentence, not an error. Does not travel; refuses outside 714 rather than guessing.
   *
   *   wants: [{ item, amount }]  ->  { ok, took: {item: n}, short: {item: n}, steps }
   */
  async hallWithdraw(wants = [], { stash = null, deposit = null } = {}) {
    const s = this.s, c = s.need();
    const nameOf = o => String(c.rsc?.get?.(o.nameRsc) ?? o.name ?? '').toLowerCase().trim();
    const same = (a, b) => norm(a) === norm(b) || String(a).toLowerCase() === String(b).toLowerCase();
    const packCount = async (item) => {
      await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
      await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
      return (c.inventory ?? []).filter(o => same(nameOf(o), item))
        .reduce((n, o) => n + (Number(o.amount) || 1), 0);
    };
    const roomNum = Number(s.world?.room?.num ?? NaN);   // the SESSION's world; `this.world` is undefined and read NaN on prod
    // A REFUSAL IS SHORT OF EVERYTHING IT WAS ASKED FOR. These two returned `short: {}`, which is
    // the shape of a draw that got all it wanted: on 2026-10-04 a mushroom courier walked to the hall,
    // its withdrawal refused, and the script logged `short {}` -- "nothing missing" -- beside a pack
    // that went 0 -> 0. Every want is short on a refusal, and `why` says which refusal it was.
    const allShort = () => Object.fromEntries((wants ?? []).map(w => [String(w.item ?? ''), Number(w.amount) || 0])
      .filter(([k, n]) => k && n > 0));
    if (roomNum !== BOOKMAKERS_HALL_ROOM)
      return { ok: false, why: `not in the hall (room ${roomNum}, want ${BOOKMAKERS_HALL_ROOM})`, took: {}, short: allShort() };
    const hall = await this.reachHallChests().catch(e => ({ ok: false, why: e?.message ?? String(e) }));
    if (!hall.ok) return { ok: false, why: hall.why, steps: hall.steps, took: {}, short: allShort() };
    const chests = [...(c.room?.objects?.values?.() ?? [])].filter(o => /chest/i.test(nameOf(o)));
    const nearChest = async (chest) => {
      const me = c.self;
      if (me && Number.isFinite(chest.row) && Number.isFinite(chest.col)
          && Math.abs(me.row - chest.row) + Math.abs(me.col - chest.col) > 5)
        await s.walkTo(chest.col, chest.row, { maxSteps: 40, hardCap: 50 }).catch(() => {});
    };
    // MAKE ROOM FIRST: STASH WHAT THE ERRAND DOES NOT NEED. An armorer arrives with a working pack,
    // and on the 2026-09-25 rehearsal one reached the chests with 126 bulk free — less than one
    // knight's shield. `stash` is a keep list (substrings); everything else that is not worn or
    // wielded goes into a chest before anything comes out. Measured by the pack, item by item.
    // `deposit` is the other direction of the same step: put THESE named things in (a prefarm run
    // bringing its gear home), rather than everything BUT a keep list.
    let stashed = 0;
    // `id:<n>` entries name ONE object by id; the rest are name substrings. By id because a revealed
    // permanent attribute often does not rename the item (magicsort's table: seven of twelve), so
    // depositing "long sword" by name would take the rider's ordinary long swords with it.
    const depList = Array.isArray(deposit) && deposit.length ? deposit.map(d => String(d).toLowerCase()) : null;
    const depIds = new Set((depList ?? []).map(d => /^id:(\d+)$/.exec(d)?.[1]).filter(Boolean).map(Number));
    const depNames = (depList ?? []).filter(d => !/^id:\d+$/.test(d));
    const dep = depList ? { has: o => depIds.has(o.id) || depNames.some(d => nameOf(o).includes(d)) } : null;
    if ((Array.isArray(stash) || dep) && chests.length) {
      await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
      await c.waitFor({ kinds: ['inventory', 'equipment'], timeoutMs: 3000 }).catch(() => {});
      // UNKNOWN IS NOT EMPTY. An unread use list defaulted to an empty set, which let the stash put
      // a WIELDED weapon in the chest — an armorer came home unarmed on the 2026-09-25 rehearsal.
      // Ask once more; if the server's use list is still unknown, stash nothing.
      let using = skills.equippedNow(c);
      if (!using) {
        await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
        await c.waitFor({ kinds: ['inventory', 'equipment'], timeoutMs: 4000 }).catch(() => {});
        using = skills.equippedNow(c);
      }
      if (!using) { this.note('stash refused: the use list is unknown', {}); }
      const keep = (stash ?? []).map(k => String(k).toLowerCase());
      const spare = !using ? [] : (c.inventory ?? []).filter(o => !using.has(o.id)
        && (dep ? dep.has(o) : !keep.some(k => nameOf(o).includes(k))));
      for (const chest of chests) {
        if (!spare.length) break;
        await nearChest(chest);
        for (const o of [...spare]) {
          const before = (c.inventory ?? []).length;
          // A STACK NEEDS A SPEC — a bare id on a stack completes the handshake and moves
          // nothing (see the coop deposit below). The first stash went out with bare ids and
          // stashed none of the pork or reagents that were filling the packs.
          await s.pacer.submit('trade', () => c.put(dropSpecFor(o), chest.id)).catch(() => {});
          await new Promise(r => setTimeout(r, 300));
          await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
          await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
          if (!(c.inventory ?? []).some(x => x.id === o.id) || (c.inventory ?? []).length < before) {
            stashed++; spare.splice(spare.indexOf(o), 1);
            this.tradeFact({ guild_deposited: [{ name: nameOf(o), amount: Number(o.amount) || 1 }] });
          } else break;                          // this chest is full or refusing; try the next
        }
      }
    }
    const took = {}, short = {}, diag = {};
    // TWO PASSES. Rehearsal 25's runner came back with 0 of elderberry, orc teeth, emeralds and purple
    // mushrooms while the chests held hundreds of each and its pack had room; the first pass's reads
    // and takes are now recorded per item (`diag`) and anything still short is asked for once more.
    for (let pass = 0; pass < 2; pass++)
    for (const w of wants) {
      if (pass === 1 && !(short[String(w.item ?? '')] > 0)) continue;
      const item = String(w.item ?? ''), want = Math.max(0, Number(w.amount) || 0);
      if (!item || !want) continue;
      const d = diag[item] ??= { chests_read: 0, chests_unread: 0, stacks_seen: 0, tries: 0, refused: 0 };
      const start = await packCount(item);
      let have = start;
      for (const chest of chests) {
        if (have - start >= want) break;
        // WITHIN SEVEN SQUARES OF THE CHEST. UserGet (user.kod:3576) measures the item's position —
        // the chest's, for an item inside one — and refuses past a row + column distance of 7 in
        // silence. The passage leaves us where the chest SECTION begins, not beside each chest; on
        // the 2026-09-25 rehearsal an armorer with room for four chain armours took none.
        await nearChest(chest);
        const since = c.evSeq;
        await s.pacer.submit('read', () => c.contents(chest.id)).catch(() => {});
        const reply = await c.waitFor({ since, kinds: ['container', 'message'], timeoutMs: 5000 }).catch(() => null);
        const box = (reply?.events ?? []).find(e => e.kind === 'container');
        if (box) d.chests_read++; else d.chests_unread++;
        const stacks = (box?.items ?? []).filter(o => same(o.name ?? nameOf(o), item))
          .sort((a, b) => (Number(b.amount) || 1) - (Number(a.amount) || 1));
        for (const st of stacks) {
          if (have - start >= want) break;
          // TAKE WHAT IS WANTED, NOT THE WHOLE STACK. REQ_GET_FROM_CONTAINER carries an amount
          // (user.kod:977 -> UserGet #number), so forty teeth come out of a 162-stack as forty.
          // A whole-stack REQ_GET was refused as too heavy on the 2026-09-25 rehearsal: 0 of 40
          // teeth, 15 of 120 elderberry, with the stacks sitting in the chest.
          d.stacks_seen++;
          const n = Math.min(want - (have - start), Number(st.amount) || 1);
          const spec = dropSpecFor(st, Number(st.amount) >= 1 ? n : null);
          await s.pacer.submit('trade', () => (typeof c.getFromContainer === 'function'
            ? c.getFromContainer(spec) : c.get(st.id))).catch(() => {});
          await new Promise(r => setTimeout(r, 400));
          d.tries++;
          const now = await packCount(item);
          if (now <= have) d.refused++;
          // Refused — usually too heavy for what the pack has left. A SMALLER stack may still fit, so
          // try the next one rather than giving up on the chest (stacks are largest first).
          if (now <= have) continue;
          have = now;
        }
      }
      took[item] = (pass === 1 ? (took[item] ?? 0) : 0) + (have - start);
      const still = want - (pass === 1 ? took[item] : have - start);
      if (still > 0) short[item] = still; else delete short[item];
    }
    this.note('hall withdrawal for an errand', { took, short, stashed, diag });
    // WHAT CAME OUT OF THE CHESTS, into an open town trip's book like any other trade.
    const drawn = Object.entries(took).filter(([, n]) => n > 0).map(([name, amount]) => ({ name, amount }));
    if (drawn.length) this.tradeFact({ withdrawn: drawn });
    return { ok: true, took, short, stashed, chests: chests.length, diag };
  }

  /**
   * MOVE STOCK FROM ONE NAMED GUILD CHEST TO ANOTHER, through this pack. `moves`:
   * [{item, amount, from: 'r18c6', to: 'r18c2'}] — chests are named by their square (m59-storage
   * chestKey), never a number. The take is from `from` only and the put into `to` only, so a chest's
   * overstock can be rebalanced into one with room (operator, 2026-09-28: "Over stocking the unfull
   * chests also works, particularly for items of value"). hall_withdraw cannot do this: it takes
   * from whichever chest it reaches first.
   *
   * Only what this call took is put back down: the character's own stock of the same item stays in
   * its pack. A put the destination refuses (full, storebox.kod ReqNewHold) goes back into `from`,
   * so nothing is left carried; whatever still cannot be put back is reported `carried`.
   */
  async hallMove(moves = []) {
    const s = this.s, c = s.need();
    const nameOf = o => String(c.rsc?.get?.(o.nameRsc) ?? o.name ?? '').toLowerCase().trim();
    const same = (a, b) => norm(a) === norm(b) || String(a).toLowerCase() === String(b).toLowerCase();
    const packCount = async (item) => {
      await s.pacer.submit('read', () => c.requestInventory()).catch(() => {});
      await c.waitFor({ kinds: ['inventory'], timeoutMs: 3000 }).catch(() => {});
      return (c.inventory ?? []).filter(o => same(nameOf(o), item)).reduce((n, o) => n + (Number(o.amount) || 1), 0);
    };
    const roomNum = Number(s.world?.room?.num ?? NaN);
    if (roomNum !== BOOKMAKERS_HALL_ROOM) return { ok: false, why: `not in the hall (room ${roomNum})`, moves: [] };
    const hall = await this.reachHallChests().catch(e => ({ ok: false, why: e?.message ?? String(e) }));
    if (!hall.ok) return { ok: false, why: hall.why, moves: [] };
    const chests = [...(c.room?.objects?.values?.() ?? [])].filter(o => /chest/i.test(nameOf(o)));
    const bySquare = new Map(chests.map(ch => [chestKey(ch), ch]));
    const nearChest = async (chest) => {
      const me = c.self;
      if (me && Number.isFinite(chest.row) && Number.isFinite(chest.col)
          && Math.abs(me.row - chest.row) + Math.abs(me.col - chest.col) > 5)
        await s.walkTo(chest.col, chest.row, { maxSteps: 40, hardCap: 50 }).catch(() => {});
    };
    const putBack = async (item, n, chest) => {
      let left = n;
      await nearChest(chest);
      for (const o of [...(c.inventory ?? [])].filter(x => same(nameOf(x), item))) {
        if (left <= 0) break;
        const k = Number(o.amount) >= 1 ? Math.min(left, Number(o.amount)) : 1;
        const before = await packCount(item);
        await s.pacer.submit('trade', () => c.put(dropSpecFor(o, Number(o.amount) >= 1 ? k : null), chest.id)).catch(() => {});
        await new Promise(r => setTimeout(r, 300));
        left -= Math.max(0, before - await packCount(item));
      }
      return n - left;
    };
    const out = [];
    for (const m of moves) {
      const item = String(m.item ?? ''), want = Math.max(0, Number(m.amount) || 0);
      const from = bySquare.get(String(m.from)), to = bySquare.get(String(m.to));
      if (!item || !want || !from || !to || from === to) { out.push({ ...m, moved: 0, why: !from || !to ? 'chest not in this hall' : 'nothing to move' }); continue; }
      const start = await packCount(item);
      await nearChest(from);
      const since = c.evSeq;
      await s.pacer.submit('read', () => c.contents(from.id)).catch(() => {});
      const reply = await c.waitFor({ since, kinds: ['container', 'message'], timeoutMs: 5000 }).catch(() => null);
      const box = (reply?.events ?? []).find(e => e.kind === 'container');
      const stacks = (box?.items ?? []).filter(o => same(o.name ?? nameOf(o), item)).sort((a, b) => (Number(b.amount) || 1) - (Number(a.amount) || 1));
      let have = start;
      for (const st of stacks) {
        if (have - start >= want) break;
        const n = Math.min(want - (have - start), Number(st.amount) || 1);
        await s.pacer.submit('trade', () => (typeof c.getFromContainer === 'function' ? c.getFromContainer(dropSpecFor(st, Number(st.amount) >= 1 ? n : null)) : c.get(st.id))).catch(() => {});
        await new Promise(r => setTimeout(r, 400));
        have = Math.max(have, await packCount(item));
      }
      const took = have - start;
      const put = took ? await putBack(item, took, to) : 0;
      const returned = took - put ? await putBack(item, took - put, from) : 0;
      out.push({ item, from: m.from, to: m.to, asked: want, took, moved: put, returned, carried: took - put - returned,
                 ...(took < want ? { short: want - took } : {}), ...(put < took ? { refused_by: m.to } : {}) });
    }
    this.note('hall move', { moves: out });
    return { ok: true, moves: out };
  }
  // @end 1
}
