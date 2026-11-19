// Extension logic with fake vscode API. No VS Code needed.
const assert=require('node:assert/strict'),Module=require('node:module');
const calls={commands:{},external:[],errors:[],panels:[]};let uriHandler,serializer;
const panel=()=>{const p={title:'',revealed:0,disposed:null,receive:null,posted:[],webview:{html:'',options:null,postMessage:m=>p.posted.push(m),onDidReceiveMessage:f=>{p.receive=f;}},reveal(){p.revealed++;},onDidDispose(f){p.disposed=f;}};return p;};
const vscode={
  ViewColumn:{One:1},StatusBarAlignment:{Left:1},
  Uri:{parse:s=>({s,toString:()=>s}),joinPath:(b,...a)=>({s:[b.s,...a].join('/')})},
  env:{asExternalUri:async u=>u,openExternal:u=>calls.external.push(u.s)},
  workspace:{getConfiguration:()=>({get:(k,d)=>d})},
  commands:{registerCommand:(id,f)=>{calls.commands[id]=f;return{};}},
  window:{
    registerUriHandler:h=>{uriHandler=h;return{};},registerWebviewPanelSerializer:(id,s)=>{serializer=s;return{};},
    createWebviewPanel:(id,title,col,opts)=>{const p=panel();p.opts=opts;p.title=title;calls.panels.push(p);return p;},
    showErrorMessage:async m=>{calls.errors.push(m);},
    createStatusBarItem:(id,align,prio)=>{const i={id,shown:false,show(){i.shown=true;}};calls.status=i;return i;},createOutputChannel:(name,opts)=>({info:m=>calls.log=m}),showQuickPick:async items=>items[0],
  },
};
const load=Module._load;Module._load=function(req,...a){return req==='vscode'?vscode:load.call(this,req,...a);};
let healthy=true;global.fetch=async url=>{if(!healthy)throw Error('down');return{ok:true,json:async()=>[{id:'done',title:'Done',decision:{status:'closed'}},{id:'live',title:'Live',openThreads:2}]};};
const ext=require('../vscode/extension.js');
(async()=>{
  ext.activate({subscriptions:[],extensionUri:{s:'/ext'}});
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
  console.log('PASS: VS Code extension status button, activation log, commands, URI handler, one tab per review, reveal/re-key, snapshot navigation, title, external links, unreachable service, restore.');
})().catch(e=>{console.error(e);process.exit(1)});
