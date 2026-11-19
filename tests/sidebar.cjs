// Disposable server only.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const url=process.env.PREPR_TEST_URL||'http://127.0.0.1:18745';
const call=async(path,data,method='POST')=>{const r=await fetch(url+path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});assert.equal(r.status,200,await r.clone().text());return r.json();};
(async()=>{const browser=await chromium.launch({headless:true});try{
 const page=await browser.newPage({viewport:{width:1400,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const id='sidebar-'+Date.now(),before='alpha\nbeta\ngamma\ndelta\n';
 const file=(path,status,old,next,added,removed,extra={})=>({path,oldPath:path,status,old,new:next,added,removed,note:'',...extra});
 const files=Array.from({length:40},(_,i)=>file(`pkg/dir${i%4}/file${String(i).padStart(2,'0')}.txt`,'M','a\n',`b${i}\n`,1,1));
 files.push(file('main.txt','M',before,before.replace('beta','beta2'),1,1),file('gone.txt','M','x\ny\n','x\ny2\n',1,1),file('tests/test_main.py','A',null,'pass\n',1,0),
   file('moved/same.txt','R','same\n','same\n',0,0,{oldPath:'old/same.txt'}),file('old/source.txt','D','same\n',null,0,0,{movedTo:{repo:'app',path:'moved/same.txt'}}));
 const payload={id,title:'Sidebar review',repos:[{name:'app',source:'/demo',branch:'main',base:'a'.repeat(40),head:'b'.repeat(40),files}]};
 const first=(await call('/api/reviews',payload)).snapshot;
 const comment=async(path,side,line,body)=>(await call('/api/threads',{snapshot:first,repo:'app',path,side,line,author:'Reviewer',body})).id;
 const moved=await comment('main.txt','new',2,'Rename beta2?'),kept=await comment('main.txt','new',4,'Delta fine?'),deleted=await comment('gone.txt','new',2,'Remove file?');
 // Agent answers, changes code, publishes new snapshot.
 for(const tid of [moved,kept,deleted])await call('/api/threads/'+tid+'/messages',{author:'Codex',body:'Done in snapshot 2.'});
 await call('/api/threads/'+moved,{status:'resolved'},'PATCH');
 files.find(f=>f.path==='main.txt').new='alpha\nbeta3\ngamma\ndelta\n';Object.assign(files.find(f=>f.path==='gone.txt'),{status:'D',new:null,added:0,removed:2});
 await call('/api/reviews',payload);
 await page.goto(url+'/?review='+id+'&repo=app&file=main.txt');await page.locator('.file-nav.active').waitFor();
 // Compact rows, folder headers, no-diff hidden by default.
 const height=(await page.locator('.file-nav').first().boundingBox()).height;assert.ok(height<=26,`row height ${height}`);
 assert.equal(await page.locator('.folder',{hasText:'pkg/dir0'}).count(),1);
 const toggle=page.getByLabel(/Hide unchanged moves \(2\)/);assert.equal(await toggle.isChecked(),true);
 assert.equal(await page.locator('.file-nav[title="app/moved/same.txt"]').count(),0);
 await toggle.uncheck();await page.locator('.file-nav[title="app/moved/same.txt"]').waitFor();await toggle.check();
 assert.equal(await page.locator('.file-nav[title="app/moved/same.txt"]').count(),0);
 const tests=page.getByLabel(/Hide tests \(1\)/);assert.equal(await tests.isChecked(),true);assert.equal(await page.locator('.file-nav[title="app/tests/test_main.py"]').count(),0);
 await tests.uncheck();await page.locator('.file-nav[title="app/tests/test_main.py"]').waitFor();await tests.check();
 // Earlier threads carried into latest code view.
 const changed=page.locator('[data-thread="'+moved+'"]'),same=page.locator('[data-thread="'+kept+'"]');
 await changed.waitFor();await changed.getByText('Snapshot 1 · code changed since').waitFor();await changed.getByText('beta2',{exact:true}).waitFor();
 await changed.getByText('Done in snapshot 2.').waitFor();assert.equal(await same.locator('.carried-note').textContent(),'Snapshot 1');
 assert.ok(await page.locator('tr:has(code[data-side="new"][data-line="4"]) + tr.thread-row [data-thread="'+kept+'"]').count());
 // Scroll stays when picking a file.
 const side=page.locator('.sidebar');await side.evaluate(n=>n.scrollTop=n.scrollHeight);const top=await side.evaluate(n=>n.scrollTop);assert.ok(top>0);
 await page.locator('.file-nav[title="app/pkg/dir3/file39.txt"]').click();await page.locator('.file-header .file-path',{hasText:'file39.txt'}).waitFor();
 assert.equal(await side.evaluate(n=>n.scrollTop),top);
 await page.locator('.file-nav[title="app/gone.txt"]').click();await page.locator('.file-header .file-path',{hasText:'gone.txt'}).waitFor();assert.equal(await page.locator('[data-thread="'+deleted+'"]').count(),0);
 // Deleted file: discussion only; resolved threads listed by default.
 await page.getByRole('button',{name:/^Discussion/}).click();
 for(const tid of [moved,kept,deleted])await page.locator('.discussion [data-thread="'+tid+'"]').waitFor();
 await page.getByRole('button',{name:/gone\.txt/}).click();await page.getByText('You’re viewing an earlier snapshot.',{exact:false}).waitFor();
 await page.locator('[data-thread="'+deleted+'"]').waitFor();
 await page.screenshot({path:'.local/ui-test/sidebar.png'});
 assert.deepEqual(errors,[]);console.log('PASS: compact sidebar, folder grouping, no-diff/tests toggles, stable scroll, carried threads, deleted-file discussion.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
