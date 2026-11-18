// External script only. Fixed root deployment; no URL/query-configurable endpoint.
// Omit service worker settings; do not register a service worker.
const nonceTags = document.querySelectorAll('meta[name="summon-preview-style-nonce"]');
const nonce = nonceTags.length === 1 ? nonceTags[0].content : '';
if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw new Error('preview_style_nonce_required');
_flutter.loader.load({
  nonce,
  config: {
    nonce,
    renderer: 'canvaskit',
    canvasKitVariant: 'full',
    canvasKitBaseUrl: '/canvaskit/',
    entrypointBaseUrl: '/',
    assetBase: '/', // Flutter AssetManager itself appends assets/
    fontFallbackBaseUrl: '/font-fallback/'
  }
});
