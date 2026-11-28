import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The SQL connector accepts statement text. Encode all input as data, including HTML.
export function publishSql(action, input) {
  const literal = key => {
    const value = input[key];
    if (typeof value !== "string" || value.includes("\0")) throw Error("Invalid " + key);
    return `convert_from(decode('${Buffer.from(value).toString("hex")}','hex'),'UTF8')`;
  };
  const slug = literal("slug"), owner = literal("owner_id") + "::uuid";
  const ownedSite = `select slug from public.sites where slug = ${slug} and owner_id = ${owner}`;
  switch (action) {
    case "create":
      return `with created as (
        insert into public.sites (slug,title,owner_id) values (${slug},${literal("title")},${owner}) returning slug
      ) insert into public.site_pages (site_slug,path,title,html)
        select slug,'',${literal("title")},${literal("html")} from created returning site_slug,path;`;
    case "publish":
      return `insert into public.site_pages (site_slug,path,title,html)
        select slug,${literal("path")},${literal("title")},${literal("html")} from (${ownedSite}) s
        on conflict (site_slug,path) do update set title=excluded.title, html=excluded.html returning site_slug,path;`;
    case "share":
      return `insert into public.site_viewers (site_slug,viewer_id)
        select slug,${literal("viewer_id")}::uuid from (${ownedSite}) s
        on conflict do nothing returning site_slug,viewer_id;`;
    case "unshare":
      return `delete from public.site_viewers where site_slug in (${ownedSite})
        and viewer_id=${literal("viewer_id")}::uuid returning site_slug,viewer_id;`;
    case "link":
      return `insert into public.site_links (source_slug,target_slug)
        select s.slug,t.slug from (${ownedSite}) s, public.sites t where t.slug=${literal("target_slug")}
          and (t.owner_id=${owner} or exists (select 1 from public.site_viewers v
            where v.site_slug=t.slug and v.viewer_id=${owner}))
        on conflict do nothing returning source_slug,target_slug;`;
    default: throw Error("Expected create, publish, share, unshare or link");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(publishSql(process.argv[2], JSON.parse(readFileSync(0, "utf8"))));
