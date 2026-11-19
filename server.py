"""Local immutable diffs and persistent review threads. Standard library only."""
import difflib
import hashlib
import json
import os
import re
import sqlite3
import uuid
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
        thread['messages'] = [dict(m) for m in db.execute('SELECT * FROM messages WHERE thread_id=? ORDER BY id', (row['id'],))]
        result.append(thread)
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
    payload = json.dumps(data, sort_keys=True, separators=(',', ':'))
    fingerprint = hashlib.sha256(payload.encode()).hexdigest()
    last = db.execute('SELECT id,fingerprint FROM snapshots WHERE review_id=? ORDER BY id DESC LIMIT 1', (data['id'],)).fetchone()
    if last and last['fingerprint'] == fingerprint:
        return {'review': data['id'], 'snapshot': last['id'], 'unchanged': True}
    stamp = now()
    db.execute('''INSERT INTO reviews VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                  title=excluded.title,description=excluded.description,updated=excluded.updated''',
               (data['id'], data['title'], data.get('description', ''), stamp))
    sid = db.execute('INSERT INTO snapshots(review_id,fingerprint,created,payload) VALUES(?,?,?,?)',
                     (data['id'], fingerprint, stamp, payload)).lastrowid
    return {'review': data['id'], 'snapshot': sid, 'unchanged': False}


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
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.handle_request('GET')

    def do_POST(self):
        self.handle_request('POST')

    def do_PATCH(self):
        self.handle_request('PATCH')

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
        if method == 'GET' and path == '/api/health':
            return {'ok': True}
        if method == 'GET' and path in ('/', '/app.js', '/style.css'):
            name, mime = {'/': ('index.html', 'text/html; charset=utf-8'), '/app.js': ('app.js', 'text/javascript; charset=utf-8'), '/style.css': ('style.css', 'text/css; charset=utf-8')}[path]
            self.send(200, (STATIC / name).read_bytes(), mime)
            return None
        if path == '/api/reviews':
            if method == 'POST':
                return publish(db, data)
            if method == 'GET':
                return [dict(row) for row in db.execute('''SELECT r.*, (SELECT max(id) FROM snapshots WHERE review_id=r.id) AS latest,
                       (SELECT count(*) FROM threads t JOIN snapshots s ON s.id=t.snapshot_id WHERE s.review_id=r.id AND t.status='open') AS openThreads
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
            return {**dict(review), 'snapshot': sid, 'snapshots': versions, 'repos': repos, 'threads': threads(db, rid), 'viewed': viewed}
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
