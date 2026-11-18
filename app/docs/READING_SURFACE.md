# Explicit local read-only surface

`ReadingSurface(resource:, readingState:, fontCapabilities:)` is an independently
supplied widget, not a Home entry, book application or resource provider. There is no
HTTP client, model adapter, owner/context authority, durable progress or save operation.
It does not modify the supplied state, even after manual scrolling. A future host must
explicitly provide/revalidate resources, authorize state transitions and decide whether
to persist progress. Returning to this widget makes the supplied canonical anchor visible;
it does not claim that a later manually scrolled position was recorded.

The Dart validators mirror `runtime/src/reading-surface.js` C1 schemas and size/scalar
bounds. `generate_reading_vectors.mjs` produces checked-in vectors using that actual
Node implementation. Content digests identify supplied literal blocks, not downloaded
raw source bytes or verified book editions. The synthetic examples are not real books.

Only `flow:scroll` with `pageControls:false` is implemented. Other requested flows or
controls display a clear unsupported message, never fake character-count pagination
or fabricated buttons. The current renderer accepts only registered `SummonPreviewSC`
when explicitly present in host-supplied font capabilities. Unsupported fonts preserve
the external state but do not silently render the document in a substituted font.
Availability claims and font registration are not evidence of complete Unicode coverage;
the SC face has missing emoji/extended characters. Unsupported presentation notices
are UI text, not a claim that the requested document font was loaded.

Blocks are joined with two presentation-only newlines. The canonical block/scalar offset
is converted to UTF-16 only for Flutter layout. A TextPainter and the rendered RichText
share exact text, style, width, scaler and direction. Position is computed from actual
layout, not page number or fixed character width. Scalar positions inside a combining
grapheme remain unchanged; caret layout may show the whole glyph. No segmentation
or glyph completeness claim follows from scalar-valid data. The renderer uses literal
TextSpan content without recognizers, HTML, templates or executable URLs.

Each pending post-frame scroll is bound to the validated resource digest/state revision,
input generation, viewport/style signature and route/lifecycle epoch. Superseded, hidden,
background or disposed callbacks cannot apply a stale position. Reflow and explicit
return recalculate where the same anchor should be visible; neither rewrites it.

Tests load the existing local SC asset, use real RenderParagraph/TextPainter geometry
at different widths/heights and scales, and assert the anchor is inside the viewport.
They also exercise replacement, unavailable font/flow, lifecycle, literal markup and
malformed schemas. The no-business-HTTP test only covers this widget's operations. It
is not a browser engine network audit: Web fallback fonts and CSP behavior remain a
separate verification task. No real-model, browser, source-license, camera or gesture
verification is claimed by this slice.

The geometry tests preload the bundled SC face before layout. Arbitrary asynchronous
font installation/replacement after first layout is not part of this slice: no font-load
generation is tracked, so those changes are not yet proven to preserve anchor visibility.
The host must not treat a capability ID as proof that an arbitrary late-loaded font has
settled. Adding such a font lifecycle is a separate tested integration step.

`test/reading_compile_probe.dart` is an explicit compile-only target containing
an encoded copy of the first Node synthetic vector. It is not a default route,
a deployed reader, or browser runtime acceptance. Default application builds may
tree-shake this standalone surface; the probe separately checks Web compilation.
