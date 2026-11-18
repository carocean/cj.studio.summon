import {join} from 'node:path';
import {SnapshotStore} from '../../../microkernel/src/store.js';
import {HostIdentity} from '../../../microkernel/src/identity.js';
import {GrantLedger} from '../../../microkernel/src/grants.js';
import {ControlledContextLab} from '../../../microkernel/src/context.js';
import {LocalArtifactMailbox} from '../../src/local-artifact-mailbox.js';
const [dir,phase]=process.argv.slice(2);
if(!['before-commit','after-commit'].includes(phase))throw Error('invalid crash phase');
const store=new SnapshotStore(join(dir,'core.sqlite')),auth=new HostIdentity();
const h=Object.fromEntries(['host-admin','owner','primary','worker'].map(p=>[p,auth.authenticate(p)]));
const grants=new GrantLedger(store,auth,{clock:()=>100}),data=new ControlledContextLab(store,grants),mail=new LocalArtifactMailbox(store,auth,data);
data.createSource(h['host-admin'],'source',{sourceId:'draft',controller:'owner',content:'synthetic-field-copy',purposes:['draft-return'],recipients:['primary','worker'],retentionUntil:1000});
grants.issueRoot(h['host-admin'],'root',{grantId:'primary-grant',rootPrincipal:'owner',delegate:'primary',resources:['draft'],operations:['derive','disclose','read'],purposes:['draft-return'],recipients:['primary','worker'],budget:{calls:3,bytes:1000},expiresAt:900,maxDepth:1});
grants.attenuate(h.primary,'delegate','primary-grant',{grantId:'worker-grant',delegate:'worker',resources:['draft'],operations:['derive','disclose','read'],purposes:['draft-return'],recipients:['primary','worker'],budget:{calls:3,bytes:1000},expiresAt:800,maxDepth:0});
data.createContext(h.worker,'context',{contextId:'context',bindings:[{sourceId:'draft',grantId:'worker-grant'}],stateRefs:[],purpose:'draft-return'});data.run(h.worker,'run',{contextId:'context',artifactId:'work-return'});
if(phase==='before-commit'){
 const command=store.command.bind(store);
 store.command=(actor,id,input,apply)=>command(actor,id,input,(...args)=>{
  const result=apply(...args);
  if(input.operation==='local-artifact-delivery')process.kill(process.pid,'SIGKILL');
  return result;
 });
}
mail.deliver(h.worker,'return',{artifactId:'work-return',purpose:'draft-return',recipientId:'primary'});
process.kill(process.pid,'SIGKILL');
