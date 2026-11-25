# Private ChatGPT connector

Use the project’s [Supabase discovery document](https://jjgepkhpvslqwzkquqaf.supabase.co/auth/v1/.well-known/openid-configuration) for the OAuth issuer and endpoints. The connection uses a manually registered public client, authorization code with S256 PKCE, and no client secret. The `openid` scope identifies the signed-in user. Habit Practice asks separately before sharing a finished round.

The template needs the suite MCP server’s verified HTTPS URL and its own Supabase OAuth client ID. For the registration, allow only the exact OAuth redirect URI shown by ChatGPT for this connector. The website’s `/oauth/consent/` is the consent screen. The Recall canary has a different client and resource.

Once those values exist, substitute them in `mcp.json.template`, save the result as `mcp.json`, and package it with `plugin.json` for a private installation. The token hook denies a new registration until it has an explicit authorization policy. Verify the suite audience and permission on both issue and refresh before asking for consent to share real summaries.

## Test one Habit Practice debrief

Deploy the reviewed notification migration and suite Edge Function before starting the pilot.
The database uses pg_net and Vault. Set `habit_notify_dispatch_url` in Vault to the suite
function's HTTPS `/deliver` route. Generate a random dispatch secret of at least 32 bytes.
Store it as `habit_notify_dispatch_secret` in Vault and `HABIT_NOTIFY_DISPATCH_SECRET` in
the Edge Function environment. Keep it out of command history and logs.

1. In the destination Dot chat, subscribe to `habit.practice.round.completed` with empty
   arguments and delivery in the current thread. Instruct Dot to send one brief debrief for
   each completion using only the counts in the event. Confirm the watch is active.
2. From that chat call `get_habit_practice_link` with `debrief: true`. Open the link, sign in
   as the same user, select **Request Dot debrief**, and finish the round. Opening the link
   alone leaves sharing off.
3. Verify one saved completion, one accepted delivery, and one visible reply in the original
   chat. Record the finish and reply times. Disable the pilot watch afterward. An HTTP
   acknowledgment alone does not establish that the debrief appeared.

Each opt-in covers one round. The callback carries a finish time and aggregate counts. The
suite token cannot read the deck, card text, or prior rounds. A duplicate delivery request
cannot claim the same result twice. A lost response can therefore leave a saved round without
a debrief. Check the delivery state before considering recovery.
