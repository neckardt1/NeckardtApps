# Private ChatGPT connector

[Neckardt Apps MCP](https://jjgepkhpvslqwzkquqaf.supabase.co/functions/v1/neckardt-apps-mcp) uses Streamable HTTP. ChatGPT can discover the server and its tools before sign-in. The first tool, `get_habit_practice_link`, returns the website's existing review link. The function has no database calls. Sharing completion summaries will require a separate grant and fresh consent.

Use the project's [Supabase issuer](https://jjgepkhpvslqwzkquqaf.supabase.co/auth/v1/.well-known/openid-configuration), a public OAuth client, S256 PKCE and the `openid` scope. Register only the exact ChatGPT redirect URI shown for this connection. The site's `/oauth/consent/` is the authorization screen.

Set `NECKARDT_APPS_OAUTH_CLIENT_ID` to the registered client ID and use the same ID in `mcp.json.template`. The verifier expects a signed project token with that client ID, the exact MCP endpoint as its audience and the `neckardt_apps_oauth` role. The shared token hook denies the new client until an explicit policy issues that grant. Package the rendered `mcp.json` alongside `plugin.json` for private installation.
