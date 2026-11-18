import test from 'node:test';import assert from 'node:assert/strict';
import {HostIdentity} from '../../microkernel/src/identity.js';
import {compileReadingResource} from '../src/reading-surface.js';
import {ReadingViews} from '../src/reading-views.js';
const resource=(text='纯合成😀',referenceId='synthetic')=>compileReadingResource({schema:'reading-resource.v1',resourceId:'sample',provenance:{kind:'host-declared',referenceId},blocks:[{id:'first',text}]});
const presentation={background:'#ffffff',fontRef:'synthetic-font',textScalePermille:1000,flow:'scroll',pageControls:false};
function fixture(options={}){const auth=new HostIdentity(),admin=auth.authenticate('host-admin'),alice=auth.authenticate('alice'),bob=auth.authenticate('bob');const host=new ReadingViews(auth,{installedFontIds:['synthetic-font'],...options}),r=resource(),ref={resourceId:r.resourceId,contentDigest:r.contentDigest};host.installResource(admin,r);const access=(enabled,expectedGeneration,ownerId='alice')=>host.setAccess(admin,{...ref,ownerId,enabled,expectedGeneration});const open={epoch:host.epoch,viewId:'v1',...ref,presentation};return {auth,admin,alice,bob,host,r,ref,access,open,view:{epoch:host.epoch,viewId:'v1'}};}
test('default deny, explicit admin only, owner isolation and historical receipts contain no text',()=>{
 const f=fixture();assert.throws(()=>f.host.open(f.alice,'open',f.open),/reading_access_denied/);
 assert.throws(()=>f.host.installResource(f.alice,resource()),/not_authorized/);assert.throws(()=>f.host.setAccess(f.alice,{}),/not_authorized/);
 f.access(true,0);const ack=f.host.open(f.alice,'open',f.open);assert.equal(ack.ack.fact,'reading_view_opened');assert.equal(ack.replayed,false);
 assert.throws(()=>f.host.read(f.bob,f.view),/reading_view_not_found/);assert.equal(f.host.query(f.bob,{epoch:f.host.epoch,commandId:'open'}).status,'not_started');
 const q=f.host.query(f.alice,{epoch:f.host.epoch,commandId:'open'});assert.equal(q.status,'completed');assert.equal(JSON.stringify(q).includes('纯合成'),false);assert.equal('state' in q.ack,false);
 assert.equal(f.host.open(f.alice,'open',f.open).replayed,true);
 assert.throws(()=>f.host.open(f.alice,'open',{...f.open,viewId:'other'}),/reading_command_conflict/);
});
test('immutable exact versions, provenance conflict and cloned installed font capabilities',()=>{
 const fonts=['synthetic-font'],f=fixture({installedFontIds:fonts});fonts.length=0;f.access(true,0);f.host.open(f.alice,'open',f.open);
 assert.deepEqual(f.host.installResource(f.admin,resource()),f.r);
 assert.throws(()=>f.host.installResource(f.admin,resource('纯合成😀','another-source')),/reading_resource_conflict/);
 const next=resource('different');f.host.installResource(f.admin,next);
 assert.throws(()=>f.host.open(f.alice,'new',{...f.open,viewId:'v2',contentDigest:next.contentDigest}),/reading_access_denied/);
 assert.throws(()=>f.host.open(f.alice,'bad',{...f.open,viewId:'v3',contentDigest:'sha256:missing'}),/reading_resource_not_installed/);
 assert.equal(f.host.read(f.alice,f.view).resource.contentDigest,f.r.contentDigest);
});
test('CAS updates preserve independent fields, read is side-effect-free and failure leaves state unchanged',()=>{
 const f=fixture();f.access(true,0);f.host.open(f.alice,'open',f.open);const before=f.host.read(f.alice,f.view);
 f.host.updateAnchor(f.alice,'move',{...f.view,expectedRevision:1,anchor:{blockId:'first',scalarOffset:3}});
 const moved=f.host.read(f.alice,f.view);assert.deepEqual(moved.state.presentation,before.state.presentation);
 f.host.updatePresentation(f.alice,'style',{...f.view,expectedRevision:2,changes:{background:'#ffccdd'}});
 const styled=f.host.read(f.alice,f.view);assert.deepEqual(styled.state.anchor,moved.state.anchor);assert.equal(styled.state.revision,3);
 for(let i=0;i<20;i++)assert.deepEqual(f.host.read(f.alice,f.view),styled);
 assert.throws(()=>f.host.updateAnchor(f.alice,'late',{...f.view,expectedRevision:1,anchor:{blockId:'first',scalarOffset:0}}),/reading_revision_conflict/);
 assert.equal(f.host.query(f.alice,{epoch:f.host.epoch,commandId:'late'}).status,'not_started');assert.deepEqual(f.host.read(f.alice,f.view),styled);
 assert.throws(()=>f.host.updatePresentation(f.alice,'font',{...f.view,expectedRevision:3,changes:{fontRef:'unavailable'}}),/reading_font_unavailable/);
 assert.deepEqual(f.host.read(f.alice,f.view),styled);assert.ok(Object.isFrozen(styled.state.anchor));
});
test('revoke and regrant never resurrect old view; replay only original metadata, close allowed after revocation',()=>{
 const f=fixture();f.access(true,0);f.host.open(f.alice,'open',f.open);f.access(false,1);
 assert.throws(()=>f.host.read(f.alice,f.view),/reading_access_denied/);assert.equal(f.host.open(f.alice,'open',f.open).replayed,true);
 f.access(true,2);assert.throws(()=>f.host.read(f.alice,f.view),/reading_access_changed/);
 assert.throws(()=>f.host.updateAnchor(f.alice,'move',{...f.view,expectedRevision:1,anchor:{blockId:'first',scalarOffset:0}}),/reading_access_changed/);
 assert.throws(()=>f.access(true,1),/reading_access_conflict/);
 f.host.open(f.alice,'fresh',{...f.open,viewId:'v2'});assert.equal(f.host.read(f.alice,{...f.view,viewId:'v2'}).state.revision,1);
 f.host.close(f.alice,'close',{...f.view,expectedRevision:1});assert.throws(()=>f.host.read(f.alice,f.view),/reading_view_closed/);
});
test('all ordinary methods authenticate before epoch; handle revocation and restart are explicit',()=>{
 const f=fixture();f.access(true,0);f.host.open(f.alice,'open',f.open);f.auth.revoke('alice');
 for(const call of [()=>f.host.read(f.alice,{...f.view,epoch:'old'}),()=>f.host.query(f.alice,{epoch:'old',commandId:'open'}),()=>f.host.open(f.alice,'x',{...f.open,epoch:'old'}),()=>f.host.close(f.alice,'x',{...f.view,epoch:'old',expectedRevision:1})])assert.throws(call,/unauthenticated/);
 const fresh=f.auth.authenticate('alice'),restarted=new ReadingViews(f.auth,{installedFontIds:['synthetic-font']});assert.notEqual(restarted.epoch,f.host.epoch);
 assert.throws(()=>restarted.query(fresh,{epoch:f.host.epoch,commandId:'open'}),/reading_instance_lost/);
 assert.equal(restarted.query(fresh,{epoch:restarted.epoch,commandId:'open'}).status,'not_started');restarted.installResource(f.admin,f.r);
 assert.throws(()=>restarted.open(fresh,'open',{...f.open,epoch:restarted.epoch}),/reading_access_denied/);
});
test('capacity is lifetime per instance; closing never frees IDs/receipts; old commands replay at saturation',()=>{
 const f=fixture({maxViewsPerOwner:1,maxCommandsPerOwner:2,maxResources:1,maxAccessRecords:1});f.access(true,0);f.host.open(f.alice,'open',f.open);f.host.close(f.alice,'close',{...f.view,expectedRevision:1});
 assert.equal(f.host.open(f.alice,'open',f.open).replayed,true);assert.equal(f.host.close(f.alice,'close',{...f.view,expectedRevision:1}).replayed,true);
 assert.throws(()=>f.host.open(f.alice,'new',{...f.open,viewId:'v2'}),/reading_command_capacity/);
 assert.throws(()=>f.host.installResource(f.admin,resource('other')),/reading_resource_capacity/);assert.throws(()=>f.access(true,0,'bob'),/reading_access_capacity/);
 const g=fixture({maxViewsPerOwner:1});g.access(true,0);g.host.open(g.alice,'open',g.open);g.host.close(g.alice,'close',{...g.view,expectedRevision:1});
 assert.throws(()=>g.host.open(g.alice,'reuse',g.open),/reading_view_exists/);assert.throws(()=>g.host.open(g.alice,'new',{...g.open,viewId:'v2'}),/reading_view_capacity/);
 assert.throws(()=>g.host.updateAnchor(g.alice,'late',{...g.view,expectedRevision:1,anchor:{blockId:'first',scalarOffset:0}}),/reading_view_closed/);
});
test('request accessors/proxies rejected without effects; ordinary methods cannot inject resource or owner',()=>{
 const f=fixture();f.access(true,0);let calls=0;const getter={...f.open};Object.defineProperty(getter,'presentation',{enumerable:true,get(){calls++;return presentation;}});
 assert.throws(()=>f.host.open(f.alice,'bad',getter));assert.equal(calls,0);assert.equal(f.host.query(f.alice,{epoch:f.host.epoch,commandId:'bad'}).status,'not_started');
 for(const raw of [{...f.open,ownerId:'bob'},{...f.open,resource:f.r},new Proxy(f.open,{})])assert.throws(()=>f.host.open(f.alice,'bad',raw));
 f.host.open(f.alice,'good',f.open);assert.equal(f.host.read(f.alice,f.view).state.revision,1);
});
test('constructing a second host does not retire the first; explicit admin retirement permanently clears and rejects',()=>{
 const f=fixture({maxCommandsPerOwner:1});f.access(true,0);f.host.open(f.alice,'open',f.open);
 const second=new ReadingViews(f.auth,{installedFontIds:['synthetic-font']});assert.notEqual(second.epoch,f.host.epoch);
 assert.equal(f.host.query(f.alice,{epoch:f.host.epoch,commandId:'open'}).status,'completed');
 assert.throws(()=>f.host.retireHost(f.alice),/not_authorized/);assert.throws(()=>f.host.retireHost({}),/unauthenticated/);
 const epoch=f.host.epoch;assert.deepEqual(f.host.retireHost(f.admin),{fact:'reading_host_retired',epoch,alreadyRetired:false});assert.equal(f.host.epoch,epoch);
 assert.equal(f.host.retireHost(f.admin).alreadyRetired,true);
 for(const call of [()=>f.host.read(f.alice,f.view),()=>f.host.query(f.alice,{epoch,commandId:'open'}),()=>f.host.open(f.alice,'open',f.open),()=>f.host.updateAnchor(f.alice,'late',{...f.view,expectedRevision:1,anchor:{blockId:'first',scalarOffset:0}}),()=>f.host.updatePresentation(f.alice,'style',{...f.view,expectedRevision:1,changes:{background:'#ffccdd'}}),()=>f.host.close(f.alice,'close',{...f.view,expectedRevision:1}),()=>f.host.installResource(f.admin,f.r),()=>f.access(true,1)])assert.throws(call,/reading_host_retired/);
 assert.throws(()=>f.host.query(f.alice,{epoch:second.epoch,commandId:'open'}),/reading_host_retired/);
 assert.throws(()=>f.host.read({},f.view),/unauthenticated/);assert.throws(()=>f.host.installResource(f.alice,f.r),/not_authorized/);assert.throws(()=>f.host.setAccess(f.alice,{}),/not_authorized/);
 f.auth.revoke('host-admin');assert.throws(()=>f.host.retireHost(f.admin),/unauthenticated/);assert.equal(f.host.retireHost(f.auth.authenticate('host-admin')).alreadyRetired,true);
 second.installResource(f.auth.authenticate('host-admin'),f.r);
 assert.throws(()=>second.open(f.alice,'new',{...f.open,epoch:second.epoch}),/reading_access_denied/);
 assert.throws(()=>second.query(f.alice,{epoch,commandId:'open'}),/reading_instance_lost/);
});
