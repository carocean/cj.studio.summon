# Summon Flutter client

Requires Flutter 3.50+ / Dart 3.14+, plus Node.js 22+ for the live client/server test. SDK sources: https://docs.flutter.dev/install and https://github.com/flutter/flutter . This project follows the current standalone `material_ui` package guidance: https://docs.flutter.dev/release/breaking-changes/material-ui-and-cupertino-ui .

```sh
flutter pub get
flutter analyze
flutter test
flutter build web --release
```

The client supports an explicitly configured local development API or an HTTPS endpoint. The token field is for the local API access token, not a provider API key. Tokens are kept in widget memory, not saved or bundled. Disconnect clears local subject/session state; it does not stop server-side subjects and tasks.

## Local web development

Start the backend from `../server` with your own randomly generated `APP_TOKEN`, `LLM_MODE=demo`, and `DEV_CORS_ORIGIN=http://localhost:7357`. Then:

```sh
flutter run -d chrome --web-hostname localhost --web-port 7357
```

Enter `http://127.0.0.1:8080` and the same local API token in the app. The backend only accepts the exact configured local development origin for CORS; authentication is still required. Do not publish the prototype or development token. For HTTPS deployment, design proper authentication and origin policies first.

## Native platform boundaries

Android and iOS platform shells are generated and checked in, but generating them is not an APK/IPA build. Android requires an Android SDK; iOS requires macOS and Xcode. Native production connections should use HTTPS. Android emulator host loopback uses `10.0.2.2`; local cleartext rules may need explicit debug configuration and are not globally relaxed here. No GPS, microphone or camera permission is requested by this version.

## Tests

- API validation, UTF-8 requests and structured errors.
- Widget connection, subject selection, service discovery, conversation, failure retry, disconnect, repeated clicks, disposal and small viewport.
- A real local Node process receives requests from the Dart client and runs the persistent runtime. It uses the visibly labeled demo provider, not an LLM.

Web release compilation does not imply visual browser QA or native device QA. See the root validation record for the exact checks executed.
