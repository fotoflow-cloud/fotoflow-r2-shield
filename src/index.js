/**
 * FotoFlow R2 Shield Worker
 *
 * A Cloudflare Worker that sits in front of R2 storage,
 * handling authentication, access control, and image serving.
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', timestamp: Date.now() }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('FotoFlow R2 Shield is running.', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  },
};
