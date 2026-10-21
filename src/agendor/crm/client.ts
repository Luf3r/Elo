import type { Env } from '../../env';
import type { AgendorCrmClient } from './types';
import { fetchJson } from '../../http';
import { SafeError } from '../../errors';
import { isConfiguredSecret } from '../../auth';
import { normalizePage } from './pagination';
import { peopleInput, organizationsInput, dealsInput, tasksInput, positiveId, detailEnvelope, parseInput } from './schemas';

export function createAgendorCrmClient(env: Pick<Env, 'AGENDOR_CRM_TOKEN'>): AgendorCrmClient {
  async function get(path: string, params: Record<string, string | number | undefined> = {}) {
    if (!isConfiguredSecret(env.AGENDOR_CRM_TOKEN)) throw new SafeError('UPSTREAM_UNAVAILABLE', 'CRM service is not configured.', false, 503);
    const url = new URL(`https://api.agendor.com.br/v3${path}`);
    for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== '') url.searchParams.set(name, String(value));
    return fetchJson<unknown>(new Request(url, { method: 'GET', headers: { Authorization: `Token ${env.AGENDOR_CRM_TOKEN}`, Accept: 'application/json' } }));
  }
  async function list(path: string, input: { page: number; perPage: number }, filters: Record<string, string | number | undefined> = {}) {
    return normalizePage(await get(path, { page: input.page, per_page: input.perPage, ...filters }), input.page, input.perPage);
  }
  async function detail(path: string, id: number) {
    const validId = parseInput(positiveId, id);
    const result = detailEnvelope.safeParse(await get(`${path}/${validId}`));
    if (!result.success) throw new SafeError('UPSTREAM_INVALID_RESPONSE', 'Invalid upstream record.', false);
    return result.data.data;
  }
  return {
    async searchPeople(input) {
      const v = parseInput(peopleInput, input);
      return list('/people', v, { ...(v.email ? { email: v.email } : {}), ...(v.query ? { name: v.query } : {}) });
    },
    async searchOrganizations(input) {
      const v = parseInput(organizationsInput, input);
      return list('/organizations', v, { name: v.query });
    },
    getOrganization: id => detail('/organizations', id),
    async searchDeals(input) {
      const v = parseInput(dealsInput, input);
      return list('/deals', v, { title: v.query, organization: v.organizationId, person: v.personId, userOwner: v.ownerId, dealStatus: v.status });
    },
    getDeal: id => detail('/deals', id),
    async listTasks(input) {
      const v = parseInput(tasksInput, input);
      const path = v.dealId !== undefined ? `/deals/${v.dealId}/tasks`
        : v.personId !== undefined ? `/people/${v.personId}/tasks`
        : v.organizationId !== undefined ? `/organizations/${v.organizationId}/tasks` : '/tasks';
      return list(path, v, { updatedDateGt: v.updatedDateGt });
    },
  };
}
