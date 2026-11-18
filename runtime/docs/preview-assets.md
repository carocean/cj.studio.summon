# Private preview asset snapshot (host-only, not deployment)

`collectPreviewAssets(buildRoot, limits?)` in `src/preview-assets.js` takes a trusted,
quiescent host build directory and returns `{assets, audit}`. `assets` is an explicit
Map compatible with the gate's existing asset input. `index.html` maps to `/`;
other admitted paths map to their exact absolute URL. No request URL selects a file,
no HTTP server is created, and no existing gate/login/app file is changed. Files are
read without transformation. This module does not replace bootstrap, fonts, base
markup, CSP or transport configuration.

## Admission and limits

Root files are an exact allowlist: index.html, flutter_bootstrap.js, flutter.js,
main.dart.js, main.dart.wasm, main.dart.mjs, manifest.json, favicon.png, version.json.
Only assets/, icons/, canvaskit/ subtrees are scanned. Icons admit PNG only;
CanvasKit admits JS/Wasm only. Asset extensions have an explicit MIME table.
OTF/TTF, BIN, FRAG and assets/NOTICES use application/octet-stream, already accepted
by the gate; this does not guarantee font rendering on a browser.

Hidden files/directories, map/symbol artifacts and service-worker-named files are
excluded and reported, as are unlisted roots/types. Symlinks encountered during
admitted traversal, including root ancestors and excluded files at scanned levels,
are rejected, not followed. Unlisted/hidden directories are not traversed at all.
Special files and non-ASCII/space/percent/ambiguous path components are rejected.
Any double-dot substring is rejected, including a..js, to match the gate's exact
path admission rather than merely rejecting traversal components.
This conservative collector may reject a valid future Flutter plugin build;
extending an allowlist requires review rather than silently serving it.

Hard maximums (options may only lower): 512 admitted files, 16MiB each, 64MiB total,
2048 scanned directory entries, depth 16; each relative path <=512 characters.
Directory iteration is bounded before sorting. File reads use O_NOFOLLOW and a
size-bounded buffer, with inode/size/timestamp checks for ordinary concurrent
changes. Work with a trusted build tree that is not changing. These checks are not
an adversarial-filesystem sandbox or a platform-independent openat capability tree;
they cannot make an actively malicious host safe. Executable content is trusted
build output, not sanitized content. This is not a secret sanitizer: an admitted
assets/config.json containing credentials would be copied verbatim. The operator
must ensure the trusted build contains no secrets before collecting it. A captured Map is isolated from later file edits.

## Audit is not a readiness verdict

Audit contains SHA256, MIME, byte size and path for every admitted file, all excluded
paths with reasons, scan/byte totals and conservative findings. It always states
`deployable:false`. Literal URL/CDN/service-worker detection is a warning heuristic,
not proof that those code paths execute, and absence is not a network-isolation
proof. Preview-client activation and browser rendering remain explicitly unverified.

A read-only audit of the current `app/build/web` admitted 32 files / 34,194,789 bytes
and excluded nine hidden/debug/service-worker files (54 scanned entries). This is
an observation of that build, not a stable release manifest. It found base markup
incompatible with the current base-uri none, external/Google CDN or font literals,
service-worker bootstrap references and Wasm requiring actual CSP testing. Merely
excluding a worker file does not disable registration in the bootstrap. No CSP was
relaxed; no fonts replaced; preview was not enabled; no browser or network was used.

Tests use synthetic temporary directories for exact MIME/map/audit behavior,
unchanged source bytes, symlink/root-alias rejection, limits, path rejection and
missing entrypoints. Real build audit is read-only and not checked into the repo as
a runnable bundle or user data. Follow-up must deliberately prepare a private
bootstrap and assess actual browser requests before claiming usable preview.
