"""Exercise the built web runtime and fail if the static host receives user data."""
import base64
import http.server
import json
import os
from pathlib import Path
import threading
import unittest
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1] / 'dist' / 'web'
class StaticHandler(http.server.SimpleHTTPRequestHandler):
    traffic = []
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)
    def do_GET(self):
        self.traffic.append(('GET', self.path, 0))
        super().do_GET()
    def do_POST(self):
        self.traffic.append(('POST', self.path, int(self.headers.get('Content-Length', '0'))))
        self.send_error(405)
    do_PUT = do_POST
    do_PATCH = do_POST
    do_DELETE = do_POST
    def log_message(self, *_): pass
    def end_headers(self):
        lines = (ROOT / '_headers').read_text().splitlines()[1:]
        for line in lines:
            name, value = line.strip().split(': ', 1)
            self.send_header(name, value)
        super().end_headers()

class PrivacyBrowserTests(unittest.TestCase):
    def test_static_workspace_flow(self):
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), StaticHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        origin = os.environ.get('LIBREFLOW_WEB_TEST_URL') or f'http://127.0.0.1:{server.server_port}'
        with sync_playwright() as p:
            executable = os.environ.get('CHROMIUM_EXECUTABLE', '/usr/bin/chromium')
            browser = p.chromium.launch(executable_path=executable if Path(executable).exists() else None, args=['--no-sandbox'])
            page = browser.new_page(accept_downloads=True)
            errors=[]; requests=[]
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type=='error' else None)
            page.on('request', lambda r: requests.append((r.method,r.url,r.post_data)))
            try:
                page.goto(origin)
                page.select_option('#provider','fallback')
                page.fill('#passphrase','browser test private passphrase')
                page.click('#create')
                page.wait_for_selector('#workspace', state='visible')
                page.fill('#project-name','<img src=x onerror=alert(1)> private-project')
                page.click('#new-project')
                page.wait_for_function("() => document.querySelector('#projects').options.length===1")
                # A genuine PNG; browser decoder and workspace encryption both run.
                png=base64.b64decode(page.evaluate("() => { const c=document.createElement('canvas');c.width=64;c.height=64;return c.toDataURL('image/png').split(',')[1]; }"))
                page.set_input_files('#images',{'name':'private-image.png','mimeType':'image/png','buffer':png})
                page.wait_for_function("() => document.querySelector('#image-list').options.length===1")
                page.wait_for_timeout(300)
                page.evaluate("Canvas.addClassification('private-label')")
                page.click('#save')
                page.wait_for_function("() => document.querySelector('#revisions').options.length===1")
                page.select_option('#review','approved');page.click('#save-review')
                page.fill('#review-comment','<script>alert(1)</script> private-review');page.click('#add-comment')
                page.wait_for_function("() => document.querySelector('#comments').textContent.includes('private-review')")
                self.assertEqual(page.locator('#comments script').count(),0)
                page.click('#version');page.wait_for_function("() => document.querySelector('#status').textContent.includes('immutable dataset version')")
                session=page.evaluate('LibreFlowWeb.api.restoreSession()');self.assertIn('imageId',session)
                page.check('#offline');page.evaluate("Canvas.addClassification('offline-label')");page.click('#save')
                page.wait_for_function("() => LibreFlowWeb.workspace.status.pending>0")
                page.uncheck('#offline');page.click('#retry');page.wait_for_function("() => LibreFlowWeb.workspace.status.pending===0")
                with page.expect_download() as download:
                    page.click('#export')
                backup=json.loads(Path(download.value.path()).read_text())
                self.assertEqual(backup['format'],'libreflow-portable')
                self.assertNotIn('private-label',json.dumps(backup))
                # Model selection/upload remains browser/provider-local; no host endpoint.
                page.set_input_files('#model-file',{'name':'untrusted.onnx','mimeType':'application/octet-stream','buffer':b'invalid ONNX fixture'})
                page.wait_for_function("() => document.querySelector('#model-list').options.length===1")
                # Crash recovery: cache an unsaved draft, reload, import the cloud/portable
                # source of truth, then unlock the same encrypted IndexedDB namespace.
                page.evaluate("Canvas.addClassification('crash-recovered-label')")
                page.wait_for_function("async () => (await LibreFlowWeb.workspace.readDraft(document.querySelector('#image-list').value))?.some(s=>s.label==='crash-recovered-label')")
                page.reload()
                page.select_option('#provider','fallback');page.fill('#passphrase','browser test private passphrase')
                page.set_input_files('#import',{'name':'backup.json','mimeType':'application/json','buffer':json.dumps(backup).encode()})
                page.wait_for_selector('#workspace',state='visible')
                page.wait_for_function("() => Canvas.getShapes().some(s=>s.label==='crash-recovered-label')")
                page.click('#save');page.wait_for_function("async () => (await LibreFlowWeb.workspace.readDraft(document.querySelector('#image-list').value))===null")
                self.assertFalse(errors,errors)
                host_requests=[r for r in requests if urlsplit(r[1]).netloc==urlsplit(origin).netloc]
                self.assertTrue(host_requests)
                for method,url,body in host_requests:
                    self.assertEqual(method,'GET',url);self.assertIsNone(body,url)
                    self.assertEqual(urlsplit(url).query,'',url)
                    self.assertNotIn('/api/',url);self.assertNotIn('private-',url)
                self.assertTrue(all(method=='GET' and size==0 for method,_,size in StaticHandler.traffic))
                print(f'Stateless browser verification: {len(host_requests)} asset-only host requests; project/image/annotation/review/version/session/model/offline flows passed')
            except Exception:
                print('Browser status:',page.locator('#status').inner_text());print('Browser errors:',errors);raise
            finally:
                browser.close();server.shutdown();server.server_close()

if __name__=='__main__': unittest.main()
