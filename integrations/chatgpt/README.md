# Private ChatGPT connector

Use the project’s [Supabase discovery document](https://jjgepkhpvslqwzkquqaf.supabase.co/auth/v1/.well-known/openid-configuration) for the OAuth issuer and endpoints. The connection uses a manually registered public client, authorization code with S256 PKCE, and no client secret. The `openid` scope identifies the signed-in user. An automatic completion subscription is a separate choice made in the destination chat.

The template needs the suite MCP server’s verified HTTPS URL and its own Supabase OAuth client ID. For the registration, allow only the exact OAuth redirect URI shown by ChatGPT for this connector. The website’s `/oauth/consent/` is the consent screen. The Recall canary has a different client and resource.

Once those values exist, substitute them in `mcp.json.template`, save the result as `mcp.json`, and package it with `plugin.json` for a private installation. The token hook denies a new registration until it has an explicit authorization policy. Verify the suite audience and permission on both issue and refresh before asking for consent to share real summaries.

## Test one Habit Practice debrief

Apply the reviewed notification migrations and deploy the matching suite Edge Function before starting the pilot.
The database uses pg_net and Vault. Set `habit_notify_dispatch_url` in Vault to the suite
function's HTTPS `/deliver` route. Generate a random dispatch secret of at least 32 bytes.
Store it as `habit_notify_dispatch_secret` in Vault and `HABIT_NOTIFY_DISPATCH_SECRET` in
the Edge Function environment. Keep it out of command history and logs.

1. In the destination Dot chat, request a subscription to `habit.practice.round.completed`
   with `{"automatic":true}` to receive counts from new rounds. A counts-only pilot created
   with empty arguments keeps its original per-round scope on renewal. To switch modes,
   unsubscribe the old registration before creating the automatic one.
   To include card names, prompts, answers, grades and due dates in this private chat, explicitly
   select `{"automatic":true,"share_items":true}`. This choice applies to subsequent rounds.
   Unsubscribing revokes the registration and any queued, unclaimed deliveries. A new destination
   needs its own verified registration and choice of scope.
2. Open Habit Practice from the launcher, a bookmark, or `get_habit_practice_link`. Sign
   in as the subscribed user and answer the due items. Saving the last response completes
   the round. Its destination was bound when the round opened, so enabling a subscription
   mid-round takes effect with the next new round.
3. Verify one saved completion, one accepted delivery, and one visible reply in the original
   chat. Record the completion and reply times. Disable the pilot watch afterward.

Every callback carries a completion time and aggregate counts. A detailed registration also
receives the ordered items and their saved grading receipts. The connector provides no deck
or review-history query. A delivery can be claimed once, so check its state before attempting
recovery after a lost response.
