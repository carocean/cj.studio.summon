import {snapshot,digest} from '../../microkernel/src/canonical.js';
import {fields,deny,id} from '../../microkernel/src/grants.js';
const sealed=v=>snapshot('local-mailbox',v).value;
const indexKey=recipient=>'local-mail-index.'+digest('mail-recipient',recipient).slice(7,55);
const messageKey=mailId=>'local-mail.'+id(mailId);

// Trusted-host, same-store recipient mailbox. Not a network transport or agent API.
// A durable recipient copy and its one disclosure budget debit commit together.
export class LocalArtifactMailbox {
 #store;#identities;#data;
 constructor(store,identities,data){data.assertBrokerDomain(store,identities);this.#store=store;this.#identities=identities;this.#data=data;}
 assertDomain(store,identities){if(this.#store!==store||this.#identities!==identities)deny('local_mail_domain_mismatch');}
 deliver(handle,commandId,raw){
  const sender=this.#identities.resolve(handle),spec=sealed(raw);id(commandId);fields(spec,['artifactId','purpose','recipientId']);
  id(spec.artifactId);id(spec.purpose);id(spec.recipientId);
  const now=this.#data.refreshForPermit(handle,spec.artifactId);
  const mailId='mail-'+digest('mail-delivery',[sender,commandId]).slice(7,55);
  return this.#store.command(sender,commandId,{operation:'local-artifact-delivery',spec},tx=>{
   const index=tx.get(indexKey(spec.recipientId)),ids=index?.value.ids??[];
   if(ids.length>=64)deny('local_mailbox_capacity');
   const packet=this.#data.permitInputIn(tx,{actor:sender,artifactId:spec.artifactId,purpose:spec.purpose,recipient:spec.recipientId,charge:true},now);
   const receipt={schema:'local-artifact-delivery.v1',mailId,sender,recipientId:spec.recipientId,artifactId:packet.artifactId,artifactDigest:packet.artifactDigest,contextDigest:packet.contextDigest,purpose:spec.purpose,deliveredAt:now,retentionUntil:packet.retentionUntil,fact:'local_recipient_copy_saved'};
   tx.put(messageKey(mailId),'local-mail',{receipt,content:packet.content},0);
   tx.put(indexKey(spec.recipientId),'local-mail-index',{ids:[...ids,mailId]},index?.revision??0);
   return receipt;
  });
 }
 #owned(handle,mailId){
  const recipient=this.#identities.resolve(handle),r=this.#store.get(messageKey(mailId));
  if(!r||r.value.receipt.recipientId!==recipient)deny('local_mail_not_authorized');
  return r.value;
 }
 inspect(handle,mailId){return sealed(this.#owned(handle,mailId).receipt);}
 read(handle,mailId){
  const entry=this.#owned(handle,mailId),receipt=entry.receipt;
  // Sender identity comes only from an immutable receipt previously authenticated
  // by deliver(), never from a recipient's request. This is host-only revalidation,
  // not delegation of sender authority to the recipient.
  const senderHandle=this.#identities.authenticate(receipt.sender);
  const now=this.#data.refreshForPermit(senderHandle,receipt.artifactId);
  return this.#store.transaction(tx=>{
   const packet=this.#data.permitInputIn(tx,{actor:receipt.sender,artifactId:receipt.artifactId,purpose:receipt.purpose,recipient:receipt.recipientId,expectedDigest:receipt.artifactDigest,charge:false},now);
   if(packet.content!==entry.content||packet.contextDigest!==receipt.contextDigest||now>=receipt.retentionUntil)deny('local_mail_binding_mismatch');
   // Reopening this already-delivered local copy is not a new disclosure/send.
   return sealed({receipt,content:entry.content});
  });
 }
 list(handle){
  const recipient=this.#identities.resolve(handle),ids=this.#store.get(indexKey(recipient))?.value.ids??[];
  return sealed(ids.map(mailId=>this.#store.get(messageKey(mailId)).value.receipt));
 }
}
