export interface PageInfo { page: number; perPage: number; hasNext: boolean; nextPage: number | null }
export interface PagedResult<T> { items: T[]; pageInfo: PageInfo }
export interface ListInput { page?: number; perPage?: number }
export interface SearchPeopleInput extends ListInput { query?: string; email?: string }
export interface SearchOrganizationsInput extends ListInput { query?: string }
export interface SearchDealsInput extends ListInput { query?: string; organizationId?: number; personId?: number; ownerId?: number; status?: string }
export interface ListTasksInput extends ListInput { dealId?: number; personId?: number; organizationId?: number }
export interface AgendorCrmClient {
  searchPeople(input: SearchPeopleInput): Promise<PagedResult<unknown>>;
  searchOrganizations(input: SearchOrganizationsInput): Promise<PagedResult<unknown>>;
  getOrganization(id: number): Promise<unknown>;
  searchDeals(input: SearchDealsInput): Promise<PagedResult<unknown>>;
  getDeal(id: number): Promise<unknown>;
  listTasks(input: ListTasksInput): Promise<PagedResult<unknown>>;
}
