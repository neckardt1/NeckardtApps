---
name: backup
description: Save and verify a commit-labelled Habit Practice row snapshot in private Google Drive.
---

Use the last successful production Pages deployment's full SHA. This identifies the web release at capture time. Backend deployments have their own history. Scope covers every row of the nine flashcards_private tables, including the import archive. Auth, subscriptions, database definitions and sequence state are outside this snapshot.

1. Verify the hosted project against the repo's public config. Run `node .agents/skills/backup/snapshot.mjs sql <deployed-sha>`. Execute the resulting single read-only statement through the connected Supabase SQL tool as a role with full row visibility. Capture the one result row programmatically. Treat its contents as private data and keep them out of chat, logs and Git.
2. Pass the row object as JSON on stdin to `node .agents/skills/backup/snapshot.mjs save <private-temp-directory>`. Preserve the payload string verbatim when unwrapping the tool response. A missing table, truncated result or inventory mismatch fails the run. Record the returned filename and SHA-256.
3. Upload the file unchanged to the owner's private My Drive via the connected Drive upload action. On retry, reuse an existing private file with that exact name and matching checksum. Check the returned ID, owner and permissions, download via the authenticated connector and compare SHA-256 to the saved value. Clean the private temporary files after verification. Report only the link, scope, commit and verification status.
4. To rehearse a recovery, use a disposable database with matching table definitions and owner identities. Read the verified JSON as text in PostgreSQL and select a table's rows with `jsonb_populate_recordset(null::flashcards_private.cards, $1::jsonb->'tables'->'cards')`. Insert explicit writable columns into empty scratch tables in foreign-key order. Preserve IDs and review trigger effects and generated columns. Compare restored rows in both directions using EXCEPT ALL. Production recovery is a separate operation.

The backend snapshot test exercises capture, checksum validation and typed recovery with synthetic rows. A successful upload alone establishes file integrity.

## Retention after a verified upload

Use a dedicated private My Drive folder for scheduled snapshots. Record its ID in the schedule, supply it to upload, and verify its ownership and permissions each run. Leave older exports outside that folder alone.

After download verification, list every page of non-trashed files directly in that folder. Pass their `[{id,name}]` metadata on stdin to `node .agents/skills/backup/retention.mjs <freshly-verified-file-id>`. It prints a dry-run plan. Keep the current copy and progressively coarser weekly, fortnightly, monthly, quarterly, half-year and year-scale checkpoints. Exact ages vary with the capture dates.

Apply the plan only after a successful recovery rehearsal and while this is the sole backup run for the folder. For each proposed removal, recheck its ID, current parent, private ownership and matching filename, download it and verify that its payload format, header and checksum match the backup and Drive metadata. Use Drive Trash. If inventory, identity or verification is uncertain, preserve the file. A failed upload or round trip skips pruning. Verify the retained files still exist and report the counts.
