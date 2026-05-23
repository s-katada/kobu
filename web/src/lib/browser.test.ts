import { describe, expect, it } from 'vitest';
import {
  browserLabel,
  detectEnvironment,
  osLabel,
  recommendedBrowsers,
  refineBrave,
  unsupportedReason,
} from './browser';

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const EDGE_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0';
const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const IOS_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const OPERA_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0';

describe('detectEnvironment - browser', () => {
  it('detects Chrome on macOS', () => {
    const env = detectEnvironment({
      userAgent: CHROME_MAC,
      protocol: 'https:',
      isSecureContext: true,
      webhidSupported: true,
    });
    expect(env.browser).toBe('chrome');
    expect(env.os).toBe('macos');
  });

  it('detects Edge before falling through to Chrome', () => {
    const env = detectEnvironment({
      userAgent: EDGE_WIN,
      protocol: 'https:',
      isSecureContext: true,
      webhidSupported: true,
    });
    expect(env.browser).toBe('edge');
    expect(env.os).toBe('windows');
  });

  it('detects Firefox on Linux', () => {
    const env = detectEnvironment({
      userAgent: FIREFOX_LINUX,
      protocol: 'https:',
      isSecureContext: true,
      webhidSupported: false,
    });
    expect(env.browser).toBe('firefox');
    expect(env.os).toBe('linux');
  });

  it('detects Safari on macOS without confusing it with Chrome', () => {
    const env = detectEnvironment({
      userAgent: SAFARI_MAC,
      protocol: 'https:',
      isSecureContext: true,
      webhidSupported: false,
    });
    expect(env.browser).toBe('safari');
    expect(env.os).toBe('macos');
  });

  it('detects iOS Safari', () => {
    const env = detectEnvironment({
      userAgent: IOS_SAFARI,
      protocol: 'https:',
      isSecureContext: true,
      webhidSupported: false,
    });
    expect(env.os).toBe('ios');
    expect(env.browser).toBe('safari');
  });

  it('detects Android Chrome', () => {
    const env = detectEnvironment({
      userAgent: ANDROID_CHROME,
      protocol: 'https:',
      isSecureContext: true,
      webhidSupported: true,
    });
    expect(env.browser).toBe('chrome');
    expect(env.os).toBe('android');
  });

  it('detects Opera', () => {
    const env = detectEnvironment({
      userAgent: OPERA_MAC,
      protocol: 'https:',
      isSecureContext: true,
      webhidSupported: true,
    });
    expect(env.browser).toBe('opera');
  });
});

describe('detectEnvironment - context', () => {
  it('flags http: as insecure', () => {
    const env = detectEnvironment({
      userAgent: CHROME_MAC,
      protocol: 'http:',
      isSecureContext: false,
      webhidSupported: true,
    });
    expect(env.insecureContext).toBe(true);
    expect(env.isSecureContext).toBe(false);
  });

  it('considers https: secure', () => {
    const env = detectEnvironment({
      userAgent: CHROME_MAC,
      protocol: 'https:',
      isSecureContext: true,
      webhidSupported: true,
    });
    expect(env.insecureContext).toBe(false);
    expect(env.isSecureContext).toBe(true);
  });
});

describe('unsupportedReason', () => {
  it('returns null for Chrome desktop on HTTPS with WebHID', () => {
    const env = detectEnvironment({
      userAgent: CHROME_MAC,
      protocol: 'https:',
      isSecureContext: true,
      webhidSupported: true,
    });
    expect(unsupportedReason(env)).toBeNull();
  });

  it('returns "firefox" for Firefox even though WebHID is also missing', () => {
    const env = detectEnvironment({
      userAgent: FIREFOX_LINUX,
      protocol: 'https:',
      isSecureContext: true,
      webhidSupported: false,
    });
    expect(unsupportedReason(env)).toBe('firefox');
  });

  it('returns "safari" for desktop Safari', () => {
    const env = detectEnvironment({
      userAgent: SAFARI_MAC,
      protocol: 'https:',
      isSecureContext: true,
      webhidSupported: false,
    });
    expect(unsupportedReason(env)).toBe('safari');
  });

  it('returns "ios" for iOS regardless of which engine claims to host', () => {
    const env = detectEnvironment({
      userAgent: IOS_SAFARI,
      protocol: 'https:',
      isSecureContext: true,
      webhidSupported: false,
    });
    expect(unsupportedReason(env)).toBe('ios');
  });

  it('returns "insecure-origin" when WebHID exists but the page is HTTP', () => {
    const env = detectEnvironment({
      userAgent: CHROME_MAC,
      protocol: 'http:',
      isSecureContext: false,
      webhidSupported: true,
    });
    expect(unsupportedReason(env)).toBe('insecure-origin');
  });

  it('returns "no-webhid" for an unknown UA without WebHID', () => {
    const env = detectEnvironment({
      userAgent: '',
      protocol: 'https:',
      isSecureContext: true,
      webhidSupported: false,
    });
    expect(unsupportedReason(env)).toBe('no-webhid');
  });
});

describe('recommendedBrowsers', () => {
  it('returns desktop Chromium options on macOS / Windows / Linux', () => {
    expect(recommendedBrowsers('macos').length).toBeGreaterThan(0);
    expect(recommendedBrowsers('windows').length).toBeGreaterThan(0);
    expect(recommendedBrowsers('linux').length).toBeGreaterThan(0);
  });

  it('points Android users at Chrome with a USB-OTG note', () => {
    const list = recommendedBrowsers('android');
    expect(list).toHaveLength(1);
    expect(list[0]?.note).toMatch(/OTG/);
  });

  it('returns an empty list on iOS (no Chromium engine available)', () => {
    expect(recommendedBrowsers('ios')).toEqual([]);
  });
});

describe('browserLabel / osLabel', () => {
  it('returns localized labels', () => {
    expect(browserLabel('chrome')).toBe('Chrome');
    expect(browserLabel('unknown')).toMatch(/ブラウザ/);
    expect(osLabel('macos')).toBe('macOS');
    expect(osLabel('unknown')).toMatch(/未検出/);
  });
});

describe('refineBrave', () => {
  it('leaves non-chrome detections alone', async () => {
    const env = {
      browser: 'firefox' as const,
      os: 'linux' as const,
      insecureContext: false,
      isSecureContext: true,
      webhidSupported: false,
    };
    const after = await refineBrave(env);
    expect(after.browser).toBe('firefox');
  });

  it('upgrades chrome → brave when navigator.brave.isBrave() resolves true', async () => {
    const env = {
      browser: 'chrome' as const,
      os: 'macos' as const,
      insecureContext: false,
      isSecureContext: true,
      webhidSupported: true,
    };
    const fakeNav = { brave: { isBrave: async () => true } } as unknown as Navigator;
    const after = await refineBrave(env, fakeNav);
    expect(after.browser).toBe('brave');
  });

  it('keeps chrome when isBrave resolves false', async () => {
    const env = {
      browser: 'chrome' as const,
      os: 'macos' as const,
      insecureContext: false,
      isSecureContext: true,
      webhidSupported: true,
    };
    const fakeNav = { brave: { isBrave: async () => false } } as unknown as Navigator;
    const after = await refineBrave(env, fakeNav);
    expect(after.browser).toBe('chrome');
  });
});
