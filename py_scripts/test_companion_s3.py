"""Offline tests for the paired companion S3 storage adapter."""
from __future__ import annotations

import io
import sys
import unittest
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent))
import companion_s3


class FakeS3Error(Exception):
    def __init__(self, code: str, status: int):
        super().__init__(code)
        self.response = {
            "Error": {"Code": code},
            "ResponseMetadata": {"HTTPStatusCode": status},
        }


class FakeBody(io.BytesIO):
    pass


class FakeS3:
    def __init__(self):
        self.objects = {}
        self.counter = 0
        self.failure = None

    def _check(self):
        if self.failure:
            raise self.failure

    def list_objects_v2(self, **args):
        self._check()
        prefix = args["Prefix"]
        keys = sorted(key for key in self.objects if key.startswith(prefix))
        contents, prefixes = [], set()
        for key in keys:
            remainder = key[len(prefix):]
            if "/" in remainder:
                prefixes.add(prefix + remainder.split("/", 1)[0] + "/")
            else:
                body, etag = self.objects[key]
                contents.append({"Key": key, "Size": len(body), "ETag": etag})
        return {"Contents": contents, "CommonPrefixes": [{"Prefix": k} for k in sorted(prefixes)]}

    def put_object(self, **args):
        self._check()
        key = args["Key"]
        current = self.objects.get(key)
        if args.get("IfNoneMatch") == "*" and current:
            raise FakeS3Error("PreconditionFailed", 412)
        if "IfMatch" in args and (not current or current[1] != args["IfMatch"]):
            raise FakeS3Error("PreconditionFailed", 412)
        self.counter += 1
        etag = f'"etag-{self.counter}"'
        body = args["Body"]
        self.objects[key] = (body, etag)
        return {"ETag": etag}

    def head_object(self, **args):
        self._check()
        if args["Key"] not in self.objects:
            raise FakeS3Error("NoSuchKey", 404)
        body, etag = self.objects[args["Key"]]
        return {"ContentLength": len(body), "ETag": etag}

    def get_object(self, **args):
        self._check()
        body, etag = self.objects[args["Key"]]
        return {"Body": FakeBody(body), "ETag": etag}


class CompanionS3Tests(unittest.TestCase):
    def setUp(self):
        self.client = FakeS3()
        self.app = FastAPI()

        @self.app.exception_handler(HTTPException)
        async def structured_http_error(request, exc):
            from fastapi.responses import JSONResponse
            detail = exc.detail if isinstance(exc.detail, dict) else {"code": "request_rejected", "message": str(exc.detail)}
            return JSONResponse(status_code=exc.status_code, content={"error": detail}, headers=exc.headers)

        async def authorize(request):
            if request.headers.get("authorization") != "Bearer paired":
                raise HTTPException(401, {"code": "unauthorized", "message": "Pair first"})
            return "https://web.example.test"

        self.backend = companion_s3.attach_s3_routes(
            self.app, authorize, client=self.client,
            storage=companion_s3.S3CompanionStorage(
                "private-bucket", "users/alice", client=self.client,
                id_secret=b"s" * 32,
            ),
        )
        self.http = TestClient(self.app)
        self.headers = {"Authorization": "Bearer paired"}

    def test_create_list_stat_read_and_conditional_overwrite(self):
        saved = self.http.post("/storage/s3/write?name=labels.json", headers=self.headers, content=b"one")
        self.assertEqual(saved.status_code, 200, saved.text)
        item = saved.json()
        self.assertEqual(item["provider"]["name"], "s3-companion")
        self.assertEqual(self.client.objects["users/alice/labels.json"][0], b"one")
        listed = self.http.get("/storage/s3/list?parentId=root", headers=self.headers).json()["items"]
        self.assertEqual([entry["id"] for entry in listed], [item["id"]])
        stat = self.http.get(f"/storage/s3/stat/{item['id']}", headers=self.headers).json()
        self.assertEqual(stat["revision"], item["revision"])
        self.assertEqual(self.http.get(f"/storage/s3/read/{item['id']}", headers=self.headers).content, b"one")

        updated = self.http.post(
            f"/storage/s3/write?id={item['id']}&expectedRevision=%22etag-1%22",
            headers=self.headers, content=b"two",
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        conflict = self.http.post(
            f"/storage/s3/write?id={item['id']}&expectedRevision=%22etag-1%22",
            headers=self.headers, content=b"stale",
        )
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json()["error"]["code"], "conflict")

    def test_directory_and_unsafe_ids_names_and_prefixes(self):
        folder = self.http.post("/storage/s3/mkdir", headers=self.headers, json={"name": "images"})
        self.assertEqual(folder.status_code, 200, folder.text)
        created = self.http.post(
            f"/storage/s3/write?parentId={folder.json()['id']}&name=frame.png",
            headers=self.headers, content=b"pixels",
        )
        self.assertEqual(created.status_code, 200, created.text)
        child_list = self.http.get(f"/storage/s3/list?parentId={folder.json()['id']}", headers=self.headers)
        self.assertEqual(child_list.json()["items"][0]["name"], "frame.png")
        for unsafe in ("../escape", "a/b", "a\\b", "."):
            response = self.http.post(f"/storage/s3/write?name={unsafe}", headers=self.headers, content=b"x")
            self.assertIn(response.status_code, (400, 404))
        self.assertEqual(self.http.get("/storage/s3/stat/../secret", headers=self.headers).status_code, 404)
        self.assertEqual(self.http.get("/storage/s3/stat/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", headers=self.headers).status_code, 404)
        bad_parent = self.http.post("/storage/s3/mkdir", headers=self.headers, json={"parentId": [], "name": "escape"})
        self.assertEqual(bad_parent.status_code, 404)
        self.client.objects["outside/secret"] = (b"no", '"x"')
        self.client.objects["users/alice/../secret"] = (b"no", '"y"')
        roots = self.http.get("/storage/s3/list", headers=self.headers).json()["items"]
        self.assertFalse(any(row["name"] in ("secret", "..") for row in roots))

    def test_authorization_delete_and_error_mapping(self):
        denied = self.http.get("/storage/s3/list")
        self.assertEqual(denied.status_code, 401)
        created = self.http.post("/storage/s3/write?name=doc", headers=self.headers, content=b"x").json()
        refused = self.http.delete(f"/storage/s3/delete/{created['id']}?expectedRevision={created['revision']}", headers=self.headers)
        self.assertEqual(refused.status_code, 501)
        self.assertEqual(refused.json()["error"]["code"], "conditional_delete_unsupported")
        self.assertEqual(self.backend._error(FakeS3Error("AccessDenied", 403)).status_code, 403)
        self.assertEqual(self.backend._error(FakeS3Error("QuotaExceeded", 507)).status_code, 507)
        self.client.failure = FakeS3Error("AccessDenied", 403)
        access = self.http.get("/storage/s3/list", headers=self.headers)
        self.assertEqual(access.status_code, 403)
        self.assertEqual(access.json()["error"]["code"], "access_denied")
        self.client.failure = FakeS3Error("QuotaExceeded", 507)
        quota = self.http.get("/storage/s3/list", headers=self.headers)
        self.assertEqual(quota.status_code, 507)
        self.assertEqual(quota.json()["error"]["code"], "quota")
        self.client.failure = FakeS3Error("InvalidRequest", 400)
        unsupported = self.http.post("/storage/s3/write?name=unsupported", headers=self.headers, content=b"x")
        self.assertEqual(unsupported.status_code, 501)
        self.assertEqual(unsupported.json()["error"]["code"], "conditional_write_unsupported")

    def test_authorizer_can_accept_the_bearer_argument_directly(self):
        app = FastAPI()

        def authorize(request, authorization):
            if authorization != "Bearer paired":
                raise HTTPException(401, "Pair first")

        companion_s3.attach_s3_routes(
            app, authorize, client=self.client,
            storage=companion_s3.S3CompanionStorage("private-bucket", "users/alice", client=self.client),
        )
        http = TestClient(app)
        self.assertEqual(http.get("/storage/s3/list", headers=self.headers).status_code, 200)
        self.assertEqual(http.get("/storage/s3/list").status_code, 401)

    def test_etag_ids_are_keyed_and_not_decodable_or_reusable(self):
        first = companion_s3.S3CompanionStorage("bucket", "prefix", client=self.client, id_secret=b"a" * 32)
        second = companion_s3.S3CompanionStorage("bucket", "prefix", client=self.client, id_secret=b"b" * 32)
        id_one = first._id("prefix/file")
        id_two = second._id("prefix/file")
        self.assertNotEqual(id_one, id_two)
        with self.assertRaises(Exception):
            second._key(id_one)
        with self.assertRaises(ValueError):
            companion_s3.S3CompanionStorage("bucket", "../escape", client=self.client)

    def test_listing_is_bounded_and_rejects_repeated_continuation_tokens(self):
        class OversizedPage:
            def list_objects_v2(self, **args):
                return {"Contents": [
                    {"Key": f"users/alice/item-{i}", "Size": 1, "ETag": '"r"'}
                    for i in range(companion_s3.MAX_LIST_RESULTS + 1)
                ]}

        bounded = companion_s3.S3CompanionStorage("bucket", "users/alice", client=OversizedPage())
        with self.assertRaises(HTTPException) as too_many:
            bounded.list()
        self.assertEqual(too_many.exception.status_code, 413)

        class RepeatingToken:
            def list_objects_v2(self, **args):
                return {"Contents": [], "IsTruncated": True, "NextContinuationToken": "same"}

        repeated = companion_s3.S3CompanionStorage("bucket", "users/alice", client=RepeatingToken())
        with self.assertRaises(HTTPException) as loop:
            repeated.list()
        self.assertEqual(loop.exception.status_code, 502)
        self.assertEqual(loop.exception.detail["code"], "pagination_invalid")


if __name__ == "__main__":
    unittest.main()
