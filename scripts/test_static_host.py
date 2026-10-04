"""Assert the supplied static container headers and refusal of persistence APIs."""
import os
import time
import unittest
import urllib.error
import urllib.request

class StaticHostTests(unittest.TestCase):
    def test_asset_only_http_boundary(self):
        origin=os.environ['LIBREFLOW_WEB_TEST_URL']
        for attempt in range(40):
            try:
                with urllib.request.urlopen(origin,timeout=2) as response:
                    self.assertEqual(response.status,200)
                    csp=response.headers['Content-Security-Policy']
                    self.assertIn("form-action 'none'",csp);self.assertNotIn("'unsafe-inline'",csp)
                    self.assertEqual(response.headers['X-Content-Type-Options'],'nosniff')
                    self.assertEqual(response.headers['Referrer-Policy'],'no-referrer')
                break
            except OSError:time.sleep(.1)
        else:self.fail('Static host did not become available')
        for route in ['/api/projects','/data/users.json','/uploads/private.png','/models-static/private.onnx','/datasets-files/private','/versions/private']:
            with self.assertRaises(urllib.error.HTTPError) as denied:urllib.request.urlopen(origin+route,timeout=2)
            self.assertEqual(denied.exception.code,404)
        with self.assertRaises(urllib.error.HTTPError) as denied:
            urllib.request.urlopen(urllib.request.Request(origin,data=b'synthetic-private-payload',method='POST'),timeout=2)
        self.assertIn(denied.exception.code,(403,405))
        print('Read-only static container: asset GET/header checks passed; 6 persistence paths refused; POST refused')

if __name__=='__main__':unittest.main()
