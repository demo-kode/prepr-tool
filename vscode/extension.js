'use strict';
// PrePR in editor tab: webview hosts service page in full-size iframe. No deps.
const vscode = require('vscode');
const crypto = require('crypto');
const cp = require('child_process');
const path = require('path');

// One tab per review (key = review ID; '' = home). Parallel tasks stay side by side.
const panels = new Map();
let log = null;

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
    else if(m.type==='prepr:open-external')vscode.postMessage(m);
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
    if (m?.type === 'prepr:open-external' && /^https?:\/\//.test(m.url || '')) vscode.env.openExternal(vscode.Uri.parse(m.url));
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

// Agents run on the host: review.py agent-run watches reviews and starts the CLI. Extension only keeps it up.
let lastEnsure = 0;
function ensureRunner(reason) {
  const cfg = vscode.workspace.getConfiguration('prepr'), tool = cfg.get('toolPath', '');
  if (!tool || Date.now() - lastEnsure < 10000) return false;
  lastEnsure = Date.now();
  let child, output = '';
  try { child = cp.spawn(cfg.get('pythonPath', 'python3'), [path.join(tool, 'review.py'), '--url', base(), 'agent-ensure'], {cwd: tool, stdio: ['ignore', 'pipe', 'pipe']}); }
  catch (e) { log?.info(`Agent runner (${reason}): cannot start: ${e.message}`); return false; }
  const collect = chunk => { output = (output + String(chunk)).slice(-2000); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  child.on('error', e => log?.info(`Agent runner (${reason}): cannot start: ${e.message}. Check prepr.pythonPath and prepr.toolPath.`));
  child.on('exit', code => log?.info(`Agent runner (${reason}): ${code ? 'failed: ' : ''}${output.replace(/\s+/g, ' ').trim()}`));
  return true;
}

// Start watching click waits in the service. Runner claims it; nobody claimed yet: make sure a runner exists.
let polling = false, pollTimer = null, stopped = false;
async function poll() {
  if (polling) return false;
  polling = true;
  try {
    const r = await fetch(`${base()}/api/resume-requests`, {signal: AbortSignal.timeout(3000)});
    if (!r.ok) return false;
    if (((await r.json()).reviews || []).length) ensureRunner('Start watching');
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
  // Reviews recorded before a reboot: runner picks them up again.
  ensureRunner('startup');
  stopped = false; schedule(1000);
}

// Runner outlives the window on purpose.
function deactivate() { stopped = true; clearTimeout(pollTimer); }

module.exports = {activate, deactivate, pagePath, html, keyOf, ensureRunner, poll};
