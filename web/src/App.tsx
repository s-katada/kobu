import { ConnectButton } from './components/ConnectButton';
import { ConnectionStatus } from './components/ConnectionStatus';

export default function App() {
  return (
    <div className="min-h-full bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      <header className="border-b border-zinc-200 dark:border-zinc-800 px-6 py-4">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">kobu-config</h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Web-based keymap editor for the kobu split keyboard
            </p>
          </div>
          <ConnectionStatus />
        </div>
      </header>
      <main className="px-6 py-8 max-w-3xl mx-auto">
        <section className="space-y-4">
          <h2 className="text-lg font-medium">Connect</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Plug in the central (left) half via USB-C, then authorise the device.
          </p>
          <ConnectButton />
        </section>
      </main>
    </div>
  );
}
