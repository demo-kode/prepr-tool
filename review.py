#!/usr/bin/env python3
"""Publish Git snapshots; read and answer local review feedback."""
import argparse
import difflib
import fnmatch
import hashlib
import json
import os
import re
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from urllib.parse import urlsplit

LIMIT = 1024 * 1024


def git_blocks(old, new):
    """Diff exact Git/worktree text with Git's histogram algorithm."""
    if old is None or new is None:
        return [], 0, 0
    with tempfile.TemporaryDirectory(prefix='prepr-diff-') as directory:
        before, after = Path(directory)/'before', Path(directory)/'after'
        before.write_bytes(old.encode()); after.write_bytes(new.encode())
        result = subprocess.run(['git', 'diff', '--no-index', '--no-ext-diff', '--no-textconv',
                                 '--histogram', '--unified=4', '--', str(before), str(after)], capture_output=True)
    if result.returncode not in (0, 1):
        raise ValueError(result.stderr.decode(errors='replace'))
    blocks, removed, added = [], 0, 0
    block = None
    left, right = [], []
    def flush():
        if block is None:
            return
        for i in range(max(len(left), len(right))):
            block['rows'].append({'kind': 'replace', 'old': left[i] if i < len(left) else None,
                                  'new': right[i] if i < len(right) else None})
        left.clear(); right.clear()
    for line in result.stdout.decode().splitlines():
        match = re.match(r'^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@', line)
        if match:
            flush()
            a, b = map(int, match.groups())
            block = {'oldStart': a, 'newStart': b, 'rows': []}
            blocks.append(block)
        elif block is not None and line.startswith('-'):
            left.append({'number': a, 'text': line[1:]}); a += 1; removed += 1
        elif block is not None and line.startswith('+'):
            right.append({'number': b, 'text': line[1:]}); b += 1; added += 1
        elif block is not None and line.startswith(' '):
            flush()
            block['rows'].append({'kind': 'equal', 'old': {'number': a, 'text': line[1:]},
                                  'new': {'number': b, 'text': line[1:]}})
            a += 1; b += 1
    flush()
    return blocks, added, removed


def prepare_comparisons(repos, comparisons=()):
    """Pair moves conservatively; explicit mappings also support retained sources."""
    by_name = {r['name']: r for r in repos}
    additions = [(r, f) for r in repos for f in r['files'] if f['status'] == 'A']
    deletions = [(r, f) for r in repos for f in r['files'] if f['status'] == 'D']
    paired = set()

    def pair(dest_repo, dest, source_repo, source, explicit=False):
        dest['gitStatus'] = dest['status']
        dest['status'] = 'R' if source.get('status') == 'D' else 'C'
        dest['old'] = source['old']
        dest['oldHash'] = source['oldHash']
        dest['oldMode'] = source['oldMode']
        dest['oldPath'] = source['path']
        dest['oldRepo'] = source_repo['name']
        dest['oldBase'] = source_repo['base']
        dest['comparison'] = 'explicit' if explicit else 'detected-move'
        if source.get('status') == 'D':
            source['movedTo'] = {'repo': dest_repo['name'], 'path': dest['path']}
            paired.add((source_repo['name'], source['path']))

    for mapping in comparisons:
        dest_repo, source_repo = by_name[mapping['repo']], by_name[mapping['fromRepo']]
        dest = next((f for f in dest_repo['files'] if f['path'] == mapping['path']), None)
        if dest is None or dest['status'] != 'A':
            raise ValueError(f'Comparison destination must be an added file: {mapping["path"]}')
        source_path = mapping['fromPath']
        source = next((f for f in source_repo['files'] if f['path'] == source_path), None)
        if source is None:
            raw = git(source_repo['source'], 'show', f'{source_repo["base"]}:{source_path}')
            text, digest, note = decode_content(raw)
            if text is None:
                raise ValueError(f'Comparison source is not reviewable text: {source_path}')
            source = {'path':source_path, 'old':text, 'oldHash':digest, 'oldMode':'100644'}
        if source['old'] is None:
            raise ValueError(f'Comparison source is not reviewable text: {source_path}')
        pair(dest_repo, dest, source_repo, source, True)

    for dest_repo, dest in additions:
        if dest['status'] != 'A' or not dest['new']:
            continue
        choices = []
        for source_repo, source in deletions:
            if (source_repo['name'], source['path']) in paired or not source['old']:
                continue
            same = source['oldHash'] == dest['newHash']
            if not same and Path(source['path']).name != Path(dest['path']).name:
                continue
            ratio = 1 if same else difflib.SequenceMatcher(None, source['old'].splitlines(), dest['new'].splitlines()).ratio()
            if ratio >= .6:
                choices.append((ratio, source_repo, source))
        choices.sort(key=lambda item: item[0], reverse=True)
        if choices and (len(choices) == 1 or choices[0][0] > choices[1][0] + .05):
            _, source_repo, source = choices[0]
            pair(dest_repo, dest, source_repo, source)

    for repo in repos:
        for f in repo['files']:
            if f.get('movedTo'):
                f['blocks'], f['added'], f['removed'] = [], 0, 0
            else:
                f['blocks'], f['added'], f['removed'] = git_blocks(f['old'], f['new'])
            f['diffEngine'] = 'git-histogram'
    return repos


def git(repo, *args):
    result = subprocess.run(['git', '-C', str(repo), '-c', 'core.quotepath=false', *args], capture_output=True)
    if result.returncode:
        raise ValueError(result.stderr.decode(errors='replace').strip())
    return result.stdout


def decode_content(raw, kind='file'):
    digest = hashlib.sha256(raw).hexdigest()
    if len(raw) > LIMIT:
        return None, digest, 'Too large for inline review (over 1 MiB)'
    if b'\0' in raw or kind == 'submodule':
        return None, digest, 'Binary file or submodule; text diff unavailable'
    try:
        return raw.decode('utf-8'), digest, ''
    except UnicodeDecodeError:
        return None, digest, 'Non-UTF-8 file; text diff unavailable'


def working_bytes(repo, path):
    target = repo / path
    # Never follow repository symlinks outside the snapshot.
    for parent in target.parents:
        if parent == repo:
            break
        if parent.is_symlink():
            raise ValueError(f'Symlink parent cannot be snapshotted: {path}')
    try:
        mode = target.lstat().st_mode
    except FileNotFoundError:
        return b'', 'missing', ''
    if stat.S_ISLNK(mode):
        return os.readlink(target).encode(), 'symlink', '120000'
    if stat.S_ISDIR(mode):
        return git(target, 'rev-parse', 'HEAD'), 'submodule', '160000'
    if not stat.S_ISREG(mode):
        raise ValueError(f'Not a regular file: {path}')
    return target.read_bytes(), 'file', '100755' if mode & stat.S_IXUSR else '100644'


EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
COMMIT_LIMIT = 200


def in_scope(spec, path, old_path=''):
    if spec.get('include') and not any(fnmatch.fnmatchcase(path, p) or fnmatch.fnmatchcase(old_path, p) for p in spec['include']):
        return False
    return not any(fnmatch.fnmatchcase(path, p) for p in spec.get('exclude', []))


def name_status(raw):
    # -z name-status: STATUS\0path\0 or R/C: STATUS\0old\0new\0.
    fields, pos, result = raw.split(b'\0'), 0, []
    while pos < len(fields) and fields[pos]:
        status = fields[pos].decode()[0]
        old_path = fields[pos+1].decode(); pos += 2
        path = old_path
        if status in ('R', 'C'):
            path = fields[pos].decode(); pos += 1
        result.append((status, old_path, path))
    return result


def numstat(raw):
    # -z numstat: A\tR\tpath\0 or renames A\tR\t\0old\0new\0; binary uses '-'.
    fields, pos, result = raw.split(b'\0'), 0, {}
    while pos < len(fields) and fields[pos]:
        added, removed, path = fields[pos].decode().split('\t', 2); pos += 1
        if not path:
            path = fields[pos+1].decode(); pos += 2
        result[path] = (int(added) if added != '-' else 0, int(removed) if removed != '-' else 0)
    return result


def capture_commits(repo, base, head, spec):
    # Commits base..head; files limited to review scope. Name only, no email.
    raw = git(repo, 'log', f'--max-count={COMMIT_LIMIT+1}', '--format=%H%x1f%P%x1f%an%x1f%aI%x1f%B%x1e', f'{base}..{head}')
    commits = []
    for record in raw.decode('utf-8', 'replace').split('\x1e'):
        record = record.strip('\n')
        if not record:
            continue
        sha, parents, author, date, message = record.split('\x1f', 4)
        parent = (parents.split() or [EMPTY_TREE])[0]
        stats = numstat(git(repo, 'diff', '--no-ext-diff', '--no-textconv', '-z', '-M', '--numstat', parent, sha))
        files, hidden = [], 0
        for status, old_path, path in name_status(git(repo, 'diff', '--no-ext-diff', '-z', '-M', '--name-status', parent, sha)):
            if not in_scope(spec, path, old_path):
                hidden += 1
                continue
            added, removed = stats.get(path, (0, 0))
            files.append({'path':path, 'oldPath':old_path, 'status':status, 'added':added, 'removed':removed})
        subject, _, body = message.strip().partition('\n')
        commits.append({'sha':sha, 'author':author, 'date':date, 'subject':subject, 'body':body.strip(),
                        'merge':len(parents.split()) > 1, 'files':files, 'hiddenFiles':hidden})
    return commits[:COMMIT_LIMIT], len(commits) > COMMIT_LIMIT


def capture_repository(spec):
    repo = Path(spec['path']).expanduser().resolve()
    root = Path(git(repo, 'rev-parse', '--show-toplevel').decode().strip()).resolve()
    if root != repo:
        raise ValueError(f'Repository path must name its Git root: {repo}')
    base_ref = spec.get('base', 'HEAD')
    base = git(repo, 'rev-parse', '--verify', '--end-of-options', base_ref + '^{commit}').decode().strip()
    head = git(repo, 'rev-parse', 'HEAD').decode().strip()
    branch = git(repo, 'branch', '--show-current').decode().strip() or '(detached)'
    if spec.get('branch') and branch != spec['branch']:
        raise ValueError(f'{spec["name"]}: expected branch {spec["branch"]}, found {branch}')
    changed = name_status(git(repo, 'diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--find-renames', base, '--'))
    changed += [('A', '', p.decode()) for p in git(repo, 'ls-files', '--others', '--exclude-standard', '-z').split(b'\0') if p]
    tree = {}
    for item in git(repo, 'ls-tree', '-r', '-z', base).split(b'\0'):
        if item:
            meta, name = item.split(b'\t', 1)
            mode, kind, oid = meta.decode().split()
            tree[name.decode()] = (mode, kind, oid)
    files = []
    for status, old_path, path in sorted(changed, key=lambda x: x[2]):
        if not in_scope(spec, path, old_path):
            continue
        if status not in ('A','M','D','R','T'):
            raise ValueError(f'Unsupported Git status {status} for {path}; resolve conflicts first')
        old_mode, old_kind, oid = tree.get(old_path, ('', 'blob', ''))
        old_raw = (git(repo, 'cat-file', 'blob', oid) if old_kind == 'blob' else oid.encode()) if oid else b''
        new_raw, new_kind, new_mode = working_bytes(repo, path) if status != 'D' else (b'', 'missing', '')
        old, old_hash, old_note = decode_content(old_raw, 'submodule' if old_kind == 'commit' else 'file')
        new, new_hash, new_note = decode_content(new_raw, new_kind)
        added = removed = 0
        if old is not None and new is not None:
            for tag, a, b, c, d in difflib.SequenceMatcher(None, old.splitlines(), new.splitlines(), autojunk=False).get_opcodes():
                if tag != 'equal':
                    added += d-c; removed += b-a
        files.append({'path':path, 'oldPath':old_path or path, 'status':status, 'old':old, 'new':new,
                      'oldHash':old_hash, 'newHash':new_hash, 'oldMode':old_mode, 'newMode':new_mode,
                      'note':old_note or new_note, 'added':added, 'removed':removed})
    commits, truncated = capture_commits(repo, base, head, spec)
    if git(repo, 'rev-parse', 'HEAD').decode().strip() != head:
        raise ValueError(f'{repo}: HEAD moved during capture; publish again')
    return {'name':spec['name'], 'source':str(repo), 'base':base, 'baseRef':base_ref, 'head':head,
            'branch':branch, 'files':files, 'include':spec.get('include', []), 'exclude':spec.get('exclude', []),
            'commits':commits, 'commitsTruncated':truncated}


def api(url, path, data=None, method=None):
    if urlsplit(url).hostname not in ('localhost', '127.0.0.1', '::1'):
        raise ValueError('Review server must be local')
    request = Request(url.rstrip('/') + path, data=json.dumps(data).encode() if data is not None else None,
                      headers={'Content-Type':'application/json'}, method=method)
    try:
        with urlopen(request, timeout=120) as response:
            return json.load(response)
    except HTTPError as exc:
        raise ValueError(exc.read().decode()) from exc



# Per-user setup (first skill run): VS Code panel choice + PR platform access. Kept in ignored .local.
PR_PLATFORMS = ['github', 'azure-devops', 'gitlab', 'bitbucket', 'other', 'none']
VSCODE_EXTENSION = 'demo-kode.prepr'


def setup_path():
    return Path(os.environ.get('PREPR_SETUP') or Path(__file__).resolve().parent / '.local' / 'setup.json')


def load_setup():
    try:
        return json.loads(setup_path().read_text())
    except FileNotFoundError:
        return {}


def save_setup(**changes):
    cfg = {**load_setup(), **{k: v for k, v in changes.items() if v is not None}}
    path = setup_path(); path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(cfg, f, indent=2)
    return cfg


def setup_status(cfg):
    missing = [k for k in ('vscode', 'pr') if k not in cfg]
    return {'configured': not missing, 'missing': missing, **cfg}


def open_target(cfg, url, review, snapshot=None):
    query = 'review=' + review + (f'&snapshot={snapshot}' if snapshot else '')
    if cfg.get('vscode') == 'installed':
        return 'vscode', f'vscode://{VSCODE_EXTENSION}/open?{query}'
    return 'browser', f'{url.rstrip("/")}/?{query}'


def vscode_install():
    sys.path.insert(0, str(Path(__file__).resolve().parent / 'vscode'))
    import build
    vsix, ext_id = build.build(Path(__file__).resolve().parent / '.local' / 'vscode')
    done = subprocess.run(['code', '--install-extension', str(vsix), '--force'], capture_output=True, text=True)
    if done.returncode:
        raise ValueError('VS Code install failed: ' + (done.stderr or done.stdout).strip())
    save_setup(vscode='installed')
    return {'installed': ext_id, 'vsix': str(vsix), 'output': done.stdout.strip()}


def open_review(url, review, snapshot=None):
    if not re.fullmatch(r'[A-Za-z0-9_-]+', review):
        raise ValueError('Invalid review ID')
    kind, target = open_target(load_setup(), url, review, snapshot)
    if kind == 'vscode':
        try:
            if subprocess.run(['code', '--open-url', target], capture_output=True).returncode == 0:
                return {'opened': 'vscode', 'url': target}
        except FileNotFoundError:
            pass
        kind, target = open_target({}, url, review, snapshot)
    import webbrowser
    if not webbrowser.open(target):
        raise ValueError('No browser available; open ' + target)
    return {'opened': kind, 'url': target}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default=os.environ.get('PREPR_URL', 'http://127.0.0.1:18744'))
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('publish', help='Capture all specified repositories, including uncommitted files')
    p.add_argument('manifest', type=Path)
    p = sub.add_parser('feedback', help='Read threads with original code anchors')
    p.add_argument('review'); p.add_argument('--json', action='store_true'); p.add_argument('--open', action='store_true')
    p = sub.add_parser('reply'); p.add_argument('thread'); p.add_argument('body'); p.add_argument('--author', default='Codex')
    p = sub.add_parser('resolve'); p.add_argument('thread'); p.add_argument('--reopen', action='store_true')
    p = sub.add_parser('watch-start', help='Attach the working agent to an accepted live review')
    p.add_argument('review'); p.add_argument('--state', required=True, type=Path)
    p.add_argument('--author', default='Codex'); p.add_argument('--session')
    for command in ['watch', 'watch-ack', 'watch-heartbeat', 'watch-stop']:
        p = sub.add_parser(command); p.add_argument('--state', required=True, type=Path)
        if command == 'watch': p.add_argument('--timeout', default=45, type=float)
    p = sub.add_parser('watch-activity', help='Show agent work on threads: reply, code or idle')
    p.add_argument('--state', required=True, type=Path); p.add_argument('--activity', required=True, choices=['reply','code','idle'])
    p.add_argument('--thread', action='append', help='Thread ID; default: current comment batch')
    for command in ['ship-claim','ship-verify','ship-result']:
        p=sub.add_parser(command);p.add_argument('--state',required=True,type=Path)
        if command=='ship-result':
            p.add_argument('--status',required=True,choices=['shipped','blocked']);p.add_argument('--body',required=True)
    sub.add_parser('list')
    p = sub.add_parser('setup', help='Show or record first-run choices: VS Code panel, PR platform access')
    p.add_argument('--vscode', choices=['installed', 'declined'])
    p.add_argument('--pr-platform', choices=PR_PLATFORMS)
    p.add_argument('--pr-access', help='How agent reaches PR platform: CLI, account, org/project, target branch')
    sub.add_parser('vscode-install', help='Build and install the PrePR VS Code extension')
    p = sub.add_parser('open', help='Open review: VS Code panel when installed, else browser')
    p.add_argument('review'); p.add_argument('--snapshot', type=int)
    args = parser.parse_args()
    if args.command.startswith('ship-'):
        import review_watch
        if args.command=='ship-verify': result=review_watch.verify_shipping(args.state,capture_repository)
        else: result=review_watch.ship(api,args.state,'claim' if args.command=='ship-claim' else 'complete' if args.status=='shipped' else 'block',None if args.command=='ship-claim' else args.body)
        print(json.dumps(result,indent=2,ensure_ascii=False))
    elif args.command.startswith('watch'):
        import review_watch
        if args.command == 'watch-start': result = review_watch.start(api,args.url,args.review,args.state,args.author,args.session)
        elif args.command == 'watch': result = review_watch.wait(api,args.state,args.timeout)
        elif args.command == 'watch-ack': result = review_watch.acknowledge(args.state, api)
        elif args.command == 'watch-activity': result = review_watch.activity(api, args.state, args.activity, args.thread)
        else:
            state = json.loads(args.state.read_text())
            if args.command == 'watch-heartbeat': result = review_watch.heartbeat(api,state)
            else: result = api(state['url'],'/api/reviews/'+state['review']+'/watch',{'action':'stop','token':state['token']})
        print(json.dumps(result,indent=2,ensure_ascii=False))
    elif args.command == 'publish':
        spec = json.loads(args.manifest.read_text())
        repos = prepare_comparisons([capture_repository(r) for r in spec['repos']], spec.get('comparisons', []))
        data = {'id':spec['id'], 'title':spec['title'], 'description':spec.get('description',''), 'repos':repos}
        result = api(args.url, '/api/reviews', data)
        print(f'{args.url}/?review={result["review"]}')
        print(f'Snapshot {result["snapshot"]}{" (unchanged)" if result["unchanged"] else ""}: {len(repos)} repos, {sum(len(r["files"]) for r in repos)} files')
    elif args.command == 'feedback':
        result = api(args.url, '/api/reviews/' + args.review + '/feedback')
        if args.open:
            result['threads'] = [t for t in result['threads'] if t['status'] == 'open']
        if args.json:
            print(json.dumps(result, indent=2, ensure_ascii=False))
        else:
            for t in result['threads']:
                print(f'\n[{t["status"]}] {t["id"]} · snapshot {t["snapshot_id"]}{" (earlier)" if t["snapshot_id"] != result["latestSnapshot"] else ""}')
                print(f'{t["repo"]}/{t["path"]}:{t["line"]} ({t["side"]})\n  {t["code"]}')
                for m in t['messages']:
                    print(f'{m["author"]}: {m["body"]}')
            if not result['threads']: print('No comments yet.')
    elif args.command == 'reply':
        print(api(args.url, '/api/threads/' + args.thread + '/messages', {'author':args.author,'body':args.body}))
    elif args.command == 'resolve':
        print(api(args.url, '/api/threads/' + args.thread, {'status':'open' if args.reopen else 'resolved'}, 'PATCH'))
    elif args.command == 'setup':
        cfg = load_setup()
        if args.pr_platform or args.pr_access:
            pr = {**cfg.get('pr', {}), **({'platform': args.pr_platform} if args.pr_platform else {}),
                  **({'access': args.pr_access} if args.pr_access else {})}
            cfg = save_setup(pr=pr)
        if args.vscode: cfg = save_setup(vscode=args.vscode)
        print(json.dumps(setup_status(cfg), indent=2, ensure_ascii=False))
    elif args.command == 'vscode-install':
        print(json.dumps(vscode_install(), indent=2))
    elif args.command == 'open':
        print(json.dumps(open_review(args.url, args.review, args.snapshot), indent=2))
    else:
        print(json.dumps(api(args.url, '/api/reviews'), indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, URLError) as exc:
        sys.exit(str(exc))
