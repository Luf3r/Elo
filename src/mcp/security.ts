export function oauthToolSecurity(...scopes: string[]) {
  return { securitySchemes: [{ type: 'oauth2', scopes }] };
}
export const crmReadSecurity = oauthToolSecurity('crm:read');
export const chatReadSecurity = oauthToolSecurity('chat:read');
export const crmWriteSecurity = oauthToolSecurity('crm:write');
export const publicToolSecurity = oauthToolSecurity();
export const crmCreateSecurity = oauthToolSecurity('crm:create');
export const crmEnrichSecurity = oauthToolSecurity('crm:enrich');
export const automationReadSecurity = oauthToolSecurity('automation:read');
export const automationProcessSecurity = oauthToolSecurity('automation:process', 'chat:read', 'crm:read');
export const automationContextSecurity = oauthToolSecurity('automation:read', 'chat:read', 'crm:read');
export const automationReviewSecurity = oauthToolSecurity('automation:manage', 'chat:read', 'crm:read');
