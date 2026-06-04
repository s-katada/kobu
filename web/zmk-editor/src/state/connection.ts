/**
 * Connection store: owns the live `StudioSession` and the connection
 * state machine. Connecting also loads the keymap (via the keymap
 * store); a mid-session disconnect (cable pull / BLE drop) resets both.
 */

import { create } from 'zustand';
import { ConnectError, connect as openConnection, type TransportKind } from '../rpc/connect';
import type { StudioSession } from '../rpc/session';
import { useKeymapStore } from './keymap';

export type ConnectionState =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'ready'; transport: TransportKind; label: string; deviceName: string }
  | { kind: 'error'; message: string };

interface ConnectionStore {
  state: ConnectionState;
  session: StudioSession | null;
  connect: (kind: TransportKind) => Promise<void>;
  disconnect: () => Promise<void>;
  /** Internal: the notification stream ended (device went away). */
  handleDrop: () => void;
  clearError: () => void;
}

export const useConnectionStore = create<ConnectionStore>((set, get) => ({
  state: { kind: 'idle' },
  session: null,

  connect: async (kind) => {
    if (get().state.kind === 'connecting') return;
    set({ state: { kind: 'connecting' } });

    let session: StudioSession;
    try {
      session = await openConnection(kind, {
        onUnsavedChangesChanged: (unsaved) => useKeymapStore.getState().setUnsaved(unsaved),
        onDisconnect: () => get().handleDrop(),
      });
    } catch (err) {
      if (err instanceof ConnectError && err.kind === 'cancelled') {
        set({ state: { kind: 'idle' } });
        return;
      }
      set({ state: { kind: 'error', message: err instanceof Error ? err.message : String(err) } });
      return;
    }

    try {
      const info = await session.getDeviceInfo();
      await useKeymapStore.getState().load(session);
      set({
        session,
        state: { kind: 'ready', transport: kind, label: session.label, deviceName: info.name },
      });
    } catch (err) {
      await session.close();
      useKeymapStore.getState().reset();
      set({
        session: null,
        state: {
          kind: 'error',
          message: `初期化に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
    }
  },

  disconnect: async () => {
    const { session } = get();
    if (session) await session.close();
    useKeymapStore.getState().reset();
    set({ session: null, state: { kind: 'idle' } });
  },

  handleDrop: () => {
    if (get().session === null && get().state.kind !== 'ready') return;
    useKeymapStore.getState().reset();
    set({
      session: null,
      state: { kind: 'error', message: 'デバイスとの接続が切れました。再接続してください。' },
    });
  },

  clearError: () => {
    if (get().state.kind === 'error') set({ state: { kind: 'idle' } });
  },
}));
