import assert from "node:assert/strict";
import {generateKeyPairSync, randomUUID, sign} from "node:crypto";
import {test} from "node:test";
import {createClient} from "@supabase/supabase-js";
import {firstPartyOwner,gradeHandler} from "../supabase/functions/recall-grade/grade.mjs";

const project="https://grade-fixture.invalid";
const issuer=project+"/auth/v1";
const owner=randomUUID(), session=randomUUID(), client=randomUUID();
const keys=generateKeyPairSync("ec",{namedCurve:"P-256"});
const jwk={...keys.publicKey.export({format:"jwk"}),alg:"ES256",kid:"local-grade",use:"sig"};
const body={review_id:randomUUID(),card_id:randomUUID(),revision:0,
  grade:"hard",reviewed_at:new Date().toISOString()};
const b64=value=>Buffer.from(JSON.stringify(value)).toString("base64url");
function token(changes={},signingKey=keys.privateKey) {
  const now=Math.floor(Date.now()/1000);
  const claims={iss:issuer,aud:"authenticated",sub:owner,role:"authenticated",
    session_id:session,iat:now,exp:now+300,is_anonymous:false,...changes};
  const input=b64({alg:"ES256",kid:jwk.kid,typ:"JWT"})+"."+b64(claims);
  return input+"."+sign("sha256",Buffer.from(input),
    {key:signingKey,dsaEncoding:"ieee-p1363"}).toString("base64url");
}

// Only the provider's HTTP endpoints are fixtures. Production SDK getClaims
// checks the ES256 signature with this disposable project key.
function fixture({userId=owner,userStatus=200}={}) {
  const seen=[], database=[];
  const {auth}=createClient(project,"fixture-publishable",{
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false,storageKey:randomUUID()},
    global:{fetch:async(input,init)=>{
      const path=new URL(input).pathname;
      seen.push({path,bearer:new Headers(init?.headers).get("authorization")});
      if(path==="/auth/v1/.well-known/jwks.json") return Response.json({keys:[jwk]});
      assert.equal(path,"/auth/v1/user");
      return userStatus===200 ? Response.json({id:userId,aud:"authenticated",is_anonymous:false})
        : Response.json({message:"Fixture unavailable"},{status:userStatus});
    }},
  });
  const handle=gradeHandler({
    getOwner:jwt=>firstPartyOwner(auth,issuer,jwt),
    prepare:async params=>{database.push(["prepare",params.p_owner]); return {kind:"card"};},
    schedule:()=>({}),
    commit:async params=>{database.push(["commit",params.p_owner]); return {revision:1};},
  });
  const post=jwt=>handle(new Request(project+"/functions/v1/recall-grade",{
    method:"POST",headers:{authorization:"Bearer "+jwt},body:JSON.stringify(body),
  }));
  return {post,seen,database};
}

test("a first-party grade verifies the exact token, checks the live user, and reaches the owner RPCs",async()=>{
  const f=fixture(), jwt=token();
  assert.equal((await f.post(jwt)).status,200);
  assert.equal(f.seen.find(row=>row.path==="/auth/v1/user").bearer,"Bearer "+jwt);
  assert.deepEqual(f.database,[["prepare",owner],["commit",owner]]);
});

test("delegated, misbound and invalid grants are rejected before owner RPCs",async()=>{
  const f=fixture();
  const delegated={client_id:client,aud:project+"/functions/v1/recall-events/web/mcp",role:"recall_canary_oauth"};
  for(const [label,changes] of Object.entries({
    "canary owner token":delegated, "OAuth with first-party-looking audience and role":{client_id:client},
    "empty client marker":{client_id:""}, "null client marker":{client_id:null},
    "unbound issuer":{iss:"https://other.invalid/auth/v1"}, "wrong audience":{aud:delegated.aud},
    "multiple audiences":{aud:["authenticated",delegated.aud]}, "wrong role":{role:"service_role"},
    "missing subject":{sub:undefined}, "missing session":{session_id:undefined},
    "malformed session":{session_id:[session]}, "anonymous session":{is_anonymous:true}, "expired":{exp:1},
  })) {
    assert.equal((await f.post(token(changes))).status,401,label);
  }
  const otherKey=generateKeyPairSync("ec",{namedCurve:"P-256"}).privateKey;
  assert.equal((await f.post(token({},otherKey))).status,401);
  assert.deepEqual(f.database,[]);
  assert.equal(f.seen.some(r=>r.path==="/auth/v1/user"),false);
});

test("verified claims also require the live session to resolve to the same subject",async()=>{
  for(const [options,status] of [[{userId:randomUUID()},401],[{userStatus:401},401],[{userStatus:503},503]]) {
    const f=fixture(options);
    assert.equal((await f.post(token())).status,status);
    assert.deepEqual(f.database,[]);
  }
});
