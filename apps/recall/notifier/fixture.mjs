// Synthetic local fixture shared by integration tests and the HTTP benchmark.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import * as fsrs from 'ts-fsrs';
import { gradeHandler, schedulerFor } from '../supabase/functions/recall-grade/grade.mjs';
import { completionStore } from './store.mjs';

export async function fixture({ now = Date.now, dataDir } = {}) {
  const db = new PGlite(dataDir);
  const ownerId = randomUUID();
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid stable language sql as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$; grant usage on schema auth to anon,authenticated,service_role;`);
  for (const name of ['20261121000000_demo_flashcards', '20261121000100_recall_fsrs_synthetic']) {
    await db.exec(await readFile(new URL('../supabase/migrations/' + name + '.sql', import.meta.url), 'utf8'));
  }
  await db.exec(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  await q('insert into auth.users values($1)', [ownerId]);
  await q('insert into flashcards_private.app_owner(owner_id) values($1)', [ownerId]);
  const store = completionStore(db, { now });
  let wake = () => {};
  const values = p => [p.p_owner,p.p_review_id,p.p_card_id,p.p_revision,p.p_grade,p.p_reviewed_at];
  const handler = gradeHandler({
    getOwner: async token => token === 'synthetic-owner' ? ownerId : null,
    prepare: async p => (await q('select public.recall_grade_context($1,$2,$3,$4,$5,$6) result', values(p)))[0].result,
    commit: async p => (await q('select public.recall_commit_review($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) result',
      [...values(p),p.p_due_at,p.p_state,p.p_log,p.p_scheduler_build,p.p_scheduler_config]))[0].result,
    schedule: schedulerFor(fsrs),
    afterSave: () => wake()
  });
  return {
    db, q, ownerId, store, setWake: fn => { wake = fn; },
    async session(count = 3) {
      const sessionId = randomUUID(), reviews = [];
      for (let i = 0; i < count; i++) {
        const cardId = randomUUID();
        await q(`insert into flashcards_private.cards(id,owner_id,front,back,due_at)
          values($1,$2,'Synthetic question','Synthetic answer',now()-interval '1 minute')`, [cardId, ownerId]);
        reviews.push({ review_id: randomUUID(), card_id: cardId, revision: 0,
          grade: 'medium', reviewed_at: new Date().toISOString() });
      }
      return { ownerId, sessionId, reviews, reviewIds: reviews.map(x => x.review_id) };
    },
    grade: review => handler(new Request('https://test.invalid/functions/v1/recall-grade', {
      method: 'POST', headers: { authorization: 'Bearer synthetic-owner' }, body: JSON.stringify(review)
    })),
    events: () => q('select * from flashcards_private.completion_events order by created_at,event_id'),
    close: () => db.close()
  };
}
