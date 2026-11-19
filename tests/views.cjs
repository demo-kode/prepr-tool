// Run against a disposable local server.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const url=process.env.PREPR_TEST_URL||'http://127.0.0.1:18745';
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const id='views-'+Date.now(),old='// start\nconst first = 1;\nconst second = 2;\n// tail\n'+Array.from({length:15},(_,i)=>`// unchanged ${i}`).join('\n')+'\n';
  const next=old.replace('first = 1','first = 10').replace('second = 2','second = 20');
  const file=(path,before,after,status='M')=>({path,oldPath:path,status,old:before,new:after,added:2,removed:2,oldMode:'100644',newMode:'100644',note:''});
  const payload={id,title:'Review layout',repos:[{name:'api',source:'/demo/api',branch:'feature/demo',base:'a'.repeat(40),head:'b'.repeat(40),files:[file('src/settings.js',old,next),file('retired.js','const removed = true;\n','','D'),file('new.js','','const added = true;\n','A'),file('large.txt','start\n',Array.from({length:2005},(_,i)=>`line ${i+1}`).join('\n')+'\n')]}]};
  const published=await fetch(url+'/api/reviews',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});assert.equal(published.status,200,await published.text());
  await page.goto(url+'/?review='+id);await page.locator('table[data-highlighted="true"]').waitFor();
  assert.equal(await page.locator('.file-header .file-repo').textContent(),'api');
  assert.equal(await page.getByRole('button',{name:'Wrap',exact:true}).count(),0);
  assert.equal(await page.getByText('Click + beside a line to leave an inline comment.',{exact:true}).count(),0);
  const list=page.getByRole('separator',{name:'Resize file list'}),split=page.getByRole('separator',{name:'Resize diff columns'});
  async function drag(locator,dx){const box=await locator.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+25);await page.mouse.down();await page.mouse.move(box.x+box.width/2+dx,box.y+25,{steps:8});await page.mouse.up();}
  const beforeWidth=(await page.locator('.sidebar').boundingBox()).width;await drag(list,90);assert.ok((await page.locator('.sidebar').boundingBox()).width>beforeWidth+70);
  await drag(split,120);assert.ok(Number(await split.getAttribute('aria-valuenow'))>55);
  const ratio=Number(await split.getAttribute('aria-valuenow'));await split.focus();await page.keyboard.press('ArrowLeft');assert.ok(Number(await split.getAttribute('aria-valuenow'))<ratio);
  await page.getByRole('button',{name:'Unified',exact:true}).click();await page.locator('table[data-highlighted="true"]').waitFor();
  assert.equal(await page.getByRole('separator',{name:'Resize diff columns'}).count(),0);
  const changed=await page.locator('.diff td.removed code,.diff td.added code').allTextContents();assert.deepEqual(changed,['const first = 1;','const second = 2;','const first = 10;','const second = 20;']);
  await page.getByRole('button',{name:'Comment on before line 2',exact:true}).click();await page.getByRole('textbox',{name:'Comment on before line 2',exact:true}).fill('Deletion anchor stays on old line 2.');await page.getByRole('button',{name:'Post comment',exact:true}).click();await page.getByText('Deletion anchor stays on old line 2.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Comment on after line 3',exact:true}).click();await page.getByRole('textbox',{name:'Comment on after line 3',exact:true}).fill('Addition anchor stays on new line 3.');await page.getByRole('button',{name:'Post comment',exact:true}).click();await page.getByText('Addition anchor stays on new line 3.',{exact:true}).waitFor();
  await page.screenshot({path:'.local/ui-test/unified.png',fullPage:true});
  await page.getByRole('button',{name:'Raw',exact:true}).click();await page.locator('table[data-highlighted="true"]').waitFor();
  assert.equal(await page.locator('.diff code').count(),19);assert.equal(await page.locator('.hunk').count(),0);
  assert.deepEqual(await page.locator('.diff code').allTextContents(),next.trimEnd().split('\n'));
  await page.getByRole('button',{name:'Comment on after line 19',exact:true}).click();await page.getByRole('textbox',{name:'Comment on after line 19',exact:true}).fill('Raw context anchor.');await page.getByRole('button',{name:'Post comment',exact:true}).click();await page.getByText('Raw context anchor.',{exact:true}).waitFor();
  await page.getByRole('combobox',{name:'Raw version'}).selectOption('old');await page.locator('table[data-highlighted="true"]').waitFor();assert.deepEqual(await page.locator('.diff code').allTextContents(),old.trimEnd().split('\n'));
  await page.getByRole('button',{name:'Comment on before line 19',exact:true}).click();await page.getByRole('textbox',{name:'Comment on before line 19',exact:true}).fill('Unsent draft');page.once('dialog',d=>d.dismiss());await page.getByRole('button',{name:'Unified',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Raw',exact:true}).getAttribute('aria-pressed'),'true');await page.getByRole('button',{name:'Cancel',exact:true}).click();
  const feedback=await(await fetch(url+'/api/reviews/'+id+'/feedback')).json();assert.deepEqual(feedback.threads.sort((a,b)=>a.line-b.line).map(t=>[t.side,t.line,t.code]),[['old',2,'const first = 1;'],['new',3,'const second = 20;'],['new',19,'// unchanged 14']]);
  await page.getByRole('button',{name:/retired.js/}).click();await page.getByRole('button',{name:'Comment on before line 1',exact:true}).waitFor();assert.equal(await page.locator('.diff code').textContent(),'const removed = true;');
  await page.getByRole('button',{name:/new.js/}).click();await page.getByRole('button',{name:'Comment on after line 1',exact:true}).waitFor();assert.equal(await page.locator('.diff code').textContent(),'const added = true;');
  await page.getByRole('button',{name:/large.txt/}).click();await page.getByRole('button',{name:/Show next 5 lines/}).waitFor();assert.equal(await page.locator('.diff code').count(),2000);await page.getByRole('button',{name:/Show next 5 lines/}).click();assert.equal(await page.locator('.diff code').count(),2005);
  await page.getByRole('button',{name:/settings.js/}).click();await page.getByRole('button',{name:'Split',exact:true}).click();await page.locator('table[data-highlighted="true"]').waitFor();
  const colWidth=await page.locator('.diff col').first().evaluate(n=>n.getBoundingClientRect().width),tableWidth=await page.locator('.diff').evaluate(n=>n.getBoundingClientRect().width);assert.ok(colWidth/tableWidth>.55);
  await page.reload();await page.locator('table[data-highlighted="true"]').waitFor();assert.ok((await page.locator('.sidebar').boundingBox()).width>beforeWidth+70);assert.ok(Number(await page.getByRole('separator',{name:'Resize diff columns'}).getAttribute('aria-valuenow'))>55);
  await page.screenshot({path:'.local/ui-test/resized-split.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.getByRole('separator',{name:'Resize file list'}).isVisible(),false);await page.getByRole('button',{name:'Unified',exact:true}).click();await page.screenshot({path:'.local/ui-test/unified-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);console.log('PASS: repo header, clean toolbar, split/unified/raw, old/new comments, full raw context, pagination, draft guard, pointer/keyboard resizing, persisted widths, mobile.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
