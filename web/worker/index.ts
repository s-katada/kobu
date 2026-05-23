// Cloudflare Worker entrypoint for the kobu-config SPA.
//
// Jobs:
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
//
//   3. Attach a strict-but-workable CSP and a handful of static
//      security headers to every SPA response. The release proxy
//      keeps GitHub's own headers; overlaying our CSP on a UF2
//      binary would be misleading (the browser doesn't parse the
//      body as HTML).

export interface Env {
  ASSETS: Fetcher;
}

const RELEASE_PREFIX = '/__release';

/**
 * Content-Security-Policy for the SPA.
 *
 * - `default-src 'self'` blocks everything that isn't allowed below.
 * - `script-src 'self'` — no inline scripts and no third-party
 *   bundles. Vite emits hashed JS files we serve from our own origin.
 * - `style-src 'self' 'unsafe-inline'` — `InstallButton.tsx` writes
 *   the firmware-install progress bar width with an inline
 *   `style={{ width: '${percent}%' }}`. That's the only inline
 *   style in the bundle today. We accept the broader exposure: no
 *   user-controlled string flows into `style=`.
 * - `connect-src 'self' https://api.github.com` —
 *   `/__release` (Worker proxy) is same-origin, but the firmware
 *   install code also fetches `https://api.github.com/repos/...`
 *   directly to list releases. GitHub's API does send proper CORS
 *   headers (unlike Release downloads, which is why those are
 *   proxied), so we allow that origin directly rather than adding
 *   another proxy hop.
 * - `worker-src 'self'` — the PWA service worker.
 * - `frame-ancestors 'none'` — block clickjacking entirely.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' https://api.github.com",
  "worker-src 'self'",
  "manifest-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // kobu-config explicitly needs WebHID. Allow it for our own origin
  // only — `()` denies every other unused powerful API.
  'Permissions-Policy': [
    'hid=(self)',
    'usb=()',
    'bluetooth=()',
    'camera=()',
    'microphone=()',
    'geolocation=()',
    'gyroscope=()',
    'accelerometer=()',
    'magnetometer=()',
    'payment=()',
    'serial=()',
  ].join(', '),
};

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

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
      const upstream = await fetch(target.toString(), {
        method: request.method,
        headers,
        body: hasBody ? request.body : undefined,
        redirect: 'follow',
      });
      // GitHub serves a CSP on its own HTML responses. For a UF2
      // binary the body is opaque so the header is harmless, but we
      // strip it defensively in case GitHub ever proxies an HTML
      // error page through this path — letting their CSP through
      // would override ours for that response.
      const proxiedHeaders = new Headers(upstream.headers);
      proxiedHeaders.delete('content-security-policy');
      proxiedHeaders.delete('content-security-policy-report-only');
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: proxiedHeaders,
      });
    }

    const response = await env.ASSETS.fetch(request);
    return withSecurityHeaders(response);
  },
} satisfies ExportedHandler<Env>;
