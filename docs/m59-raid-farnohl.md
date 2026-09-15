# Killing the ghost of Far'Nohl with a fleet that has to buy its own reagents

Room 40, the throne room of Castle Victoria. This is the plan a **prod** fleet can actually
run — no DM socket, no spell grants, no conjured weapons — with the arithmetic it rests on and
the measurements that overturned parts of it.

Sixteen simulated raids. **The first nine measured the harness rather than the fight**, and
the five after that measured a room my own harness had left in a state prod will never see.
Only the last two are clean. That is said first because the numbers below are worth exactly
what the instrument was worth.

---

## 1. The three facts that decide it

### The weapon is the fight

`ghost.kod:83-89`:

| what you deal | its resistance | a raw-5 blow delivers |
|---|---|---|
| `ATCK_WEAP_NONMAGIC` | **+90** | **1** |
| `ATCK_WEAP_MAGIC` | **-50** | **7** |
| `ATCK_SPELL_HOLY` | **-50** | ×1.5 |
| fire / cold / unholy / acid spells | +90 | ~nothing |

**Measured:** 6.9 to 10.9 health per landed blow with dedicated weapons; **1.0** with mundane
ones. A resisted blow still floors at 1 (`monster.kod:1562`), which is why the ratio is seven
and not the fifteen the raw multiplier suggests — and why a mundane raider is a *stalemate*
rather than a zero. It still holds aggression.

### The escort is a CLOCK, not a constant

This is the correction that changed the plan. Measured from a genuinely cold room:

| | |
|---|---|
| **+0 s** | the first player to enter spawns **the ghost** — `throne1`'s `FirstUserEntered` calls `SpawnGhost`. And because a Ghost is a `&Monster`, `MonsterRoom`'s own `FirstUserEntered` then finds `bFound = TRUE` and **skips its initial batch of 1–5 entirely**. The room opens with the boss and nothing else. |
| **~12 s** | one tusked skeleton. And another every ~12 s after that. |
| **+110 s** | escort **9**, and no more — `piMonster_count` counts the ghost and the cap is 10. |

Two things this repository used to say were wrong. It is **not** one per 20 seconds:
`GetMonsterGenTime` divides `piGen_Time` by the player count, which
`vbScaleSpawnRateWithPlayers = FALSE` pins at 5. And **nothing spawns at all while the room
holds no players** — `LastUserLeft` deletes the generation timer.

So every second the boss survives buys it another twelfth of a skeleton; skeletons drive
raiders out; fewer raiders means a longer fight. **It is a feedback loop, and the way to win
is to be quick rather than to be strong.**

### The boss is cheap to re-try, not a two-hour wait

`GHOST_CYCLE = 7200` seconds is a *periodic* re-trigger, not a gate. `SpawnGhost` spawns
whenever the room has no ghost, and `FirstUserEntered` calls it. So: kill it, leave, come
back, and there is another one — as long as `pbOkay_To_Load` is true, which it is unless the
last player left a room that was *also* empty of monsters (then it is false for 180 s).

Max health varies per spawn — 186 through 295 observed. **Read it, do not assume it.**

---

## 2. What the clean runs measured

Both from a cold room, same fleet, same weapons, same buffs, one variable apart.

| | boss health | kill window | fleet damage | per blow on the boss | deaths | escort at +90 s |
|---|---|---|---|---|---|---|
| **all 17 on the boss** | 294 | 90 s | **3.3 hp/s** | 10.9 | **0** | 9 |
| 10 on the boss + 7 on the escort | 216 | 90 s | 2.4 hp/s | 9.4 | 1 | 9 |
| *(for contrast: hot room, all-in)* | 254 | 171 s | 1.5 hp/s | 6.9 | 1 | 10 from t=0 |

**The escort reached nine in both cold runs.** Seven raiders assigned to it did not hold it
down and could not: killing one skeleton buys twelve seconds before the generator replaces it.
They bought nothing and cost 0.9 hp/s of boss damage.

So the recommendation in the previous version of this document — *put six to eight raiders on
the escort* — **is withdrawn.** Going all-in is 38% more damage per second and produced the
only run of sixteen with no deaths at all.

The earlier ablation still stands for what it measured, from the hot room:

| weapons | forces of light | fleet damage | per blow | outcome |
|---|---|---|---|---|
| enchanted | yes | 1.50 hp/s | 6.9 | killed |
| enchanted | yes | 1.55 hp/s | 7.5 | lost at 31/280 |
| **mundane** | yes | 0.59 hp/s | **1.0** | lost at 92/187 |
| enchanted | **no** | 0.60 hp/s | 7.7 | lost at 87/256 |
| enchanted | **no** | 0.10 hp/s | — | routed, 0 swings |

Forces of light does not change damage *per blow* — 7.7 without against 6.9 and 7.5 with,
exactly as `ModifyDamage` returning its argument predicts. What it changes is how many land.
The evidence for that is consistent rather than conclusive: one of the two no-light runs was a
rout with a beaten-up fleet.

---

## 3. What the prod fleet actually has

Surveyed read-only on 2026-09-12, 23 characters:

| | who |
|---|---|
| **enchant weapon** | 4 — Robin (41 mana), Beaker (25), Bunsen (25), Camilla (33) |
| **forces of light** | **1** — Loial the Ogier (65 mana, **20 max health**) |
| **minor heal** | 4 — Pepe (27), Statler (27), Loial, Marco Polo (25) |
| reagents | elderberry 149, orc teeth 43, herbs 109, emeralds 274 |
| weapons | 108 carried across 20 characters — but **only 13 are wielding one** |
| max health | 20 to 62 |

**Ten characters are carrying weapons and holding none.** Free damage, and the first thing to
fix.

---

## 4. The plan

### Phase 0 — wield something

`equip` the ten empty-handed raiders. The enchantment goes on the thing they are actually
holding, and `equipment()` is the only honest read of what that is.

### Phase 1 — the reagents are already bought

| for | each | for 21 raiders |
|---|---|---|
| enchant weapon | 3 elderberry + 1 orc tooth | **63 elderberry, 21 orc teeth** |
| forces of light | 2 elderberry + 1 emerald, per ~3 minutes | 6 elderberry, 3 emeralds |
| minor heal | 1 herb per cast | 40–60 herbs |

Against 149 elderberry, 43 teeth, 109 herbs and 274 emeralds already in the packs: **no
shopping trip is needed for one raid.** Two raids are tight on orc teeth.

Do **not** use `create weapon` conjures — they are `ItemAttMade` and evaporate, taking the
enchantment with them.

### Phase 2 — dedicate every weapon, on the floor

`IsTargetInRange` (`enchwp.kod:75`) is `who = GetOwner(target) OR GetOwner(who) =
GetOwner(target)`. A weapon on the floor is owned by the **room**, and so is the caster
standing in it — so **a dropped weapon is a legal target and no trade handshake is needed.**
Drop, enchant, pick up, next; one at a time, because two "long sword"s on the floor are
indistinguishable by name.

**17 mana, 3 elderberry + 1 orc tooth, 20 vigor, 30-second cast.**

- casts per full mana bar: Robin 2, Beaker 1, Bunsen 1, Camilla 1 = **5 weapons per cycle**
- 21 weapons is **four to five rest-and-repeat cycles**
- re-casting on an already-dedicated weapon is **free** — refused in `CanPayCosts` before
  payment — so verifying costs nothing

The trance is the hard part and the keeper is what breaks it. Use `castVerified`, and do it
somewhere quiet — not in room 40.

### Phase 3 — go in cold, and go in together

**This is the phase that replaced the escort split.**

1. **Make sure the room is empty of players** before the raid forms up. While nobody is in it,
   nothing spawns.
2. **Everybody walks in at once.** The escort clock starts with the first raider, so a fleet
   that trickles in over ninety seconds hands the room a free skeleton every twelve.
3. **Everyone fights the boss.** Nobody is assigned to the escort — it cannot be held down and
   the raiders spent trying are raiders not shortening the fight.
4. **Three healers at the back**, never swinging. One caster holding forces of light up.

Target: **under 90 seconds of contact**, which is what the all-in run achieved. At that pace
the escort peaks around seven and never gets its full nine.

### Phase 4 — the fight

- **Stand up** before every swing, every walk and every cast. See §5.
- Close, swing, re-close **every round**. The ghost is `SPEED_FAST` and walks through walls.
  Aim at a **ring of eight** around it, not one square.
- **Do not fight it on its spawn square** at r2c5 — it has refused every approach tried. Every
  kill happened when the ghost came to the raiders.
- **Swing at the object, not the word.** A logged-off player leaves a "logoff ghost" that
  matches the name and is often nearer; it turned up in five of sixteen runs. Require the
  server's own `can: ["attack"]`.

---

## 5. The failure that hid all the others: posture

`IsResting` sets `PFLAG_NO_FIGHT`, `PFLAG_NO_MOVE` and `PFLAG_NO_MAGIC` together
(`player.kod:1161-1166`). A character the keeper has sat down:

| | |
|---|---|
| **cannot swing** | refused out loud — "You find yourself unable to lift your weapon." (`user.kod:4679`) |
| **cannot walk** | bounced **silently**: put back on the square it is on, and returns (`user.kod:2988`) |
| **cannot cast** | refused |

**The commander claim does not stop it.** A claim takes work, movement and economy; recovery
stays with the keeper on purpose.

Every silent failure in nine raids was this one flag, and **none of them errored**:

- `landed=0` across eighteen raiders through a kill — the swings were refused
- "first contact said nothing conclusive about the weapon", twenty-one times, every run
- `forces of lightx0` with the reagents untouched — the room caster never cast
- "could not close on Ghost (distance 20)" — read as geometry. **Four of twenty-one raiders
  reached melee in the run that found this; fifteen in the next.**

Proved: `piFlags` 4309088 seated, 4194400 standing, same character, same ghost, every swing
refused before and every swing landing after.

Two instrument bugs underneath it, each of which hid it:

- `attackRounds` **dropped the resistance sentence** — `waitFor` resolves on the first matching
  event, so the hit line ended the round's wait and "The ghost of Far'Nohl staggers backwards
  from the blow." arrived in the gap before the next round took its `since`.
- **a literal backspace byte** sat in the hit counter's regex, and in four others across the
  harness. Patching source through a heredoc on this machine eats one backslash, so `\b` lands
  in the file as 0x08. The regex compiles, runs, and matches nothing, for ever, in silence.

---

## 6. Still open

**Forces of light has one caster who cannot survive the room.** It is a room enchantment, so
the caster must stand in room 40, and Loial has 20 maximum health. Either teach a second
character the spell (Shal'ille level 4), or send Loial with two healers assigned to nothing
else, or leave it out and accept the difference between 1.50 hp/s and 0.60.

**The healers are unmeasured, not useless.** `minor heal` is 3 mana, one herb, and caps at
**ten health** per cast. The measured landing rate is not trustworthy: most failures
classified as `nothing_happened`, and the commonest real cause turned out to be "*Xxxx is
perfectly healthy*" — a refusal raised before payment that the classifier did not recognise.
That is now the `unnecessary` outcome.

---

## 7. Would prod manage it?

**Yes.** Two consecutive kills from a cold room, the better of them 294 health in 90 seconds
with **zero deaths**, using nothing prod cannot do for itself. The corrections that got there
were all about the harness and the opening, not about the fleet:

- go in **cold** — 2.2× the damage rate of the same fleet in a room already at the escort cap
- go in **together** — the escort clock starts with the first raider through the door
- go in **all-in** — the escort cannot be suppressed, so do not spend raiders trying

Prod's remaining disadvantages are healers with 25 mana rather than the 90 the simulation gave
them, and one forces-of-light caster who cannot take a hit.

---

## 8. Running it

```bash
node tools/m59-fleet-repl.mjs
  run raid-action --target Ghost --room 40 --via 40 --stage-room 38 \
      --healers t2,t3,hk2 --room-caster hk1 --room-enchant "forces of light" \
      --require-enchanted --rounds 60
```

Room 40 is a declared hazard and `--despite-hazard` takes a mandatory reason.
`require_enchanted` is satisfied by an enchanted weapon **or** by a caster with the spell and
the reagents, and a raider that fails it still goes in and swings. `--escort a,b,c` assigns
raiders to the escort instead of the boss; the measurement above says do not.

```bash
node tools/m59-raidreport.mjs --hp <sample.log> --raid <raid.log> --avg-max-health 52
```
