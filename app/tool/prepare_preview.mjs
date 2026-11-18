import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,renameSync,rmSync,existsSync,realpathSync,lstatSync} from 'node:fs';
import {resolve,dirname,join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {collectPreviewAssets} from '../../runtime/src/preview-assets.js';
import {PREVIEW_RENDER_HTML,PREVIEW_RENDER_KIND} from '../../runtime/src/preview-render-profile.js';
const here=dirname(fileURLToPath(import.meta.url));
const fail=code=>{throw Object.assign(new Error(code),{code});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
// Parse only the official generated JSON assignment. Never evaluate build JS.
export function parseBuildConfig(text){
 const lines=text.split('\n').filter(line=>line.startsWith('_flutter.buildConfig = '));
 if(lines.length!==1||!lines[0].endsWith(';'))fail('build_config_assignment');
 let c;try{c=JSON.parse(lines[0].slice('_flutter.buildConfig = '.length,-1));}catch{fail('build_config_json');}
 if(!exact(c,['engineRevision','useLocalCanvasKit','wasmHashes','builds'])||! /^[0-9a-f]{40}$/.test(c.engineRevision)||c.useLocalCanvasKit!==true)fail('build_config_not_local');
 if(!Array.isArray(c.builds)||c.builds.length!==2||!exact(c.builds[0],['compileTarget','renderer','mainJsPath'])||c.builds[0].compileTarget!=='dart2js'||c.builds[0].renderer!=='canvaskit'||c.builds[0].mainJsPath!=='main.dart.js'||!exact(c.builds[1],[]))fail('build_config_target');
 const allowed=new Set(['canvaskit.wasm','chromium/canvaskit.wasm','webparagraph/canvaskit.wasm','skwasm.wasm','skwasm_heavy.wasm','wimp.wasm']);
 if(!c.wasmHashes||typeof c.wasmHashes!=='object'||Array.isArray(c.wasmHashes)||!Object.hasOwn(c.wasmHashes,'canvaskit.wasm')||Object.entries(c.wasmHashes).some(([k,v])=>!allowed.has(k)||typeof v!=='string'||!/^[0-9a-f]{64}$/.test(v)))fail('build_config_hashes');
 return {engineRevision:c.engineRevision,useLocalCanvasKit:true,wasmHashes:{'canvaskit.wasm':c.wasmHashes['canvaskit.wasm']},builds:c.builds};
}
export function preparePreview(buildRoot,destination,{previewBuildAcknowledged=false}={}){
 if(previewBuildAcknowledged!==true)fail('preview_build_ack_required');
 const input=collectPreviewAssets(buildRoot);
 const root=realpathSync(buildRoot),dest=resolve(destination),parent=dirname(dest);
 if(existsSync(dest))fail('destination_exists');
 // Existing real parent only; never write through symlink ancestors.
 if(realpathSync(parent)!==parent||!lstatSync(parent).isDirectory())fail('destination_parent');
 if(dest===root||dest.startsWith(root+sep)||root.startsWith(dest+sep))fail('destination_overlaps_build');
 // Input and output collectors both enforce the existing 16 MiB / 64 MiB limits.
 const get=url=>{const a=input.assets.get(url);if(!a)fail('required_asset_missing');return a.body;};
 const config=parseBuildConfig(get('/flutter_bootstrap.js').toString('utf8'));
 if(sha(get('/canvaskit/canvaskit.wasm'))!==config.wasmHashes['canvaskit.wasm'])fail('canvaskit_hash_mismatch');
 get('/main.dart.js');get('/flutter.js');get('/canvaskit/canvaskit.js');
 const stage=mkdtempSync(join(parent,'.preview-preparation-'));
 try{
  const site=join(stage,'site');mkdirSync(site);
  for(const [url,asset] of input.assets){
   if(!(['/flutter.js','/main.dart.js','/canvaskit/canvaskit.js','/canvaskit/canvaskit.wasm'].includes(url)||url.startsWith('/assets/')))continue;
   const file=join(site,url.slice(1));mkdirSync(dirname(file),{recursive:true});writeFileSync(file,asset.body,{flag:'wx'});
  }
  const bootstrap=Buffer.concat([get('/flutter.js'),Buffer.from('\nif (!window._flutter) window._flutter = {};\n_flutter.buildConfig = '+JSON.stringify(config)+';\n'),readFileSync(join(here,'../preview/bootstrap-load.js'))]);
  writeFileSync(join(site,'flutter_bootstrap.js'),bootstrap,{flag:'wx'});
  writeFileSync(join(site,'index.html'),PREVIEW_RENDER_HTML,{flag:'wx'});
  const final=collectPreviewAssets(site);
  const license=readFileSync(join(here,'../assets/fonts/LICENSE.noto-cjk.txt'));
  if(license.length>65536)fail('font_license_size');
  writeFileSync(join(stage,'FONT_LICENSE.txt'),license,{flag:'wx'});
  const audit={...final.audit,fontLicense:{path:'FONT_LICENSE.txt',bytes:license.length,sha256:sha(license)},preparationSchema:'summon-preview-preparation.v1',renderProfileKind:PREVIEW_RENDER_KIND,deployable:false,previewCompileOptIn:'caller-acknowledged-not-inspected',defaultWebTemplateUnchanged:true,renderer:'canvaskit-full',serviceWorkerRegistration:false,fontFallback:{base:'/font-fallback/',bundled:false,expected:'same-origin-404-for-unbundled-glyphs',completeEmojiSupport:false},blockers:['default-csp-blocks-wasm-and-engine-styles','opt-in-csp-nonce-browser-verification-required','browser-rendering-not-tested'],sourceBuildConfig:config};
  writeFileSync(join(stage,'PREPARATION_AUDIT.json'),JSON.stringify(audit,null,2)+'\n',{flag:'wx'});
  // Atomic publish only after complete bounded collection; existing outputs never replaced.
  if(existsSync(dest))fail('destination_exists');renameSync(stage,dest);
  return audit;
 }catch(error){rmSync(stage,{recursive:true,force:true});throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==5||process.argv[2]!=='--ack-preview-build')throw Error('usage: prepare_preview.mjs --ack-preview-build INPUT_BUILD NEW_OUTPUT');
 const audit=preparePreview(process.argv[3],process.argv[4],{previewBuildAcknowledged:true});
 console.log(JSON.stringify({deployable:false,totalBytes:audit.totalBytes,files:audit.files.length}));
}
