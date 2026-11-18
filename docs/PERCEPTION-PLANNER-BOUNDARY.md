# Perception → understanding → creature/service → scene

Design proposal after local-model probes, **not an implemented general planner**.
The product remains a generative geographic/creature operating-system entry, not
a model-training project. This boundary permits different LLM vendors without
making model text an execution authority.

## Intended minimum chain

1. A user-authorized hearing capture becomes a real ASR event bound to the receiving
   creature, owner, scene revision, sensory generation and expiry. OCR is observation,
   not an instruction channel. Neither recorded voices nor image text authenticate
   the speaker or grant service access.
2. A planner receives a fresh, bounded attempt: transcription, explicit current
   task and the allowed product/capability catalog. Raw media, another creature's
   memory and unrelated private context are absent by default. Provider/model/mode
   are explicit deployment configuration, never a model-selected URL or secret.
3. Output is a **proposal**, not a receipt: target product and entitled instance,
   service version, typed parameters, ambiguity/clarification status. No arbitrary
   shell, code, HTTP endpoint, UI program, subscription, payment or permission change.
4. The host verifies schema and field relationships, exact provider availability,
   parameter grounding and boundary versions. Unknown provider, missing destination,
   ungrounded nodes or ambiguity produce clarification/unsupported status. Literal
   evidence spans can detect invented values but **do not prove intent**, negation,
   quotation or authorization; model-provided spans are also untrusted.
5. A separate user confirmation binds the immutable proposal digest, source event,
   target instance, exact parameters, permission generations and expiry. Subscription
   and service permission remain separate. Confirmation does not silently subscribe
   or grant a missing capability.
6. The service returns a validated receipt. Only then may the scene show a route,
   completed business result or corresponding structured output. A conversational
   model saying “done” is never an execution fact. Spoken service-status narration
   should derive from the receipt/state, not unchecked free-form model output.
7. The view may close while persistent task/receipt continues. Timeout, cancellation,
   late results, context change and revocation are explicit, without blind replay.

## Replaceable adapters, not interchangeable trust

A local adapter must enforce bounded CPU/memory/time and terminate/reap its worker;
a cancelled Promise alone does not stop inference. A fresh HTTP request is not
proof a remote provider forgot past context. Either the execution context is
isolated, or all retained state must be represented in the provenance closure.
An unknown third-party model's hidden state cannot be claimed to satisfy that proof.

A remote vendor adapter additionally requires a fixed approved recipient/config,
appropriate data-sharing permission, explicit retention expectations and spending
authority. No paid/vendor inference is enabled by this document. Source labeling
must distinguish local LLM, remote LLM, deterministic policy and mock output.

## Staged verification rather than overstating generation

- Keep current real ASR/OCR and local TTS working independently of planner choice.
- Use synthetic transcription tests first, including wrong provider, real places
  outside the demo, missing/reversed endpoints, negation, quotation, conditions and
  instruction-like content. Schema success is separate from semantic success.
- Add real WAV→ASR→planner trials only after a candidate satisfies the narrow
  acceptance policy. Record ASR and planner errors separately; synthetic TTS test
  audio is not proof of microphone/real-speaker quality.
- Initially show proposals without automatic calls. Even a good finite test suite
  does not establish general language reliability or permission to act.
- A deliberately finite, labeled spoken demo can validate the full system chain
  while general language planning is unavailable. It must be called a supported
  grammar/policy, **not** LLM understanding or general scene/service generation.

Current implementation has no unrestricted spoken map-provider resolver. A finite
spoken route slice now binds actual local ASR results to explicit proposals and
separate confirmation; market controls remain available, and local creature
replies remain bounded deterministic phrasing. See [the implemented finite chain](FINITE-SPOKEN-ROUTE.md). The 0.5B and 1.5B probes do not meet the current
candidate policy; do not enable them just because they run cheaply. The completed 4B probe also failed this candidate policy. Results and exact
synthetic evidence are preserved; this selection round has ended.
