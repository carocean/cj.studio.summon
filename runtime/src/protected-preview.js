import {DishConfirmationHost} from './dish-confirmation.js';
import {DEFAULT_PREVIEW_CSP,prepareRenderProfile,renderPrivateDocument} from './preview-render-profile.js';
import {loginHtml,loginScript} from './preview-login.js';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { performance } from 'node:perf_hooks';
const DISH_CONFIRMATION = new Set(['/scene/dish-confirmation-read','/scene/dish-confirmation-respond','/scene/dish-confirmation-invalidate']);
const COOKIE = '__Host-summon_preview';
const GET = new Set(['/scene/reading-state', '/scene/textgen-state', '/scene/state', '/scene/usage', '/scene/interaction-current']);
const POST = new Set(['dish-read','dish-command','reading-open','reading-read','reading-query','reading-close','textgen-generate','textgen-query','textgen-cancel','usage-select','usage-presented','usage-query','interaction-read','interaction-edit','interaction-save','interaction-query','interaction-close','interaction-saved'].map(p=>'/scene/'+p));
// Explicit transport caps; host C1/value validation remains independently stricter.
const POST_LIMITS = new Map([...POST].map(path=>[path,path==='/scene/interaction-edit'?128*1024:path==='/scene/textgen-generate'?64*1024:4096]));
const hash = text => createHash('sha256').update(text).digest();
const equal = (a,b) => typeof a === 'string' && timingSafeEqual(hash(a),hash(b));
const error = (code,status=400) => Object.assign(new Error(code),{status});
function noOwner(value) {
 if (!value || typeof value !== 'object') return;
 for(const [k,v] of Object.entries(value)) { if (/^(owner|ownerId|principal|principalId|authorization|headers|upstream)$/i.test(k)) throw error('owner_selection_forbidden'); noOwner(v); }
}
/** Direct TLS single-owner preview only. No reverse-proxy trust, accounts or public hosting. */
export function createProtectedPreview({origin,invitation,upstream,assets=new Map(),renderProfile=null,ttlMs=15*60*1000,clock=()=>performance.now(),maxConcurrent=4,upstreamTimeoutMs=30000,dishConfirmation=null}={}) {
 const publicUrl=new URL(origin),target=new URL(upstream);
 if(publicUrl.protocol!=='https:'||publicUrl.origin!==origin||publicUrl.username||publicUrl.password||typeof invitation!=='string'||invitation.length<43||invitation.length>256||target.protocol!=='http:'||target.hostname!=='127.0.0.1'||!target.port||target.pathname!=='/'||target.search||target.hash||target.username||target.password||!Number.isInteger(ttlMs)||ttlMs<1||ttlMs>1800000||!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>8||!Number.isInteger(upstreamTimeoutMs)||upstreamTimeoutMs<1||upstreamTimeoutMs>60000)throw error('invalid_preview_configuration');
 if(dishConfirmation!==null&&!(dishConfirmation instanceof DishConfirmationHost))throw error('invalid_dish_confirmation_configuration');
 const dishChannel=dishConfirmation?.userChannel();
 const retireDish=()=>dishChannel?.invalidate().catch(()=>{});
 const privateAssets=new Map();
 for(const [path,a] of assets){if(!/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]*$/.test(path)||path.includes('..')||path.startsWith('/scene/')||path.startsWith('/preview/')||!Buffer.isBuffer(a.body)||a.body.length>16*1024*1024||!['text/html','text/javascript','application/javascript','application/json','application/wasm','text/css','image/png','image/svg+xml','font/woff2','application/octet-stream'].includes(a.type))throw error('invalid_preview_asset');privateAssets.set(path,{body:Buffer.from(a.body),type:a.type});}
 const rendering=prepareRenderProfile(renderProfile,privateAssets);
 let session=null,active=0,lastTime=clock(),windowStart=lastTime,attempts=0,closed=false;
 const nowTime=()=>{const now=clock();if(!Number.isFinite(now)||now<lastTime){session=null;retireDish();throw error('preview_clock_invalid',503);}lastTime=now;return now;};
 const inviteHash=hash(invitation); invitation=null;
 function valid(token){if(session&&nowTime()>=session.expires){session=null;retireDish();}return !closed&&session&&equal(token,session.id);}
 const cookie=(id,age)=>`${COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
 function token(req){const all=(req.headers.cookie||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(COOKIE+'='));return all.length===1?all[0].slice(COOKIE.length+1):null;}
 async function body(req,limit){if(req.headers['content-type']?.split(';')[0]!=='application/json'||req.headers['content-encoding'])throw error('json_required',415);if(Number(req.headers['content-length'])>limit)throw error('request_too_large',413);let size=0,chunks=[];for await(const b of req){size+=b.length;if(size>limit)throw error('request_too_large',413);chunks.push(b);}try{return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks)));}catch{throw error('invalid_json');}}
 function proxy(path,method,payload,signal){return new Promise((resolve,reject)=>{
  const data=payload===undefined?null:Buffer.from(JSON.stringify(payload));
  const r=httpRequest({hostname:'127.0.0.1',port:target.port,path,method,signal,headers:{Host:target.host,...(data?{'Content-Type':'application/json','Content-Length':data.length,'X-Summon-Lab':'synthetic'}:{})}},s=>{
   let size=0,chunks=[];s.on('data',b=>{size+=b.length;if(size>8*1024*1024){r.destroy();reject(error('upstream_output_limit',502));}else chunks.push(b);});
   s.on('error',()=>reject(error('upstream_failed',502)));s.on('end',()=>{if(s.statusCode>=300&&s.statusCode<400)return reject(error('upstream_redirect_denied',502));if(s.headers['content-type']?.split(';')[0]!=='application/json')return reject(error('upstream_type_denied',502));resolve({status:s.statusCode,body:Buffer.concat(chunks)});});
  });r.setTimeout(upstreamTimeoutMs,()=>r.destroy());r.on('error',()=>reject(error('upstream_failed',502)));r.end(data);
 });}
 const handler=async(req,res)=>{
  const headers={'Cache-Control':'no-store, private','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin','X-Frame-Options':'DENY','Content-Security-Policy':DEFAULT_PREVIEW_CSP};
  const reply=(status,value,type='application/json',extra={})=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{...headers,'Content-Type':type,...extra});res.end(Buffer.isBuffer(value)?value:JSON.stringify(value));};
  if(closed)return reply(503,{error:'preview_closed'});
  if(!req.socket.encrypted||req.headers.host!==publicUrl.host)return reply(403,{error:'tls_host_required'});
  if(Object.keys(req.headers).some(k=>k.startsWith('x-forwarded-')||['forwarded','authorization','proxy-authorization'].includes(k)))return reply(403,{error:'forwarded_authority_denied'});
  if(req.headers.origin&&req.headers.origin!==origin||req.headers['sec-fetch-site']&& !['same-origin','none'].includes(req.headers['sec-fetch-site']))return reply(403,{error:'origin_denied'});
  if(req.method==='GET'&&(req.headers['transfer-encoding']||Number(req.headers['content-length'])>0))return reply(400,{error:'get_body_denied'});
  if(!['GET','POST'].includes(req.method)||!/^\/[A-Za-z0-9_./-]*$/.test(req.url)||req.url.includes('..'))return reply(400,{error:'invalid_request_target'});
  if(req.method==='POST'&&req.headers.origin!==origin)return reply(403,{error:'origin_required'});
  if(active>=maxConcurrent)return reply(429,{error:'preview_busy'});
  active++; const controller=new AbortController();const disconnect=()=>{if(!res.writableEnded)controller.abort();};res.on('close',disconnect);
  const timeout=setTimeout(()=>{controller.abort();req.destroy();res.destroy();},upstreamTimeoutMs+5000);
  try{
   const path=req.url;
   if(path==='/preview/login'&&req.method==='GET')return reply(200,loginHtml,'text/html; charset=utf-8');
   if(path==='/preview/login.js'&&req.method==='GET')return reply(200,loginScript,'text/javascript; charset=utf-8');
   if(path==='/preview/login'&&req.method==='POST'){
    const now=nowTime();if(now-windowStart>=60000){windowStart=now;attempts=0;}if(++attempts>5)throw error('login_rate_limited',429);
    const input=await body(req,1024);if(!input||Object.keys(input).length!==1||typeof input.invitation!=='string'||input.invitation.length>256||!timingSafeEqual(hash(input.invitation),inviteHash))throw error('invalid_invitation',401);
    if(session&&dishChannel)await dishChannel.invalidate();
    session={id:randomBytes(32).toString('base64url'),csrf:randomBytes(32).toString('base64url'),expires:nowTime()+ttlMs};
    return reply(200,{csrf:session.csrf,expiresInMs:ttlMs},'application/json',{'Set-Cookie':cookie(session.id,Math.ceil(ttlMs/1000))});
   }
   const sid=token(req);if(!valid(sid))throw error('authentication_required',401);
   if(req.method==='POST'&&!equal(req.headers['x-preview-csrf'],session.csrf))throw error('csrf_required',403);
   if(path==='/preview/session'&&req.method==='GET')return reply(200,{csrf:session.csrf,expiresInMs:Math.max(0,session.expires-nowTime())});
   if(path==='/preview/logout'&&req.method==='POST'){const input=await body(req,32);if(!input||Object.keys(input).length)throw error('invalid_logout');if(!valid(sid))throw error('authentication_required',401);if(dishChannel)await dishChannel.invalidate();if(!valid(sid))throw error('authentication_required',401);session=null;return reply(200,{loggedOut:true},'application/json',{'Set-Cookie':cookie('',0)});}
   if(req.method==='GET'&&privateAssets.has(path)){if(rendering&&path==='/'){const document=renderPrivateDocument();return reply(200,document.body,'text/html; charset=utf-8',{'Content-Security-Policy':document.csp});}const a=privateAssets.get(path);return reply(200,a.body,a.type);}
   if(dishChannel&&path==='/scene/dish-command')throw error('endpoint_denied',404);
   if(req.method==='POST'&&DISH_CONFIRMATION.has(path)){
    if(!dishChannel)throw error('endpoint_denied',404);
    const input=await body(req,1024);if(!input||typeof input!=='object'||Array.isArray(input))throw error('invalid_shape');noOwner(input);
    if(!valid(sid))throw error('authentication_required',401);
    let value;
    if(path==='/scene/dish-confirmation-respond')value=await dishChannel.respond(input);
    else {if(Object.keys(input).length)throw error('invalid_shape');if(path==='/scene/dish-confirmation-invalidate')await dishChannel.invalidate();value=dishChannel.read();}
    if(!valid(sid))throw error('authentication_required',401);return reply(200,value);
   }
   if(!(req.method==='GET'?GET:POST).has(path))throw error('endpoint_denied',404);
   const payload=req.method==='POST'?await body(req,POST_LIMITS.get(path)):undefined;
   if(payload!==undefined){if(!payload||typeof payload!=='object'||Array.isArray(payload))throw error('invalid_shape');noOwner(payload);}
   if(!valid(sid))throw error('authentication_required',401);
   const response=await proxy(path,req.method,payload,controller.signal);
   if(!valid(sid))throw error('authentication_required',401);
   reply(response.status,response.body);
  }catch(e){reply(e.status||400,{error:e.status?e.message:'request_failed'});}finally{clearTimeout(timeout);res.removeListener('close',disconnect);active--;}
 };
 handler.close=()=>{closed=true;session=null;retireDish();};
 return handler;
}
