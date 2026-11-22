# Recall MCP canary

This experiment delivers synthetic events for batch `mcp-canary`. Install the matching migration and
deploy the `recall-events` function, then set the function URL from the target project in the SQL Editor.

```sql
update recall_canary.settings
set deliver_url = 'https://<your-project-ref>.supabase.co/functions/v1/recall-events/deliver'
where singleton;
```

For a ChatGPT web connection, use the [OAuth setup guide](recall-canary-oauth.md).
For a bearer-capable MCP client, connect with its dedicated bearer from project Vault, named `recall_canary_mcp_bearer`.
The delivery key and storage key are internal to Postgres. Restrict access to project Vault.
The public RPC is executable only by `service_role` and the owner.
The subscription stores its callback URL and signing secrets encrypted.

Subscribe from the intended conversation first. Confirm that the subscription is active without
reading callback details:

```sql
select id, expires from recall_canary.subscriptions where active and expires > now();
```

When the conversation is idle and the test window is agreed, insert one synthetic completion.
Choose a new session ID for each new test. Reusing the same ID will not enqueue a duplicate.

```sql
insert into recall_canary.events(session_id) values ('canary-first')
on conflict (session_id) do nothing returning session_id, event_id, saved_at;
```

The insert and recipient snapshot share a transaction. The trigger enqueues a pg_net HTTP request
only for a matching subscription. The worker performs it after commit. Compare the returned event ID
with the message in the original conversation and use the recorded receipt time:

```sql
select e.session_id, e.event_id, e.saved_at, d.state, d.attempts, d.http_status, d.acknowledged_at
from recall_canary.events e left join recall_canary.deliveries d using (event_id)
order by e.saved_at desc limit 10;
```

For this bounded test, retries are operator-initiated. A transient callback failure leaves the delivery
pending until `available_after`. If the worker stops after claiming, wait for its 90-second lease.
After a dispatch transport error, check for a visible reply before retrying. A retry uses the same
event ID and at most three callback attempts. Run this SQL for the original event if needed:

```sql
select recall_canary.dispatch(event_id)
from recall_canary.events where session_id = 'canary-first';
```

Stop the subscription in ChatGPT and confirm it is inactive. Uninstall the canary plugin and remove
the deployed canary Edge Function when the experiment is retired. The following SQL is destructive
and applies only when intentionally retiring this canary and its stored benchmark evidence. Keep
shared database extensions and the rest of the project in place.

```sql
begin;
drop function public.recall_canary_db(text,jsonb);
drop schema recall_canary cascade;
delete from vault.secrets where name in (
  'recall_canary_mcp_bearer', 'recall_canary_delivery_key', 'recall_canary_storage_key'
);
commit;
```
