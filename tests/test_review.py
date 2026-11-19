import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
def module(name):
    spec=importlib.util.spec_from_file_location(name, ROOT/f'{name}.py')
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result
server=module('server');review=module('review')

class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        server.DATA=self.root/'data';server.init()
        self.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        self.worker=threading.Thread(target=self.http.serve_forever,daemon=True);self.worker.start()
        self.url=f'http://127.0.0.1:{self.http.server_port}'
        self.repo=self.root/'repo';self.repo.mkdir()
        self.git('init','-q');self.git('config','user.email','test@example.invalid');self.git('config','user.name','Test')
        (self.repo/'a.txt').write_text('one\ntwo\nthree\n')
        (self.repo/'rename.txt').write_text('rename me\n')
        (self.repo/'delete.txt').write_text('delete me\n')
        (self.repo/'.gitignore').write_text('ignored\n')
        self.git('add','.');self.git('commit','-qm','base')
        self.base=self.git('rev-parse','HEAD').strip()

    def tearDown(self):
        self.http.shutdown();self.http.server_close();self.worker.join();self.tmp.cleanup()

    def git(self,*args):
        return subprocess.check_output(['git','-C',str(self.repo),*args],text=True)

    def payload(self):
        return {'id':'task-test','title':'Test task','description':'A review', 'repos':[review.capture_repository({'name':'repo','path':str(self.repo),'base':self.base})]}

    def api(self,path,data=None,method=None):return review.api(self.url,path,data,method)

    def test_snapshot_covers_commits_index_worktree_new_deleted_and_rename(self):
        (self.repo/'a.txt').write_text('committed\ntwo\nthree\n');self.git('commit','-qam','change')
        (self.repo/'a.txt').write_text('committed\nstaged\nthree\n');self.git('add','a.txt')
        (self.repo/'a.txt').write_text('committed\nstaged\nworking\n')
        (self.repo/'new.txt').write_text('new\n');(self.repo/'ignored').write_text('ignored')
        self.git('mv','rename.txt','renamed.txt');(self.repo/'delete.txt').unlink()
        payload=self.payload();files={f['path']:f for f in payload['repos'][0]['files']}
        self.assertEqual(set(files),{'a.txt','new.txt','renamed.txt','delete.txt'})
        self.assertEqual(files['a.txt']['old'],'one\ntwo\nthree\n');self.assertIn('working',files['a.txt']['new'])
        self.assertEqual(files['renamed.txt']['status'],'R');self.assertEqual(files['renamed.txt']['oldPath'],'rename.txt')
        self.assertEqual(files['delete.txt']['new'],'')
        first=self.api('/api/reviews',payload);again=self.api('/api/reviews',payload)
        self.assertTrue(again['unchanged']);self.assertEqual(first['snapshot'],again['snapshot'])

    def test_feedback_survives_new_snapshot_and_database_reopen(self):
        (self.repo/'a.txt').write_text('one\nchanged\nthree\n');sid=self.api('/api/reviews',self.payload())['snapshot']
        tid=self.api('/api/threads',{'snapshot':sid,'repo':'repo','path':'a.txt','side':'new','line':2,'author':'Reviewer','body':'Why this change?'})['id']
        self.api(f'/api/threads/{tid}/messages',{'author':'Codex','body':'Because the old value was wrong.'})
        (self.repo/'a.txt').write_text('inserted\none\nfixed\nthree\n');sid2=self.api('/api/reviews',self.payload())['snapshot']
        self.assertNotEqual(sid,sid2);server.init()
        feedback=self.api('/api/reviews/task-test/feedback');thread=feedback['threads'][0]
        self.assertEqual(thread['code'],'changed');self.assertEqual(thread['line'],2);self.assertEqual(thread['snapshot_id'],sid)
        self.assertEqual(len(thread['messages']),2)
        self.api(f'/api/threads/{tid}',{'status':'resolved'},'PATCH')
        self.assertEqual(self.api('/api/reviews/task-test/feedback')['threads'][0]['status'],'resolved')
        self.api(f'/api/threads/{tid}',{'status':'open'},'PATCH')
        self.assertEqual(self.api('/api/reviews/task-test/feedback')['threads'][0]['status'],'open')

    def test_deleted_lines_and_line_validation(self):
        (self.repo/'delete.txt').unlink();sid=self.api('/api/reviews',self.payload())['snapshot']
        anchor={'snapshot':sid,'repo':'repo','path':'delete.txt','side':'old','line':1,'author':'Reviewer','body':'Keep it?'}
        self.api('/api/threads',anchor)
        for delta in [{'line':0},{'line':99},{'side':'new'},{'path':'../secret'},{'line':True}]:
            with self.assertRaises(ValueError):self.api('/api/threads',dict(anchor,**delta))
        detail=self.api(f'/api/snapshots/{sid}/file?repo=repo&path=delete.txt')
        self.assertEqual(detail['blocks'][0]['rows'][0]['old']['number'],1)
        self.assertIsNone(detail['blocks'][0]['rows'][0]['new'])

    def test_symlink_binary_and_scope(self):
        secret=self.root/'secret';secret.write_text('do not read me')
        (self.repo/'link').symlink_to(secret)
        (self.repo/'binary').write_bytes(b'a\x00b')
        (self.repo/'large').write_text('x'*(1024*1024+1))
        files={f['path']:f for f in self.payload()['repos'][0]['files']}
        self.assertEqual(files['link']['new'],str(secret));self.assertNotIn('do not read me',json.dumps(files))
        self.assertIsNone(files['binary']['new']);self.assertIsNone(files['large']['new'])
        scoped=review.capture_repository({'name':'r','path':str(self.repo),'base':self.base,'include':['link']})
        self.assertEqual([f['path'] for f in scoped['files']],['link'])
        with self.assertRaises(ValueError):review.capture_repository({'name':'r','path':str(self.repo),'branch':'wrong'})

    def test_multiple_repositories_and_viewed_isolation(self):
        (self.repo/'a.txt').write_text('changed');payload=self.payload();second=dict(payload['repos'][0],name='second');payload['repos'].append(second)
        sid=self.api('/api/reviews',payload)['snapshot']
        self.api(f'/api/snapshots/{sid}/viewed',{'repo':'repo','path':'a.txt','viewed':True})
        detail=self.api('/api/reviews/task-test')
        self.assertEqual(detail['viewed'],[{'repo':'repo','path':'a.txt'}]);self.assertEqual(len(detail['repos']),2)
        self.assertNotIn('new',detail['repos'][0]['files'][0])
        self.api(f'/api/snapshots/{sid}/viewed',{'repo':'repo','path':'a.txt','viewed':False})
        self.assertEqual(self.api('/api/reviews/task-test')['viewed'],[])

    def test_local_origin_host_and_json_guards(self):
        for headers in [{'Origin':'https://evil.example'},{'Host':'evil.example'},{'Content-Type':'text/plain'}]:
            req=Request(self.url+'/api/reviews',data=b'{}',headers={'Content-Type':'application/json',**headers})
            with self.assertRaises(HTTPError) as caught:urlopen(req)
            self.assertIn(caught.exception.code,(400,403))
        req=Request(self.url+'/../server.py')
        with self.assertRaises(HTTPError) as caught:urlopen(req)
        self.assertEqual(caught.exception.code,404)
        with urlopen(self.url) as result:
            self.assertIn("frame-ancestors 'none'",result.headers['Content-Security-Policy'])

    def test_hunk_line_numbers_and_blank_lines(self):
        rows=server.diff_rows('a\nb\nc\n','a\n\nc\nd\n')[0]['rows']
        self.assertEqual([(r['new']['number'],r['new']['text']) for r in rows if r['new']],[(1,'a'),(2,''),(3,'c'),(4,'d')])

    def test_git_diff_and_cross_repository_move(self):
        original = 'first\nsecond\nthird\nfourth\nfifth\n'
        (self.repo/'moved.py').write_text(original)
        self.git('add','.');self.git('commit','-qm','source')
        base=self.git('rev-parse','HEAD').strip()
        (self.repo/'moved.py').unlink()
        source=review.capture_repository({'name':'source','path':str(self.repo),'base':base})
        destination={'name':'destination','source':str(self.repo),'base':base,'files':[{
            'path':'nested/moved.py','oldPath':'nested/moved.py','status':'A','old':'','new':original.replace('third','changed'),
            'oldMode':'','newMode':'100644','oldHash':'','newHash':'different','note':''}]}
        review.prepare_comparisons([source,destination])
        moved=destination['files'][0]
        self.assertEqual(moved['status'],'R');self.assertEqual(moved['oldRepo'],'source')
        self.assertEqual((moved['added'],moved['removed']),(1,1))
        changed=[r for b in moved['blocks'] for r in b['rows'] if r['kind']!='equal']
        self.assertEqual(changed[0]['old'],{'number':3,'text':'third'})
        self.assertEqual(changed[0]['new'],{'number':3,'text':'changed'})
        self.assertEqual(source['files'][0]['movedTo'],{'repo':'destination','path':'nested/moved.py'})

    def test_explicit_copy_reads_source_from_git_and_keeps_line_anchor(self):
        (self.repo/'a.txt').write_text('working value must not become baseline\n')
        (self.repo/'copy.txt').write_text('one\nchanged\nthree\n')
        payload=self.payload()
        review.prepare_comparisons(payload['repos'],[{'repo':'repo','path':'copy.txt','fromRepo':'repo','fromPath':'a.txt'}])
        copied=next(f for f in payload['repos'][0]['files'] if f['path']=='copy.txt')
        self.assertEqual(copied['status'],'C');self.assertEqual(copied['old'],'one\ntwo\nthree\n')
        sid=self.api('/api/reviews',payload)['snapshot']
        self.api('/api/threads',{'snapshot':sid,'repo':'repo','path':'copy.txt','side':'old','line':2,'author':'Reviewer','body':'Why change two?'})
        self.assertEqual(self.api('/api/reviews/task-test/feedback')['threads'][0]['code'],'two')

    def test_ambiguous_sources_remain_additions(self):
        original='same content\n'
        for p in ['one.txt','two.txt']:(self.repo/p).write_text(original)
        self.git('add','.');self.git('commit','-qm','duplicates');base=self.git('rev-parse','HEAD').strip()
        for p in ['one.txt','two.txt']:(self.repo/p).unlink()
        (self.repo/'new.txt').write_text(original)
        r=review.capture_repository({'name':'r','path':str(self.repo),'base':base})
        review.prepare_comparisons([r])
        self.assertEqual(next(f for f in r['files'] if f['path']=='new.txt')['status'],'A')

    def test_file_comments_are_persistent_and_do_not_fake_line_numbers(self):
        (self.repo/'empty').write_text('');sid=self.api('/api/reviews',self.payload())['snapshot']
        self.api('/api/threads',{'snapshot':sid,'repo':'repo','path':'empty','side':'file','line':0,'author':'Reviewer','body':'Is this file needed?'})
        t=self.api('/api/reviews/task-test/feedback')['threads'][0]
        self.assertEqual((t['side'],t['line'],t['code']),('file',0,''))

if __name__=='__main__':unittest.main()
