export type {
  PageInfo,
  PagedResult,
  ListInput,
  DateFilters,
  CustomFieldOptions,
  SearchPeopleInput,
  SearchOrganizationsInput,
  SearchDealsInput,
  ListTasksInput,
  CatalogEntityType,
  ConfigurationInput,
  CatalogSection,
  CatalogCoverage,
  CatalogPage,
  CatalogNamedEntry,
  CatalogStage,
  CatalogCustomField,
  CatalogSnapshot,
  UpdateResult,
  CrmMutationRef,
  MutationOutcome,
} from '../../shared/contracts/crm';
import type {
  CatalogPage,
  ConfigurationInput,
  ListTasksInput,
  MutationOutcome,
  PagedResult,
  SearchDealsInput,
  SearchOrganizationsInput,
  SearchPeopleInput,
  CustomFieldOptions,
  UpdateResult,
} from '../../shared/contracts/crm';

export interface CrmMutationClient {
  changeStage(id: number, patch: import('./mutation-schemas').ChangeStage): Promise<MutationOutcome>;
  createOrganization(record: import('./mutation-schemas').CreateOrganization): Promise<MutationOutcome>;
  createPerson(record: import('./mutation-schemas').CreatePerson): Promise<MutationOutcome>;
  createDeal(
    parent: import('./mutation-schemas').CrmEntityRef,
    record: import('./mutation-schemas').CreateDealRecord,
  ): Promise<MutationOutcome>;
  createTask(
    parent: import('./mutation-schemas').CrmTaskParent,
    record: import('./mutation-schemas').CreateTaskRecord,
  ): Promise<MutationOutcome>;
  enrichOrganization(id: number, patch: import('./mutation-schemas').EnrichOrganization): Promise<MutationOutcome>;
  enrichPerson(id: number, patch: import('./mutation-schemas').EnrichPerson): Promise<MutationOutcome>;
  enrichDeal(id: number, patch: import('./mutation-schemas').EnrichDeal): Promise<MutationOutcome>;
  updateTask(id: number, patch: import('./mutation-schemas').UpdateTask): Promise<MutationOutcome>;
}
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
