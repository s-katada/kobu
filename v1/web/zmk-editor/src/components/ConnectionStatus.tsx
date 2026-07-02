import { useConnectionStore } from '../state/connection';

export function ConnectionStatus() {
  const state = useConnectionStore((s) => s.state);

  const dot = (cls: string) => <span className={`inline-block h-2 w-2 rounded-full ${cls}`} />;

  switch (state.kind) {
    case 'idle':
      return (
        <span className="flex items-center gap-2 text-sm text-zinc-500">
          {dot('bg-zinc-400')} 未接続
        </span>
      );
    case 'connecting':
      return (
        <span className="flex items-center gap-2 text-sm text-sky-600 dark:text-sky-400">
          {dot('bg-sky-500 animate-pulse')} 接続中…
        </span>
      );
    case 'ready':
      return (
        <span className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
          {dot('bg-emerald-500')} {state.deviceName || 'kobu'}（
          {state.transport === 'usb' ? 'USB' : 'BLE'}）
        </span>
      );
    case 'error':
      return (
        <span className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
          {dot('bg-red-500')} エラー
        </span>
      );
  }
}
