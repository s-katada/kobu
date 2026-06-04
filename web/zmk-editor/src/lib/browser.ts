/**
 * Browser / OS detection for the unsupported-browser UX.
 *
 * The kobu ZMK editor talks to the keyboard over the ZMK Studio RPC
 * protocol, which in a browser means **Web Serial** (USB, the primary
 * path) or **Web Bluetooth** (BLE, Chromium + Linux only). Both are
 * Chromium-only. This module answers "which browser is this, and can it
 * talk to kobu at all" so we can show a helpful splash instead of
 * dead-ending at a connect button that can never work.
 *
 * UA sniffing is only used for *messaging* (which download to recommend);
 * the real gate is `webSerialSupported` / `webBluetoothSupported`.
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
  /** True when the page is a secure context (HTTPS or localhost). */
  isSecureContext: boolean;
  /** True when Web Serial (USB transport) is present. */
  webSerialSupported: boolean;
  /** True when Web Bluetooth (BLE transport) is present. */
  webBluetoothSupported: boolean;
}

const KNOWN_PATTERNS: Array<{ id: DetectedBrowser; re: RegExp }> = [
  // Order matters — Edge / Brave / Opera ALSO match the "Chrome" UA, so
  // check the more-specific brand strings first.
  { id: 'edge', re: /\bEdg(?:e|A|iOS)?\/[\d.]+/i },
  { id: 'opera', re: /\bOPR\/[\d.]+/i },
  { id: 'samsung-internet', re: /SamsungBrowser\/[\d.]+/i },
  { id: 'firefox', re: /\bFirefox\/[\d.]+/i },
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
    webSerialSupported?: boolean;
    webBluetoothSupported?: boolean;
    nav?: Navigator;
  } = {},
): Environment {
  const userAgent =
    options.userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const protocol = options.protocol ?? (typeof location !== 'undefined' ? location.protocol : '');
  const secureCtx =
    options.isSecureContext ??
    (typeof window !== 'undefined' ? Boolean(window.isSecureContext) : false);
  const serial =
    options.webSerialSupported ?? (typeof navigator !== 'undefined' && 'serial' in navigator);
  const bluetooth =
    options.webBluetoothSupported ?? (typeof navigator !== 'undefined' && 'bluetooth' in navigator);
  return {
    browser: detectBrowser(userAgent, options.nav),
    os: detectOS(userAgent),
    insecureContext: protocol === 'http:',
    isSecureContext: secureCtx,
    webSerialSupported: serial,
    webBluetoothSupported: bluetooth,
  };
}

/**
 * Refine a `chrome` detection to `brave` if `navigator.brave.isBrave()`
 * resolves true. Returns the input unchanged otherwise.
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
 * Why the current environment cannot use the editor. Returns null when
 * at least one transport (Web Serial or Web Bluetooth) is usable.
 */
export type UnsupportedReason =
  | 'no-webserial' // neither Web Serial nor Web Bluetooth present
  | 'firefox'
  | 'safari'
  | 'ios'
  | 'insecure-origin';

export function unsupportedReason(env: Environment): UnsupportedReason | null {
  if (env.os === 'ios') return 'ios';
  if (env.browser === 'firefox') return 'firefox';
  if (env.browser === 'safari') return 'safari';
  if (!env.webSerialSupported && !env.webBluetoothSupported) return 'no-webserial';
  if (env.insecureContext && !env.isSecureContext) return 'insecure-origin';
  return null;
}

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
      return [];
    case 'unknown':
      return [
        { name: 'Google Chrome', url: 'https://www.google.com/chrome/' },
        { name: 'Microsoft Edge', url: 'https://www.microsoft.com/edge/download' },
      ];
  }
}
