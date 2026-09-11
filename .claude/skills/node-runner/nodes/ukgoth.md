# ukgoth — NODE_i9, room 599, stone at r27c61

**A KEY, A PASSWORD, A TEN-SECOND FLOOR AND A CLOCK.** This stone is in the room this fleet
loses characters in — 599 is in `KNOWN_TRAPS`, it is the gutter every Castle Victoria run
crosses, and it killed two characters on 2026-09-10. Nothing in this repository knew there was
a mana node in it until the census read the kod.

## The errand, in the operator's words

> Ukgoth requires a "Relic of Qor" to get it, let's make it "skip" when we run the node run
> unless the runner has the item. If the runner does have the relic they should go at that time
> and say the words to open the door.

So `m59-node-run.mjs` **skips this leg before the road** unless the character is carrying the
relic, and says the words once it is in the room if it is. The skip is first-class: `skipped`,
with the reason, not a failure.

## What the kod actually requires (i9.kod `SomeoneSaid`)

```
i9_qor = "Qor the Vile"                      the words, matched with StringEqual

SomeoneSaid(what, string)
   if StringEqual(string, i9_qor)
      lPassive = Send(what,@GetHolderPassive)    the SPEAKER's own pack
      for each object:
         if IsClass(each_obj,&Scepter)           `relic of Qor` (scepter.kod:19)
            WaveSendUser to everyone in the room
            SetSector SECTOR_DOOR ANIMATE_FLOOR_LIFT height=340 speed=16
            CreateTimer(self,@DoorCloseTimer,DOORWAY_DELAY)      10000 ms
            Send(each_obj,@Delete)              THE RELIC IS CONSUMED

DoorCloseTimer()  ->  SetSector SECTOR_DOOR height=440
```

Five facts worth having in front of you before spending one:

1. **The words are exact.** `StringEqual`, so "qor the vile" is not it.
2. **The relic must be in the SPEAKER's pack** — not the room, not a companion's.
3. **It is deleted on use.** One relic, one opening. That is the whole argument for the skip:
   a speculative trip burns a one-use key on a walk that was never going to arrive.
4. **The floor is open for ten seconds**, lifting 440 → 340, and everyone in the room hears it.
5. **And the stone itself is only there at game-hour 0** (`RecalcLightAndWeather`), which is
   what the operator means by "go at that time". The relic opens the floor at any hour; the
   node is only in the room for one of them.

The relic's own inscription is the errand, and it names the room: *"The true servant shall bring
this to the barren place and speak my name."* (`scepter.kod`).

## What is NOT measured, and is the next question

**Where SECTOR_DOOR is.** The floor lifts 440 → 340 somewhere in a 71x66 room and nothing here
knows which squares that opens. Until somebody measures it, the run says the words, records the
ten-second window, and lets the ordinary approach try — and if it comes up short the FRONTIER
line says which square it stopped on and which door it needed. That is the measurement to take
with a relic in hand, and it is worth taking deliberately rather than as a side effect: there
is one relic per attempt.

**The room animates its geometry**, which is the same caveat as the Ice Caves: `i9.kod` is one
of 44 kod room files that call `setsector ... ANIMATE_`, and `MUTABLE_GEOMETRY` in
`tools/m59-mutable.mjs` does not list 599. A reachability claim about this room is a claim
about one frame of a moving floor.

## Related, and already recorded elsewhere

The north exit of 599 **works** and is a declared fall jump, not a door — the Relic is for
climbing back after missing it, which is a different errand from this one. See the gutter notes
and `substrate/m59-falljumps.json`.
