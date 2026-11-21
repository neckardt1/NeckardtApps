const grades=new Set(["miss","hard","medium","easy"]);

export function makeReviewSession(cards,enqueue,{
  makeId=()=>crypto.randomUUID(), now=()=>new Date().toISOString()
}={}) {
  // The array is a prefetch buffer, not a rendered card list.
  const batch=cards.slice(0,5);
  let index=0,revealed=false;
  return {
    view:()=>({
      index,total:batch.length,current:batch[index]?.front??null,
      revealed,answer:revealed?(batch[index]?.back??null):null,done:index>=batch.length
    }),
    reveal() {
      if(index>=batch.length||revealed) return false;
      revealed=true;
      return true;
    },
    rate(value) {
      if(index>=batch.length||!revealed||!grades.has(value)) return null;
      const card=batch[index];
      const event={review_id:makeId(),card_id:card.card_id,revision:card.revision,grade:value,reviewed_at:now()};
      enqueue(event); // synchronous small durable outbox write; never await network
      index++;
      revealed=false;
      return event;
    }
  };
}

export function makeOutbox({storage,prefix,send,onChange=()=>{},active=()=>true}) {
  const key=(id)=>prefix+id;
  let draining=false;
  function entries() {
    const out=[];
    for(let i=0;i<storage.length;i++) {
      const name=storage.key(i);
      if(name?.startsWith(prefix)) {
        const parsed=JSON.parse(storage.getItem(name)||"null");
        if(parsed?.event?.review_id) out.push(parsed);
      }
    }
    return out.sort((a,b)=>a.event.reviewed_at.localeCompare(b.event.reviewed_at));
  }
  function put(item) {storage.setItem(key(item.event.review_id),JSON.stringify(item));}
  return {
    entries,
    enqueue(event) {put({event,status:"pending"});},
    async flush(){
      if(draining) return;
      draining=true;
      try {
        while(active()){
          const item=entries().find(e=>e.status==="pending");
          if(!item) return;
          try {
            await send(item.event);
            storage.removeItem(key(item.event.review_id));
          } catch(error) {
            put({...item,status:[400,403,404,409,422].includes(error?.status)?"conflict":"failed"});
          }
          if(active()) onChange();
        }
      } finally {draining=false;}
    },
    retry(){for(const item of entries()) if(item.status==="failed") put({...item,status:"pending"});onChange();void this.flush();},
    dismissConflicts(){for(const item of entries()) if(item.status==="conflict") storage.removeItem(key(item.event.review_id));onChange();}
  };
}
