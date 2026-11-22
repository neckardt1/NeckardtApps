const headers={
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods":"POST, OPTIONS",
  "Cache-Control":"no-store",
  "Content-Type":"application/json"
};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const payloadKeys=["card_id","grade","review_id","reviewed_at","revision"];
const gradeLabels={miss:"Again",hard:"Hard",medium:"Good",easy:"Easy"};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
const storageJson=(x)=>JSON.parse(JSON.stringify(x));
const onlyResult=(r)=>({review_id:r.review_id,card_id:r.card_id,revision:r.revision,due_at:r.due_at});

export function schedulerFor(fsrsLib) {
  const config=fsrsLib.generatorParameters({
    request_retention:0.9,enable_fuzz:false,enable_short_term:true,
    learning_steps:["1m","10m"],relearning_steps:["10m"],maximum_interval:36500
  });
  const scheduler=fsrsLib.fsrs(config);
  return (snapshot,grade,when)=>{
    const at=new Date(when);
    const card=snapshot.state
      ? {...snapshot.state,due:new Date(snapshot.state.due),
         last_review:snapshot.state.last_review?new Date(snapshot.state.last_review):undefined}
      : fsrsLib.createEmptyCard(new Date(snapshot.due_at));
    const result=scheduler.next(card,at,fsrsLib.Rating[gradeLabels[grade]]);
    return {
      dueAt:result.card.due.toISOString(),
      state:storageJson(result.card),
      log:storageJson(result.log),
      build:"ts-fsrs@5.4.2/FSRS-6",
      config:storageJson(config)
    };
  };
}

function authData({data,error}) {
  if(error && (!error.status || error.status>=500)) throw error;
  return error ? null : data;
}

export async function firstPartyOwner(auth,issuer,jwt) {
  // getUser can accept delegated OAuth tokens for this same user. Check the
  // verified JWT's intended audience and grant before performing owner RPCs.
  const claims=authData(await auth.getClaims(jwt))?.claims;
  if(!claims || claims.iss!==issuer || claims.aud!=="authenticated" ||
     claims.role!=="authenticated" || Object.hasOwn(claims,"client_id") ||
     typeof claims.sub!=="string" || !uuid.test(claims.sub) ||
     typeof claims.session_id!=="string" || !uuid.test(claims.session_id) ||
     (Object.hasOwn(claims,"is_anonymous") && claims.is_anonymous!==false)) return null;
  const user=authData(await auth.getUser(jwt))?.user;
  return user && user.id===claims.sub && !user.is_anonymous ? user.id : null;
}

export function gradeHandler({getOwner,prepare,commit,schedule}) {
  return async (request)=>{
    if(request.method==="OPTIONS") return new Response(null,{status:204,headers});
    if(request.method!=="POST") return json({error:"Method not allowed"},405);
    const auth=/^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization")||"");
    if(!auth) return json({error:"Sign in to review cards"},401);
    try {
      const owner=await getOwner(auth[1]);
      if(!owner) return json({error:"Sign in to review cards"},401);
      const raw=await request.text();
      if(raw.length>2048) return json({error:"Review is too large"},413);
      let p;
      try {p=JSON.parse(raw);}catch{return json({error:"Invalid review JSON"},400);}
      if(!p || Array.isArray(p) || Object.keys(p).sort().join("|")!==payloadKeys.join("|")
         || !uuid.test(p.card_id)||!uuid.test(p.review_id)
         || !Number.isInteger(p.revision)||p.revision<0||p.revision>2147483646
         || !Object.hasOwn(gradeLabels,p.grade)
         || typeof p.reviewed_at!=="string"
         || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(p.reviewed_at)
         || !Number.isFinite(Date.parse(p.reviewed_at))) return json({error:"Invalid review"},400);
      const owned={
        p_owner:owner,p_card_id:p.card_id,p_review_id:p.review_id,p_revision:p.revision,
        p_grade:p.grade,p_reviewed_at:p.reviewed_at
      };
      const context=await prepare(owned);
      if(context.kind==="replay") return json(onlyResult(context));
      if(context.kind!=="card") throw new Error("Unknown review snapshot");
      const result=schedule(context,p.grade,p.reviewed_at);
      const saved=await commit({...owned,p_due_at:result.dueAt,p_state:result.state,p_log:result.log,
        p_scheduler_build:result.build,p_scheduler_config:result.config});
      return json(onlyResult(saved));
    } catch(error) {
      const code=error?.code;
      if(code==="42501") return json({error:"This deck is available only to the configured owner."},403);
      if(code==="PT409") return json({error:"This card changed. Load the latest due cards."},409);
      if(code==="PT404") return json({error:"Card no longer exists."},404);
      if(code==="22023" || code==="23505") return json({error:"This review cannot be applied."},422);
      return json({error:"Could not save the rating. Retry the same review."},503);
    }
  };
}
