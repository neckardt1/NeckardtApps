# Private ChatGPT connector

Use the project’s [Supabase discovery document](https://jjgepkhpvslqwzkquqaf.supabase.co/auth/v1/.well-known/openid-configuration) for the OAuth issuer and endpoints. The connection uses a manually registered public client, authorization code with S256 PKCE, and no client secret. The `openid` scope identifies the signed-in user. The first planned app permission is Habit Practice completion summaries.

The template needs the suite MCP server’s verified HTTPS URL and its own Supabase OAuth client ID. For the registration, allow only the exact OAuth redirect URI shown by ChatGPT for this connector. The website’s `/oauth/consent/` is the consent screen. The Recall canary has a different client and resource.

Once those values exist, substitute them in `mcp.json.template`, save the result as `mcp.json`, and package it with `plugin.json` for a private installation. The token hook denies a new registration until it has an explicit authorization policy. Verify the suite audience and permission on both issue and refresh before asking for consent to share real summaries.
