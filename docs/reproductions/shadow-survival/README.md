# Shadow survival experiment

Read [the report](../../shadow-shopping-survival-2026-09-14.md) and
[protocol](protocol.md) before interpreting or replaying these trials.

`evidence.json.gz` is an explicit, credential-free export of trial metadata,
second-by-second cached observations, results and cleanup receipts. No roster backup
or account credentials are included. This is the compact published evidence; original
captures remain in the ignored `substrate/shadow-survival-2026-09-14/` directory on the
experiment machine. The report and bundle were recovered into main on September 15,
2026. They describe the historical `e1c26da` experiment, not the current production build.

Offline use requires no broker or game server. `plot.py` reads the bundle and produces
the Cccc health figure using Matplotlib. To extract the bundle into a new, disposable
directory compatible with `analyze.mjs`:

```powershell
node docs/reproductions/shadow-survival/unpack.mjs substrate/shadow-survival-replay
node docs/reproductions/shadow-survival/analyze.mjs substrate/shadow-survival-replay severe.json matched-
node docs/reproductions/shadow-survival/analyze.mjs substrate/shadow-survival-replay moderate.json moderate-
node docs/reproductions/shadow-survival/analyze.mjs substrate/shadow-survival-replay rate.json rate-
```

The live driver is specific to this isolated lab: shadow-ab, loopback game port 15959,
admin port 19998, broker 8971, keepers 9011–9031, and a runtime checkout named
`shadow-survival` containing production code `e1c26da`. Its write gate rejects a
different broker, fleet, server or checkout. Never point these scripts at production.
Use the repository's normal fleet ownership/service workflow when switching the shadow
runtime. Preserve the original roster and cached keeper states privately before making
changes; `restore-characters.mjs` expects those private backups and a stopped broker.

With that isolated runtime prepared, the completed sequence was:

```powershell
node docs/reproductions/shadow-survival/driver.mjs park
node docs/reproductions/shadow-survival/batch.mjs flatlands
node docs/reproductions/shadow-survival/batch.mjs crag
node docs/reproductions/shadow-survival/moderate.mjs flatlands
```

`moderate.mjs crag` and `rate.mjs` were prepared follow-ups but did not start because
automatic approval review failed with its model at capacity. They are not evidence.
The published bundle contains 16 severe trials and four milder Flatlands trials.

Flatlands and Crag queues can overlap; never run two trials on the same route at once.
The primary batch and the exploratory extensions were specified at different times,
as the protocol records. The batch scripts resume only trials with completed cleanup
receipts. If a run has a result but cleanup failed, reconcile it with
`driver.mjs cleanup <trial-id>` before resuming; do not overwrite the result with a new
trial. Do not remove live ownership locks to accelerate keeper restarts.

`progress.mjs` and `analyze.mjs` are offline readers. `export-evidence.mjs` builds the
published bundle from an explicit field allowlist and rejects credential-shaped keys.
The live driver is experimental orchestration, not a proposed production policy change.
