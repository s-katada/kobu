import { describe, expect, it } from 'vitest';
import { TransportError } from '../transport/types';
import { describeWriteError, isTransportLost } from './saveError';

describe('describeWriteError', () => {
  it('maps a lost transport to a reconnect message', () => {
    for (const kind of ['disconnected', 'send-failed', 'receive-timeout'] as const) {
      const msg = describeWriteError(new TransportError(kind, 'x'));
      expect(msg).toMatch(/切断されました.*再接続/);
    }
  });

  it('maps a concurrent request to a wait message', () => {
    expect(describeWriteError(new TransportError('concurrent-request', 'x'))).toMatch(
      /別の操作が進行中/,
    );
  });

  it('falls back to a generic save-failure for non-transport errors', () => {
    expect(describeWriteError(new Error('boom'))).toMatch(/保存に失敗しました.*boom/);
    expect(describeWriteError('weird')).toMatch(/保存に失敗しました.*weird/);
  });
});

describe('isTransportLost', () => {
  it('is true only for device-gone transport errors', () => {
    expect(isTransportLost(new TransportError('disconnected', 'x'))).toBe(true);
    expect(isTransportLost(new TransportError('send-failed', 'x'))).toBe(true);
    expect(isTransportLost(new TransportError('concurrent-request', 'x'))).toBe(false);
    expect(isTransportLost(new Error('boom'))).toBe(false);
  });
});
