export const consentOrigin = 'https://apps.neckardt.com';
export const mcpIssuer = consentOrigin + '/mcp.json';
export const linkScope = 'habit:link';
export const eventScope = 'habit:events';
export const offlineScope = 'offline_access';

export function issuerMetadata(resource: string) {
  return { issuer:mcpIssuer, authorization_endpoint:consentOrigin + '/oauth/consent/',
    token_endpoint:resource + '/oauth/token', revocation_endpoint:resource + '/oauth/revoke',
    response_types_supported:['code'], grant_types_supported:['authorization_code','refresh_token'],
    token_endpoint_auth_methods_supported:['none'], revocation_endpoint_auth_methods_supported:['none'],
    scopes_supported:[linkScope, eventScope, offlineScope], code_challenge_methods_supported:['S256'],
    authorization_response_iss_parameter_supported:true };
}
