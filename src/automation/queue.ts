import { z } from 'zod';
import type { Env } from '../env';
import { accountState } from './state/budget';
import { resumeOperation, type ExecutionDeps } from './executor';
import { createCrmMutationClient } from '../agendor/crm/mutations';
import { createAgendorCrmClient } from '../agendor/crm/client';
import { createAgendorChatClient, createConversationReader } from '../agendor/chat/client';
import { matchesFields, readRef, resolvedTarget } from './reconciliation';
import type { CatalogSnapshot } from '../agendor/crm/types';
import { canonical } from './operations';
import type { WorkflowState } from './service-state';

export const automationQueuePayloadSchema = z.strictObject({ accountKey: z.literal('elotenant'), operationId: z.string().min(1).max(200), version: z.number().int().positive() });
export type AutomationQueuePayload = z.infer<typeof automationQueuePayloadSchema>;
interface QueueBatch { messages: readonly { body: unknown; ack(): void; retry(options?: { delaySeconds?: number }): void }[] }
export async function enqueueOperation(operationId: string, deps: Pick<ExecutionDeps, 'repository' | 'accountKey'> & { queue: { send(body: AutomationQueuePayload): Promise<unknown> } }): Promise<void> {
  const operation = await deps.repository.getOperation(operationId);
  if (!operation) throw Error('OPERATION_UNAVAILABLE');
  for (const command of operation.input.authorization.plan.orderedCommands) {
    const ledger = await deps.repository.getExecutionCommand(command.commandKey);
    if (!ledger || ledger.operationId !== operationId) throw Error('OPERATION_NOT_RESERVED');
  }
  await deps.queue.send({ accountKey: deps.accountKey, operationId, version: operation.version });
}

/** Server-owned factory. No credentials, routes or capability claims arrive in
 * a Queue body. Canonical reads fail closed if their revisions cannot be proven. */
export async function createQueueExecutionDeps(payload: AutomationQueuePayload, env: Env): Promise<ExecutionDeps> {
  const repository = accountState(env); const operation = await repository.getOperation(payload.operationId);
  if (!operation) throw Error('OPERATION_UNAVAILABLE');
  const reads = createAgendorCrmClient(env);
  const catalog = JSON.parse(operation.input.catalogJson) as CatalogSnapshot;
  const deps: ExecutionDeps = { repository, basis: operation.input.basis, requestId: operation.input.requestId, accountKey: 'elotenant', catalog, reads, legacy: reads,
    mutations: createCrmMutationClient({ env, catalog }),
    async verify(command, phase, stored) {
      const workflowJson = await repository.getWorkflow(stored.input.basis.lease.workId);
      const workflow = workflowJson ? JSON.parse(workflowJson) as WorkflowState : undefined;
      if (workflow?.direct) {
        const direct = workflow.direct; const actor = stored.input.authorization.actor;
        if (canonical(direct.command) !== canonical(command) || canonical(workflow.lease) !== canonical(stored.input.basis.lease) || workflow.lease.owner.userId !== actor.userId || workflow.lease.owner.clientId !== actor.clientId || command.requiredCapabilities.length !== 1 || command.requiredCapabilities[0] !== direct.capability || !actor.scopes.includes(direct.capability) || command.sourceRefs.length !== 1 || command.sourceRefs[0]?.kind !== 'operator' || command.sourceRefs[0].id !== actor.userId || command.sourceRefs[0].revision !== direct.digest) return ['DIRECT_AUTHORIZATION_CHANGED'];
        // A direct request remains bound to the original typed command and
        // actor. Queue bodies carry only a reference, never operator evidence.
        if (command.kind === 'create_deal' || command.kind === 'create_task') {
          if (!('id' in command.target)) return ['PARENT_UNVERIFIED'];
          const parent = await readRef(command.target, reads);
          if (!parent || typeof parent !== 'object' || !('id' in parent) || parent.id !== command.target.id) return ['PARENT_UNVERIFIED'];
        }
        return [];
      }
      const policy = await repository.getExecutionPolicy();
      if (!policy || policy.mode !== 'apply' || policy.version !== stored.input.authorization.plan.policyVersion || command.requiredCapabilities.some(c => !policy.capabilities.includes(c))) return ['POLICY_CHANGED'];
      for (const source of command.sourceRefs) {
        if (source.kind === 'message' || source.kind === 'contact') {
          const conversationIds = source.kind === 'message' ? [Number(source.id.split(':')[0])] : [...new Set(stored.input.authorization.plan.sourceRefs.filter(s => s.kind === 'message').map(s => Number(s.id.split(':')[0])))];
          if (!conversationIds.length || conversationIds.some(id => !Number.isSafeInteger(id) || id <= 0)) return ['SOURCE_UNVERIFIED'];
          const reader = createConversationReader(createAgendorChatClient(env)); let found = false;
          for (const conversationId of conversationIds) {
            const snapshot = await reader.readConversation({ conversationId });
            const known = source.kind === 'message' ? snapshot.messages.some(m => String(m.id) === source.id.split(':')[1]) : String(snapshot.contact?.id) === source.id;
            if (known && snapshot.revision === source.revision) found = true;
          }
          if (!found) return ['SOURCE_CHANGED'];
        } else if (source.kind === 'crm') {
          const [kind, rawId] = source.id.split(':'); const id = Number(rawId);
          if (!['organization', 'person', 'deal', 'task'].includes(kind ?? '') || !Number.isSafeInteger(id) || id <= 0) return ['SOURCE_UNVERIFIED'];
          const ref = { kind: kind as 'organization' | 'person' | 'deal' | 'task', id };
          const target = await resolvedTarget(command, stored.operationId, repository);
          // This command's own effect is checked through its receipt, so its
          // previous source hash is expected to change after a PUT.
          if (phase === 'after' && target?.kind === ref.kind && target.id === ref.id) continue;
          const record = await readRef(ref, reads);
          const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(record)));
          const revision = [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('');
          if (revision !== source.revision) return ['SOURCE_CHANGED'];
        } else return ['OPERATOR_SOURCE_REQUIRES_INTERACTIVE_VERIFICATION'];
      }
      const target = await resolvedTarget(command, stored.operationId, repository);
      if (phase === 'before' && target && !command.kind.startsWith('create_') && command.before.length) {
        const current = await readRef(target, reads);
        const fields = Object.fromEntries(command.before.map(f => [f.field, f.value]));
        if (!matchesFields(current, fields)) return ['CRM_CHANGED'];
      }
      return [];
    } };
  return deps;
}
export async function handleAutomationQueue(batch: QueueBatch, env: Env, factory: (payload: AutomationQueuePayload, env: Env) => ExecutionDeps | Promise<ExecutionDeps> = createQueueExecutionDeps): Promise<void> {
  for (const message of batch.messages) {
    const parsed = automationQueuePayloadSchema.safeParse(message.body);
    if (!parsed.success) { message.ack(); continue; }
    try {
      const deps = await factory(parsed.data, env);
      const operation = await deps.repository.getOperation(parsed.data.operationId);
      if (!operation || operation.version !== parsed.data.version || operation.input.accountKey !== parsed.data.accountKey) { message.ack(); continue; }
      const status = await resumeOperation(operation, { ...deps, defer: false });
      if (status.state === 'applied') await accountState(env).completeDirectOperation(operation.operationId);
      if (status.state === 'queued' || status.state === 'uncertain') message.retry({ delaySeconds: 10 }); else message.ack();
    } catch { message.retry({ delaySeconds: 10 }); }
  }
}
