export interface PageInfo {
  page: number;
  perPage: number;
  hasNext: boolean;
  nextPage: number | null;
}
export interface PagedResult<T> {
  items: T[];
  pageInfo: PageInfo;
}
export interface ListInput {
  page?: number;
  perPage?: number;
}
export interface DateFilters {
  createdAtGt?: string;
  createdAtLt?: string;
  updatedAtGt?: string;
  updatedAtLt?: string;
}
export interface CustomFieldOptions {
  withCustomFields?: boolean;
}
export interface SearchPeopleInput extends ListInput, DateFilters, CustomFieldOptions {
  query?: string;
  email?: string;
  phone?: string;
  cpf?: string;
  organizationId?: number;
}
export interface SearchOrganizationsInput extends ListInput, DateFilters, CustomFieldOptions {
  query?: string;
  cnpj?: string;
  phone?: string;
  email?: string;
  exactName?: string;
}
export interface SearchDealsInput extends ListInput, DateFilters, CustomFieldOptions {
  query?: string;
  organizationId?: number;
  personId?: number;
  ownerId?: number;
  status?: string;
  titleSearch?: string;
  funnelIds?: number[];
  stageId?: number;
  stageSequence?: number;
  startAtGt?: string;
  startAtLt?: string;
  endAtGt?: string;
  endAtLt?: string;
}
export interface ListTasksInput extends ListInput {
  dealId?: number;
  personId?: number;
  organizationId?: number;
  updatedDateGt?: string;
}
export type CatalogEntityType = 'organizations' | 'people' | 'deals' | 'products';
export type ConfigurationInput = ListInput &
  (
    | { section: 'funnels' | 'users' | 'products' | 'origins' | 'categories' | 'sectors' }
    | { section: 'stages'; funnelId: number }
    | { section: 'customFields'; entityType: CatalogEntityType }
    | { section: 'cities'; state: string }
  );
export type CatalogSection = ConfigurationInput['section'];
export interface CatalogCoverage {
  status: 'partial' | 'complete';
  pages: number[];
}
export interface CatalogPage extends PagedResult<Record<string, unknown>> {
  section: CatalogSection;
  entityType?: CatalogEntityType;
  funnelId?: number;
  state?: string;
  fetchedAt: string;
  coverage: CatalogCoverage;
}
export interface CatalogNamedEntry {
  id: number;
  name: string;
  active?: boolean;
}
export interface CatalogStage extends CatalogNamedEntry {
  sequence: number;
  funnelId: number;
}
export interface CatalogCustomField {
  id?: string | number;
  name?: string;
  type?: string;
  options?: unknown[];
  entityType: CatalogEntityType;
  [key: string]: unknown;
}
export interface CatalogSnapshot {
  version: string;
  fetchedAt: string;
  accountId: string;
  funnels: CatalogNamedEntry[];
  stages: CatalogStage[];
  users: CatalogNamedEntry[];
  products: CatalogNamedEntry[];
  customFields: CatalogCustomField[];
  capabilities: { customFields: 'unverified'; collectionWriteSemantics: 'unverified' };
  coverage: Partial<Record<string, CatalogCoverage>>;
}
export interface UpdateResult {
  id: number;
  updatedFields: string[];
}
export type CrmMutationRef = { kind: 'organization' | 'person' | 'deal' | 'task'; id: number };
/** HTTP acknowledgement only. Returned fields are evidence for later read-back,
 * never a checked receipt or permission to dispatch again. */
export type MutationOutcome =
  | { state: 'confirmed'; ref: CrmMutationRef; returnedFields: Record<string, unknown> }
  | { state: 'uncertain'; reason: import('../errors').ErrorCode | 'UPSTREAM_CANCELLED' }
  | {
      state: 'rejected';
      code: import('../errors').ErrorCode | 'COLLECTION_WRITE_UNVERIFIED';
      retryAfterSeconds?: number;
    };
