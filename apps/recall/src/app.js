import {createClient} from "@supabase/supabase-js";
import {makeOutbox,makeReviewSession} from "./review-session.js";
const $=(id)=>document.getElementById(id);
const config=window.RECALL_SUPABASE??{};
let url;
try {url=new URL(config.url);}catch{}
const valid=url?.protocol==="https:" && url.hostname.endsWith(".supabase.co")
  && url.pathname==="/" && !url.username && !url.password && !url.port && !url.search && !url.hash
  && /^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey??"");
if(!valid){
  $("config-note").hidden=false;
  $("config-note").textContent="The connected sample is not configured. The original offline demo still works.";
} else run(url.origin,config.publishableKey);

function run(origin,key){
  const client=createClient(origin,key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
  let owner=null,outbox=null,review=null,tap=-Infinity,request=0;
  const messages=$("deck-status");
  function paintStatus(){
    if(!outbox)return;
    let items;
    try {items=outbox.entries();} catch {
      $("status").textContent="Browser storage is unavailable. Ratings cannot be safely queued here.";
      return;
    }
    const count=(status)=>items.filter(e=>e.status===status).length;
    const pending=count("pending"),retry=count("failed"),conflict=count("conflict");
    $("status").textContent=[
      pending&&`Saving ${pending}…`,retry&&`${retry} need a retry`,conflict&&`${conflict} cannot be saved; reload due cards`
    ].filter(Boolean).join(" · ")||"No unsaved ratings";
    $("status").classList.toggle("error",Boolean(retry||conflict));
    $("retry").hidden=!retry;
    $("refresh-conflict").hidden=!conflict;
    $("restart").disabled=Boolean(items.length);
  }
  function render(focus=false){
    const s=review?.view();
    $("progress-label").textContent=s?(s.done?`${s.total} of ${s.total} reviewed`:`Card ${s.index+1} of ${s.total}`):"";
    $("progress").style.gridTemplateColumns=s?.total?`repeat(${s.total},1fr)`:"";
    $("progress").replaceChildren(...Array.from({length:s?.total??0},(_,i)=>{
      const node=document.createElement("span");
      node.className=i<s.index?"done":i===s.index?"current":"";
      return node;
    }));
    $("back").hidden=!s?.revealed;
    $("answer").textContent=s?.answer??"";
    $("show-answer").hidden=!s?.current||s.revealed;
    $("actions").hidden=!s?.current||!s.revealed;
    $("card-label").textContent=!s||s.done?"Sample deck":"Question";
    $("front").textContent=!s?"Ready to load cards":s.current??(s.total?"That’s all for this round.":"No cards due now.");
    $("complete").hidden=Boolean(s?.current);
    $("summary").textContent="";
    paintStatus();
    if(focus)$("front").focus({preventScroll:true});
  }
  async function load(){
    if(!owner||!outbox)return;
    const n=++request;
    messages.textContent="Loading due cards…";
    const {data,error}=await client.rpc("demo_flashcards_due",{p_limit:5});
    if(n!==request)return;
    if(error){
      messages.textContent=error.code==="42501"?"This account is not the configured deck owner.":"Could not load cards. Try again.";
      review=null;render();return;
    }
    try{
      const blocked=new Set(outbox.entries().map(e=>e.event.card_id));
      review=makeReviewSession((data??[]).filter(c=>!blocked.has(c.card_id)),event=>outbox.enqueue(event));
      messages.textContent="";
      render();
      void outbox.flush();
    } catch {
      messages.textContent="Browser storage is unavailable. Ratings cannot be safely queued.";
      review=null;render();
    }
  }
  const reveal=()=>{
    if(!review?.reveal()) return;
    render();
    $("answer").focus({preventScroll:true});
  };
  const rating=(value)=>{
    if(!review||performance.now()-tap<230) return;
    try {
      if(!review.rate(value))return;
      tap=performance.now();render(true);void outbox.flush();
    } catch {
      // Never advance if local durable storage failed before enqueue completed.
      messages.textContent="Could not queue this rating. The card has not advanced.";
    }
  };
  async function activate(session){
    const next=session?.user?.id??null;
    if(next===owner)return;
    ++request; owner=next;
    review=null;outbox=null;
    $("deck").hidden=!owner;$("sign-in").hidden=Boolean(owner);
    if(!owner){render();return;}
    const scope=owner;
    try {
      outbox=makeOutbox({
        storage:window.localStorage,prefix:`recall.live.v1.${origin}.${owner}.`,
        active:()=>owner===scope,onChange:paintStatus,
        async send(event) {
          const {error}=await client.functions.invoke("recall-grade",{body:event});
          if(error){
            const e=new Error("Rating could not be saved");
            e.status=error.context?.status;
            throw e;
          }
        }
      });
    } catch {
      messages.textContent="Browser storage is unavailable. Ratings cannot be safely queued.";
      render();return;
    }
    render();void load();
  }
  $("sign-in").addEventListener("submit",async (event)=>{
    event.preventDefault();
    const btn=event.currentTarget.querySelector("button");
    btn.disabled=true;
    const data=new FormData(event.currentTarget);
    $("sign-in-msg").textContent="Signing in…";
    try{
      const {error,data:result}=await client.auth.signInWithPassword({email:data.get("email"),password:data.get("password")});
      $("sign-in-msg").textContent=error?"Sign-in failed. Check the owner account credentials.":"";
      if(!error){
        $("sign-in").reset();
        void activate(result.session);
      }
    } finally {btn.disabled=false;}
  });
  $("sign-out").addEventListener("click",async ()=>{
    const {error}=await client.auth.signOut({scope:"local"});
    if(error) messages.textContent="Could not sign out. Try again.";
    else void activate(null);
  });
  $("restart").addEventListener("click",()=>void load());
  $("retry").addEventListener("click",()=>outbox?.retry());
  $("refresh-conflict").addEventListener("click",()=>{outbox?.dismissConflicts();void load();});
  $("show-answer").addEventListener("click",reveal);
  $("ratings").addEventListener("click",e=>{const btn=e.target.closest("[data-grade]");if(btn)rating(btn.dataset.grade);});
  document.addEventListener("keydown",e=>{
    const state=review?.view();
    if(!state?.current||$("deck").hidden||e.repeat||e.altKey||e.ctrlKey||e.metaKey||e.isComposing||e.target.closest?.("input,textarea,select,[contenteditable]"))return;
    if(e.key===" "||e.key==="Enter"){
      // Use native Space/Enter behavior for focused controls. On the card
      // itself, use Anki's reveal / Good shortcut.
      if(e.target.closest?.("button,a")) return;
      e.preventDefault();
      if(state.revealed) rating("medium");
      else reveal();
    } else if(state.revealed&&/^[1-4]$/.test(e.key)){
      e.preventDefault();
      rating(["miss","hard","medium","easy"][Number(e.key)-1]);
    }
  });
  // Avoid awaiting any Auth SDK method inside its own auth callback.
  client.auth.onAuthStateChange((_event,session)=>setTimeout(()=>void activate(session),0));
  $("sign-in").hidden=false;
}
