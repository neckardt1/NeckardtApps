---
name: backup
description: Capture every local table across the NeckardtApps database and verify the row snapshot in private Drive.
---

Use the most recent successful production Pages commit. The SQL path captures table rows across all non-system schemas, including Auth and Storage metadata. PostgreSQL catalogs, views, sequence state, schema definitions, roles and object-storage file contents are outside the row snapshot. Use matching database definitions for recovery. Foreign tables cause an explicit failure.

1. Confirm the hosted project from the repo's public config. Verify the Drive destination is the owner's private My Drive or a private folder there **before upload**. Auth and other managed schemas may include credentials. Keep results and temporary files private and out of Git, logs and chat.
2. Run `node .agents/skills/backup/snapshot.mjs inventory` and execute the emitted SQL through the connected Supabase SQL tool. Pipe the complete result array, in returned order, into `node .agents/skills/backup/snapshot.mjs sql <deployed-sha>`. Execute that SQL as one statement. The same database snapshot supplies the catalog check and every table's rows. If it returns zero rows, rediscover and retry. Missing permission, active row filtering, truncation or an oversized result fails the run.
3. Unwrap the single result programmatically. Pass the row object as JSON on stdin to `node .agents/skills/backup/snapshot.mjs save <private-temp-directory>`. Preserve the payload string verbatim. The script returns the filename and SHA-256.
4. Upload the file unchanged using the connected Drive upload action. Reuse an existing private file on retry only if name and checksum match. Verify owner and permissions, download via the authenticated connector and compare SHA-256. Clean the private temporary files and report link, commit, table count and verification status.
5. Rehearse recovery in a disposable database with matching definitions. Locate each entry by both schema and table name. Feed its rows as JSON text to PostgreSQL's jsonb_populate_recordset for the matching type, insert explicit writable columns in dependency order and compare rows in both directions using EXCEPT ALL. Account for triggers, partition routing, generated columns and identities. Treat a production restore as a separate operation.

## Retention after a verified upload

Use a dedicated private My Drive folder for scheduled snapshots. Record its ID in the schedule, supply it to upload, and verify its ownership and permissions each run. Leave older exports outside that folder alone.

After download verification, list every page of non-trashed files directly in that folder. Pass their `[{id,name}]` metadata on stdin to `node .agents/skills/backup/retention.mjs <freshly-verified-file-id>`. It prints a dry-run plan. Keep the current copy and progressively coarser weekly, fortnightly, monthly, quarterly, half-year and year-scale checkpoints. Exact ages vary with the capture dates.

Apply the plan only after a successful recovery rehearsal and while this is the sole backup run for the folder. For each proposed removal, recheck its ID, current parent, private ownership and matching filename, download it and verify that its payload format, header and checksum match the backup and Drive metadata. Use Drive Trash. If inventory, identity or verification is uncertain, preserve the file. A failed upload or round trip skips pruning. Verify the retained files still exist and report the counts.
