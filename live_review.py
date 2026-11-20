"""Track live review ownership; no agent execution."""
import re
import time
import json
import uuid


def init(db):
    db.execute('CREATE TABLE IF NOT EXISTS review_watchers(review_id TEXT PRIMARY KEY REFERENCES reviews(id), token TEXT NOT NULL, author TEXT NOT NULL, session TEXT NOT NULL, updated REAL NOT NULL, stopped INTEGER NOT NULL DEFAULT 0)')
    columns = [row[1] for row in db.execute('PRAGMA table_info(review_watchers)')]
    # Agent activity: idle, reply or code, on listed threads.
    if 'activity' not in columns:
        db.execute("ALTER TABLE review_watchers ADD COLUMN activity TEXT NOT NULL DEFAULT 'idle'")
        db.execute("ALTER TABLE review_watchers ADD COLUMN activity_threads TEXT NOT NULL DEFAULT '[]'")
    # Resume info: agent kind, session, working dir, writable roots.
    if 'agent' not in columns:
        db.execute("ALTER TABLE review_watchers ADD COLUMN agent TEXT NOT NULL DEFAULT ''")
        db.execute("ALTER TABLE review_watchers ADD COLUMN cwd TEXT NOT NULL DEFAULT ''")
        db.execute("ALTER TABLE review_watchers ADD COLUMN roots TEXT NOT NULL DEFAULT '[]'")
    db.execute('CREATE TABLE IF NOT EXISTS review_decisions(review_id TEXT PRIMARY KEY REFERENCES reviews(id), id TEXT NOT NULL, snapshot_id INTEGER NOT NULL REFERENCES snapshots(id), action TEXT NOT NULL, status TEXT NOT NULL, result TEXT NOT NULL DEFAULT \'\', claimed_by TEXT)')
    # Keep renamed Close: migrate old rows.
    db.execute("UPDATE review_decisions SET action='close' WHERE action='keep'")
    db.execute("UPDATE review_decisions SET status='closed' WHERE status='kept'")


def decision(db, rid):
    row = db.execute('SELECT * FROM review_decisions WHERE review_id=?', (rid,)).fetchone()
    if row is None: return None
    return {k:row[k] for k in ['id','snapshot_id','action','status','result']}


def require_open(db, rid):
    if decision(db, rid): raise ValueError('Local review is closed; preserve its approved snapshot and use a new review for further changes')


def delete_review(db, rid):
    # Only completed reviews: closed, shipped or blocked.
    db.execute('UPDATE reviews SET updated=updated WHERE id=?', (rid,))
    if not db.execute('SELECT 1 FROM reviews WHERE id=?', (rid,)).fetchone(): raise LookupError('Review not found')
    closed = decision(db, rid)
    if not closed or closed['status'] not in ('closed', 'shipped', 'blocked'): raise ValueError('Only completed reviews can be deleted')
    remove(db, rid)
    return {'status': 'deleted'}


def remove(db, rid):
    # Drop review, snapshots, comments, watcher.
    snaps = 'SELECT id FROM snapshots WHERE review_id=?'
    db.execute(f'DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE snapshot_id IN ({snaps}))', (rid,))
    for table in ('threads', 'viewed'): db.execute(f'DELETE FROM {table} WHERE snapshot_id IN ({snaps})', (rid,))
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for table in ('review_decisions', 'review_watchers', 'agent_jobs'):
        if table in tables: db.execute(f'DELETE FROM {table} WHERE review_id=?', (rid,))
    db.execute('DELETE FROM snapshots WHERE review_id=?', (rid,))
    db.execute('DELETE FROM reviews WHERE id=?', (rid,))


def decide(db, rid, data):
    # Serialize decisions with ownership and publication.
    db.execute('UPDATE reviews SET updated=updated WHERE id=?', (rid,))
    latest = db.execute('SELECT max(id) FROM snapshots WHERE review_id=?', (rid,)).fetchone()[0]
    if latest is None: raise LookupError('Review not found')
    existing = decision(db, rid)
    action = data.get('action')
    if action == 'keep': action = 'close'  # old clients
    if action in ('close', 'ship'):
        # Ship needs displayed snapshot; Close archives latest.
        if action == 'ship' and data.get('snapshot') != latest: raise ValueError('Open the latest snapshot before closing this review')
        if existing:
            if existing['action'] == action and existing['snapshot_id'] == latest: return existing
            raise ValueError('Review already closed')
        db.execute('INSERT INTO review_decisions(review_id,id,snapshot_id,action,status) VALUES(?,?,?,?,?)',
                   (rid,uuid.uuid4().hex,latest,action,'closed' if action=='close' else 'requested'))
        db.execute('UPDATE review_watchers SET stopped=1 WHERE review_id=?', (rid,))
        return decision(db, rid)
    if action == 'sent':
        # PRs sent from chat, not Ship it button: record result. Upgrades closed.
        result = data.get('result')
        if not isinstance(result, str) or not 1 <= len(result.strip()) <= 4000: raise ValueError('PR result required')
        if existing and existing['status'] in ('requested', 'preparing'): raise ValueError('Ship it in progress; record result with ship-result')
        if existing and existing['status'] != 'closed': raise ValueError('Review already ' + existing['status'])
        db.execute('INSERT OR REPLACE INTO review_decisions(review_id,id,snapshot_id,action,status,result) VALUES(?,?,?,?,?,?)',
                   (rid, uuid.uuid4().hex, latest, 'ship', 'shipped', result.strip()))
        db.execute('UPDATE review_watchers SET stopped=1 WHERE review_id=?', (rid,))
        return decision(db, rid)
    if not existing or existing['action'] != 'ship': raise ValueError('No Ship it request for this review')
    owner = db.execute('SELECT token FROM review_watchers WHERE review_id=?', (rid,)).fetchone()
    if owner is None or owner['token'] != data.get('token'): raise ValueError('Only the attached working agent can handle this request')
    if data.get('request') != existing['id']: raise ValueError('Ship request changed')
    if action == 'claim':
        if existing['status'] not in ('requested','preparing'): raise ValueError('Ship request already finished')
        db.execute("UPDATE review_decisions SET status='preparing',claimed_by=? WHERE review_id=?", (owner['token'],rid))
        payload = json.loads(db.execute('SELECT payload FROM snapshots WHERE id=?', (existing['snapshot_id'],)).fetchone()[0])
        return {'decision':decision(db,rid),'reconcile':existing['status']=='preparing','payload':payload}
    if action in ('complete', 'block'):
        row = db.execute('SELECT claimed_by FROM review_decisions WHERE review_id=?', (rid,)).fetchone()
        if existing['status'] != 'preparing' or row['claimed_by'] != owner['token']: raise ValueError('Claim the request before recording a result')
        result = data.get('result','')
        if not isinstance(result,str) or not 1 <= len(result.strip()) <= 10000: raise ValueError('Provide PR links or the blocking reason')
        db.execute('UPDATE review_decisions SET status=?,result=? WHERE review_id=?', ('shipped' if action=='complete' else 'blocked',result.strip(),rid))
        return decision(db,rid)
    raise ValueError('Invalid review decision')


def watcher(db, rid):
    row = db.execute('SELECT * FROM review_watchers WHERE review_id=?', (rid,)).fetchone()
    if row is None: return None
    active = not row['stopped'] and row['updated'] > time.time()-120 and not decision(db,rid)
    resumable = row['agent'] in ('codex', 'claude') and bool(row['session'])
    return {'author': row['author'], 'active': active, 'activity': row['activity'] if active else 'idle',
            'threads': json.loads(row['activity_threads']) if active else [], 'agent': row['agent'], 'resumable': resumable}


def resume_target(db, rid):
    # Host starts or resumes; page never receives session IDs.
    snapshot = db.execute('SELECT payload FROM snapshots WHERE review_id=? ORDER BY id DESC LIMIT 1', (rid,)).fetchone()
    if snapshot is None: raise LookupError('Review not found')
    closed = decision(db, rid)
    if closed and closed['status'] not in ('requested', 'preparing'): raise ValueError('Review already completed')
    payload = json.loads(snapshot['payload'])
    repos = [{k:r[k] for k in ('name', 'source', 'branch', 'base', 'include', 'exclude') if k in r} for r in payload['repos']]
    roots = list(dict.fromkeys(r['source'] for r in repos if r.get('source', '').startswith('/')))
    if not roots: raise ValueError('Review has no local repository paths')
    row = db.execute('SELECT * FROM review_watchers WHERE review_id=?', (rid,)).fetchone()
    saved = row is not None and row['agent'] in ('codex', 'claude') and bool(row['session'])
    return {'author': row['author'] if saved else 'Codex', 'agent': row['agent'] if saved else 'codex',
            'session': row['session'] if saved else '', 'cwd': row['cwd'] if saved and row['cwd'] else roots[0],
            'roots': list(dict.fromkeys(roots + (json.loads(row['roots']) if saved else []))),
            'active': bool(row is not None and watcher(db, rid)['active']), 'decision': closed,
            'review': {'id': rid, 'title': payload.get('title', rid), 'description': payload.get('description', ''), 'repos': repos}}


def resume_info(data):
    # Validate resume fields; empty when agent unknown.
    agent, session, cwd, roots = data.get('agent', ''), data.get('session', ''), data.get('cwd', ''), data.get('roots', [])
    if agent not in ('', 'codex', 'claude'): raise ValueError('Invalid agent')
    if agent and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{7,99}', session or ''): raise ValueError('Invalid session reference')
    path = lambda p: isinstance(p, str) and p.startswith('/') and len(p) <= 500 and '\0' not in p
    if cwd and not path(cwd): raise ValueError('Invalid working directory')
    if not isinstance(roots, list) or len(roots) > 20 or not all(path(r) for r in roots): raise ValueError('Invalid writable roots')
    return agent, cwd, json.dumps(roots)


def watch(db, rid, data):
    # Serialize watcher ownership.
    db.execute('UPDATE review_watchers SET updated=updated WHERE review_id=?', (rid,))
    if not db.execute('SELECT 1 FROM reviews WHERE id=?', (rid,)).fetchone():
        # Deleted after completion; tell watcher.
        if data.get('action') == 'heartbeat': return {'status': 'closed', 'removed': True}
        raise LookupError('Review not found')
    row = db.execute('SELECT * FROM review_watchers WHERE review_id=?', (rid,)).fetchone()
    action = data.get('action')
    if action == 'stop':
        if data.get('token') and (row is None or row['token'] != data['token']): return {'status': 'replaced'}
        db.execute('UPDATE review_watchers SET stopped=1 WHERE review_id=?', (rid,))
        return {'status': 'stopped'}
    token = data.get('token', '')
    if not isinstance(token, str) or not re.fullmatch(r'[a-f0-9]{32}', token): raise ValueError('Invalid watcher token')
    active = watcher(db, rid)
    if action == 'start':
        if active and active['active'] and row['token'] != token: raise ValueError('Another working agent is watching this review')
        author, session = data.get('author', ''), data.get('session', '')
        if not isinstance(author, str) or not 1 <= len(author.strip()) <= 100: raise ValueError('Invalid watcher author')
        if not isinstance(session, str) or len(session)>200: raise ValueError('Invalid session reference')
        agent, cwd, roots = resume_info(data)
        db.execute("INSERT OR REPLACE INTO review_watchers(review_id,token,author,session,updated,stopped,activity,activity_threads,agent,cwd,roots) VALUES(?,?,?,?,?,0,'idle','[]',?,?,?)", (rid,token,author.strip(),session,time.time(),agent,cwd,roots))
    elif action in ('heartbeat', 'activity'):
        if row is None or row['token'] != token: return {'status': 'replaced'}
        closed = decision(db,rid)
        if closed: return {'status':'closed' if closed['action']=='close' else 'ship_requested', 'decision':closed}
        if row['stopped']: return {'status': 'stopped'}
        if not active['active']: return {'status': 'expired'}
        if action == 'activity':
            activity, threads = data.get('activity'), data.get('threads', [])
            if activity not in ('idle', 'reply', 'code'): raise ValueError('Invalid agent activity')
            if not isinstance(threads, list) or len(threads) > 200 or not all(isinstance(t, str) and re.fullmatch(r'[a-f0-9]{1,64}', t) for t in threads):
                raise ValueError('Invalid activity threads')
            db.execute('UPDATE review_watchers SET activity=?,activity_threads=? WHERE review_id=?', (activity, json.dumps([] if activity == 'idle' else threads), rid))
        db.execute('UPDATE review_watchers SET updated=? WHERE review_id=?', (time.time(),rid))
    else: raise ValueError('Invalid watcher action')
    closed = decision(db,rid)
    if closed:
        db.execute('UPDATE review_watchers SET stopped=1 WHERE review_id=?',(rid,))
        return {'status':'closed' if closed['action']=='close' else 'ship_requested','decision':closed}
    return {'status': 'watching'}


