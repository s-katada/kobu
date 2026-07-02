import { useConnectionStore } from '../state/connection';

/**
 * Compact status indicator for the header. The full connect/disconnect
 * UX lives in `ConnectButton`; this is the "always-on" badge.
 */
export function ConnectionStatus() {
  const state = useConnectionStore((s) => s.state);

  switch (state.kind) {
    case 'unsupported':
      return (
        <span className="text-xs text-amber-700 dark:text-amber-400" aria-live="polite">
          WebHID 非対応
        </span>
      );
    case 'idle':
      return (
        <span className="text-xs text-zinc-500 dark:text-zinc-400" aria-live="polite">
          未接続
        </span>
      );
    case 'connecting':
      return (
        <span className="text-xs text-zinc-500 dark:text-zinc-400" aria-live="polite">
          接続中…
        </span>
      );
    case 'ready':
      return (
        <span
          className="text-xs text-emerald-700 dark:text-emerald-400"
          title={`Via 0x${state.handshake.viaProtocolVersion.toString(16).padStart(4, '0')}, Vial 0x${state.handshake.keyboardId.vialProtocolVersion.toString(16).padStart(4, '0')}`}
          aria-live="polite"
        >
          ● {state.deviceName}
          {state.definitionFromCache && (
            <span className="ml-1 text-zinc-500 dark:text-zinc-400">（キャッシュ）</span>
          )}
        </span>
      );
    case 'wrong-device':
      return (
        <span
          className="text-xs text-amber-700 dark:text-amber-400"
          title={`UID ${state.uidHex}`}
          aria-live="polite"
        >
          別のデバイス
        </span>
      );
    case 'error':
      return (
        <span
          className="text-xs text-rose-700 dark:text-rose-400"
          title={state.message}
          aria-live="polite"
        >
          ● {state.errorKind}
        </span>
      );
  }
}
