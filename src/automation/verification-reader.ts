import {createConversationReader,type ConversationReaderDependencies,type ReadProgress} from '../agendor/chat/contacts';
import {SafeError} from '../errors';
/** A bounded read batch is not SOURCE_CHANGED. Continue locally when credit is
 * available; persist and defer only when the actual transport/budget cannot proceed. */
export async function readVerificationSnapshot(deps:ConversationReaderDependencies,conversationId:number,progress:ReadProgress) {
  let previous=progress.previous;
  for(let batch=0;batch<12;batch++) {
    const snapshot=await createConversationReader(deps).readConversation({conversationId},{...progress,previous});
    if(!snapshot.continuation && !snapshot.attachmentListing?.nextPage)return snapshot;
    if(snapshot.coverage.missingReasons.includes('history_read_deferred'))throw new SafeError('UPSTREAM_RATE_LIMITED','Canonical history verification deferred.',true,429);
    if(snapshot.coverage.missingReasons.includes('history_query_failed') || snapshot.messages.length>=10000)throw new SafeError('UPSTREAM_INVALID_RESPONSE','Canonical history verification limit reached.',false);
    previous=snapshot;
  }
  throw new SafeError('UPSTREAM_RATE_LIMITED','Canonical verification requires continuation.',true,429);
}
