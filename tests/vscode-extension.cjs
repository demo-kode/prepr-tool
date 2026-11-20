// Extension logic with fake vscode API. No VS Code needed.
const assert=require('node:assert/strict'),Module=require('node:module');
const calls={commands:{},external:[],errors:[],panels:[]};let uriHandler,serializer;
const panel=()=>{const p={title:'',revealed:0,disposed:null,receive:null,posted:[],webview:{html:'',options:null,postMessage:m=>p.posted.push(m),onDidReceiveMessage:f=>{p.receive=f;}},reveal(){p.revealed++;},onDidDispose(f){p.disposed=f;}};return p;};
const vscode={
  ViewColumn:{One:1},StatusBarAlignment:{Left:1},
  Uri:{parse:s=>({s,toString:()=>s}),joinPath:(b,...a)=>({s:[b.s,...a].join('/')})},
  env:{uriScheme:'vscode',asExternalUri:async u=>u,openExternal:u=>calls.external.push(u.s)},
  workspace:{getConfiguration:()=>({get:(k,d)=>d})},
  commands:{registerCommand:(id,f)=>{calls.commands[id]=f;return{};}},
  window:{
    registerUriHandler:h=>{uriHandler=h;return{};},registerWebviewPanelSerializer:(id,s)=>{serializer=s;return{};},
    createWebviewPanel:(id,title,col,opts)=>{const p=panel();p.opts=opts;p.title=title;calls.panels.push(p);return p;},
    showErrorMessage:async m=>{calls.errors.push(m);},showInformationMessage:async m=>{(calls.info=calls.info||[]).push(m);},
    createStatusBarItem:(id,align,prio)=>{const i={id,shown:false,show(){i.shown=true;}};calls.status=i;return i;},createOutputChannel:(name,opts)=>({info:m=>calls.log=m}),showQuickPick:async items=>items[0],
  },
};
const {EventEmitter}=require('node:events');calls.spawned=[];
const fakeCp={spawn:(bin,args,opts)=>{const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.kill=()=>{};calls.spawned.push({bin,args,opts,c});return c;}};
const load=Module._load;Module._load=function(req,...a){return req==='vscode'?vscode:req==='child_process'?fakeCp:load.call(this,req,...a);};
let healthy=true,targets={},pending=[],claims={};const posts=[];global.fetch=async(url,init)=>{if(!healthy)throw Error('down');const m=String(url).match(/\/api\/reviews\/([^/]+)\/resume$/);
 if(String(url).endsWith('/api/resume-requests'))return{ok:true,json:async()=>({reviews:pending})};
 if(m&&init?.method==='POST'){const body=JSON.parse(init.body);posts.push({review:m[1],...body});return{ok:true,json:async()=>body.action==='claim'?(claims[m[1]]||{status:'none'}):{status:'failed'}};}
 if(m)return targets[m[1]]?{ok:true,json:async()=>targets[m[1]]}:{ok:false,status:400,json:async()=>({error:'Agent session not recorded'})};
 return{ok:true,json:async()=>[{id:'done',title:'Done',decision:{status:'closed'}},{id:'live',title:'Live',openThreads:2}]};};
const ext=require('../vscode/extension.js');
const fs=require('node:fs'),path=require('node:path'),storage=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'prepr-extension-'));
(async()=>{
  ext.activate({subscriptions:[],extensionUri:{s:'/ext'},globalStorageUri:{fsPath:storage}});
  ext.deactivate(); // Stop background timer; test drives poll() itself.
  assert.deepEqual(Object.keys(calls.commands).sort(),['prepr.open','prepr.openReview']);
  assert.equal(calls.status.shown,true);assert.equal(calls.status.command,'prepr.openReview');assert.match(calls.log,/PrePR activated/);
  await uriHandler.handleUri({query:'review=search-timeout&snapshot=4'});
  const p=calls.panels[0];assert.equal(calls.panels.length,1);assert.equal(p.opts.retainContextWhenHidden,true);assert.equal(p.iconPath.s,'/ext/media/icon.svg');
  assert.match(p.webview.html,/<iframe id="prepr" title="PrePR" src="http:\/\/127\.0\.0\.1:18744\/\?review=search-timeout&amp;snapshot=4"|src="http:\/\/127\.0\.0\.1:18744\/\?review=search-timeout&snapshot=4"/);
  assert.match(p.webview.html,/frame-src http:\/\/127\.0\.0\.1:18744;/);assert.match(p.webview.html,/script-src 'nonce-/);
  await uriHandler.handleUri({query:'review=bad%20id'});assert.equal(calls.panels.length,1);assert.equal(p.posted.length,0);
  assert.equal(p.title,'search-timeout');
  p.receive({type:'prepr:location',title:'Give slow searches time to finish',href:'http://127.0.0.1:18744/?review=search-timeout&snapshot=4'});assert.equal(p.title,'Give slow searches time to finish');
  // Second task: own tab, first stays.
  await calls.commands['prepr.openReview']();assert.equal(calls.panels.length,2,'second review gets own tab');
  const q=calls.panels[1];assert.match(q.webview.html,/review=live"/,'active review first');
  // Reopen first: reveal, no new tab, no navigation.
  await uriHandler.handleUri({query:'review=search-timeout'});assert.equal(calls.panels.length,2);assert.equal(p.revealed,1);assert.equal(p.posted.length,0);
  // Agent opens newer snapshot: same tab navigates.
  await uriHandler.handleUri({query:'review=search-timeout&snapshot=5'});assert.deepEqual(p.posted.at(-1),{type:'navigate',src:'http://127.0.0.1:18744/?review=search-timeout&snapshot=5'});
  // Home tab separate; clicking a review inside it re-keys that tab.
  await calls.commands['prepr.open']();assert.equal(calls.panels.length,3);const h=calls.panels[2];assert.equal(h.title,'PrePR reviews');
  h.receive({type:'prepr:location',title:'Reviews',href:'http://127.0.0.1:18744/?tab=completed'});assert.equal(h.title,'PrePR reviews');
  h.receive({type:'prepr:location',title:'Done',href:'http://127.0.0.1:18744/?review=done'});assert.equal(h.title,'Done');
  await uriHandler.handleUri({query:'review=done'});assert.equal(calls.panels.length,3);assert.equal(h.revealed,1);
  await calls.commands['prepr.open']();assert.equal(calls.panels.length,4,'home key freed after re-key');
  p.receive({type:'prepr:open-external',url:'https://github.com/demo-kode/prepr-tool'});p.receive({type:'prepr:open-external',url:'javascript:alert(1)'});
  assert.deepEqual(calls.external,['https://github.com/demo-kode/prepr-tool']);
  p.disposed();await uriHandler.handleUri({query:'review=search-timeout'});assert.equal(calls.panels.length,5,'closed tab reopens fresh');
  healthy=false;await uriHandler.handleUri({query:'review=other'});
  assert.match(calls.errors[0],/PrePR not reachable at http:\/\/127\.0\.0\.1:18744/);assert.equal(calls.panels.length,5);
  healthy=true;const restored=panel();await serializer.deserializeWebviewPanel(restored,{src:'http://127.0.0.1:18744/?review=restored&snapshot=2'});
  assert.match(restored.webview.html,/review=restored&snapshot=2/);await uriHandler.handleUri({query:'review=restored'});assert.equal(restored.revealed,1,'restored tab keyed');
  const evil=panel();await serializer.deserializeWebviewPanel(evil,{src:'https://evil.example/'});assert.match(evil.webview.html,/src="http:\/\/127\.0\.0\.1:18744\/"/);
  // Resume: Codex in background, same session, task sandbox.
  targets.cx={author:'Codex',agent:'codex',session:'0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',cwd:'/tmp',roots:['/tmp/task','rel'],active:false};
  // Exercise generated iframe bridge, not just host handler.
  const frame={src:'http://127.0.0.1:18744/?review=cx',contentWindow:{},addEventListener(){},focus(){}};
  let frameMessage;
  require('node:vm').runInNewContext(restored.webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1],{
    acquireVsCodeApi:()=>({setState(){},postMessage:m=>restored.receive(m)}),
    document:{getElementById:()=>frame},window:{addEventListener:(name,handler)=>{if(name==='message')frameMessage=handler;}},
  });
  frameMessage({source:{},data:{type:'prepr:resume',review:'cx'}});
  await new Promise(r=>setTimeout(r,10));assert.equal(calls.spawned.length,0,'ignore messages outside review iframe');
  frameMessage({source:frame.contentWindow,data:{type:'prepr:resume',review:'cx'}});await new Promise(r=>setTimeout(r,10));
  assert.equal(calls.spawned.length,1);const sp=calls.spawned[0];
  assert.equal(sp.bin,'codex');assert.deepEqual(sp.args.slice(0,2),['exec','resume']);assert.equal(sp.opts.cwd,'/tmp');
  const roots=JSON.parse(sp.args.find(a=>a.startsWith('sandbox_workspace_write.writable_roots=')).split('=')[1]);
  assert.deepEqual(roots,['/tmp/task',path.join(storage,'cx')]);assert.ok(sp.args.includes('sandbox_workspace_write.network_access=true'));
  assert.equal(sp.args.at(-2),'0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee');assert.match(sp.args.at(-1),/^PrePR review cx: .*watch-start/);
  await uriHandler.handleUri({path:'/resume',query:'review=cx'});assert.equal(calls.spawned.length,1,'no double resume');
  sp.c.emit('exit',0);await uriHandler.handleUri({path:'/resume',query:'review=cx'});assert.equal(calls.spawned.length,2,'resume again after exit');
  // Claude: open same conversation with prompt.
  targets.cl={author:'Claude Code',agent:'claude',session:'7c75ba72-19b6-4e13-a423-e504f6d4798b',cwd:'/tmp',roots:[],active:false};
  await uriHandler.handleUri({path:'/resume',query:'review=cl'});
  const link=calls.external.at(-1);assert.match(link,/^vscode:\/\/anthropic\.claude-code\/open\?session=7c75ba72-19b6-4e13-a423-e504f6d4798b&prompt=PrePR\+review\+cl/);
  targets.on={...targets.cx,active:true};await uriHandler.handleUri({path:'/resume',query:'review=on'});assert.match(calls.info.at(-1),/already watching/);
  await uriHandler.handleUri({path:'/resume',query:'review=none'});assert.match(calls.errors.at(-1),/cannot resume agent: Agent session not recorded/);
  await uriHandler.handleUri({path:'/resume',query:'review=bad%20id'});assert.equal(calls.spawned.length,2);
  // No saved session: new Codex session gets pinned context automatically.
  targets.fresh={...targets.cx,session:'',review:{id:'fresh',title:'Fresh review',repos:[{name:'app',source:'/tmp',branch:'fix/example',base:'a'.repeat(40),include:['a.py']}]}};
  await uriHandler.handleUri({path:'/resume',query:'review=fresh'});
  const fresh=calls.spawned.at(-1);assert.equal(calls.spawned.length,3);assert.equal(fresh.args[0],'exec');assert.equal(fresh.args.includes('resume'),false);
  assert.ok(fresh.args.includes('--json'));assert.match(fresh.args.at(-1),/context.json/);
  const manifest=JSON.parse(fs.readFileSync(path.join(storage,'fresh','review.json'),'utf8'));
  assert.equal(manifest.repos[0].base,'a'.repeat(40));assert.equal(manifest.repos[0].path,'/tmp');assert.deepEqual(manifest.repos[0].include,['a.py']);
  // Missing saved session falls back once; authentication and started runs do not.
  calls.spawned[1].c.stderr.emit('data','No session found with ID example');calls.spawned[1].c.emit('exit',1);
  assert.equal(calls.spawned.length,4);assert.equal(calls.spawned.at(-1).args.includes('resume'),false);
  calls.spawned.at(-1).c.stderr.emit('data','No session found');calls.spawned.at(-1).c.emit('exit',1);assert.equal(calls.spawned.length,4);
  await uriHandler.handleUri({path:'/resume',query:'review=cx'});const auth=calls.spawned.at(-1);auth.c.stderr.emit('data','Authentication failed');auth.c.emit('exit',1);assert.equal(calls.spawned.length,5);
  await uriHandler.handleUri({path:'/resume',query:'review=cx'});const started=calls.spawned.at(-1);started.c.stdout.emit('data','{"type":"thread.started"}\n');started.c.stderr.emit('data','session not found');started.c.emit('exit',1);assert.equal(calls.spawned.length,6);
  // Page click relayed by service: poll claims, launches same way, reports failure to page.
  pending=['relay'];claims.relay={...targets.cx,status:'claimed',request:'r1'};const before=calls.spawned.length;
  assert.equal(await ext.poll(),true);assert.equal(calls.spawned.length,before+1);assert.deepEqual(posts.at(-1),{review:'relay',action:'claim'});
  const relay=calls.spawned.at(-1);assert.deepEqual(relay.args.slice(0,2),['exec','resume']);
  relay.c.stderr.emit('data','Authentication failed');relay.c.emit('exit',1);
  assert.deepEqual(posts.at(-1),{review:'relay',action:'fail',request:'r1',error:'watcher exited with code 1.'});assert.match(calls.errors.at(-1),/watcher exited with code 1/);
  // Clean exit without attaching: page told, no error popup. Attached watcher makes service ignore it.
  const quiet=calls.errors.length;await ext.poll();calls.spawned.at(-1).c.emit('exit',0);
  assert.equal(posts.at(-1).error,'Codex ended without attaching to the review.');assert.equal(calls.errors.length,quiet);
  // Other window claimed first, bad ID, service down: nothing starts.
  pending=['lost','bad id'];const count=calls.spawned.length,claimsSent=posts.length;assert.equal(await ext.poll(),true);
  assert.equal(calls.spawned.length,count);assert.equal(posts.length,claimsSent+1);assert.equal(calls.errors.length,quiet);
  healthy=false;assert.equal(await ext.poll(),false);healthy=true;
  // Launch problem after claim reaches page too.
  pending=['gone'];claims.gone={...targets.cx,cwd:'/no/such/dir',status:'claimed',request:'r2'};await ext.poll();
  assert.deepEqual(posts.at(-1),{review:'gone',action:'fail',request:'r2',error:'review working directory is unavailable.'});
  // Direct host paths (old open tabs) report nothing: no request to answer.
  const direct=posts.length;await uriHandler.handleUri({path:'/resume',query:'review=cx'});calls.spawned.at(-1).c.emit('exit',1);assert.equal(posts.length,direct);
  fs.rmSync(storage,{recursive:true,force:true});
  console.log('PASS: VS Code extension resume (Codex background, Claude conversation, guards), relayed page clicks (claim, failure report), status button, activation log, commands, URI handler, one tab per review, reveal/re-key, snapshot navigation, title, external links, unreachable service, restore.');
})().catch(e=>{console.error(e);process.exit(1)});
