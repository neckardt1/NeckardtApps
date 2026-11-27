---
name: add-cards
description: Preview and add approved facts and paired habits to Nick’s Habit Practice deck in NeckardtApps.
---

## Preview in private Dot chat

Draft facts as one question with one short, checkable answer. For a habit, agree on one observable cue and one tiny action. Draft a recall card asking what to do at the cue, then an action card asking what actually happened on a real occasion. Its back defines what counts as doing it.

Show the entire batch as one Markdown ordered list. Each item's bold question goes directly above its indented blockquoted answer. Indent every quote line to the start of the item's text (three spaces for 1–9, four for 10–99). Preserve Markdown and links, including quoted blank lines between answer paragraphs. Leave an unquoted blank line between cards. Omit titles and Front/Back labels.

1. **When I close my laptop for the evening, what do I do?**
   > Put tomorrow's notebook on the desk.

2. **After I closed my laptop, did I put tomorrow's notebook on the desk?**
   > Yes if the notebook was on the desk before I walked away.

Wait for Nick's approval of the exact current wording. After any wording change show the full revised batch and wait again. Clarify an ambiguous approval. Save only the explicitly approved items when he selects a subset. Both cards of a habit pair must be approved together.

## Save to Habit Practice

Confirm the target project against the repo's public config and resolve the intended user's enrolled owner UUID from a verified account mapping. A fixture or the first enrolled user is not evidence of deck identity. Keep real batches and generated SQL private and outside Git.

Build one JSON file in a private temporary directory. Generate one UUID per card once and retain the file through verification, including on retry. Copy the approved Markdown exactly. Use this shape (replace placeholders with UUIDs and approved wording):

```json
{"owner_id":"OWNER_UUID","items":[
  {"kind":"fact","card":{"id":"FACT_UUID","front":"…","back":"…"}},
  {"kind":"habit","cue":{"id":"CUE_UUID","front":"…","back":"…"},
   "action":{"id":"ACTION_UUID","front":"…","back":"…"}}
]}
```

From the repo root run `node .agents/skills/add-cards/add-cards.mjs insert < batch.json` with output redirected to a private SQL file. Submit that one statement unchanged through the connected Supabase SQL tool. New cards inherit the database's due and scheduling defaults. Repeat the same command with `verify` in place of `insert` and execute the emitted read-only query. Compare every returned ID, owner, kind, exact front/back and cue link against the approved batch. For a new insert also check active and due. Report the number saved after readback.

If the write outcome is uncertain, verify first. Retry only with the same IDs and approved batch. Stop on conflicting content or owner; a retry preserves existing review schedules. Remove temporary files after verification.
