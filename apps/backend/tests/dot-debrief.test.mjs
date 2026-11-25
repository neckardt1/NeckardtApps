import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("only a first-party opted-in round can deliver its numeric summary, once", async () => {
  const db = new PGlite();
  const query = async (sql, args = []) => (await db.query(sql, args)).rows;
  const scalar = async (sql, args = []) => Object.values((await query(sql, args))[0])[0];
  const owner = randomUUID();
  const other = randomUUID();
  const round = randomUUID();
  const secret = "synthetic webhook secret";
  const subscription = { owner_id: owner, id: "test-sub", url: "https://example.test/callback",
    secret, expires_at: new Date(Date.now() + 600000).toISOString() };
  const rpc = (action, payload) => scalar("select public.habit_notify_rpc($1,$2)", [action, payload]);
  const admin = () => db.exec("reset role");
  const service = () => db.exec("reset role; set role service_role");
  const asUser = async (id, extra = {}) => {
    await db.exec("reset role; set role authenticated");
    const claims = { sub:id, role:"authenticated", aud:"authenticated", is_anonymous:false, ...extra };
    await query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claims)]);
  };
  const arm = id => scalar("select public.habit_notify_arm($1)", [id]);
  const finish = id => query("select * from public.recall_finish_round($1)", [id]);
  const open = (who, id) => query(
    "insert into flashcards_private.practice_rounds(owner_id,round_id) values ($1,$2)", [who, id]);
  try {
    // Only the hosted Vault and pg_net boundaries are stubbed. The production trigger,
    // Finish, Postgres roles, arm, claim and acknowledgment functions all run here.
    await db.exec(`create role anon; create role authenticated; create role service_role; create role supabase_auth_admin;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid stable language sql as $$
        select (current_setting('request.jwt.claims', true)::jsonb->>'sub')::uuid $$;
      grant usage on schema auth to authenticated;
      create schema vault; create table vault.decrypted_secrets(name text, decrypted_secret text);
      insert into vault.decrypted_secrets values
        ('habit_notify_dispatch_url','https://fixture.supabase.co/functions/v1/neckardt-apps-mcp/deliver'),
        ('habit_notify_dispatch_secret',repeat('x',32));
      create schema net; create table net.requests(body jsonb);
      create function net.http_post(url text, body jsonb, headers jsonb, timeout_milliseconds integer)
        returns bigint language plpgsql as $$
        begin
          if headers->>'Authorization' <> 'Bearer ' || repeat('x',32) then raise exception 'Bad dispatch header'; end if;
          insert into net.requests values(body); return 1;
        end $$;`);
    const migrations = new URL("../supabase/migrations/", import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) {
      await db.exec(await readFile(new URL(name, migrations), "utf8"));
    }
    for (const who of [owner, other]) {
      await query("insert into auth.users values ($1)", [who]);
      await query("insert into flashcards_private.app_owner(owner_id) values ($1)", [who]);
    }
    await open(owner, round);
    await asUser(owner);
    await assert.rejects(arm(round), { code: "PT409" });
    await assert.rejects(rpc("subscribe", subscription), { code: "42501" });
    await service();
    assert.equal(await rpc("subscribe", subscription), true);
    await assert.rejects(rpc("subscribe", { ...subscription, url:"https://other.example/" }), { code:"PT409" });
    await assert.rejects(arm(round), { code: "42501" });
    await asUser(other);
    await assert.rejects(arm(round), { code:"42501" });
    await asUser(owner, { client_id:randomUUID() });
    await assert.rejects(arm(round), { code:"42501" });
    await asUser(owner);
    assert.equal(await arm(round), true);
    assert.equal(await arm(round), true);
    await finish(round);
    await finish(round);
    await assert.rejects(arm(round), { code:"42501" });
    await admin();
    const [request] = await query("select body from net.requests");
    const delivery = request.body;
    assert.deepEqual(Object.keys(delivery), ["delivery_id"]);
    assert.equal(await scalar("select count(*)::integer from net.requests"), 1);
    await query(`update flashcards_private.round_completions
      set outcomes = '{"easy":2,"yes":1,"some text":99,"hard":"private"}' where round_id=$1`, [round]);
    await service();
    const claim = await rpc("claim", delivery);
    assert.deepEqual(claim.outcomes, { easy:2, yes:1 });
    assert.equal(claim.subscription_id, subscription.id);
    assert.equal(claim.secret, secret);
    assert.deepEqual(Object.keys(claim).sort(), [
      "id","delivery_id","subscription_id","url","secret","finished_at","review_count","action_count","superseded_count","outcomes"
    ].sort());
    assert.equal(await rpc("claim", delivery), null);
    await rpc("ack", { ...delivery, http_status:200 });
    await rpc("ack", { ...delivery, http_status:500 });
    await admin();
    assert.equal(await scalar("select state from habit_notify.deliveries"), "accepted");

    // A successful old enrollment cannot authorize delivery to a replacement listener.
    const replaced = randomUUID();
    await open(owner, replaced);
    await asUser(owner);
    await arm(replaced);
    await service();
    await rpc("unsubscribe", subscription);
    await rpc("subscribe", { ...subscription, id:"new-sub" });
    await asUser(owner);
    await finish(replaced);
    await admin();
    assert.equal(await scalar("select count(*)::integer from net.requests"), 1);

    const missingConfig = randomUUID();
    await open(owner, missingConfig);
    await asUser(owner);
    await arm(missingConfig);
    await admin();
    await db.exec("delete from vault.decrypted_secrets");
    await asUser(owner);
    await finish(missingConfig);
    await admin();
    assert.equal(await scalar("select count(*)::integer from flashcards_private.round_completions"), 3);
    assert.equal(await scalar("select state from habit_notify.deliveries where round_id=$1", [missingConfig]), "failed");
    assert.equal(await scalar("select count(*)::integer from net.requests"), 1);
  } finally {
    await db.close();
  }
});
