import {randomBytes} from 'node:crypto';
import {types} from 'node:util';

// Trusted host opt-in only. This is a preparation contract, not browser validation.
export const PREVIEW_RENDER_KIND='flutter-canvaskit-v1';
export const PREVIEW_STYLE_NONCE_TOKEN='__SUMMON_PREVIEW_STYLE_NONCE__';
export const PREVIEW_RENDER_HTML=`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="summon-preview-style-nonce" content="${PREVIEW_STYLE_NONCE_TOKEN}">
<title>Summon · 唤起</title>
</head>
<body>
<script src="/flutter_bootstrap.js" defer></script>
</body>
</html>
`;
export const DEFAULT_PREVIEW_CSP="default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const fail=()=>{throw new Error('invalid_preview_render_profile');};
export function prepareRenderProfile(profile,assets){
 if(profile===null)return null;
 if(!profile||typeof profile!=='object'||types.isProxy(profile)||![Object.prototype,null].includes(Object.getPrototypeOf(profile)))fail();
 const descriptors=Object.getOwnPropertyDescriptors(profile),keys=Reflect.ownKeys(profile);
 if(keys.length!==1||keys[0]!=='kind'||!Object.hasOwn(descriptors.kind,'value')||!descriptors.kind.enumerable||descriptors.kind.value!==PREVIEW_RENDER_KIND)fail();
 const html=assets.get('/'),bootstrap=assets.get('/flutter_bootstrap.js');
 if(!html||html.type!=='text/html'||!html.body.equals(Buffer.from(PREVIEW_RENDER_HTML))||!bootstrap||!['text/javascript','application/javascript'].includes(bootstrap.type)||bootstrap.body.length===0)fail();
 // Never grant a nonce to arbitrary host HTML or aliases of the root document.
 for(const [path,asset] of assets)if(path!=='/'&&asset.type==='text/html')fail();
 return Object.freeze({kind:PREVIEW_RENDER_KIND,deployable:false});
}
export function renderPrivateDocument(){
 const nonce=randomBytes(32).toString('base64url');
 return {body:Buffer.from(PREVIEW_RENDER_HTML.replace(PREVIEW_STYLE_NONCE_TOKEN,nonce)),
  csp:DEFAULT_PREVIEW_CSP+`; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'nonce-${nonce}'; worker-src 'none'`};
}
