import {
  browserLabel,
  type Environment,
  osLabel,
  recommendedBrowsers,
  type UnsupportedReason,
} from '../lib/browser';

const REASON_TEXT: Record<UnsupportedReason, string> = {
  'no-webserial':
    'このブラウザは Web Serial / Web Bluetooth に対応していないため、kobu の ZMK ファームウェアと通信できません。',
  firefox: 'Firefox は Web Serial / Web Bluetooth に対応していません。',
  safari: 'Safari は Web Serial / Web Bluetooth に対応していません。',
  ios: 'iOS のブラウザはすべて WebKit ベースで、Web Serial / Web Bluetooth に対応していません。',
  'insecure-origin':
    'このページは保護されていない接続（http）で開かれているため、デバイスにアクセスできません。HTTPS でアクセスしてください。',
};

export function UnsupportedBrowserSplash({
  env,
  reason,
}: {
  env: Environment;
  reason: UnsupportedReason;
}) {
  const browsers = recommendedBrowsers(env.os);
  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">kobu ZMK editor</h1>
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        {browserLabel(env.browser)} / {osLabel(env.os)} を検出しました。
      </p>
      <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
        <p className="text-sm">{REASON_TEXT[reason]}</p>
      </div>
      {browsers.length > 0 && (
        <div className="mt-6">
          <p className="text-sm font-medium">対応ブラウザ（Chromium 系）:</p>
          <ul className="mt-2 space-y-1 text-sm">
            {browsers.map((b) => (
              <li key={b.url}>
                <a
                  className="text-sky-600 underline hover:text-sky-500 dark:text-sky-400"
                  href={b.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {b.name}
                </a>
                {b.note ? <span className="text-zinc-500"> — {b.note}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-6 text-xs text-zinc-500 dark:text-zinc-400">
        ライブ編集には Chrome / Edge / Brave / Opera（デスクトップ、USB 接続）を推奨します。BLE
        接続は Linux のブラウザのみ対応しています。
      </p>
    </div>
  );
}
