import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import subprocess
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import review
import review_watch
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

    def test_keep_closes_and_preserves_review(self):
        tid=self.comment();self.start()
        result=self.api('/api/reviews/demo/decision',{'action':'keep','snapshot':self.sid})
        self.assertEqual(result,self.api('/api/reviews/demo/decision',{'action':'keep','snapshot':self.sid}))
        self.assertEqual(self.poll()['status'],'kept');self.assertEqual(self.start()['status'],'kept')
        self.assertFalse(self.api('/api/reviews/demo/watch')['watcher']['active'])
        with self.assertRaises(ValueError):self.comment()
        with self.assertRaises(ValueError):self.api('/api/threads/'+tid+'/messages',{'author':'Reviewer','body':'Late reply'})
        with self.assertRaises(ValueError):self.api('/api/reviews/demo/decision',{'action':'ship','snapshot':self.sid})
        self.payload['description']='more changes'
        with self.assertRaises(ValueError):self.api('/api/reviews',self.payload)
        self.assertEqual(len(self.api('/api/reviews/demo/feedback')['threads']),1)
        server.init();self.assertEqual(self.api('/api/reviews/demo')['decision']['status'],'kept')

    def test_stale_snapshot_cannot_close_or_ship(self):
        self.payload['description']='new snapshot';self.api('/api/reviews',self.payload)
        for action in ['keep','ship']:
            with self.assertRaises(ValueError):self.api('/api/reviews/demo/decision',{'action':action,'snapshot':self.sid})
        self.assertIsNone(self.api('/api/reviews/demo/watch')['decision'])

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
        review_watch.ship(review.api,self.state,'claim')
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
        self.payload['repos']=[review.capture_repository({'name':'app','path':str(root),'base':base})]
        self.sid=self.api('/api/reviews',self.payload)['snapshot'];self.start()
        self.api('/api/reviews/demo/decision',{'action':'ship','snapshot':self.sid});review_watch.ship(review.api,self.state,'claim')
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
        self.api('/api/reviews/demo/decision',{'action':'keep','snapshot':self.sid})
        with self.assertRaises(ValueError):review.api(self.url,'/api/messages/'+str(m['id']),{},'DELETE')


if __name__=='__main__': unittest.main()
