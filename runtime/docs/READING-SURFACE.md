# Pure reading surface, v1

This module is a small **synthetic-tested, device-neutral state contract**, not a
reader application. It has no HTTP, resource acquisition, model inference, font
download, rendering, pagination engine, command query/deduplication, authentication,
permission grant, clock, storage or gesture/camera integration. Nothing here proves
that a person read text. The existing temporary form schemas and sessions are unchanged.

## API

- `compileReadingResource(declaration)` makes a deeply frozen compiled resource.
- `validateReadingResource(resource)` recomputes and verifies its content digest.
- `createReadingState(resource, presentation, capabilities)` requires explicit host
  font capabilities; returns revision 1 at offset 0 of the first block.
- `validateReadingState(resource, state)` validates structure and exact resource
  identity/version. It deliberately does **not** check current font availability.
- `validateReadingPresentationCapabilities(presentation, capabilities)` separately
  rejects unavailable fonts without rewriting or destroying an existing state.
- `updateReadingPresentation(resource, state, {expectedRevision, changes}, capabilities)`
  changes only presentation and increments revision. The anchor stays exactly equal.
- `updateReadingAnchor(resource, state, {expectedRevision, anchor})` changes only the
  anchor and increments revision. Presentation stays exactly equal. This pure operation
  does not assert that text can currently be rendered or that the caller is authorized.

All returned values are C1 snapshots. Inputs are never mutated, even on failure. The
CAS here is a **pure version comparison**, not an atomic database commit. A future host
must apply owner/context authority, atomic CAS, command IDs/unknown-result recovery,
resource access policy and any explicitly authorized persistence. No such layer is
implemented by these functions.

## Resource declaration

```
{
  schema: 'reading-resource.v1',
  resourceId: 'synthetic-a',
  provenance: {kind: 'host-declared', referenceId: 'synthetic-fixture'},
  blocks: [{id: 'opening', text: '天地😀é。'}]
}
```

Resource IDs and block IDs are bounded ASCII identifiers. Block IDs are unique within
one exact content version. A compiled resource has schema `compiled-reading-resource.v1`,
`contentDigest` and `authorityGranted:false`. The digest uses the C1 `reading-content`
domain over `{resourceId, blocks}` in order. It identifies **these supplied scalar
strings**, not a downloaded raw file, historical edition or copyright clearance.
Changing the provenance claim alone does not change text identity. Provenance is only
a trusted caller's declaration; it is not source verification or permission evidence.

There is no normalization, trimming, newline conversion, HTML parsing or URL execution.
Markup-looking text and URLs inside a text block remain literal data. Lone surrogates,
C0 controls except tab/LF/CR, DEL and C1 controls are rejected. A future renderer must
preserve literal-only behavior, not interpret blocks as rich HTML or executable links.

Limits: 48 KiB canonical resource snapshot (input and compiled), 1–64 blocks,
1–2000 Unicode scalars per block, 8000 scalars in total. C1's independent per-string,
depth and aggregate limits also apply. This is a bounded excerpt, **not an entire
arbitrarily large book**. It does not chunk or silently truncate oversized input.

## State and position

```
{
  schema: 'reading-state.v1', resourceId, contentDigest, revision,
  anchor: {blockId, scalarOffset},
  presentation: {
    background: '#ffffff', fontRef: 'synthetic-sc',
    textScalePermille: 1000, flow: 'scroll', pageControls: false
  }
}
```

State and request snapshots are bounded to 4 KiB. Revision is a positive safe integer;
overflow rejects rather than wraps. A resource ID/digest mismatch rejects, never
silently migrates or resets a bookmark. Changing content therefore requires a new state
or a separately designed explicit migration, not reusing a stale offset by guesswork.

`scalarOffset` is an integer from zero **through the block's scalar length**, inclusive.
End-of-block is valid and not silently normalized to the next block. Emoji outside the
BMP count once, unlike UTF-16 code units. A scalar boundary is **not a grapheme boundary**:
in `e\u0301`, offset 1 is valid but lies within one displayed grapheme. A renderer may
show the preceding whole grapheme to keep that anchor visible, without rewriting the
canonical position. Unicode grapheme segmentation and visual layout are not implemented.

Page ordinals, pixel offsets, viewport width/height and pagination caches are deliberately
absent. Different viewports can place one canonical anchor on different visual pages.
The tests include a clearly synthetic scalar-width projection to demonstrate this;
it is not real typography or proof that Flutter currently paginates. Showing page
controls is a declaration only. No controls, movement or collection happen by default.

## Presentation and fonts

Background accepts exactly `#RRGGBB` hexadecimal digits, not CSS/color names/URLs.
The future host/renderer must choose a readable contrasting foreground. Font IDs are
bounded identifiers; the caller provides `{installedFontIds:[...]}` with at most 16
unique IDs. This list is an explicit compatibility claim, not proof of installation,
font loading, licensing or glyph coverage. Unsupported fonts (including unverified
clerical-script/隶书 fonts) reject; there is no substitution disguised as success.

Font availability may change after state creation. State validation still preserves
its original font and anchor; the separate capability check reports unsupported. A
future host can show a retained read-only copy or a clear unsupported state. It must
not silently replace a font or clear progress. Presentation edits require the resulting
font to be in the current supplied capability list. Scalar position validity is
independent of font availability.

Scale is an integer 800–2000 permille. Flow is `scroll` or `paged`; pageControls is a
boolean. Partial presentation changes must be nonempty and contain only these fields.
Changing pink background, font, scale, flow or page-controls visibility never changes
the anchor. Request fields cannot inject an owner, URL, handler, page number or pixel
position. There are no cover-image or gesture mappings in this first slice.

## Evidence boundary

`reading-surface.test.js` uses two explicitly synthetic documents, emoji/combining
characters, bounded text, malformed C1 values, CAS/overflow/version rejection and
unchanged-state checks. No public source was downloaded or represented as verified.
No Flutter reading UI, book provider, durable progress, model understanding or camera
consent is claimed by this module.
