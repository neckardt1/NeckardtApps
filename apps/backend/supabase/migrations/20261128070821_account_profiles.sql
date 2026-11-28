create table public.account_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  picture text check (octet_length(picture) <= 65536 and picture ~ '^data:image/jpeg;base64,/9j/[A-Za-z0-9+/]*={0,2}$')
);

alter table public.account_profiles enable row level security;
revoke all on public.account_profiles from public, anon, authenticated, service_role;
grant select, insert, update on public.account_profiles to authenticated;

-- Applies to both the existing row and the proposed row on insert/update.
create policy manage_own_profile on public.account_profiles for all to authenticated using (
  user_id = (select auth.uid())
  and (select nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'is_anonymous') = 'false'::jsonb
  and (select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'client_id') is null
);
