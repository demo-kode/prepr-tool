import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import subprocess
import unittest
from unittest import mock
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import review
import review_watch
import live_review
import server


class WatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        server.DATA = self.root/'data'; server.init()
        self.http = server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever,daemon=True);self.thread.start()
        self.url = f'http://127.0.0.1:{self.http.server_port}'
        self.state = self.root/'watch.json'
        self.payload = {'id':'demo','title':'Watch test','repos':[{'name':'app','source':'/demo','branch':'main','base':'a'*40,'head':'b'*40,'files':[{'path':'a.py','status':'M','old':'old\n','new':'new\n'}]}]}
        self.sid = self.api('/api/reviews',self.payload)['snapshot']
    def tearDown(self):
        self.http.shutdown();self.http.server_close();self.thread.join();self.tmp.cleanup()
    def api(self, path, data=None): return review.api(self.url,path,data)
    def start(self): return review_watch.start(review.api,self.url,'demo',self.state,'Codex','test-session')
    def poll(self): return review_watch.wait(review.api,self.state,timeout=0)
    def comment(self):
        return self.api('/api/threads',{'snapshot':self.sid,'repo':'app','path':'a.py','side':'new','line':1,'author':'Reviewer','body':'Why?'})['id']
    def test_comments_replay_acknowledge_and_reply_filter(self):
        tid=self.comment();self.start()
        first=self.poll();self.assertEqual(first['status'],'comments');self.assertEqual(first['threads'][0]['code'],'new')
        self.assertEqual(self.poll()['threads'],first['threads'])
        self.api('/api/threads/'+tid+'/messages',{'author':'Codex','body':'Because.'})
        self.api('/api/threads/'+tid+'/messages',{'author':'Reviewer','body':'Another question during edits.'})
        review_watch.acknowledge(self.state)
        self.assertEqual(self.poll()['threads'][0]['messages'][-1]['body'],'Another question during edits.')
        review_watch.acknowledge(self.state)
        self.api('/api/threads/'+tid+'/messages',{'author':'Codex','body':'Answered.'})
        self.assertEqual(self.poll()['status'],'waiting')
    def test_earlier_snapshot_and_review_isolation(self):
        tid=self.comment();self.start();self.payload['description']='new snapshot';self.api('/api/reviews',self.payload)
        result=self.poll();self.assertNotEqual(result['latestSnapshot'],self.sid);self.assertEqual(result['threads'][0]['snapshot_id'],self.sid)
        self.payload['id']='other';sid=self.api('/api/reviews',self.payload)['snapshot']
        self.api('/api/threads',{'snapshot':sid,'repo':'app','path':'a.py','side':'new','line':1,'author':'Reviewer','body':'Other task'})
        review_watch.acknowledge(self.state);self.assertEqual(self.poll()['status'],'waiting')
        with self.assertRaises(ValueError):review_watch.start(review.api,self.url,'other',self.state,'Codex')
    def test_ownership_stop_expiry_and_restart(self):
        self.start();self.assertTrue(self.api('/api/reviews/demo/watch')['watcher']['active'])
        with self.assertRaises(ValueError):review_watch.start(review.api,self.url,'demo',self.root/'other.json','Claude Code')
        self.api('/api/reviews/demo/watch',{'action':'stop'});self.assertEqual(self.poll()['status'],'stopped')
        self.assertFalse(self.api('/api/reviews/demo/watch')['watcher']['active'])
        old=json.loads(self.state.read_text())
        self.start()
        self.assertEqual(self.api('/api/reviews/demo/watch',{'action':'stop','token':old['token']})['status'],'replaced')
        with server.session() as db: db.execute('UPDATE review_watchers SET updated=?',(time.time()-121,))
        self.assertEqual(self.poll()['status'],'expired');self.assertFalse(self.api('/api/reviews/demo/watch')['watcher']['active'])
        self.start();self.assertEqual(self.poll()['status'],'waiting')
        view=self.api('/api/reviews/demo/watch');self.assertNotIn('token',json.dumps(view));self.assertNotIn('test-session',json.dumps(view))
    def test_reopen_is_delivered_and_timeout_is_bounded(self):
        tid=self.comment();self.start();self.poll();review_watch.acknowledge(self.state)
        review.api(self.url,'/api/threads/'+tid,{'status':'resolved'},'PATCH');self.poll()
        review.api(self.url,'/api/threads/'+tid,{'status':'open'},'PATCH');self.assertEqual(self.poll()['status'],'comments')
        with self.assertRaises(ValueError):review_watch.wait(review.api,self.state,timeout=51)
    def test_wait_delivers_arriving_comment(self):
        self.start();timer=threading.Timer(.1,self.comment);timer.start()
        result=review_watch.wait(review.api,self.state,timeout=1,interval=.05);timer.join()
        self.assertEqual(result['status'],'comments')

    def test_viewed_carries_to_unchanged_files(self):
        self.payload['repos'][0]['files'].append({'path':'b.py','status':'M','old':'x\n','new':'y\n'})
        sid=self.api('/api/reviews',self.payload)['snapshot']
        for path in ['a.py','b.py']:self.api(f'/api/snapshots/{sid}/viewed',{'repo':'app','path':path,'viewed':True})
        self.payload['repos'][0]['files'][1]['new']='z\n'
        new=self.api('/api/reviews',self.payload)['snapshot']
        self.assertEqual(self.api('/api/reviews/demo?snapshot='+str(new))['viewed'],[{'repo':'app','path':'a.py'}])
        self.assertEqual(len(self.api('/api/reviews/demo?snapshot='+str(sid))['viewed']),2)

    def test_agent_activity_follows_batch(self):
        tid=self.comment();self.start()
        view=lambda:self.api('/api/reviews/demo/watch')['watcher']
        self.assertEqual((view()['activity'],view()['threads']),('idle',[]))
        self.assertEqual(self.poll()['status'],'comments');self.assertEqual((view()['activity'],view()['threads']),('reply',[tid]))
        review_watch.activity(review.api,self.state,'code');self.assertEqual(view()['activity'],'code')
        self.assertEqual(review_watch.acknowledge(self.state,review.api)['agent'],'watching');self.assertEqual((view()['activity'],view()['threads']),('idle',[]))
        state=json.loads(self.state.read_text())
        with self.assertRaises(ValueError):review_watch.set_activity(review.api,state,'sleep')
        with self.assertRaises(ValueError):review_watch.set_activity(review.api,state,'code',['bad id'])
        self.assertEqual(review_watch.set_activity(review.api,{**state,'token':'f'*32},'code')['status'],'replaced')
        review_watch.activity(review.api,self.state,'code',[tid]);self.api('/api/reviews/demo/watch',{'action':'stop'})
        self.assertEqual(view()['activity'],'idle')

    def test_resume_target_recorded_from_agent_env(self):
        with mock.patch.dict(os.environ,{'CODEX_THREAD_ID':'0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee','CLAUDE_CODE_SESSION_ID':''}):
            review_watch.start(review.api,self.url,'demo',self.state,'Codex')
        view=self.api('/api/reviews/demo/watch')['watcher']
        self.assertEqual((view['agent'],view['resumable']),('codex',True));self.assertNotIn('0199aaaa',json.dumps(view))
        t=self.api('/api/reviews/demo/resume')
        self.assertEqual((t['agent'],t['session'],t['cwd'],t['roots'],t['active']),('codex','0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',os.getcwd(),['/demo',str(Path(self.state).resolve().parent)],True))
        self.api('/api/reviews/demo/watch',{'action':'stop'})
        with mock.patch.dict(os.environ,{'CODEX_THREAD_ID':'','CLAUDE_CODE_SESSION_ID':'0199bbbb-cccc-dddd-eeee-ffffffffffff'}):
            review_watch.start(review.api,self.url,'demo',self.state,'Claude Code')
        self.assertEqual(self.api('/api/reviews/demo/resume')['agent'],'claude')
        self.api('/api/reviews/demo/watch',{'action':'stop'})
        with mock.patch.dict(os.environ,{'CODEX_THREAD_ID':'','CLAUDE_CODE_SESSION_ID':''}):
            review_watch.start(review.api,self.url,'demo',self.state,'Other',session='manual-ref')
        self.assertFalse(self.api('/api/reviews/demo/watch')['watcher']['resumable'])
        self.assertEqual(self.api('/api/reviews/demo/resume')['session'],'')

    def test_start_without_session_preserves_review_context(self):
        t=self.api('/api/reviews/demo/resume')
        self.assertEqual((t['agent'],t['author'],t['session'],t['cwd'],t['roots'],t['active']),('','','','/demo',['/demo'],False))
        self.assertEqual(t['review']['repos'][0]['base'],'a'*40)
        self.assertEqual(t['review']['repos'][0]['branch'],'main')
        self.assertNotIn('files',t['review']['repos'][0])
        self.api('/api/reviews/demo/decision',{'action':'ship','snapshot':self.sid})
        self.assertEqual(self.api('/api/reviews/demo/resume')['decision']['status'],'requested')

    def test_ship_it_asks_runner_only_when_no_agent_attached(self):
        self.start();self.api('/api/reviews/demo/decision',{'action':'ship','snapshot':self.sid})
        self.assertIsNone(self.api('/api/reviews/demo/watch')['start']);self.assertEqual(self.api('/api/resume-requests'),{'reviews':[]})
        self.payload['id']='lonely';sid=self.api('/api/reviews',self.payload)['snapshot']
        self.api('/api/reviews/lonely/decision',{'action':'ship','snapshot':sid});self.assertEqual(self.api('/api/resume-requests'),{'reviews':['lonely']})
        self.payload['id']='shut';self.api('/api/reviews',self.payload);self.api('/api/reviews/shut/decision',{'action':'close'})
        self.assertEqual(self.api('/api/resume-requests'),{'reviews':['lonely']})

    def test_runner_failure_shows_until_next_start(self):
        self.start();state=json.loads(self.state.read_text());post=lambda d:self.api('/api/reviews/demo/watch',d)
        with self.assertRaises(ValueError):post({'action':'fail','token':state['token'],'error':''})
        self.assertEqual(post({'action':'fail','token':'f'*32,'error':'x'})['status'],'replaced')
        self.assertEqual(post({'action':'fail','token':state['token'],'error':'run failed'})['status'],'failed')
        view=self.api('/api/reviews/demo/watch')['watcher'];self.assertEqual((view['active'],view['activity'],view['error']),(False,'idle','run failed'))
        self.assertEqual(self.poll()['status'],'stopped')
        self.start();self.assertEqual(self.api('/api/reviews/demo/watch')['watcher']['error'],'')

    def test_start_click_relays_to_first_host(self):
        # Page click waits in service; host claims once; page sees progress.
        watch=lambda:self.api('/api/reviews/demo/watch')['start']
        self.assertIsNone(watch());self.assertEqual(self.api('/api/resume-requests'),{'reviews':[]})
        self.assertEqual(self.api('/api/reviews/demo/resume',{'action':'request'}),{'status':'requested'})
        self.assertEqual(self.api('/api/resume-requests'),{'reviews':['demo']});self.assertEqual(watch(),{'status':'requested'})
        claimed=self.api('/api/reviews/demo/resume',{'action':'claim'})
        self.assertEqual((claimed['status'],claimed['agent'],claimed['session'],claimed['review']['id']),('claimed','','','demo'))
        self.assertEqual(self.api('/api/reviews/demo/resume',{'action':'claim'}),{'status':'none'})
        self.assertEqual(self.api('/api/resume-requests'),{'reviews':[]});self.assertEqual(watch(),{'status':'starting'})
        self.assertNotIn('session',json.dumps(self.api('/api/reviews/demo/watch')))
        # Host failure reaches page; wrong request ID ignored.
        self.assertEqual(self.api('/api/reviews/demo/resume',{'action':'fail','request':'other','error':'x'}),{'status':'none'})
        self.assertEqual(self.api('/api/reviews/demo/resume',{'action':'fail','request':claimed['request'],'error':'watcher exited with code 1.'}),{'status':'failed','error':'watcher exited with code 1.'})
        self.assertEqual(watch()['status'],'failed')
        with self.assertRaises(ValueError):self.api('/api/reviews/demo/resume',{'action':'fail','request':claimed['request'],'error':''})
        with self.assertRaises(ValueError):self.api('/api/reviews/demo/resume',{'action':'other'})
        # Retry click replaces failure; attached watcher clears it.
        self.api('/api/reviews/demo/resume',{'action':'request'});retry=self.api('/api/reviews/demo/resume',{'action':'claim'})
        self.assertNotEqual(retry['request'],claimed['request']);self.start();self.assertIsNone(watch())
        self.assertEqual(self.api('/api/reviews/demo/resume',{'action':'fail','request':retry['request'],'error':'late'}),{'status':'none'})
        with self.assertRaisesRegex(ValueError,'already watching'):self.api('/api/reviews/demo/resume',{'action':'request'})
    def test_start_click_unanswered_then_expires(self):
        # No VS Code host: page says so; old click never launches an agent later.
        self.api('/api/reviews/demo/resume',{'action':'request'});now=time.time()
        with mock.patch.object(live_review.time,'time',return_value=now+live_review.START_ANSWER+1):
            self.assertEqual(self.api('/api/reviews/demo/watch')['start'],{'status':'unanswered'})
            self.assertEqual(self.api('/api/resume-requests'),{'reviews':['demo']})
        with mock.patch.object(live_review.time,'time',return_value=now+live_review.START_CLAIM+1):
            self.assertEqual(self.api('/api/resume-requests'),{'reviews':[]})
            self.assertEqual(self.api('/api/reviews/demo/resume',{'action':'claim'}),{'status':'none'})
            self.assertEqual(self.api('/api/reviews/demo/watch')['start'],{'status':'unanswered'})
        with mock.patch.object(live_review.time,'time',return_value=now+live_review.START_SHOWN+1):
            self.assertIsNone(self.api('/api/reviews/demo/watch')['start'])
        # Completed review: no start; delete drops the click.
        self.api('/api/reviews/demo/resume',{'action':'request'})
        self.api('/api/reviews/demo/decision',{'action':'close','snapshot':self.sid})
        with self.assertRaisesRegex(ValueError,'completed'):self.api('/api/reviews/demo/resume',{'action':'request'})
        review.api(self.url,'/api/reviews/demo',{},'DELETE')
        self.assertEqual(self.api('/api/resume-requests'),{'reviews':[]})
    def test_completed_review_cannot_start_session(self):
        self.api('/api/reviews/demo/decision',{'action':'close'})
        with self.assertRaisesRegex(ValueError,'completed'):self.api('/api/reviews/demo/resume')
        with self.assertRaises(ValueError):self.api('/api/reviews/missing/resume')
        self.api('/api/reviews/demo/watch',{'action':'stop'})
        for bad in [{'agent':'bash','session':'x'*10},{'agent':'codex','session':'../etc'},{'agent':'codex','session':'a'*10,'cwd':'relative'},{'agent':'codex','session':'a'*10,'roots':['/ok','rel']}]:
            with self.assertRaises(ValueError):self.api('/api/reviews/demo/watch',{'action':'start','token':'c'*32,'author':'X',**bad})

    def test_close_archives_then_delete_removes(self):
        tid=self.comment();self.start()
        with server.session() as db: db.execute('INSERT INTO viewed VALUES(?,?,?)',(self.sid,'app','a.py'))
        with self.assertRaises(ValueError):review.api(self.url,'/api/reviews/demo',{},'DELETE')
        result=self.api('/api/reviews/demo/decision',{'action':'close','snapshot':self.sid})
        self.assertEqual((result['action'],result['status']),('close','closed'));self.assertEqual(result,self.api('/api/reviews/demo/decision',{'action':'close'}))
        self.assertEqual(result,self.api('/api/reviews/demo/decision',{'action':'keep'}),'old keep alias')
        self.assertEqual(self.poll()['status'],'closed');self.assertFalse(self.api('/api/reviews/demo/watch')['watcher']['active'])
        self.assertEqual(self.api('/api/reviews')[0]['decision']['status'],'closed')
        with self.assertRaises(ValueError):self.comment()
        with self.assertRaises(ValueError):self.api('/api/threads/'+tid+'/messages',{'author':'Reviewer','body':'Late'})
        self.assertEqual(review.api(self.url,'/api/reviews/demo',{},'DELETE'),{'status':'deleted'})
        self.assertEqual(self.api('/api/reviews'),[]);self.assertEqual(self.poll()['status'],'closed')
        with server.session() as db:
            for table in ['snapshots','threads','messages','viewed','review_watchers','review_decisions']:
                self.assertEqual(db.execute(f'SELECT count(*) FROM {table}').fetchone()[0],0,table)
        self.payload['description']='new task';self.assertIn('snapshot',self.api('/api/reviews',self.payload))

    def test_old_keep_rows_migrate_to_closed(self):
        self.start()
        with server.session() as db:
            db.execute("INSERT INTO review_decisions(review_id,id,snapshot_id,action,status) VALUES('demo',?,?,'keep','kept')",('f'*32,self.sid))
            live_review.init(db)
        d=self.api('/api/reviews/demo')['decision'];self.assertEqual((d['action'],d['status']),('close','closed'))
        self.assertEqual(self.poll()['status'],'closed')
        self.assertEqual(review.api(self.url,'/api/reviews/demo',{},'DELETE'),{'status':'deleted'})

    def test_prs_sent_from_chat_recorded(self):
        self.start()
        with self.assertRaises(ValueError):self.api('/api/reviews/demo/decision',{'action':'sent','result':' '})
        d=self.api('/api/reviews/demo/decision',{'action':'sent','result':'app: https://example.invalid/pr/7'})
        self.assertEqual((d['status'],d['result']),('shipped','app: https://example.invalid/pr/7'))
        self.assertEqual(self.poll()['status'],'ship_requested')
        with self.assertRaises(ValueError):self.api('/api/reviews/demo/decision',{'action':'sent','result':'again'})
        self.assertEqual(review.api(self.url,'/api/reviews/demo',{},'DELETE'),{'status':'deleted'})

    def test_closed_review_upgrades_to_sent_but_not_mid_ship(self):
        self.api('/api/reviews/demo/decision',{'action':'close'})
        d=self.api('/api/reviews/demo/decision',{'action':'sent','result':'app: https://example.invalid/pr/8'})
        self.assertEqual(d['status'],'shipped')
        self.payload['id']='other';other=self.api('/api/reviews',self.payload)['snapshot']
        self.api('/api/reviews/other/decision',{'action':'ship','snapshot':other})
        with self.assertRaises(ValueError):self.api('/api/reviews/other/decision',{'action':'sent','result':'x'})
        out=subprocess.run([sys.executable,str(Path(__file__).resolve().parents[1]/'review.py'),'--url',self.url,'close','other'],capture_output=True,text=True)
        self.assertNotEqual(out.returncode,0)

    def test_close_and_delete_blocked_while_ship_in_flight(self):
        self.api('/api/reviews/demo/decision',{'action':'ship','snapshot':self.sid})
        with self.assertRaises(ValueError):self.api('/api/reviews/demo/decision',{'action':'close','snapshot':self.sid})
        with self.assertRaises(ValueError):review.api(self.url,'/api/reviews/demo',{},'DELETE')
        self.assertEqual(self.api('/api/reviews/demo')['decision']['status'],'requested')

    def test_stale_snapshot_cannot_close_or_ship(self):
        self.payload['description']='new snapshot';self.api('/api/reviews',self.payload)
        with self.assertRaises(ValueError):self.api('/api/reviews/demo/decision',{'action':'ship','snapshot':self.sid})
        self.assertIsNone(self.api('/api/reviews/demo/watch')['decision'])

    def test_shipping_progress_survives_reclaims_and_stops_at_completion(self):
        self.start()
        request = self.api('/api/reviews/demo/decision', {'action':'ship','snapshot':self.sid})
        def report(stage, repo='app'):
            return review_watch.shipping_progress(review.api, self.state, stage, repo)
        review_watch.ship(review.api, self.state, 'claim')
        self.assertTrue(report('verified', None)['progress']['verified'])
        self.assertEqual(report('pushed')['progress']['repos'], {'app':'pushed'})
        review_watch.ship(review.api, self.state, 'claim')
        self.assertEqual(report('pushing')['progress']['repos']['app'], 'pushed')
        for invalid in [('invalid','app'),('pushing','unapproved')]:
            with self.assertRaises(ValueError): report(*invalid)
        with self.assertRaises(ValueError):
            self.api('/api/reviews/demo/decision', {'action':'progress','token':'other','request':request['id'],'repo':'app','stage':'opened'})
        report('opened')
        self.assertEqual(self.api('/api/reviews/demo/watch')['decision']['progress']['repos']['app'], 'opened')
        # Same rank: first confirmed kind stays.
        self.assertEqual(report('updated')['progress']['repos']['app'], 'opened')
        review_watch.ship(review.api, self.state, 'complete', 'app: https://example.invalid/pr/1')
        with self.assertRaises(ValueError): report('opened')

    def test_shipping_progress_tells_updated_pr_from_opened_pr(self):
        other = {**self.payload['repos'][0], 'name':'worker', 'source':'/other'}
        self.payload['repos'].append(other); self.sid = self.api('/api/reviews', self.payload)['snapshot']
        self.start()
        self.api('/api/reviews/demo/decision', {'action':'ship','snapshot':self.sid})
        def report(stage, repo):
            return review_watch.shipping_progress(review.api, self.state, stage, repo)['progress']['repos']
        review_watch.ship(review.api, self.state, 'claim')
        report('pushed', 'app'); report('pushed', 'worker')
        self.assertEqual(report('updating', 'app'), {'app':'updating', 'worker':'pushed'})
        # Kind fixed only by the confirmed stage: creating may still end as updated.
        self.assertEqual(report('creating', 'app')['app'], 'updating')
        report('creating', 'worker')
        self.assertEqual(report('updated', 'worker'), {'app':'updating', 'worker':'updated'})
        self.assertEqual(report('updated', 'app'), {'app':'updated', 'worker':'updated'})
        self.assertEqual(report('opened', 'app')['app'], 'updated')

    def test_ship_request_survives_offline_and_claim_recovery(self):
        other={**self.payload['repos'][0],'name':'worker','source':'/other'}
        self.payload['repos'].append(other);self.sid=self.api('/api/reviews',self.payload)['snapshot']
        request=self.api('/api/reviews/demo/decision',{'action':'ship','snapshot':self.sid})
        self.assertEqual(self.start()['status'],'ship_requested');self.assertEqual(self.poll()['decision'],request)
        claimed=review_watch.ship(review.api,self.state,'claim')
        self.assertFalse(claimed['reconcile']);self.assertEqual(len(claimed['repositories']),2)
        self.assertTrue(review_watch.ship(review.api,self.state,'claim')['reconcile'])
        approved=json.loads(Path(claimed['approvedSnapshotFile']).read_text())
        self.assertEqual(approved['payload'],self.payload)
        with self.assertRaises(ValueError):self.api('/api/reviews/demo/decision',{'action':'complete','token':'wrong','request':request['id'],'result':'bad'})
        result=review_watch.ship(review.api,self.state,'complete','app: https://example.invalid/pr/1; worker: https://example.invalid/pr/2')
        self.assertEqual(result['status'],'shipped');self.assertIn('/pr/2',self.poll()['decision']['result'])
        with self.assertRaises(ValueError):review_watch.ship(review.api,self.state,'claim')

    def test_ship_verify_and_partial_failure(self):
        stored=self.payload['repos'][0];stored['files'][0].update(newHash='expected',newMode='100644')
        self.sid=self.api('/api/reviews',self.payload)['snapshot'];self.start()
        self.api('/api/reviews/demo/decision',{'action':'ship','snapshot':self.sid})
        self.assertEqual(review_watch.ship(review.api,self.state,'claim')['checks'],'')
        self.assertEqual(review_watch.verify_shipping(self.state,lambda spec:stored)['status'],'verified')
        changed=json.loads(json.dumps(stored));changed['files'][0]['newHash']='changed'
        with self.assertRaises(ValueError):review_watch.verify_shipping(self.state,lambda spec:changed)
        review_watch.ship(review.api,self.state,'block','One PR created; second repository needs authentication.')
        self.assertEqual(self.poll()['decision']['status'],'blocked')
        with self.assertRaises(ValueError):review_watch.ship(review.api,self.state,'claim')

    def test_ship_verify_real_worktree(self):
        root=self.root/'repo';root.mkdir()
        def git(*args):return subprocess.check_output(['git','-C',str(root),*args],text=True)
        git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid')
        (root/'a.py').write_text('before\n');git('add','.');git('commit','-qm','base')
        base=git('rev-parse','HEAD').strip();(root/'a.py').write_text('reviewed\n')
        self.payload['repos']=[review.capture_repository({'name':'app','path':str(root),'base':base})];self.payload['checks']='make test: ok'
        self.sid=self.api('/api/reviews',self.payload)['snapshot'];self.start()
        self.api('/api/reviews/demo/decision',{'action':'ship','snapshot':self.sid})
        self.assertEqual(review_watch.ship(review.api,self.state,'claim')['checks'],'make test: ok')
        self.assertEqual(review_watch.verify_shipping(self.state,review.capture_repository)['status'],'verified')
        (root/'a.py').write_text('unreviewed\n')
        with self.assertRaisesRegex(ValueError,'worktree changed'):review_watch.verify_shipping(self.state,review.capture_repository)

    def test_delete_comments_updates_feedback_and_watcher(self):
        tid=self.comment();self.start();self.poll();review_watch.acknowledge(self.state)
        self.api('/api/threads/'+tid+'/messages',{'author':'Reviewer','body':'Still relevant'})
        batch=self.poll();review_watch.acknowledge(self.state);messages=batch['threads'][0]['messages']
        review.api(self.url,'/api/messages/'+str(messages[0]['id']),{},'DELETE')
        remaining=self.poll()['threads'][0]['messages'];self.assertEqual([m['body'] for m in remaining],['Still relevant'])
        review.api(self.url,'/api/messages/'+str(messages[1]['id']),{},'DELETE')
        self.assertEqual(self.poll()['status'],'waiting');self.assertEqual(self.api('/api/reviews/demo/feedback')['threads'],[])
        self.assertEqual(self.api('/api/reviews')[0]['openThreads'],0)
        server.init();self.assertEqual(self.api('/api/reviews/demo/feedback')['threads'],[])
        with self.assertRaises(ValueError):self.api('/api/threads/'+tid+'/messages',{'author':'Codex','body':'Stale response'})
        new=self.comment();m=self.api('/api/reviews/demo/feedback')['threads'][0]['messages'][0]
        self.assertGreater(m['id'],messages[-1]['id'])
        self.api('/api/reviews/demo/decision',{'action':'ship','snapshot':self.sid})
        with self.assertRaises(ValueError):review.api(self.url,'/api/messages/'+str(m['id']),{},'DELETE')


if __name__=='__main__': unittest.main()
