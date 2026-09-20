---
name: fs
description: Fleet stats in three numbers — kills per minute, max health, and total money (banked plus on hand) — in a column no wider than 43 characters. Use for "/fs", "fleet stats", "how is the fleet doing", "how much money do we have", or any request for a quick fleet status that is not about one character.
---

# /fs — the fleet in three numbers

```
node tools/m59-fs.mjs                the three numbers
node tools/m59-fs.mjs --minutes 60   a different kills window
node tools/m59-fs.mjs --json         the same, for something else to read
```

Run it and **print the output verbatim**. Do not reformat it, do not widen it, do not add a
table, and do not helpfully expand the abbreviations. The layout is the deliverable.

```
FLEET 24              kills/min 0.00
max hp    20 / 51 / 62        lo/av/hi

purse             21,766
banked            84,710  23/24
TOTAL            106,476
oldest bank read 9d — may be stale
```

## THE WIDTH IS THE REQUIREMENT

Operator, 2026-09-19: no line wider than 43 columns. That is not a style note — it is the
constraint the whole view was asked for, so it is **checked rather than trusted**:
`m59-fs.mjs` reports `width_ok` and `widest` in `--json`, and `m59-fs-test.mjs` fails the
build if any line grows past it, including against a fleet with a hundred million banked and
a three-digit roster. Money is the column with no ceiling and it grows a character at a time,
which is exactly the kind of drift nobody re-measures.

If you find yourself wanting one more column, the answer is a shorter label.

## WHY EACH NUMBER

**max health IS the level in this game** — it is the only thing that goes up and the only
thing a death takes away. Reported as lo/av/hi because a fleet average alone hides the one
character at 20.

**kills per minute is the rate everything else protects.** Vigor, supply, safe spots, which
room — all of it exists to keep this number off the floor. A fleet-wide figure, not per
character, because that is the one that compares against yesterday.

**Money is two halves and they are not equally true.** `purse` is a live field on the fleet
board. `banked` is a balance the banker SPOKE ONCE — `Lm_bnkr_balance`, monster.kod:136 —
and there is no packet for it, so what is recorded is as old as that character's last visit
to a teller. The view prints the age of the oldest component and says "may be stale" because
a confident total over a month-old balance is the most misleading thing it could show. It
also prints how many characters the banked figure covers (`23/24`): a total from 23 of 24 is
not a fleet total.

## WHAT IT IS NOT

Not a dashboard, and not a replacement for anything. `m59-minimal.mjs` owns the health and
kill arithmetic and is CALLED by this rather than re-implemented — if those numbers are ever
wrong, fix them there. `m59-fs.mjs` adds money and the width discipline and nothing else.

For one character use `/m59-hero`; for who is stuck use `/m59`.

Guard: `node tools/m59-fs-test.mjs` (12, offline — no socket, no roster).
