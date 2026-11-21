import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest import mock
import zipfile

ROOT = Path(__file__).resolve().parents[1]
def module(name, path):
    spec=importlib.util.spec_from_file_location(name, path)
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result
review=module('review', ROOT/'review.py');build=module('vscode_build', ROOT/'vscode'/'build.py')

class SetupTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'setup.json'
        self.env=mock.patch.dict(os.environ,{'PREPR_SETUP':str(self.path)});self.env.start()
    def tearDown(self):
        self.env.stop();self.tmp.cleanup()

    def test_first_run_reports_missing_then_merges_choices(self):
        self.assertEqual(review.setup_status(review.load_setup()),{'configured':False,'missing':['vscode','pr']})
        review.save_setup(pr={'platform':'github','access':'gh CLI as demo-kode'})
        review.save_setup(vscode='declined')
        status=review.setup_status(review.load_setup())
        self.assertTrue(status['configured']);self.assertEqual(status['pr']['access'],'gh CLI as demo-kode')
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode),0o600)

    def test_cli_setup_merges_pr_fields(self):
        run=lambda *a:json.loads(subprocess.check_output(['python3',str(ROOT/'review.py'),'setup',*a],env={**os.environ},text=True))
        run('--pr-platform','azure-devops','--pr-access','az repos; org demo; project tools')
        status=run('--vscode','installed')
        self.assertEqual(status['pr'],{'platform':'azure-devops','access':'az repos; org demo; project tools'})
        self.assertEqual(run('--pr-platform','github')['pr']['access'],'az repos; org demo; project tools')

    def test_open_target_prefers_vscode_when_installed(self):
        self.assertEqual(review.open_target({},'http://127.0.0.1:18744/','abc',3),('browser','http://127.0.0.1:18744/?review=abc&snapshot=3'))
        self.assertEqual(review.open_target({'vscode':'installed'},'http://x','abc'),('vscode','vscode://demo-kode.prepr/open?review=abc'))
        with self.assertRaises(ValueError):review.open_review('http://x','bad id')

    def test_open_falls_back_to_browser_without_code(self):
        review.save_setup(vscode='installed')
        with mock.patch.object(review.subprocess,'run',side_effect=FileNotFoundError),mock.patch('webbrowser.open',return_value=True) as browser:
            self.assertEqual(review.open_review('http://x','abc'),{'opened':'browser','url':'http://x/?review=abc'})
        browser.assert_called_once_with('http://x/?review=abc')

class VsixTests(unittest.TestCase):
    def test_vsix_layout_matches_package(self):
        with tempfile.TemporaryDirectory() as tmp:
            path,ext_id=build.build(tmp)
            pkg=json.loads((ROOT/'vscode'/'package.json').read_text())
            self.assertEqual(ext_id,'demo-kode.prepr');self.assertEqual(review.VSCODE_EXTENSION,ext_id)
            with zipfile.ZipFile(path) as z:
                names=set(z.namelist())
                self.assertEqual(names,{'[Content_Types].xml','extension.vsixmanifest','extension/package.json','extension/extension.js','extension/README.md','extension/media/icon.png','extension/media/icon.svg'})
                m=z.read('extension.vsixmanifest').decode()
                self.assertIn(f'Version="{pkg["version"]}" Publisher="demo-kode"',m)
                # Installed copy carries the tool folder, so the extension can keep the agent runner up.
                self.assertEqual(pkg['contributes']['configuration']['properties']['prepr.toolPath']['default'],'')
                pkg['contributes']['configuration']['properties']['prepr.toolPath']['default']=str(ROOT)
                self.assertEqual(json.loads(z.read('extension/package.json')),pkg)
                self.assertIn('Path="extension/media/icon.png"',m);self.assertEqual(z.read('extension/media/icon.png')[:8],b'\x89PNG\r\n\x1a\n')

if __name__=='__main__':unittest.main()
