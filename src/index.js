/**
 * FotoFlow R2 Shield Worker
 *
 * Edge read-through cache for cdn.fotoflow.co:
 * 1. Checks Cloudflare Edge Cache (caches.default).
 * 2. On edge miss, checks R2 Shield Bucket (env.R2_SHIELD).
 *    On R2 hit: serves asset and asynchronously caches at edge.
 * 3. On R2 miss, falls back to Google Cloud Storage (Firebase Storage).
 *    On GCS hit: serves asset immediately and asynchronously backfills
 *    both R2 and the Cloudflare edge cache.
 */

const CACHE_CONTROL_IMMUTABLE = "public, max-age=31536000, immutable";

export default {
  async fetch(request, env, ctx) {
    // 1. Method validation: only GET and HEAD are supported for asset delivery
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" }
      });
    }

    const url = new URL(request.url);

    // Extracts the clean object path (e.g., /galleries/event_abc/highres_01.jpg)
    const objectKey = url.pathname.slice(1);

    if (!objectKey) {
      return new Response("Asset identifier path required.", { status: 400 });
    }

    // Standard cache key using the full request URL
    const cacheKey = new Request(request.url, { method: "GET" });
    const edgeCache = caches.default;

    // 2. Check Cloudflare Edge Cache
    try {
      const cachedResponse = await edgeCache.match(cacheKey);
      if (cachedResponse) {
        const headers = new Headers(cachedResponse.headers);
        headers.set("X-FotoFlow-Edge-Cache", "HIT");
        return new Response(
          request.method === "HEAD" ? null : cachedResponse.body,
          {
            status: cachedResponse.status,
            statusText: cachedResponse.statusText,
            headers
          }
        );
      }
    } catch (cacheErr) {
      console.error("Edge Cache Read Error:", cacheErr);
    }

    // 3. Edge MISS: Check for the asset in the R2 Shield Bucket
    try {
      const r2Object = await env.R2_SHIELD.get(objectKey);
      if (r2Object) {
        const baseHeaders = new Headers();
        r2Object.writeHttpMetadata(baseHeaders);
        if (r2Object.httpEtag) {
          baseHeaders.set("etag", r2Object.httpEtag);
        }
        if (typeof r2Object.size === "number") {
          baseHeaders.set("Content-Length", String(r2Object.size));
        }
        baseHeaders.set("Cache-Control", CACHE_CONTROL_IMMUTABLE);
        baseHeaders.set("X-Cache-Shield", "HIT-R2");

        // Prepare client response
        const clientHeaders = new Headers(baseHeaders);
        clientHeaders.set("X-FotoFlow-Edge-Cache", "MISS");

        if (request.method === "HEAD") {
          const edgeHeaders = new Headers(baseHeaders);
          const cacheResponse = new Response(r2Object.body, {
            status: 200,
            headers: edgeHeaders
          });
          ctx.waitUntil(edgeCache.put(cacheKey, cacheResponse));

          return new Response(null, {
            status: 200,
            headers: clientHeaders
          });
        }

        // For GET, tee the stream so one goes to client, one goes to edge cache
        const [clientStream, cacheStream] = r2Object.body.tee();

        const edgeHeaders = new Headers(baseHeaders);
        const cacheResponse = new Response(cacheStream, {
          status: 200,
          headers: edgeHeaders
        });
        ctx.waitUntil(edgeCache.put(cacheKey, cacheResponse));

        return new Response(clientStream, {
          status: 200,
          headers: clientHeaders
        });
      }
    } catch (err) {
      console.error("R2 Read Interrupted:", err);
    }

    // 4. Cache Miss on both Edge & R2: Query Firebase Storage via the REST API
    // Slashes in the path must be encoded as %2F for the Firebase /o/ endpoint
    const encodedKey = objectKey.split("/").map(encodeURIComponent).join("%2F");
    const gcsUrl = `https://firebasestorage.googleapis.com/v0/b/fotoflow-studio.firebasestorage.app/o/${encodedKey}?alt=media`;

    let gcsResponse;
    try {
      gcsResponse = await fetch(gcsUrl, { method: "GET" });
    } catch (fetchErr) {
      console.error("GCS Fetch Error:", fetchErr);
      return new Response("Upstream storage error.", { status: 502 });
    }

    if (!gcsResponse.ok) {
      return new Response("Asset missing from primary source.", {
        status: gcsResponse.status
      });
    }

    // 5. GCS HIT: Clone responses for asynchronous R2 backfill and Edge Cache population
    const r2Clone = gcsResponse.clone();
    const edgeCacheClone = gcsResponse.clone();

    // Client response headers
    const clientHeaders = new Headers(gcsResponse.headers);
    clientHeaders.set("Cache-Control", CACHE_CONTROL_IMMUTABLE);
    clientHeaders.set("X-Cache-Shield", "MISS-GCS-BACKFILLING");
    clientHeaders.set("X-FotoFlow-Edge-Cache", "MISS");

    // Edge cache response headers
    const edgeHeaders = new Headers(edgeCacheClone.headers);
    edgeHeaders.set("Cache-Control", CACHE_CONTROL_IMMUTABLE);
    edgeHeaders.set("X-Cache-Shield", "HIT-R2");

    const cacheEntry = new Response(edgeCacheClone.body, {
      status: edgeCacheClone.status,
      statusText: edgeCacheClone.statusText,
      headers: edgeHeaders
    });

    // Asynchronously perform R2 backfill and Edge Cache population without blocking client
    ctx.waitUntil(
      (async () => {
        const r2Backfill = (async () => {
          try {
            await env.R2_SHIELD.put(objectKey, r2Clone.body, {
              httpMetadata: {
                contentType:
                  r2Clone.headers.get("content-type") ||
                  "application/octet-stream",
                cacheControl: CACHE_CONTROL_IMMUTABLE
              }
            });
          } catch (r2Err) {
            console.error("Failed to backfill asset to R2 layer:", r2Err);
          }
        })();

        const edgeCachePopulate = (async () => {
          try {
            await edgeCache.put(cacheKey, cacheEntry);
          } catch (cacheErr) {
            console.error("Failed to populate edge cache:", cacheErr);
          }
        })();

        await Promise.allSettled([r2Backfill, edgeCachePopulate]);
      })()
    );

    // 6. Return response straight to the client
    return new Response(
      request.method === "HEAD" ? null : gcsResponse.body,
      {
        status: gcsResponse.status,
        statusText: gcsResponse.statusText,
        headers: clientHeaders
      }
    );
  }
};
