'use strict';
// PrePR in editor tab: webview hosts service page in full-size iframe. No deps.
const vscode = require('vscode');
const crypto = require('crypto');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

// One tab per review (key = review ID; '' = home). Parallel tasks stay side by side.
const panels = new Map();
const resuming = new Map(); // review ID -> background Codex process
let log = null;
let storageDirectory = null;

function base() {
  return vscode.workspace.getConfiguration('prepr').get('url', 'http://127.0.0.1:18744').replace(/\/+$/, '');
}

function pagePath(review, snapshot) {
  if (!review) return '/';
  const q = new URLSearchParams({review});
  if (snapshot) q.set('snapshot', String(snapshot));
  return '/?' + q.toString();
}

async function reachable() {
  try { return (await fetch(base() + '/api/health', {signal: AbortSignal.timeout(3000)})).ok; }
  catch { return false; }
}

async function frameUrl(path) {
  // Remote windows: map local port through VS Code forwarding.
  const external = await vscode.env.asExternalUri(vscode.Uri.parse(base()));
  return external.toString(true).replace(/\/+$/, '') + path;
}

function keyOf(src) {
  try { return new URL(src).searchParams.get('review') || ''; } catch { return ''; }
}

function rekey(p, key) {
  for (const [k, v] of panels) if (v === p && k !== key) panels.delete(k);
  if (!panels.has(key)) panels.set(key, p);
}

function html(webview, src) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const origin = new URL(src).origin;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#111318}iframe{border:0;width:100%;height:100%;display:block}</style>
</head><body><iframe id="prepr" title="PrePR" src="${src.replace(/"/g, '&quot;')}"></iframe>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi(),frame=document.getElementById('prepr');
vscode.setState({src:frame.src});
window.addEventListener('message',e=>{
  const m=e.data||{};
  if(e.source===frame.contentWindow){
    if(m.type==='prepr:location'){vscode.setState({src:m.href});vscode.postMessage(m);}
    else if(m.type==='prepr:open-external'||m.type==='prepr:resume')vscode.postMessage(m);
    return;
  }
  if(m.type==='navigate'){frame.src=m.src;frame.focus();}
});
frame.addEventListener('load',()=>frame.focus());
</script></body></html>`;
}

let iconUri = null;

function attach(p, key) {
  rekey(p, key);
  if (iconUri) p.iconPath = iconUri;
  p.onDidDispose(() => { for (const [k, v] of panels) if (v === p) panels.delete(k); });
  p.webview.onDidReceiveMessage(m => {
    if (m?.type === 'prepr:resume' && typeof m.review === 'string') resume(m.review);
    else if (m?.type === 'prepr:open-external' && /^https?:\/\//.test(m.url || '')) vscode.env.openExternal(vscode.Uri.parse(m.url));
    else if (m?.type === 'prepr:location' && typeof m.title === 'string') {
      // In-page navigation (home -> review) moves tab to new key.
      const key = keyOf(m.href);
      rekey(p, key);
      p.title = key ? (m.title || key).slice(0, 60) : 'PrePR reviews';
    }
  });
}

const options = {enableScripts: true, retainContextWhenHidden: true};

async function open(review, snapshot) {
  if (!(await reachable())) {
    const pick = await vscode.window.showErrorMessage(`PrePR not reachable at ${base()}. Start it with: docker compose up -d`, 'Retry');
    if (pick === 'Retry') return open(review, snapshot);
    return;
  }
  const key = review || '', src = await frameUrl(pagePath(review, snapshot));
  const existing = panels.get(key);
  if (existing) {
    existing.reveal();
    if (snapshot) existing.webview.postMessage({type: 'navigate', src});
    return;
  }
  const p = vscode.window.createWebviewPanel('prepr', review || 'PrePR reviews', vscode.ViewColumn.One, options);
  attach(p, key);
  p.webview.html = html(p.webview, src);
}

function resumePrompt(review, target, contextFile, stateFile) {
  return `PrePR review ${review}: the user clicked Start watching. Use the prepr-review skill. ` +
    `Read the saved review context at ${JSON.stringify(contextFile)} and applicable AGENTS.md files. ` +
    `The context records the service URL, repository paths, branches, pinned baselines and reusable manifest. ` +
    `Run watch-start for this review with state file ${JSON.stringify(stateFile)} and author ${target.agent === 'claude' ? 'Claude Code' : 'Codex'}. ` +
    'Read existing feedback, answer each open thread there, and watch continuously in this session. ' +
    'Use yielding waits; keep heartbeat current during work. Stop after 30 idle minutes or when review closes. ' +
    'Handle a pending Ship it request through the skill; otherwise do not push, create PRs, merge or deploy. ' +
    'Preserve the review ID, baselines, worktrees and unrelated edits. Reply in PrePR threads, not chat. ' +
    `Review title: ${JSON.stringify(target.review?.title || review)}.`;
}

function codexArgs(target, prompt) {
  const roots = [...new Set(target.roots.filter(r => path.isAbsolute(r)))];
  // Same sandbox as working sessions: write task dirs, reach local PrePR API.
  return ['exec', ...(target.session ? ['resume'] : []), '--json', '--skip-git-repo-check',
    '-c', 'sandbox_mode="workspace-write"',
    '-c', 'sandbox_workspace_write.network_access=true',
    '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`,
    ...(target.session ? [target.session] : []), prompt];
}

async function post(pathname, body) {
  const r = await fetch(base() + pathname, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(5000)});
  const result = await r.json();
  if (!r.ok) throw Error(result.error || `HTTP ${r.status}`);
  return result;
}

// Wake the same agent session that watched this review.
// claim: page click relayed by service; first VS Code window wins.
async function resume(review, claim = false) {
  if (!/^[A-Za-z0-9_-]+$/.test(review)) return;
  let target;
  try {
    if (claim) target = await post(`/api/reviews/${review}/resume`, {action: 'claim'});
    else {
      const r = await fetch(`${base()}/api/reviews/${review}/resume`, {signal: AbortSignal.timeout(5000)});
      target = await r.json();
      if (!r.ok) throw Error(target.error || `HTTP ${r.status}`);
    }
  } catch (e) { vscode.window.showErrorMessage(`PrePR: cannot resume agent: ${e.message}`); return; }
  if (claim && target.status !== 'claimed') return;
  // Page shows why nothing started. No-op once the watcher attached.
  const report = message => {
    if (target.request) post(`/api/reviews/${review}/resume`, {action: 'fail', request: target.request, error: message.slice(0, 500)}).catch(() => {});
  };
  const fail = (message, showLog) => {
    log?.info(`[${review}] ${message}`);
    vscode.window.showErrorMessage(`PrePR: ${message}`, ...(showLog ? ['Show log'] : [])).then(p => p && log?.show());
    report(message);
  };
  if (target.active) { vscode.window.showInformationMessage(`PrePR: ${target.author} is already watching.`); return; }
  if (resuming.has(review)) { vscode.window.showInformationMessage(`PrePR: watcher is already starting.`); return; }
  let prompt;
  try {
    const directory = path.join(storageDirectory, review);
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    const contextFile = path.join(directory, 'context.json'), stateFile = path.join(directory, 'watch.json');
    const manifestFile = path.join(directory, 'review.json');
    const saved = target.review || {id: review, title: review, repos: []};
    const manifest = {...saved, repos: saved.repos.map(({source, ...r}) => ({...r, path: source}))};
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', {mode: 0o600});
    fs.writeFileSync(contextFile, JSON.stringify({url: base(), review: saved, manifestFile, stateFile}, null, 2) + '\n', {mode: 0o600});
    target = {...target, roots: [...target.roots, directory]};
    prompt = resumePrompt(review, target, contextFile, stateFile);
  } catch (e) { fail(`cannot save review context: ${e.message}`); return; }
  if (target.agent === 'claude') {
    const q = new URLSearchParams({session: target.session, prompt}).toString();
    log?.info(`Resume ${review}: Claude Code session ${target.session}`);
    const opened = await vscode.env.openExternal(vscode.Uri.parse(`${vscode.env.uriScheme}://anthropic.claude-code/open?${q}`));
    if (opened === false) fail('cannot open the Claude Code session.');
    return;
  }
  if (target.agent !== 'codex') { fail(`unknown agent ${JSON.stringify(target.agent)}.`); return; }
  const cwd = target.cwd && path.isAbsolute(target.cwd) && fs.existsSync(target.cwd) ? target.cwd : undefined;
  if (!cwd) { fail('review working directory is unavailable.'); return; }
  const bin = vscode.workspace.getConfiguration('prepr').get('codexPath', 'codex');
  function launch(session) {
    log?.info(`${review}: codex exec${session ? ' resume ' + session : ''} (cwd ${cwd})`);
    let child, output = '', started = false;
    try { child = cp.spawn(bin, codexArgs({...target, session}, prompt), {cwd, stdio: ['ignore', 'pipe', 'pipe']}); }
    catch (e) { fail(`cannot start Codex: ${e.message}`); return; }
    resuming.set(review, child);
    const line = chunk => {
      output = (output + String(chunk)).slice(-65536);
      started ||= /"type"\s*:\s*"thread.started"/.test(output);
      String(chunk).split('\n').filter(Boolean).forEach(l => log?.info(`[${review}] ${l}`));
    };
    child.stdout.on('data', line); child.stderr.on('data', line);
    child.on('error', e => { resuming.delete(review); fail(`cannot start Codex (${e.message}). Set prepr.codexPath.`); });
    child.on('exit', code => {
      resuming.delete(review);
      log?.info(`[${review}] Codex exited ${code}`);
      if (code && session && !started && /(?:no (?:saved )?(?:session|rollout|conversation|thread).*?found|(?:session|rollout|conversation|thread).*?(?:not found|does not exist))/i.test(output)) {
        log?.info(`[${review}] Saved session unavailable; starting with review context.`);
        launch(''); return;
      }
      if (code) fail(`watcher exited with code ${code}.`, true);
      else report('Codex ended without attaching to the review.');
    });
  }
  launch(target.session);
  vscode.window.showInformationMessage('PrePR: starting review watcher in background.', 'Show log').then(p => p && log?.show());
}

// Page clicks wait in the service: built-in and external browsers cannot reach this host directly.
let polling = false, pollTimer = null, stopped = false;
async function poll() {
  if (polling) return false;
  polling = true;
  try {
    const r = await fetch(`${base()}/api/resume-requests`, {signal: AbortSignal.timeout(3000)});
    if (!r.ok) return false;
    for (const review of (await r.json()).reviews || []) if (typeof review === 'string') await resume(review, true);
    return true;
  } catch { return false; } finally { polling = false; }
}
// Service down: slow retry.
function schedule(delay) { if (!stopped) pollTimer = setTimeout(async () => schedule(await poll() ? 2000 : 10000), delay); }

async function pickReview() {
  let reviews;
  try { reviews = await (await fetch(base() + '/api/reviews', {signal: AbortSignal.timeout(5000)})).json(); }
  catch { return open(); }
  const done = r => ['closed', 'shipped', 'blocked'].includes(r.decision?.status);
  const items = [...reviews.filter(r => !done(r)), ...reviews.filter(done)].map(r => ({
    label: r.title, description: r.id, detail: done(r) ? `Completed · ${r.decision.status}` : `${r.openThreads ?? 0} open threads`, id: r.id,
  }));
  if (!items.length) return open();
  const pick = await vscode.window.showQuickPick(items, {placeHolder: 'Open PrePR review', matchOnDescription: true});
  if (pick) return open(pick.id);
}

function activate(context) {
  storageDirectory = context.globalStorageUri.fsPath;
  iconUri = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
  // Status bar button: always-visible entry point.
  const item = vscode.window.createStatusBarItem('prepr.status', vscode.StatusBarAlignment.Left, 100);
  item.name = 'PrePR'; item.text = '$(git-pull-request) PrePR'; item.tooltip = 'PrePR: open a review'; item.command = 'prepr.openReview'; item.show();
  log = vscode.window.createOutputChannel('PrePR', {log: true});
  log.info(`PrePR activated; service ${base()}`);
  context.subscriptions.push(item, log,
    vscode.commands.registerCommand('prepr.open', () => open()),
    vscode.commands.registerCommand('prepr.openReview', review => typeof review === 'string' ? open(review) : pickReview()),
    // vscode://demo-kode.prepr/open?review=ID[&snapshot=N]
    vscode.window.registerUriHandler({handleUri(uri) {
      const q = new URLSearchParams(uri.query);
      // vscode://demo-kode.prepr/resume?review=ID (from browser page)
      if (uri.path === '/resume') return q.get('review') && resume(q.get('review'));
      const review = q.get('review'), snapshot = q.get('snapshot');
      if (review && !/^[A-Za-z0-9_-]+$/.test(review)) return;
      return open(review || undefined, /^\d+$/.test(snapshot || '') ? snapshot : undefined);
    }}),
    vscode.window.registerWebviewPanelSerializer('prepr', {async deserializeWebviewPanel(p, state) {
      p.webview.options = options;
      const fallback = await frameUrl('/');
      const src = typeof state?.src === 'string' && state.src.startsWith(new URL(fallback).origin) ? state.src : fallback;
      attach(p, keyOf(src));
      p.webview.html = html(p.webview, src);
    }}),
  );
  stopped = false; schedule(1000);
}

function deactivate() { stopped = true; clearTimeout(pollTimer); for (const child of resuming.values()) child.kill(); }

module.exports = {activate, deactivate, pagePath, html, keyOf, codexArgs, resumePrompt, poll};
