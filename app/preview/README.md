# Resource preparation only

This opt-in packaging path leaves `web/index.html` and the default local theme unchanged.
The HTML comes from the runtime's exact `PREVIEW_RENDER_HTML` contract. Its placeholder
is replaced only by the explicitly opted-in trusted host, with a fresh style nonce per
HTML response. The external bootstrap passes the nonce to both loader and engine.
No policy setting or deployment is performed by this directory.

Build serially with the project's approved offline SDK environment:

```
flutter --no-version-check build web --release --no-pub --no-web-resources-cdn --dart-define=SUMMON_PROTECTED_PREVIEW=true --output /tmp/preview-resource-build
node tool/prepare_preview.mjs --ack-preview-build /tmp/preview-resource-build /tmp/preview-prepared-new
```

The output must be new, outside the input, with an existing real parent. The caller
attests this is the explicit preview build; the packager does not prove the Dart define
from minified JavaScript. Trusted quiescent local build files only; this is not a JS
sanitizer. It parses only the generated JSON buildConfig assignment, checks the fixed
Dart2JS/CanvasKit target and exact CanvasKit Wasm digest, then builds an external
bootstrap from the official loader. Any input contract change fails closed.

The independent output contains `site/`, the original OFL `FONT_LICENSE.txt`, and `PREPARATION_AUDIT.json`. Both input and
final asset collectors enforce 16 MiB per file and 64 MiB total. Only full CanvasKit
JS/Wasm, main JS, official loader and app assets are retained. No SW is registered.
The default root template is not overwritten. Preparation stages are removed on error;
existing outputs are never intentionally replaced. Do not concurrently mutate input or output.

Every audit says `deployable:false`. Default CSP still blocks Wasm/engine styles;
the separately opt-in render profile needs actual browser validation. No `unsafe-inline`,
`unsafe-eval`, wildcard workers or external CDN is enabled here. The fixed
`/font-fallback/` origin path is intentionally unbundled, so unsupported characters
get same-origin 404 rather than Google font requests. The full SC face is not all Unicode
or complete emoji coverage. Do not claim offline/browser/iPhone readiness from a build.
