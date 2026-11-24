"""Local immutable diffs and persistent review threads. Standard library only."""
import difflib
import hashlib
import json
import os
import re
import sqlite3
import uuid
import live_review
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

DATA = Path(os.environ.get('PREPR_DATA', Path(__file__).parent / '.local/data'))
STATIC = Path(__file__).parent / 'static'
MAX_BODY = 32 * 1024 * 1024


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def connect():
    conn = sqlite3.connect(DATA / 'reviews.sqlite', timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys=ON')
    return conn


@contextmanager
def session():
    db = connect()
    try:
        with db:
            yield db
    finally:
        db.close()


def init():
    DATA.mkdir(parents=True, exist_ok=True)
    with session() as db:
        db.executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, updated TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS snapshots(id INTEGER PRIMARY KEY, review_id TEXT NOT NULL REFERENCES reviews(id), fingerprint TEXT NOT NULL, created TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, snapshot_id INTEGER NOT NULL REFERENCES snapshots(id), repo TEXT NOT NULL, path TEXT NOT NULL, side TEXT NOT NULL, line INTEGER NOT NULL, code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), author TEXT NOT NULL, body TEXT NOT NULL, created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS viewed(snapshot_id INTEGER NOT NULL REFERENCES snapshots(id), repo TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(snapshot_id,repo,path));
        ''')
        live_review.init(db)
        if 'deleted' not in [row[1] for row in db.execute('PRAGMA table_info(messages)')]:
            db.execute('ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0')


def required_text(data, key, limit=200):
    value = data.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError(f'{key} must contain 1–{limit} characters')
    return value.strip()


def snapshot(db, sid):
    row = db.execute('SELECT * FROM snapshots WHERE id=?', (sid,)).fetchone()
    if row is None:
        raise LookupError('Snapshot not found')
    return row, json.loads(row['payload'])


def file_in(payload, repo, path):
    for r in payload['repos']:
        if r['name'] == repo:
            for f in r['files']:
                if f['path'] == path:
                    return f
    raise LookupError('File not found in snapshot')


def threads(db, review):
    result = []
    rows = db.execute('''SELECT t.* FROM threads t JOIN snapshots s ON s.id=t.snapshot_id
                         WHERE s.review_id=? ORDER BY t.created,t.id''', (review,))
    for row in rows:
        thread = dict(row)
        thread['messages'] = [dict(m) for m in db.execute('SELECT id,thread_id,author,body,created FROM messages WHERE thread_id=? AND deleted=0 ORDER BY id', (row['id'],))]
        if thread['messages']: result.append(thread)
    return result


def diff_rows(old, new):
    a, b = (old or '').splitlines(), (new or '').splitlines()
    blocks = []
    for group in difflib.SequenceMatcher(None, a, b, autojunk=False).get_grouped_opcodes(4):
        rows = []
        for tag, i, end_i, j, end_j in group:
            for offset in range(max(end_i-i, end_j-j)):
                left = {'number': i+offset+1, 'text': a[i+offset]} if i+offset < end_i else None
                right = {'number': j+offset+1, 'text': b[j+offset]} if j+offset < end_j else None
                rows.append({'kind': tag, 'old': left, 'new': right})
        blocks.append({'oldStart': group[0][1]+1, 'newStart': group[0][3]+1, 'rows': rows})
    return blocks


def validate_payload(data):
    review_id = required_text(data, 'id', 100)
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]*', review_id):
        raise ValueError('Use letters, digits, hyphens or underscores for review id')
    required_text(data, 'title', 300)
    if not isinstance(data.get('description', ''), str) or len(data.get('description', '')) > 10000:
        raise ValueError('Description too long')
    if not isinstance(data.get('checks', ''), str) or len(data.get('checks', '')) > 10000:
        raise ValueError('Checks record too long')
    repos = data.get('repos')
    if not isinstance(repos, list) or not 1 <= len(repos) <= 50:
        raise ValueError('Provide 1–50 repositories')
    names = set()
    count = 0
    for r in repos:
        name = required_text(r, 'name')
        if name in names:
            raise ValueError('Duplicate repository name')
        names.add(name)
        for key in ('branch', 'base', 'head', 'source'):
            required_text(r, key, 2000)
        if not isinstance(r.get('files'), list):
            raise ValueError('Missing files')
        if not isinstance(r.get('commits', []), list):
            raise ValueError('Commits must be a list')
        paths = set()
        for f in r['files']:
            path = required_text(f, 'path', 4000)
            if path in paths:
                raise ValueError('Duplicate file path')
            paths.add(path)
            if f.get('status') not in ('A', 'M', 'D', 'R', 'C', 'T'):
                raise ValueError('Invalid file status')
            for side in ('old', 'new'):
                text = f.get(side)
                if text is not None and (not isinstance(text, str) or len(text.encode()) > 1024*1024):
                    raise ValueError('File exceeds 1 MiB text limit')
            count += 1
    if count > 3000:
        raise ValueError('Too many files; narrow the review scope')


def publish(db, data):
    validate_payload(data)
    db.execute('UPDATE reviews SET updated=updated WHERE id=?', (data['id'],))
    payload = json.dumps(data, sort_keys=True, separators=(',', ':'))
    fingerprint = hashlib.sha256(payload.encode()).hexdigest()
    last = db.execute('SELECT id,fingerprint,payload FROM snapshots WHERE review_id=? ORDER BY id DESC LIMIT 1', (data['id'],)).fetchone()
    if last and last['fingerprint'] == fingerprint:
        return {'review': data['id'], 'snapshot': last['id'], 'unchanged': True}
    if last and not data.get('checks'):
        # Same bytes again, no record this time: snapshot and its checks record stay.
        previous = json.loads(last['payload'])
        if previous.pop('checks', None) and previous == {k: v for k, v in data.items() if k != 'checks'}:
            return {'review': data['id'], 'snapshot': last['id'], 'unchanged': True}
    live_review.require_open(db,data['id'])
    stamp = now()
    db.execute('''INSERT INTO reviews VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                  title=excluded.title,description=excluded.description,updated=excluded.updated''',
               (data['id'], data['title'], data.get('description', ''), stamp))
    sid = db.execute('INSERT INTO snapshots(review_id,fingerprint,created,payload) VALUES(?,?,?,?)',
                     (data['id'], fingerprint, stamp, payload)).lastrowid
    if last:
        carry_viewed(db, last['id'], sid, data)
    return {'review': data['id'], 'snapshot': sid, 'unchanged': False}


def file_signature(f):
    return [f.get(k) for k in ('status', 'oldRepo', 'oldPath', 'old', 'new', 'oldMode', 'newMode', 'oldHash', 'newHash', 'movedTo')]


def carry_viewed(db, previous, sid, data):
    # Viewed carries forward only for byte-identical file entries.
    before = {(r['name'], f['path']): file_signature(f) for r in snapshot(db, previous)[1]['repos'] for f in r['files']}
    after = {(r['name'], f['path']): file_signature(f) for r in data['repos'] for f in r['files']}
    for row in db.execute('SELECT repo,path FROM viewed WHERE snapshot_id=?', (previous,)).fetchall():
        k = (row['repo'], row['path'])
        if k in after and after[k] == before.get(k):
            db.execute('INSERT OR IGNORE INTO viewed VALUES(?,?,?)', (sid, row['repo'], row['path']))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def send(self, status, value, mime='application/json'):
        body = json.dumps(value, ensure_ascii=False).encode() if mime == 'application/json' else value
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self' vscode-webview: vscode-file:; base-uri 'none'; form-action 'self'")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.handle_request('GET')

    def do_POST(self):
        self.handle_request('POST')

    def do_PATCH(self):
        self.handle_request('PATCH')

    def do_DELETE(self):
        self.handle_request('DELETE')

    def handle_request(self, method):
        try:
            host = self.headers.get('Host', '')
            if urlsplit('http://' + host).hostname not in ('localhost', '127.0.0.1', '::1'):
                self.send(403, {'error': 'Local access only'})
                return
            origin = self.headers.get('Origin')
            if origin and origin != 'http://' + host:
                self.send(403, {'error': 'Cross-origin request rejected'})
                return
            url = urlsplit(self.path)
            path = url.path
            query = parse_qs(url.query)
            data = {}
            if method != 'GET':
                if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                    raise ValueError('JSON body required')
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= MAX_BODY:
                    raise ValueError('Request body must be between 1 byte and 32 MiB')
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict):
                    raise ValueError('JSON object required')
            with session() as db:
                result = self.route(db, method, path, query, data)
            if result is not None:
                self.send(200, result)
        except (ValueError, TypeError, KeyError) as exc:
            self.send(400, {'error': str(exc)})
        except LookupError as exc:
            self.send(404, {'error': str(exc)})
        except Exception:
            import traceback
            traceback.print_exc()
            self.send(500, {'error': 'Server error; check container logs'})

    def route(self, db, method, path, query, data):
        message_match = re.fullmatch(r'/api/messages/(\d+)', path)
        if message_match and method == 'DELETE':
            db.execute('UPDATE messages SET deleted=deleted WHERE id=?',(message_match[1],))
            row=db.execute('SELECT s.review_id FROM messages m JOIN threads t ON t.id=m.thread_id JOIN snapshots s ON s.id=t.snapshot_id WHERE m.id=?',(message_match[1],)).fetchone()
            if row is None: raise LookupError('Comment not found')
            live_review.require_open(db,row['review_id'])
            db.execute('UPDATE messages SET deleted=1 WHERE id=?',(message_match[1],))
            return {'ok':True}
        delete_match = re.fullmatch(r'/api/reviews/([A-Za-z0-9_-]+)', path)
        if delete_match and method == 'DELETE':
            return live_review.delete_review(db, delete_match[1])
        decision_match = re.fullmatch(r'/api/reviews/([A-Za-z0-9_-]+)/decision', path)
        if decision_match and method == 'POST':
            return live_review.decide(db,decision_match[1],data)
        resume_match = re.fullmatch(r'/api/reviews/([A-Za-z0-9_-]+)/resume', path)
        if resume_match and method == 'GET': return live_review.resume_target(db, resume_match[1])
        if resume_match and method == 'POST': return live_review.start(db, resume_match[1], data)
        if method == 'GET' and path == '/api/resume-requests': return live_review.pending_starts(db)
        watch_match = re.fullmatch(r'/api/reviews/([A-Za-z0-9_-]+)/watch', path)
        if watch_match:
            if method == 'POST': return live_review.watch(db, watch_match[1], data)
            if method == 'GET':
                rid = watch_match[1]
                latest = db.execute('SELECT max(id) FROM snapshots WHERE review_id=?', (rid,)).fetchone()[0]
                return {'watcher': live_review.watcher(db, rid), 'decision': live_review.decision(db, rid),
                        'start': live_review.start_status(db, rid), 'latestSnapshot': latest}
        if method == 'GET' and path == '/api/health':
            return {'ok': True}
        assets = {
            '/submission.js': 'submission.js', '/live-review.js': 'live-review.js', '/extra-grammars.js': 'extra-grammars.js', '/languages.js': 'languages.js', '/highlight.js': 'highlight.js',
            '/highlight-worker.js': 'highlight-worker.js', '/vendor/shiki.js': 'vendor/shiki.js',
        }
        if method == 'GET' and path in assets:
            self.send(200, (STATIC / assets[path]).read_bytes(), 'text/javascript; charset=utf-8')
            return None
        if method == 'GET' and path in ('/', '/app.js', '/style.css'):
            name, mime = {'/': ('index.html', 'text/html; charset=utf-8'), '/app.js': ('app.js', 'text/javascript; charset=utf-8'), '/style.css': ('style.css', 'text/css; charset=utf-8')}[path]
            self.send(200, (STATIC / name).read_bytes(), mime)
            return None
        if path == '/api/reviews':
            if method == 'POST':
                return publish(db, data)
            if method == 'GET':
                return [{**dict(row),'decision':live_review.decision(db,row['id'])} for row in db.execute('''SELECT r.*, (SELECT max(id) FROM snapshots WHERE review_id=r.id) AS latest,
                       (SELECT count(*) FROM threads t JOIN snapshots s ON s.id=t.snapshot_id WHERE s.review_id=r.id AND t.status='open' AND EXISTS(SELECT 1 FROM messages m WHERE m.thread_id=t.id AND m.deleted=0)) AS openThreads
                       FROM reviews r ORDER BY updated DESC''')]
        match = re.fullmatch(r'/api/reviews/([A-Za-z0-9_-]+)', path)
        if match and method == 'GET':
            rid = match[1]
            review = db.execute('SELECT * FROM reviews WHERE id=?', (rid,)).fetchone()
            if review is None:
                raise LookupError('Review not found')
            versions = [dict(row) for row in db.execute('SELECT id,created FROM snapshots WHERE review_id=? ORDER BY id DESC', (rid,))]
            sid = int(query.get('snapshot', [versions[0]['id']])[0])
            row, payload = snapshot(db, sid)
            if row['review_id'] != rid:
                raise LookupError('Snapshot not in this review')
            repos = []
            for r in payload['repos']:
                brief = {k:v for k,v in r.items() if k != 'files'}
                brief['files'] = [{k:v for k,v in f.items() if k not in ('old', 'new', 'blocks')} for f in r['files']]
                repos.append(brief)
            viewed = [dict(row) for row in db.execute('SELECT repo,path FROM viewed WHERE snapshot_id=?', (sid,))]
            return {**dict(review), 'decision':live_review.decision(db,rid), 'snapshot': sid, 'snapshots': versions, 'checks': payload.get('checks', ''), 'repos': repos, 'threads': threads(db, rid), 'viewed': viewed}
        match = re.fullmatch(r'/api/reviews/([A-Za-z0-9_-]+)/feedback', path)
        if match and method == 'GET':
            latest = db.execute('SELECT max(id) FROM snapshots WHERE review_id=?', (match[1],)).fetchone()[0]
            if latest is None:
                raise LookupError('Review not found')
            return {'review': match[1], 'latestSnapshot': latest, 'threads': threads(db, match[1])}
        match = re.fullmatch(r'/api/snapshots/(\d+)/file', path)
        if match and method == 'GET':
            _, payload = snapshot(db, int(match[1]))
            f = file_in(payload, query.get('repo', [''])[0], query.get('path', [''])[0])
            return {**f, 'blocks': f['blocks'] if 'blocks' in f else diff_rows(f['old'], f['new'])}
        if path == '/api/threads' and method == 'POST':
            sid = int(data['snapshot'])
            _, payload = snapshot(db, sid)
            live_review.require_open(db,payload['id'])
            f = file_in(payload, data['repo'], data['path'])
            side, line = data['side'], data['line']
            if side == 'file' and type(line) is int and line == 0:
                code = ''
            else:
                if side not in ('old', 'new') or type(line) is not int or f[side] is None:
                    raise ValueError('Invalid comment anchor')
                lines = f[side].splitlines()
                if not 1 <= line <= len(lines):
                    raise ValueError('Line not in file')
                code = lines[line-1]
            tid = uuid.uuid4().hex[:16]
            author, body = required_text(data, 'author', 100), required_text(data, 'body', 20000)
            db.execute('INSERT INTO threads(id,snapshot_id,repo,path,side,line,code,created) VALUES(?,?,?,?,?,?,?,?)',
                       (tid, sid, data['repo'], data['path'], side, line, code, now()))
            db.execute('INSERT INTO messages(thread_id,author,body,created) VALUES(?,?,?,?)', (tid, author, body, now()))
            return {'id': tid}
        match = re.fullmatch(r'/api/threads/([a-f0-9]+)/?(messages)?', path)
        if match:
            tid = match[1]
            if not db.execute('SELECT 1 FROM threads WHERE id=?', (tid,)).fetchone():
                raise LookupError('Thread not found')
            rid = db.execute('SELECT s.review_id FROM threads t JOIN snapshots s ON s.id=t.snapshot_id WHERE t.id=?',(tid,)).fetchone()[0]
            live_review.require_open(db,rid)
            if not db.execute('SELECT 1 FROM messages WHERE thread_id=? AND deleted=0',(tid,)).fetchone():
                raise LookupError('Thread deleted')
            if method == 'POST' and match[2] == 'messages':
                author, body = required_text(data, 'author', 100), required_text(data, 'body', 20000)
                db.execute('INSERT INTO messages(thread_id,author,body,created) VALUES(?,?,?,?)', (tid, author, body, now()))
                return {'ok': True}
            if method == 'PATCH' and not match[2]:
                if data.get('status') not in ('open', 'resolved'):
                    raise ValueError('Invalid thread status')
                db.execute('UPDATE threads SET status=? WHERE id=?', (data['status'], tid))
                return {'ok': True}
        match = re.fullmatch(r'/api/snapshots/(\d+)/viewed', path)
        if match and method == 'POST':
            sid = int(match[1])
            _, payload = snapshot(db, sid)
            file_in(payload, data['repo'], data['path'])
            if data.get('viewed'):
                db.execute('INSERT OR IGNORE INTO viewed VALUES(?,?,?)', (sid, data['repo'], data['path']))
            else:
                db.execute('DELETE FROM viewed WHERE snapshot_id=? AND repo=? AND path=?', (sid, data['repo'], data['path']))
            return {'ok': True}
        raise LookupError('Not found')


if __name__ == '__main__':
    init()
    ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('PORT', '8080'))), Handler).serve_forever()
