# Recurring tasks (planned)

A swipe punt must move the current unfinished occurrence to tomorrow in `America/Los_Angeles`.
Only the planned date changes. The occurrence keeps its deadline and the series keeps its original schedule.
The occurrence stays open through repeated punts. Only completing it advances the series to the next cycle.

## Acceptance example for monthly rent

“Pay rent” is planned for the 25th of each month and due on the 30th. Follow these steps in order.

| Action | Open occurrence | Planned | Deadline |
| --- | --- | --- | --- |
| Start on April 25 | April rent | April 25 | April 30 |
| Swipe to punt on April 25 | April rent | April 26 | April 30 |
| Swipe to punt again on April 26 | April rent | April 27 | April 30 |
| Undo the April 26 punt | April rent | April 26 | April 30 |
| Complete April rent on April 26 | May rent | May 25 | May 30 |

If April rent is still open on April 30, punting it that day moves the plan to May 1.
On May 1, April rent is still outstanding against its April 30 deadline.

Record each punt as a `rescheduled` entry on the April occurrence. Undo links back to that specific
entry on the same occurrence and restores its previous planned date. Checking off April rent records
the `completed` entry. [Task history and undo](https://github.com/neckardt1/NeckardtApps/pull/72)
