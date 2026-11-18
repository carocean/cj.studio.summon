# Local creature market and route slice

This is a deliberately small **synthetic** vertical slice, not a public market,
Google integration, live navigation, payment/subscription billing or an ECM service.
The product name and existing repository name remain experimental, not finalized.

## Separate records and authority

- Trusted built-in publisher/provider `demo-maps` offers versioned product
  `demo.maps.v1` and service `synthetic.route.v1` version 1.
- A fixed catalog describes A/B/C synthetic nodes, no network and no payment.
  There is no open publisher registration/upload endpoint.
- A user subscription points to a persistent business-creature instance. Creation
  and subscription commit in one SnapshotStore transaction, respecting the
  registry's capacity and authenticated owner handle. Existing primary remains
  unchanged; subscription does not grant either sense or route execution.
- Route capability is an independent explicit grant, with a CAS revision and
  generation. Unsubscribe disables new route use but retains instance/history.
  Resubscribe reuses the instance and requires a fresh route grant.
- Runtime HTTP remains one demo owner. Internal multi-owner tests are not a
  production authentication or tenant-account implementation.

## Receipt before presentation

A request names the exact product and instance plus synthetic `from`, `to` and
`requestId`. Unknown products, mismatched instances, real coordinates/URLs and
arbitrary service names cannot substitute another provider. The pure local
executor computes the closed A/B/C path. The host validates the exact expected
path and hop count, and rechecks subscription authorization before atomically
recording completion. The executor cannot mint its own trusted receipt.

Only the stored completed receipt produces `synthetic-route.v1` render data.
The outer scene changes to the requested creature only after a valid receipt;
a foreground change while computation was pending prevents stale UI replacement.
The receipt remains a historical service fact and can be reconciled later. A
route card is a schematic sequence of synthetic nodes, **not GPS guidance, road
geometry, distance, travel time or proof anyone reached a destination**.

Hiding the card persists its visibility independently from the receipt. Restart
preserves the last route/view and subscription. It does not cancel or delete
history. Existing synthetic bank tasks and the primary companion relationship
are not replaced by subscribing or closing the map scene.

## Retry, failure and boundaries

Request IDs are owner-scoped. Same ID and content returns only the original
historical receipt; conflicting content is rejected. Pending requests are
persisted before execution and are not automatically redispatched after a crash.
Timeout, bad output or changed authorization cannot produce a success surface.
A replay after unsubscribe is historical information, not a newly authorized call.
The UI must label replay/history rather than claim another service execution.

This executor has no external effects, credentials, location disclosure or
arbitrary Agent tools. Its timeout bounds waiting, not arbitrary uncooperative
third-party computation. Real remote providers require cancellation/uncertain
outcome semantics, identity/receipt authentication and disclosure policy before
reuse. This read-only synthetic path is not presented as the financial Permit
sink protocol or a proof of distributed exactly-once execution.

Limits: one built-in product/provider, one instance per owner subscription,
128 request identities per owner with no automatic eviction, last 16 completed
receipts in the underlying market view, and one current route surface. The aggregate
Scene view projects the most recent eight receipts (`receiptWindow:8`) to stay
within its bounded transport budget; it retains all 128 request statuses and does
not delete historical records. Capacity exhaustion
is explicit. Failed/pending requests consume identity slots. There is no automatic
paid upgrade, public publication, arbitrary product installation or private
cross-Agent memory sharing.

## Current HTTP contract

All mutations use the existing local-demo header and loopback boundary. Each
returns full scene state; state includes `market` and optional `route`.

- `market-subscribe`: `{productId}`
- `market-grant`: `{productId, enabled, expectedRevision}`
- `market-unsubscribe`: `{productId, expectedRevision}`
- `market-route`: `{productId, instanceId, from, to, requestId}`
- `route-visible`: `{receiptId, visible}`

Tests cover subscription/instance atomic rollback, separate grant, two-owner
separation, specified provider, bad receipt, revoke/regrant ABA, timeout, real
SIGKILL pending recovery, idempotence and conflicts, actual HTTP discovery through
route presentation, stale foreground protection, hide/restart and preserved facts.

UI scope: discovery, subscription, provider selection and route request are
currently explicit Flutter controls. An unrestricted spoken “use vendor X from
A to B” planner is **not implemented**. Hearing/vision remain available per
creature's independent grants; enabling a map product does not enable them.
Local response phrasing can select the registered bounded tone (playful/precise),
not a trained personality or a generated service implementation.

## Explicit recovery, not automatic redispatch

Discovery state now includes the complete bounded request-status index, not just
its receipt display window (16 in the underlying market, eight in aggregate Scene). `failed` and `cancelled` are terminal and allow a
user to explicitly start a new request identity; `pending` and an unknown network
outcome do not. A missing receipt alone is never proof of failure or completion.

`market-cancel: {requestId}` is an explicit local recovery operation. For a
previously unseen identity it writes a persistent cancelled tombstone so a late
arrival cannot start under that ID. For a pending pure synthetic request it
prevents late completion from committing a new receipt. It does not claim the
executor stopped running, and cannot erase an already completed service fact.
A completed request remains completed. Cancellation consumes the same bounded
identity quota. This protocol is **not** applicable to uncertain real payments,
network side effects or arbitrary Agents without further design.

The client unlocks only after confirmed terminal status, not merely after sending
cancel. Failure to confirm cancellation leaves the unknown outcome visible and
does not resend the original route. Replayed receipts are visibly identified as
history with no new service call; the renderer requires an explicit Boolean
`replayed` field. A completed request older than the visible receipt window is
still known completed from its status, not incorrectly labeled pending forever.
