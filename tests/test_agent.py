import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import review
import review_agent
import review_watch
import server

# Stand-in for codex/claude: one conversation, records what it was given, acts per mode file.
FAKE = r'''#!/usr/bin/env python3
import json, os, re, shlex, subprocess, sys, time, uuid
root = os.environ['FAKE_AGENT_DIR']; argv = sys.argv; known = root + '/sessions'
def act(prompt, session):
    with open(root + '/calls.jsonl', 'a') as f:
        f.write(json.dumps({'argv': argv, 'prompt': prompt, 'cwd': os.getcwd(), 'pid': os.getpid(), 'conversation': session,
                            'session': [k for k in os.environ if k in ('CODEX_THREAD_ID', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID')],
                            'kept': os.environ.get('CODEX_HOME', '')}) + '\n')
    mode = open(root + '/mode').read().strip()
    cli = shlex.split(re.search(r'^- CLI: (.+)$', prompt, re.M)[1])
    author = (re.search(r'^You are (.+?), the unattended', prompt) or re.search(r'same role \((.+?), unattended', prompt))[1]
    if mode == 'crash': sys.exit(3)
    if mode == 'sleep': time.sleep(120)
    if mode == 'child':
        # Leaves a process outside its own process group.
        child = subprocess.Popen(['sleep', '300'], start_new_session=True)
        open(root + '/child', 'w').write(str(child.pid)); mode = 'reply'
    if mode in ('reply', 'reply-ack', 'reply-stop'):
        for tid in re.findall(r'^### Thread ([a-f0-9]+)', prompt.split('## Other open threads')[0], re.M):
            subprocess.run(cli + ['reply', tid, 'Answered by background run.', '--author', author], check=True, capture_output=True)
    state = re.search(r'^- Watcher state file: (.+)$', prompt, re.M)[1]
    # Old skill habits: agent acknowledges the batch or stops the watcher itself.
    if mode == 'reply-ack': subprocess.run(cli + ['watch-ack', '--state', state], check=True, capture_output=True)
    if mode == 'reply-stop': subprocess.run(cli + ['watch-stop', '--state', state], check=True, capture_output=True)
    if mode == 'ship':
        subprocess.run(cli + ['ship-claim', '--state', state], check=True, capture_output=True)
        subprocess.run(cli + ['ship-progress', '--state', state, '--repo', 'app', '--stage', 'opened'], check=True, capture_output=True)
        subprocess.run(cli + ['ship-result', '--state', state, '--status', 'shipped', '--body', 'app: https://example.invalid/pr/1'], check=True, capture_output=True)
wanted = next((argv[i+1] for i, a in enumerate(argv) if a in ('resume', '--resume')), '')
if wanted and wanted not in (open(known).read().split() if os.path.exists(known) else []):
    sys.exit('no rollout found for thread id ' + wanted)
session = wanted or str(uuid.uuid4())
if not wanted: open(known, 'a').write(session + '\n')
if '--input-format' in argv:
    # Claude: stays up, one message per line.
    print(json.dumps({'type': 'system', 'subtype': 'init', 'session_id': session}), flush=True)
    for line in sys.stdin:
        act(json.loads(line)['message']['content'][0]['text'], session)
        print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': False, 'session_id': session}), flush=True)
else:
    print(json.dumps({'type': 'thread.started', 'thread_id': session}), flush=True)
    act(sys.stdin.read(), session)
'''


def running(pid):
    try: return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[0] != 'Z'
    except OSError: return False


def ended(*pids):
    # Kill signal lands a moment after it is sent.
    deadline = time.time()+3
    while any(map(running, pids)) and time.time() < deadline: time.sleep(.02)
    return not any(map(running, pids))


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        server.DATA = self.root/'data'; server.init()
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True); self.thread.start()
        self.url = f'http://127.0.0.1:{self.http.server_port}'
        self.repo = self.root/'repo'; self.repo.mkdir(); bin = self.root/'bin'; bin.mkdir()
        for name in review_agent.AUTHORS:
            (bin/name).write_text(FAKE); (bin/name).chmod(0o755)
        self.setup = {'pr': {'platform': 'github', 'access': 'gh CLI; target main'}}
        patch = mock.patch.dict(os.environ, {'PREPR_AGENTS': str(self.root/'agents'), 'FAKE_AGENT_DIR': str(self.root), 'PATH': f'{bin}{os.pathsep}{os.environ["PATH"]}',
                                             'CODEX_THREAD_ID': '0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'CLAUDECODE': '1', 'CODEX_HOME': '/keep'})
        patch.start(); self.addCleanup(patch.stop)
        self.mode('reply'); self.now = 1000.0
        self.payload = {'id': 'demo', 'title': 'Agent test', 'description': 'Demo change', 'repos': [{'name': 'app', 'source': str(self.repo), 'branch': 'fix/demo', 'base': 'a'*40, 'head': 'b'*40,
                        'files': [{'path': 'a.py', 'status': 'M', 'old': 'old\n', 'new': 'new\n'}]}]}
        self.sid = self.api('/api/reviews', self.payload)['snapshot']
        self.sup = review_agent.Supervisor(review.api, self.url, lambda: self.setup, clock=lambda: self.now)
        self.sup.log = lambda *a: None

    def tearDown(self):
        self.sup.shutdown('test over')
        self.http.shutdown(); self.http.server_close(); self.thread.join(); self.tmp.cleanup()

    def api(self, path, data=None): return review.api(self.url, path, data)
    def mode(self, name): (self.root/'mode').write_text(name)
    def calls(self): return [json.loads(l) for l in (self.root/'calls.jsonl').read_text().splitlines()] if (self.root/'calls.jsonl').exists() else []
    def view(self): return self.api('/api/reviews/demo/watch')
    def register(self, agent='codex', **kw): return review_agent.register(review.api, self.url, 'demo', agent, **kw)
    def comment(self, body='Why?'):
        return self.api('/api/threads', {'snapshot': self.sid, 'repo': 'app', 'path': 'a.py', 'side': 'new', 'line': 1, 'author': 'Reviewer', 'body': body})['id']
    def run_job(self):
        # One launch tick, then tick until that turn is settled.
        self.sup.tick(); self.assertIn('demo', self.sup.jobs, 'turn started')
        deadline = time.time()+30
        while 'demo' in self.sup.jobs:
            self.assertLess(time.time(), deadline, 'turn finished'); time.sleep(.05); self.sup.tick()
    def last_author(self, tid): return [t for t in self.api('/api/reviews/demo/feedback')['threads'] if t['id'] == tid][0]['messages'][-1]['author']

    def test_reviewer_can_follow_up_before_resolving_a_question(self):
        self.register()
        tid = self.comment('Why is the timeout configurable?')
        for question in (None, 'What happens if I leave it unset?'):
            if question:
                self.api(f'/api/threads/{tid}/messages', {'author':'Reviewer', 'body':question})
            self.run_job()
            prompt = self.calls()[-1]['prompt']
            self.assertIn('leave the thread open for the reviewer to resolve', prompt)
            self.assertIn('republished the change requested in that thread', prompt)
            thread, = self.api('/api/reviews/demo/feedback')['threads']
            self.assertEqual((thread['id'], thread['status'], thread['messages'][-1]['author']), (tid, 'open', 'Codex'))
            self.sup.tick()
            self.assertFalse(self.sup.jobs)
        review.api(self.url, f'/api/threads/{tid}', {'status':'resolved'}, 'PATCH')
        self.assertEqual(self.api('/api/reviews/demo/feedback')['threads'][0]['status'], 'resolved')
        self.assertEqual(len(self.calls()), 2)

    def test_comment_starts_same_cli_with_whole_context_as_text(self):
        cfg, result = self.register(context='User wants timeout configurable. Run make test.')
        self.assertEqual((result['status'], cfg['agent'], cfg['author']), ('watching', 'codex', 'Codex'))
        self.assertTrue(self.view()['watcher']['active'])
        self.sup.tick(); self.assertEqual(self.sup.jobs, {}, 'idle review runs no model')
        tid = self.comment('Why this change?'); self.sup.tick()
        watcher = self.view()['watcher']; self.assertEqual((watcher['activity'], watcher['threads']), ('reply', [tid]))
        while 'demo' in self.sup.jobs: time.sleep(.05); self.sup.tick()
        call = self.calls()[0]
        self.assertEqual(call['argv'][1:3], ['exec', '--json']); self.assertIn('--approve-for-me', call['argv']); self.assertEqual(call['argv'][-1], '-')
        self.assertEqual(call['argv'][call['argv'].index('--cd')+1], str(self.repo)); self.assertEqual(call['cwd'], str(self.repo))
        self.assertIn(str(review_agent.folder('demo')), call['argv'], 'state dir writable for ship files')
        self.assertEqual((call['session'], call['kept']), ([], '/keep'), 'caller session markers dropped, config kept')
        for text in ['User wants timeout configurable. Run make test.', f'### Thread {tid} · app/a.py:1 (new side)', 'Why this change?', 'Code line: new',
                     'Demo change', f'{self.repo} · branch fix/demo · base {"a"*40}', cfg['manifest'], 'Never push, open pull requests, merge or deploy', '--author Codex']:
            self.assertIn(text, call['prompt'])
        self.assertEqual(self.last_author(tid), 'Codex')
        watcher = self.view()['watcher']; self.assertEqual((watcher['active'], watcher['activity'], watcher['error']), (True, 'idle', ''))
        self.sup.tick(); self.sup.tick(); self.assertEqual((len(self.calls()), self.sup.jobs), (1, {}), 'answered batch not replayed')
        # Next reviewer message: new run; earlier answered thread is context only.
        other = self.comment('And this?'); self.run_job()
        prompt = self.calls()[1]['prompt']; waiting, context = prompt.split('## Other open threads')
        self.assertIn(other, waiting); self.assertNotIn(tid, waiting); self.assertIn(tid, context); self.assertIn('Answered by background run.', context)
        self.assertEqual(review_agent.status('demo')['reviews'][0]['state'], 'watching')

    def test_crash_retries_once_then_page_shows_reason_and_click_retries(self):
        self.register(); tid = self.comment(); self.mode('crash')
        self.run_job(); self.assertEqual(review_agent.load('demo')['attempts'], 1)
        self.run_job(); cfg = review_agent.load('demo'); self.assertEqual((cfg['state'], cfg['failedKind']), ('failed', 'comments'))
        watcher = self.view()['watcher']; self.assertFalse(watcher['active'])
        self.assertRegex(watcher['error'], r'^Codex run failed: codex exited with code 3 · log .*-comments\.log$')
        for _ in range(3): self.sup.tick()
        self.assertEqual(len(self.calls()), 2, 'no endless retries')
        self.mode('reply'); self.assertEqual(self.api('/api/reviews/demo/resume', {'action': 'request'}), {'status': 'requested'})
        self.run_job()
        self.assertEqual(self.last_author(tid), 'Codex'); watcher = self.view()['watcher']; self.assertEqual((watcher['active'], watcher['error']), (True, ''))
        self.assertIsNone(self.view()['start']); self.assertEqual(review_agent.load('demo')['state'], 'watching')

    def test_run_that_answers_nothing_fails_and_new_message_retries(self):
        self.register(); tid = self.comment(); self.mode('silent')
        self.run_job(); self.run_job()
        self.assertIn('run ended without answering 1 thread', self.view()['watcher']['error'])
        self.sup.tick(); self.assertEqual(len(self.calls()), 2)
        self.mode('reply'); self.api('/api/threads/'+tid+'/messages', {'author': 'Reviewer', 'body': 'Still waiting.'})
        self.sup.tick(); self.assertEqual(review_agent.load('demo')['state'], 'watching'); self.run_job()
        self.assertEqual(self.last_author(tid), 'Codex'); self.assertIn('Still waiting.', self.calls()[2]['prompt'])

    def test_ship_it_runs_cli_and_releases_review(self):
        self.register('claude', context='Target branch main.')
        self.assertEqual(self.view()['watcher']['author'], 'Claude Code')
        request = self.api('/api/reviews/demo/decision', {'action': 'ship', 'snapshot': self.sid})['id']
        self.mode('ship'); self.run_job()
        call = self.calls()[0]
        self.assertEqual(call['argv'][1:7], ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']); self.assertIn('auto', call['argv'])
        for text in [f'PrePR request: {request}', 'github: gh CLI; target main', 'Target branch main.', 'ship-verify --state', 'Never merge. Never deploy.', 'send updating instead of creating']:
            self.assertIn(text, call['prompt'])
        decision = self.view()['decision']; self.assertEqual((decision['status'], decision['result']), ('shipped', 'app: https://example.invalid/pr/1'))
        self.assertEqual(decision['progress']['repos'], {'app':'opened'})
        cfg = review_agent.load('demo'); self.assertEqual((cfg['state'], cfg['reason']), ('done', 'ship shipped'))
        self.sup.tick(); self.assertEqual(len(self.calls()), 1)
        self.assertFalse(running(call['pid']), 'review over: its CLI is gone'); self.assertEqual((self.sup.live, 'live' in cfg), ({}, False))

    def test_ship_it_alone_attaches_agent_on_unrecorded_review(self):
        self.api('/api/reviews/demo/decision', {'action': 'ship', 'snapshot': self.sid})
        self.assertEqual(self.view()['start'], {'status': 'requested'})
        self.mode('ship'); self.run_job()
        self.assertEqual((self.view()['decision']['status'], review_agent.load('demo')['state']), ('shipped', 'done'))

    def test_failed_ship_waits_for_click(self):
        self.register(); self.api('/api/reviews/demo/decision', {'action': 'ship', 'snapshot': self.sid}); self.mode('silent')
        self.run_job(); self.run_job()
        self.assertIn('run ended without recording a Ship it result', self.view()['watcher']['error']); self.assertEqual(self.view()['decision']['status'], 'requested')
        for _ in range(3): self.sup.tick()
        self.assertEqual(len(self.calls()), 2)
        self.mode('ship'); self.api('/api/reviews/demo/resume', {'action': 'request'}); self.run_job()
        self.assertEqual(self.view()['decision']['status'], 'shipped')

    def test_close_cancels_running_job(self):
        self.register(); self.comment(); self.mode('sleep'); self.sup.tick()
        process = self.sup.jobs['demo'].cli.process; self.assertIsNone(process.poll())
        self.api('/api/reviews/demo/decision', {'action': 'close'})
        self.now += review_agent.BEAT; self.sup.tick(); self.assertIsNotNone(process.poll(), 'run stopped')
        self.sup.tick(); self.sup.tick()
        cfg = review_agent.load('demo'); self.assertEqual((cfg['state'], cfg['reason'], self.sup.jobs), ('done', 'closed', {}))

    def test_timeout_stops_run(self):
        self.register(); self.comment(); self.mode('sleep'); self.sup.tick()
        self.now += review_agent.TIMEOUT+1; self.sup.tick(); self.sup.tick()
        cfg = review_agent.load('demo'); self.assertEqual(cfg['attempts'], 1); self.assertIn('timed out', cfg['error'])

    def test_heartbeat_gap_is_repaired_without_click(self):
        self.register()
        with server.session() as db: db.execute('UPDATE review_watchers SET updated=?', (time.time()-121,))
        self.assertFalse(self.view()['watcher']['active'])
        self.sup.tick(); self.assertTrue(self.view()['watcher']['active'])

    def test_start_click_on_unrecorded_review_attaches_configured_agent(self):
        self.setup['agent'] = 'claude'; tid = self.comment()
        self.api('/api/reviews/demo/resume', {'action': 'request'}); self.run_job()
        cfg = review_agent.load('demo'); self.assertEqual((cfg['agent'], cfg['cwd']), ('claude', str(self.repo)))
        manifest = json.loads(Path(cfg['manifest']).read_text()); self.assertEqual((manifest['repos'][0]['path'], manifest['repos'][0]['base']), (str(self.repo), 'a'*40))
        self.assertEqual(self.last_author(tid), 'Claude Code'); self.assertIsNone(self.view()['start'])

    def test_click_problem_reaches_page(self):
        self.payload['repos'][0]['source'] = str(self.root/'gone'); self.sid = self.api('/api/reviews', self.payload)['snapshot']
        self.api('/api/reviews/demo/resume', {'action': 'request'}); self.sup.tick()
        start = self.view()['start']; self.assertEqual(start['status'], 'failed'); self.assertIn('Repository path missing', start['error'])

    def test_handoff_takes_over_chat_watcher_and_stop_releases(self):
        state = self.root/'chat.json'; review_watch.start(review.api, self.url, 'demo', state, 'Codex')
        self.register()
        self.assertEqual(review_watch.heartbeat(review.api, json.loads(state.read_text()))['status'], 'replaced')
        self.assertEqual(review_agent.unregister(review.api, 'demo')['status'], 'stopped')
        self.comment(); self.sup.tick(); self.assertEqual((self.sup.jobs, self.calls()), ({}, []))
        self.assertFalse(self.view()['watcher']['active'], 'released review stays released')
        with self.assertRaises(ValueError): review_agent.unregister(review.api, 'other')

    def test_registration_guards_and_flag_override(self):
        with self.assertRaises(ValueError): self.register('other')
        with self.assertRaises(ValueError): self.register(context='x'*(review_agent.CONTEXT_LIMIT+1))
        wrong = self.root/'wrong.json'; wrong.write_text(json.dumps({'id': 'else', 'repos': []}))
        with self.assertRaises(ValueError): self.register(manifest=wrong)
        cfg, _ = self.register('claude')
        self.assertEqual(review_agent.command(cfg, ['--permission-mode', 'acceptEdits'])[7:9], ['--permission-mode', 'acceptEdits'])
        self.setup['agentArgs'] = {'claude': ['--model', 'x']}; self.comment(); self.run_job()
        self.assertIn('--model', self.calls()[0]['argv']); self.assertNotIn('auto', self.calls()[0]['argv'])

    def test_agent_own_ack_or_stop_keeps_review_watched(self):
        self.register(); errors = []; self.sup.log = lambda rid, text: errors.append(text) if 'error' in text else None
        for mode in ['reply-ack', 'reply-stop']:
            self.mode(mode); tid = self.comment(mode); self.run_job(); self.sup.tick()
            self.assertEqual(self.last_author(tid), 'Codex')
            watcher = self.view()['watcher']; self.assertEqual((watcher['active'], watcher['activity']), (True, 'idle'), mode)
        self.assertEqual((errors, len(self.calls()), review_agent.load('demo')['state']), ([], 2, 'watching'))

    def test_claude_process_reused_for_review_then_idle_timeout_then_resumed(self):
        self.register('claude', context='Keep timeout configurable.')
        first = self.comment('one'); self.run_job(); second = self.comment('two'); self.run_job()
        a, b = self.calls(); pid = a['pid']
        self.assertEqual((b['pid'], b['conversation'], self.last_author(first), self.last_author(second)), (pid, a['conversation'], 'Claude Code', 'Claude Code'))
        self.assertIn('Keep timeout configurable.', a['prompt']); self.assertTrue(a['prompt'].startswith('You are Claude Code, the unattended'))
        self.assertTrue(b['prompt'].startswith('More work on PrePR review demo.')); self.assertNotIn('Keep timeout configurable.', b['prompt']); self.assertIn(second, b['prompt'])
        cfg = review_agent.load('demo'); self.assertEqual((cfg['live'], cfg['session'], running(pid)), (pid, a['conversation'], True))
        self.assertEqual(review_agent.status('demo')['reviews'][0]['live'], pid)
        # Reviewer away: CLI ends after the idle limit, watcher slot stays.
        self.now += (review_agent.IDLE-1)*60; self.sup.tick(); self.assertTrue(running(pid))
        self.now += 2*60; self.sup.tick(); self.assertFalse(running(pid)); self.assertEqual(self.sup.live, {})
        self.assertNotIn('live', review_agent.load('demo')); self.assertTrue(self.view()['watcher']['active'])
        # Reviewer back: new process, same conversation.
        third = self.comment('three'); self.run_job(); c = self.calls()[2]
        self.assertNotEqual(c['pid'], pid); self.assertEqual(c['argv'][-2:], ['--resume', a['conversation']]); self.assertEqual(c['conversation'], a['conversation'])
        self.assertTrue(c['prompt'].startswith('More work on PrePR review demo.')); self.assertEqual(self.last_author(third), 'Claude Code')
        self.setup['agentIdle'] = 1; self.now += 61; self.sup.tick(); self.assertFalse(running(c['pid']), 'idle limit from setup')

    def test_codex_thread_reused_and_lost_thread_gets_whole_briefing_again(self):
        self.register(context='Keep timeout configurable.'); self.comment('one'); self.run_job(); self.comment('two'); self.run_job()
        a, b = self.calls()
        self.assertEqual(b['argv'][-3:], ['resume', a['conversation'], '-']); self.assertNotIn('resume', a['argv'])
        self.assertTrue(b['prompt'].startswith('More work on PrePR review demo.')); self.assertFalse(running(a['pid']) or running(b['pid']), 'one turn, then gone')
        self.assertEqual(self.sup.live, {}); self.assertEqual(review_agent.load('demo')['session'], a['conversation'])
        # Saved thread gone: failed resume, then clean start with the whole briefing.
        (self.root/'sessions').unlink(); tid = self.comment('three'); self.run_job()
        cfg = review_agent.load('demo'); self.assertEqual((cfg['attempts'], 'session' in cfg, len(self.calls())), (1, False, 2))
        self.run_job(); c = self.calls()[2]
        self.assertNotIn('resume', c['argv']); self.assertIn('Keep timeout configurable.', c['prompt']); self.assertTrue(c['prompt'].startswith('You are Codex'))
        self.assertEqual((self.last_author(tid), review_agent.load('demo')['attempts'], self.view()['watcher']['error']), ('Codex', 0, ''))

    def test_failed_turn_ends_staying_cli_and_restarts_clean(self):
        self.register('claude'); self.comment('one'); self.run_job(); pid = self.calls()[0]['pid']
        self.mode('silent'); tid = self.comment('two'); self.run_job()
        self.assertFalse(running(pid), 'CLI of failed turn ended'); self.assertNotIn('session', review_agent.load('demo'))
        self.mode('reply'); self.run_job(); c = self.calls()[2]
        self.assertNotIn('--resume', c['argv']); self.assertTrue(c['prompt'].startswith('You are Claude Code')); self.assertEqual(self.last_author(tid), 'Claude Code')

    def test_nothing_outlives_review_or_turn(self):
        # Staying CLI plus a child that left its process group: both end with the review.
        self.register('claude'); self.mode('child'); self.comment(); self.run_job()
        pid, child = self.calls()[0]['pid'], int((self.root/'child').read_text())
        self.assertTrue(running(pid) and running(child))
        self.api('/api/reviews/demo/decision', {'action': 'close'}); self.sup.tick()
        self.assertTrue(ended(pid, child)); self.assertEqual((self.sup.live, review_agent.load('demo')['state']), ({}, 'done'))
        # One-turn CLI: detached child ends when the turn does.
        self.payload['id'] = 'other'; self.sid = self.api('/api/reviews', self.payload)['snapshot']
        review_agent.register(review.api, self.url, 'other', 'codex')
        self.api('/api/threads', {'snapshot': self.sid, 'repo': 'app', 'path': 'a.py', 'side': 'new', 'line': 1, 'author': 'Reviewer', 'body': 'Why?'})
        self.sup.tick(); deadline = time.time()+30
        while 'other' in self.sup.jobs and time.time() < deadline: time.sleep(.3); self.sup.tick()
        stray = int((self.root/'child').read_text()); self.assertNotEqual(stray, child)
        # Fully detached child of an already finished CLI: only a cgroup scope still finds it.
        if review_agent.scoped(): self.assertTrue(ended(stray), 'stray child of finished turn ended')
        else: os.kill(stray, 9)

    def test_runner_stop_restart_and_new_handoff_end_clis(self):
        self.register('claude', context='old'); self.comment(); self.run_job(); first = self.calls()[0]['pid']
        # Dead runner left its CLI: next runner ends it at start.
        orphan = self.sup.live.pop('demo'); fresh = review_agent.Supervisor(review.api, self.url, lambda: self.setup, clock=lambda: self.now); fresh.log = lambda *a: None
        fresh.sweep(); orphan.process.wait(timeout=10); self.assertFalse(running(first)); self.assertNotIn('live', review_agent.load('demo'))
        # Handed over again with new context: CLI of the old conversation ends, next turn gets the new briefing.
        self.comment('again'); self.run_job(); second = self.calls()[1]['pid']; self.assertTrue(running(second))
        self.register('claude', context='new'); self.sup.tick(); self.assertFalse(running(second))
        self.comment('more'); self.run_job(); third = self.calls()[2]
        self.assertIn('new', third['prompt'].split('## Task context')[1]); self.assertNotIn('--resume', third['argv'])
        # Runner leaving takes every CLI along.
        self.assertTrue(running(third['pid'])); self.sup.shutdown('runner stopping'); self.assertFalse(running(third['pid']))

    def test_one_runner_at_a_time(self):
        self.assertFalse(review_agent.alive())
        import fcntl
        with open(review_agent.home()/'runner.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            self.assertTrue(review_agent.alive())
            self.assertIs(review_agent.run(review.api, self.url, dict), False)
        self.assertFalse(review_agent.alive())


if __name__ == '__main__':
    unittest.main()
