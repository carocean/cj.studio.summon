import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {collectPreviewAssets} from '../src/preview-assets.js';
function fixture(run){const root=mkdtempSync(join(tmpdir(),'preview-assets-'));const put=(p,v='x')=>{mkdirSync(join(root,p,'..'),{recursive:true});writeFileSync(join(root,p),v)};put('index.html','<base href="/">');put('flutter_bootstrap.js','https://www.gstatic.com/font serviceWorker');try{return run(root,put);}finally{rmSync(root,{recursive:true,force:true});}}
test('exact private map, MIME, stable audit, excludes debug/offline/hidden/unlisted material without rewriting input',()=>fixture((root,put)=>{
 put('main.dart.js');put('canvaskit/canvaskit.wasm');put('assets/fonts/local.otf');put('assets/AssetManifest.bin');put('assets/shaders/effect.frag');put('assets/NOTICES');put('icons/Icon.png');
 for(const p of ['flutter.js.map','canvaskit/canvaskit.js.symbols','flutter_service_worker.js','.last_build_id','assets/.secret','private/secret.json','random.js'])put(p,'excluded');
 const {assets,audit}=collectPreviewAssets(root);assert.equal(audit.deployable,false);assert.equal(assets.get('/assets/fonts/local.otf').type,'application/octet-stream');assert.equal(assets.get('/canvaskit/canvaskit.wasm').type,'application/wasm');assert.equal(assets.get('/').body.toString(),'<base href="/">');assert.equal(readFileSync(join(root,'index.html'),'utf8'),'<base href="/">');assert.equal(audit.excluded.length,7);assert.equal(assets.size,9);assert.ok(audit.findings.includes('google-cdn-or-font-literals-require-review'));assert.ok(audit.findings.includes('base-element-conflicts-with-base-uri-none'));assert.deepEqual(collectPreviewAssets(root).audit,audit);
}));
test('reject symlink files, directories, and root aliases',()=>fixture((root,put)=>{
 symlinkSync(join(root,'index.html'),join(root,'evil.js'));assert.throws(()=>collectPreviewAssets(root),{code:'asset_symlink_forbidden'});rmSync(join(root,'evil.js'));symlinkSync(root,join(root,'assets'));assert.throws(()=>collectPreviewAssets(root),{code:'asset_symlink_forbidden'});assert.throws(()=>collectPreviewAssets(join(root,'assets')),{code:'asset_symlink_forbidden'});
}));
test('bounded scan, files, bytes, depth and configuration',()=>fixture((root,put)=>{
 for(const [option,value,code] of [['maxFiles',1,'asset_file_limit'],['maxFileBytes',1,'asset_size_limit'],['maxTotalBytes',1,'asset_total_limit'],['maxScannedEntries',1,'asset_scan_limit']])assert.throws(()=>collectPreviewAssets(root,{[option]:value}),{code});
 put('assets/a/b/test.bin');assert.throws(()=>collectPreviewAssets(root,{maxDepth:1}),{code:'asset_depth_limit'});
 for(const options of [{maxFiles:513},{maxFileBytes:Infinity},{path:'x'},{maxDepth:0}])assert.throws(()=>collectPreviewAssets(root,options),{code:'invalid_asset_configuration'});
}));
test('reject ambiguous path names and absent entrypoint',()=>fixture((root,put)=>{
 put('assets/space name.bin');assert.throws(()=>collectPreviewAssets(root),{code:'invalid_asset_path'});rmSync(join(root,'assets/space name.bin'));rmSync(join(root,'index.html'));assert.throws(()=>collectPreviewAssets(root),{code:'asset_entrypoint_missing'});
}));

test('reject double-dot names also rejected by the gate, without widening its path policy',()=>fixture((root,put)=>{
 put('assets/a..js');assert.throws(()=>collectPreviewAssets(root),{code:'invalid_asset_path'});
}));
