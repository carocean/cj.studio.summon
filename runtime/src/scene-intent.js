// Finite whole-utterance matching, never general understanding or authority.
export function hearingSceneCandidate(text){
 if(typeof text!=='string'||text.length>4000)return null;
 const normalized=text.replace(/\s+/g,'').replace(/[。.!！]$/,'');
 if(['我要输入','我要打字','打开文字输入','改用文字'].includes(normalized))return 'text-entry-request';
 if(['开始工作','进入工作情境','我要上班','startwork'].includes(normalized.toLowerCase()))return 'work-context';
 if(['模拟开户','打开模拟开户表单','请帮我模拟开户','opensyntheticaccountform'].includes(normalized.toLowerCase()))return 'account-request';
 if(['回到小伴','回到伙伴','结束工作','returntocompanion'].includes(normalized.toLowerCase()))return 'personal-context';
 return null;
}

