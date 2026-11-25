# Private ChatGPT connector

Use the project’s [Supabase discovery document](https://jjgepkhpvslqwzkquqaf.supabase.co/auth/v1/.well-known/openid-configuration) for the OAuth issuer and endpoints. The connection uses a manually registered public client, authorization code with S256 PKCE, and no client secret. The `openid` scope identifies the signed-in user. Habit Practice asks separately before sharing a finished round.

The template needs the suite MCP server’s verified HTTPS URL and its own Supabase OAuth client ID. For the registration, allow only the exact OAuth redirect URI shown by ChatGPT for this connector. The website’s `/oauth/consent/` is the consent screen. The Recall canary has a different client and resource.

Once those values exist, substitute them in `mcp.json.template`, save the result as `mcp.json`, and package it with `plugin.json` for a private installation. The token hook denies a new registration until it has an explicit authorization policy. Verify the suite audience and permission on both issue and refresh before asking for consent to share real summaries.

## Test one Habit Practice debrief

For detailed events, apply the reviewed `round_debrief_items` migration and deploy
`neckardt-apps-mcp` before testing the updated web client.
The database uses pg_net and Vault. Set `habit_notify_dispatch_url` in Vault to the suite
function's HTTPS `/deliver` route. Generate a random dispatch secret of at least 32 bytes.
Store it as `habit_notify_dispatch_secret` in Vault and `HABIT_NOTIFY_DISPATCH_SECRET` in
the Edge Function environment. Keep it out of command history and logs.

1. In the destination Dot chat, subscribe to `habit.practice.round.completed` with empty
   arguments and delivery in the current thread. Instruct Dot to send one brief debrief for
   each completion using the supplied review results. Confirm the watch is active.
2. From that chat call `get_habit_practice_link` with `debrief: true`. Open the link, sign in
   as the same user, select **Request Dot debrief**, and finish the round. Opening the link
   alone leaves sharing off.
3. Verify one saved completion, one accepted delivery, and one visible reply in the original
   chat. Record the finish and reply times. Disable the pilot watch afterward. An HTTP
   acknowledgment alone does not establish that the debrief appeared.

Each opt-in covers one round. Every callback includes the finish time, counts, and outcome totals.
A round armed with `habit_notify_arm(round_id, share_items: true)` also includes `round_id` and
`items` in presentation order. Existing arms and clients that omit `share_items` receive counts only.

Each item includes a card ID, `card_name`, position, and kind. The card’s front is its display name.
Action items opened before this migration use their saved question as the name. For recall, `front` and `back` are the displayed
card name/prompt and expected answer. For a habit check they are the question and optional cue.
`answer` is the saved selection or `superseded`. `answered_at` is the response time, and `due_at`
is the due date captured when the round opened, when available. `grade` and `next_due_at` come from
the matching scheduling receipt. For example, a paired Yes is graded `medium`. A skip has no
grade or newly scheduled date. The app records self-ratings and check-ins. The recall buttons Again and Good correspond to
`miss` and `medium` in the event.

The suite token grants access to the review link. Card details are delivered through the callback for the authorized round. A duplicate delivery request
cannot claim the same result twice. A lost response can therefore leave a saved round without
a debrief. Check the delivery state before considering recovery.
