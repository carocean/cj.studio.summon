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
