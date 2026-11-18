// A small deterministic presentation policy, not a language model or general UI generator.
// Stable creature identity and task state do not belong to the view lifecycle.
export const creatureDefinitions=Object.freeze([
 Object.freeze({id:'companion',name:'小伴',personality:'轻松、好奇的日常伙伴',body:'sprout',tone:'playful'}),
 Object.freeze({id:'work',name:'小谨',personality:'严谨、清楚的业务伙伴',body:'owl',tone:'precise'}),
]);
export function presentCreature(state,registry=creatureDefinitions){
 const work=state.activeCreatureId==='work',creature=registry.find(c=>c.id===state.activeCreatureId),activity=state.activity;
 return {schema:'creature-scene.v1',context:work?'work':'personal',creatureId:creature.id,body:creature.body,tone:creature.tone,
  surface:state.routeView&&state.routeView.receipt.instanceId===creature.id?(state.routeView.visible?'synthetic-route':'route-summary'):!activity?'none':work&&activity.sceneVisible?'synthetic-account':'task-summary',activityId:activity?.id??null,activityRevision:activity?.revision??null,source:'deterministic-policy'};
}
