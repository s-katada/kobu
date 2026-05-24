/**
 * Full-page splash shown when the current browser cannot run kobu-editor.
 *
 * Replaces the normal app layout instead of letting the user reach an
 * Editor that will never work — there is literally no recovery path
 * inside Safari / Firefox / iOS for WebHID.
 *
 * Per-reason copy:
 *   * ios            no Chromium engine on iOS; honest about it
 *   * safari         WebKit on desktop — same story
 *   * firefox        no WebHID intent on the Mozilla roadmap
 *   * insecure-origin WebHID exists but the page is HTTP — needs HTTPS
 *                    or localhost
 *   * no-webhid      generic fallback for unknown UAs / older browsers
 */

import {
  browserLabel,
  type Environment,
  osLabel,
  recommendedBrowsers,
  type UnsupportedReason,
} from '../lib/browser';

export interface UnsupportedBrowserSplashProps {
  env: Environment;
  reason: UnsupportedReason;
}

export function UnsupportedBrowserSplash({ env, reason }: UnsupportedBrowserSplashProps) {
  const copy = COPY[reason];
  const browsers = recommendedBrowsers(env.os);

  return (
    <div className="min-h-full flex items-center justify-center px-6 py-12">
      <article
        aria-labelledby="unsupported-heading"
        className="max-w-xl rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-sm p-6 md:p-8 space-y-5"
      >
        <header className="space-y-2">
          <p className="text-xs uppercase tracking-wider text-rose-700 dark:text-rose-300">
            未対応のブラウザ
          </p>
          <h1 id="unsupported-heading" className="text-xl font-semibold">
            {copy.title}
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            検出: <strong className="font-medium">{browserLabel(env.browser)}</strong> on{' '}
            <strong className="font-medium">{osLabel(env.os)}</strong>
          </p>
        </header>

        <section className="space-y-3 text-sm">
          <p>{copy.body}</p>
          <details className="rounded-md bg-zinc-50 dark:bg-zinc-900 px-3 py-2">
            <summary className="cursor-pointer text-xs text-zinc-600 dark:text-zinc-400">
              なぜ WebHID が必要なのか
            </summary>
            <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed">
              kobu-editor はキーボードに直接 USB / BLE 経由でキーマップを書き込みます。これには
              ブラウザの <code className="font-mono">navigator.hid</code> API
              （WebHID）が必要で、現時点では Chromium 系（Chrome / Edge / Brave / Opera）の
              デスクトップ版と Android Chrome のみが対応しています。クラウドのサーバには
              キーマップを一切送信しません。
            </p>
          </details>
        </section>

        {browsers.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-medium">推奨ブラウザ</h2>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {browsers.map((b) => (
                <li key={b.url}>
                  <a
                    href={b.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block rounded-md border border-zinc-200 dark:border-zinc-800 px-3 py-2 hover:bg-zinc-100 dark:hover:bg-zinc-900"
                  >
                    <span className="text-sm font-medium block">{b.name}</span>
                    {b.note && (
                      <span className="text-xs text-zinc-500 dark:text-zinc-400 block mt-0.5">
                        {b.note}
                      </span>
                    )}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

        {reason === 'ios' && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400 italic">
            iOS では全てのブラウザが WebKit エンジン上で動作するため、Chrome や Edge を
            インストールしても WebHID は使えません。kobu
            の設定変更には別のデバイスをご利用ください。
          </p>
        )}

        {reason === 'insecure-origin' && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400 italic">
            WebHID はセキュリティ上の理由で HTTPS / localhost からのみ動作します。 このページを
            HTTPS で開き直すか、開発時は <code className="font-mono">localhost</code> で
            アクセスしてください。
          </p>
        )}

        <footer className="text-xs text-zinc-500 dark:text-zinc-400 pt-2 border-t border-zinc-100 dark:border-zinc-900">
          フォールバック:{' '}
          <a
            href="https://vial.rocks/"
            target="_blank"
            rel="noreferrer"
            className="underline hover:no-underline"
          >
            vial.rocks
          </a>{' '}
          も WebHID を使うため同じ要件です。
        </footer>
      </article>
    </div>
  );
}

const COPY: Record<UnsupportedReason, { title: string; body: string }> = {
  ios: {
    title: 'iOS では kobu-editor を実行できません',
    body: 'iOS のすべてのブラウザは WebKit エンジン上で動作し、WebHID API を提供していません。デスクトップ (macOS / Windows / Linux) または Android デバイスから Chromium 系ブラウザでアクセスしてください。',
  },
  safari: {
    title: 'Safari では kobu-editor を実行できません',
    body: 'Safari は WebHID API を実装していません。Chromium 系ブラウザ (Chrome / Edge / Brave / Opera) をインストールしてアクセスしてください。',
  },
  firefox: {
    title: 'Firefox では kobu-editor を実行できません',
    body: 'Firefox は WebHID API を実装する予定がありません。Chromium 系ブラウザ (Chrome / Edge / Brave / Opera) をインストールしてアクセスしてください。',
  },
  'no-webhid': {
    title: 'このブラウザは kobu-editor に対応していません',
    body: 'WebHID API が見つかりませんでした。Chromium 系ブラウザ (Chrome / Edge / Brave / Opera) の最新版を利用するか、お使いのブラウザを最新にアップデートしてください。',
  },
  'insecure-origin': {
    title: 'HTTPS でアクセスしてください',
    body: 'このページは HTTP で表示されています。WebHID はセキュリティ上の理由で HTTPS または localhost からしか動作しません。',
  },
};
