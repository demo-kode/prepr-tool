// Run against a disposable local server.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const url = process.env.PREPR_TEST_URL || 'http://127.0.0.1:18745';
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], external = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (!r.url().startsWith(url + '/')) external.push(r.url()); });
    await page.goto(url);
    const cases = {
      'main.tf': ['terraform', 'locals {\n  timeout = 120\n}\n'],
      'variables.tfvars': ['terraform', 'enabled = true\n'],
      '.terraform.lock.hcl': ['hcl', 'provider "example" { version = "1" }\n'],
      'install.sh': ['shellscript', '#!/bin/bash\necho "hello $USER"\n'],
      'checks.bats': ['shellscript', '@test "works" { true; }\n'],
      'update.ps1': ['powershell', '$count = 2\nWrite-Host "Hello $count"\n'],
      'module.psm1': ['powershell', 'function Start-Demo { return $true }\n'],
      'settings.psd1': ['powershell', '@{ Name = "Demo" }\n'],
      'app.ts': ['typescript', 'const enabled: boolean = true;\n'],
      'app.tsx': ['tsx', 'const App = () => <h1>Hello</h1>;\n'],
      'app.svelte': ['svelte', '<script lang="ts">let n: number = 1;</script>\n<h1>{n}</h1>\n'],
      'app.vue': ['vue', '<script setup>const n = 1;</script>\n<template><h1>{{ n }}</h1></template>\n'],
      'task.py': ['python', 'def hello():\n    return "hello"\n'],
      'Dockerfile-worker': ['dockerfile', 'FROM python:3.12-slim\nRUN echo hello\n'],
      'Makefile': ['make', 'build:\n\techo hello\n'],
      '.env.example': ['dotenv', 'PORT=8080\n'],
      'unit.service': ['systemd', '[Service]\nExecStart=/bin/true\n'],
      'install.sls': ['salt', '{% set package = "demo" %}\ninstall:\n  pkg.installed:\n    - name: {{ package }}\n'],
      'config.jinja': ['jinja', '{% if enabled %}{{ value }}{% endif %}\n'],
      'config.yaml': ['yaml', 'enabled: true\n'],
      'settings.json': ['json', '{"enabled": true}\n'],
      'settings.jsonc': ['jsonc', '// comment\n{"enabled": true}\n'],
      'notes.md': ['markdown', '# Hello\n**world**\n'],
      'settings.toml': ['toml', '[app]\nenabled = true\n'],
      '.secrets.baseline': ['json', '{"results": {}}\n'],
      'users.ldif': ['ldif', 'dn: cn=demo\nobjectClass: person\n'],
      '.gitignore': ['ignore', '# generated\n!keep\n*.tmp\n'],
      'tool': ['python', '#!/usr/bin/env python3\nprint("hello")\n'],
      'tool.example': ['shellscript', '#!/usr/bin/env -S bash -e\necho yes\n'],
      'settings.yml.tpl': ['yaml', 'enabled: true\n'],
      'index.html': ['html', '<img src=x onerror="alert(1)">\n<script>alert(1)</script>\n'],
      'module.java': ['java', 'class Demo { int count = 2; }\n'],
      'module.kt': ['kotlin', 'val enabled: Boolean = true\n'],
      'query.sql': ['sql', 'SELECT * FROM users WHERE active = true;\n'],
      'module.go': ['go', 'package main\nfunc main() {}\n'],
      'module.cpp': ['cpp', '#include <iostream>\nint main() { return 0; }\n'],
      'line-endings.py': ['python', 'def hello():\r\n    return True\r\n'],
      'module.tf.json': ['json', '{"variable": {}}\n'],
      'unknown.weird': ['text', 'ordinary prose\n']
    };
    const detected = await page.evaluate(cases => Object.fromEntries(Object.entries(cases).map(([p, c]) => [p, PreprHighlight.detect(p, c[1])])), cases);
    for (const [path, [language]] of Object.entries(cases)) assert.equal(detected[path], language, path);
    const tokenized = await page.evaluate(async cases => {
      const worker = new Worker('/highlight-worker.js', { type: 'module' });
      try {
        const result = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(Error('Worker timed out')), 20000);
          worker.onerror = e => { clearTimeout(timeout);reject(Error(e.message)); };
          worker.onmessage = e => { clearTimeout(timeout); resolve(e.data); };
          worker.postMessage({ id: 1, sides: Object.entries(cases).filter(([,c])=>c[0]!=='text').map(([path,[language,text]]) => ({ side:path, language,text,lines:text.trimEnd().split('\n').map((_,i)=>i+1) })) });
        });
        return result;
      } finally { worker.terminate(); }
    }, cases);
    assert.ok(!tokenized.error, 'All grammars load and tokenize');
    for (const [path, lines] of Object.entries(tokenized.sides)) {
      const source = cases[path][1].split('\n');
      for (const [line, tokens] of Object.entries(lines)) assert.equal(tokens.map(t=>t.content).join(''), source[Number(line)-1].replace(/\r$/, ''), path);
      assert.ok(new Set(Object.values(lines).flat().map(t=>t.color)).size>1, `Colored tokens: ${path}`);
    }
    const id = 'highlight-test-' + Date.now();
    const old = '/*\n' + ' inside comment\n'.repeat(15) + '*/\nconst value = "<img src=x onerror=alert(1)>";\n';
    const modified = old.replace('inside comment\n*/', 'changed comment\n*/');
    const file = { path:'src/code.ts', oldPath:'src/code.ts', status:'M', old, new:modified, added:1,removed:1,oldMode:'100644',newMode:'100644',note:'' };
    const published = await fetch(url+'/api/reviews',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,title:'Syntax tests',repos:[{name:'demo',source:'/demo',branch:'test',base:'a'.repeat(40),head:'b'.repeat(40),files:[file]}]})});
    assert.equal(published.status,200,await published.text());
    await page.goto(url+'/?review='+id);
    await page.locator('table[data-highlighted="true"]').waitFor();
    const comment = page.locator('code[data-side="new"][data-line="16"]');
    assert.equal(await comment.textContent(),' changed comment');
    assert.equal(await comment.locator('span').first().evaluate(e=>e.style.color),'rgb(157, 167, 183)');
    assert.equal(await page.locator('.diff img,.diff script').count(),0);
    await page.getByRole('button',{name:'Comment on after line 16',exact:true}).click();
    await page.getByRole('textbox',{name:'Comment on after line 16',exact:true}).fill('Same line after highlighting?');
    await page.getByRole('button',{name:'Post comment',exact:true}).click();
    await page.getByText('Same line after highlighting?',{exact:true}).waitFor();
    const feedback=await (await fetch(url+'/api/reviews/'+id+'/feedback')).json();
    assert.equal(feedback.threads[0].code,' changed comment');assert.equal(feedback.threads[0].line,16);
    assert.equal(await page.getByRole('combobox',{name:'Syntax language'}).count(),0);
    assert.equal(await page.locator('.syntax-status').textContent(),'TypeScript');
    const fallback = await page.evaluate(async () => {
      const table = document.createElement('table');
      const code = document.createElement('code'); code.dataset.side='new';code.dataset.line='1';code.dataset.source='const value = 1;';code.textContent=code.dataset.source;table.append(code);document.body.append(table);
      const status=document.createElement('span');
      await PreprHighlight.apply(table,{path:'big.js',oldPath:'big.js',new:'x'.repeat(300001)},'auto',status);
      const result={status:status.textContent,text:code.textContent,spans:code.children.length};table.remove();return result;
    });
    assert.match(fallback.status,/plain text for large file/);assert.equal(fallback.spans,0);assert.equal(fallback.text,'const value = 1;');
    await page.screenshot({path:'.local/ui-test/highlighting.png',fullPage:true});
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    console.log(`PASS: ${Object.keys(cases).length} format detections, whole-file multiline tokens, preserved source, XSS, original comment anchors, automatic language, plain text, zero external requests.`);
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1)});
