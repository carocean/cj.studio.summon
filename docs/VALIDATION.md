# Validation record

## v0.5 environment

- Flutter 3.50.0 stable, framework revision `ab2912035e160d9cad6306df307576da6128ebdb` from the official Flutter GitHub repository.
- Dart 3.14.0; current official `material_ui` 1.11.1, dependencies recorded in `app/pubspec.lock`.
- Node.js v24.22.1.
- Local SDK/cache were kept outside the project and are not committed. No real model key or paid API was used.

## Scope distinctions

1. Flutter static analysis and widget tests check real Dart code, not a static HTML substitute.
2. Flutter web release build proves compilation for web, not APK/IPA installation or phone operation.
3. Dart → actual local Node API test exercises client JSON/HTTP and persistent backend together; model responses remain explicitly demo.
4. Backend → local HTTPS Chat Completions compatible mock test uses native fetch and TLS with an ephemeral test CA trusted only by its child process. It verifies request path, headers, model/messages, response parsing and returned conversation result. It does **not** verify any external vendor or model inference.
5. Android/iOS platform source generation is not compilation; no device, emulator or App Store upload has been performed.

The TLS test requires OpenSSL in PATH. Temporary test certificates and synthetic tokens are removed after tests. No global TLS verification switch is disabled.

## Executed final checks (2026-11-17)

- `flutter analyze`: passed, no issues.
- `flutter test`: passed, 9 tests, including real Dart client → Node process integration.
- `flutter build web --release`: passed; compiled `build/web` output is reproducible and excluded from source control.
- `npm test` in server: passed, 23 tests.
- `flutter doctor -v`: not an all-green environment. Android SDK is absent; Linux desktop toolchain is incomplete; Chrome needs explicit executable selection in this environment; its proxy-interface diagnostic crashed. These do not invalidate the above checks, but native builds and interactive browser QA are not claimed.

No testing server or mock provider was left running. Android/iOS generated default icons remain placeholders rather than final product branding.

## v0.6 session recovery regression (2026-11-17)

- Flutter analyze: no issues; Flutter tests: 11 passing (API, widget and actual HTTP).
- Node tests: 24 passing. Durable resume tested after reopening the store, repeatedly at session capacity, with owner/lifecycle rejection and immutable returned history.
- The real Dart→Node test now terminates and restarts the Node process on the same store, re-discovers the session by creature, and verifies identical ID and saved turns. This is real local persistence, still demo model output.
- Widget regressions cover already-selected no-op, A→B→A, draft preservation, disconnect/reconnect, changed-token draft isolation, and a 30-message newest-reply visibility check. The bounded conversation scroll body lays out all turns so scroll extent is exact.
- Web release compiled again. Native packaging and visual browser QA remain unverified. No real model or paid service used.
- Known limits: drafts are process-memory only; no multi-session UI/automatic rotation for the 50-round limit; connection ambiguity still requires checking saved history before resending a potentially committed call.

## v0.7 owner-scoped cross-subject service discovery (2026-11-17)

- `npm test`: 28 passing. Four new scenarios cover registry discovery without preselected subject, active/owner/capability/spatial/rendering boundaries, dynamic grants/revocation/retirement, invalid and unknown requests, and a real authenticated HTTP discovery→explicit selection→invocation sequence.
- Discovery is asserted not to mutate the persistent snapshot or invoke a model. A proposal obtained before capability revocation cannot bypass invocation checks.
- `flutter analyze`: no issues; `flutter test`: 11 passing. The existing real Dart client→Node restart test now also invokes global discovery and verifies multiple choices include the persisted subject.
- Client production source and platform shells are unchanged from v0.6; Web release was not rebuilt in this backend-focused iteration. The previously verified v0.6 client remains the current UI version. Global discovery is not yet a Flutter screen.
- No external model, paid API, third-party service market, physical location, hardware connector or real-world action was used. Native/visual browser verification remains open.

## v0.8 Flutter global calling entry (2026-11-17)

- `flutter analyze`: no issues; `flutter test`: 18 passed; `flutter build web --release`: passed (0.8.0+8).
- Six dedicated discovery widget scenarios verify discover/select without execution, explicit selected invocation, edited prompt invalidating candidates, failed rediscovery, revoked stale proposal, unavailable/unknown intent, duplicate pending requests/disposal, and narrow 320×568 menu/space presentation (some scenarios cover multiple checks).
- A navigation regression verifies entering/leaving global discovery preserves the chat subject, persisted history and private draft without creating another session or sending a conversation message.
- The real Dart→Node test now also selects a discovery candidate, invokes its service, revokes the grant using the test kernel API and verifies the old selection receives `outside_service_boundary`. The fixture then restores the grant and completes existing checks. This is actual loopback HTTP, not a widget mock, but not a real device or model.
- `npm test`: 28 passed; backend behavior remains unchanged in this client-focused iteration.
- Browser screenshot/interactive visual QA and Android/iOS builds remain unverified. Widget tests and web compilation are not substitutes for those stages. No paid API, real model, physical location, external order or device action was used.
