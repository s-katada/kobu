import { describe, expect, it, vi } from 'vitest';
import { TransportError } from '../transport/types';
import type { WebHidTransport } from '../transport/webhid';
import { enterBootloader } from './device';

function fakeTransport(behaviour: 'reply' | TransportError['kind'] | 'other'): WebHidTransport {
  return {
    sendAndReceive: vi.fn(async () => {
      if (behaviour === 'reply') {
        return new Uint8Array(new ArrayBuffer(32)) as never;
      }
      if (behaviour === 'other') {
        throw new TypeError('boom');
      }
      throw new TransportError(behaviour, `simulated ${behaviour}`);
    }),
  } as unknown as WebHidTransport;
}

describe('enterBootloader', () => {
  it('treats a receive-timeout as success (firmware rebooted before ack)', async () => {
    await expect(enterBootloader(fakeTransport('receive-timeout'))).resolves.toBeUndefined();
  });

  it('treats send-failed as success (HID endpoint vanished mid-write)', async () => {
    await expect(enterBootloader(fakeTransport('send-failed'))).resolves.toBeUndefined();
  });

  it('treats disconnected as success', async () => {
    await expect(enterBootloader(fakeTransport('disconnected'))).resolves.toBeUndefined();
  });

  it('returns normally when the firmware happens to ack before rebooting', async () => {
    await expect(enterBootloader(fakeTransport('reply'))).resolves.toBeUndefined();
  });

  it('re-throws unrelated errors', async () => {
    await expect(enterBootloader(fakeTransport('other'))).rejects.toThrow('boom');
  });
});
