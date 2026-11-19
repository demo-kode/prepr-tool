'use strict';
(() => {
  let refreshing=false,watchedReview=null,lastCheck=0;
  function indicator(active,label,description,working=false){
    const node=document.querySelector('#watcher-indicator');node.classList.toggle('watching',active&&!working);node.classList.toggle('working',active&&working);node.title=description;
    const text=node.querySelector('.watcher-label');if(text.textContent!==label)text.textContent=label;
  }
  async function refresh() {
    const holder=document.querySelector('.live-review-status');
    if(!holder||!state.review||refreshing)return;
    const rid=state.review.id;refreshing=true;
    if(watchedReview!==rid){watchedReview=rid;state.watcher=null;indicator(false,'Not watching','Checking whether an agent is watching this review');}
    try {
      const result=await api('/api/reviews/'+rid+'/watch');
      if(!holder.isConnected||state.review?.id!==rid)return;
      lastCheck=Date.now();
      const watching=!!result.watcher?.active&&!result.decision,w=watching?result.watcher:null,busy=!!w&&w.activity!=='idle';
      const doing=busy?`${w.activity==='code'?'changing code':'writing a reply'} for ${w.threads.length} thread${w.threads.length===1?'':'s'}`:'';
      indicator(watching,busy?'Agent working':watching?'Agent watching':'Not watching',busy?`${w.author} is ${doing}`:watching?`${w.author} is watching this review`:'No agent is watching this review',busy);
      state.watcher=w;paintActivity();
      state.review.decision=result.decision;
      for(const button of document.querySelectorAll('.review-ship'))button.disabled=!!result.decision;
      for(const button of document.querySelectorAll('.review-keep'))button.disabled=['requested','preparing'].includes(result.decision?.status);
      for(const button of document.querySelectorAll('.review-edit'))button.disabled=!!result.decision;
      let feedback;
      if(result.watcher){
        const current=state.review;
        feedback=await api('/api/reviews/'+rid+'/feedback');
        if(!holder.isConnected||state.review!==current)return;
        if(!state.draft&&!document.querySelector('.composer')&&!document.activeElement?.matches('input,select,textarea')&&
           (state.tab!=='files'||state.file)&&JSON.stringify(feedback.threads)!==JSON.stringify(state.review.threads)){
          const panel=document.querySelector('.main-panel'),top=panel?.scrollTop,left=panel?.scrollLeft;
          state.review.threads=feedback.threads;renderShell();
          if(state.tab==='files'){renderFile();const next=document.querySelector('.main-panel');next.scrollTop=top||0;next.scrollLeft=left||0;}else renderOther();
          return;
        }
      }
      const signature=JSON.stringify([result,feedback?.latestSnapshot]);if(holder.dataset.signature===signature)return;
      holder.dataset.signature=signature;holder.replaceChildren();
      if(result.decision){
        const d=result.decision,labels={kept:'Kept locally · review closed',requested:'Ship it requested · waiting for the working agent',preparing:'Working agent preparing pull requests',shipped:'Pull requests created · review closed',blocked:'Shipping blocked · review closed'};
        holder.append(el('span','',labels[d.status]));
        if(d.result)holder.append(el('span','',d.result));
        return;
      }
      if(!result.watcher)return;
      if(result.watcher.active){
        holder.append(el('span','',`${result.watcher.author} · ${result.watcher.activity==='idle'?'working session watching':result.watcher.activity==='code'?'changing code':'writing replies'}`));
      }else holder.append(el('span','','Live review ended. Ask the working agent to resume.'));
      if(feedback?.latestSnapshot>state.review.snapshot)holder.append(btn('Open updated diff',()=>{if(canNavigate())return openReview(rid);}));
    }catch(e){if(holder.isConnected){holder.textContent=e.message;indicator(false,'Status unavailable','Unable to check the working agent');}}finally{refreshing=false;}
  }
  globalThis.PreprLive={refresh:()=>setTimeout(refresh,0),decide:async action=>{
    if(!canNavigate())return;
    const rid=state.review.id;
    if(action==='keep'&&!confirm('Keep local changes and delete this review with its comments?'))return;
    await api('/api/reviews/'+rid+'/decision',{action,snapshot:state.review.snapshot});
    // Keep deletes review; back to list.
    if(action==='keep'){lastCheck=0;watchedReview=null;indicator(false,'Not watching','No review open');state.review=null;history.replaceState(null,'','/');await home();toast('Review kept locally and removed');return;}
    await refresh();
  }};
  setInterval(()=>{if(lastCheck&&Date.now()-lastCheck>10000)indicator(false,'Status unavailable','Working-agent status is out of date');refresh();},2000);refresh();
})();
