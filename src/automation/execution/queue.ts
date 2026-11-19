import { TENANT_ACCOUNT_KEY } from '../../app/config/tenant';
import { SafeError } from '../../shared/errors';
import { readJson } from '../../shared/json';
import { readVerificationSnapshot } from './verification-reader';
import { assertInboxAllowed } from '../../domain/inbox-policy';
import { z } from 'zod';
import type { Env } from '../../env';
import { accountState } from '../state/budget';
import { resumeOperation, type ExecutionDeps } from './executor';
import {
  createAgendorChatClient,
  createAgendorCrmClient,
  createCrmMutationClient,
  readCanonicalConversation,
} from '../clients';
import { matchesFields, readRef, resolvedTarget } from './reconciliation';
import { canonical } from '../operations';
import { catalogSnapshotSchema } from '../schemas';
import { workflowStateSchema } from '../service-state';

export const automationQueuePayloadSchema = z.strictObject({
  accountKey: z.literal(TENANT_ACCOUNT_KEY),
  operationId: z.string().min(1).max(200),
  version: z.number().int().positive(),
});
export type AutomationQueuePayload = z.infer<typeof automationQueuePayloadSchema>;
interface QueueBatch {
  messages: readonly { body: unknown; ack(): void; retry(options?: { delaySeconds?: number }): void }[];
}
export async function enqueueOperation(
  operationId: string,
  deps: Pick<ExecutionDeps, 'repository' | 'accountKey'> & {
    queue: { send(body: AutomationQueuePayload): Promise<unknown> };
  },
): Promise<void> {
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
  const repository = accountState(env);
  const operation = await repository.getOperation(payload.operationId);
  if (!operation) throw Error('OPERATION_UNAVAILABLE');
  const reads = createAgendorCrmClient(env);
  const catalog = readJson(catalogSnapshotSchema, operation.input.catalogJson, 'operation.input.catalogJson');
  const deps: ExecutionDeps = {
    repository,
    basis: operation.input.basis,
    requestId: operation.input.requestId,
    accountKey: TENANT_ACCOUNT_KEY,
    catalog,
    reads,
    legacy: reads,
    mutations: createCrmMutationClient({ env, catalog }),
    async verify(command, phase, stored) {
      const workflowJson = await repository.getWorkflow(stored.input.basis.lease.workId);
      const workflow = workflowJson ? readJson(workflowStateSchema, workflowJson, 'workflow') : undefined;
      if (workflow?.direct) {
        const direct = workflow.direct;
        const actor = stored.input.authorization.actor;
        if (
          canonical(direct.command) !== canonical(command) ||
          canonical(workflow.lease) !== canonical(stored.input.basis.lease) ||
          workflow.lease.owner.userId !== actor.userId ||
          workflow.lease.owner.clientId !== actor.clientId ||
          command.requiredCapabilities.length !== 1 ||
          command.requiredCapabilities[0] !== direct.capability ||
          !actor.scopes.includes(direct.capability) ||
          command.sourceRefs.length !== 1 ||
          command.sourceRefs[0]?.kind !== 'operator' ||
          command.sourceRefs[0].id !== actor.userId ||
          command.sourceRefs[0].revision !== direct.digest
        )
          return ['DIRECT_AUTHORIZATION_CHANGED'];
        // A direct request remains bound to the original typed command and
        // actor. Queue bodies carry only a reference, never operator evidence.
        if (command.kind === 'create_deal' || command.kind === 'create_task') {
          if (!('id' in command.target)) return ['PARENT_UNVERIFIED'];
          const parent = await readRef(command.target, reads);
          if (!parent || typeof parent !== 'object' || !('id' in parent) || parent.id !== command.target.id)
            return ['PARENT_UNVERIFIED'];
        }
        return [];
      }
      if (command.kind === 'create_person') return ['CHAT_PERSON_CREATION_REQUIRES_REVIEW'];
      const policy = await repository.getExecutionPolicy();
      if (
        !policy ||
        policy.mode !== 'apply' ||
        policy.version !== stored.input.authorization.plan.policyVersion ||
        command.requiredCapabilities.some((c) => !policy.capabilities.includes(c))
      )
        return ['POLICY_CHANGED'];
      if (!workflow?.conversationIds.length) return ['INBOX_UNAVAILABLE'];
      const chat = createAgendorChatClient(env, { waitForBudget: true });
      const passKey = JSON.stringify([command.commandKey, phase]);
      const persist = async () => {
        const expected = workflow.revision;
        workflow.revision++;
        await repository.saveWorkflow(workflow, expected);
      };
      if (workflow.verificationPass?.key !== passKey) {
        workflow.verificationPass = { key: passKey, inboxes: [] };
        workflow.verificationReads = {};
        await persist();
      }
      for (const conversationId of workflow.conversationIds) {
        try {
          assertInboxAllowed(await chat.getConversation(conversationId), policy);
        } catch (error) {
          if (error instanceof SafeError && error.retryable) throw error;
          return ['INBOX_NOT_AUTHORIZED'];
        }
      }
      // A field absent during preparation may have been filled by a human.
      // Verify the full observed record hash as well as the new fact sources.
      const verificationSources = [...command.sourceRefs, ...command.before.flatMap((f) => f.sources)];
      for (const source of verificationSources) {
        if (source.kind === 'message' || source.kind === 'contact') {
          const conversationIds =
            source.kind === 'message'
              ? [Number(source.id.split(':')[0])]
              : [
                  ...new Set(
                    stored.input.authorization.plan.sourceRefs
                      .filter((s) => s.kind === 'message')
                      .map((s) => Number(s.id.split(':')[0])),
                  ),
                ];
          if (!conversationIds.length || conversationIds.some((id) => !Number.isSafeInteger(id) || id <= 0))
            return ['SOURCE_UNVERIFIED'];
          let found = false;
          for (const conversationId of conversationIds) {
            const previous = workflow.verificationReads?.[String(conversationId)];
            const snapshot =
              previous && !previous.continuation && !previous.attachmentListing?.nextPage
                ? previous
                : await readVerificationSnapshot(
                    {
                      ...chat,
                      getConversation: (id) => readCanonicalConversation(chat, id, policy),
                      validateConversation: (c) => assertInboxAllowed(c, policy),
                    },
                    conversationId,
                    {
                      previous,
                      onProgress: async (snapshot) => {
                        workflow.verificationReads ??= {};
                        workflow.verificationReads[String(conversationId)] = snapshot;
                        await persist();
                      },
                    },
                  );
            const known =
              source.kind === 'message'
                ? snapshot.messages.some((m) => String(m.id) === source.id.split(':')[1])
                : String(snapshot.contact?.id) === source.id;
            if (known && snapshot.revision === source.revision) found = true;
          }
          if (!found) return ['SOURCE_CHANGED'];
        } else if (source.kind === 'crm') {
          const [kind, rawId] = source.id.split(':');
          const id = Number(rawId);
          if (!['organization', 'person', 'deal', 'task'].includes(kind ?? '') || !Number.isSafeInteger(id) || id <= 0)
            return ['SOURCE_UNVERIFIED'];
          const ref = { kind: kind as 'organization' | 'person' | 'deal' | 'task', id };
          const target = await resolvedTarget(command, stored.operationId, repository);
          // This command's own effect is checked through its receipt, so its
          // previous source hash is expected to change after a PUT.
          if (phase === 'after' && target?.kind === ref.kind && target.id === ref.id) continue;
          const record = await readRef(ref, reads);
          const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(record)));
          const revision = [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, '0')).join('');
          if (revision !== source.revision) return ['SOURCE_CHANGED'];
        } else return ['OPERATOR_SOURCE_REQUIRES_INTERACTIVE_VERIFICATION'];
      }
      const target = await resolvedTarget(command, stored.operationId, repository);
      if (phase === 'before' && target && !command.kind.startsWith('create_') && command.before.length) {
        const current = await readRef(target, reads);
        const fields = Object.fromEntries(command.before.map((f) => [f.field, f.value]));
        if (!matchesFields(current, fields)) return ['CRM_CHANGED'];
      }
      // Recheck canonical inboxes on every dispatch attempt, including a retry
      // that reused already-read source snapshots. A persisted pass is not authority.
      for (const conversationId of workflow.conversationIds) {
        try {
          assertInboxAllowed(await chat.getConversation(conversationId), policy);
        } catch (error) {
          if (error instanceof SafeError && (error.code === 'MCP_UNAUTHORIZED' || error.code === 'POLICY_BLOCKED'))
            return ['INBOX_NOT_AUTHORIZED'];
          throw error;
        }
      }
      delete workflow.verificationPass;
      delete workflow.verificationReads;
      await persist();
      return [];
    },
  };
  return deps;
}
export async function handleAutomationQueue(
  batch: QueueBatch,
  env: Env,
  factory: (
    payload: AutomationQueuePayload,
    env: Env,
  ) => ExecutionDeps | Promise<ExecutionDeps> = createQueueExecutionDeps,
): Promise<void> {
  for (const message of batch.messages) {
    const parsed = automationQueuePayloadSchema.safeParse(message.body);
    if (!parsed.success) {
      message.ack();
      continue;
    }
    try {
      const deps = await factory(parsed.data, env);
      const operation = await deps.repository.getOperation(parsed.data.operationId);
      if (
        !operation ||
        operation.version !== parsed.data.version ||
        operation.input.accountKey !== parsed.data.accountKey
      ) {
        message.ack();
        continue;
      }
      const status = await resumeOperation(operation, { ...deps, defer: false });
      if (status.state === 'applied') await deps.repository.publishOperationContext(operation.operationId);
      if (status.state === 'queued' || status.state === 'uncertain') {
        const commands = await Promise.all(
          operation.input.authorization.plan.orderedCommands.map((c) =>
            deps.repository.getExecutionCommand(c.commandKey),
          ),
        );
        const next = commands.reduce((deadline, c) => Math.max(deadline, c?.nextAttemptAt ?? 0), Date.now() + 10_000);
        message.retry({ delaySeconds: Math.min(43_200, Math.max(1, Math.ceil((next - Date.now()) / 1000))) });
      } else message.ack();
    } catch {
      message.retry({ delaySeconds: 10 });
    }
  }
}
