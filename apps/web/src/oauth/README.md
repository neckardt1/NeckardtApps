# OAuth consent

The page at `/oauth/consent/` asks Supabase for the request details after sign-in. It matches the
registered client ID, exact callback, signed-in account and permitted scopes before showing Allow
and Deny. Its session is held in memory, separate from the site's Account session.

## Neckardt Apps MCP

Supabase issues and refreshes public PKCE grants for the shared MCP resource. The consent page
and token hook read the same client registration policy. The hook signs the MCP audience, client
identity and subscription permission into each access token. The MCP verifies those claims for
each request. Its restricted token role has no Data API privileges. Supabase Auth can still return
the account profile, including email, to the OAuth client, even for `openid` alone.

### Register an integration

1. In Supabase **Authentication → OAuth Apps**, manually create a public client with token
   endpoint authentication `none` and the integration's single exact HTTPS callback.
2. Add one row in `neckardt_mcp.clients` using the public client ID, display name and identical
   callback. For an owner-only pilot, use an inner join on the intended verified Auth user so that
   an unresolved owner produces zero rows. Verify exactly one inserted row. This parameterized
   statement shows the four operator inputs in order.

   ```sql
   insert into neckardt_mcp.clients (client_id, display_name, callback_url, owner_id)
   select c.id, $2, c.redirect_uris, u.id
   from auth.oauth_clients c
   join auth.users u on u.id = $4 and u.email_confirmed_at is not null and not u.is_anonymous
   where c.id = $1 and c.redirect_uris = $3 and c.deleted_at is null
     and c.registration_type = 'manual' and c.client_type = 'public' and c.token_endpoint_auth_method = 'none'
   returning client_id, display_name;
   ```

   Defaults allow `openid` and the Habit Practice link. A null `owner_id` explicitly enables all
   signed-in, non-anonymous users. `scopes` sets the exact expanded bundle a client may request in
   addition to plain `openid`. The ChatGPT row allows `openid email offline_access` and enables
   `subscriptions` for the existing Dot completion events. The event transport accepts its existing
   verified delivery destination. Permission changes affect subsequent token issues and refreshes.
   Use a fresh registration and consent when expanding the access a user previously approved.
3. Give the integration its public ID and the suite resource URL. Start **Connect** in the
   integration so it creates the PKCE verifier and state. New clients using existing capabilities
   need no Pages rebuild, Edge deployment or client-specific environment variables.

Users can disconnect a grant under **Account → Manage connections**. Supabase revokes the user's
sessions for that client. Its refresh tokens stop working, while the MCP accepts an already-issued
access token until expiry. Existing Dot webhook subscriptions have their own unsubscribe and expiry.
If Supabase returns only a redirect for a previous grant, disconnect that app and start Connect
again to review the registered client and callback. The sign-in for consent and grant management
uses a separate in-memory session.

Deploy the registry migration and the shared MCP function for this release. The verifier requires
the signed permission claim, so previously issued ChatGPT tokens need their normal refresh or a
reconnect. The existing public ChatGPT ID and grant remain usable.

## Recall canary

The canary additionally checks the bound account on the consent page and in the token hook.

Before binding an account that owns application data, deploy the reviewed `recall-grade` function
with the project's existing gateway JWT setting. Verify first-party grading authorization and
delegated-token rejection before any grading RPC using synthetic requests. Pages deploys independently.
Keep the token hook enabled and the OAuth client bound throughout cutover. Switch the Edge verifier's
expected subject before updating the existing hook binding in place. Check the token and its refresh
for the exact audience and restricted role, and verify that the Data API denies access using its
schema root. Supabase Auth can still return the signed-in user's Auth profile to the OAuth client.

1. Register the OAuth client manually in Supabase with its exact callback. For a local PKCE pilot,
   use a `http://127.0.0.1:<port>/<path>` callback. For ChatGPT, copy its HTTPS callback from the
   connection setup and update both the client registration and the build variable. Configure the
   authorized account in the private token hook and resource server. The resource must independently
   verify the token issuer, audience, client ID and subject.
2. Set the GitHub Actions repository variables `RECALL_CANARY_CLIENT_ID`,
   `RECALL_CANARY_USER_DIGEST` and `RECALL_CANARY_CALLBACK_URL`. All three are public build inputs.
   To generate the digest privately, run the following command from the repository root with a
   private file containing the Auth UUID on standard input. It prints only the digest.

   ```sh
   node --input-type=module -e 'import {readFileSync} from "node:fs"; import {ownerDigest} from "./apps/web/src/oauth/flow.ts"; console.log(await ownerDigest(readFileSync(0, "utf8").trim()))' < /path/to/private-subject-file
   ```

   Keep the raw owner UUID out of GitHub variables and source. Until the digest is set, an existing
   installation can reuse its old `RECALL_CANARY_USER_ID` variable for the already-public synthetic
   pilot account. The build hashes that value before invoking Vite. Remove the legacy variable
   after cutover.
3. Build and deploy Pages. Open `https://apps.neckardt.com/oauth/consent/` to check the route.
   Set Supabase Auth Site URL to `https://apps.neckardt.com` and its OAuth Authorization Path to
   `/oauth/consent/`. Changing Site URL also changes defaults for other Auth redirects.
4. Start a fresh connection in ChatGPT. If Supabase reports previous consent, revoke the canary
   account's existing grant and reconnect. A previous grant response omits the client ID needed to
   verify the request. The form requires a valid account digest, client ID and callback.

For a pre-merge test on the browser's own computer, build with `VITE_CANARY_CLIENT_ID`,
`VITE_CANARY_USER_DIGEST` and `VITE_CANARY_CALLBACK_URL` in the local environment, then serve
`_site/` on `localhost:3000` and use that origin as the Supabase Site URL. Only use this method
when the intended browser can reach this loopback address.
