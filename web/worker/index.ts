// Cloudflare Worker entrypoint for the kobu-config SPA.
//
// Two jobs:
//
//   1. Serve the Vite-built static assets in `dist/` (the SPA itself).
//      The `ASSETS` binding handles caching, ETags, and the not-found
//      fallback to `index.html` so client-side routing works.
//
//   2. Proxy `/__release/*` to `https://github.com/*`. GitHub Release
//      downloads do not return `Access-Control-Allow-Origin`, so the
//      browser cannot fetch `.uf2` assets directly. Routing them
//      through the Worker makes the request same-origin from the
//      browser's point of view — server-to-GitHub fetches are not
//      subject to CORS. Mirrors the dev-server proxy in
//      `vite.config.ts`.

export interface Env {
  ASSETS: Fetcher;
}

const RELEASE_PREFIX = '/__release';

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === RELEASE_PREFIX || url.pathname.startsWith(`${RELEASE_PREFIX}/`)) {
      const target = new URL(
        url.pathname.slice(RELEASE_PREFIX.length) || '/',
        'https://github.com',
      );
      target.search = url.search;

      // Strip headers that would either confuse GitHub or leak Worker
      // internals. A same-origin browser request wouldn't carry these.
      const headers = new Headers(request.headers);
      for (const name of ['host', 'origin', 'referer', 'cf-connecting-ip', 'cf-ray']) {
        headers.delete(name);
      }

      const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
      return fetch(target.toString(), {
        method: request.method,
        headers,
        body: hasBody ? request.body : undefined,
        redirect: 'follow',
      });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
