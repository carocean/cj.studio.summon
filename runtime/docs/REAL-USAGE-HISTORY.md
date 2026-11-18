# Real usage references (local experimental host)

This small history starts empty. It never backfills creature registration, primary
selection, old snapshots, research fixtures or model generations. Only the new
explicit APIs below learn anything. Legacy selection, automatic scene switches,
create/edit/save/close, reads, discovery and queries do not increment it.

The host still has one local `demo-owner`. `RealUsageHistory` authenticates opaque
owner handles and isolates statistics/receipts in tests; that is **not** deployed
multi-tenant authentication. A client presentation report is not proof of human
attention or permission. Test/experiment stores must stay separate: metadata such
as modelId, realProcessing or client isTest cannot classify genuine human use.

## API

All POSTs use existing loopback lab headers and closed JSON shapes. IDs are bounded
by the existing 64-character ID grammar. Internal usage snapshots/requests/acks
have a 16 KiB total C1 limit; HTTP bodies use the existing 4096-byte request cap.

- `GET /scene/usage` returns
  `{schema:'real-usage-history.v1', sourceTrust:'host-actions-and-client-presentation-reports', minUses:2, learningSaturated, items}`.
  Each item is `{kind,targetId,useCount,lastUsedAt,label}`. At most six currently
  usable references, ordered by count, latest host time and stable target tie-break.
  The UI may show fewer. Zero qualifying references means an empty row, not seeded
  icons. `label` is resolved from the current creature name or current session
  title, not stored in the usage index. Availability filtering does not learn or
  restore permission; observing session expiry/context change may latch it inactive.
- `POST /scene/usage-select` takes `{commandId,creatureId,context}`. Context is the
  **before** scene frame. A successful changed selection atomically updates the
  scene, learns one use and records a receipt. Same-target selection is a no-op and
  does not increment the scene revision or usage. The ack is
  `{fact:'creature_selection_confirmed',creatureId,changed,context,usage}`; its
  context is the **after** frame. It does not grant hearing/vision permission.
- `POST /scene/usage-presented` takes
  `{commandId,sessionId,context,expectedRevision,programDigest,confirmation:'presented-explicitly'}`.
  Call only after an explicit user opening has successfully shown its precise
  route. The host actually reads the session and verifies owner, current context,
  session revision, program digest and session lifetime. The ack is
  `{fact:'interaction_presentation_reported',sessionId,revision,programDigest,usage}`.
  It cannot attest that a human looked at the surface. Discovery, prefetch, automatic
  recovery and repeated renders must not allocate new usage commands.
- Both actions return `{replayed,receiptStored,ack}`. `ack.usage` is
  `{recorded,reason,useCount}` with reason `recorded`, `same-target` or
  `learning-saturated`. A nonrecording result has the existing count or null if no
  such entry exists. Recording never copies field values, raw ASR or grants.
- `POST /scene/usage-query` takes `{commandId}` and returns
  `{status:'completed',commandId,ack}`, `{status:'not_started',commandId}`, or the
  capacity-limited `{status:'untracked',commandId,reason:'learning-saturated'}`.
  Queries do not schedule retries or count uses. An unknown outcome must retain
  its original command; it must not be resent under a fresh ID.

Only `creature` and `interaction-session` targets exist. Saved-note viewing is not
implemented by this slice and no saved-note shortcut is advertised. Session
shortcuts are not durable saved contents: closed, expired or stale unsaved sessions
are filtered out, never recreated automatically. A usage reference is not authority:
clicking must read and validate the target again. Ordinary retained sessions do not
inherit ASR expiry or microphone permission as an editing prerequisite. Existing
unsaved/pending drafts must not be silently replaced when activating a shortcut.

## Capacity and atomicity

Defaults: 32 aggregate targets, 1024 learning events and 1024 stored usage action
receipts (including same-target no-ops). On reaching any limit, learning saturation
is latched permanently. There is no eviction, reset-on-restart or implicit history
migration. Existing recorded commands replay their original ack and reject changed
payloads, without recounting even if the target is now expired.

After saturation, ordinary explicit selection still works using its before-context
CAS. It does not create any more usage receipts, store command rows or index
versions. Such actions return `receiptStored:false`. A repeated original selection
cannot change the scene twice because its before scene revision is no longer
current; same-target no-ops remain harmless. This holds across restart and scene
ABA. Untracked requests do **not** promise stored payload-conflict detection: a
reused untracked ID with a fresh context is treated as an ordinary CAS selection,
not as a recorded command replay, and still never counts. `untracked` is not
`not_started` and cannot justify retrying a potentially completed action.

Session reports after saturation still validate their targets, but do not learn.
A history/report failure should not discard a normal displayed draft. Saturation
is bounded telemetry degradation, not a permission revocation or a reason to
prevent normal creature selection. Host identity is rechecked after synchronous
prepare, clock and action callbacks; failed commits leave no partial action/index.

## Verification

`node --test test/real-usage-history.test.js` uses fresh isolated stores and no
model/Flutter/network service. It checks default emptiness, no automatic counts,
owner isolation, atomic rollback, stable replay, changed payloads, context ABA,
restart, strict bindings, unavailable targets, saturation, bounded SQLite row
counts, C1/size limits, and actual loopback HTTP routing. It validates host state
and protocol behavior, not human intent or a deployed authentication boundary.

A presentation can observe expiry twice: during its initial session read and
again at commit. If the second observation expires the session, the usage
transaction rolls back and the trusted host persists that exact observation
separately. A later clock rollback or process restart cannot revive it. No
client timestamp or expiry-latch endpoint is accepted. The independent regression
that originally exposed this failure is preserved in the repository test suite.
