import { useEffect, useMemo, useState } from 'react';
import { ConnectButton } from './components/ConnectButton';
import { ConnectionStatus } from './components/ConnectionStatus';
import { Editor } from './components/Editor';
import { FirmwareSection } from './components/FirmwareSection';
import { SettingsPanel } from './components/SettingsPanel';
import { UnsupportedBrowserSplash } from './components/UnsupportedBrowserSplash';
import { detectEnvironment, refineBrave, unsupportedReason } from './lib/browser';
import { useConnectionStore } from './state/connection';

export default function App() {
  const ready = useConnectionStore((s) => s.state.kind === 'ready');

  const initialEnv = useMemo(() => detectEnvironment(), []);
  const [env, setEnv] = useState(initialEnv);
  useEffect(() => {
    void refineBrave(initialEnv).then((next) => {
      if (next.browser !== initialEnv.browser) setEnv(next);
    });
  }, [initialEnv]);

  const unsupported = unsupportedReason(env);
  if (unsupported) {
    return (
      <div className="min-h-full bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <UnsupportedBrowserSplash env={env} reason={unsupported} />
      </div>
    );
  }

  return (
    <div className="min-h-full bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
        <div className="mx-auto flex max-w-6xl items-baseline justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">kobu ZMK editor</h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              kobu（ZMK ファームウェア）向けの Web キーマップエディタ — ZMK Studio over USB / BLE
            </p>
          </div>
          <ConnectionStatus />
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-8 px-6 py-8">
        <section className="space-y-4">
          <h2 className="text-lg font-medium">接続</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            セントラル（左半分）を USB-C
            で接続し、デバイスを認可してください。レイヤーやキー割り当ては
            その場で本体に反映され、「本体に保存」で書き込まれます。
          </p>
          <ConnectButton />
        </section>

        {ready && (
          <section className="space-y-4">
            <h2 className="text-lg font-medium">キーマップ</h2>
            <Editor />
          </section>
        )}

        <SettingsPanel />

        <FirmwareSection />
      </main>
    </div>
  );
}
