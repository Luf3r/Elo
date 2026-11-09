import { describe,expect,it } from 'vitest';
import {isInboxAllowed,assertInboxAllowed} from '../../src/automation/inbox-policy';
import {collectionPageInfo} from '../../src/agendor/chat/pagination';
describe('inbox allowlist',()=>{
  it('denies empty policy, missing inbox and boxes outside both allowlists',()=>{
    expect(isInboxAllowed(4101)).toBe(true);expect(isInboxAllowed(4102)).toBe(true);
    expect(isInboxAllowed(4101,{allowedInboxIds:[]})).toBe(false);
    expect(isInboxAllowed(undefined)).toBe(false);expect(isInboxAllowed(9999,{allowedInboxIds:[9999]})).toBe(false);
    expect(()=>assertInboxAllowed({inboxId:4102},{allowedInboxIds:[4101]})).toThrow();
  });
});
describe('collection continuation evidence',()=>{
  const path='/accounts/100/conversations';
  it('does not turn a count or short default page into terminal evidence',()=>{
    expect(collectionPageInfo({data:{meta:{all_count:1002},payload:[]}},1,path)).toMatchObject({complete:false,hasNext:null});
  });
  it('validates exact route and exclusive page advancement before exposing continuation',()=>{
    expect(collectionPageInfo({links:{next:'https://chat.agendor.com.br/api/v1/accounts/100/conversations?page=2'}},1,path)).toMatchObject({nextPage:2,hasNext:true,complete:false});
    for(const next of ['https://evil.test/api/v1/accounts/100/conversations?page=2','https://chat.agendor.com.br/api/v1/accounts/101/conversations?page=2','https://chat.agendor.com.br/api/v1/accounts/100/conversations?page=1'])expect(collectionPageInfo({links:{next}},1,path).hasNext).toBeNull();
    expect(collectionPageInfo({links:{next:null}},1,path).complete).toBe(true);
    expect(collectionPageInfo({links:{next:null}},2,path)).toMatchObject({endReached:true,complete:false});
  });
});
