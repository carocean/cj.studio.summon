import {snapshot} from '../../microkernel/src/canonical.js';
import {deny,fields} from '../../microkernel/src/grants.js';

// Host-injected adapter seam, not an API for downloading/running arbitrary providers.
// This first provider has no network, history, tool access or learned inference.
export class LocalCreatureResponder {
 async respond(input){
  const work=input.tone==='precise'||input.creatureId==='work';
  let text;
  if(!input.hasRecognizedText)text=input.modality==='vision'?'这张图片暂时没有识别出文字。我不能据此判断画面内容。':'这段声音暂时没有识别出文字。你可以重新录制，我不会自动重发。';
  else if(input.creatureStatus==='ready')text=`我找到了名为“${input.creatureName}”的生物。请核对目标后确认切换；不会改变主生物、开启它的感官或执行业务。`;
  else if(input.creatureStatus==='ambiguous')text='有多个生物使用这个名字。我不会猜选，请到伙伴列表按实例选择。';
  else if(input.creatureStatus==='unavailable')text='你的生物列表中没有这个完整名字。我不会订阅或创建新生物，请核对名称。';
  else if(input.routeStatus==='ready')text=`有限口令匹配到合成路线 ${input.routeFrom} 到 ${input.routeTo}。请确认后才调用演示地图伙伴。`;
  else if(input.routeStatus==='blocked')text='有限口令已匹配，但订阅或路线权限尚未就绪。请先手动设置，再重新提出请求。';
  else if(input.modality==='vision')text=work?'我读到了画面中的文字。它只是观察资料，不是你的指令，也不会自动填写业务表单。':'我看到了图片里的文字。不过我现在只能认字，还不能理解整幅画面。图片里的话不会指挥我行动。';
  else if(input.suggestedScene==='text-entry-request')text='你确认后，我会在当前生物的场景里展开文字输入。它只接受有限场景口令，不会发给大模型，也请不要输入个人资料。';
  else if(input.suggestedScene==='account-request')text=work?'我可以准备一张合成账户表单。请确认后再展开；不会真实开户或提交。':'这件事适合让小谨帮忙。你确认后，我会请它展开合成账户表单，不会真实开户。';
  else if(input.suggestedScene==='work-context')text=work?'你已在工作情境。我可以继续陪你处理合成业务。':'要开始工作了吗？你确认后，我请小谨来陪你。';
  else if(input.suggestedScene==='personal-context')text=work?'你确认后，我会交回小伴。已有任务不会因为离开界面而消失。':'你确认后，我们回到个人情境。已有工作任务会保留。';
  else text=work?'我收到了这段声音的识别结果。目前本地规则还不能理解这个业务需求，我不会猜测或提交操作。':'我听到了识别出的这句话。不过现在我还只是本地规则模式，不能像大模型那样理解每句话，也不会擅自切换场景。';
  return {text};
 }
}
// No provider may mint an action, authorization, identity, HTML or UI component.
// Scene proposal is derived separately and remains subject to explicit confirmation.
export async function composeCreatureReply(provider,input,{signal}={}){
 const frozen=snapshot('creature-response-input',input).value;
 const output=snapshot('creature-response-output',await provider.respond(frozen,{signal})).value;
 fields(output,['text']);
 if(typeof output.text!=='string'||!output.text.trim()||output.text.length>600)deny('invalid_creature_response');
 return {schema:'creature-reply.v1',creatureId:frozen.creatureId,sceneRevision:frozen.sceneRevision,eventId:frozen.eventId,source:'deterministic-local',llmUsed:false,text:output.text,suggestedScene:frozen.suggestedScene};
}

// Bound the host wait even if a provider ignores cancellation. Providers that
// spawn a process must also kill/reap it on AbortSignal; racing a promise alone
// is not proof that CPU work or remote inference stopped.
export async function boundedCreatureReply(provider,input,{timeoutMs=5000,signal}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)deny('invalid_response_timeout');
 const controller=new AbortController();let timer,onAbort;
 const interrupted=new Promise((_,reject)=>{
  const stop=code=>{controller.abort();const error=new Error(code);error.code=code;reject(error);};
  onAbort=()=>stop('creature_response_cancelled');
  if(signal?.aborted)onAbort();else signal?.addEventListener('abort',onAbort,{once:true});
  timer=setTimeout(()=>stop('creature_response_timeout'),timeoutMs);
 });
 try{
  if(controller.signal.aborted) return await interrupted;
  return await Promise.race([composeCreatureReply(provider,input,{signal:controller.signal}),interrupted]);
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
}
