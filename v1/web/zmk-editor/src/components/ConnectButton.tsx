import { isBleSupported } from '../rpc/connect';
import { useConnectionStore } from '../state/connection';

export function ConnectButton() {
  const state = useConnectionStore((s) => s.state);
  const connect = useConnectionStore((s) => s.connect);
  const disconnect = useConnectionStore((s) => s.disconnect);
  const clearError = useConnectionStore((s) => s.clearError);

  const connecting = state.kind === 'connecting';
  const ready = state.kind === 'ready';
  const ble = isBleSupported();

  if (ready) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-zinc-600 dark:text-zinc-300">接続済み: {state.label}</span>
        <button
          type="button"
          onClick={() => void disconnect()}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          切断
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={connecting}
          onClick={() => void connect('usb')}
          className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {connecting ? '接続中…' : 'USB で接続'}
        </button>
        {ble && (
          <button
            type="button"
            disabled={connecting}
            onClick={() => void connect('ble')}
            className="rounded-md border border-sky-600 px-4 py-2 text-sm font-medium text-sky-700 hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-sky-300 dark:hover:bg-sky-950/40"
          >
            BLE で接続
          </button>
        )}
      </div>
      {state.kind === 'error' && (
        <div className="flex items-start gap-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
          <span className="flex-1">{state.message}</span>
          <button type="button" onClick={clearError} className="font-medium underline">
            閉じる
          </button>
        </div>
      )}
    </div>
  );
}
