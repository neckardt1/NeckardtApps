import {randomUUID} from "node:crypto";
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import * as fsrsLib from "ts-fsrs";
import {PGlite} from "@electric-sql/pglite";
import {gradeHandler,schedulerFor} from "../supabase/functions/recall-grade/grade.mjs";
import {makeOutbox,makeReviewSession} from "../../../src/apps/habit-practice/review-session.ts";

test("actual Edge handler + FSRS-6 + both SQL migrations",async ()=>{
 const db=new PGlite();
 const owner=randomUUID(), other=randomUUID();
 const q=async (sql,params=[]) => (await db.query(sql,params)).rows;
 const role=async (name,id="")=>{
   await db.exec("reset role; set role "+name);
   await q("select set_config('request.jwt.claim.sub',$1,false)",[id]);
 };
 try{
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth; create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid stable language sql as $$
    select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
  $$; grant usage on schema auth to anon,authenticated,service_role;`);
  for(const name of ["20261121000000_demo_flashcards","20261121000100_recall_fsrs_synthetic"]) {
    await db.exec(await readFile(new URL("../supabase/migrations/"+name+".sql",import.meta.url),"utf8"));
  }
  await q("insert into auth.users values ($1),($2)",[owner,other]);
  await q("insert into flashcards_private.app_owner(owner_id) values($1)",[owner]);
  await q(`insert into flashcards_private.cards(owner_id,front,back,due_at)
    select $1,'Question '||i,'Answer '||i,now()+(i-7)*interval '1 second'
    from generate_series(1,6) i`,[owner]);
  await role("anon");
  await assert.rejects(q("select * from public.demo_flashcards_due(5)"),{code:"42501"});
  await role("authenticated",other);
  await assert.rejects(q("select * from public.demo_flashcards_due(5)"),{code:"42501"});
  await role("authenticated",owner);
  const cards=await q("select * from public.demo_flashcards_due(80)");
  assert.equal(cards.length,5);
  assert(!Object.hasOwn(cards[0],"scheduler_state"));
  assert.equal(cards[0].front,"Question 1");
  await assert.rejects(q("select scheduler_state from flashcards_private.cards"),{code:"42501"});
  await assert.rejects(q("update flashcards_private.cards set revision=123"),{code:"42501"});
  await assert.rejects(q("select * from flashcards_private.reviews"),{code:"42501"});
  const getParams=p=>[p.p_owner,p.p_review_id,p.p_card_id,p.p_revision,p.p_grade,p.p_reviewed_at];
  const contextSQL="select public.recall_grade_context($1,$2,$3,$4,$5,$6) answer";
  const commitSQL="select public.recall_commit_review($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) answer";
  const fields={
    card_id:cards[0].card_id,review_id:randomUUID(),
    revision:cards[0].revision,grade:"medium",reviewed_at:new Date().toISOString()
  };
  const args=[owner,fields.review_id,fields.card_id,0,"medium",fields.reviewed_at];
  await assert.rejects(q(contextSQL,args),{code:"42501"});
  await assert.rejects(q(commitSQL,[...args,new Date().toISOString(),{},{},'no',{}]),{code:"42501"});
  await role("service_role");
  const testSchedule=schedulerFor(fsrsLib);
  const contenderParams=[...args];
  contenderParams[1]=randomUUID();
  const snapshot=(await q(contextSQL,contenderParams))[0].answer;
  assert.equal(snapshot.kind,"card");
  const contenderCalc=testSchedule(snapshot,"medium",fields.reviewed_at);
  const handler=gradeHandler({
    getOwner:async token=>token==="owner-token"?owner:token==="other-token"?other:null,
    prepare:async p=>(await q(contextSQL,getParams(p)))[0].answer,
    commit:async p=>(await q(commitSQL,[...getParams(p),p.p_due_at,p.p_state,p.p_log,p.p_scheduler_build,p.p_scheduler_config]))[0].answer,
    schedule:testSchedule
  });
  const post=(token,body)=>handler(new Request("https://test.invalid/functions/v1/recall-grade",{
    method:"POST",headers:token?{authorization:"Bearer "+token}:{},body:JSON.stringify(body)
  }));
  assert.equal((await post("",fields)).status,401);
  assert.equal((await post("other-token",fields)).status,403);
  assert.equal((await post("owner-token",{...fields,p_state:{stability:999999}})).status,400);
  const first=await post("owner-token",fields);
  assert.equal(first.status,200,first.status!==200?await first.clone().text():"");
  const saved=await first.json();
  // Valid FSRS-6 Good from a New card goes to the 10-minute learning step,
  // not the old draft SQL's fixed 3-day Medium interval.
  assert.equal(Date.parse(saved.due_at)-Date.parse(fields.reviewed_at),10*60*1000);
  // A second request could have computed its next state before the first
  // one committed. The live commit must reject that stale result too.
  await assert.rejects(q(commitSQL,[...contenderParams,contenderCalc.dueAt,contenderCalc.state,
    contenderCalc.log,contenderCalc.build,contenderCalc.config]),{code:"PT409"});
  const replay=await post("owner-token",fields);
  assert.deepEqual(await replay.json(),saved);
  assert.equal((await post("owner-token",{...fields,grade:"easy"})).status,422);
  assert.equal((await post("owner-token",{...fields,review_id:randomUUID()})).status,409);
  await db.exec("reset role");
  let reviews=await q("select * from flashcards_private.reviews");
  assert.equal(reviews.length,1);
  assert.equal(reviews[0].scheduler_build,"ts-fsrs@5.4.2/FSRS-6");
  assert.equal(reviews[0].scheduler_config.w.length,21);
  assert.equal(reviews[0].fsrs_log.rating,3);
  assert(reviews[0].after_state.stability>0);
  const after=(await q("select * from flashcards_private.cards where id=$1",[fields.card_id]))[0];
  assert.equal(after.revision,1);
  assert.deepEqual(after.scheduler_state,reviews[0].after_state);
  // Hydrate the stored dates and verify second transition uses the persisted state.
  const secondEvent={...fields,review_id:randomUUID(),
    revision:1,reviewed_at:new Date(Date.parse(fields.reviewed_at)+1000).toISOString(),grade:"hard"};
  await role("service_role");
  const second=await post("owner-token",secondEvent);
  assert.equal(second.status,200,second.status!==200?await second.clone().text():"");
  await db.exec("reset role");
  reviews=await q("select * from flashcards_private.reviews order by card_revision");
  assert.equal(reviews.length,2);
  assert.equal(reviews[1].fsrs_log.rating,2);
  assert.equal(reviews[1].after_state.reps,2);
 } finally {await db.close();}
});

test("Anki-style session reveals, advances before saver, retries exact event and caps queue",async ()=>{
 const cache=new Map();
 const storage={get length(){return cache.size;},setItem:(k,v)=>cache.set(k,v),getItem:k=>cache.get(k),
   removeItem:k=>cache.delete(k),key:i=>[...cache.keys()][i]};
 let release,requests=[],db=new Map();
 const outbox=makeOutbox({storage,prefix:"test.",async send(event){
   requests.push(event);
   if(requests.length===1){
     await new Promise(resolve=>{release=resolve;});
     db.set(event.review_id,event); // atomically committed, response lost
     throw Error("network dropped");
   }
   if(!db.has(event.review_id))db.set(event.review_id,event);
 }});
 let sequence=0;
 const review=makeReviewSession(Array.from({length:6},(_,i)=>({card_id:"c"+i,revision:0,front:"q"+i,back:"a"+i})),
    event=>outbox.enqueue(event),{makeId:()=>String(++sequence),now:()=>new Date().toISOString()});
 assert.deepEqual(review.view(),{index:0,total:5,current:"q0",revealed:false,answer:null,done:false});
 assert.equal(review.rate("miss"),null);
 assert.equal(outbox.entries().length,0);
 assert.equal(review.reveal(),true);
 assert.equal(review.reveal(),false);
 assert.deepEqual(review.view(),{index:0,total:5,current:"q0",revealed:true,answer:"a0",done:false});
 assert.equal(outbox.entries().length,0);
 const first=review.rate("miss");
 assert.equal(first.grade,"miss");
 const save=outbox.flush();
 assert.deepEqual(review.view(),{index:1,total:5,current:"q1",revealed:false,answer:null,done:false});
 assert.equal(review.rate("medium"),null);
 assert.equal(outbox.entries()[0].status,"pending"); assert.equal(db.size,0);
 release(); await save;
 assert.equal(outbox.entries()[0].status,"failed");
 outbox.retry(); await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(requests[1],first); assert.equal(db.size,1);
 for(const grade of ["hard","medium","easy","miss"]){
   assert.equal(review.reveal(),true);
   assert.equal(review.rate(grade).grade,grade);
   assert.equal(review.view().answer,null);
 }
 assert.equal(review.view().current,null); assert.equal(review.view().total,5);
 assert.equal(review.rate("easy"),null);
 assert.equal(review.reveal(),false);
 await outbox.flush(); assert.equal(db.size,5);
});
