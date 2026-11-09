import type { AgendorCrmClient } from '../agendor/crm/types';
import type { CustomerCandidate, CustomerCandidates, Fact } from './types';
import { SafeError } from '../errors';
const normalizedName=(v:string)=>v.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('pt-BR');
const object=(v:unknown):Record<string,unknown>=>v!==null && typeof v==='object' && !Array.isArray(v) ? v as Record<string,unknown> : {};
/** Diagnostic only. A duplicate never changes the native contact/person link. */
export async function readDuplicateCandidates(crm: Pick<AgendorCrmClient,'searchPeople'>, current: CustomerCandidate, facts: readonly Fact[] = []): Promise<NonNullable<CustomerCandidates['duplicateCheck']>> {
  const base={currentPersonId:current.ref.id};
  const ids=new Set<number>(); const reasons=new Set<string>(); let strong=false;
  const organizations=new Set([...current.organizationIds,...facts.flatMap(f=>f.entity==='person' && f.field==='organization' && f.certainty==='confirmed' && typeof f.value==='number' ? [f.value] : [])]);
  const filters=[{query:current.name},...(current.email?[{email:current.email}]:[]),...(current.document && current.document.replace(/\D/g,'').length===11?[{cpf:current.document.replace(/\D/g,'')}]:[])];
  for(const filter of filters) {
    let page=1; const fingerprints=new Set<string>();
    for(let count=0;count<10;count++) {
      let result;
      try {result=await crm.searchPeople({...filter,page,perPage:100});}
      catch(error) {if(error instanceof SafeError && error.retryable)throw error;return {...base,status:'query_failed'};}
      if(result.pageInfo.page!==page || result.items.length>100) return {...base,status:'query_failed'};
      const fingerprint=JSON.stringify(result.items.map(v=>object(v).id));
      if(result.items.length && fingerprints.has(fingerprint)) return {...base,status:'query_failed'};
      fingerprints.add(fingerprint);
      for(const item of result.items) {
        const r=object(item), contact=object(r.contact); const organization=typeof r.organization==='number'?r.organization:object(r.organization).id;
        if(typeof r.id!=='number' || !Number.isSafeInteger(r.id) || r.id<=0 || typeof r.name!=='string') return {...base,status:'query_failed'};
        if(r.id===current.ref.id) continue;
        const sameMail=current.email && typeof contact.email==='string' && current.email.trim().toLowerCase()===contact.email.trim().toLowerCase();
        const sameDocument=current.document && typeof r.cpf==='string' && current.document.replace(/\D/g,'')===r.cpf.replace(/\D/g,'');
        const sameName=normalizedName(current.name)===normalizedName(r.name);
        const sameOrganization=typeof organization==='number' && organizations.has(organization);
        if(sameMail || sameDocument || (sameName && sameOrganization)) {
          ids.add(r.id);if(sameMail){reasons.add('exact_email');strong=true;}if(sameDocument){reasons.add('exact_cpf');strong=true;}
          if(sameName)reasons.add('same_normalized_name');if(sameOrganization)reasons.add('same_organization');
        }
      }
      if(!result.pageInfo.hasNext) {if(result.pageInfo.nextPage!==null)return {...base,status:'query_failed'};break;}
      if(result.pageInfo.nextPage!==page+1 || count===9)return {...base,status:'query_failed'};
      page=result.pageInfo.nextPage;
    }
  }
  return {...base,status:ids.size ? strong?'high_confidence_duplicate':'possible_duplicate' : 'none',candidatePersonIds:[...ids].sort((a,b)=>a-b),reasons:[...reasons].sort()};
}
