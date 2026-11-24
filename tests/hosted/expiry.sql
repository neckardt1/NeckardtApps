-- Schedule once as the database owner on the project opted into hosted tests.
create extension if not exists pg_cron;
select cron.schedule('expire-habit-practice-workers', '19 * * * *',
  'select flashcards_private.expire_habit_fixtures()');
