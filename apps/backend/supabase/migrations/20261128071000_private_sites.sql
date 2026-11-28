create table public.sites (
  slug text primary key check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text not null check (btrim(title) <> ''),
  owner_id uuid not null references auth.users(id) on delete cascade
);
create table public.site_viewers (
  site_slug text references public.sites on delete cascade,
  viewer_id uuid references auth.users(id) on delete cascade,
  primary key (site_slug, viewer_id)
);
create table public.site_pages (
  site_slug text references public.sites on delete cascade,
  path text check (path = '' or path ~ '^[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*$'),
  title text not null check (btrim(title) <> ''),
  html text not null,
  primary key (site_slug, path)
);
create table public.site_links (
  source_slug text references public.sites on delete cascade,
  target_slug text references public.sites on delete cascade,
  primary key (source_slug, target_slug),
  check (source_slug <> target_slug)
);

alter table public.sites enable row level security;
alter table public.site_viewers enable row level security;
alter table public.site_pages enable row level security;
alter table public.site_links enable row level security;
revoke all on public.sites, public.site_viewers, public.site_pages, public.site_links
  from public, anon, authenticated, service_role;
grant select on public.sites, public.site_viewers, public.site_pages, public.site_links to authenticated;
create policy own_memberships on public.site_viewers for select to authenticated
  using (viewer_id = (select auth.uid()));
create policy visible_sites on public.sites for select to authenticated using (
  owner_id = (select auth.uid()) or exists (
    select 1 from public.site_viewers v where v.site_slug = sites.slug and v.viewer_id = (select auth.uid())
  )
);

create function public.can_view_private_site(target text) returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from public.sites s where s.slug = target and s.owner_id = (select auth.uid()))
      or exists (select 1 from public.site_viewers v where v.site_slug = target and v.viewer_id = (select auth.uid()));
$$;
revoke all on function public.can_view_private_site(text) from public, anon, authenticated, service_role;
grant execute on function public.can_view_private_site(text) to authenticated;
create policy visible_pages on public.site_pages for select to authenticated using (
  public.can_view_private_site(site_slug)
);
create policy visible_links on public.site_links for select to authenticated using (
  public.can_view_private_site(source_slug) and public.can_view_private_site(target_slug)
);
