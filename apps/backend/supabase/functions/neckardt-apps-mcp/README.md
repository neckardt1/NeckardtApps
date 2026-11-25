# Neckardt Apps MCP

One stateless MCP endpoint serves the suite. The [shared handler](server.ts) owns HTTP routing,
transport and capability registration. [Token verification](auth.ts) is shared across apps.

| App | Tool | Result |
| --- | --- | --- |
| Habit Practice | [`get_habit_practice_link`](apps/habit-practice/tools.ts) | Returns the same review URL for all callers. |

The [Habit Practice completion event](apps/habit-practice/events.ts), `habit.practice.round.completed`,
accepts `{"automatic":true}` to send counts when a new round completes. Also setting `share_items: true` includes card-level results for that destination until unsubscribe. Empty arguments retain the original one-round scope.

## Adding a feature

For Habit Practice, put UI changes in the [frontend](../../../../web/src/apps/habit-practice/),
review operations in the [grading function](../recall-grade/), and database changes in
[Supabase migrations](../../migrations/). Define MCP tools in the app’s [tool module](apps/habit-practice/tools.ts).
When an app gains its first subscription, put its event definitions and handlers beside its tools
and register the capability in the shared server. Add the public name and definition link here.
