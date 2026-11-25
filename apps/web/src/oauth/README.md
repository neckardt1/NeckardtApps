# OAuth consent

The page at `/oauth/consent/` asks Supabase for the request details after sign-in. It matches the
registered client ID, exact callback, signed-in account and permitted scopes before showing Allow
and Deny. Its session is held in memory, separate from the site's Account session.

## Neckardt Apps MCP

Any signed-in, non-anonymous project user can authorize the Habit Practice link tool. The token
hook keeps that user's subject on issue and refresh and binds the token to the suite MCP endpoint.
The connector can return the link regardless of the user's separate Habit Practice enrollment.
A user can separately request an automatic completion subscription in Dot. It receives aggregate
counts from rounds opened by that owner’s first-party session while the subscription is active.
A separate detailed subscription includes card names, prompts, answers, grades and due dates for that destination. Unsubscribing revokes it. Existing registrations keep their original one-round sharing scope.

The suite accepts `openid` alone or the exact set `openid email offline_access` that ChatGPT
requests. For the latter, consent covers access to email and verification status through Supabase
OIDC and permission to refresh the connection. The MCP access token retains its link-only role and
audience. The canary consent page accepts only `openid`.

For rollout, apply the reviewed `authorize_neckardt_apps_mcp` and
`allow_suite_chatgpt_identity_scopes` migrations. Set the public
`NECKARDT_APPS_OAUTH_CLIENT_ID` to the registered suite client ID in the MCP function's environment
and in GitHub Actions repository variables. Set the Actions variable `NECKARDT_APPS_OAUTH_CALLBACK_URL`
to the exact redirect shown on the ChatGPT suite connection and registered in Supabase. Deploy Pages,
then start a fresh connection from ChatGPT and call `get_habit_practice_link`. The migration pins the
production issuer and public client ID. Registering a replacement requires updating that policy.

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
