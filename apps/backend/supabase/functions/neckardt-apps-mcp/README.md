# Neckardt Apps MCP

One stateless MCP endpoint serves the suite. The [shared handler](server.ts) owns HTTP routing,
transport and capability registration. [Token verification](auth.ts) is shared across apps.

| App | Tool | Result |
| --- | --- | --- |
| Habit Practice | [`get_habit_practice_link`](apps/habit-practice/tools.ts) | Returns the same review URL for all callers. |
| Habit Practice | [`get_cards`](apps/habit-practice/cards.ts) | Reads the connected owner's cards by ID or by UUID cursor, including exact wording, pairing, active status and due date. |
| Habit Practice | [`create_cards`](apps/habit-practice/cards.ts) | Atomically saves an approved batch of facts and paired habits and reads back the saved rows. |
| Tasks | [`list_tasks`](apps/tasks/tools.ts) | Returns active tasks, visible lists, and the connected owner's Focus choices and Pacific day. |
| Tasks | [`create_task`, `update_task`, `complete_task`](apps/tasks/tools.ts) | Creates with a stable request ID, or edits/completes at the supplied version. Household writes affect its members. |
| Tasks | [`set_task_focus`](apps/tasks/tools.ts) | Promotes or deprioritizes a visible task for the connected owner. |

Before invoking `create_cards`, show the exact full batch privately and get approval of the current wording.
A client passes `approved_exact_wording: true` to attest to that conversation. The server validates the
batch and verifies the owner and saved content in the transaction. Preserve the same IDs on retry.

Data access on an existing OAuth registration is scoped to the account and the apps approved in
Manage connections. The Edge function relays the verified client, subject, session and signed approval
receipts to a service-only RPC. Each app enforces its own enrollment and visibility. See the
[consent and registration guide](../../../../web/src/oauth/README.md).

The [Habit Practice completion event](apps/habit-practice/events.ts), `habit.practice.round.completed`,
accepts `{"automatic":true}` to send counts when a new round completes. Also setting `share_items: true` includes card-level results for that destination until unsubscribe. Empty arguments retain the original one-round scope.

## Adding a feature

For Habit Practice, put UI changes in the [frontend](../../../../web/src/apps/habit-practice/),
review operations in the [grading function](../recall-grade/), and database changes in
[Supabase migrations](../../migrations/). Define MCP tools in the app’s [tool module](apps/habit-practice/tools.ts).
When an app gains its first subscription, put its event definitions and handlers beside its tools
and register the capability in the shared server. Add the public name and definition link here.
