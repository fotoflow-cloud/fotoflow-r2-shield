
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

// Setup minimal mock environment for Cloudflare Workers
class MockCache {
  constructor() {
    this.store = new Map();
  }
  async match(request) {
    const key = typeof request === "string" ? request : request.url;
    const entry = this.store.get(key);
    if (!entry) return undefined;
    return new Response(entry.body, {
      status: entry.status,
      headers: entry.headers
    });
  }
  async put(request, response) {
    const key = typeof request === "string" ? request : request.url;
    const text = await response.text();
    this.store.set(key, {
      body: text,
      status: response.status,
      headers: new Headers(response.headers)
    });
  }
}

globalThis.caches = {
  default: new MockCache()
};

test.beforeEach(() => {
  caches.default.store.clear();
});

test("1. Reject unsupported HTTP methods (e.g. POST, PUT, DELETE)", async () => {
  const req = new Request("https://cdn.fotoflow.co/sample.jpg", { method: "POST" });
  const env = {};
  const ctx = { waitUntil: () => {} };

  const res = await worker.fetch(req, env, ctx);
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("Allow"), "GET, HEAD");
});

test("2. Reject empty path", async () => {
  const req = new Request("https://cdn.fotoflow.co/", { method: "GET" });
  const env = {};
  const ctx = { waitUntil: () => {} };

  const res = await worker.fetch(req, env, ctx);
  assert.equal(res.status, 400);
});

test("3. Edge Cache HIT returns cached asset with X-FotoFlow-Edge-Cache: HIT", async () => {
  const url = "https://cdn.fotoflow.co/web/test/photo.jpg";
  const edgeCache = caches.default;
  await edgeCache.put(
    new Request(url, { method: "GET" }),
    new Response("edge cached image data", {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Cache-Shield": "HIT-R2"
      }
    })
  );

  const req = new Request(url, { method: "GET" });
  const env = { R2_SHIELD: {} };
  const ctx = { waitUntil: () => {} };

  const res = await worker.fetch(req, env, ctx);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "edge cached image data");
  assert.equal(res.headers.get("X-FotoFlow-Edge-Cache"), "HIT");
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
});

test("4. Edge Cache MISS + R2 HIT returns asset and backfills Edge Cache", async () => {
  const url = "https://cdn.fotoflow.co/web/test/r2hit.jpg";
  const objectKey = "web/test/r2hit.jpg";

  let r2GetCalled = false;
  let waitUntilPromise = null;

  const mockR2 = {
    async get(key) {
      assert.equal(key, objectKey);
      r2GetCalled = true;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("r2 image data"));
          controller.close();
        }
      });
      return {
        body: stream,
        size: 13,
        httpEtag: '"etag123"',
        writeHttpMetadata(headers) {
          headers.set("content-type", "image/jpeg");
        }
      };
    }
  };

  const req = new Request(url, { method: "GET" });
  const env = { R2_SHIELD: mockR2 };
  const ctx = {
    waitUntil(p) {
      waitUntilPromise = p;
    }
  };

  const res = await worker.fetch(req, env, ctx);
  assert.equal(res.status, 200);
  assert.equal(r2GetCalled, true);
  assert.equal(res.headers.get("X-FotoFlow-Edge-Cache"), "MISS");
  assert.equal(res.headers.get("X-Cache-Shield"), "HIT-R2");
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  assert.equal(res.headers.get("Content-Length"), "13");
  assert.equal(res.headers.get("etag"), '"etag123"');
  assert.equal(await res.text(), "r2 image data");

  await waitUntilPromise;

  // Next request should be an Edge HIT
  const nextReq = new Request(url, { method: "GET" });
  const nextRes = await worker.fetch(nextReq, env, ctx);
  assert.equal(nextRes.status, 200);
  assert.equal(nextRes.headers.get("X-FotoFlow-Edge-Cache"), "HIT");
  assert.equal(await nextRes.text(), "r2 image data");
});

test("5. Edge Cache MISS + R2 MISS + GCS HIT returns asset and backfills R2 & Edge Cache", async () => {
  const url = "https://cdn.fotoflow.co/web/monalisa/event/IM_01.jpg";
  const objectKey = "web/monalisa/event/IM_01.jpg";
  const encodedKey = objectKey.split("/").map(encodeURIComponent).join("%2F");
  const expectedGcsUrl = "https://firebasestorage.googleapis.com/v0/b/fotoflow-studio.firebasestorage.app/o/" + encodedKey + "?alt=media";

  let gcsFetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (fetchUrl) => {
    if (fetchUrl === expectedGcsUrl) {
      gcsFetchCalled = true;
      return new Response("gcs image data payload", {
        status: 200,
        headers: {
          "content-type": "image/jpeg"
        }
      });
    }
    return originalFetch(fetchUrl);
  };

  let r2PutData = null;
  const mockR2 = {
    async get() {
      return null;
    },
    async put(key, body, options) {
      assert.equal(key, objectKey);
      const reader = body.getReader();
      const { value } = await reader.read();
      r2PutData = new TextDecoder().decode(value);
      assert.equal(options.httpMetadata.contentType, "image/jpeg");
      assert.equal(options.httpMetadata.cacheControl, "public, max-age=31536000, immutable");
    }
  };

  let waitUntilPromise = null;
  const req = new Request(url, { method: "GET" });
  const env = { R2_SHIELD: mockR2 };
  const ctx = {
    waitUntil(p) {
      waitUntilPromise = p;
    }
  };

  const res = await worker.fetch(req, env, ctx);
  assert.equal(res.status, 200);
  assert.equal(gcsFetchCalled, true);
  assert.equal(res.headers.get("X-FotoFlow-Edge-Cache"), "MISS");
  assert.equal(res.headers.get("X-Cache-Shield"), "MISS-GCS-BACKFILLING");
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  assert.equal(await res.text(), "gcs image data payload");

  await waitUntilPromise;
  assert.equal(r2PutData, "gcs image data payload");

  // Verify edge cache got populated
  const nextReq = new Request(url, { method: "GET" });
  const nextRes = await worker.fetch(nextReq, env, ctx);
  assert.equal(nextRes.status, 200);
  assert.equal(nextRes.headers.get("X-FotoFlow-Edge-Cache"), "HIT");
  assert.equal(await nextRes.text(), "gcs image data payload");

  globalThis.fetch = originalFetch;
});

test("6. GCS 404 (nonexistent object) returns 404 and is not cached", async () => {
  const url = "https://cdn.fotoflow.co/nonexistent.jpg";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response("Not Found", { status: 404 });
  };

  const mockR2 = {
    async get() {
      return null;
    }
  };

  const req = new Request(url, { method: "GET" });
  const env = { R2_SHIELD: mockR2 };
  const ctx = { waitUntil: () => {} };

  const res = await worker.fetch(req, env, ctx);
  assert.equal(res.status, 404);

  const cached = await caches.default.match(req);
  assert.equal(cached, undefined);

  globalThis.fetch = originalFetch;
});

test("7. R2 failure falls back safely to GCS", async () => {
  const url = "https://cdn.fotoflow.co/fallback-test.jpg";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response("fallback gcs data", {
      status: 200,
      headers: { "content-type": "image/jpeg" }
    });
  };

  const mockR2 = {
    async get() {
      throw new Error("R2 cluster network failure");
    },
    async put() {}
  };

  const req = new Request(url, { method: "GET" });
  const env = { R2_SHIELD: mockR2 };
  const ctx = { waitUntil: () => {} };

  const res = await worker.fetch(req, env, ctx);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("X-Cache-Shield"), "MISS-GCS-BACKFILLING");
  assert.equal(await res.text(), "fallback gcs data");

  globalThis.fetch = originalFetch;
});

test("8. Multiple image variants (thumb, preview, web, original) map cleanly without collision", async () => {
  const paths = [
    "thumb/monalisa/event/IM_01.jpg",
    "preview/monalisa/event/IM_01.jpg",
    "web/monalisa/event/IM_01.jpg",
    "original/monalisa/event/IM_01.jpg"
  ];

  for (const p of paths) {
    const url = "https://cdn.fotoflow.co/" + p;
    const encodedKey = p.split("/").map(encodeURIComponent).join("%2F");
    const expectedGcsUrl = "https://firebasestorage.googleapis.com/v0/b/fotoflow-studio.firebasestorage.app/o/" + encodedKey + "?alt=media";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (fUrl) => {
      assert.equal(fUrl, expectedGcsUrl);
      return new Response("content of " + p, { status: 200 });
    };

    let putKey = null;
    const mockR2 = {
      async get() { return null; },
      async put(key) { putKey = key; }
    };
    let waitUntilPromise = null;
    const ctx = { waitUntil(prom) { waitUntilPromise = prom; } };
    const res = await worker.fetch(new Request(url), { R2_SHIELD: mockR2 }, ctx);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "content of " + p);
    await waitUntilPromise;
    assert.equal(putKey, p);

    globalThis.fetch = originalFetch;
  }
});
