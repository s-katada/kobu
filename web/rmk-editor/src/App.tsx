import { useEffect, useMemo, useState } from 'react';
import { ConnectButton } from './components/ConnectButton';
import { ConnectionStatus } from './components/ConnectionStatus';
import { Editor } from './components/Editor';
import { FirmwareSection } from './components/FirmwareSection';
import { PwaUpdateToast } from './components/PwaUpdateToast';
import { UnsupportedBrowserSplash } from './components/UnsupportedBrowserSplash';
import { detectEnvironment, refineBrave, unsupportedReason } from './lib/browser';
import { useConnectionStore } from './state/connection';

export default function App() {
  const connectionKind = useConnectionStore((s) => s.state.kind);
  const showEditor = connectionKind === 'ready';

  // Detect once at mount; refine the Chrome→Brave async check after
  // the synchronous detection lands. Brave reports as Chrome in the
  // UA string, so this is the only path that can correct it.
  const initialEnv = useMemo(() => detectEnvironment(), []);
  const [env, setEnv] = useState(initialEnv);
  useEffect(() => {
    void refineBrave(initialEnv).then((next) => {
      if (next.browser !== initialEnv.browser) setEnv(next);
    });
  }, [initialEnv]);

  const unsupported = unsupportedReason(env);

  // Block the rest of the app for environments that literally cannot
  // talk to kobu. The splash explains what to do; rendering the
  // normal layout would just dead-end at the connect button with no
  // recovery path.
  if (unsupported) {
    return (
      <div className="min-h-full bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
        <UnsupportedBrowserSplash env={env} reason={unsupported} />
      </div>
    );
  }

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      <header className="border-b border-zinc-200 dark:border-zinc-800 px-6 py-4">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">kobu-editor</h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              kobu スプリットキーボード向けの Web キーマップエディタ
            </p>
          </div>
          <ConnectionStatus />
        </div>
      </header>
      <main className="px-6 py-8 max-w-6xl mx-auto space-y-8">
        <section className="space-y-4">
          <h2 className="text-lg font-medium">接続</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            セントラル（左半分）を USB-C で接続し、デバイスを認可してください。
          </p>
          <ConnectButton />
        </section>

        {showEditor && (
          <section className="space-y-4">
            <h2 className="text-lg font-medium">キーマップ</h2>
            <Editor />
          </section>
        )}

        <FirmwareSection />
      </main>
      <PwaUpdateToast />
    </div>
  );
}
