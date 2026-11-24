"""Watch local feedback from the working agent's existing session."""
import json
import os
from pathlib import Path
import re
import time
import uuid


def save(path, state):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(state, indent=2)+'\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def agent_session():
    # Detect running agent and its session ID.
    if os.environ.get('CODEX_THREAD_ID'): return 'codex', os.environ['CODEX_THREAD_ID']
    if os.environ.get('CLAUDE_CODE_SESSION_ID'): return 'claude', os.environ['CLAUDE_CODE_SESSION_ID']
    return '', ''


def start(api, url, rid, path, author, session=None, resume=None):
    if not re.fullmatch(r'[A-Za-z0-9_-]+', rid): raise ValueError('Invalid review ID')
    path = Path(path)
    previous = json.loads(path.read_text()) if path.exists() else {}
    if previous and (previous['review'] != rid or previous['url'] != url):
        raise ValueError('Use a separate watcher state file for each review and server')
    agent, detected = agent_session()
    state = {**previous, 'review': rid, 'url': url, 'author': author, 'token': uuid.uuid4().hex,
             'session': session or detected, 'seen': previous.get('seen', {})}
    # Agent kind and dirs let PrePR restart the right CLI. Runner passes its own.
    resume = resume or {'agent': agent if state['session'] == detected and detected else '', 'cwd': os.getcwd(),
                        'roots': [str(path.resolve().parent)]}
    result=api(url, '/api/reviews/'+rid+'/watch', {'action':'start', **{k:state[k] for k in ['token','author','session']}, **resume})
    save(path, state)
    return {**result, 'review':rid, 'url':url+'/?review='+rid}


def heartbeat(api, state):
    return api(state['url'], '/api/reviews/'+state['review']+'/watch', {'action':'heartbeat','token':state['token']})


def wait(api, path, timeout=45, interval=2):
    if not 0 <= timeout <= 50: raise ValueError('Watch timeout must be between 0 and 50 seconds')
    state = json.loads(Path(path).read_text())
    deadline = time.monotonic()+timeout
    while True:
        status = heartbeat(api, state)
        if status['status'] != 'watching': return status
        feedback = api(state['url'], '/api/reviews/'+state['review']+'/feedback')
        changes, observed = [], {}
        for thread in feedback['threads']:
            external = [m['id'] for m in thread['messages'] if m['author'] != state['author']]
            fingerprint = [thread['status'], external]
            observed[thread['id']] = fingerprint
            if thread['status']=='open' and external and state['seen'].get(thread['id']) != fingerprint:
                changes.append(thread)
        if changes:
            # Advance only after the working agent acknowledges this batch.
            state['pending'] = observed
            state['batch'] = [t['id'] for t in changes]
            save(path, state)
            set_activity(api, state, 'reply', state['batch'])
            return {'status':'comments','review':state['review'],'latestSnapshot':feedback['latestSnapshot'],'threads':changes}
        state['seen'] = observed
        save(path, state)
        remaining = deadline-time.monotonic()
        if remaining <= 0: return {'status':'waiting','review':state['review']}
        time.sleep(min(interval, remaining))


def set_activity(api, state, activity, threads=()):
    return api(state['url'], '/api/reviews/'+state['review']+'/watch', {'action':'activity','token':state['token'],'activity':activity,'threads':list(threads)})


def activity(api, path, kind, threads=None):
    # Shows agent work per thread; defaults to current batch.
    state = json.loads(Path(path).read_text())
    return set_activity(api, state, kind, threads or state.get('batch', []))


def acknowledge(path, api=None):
    state = json.loads(Path(path).read_text())
    if 'pending' not in state: raise ValueError('No comment batch to acknowledge')
    state['seen'] = state.pop('pending')
    state.pop('batch', None)
    save(path, state)
    result = {'status':'acknowledged'}
    if api: result['agent'] = set_activity(api, state, 'idle')['status']
    return result


def ship(api, path, action, result=None):
    state=json.loads(Path(path).read_text())
    current=heartbeat(api,state)
    if current['status']!='ship_requested': raise ValueError('No Ship it request for this working session')
    response=api(state['url'],'/api/reviews/'+state['review']+'/decision',
                 {'action':action,'token':state['token'],'request':current['decision']['id'],'result':result})
    if action=='claim':
        approved=Path(path).with_suffix('.ship.json');save(approved,response)
        # checks: recorded at publish as passed on this snapshot; verified worktree needs no rerun.
        return {'decision':response['decision'],'reconcile':response['reconcile'],'approvedSnapshotFile':str(approved.resolve()),
                'checks':response['payload'].get('checks',''),'repositories':[{k:v for k,v in r.items() if k!='files'} for r in response['payload']['repos']]}
    return response


def shipping_progress(api, path, stage, repo=None):
    state = json.loads(Path(path).read_text())
    request = json.loads(Path(path).with_suffix('.ship.json').read_text())['decision']['id']
    return api(state['url'], '/api/reviews/'+state['review']+'/decision',
               {'action':'progress', 'request':request, 'token':state['token'], 'repo':repo, 'stage':stage})


def verify_shipping(path, capture):
    approved=json.loads(Path(path).with_suffix('.ship.json').read_text())
    for stored in approved['payload']['repos']:
        spec={k:stored[k] for k in ['name','base','branch','include','exclude'] if k in stored}
        spec['path']=stored['source'];current=capture(spec)
        def files(repo):
            if any('newHash' not in f for f in repo['files']): raise ValueError('Snapshot lacks file hashes; cannot verify shipping scope')
            return {f['path']:(f.get('newHash'),f.get('newMode')) for f in repo['files']}
        if current['head']!=stored['head'] or files(current)!=files(stored):
            raise ValueError(f'{stored["name"]}: worktree changed after Ship it; stop and review the new changes')
    return {'status':'verified','request':approved['decision']['id']}
