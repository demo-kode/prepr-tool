'use strict';
const app = document.querySelector('#app');
// Reviewer name: asked where a comment is written, not in the top bar.
const author = () => localStorage.getItem('prepr-author') || 'Reviewer';
const decisionTokens = {closed:['closed','Closed'],shipped:['shipped','PR submitted'],blocked:['blocked','Ship blocked'],requested:['pending','Ship requested'],preparing:['pending','Submitting PRs']};
const state = { review: null, selected: null, tab: 'files', query: '', threadFilter: 'all', hideNoDiff: localStorage.getItem('prepr-hide-nodiff')!=='0', hideTests: true, sidebarScroll: null, watcher: null, expanded: new Set(), file: null, request: 0, draft: false, view: ['split','unified','raw'].includes(localStorage.getItem('prepr-view')) ? localStorage.getItem('prepr-view') : 'split' };
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
function btn(text, action, cls='') { const n=el('button',cls,text); n.type='button'; if(cls.split(' ').includes('review-edit'))n.disabled=!!state.review?.decision; n.addEventListener('click', () => Promise.resolve(action()).catch(error => toast(error.message))); return n; }
function iconBtn(label,icon,action,cls='') {
  const button=btn('',action,`icon-button ${cls}`);button.title=label;button.setAttribute('aria-label',label);
  const paths={refresh:'M20 7v5h-5 M20 12a8 8 0 1 0-2 5 M20 7l-3-3',split:'M3 4h18v16H3z M12 4v16',unified:'M3 4h18v16H3z M6 9h12 M6 15h12',raw:'M8 6l-6 6 6 6 M16 6l6 6-6 6 M14 3l-4 18',trash:'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7'};
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
  const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',paths[icon]);svg.append(path);button.append(svg);return button;
}
function savedWidth(key, fallback, min, max) {
  const value=Number(localStorage.getItem(key));return Number.isFinite(value)&&value>=min&&value<=max?value:fallback;
}
function resizeHandle(label, read, write, bounds, fromPointer, reset, step=10) {
  const handle=el('div','resize-handle');handle.tabIndex=0;handle.setAttribute('role','separator');
  handle.setAttribute('aria-label',label);handle.setAttribute('aria-orientation','vertical');handle.title='Drag to resize · double-click to reset';
  const update=value=>{const [min,max]=bounds();const next=Math.min(max,Math.max(min,value));write(next);handle.setAttribute('aria-valuemin',Math.round(min));handle.setAttribute('aria-valuemax',Math.round(max));handle.setAttribute('aria-valuenow',Math.round(next));};
  const finish=()=>{handle.classList.remove('dragging');document.body.classList.remove('resizing');};
  handle.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();handle.setPointerCapture(e.pointerId);handle.classList.add('dragging');document.body.classList.add('resizing');});
  handle.addEventListener('pointermove',e=>{if(handle.hasPointerCapture(e.pointerId))update(fromPointer(e.clientX));});
  handle.addEventListener('pointerup',e=>{if(handle.hasPointerCapture(e.pointerId))handle.releasePointerCapture(e.pointerId);finish();});
  handle.addEventListener('lostpointercapture',finish);handle.addEventListener('pointercancel',finish);
  handle.addEventListener('dblclick',()=>update(reset));
  handle.addEventListener('keydown',e=>{const [min,max]=bounds();if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();update(e.key==='Home'?min:e.key==='End'?max:read()+(e.key==='ArrowLeft'?-step:step));});
  handle.setAttribute('aria-valuemin',Math.round(bounds()[0]));handle.setAttribute('aria-valuemax',Math.round(bounds()[1]));handle.setAttribute('aria-valuenow',Math.round(read()));
  return handle;
}
function time(iso) { return new Date(iso).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }
function toast(text) { const n=document.querySelector('#toast'); n.textContent=text; n.classList.add('visible'); clearTimeout(toast.timer); toast.timer=setTimeout(()=>n.classList.remove('visible'),4500); }
// Embedded in VS Code panel: no native dialogs/popups. Host gets location + external links.
const embedded=(()=>{try{return window.self!==window.top;}catch{return true;}})();
function hostPost(message){if(embedded)window.parent.postMessage(message,'*');}
function ask(message,ok){return new Promise(resolve=>{const d=el('dialog','ask'),actions=el('div','ask-actions'),cancel=el('button','','Cancel'),go=el('button','danger',ok);cancel.type=go.type='button';cancel.onclick=()=>d.close('cancel');go.onclick=()=>d.close('ok');actions.append(cancel,go);d.append(el('p','',message),actions);d.addEventListener('close',()=>{resolve(d.returnValue==='ok');d.remove();});document.body.append(d);d.showModal();cancel.focus();});}
if(embedded)document.addEventListener('click',e=>{const a=e.target.closest?.('a[href]');if(!a)return;const url=new URL(a.href,location.href);if(url.origin===location.origin&&a.target!=='_blank')return;e.preventDefault();if(/^https?:$/.test(url.protocol))hostPost({type:'prepr:open-external',url:url.href});},true);
async function api(path, data, method='POST') { const response=await fetch(path, data===undefined ? {} : {method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}); const result=await response.json(); if(!response.ok) throw Error(result.error || 'Request failed'); return result; }
// Earlier threads stay visible on later snapshots unless file deleted.
function fileThreads(repo,path,status) { return state.review.threads.filter(t=>t.repo===repo&&t.path===path&&(t.snapshot_id===state.review.snapshot||(t.snapshot_id<state.review.snapshot&&status!=='D'))); }
function hideTestsKey(reviewId) { return `prepr-hide-tests:${reviewId}`; }
function snapshotNumber(id) { const i=state.review.snapshots.findIndex(s=>s.id===id);return state.review.snapshots.length-i; }
function splitLines(text) {
  // Match Python splitlines, used by persisted comment anchors.
  const lines=text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);if(lines.at(-1)==='')lines.pop();return lines;
}
// Map earlier anchor onto this snapshot: same line, nearest identical line, else old position.
function carryThread(t,f) {
  if(t.snapshot_id===state.review.snapshot)return t;
  const origin={side:t.side,line:t.line},carried={...t,carried:true,origin};
  if(t.side==='file')return carried;
  if(typeof f[t.side]!=='string')return {...carried,side:'file',line:0,changed:true};
  const lines=splitLines(f[t.side]);let line=lines[t.line-1]===t.code?t.line:0;
  if(!line&&t.code.trim())lines.forEach((text,i)=>{if(text===t.code&&(!line||Math.abs(i+1-t.line)<Math.abs(line-t.line)))line=i+1;});
  return {...carried,line:line||Math.min(Math.max(t.line,1),Math.max(lines.length,1)),changed:!line};
}
function isTest(path) {
  const name=path.split('/').pop();
  return /(^|\/)(tests?|__tests__|specs?|fixtures?|testdata)\//i.test(path)||/^test_|_test\.|\.(test|spec|tftest)\.|[a-z0-9]Tests?\.[a-z0-9]+$/.test(name);
}
function shownFile(f) { return (!state.hideNoDiff||!noDiff(f))&&(!state.hideTests||!isTest(f.path)); }
function noDiff(f) { return !f.added&&!f.removed&&(['R','C'].includes(f.status)||(f.status==='D'&&!!f.movedTo)); }
function key(repo,path) { return `${repo}\0${path}`; }
function viewed(repo,path) { return state.review.viewed.some(v=>v.repo===repo && v.path===path); }
function totalFiles() { return state.review.repos.reduce((n,r)=>n+r.files.length,0); }
function canNavigate() {
  if (!state.draft) return true;
  if(!embedded){if(!confirm('Discard your unsaved comment?')) return false; state.draft=false; return true;}
  // No sync confirm in panel: ask, discard on OK, user repeats action.
  ask('Discard your unsaved comment?','Discard').then(ok=>{if(!ok)return;state.draft=false;document.querySelectorAll('.new-comment-row,.reply-composer').forEach(n=>n.remove());toast('Comment discarded');});
  return false;
}
window.addEventListener('beforeunload', event=>{if(state.draft){event.preventDefault();event.returnValue='';}});
function setLocation() { const url=new URL(location); url.search=''; url.searchParams.set('review',state.review.id); url.searchParams.set('snapshot',state.review.snapshot); if(state.selected) {url.searchParams.set('repo',state.selected.repo);url.searchParams.set('file',state.selected.path);} history.replaceState(null,'',url); hostPost({type:'prepr:location',title:state.review.title,href:url.href}); }
let pendingReview = null;
async function openReview(id, snapshot, selection, stillFollowing) {
  if (stillFollowing && pendingReview) return;
  const request = api(`/api/reviews/${encodeURIComponent(id)}${snapshot?`?snapshot=${snapshot}`:''}`);
  pendingReview = request;
  try {
    const review = await request;
    if (pendingReview !== request || (stillFollowing && !stillFollowing())) return;
    state.hideTests = localStorage.getItem(hideTestsKey(review.id)) !== '0';
    state.review = review;
  } finally {
    if (pendingReview === request) pendingReview = null;
  }
  if(selection) state.selected=selection;
  if(!state.selected || !state.review.repos.some(r=>r.name===state.selected.repo && r.files.some(f=>f.path===state.selected.path))) {
    const shown=shownFile,r=state.review.repos.find(r=>r.files.some(shown))||state.review.repos.find(r=>r.files.length);
    state.selected=r?{repo:r.name,path:(r.files.find(shown)||r.files[0]).path}:null;
  }
  setLocation(); renderShell();
  if (stillFollowing) toast(`Opened updated diff · Snapshot ${snapshotNumber(state.review.snapshot)}`);
  if(state.tab==='files') await loadFile(); else renderOther();
}
async function refresh() { if(!canNavigate())return; await openReview(state.review.id,state.review.snapshot); toast('Comments refreshed'); }
// Top bar: where you are, plus the open review's own controls. Emptied on the list page.
function paintBar(r) {
  const crumb=document.querySelector('.crumb-review'),tools=document.querySelector('#review-tools'),back=document.querySelector('.all-reviews');
  crumb.replaceChildren();tools.replaceChildren();
  // Agent state belongs to a review: nothing to show on the list.
  document.querySelector('#watcher-indicator').hidden=!r;
  if(!r){back.setAttribute('aria-current','page');return;}
  back.removeAttribute('aria-current');
  const title=el('h1','',r.title);title.title=r.title;crumb.append(el('span','crumb-sep','/'),title,el('span','crumb-id',r.id));
  const versions=el('select');versions.setAttribute('aria-label','Review snapshot');
  r.snapshots.forEach((v,i)=>{const o=el('option','',`Snapshot ${r.snapshots.length-i}${i===0?' · latest':''} — ${time(v.created)}`);o.value=v.id;versions.append(o);});versions.value=r.snapshot;
  versions.addEventListener('change',()=>{if(!canNavigate()){versions.value=r.snapshot;return;}openReview(r.id,Number(versions.value)).catch(e=>toast(e.message));});
  tools.append(versions,iconBtn('Refresh','refresh',refresh,'quiet'),btn('Close',()=>PreprLive.decide('close'),'review-close quiet'),btn('Ship it',()=>PreprLive.decide('ship'),'primary review-ship'),el('span','status-token decision-chip'));
  paintDecision(r.decision);
}
// Decided review: its state replaces Close and Ship it. No dead buttons.
function paintDecision(d) {
  for(const button of document.querySelectorAll('.review-ship,.review-close'))button.hidden=!!d;
  for(const button of document.querySelectorAll('.review-edit'))button.disabled=!!d;
  const chip=document.querySelector('.decision-chip');if(!chip)return;chip.hidden=!d;
  // Progress of a pending request lives in the agent indicator; the chip names the decision.
  if(d){const [kind,text]=['requested','preparing'].includes(d.status)?['pending','Ship requested']:decisionTokens[d.status];chip.className='status-token decision-chip '+kind;chip.textContent=text;}
}
function renderShell() {
  const r=state.review; app.replaceChildren();paintBar(r);
  const sub=el('section','review-sub'),tabs=el('nav','tabs');
  const commits=r.repos.reduce((n,repo)=>n+(repo.commits?.length||0),0);
  for(const [id,label,count] of [['files','Files',totalFiles()],['commits','Commits',commits],['discussion','Discussion',r.threads.length]]) {
    const b=btn(label,()=>{if(!canNavigate())return;state.tab=id;renderShell();return id==='files'?loadFile():renderOther();},'tab'+(state.tab===id?' active':''));b.append(el('span','count',String(count))); tabs.append(b);
  }
  sub.append(tabs);
  // One line beside the tabs; click for the whole text.
  if(r.description){const about=btn(r.description,()=>{state.aboutOpen=!state.aboutOpen;about.classList.toggle('open',state.aboutOpen);about.setAttribute('aria-expanded',String(state.aboutOpen));},'description'+(state.aboutOpen?' open':''));about.title='Show or hide the whole description';about.setAttribute('aria-expanded',String(!!state.aboutOpen));sub.append(about);}
  const facts=el('div','facts');
  // Checks recorded as passed on this snapshot: Ship it reuses them.
  if(r.checks){const n=r.checks.split('\n').length,checks=el('details','checks'),summary=el('summary','',`${n} check${n===1?'':'s'} passed`);summary.title='Recorded as passed on this snapshot · Ship it reuses them';checks.append(summary,el('pre','',r.checks));facts.append(checks);}
  const add=r.repos.reduce((n,r)=>n+r.files.reduce((m,f)=>m+f.added,0),0), del=r.repos.reduce((n,r)=>n+r.files.reduce((m,f)=>m+f.removed,0),0),stats=el('span','stats');
  stats.append(el('span','plus',`+${add.toLocaleString()}`),el('span','minus',`−${del.toLocaleString()}`));
  facts.append(el('span','fact-repos',`${r.repos.length} repo${r.repos.length===1?'':'s'}`),stats,el('span','progress',`${r.viewed.length} / ${totalFiles()} files viewed`));sub.append(facts);app.append(sub);
  // Filled only when there is something to say: ship result, start progress, agent away.
  app.append(el('div','live-review-status'));
  if(globalThis.PreprLive)PreprLive.refresh();
  if(r.snapshot!==r.snapshots[0].id) {const banner=el('div','banner','You’re viewing an earlier snapshot. Comments stay attached to this version.');banner.append(btn('Open latest',()=>{if(canNavigate())return openReview(r.id);}));app.append(banner);}
  if(state.tab==='files') {
    const workspace=el('div','workspace');let width=savedWidth('prepr-sidebar-width',280,180,600);
    workspace.style.setProperty('--sidebar-width',`${Math.min(width,window.innerWidth*.5)}px`);
    const divider=resizeHandle('Resize file list',()=>width,value=>{width=value;workspace.style.setProperty('--sidebar-width',`${value}px`);localStorage.setItem('prepr-sidebar-width',value);},()=>[180,Math.min(600,window.innerWidth*.6)],x=>x-workspace.getBoundingClientRect().left,280);
    divider.classList.add('sidebar-divider');workspace.append(el('aside','sidebar'),divider,el('section','main-panel'));app.append(workspace);renderSidebar();
  } else app.append(el('section',state.tab==='commits'?'commits-page':'discussion'));
}
function renderSidebar() {
  const side=document.querySelector('.sidebar');if(!side)return;side.replaceChildren();
  const tools=el('div','sidebar-tools'),search=el('input','search');search.type='search';search.placeholder='Find a file…';search.setAttribute('aria-label','Filter files');search.value=state.query;
  const all=state.review.repos.flatMap(r=>r.files),filter=(stateKey,storage,text,title,count)=>{
    if(!count)return;const label=el('label','sidebar-filter'),box=el('input');box.type='checkbox';box.checked=state[stateKey];
    box.addEventListener('change',()=>{state[stateKey]=box.checked;localStorage.setItem(storage,box.checked?'1':'0');paint();});
    label.title=title;label.append(box,document.createTextNode(`${text} (${count})`));tools.append(label);
  };
  tools.append(search);
  filter('hideNoDiff','prepr-hide-nodiff','Hide unchanged moves','Hide moved or copied files without content changes',all.filter(noDiff).length);
  filter('hideTests',hideTestsKey(state.review.id),'Hide tests','Hide test files and fixtures',all.filter(f=>isTest(f.path)).length);
  side.append(tools);
  const list=el('div','file-tree');side.append(list);
  const paint=()=>{list.replaceChildren();const query=state.query.toLowerCase();
    for(const r of state.review.repos){
      const files=r.files.filter(f=>(r.name+'/'+f.path).toLowerCase().includes(query)&&(shownFile(f)||fileThreads(r.name,f.path,f.status).length||isSelected(r.name,f.path)));if(!files.length)continue;
      const details=el('details','repo');details.open=true;const heading=el('summary','repo-title');heading.append(el('span','repo-name',r.name),el('small','',String(files.length)));details.append(heading);
      const groups=new Map();for(const f of files){const dir=f.path.includes('/')?f.path.slice(0,f.path.lastIndexOf('/')):'';if(!groups.has(dir))groups.set(dir,[]);groups.get(dir).push(f);}
      for(const dir of [...groups.keys()].sort()){
        if(dir){const folder=el('div','folder',dir);folder.title=dir;details.append(folder);}
        for(const f of groups.get(dir))details.append(fileButton(r,f,!!dir));
      }
      list.append(details);
    }
    if(!list.children.length)list.append(el('p','muted','No matching files.'));};
  // Up/Down move selection through visible files; Down from search enters list.
  const step=(from,delta)=>{const items=[...list.querySelectorAll('.file-nav')].filter(n=>n.offsetParent);if(!items.length)return;
    const index=items.indexOf(from),next=items[index<0?(delta>0?0:items.length-1):Math.min(items.length-1,Math.max(0,index+delta))];
    if(next===from)return;next.focus();next.scrollIntoView({block:'nearest'});next.click();};
  // Right/Left mark focused file viewed/unviewed.
  // WASD mirror arrows.
  const keys={ArrowUp:'up',w:'up',ArrowDown:'down',s:'down',ArrowLeft:'left',a:'left',ArrowRight:'right',d:'right'};
  list.addEventListener('keydown',e=>{if(!e.target.matches('.file-nav')||e.ctrlKey||e.metaKey||e.altKey)return;
    const move=keys[e.key.length===1?e.key.toLowerCase():e.key];if(!move)return;e.preventDefault();
    if(move==='up'||move==='down'){step(e.target,move==='down'?1:-1);return;}
    const [repo,path]=e.target.dataset.key.split('\0'),value=move==='right';if(viewed(repo,path)!==value)setViewed(repo,path,value).catch(error=>toast(error.message));});
  search.addEventListener('keydown',e=>{if(e.key!=='ArrowDown')return;e.preventDefault();const active=list.querySelector('.file-nav.active');if(active&&active.offsetParent)active.focus();else step(null,1);});
  search.addEventListener('input',()=>{state.query=search.value;paint();});paint();
  side.addEventListener('scroll',()=>{state.sidebarScroll=side.scrollTop;});
  if(state.sidebarScroll!==null)side.scrollTop=state.sidebarScroll;else side.querySelector('.file-nav.active')?.scrollIntoView({block:'nearest'});
}
// Marks: + added, * changed, +m/*m moved, +c/*c copied (* = edited), removed = struck name.
function statusMark(f) {
  const from=f.oldRepo?`${f.oldRepo}/${f.oldPath}`:f.oldPath,edit=f.added||f.removed?'*':'+',edited=f.added||f.removed?' with changes':'';
  const [mark,label]={A:['+','Added'],D:['',f.movedTo?`Moved to ${f.movedTo.repo}/${f.movedTo.path}`:'Deleted'],R:[edit+'m',`Moved from ${from}${edited}`],C:[edit+'c',`Copied from ${from}${edited}`]}[f.status]||['*','Changed'];
  const node=el('span',`file-status ${f.status}`,mark);node.title=label;node.setAttribute('aria-label',label);return node;
}
// Update viewed in place; keeps list focus and scroll.
async function setViewed(repo,path,value) {
  await api(`/api/snapshots/${state.review.snapshot}/viewed`,{repo,path,viewed:value});
  state.review.viewed=state.review.viewed.filter(v=>v.repo!==repo||v.path!==path);if(value)state.review.viewed.push({repo,path});
  const node=[...document.querySelectorAll('.file-nav')].find(n=>n.dataset.key===key(repo,path));
  if(node){node.querySelector('.view-tick')?.remove();if(value)node.append(el('span','view-tick','✓'));}
  const progress=document.querySelector('.progress');if(progress)progress.textContent=`${state.review.viewed.length} / ${totalFiles()} files viewed`;
  const box=document.querySelector('.viewed-toggle');if(box&&isSelected(repo,path))box.checked=value;
}
function isSelected(repo,path) { return !!state.selected&&key(repo,path)===key(state.selected.repo,state.selected.path); }
function fileButton(r,f,nested) {
  const b=btn('',()=>selectFile({repo:r.name,path:f.path}),'file-nav'+(nested?' nested':'')+(f.status==='D'?' deleted':'')+(isSelected(r.name,f.path)?' active':''));b.title=`${r.name}/${f.path}`;b.dataset.key=key(r.name,f.path);
  b.append(statusMark(f),el('span','file-label',f.path.split('/').pop()));
  const count=fileThreads(r.name,f.path,f.status).filter(t=>t.status==='open').length;if(count)b.append(el('span','file-comment-count',`${count} ◦`));
  if(viewed(r.name,f.path))b.append(el('span','view-tick','✓'));return b;
}
// Swap highlight only; full re-render resets list scroll.
async function selectFile(selection) {
  if(!canNavigate())return;state.selected=selection;setLocation();
  for(const node of document.querySelectorAll('.file-nav'))node.classList.toggle('active',node.dataset.key===key(selection.repo,selection.path));
  await loadFile();
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
  const head=el('div','file-header');head.append(statusMark(f),el('span','file-repo',repo),el('span','file-path',path));
  // Origin inline after path, replaces comparison bar.
  const origin=el('span','file-origin');head.append(origin);
  if(['R','C'].includes(f.status)||f.oldRepo){const from=f.oldRepo?`${f.oldRepo}/${f.oldPath}`:f.oldPath;origin.textContent=`${f.status==='C'?'copied':'moved'} from ${from}`;if(f.oldBase)origin.title=`Compared with ${from} @ ${f.oldBase.slice(0,8)}`;}
  if(f.movedTo){origin.append(document.createTextNode('moved to '),btn(`${f.movedTo.repo}/${f.movedTo.path}`,()=>selectFile(f.movedTo),'origin-link'));}
  const stats=el('span','stats');stats.append(el('span','plus',`+${f.added}`),el('span','minus',`−${f.removed}`));head.append(stats);
  const actions=el('div','file-actions');const label=el('label'),checkbox=el('input','viewed-toggle');checkbox.type='checkbox';checkbox.checked=viewed(repo,path);checkbox.addEventListener('change',()=>setViewed(repo,path,checkbox.checked).catch(e=>{checkbox.checked=!checkbox.checked;toast(e.message);}));label.append(checkbox,document.createTextNode('Viewed'));actions.append(label);
  actions.append(btn('Comment on file',startFileComment,'review-edit'));
  const views=el('div','view-switch');views.setAttribute('role','group');views.setAttribute('aria-label','Code view');
  for(const view of ['split','unified','raw']){const button=iconBtn(view[0].toUpperCase()+view.slice(1),view,()=>{if(!canNavigate())return;state.view=view;localStorage.setItem('prepr-view',view);renderFile();});button.setAttribute('aria-pressed',state.view===view?'true':'false');views.append(button);}
  actions.append(views);head.append(actions);panel.append(head);
  
  panel.append(el('section','file-discussion'));
  if(f.oldMode!==f.newMode && f.oldMode && f.newMode)panel.append(el('div','file-note',`Mode: ${f.oldMode} → ${f.newMode}`));
  if(f.note)panel.append(el('div','file-note',f.note));
  const sides=f.status==='A'?['new']:f.status==='D'?['old']:['old','new'];
  const split=state.view==='split'&&sides.length===2;
  const frame=el('div','diff-frame'),scroll=el('div','diff-scroll'),table=el('table','diff'+(split?' split':' single')+(state.view==='unified'?' unified':state.view==='raw'?' raw':''));
  table.setAttribute('aria-label',`${state.view==='raw'?'Raw file':'Diff'} for ${repo}/${path}`);
  const columns=el('colgroup');for(let i=0;i<(split?2:1);i++)columns.append(el('col'));table.append(columns);
  let ratio=savedWidth('prepr-split-ratio',50,20,80);frame.style.setProperty('--split-ratio',`${ratio}%`);
  let rawSide=f.rawSide|| (f.status==='D'?'old':'new');
  if(!sides.includes(rawSide))rawSide=sides[0];
  if(state.view==='raw'){
      const thead=el('thead'),heading=el('tr'),cell=el('th');
      const select=el('select','raw-side');select.setAttribute('aria-label','Raw version');
      for(const side of sides){const option=el('option','',side==='old'?'Before':'After');option.value=side;select.append(option);}select.value=rawSide;
      select.addEventListener('change',()=>{if(!canNavigate()){select.value=rawSide;return;}f.rawSide=select.value;renderFile();});
      cell.append(select,el('span','',` ${rawSide==='old'?(f.oldRepo||repo)+'/'+f.oldPath:repo+'/'+path}`));
      heading.append(cell);thead.append(heading);table.append(thead);
  }
  const tbody=el('tbody');table.append(tbody);scroll.append(table);frame.append(scroll);panel.append(frame);
  if(split){const divider=resizeHandle('Resize diff columns',()=>ratio,value=>{ratio=value;frame.style.setProperty('--split-ratio',`${value}%`);localStorage.setItem('prepr-split-ratio',value);},()=>[20,80],x=>(x-frame.getBoundingClientRect().left)/frame.getBoundingClientRect().width*100,50,2);divider.classList.add('diff-divider');frame.append(divider);}
  const threads=fileThreads(repo,path,f.status).map(t=>carryThread(t,f)),placed=new Set();
  for(const thread of threads.filter(t=>t.side==='file')){placed.add(thread.id);panel.querySelector('.file-discussion').append(renderThread(thread));}
  const appendThreads=(row,anchors)=>{
    const matching=threads.filter(t=>!placed.has(t.id)&&anchors.some(a=>t.side===a.side&&t.line===a.line));
    if(!matching.length)return;
    const tr=el('tr','thread-row'),cell=el('td');cell.colSpan=split?2:1;
    for(const thread of matching){placed.add(thread.id);cell.append(renderThread(thread));}tr.append(cell);row.after(tr);
  };
  const numberButton=(row,side,number)=>{
    const button=btn(String(number),()=>startComment(row,side,number),'line-number review-edit');button.title=`Comment on ${side==='old'?'before':'after'} line ${number}`;button.setAttribute('aria-label',button.title);return button;
  };
  const codeNode=(side,line)=>{const code=el('code','',line.text||' ');code.dataset.side=side;code.dataset.line=line.number;code.dataset.source=line.text||'';return code;};
  const appendSingle=(side,line,kind,other)=>{
    const row=el('tr'),cell=el('td',kind),codeLine=el('div','code-line'),anchors=[{side,line:line.number}];row.append(cell);tbody.append(row);
    if(state.view==='unified'){
      for(const column of ['old','new']){const value=column===side?line:other;if(value){codeLine.append(numberButton(row,column,value.number));anchors.push({side:column,line:value.number});}else codeLine.append(el('span','line-number placeholder'));}
      codeLine.append(el('span','diff-sign',kind==='removed'?'−':kind==='added'?'+':' '));
    }else codeLine.append(numberButton(row,side,line.number));
    codeLine.append(codeNode(side,line));cell.append(codeLine);appendThreads(row,anchors);
  };
  if(state.view==='raw'){
    const text=f[rawSide];
    if(typeof text==='string'){
      const lines=splitLines(text);
      const limit=f.rawLimit||2000;lines.slice(0,limit).forEach((text,index)=>appendSingle(rawSide,{number:index+1,text},''));
      if(lines.length>limit)panel.append(btn(`Show next ${Math.min(2000,lines.length-limit).toLocaleString()} lines (${limit.toLocaleString()} / ${lines.length.toLocaleString()})`,()=>{if(!canNavigate())return;const top=panel.scrollTop;f.rawLimit=limit+2000;renderFile();panel.scrollTop=top;},'raw-more'));
    }
  }else for(const block of f.blocks){
    const hunk=el('tr','hunk'),cell=el('td','',`@@ before line ${block.oldStart} · after line ${block.newStart} @@`);cell.colSpan=split?2:1;hunk.append(cell);tbody.append(hunk);
    if(state.view==='unified'){
      // Keep each deletion run before its corresponding additions.
      let changed=[];
      const flush=()=>{for(const side of ['old','new'])for(const row of changed)if(row[side])appendSingle(side,row[side],side==='old'?'removed':'added');changed=[];};
      for(const row of block.rows){if(row.kind==='equal'){flush();appendSingle('new',row.new,'',row.old);}else changed.push(row);}flush();
    }else for(const data of block.rows){
      if(!split){const side=sides[0];if(data[side])appendSingle(side,data[side],data.kind==='equal'?'':side==='old'?'removed':'added');continue;}
      const row=el('tr'),anchors=[];tbody.append(row);
      for(const side of sides){const line=data[side],cell=el('td',line?(data.kind==='equal'?'':side==='old'?'removed':'added'):'empty');if(line){const codeLine=el('div','code-line');codeLine.append(numberButton(row,side,line.number),codeNode(side,line));cell.append(codeLine);anchors.push({side,line:line.number});}row.append(cell);}appendThreads(row,anchors);
    }
  }
  if(state.view!=='raw' && !f.blocks.length && !f.note)panel.append(el('div','file-note',f.movedTo?'Review the destination comparison for content changes.':f.old===f.new?'No text changes. File moved or permissions changed.':'Line-ending or final-newline change.'));
  const syntaxStatus=el('span','syntax-status');syntaxStatus.setAttribute('role','status');syntaxStatus.classList.add('sr-only');head.append(syntaxStatus);PreprHighlight.apply(table,f,'auto',syntaxStatus);
  const hidden=threads.filter(t=>!placed.has(t.id));if(hidden.length){const section=el('div','discussion');section.append(el('h2','','Comments outside this view'));for(const t of hidden){section.append(el('pre','anchor-code',`${t.side}:${t.line}  ${t.code}`),renderThread(t));}panel.append(section);}
}
function composer(onSave,onCancel,label='Add a comment') {
  const box=el('form','composer');box.append(el('label','composer-label',label));const input=el('textarea');input.placeholder='Ask a question or suggest a change…';input.setAttribute('aria-label',label);input.maxLength=20000;input.required=true;box.append(input);
  const error=el('p','draft-error');box.append(error);const actions=el('div','composer-actions');
  const who=el('label','composer-author','Comment as'),name=el('input');name.id='author';name.maxLength=100;name.value=author();name.setAttribute('aria-label','Comment author');who.append(name);
  const keep=()=>{localStorage.setItem('prepr-author',name.value.trim()||'Reviewer');name.value=author();};name.addEventListener('change',keep);
  actions.append(who,el('span','shortcut','Ctrl / ⌘ + Enter to send'));const cancel=btn('Cancel',()=>{state.draft=false;onCancel();});const save=el('button','primary','Post comment');save.type='submit';actions.append(cancel,save);box.append(actions);
  input.addEventListener('input',()=>{state.draft=!!input.value;});
  box.addEventListener('submit',async event=>{event.preventDefault();if(!input.value.trim())return;keep();save.disabled=true;error.textContent='';try{await onSave(input.value.trim());state.draft=false;}catch(e){error.textContent=e.message;save.disabled=false;}});
  input.addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();box.requestSubmit();}});setTimeout(()=>input.focus(),0);return box;
}
function startFileComment() {
  if(!canNavigate())return;
  document.querySelectorAll('.new-comment-row,.reply-composer').forEach(n=>n.remove());
  const area=document.querySelector('.file-discussion'),holder=el('div','reply-composer');
  const anchor={snapshot:state.review.snapshot,...state.selected,side:'file',line:0};
  holder.append(composer(async body=>{await api('/api/threads',{...anchor,author:author(),body});await reloadThreads();toast('Comment saved');},()=>holder.remove(),'Comment on file'));
  area.prepend(holder);holder.scrollIntoView({block:'center'});
}
function startComment(row,side,line) {
  if(!canNavigate())return;document.querySelectorAll('.new-comment-row,.reply-composer').forEach(n=>n.remove());
  const tr=el('tr','thread-row new-comment-row'),cell=el('td');cell.colSpan=row.children.length;const anchor={snapshot:state.review.snapshot,...state.selected,side,line};
  cell.append(composer(async body=>{await api('/api/threads',{...anchor,author:author(),body});await reloadThreads();toast('Comment saved');},()=>tr.remove(),`Comment on ${side==='old'?'before':'after'} line ${line}`));tr.append(cell);row.after(tr);
}
async function reloadThreads(){const feedback=await api(`/api/reviews/${state.review.id}/feedback`);state.review.threads=feedback.threads;state.draft=false;const scroll=document.querySelector('.main-panel')?.scrollTop;renderShell();if(state.tab==='files'){renderFile();document.querySelector('.main-panel').scrollTop=scroll||0;}else renderOther();}
// Thread turn: agent busy, waiting on you, or waiting on agent.
function threadActivity(t){
  if(t.status!=='open'||!t.messages.length)return null;const w=state.watcher,last=t.messages.at(-1).author;
  if(w&&w.activity!=='idle'&&w.threads.includes(t.id))return ['working',`${w.author} ${w.activity==='code'?'is changing code…':'is writing a reply…'}`];
  if(w)return last===w.author?['waiting-you','Waiting for your reply']:['waiting-agent',`Waiting for ${w.author}`];
  return last!==(author())?['waiting-you','Waiting for your reply']:null;
}
// Update badges in place; keeps drafts.
function paintActivity(){
  for(const node of document.querySelectorAll('.thread[data-thread]')){
    const t=state.review?.threads.find(x=>x.id===node.dataset.thread),badge=node.querySelector('.thread-activity');if(!t||!badge)continue;
    const [kind,text]=threadActivity(t)||['',''];badge.className='thread-activity '+kind;badge.textContent=text;
  }
}
function renderThread(t){
  const open=t.status==='open',thread=el('article','thread'+(open?'':' resolved'));thread.dataset.thread=t.id;const top=el('div','thread-top'),anchor=t.origin||t;
  const activity=threadActivity(t)||['',''],badge=el('span','thread-activity '+activity[0],activity[1]);
  const decide=btn(open?'Resolve':'Reopen',async()=>{if(!canNavigate())return;await api(`/api/threads/${t.id}`,{status:open?'resolved':'open'},'PATCH');await reloadThreads();},'review-edit');
  if(!open)top.append(el('span','status','Resolved'));
  // Thread sits under its line: anchor only where that says something more.
  if(t.carried||anchor.side==='file')top.append(el('small','',anchor.side==='file'?'File comment':`${anchor.side==='old'?'Before':'After'} line ${anchor.line}`));
  if(t.carried)top.append(el('small','carried-note',`Snapshot ${snapshotNumber(t.snapshot_id)}${t.changed?' · code changed since':''}`));// Resolved threads start collapsed; toggle keeps state across re-renders.
  if(!open){
    const collapsed=!state.expanded.has(t.id);thread.classList.toggle('collapsed',collapsed);
    top.append(el('span','thread-snippet',t.messages[0].body.split('\n')[0]));
    const toggle=btn('',()=>{const now=!thread.classList.toggle('collapsed');if(now)state.expanded.add(t.id);else state.expanded.delete(t.id);toggle.textContent=now?'Hide':`Show ${t.messages.length}`;toggle.setAttribute('aria-expanded',String(now));},'thread-toggle');
    toggle.textContent=collapsed?`Show ${t.messages.length}`:'Hide';toggle.setAttribute('aria-expanded',String(!collapsed));toggle.title='Show or hide resolved discussion';top.append(toggle,decide);
  }
  if(top.children.length)thread.append(top);if(t.changed&&t.code)thread.append(el('pre','anchor-code',t.code));
  for(const m of t.messages){const msg=el('div','message'),head=el('div','message-head');head.append(el('strong','',m.author),el('time','',time(m.created)),iconBtn('Delete comment','trash',async()=>{if(!canNavigate())return;await api('/api/messages/'+m.id,{},'DELETE');await reloadThreads();toast('Comment deleted');},'delete-comment review-edit quiet'));msg.append(head,el('p','message-body',m.body));thread.append(msg);}
  const reply=btn('Reply…',()=>{if(!canNavigate())return;document.querySelectorAll('.new-comment-row,.reply-composer').forEach(n=>n.remove());const holder=el('div','reply-composer');holder.append(composer(async body=>{await api(`/api/threads/${t.id}/messages`,{author:author(),body});await reloadThreads();toast('Reply saved');},()=>holder.remove(),'Reply to thread'));thread.append(holder);},'thread-reply review-edit');
  // Foot: reply, whose turn, resolve. One row.
  const foot=el('div','thread-foot');foot.append(reply);if(open)foot.append(badge,decide);thread.append(foot);return thread;
}
function renderOther(){return state.tab==='commits'?renderCommits():renderDiscussion();}
function statSpan(added,removed){const n=el('span','stats');n.append(el('span','plus',`+${added}`),el('span','minus',`−${removed}`));return n;}
function openFromCommit(repo,path){if(!canNavigate())return;state.tab='files';state.selected={repo,path};state.sidebarScroll=null;setLocation();renderShell();return loadFile();}
// Commits per repo, base..HEAD, captured at publish.
function renderCommits(){
  const panel=document.querySelector('.commits-page');panel.replaceChildren();
  for(const r of state.review.repos){
    const section=el('section','commit-repo'),head=el('div','commit-repo-head');
    head.append(el('h2','',r.name),el('span','muted',r.base===r.head?`${r.branch} · ${r.head.slice(0,8)} + uncommitted changes`:`${r.branch} · ${r.base.slice(0,8)} → ${r.head.slice(0,8)}`));section.append(head);
    // Same base/head: nothing committed, regardless of capture.
    if(r.base===r.head||r.commits?.length===0){section.append(el('p','muted','No commits yet — all changes in this repository are uncommitted.'));panel.append(section);continue;}
    if(!r.commits){section.append(el('p','muted','Commit list not recorded: this snapshot predates the Commits tab. The next publish will include it.'));panel.append(section);continue;}
    for(const c of r.commits){
      const item=el('details','commit'),summary=el('summary');
      summary.append(el('code','commit-sha',c.sha.slice(0,8)),el('span','commit-subject',c.subject),el('span','muted commit-meta',`${c.author} · ${time(c.date)}`),statSpan(c.files.reduce((n,f)=>n+f.added,0),c.files.reduce((n,f)=>n+f.removed,0)));
      const body=el('div','commit-body');if(c.body)body.append(el('p','commit-message',c.body));
      body.append(el('div','muted commit-full',`${c.sha}${c.merge?' · merge, first-parent diff':''}`));
      for(const f of c.files){
        const inReview=r.files.some(x=>x.path===f.path),row=btn('',()=>openFromCommit(r.name,f.path),'commit-file'+(f.status==='D'?' deleted':''));
        row.disabled=!inReview;row.title=inReview?`Open ${f.path} in Files`:'Not in this review snapshot';
        row.append(statusMark(f),el('span','file-label',f.oldPath&&f.oldPath!==f.path?`${f.oldPath} → ${f.path}`:f.path),statSpan(f.added,f.removed));body.append(row);
      }
      if(c.hiddenFiles)body.append(el('p','muted commit-hidden',`${c.hiddenFiles} file${c.hiddenFiles>1?'s':''} outside review scope`));
      item.append(summary,body);section.append(item);
    }
    if(r.commitsTruncated)section.append(el('p','muted','Showing latest 200 commits.'));
    panel.append(section);
  }
}
function renderDiscussion(){const panel=document.querySelector('.discussion');panel.replaceChildren();const tools=el('div','discussion-tools');tools.append(el('h2','','Review discussion'));const filter=el('select');filter.setAttribute('aria-label','Filter discussion');for(const [value,label] of [['open','Open threads'],['all','All threads'],['resolved','Resolved threads']]){const o=el('option','',label);o.value=value;filter.append(o);}filter.value=state.threadFilter;filter.addEventListener('change',()=>{if(!canNavigate()){filter.value=state.threadFilter;return;}state.threadFilter=filter.value;renderDiscussion();});tools.append(filter);panel.append(tools);
 const list=state.review.threads.filter(t=>state.threadFilter==='all'||t.status===state.threadFilter);
 if(!list.length){const empty=el('div','empty-state');empty.append(el('h2','','No comments here yet'),el('p','','Click a line number in the diff to start a discussion.'));panel.append(empty);}
 for(const t of list){const item=el('div','discussion-item');const index=state.review.snapshots.findIndex(s=>s.id===t.snapshot_id);const label=`${t.repo} / ${t.path} · ${t.side}:${t.line} · Snapshot ${state.review.snapshots.length-index}${t.snapshot_id!==state.review.snapshots[0].id?' (earlier)':''}`;
 item.append(btn(label,async()=>{if(!canNavigate())return;state.tab='files';const selection={repo:t.repo,path:t.path};
  // Latest first; fall back to original snapshot when file gone.
  await openReview(state.review.id,null,selection);let node=document.querySelector(`[data-thread="${t.id}"]`);
  if(!node){await openReview(state.review.id,t.snapshot_id,selection);node=document.querySelector(`[data-thread="${t.id}"]`);}node?.scrollIntoView({block:'center'});},'anchor-link'),el('pre','anchor-code',t.side==='file'?'Comment on file':t.code),renderThread(t));panel.append(item);}
}
// Home: Active vs Completed (closed, shipped, blocked).
const completed=r=>['closed','shipped','blocked'].includes(r.decision?.status);
async function home(tab){
  if(tab)state.homeTab=tab;state.homeTab=state.homeTab||(new URLSearchParams(location.search).get('tab')==='completed'?'completed':'active');
  const reviews=await api('/api/reviews'),done=reviews.filter(completed),active=reviews.filter(r=>!completed(r));
  state.review=null;paintBar(null);
  const page=el('section','home');page.append(el('h1','sr-only','Reviews'));
  const tabs=el('nav','tabs home-tabs');
  for(const [id,label,list] of [['active','Active',active],['completed','Completed',done]]){
    const b=btn(label,()=>{const url=new URL(location);url.search=id==='completed'?'?tab=completed':'';history.replaceState(null,'',url);return home(id);},'tab'+(state.homeTab===id?' active':''));b.append(el('span','count',String(list.length)));tabs.append(b);
  }
  page.append(tabs);
  const list=state.homeTab==='completed'?done:active;
  for(const r of list){
    // Row: what it is on the left, where it stands on the right.
    const item=el('div','review-item'),link=el('a','review-link'),what=el('div','review-what'),where=el('div','review-where'),d=r.decision;link.href=`/?review=${encodeURIComponent(r.id)}`;
    what.append(el('h2','',r.title),el('p','',r.description));
    if(d){const [cls,text]=decisionTokens[d.status];where.append(el('span','status-token '+cls,text));}
    else if(r.openThreads)where.append(el('span','status-token open',`${r.openThreads} open thread${r.openThreads===1?'':'s'}`));
    const meta=el('div','meta-line');meta.append(el('span','',r.id),el('span','',`Updated ${time(r.updated)}`));where.append(meta);link.append(what,where);item.append(link);
    if(completed(r))item.append(iconBtn('Delete review','trash',async()=>{if(!await ask(`Delete “${r.title}” with its snapshots and comments? This cannot be undone.`,'Delete'))return;await api('/api/reviews/'+encodeURIComponent(r.id),{},'DELETE');toast('Review deleted');await home();},'delete-review quiet'));
    page.append(item);
  }
  if(!list.length){const empty=el('div','empty-state');
    if(state.homeTab==='completed')empty.append(el('h2','','No completed reviews'),el('p','','Reviews you Close or Ship appear here.'));
    else empty.append(el('h2','','Ready for your first review'),el('p','','Your agent publishes one through the prepr-review skill.'),el('code','','python3 review.py publish task.json'));
    page.append(empty);}
  app.replaceChildren(page);hostPost({type:'prepr:location',title:'Reviews',href:location.href});
}
const params=new URLSearchParams(location.search);
(params.has('review')?openReview(params.get('review'),params.get('snapshot'),params.has('repo')&&params.has('file')?{repo:params.get('repo'),path:params.get('file')}:null):home()).catch(error=>{app.replaceChildren(el('div','error',error.message));});
