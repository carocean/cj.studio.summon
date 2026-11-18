# Multiple creatures and a primary companion

User direction: one person may own several AI creatures; one is their primary
AI creature, and each has its own hearing and vision. This extends, rather than
replaces, persistent personality, relationships and context-driven scene changes.

## Meaning and authority

- `owner → creature` is an ownership/relationship fact; `owner → primaryCreature`
  chooses the principal companion in that person's experience. Primary is **not**
  root/admin authority over other creatures, their memories or sensor streams.
- Each creature needs stable identity, personality continuity, its own hearing
  and vision grants/generations, perception events, task/context and lifetime.
- Current rendered creature, primary creature and executing creature are distinct.
  A business scene can foreground a specialist without changing primary identity.
- Shared physical microphone/camera is a device resource, not shared perception
  permission. A capture binds intended receiving creature(s) before acquisition;
  switching foreground does not silently forward already-captured media.
- Cross-creature cooperation must name delegator, executor, recipient, purpose,
  time and budget, inherit source restrictions and only narrow authority. Primary
  status alone never grants transcript, memory, audio or camera disclosure.
- Revoking one creature's senses must prevent its late results without revoking an
  unrelated creature or granting it the revoked stream. Device-level stop/privacy
  remains independent and can terminate all active hardware capture.

## Incremental acceptance, not current completion

1. A persistent owner-scoped registry can create at least three creatures and
   set/change the primary relationship; restart preserves IDs and primary.
2. Reject a foreign owner's creature as primary. Deleting/retiring a primary
   requires an explicit valid successor or an explicit no-primary state; no
   automatic grant expansion. This is future behavior to design, not present UI.
3. Independent hearing and vision grants: A hears but cannot see; B sees but
   cannot hear; C has both. Positive and negative tests exercise each identity.
4. Start A inference, switch to B, revoke/regrant A: no result binds to B or uses
   stale A authorization. Returning to A restores its own task/context only.
5. A primary companion asks B for help: B receives only authorized purpose-bound
   input, and the reply does not inherit access to B's unrelated private history.
6. Foreground switch/scene dismissal does not delete an Agent or terminate its
   persistent task. Device capture lifecycle is still explicitly stopped.

## Present implementation boundary

The local single-owner demo now has a persistent owner-scoped registry (up to 16
creatures), primary relationship, independent hearing/vision flags and an
authorization generation. The host seeds companion/work for compatibility;
newly created creatures start with both senses disabled. Primary changes are
CAS-checked relationship changes, not foreground changes or permission grants.
A named creature can be selected without discarding the existing synthetic task;
selecting the already-active creature is a no-op. Each registered creature gets
a distinct persisted legacy sensory-subject mapping when used.

The internal registry uses HostIdentity handles and tests two-owner isolation,
but HTTP still represents one fixed demo owner, **not production multi-user
authentication**. It does not yet implement per-Agent private memories, concurrent
contexts, marketplace/subscriptions or delegated collaboration. The bank activity
is still one existing demo workflow rather than an arbitrary task namespace per
Agent. Same-owner state includes that activity; visual hiding is not privacy.

Registry sensory authorization is checked before and after processing, before
confirmation and before/after speech. Generation comparison catches revoke/regrant
ABA even when legacy permissions end at the same Boolean. Legacy permissions are
an additional check; syncing is only after an explicit registry generation change,
not a startup permission restore. A migration preserves independently revoked
legacy permissions. Existing in-flight results without registry-generation
metadata fail closed when registry integration requires it.

The historical finite `personal-context` command still explicitly targets the
built-in companion, not a newly selected primary. This avoids silently retargeting
an old pending proposal. Future “return to primary” needs an explicit immutable
target binding/version check, not overloading the old candidate.

## Published creatures and subscriptions (new product direction)

Personal primary/stand-in companions and pets coexist with a public marketplace
of business creatures published by organizations, such as banking or insurance
workflow assistants. These must not collapse into one ownership boolean:

- **Publisher**: accountable organization and its verified signing identity.
- **Creature product**: discoverable, versioned description/personality, AIBM,
  declared services, required data purposes and supported rendering/senses.
- **Subscription**: user's entitlement/relationship to a product, with terms and
  lifecycle. This is not implied payment authorization or a blanket privacy grant.
- **Use instance**: the user's persistent creature identity/context and tasks,
  linked to a product version and subscription. Whether execution is a local
  instance, shared hosted agent or hybrid is an explicit contract, not inferred
  cloning or ownership transfer.
- **Service authority**: separately approved bounded powers and disclosure
  recipients. Subscription alone cannot grant microphone/camera access, disclose
  user history to the publisher, share other creatures' memories, transact money,
  purchase insurance, or submit a real account application.

Publishing a product/update must not silently expand an installed instance's
capabilities or change its data recipients. Separate immutable version/content
identity from user-granted permissions. Ending a subscription must define future
service availability and task/data retention without pretending to undo already
observed business facts. Publisher shutdown likewise cannot erase receipts.

Future synthetic acceptance: a mock bank publishes a versioned product; two
users independently subscribe and instantiate it; each instance has its own
identity, personality/context, hearing and vision grants; one user's camera
revocation or task does not affect/disclose to the other; a product update asking
for broader data stays unapproved; unsubscribe blocks new business capability
without destroying existing historical receipts. Only synthetic forms and
simulated service effects are in scope. No real marketplace, fees, financial
contracts or corporate data access are implemented by this document.

## Map-provider creature: cross-entry acceptance

A map company can publish a map creature; the user can subscribe and explicitly
request that provider's creature to travel from A to B. Desired flow:

`subscription → named-provider resolution → entitled creature instance → scoped
route capability → provider receipt → generated navigation surface`

The map surface appears because a route result requires it, not because a
preinstalled map app/tab was opened. The system must preserve the explicitly
requested provider, distinguish provider unavailable from an empty route, and
never silently substitute a different provider. A model vendor (reasoning), an
external vendor Agent (delegated participant) and a map API/service (capability)
are separate roles with separate identity, data-sharing and call contracts.

Next synthetic acceptance can publish a mock map creature, subscribe, resolve a
user's named provider, send only authorized synthetic A/B coordinates to a fixed
mock capability, verify the route receipt and render a bounded route/navigation
scene. Missing subscription, unknown provider, malformed route, revoked location
grant and late response after creature switch must fail without a fake route or
interface falsely claiming navigation has started. Persistence should preserve
the request/task when the map view is dismissed.

Google is a user-supplied product example, not an installed/authorized integration.
No Google account, brand affiliation, live API key, live location, real navigation
or vendor-Agent authorization is implied by this design. A real integration must
establish provider-specific interface/terms/consent before using it.

### Integrated local interface and validation

`/scene/creature-create`, `creature-select`, `creature-primary` and
`creature-sense` operate only on the fixed demo owner. Primary and sensor changes
use `expectedRevision` against the registry snapshot; conflict requires refresh,
not blind retry. Flutter shows a lightweight companion sheet and generates a
name/personality input dialog only after the user asks to add a pet. New pets
have a deliberately limited sprout/owl presentation vocabulary, not generated
artwork or autonomous reasoning. Each sensory switch is an explicit user action.

Global `generation` invalidates stale creature inference; `senseGenerations`
tracks hearing/vision independently for legacy adapter synchronization. Changing
vision cannot restore independently revoked hearing. Old generation-only adapter
files are baselined without expanding permissions; a missing grant may require
explicit revoke/regrant. Cross-store synchronization is fail-closed, not claimed
as an atomic distributed transaction. Crash during seed/sync can leave a sense
unavailable; it must not manufacture authorization to recover availability.

Internal tests cover two-owner registry separation, primary CAS, per-modality
ABA, capacity, restart, old-record normalization, actual HTTP create/select/grant,
unchanged-current no-op, stale pending events and dynamic ID mapping. Opt-in real
inference adds a third pet and runs its own Chinese ASR→event→response→TTS chain.
These are not production multi-owner login, simultaneous device streams or
independent LLM-memory isolation tests.


### Recovery correction: atomic sensory synchronization

The earlier split legacy-grant commit / generation-JSON save could restore a
revoked sense after the second write failed. That implementation is replaced:
`Kernel.syncRegistrySense` commits the modality generation and capability change
in the **same legacy state write**. The separate generation file is no longer an
authority or synchronization source. Existing subjects without atomic markers
are migrated by observing their current grants, never silently enabling them.

Independent legacy `mount(false)` sets a persistent additional revocation block;
registry synchronization does not clear it. Reauthorizing that legacy boundary
requires an explicit legacy grant, rather than silently treating a registry
change as permission to override it. Ordinary registry disable/enable still uses
its own per-modality generations and does not create this independent block.

Regression tests reproduced the old failure with a real unwritable generation
save target for both hearing and vision. Additional tests obstruct the legacy
state replacement itself, verify marker+capability both roll back, independently
revoke, restart, and confirm both remain denied. These are process/file-failure
checks, not hardware power-loss/fsync guarantees. The registry and legacy stores
are still not one distributed transaction; availability can fail closed.

Legacy migration is deliberately conservative: an absent sensory capability in
an old subject lacking synchronization metadata is treated as independently
blocked even when the registry currently also says disabled. Absence cannot
prove that no independent revocation happened. Registry-only enable therefore
cannot silently restore it later; explicit legacy reauthorization is required.
Fresh instances created by the new protocol are distinguishable and retain the
normal explicit registry enable flow. Both hearing and vision are regression-tested.
