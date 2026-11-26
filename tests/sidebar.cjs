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
   file('moved/same.txt','R','same\n','same\n',0,0,{oldPath:'old/same.txt'}),file('moved/edited.txt','R','one\n','two\n',1,1,{oldPath:'old/edited.txt'}),file('copy.txt','C','c\n','c\n',0,0,{oldPath:'orig.txt'}),file('old/source.txt','D','same\n',null,0,0,{movedTo:{repo:'app',path:'moved/same.txt'}}));
 const commits=[{sha:'c'.repeat(40),author:'Dev',date:'2026-11-19T10:00:00-05:00',subject:'Tune main',body:'Explain why.',merge:false,hiddenFiles:1,files:[{path:'main.txt',oldPath:'main.txt',status:'M',added:1,removed:1},{path:'elsewhere.txt',oldPath:'elsewhere.txt',status:'A',added:3,removed:0}]}];
 const payload={id,title:'Sidebar review',repos:[{name:'app',source:'/demo',branch:'main',base:'a'.repeat(40),head:'b'.repeat(40),files,commits}]};
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
 const toggle=page.getByLabel(/Hide unchanged moves \(3\)/);assert.equal(await toggle.isChecked(),true);
 assert.equal(await page.locator('.file-nav[title="app/moved/same.txt"]').count(),0);
 await toggle.uncheck();await page.locator('.file-nav[title="app/moved/same.txt"]').waitFor();
 const mark=path=>page.locator(`.file-nav[title="app/${path}"] .file-status`).textContent();
 assert.equal(await mark('moved/same.txt'),'+m');assert.equal(await mark('moved/edited.txt'),'*m');assert.equal(await mark('copy.txt'),'+c');assert.equal(await mark('main.txt'),'*');assert.equal(await mark('old/source.txt'),'');
 assert.equal(await page.locator('.file-nav[title="app/old/source.txt"] .file-label').evaluate(n=>getComputedStyle(n).textDecorationLine),'line-through');
 // Origin shown inline in header; no comparison bar.
 const origin=async path=>{await page.locator(`.file-nav[title="app/${path}"]`).click();await page.locator('.file-header .file-path',{hasText:path}).waitFor();return page.locator('.file-origin').textContent();};
 assert.equal(await origin('moved/edited.txt'),'moved from old/edited.txt');assert.equal(await origin('copy.txt'),'copied from orig.txt');
 assert.equal(await origin('old/source.txt'),'moved to app/moved/same.txt');assert.equal(await page.locator('.move-note').count(),0);
 await page.locator('.origin-link').click();await page.locator('.file-header .file-path',{hasText:'moved/same.txt'}).waitFor();
 await page.locator('.file-nav[title="app/main.txt"]').click();await page.locator('.file-header .file-path',{hasText:/^main\.txt$/}).waitFor();await toggle.check();
 assert.equal(await page.locator('.file-nav[title="app/moved/same.txt"]').count(),0);
 const tests=page.getByLabel(/Hide tests \(1\)/);assert.equal(await tests.isChecked(),true);assert.equal(await page.locator('.file-nav[title="app/tests/test_main.py"]').count(),0);
 await tests.uncheck();await page.locator('.file-nav[title="app/tests/test_main.py"]').waitFor();assert.equal(await page.locator('.file-nav[title="app/tests/test_main.py"] .file-status').textContent(),'+');await tests.check();
 // Arrow keys walk visible files.
 await page.locator('.file-nav[title="app/main.txt"]').click();await page.keyboard.press('ArrowDown');
 await page.locator('.file-header .file-path',{hasText:/^gone\.txt$/}).waitFor();assert.equal(await page.evaluate(()=>document.activeElement.title),'app/gone.txt');
 await page.keyboard.press('ArrowUp');await page.locator('.file-header .file-path',{hasText:/^main\.txt$/}).waitFor();
 await page.getByRole('searchbox',{name:'Filter files'}).focus();await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.title),'app/main.txt');
 // Right/Left toggle viewed on focused file.
 const tick=()=>page.locator('.file-nav[title="app/main.txt"] .view-tick').count();
 await page.keyboard.press('ArrowRight');await page.locator('.file-nav[title="app/main.txt"] .view-tick').waitFor();
 assert.equal(await page.locator('.viewed-toggle').isChecked(),true);await page.getByText(/^1 \/ \d+ files viewed$/).waitFor();
 assert.equal(await page.evaluate(()=>document.activeElement.title),'app/main.txt');
 await page.keyboard.press('ArrowLeft');await page.waitForFunction(()=>!document.querySelector('.file-nav[title="app/main.txt"] .view-tick'));
 assert.equal(await tick(),0);assert.equal(await page.locator('.viewed-toggle').isChecked(),false);
 // WASD mirror arrows.
 await page.locator('.file-nav[title="app/main.txt"]').focus();await page.keyboard.press('s');await page.locator('.file-header .file-path',{hasText:/^gone\.txt$/}).waitFor();
 await page.keyboard.press('d');await page.locator('.file-nav[title="app/gone.txt"] .view-tick').waitFor();
 await page.keyboard.press('a');await page.waitForFunction(()=>!document.querySelector('.file-nav[title="app/gone.txt"] .view-tick'));
 await page.keyboard.press('w');await page.locator('.file-header .file-path',{hasText:/^main\.txt$/}).waitFor();
 // Earlier threads carried into latest code view.
 const changed=page.locator('[data-thread="'+moved+'"]'),same=page.locator('[data-thread="'+kept+'"]');
 await changed.waitFor();await changed.getByText('Snapshot 1 · code changed since').waitFor();
 // Resolved: collapsed to one line, expandable.
 assert.equal(await changed.getByText('Done in snapshot 2.').isVisible(),false);await changed.locator('.thread-snippet',{hasText:'Rename beta2?'}).waitFor();
 await changed.getByRole('button',{name:'Show 2'}).click();await changed.getByRole('button',{name:'Hide'}).waitFor();await changed.getByText('beta2',{exact:true}).waitFor();
 await changed.getByText('Done in snapshot 2.').waitFor();assert.equal(await same.locator('.carried-note').textContent(),'Snapshot 1');
 assert.ok(await page.locator('tr:has(code[data-side="new"][data-line="4"]) + tr.thread-row [data-thread="'+kept+'"]').count());
 // Scroll stays when picking a file.
 const side=page.locator('.sidebar');await side.evaluate(n=>n.scrollTop=n.scrollHeight);const top=await side.evaluate(n=>n.scrollTop);assert.ok(top>0);
 await page.locator('.file-nav[title="app/pkg/dir3/file39.txt"]').click();await page.locator('.file-header .file-path',{hasText:'file39.txt'}).waitFor();
 assert.equal(await side.evaluate(n=>n.scrollTop),top);
 await page.locator('.file-nav[title="app/gone.txt"]').click();await page.locator('.file-header .file-path',{hasText:'gone.txt'}).waitFor();assert.equal(await page.locator('[data-thread="'+deleted+'"]').count(),0);
 // Deleted file: discussion only; resolved threads listed by default.
 assert.equal(await page.getByRole('button',{name:/^Discussion/}).locator('.count').textContent(),'3');
 await page.getByRole('button',{name:/^Discussion/}).click();
 for(const tid of [moved,kept,deleted])await page.locator('.discussion [data-thread="'+tid+'"]').waitFor();
 await page.getByRole('button',{name:/gone\.txt/}).click();await page.getByText('You’re viewing an earlier snapshot.',{exact:false}).waitFor();
 await page.locator('[data-thread="'+deleted+'"]').waitFor();
 assert.equal(await page.locator('.topbar .brand').getAttribute('href'),'https://github.com/demo-kode/prepr-tool');assert.equal(await page.locator('.topbar .brand').getAttribute('target'),'_blank');
 // Way back to the review list: top bar link, in view after scrolling too.
 const back=page.locator('.topbar .all-reviews');assert.equal(await back.getAttribute('href'),'/');
 await page.setViewportSize({width:1400,height:420});await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
 assert.equal(await page.evaluate(()=>scrollY>0),true,'page scrolled');assert.equal(await back.evaluate(n=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),true,'link in view after scroll');
 await page.screenshot({path:'.local/ui-test/reviews-link-scrolled.png'});
 await page.evaluate(()=>window.scrollTo(0,0));await page.setViewportSize({width:1400,height:800});
 // Commits tab replaces branch bar.
 assert.equal(await page.locator('.branch-line').count(),0);
 await page.getByRole('button',{name:/^Commits/}).click();await page.locator('.commit-repo-head',{hasText:'main · aaaaaaaa → bbbbbbbb'}).waitFor();
 await page.getByText('Tune main',{exact:true}).click();await page.getByText('Explain why.',{exact:true}).waitFor();await page.getByText('1 file outside review scope').waitFor();
 assert.equal(await page.locator('.commit-file',{hasText:'elsewhere.txt'}).isDisabled(),true);
 const plain={id:id+'-plain',title:'Uncommitted',repos:[{name:'app',source:'/demo',branch:'main',base:'d'.repeat(40),head:'d'.repeat(40),files:[file('x.txt','M','a\n','b\n',1,1)]}]};
 await call('/api/reviews',plain);await page.goto(url+'/?review='+plain.id);await page.getByRole('button',{name:/^Commits/}).click();
 await page.getByText('No commits yet — all changes in this repository are uncommitted.').waitFor();await page.getByText('main · dddddddd + uncommitted changes').waitFor();
 await page.goto(url+'/?review='+id+'&repo=app&file=main.txt');await page.getByRole('button',{name:/^Commits/}).click();await page.getByText('Tune main',{exact:true}).click();
 await page.screenshot({path:'.local/ui-test/commits.png'});
 await page.locator('.commit-file',{hasText:'main.txt'}).click();await page.locator('.file-header .file-path',{hasText:/^main\.txt$/}).waitFor();
 await page.screenshot({path:'.local/ui-test/sidebar.png'});
 // Review that fails to load: link still there and leads to the list. Narrow screen keeps it.
 await page.goto(url+'/?review=no-such-review');await page.locator('.error').waitFor();
 await page.setViewportSize({width:420,height:900});assert.equal(await back.isVisible(),true,'narrow screen keeps link');await page.screenshot({path:'.local/ui-test/reviews-link-narrow.png'});await page.setViewportSize({width:1400,height:800});
 await back.click();await page.getByRole('heading',{name:'Reviews before pull requests'}).waitFor();assert.equal(await back.isVisible(),true);
 assert.deepEqual(errors,[]);console.log('PASS: compact sidebar, folder grouping, status marks, arrow keys, viewed keys, WASD, no-diff/tests toggles, stable scroll, carried threads, collapsed resolved, commits tab, inline origin, brand link, All reviews link (scrolled, failed load, narrow), deleted-file discussion.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
