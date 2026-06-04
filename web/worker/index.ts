// Cloudflare Worker entrypoint for the kobu-editor SPA.
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
  /**
   * Fine-grained PAT with `actions:read+write` + `contents:read` on the
   * firmware repo. Set via `wrangler secret put GITHUB_TOKEN`. When
   * absent, the ZMK editor's build endpoints return 501 and the UI shows
   * "build not configured" — everything else still works.
   */
  GITHUB_TOKEN?: string;
  /** Firmware repo owner / name (defaults below). */
  GH_OWNER?: string;
  GH_REPO?: string;
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
};

// Powerful-API allow-list, per app:
//   * the RMK editor (root `/`) needs WebHID;
//   * the ZMK editor (`/zmk`) needs Web Serial + Web Bluetooth (ZMK
//     Studio transports).
// Everything else is denied. The policy is attached to the served
// document so each app only gets the features it actually uses.
function permissionsPolicy(pathname: string): string {
  const isZmk = pathname === '/zmk' || pathname.startsWith('/zmk/');
  const allow = isZmk
    ? ['hid=()', 'serial=(self)', 'bluetooth=(self)', 'usb=()']
    : ['hid=(self)', 'serial=()', 'bluetooth=()', 'usb=()'];
  return [
    ...allow,
    'camera=()',
    'microphone=()',
    'geolocation=()',
    'gyroscope=()',
    'accelerometer=()',
    'magnetometer=()',
    'payment=()',
  ].join(', ');
}

function withSecurityHeaders(response: Response, pathname: string): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  headers.set('Permissions-Policy', permissionsPolicy(pathname));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ── ZMK editor: GitHub Actions firmware-build proxy ──────────────────────
//
// The ZMK editor's "detailed settings" can't change live (ZMK bakes
// CPI / hold-tap / combo timing into the firmware at build time). Instead
// the browser POSTs the changed knobs here; we dispatch a parameterised
// `firmware.yml` build, the workflow patches the config via
// `scripts/zmk-apply-overrides.py`, and we proxy the resulting artifact
// back for in-browser flashing. The GitHub token never reaches the client.

const GH_API = 'https://api.github.com';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Allowed override keys + integer bounds (mirrors the build script).
const OVERRIDE_BOUNDS: Record<string, readonly [number, number]> = {
  left_cpi: [100, 3000],
  right_cpi: [100, 3000],
  pointer_gain_x100: [50, 300],
  scroll_divisor: [5, 60],
  tapping_term_ms: [50, 500],
  combo_timeout_ms: [10, 150],
  automouse_timeout_ms: [50, 600],
};

function sanitizeOverrides(input: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof input !== 'object' || input === null) return out;
  const obj = input as Record<string, unknown>;
  for (const [key, [lo, hi]] of Object.entries(OVERRIDE_BOUNDS)) {
    const v = obj[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    out[key] = Math.min(hi, Math.max(lo, Math.round(v)));
  }
  return out;
}

interface GhRun {
  id: number;
  name: string | null;
  status: string;
  conclusion: string | null;
}

async function handleFirmwareBuild(request: Request, url: URL, env: Env): Promise<Response> {
  const token = env.GITHUB_TOKEN;
  if (!token) return json({ error: 'build-not-configured' }, 501);
  const owner = env.GH_OWNER ?? 's-katada';
  const repo = env.GH_REPO ?? 'kobu';
  const gh: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'kobu-zmk-editor',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  if (url.pathname === '/zmk/__build' && request.method === 'POST') {
    let body: { overrides?: unknown };
    try {
      body = (await request.json()) as { overrides?: unknown };
    } catch {
      return json({ error: 'invalid-json' }, 400);
    }
    const overrides = sanitizeOverrides(body.overrides);
    if (Object.keys(overrides).length === 0) return json({ error: 'no-overrides' }, 400);
    const buildId = crypto.randomUUID();
    const overridesB64 = btoa(JSON.stringify({ overrides, build_id: buildId }));
    const res = await fetch(
      `${GH_API}/repos/${owner}/${repo}/actions/workflows/firmware.yml/dispatches`,
      {
        method: 'POST',
        headers: { ...gh, 'content-type': 'application/json' },
        body: JSON.stringify({
          ref: 'main',
          inputs: { overrides_b64: overridesB64, build_id: buildId },
        }),
      },
    );
    if (res.status !== 204) {
      return json({ error: 'dispatch-failed', status: res.status }, 502);
    }
    return json({ ok: true, build_id: buildId });
  }

  if (url.pathname === '/zmk/__build/status' && request.method === 'GET') {
    const buildId = url.searchParams.get('build_id');
    if (!buildId) return json({ error: 'missing-build_id' }, 400);
    const res = await fetch(
      `${GH_API}/repos/${owner}/${repo}/actions/runs?event=workflow_dispatch&per_page=30`,
      { headers: gh },
    );
    if (!res.ok) return json({ error: 'list-runs-failed', status: res.status }, 502);
    const data = (await res.json()) as { workflow_runs?: GhRun[] };
    const run = data.workflow_runs?.find((r) => (r.name ?? '').includes(buildId));
    if (!run) return json({ status: 'queued', conclusion: null });
    return json({ status: run.status, conclusion: run.conclusion, run_id: run.id });
  }

  if (url.pathname === '/zmk/__artifact' && request.method === 'GET') {
    const runId = url.searchParams.get('run_id');
    if (!runId) return json({ error: 'missing-run_id' }, 400);
    const listRes = await fetch(
      `${GH_API}/repos/${owner}/${repo}/actions/runs/${encodeURIComponent(runId)}/artifacts`,
      { headers: gh },
    );
    if (!listRes.ok) return json({ error: 'list-artifacts-failed', status: listRes.status }, 502);
    const list = (await listRes.json()) as { artifacts?: Array<{ id: number; name: string }> };
    const artifact = list.artifacts?.[0];
    if (!artifact) return json({ error: 'no-artifact' }, 404);
    const zipRes = await fetch(
      `${GH_API}/repos/${owner}/${repo}/actions/artifacts/${artifact.id}/zip`,
      { headers: gh, redirect: 'follow' },
    );
    if (!zipRes.ok) return json({ error: 'artifact-download-failed', status: zipRes.status }, 502);
    return new Response(zipRes.body, {
      status: 200,
      headers: { 'content-type': 'application/zip' },
    });
  }

  return json({ error: 'not-found' }, 404);
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

    // ZMK editor firmware-build endpoints (detailed settings → GitHub
    // Actions build → flash). The token lives server-side only.
    if (
      url.pathname === '/zmk/__build' ||
      url.pathname === '/zmk/__build/status' ||
      url.pathname === '/zmk/__artifact'
    ) {
      return handleFirmwareBuild(request, url, env);
    }

    // The ZMK editor is a separate SPA built with base `/zmk/` and served
    // from `dist/zmk/`. Normalise the bare path so `/zmk` lands on its
    // index instead of the root SPA fallback.
    if (url.pathname === '/zmk') {
      return Response.redirect(new URL('/zmk/', url).toString(), 301);
    }

    const response = await env.ASSETS.fetch(request);
    return withSecurityHeaders(response, url.pathname);
  },
} satisfies ExportedHandler<Env>;
