begin;

-- Enrollment is separate from Habit Practice. This migration enrolls nobody.
create table public.todo_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade
);
create table public.todo_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.todo_accounts(user_id) on delete cascade,
  collaborator_id uuid references public.todo_accounts(user_id) on delete set null,
  name text not null check (length(btrim(name)) between 1 and 120),
  check (collaborator_id <> owner_id)
);
create table public.todo_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.todo_projects(id) on delete cascade,
  title text not null check (length(btrim(title)) between 1 and 240),
  done boolean not null default false,
  created_at timestamptz not null default now()
);
create index on public.todo_projects (owner_id);
create index on public.todo_projects (collaborator_id) where collaborator_id is not null;
create index on public.todo_tasks (project_id);

alter table public.todo_accounts enable row level security;
alter table public.todo_projects enable row level security;
alter table public.todo_tasks enable row level security;
revoke all on public.todo_accounts, public.todo_projects, public.todo_tasks
  from public, anon, authenticated, service_role;

grant select on public.todo_accounts, public.todo_projects, public.todo_tasks to authenticated;
grant insert (owner_id, name), update (collaborator_id) on public.todo_projects to authenticated;
grant insert (project_id, title), update (title, done) on public.todo_tasks to authenticated;

create policy see_own_enrollment on public.todo_accounts for select to authenticated
  using (user_id = (select auth.uid()));
create policy see_project on public.todo_projects for select to authenticated
  using (owner_id = (select auth.uid()) or collaborator_id = (select auth.uid()));
create policy create_private_project on public.todo_projects for insert to authenticated
  with check (owner_id = (select auth.uid()) and collaborator_id is null);
create policy manage_sharing on public.todo_projects for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

-- The project SELECT policy supplies the same membership check for every task operation.
create policy work_on_project_tasks on public.todo_tasks for all to authenticated
  using (exists (select 1 from public.todo_projects p where p.id = project_id))
  with check (exists (select 1 from public.todo_projects p where p.id = project_id));

commit;
