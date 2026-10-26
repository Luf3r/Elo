export interface PageInfo { page: number; perPage: number; hasNext: boolean; nextPage: number | null }
export interface PagedResult<T> { items: T[]; pageInfo: PageInfo }
export interface ListInput { page?: number; perPage?: number }
export interface DateFilters { createdAtGt?: string; createdAtLt?: string; updatedAtGt?: string; updatedAtLt?: string }
export interface CustomFieldOptions { withCustomFields?: boolean }
export interface SearchPeopleInput extends ListInput, DateFilters, CustomFieldOptions { query?: string; email?: string; phone?: string; cpf?: string; organizationId?: number }
export interface SearchOrganizationsInput extends ListInput, DateFilters, CustomFieldOptions { query?: string; cnpj?: string; phone?: string; email?: string; exactName?: string }
export interface SearchDealsInput extends ListInput, DateFilters, CustomFieldOptions { query?: string; organizationId?: number; personId?: number; ownerId?: number; status?: string; titleSearch?: string; funnelIds?: number[]; stageId?: number; stageSequence?: number; startAtGt?: string; startAtLt?: string; endAtGt?: string; endAtLt?: string }
export interface ListTasksInput extends ListInput { dealId?: number; personId?: number; organizationId?: number; updatedDateGt?: string }
export type CatalogEntityType = 'organizations' | 'people' | 'deals' | 'products';
export type ConfigurationInput = ListInput & (
  | { section: 'funnels' | 'users' | 'products' | 'origins' | 'categories' | 'sectors' }
  | { section: 'stages'; funnelId: number }
  | { section: 'customFields'; entityType: CatalogEntityType }
  | { section: 'cities'; state: string }
);
export type CatalogSection = ConfigurationInput['section'];
export interface CatalogCoverage { status: 'partial' | 'complete'; pages: number[] }
export interface CatalogPage extends PagedResult<Record<string, unknown>> {
  section: CatalogSection; entityType?: CatalogEntityType; funnelId?: number; state?: string;
  fetchedAt: string; coverage: CatalogCoverage;
}
export interface CatalogNamedEntry { id: number; name: string }
export interface CatalogStage extends CatalogNamedEntry { sequence: number; funnelId: number }
export interface CatalogCustomField { id?: string | number; name?: string; type?: string; options?: unknown[]; entityType: CatalogEntityType; [key: string]: unknown }
export interface CatalogSnapshot {
  version: string; fetchedAt: string; accountId: string;
  funnels: CatalogNamedEntry[]; stages: CatalogStage[]; users: CatalogNamedEntry[]; products: CatalogNamedEntry[]; customFields: CatalogCustomField[];
  capabilities: { customFields: 'unverified'; collectionWriteSemantics: 'unverified' };
  coverage: Partial<Record<string, CatalogCoverage>>;
}
export interface UpdateResult { id: number; updatedFields: string[] }
export interface AgendorCrmClient {
  searchPeople(input: SearchPeopleInput): Promise<PagedResult<unknown>>;
  getPerson(id: number, options?: CustomFieldOptions): Promise<unknown>;
  searchOrganizations(input: SearchOrganizationsInput): Promise<PagedResult<unknown>>;
  getOrganization(id: number): Promise<unknown>;
  searchDeals(input: SearchDealsInput): Promise<PagedResult<unknown>>;
  getDeal(id: number): Promise<unknown>;
  listTasks(input: ListTasksInput): Promise<PagedResult<unknown>>;
  getTask(id: number): Promise<unknown>;
  getConfiguration(input: ConfigurationInput): Promise<CatalogPage>;
  updateDeal(id: number, fields: unknown): Promise<UpdateResult>;
  updateDealStage(id: number, fields: unknown): Promise<UpdateResult>;
  updatePerson(id: number, fields: unknown): Promise<UpdateResult>;
  updateOrganization(id: number, fields: unknown): Promise<UpdateResult>;
}
