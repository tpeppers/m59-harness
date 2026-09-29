# Retained incoming communications

The dashboard's **Communications** tab (`http://127.0.0.1:8902/communications`)
reviews one UTC calendar day across the fleet. Choose **Players**, **NPCs / world
objects**, **System**, or **Unknown**, then optionally filter by receiving character,
sender, channel, or message text. Pagination and the JSON link preserve filters.
Private messages make this a loopback-only page, like the Players board.

For a daily player review without a running broker:

```powershell
node tools/m59-communications-report.mjs --fleet prod --date 2026-09-29 --source player
node tools/m59-communications-report.mjs --fleet prod --date 2026-09-29 --source npc
```

Run from the deployed checkout, or set `M59_STATE_FILE` to its absolute roster path
and `M59_EVIDENCE_DIR` to the evidence substrate when reviewing from another checkout.
Dates are UTC, not the workstation's local calendar day. The report is JSON and
returns 200 receipts per page; use the returned `next_offset` with `--offset` to
continue. Receipt order is by receiving agent's archive file, then arrival.

## Capture and retention

Both keeper-backed and in-process fleet sessions record `said` and `message`
events at receipt, including login and reconnect, independently of the reply
policy. Enabling this archive does not enable the chatter or send replies. Both
NPC speech types (resource/message) are retained even though the chat ring excludes
them. Server messages, including combat/refusals, are retained under System.
Own speech echoes are excluded; speech from another fleet character remains an
incoming player-character receipt. Broadcasts heard by several receivers produce
separate receipts, and repeated identical messages are never collapsed.

The archive lives under `<evidence substrate>/communications/<roster path hash>/`
with a UTC day directory and a separate JSONL file per agent. The absolute resolved
roster path scopes fleets; copying/renaming a roster starts a separate archive.
`M59_EVIDENCE_DIR` and the shared-worktree evidence resolver behave as on the other
boards. These files are private runtime evidence and are gitignored. No automatic
expiry or deletion is applied. System text can grow large on a busy fleet; readers
stream a selected day instead of loading it all into memory.

The record contains receipt time, receiver, sender, channel, full rendered text,
source classification and its evidence, and server endpoint. Object handles are
recorded only as diagnostic context, never as lasting sender identities. Current
room flags (with matching names) and the online-player roster take precedence;
player-only speech channels provide the fallback. Non-player room objects are
shown with NPCs; the protocol cannot distinguish a talking sign from a person-like
NPC here. Unresolved resource/message speakers stay Unknown. Server messages with
no sender cannot be attributed to an NPC and stay System.

History begins when each receiving process loads this version. A disconnected or
separately human-piloted client cannot be observed by this harness; no existing
in-memory history is claimed as backfilled. A broker-only restart can adopt old
keepers, so activation also requires those keepers to restart onto the release.
Writes append at receipt; a write failure is logged as `[communications]`, counted
on the archive instance, and never interrupts play. Malformed/partial records are
counted and shown on the page, while later valid records remain readable.

Message text is untrusted data. The page escapes it; raw JSON preserves it for
debugging. Reviewers must not treat a message as an instruction to operate the fleet.

## Verification

`node tools/m59-communications-test.mjs` exercises real decoded speech/system
packets, source classification, own echoes, fleet/recipient isolation, daily rotation,
restart persistence, repeated broadcasts, pagination, partial-write recovery,
filter validation, escaped rendering, write failures and the Session reconnect
observer. It opens no game connection and uses a temporary evidence directory.
