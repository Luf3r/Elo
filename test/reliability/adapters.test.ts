import {readCanonicalConversation} from '../../src/agendor/chat/canonical';
import {BudgetDeferredError} from '../../src/automation/state/budget';
import { describe, expect, it } from 'vitest';
import { createAgendorChatClient, createConversationReader } from '../../src/agendor/chat/client';
import { readCustomerCandidates, readDuplicateCandidates, candidateLookupLinks } from '../../src/automation/identity';
import { SafeError } from '../../src/errors';
const env = { AGENDOR_CHAT_TOKEN: 'synthetic-token', AGENDOR_CHAT_ACCOUNT_ID: '100' };
const coverage = { complete: true, missingReasons: [], pagesRead: 1 };
const empty = async () => ({ items: [], pageInfo: { page: 1, perPage: 100, hasNext: false, nextPage: null } });
function chat(total: number) {
  const cursors: number[] = [];
  const client = createAgendorChatClient(env, { budgetGate: async () => {}, request: async req => {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/messages')) {
      const after = Number(url.searchParams.get('after')); cursors.push(after);
      return Response.json({ payload: Array.from({length: total}, (_, i) => ({id: i + 2, conversation_id: 200})).filter(m => m.id > after).slice(0,100) });
    }
    throw Error('Unexpected request');
  } });
  return { client, cursors };
}
describe('message continuation contract', () => {
  it('starts at after=1 and returns a verified exclusive continuation for a full page', async () => {
    const { client, cursors } = chat(437);
    const page = await client.listMessages(200);
    expect(cursors).toEqual([1]);
    expect(page.continuation).toEqual({ conversationId: 200, after: 101 });
    expect(page.coverage.missingReasons).toEqual(['history_end_not_reached']);
  });
  it('reads all 437 messages across five pages without the old 100-message cutoff', async () => {
    const { client, cursors } = chat(437);
    const result = await createConversationReader({ ...client, getConversation: async () => ({ id:200, contact: {id:300} }), listAttachments: async () => ({ attachments:[], coverage }) }).readConversation({conversationId:200});
    expect(result.messages).toHaveLength(437);
    expect(cursors).toEqual([1,101,201,301,401]);
    expect(result.coverage.complete).toBe(true);
    expect(result.coverage.history).toMatchObject({ startReached:true, endReached:true, messagesRead:437, pagesRead:5, complete:true });
  });
  it('does not call a delta complete history or flag upstream edits as an MCP failure', async () => {
    const result = await chat(20).client.listMessages(200,{after:10});
    expect(result.coverage.missingReasons).toEqual(['history_start_not_reached']);
    expect(result.coverage.complete).toBe(false);
  });
});
describe('attachment coverage from complete message history', () => {
  it('recovers a repeated attachment listing from every message page', async () => {
    const attachments = [
      { id: 10, fileType: 'file', messageId: 2 },
      { id: 11, fileType: 'image', messageId: 3 },
      { id: 12, fileType: 'audio', messageId: 4 },
    ];
    const reader = createConversationReader({
      getConversation: async () => ({ id: 200, contact: { id: 300 } }),
      listAttachments: async () => ({
        attachments: [attachments[0]!],
        coverage: { complete: false, missingReasons: ['attachment_pagination_unavailable'], pagesRead: 1 },
        pageInfo: { page: 1, nextPage: null, hasNext: null, endReached: false, complete: false },
      }),
      listMessages: async (_id, input) => input?.after === 1
        ? { conversationId: 200, messages: [
            { id: 2, conversationId: 200, attachments: [attachments[0]!] },
            { id: 3, conversationId: 200, attachments: [attachments[1]!] },
          ], coverage: { complete: false, missingReasons: ['history_end_not_reached'], pagesRead: 1, history: { startReached: true, endReached: false, messagesRead: 2, pagesRead: 1, complete: false } }, continuation: { conversationId: 200, after: 3 } }
        : { conversationId: 200, messages: [
            { id: 4, conversationId: 200, attachments: [attachments[2]!] },
          ], coverage: { complete: false, missingReasons: ['history_start_not_reached'], pagesRead: 1, history: { startReached: false, endReached: true, messagesRead: 1, pagesRead: 1, complete: false } } },
    });

    const result = await reader.readConversation({ conversationId: 200 });

    expect(result.attachments.map(a => a.id)).toEqual([10, 11, 12]);
    expect(result.attachmentListing).toMatchObject({ complete: true, source: 'message_history', messagePagesRead: 2 });
    expect(result.coverage.attachmentListing).toBe('complete');
    expect(result.coverage.missingReasons.filter(reason => reason.startsWith('attachment'))).toEqual([]);
    expect(result.coverage.complete).toBe(true);
  });

  it('resumes after a retryable message failure and completes the attachment fallback', async () => {
    const attachment = { id: 10, fileType: 'file', messageId: 2 };
    const laterAttachment = { id: 11, fileType: 'image', messageId: 4 };
    let deferred = false;
    const reader = createConversationReader({
      getConversation: async () => ({ id: 200, contact: { id: 300 } }),
      listAttachments: async () => ({ attachments: [attachment], coverage: { complete: false, missingReasons: ['attachment_pagination_unavailable'], pagesRead: 1 }, pageInfo: { page: 1, nextPage: null, hasNext: null, endReached: false, complete: false } }),
      listMessages: async (_id, input) => {
        if (input?.after === 1) return { conversationId: 200, messages: [
          { id: 2, conversationId: 200, attachments: [attachment] },
          { id: 3, conversationId: 200 },
        ], coverage: { complete: false, missingReasons: ['history_end_not_reached'], pagesRead: 1, history: { startReached: true, endReached: false, messagesRead: 2, pagesRead: 1, complete: false } }, continuation: { conversationId: 200, after: 3 } };
        if (!deferred) { deferred = true; throw new SafeError('UPSTREAM_RATE_LIMITED', 'defer', true); }
        return { conversationId: 200, messages: [{ id: 4, conversationId: 200, attachments: [laterAttachment] }], coverage: { complete: false, missingReasons: ['history_start_not_reached'], pagesRead: 1, history: { startReached: false, endReached: true, messagesRead: 1, pagesRead: 1, complete: false } } };
      },
    });

    const partial = await reader.readConversation({ conversationId: 200 });
    expect(partial.continuation).toEqual({ conversationId: 200, after: 3 });
    expect(partial.coverage.missingReasons).toContain('history_read_deferred');
    const complete = await reader.readConversation({ conversationId: 200 }, { previous: partial });

    expect(complete.attachments.map(a => a.id)).toEqual([10, 11]);
    expect(complete.attachmentListing).toMatchObject({ complete: true, source: 'message_history', messagePagesRead: 2 });
    expect(complete.coverage.complete).toBe(true);
  });
});
describe('canonical identity', () => {
  it('verifies the direct link before any search and skips fallback', async () => {
    const calls: string[] = [];
    const result = await readCustomerCandidates({ getPerson: async () => { calls.push('person'); return {id:13,name:'Person'}; }, searchPeople: async () => {calls.push('search');return empty();}, searchOrganizations: empty },{id:42,crmPersonId:13,email:'person@example.test'},'r1');
    expect(calls).toEqual(['person']);
    expect(result.crmContactLink).toMatchObject({status:'verified',crmPersonId:13,method:'direct_agendor_link'});
    expect(result.candidateRead).toMatchObject({status:'not_needed'});
  });
  it('does not recover or create on a transient error reading the direct link', async () => {
    let searches=0;
    const result = await readCustomerCandidates({ getPerson: async () => {throw new SafeError('UPSTREAM_TIMEOUT','timeout',true);},searchPeople:async () => {searches++;return empty();},searchOrganizations:empty },{id:42,crmPersonId:13,phoneNumber:'+5565999990000'},'r1');
    expect(searches).toBe(0);
    expect(result.crmContactLink?.status).toBe('query_failed');
    expect(result.coverage.complete).toBe(false);
  });
});

describe('inbox isolation and resumable history', () => {
  it('checks the canonical inbox before reading any content', async () => {
    const reads: string[]=[];
    const reader=createConversationReader({ getConversation:async()=>({id:200,inboxId:9999}),validateConversation:c=>{if(c.inboxId!==4101)throw Error('blocked');},listAttachments:async()=>{reads.push('attachment');return {attachments:[],coverage};},listMessages:async()=>{reads.push('message');return {conversationId:200,messages:[],coverage};} });
    await expect(reader.readConversation({conversationId:200})).rejects.toThrow('blocked');
    expect(reads).toEqual([]);
  });
  it('keeps the last successful page when the budget defers a following page', async () => {
    const {client}=chat(200); let calls=0; const persisted: number[]=[];
    const reader=createConversationReader({...client,getConversation:async()=>({id:200,contact:{id:300}}),listAttachments:async()=>({attachments:[],coverage}),listMessages:async(id,input)=>{if(++calls===2)throw new SafeError('UPSTREAM_RATE_LIMITED','defer',true);return client.listMessages(id,input);} });
    const result=await reader.readConversation({conversationId:200},{onProgress:async s=>{persisted.push(s.messages.length);}});
    expect(result.messages).toHaveLength(100);expect(result.continuation?.after).toBe(101);expect(persisted).toContain(100);
    const complete=await createConversationReader({...client,getConversation:async()=>({id:200,contact:{id:300}}),listAttachments:async()=>({attachments:[],coverage})}).readConversation({conversationId:200},{previous:result});
    expect(complete.messages).toHaveLength(200);expect(complete.coverage.history?.complete).toBe(true);
  });
});

describe('authorized discovery',()=>{
  it('excludes missing or unauthorized inboxes and does not label a default page complete',async()=>{
    const c=createAgendorChatClient(env,{budgetGate:async()=>{},request:async()=>Response.json({data:{meta:{all_count:1002},payload:[{id:1,inbox_id:4101},{id:2,inbox_id:4102},{id:3,inbox_id:9999},{id:4}]}})});
    const result=await c.listConversations();expect(result.conversations.map(c=>c.id)).toEqual([1,2]);expect(result.coverage.missingReasons).toContain('conversation_pagination_incomplete');
  });
  it('reads a contact from its documented detail route',async()=>{
    const routes:string[]=[];const c=createAgendorChatClient(env,{budgetGate:async()=>{},request:async req=>{routes.push(new URL(req.url).pathname);return Response.json({payload:{id:300,name:'Person',agendor_person_id:13}});}});
    expect((await c.getContact(300)).contact?.crmPersonId).toBe(13);expect(routes).toEqual(['/api/v1/accounts/100/contacts/300']);
  });
});

describe('independent duplicate diagnostics',()=>{
  it('keeps a direct link verified while reporting an older same-name same-organization person',async()=>{
    const result=await readDuplicateCandidates({searchPeople:async input=>({items:[{id:1001,name:'João Silva',organization:99,contact:{mobile:'+5565999990001'}}],pageInfo:{page:input.page!,perPage:100,hasNext:false,nextPage:null}})},{ref:{kind:'person',id:2458},name:'João Silva',phone:'+5565999990002',organizationIds:[99],sourceRefs:[]});
    expect(result).toMatchObject({status:'possible_duplicate',currentPersonId:2458,candidatePersonIds:[1001],reasons:expect.arrayContaining(['same_normalized_name','same_organization'])});
  });
  it('does not treat a shared name alone as proof of duplication',async()=>{
    const result=await readDuplicateCandidates({searchPeople:async input=>({items:[{id:1001,name:'João Silva'}],pageInfo:{page:input.page!,perPage:100,hasNext:false,nextPage:null}})},{ref:{kind:'person',id:2458},name:'João Silva',organizationIds:[],sourceRefs:[]});
    expect(result.status).toBe('none');
  });
});

describe('large conversation enumeration',()=>{
  it('defaults conversation discovery to all statuses but preserves an explicit status filter',async()=>{
    const statuses:string[]=[];
    const c=createAgendorChatClient(env,{budgetGate:async()=>{},request:async req=>{
      const status=new URL(req.url).searchParams.get('status');statuses.push(status ?? '(omitted)');
      const payload=status==='open'?[{id:1,status:'open',inbox_id:4101}]:[{id:1,status:'open',inbox_id:4101},{id:2,status:'resolved',inbox_id:4101}];
      return Response.json({data:{payload,links:{next:null}}});
    }});

    const all=await c.listConversations();
    const open=await c.listConversations({status:'open'});

    expect(statuses).toEqual(['all','open']);
    expect(all.conversations.map(c=>c.status)).toEqual(['open','resolved']);
    expect(open.conversations.map(c=>c.status)).toEqual(['open']);
  });

  it('enumerates 1002 authorized IDs over eleven pages and resumable batches',async()=>{
    const visited:number[]=[];
    const c=createAgendorChatClient(env,{budgetGate:async()=>{},request:async req=>{
      const page=Number(new URL(req.url).searchParams.get('page') ?? 1);visited.push(page);
      const payload=Array.from({length:Math.min(100,1002-(page-1)*100)},(_,i)=>({id:(page-1)*100+i+1,inbox_id:4101}));
      return Response.json({data:{payload,links:{next:page<11?'https://chat.agendor.com.br/api/v1/accounts/100/conversations?page='+String(page+1):null}}});
    }});
    const ids=new Set<number>();let page:number|undefined;let pagesRead=0;
    for(let batch=0;batch<5;batch++) {const result=await c.listConversations(page?{page}:{});result.conversations.forEach(c=>ids.add(c.id));pagesRead+=result.coverage.pagesRead;page=result.pageInfo.nextPage ?? undefined;if(!page)break;}
    expect(ids.size).toBe(1002);expect(pagesRead).toBe(11);expect(visited).toEqual([1,2,3,4,5,6,7,8,9,10,11]);
  });
});
describe('bounded conversation pagination probes',()=>{
  it('continues across an empty page because empty responses are not terminal evidence',async()=>{
    const visited:number[]=[];
    const c=createAgendorChatClient(env,{budgetGate:async()=>{},request:async req=>{
      const page=Number(new URL(req.url).searchParams.get('page') ?? 1);visited.push(page);
      const ids=page===1?Array.from({length:25},(_,i)=>i+1):page===3?[76,77]:[];
      const payload=ids.map(id=>({id,inbox_id:4101}));
      return Response.json({data:{payload}});
    }});

    const result=await c.listConversations();

    expect(visited).toEqual([1,2,3]);
    expect(result.conversations).toHaveLength(27);
    expect(result.pageInfo).toMatchObject({page:3,endReached:false,complete:false});
    expect(result.coverage).toMatchObject({complete:false,paginationProbe:{pagesScanned:3,nextPage:4,emptyPage:2,stoppedBy:'page_limit'}});
  });

  it('returns a bounded probe cursor when more pages remain',async()=>{
    const visited:number[]=[];
    const c=createAgendorChatClient(env,{budgetGate:async()=>{},request:async req=>{
      const page=Number(new URL(req.url).searchParams.get('page') ?? 1);visited.push(page);
      return Response.json({data:{payload:Array.from({length:25},(_,i)=>({id:(page-1)*25+i+1,inbox_id:4101}))}});
    }});

    const first=await c.listConversations();
    const resumed=await c.listConversations({page:first.coverage.paginationProbe!.nextPage!});

    expect(visited).toEqual([1,2,3,4,5,6]);
    expect(first.coverage).toMatchObject({complete:false,paginationProbe:{pagesScanned:3,nextPage:4,stoppedBy:'page_limit'}});
    expect(resumed.coverage).toMatchObject({complete:false,paginationProbe:{pagesScanned:3,nextPage:7,stoppedBy:'page_limit'}});
  });
});

describe('review regressions',()=>{
  it('renews a contact link instead of trusting the conversation sender summary',async()=>{
    const refreshed=await readCanonicalConversation({getConversation:async()=>({id:42,inboxId:4101,contact:{id:7,crmPersonId:10}}),getContact:async id=>({contact:{id,crmPersonId:20}})},42,{allowedInboxIds:[4101,4102]});
    expect(refreshed.contact?.crmPersonId).toBe(20);
  });
  it('defers rather than persisting a query failure when shared credit prevents the direct CRM read',async()=>{
    await expect(readCustomerCandidates({getPerson:async()=>{throw new BudgetDeferredError();},searchPeople:empty,searchOrganizations:empty},{id:42,crmPersonId:13},'r1')).rejects.toMatchObject({code:'UPSTREAM_RATE_LIMITED'});
  });
  it('uses a recovered person for durable-customer lookup without claiming a native link',async()=>{
    const c=await readCustomerCandidates({getPerson:async()=>{throw Error('unused');},searchPeople:async()=>({items:[{id:13,name:'Person',contact:{mobile:'+5565999990000'}}],pageInfo:{page:1,perPage:100,hasNext:false,nextPage:null}}),searchOrganizations:empty},{id:42,phoneNumber:'+5565999990000'},'r1');
    expect(c.crmContactLink?.status).toBe('missing');expect(c.verifiedLinks).toEqual([]);
    expect(candidateLookupLinks(c).map(l=>l.ref)).toEqual([{kind:'person',id:13}]);
  });
});

it('projects only scope evidence and rejects conflicting inbox fields', async () => {
  const client = createAgendorChatClient(env, { budgetGate: async () => {}, request: async () => Response.json({
    id: 200, inbox_id: 4101, meta: { inbox: { id: 4102 }, sender: { id: 300, email: 'private@example.test' } },
    last_non_activity_message: { content: 'private content' }, messages: [{ id: 2, content: 'inline content' }],
  }) });
  const result = await client.getConversation(200, { scopeOnly: true });
  expect(result).toEqual({ id: 200, contact: { id: 300 } });
});

it('stops attachment pagination at the requested cap even with a verified next link', async () => {
  const urls: string[] = [];
  const client = createAgendorChatClient(env, { budgetGate: async () => {}, request: async req => {
    const path = new URL(req.url).pathname;
    urls.push(path);
    if (path.endsWith('/attachments')) return Response.json({ payload: [{ id: 31 }], links: { next: path + '?page=2' } });
    return Response.json({ payload: [] });
  } });
  const reader = createConversationReader({ ...client, getConversation: async () => ({ id: 200, inboxId: 4101, contact: { id: 300 } }) });
  const snapshot = await reader.readConversation({ conversationId: 200 }, { maxAttachmentPages: 1 });
  expect(urls.filter(path => path.endsWith('/attachments'))).toHaveLength(1);
  expect(snapshot.attachmentListing).toMatchObject({ pagesRead: 1, complete: false, nextPage: null });
  expect(snapshot.coverage.missingReasons).toContain('attachment_page_limit');
});
