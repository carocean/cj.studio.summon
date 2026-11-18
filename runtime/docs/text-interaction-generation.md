# Explicit user-text generation: host protocol only

`TextInteractionGeneration` is a host-only protocol, not an HTTP handler, UI,
startup script or background model runner. The separate HTTP wiring described
below does not connect it to SceneLab's
existing fixed-keyword textRequest or to the hearing-event bridge. Tests use
only fake planners. The protocol itself grants no
microphone, camera, tool, storage or model execution authority.

## Interface and capability

Construct with the same SnapshotStore/HostIdentity/InteractionSession domain and
`{planner:null, currentContext, clock, ttlMs:30000, maxAttempts:64}`. Planner defaults
to unavailable. A supplied adapter follows LocalInteractionPlanner's
`generate({text},{signal}) -> {proposal,modelId}` contract; callers must separately
configure an actual trusted loopback planner. No model process or remote fallback
is started here. A modelId remains host metadata, not model-loading proof.

A new owner's capability is disabled. Host-only `setEnabled(handle,
{enabled,expectedGeneration})` increments the persistent generation and cancels
all outstanding owner attempts, even if enabled is unchanged. `state(handle)`
returns that policy plus plannerAvailable, configured ttlMs and attempt count/limit. Policy is persisted, not silently
regranted on restart; a missing planner still prevents inference. Only one open
service is allowed per store. Constructing the protocol does not authenticate any
remote client. SceneLab's single demo owner is not production multi-tenant auth.

`generate(handle,{commandId,context,text,confirmation:'generate-from-user-text'})`
requires a stable 64-character-grammar ID, exact creature/revision frame, nonblank
text <=4000 Unicode scalars / <=16000 UTF-8 bytes and C1 validity. There is no HTTP
body limit here; any future HTTP route must budget JSON overhead explicitly.

Independent sessions may coexist. A new generation does not edit, close, save or
copy values from any existing session. currentReference is a latest-created
**discovery** reference, not the UI's active editor. Successful creation moves that
reference; failure/cancellation does not. Discovery examines only the last-created
session: when that session is inactive it returns null, not an earlier open session.
Reading/restoring an older session still
uses its original owner/context/revision/TTL validation, never an automatic reopen.

This permission to create a separate session is not backend preservation of
unsynchronized client input, nor an automatic UI switch. Before switching surfaces,
the client must explicitly handle retaining its local edits and unknown commands
using its existing workflow. No retainedSession field or extra wire coupling is
introduced here. A client returnSessionId remains client state. Concurrent edits to
the old session do not invalidate an independent new generation merely because its
old draft revision changed. Historical attempts may be replayed without changing discovery.

## Durable identity and outcomes

Before invoking the adapter, admission atomically stores a running attempt and
adds its ID to the bounded owner index. It records owner, inputKind:'user-text',
sourceReference, request digest, frame, capability generation, run identity and
absolute expiry. It does not persist the input text field or log that field.

**Privacy limitation:** digests are private metadata, not anonymization. Generated
titles/labels/questions/reasons may quote input. Programs and session/draft content,
and clarify/none terminal results, are persisted normally and remain private data.
No claim is made that no user-derived words are retained. Adapter exception messages
and arbitrary exception codes are never persisted or echoed: only a finite safe
error-code set or text_generation_failed is returned/stored.

Same command and payload return the original current/terminal result without
inference; changed payload conflicts. `query(handle,{commandId})` returns
not_started, running, completed, cancelled, expired, failed or interrupted.
Completed includes a bounded form creation receipt or clarify/none response, always
inputKind:'user-text'. An unknown network result must keep its original ID and be
queried, not resent under a new ID. Query never invokes the planner.

On reopening, observing a running attempt from another run latches interrupted.
An orphaned marker with no active local attempt is also interrupted. No raw input
is available to automatically recompute it. Historical completion remains queryable
after restart or session expiry, without reading or reviving the session.

The attempt stores a stable owner-derived textgen sourceReference; session.source
retains its existing exact `{kind:'model-proposal', referenceId, modelId}` shape.
referenceId equals that attempt's sourceReference. No ASR ID, realProcessing flag
or hearing authorization is invented; old Flutter source validators are unchanged.

## Commit, cancellation, expiry and bounds

Form uses trusted `InteractionSession.createComposed` before/after hooks. Hooks
have exact names, synchronous functions and null results; accessors/proxies/async
hooks/thenable results are rejected. Existing create command receipt, operation
index, session index, empty values and all original limits are retained. The after
hook completes the attempt in that SAME transaction. Any failure rolls back both
session and completed attempt; admission remains to record failure/interruption.
No HTTP API can supply hooks or programs through this module.

Owner, frame and capability generation are checked before inference and after
await, and inside composition before/after provisional creation. Attempt expiry is
sampled after context callbacks in both before/after composition hooks; only
callback-free owner/policy/status checks follow that final sample; a witnessed expiry rolls back and is latched in
an independent authenticated transaction. A real timer also bounds waiting. Clock
rollback cannot revive a witnessed terminal expiry. New sessions keep their own
existing independent TTL (normally five minutes), unrelated to ASR retention.

`cancel(handle,{commandId})` atomically marks a running attempt cancelled and signals
abort. If completion already committed, cancellation returns completed; it does not
undo it. Policy changes similarly retire pending work. Cancel/timeout may end the
await while an uncooperative adapter continues: the store-domain single-flight lock
stays held until its promise actually settles, including service close/reopen on
the same store. This is a single trusted host service/single-writer domain, not a distributed
coordination protocol. This is not proof that an external inference server has stopped
computing, nor a cross-process/model-server lock. Caller shutdown must separately
manage the model process if needed. No automatic retries occur.

At maxAttempts (default/hard maximum64), new commands are rejected permanently;
old entries/receipts are never evicted. Existing session limits (16 lifetime
sessions, 1024 commands, etc.) still apply at commit. Closing a session does not
reclaim a slot in the lifetime 16-session limit. This slice does not reserve a
session slot before inference: reaching that separate limit can reject a finished
proposal, which is recorded failed rather than bypassing quota. Existing draft
read/edit/save/close protocols remain usable when generation attempts are full.

## Verification

`node --test runtime/test/text-interaction-generation.test.js` uses fresh isolated
stores and fake planners. It covers default-off, owner separation, exact replay,
changed payloads, empty draft, unchanged source shape, no raw-input field in DB,
unchanged prior edited/saved drafts and concurrent old-session edits across new
success/failure/cancel/timeout, no inherited values, cancel/completion competition, late uncooperative adapter,
policy/context ABA/revocation, real and sampled TTL, hook validation, bounded
attempts, atomic rollback and actual SIGKILL before admission returns/before commit/
after commit recovery. Existing interaction-session tests also remain required.
This is protocol evidence, not model semantic accuracy or a working user-facing
text generation feature.


## Narrow SceneLab / HTTP wiring

SceneLab accepts trusted textGenerationOptions with only planner/ttlMs/maxAttempts;
clock, authenticated owner, currentContext and persistence domain are supplied by
SceneLab itself. configureTextGeneration({enabled,expectedGeneration}) is host-only.
No startup code configures a planner or enables the capability. Policy survives
restart, while planner injection does not: enabled:true with plannerAvailable:false
still rejects new inference. plannerAvailable means an adapter was injected, not
that a model-health probe or inference succeeded. State reports configured ttlMs (default30000/max60000).
SceneLab closes generation before closing its database to block late callbacks.

Both the loopback Scene server and authenticated TLS gate allow exactly:

- GET /scene/textgen-state: {enabled,generation,plannerAvailable,ttlMs,attemptCount,attemptLimit}.
- POST /scene/textgen-generate: the existing exact generation request; 64KiB raw
  HTTP body cap, enough for 4000 surrogate-pair emoji escaped as JSON. Host Unicode,
  UTF-8 and IR constraints remain independently enforced.
- POST /scene/textgen-query and /scene/textgen-cancel: {commandId}, 4096 bytes each.

Responses retain the host status/result shape, with no schema wrapper. The only
other expanded body cap remains interaction-edit (128KiB); unrelated ordinary
routes remain4096. Strict UTF-8 parsing, exact gate routes, TLS Host/Origin,
HttpOnly cookie and CSRF requirements are unchanged. Client-supplied owner/model/
program/enabled fields fail; no enable/configuration HTTP endpoint exists.

Connection loss or proxy timeout does NOT cancel an admitted attempt. Keep the
original ID and query; never automatically regenerate under another ID. Gate proxy
uses its existing host-configured timeout (default30s socket,35s total handler;
maximum60s socket/65s total); this can precede a configured host generation deadline.
A transport timeout is an unknown result, not proof of failed inference.

Only explicit cancel marks a running attempt cancelled. A cancel arriving before
admission returns not_started and stores NO tombstone: a later generate may still
run and complete. Do not display this result as confirmed cancellation. A client
must keep uncertainty separate and avoid automatically presenting late results.
A completed command returned by cancel likewise means it was not undone.

`text-generation-http.test.js` uses actual loopback HTTP and a real TLS gate with
a temporary explicitly trusted CA, isolated SceneLab and fake adapter. Tests cover
four routes, default refusal, cookie/CSRF, forbidden fields/config routes, exact
64KiB/4KiB limits and overflow, escaped emoji, invalid UTF-8, stable replay/query,
retained independent draft, dropped replies, explicit cancellation, cancel-before-
admission ordering, persistent policy without model configuration, and close/reopen
interruption. No real model, paid service, user data or public listener is used.
