# Hosted OAuth for the Recall canary

The public PKCE client is dedicated to one resource and one synthetic Supabase Auth account. Keep the
client disabled for human connections until the hook and resource server both enforce its binding.
Use manual client registration and the exact callback URI supplied by the client.

## Configure

1. Check **Authentication → Auth Hooks**. An existing Custom Access Token hook must be composed with
   this logic and tested before enabling either change. The project supports one hook of this type.
2. Apply the canary migrations. Each row in `recall_canary.oauth_clients` affects exactly one OAuth
   client. Create the binding using the UUIDs from the **project’s** OAuth Apps and Users pages.
   Use a fresh Auth user that owns no application data. These bindings contain no passwords or tokens.

   ```sql
   insert into recall_canary.oauth_clients (client_id, subject_id, audience)
   values ('<oauth-client-uuid>', '<dedicated-auth-user-uuid>',
           'https://<project-ref>.supabase.co/functions/v1/recall-events/web/mcp');
   ```

3. Under **Authentication → Auth Hooks**, create a Custom Access Token hook targeting the Postgres
   function `public.recall_canary_access_token_hook`. Configure the same client, subject, and resource
   on the Edge Function using `RECALL_OAUTH_CLIENT_ID` and `RECALL_OAUTH_USER_ID`. The function
   derives the resource and issuer from its hosted `SUPABASE_URL`. The project must sign access
   tokens with ES256 or RS256 and publish the verification keys at `/auth/v1/.well-known/jwks.json`.
4. Run a fresh PKCE S256 authorization with this client and subject. Send the exact `resource` at
   authorization and token exchange. Verify the issued JWT signature using the issuer's JWKS and
   assert its issuer, expiry, subject, client ID, exclusive resource audience and role
   `recall_canary_oauth`. Repeat after refreshing. Keep token values out of output and PRs.
5. Send `events/list` to discover the synthetic event, then call `get_canary` with a synthetic
   session ID. A resource-bound token returns a receipt or `found:false`. An ordinary first-party
   session receives an OAuth connection challenge in the MCP tool error. A protected
   `events/subscribe` request with the same first-party token returns HTTP 401. As an independent isolation check,
   request the **schema root** `/rest/v1/` with the project publishable key and the resource token.
   Expect the gateway or PostgREST to reject the audience or database role. A successful schema
   response warrants investigation before connecting Dot. No flashcard rows are needed for this test.

The hook reads the signed-claims input at `event.claims.client_id`, populated by Supabase for OAuth
code exchange and refresh. On the selected client an incorrect user gets a 403. A correct user gets
the MCP URL as the sole audience and a role name that PostgREST cannot assume. Keep that role name
unallocated. Direct sign-ins and other registered clients retain their original claims.

At the upstream revision inspected, Supabase checks request/resource consistency at code exchange,
but sets the access token audience from the user's Auth audience. Its hook does not receive the
requested resource. This client therefore has one fixed resource for every grant, including refresh.
[Supabase Auth source](https://github.com/supabase/auth/blob/10ef10789d1ee4fb422b448047e67e3e264c0482/internal/tokens/service.go#L698-L755)
and [resource binding implementation](https://github.com/supabase/auth/pull/2894).

A GET on `/functions/v1/recall-events/web/mcp` returns a bearer challenge with a link to protected
resource metadata. Public discovery describes the read tool and event. A subscription requires a
separate authenticated request after connecting the client. The original `/mcp` canary bearer
and signed database dispatch to `/deliver` remain separate paths.

Run the Edge tests from `apps/recall/supabase/functions/recall-events` with
`deno test --allow-env oauth.test.ts` and `node --test handler.test.mjs`.

## Suspend and retire

Set `subject_id = null` for the registered client to refuse new authorizations and refreshes. During
incident response, also disable acceptance of that client at the resource server to stop outstanding
access tokens. For permanent removal, revoke the relevant authorization and delete the OAuth client
before deleting its binding or disabling the hook. Removing the binding while a client still exists
would restore default project-wide token issuance for it.

For rollback-only local SQL coverage, run `apps/recall/tests/canary-oauth-hook.sql` on a disposable
Supabase-compatible database after applying the migrations.
