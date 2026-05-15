import { useEffect } from 'react';
import { useConnectionStore } from '../state/connection';

function recoveryHint(errorKind: string): string {
  switch (errorKind) {
    case 'webhid-unsupported':
      return 'Use Chrome, Edge, Brave, or Opera on desktop or Android.';
    case 'open-failed':
      return 'Another tab might already be holding the device. Close it and try again.';
    case 'receive-timeout':
      return 'kobu did not reply. Unplug and replug the USB cable, then retry.';
    case 'disconnected':
      return 'The cable was unplugged mid-request. Plug it back in and reconnect.';
    case 'send-failed':
      return 'Writing to kobu failed. Check the cable and try again.';
    default:
      return '';
  }
}

export function ConnectButton() {
  const state = useConnectionStore((s) => s.state);
  const promptConnect = useConnectionStore((s) => s.promptConnect);
  const trySilentReconnect = useConnectionStore((s) => s.trySilentReconnect);
  const disconnect = useConnectionStore((s) => s.disconnect);
  const clearError = useConnectionStore((s) => s.clearError);

  // Reattach to a previously-authorised kobu on first mount, then
  // again whenever we drop back to idle (e.g. after a USB unplug).
  useEffect(() => {
    if (state.kind === 'idle') void trySilentReconnect();
  }, [state.kind, trySilentReconnect]);

  if (state.kind === 'unsupported') {
    return (
      <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 p-4 text-sm">
        WebHID is not available in this browser. Use a Chromium-based browser (Chrome, Edge, Brave,
        or Opera) on desktop or Android.
      </div>
    );
  }

  if (state.kind === 'ready') {
    const { handshake } = state;
    const matrix = handshake.definition.matrix;
    return (
      <div className="space-y-3">
        <div className="rounded-md border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 p-4 text-sm space-y-1">
          <p>
            Connected to <span className="font-medium">{state.deviceName}</span>
            {state.definitionFromCache && (
              <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                (definition served from cache)
              </span>
            )}
          </p>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            Via 0x{handshake.viaProtocolVersion.toString(16).padStart(4, '0')} / Vial 0x
            {handshake.keyboardId.vialProtocolVersion.toString(16).padStart(4, '0')} / matrix{' '}
            {matrix.rows}×{matrix.cols} / {handshake.definition.layouts.keymap.length} layout row(s)
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void disconnect();
          }}
          className="rounded-md border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-900"
        >
          Disconnect
        </button>
      </div>
    );
  }

  if (state.kind === 'wrong-device') {
    return (
      <div className="space-y-3">
        <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 p-4 text-sm space-y-1">
          <p className="font-medium">This is not a kobu.</p>
          <p className="text-xs text-zinc-700 dark:text-zinc-300">
            The keyboard reported UID <code className="font-mono">{state.uidHex}</code>, which does
            not match kobu's VIAL_KEYBOARD_ID. Pick a different device.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void disconnect();
          }}
          className="rounded-md border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-900"
        >
          Disconnect
        </button>
      </div>
    );
  }

  if (state.kind === 'error') {
    const hint = recoveryHint(state.errorKind);
    return (
      <div className="space-y-3">
        <div className="rounded-md border border-rose-300 dark:border-rose-700 bg-rose-50 dark:bg-rose-950/40 p-4 text-sm space-y-1">
          <p className="font-medium">
            {state.errorKind}: {state.message}
          </p>
          {hint && <p className="text-rose-700 dark:text-rose-400">{hint}</p>}
        </div>
        <button
          type="button"
          onClick={clearError}
          className="rounded-md border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-900"
        >
          Try again
        </button>
      </div>
    );
  }

  const busy = state.kind === 'connecting';
  return (
    <button
      type="button"
      onClick={() => {
        void promptConnect();
      }}
      disabled={busy}
      className="rounded-md bg-zinc-900 dark:bg-zinc-100 text-zinc-50 dark:text-zinc-900 px-4 py-2 text-sm font-medium disabled:opacity-60"
    >
      {busy ? 'Connecting…' : 'Connect to kobu'}
    </button>
  );
}
