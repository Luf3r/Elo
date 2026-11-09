import {expect,it} from 'vitest';
import {readVerificationSnapshot} from '../../src/automation/verification-reader';
import {createConversationReader} from '../../src/agendor/chat/contacts';
import {SafeError} from '../../src/errors';
import type {ConversationSnapshot} from '../../src/agendor/chat/types';
const coverage={complete:true,missingReasons:[],pagesRead:1};
const deps={getConversation:async()=>({id:42,contact:{id:7}}),listAttachments:async()=>({attachments:[],coverage}),listMessages:async (_id:number,input?:{after?:number})=>{
  const after=input?.after ?? 1;const messages=Array.from({length:1200},(_,i)=>({id:i+2,conversationId:42})).filter(m=>m.id>after).slice(0,100);
  const end=messages.length<100;
  return {conversationId:42,messages,coverage:{...coverage,complete:end,history:{startReached:after===1,endReached:end,messagesRead:messages.length,pagesRead:1,complete:end}},...(!end?{continuation:{conversationId:42,after:messages.at(-1)!.id}}:{})};
}};
it('resumes verification above one thousand messages without comparing a partial hash',async()=>{
  let previous:ConversationSnapshot|undefined;let reads=0;
  const scripted={...deps,listMessages:async(id:number,input?:{after?:number})=>{if(++reads===11)throw new SafeError('UPSTREAM_RATE_LIMITED','defer',true);return deps.listMessages(id,input);}};
  await expect(readVerificationSnapshot(scripted,42,{onProgress:async s=>{previous=s;}})).rejects.toMatchObject({code:'UPSTREAM_RATE_LIMITED'});
  expect(previous!.messages).toHaveLength(1000);
  const complete=await readVerificationSnapshot(scripted,42,{previous});
  expect(complete.messages).toHaveLength(1200);expect(complete.coverage.history?.complete).toBe(true);
});
it('retains a media/collection discrepancy across history batches',async()=>{
  const reader=createConversationReader({...deps,listMessages:async(id,input)=>{
    const page=await deps.listMessages(id,input);
    return {...page,messages:page.messages.map(m=>m.id===2?{...m,attachments:[{id:77,messageId:2}]}:m)};
  }});
  const first=await reader.readConversation({conversationId:42});
  expect(first.coverage.missingReasons).toContain('attachment_collection_missing_media');
  const last=await reader.readConversation({conversationId:42},{previous:first});
  expect(last.coverage.history?.complete).toBe(true);expect(last.coverage.complete).toBe(false);
  expect(last.coverage.missingReasons).toContain('attachment_collection_missing_media');
});
