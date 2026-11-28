import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { readPublicSupabaseConfig } from "../../shell/browser-auth.mts";
import { getSiteClient } from "../../shell/site-client.ts";
import { useSiteSession } from "../../shell/session.tsx";

declare const __SITE_PUBLIC_CONFIG__: unknown;
type View = { title: string; links: { href: string; title: string }[]; html?: string; message?: string };
const policy = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";
const frameHead = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1">`;

async function load(slug: string | undefined, path: string): Promise<View> {
  const config = readPublicSupabaseConfig(__SITE_PUBLIC_CONFIG__);
  if (!config) throw new Error("Missing configuration");
  const client = getSiteClient(config);
  if (!slug) {
    const { data } = await client.from("sites").select("slug,title").order("title").throwOnError();
    return { title: "Private sites", links: data.map(site => ({ href: "/sites/" + site.slug, title: site.title })),
      message: data.length ? undefined : "Your sites and sites shared with you will appear here." };
  }
  const base = "/sites/" + slug;
  const [{ data: page }, { data: pages }, { data: related }] = await Promise.all([
    client.from("site_pages").select("title,html").eq("site_slug", slug).eq("path", path).maybeSingle().throwOnError(),
    client.from("site_pages").select("path,title").eq("site_slug", slug).order("path").throwOnError(),
    client.from("site_links").select("site:sites!target_slug(slug,title)").eq("source_slug", slug).throwOnError()
  ]);
  if (!page) return { title: "Page unavailable", links: [], message: "Check the link and the account you signed in with." };
  return { title: page.title, html: page.html, links: [
    ...pages.filter(item => item.path !== path).map(item => ({ href: item.path ? base + "/" + item.path : base, title: item.title })),
    ...related.map(({ site }) => ({ href: "/sites/" + site.slug, title: site.title }))
  ] };
}

function SiteContent({ slug, path }: { slug?: string; path: string }) {
  const [view, setView] = useState<View | null>(null);
  const { isCurrent } = useSiteSession();
  useEffect(() => {
    let active = true;
    const show = (result: View) => { if (active && isCurrent()) setView(result); };
    load(slug, path).then(show, () => show({ title: "Couldn’t load sites", links: [], message: "Reload to try again." }));
    return () => { active = false; };
  }, [slug, path, isCurrent]);
  if (!view) return <p role="status">Loading…</p>;
  return <>
    {slug && <Link to="/sites">All private sites</Link>}
    <h1>{view.title}</h1>
    {view.message && <p>{view.message}</p>}
    {view.links.length > 0 && <nav aria-label="Site navigation"><ul>
      {view.links.map(link => <li key={link.href}><Link to={link.href}>{link.title}</Link></li>)}
    </ul></nav>}
    {view.html !== undefined && <iframe sandbox="" referrerPolicy="no-referrer" title={view.title}
      style={{ width: "100%", height: "75dvh", border: 0, background: "white" }} srcDoc={frameHead + view.html} />}
  </>;
}

export function Sites() {
  const session = useSiteSession();
  const { slug, "*": rest } = useParams();
  const path = (rest ?? "").replace(/\/+$/, "");
  return <section className="launcher">
    {session.status === "signed-in" && session.user
      ? <SiteContent key={JSON.stringify([session.user.id, slug, path])} slug={slug} path={path} />
      : <><h1>Private sites</h1><p>{session.status === "loading" ? "Checking your session…" :
        session.status === "unavailable" ? "Account sign-in is unavailable." : "Sign in under Account to open your private sites."}</p></>}
  </section>;
}
