# Protected preview gate (not deployed / not production authentication)

`createProtectedPreview(options)` in `src/protected-preview.js` returns a Node HTTPS request handler. Attach it directly to an HTTPS server using a valid certificate for the configured exact `origin`. `handler.close()` invalidates sessions and refuses subsequent requests. No existing startup/server/Flutter code has been changed by this module.

## Host-only configuration

- `origin`: exact HTTPS origin, including non-default port. No path/query.
- `invitation`: host-injected secret, generated externally from **at least 32 cryptographically random bytes** (e.g. base64url). Minimum 43 characters is checked, but entropy cannot be verified. Tests use synthetic constants, NOT safe deployment credentials. Never place this value in URLs, logs, repo, static JavaScript, or browser storage. Rotate by recreating the gate.
- `upstream`: fixed `http://127.0.0.1:PORT`; localhost/DNS, remote hosts, userinfo, queries and paths are refused. Operator must separately verify the upstream listener is bound only to loopback. This module cannot inspect remote process bind configuration.
- `assets`: trusted host Map of exact URL paths to `{body: Buffer, type: MIME}`. Assets are copied and only served after session authentication. No filesystem path resolution, arbitrary URL fetch, or client-chosen proxy destinations. Flutter assets still need an audited build and integration; service-worker offline caching is not configured or approved by this module.
- `ttlMs`: fixed absolute lifetime, default 15 minutes, maximum 30. Uses monotonic performance clock, no sliding refresh. Injected-clock observed rollback invalidates the session.
- `maxConcurrent`: default 4, max 8; global request limit. `upstreamTimeoutMs`: default 30 seconds, max 60; upstream socket timeout plus bounded total handler deadline.

## Client contract

Public `GET /preview/login` returns a minimal cold-start HTML form. Its only executable resource is fixed same-origin `GET /preview/login.js`, also public. No private App assets are public. This is not yet a complete iPhone launch flow.

1. Same-origin `POST /preview/login`, `Content-Type: application/json`, exact body `{ "invitation": "..." }`. Extra fields fail. Response `{csrf,expiresInMs}` sets a single-owner random session cookie `__Host-summon_preview` with `HttpOnly; Secure; SameSite=Strict; Path=/`. Each successful login replaces the previous session. Cookie never contains invitation or owner ID.
2. Authenticated `GET /preview/session` returns current `{csrf,expiresInMs}`. Browser should keep CSRF in memory; no URL credentials. No CORS is provided.
3. Every private POST must send `X-Preview-CSRF: <csrf>` and exact matching Origin, plus JSON. GET may omit Origin for browser navigation but rejects mismatches and cross-site Fetch Metadata. Client supplies neither upstream auth nor owner selection.
4. `POST /preview/logout`, body `{}`, CSRF required, clears cookie and invalidates session. Expiry, logout, gate close, process restart and successful replacement login invalidate previous cookie. Exceeding global login limit (5 attempts per minute, including successes) rejects further login attempts until window reset, but does not invalidate the existing owner session. Unauthenticated failed attempts must not force the owner to log out.

All URLs with query parameters, unknown methods/paths, traversal-like paths, unexpected authorization/proxy headers and forwarded-host/proto headers are rejected. `X-Forwarded-*` never grants TLS/host authority. All responses are no-store; frame embedding blocked. The fixed proxy forwards only its own host/content headers and `X-Summon-Lab: synthetic`; it never forwards Cookie, Authorization or incoming owner headers. Owner/principal selection fields within JSON are rejected recursively. Upstream redirects are rejected, not followed. Response content must be JSON and <=8MiB. Private POST limit 4KiB, interaction-edit 128KiB, textgen-generate 64KiB, login 1KiB. Sensory uploads are not exposed. Limits count transmitted bytes, including JSON/base64 overhead. UTF-8 is decoded strictly before JSON parsing: malformed sequences are rejected, never silently replaced before forwarding.

## Boundaries / deployment blockers

This is an in-memory **single demo owner** gate, not multi-user identity, production authentication, MFA or brute-force/DoS resilience. Global throttling can deny the legitimate user too. TLS handshake/header/socket limits must also be configured on the actual HTTPS server. Existing loopback HTTP app must never be exposed separately. Upstream credential/session status is not trusted from headers.

Logout/expiry stops subsequent dispatch and suppresses results from in-flight upstream calls; it cannot undo a mutation already dispatched. Do not describe that as transaction cancellation. Browser caching, compromised same-origin scripts/XSS, phone theft, invitation recovery/rotation UX, audit policy, device media permission/consent and incident response are not solved. HTTPS hosting, DNS, valid public TLS, trusted deployment process and availability are unverified. Do not ask the user to bypass a certificate warning.

Phone media uploaded to a hosted server is **server-side processing**, not “stays on your iPhone”. Authentication does not replace clear capture consent or retention policy.

## Verification

`node --test runtime/test/protected-preview.test.js`

Tests create ephemeral self-signed localhost certificate files in a temporary directory, and supply that certificate explicitly as CA to the test HTTPS client. Certificate and hostname checks stay enabled. No browser TLS warning bypass or OS trust-store modification. Fake loopback upstream, synthetic invitation only; no public service starts.

Coverage: private asset/API gate; TLS hostname and trusted test CA; same-origin checks; secret query rejection; extra login field rejection; session and cookie flags; CSRF; no credential forwarding; owner rejection; fixed routes; redirect rejection; body bound; concurrency and upstream timeout; logout, expiry, restart, failed-login throttling without owner-session eviction and observed clock rollback.

Security references: [OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html), [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [Node HTTPS](https://nodejs.org/api/https.html), [Node TLS socket](https://nodejs.org/api/tls.html#tlssocketencrypted). SameSite is defense in depth, not a replacement for CSRF checks.

## Flutter compatibility not yet verified

The current restrictive CSP and exact asset routing have **not** been tested with a built Flutter App. WebAssembly compilation, blob audio playback, camera/media use and Flutter CanvasKit external-CDN loading may be blocked. This gate cannot yet be described as hosting the complete App. Future integration must build and serve trusted local resources and selectively declare the required CSP directives after real-browser testing, not loosen policy to wildcard sources or broadly unsafe execution. The current user trial is a remote cloud simulator; this independent gate is not connected to startup or public hosting.


## Bounded text integration slice

The gate now explicitly allows GET `/scene/usage` and `/scene/interaction-current`,
and POST `/scene/usage-select`, `/scene/usage-presented`, `/scene/usage-query`,
`/scene/interaction-read`, `/scene/interaction-edit`, `/scene/interaction-save`,
`/scene/interaction-query`, `/scene/interaction-close`, `/scene/interaction-saved`.
GET `/scene/state` is also allowed. Together with the text-generation routes below, these are the complete scene routes for this
text-only gate, not a wildcard proxy. The prototype's prior media, market,
legacy selection and other action routes are now denied, with no legacy mode.
Only interaction-edit receives the upstream's 128KiB transport allowance. Host
C1, field lengths, command CAS, confirmation and owner checks remain authoritative;
a request fitting the HTTP cap is not necessarily a valid host request.

Media/speech/sensory capabilities, hearing interaction-generate, create/revise, handoff and legacy text-request/text-entry are
not exposed in this slice. Tests install a host-only synthetic declaration before
serving it; that is not model generation or a phone-created session. A saved-note
read is not a usage count and does not add saved-note shortcuts. Closing a session
does not revoke access to its explicitly saved local note.

The additional test connects this actual TLS gate to actual createSceneServer and
an isolated SceneLab. It covers empty usage, bound presentation/replay/query,
explicit creature selection, a >4KiB multibyte text edit, explicit save/replay/query,
readSaved, close, strict UTF-8, separate request limits, denied routes, CSRF,
foreign origin, owner injection and logout. Original prototype security scenarios remain, using the narrower text routes.
Certificates are temporary and trusted only by the test client. No public network,
user data, models, phone capture or deployment is involved.

This backend does not integrate or launch Flutter's transport or private build. It does not validate Safari media, Flutter CSP/static assets, production
TLS lifecycle or public hosting. It must not be presented as an iPhone-ready app.

Async session regression tests in `test/protected-preview-races.test.js` verify
that a slow old-session logout cannot revoke a replacement login or clear its
cookie. Logout rechecks session identity after reading its body. They also cover
replacement-login response suppression, expiry before dispatch, duplicate cookies,
strict UTF-8, disconnect abort and clock rollback, with isolated trusted local TLS.


## Cold-start login shell

The public HTML and script are fixed module bytes, not templates containing the
invitation or configurable redirects. No inline script/style, third-party asset,
base element or relaxed CSP is needed. A submit handler sends JSON only on explicit
submission, using same-origin credentials and redirect:error. The input has no
HTML name, so a script-disabled/native form fallback cannot serialize its secret.
The button starts disabled until the handler is installed. Browser autofill cannot
be universally controlled; autocomplete is disabled but is not an assurance about
browser/password-manager behavior.

The input is cleared upon submission and successful login navigates only to `/`.
The App must independently GET `/preview/session` and keep its CSRF in memory.
There is no storage, URL token, console logging or automatic retry. Fixed text
errors do not reflect server messages. Double submission is suppressed; timeout
aborts, and pagehide/pageshow retire late fetch/JSON completions so they cannot
navigate a newer page lifecycle. Abort does not promise rollback of a login already
processed by the server.

This shell is for cold start, not recovery: an already-running App must preserve
its dirty draft and reauthenticate in place on 401 rather than redirect here.
No draft persistence, private asset directory, Flutter initialization, iPhone
browser verification or deployment is implemented by this shell. Tests execute
its script with a minimal DOM harness plus real trusted local TLS resource checks;
that is not a real-browser CSP or accessibility verification.


## Explicit text generation routes (default unavailable)

GET /scene/textgen-state and POST /scene/textgen-generate, /scene/textgen-query,
/scene/textgen-cancel are now explicit protected routes. Only generate has a64KiB
request allowance; query/cancel retain4KiB. Trusted host configuration and an
explicit host policy enable are separately required; HTTP cannot enable/configure
models. See text-interaction-generation.md for exact status/TTL/unknown-result
semantics. This does not expose the hearing interaction-generate or sensory paths.
Disconnect/timeout is not cancel. A cancel-before-admission not_started result is
not a tombstone and cannot prevent a later-arriving generation. Existing gate
session expiry suppresses delivery but cannot undo an already dispatched command.
