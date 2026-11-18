import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SnapshotStore} from '../../microkernel/src/store.js';
import {digest} from '../../microkernel/src/canonical.js';
import {HostIdentity} from '../../microkernel/src/identity.js';
import {GrantLedger} from '../../microkernel/src/grants.js';
import {ControlledContextLab} from '../../microkernel/src/context.js';
import {LocalArtifactMailbox} from '../src/local-artifact-mailbox.js';
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'local-mail-')),path=join(dir,'core.sqlite');let store,grants,data,mailbox,now=100;
 const auth=new HostIdentity(),handles=Object.fromEntries(['host-admin','owner','primary','worker','other'].map(p=>[p,auth.authenticate(p)]));
 const open=()=>{store=new SnapshotStore(path);grants=new GrantLedger(store,auth,{clock:()=>now});data=new ControlledContextLab(store,grants);mailbox=new LocalArtifactMailbox(store,auth,data);};open();
 return {handles,auth,get store(){return store;},get grants(){return grants;},get data(){return data;},get mail(){return mailbox;},clock(n){now=n;},reopen(){store.close();open();},close(){store.close();rmSync(dir,{recursive:true,force:true});},prepare(){
  const h=handles,content=JSON.stringify({synthetic:true,customerAlias:'demo-a',accountType:'savings',contactPreference:'none'});
  data.createSource(h['host-admin'],'source',{sourceId:'draft',controller:'owner',content,purposes:['draft-return'],recipients:['primary','worker'],retentionUntil:1000});
  grants.issueRoot(h['host-admin'],'root',{grantId:'primary-grant',rootPrincipal:'owner',delegate:'primary',resources:['draft'],operations:['derive','disclose','read'],purposes:['draft-return'],recipients:['primary','worker'],budget:{calls:3,bytes:1000},expiresAt:900,maxDepth:1});
  grants.attenuate(h.primary,'delegate','primary-grant',{grantId:'worker-grant',delegate:'worker',resources:['draft'],operations:['derive','disclose','read'],purposes:['draft-return'],recipients:['primary','worker'],budget:{calls:3,bytes:1000},expiresAt:800,maxDepth:0});
  data.createContext(h.worker,'context',{contextId:'work-context',bindings:[{sourceId:'draft',grantId:'worker-grant'}],stateRefs:[],purpose:'draft-return'});
  data.run(h.worker,'run',{contextId:'work-context',artifactId:'work-return'});
  return content;
 }};
}
const request={artifactId:'work-return',purpose:'draft-return',recipientId:'primary'};
test('primary attenuates one bounded packet to worker, which returns durable owner-scoped content without inherited history',()=>{
 const f=fixture();try{
  const content=f.prepare();assert.equal(f.grants.inspect(f.handles.worker,'worker-grant').spent.calls,2);
  const delivery=f.mail.deliver(f.handles.worker,'return',request);assert.equal(delivery.replayed,false);assert.equal(delivery.ack.fact,'local_recipient_copy_saved');assert.equal(delivery.content,undefined);
  assert.equal(f.grants.inspect(f.handles.worker,'worker-grant').spent.calls,3);
  assert.equal(f.grants.inspect(f.handles.primary,'primary-grant').allocated.calls,3);
  assert.equal(f.mail.read(f.handles.primary,delivery.ack.mailId).content,content);
  f.reopen();assert.equal(f.mail.deliver(f.handles.worker,'return',request).replayed,true);assert.equal(f.mail.read(f.handles.primary,delivery.ack.mailId).content,content);
  assert.equal(f.grants.inspect(f.handles.worker,'worker-grant').spent.calls,3);assert.equal(f.mail.list(f.handles.primary).length,1);
  assert.throws(()=>f.mail.read(f.handles.worker,delivery.ack.mailId),{code:'local_mail_not_authorized'});assert.throws(()=>f.mail.inspect(f.handles.other,delivery.ack.mailId),{code:'local_mail_not_authorized'});
  assert.throws(()=>f.mail.deliver(f.handles.worker,'return',{...request,recipientId:'other'}),{code:'command_conflict'});
 }finally{f.close();}
});
test('primary designation is not permission: wrong actor/recipient/purpose cannot deliver or consume budget',()=>{
 const f=fixture();try{
  f.prepare();assert.throws(()=>f.mail.deliver(f.handles.primary,'wrong-actor',request),{code:'not_authorized'});
  assert.throws(()=>f.mail.deliver(f.handles.worker,'wrong-recipient',{...request,recipientId:'other'}));
  assert.throws(()=>f.mail.deliver(f.handles.worker,'wrong-purpose',{...request,purpose:'bank-submit'}));
  assert.equal(f.mail.list(f.handles.primary).length,0);assert.equal(f.grants.inspect(f.handles.worker,'worker-grant').spent.calls,2);
  assert.throws(()=>new LocalArtifactMailbox(f.store,new HostIdentity(),f.data),{code:'context_domain_mismatch'});
 }finally{f.close();}
});
test('revocation preserves historical receipt but blocks new delivery and mailbox content, including after restart',()=>{
 const f=fixture();try{
  f.prepare();const delivered=f.mail.deliver(f.handles.worker,'return',request).ack;
  f.grants.revoke(f.handles.owner,'revoke','primary-grant');f.reopen();
  assert.deepEqual(f.mail.inspect(f.handles.primary,delivered.mailId),delivered);
  assert.throws(()=>f.mail.read(f.handles.primary,delivered.mailId),{code:'grant_inactive'});
  assert.throws(()=>f.mail.deliver(f.handles.worker,'new-return',request),{code:'grant_inactive'});
  const history=f.mail.deliver(f.handles.worker,'return',request);assert.equal(history.replayed,true);assert.equal(history.content,undefined);assert.equal(f.mail.list(f.handles.primary).length,1);
 }finally{f.close();}
});
test('observed expiry survives rollback; existing receiver copy cannot be retrieved again after expiry',()=>{
 const f=fixture();try{
  f.prepare();const delivered=f.mail.deliver(f.handles.worker,'return',request).ack;f.clock(800);
  assert.throws(()=>f.mail.read(f.handles.primary,delivered.mailId));f.reopen();f.clock(100);assert.throws(()=>f.mail.read(f.handles.primary,delivered.mailId),{code:'grant_inactive'});assert.equal(f.mail.inspect(f.handles.primary,delivered.mailId).fact,'local_recipient_copy_saved');
 }finally{f.close();}
});

test('failed atomic mailbox write rolls back disclosure budget as well as recipient copy',()=>{
 const f=fixture();try{
  f.prepare();
  // Corrupt the recipient index kind through the trusted test host so the final
  // index update fails after charge and mail insertion inside the transaction.
  const key='local-mail-index.'+digest('mail-recipient','primary').slice(7,55);
  f.store.transaction(tx=>{tx.put(key,'wrong-kind',{ids:[]},0);return null;});
  assert.throws(()=>f.mail.deliver(f.handles.worker,'rollback',request),{code:'resource_kind_immutable'});
  assert.equal(f.grants.inspect(f.handles.worker,'worker-grant').spent.calls,2);
  assert.equal(f.mail.list(f.handles.primary).length,0);
  const mailId='mail-'+digest('mail-delivery',['worker','rollback']).slice(7,55);
  assert.equal(f.store.get('local-mail.'+mailId),null);
 }finally{f.close();}
});
test('source revocation blocks recipient reads; recipient never obtains sender handle or hidden private source',()=>{
 const f=fixture();try{
  f.prepare();f.data.createSource(f.handles['host-admin'],'secret',{sourceId:'private-memory',controller:'owner',content:'not-shared-private-memory',purposes:['draft-return'],recipients:['primary'],retentionUntil:900});
  const delivered=f.mail.deliver(f.handles.worker,'return',request).ack;
  const received=f.mail.read(f.handles.primary,delivered.mailId);assert.equal(JSON.stringify(received).includes('not-shared-private-memory'),false);
  assert.equal(received.handle,undefined);assert.throws(()=>f.mail.read({principal:'primary'},delivered.mailId),{code:'unauthenticated'});
  f.data.revokeSource(f.handles.owner,'source-revoke','draft');f.reopen();assert.throws(()=>f.mail.read(f.handles.primary,delivered.mailId),{code:'stale_source'});
  assert.deepEqual(f.mail.inspect(f.handles.primary,delivered.mailId),delivered);
 }finally{f.close();}
});

for(const phase of ['before-commit','after-commit'])test(`actual SIGKILL ${phase}: disclosure debit and durable inbox recover together`,{timeout:15000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mail-crash-'));let store;
 try{
  const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/mailbox-crash-worker.js',import.meta.url)),dir,phase],{stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',b=>{error+=b;});const [code,signal]=await once(child,'exit');assert.equal(signal,'SIGKILL',error);assert.equal(code,null);
  store=new SnapshotStore(join(dir,'core.sqlite'));const auth=new HostIdentity(),worker=auth.authenticate('worker'),primary=auth.authenticate('primary'),grants=new GrantLedger(store,auth,{clock:()=>100}),data=new ControlledContextLab(store,grants),mail=new LocalArtifactMailbox(store,auth,data);
  assert.equal(grants.inspect(worker,'worker-grant').spent.calls,phase==='before-commit'?2:3);
  assert.equal(mail.list(primary).length,phase==='before-commit'?0:1);
  const recovered=mail.deliver(worker,'return',request);assert.equal(recovered.replayed,phase==='after-commit');assert.equal(mail.read(primary,recovered.ack.mailId).content,'synthetic-field-copy');assert.equal(grants.inspect(worker,'worker-grant').spent.calls,3);assert.equal(mail.list(primary).length,1);
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});

test('session-handle revocation is distinct from data-grant revocation for an already delivered copy',()=>{
 const f=fixture();try{
  const content=f.prepare(),delivered=f.mail.deliver(f.handles.worker,'return',request).ack;
  f.auth.revoke('worker');assert.throws(()=>f.mail.deliver(f.handles.worker,'return',request),{code:'unauthenticated'});
  assert.equal(f.mail.read(f.handles.primary,delivered.mailId).content,content,'sender logout is not data revocation');
  f.auth.revoke('primary');assert.throws(()=>f.mail.read(f.handles.primary,delivered.mailId),{code:'unauthenticated'});
  const primary=f.auth.authenticate('primary');assert.equal(f.mail.read(primary,delivered.mailId).content,content);
  f.grants.revoke(f.handles.owner,'revoke-data','primary-grant');assert.throws(()=>f.mail.read(primary,delivered.mailId),{code:'grant_inactive'});
 }finally{f.close();}
});
