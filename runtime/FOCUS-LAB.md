# Synthetic focus record service

`synthetic.focus.v1` is a third fixed business contract rendered through the same
choice-form envelope. It records a plan, not a real focus session. No notification,
scheduler, reminder, device blocking, external booking, network or LLM is used.

Each authenticated owner has independent grants per creature, disabled by default.
Only the current primary can have its grant changed. New creation requires that
primary to be the active scene creature, a current complete form binding, and its
explicit grant. Changing primary does not transfer plans or permissions. Returning
to a formerly authorized primary preserves its grant but does not revive old forms:
the registry revision is different. Sensory flags do not authorize this service.

`FocusService(store, auth, registry, {clock})` supplies `state`, `grant`, `create`,
`cancel`, and `getPlan`; every method takes a HostIdentity handle. This remains
trusted single-host authentication, not production user authentication. Scene owns
the active-context check; the service validates primary, registry/grant versions,
closed input values and owner isolation. No request body chooses its owner.

HTTP endpoints (all fixed, existing local demo headers):
- `POST /scene/focus-grant {creatureId,enabled,expectedRevision}`: full Scene state.
- `POST /scene/form-focus {formId,binding,values,requestId}`: full Scene state.
- `POST /scene/focus-cancel {requestId}`: full Scene state.
- `POST /scene/focus-status {requestId}`: `{requestId,status,plan}`.

The last endpoint reports `not_started`, `completed` (creation saved), or a
`cancelled` pre-creation tombstone. It never creates/replays a plan. A response or
history-window omission is not evidence of failure: query the exact request ID;
never automatically submit a new one. Cancel of an unknown ID creates a durable
owner-scoped tombstone so a delayed create cannot execute. All identities share
an owner limit of 128, including tombstones. Capacity failure does not mean a
cancellation succeeded.

One active plan per owner. Plan states are `active`, `elapsed`, `cancelled`.
`elapsed` says only that a query observed the deadline, not that a user completed
work. That observation commits before later business validation, survives restart
and clock rollback, and never changes the original `fact:plan_saved` receipt.
Unobserved offline clock changes are not a monotonic-clock guarantee. Cancelling
an already elapsed plan does not rewrite the elapsed fact. Historical owner queries
and cancellation remain available after grant withdrawal or a primary change.

There is no TTL on a form. Its full declaration hash and versions must match the
current declaration before a new creation. The lower-level service supports exact
historical replay; the form endpoint is a current-creation gate and uses status
queries for recovery rather than accepting stale forms.

Views are bounded without deleting history: focus shows one recent full plan,
four request summaries, and the active plan separately. `focus-status` retrieves
any recorded request. Aggregate Scene projects market receipt history to the most
recent eight (`receiptWindow:8`) while keeping all 128 market request summaries and
the current route. The underlying market view/history remains unchanged (16 recent
receipts). This keeps the combined snapshot within C1's 64 KiB limit; it does not
relax the limit or claim that storage itself is bounded to the visible windows.

`runtime/test/fixtures/focus-http.json` is generated from actual local HTTP calls
with a fixed synthetic clock, normalizing only random plan/receipt IDs. Tests compare
it against fresh responses and exercise primary/grant ABA, owner isolation, replay,
unknown cancellation, restart/time rollback and combined maximal Unicode payloads.

## HTTP response-loss / process-death acceptance

`node --test runtime/test/focus-http-recovery.test.js` (from repository root)
launches real HTTP/SQLite child processes with isolated temporary data. A test-only
worker suppresses `res.end` **after** the operation has committed and computed its
reply; the parent observes that boundary via IPC and sends SIGKILL. The caller
receives no success response. A new process opens the same database and queries
the original request ID. All three cases are required:

1. Create saved: one active plan, identical saved receipt, no duplicated request.
2. Cancel saved: request still `completed`, plan `cancelled`, original receipt
   unchanged; an exact historical replay may return its old fact, never reactivate.
3. Cancel before create: durable `cancelled` tombstone and no plan; delayed creation
   with that request ID fails with `focus_request_cancelled`.

An active plan makes a creation form unavailable (`400 choice_form_unavailable`),
not a signal to generate a replacement request ID. Use `/scene/focus-status` for
uncertain completion. This test concerns the fixed local synthetic focus service,
not a production remote-effect exactly-once guarantee or real device network QA.
The failure hook exists only under `test/fixtures`, not in the shipped server.

2026-11-17 checkpoint: tracked Node test suites plus this recovery suite passed
201 tests with 6 explicitly skipped optional integrations (207 total). The separate
untracked protected-preview work was not included or changed. Focus service +
recovery focused run passed 10/10. No Flutter or native-device rerun was needed for
this test/documentation-only change; earlier Flutter results are not new evidence.
