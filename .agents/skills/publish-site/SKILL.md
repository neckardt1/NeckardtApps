---
name: publish-site
description: Create, update, share, or link private static sites on Neckardt Apps through the connected Supabase SQL tool.
---

Resolve the requesting account's owner UUID from its verified account mapping. Use that identity even when the requester can view someone else's site. Resolve a requested viewer to their existing, verified Supabase account. Confirm the project against apps/backend/supabase/functions/_shared/public-config.json.

Keep real HTML, account identifiers, input JSON and generated SQL outside Git in private temporary files. Write static HTML with inline CSS and embedded data images. The viewer supplies site navigation. Use paths for pages within a site and the link operation for a separately shared site. Avoid external resource requests, in-body navigation, scripts and forms.

Each operation takes a JSON object with `owner_id` and `slug`. Slugs and nested path segments use lowercase letters, digits and internal hyphens.

| Operation | Additional fields | Effect |
| --- | --- | --- |
| create | title, html | Create the site and homepage atomically. A duplicate slug fails. |
| publish | path, title, html | Add or replace one page. An empty path addresses the homepage. |
| share / unshare | viewer_id | Grant or remove site-wide read access. |
| link | target_slug | List another site in navigation for people with access to both. |

From the repo root, run `node .agents/skills/publish-site/publish.mjs OPERATION < input.json > statement.sql`. Execute the resulting statement with the connected Supabase SQL tool. Check the receipt before reporting success. If it returns zero rows or the result is uncertain, verify the intended owner, target and state in the database before retrying. On a create collision, ask for a different slug. Return the private URL at `https://apps.neckardt.com/sites/{slug}/{path}`.
