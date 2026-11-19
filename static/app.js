'use strict';
const app = document.querySelector('#app');
const authorInput = document.querySelector('#author');
authorInput.value = localStorage.getItem('prepr-author') || 'Reviewer';
authorInput.addEventListener('change', () => localStorage.setItem('prepr-author', authorInput.value.trim() || 'Reviewer'));
const state = { review: null, selected: null, tab: 'files', query: '', threadFilter: 'all', hideNoDiff: localStorage.getItem('prepr-hide-nodiff')!=='0', hideTests: localStorage.getItem('prepr-hide-tests')!=='0', sidebarScroll: null, file: null, request: 0, draft: false, view: ['split','unified','raw'].includes(localStorage.getItem('prepr-view')) ? localStorage.getItem('prepr-view') : 'split' };
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
async function api(path, data, method='POST') { const response=await fetch(path, data===undefined ? {} : {method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}); const result=await response.json(); if(!response.ok) throw Error(result.error || 'Request failed'); return result; }
// Earlier threads stay visible on later snapshots unless file deleted.
function fileThreads(repo,path,status) { return state.review.threads.filter(t=>t.repo===repo&&t.path===path&&(t.snapshot_id===state.review.snapshot||(t.snapshot_id<state.review.snapshot&&status!=='D'))); }
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
function canNavigate() { if (!state.draft) return true; if(!confirm('Discard your unsaved comment?')) return false; state.draft=false; return true; }
window.addEventListener('beforeunload', event=>{if(state.draft){event.preventDefault();event.returnValue='';}});
function setLocation() { const url=new URL(location); url.search=''; url.searchParams.set('review',state.review.id); url.searchParams.set('snapshot',state.review.snapshot); if(state.selected) {url.searchParams.set('repo',state.selected.repo);url.searchParams.set('file',state.selected.path);} history.replaceState(null,'',url); }
async function openReview(id, snapshot, selection) {
  state.review=await api(`/api/reviews/${encodeURIComponent(id)}${snapshot?`?snapshot=${snapshot}`:''}`);
  if(selection) state.selected=selection;
  if(!state.selected || !state.review.repos.some(r=>r.name===state.selected.repo && r.files.some(f=>f.path===state.selected.path))) {
    const shown=shownFile,r=state.review.repos.find(r=>r.files.some(shown))||state.review.repos.find(r=>r.files.length);
    state.selected=r?{repo:r.name,path:(r.files.find(shown)||r.files[0]).path}:null;
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
  tools.append(versions,iconBtn('Refresh','refresh',refresh),btn('Keep',()=>PreprLive.decide('keep'),'review-keep'),btn('Ship it',()=>PreprLive.decide('ship'),'primary review-ship'));title.append(tools);header.append(title);
  header.append(el('div','live-review-status'));
  if(globalThis.PreprLive)PreprLive.refresh();
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
    const workspace=el('div','workspace');let width=savedWidth('prepr-sidebar-width',280,180,600);
    workspace.style.setProperty('--sidebar-width',`${Math.min(width,window.innerWidth*.5)}px`);
    const divider=resizeHandle('Resize file list',()=>width,value=>{width=value;workspace.style.setProperty('--sidebar-width',`${value}px`);localStorage.setItem('prepr-sidebar-width',value);},()=>[180,Math.min(600,window.innerWidth*.6)],x=>x-workspace.getBoundingClientRect().left,280);
    divider.classList.add('sidebar-divider');workspace.append(el('aside','sidebar'),divider,el('section','main-panel'));app.append(workspace);renderSidebar();
    requestAnimationFrame(()=>{document.documentElement.style.setProperty('--header-height',`${workspace.getBoundingClientRect().top}px`);});
  } else app.append(el('section','discussion'));
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
  filter('hideTests','prepr-hide-tests','Hide tests','Hide test files and fixtures',all.filter(f=>isTest(f.path)).length);
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
  search.addEventListener('input',()=>{state.query=search.value;paint();});paint();
  side.addEventListener('scroll',()=>{state.sidebarScroll=side.scrollTop;});
  if(state.sidebarScroll!==null)side.scrollTop=state.sidebarScroll;else side.querySelector('.file-nav.active')?.scrollIntoView({block:'nearest'});
}
function isSelected(repo,path) { return !!state.selected&&key(repo,path)===key(state.selected.repo,state.selected.path); }
function fileButton(r,f,nested) {
  const b=btn('',()=>selectFile({repo:r.name,path:f.path}),'file-nav'+(nested?' nested':'')+(isSelected(r.name,f.path)?' active':''));b.title=`${r.name}/${f.path}`;b.dataset.key=key(r.name,f.path);
  b.append(el('span',`file-status ${f.status}`,f.status),el('span','file-label',f.path.split('/').pop()));
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
  const head=el('div','file-header');head.append(el('span',`file-status ${f.status}`,f.status),el('span','file-repo',repo),el('span','file-path',path));
  const stats=el('span','stats');stats.append(el('span','plus',`+${f.added}`),el('span','minus',`−${f.removed}`));head.append(stats);
  const actions=el('div','file-actions');const label=el('label'),checkbox=el('input');checkbox.type='checkbox';checkbox.checked=viewed(repo,path);checkbox.addEventListener('change',async()=>{try{await api(`/api/snapshots/${state.review.snapshot}/viewed`,{repo,path,viewed:checkbox.checked});state.review.viewed=state.review.viewed.filter(v=>v.repo!==repo||v.path!==path);if(checkbox.checked)state.review.viewed.push({repo,path});renderSidebar();document.querySelector('.progress').textContent=`${state.review.viewed.length} / ${totalFiles()} files viewed`;}catch(e){checkbox.checked=!checkbox.checked;toast(e.message);}});label.append(checkbox,document.createTextNode('Viewed'));actions.append(label);
  actions.append(btn('Comment on file',startFileComment,'review-edit'));
  const views=el('div','view-switch');views.setAttribute('role','group');views.setAttribute('aria-label','Code view');
  for(const view of ['split','unified','raw']){const button=iconBtn(view[0].toUpperCase()+view.slice(1),view,()=>{if(!canNavigate())return;state.view=view;localStorage.setItem('prepr-view',view);renderFile();});button.setAttribute('aria-pressed',state.view===view?'true':'false');views.append(button);}
  actions.append(views);head.append(actions);panel.append(head);
  const r=state.review.repos.find(r=>r.name===repo);panel.append(el('div','branch-line',`${r.branch}  ·  ${r.base.slice(0,8)} → working tree at ${r.head.slice(0,8)}`));
  if(f.oldRepo)panel.append(el('div','move-note',`Git comparison: ${f.oldRepo}/${f.oldPath} @ ${f.oldBase.slice(0,8)} → ${repo}/${path}`));
  else if(f.status==='R')panel.append(el('div','file-note',`Renamed from ${f.oldPath}`));
  if(f.movedTo){const note=el('div','move-note',`Moved to ${f.movedTo.repo}/${f.movedTo.path}`);note.append(btn('Review moved file',()=>selectFile(f.movedTo)));panel.append(note);}
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
  const syntaxStatus=el('span','syntax-status');syntaxStatus.setAttribute('role','status');panel.querySelector('.branch-line').append(syntaxStatus);PreprHighlight.apply(table,f,'auto',syntaxStatus);
  const hidden=threads.filter(t=>!placed.has(t.id));if(hidden.length){const section=el('div','discussion');section.append(el('h2','','Comments outside this view'));for(const t of hidden){section.append(el('pre','anchor-code',`${t.side}:${t.line}  ${t.code}`),renderThread(t));}panel.append(section);}
}
function composer(onSave,onCancel,label='Add a comment') {
  const box=el('form','composer');box.append(el('label','composer-label',label));const input=el('textarea');input.placeholder='Ask a question or suggest a change…';input.setAttribute('aria-label',label);input.maxLength=20000;input.required=true;box.append(input);
  const error=el('p','draft-error');box.append(error);const actions=el('div','composer-actions');actions.append(el('span','shortcut','Ctrl / ⌘ + Enter to send'));const cancel=btn('Cancel',()=>{state.draft=false;onCancel();});const save=el('button','primary','Post comment');save.type='submit';actions.append(cancel,save);box.append(actions);
  input.addEventListener('input',()=>{state.draft=!!input.value;});
  box.addEventListener('submit',async event=>{event.preventDefault();if(!input.value.trim())return;save.disabled=true;error.textContent='';try{await onSave(input.value.trim());state.draft=false;}catch(e){error.textContent=e.message;save.disabled=false;}});
  input.addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();box.requestSubmit();}});setTimeout(()=>input.focus(),0);return box;
}
function startFileComment() {
  if(!canNavigate())return;
  document.querySelectorAll('.new-comment-row,.reply-composer').forEach(n=>n.remove());
  const area=document.querySelector('.file-discussion'),holder=el('div','reply-composer');
  const anchor={snapshot:state.review.snapshot,...state.selected,side:'file',line:0};
  holder.append(composer(async body=>{await api('/api/threads',{...anchor,author:authorInput.value.trim()||'Reviewer',body});await reloadThreads();toast('Comment saved');},()=>holder.remove(),'Comment on file'));
  area.prepend(holder);holder.scrollIntoView({block:'center'});
}
function startComment(row,side,line) {
  if(!canNavigate())return;document.querySelectorAll('.new-comment-row,.reply-composer').forEach(n=>n.remove());
  const tr=el('tr','thread-row new-comment-row'),cell=el('td');cell.colSpan=row.children.length;const anchor={snapshot:state.review.snapshot,...state.selected,side,line};
  cell.append(composer(async body=>{await api('/api/threads',{...anchor,author:authorInput.value.trim()||'Reviewer',body});await reloadThreads();toast('Comment saved');},()=>tr.remove(),`Comment on ${side==='old'?'before':'after'} line ${line}`));tr.append(cell);row.after(tr);
}
async function reloadThreads(){const feedback=await api(`/api/reviews/${state.review.id}/feedback`);state.review.threads=feedback.threads;state.draft=false;const scroll=document.querySelector('.main-panel')?.scrollTop;renderShell();if(state.tab==='files'){renderFile();document.querySelector('.main-panel').scrollTop=scroll||0;}else renderDiscussion();}
function renderThread(t){
  const thread=el('article','thread'+(t.status==='resolved'?' resolved':''));thread.dataset.thread=t.id;const top=el('div','thread-top');const anchor=t.origin||t;top.append(el('span','status',t.status==='open'?'Open thread':'Resolved'),el('small','',anchor.side==='file'?'File comment':`${anchor.side==='old'?'Before':'After'} line ${anchor.line}`));
  if(t.carried)top.append(el('small','carried-note',`Snapshot ${snapshotNumber(t.snapshot_id)}${t.changed?' · code changed since':''}`));top.append(btn(t.status==='open'?'Resolve':'Reopen',async()=>{if(!canNavigate())return;await api(`/api/threads/${t.id}`,{status:t.status==='open'?'resolved':'open'},'PATCH');await reloadThreads();},'review-edit'));thread.append(top);if(t.changed&&t.code)thread.append(el('pre','anchor-code',t.code));
  for(const m of t.messages){const msg=el('div','message'),head=el('div','message-head');head.append(el('span','avatar',m.author.slice(0,2).toUpperCase()),el('strong','',m.author),el('time','',time(m.created)),iconBtn('Delete comment','trash',async()=>{if(!canNavigate())return;await api('/api/messages/'+m.id,{},'DELETE');await reloadThreads();toast('Comment deleted');},'delete-comment review-edit'));msg.append(head,el('p','message-body',m.body));thread.append(msg);}
  const reply=btn('Reply…',()=>{if(!canNavigate())return;document.querySelectorAll('.new-comment-row,.reply-composer').forEach(n=>n.remove());const holder=el('div','reply-composer');holder.append(composer(async body=>{await api(`/api/threads/${t.id}/messages`,{author:authorInput.value.trim()||'Reviewer',body});await reloadThreads();toast('Reply saved');},()=>holder.remove(),'Reply to thread'));thread.append(holder);},'thread-reply review-edit');thread.append(reply);return thread;
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
async function home(){const reviews=await api('/api/reviews');const page=el('section','home'),intro=el('div','home-intro'),copy=el('div');copy.append(el('div','eyebrow','Your workspace'),el('h1','','Reviews before pull requests'),el('p','','Inspect the changes. Leave feedback where it matters.'));intro.append(copy,el('span','pill purple',`${reviews.length} reviews`));page.append(intro);
 for(const r of reviews){const link=el('a','review-item');link.href=`/?review=${encodeURIComponent(r.id)}`;link.append(el('h2','',r.title),el('p','',r.description));const meta=el('div','meta-line');meta.append(el('span','',r.id),el('span','',r.decision?'Closed · '+(r.decision.action==='keep'?'kept locally':r.decision.status):`${r.openThreads} open threads`),el('span','',`Updated ${time(r.updated)}`));link.append(meta);page.append(link);}
 if(!reviews.length){const empty=el('div','empty-state');empty.append(el('h2','','Ready for your first review'),el('p','','Publish a task manifest from the workspace CLI.'),el('code','','python3 review.py publish task.json'));page.append(empty);}app.replaceChildren(page);}
const params=new URLSearchParams(location.search);
(params.has('review')?openReview(params.get('review'),params.get('snapshot'),params.has('repo')&&params.has('file')?{repo:params.get('repo'),path:params.get('file')}:null):home()).catch(error=>{app.replaceChildren(el('div','error',error.message));});
