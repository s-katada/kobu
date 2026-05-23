/**
 * Browser / OS detection for the unsupported-browser UX.
 *
 * UA sniffing is unreliable in general, but the question we need to
 * answer is narrow: *which* well-known Chromium-derived browser is
 * the user on, so we can recommend a download link if WebHID is
 * absent. Getting it wrong here just means showing a slightly less
 * specific "use Chrome" message — never blocking a real Chromium
 * browser.
 *
 * The single source of truth for "can we actually talk to kobu" is
 * `isWebHidSupported()` in `transport/webhid.ts`. Everything in this
 * file is for *messaging*, not for gating behaviour.
 */

export type DetectedBrowser =
  | 'chrome'
  | 'edge'
  | 'brave'
  | 'opera'
  | 'firefox'
  | 'safari'
  | 'samsung-internet'
  | 'unknown';

export type DetectedOS = 'macos' | 'windows' | 'linux' | 'android' | 'ios' | 'unknown';

export interface Environment {
  browser: DetectedBrowser;
  os: DetectedOS;
  /** True when the location protocol is `http:` (not `file:` or `https:`). */
  insecureContext: boolean;
  /** True when the page is the WebHID-host kind (must be HTTPS or localhost). */
  isSecureContext: boolean;
  /** True when WebHID is actually present in this runtime. */
  webhidSupported: boolean;
}

const KNOWN_PATTERNS: Array<{ id: DetectedBrowser; re: RegExp }> = [
  // Order matters — Edge / Brave / Opera ALSO match the "Chrome" UA, so
  // check the more-specific brand strings first.
  { id: 'edge', re: /\bEdg(?:e|A|iOS)?\/[\d.]+/i },
  { id: 'opera', re: /\bOPR\/[\d.]+/i },
  { id: 'samsung-internet', re: /SamsungBrowser\/[\d.]+/i },
  { id: 'firefox', re: /\bFirefox\/[\d.]+/i },
  // Chrome covers the generic Chrome + Brave UA (Brave intentionally
  // mimics Chrome verbatim to dodge fingerprinting). For Brave we have
  // to fall back to `navigator.brave?.isBrave()` which only exists in
  // Brave itself.
  { id: 'chrome', re: /\bChrome\/[\d.]+/i },
  { id: 'safari', re: /\bSafari\/[\d.]+/i }, // last — Chrome UA also contains "Safari/..."
];

const OS_PATTERNS: Array<{ id: DetectedOS; re: RegExp }> = [
  { id: 'ios', re: /\b(?:iPhone|iPad|iPod)\b/i },
  { id: 'android', re: /\bAndroid\b/i },
  { id: 'macos', re: /\bMac OS X\b|\bMacintosh\b/i },
  { id: 'windows', re: /\bWindows NT\b/i },
  { id: 'linux', re: /\bLinux\b/i },
];

interface BraveNavigator {
  brave?: { isBrave?: () => Promise<boolean> };
}

function detectBrowser(userAgent: string, nav?: Navigator): DetectedBrowser {
  // Brave detection — `navigator.brave.isBrave()` is the documented
  // path, but it's async. We can call it elsewhere; here we make a
  // best-effort sync guess based on the absence of every other brand
  // string while Chrome matches, then upgrade to 'brave' if the brand
  // string is present (rare — Brave 1.49+ no longer ships one).
  const braveBrand =
    (nav as (Navigator & BraveNavigator) | undefined)?.brave?.isBrave !== undefined;
  for (const pattern of KNOWN_PATTERNS) {
    if (pattern.re.test(userAgent)) {
      if (pattern.id === 'chrome' && braveBrand) return 'brave';
      return pattern.id;
    }
  }
  return 'unknown';
}

function detectOS(userAgent: string): DetectedOS {
  for (const pattern of OS_PATTERNS) {
    if (pattern.re.test(userAgent)) return pattern.id;
  }
  return 'unknown';
}

/**
 * Probe the current environment. Safe to call during SSR (everything
 * defaults to "unknown / unsupported").
 */
export function detectEnvironment(
  options: {
    userAgent?: string;
    protocol?: string;
    isSecureContext?: boolean;
    webhidSupported?: boolean;
    nav?: Navigator;
  } = {},
): Environment {
  const userAgent =
    options.userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const protocol = options.protocol ?? (typeof location !== 'undefined' ? location.protocol : '');
  const secureCtx =
    options.isSecureContext ??
    (typeof window !== 'undefined' ? Boolean(window.isSecureContext) : false);
  const hid = options.webhidSupported ?? (typeof navigator !== 'undefined' && 'hid' in navigator);
  return {
    browser: detectBrowser(userAgent, options.nav),
    os: detectOS(userAgent),
    insecureContext: protocol === 'http:',
    isSecureContext: secureCtx,
    webhidSupported: hid,
  };
}

/**
 * Refine a `chrome` detection to `brave` if `navigator.brave.isBrave()`
 * resolves to `true`. Returns the input unchanged otherwise. Async
 * because the official API is async.
 */
export async function refineBrave(env: Environment, nav?: Navigator): Promise<Environment> {
  if (env.browser !== 'chrome') return env;
  const probe = (nav ?? (typeof navigator !== 'undefined' ? navigator : undefined)) as
    | (Navigator & BraveNavigator)
    | undefined;
  const isBrave = probe?.brave?.isBrave;
  if (!isBrave) return env;
  try {
    const yes = await isBrave.call(probe?.brave);
    if (yes) return { ...env, browser: 'brave' };
  } catch {
    // ignore — sticking with 'chrome' is the safe default
  }
  return env;
}

/**
 * Human-readable name used in the splash + header copy.
 */
export function browserLabel(browser: DetectedBrowser): string {
  switch (browser) {
    case 'chrome':
      return 'Chrome';
    case 'edge':
      return 'Microsoft Edge';
    case 'brave':
      return 'Brave';
    case 'opera':
      return 'Opera';
    case 'firefox':
      return 'Firefox';
    case 'safari':
      return 'Safari';
    case 'samsung-internet':
      return 'Samsung Internet';
    case 'unknown':
      return 'お使いのブラウザ';
  }
}

export function osLabel(os: DetectedOS): string {
  switch (os) {
    case 'macos':
      return 'macOS';
    case 'windows':
      return 'Windows';
    case 'linux':
      return 'Linux';
    case 'android':
      return 'Android';
    case 'ios':
      return 'iOS';
    case 'unknown':
      return '未検出';
  }
}

/**
 * Why the current environment cannot use WebHID. Returns null when
 * everything is fine.
 */
export type UnsupportedReason =
  | 'no-webhid' // browser doesn't implement it
  | 'firefox' // Firefox specifically (no WebHID intent on the roadmap)
  | 'safari' // Safari / WebKit specifically
  | 'ios' // iOS WebKit — no WebHID even with Chrome wrapper
  | 'insecure-origin'; // WebHID exists but blocked by non-secure context

export function unsupportedReason(env: Environment): UnsupportedReason | null {
  // iOS first — every browser there shares WebKit and none of them
  // exposes WebHID. Show a specific message.
  if (env.os === 'ios') return 'ios';
  if (env.browser === 'firefox') return 'firefox';
  if (env.browser === 'safari') return 'safari';
  if (!env.webhidSupported) return 'no-webhid';
  if (env.insecureContext && !env.isSecureContext) return 'insecure-origin';
  return null;
}

/**
 * Pre-curated download recommendation per OS. We don't try to detect
 * processor architecture etc. — the manufacturer's download page
 * handles that.
 */
export function recommendedBrowsers(
  os: DetectedOS,
): Array<{ name: string; url: string; note?: string }> {
  switch (os) {
    case 'macos':
    case 'windows':
    case 'linux':
      return [
        { name: 'Google Chrome', url: 'https://www.google.com/chrome/' },
        { name: 'Microsoft Edge', url: 'https://www.microsoft.com/edge/download' },
        { name: 'Brave', url: 'https://brave.com/download/' },
      ];
    case 'android':
      return [
        {
          name: 'Chrome for Android',
          url: 'https://play.google.com/store/apps/details?id=com.android.chrome',
          note: 'USB-OTG ケーブル経由で接続できます',
        },
      ];
    case 'ios':
      // No Chromium engine on iOS; every iOS browser is WebKit under
      // the hood. We surface this honestly rather than recommending
      // an iOS "Chrome" that won't work either.
      return [];
    case 'unknown':
      return [
        { name: 'Google Chrome', url: 'https://www.google.com/chrome/' },
        { name: 'Microsoft Edge', url: 'https://www.microsoft.com/edge/download' },
      ];
  }
}
