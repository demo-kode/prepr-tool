// Embedded like VS Code webview: sandbox without modals/popups. Disposable server only.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const url=process.env.PREPR_TEST_URL||'http://127.0.0.1:18745';
const post=async(path,data)=>{const r=await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});assert.equal(r.status,200,await r.clone().text());return r.json();};
(async()=>{const browser=await chromium.launch({headless:true});try{
 const page=await browser.newPage({viewport:{width:1300,height:900}}),errors=[],popups=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('popup',p=>popups.push(p.url()));
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 const id='embed-'+Date.now();
 await post('/api/reviews',{id,title:'Embedded review',repos:[{name:'app',source:'/demo',branch:'main',base:'a'.repeat(40),head:'b'.repeat(40),files:[{path:'demo.py',oldPath:'demo.py',status:'M',old:'before\n',new:'after\n',added:1,removed:1}]}]});
 // Host on server origin: frame-ancestors allows self + VS Code schemes only.
 await page.route(url+'/__host',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><body style="margin:0"><iframe id="f" sandbox="allow-scripts allow-same-origin allow-forms" style="border:0;width:100vw;height:100vh" src="${url}/?review=${id}"></iframe><script>window.msgs=[];addEventListener('message',e=>{if(e.source===document.getElementById('f').contentWindow)msgs.push(e.data)});</script>`}));
 await page.goto(url+'/__host');
 const f=page.frameLocator('#f');
 await f.getByRole('button',{name:'Comment on after line 1',exact:true}).waitFor();
 // Click waits in service for a VS Code host; no host message, no vscode:// link.
 await f.getByRole('button',{name:'Start watching',exact:true}).click();
 await f.getByText('Starting watcher · waiting for VS Code…',{exact:true}).waitFor();
 assert.equal(await f.getByRole('button',{name:'Start watching'}).count(),0,'no double click');
 assert.ok((await (await fetch(url+'/api/resume-requests')).json()).reviews.includes(id));
 assert.equal((await post('/api/reviews/'+id+'/resume',{action:'claim'})).status,'claimed');
 await f.getByText('Starting Codex…',{exact:true}).waitFor();assert.equal(await f.getByRole('button',{name:'Start watching'}).count(),0);
 assert.equal(await page.evaluate(()=>msgs.some(m=>m.type==='prepr:resume')),false);
 await page.waitForFunction(()=>msgs.some(m=>m.type==='prepr:location'&&m.title==='Embedded review'));
 await f.getByRole('link',{name:'PrePR on GitHub'}).click();
 await page.waitForFunction(()=>msgs.some(m=>m.type==='prepr:open-external'&&m.url==='https://github.com/demo-kode/prepr-tool'));
 assert.deepEqual(popups,[]);
 await f.getByRole('button',{name:'Comment on after line 1',exact:true}).click();
 await f.getByRole('textbox',{name:'Comment on after line 1'}).fill('draft text');
 await f.getByRole('button',{name:/^Discussion/}).click();
 const dialog=f.getByRole('dialog');await dialog.getByText('Discard your unsaved comment?').waitFor();
 await dialog.getByRole('button',{name:'Cancel'}).click();
 assert.equal(await f.getByRole('textbox',{name:'Comment on after line 1'}).inputValue(),'draft text');
 await f.getByRole('button',{name:/^Discussion/}).click();await dialog.getByRole('button',{name:'Discard'}).click();
 await f.getByText('Comment discarded',{exact:true}).waitFor();assert.equal(await f.getByRole('textbox',{name:'Comment on after line 1'}).count(),0);
 await f.getByRole('button',{name:/^Discussion/}).click();await f.getByRole('heading',{name:'Review discussion'}).waitFor();
 // Agent away + comment waiting: banner offers Resume, posts to host.
 await post('/api/reviews/'+id+'/watch',{action:'start',token:'b'.repeat(32),author:'Codex',agent:'codex',session:'0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',cwd:'/tmp',roots:['/tmp']});
 await f.getByText('Codex · working session watching',{exact:true}).waitFor();assert.equal(await f.getByRole('button',{name:'Start watching'}).count(),0);
 await post('/api/reviews/'+id+'/watch',{action:'stop'});
 const snap=(await (await fetch(url+'/api/reviews/'+id)).json()).snapshot;
 await post('/api/threads',{snapshot:snap,repo:'app',path:'demo.py',side:'new',line:1,author:'Reviewer',body:'Still there?'});
 await f.getByText("Codex isn't watching · 1 comment waiting",{exact:true}).waitFor();
 await f.getByRole('button',{name:'Start watching'}).click({timeout:20000});
 await f.getByText('Starting watcher · waiting for VS Code…',{exact:true}).waitFor();
 // Host failure shown beside a retry button.
 const claim=await post('/api/reviews/'+id+'/resume',{action:'claim'});assert.equal(claim.session,'0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
 await post('/api/reviews/'+id+'/resume',{action:'fail',request:claim.request,error:'watcher exited with code 1.'});
 await f.getByText('Watcher did not start · watcher exited with code 1.',{exact:true}).waitFor();
 assert.equal(await f.getByRole('button',{name:'Start watching'}).isEnabled(),true,'retry offered');
 assert.equal((await (await fetch(url+'/api/reviews/'+id+'/watch')).text()).includes('0199aaaa'),false,'session hidden from page');
 await post('/api/reviews/'+id+'/decision',{action:'close'});
 await page.evaluate(src=>{document.getElementById('f').src=src;},url+'/?tab=completed');
 await page.waitForFunction(()=>msgs.some(m=>m.type==='prepr:location'&&m.title==='Reviews'));
 const item=f.locator('.review-item',{has:f.getByText(id,{exact:true})});
 await item.getByRole('button',{name:'Delete review'}).click();await dialog.getByRole('button',{name:'Delete',exact:true}).click();
 await f.getByText('Review deleted',{exact:true}).waitFor();assert.equal((await fetch(url+'/api/reviews/'+id)).status,404);
 await page.route('http://host.test/**',route=>route.fulfill({contentType:'text/html',body:`<iframe id="g" src="${url}/"></iframe>`}));
 await page.goto('http://host.test/');await page.waitForTimeout(1500);
 assert.equal(await page.frames()[1].evaluate(()=>document.querySelector('#app')).catch(()=>null),null,'foreign site cannot frame PrePR');
 errors.splice(0,errors.length,...errors.filter(e=>!/frame-ancestors|Refused to frame/.test(e)));
 assert.deepEqual(errors,[]);console.log('PASS: start click relayed through service (progress, failure, retry), foreign framing refused, embedded host messages, external link handoff without popup, in-page discard and delete dialogs.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
