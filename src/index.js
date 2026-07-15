/**
 * FotoFlow R2 Shield Worker
 *
 * A read-through cache that serves assets from R2 first,
 * falling back to Google Cloud Storage on a miss and
 * asynchronously backfilling the asset into R2 for future hits.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Extracts the clean object path (e.g., /galleries/event_abc/highres_01.jpg)
    const objectKey = url.pathname.slice(1);

    if (!objectKey) {
      return new Response("Asset identifier path required.", { status: 400 });
    }

    // 1. Check for the asset in the R2 Shield Bucket
    try {
      const r2Object = await env.R2_SHIELD.get(objectKey);
      if (r2Object) {
        const headers = new Headers();
        r2Object.writeHttpMetadata(headers);
        headers.set("X-Cache-Shield", "HIT-R2");
        return new Response(r2Object.body, { headers });
      }
    } catch (err) {
      console.error("R2 Read Interrupted:", err);
    }

    // 2. Cache Miss: Query Firebase Storage via the REST API
    // Slashes in the path must be encoded as %2F for the Firebase /o/ endpoint
    const encodedKey = objectKey.split('/').map(encodeURIComponent).join('%2F');
    const gcsUrl = `https://firebasestorage.googleapis.com/v0/b/fotoflow-studio.firebasestorage.app/o/${encodedKey}?alt=media`;

    const gcsResponse = await fetch(gcsUrl);
    if (!gcsResponse.ok) {
      return new Response("Asset missing from primary source.", { status: gcsResponse.status });
    }

    // Duplicate the incoming stream data stream
    const cacheClone = gcsResponse.clone();

    // 3. Backfill into R2 asynchronously so the client doesn't wait on the write latency
    ctx.waitUntil(
      (async () => {
        try {
          await env.R2_SHIELD.put(objectKey, cacheClone.body, {
            httpMetadata: {
              contentType: cacheClone.headers.get("content-type"),
              cacheControl: cacheClone.headers.get("cache-control") || "public, max-age=31536000",
            }
          });
        } catch (r2Err) {
          console.error("Failed to backfill asset to R2 layer:", r2Err);
        }
      })()
    );

    // 4. Immediately return the main stream data straight to the user
    const responseHeaders = new Headers(gcsResponse.headers);
    responseHeaders.set("X-Cache-Shield", "MISS-GCS-BACKFILLING");

    return new Response(gcsResponse.body, {
      status: gcsResponse.status,
      headers: responseHeaders
    });
  }
};
