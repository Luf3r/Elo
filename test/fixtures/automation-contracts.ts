/** Synthetic only. These values are canaries, never real customer records. */
export type CapabilityStatus = 'verified' | 'unverified' | 'unsupported';
export interface ContractCapability {
  status: CapabilityStatus;
  references: string[];
  evidence: string[];
}
export interface ContractCapabilities {
  chatMessageAfter: ContractCapability;
  chatHistory: ContractCapability;
  conversationDiscovery: ContractCapability;
  contacts: ContractCapability;
  attachments: ContractCapability;
  customFields: ContractCapability;
  collectionWriteSemantics: ContractCapability;
}
export const syntheticContracts = {
  profile: { account_id: 812345, name: 'SYNTHETIC customer name' },
  conversations: { data: { payload: [{ id: 823456 }], meta: { all_count: 1 } } },
  messages: { payload: [{ id: 834567, content: 'SYNTHETIC message', attachments: [] }] },
  contacts: { payload: [{ id: 845678, name: 'SYNTHETIC contact', email: 'synthetic@example.invalid' }] },
  attachments: { payload: [{ id: 856789, file_type: 'image', data_url: 'https://example.invalid/private' }] },
  catalog: { data: [{ id: 867890, name: 'SYNTHETIC catalog' }] },
};
