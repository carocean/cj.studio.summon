// Fixed public cold-start shell. No injected configuration, credentials or return URL.
export const loginHtml = Buffer.from(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Summon 预览登录</title><script src="/preview/login.js" defer></script></head>
<body><main><h1>登录私有预览</h1>
<p>登录后将打开私有预览。如有正在编辑的草稿，请保留原页面；此页面无法恢复未保存的内容。</p>
<form id="login" method="post" action="/preview/login" autocomplete="off">
<label for="invitation">邀请口令</label><input id="invitation" type="password" required minlength="43" maxlength="256" autocomplete="off" spellcheck="false">
<button id="submit" type="submit" disabled>登录</button></form>
<p id="status" role="status" aria-live="polite">登录需要启用 JavaScript。</p>
<noscript>请启用 JavaScript 以使用私有预览。</noscript></main></body></html>`);

export const loginScript = Buffer.from(`'use strict';
(() => {
 const form=document.getElementById('login'), input=document.getElementById('invitation');
 const button=document.getElementById('submit'), status=document.getElementById('status');
 let active=true, busy=false, generation=0, controller=null;
 button.disabled=false; status.textContent='';
 const retire=()=>{active=false;generation++;controller?.abort();controller=null;busy=false;input.value='';button.disabled=true;};
 window.addEventListener('pagehide',retire);
 window.addEventListener('pageshow',()=>{active=true;generation++;controller?.abort();controller=null;busy=false;input.value='';button.disabled=false;status.textContent='';});
 form.addEventListener('submit',async event=>{
  event.preventDefault();
  if(!active||busy)return;
  if(input.value.length<43||input.value.length>256){status.textContent='请输入有效的邀请口令。';return;}
  busy=true;button.disabled=true;status.textContent='正在登录…';
  const attempt=++generation, abort=new AbortController();controller=abort;
  const payload=JSON.stringify({invitation:input.value});input.value='';
  const timer=setTimeout(()=>abort.abort(),20000);
  try{
   const response=await fetch('/preview/login',{method:'POST',credentials:'same-origin',mode:'same-origin',redirect:'error',cache:'no-store',headers:{'Content-Type':'application/json'},body:payload,signal:abort.signal});
   if(!active||attempt!==generation)return;
   if(abort.signal.aborted)throw new Error('login_timeout');
   if(response.status!==200){status.textContent=response.status===429?'尝试次数过多，请等待一分钟后再试。':response.status===401?'邀请口令无效，请重新输入。':'登录失败，请重试。';return;}
   const result=await response.json();
   if(!active||attempt!==generation)return;
   if(abort.signal.aborted)throw new Error('login_timeout');
   if(typeof result?.csrf!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(result.csrf)||!Number.isSafeInteger(result.expiresInMs)||result.expiresInMs<1)throw new Error('invalid_login_response');
   input.value='';active=false;status.textContent='已登录，正在打开预览…';
   // The private App obtains its own in-memory CSRF via GET /preview/session.
   window.location.replace('/');
  }catch{if(active&&attempt===generation)status.textContent='登录未完成，请重试。';}
  finally{clearTimeout(timer);if(active&&attempt===generation){busy=false;button.disabled=false;controller=null;}}
 });
})();`);
