import type { CustomerContext } from '../types';
export class CustomerContextService {
  constructor(private readonly repository: { refreshCustomerContext(customerId: string, expectedVersion: number): Promise<CustomerContext> }) {}
  refreshCustomerContext(customerId: string, expectedVersion: number) { return this.repository.refreshCustomerContext(customerId, expectedVersion); }
}
