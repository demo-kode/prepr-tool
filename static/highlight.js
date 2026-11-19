'use strict';
(() => {
  const languages = globalThis.PreprLanguages || [];
  const aliases = new Map(languages.flatMap(l => [l.id, ...(l.aliases || [])].map(a => [a, l.id])));
  const extensions = {
    tf: 'terraform', tfvars: 'terraform', tfbackend: 'hcl', hcl: 'hcl', tftpl: 'terraform',
    sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', bats: 'shellscript',
    ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', bat: 'bat', cmd: 'bat',
    ts: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python', pyw: 'python', kt: 'kotlin', kts: 'kotlin', gradle: 'groovy',
    yml: 'yaml', sls: 'salt', jsonc: 'jsonc', json5: 'json5', geojson: 'json', geojsonld: 'json', ipynb: 'json',
    md: 'markdown', mdx: 'mdx', h: 'c', hpp: 'cpp', cc: 'cpp', cxx: 'cpp', cs: 'csharp', rs: 'rust', rb: 'ruby',
    html: 'html', htm: 'html', svg: 'xml', kml: 'xml', gpx: 'xml', sld: 'xml', tcx: 'xml',
    plist: 'xml', storyboard: 'xml', entitlements: 'xml', drawio: 'xml',
    ini: 'ini', properties: 'ini', cfg: 'ini', env: 'dotenv', service: 'systemd', timer: 'systemd',
    mount: 'systemd', socket: 'systemd', target: 'systemd', path: 'systemd', link: 'systemd',
    j2: 'jinja', jinja: 'jinja', jinja2: 'jinja', patch: 'diff', diff: 'diff',
    mod: 'go', sum: 'text', txt: 'text', log: 'text', csv: 'csv', tsv: 'tsv',
    pro: 'prolog', xcconfig: 'ini', pbxproj: 'text', pem: 'text', crt: 'text', key: 'text'
  };
  function detect(path, text = '') {
    let name = path.split('/').pop().toLowerCase();
    if (/^(dockerfile|containerfile)([._-]|$)/.test(name) || /\.(dockerfile|containerfile)$/.test(name)) return 'dockerfile';
    if (/^\.env($|\.)|^\.dev\.vars($|\.)/.test(name)) return 'dotenv';
    if (/^(gnumakefile|makefile)(\.|$)/.test(name)) return 'make';
    if (/^(\.gitconfig|\.gitmodules|\.npmrc|\.pylintrc|\.editorconfig)$/.test(name)) return 'ini';
    if (/^(\.secrets\.baseline|\.nycrc|package\.resolved)$/.test(name)) return 'json';
    if (/^(\.gitignore|\.dockerignore|\.prettierignore|\.gitattributes|license|copying|version)$/.test(name)) return /ignore|attributes/.test(name) ? 'ignore' : 'text';
    const first = text.split(/\r?\n/, 1)[0];
    if (first.startsWith('#!')) {
      if (/\b(pwsh|powershell)\b/.test(first)) return 'powershell';
      if (/\bpython[\d.]*(?:\s|$)/.test(first)) return 'python';
      if (/\b(bash|sh|dash|ash|zsh|ksh)\b/.test(first)) return 'shellscript';
      if (/\b(node|nodejs|deno|bun)\b/.test(first)) return 'javascript';
      if (/\b(ruby|perl|php)\b/.test(first)) return first.match(/\b(ruby|perl|php)\b/)[1];
    }
    // Recover known extensions beneath common template/backup suffixes.
    name = name.replace(/\.(example|sample|template|tmpl|tpl|in|disabled|bak|old|new|before|after)$/g, '');
    const ext = name.includes('.') ? name.split('.').pop() : '';
    if (extensions[ext]) return extensions[ext];
    if (aliases.has(ext)) return aliases.get(ext);
    if (/nginx/.test(path.toLowerCase())) return 'nginx';
    if (/^\s*[\[{]/.test(text)) { try { JSON.parse(text); return 'json'; } catch {} }
    if (/^\s*(<\?xml\b|<[A-Za-z][^>]*>)/.test(text)) return 'xml';
    if (ext === 'conf') return /^\s*\[.+\]/m.test(text) ? 'ini' : 'text';
    return 'text';
  }
  let worker, pending, serial = 0;
  function stop() {
    if (worker) worker.terminate();
    worker = null;
    if (pending) { clearTimeout(pending.timer); pending.done({ error: true }); pending = null; }
  }
  function request(sides) {
    // Navigation cancels stale tokenization instead of queuing large files.
    if (pending) stop();
    return new Promise(done => {
      try {
        if (!worker) {
          worker = new Worker('/highlight-worker.js', { type: 'module' });
          worker.onerror = stop;
          worker.onmessage = ({ data }) => {
            if (!pending || data.id !== pending.id) return;
            const current = pending; pending = null; clearTimeout(current.timer); current.done(data);
          };
        }
        const id = ++serial;
        pending = { id, done, timer: setTimeout(stop, 8000) };
        worker.postMessage({ id, sides });
      } catch { stop(); done({ error: true }); }
    });
  }
  function paint(code, tokens) {
    // Never trust generated HTML. Tokens only create text nodes and spans.
    if (tokens.map(t => t.content).join('') !== code.dataset.source) return;
    const fragment = document.createDocumentFragment();
    for (const t of tokens) {
      const span = document.createElement('span');span.textContent = t.content;
      if (/^#[a-f0-9]{6,8}$/i.test(t.color || '')) span.style.color = t.color;
      if (t.fontStyle & 1) span.classList.add('syntax-italic');
      if (t.fontStyle & 2) span.classList.add('syntax-bold');
      if (t.fontStyle & 4) span.classList.add('syntax-underline');
      fragment.append(span);
    }
    code.replaceChildren(fragment);
  }
  async function apply(table, file, selected, status) {
    const sides = [], names = [];
    let limited = false;
    for (const side of ['old', 'new']) {
      const nodes = [...table.querySelectorAll(`code[data-side="${side}"]`)];
      if (!nodes.length) continue;
      const text = file[side];
      const language = selected === 'auto' ? detect(side === 'old' ? file.oldPath : file.path, text || '') : selected;
      names.push(languages.find(l => l.id === language)?.name || 'Plain text');
      if (typeof text !== 'string' || language === 'text') continue;
      if (text.length > 300000 || text.split('\n').some(line => line.length > 20000)) { limited = true; continue; }
      sides.push({ side, text, language, lines: nodes.map(n => Number(n.dataset.line)) });
    }
    status.textContent = [...new Set(names)].join(' / ') || 'Plain text';
    if (!sides.length) { if (pending) stop(); if (limited) status.textContent += ' · plain text for large file'; return; }
    const result = await request(sides);
    if (!table.isConnected) return;
    if (result.error) { status.textContent += ' · highlighting unavailable'; return; }
    for (const side of sides) {
      for (const code of table.querySelectorAll(`code[data-side="${side.side}"]`)) {
        const tokens = result.sides[side.side]?.[code.dataset.line];
        if (tokens) paint(code, tokens);
      }
    }
    if (limited) status.textContent += ' · plain text for large file';
    table.dataset.highlighted = 'true';
  }
  globalThis.PreprHighlight = { languages, detect, apply };
})();
