// Whole-utterance literal name lookup only. No fuzzy name correction, aliasing,
// model output or outside registry can select an owner creature.
export function parseCreatureName(text){
 if(typeof text!=='string'||text.length>4000)return null;
 const normalized=text.trim().replace(/[。.]$/u,'');
 const match=/^(?:请)?切换到(.+)$/u.exec(normalized);
 if(!match||!match[1].trim()||[...match[1]].length>64||/[\u0000-\u001f\u007f]/u.test(match[1]))return null;
 return match[1];
}
