import type { BudgetGate } from '../ports';
import type { Env } from '../../env';
import { z } from 'zod';
import type { AgendorCrmClient } from './types';
import { fetchJson } from '../../shared/http';
import { SafeError } from '../../shared/errors';
import { isConfiguredSecret } from '../../auth';
import { normalizePage } from './pagination';
import { normalizeCatalogPage } from './catalog';
import {
  parseConfiguration,
  taskDetailEnvelope,
  personOptionsInput,
  peopleInput,
  organizationsInput,
  dealsInput,
  tasksInput,
  positiveId,
  updateIdInput,
  detailEnvelope,
  parseInput,
  updateDealInput,
  updateDealStageInput,
  updatePersonInput,
  updateOrganizationInput,
} from './schemas';
import { throwIfCancelled } from '../../shared/cancellation';

export interface CrmClientOptions {
  budgetGate: BudgetGate;
  signal?: AbortSignal;
}

export function createAgendorCrmClient(
  env: Pick<Env, 'AGENDOR_CRM_TOKEN'>,
  options: CrmClientOptions,
): AgendorCrmClient {
  const { budgetGate } = options;
  async function get(path: string, params: Record<string, string | number | boolean | undefined> = {}) {
    throwIfCancelled(options.signal);
    if (!isConfiguredSecret(env.AGENDOR_CRM_TOKEN))
      throw new SafeError('UPSTREAM_UNAVAILABLE', 'CRM service is not configured.', false, 503);
    const url = new URL(`https://api.agendor.com.br/v3${path}`);
    for (const [name, value] of Object.entries(params))
      if (value !== undefined && value !== '') url.searchParams.set(name, String(value));
    await budgetGate();
    throwIfCancelled(options.signal);
    return fetchJson<unknown>(
      new Request(url, {
        method: 'GET',
        signal: options.signal,
        headers: { Authorization: `Token ${env.AGENDOR_CRM_TOKEN}`, Accept: 'application/json' },
      }),
    );
  }
  async function list(
    path: string,
    input: { page: number; perPage: number },
    filters: Record<string, string | number | boolean | undefined> = {},
  ) {
    return normalizePage(
      await get(path, { page: input.page, per_page: input.perPage, ...filters }),
      input.page,
      input.perPage,
    );
  }
  async function detail(path: string, id: number, params: Record<string, string | number | boolean | undefined> = {}) {
    const validId = parseInput(positiveId, id);
    const result = detailEnvelope.safeParse(await get(`${path}/${validId}`, params));
    if (!result.success) throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Invalid upstream record.', false);
    return result.data.data;
  }
  async function update(route: string, expectedId: number, fields: unknown, schema: z.ZodType) {
    const payload = parseInput(schema, fields) as Record<string, unknown>;
    throwIfCancelled(options.signal);
    if (!isConfiguredSecret(env.AGENDOR_CRM_TOKEN))
      throw new SafeError('UPSTREAM_UNAVAILABLE', 'CRM service is not configured.', false, 503);
    const url = new URL(`https://api.agendor.com.br/v3${route}`);
    await budgetGate();
    throwIfCancelled(options.signal);
    const response = await fetchJson<unknown>(
      new Request(url, {
        method: 'PUT',
        signal: options.signal,
        headers: {
          Authorization: `Token ${env.AGENDOR_CRM_TOKEN}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }),
    );
    const result = detailEnvelope.safeParse(response);
    if (!result.success || result.data.data.id !== expectedId)
      throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Invalid upstream update response.', false);
    return { id: expectedId, updatedFields: Object.keys(payload).filter((key) => key !== 'checkRequiredFields') };
  }
  return {
    async searchPeople(input) {
      const v = parseInput(peopleInput, input);
      return list('/people', v, {
        ...(v.email ? { email: v.email } : {}),
        ...(v.query ? { name: v.query } : {}),
        phone: v.phone,
        cpf: v.cpf,
        organization: v.organizationId,
        withCustomFields: v.withCustomFields,
        createdAtGt: v.createdAtGt,
        createdAtLt: v.createdAtLt,
        updatedAtGt: v.updatedAtGt,
        updatedAtLt: v.updatedAtLt,
      });
    },
    getPerson: (id, options = {}) => detail('/people', id, parseInput(personOptionsInput, options)),
    async getTask(id) {
      const validId = parseInput(positiveId, id);
      const result = taskDetailEnvelope.safeParse(await get(`/tasks/${validId}`));
      if (!result.success) throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Invalid upstream task record.', false);
      return result.data.task_entity;
    },
    async getConfiguration(input) {
      const v = parseConfiguration(input);
      const paths = {
        funnels: '/funnels',
        stages: '/deal_stages',
        users: '/users',
        products: '/products',
        origins: '/lead_origins',
        categories: '/categories',
        sectors: '/sectors',
      } as const;
      const path =
        v.section === 'customFields'
          ? `/custom_fields/${v.entityType}`
          : v.section === 'cities'
            ? `/states/${v.state}/cities`
            : paths[v.section];
      const params =
        v.section === 'products'
          ? { page: v.page, per_page: v.perPage }
          : v.section === 'stages'
            ? { funnel: v.funnelId }
            : {};
      return normalizeCatalogPage(await get(path, params), v);
    },
    async searchOrganizations(input) {
      const v = parseInput(organizationsInput, input);
      return list('/organizations', v, {
        name: v.query,
        nameExact: v.exactName,
        cnpj: v.cnpj,
        phone: v.phone,
        email: v.email,
        withCustomFields: v.withCustomFields,
        createdAtGt: v.createdAtGt,
        createdAtLt: v.createdAtLt,
        updatedAtGt: v.updatedAtGt,
        updatedAtLt: v.updatedAtLt,
      });
    },
    getOrganization: (id) => detail('/organizations', id),
    async searchDeals(input) {
      const v = parseInput(dealsInput, input);
      return list('/deals', v, {
        title: v.query,
        organization: v.organizationId,
        person: v.personId,
        userOwner: v.ownerId,
        dealStatus: v.status,
        titleSearch: v.titleSearch,
        funnels: v.funnelIds?.join(','),
        dealStage: v.stageId,
        dealStageOrder: v.stageSequence,
        withCustomFields: v.withCustomFields,
        createdAtGt: v.createdAtGt,
        createdAtLt: v.createdAtLt,
        updatedAtGt: v.updatedAtGt,
        updatedAtLt: v.updatedAtLt,
        startAtGt: v.startAtGt,
        startAtLt: v.startAtLt,
        endAtGt: v.endAtGt,
        endAtLt: v.endAtLt,
      });
    },
    getDeal: (id) => detail('/deals', id),
    updateDeal: (id, fields) => {
      const validId = parseInput(updateIdInput.shape.id, id);
      return update(`/deals/${validId}`, validId, fields, updateDealInput);
    },
    async updateDealStage(id, fields) {
      const validId = parseInput(updateIdInput.shape.id, id);
      const parsed = parseInput(updateDealStageInput, fields);
      return update(
        `/deals/${validId}/stage`,
        validId,
        { ...parsed, checkRequiredFields: true },
        updateDealStageInput.extend({ checkRequiredFields: z.literal(true) }),
      );
    },
    updatePerson: (id, fields) => {
      const validId = parseInput(updateIdInput.shape.id, id);
      return update(`/people/${validId}`, validId, fields, updatePersonInput);
    },
    updateOrganization: (id, fields) => {
      const validId = parseInput(updateIdInput.shape.id, id);
      return update(`/organizations/${validId}`, validId, fields, updateOrganizationInput);
    },
    async listTasks(input) {
      const v = parseInput(tasksInput, input);
      const path =
        v.dealId !== undefined
          ? `/deals/${v.dealId}/tasks`
          : v.personId !== undefined
            ? `/people/${v.personId}/tasks`
            : v.organizationId !== undefined
              ? `/organizations/${v.organizationId}/tasks`
              : '/tasks';
      return list(path, v, { updatedDateGt: v.updatedDateGt });
    },
  };
}
