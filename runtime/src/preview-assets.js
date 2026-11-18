import {constants,lstatSync,realpathSync,opendirSync,openSync,fstatSync,readSync,closeSync} from 'node:fs';
import {resolve,join,relative,sep,extname,parse} from 'node:path';
import {createHash} from 'node:crypto';
const ROOT=new Set(['index.html','flutter_bootstrap.js','flutter.js','main.dart.js','main.dart.wasm','main.dart.mjs','manifest.json','favicon.png','version.json']);
const TYPES={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.wasm':'application/wasm','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.otf':'application/octet-stream','.ttf':'application/octet-stream','.bin':'application/octet-stream','.frag':'application/octet-stream'};
const fail=code=>{throw Object.assign(new Error(code),{code});};
const defaults={maxFiles:512,maxTotalBytes:64*1024*1024,maxFileBytes:16*1024*1024,maxScannedEntries:2048,maxDepth:16};
function reason(path){
 const parts=path.split('/');
 if(parts.some(p=>p.startsWith('.')))return 'dotfile';
 if(/\.(map|symbols)$/i.test(path))return 'debug-artifact';
 if(/service[_-]?worker/i.test(path))return 'service-worker';
 if(parts.length===1&&!ROOT.has(path))return 'unlisted-root';
 if(parts.length>1&&!['assets','icons','canvaskit'].includes(parts[0]))return 'unlisted-directory';
 if(parts[0]==='icons'&&extname(path)!=='.png')return 'unlisted-icon-type';
 if(parts[0]==='canvaskit'&&!['.js','.wasm'].includes(extname(path)))return 'unlisted-engine-type';
 if(!TYPES[extname(path)]&&path!=='assets/NOTICES')return 'unlisted-type';
 return null;
}
// Host-only snapshot of a trusted, quiescent build root. Never called with a URL.
// This does not sanitize executable assets or authorize deploying the application.
export function collectPreviewAssets(buildRoot,options={}){
 if(typeof buildRoot!=='string'||!buildRoot||Object.keys(options).some(k=>!Object.hasOwn(defaults,k)))fail('invalid_asset_configuration');
 const limits={...defaults,...options};for(const [key,max] of Object.entries(defaults))if(!Number.isSafeInteger(limits[key])||limits[key]<1||limits[key]>max)fail('invalid_asset_configuration');
 const root=resolve(buildRoot);let ancestor=parse(root).root;
 for(const part of root.slice(ancestor.length).split(sep).filter(Boolean)){ancestor=join(ancestor,part);if(lstatSync(ancestor).isSymbolicLink())fail('asset_symlink_forbidden');}
 if(!lstatSync(root).isDirectory()||realpathSync(root)!==root)fail('invalid_asset_root');
 const assets=new Map(),files=[],excluded=[],findings=new Set(['preview-client-activation-unverified','browser-csp-and-rendering-unverified']);let totalBytes=0,scanned=0;
 function walk(dir,depth){
  if(depth>limits.maxDepth)fail('asset_depth_limit');
  const names=[],directory=opendirSync(dir);try{let entry;while((entry=directory.readSync())){if(++scanned>limits.maxScannedEntries)fail('asset_scan_limit');names.push(entry.name);}}finally{directory.closeSync();}
  for(const name of names.sort()){
   const file=join(dir,name),path=relative(root,file).split(sep).join('/');
   if(path.length>512||path.includes('..')||!path.split('/').every(p=>/^[A-Za-z0-9_.-]+$/.test(p)&&p!=='.'&&p!=='..'))fail('invalid_asset_path');
   const stat=lstatSync(file);if(stat.isSymbolicLink())fail('asset_symlink_forbidden');
   if(stat.isDirectory()){if(name.startsWith('.')||depth===0&&!['assets','icons','canvaskit'].includes(name)){excluded.push({path,reason:'unlisted-directory'});continue;}walk(file,depth+1);continue;}
   if(!stat.isFile())fail('asset_special_file_forbidden');
   const why=reason(path);if(why){excluded.push({path,reason:why});continue;}
   if(files.length>=limits.maxFiles)fail('asset_file_limit');
   if(stat.size>limits.maxFileBytes)fail('asset_size_limit');if(totalBytes+stat.size>limits.maxTotalBytes)fail('asset_total_limit');
   const canonical=realpathSync(file);if(!canonical.startsWith(root+sep)||canonical!==file)fail('asset_symlink_forbidden');
   const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);let body;
   try{const before=fstatSync(fd);if(!before.isFile()||before.dev!==stat.dev||before.ino!==stat.ino||before.size!==stat.size)fail('asset_changed');const buffer=Buffer.alloc(stat.size+1);let count=0,n;while(count<buffer.length&&(n=readSync(fd,buffer,count,buffer.length-count,null))>0)count+=n;body=buffer.subarray(0,count);const after=fstatSync(fd);if(body.length!==stat.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)fail('asset_changed');}finally{closeSync(fd);}
   const url=path==='index.html'?'/':'/'+path,type=TYPES[extname(path)]??'application/octet-stream';
   assets.set(url,{body,type});totalBytes+=body.length;
   files.push({path,url,type,bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')});
   if(['.html','.js','.mjs','.json'].includes(extname(path))){const text=body.toString('utf8');
    if(path==='index.html'&&/<base\b/i.test(text))findings.add('base-element-conflicts-with-base-uri-none');
    if(/https?:\/\//.test(text))findings.add('external-url-literals-require-review');
    if(/gstatic\.com|googleapis\.com/.test(text))findings.add('google-cdn-or-font-literals-require-review');
    if(/serviceWorker|service_worker/.test(text))findings.add('service-worker-code-requires-disabled-bootstrap');
   }
   if(extname(path)==='.wasm')findings.add('wasm-compilation-csp-unverified');
  }
 }
 walk(root,0);
 if(!assets.has('/')||!assets.has('/flutter_bootstrap.js'))fail('asset_entrypoint_missing');
 return {assets,audit:{schema:'preview-assets-audit.v1',deployable:false,files,totalBytes,scannedEntries:scanned,excluded,findings:[...findings].sort()}};
}
