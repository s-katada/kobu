/**
 * Connection state machine for the kobu transport.
 *
 * The store is the single source of truth that the UI subscribes to.
 * Everything WebHID-related funnels through `promptConnect` /
 * `disconnect` so the UI never has to handle promises directly — it
 * just reads the current `state`.
 *
 * States:
 *   unsupported  - browser does not implement WebHID
 *   idle         - WebHID is available but nothing is connected
 *   connecting   - device picker dismissed, opening the device + handshaking
 *   ready        - transport is open AND handshake succeeded; the
 *                  layout definition is loaded and we know we're
 *                  talking to a kobu (UID matched)
 *   wrong-device - transport is open but the UID does not match a kobu
 *   error        - last attempt failed; UI shows {message} and retry
 *
 * The store also owns the `navigator.hid.disconnect` listener so a
 * physical USB unplug instantly transitions a `ready` state back to
 * `idle` regardless of which component is in focus.
 */

import { create } from 'zustand';
import { loadCachedDefinition, saveCachedDefinition } from '../protocol/cache';
import { type HandshakeResult, performHandshake } from '../protocol/handshake';
import { TransportError } from '../transport/types';
import {
  getPreviouslyAuthorizedKobuDevices,
  isWebHidSupported,
  requestKobuDevice,
  WebHidTransport,
} from '../transport/webhid';

export type ConnectionState =
  | { kind: 'unsupported' }
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | {
      kind: 'ready';
      transport: WebHidTransport;
      handshake: HandshakeResult;
      deviceName: string;
      definitionFromCache: boolean;
    }
  | {
      kind: 'wrong-device';
      transport: WebHidTransport;
      uidHex: string;
    }
  | { kind: 'error'; message: string; errorKind: TransportError['kind'] | 'unknown' };

interface ConnectionStore {
  state: ConnectionState;

  /** Open the device picker, then connect to whatever the user picks. */
  promptConnect: () => Promise<void>;

  /** Try to reattach to a previously-authorised device without prompting. */
  trySilentReconnect: () => Promise<void>;

  /** Close the active transport and return to `idle`. */
  disconnect: () => Promise<void>;

  /** Reset from `error` back to `idle` so the UI can retry. */
  clearError: () => void;
}

function initialState(): ConnectionState {
  if (typeof navigator === 'undefined' || !isWebHidSupported()) return { kind: 'unsupported' };
  return { kind: 'idle' };
}

function describeError(err: unknown): {
  message: string;
  errorKind: TransportError['kind'] | 'unknown';
} {
  if (err instanceof TransportError) {
    return { message: err.message, errorKind: err.kind };
  }
  return { message: String(err), errorKind: 'unknown' };
}

function deviceLabel(device: HIDDevice): string {
  if (device.productName?.length) return device.productName;
  return `kobu (${device.vendorId.toString(16)}:${device.productId.toString(16)})`;
}

function uidHex(uid: Uint8Array): string {
  return Array.from(uid, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const useConnectionStore = create<ConnectionStore>((set, get) => {
  /**
   * Listen for physical USB unplug events. The store is module-scoped so
   * we register exactly one listener for the lifetime of the page.
   */
  if (typeof navigator !== 'undefined' && isWebHidSupported()) {
    navigator.hid.addEventListener('disconnect', (event) => {
      const current = get().state;
      if (current.kind !== 'ready' && current.kind !== 'wrong-device') return;
      if (current.transport.device !== event.device) return;
      void current.transport.close();
      set({ state: { kind: 'idle' } });
    });
  }

  async function connectTo(device: HIDDevice): Promise<void> {
    set({ state: { kind: 'connecting' } });
    let transport: WebHidTransport | null = null;
    try {
      transport = await WebHidTransport.open(device);
      const handshake = await performHandshake(transport);
      if (!handshake.isKobu) {
        set({
          state: {
            kind: 'wrong-device',
            transport,
            uidHex: uidHex(handshake.keyboardId.uid),
          },
        });
        return;
      }
      // Replace the freshly-fetched definition with the cached copy
      // ONLY when its content matches byte-for-byte. The previous
      // logic blindly preferred whatever cached entry existed for a
      // given UID, so re-flashing firmware with an updated vial.json
      // (same UID, different layout) silently kept showing the stale
      // layout in the editor until the user nuked localStorage. We
      // detect the mismatch by JSON-serialising both definitions and
      // refresh the cache when they diverge.
      const cached = loadCachedDefinition(handshake.keyboardId.uid);
      const cachedMatchesFresh =
        cached !== null && JSON.stringify(cached) === JSON.stringify(handshake.definition);
      const definitionFromCache = cachedMatchesFresh;
      const handshakeMaybeCached: HandshakeResult = cachedMatchesFresh
        ? { ...handshake, definition: cached as typeof handshake.definition }
        : handshake;
      if (!cachedMatchesFresh) {
        saveCachedDefinition(handshake.keyboardId.uid, handshake.definition);
      }

      set({
        state: {
          kind: 'ready',
          transport,
          handshake: handshakeMaybeCached,
          deviceName: deviceLabel(device),
          definitionFromCache,
        },
      });
    } catch (err) {
      if (transport) {
        try {
          await transport.close();
        } catch {
          // ignore — we're already on the error path
        }
      }
      const { message, errorKind } = describeError(err);
      set({ state: { kind: 'error', message, errorKind } });
    }
  }

  return {
    state: initialState(),

    promptConnect: async () => {
      const current = get().state;
      if (current.kind === 'unsupported' || current.kind === 'connecting') return;
      try {
        const device = await requestKobuDevice();
        if (!device) {
          set({ state: { kind: 'idle' } });
          return;
        }
        await connectTo(device);
      } catch (err) {
        const { message, errorKind } = describeError(err);
        set({ state: { kind: 'error', message, errorKind } });
      }
    },

    trySilentReconnect: async () => {
      const current = get().state;
      if (current.kind !== 'idle') return;
      const previous = await getPreviouslyAuthorizedKobuDevices();
      const device = previous[0];
      if (!device) return;
      await connectTo(device);
    },

    disconnect: async () => {
      const current = get().state;
      if (current.kind !== 'ready' && current.kind !== 'wrong-device') return;
      const { transport } = current;
      await transport.close();
      // `forget()` revokes the page's permission for this device, so
      // `navigator.hid.getDevices()` no longer returns it. Without
      // this, reloading the page brings the silent-reconnect path
      // back online and the user is reconnected against their wishes.
      // Older or polyfilled HIDDevice may not have `forget` — guard
      // accordingly. Best-effort: if forget throws we still treat the
      // disconnect as successful because the transport is closed.
      try {
        await transport.device.forget?.();
      } catch {
        // Ignore — the transport is already closed, the user is
        // effectively disconnected for this session.
      }
      set({ state: { kind: 'idle' } });
    },

    clearError: () => {
      const current = get().state;
      if (current.kind === 'error') set({ state: { kind: 'idle' } });
    },
  };
});
