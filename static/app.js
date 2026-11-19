'use strict';
const app = document.querySelector('#app');
const authorInput = document.querySelector('#author');
authorInput.value = localStorage.getItem('prepr-author') || 'Reviewer';
authorInput.addEventListener('change', () => localStorage.setItem('prepr-author', authorInput.value.trim() || 'Reviewer'));
const state = { review: null, selected: null, tab: 'files', query: '', threadFilter: 'open', file: null, request: 0, draft: false };
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
function btn(text, action, cls='') { const n=el('button',cls,text); n.type='button'; n.addEventListener('click', () => Promise.resolve(action()).catch(error => toast(error.message))); return n; }
function time(iso) { return new Date(iso).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }
function toast(text) { const n=document.querySelector('#toast'); n.textContent=text; n.classList.add('visible'); clearTimeout(toast.timer); toast.timer=setTimeout(()=>n.classList.remove('visible'),4500); }
async function api(path, data, method='POST') { const response=await fetch(path, data===undefined ? {} : {method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}); const result=await response.json(); if(!response.ok) throw Error(result.error || 'Request failed'); return result; }
function currentThreads() { return state.review.threads.filter(t=>t.snapshot_id===state.review.snapshot); }
function key(repo,path) { return `${repo}\0${path}`; }
function viewed(repo,path) { return state.review.viewed.some(v=>v.repo===repo && v.path===path); }
function totalFiles() { return state.review.repos.reduce((n,r)=>n+r.files.length,0); }
function canNavigate() { if (!state.draft) return true; if(!confirm('Discard your unsaved comment?')) return false; state.draft=false; return true; }
window.addEventListener('beforeunload', event=>{if(state.draft){event.preventDefault();event.returnValue='';}});
function setLocation() { const url=new URL(location); url.search=''; url.searchParams.set('review',state.review.id); url.searchParams.set('snapshot',state.review.snapshot); if(state.selected) {url.searchParams.set('repo',state.selected.repo);url.searchParams.set('file',state.selected.path);} history.replaceState(null,'',url); }
async function openReview(id, snapshot, selection) {
  state.review=await api(`/api/reviews/${encodeURIComponent(id)}${snapshot?`?snapshot=${snapshot}`:''}`);
  if(selection) state.selected=selection;
  if(!state.selected || !state.review.repos.some(r=>r.name===state.selected.repo && r.files.some(f=>f.path===state.selected.path))) {
    const r=state.review.repos.find(r=>r.files.length); state.selected=r?{repo:r.name,path:r.files[0].path}:null;
  }
  setLocation(); renderShell();
  if(state.tab==='files') await loadFile(); else renderDiscussion();
}
async function refresh() { if(!canNavigate())return; await openReview(state.review.id,state.review.snapshot); toast('Comments refreshed'); }
function renderShell() {
  const r=state.review; app.replaceChildren();
  const header=el('section','review-header');
  const crumb=el('div','eyebrow'); const link=el('a','','Reviews');link.href='/';crumb.append(link,document.createTextNode(` / ${r.id}`));header.append(crumb);
  const title=el('div','title-line');title.append(el('h1','',r.title));
  const tools=el('div','title-tools');const versions=el('select');versions.setAttribute('aria-label','Review snapshot');
  r.snapshots.forEach((v,i)=>{const o=el('option','',`Snapshot ${r.snapshots.length-i}${i===0?' · latest':''} — ${time(v.created)}`);o.value=v.id;versions.append(o);});versions.value=r.snapshot;
  versions.addEventListener('change',()=>{if(!canNavigate()){versions.value=r.snapshot;return;}openReview(r.id,Number(versions.value)).catch(e=>toast(e.message));});
  tools.append(versions,btn('Refresh',refresh));title.append(tools);header.append(title);
  if(r.description)header.append(el('p','description',r.description));
  const stats=el('div','meta-line');const add=r.repos.reduce((n,r)=>n+r.files.reduce((m,f)=>m+f.added,0),0), del=r.repos.reduce((n,r)=>n+r.files.reduce((m,f)=>m+f.removed,0),0);
  stats.append(el('span','pill purple','Local review'),el('span','',`${r.repos.length} repositories`),el('span','',`${totalFiles()} changed files`),el('span','plus',`+${add.toLocaleString()}`),el('span','minus',`−${del.toLocaleString()}`));header.append(stats);
  const tabs=el('nav','tabs');const open=r.threads.filter(t=>t.status==='open').length;
  for(const [id,label,count] of [['files','Files',totalFiles()],['discussion','Discussion',open]]) {
    const b=btn(label,()=>{if(!canNavigate())return;state.tab=id;renderShell();return id==='files'?loadFile():renderDiscussion();},'tab'+(state.tab===id?' active':''));b.append(el('span','count',String(count))); tabs.append(b);
  }
  tabs.append(el('span','progress',`${r.viewed.length} / ${totalFiles()} files viewed`));header.append(tabs);app.append(header);
  if(r.snapshot!==r.snapshots[0].id) {const banner=el('div','banner','You’re viewing an earlier snapshot. Comments stay attached to this version.');banner.append(btn('Open latest',()=>{if(canNavigate())return openReview(r.id);}));app.append(banner);}
  if(state.tab==='files') {
    const workspace=el('div','workspace');workspace.append(el('aside','sidebar'),el('section','main-panel'));app.append(workspace);renderSidebar();
    requestAnimationFrame(()=>{document.documentElement.style.setProperty('--header-height',`${workspace.getBoundingClientRect().top}px`);});
  } else app.append(el('section','discussion'));
}
function renderSidebar() {
  const side=document.querySelector('.sidebar');side.replaceChildren();const search=el('input','search');search.type='search';search.placeholder='Find a file…';search.setAttribute('aria-label','Filter files');search.value=state.query;side.append(search);
  const list=el('div');side.append(list);
  const paint=()=>{list.replaceChildren();for(const r of state.review.repos){const files=r.files.filter(f=>(r.name+'/'+f.path).toLowerCase().includes(state.query.toLowerCase()));if(!files.length)continue;
    const section=el('div','repo'),details=el('details');details.open=true;const heading=el('summary','repo-title',r.name);heading.append(el('small','',String(files.length)));details.append(heading);
    for(const f of files){const active=state.selected && key(r.name,f.path)===key(state.selected.repo,state.selected.path);const b=btn('',async()=>{if(!canNavigate())return;state.selected={repo:r.name,path:f.path};setLocation();renderSidebar();await loadFile();},'file-nav'+(active?' active':'')); b.title=f.path;
      b.append(el('span',`file-status ${f.status}`,f.status));const label=el('span','file-label',f.path.split('/').pop());if(f.path.includes('/'))label.append(el('small','',f.path.slice(0,f.path.lastIndexOf('/'))));b.append(label);
      const count=currentThreads().filter(t=>t.repo===r.name&&t.path===f.path&&t.status==='open').length;if(count)b.append(el('span','file-comment-count',`${count} ◦`));if(viewed(r.name,f.path))b.append(el('span','view-tick','✓'));details.append(b);
    }section.append(details);list.append(section);
  }if(!list.children.length)list.append(el('p','muted','No matching files.'));};search.addEventListener('input',()=>{state.query=search.value;paint();});paint();
}
async function loadFile() {
  const panel=document.querySelector('.main-panel');if(!panel)return;
  const ticket=++state.request;
  if(!state.selected){panel.append(el('div','empty-state','No changed files in this snapshot.'));return;}
  panel.replaceChildren(el('div','loading','Loading diff…'));
  const {repo,path}=state.selected;
  const f=await api(`/api/snapshots/${state.review.snapshot}/file?${new URLSearchParams({repo,path})}`);
  if(ticket!==state.request || state.tab!=='files')return;
  state.file=f;renderFile();
}
function renderFile() {
  const panel=document.querySelector('.main-panel');panel.replaceChildren();const {repo,path}=state.selected,f=state.file;
  const head=el('div','file-header');head.append(el('span',`file-status ${f.status}`,f.status),el('span','file-path',path));
  const stats=el('span','stats');stats.append(el('span','plus',`+${f.added}`),el('span','minus',`−${f.removed}`));head.append(stats);
  const actions=el('div','file-actions');const label=el('label'),checkbox=el('input');checkbox.type='checkbox';checkbox.checked=viewed(repo,path);checkbox.addEventListener('change',async()=>{try{await api(`/api/snapshots/${state.review.snapshot}/viewed`,{repo,path,viewed:checkbox.checked});state.review.viewed=state.review.viewed.filter(v=>v.repo!==repo||v.path!==path);if(checkbox.checked)state.review.viewed.push({repo,path});renderSidebar();document.querySelector('.progress').textContent=`${state.review.viewed.length} / ${totalFiles()} files viewed`;}catch(e){checkbox.checked=!checkbox.checked;toast(e.message);}});label.append(checkbox,document.createTextNode('Viewed'));actions.append(label);
  actions.append(btn('Wrap',()=>document.querySelector('.diff').classList.toggle('nowrap')));head.append(actions);panel.append(head);
  const r=state.review.repos.find(r=>r.name===repo);panel.append(el('div','branch-line',`${r.name}  ·  ${r.branch}  ·  ${r.base.slice(0,8)} → working tree at ${r.head.slice(0,8)}`));
  if(f.status==='R')panel.append(el('div','file-note',`Renamed from ${f.oldPath}`));
  if(f.oldMode!==f.newMode && f.oldMode && f.newMode)panel.append(el('div','file-note',`Mode: ${f.oldMode} → ${f.newMode}`));
  if(f.note)panel.append(el('div','file-note',f.note));
  const sides=f.status==='A'?['new']:f.status==='D'?['old']:['old','new'];
  const scroll=el('div','diff-scroll'),table=el('table','diff'+(sides.length===1?' single':''));table.setAttribute('aria-label',`Diff for ${path}`);const th=el('thead'),tr=el('tr');for(const side of sides)tr.append(el('th','',side==='old'?`Before · ${f.oldPath}`:'After · working tree'));th.append(tr);table.append(th);const tbody=el('tbody');table.append(tbody);scroll.append(table);panel.append(scroll);
  const fileThreads=currentThreads().filter(t=>t.repo===repo && t.path===path);const placed=new Set();
  for(const block of f.blocks){const h=el('tr','hunk');const td=el('td','',`@@ before line ${block.oldStart} · after line ${block.newStart} @@`);td.colSpan=sides.length;h.append(td);tbody.append(h);
    for(const row of block.rows){const tr=el('tr');tbody.append(tr);const rowThreads=[];
      for(const side of sides){const l=row[side];const td=el('td',l?(row.kind==='equal'?'':side==='old'?'removed':'added'):'empty');if(l){const line=el('div','code-line');const number=btn(String(l.number),()=>startComment(tr,side,l.number),'line-number');number.title=`Comment on ${side==='old'?'before':'after'} line ${l.number}`;number.setAttribute('aria-label',number.title);line.append(number,el('code','',l.text||' '));td.append(line);rowThreads.push(...fileThreads.filter(t=>t.side===side && t.line===l.number));}tr.append(td);}
      if(rowThreads.length){const threadRow=el('tr','thread-row'),cell=el('td');cell.colSpan=sides.length;for(const t of rowThreads){placed.add(t.id);cell.append(renderThread(t));}threadRow.append(cell);tbody.append(threadRow);}
    }
  }
  if(!f.blocks.length && !f.note)panel.append(el('div','file-note',f.old===f.new?'No text changes. File added, renamed, or permissions changed.':'Line-ending or final-newline change.'));
  const hidden=fileThreads.filter(t=>!placed.has(t.id));if(hidden.length){const section=el('div','discussion');section.append(el('h2','','Comments outside diff context'));for(const t of hidden){section.append(el('pre','anchor-code',`${t.side}:${t.line}  ${t.code}`),renderThread(t));}panel.append(section);}
}
function composer(onSave,onCancel,label='Add a comment') {
  const box=el('form','composer');box.append(el('label','composer-label',label));const input=el('textarea');input.placeholder='Ask a question or suggest a change…';input.setAttribute('aria-label',label);input.maxLength=20000;input.required=true;box.append(input);
  const error=el('p','draft-error');box.append(error);const actions=el('div','composer-actions');actions.append(el('span','shortcut','Ctrl / ⌘ + Enter to send'));const cancel=btn('Cancel',()=>{state.draft=false;onCancel();});const save=el('button','primary','Post comment');save.type='submit';actions.append(cancel,save);box.append(actions);
  input.addEventListener('input',()=>{state.draft=!!input.value;});
  box.addEventListener('submit',async event=>{event.preventDefault();if(!input.value.trim())return;save.disabled=true;error.textContent='';try{await onSave(input.value.trim());state.draft=false;}catch(e){error.textContent=e.message;save.disabled=false;}});
  input.addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();box.requestSubmit();}});setTimeout(()=>input.focus(),0);return box;
}
function startComment(row,side,line) {
  if(!canNavigate())return;document.querySelectorAll('.new-comment-row,.reply-composer').forEach(n=>n.remove());
  const tr=el('tr','thread-row new-comment-row'),cell=el('td');cell.colSpan=row.children.length;const anchor={snapshot:state.review.snapshot,...state.selected,side,line};
  cell.append(composer(async body=>{await api('/api/threads',{...anchor,author:authorInput.value.trim()||'Reviewer',body});await reloadThreads();toast('Comment saved');},()=>tr.remove(),`Comment on ${side==='old'?'before':'after'} line ${line}`));tr.append(cell);row.after(tr);
}
async function reloadThreads(){const feedback=await api(`/api/reviews/${state.review.id}/feedback`);state.review.threads=feedback.threads;state.draft=false;const scroll=document.querySelector('.main-panel')?.scrollTop;renderShell();if(state.tab==='files'){renderFile();document.querySelector('.main-panel').scrollTop=scroll||0;}else renderDiscussion();}
function renderThread(t){
  const thread=el('article','thread'+(t.status==='resolved'?' resolved':''));thread.dataset.thread=t.id;const top=el('div','thread-top');top.append(el('span','status',t.status==='open'?'Open thread':'Resolved'),el('small','',`${t.side==='old'?'Before':'After'} line ${t.line}`));top.append(btn(t.status==='open'?'Resolve':'Reopen',async()=>{if(!canNavigate())return;await api(`/api/threads/${t.id}`,{status:t.status==='open'?'resolved':'open'},'PATCH');await reloadThreads();}));thread.append(top);
  for(const m of t.messages){const msg=el('div','message'),head=el('div','message-head');head.append(el('span','avatar',m.author.slice(0,2).toUpperCase()),el('strong','',m.author),el('time','',time(m.created)));msg.append(head,el('p','message-body',m.body));thread.append(msg);}
  const reply=btn('Reply…',()=>{if(!canNavigate())return;document.querySelectorAll('.new-comment-row,.reply-composer').forEach(n=>n.remove());const holder=el('div','reply-composer');holder.append(composer(async body=>{await api(`/api/threads/${t.id}/messages`,{author:authorInput.value.trim()||'Reviewer',body});await reloadThreads();toast('Reply saved');},()=>holder.remove(),'Reply to thread'));thread.append(holder);},'thread-reply');thread.append(reply);return thread;
}
function renderDiscussion(){const panel=document.querySelector('.discussion');panel.replaceChildren();const tools=el('div','discussion-tools');tools.append(el('h2','','Review discussion'));const filter=el('select');filter.setAttribute('aria-label','Filter discussion');for(const [value,label] of [['open','Open threads'],['all','All threads'],['resolved','Resolved threads']]){const o=el('option','',label);o.value=value;filter.append(o);}filter.value=state.threadFilter;filter.addEventListener('change',()=>{if(!canNavigate()){filter.value=state.threadFilter;return;}state.threadFilter=filter.value;renderDiscussion();});tools.append(filter);panel.append(tools);
 const list=state.review.threads.filter(t=>state.threadFilter==='all'||t.status===state.threadFilter);
 if(!list.length){const empty=el('div','empty-state');empty.append(el('h2','','No comments here yet'),el('p','','Click a line number in the diff to start a discussion.'));panel.append(empty);}
 for(const t of list){const item=el('div','discussion-item');const index=state.review.snapshots.findIndex(s=>s.id===t.snapshot_id);const label=`${t.repo} / ${t.path} · ${t.side}:${t.line} · Snapshot ${state.review.snapshots.length-index}${t.snapshot_id!==state.review.snapshots[0].id?' (earlier)':''}`;
 item.append(btn(label,async()=>{if(!canNavigate())return;state.tab='files';await openReview(state.review.id,t.snapshot_id,{repo:t.repo,path:t.path});document.querySelector(`[data-thread="${t.id}"]`)?.scrollIntoView({block:'center'});},'anchor-link'),el('pre','anchor-code',t.code),renderThread(t));panel.append(item);}
}
async function home(){const reviews=await api('/api/reviews');const page=el('section','home'),intro=el('div','home-intro'),copy=el('div');copy.append(el('div','eyebrow','Your workspace'),el('h1','','Reviews before pull requests'),el('p','','Inspect the changes. Leave feedback where it matters.'));intro.append(copy,el('span','pill purple',`${reviews.length} reviews`));page.append(intro);
 for(const r of reviews){const link=el('a','review-item');link.href=`/?review=${encodeURIComponent(r.id)}`;link.append(el('h2','',r.title),el('p','',r.description));const meta=el('div','meta-line');meta.append(el('span','',r.id),el('span','',`${r.openThreads} open threads`),el('span','',`Updated ${time(r.updated)}`));link.append(meta);page.append(link);}
 if(!reviews.length){const empty=el('div','empty-state');empty.append(el('h2','','Ready for your first review'),el('p','','Publish a task manifest from the workspace CLI.'),el('code','','python3 review.py publish task.json'));page.append(empty);}app.replaceChildren(page);}
const params=new URLSearchParams(location.search);
(params.has('review')?openReview(params.get('review'),params.get('snapshot'),params.has('repo')&&params.has('file')?{repo:params.get('repo'),path:params.get('file')}:null):home()).catch(error=>{app.replaceChildren(el('div','error',error.message));});
