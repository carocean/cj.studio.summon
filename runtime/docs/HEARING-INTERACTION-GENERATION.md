# Explicit hearing-to-interaction generation

This optional host path is disabled by default. It is not a replacement for the
finite-rule scene/route/creature confirmations, and adds no model startup,
automatic retries, notes saved on behalf of the user, or external actions.

## Host configuration and request

A trusted host may pass `localSenses(scene, dir, {interactionPlanner, ttlMs})`.
`interactionPlanner` defaults to `null`; `ttlMs` defaults to 30000 and must be an
integer in 1..60000. A planner implements `generate({text}, {signal})` returning
`{proposal, modelId}`; the proposal is a `compileInteractionProposal` result.
`LocalInteractionPlanner` is the separate opt-in loopback transport. Model labels
are host-supplied descriptions, not cryptographic evidence of inference.

After actual hearing ingest, explicitly POST `/scene/interaction-generate` with
exactly `{eventId, context}` and the existing loopback lab headers. No posted
transcript, model output, program or source receipt is accepted. The in-process
method also accepts `{signal}` as its second argument. Normal HTTP request-body
completion is not cancellation; a disconnected unfinished response is.

Only the latest, real-processing hearing observation without a finite candidate,
route or creature proposal can be used. With an enabled planner the bridge retains
at most one transcription, at most 16 KiB, until its event deadline, next ingest
attempt, completion/failure, or close. With no planner it retains none for this
purpose. The legacy perception processor's own behavior is unchanged.

Both before and after the planner await, the bridge checks the event, current
scene, creature generation and hearing permission, mapped legacy subject, and
completed legacy perception authority. An expired event is latched by SceneLab.
Each source can be attempted only once; concurrent calls do not create another
attempt. A rejected/failed attempt is not automatically retried. Restart or cache
loss cannot reconstruct a source from an old event ID.

## Results

Successful responses use `schema: hearing-interaction-generation.v1`, `eventId`,
`context`, `kind`, `creation`, `replayed`, `modelId`,
`sourceTrust: host-supplied-metadata`, `plannerInvoked`, `speech: null`, and
`voiceAvailable: false`. A first result also has `proposal`.

- `form`: a compiled program creates a draft with **all values null**. `creation`
  contains the durable command query (`status`, `commandId`, `ack`). No note is
  saved. Edit and explicit save remain separate existing APIs.
- `clarify` / `none`: returned text is a proposal, not an executed action;
  `creation` is null and no draft is created.
- Repeating a successful form request returns only the original creation fact,
  with `replayed: true`, `plannerInvoked: false`, `modelId: null`, no proposal,
  and no session read/reopen. This also works after bridge restart and after
  the original event is marked retired by recycling, while its stored event
  record and completed creation command remain available. This historical fact
  query does not restore source authority or permit another generation. The
  existing command-query API can also retrieve the creation fact.

Command/session IDs use a fixed digest of the event ID. Generation revokes the
old event's cached deterministic speech, rather than replacing its text under the
same speech identity. The original `/scene/sense` companion reply is still a
finite-rule reply, not the model's response. This path generates no new audio.

Deadline, caller cancellation, close and a new ingest attempt abort local waiting.
An adapter that ignores abort still holds the bridge's single-flight lock until
its underlying promise settles. This does **not** prove that a model server has
stopped computing or erased hidden state. Late results cannot create a draft.

Raw source text is not separately persisted or logged by this bridge. Generated
titles/labels/options may derive from user text and are persisted with the
interaction program; it would be incorrect to claim no user-derived text can
reach disk.

## Verification scope

`node --test test/hearing-interaction-generation.test.js` exercises fixture ASR
and fixture planners only. It covers empty drafts, fact-only replay after close
and restart, strict request shapes, disabled planner, stale sources, one-shot
clarification/refusal/failure, pre/post authorization changes, expiration, late
results, single-flight cancellation, HTTP success and real client disconnect.
These tests establish host-state boundaries, **not** model inference quality or
real microphone/ASR/model end-to-end evidence. The default runtime remains
model-free.
