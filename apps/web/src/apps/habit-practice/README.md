# Habit Practice

The app lives at `/recall/`. Postgres stores review rounds and responses.
The [shared shell](../../shell/) owns navigation and sign-in.

## Deck enrollment

A database administrator enrolls an existing Supabase Auth user by inserting
their UUID into `flashcards_private.app_owner(owner_id)`. Each enrolled user
gets one private deck. Set `cards.owner_id` to that user's UUID and let
`cards.id` generate a new UUID for each card.

## Paired habits

A cue card (`habit-recall`) and its action card (`habit-action`) have independent FSRS schedules.
Grade recall normally. Answer Yes or No about one specific occasion to grade the action card Good
or Again. No opportunity closes that occasion. Skip defers it until the next Seattle calendar day.
Neither changes the action card's schedule.

The deck administrator links the action's `cue_card_id` to its owner's cue card. The migration
copies known card kinds from the optional import archive. Confirm the pair before linking imported
cards. Card text alone does not identify which two cards belong together.

The deck administrator supplies one UUID per real occurrence. Reuse that ID on retry.
To enter a check-in, bind the following SQL parameters.
`$1` is the occasion UUID, `$2` the enrolled owner, `$3` the action card and `$4` the time of
the occasion. Set `$5` to the last time an answer would still describe that occasion.

```sql
insert into flashcards_private.action_opportunities
  (opportunity_id, owner_id, card_id, available_at, expires_at, prompt, cue)
select $1, action.owner_id, action.id, $4, $5, action.front, cue.front
from flashcards_private.cards action
join flashcards_private.cards cue
  on cue.owner_id = action.owner_id and cue.id = action.cue_card_id
where action.owner_id = $2 and action.id = $3
  and action.kind = 'habit-action' and action.active and cue.active
on conflict (opportunity_id) do nothing;
```

## Saved rounds and recovery

The practice home offers Start round or Continue round. Browse all cards searches the owner’s entire deck, including inactive cards and actions without an available check-in. After the final
response is acknowledged, the browser records the round’s completion and shows its summary.
If the tab closes during a save, Continue round restores the outstanding work. Starting a new round checks for newly due cards. An active automatic Dot subscription receives new completed rounds
through the existing notification service.

The browser holds queued responses until the server acknowledges them. Reopen the original
browser after going offline so it can send its outstanding answers. Before a rollout, finish or
reconcile old pending rounds on the devices that created them. If an old round reports a
permanent conflict, preserve its owner-scoped `recall.round.v2` browser record privately and
match the original event ID with its database receipt before deciding how to resolve that answer.

## Backend changes

GitHub Pages deploys the web app. Until the round RPCs are installed, a new browser continues
to use the existing review flow. In the [backend workspace](../../../../backend/supabase/),
apply the paired-habit and round migrations in order, generate database types, and deploy
`recall-grade`. Verify a synthetic paired check-in and round before linking real cards.
Check the live migration ledger before applying a migration with an older equivalent.

A frontend rollback does not roll back the database or revoke already-open
tabs. Preserve additive schema changes and browser data; check compatibility
before resuming reviews. Never commit live cards, review history, or credentials.

The canary consent page has its own [OAuth setup](../../oauth/README.md).
