/**
 * Localized, actionable messages for errors raised during a device write
 * (save / reset / settings push).
 *
 * The feature stores used to surface raw `String(err)` — e.g. a bare
 * "TransportError: device disconnected" — which is neither localized nor
 * actionable. This classifier turns a thrown error into a Japanese message
 * that tells the user what to do: a lost transport (USB unplug / BLE drop)
 * means "reconnect and retry"; a concurrent request means "wait"; everything
 * else falls back to a generic save-failure with the underlying message.
 */

import { TransportError } from '../transport/types';

export function describeWriteError(err: unknown): string {
  if (err instanceof TransportError) {
    switch (err.kind) {
      case 'disconnected':
      case 'send-failed':
      case 'receive-timeout':
        return 'デバイスが切断されました。再接続して保存し直してください。';
      case 'concurrent-request':
        return '別の操作が進行中です。少し待ってからやり直してください。';
      case 'invalid-packet-size':
        return '不正な応答を受信しました。再接続してやり直してください。';
      default:
        return `通信エラーが発生しました: ${err.message}`;
    }
  }
  return `保存に失敗しました: ${err instanceof Error ? err.message : String(err)}`;
}

/** True when the error means the device went away (vs a logical rejection). */
export function isTransportLost(err: unknown): boolean {
  return (
    err instanceof TransportError &&
    (err.kind === 'disconnected' || err.kind === 'send-failed' || err.kind === 'receive-timeout')
  );
}
