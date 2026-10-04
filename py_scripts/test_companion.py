"""Security regression tests for the local inference companion."""
from __future__ import annotations

import hashlib
import json
import sys
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import companion


ORIGIN = "https://app.example.test"


class CompanionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state = companion.CompanionState(Path(self.temp.name), frozenset({ORIGIN}))
        self.app = companion.create_app(self.state)
        self.client = TestClient(self.app)
        self.headers = {"Origin": ORIGIN}
        self.token = None
        self.pair_code = self.state.pairing_code

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    def pair(self):
        response = self.client.post("/pair", headers=self.headers,
                                    json={"code": self.pair_code})
        self.assertEqual(response.status_code, 200, response.text)
        self.token = response.json()["token"]
        self.headers["Authorization"] = f"Bearer {self.token}"

    def register(self, kind, body, content_type="application/octet-stream"):
        return self.client.post("/objects", headers={**self.headers,
                                 "X-Object-Kind": kind, "Content-Type": content_type}, content=body)

    def test_origin_configuration_requires_exact_https_origins(self):
        for origin in ("http://app.example.test", "https://*.example.test", "https://app.example.test/path",
                       "https://user@app.example.test", "https://app.example.test?x=1"):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                companion.exact_https_origin(origin)
        self.assertEqual(companion.exact_https_origin("https://APP.example.test:443"), ORIGIN)

    def test_pairing_is_allowlisted_single_use_and_token_is_origin_bound(self):
        denied = self.client.post("/pair", headers={"Origin": "https://evil.example.test"},
                                  json={"code": self.state.pairing_code})
        self.assertEqual(denied.status_code, 403)
        self.assertIsNone(self.state.token)
        self.pair()
        reused = self.client.post("/pair", headers=self.headers,
                                  json={"code": self.pair_code})
        self.assertEqual(reused.status_code, 410)
        wrong_origin = self.client.get("/cache/" + "0" * 64,
                                       headers={"Origin": "https://evil.example.test",
                                                "Authorization": f"Bearer {self.token}"})
        self.assertEqual(wrong_origin.status_code, 403)

    def test_object_and_cache_routes_require_origin_and_token(self):
        unauthorized = self.client.post("/objects", headers={"Origin": ORIGIN,
                                       "X-Object-Kind": "image"}, content=b"data")
        self.assertEqual(unauthorized.status_code, 401)
        self.pair()
        registered = self.register("image", b"image bytes")
        self.assertEqual(registered.status_code, 200)
        item = registered.json()
        self.assertEqual(item["sha256"], hashlib.sha256(b"image bytes").hexdigest())
        self.assertEqual(len(item["id"]), 32)
        self.assertEqual(self.client.get(f"/cache/{item['sha256']}", headers=self.headers).json()["exists"], True)
        deleted = self.client.delete(f"/cache/{item['sha256']}", headers=self.headers)
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(self.client.get(f"/objects/{item['id']}", headers=self.headers).status_code, 404)

    def test_hash_kind_collision_is_rejected_and_clear_all_removes_entries(self):
        self.pair()
        content = b"same content"
        image = self.register("image", content)
        conflict = self.register("model", content, "application/onnx")
        self.assertEqual(conflict.status_code, 409)
        response = self.client.delete("/cache", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["count"], 1)
        self.assertEqual(self.state.objects, {})

    def test_model_inference_and_cache_routes_require_both_credentials(self):
        for method, path, kwargs in (
            ("get", "/objects/" + "a" * 32, {}),
            ("get", "/cache/" + "0" * 64, {}),
            ("delete", "/cache/" + "0" * 64, {}),
            ("delete", "/cache", {}),
            ("post", "/infer", {"json": {"model_id": "a" * 32, "image_id": "b" * 32}}),
            ("post", "/objects", {"content": b"model", "headers": {"X-Object-Kind": "model"}}),
        ):
            request_kwargs = dict(kwargs)
            request_headers = {"Origin": ORIGIN, **request_kwargs.pop("headers", {})}
            response = getattr(self.client, method)(path, headers=request_headers, **request_kwargs)
            self.assertEqual(response.status_code, 401, f"{method} {path}: {response.text}")

    def test_pair_requires_origin_and_has_bounded_attempts(self):
        absent = self.client.post("/pair", json={"code": self.state.pairing_code})
        self.assertEqual(absent.status_code, 403)
        for _ in range(companion.PAIRING_MAX_ATTEMPTS):
            response = self.client.post("/pair", headers=self.headers, json={"code": "incorrect-code"})
            self.assertEqual(response.status_code, 401)
        exhausted = self.client.post("/pair", headers=self.headers,
                                     json={"code": self.state.pairing_code})
        self.assertEqual(exhausted.status_code, 410)

    def test_rejects_unsafe_model_mime_and_arbitrary_paths(self):
        self.pair()
        unsafe = self.register("model", b"pickle payload", "application/x-pytorch")
        self.assertEqual(unsafe.status_code, 415)
        torch_zip = self.register("model", b"PK\x03\x04malicious checkpoint", "application/onnx")
        self.assertEqual(torch_zip.status_code, 415)
        path_route = self.client.get("/objects/etc/passwd", headers=self.headers)
        self.assertEqual(path_route.status_code, 404)
        self.assertNotIn("/workspace", path_route.text)

    def test_upload_size_limit_is_enforced(self):
        self.pair()
        too_large = b"x" * (companion.MAX_OBJECT_BYTES + 1)
        response = self.register("image", too_large)
        self.assertEqual(response.status_code, 413, response.text)
        self.assertEqual(response.json()["error"]["code"], "object_too_large")
        self.assertEqual(self.state.objects, {})

    def test_inference_timeout_is_structured_and_does_not_expose_paths(self):
        self.pair()
        model = self.register("model", b"model", "application/onnx").json()
        image = self.register("image", b"image").json()
        self.state.inference_runner = lambda *args: (_ for _ in ()).throw(RuntimeError("inference_timeout"))
        with patch.object(companion, "sandbox_available", return_value=True):
            response = self.client.post("/infer", headers=self.headers,
                                        json={"model_id": model["id"], "image_id": image["id"]})
        self.assertEqual(response.status_code, 504)
        self.assertEqual(response.json()["error"]["code"], "inference_timeout")
        self.assertNotIn(str(self.state.root), response.text)

    def test_health_reports_capabilities_without_claiming_s3(self):
        with patch.object(companion, "sandbox_available", return_value=False):
            response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["capabilities"]["onnx"])
        self.assertFalse(response.json()["capabilities"]["s3"])

    def test_sandbox_command_keeps_venv_and_python_paths_in_place(self):
        command = companion.build_sandbox_command(
            "/usr/bin/bwrap", Path(sys.prefix), Path(sys.base_prefix), sys.executable,
            Path(companion.__file__).with_name("companion_worker.py"), Path(self.temp.name), 45)
        self.assertIn(sys.executable, command)
        self.assertIn(str(Path(sys.prefix)), command)
        self.assertIn(str(Path(sys.base_prefix)), command)
        self.assertIn("/etc/ld.so.cache", command)
        self.assertNotIn("/etc", [command[i + 1] for i, part in enumerate(command[:-1])
                                   if part == "--ro-bind"])

    def test_docker_fallback_uses_pinned_image_no_host_mounts_and_cleans_its_id(self):
        image_id = "sha256:" + "a" * 64
        container_id = "b" * 64
        calls = []

        def fake_run(args, **kwargs):
            calls.append((args, kwargs))
            if args[1] == "create":
                return subprocess.CompletedProcess(args, 0, stdout=container_id)
            return subprocess.CompletedProcess(args, 0, stdout=b"")

        class AttachedWorker:
            returncode = 0
            def communicate(self, timeout, input=None):
                return (b'{"results":[],"count":0,"message":"No detections above threshold."}', None)
            def poll(self): return self.returncode
            def kill(self): self.returncode = -9
        with patch.object(companion.shutil, "which", return_value="/usr/bin/docker"), \
             patch.object(companion.subprocess, "run", side_effect=fake_run), \
             patch.object(companion.subprocess, "Popen", return_value=AttachedWorker()):
            model_path = Path(self.temp.name) / "model.onnx"
            image_path = Path(self.temp.name) / "image.bin"
            model_path.write_bytes(b"onnx")
            image_path.write_bytes(b"image")
            result = companion.run_docker_inference(model_path, image_path, 45, .3, image_id)

        self.assertEqual(result["count"], 0)
        create = calls[0][0]
        self.assertIn(image_id, create)
        for flag in ("--network", "none", "--read-only", "--cap-drop", "ALL", "--memory", "2g",
                     "--cpus", "2", "--pids-limit", "64", "--user", "65534:65534",
                     "--security-opt", "no-new-privileges"):
            self.assertIn(flag, create)
        self.assertNotIn("--volume", create)
        self.assertNotIn("--mount", create)
        self.assertEqual(calls[-1][0], ["/usr/bin/docker", "rm", "--force", "--volumes", container_id])

    def test_docker_timeout_force_removes_only_created_container(self):
        image_id = "sha256:" + "a" * 64
        container_id = "c" * 64
        calls = []

        def fake_run(args, **kwargs):
            calls.append(args)
            if args[1] == "create":
                return subprocess.CompletedProcess(args, 0, stdout=container_id)
            return subprocess.CompletedProcess(args, 0, stdout=b"")

        class TimedOutWorker:
            returncode = None
            first = True
            def communicate(self, timeout, input=None):
                if self.first:
                    self.first = False
                    raise subprocess.TimeoutExpired(["docker", "start", "--attach"], timeout)
                return (b"", None)
            def poll(self): return self.returncode
            def kill(self): self.returncode = -9
        with patch.object(companion.shutil, "which", return_value="/usr/bin/docker"), \
             patch.object(companion.subprocess, "run", side_effect=fake_run), \
             patch.object(companion.subprocess, "Popen", return_value=TimedOutWorker()):
            model_path = Path(self.temp.name) / "model.onnx"
            image_path = Path(self.temp.name) / "image.bin"
            model_path.write_bytes(b"onnx")
            image_path.write_bytes(b"image")
            with self.assertRaisesRegex(RuntimeError, "inference_timeout"):
                companion.run_docker_inference(model_path, image_path, 1, .25, image_id)
        self.assertEqual(calls[-1], ["/usr/bin/docker", "rm", "--force", "--volumes", container_id])


if __name__ == "__main__":
    unittest.main()
