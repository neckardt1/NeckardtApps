-- owner_id already has a NOT NULL unique constraint referenced by the decks.
-- Drop the one-row limit in place so enrolled users and those references survive.
alter table flashcards_private.app_owner drop column singleton;
