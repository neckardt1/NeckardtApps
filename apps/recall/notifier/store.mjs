// Private SQL adapter for the isolated PGlite/Postgres experiment. Production
// needs reviewed, restricted RPCs; never give this connection to the browser.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = ms => new Date(ms).toISOString();
export function completionStore(db, { now = Date.now, makeId = () => crypto.randomUUID() } = {}) {
  return {
    // Register the immutable review-ID manifest on the final tap, even if the
    // last grade is in flight. Registration does not mean the session is saved.
    async register({ ownerId, sessionId, reviewIds }) {
      if (!uuid.test(ownerId) || !uuid.test(sessionId) || !Array.isArray(reviewIds)
          || reviewIds.length < 1 || reviewIds.length > 5 || reviewIds.some(id => !uuid.test(id))) {
        throw new Error('Invalid completion manifest');
      }
      const ids = reviewIds.map(id => id.toLowerCase()).sort();
      if (new Set(ids).size !== ids.length) throw new Error('Duplicate review IDs');
      return db.transaction(async tx => {
        const at = iso(now());
        await tx.query(`insert into flashcards_private.completion_events
          (event_id, owner_id, session_id, review_ids, created_at, next_attempt_at)
          values ($1,$2,$3,$4,$5,$5) on conflict(owner_id,session_id) do nothing`,
        [makeId(), ownerId, sessionId, ids, at]);
        const { rows: [event] } = await tx.query(`select * from flashcards_private.completion_events
          where owner_id=$1 and session_id=$2 for update`, [ownerId, sessionId]);
        if (JSON.stringify(event.review_ids) !== JSON.stringify(ids)) throw new Error('Session manifest changed');
        for (const id of ids) {
          await tx.query(`insert into flashcards_private.completion_reviews(owner_id,review_id,event_id)
            values($1,$2,$3) on conflict(owner_id,review_id) do nothing`, [ownerId, id, event.event_id]);
          const { rows: [binding] } = await tx.query(`select event_id from flashcards_private.completion_reviews
            where owner_id=$1 and review_id=$2`, [ownerId, id]);
          if (binding.event_id !== event.event_id) throw new Error('Review already belongs to another session');
        }
        return event.event_id;
      });
    },
    async claim({ leaseMs, maxAttempts }) {
      const at = iso(now()), token = makeId();
      await db.query(`update flashcards_private.completion_events set state='dead',
        lease_token=null,lease_until=null,last_error='delivery_unknown'
        where state='leased' and lease_until <= $1 and attempts >= $2`, [at, maxAttempts]);
      const { rows } = await db.query(`with candidate as (
        select e.event_id from flashcards_private.completion_events e
        where ((e.state='waiting' and e.next_attempt_at <= $1)
          or (e.state='leased' and e.lease_until <= $1)) and e.attempts < $4
        and not exists (
          select 1 from unnest(e.review_ids) expected(id)
          where not exists (select 1 from flashcards_private.reviews r
            where r.owner_id=e.owner_id and r.review_id=expected.id)
        )
        order by e.created_at,e.event_id for update skip locked limit 1
      ) update flashcards_private.completion_events e set state='leased', attempts=e.attempts+1,
        lease_token=$2, lease_until=$3, ready_observed_at=coalesce(e.ready_observed_at,$1),
        last_review_recorded_at=(select max(r.recorded_at) from flashcards_private.reviews r
          where r.owner_id=e.owner_id and r.review_id=any(e.review_ids))
        from candidate c where e.event_id=c.event_id
        returning e.event_id,e.session_id,e.attempts,e.lease_token,e.ready_observed_at,e.last_review_recorded_at`,
      [at, token, iso(now() + leaseMs), maxAttempts]);
      return rows[0] ?? null;
    },
    async accepted(event) {
      const { rows } = await db.query(`update flashcards_private.completion_events
        set state='accepted',relay_accepted_at=$3,lease_token=null,lease_until=null,last_error=null
        where event_id=$1 and state='leased' and lease_token=$2 returning event_id`,
      [event.event_id, event.lease_token, iso(now())]);
      return rows.length === 1;
    },
    async failed(event, { code, retryMs, maxAttempts, retryable }) {
      const { rows } = await db.query(`update flashcards_private.completion_events
        set state=$3,next_attempt_at=$4,last_error=$5,lease_token=null,lease_until=null
        where event_id=$1 and state='leased' and lease_token=$2 returning event_id`,
      [event.event_id, event.lease_token, !retryable || event.attempts >= maxAttempts ? 'dead' : 'waiting',
        iso(now() + retryMs), code]);
      return rows.length === 1;
    }
  };
}
