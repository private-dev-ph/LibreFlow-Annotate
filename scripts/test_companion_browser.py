"""Verify HTTPS browser pairing/inference and the static host's data-flow boundary."""
import base64
import http.server
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from urllib.parse import urlsplit

import cv2
import numpy as np
import onnx
from onnx import helper, TensorProto, numpy_helper
from playwright.sync_api import sync_playwright
from test_web_browser import StaticHandler

REPO=Path(__file__).resolve().parents[1]

class CompanionBrowserTests(unittest.TestCase):
    def test_paired_isolated_inference_sends_user_bytes_only_to_loopback(self):
        with tempfile.TemporaryDirectory(prefix='libreflow-browser-companion-') as directory:
            root=Path(directory)
            subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(root/'key.pem'),'-out',str(root/'cert.pem'),'-days','1','-subj','/CN=localhost'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            server=http.server.ThreadingHTTPServer(('127.0.0.1',0),StaticHandler)
            tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);tls.load_cert_chain(root/'cert.pem',root/'key.pem');server.socket=tls.wrap_socket(server.socket,server_side=True)
            threading.Thread(target=server.serve_forever,daemon=True).start()
            origin=f'https://127.0.0.1:{server.server_port}'
            environment={**os.environ,'COMPANION_ALLOWED_ORIGINS':origin}
            # No S3 credentials are needed for the inference fixture.
            environment.pop('LIBREFLOW_S3_BUCKET',None)
            process=subprocess.Popen([sys.executable,'py_scripts/companion.py'],cwd=REPO,env=environment,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            try:
                line=process.stdout.readline().strip();self.assertIn('pairing code',line)
                code=line.rsplit(': ',1)[1]
                for attempt in range(60):
                    try:
                        with urllib.request.urlopen('http://127.0.0.1:8787/health',timeout=1) as r:health=json.load(r)
                        break
                    except OSError:time.sleep(.1)
                else:self.fail('Companion failed to start')
                self.assertTrue(health['capabilities']['onnx'],'A restricted worker image or bubblewrap runtime is required')
                prediction=np.array([[[32,0],[32,0],[20,0],[20,0],[.99,0]]],np.float32)
                constant=helper.make_node('Constant',[],['detections'],value=numpy_helper.from_array(prediction))
                graph=helper.make_graph([constant],'smoke',[helper.make_tensor_value_info('images',TensorProto.FLOAT,[1,3,64,64])],[helper.make_tensor_value_info('detections',TensorProto.FLOAT,[1,5,2])])
                model=helper.make_model(graph,opset_imports=[helper.make_opsetid('',13)]);model.ir_version=8;model.metadata_props.add(key='names',value='{"0":"object"}')
                onnx.checker.check_model(model)
                with sync_playwright() as p:
                    executable=os.environ.get('CHROMIUM_EXECUTABLE','/usr/bin/chromium')
                    browser=p.chromium.launch(executable_path=executable if Path(executable).exists() else None,args=['--no-sandbox'])
                    context=browser.new_context(ignore_https_errors=True);page=context.new_page();traffic=[];errors=[]
                    page.on('request',lambda r:traffic.append((r.method,r.url,r.post_data_buffer)))
                    page.on('pageerror',lambda e:errors.append(str(e)))
                    try:
                        page.goto(origin);page.select_option('#provider','fallback');page.fill('#passphrase','private browser fixture passphrase');page.click('#create');page.wait_for_selector('#workspace',state='visible')
                        page.fill('#project-name','companion-private-project');page.click('#new-project');page.wait_for_function("() => document.querySelector('#projects').options.length===1")
                        ok,image=cv2.imencode('.png',np.zeros((64,64,3),np.uint8));self.assertTrue(ok)
                        page.set_input_files('#images',{'name':'private.png','mimeType':'image/png','buffer':image.tobytes()});page.wait_for_function("() => document.querySelector('#image-list').options.length===1")
                        page.click('#companion-connection summary');page.fill('#pair-code',code);page.click('#pair');page.wait_for_function("() => document.querySelector('#status').textContent.includes('Companion paired')")
                        page.get_by_text('Local inference companion',exact=True).click()
                        page.set_input_files('#model-file',{'name':'private-model.onnx','mimeType':'application/onnx','buffer':model.SerializeToString()});page.wait_for_function("() => document.querySelector('#model-list').options.length===1")
                        page.click('#infer');page.wait_for_function("() => Canvas.getShapes().some(s=>s.type==='bbox'&&s.label==='object')",timeout=60000)
                        uploads=sum('/objects'==urlsplit(url).path and method=='POST' for method,url,_ in traffic)
                        self.assertEqual(uploads,2)
                        page.click('#save');page.wait_for_function("() => document.querySelector('#revisions').options.length===1")
                        with page.expect_response(lambda r: urlsplit(r.url).path=='/infer',timeout=60000) as inference:
                            page.click('#infer')
                        self.assertEqual(inference.value.status,200)
                        page.wait_for_function("() => document.querySelector('#status').textContent.includes('annotation(s) generated')",timeout=60000)
                        self.assertEqual(page.evaluate("Canvas.getShapes().filter(s=>s.type==='bbox'&&s.label==='object').length"),1)
                        self.assertEqual(sum('/objects'==urlsplit(url).path and method=='POST' for method,url,_ in traffic),uploads)
                        page.click('#clear-cache');page.wait_for_function("() => document.querySelector('#status').textContent.includes('caches cleared')")
                        self.assertFalse(errors,errors)
                        host=[r for r in traffic if urlsplit(r[1]).netloc==urlsplit(origin).netloc]
                        for method,url,body in host:self.assertEqual(method,'GET',url);self.assertIsNone(body,url);self.assertEqual(urlsplit(url).query,'')
                        local=[r for r in traffic if urlsplit(r[1]).scheme in ('blob','data')]
                        for _,url,_ in local:
                            if url.startswith('blob:'):self.assertTrue(url.startswith(f'blob:{origin}/'),url)
                        others=[r for r in traffic if urlsplit(r[1]).scheme in ('http','https') and urlsplit(r[1]).netloc!=urlsplit(origin).netloc]
                        self.assertTrue(others)
                        for _,url,_ in others:self.assertEqual(urlsplit(url).netloc,'127.0.0.1:8787',url)
                        print(f'HTTPS companion privacy verification: {len(host)} asset host GETs; 2 byte uploads only to loopback; isolated ONNX bbox, hash cache reuse and cache clearing passed')
                    finally:browser.close()
            finally:
                process.terminate()
                try:process.wait(timeout=10)
                except subprocess.TimeoutExpired:process.kill();process.wait()
                process.stdout.close();process.stderr.close();server.shutdown();server.server_close()

if __name__=='__main__':unittest.main()
