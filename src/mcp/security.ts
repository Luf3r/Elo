export function oauthToolSecurity(...scopes: string[]) {
  return { securitySchemes: [{ type: 'oauth2', scopes }] };
}
export const crmReadSecurity = oauthToolSecurity('crm:read');
export const chatReadSecurity = oauthToolSecurity('chat:read');
export const crmWriteSecurity = oauthToolSecurity('crm:write');
export const publicToolSecurity = oauthToolSecurity();
