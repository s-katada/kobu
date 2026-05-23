import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Environment } from '../lib/browser';
import { UnsupportedBrowserSplash } from './UnsupportedBrowserSplash';

function env(overrides: Partial<Environment> = {}): Environment {
  return {
    browser: 'safari',
    os: 'macos',
    insecureContext: false,
    isSecureContext: true,
    webhidSupported: false,
    ...overrides,
  };
}

describe('UnsupportedBrowserSplash', () => {
  it('renders the Safari-specific copy', () => {
    render(<UnsupportedBrowserSplash env={env({ browser: 'safari' })} reason="safari" />);
    expect(screen.getByText(/Safari では kobu-config を実行できません/)).toBeTruthy();
  });

  it('renders the Firefox-specific copy', () => {
    render(
      <UnsupportedBrowserSplash env={env({ browser: 'firefox', os: 'linux' })} reason="firefox" />,
    );
    expect(screen.getByRole('heading', { name: /Firefox/ })).toBeTruthy();
  });

  it('renders the iOS copy and points out the WebKit lock-in', () => {
    render(<UnsupportedBrowserSplash env={env({ browser: 'safari', os: 'ios' })} reason="ios" />);
    expect(
      screen.getByRole('heading', { name: /iOS では kobu-config を実行できません/ }),
    ).toBeTruthy();
    expect(screen.getAllByText(/WebKit/).length).toBeGreaterThan(0);
  });

  it('renders the HTTPS warning for insecure-origin', () => {
    render(
      <UnsupportedBrowserSplash
        env={env({
          browser: 'chrome',
          insecureContext: true,
          isSecureContext: false,
          webhidSupported: true,
        })}
        reason="insecure-origin"
      />,
    );
    expect(screen.getByText(/HTTPS でアクセスしてください/)).toBeTruthy();
  });

  it('shows desktop Chromium download links on macOS', () => {
    render(
      <UnsupportedBrowserSplash env={env({ browser: 'safari', os: 'macos' })} reason="safari" />,
    );
    expect(screen.getByRole('link', { name: /Google Chrome/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Microsoft Edge/ })).toBeTruthy();
  });

  it('shows Chrome for Android (with OTG note) when env.os = android', () => {
    render(
      <UnsupportedBrowserSplash
        env={env({ browser: 'unknown', os: 'android' })}
        reason="no-webhid"
      />,
    );
    expect(screen.getByText(/Chrome for Android/)).toBeTruthy();
    expect(screen.getByText(/OTG/)).toBeTruthy();
  });

  it('omits the recommendation list on iOS', () => {
    render(<UnsupportedBrowserSplash env={env({ browser: 'safari', os: 'ios' })} reason="ios" />);
    expect(screen.queryByRole('link', { name: /Google Chrome/ })).toBeNull();
  });

  it('mentions vial.rocks as a fallback (with same requirements)', () => {
    render(<UnsupportedBrowserSplash env={env({ browser: 'safari' })} reason="safari" />);
    expect(screen.getByRole('link', { name: /vial.rocks/ })).toBeTruthy();
  });

  it('always renders the detected browser + OS labels', () => {
    render(
      <UnsupportedBrowserSplash env={env({ browser: 'firefox', os: 'linux' })} reason="firefox" />,
    );
    expect(screen.getAllByText(/Firefox/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Linux/)).toBeTruthy();
  });
});
