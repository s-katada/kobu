import { useEffect, useRef } from 'react';
import { useConnectionStore } from '../state/connection';

function recoveryHint(errorKind: string): string {
  switch (errorKind) {
    case 'webhid-unsupported':
      return 'デスクトップまたは Android で Chrome / Edge / Brave / Opera を使用してください。';
    case 'open-failed':
      return '他のタブがデバイスを掴んでいる可能性があります。そのタブを閉じてからやり直してください。';
    case 'receive-timeout':
      return 'kobu から応答がありません。USB ケーブルを抜き差ししてから再試行してください。';
    case 'disconnected':
      return '通信中にケーブルが抜けました。差し直して再接続してください。';
    case 'send-failed':
      return 'kobu への書き込みに失敗しました。ケーブルを確認してから再試行してください。';
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

  // Reattach to a previously-authorised kobu on first mount only.
  // Re-firing on every `idle` transition would defeat the「切断」
  // button — the user clicks disconnect, state drops to idle, and we
  // would silently reconnect again before they could blink. USB
  // unplug and explicit disconnect both leave the user in idle; they
  // must click「kobu に接続」(or refresh the page) to come back.
  const triedReconnect = useRef(false);
  useEffect(() => {
    if (triedReconnect.current) return;
    triedReconnect.current = true;
    void trySilentReconnect();
  }, [trySilentReconnect]);

  if (state.kind === 'unsupported') {
    return (
      <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 p-4 text-sm">
        このブラウザは WebHID に対応していません。デスクトップまたは Android で Chromium 系ブラウザ
        （Chrome / Edge / Brave / Opera）を使用してください。
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
            <span className="font-medium">{state.deviceName}</span> に接続しました
            {state.definitionFromCache && (
              <span className="ml-2 text-xs text-zinc-500 dark:text-zinc-400">
                （キーボード定義はキャッシュから読み込み）
              </span>
            )}
          </p>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            Via 0x{handshake.viaProtocolVersion.toString(16).padStart(4, '0')} / Vial 0x
            {handshake.keyboardId.vialProtocolVersion.toString(16).padStart(4, '0')} / マトリクス{' '}
            {matrix.rows}×{matrix.cols} / レイアウト {handshake.definition.layouts.keymap.length} 行
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void disconnect();
          }}
          className="rounded-md border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-900"
        >
          切断
        </button>
      </div>
    );
  }

  if (state.kind === 'wrong-device') {
    return (
      <div className="space-y-3">
        <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 p-4 text-sm space-y-1">
          <p className="font-medium">これは kobu ではありません。</p>
          <p className="text-xs text-zinc-700 dark:text-zinc-300">
            キーボードが返した UID <code className="font-mono">{state.uidHex}</code> は kobu の
            VIAL_KEYBOARD_ID と一致しません。別のデバイスを選択してください。
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void disconnect();
          }}
          className="rounded-md border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-900"
        >
          切断
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
          再試行
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
      {busy ? '接続中…' : 'kobu に接続'}
    </button>
  );
}
