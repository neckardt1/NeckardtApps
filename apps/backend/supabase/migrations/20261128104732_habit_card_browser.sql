grant select (kind) on flashcards_private.cards to authenticated;

create function public.recall_browse_cards(p_after uuid default null)
returns table (card_id uuid, front text, back text, kind text, active boolean, due_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select c.id, c.front, c.back, c.kind, c.active, c.due_at
  from flashcards_private.cards c
  where c.owner_id = (select auth.uid())
    and (p_after is null or c.id > p_after)
  order by c.id limit 100
$$;

revoke all on function public.recall_browse_cards(uuid) from public, anon, authenticated, service_role;
grant execute on function public.recall_browse_cards(uuid) to authenticated;
notify pgrst, 'reload schema';
