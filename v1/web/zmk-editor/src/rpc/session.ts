/**
 * Typed wrapper around a ZMK Studio RPC connection.
 *
 * `@zmkfirmware/zmk-studio-ts-client` gives us `create_rpc_connection`
 * (framing + request/response matching) and `call_rpc` (which already
 * throws `MetaError` / `NoResponseError` on protocol-level failures). On
 * top of that this class:
 *
 *   - owns the single notification-reader loop and fans events out to
 *     listeners (lock-state, unsaved-changes, disconnect);
 *   - exposes one typed method per RPC we use, unwrapping the subsystem
 *     field and throwing `StudioError` if the device returned an empty
 *     response.
 *
 * It is deliberately framework-agnostic (no React / Zustand) so it can
 * be unit-tested against a fake transport.
 */

import { call_rpc, create_rpc_connection } from '@zmkfirmware/zmk-studio-ts-client';
import { LockState } from '@zmkfirmware/zmk-studio-ts-client/core';
import type { RpcTransport } from '@zmkfirmware/zmk-studio-ts-client/transport/index';
import type {
  AddLayerResponse,
  BehaviorBinding,
  GetBehaviorDetailsResponse,
  GetDeviceInfoResponse,
  Keymap,
  MoveLayerResponse,
  Notification,
  PhysicalLayouts,
  RemoveLayerResponse,
  RestoreLayerResponse,
  RpcConnection,
  SaveChangesResponse,
  SetActivePhysicalLayoutResponse,
  SetLayerBindingResponse,
  SetLayerPropsResponse,
} from './types';

export class StudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudioError';
  }
}

export interface StudioListeners {
  onLockStateChanged?: (state: LockState) => void;
  onUnsavedChangesChanged?: (unsaved: boolean) => void;
  /** Fired when the notification stream ends (cable pull / BLE drop). */
  onDisconnect?: () => void;
}

export class StudioSession {
  readonly label: string;
  private readonly conn: RpcConnection;
  private listeners: StudioListeners;
  private closed = false;

  private constructor(conn: RpcConnection, listeners: StudioListeners) {
    this.conn = conn;
    this.label = conn.label;
    this.listeners = listeners;
    void this.runNotificationLoop();
  }

  static fromTransport(transport: RpcTransport, listeners: StudioListeners = {}): StudioSession {
    return new StudioSession(create_rpc_connection(transport), listeners);
  }

  setListeners(listeners: StudioListeners): void {
    this.listeners = listeners;
  }

  private async runNotificationLoop(): Promise<void> {
    const reader = this.conn.notification_readable.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.dispatch(value);
      }
    } catch {
      // Stream errored — typically the transport disappeared. Handled by
      // the onDisconnect call in `finally`.
    } finally {
      reader.releaseLock();
      if (!this.closed) this.listeners.onDisconnect?.();
    }
  }

  private dispatch(n: Notification): void {
    const lock = n.core?.lockStateChanged;
    if (lock !== undefined) this.listeners.onLockStateChanged?.(lock);
    const unsaved = n.keymap?.unsavedChangesStatusChanged;
    if (unsaved !== undefined) this.listeners.onUnsavedChangesChanged?.(unsaved);
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.conn.request_writable.close();
    } catch {
      // Already closing / errored — nothing to do.
    }
  }

  // ── core ──────────────────────────────────────────────────────────
  async getDeviceInfo(): Promise<GetDeviceInfoResponse> {
    const r = await call_rpc(this.conn, { core: { getDeviceInfo: true } });
    const v = r.core?.getDeviceInfo;
    if (!v) throw new StudioError('getDeviceInfo: 空のレスポンス');
    return v;
  }

  async getLockState(): Promise<LockState> {
    const r = await call_rpc(this.conn, { core: { getLockState: true } });
    return r.core?.getLockState ?? LockState.ZMK_STUDIO_CORE_LOCK_STATE_LOCKED;
  }

  async resetSettings(): Promise<boolean> {
    const r = await call_rpc(this.conn, { core: { resetSettings: true } });
    return r.core?.resetSettings ?? false;
  }

  // ── behaviors ─────────────────────────────────────────────────────
  async listAllBehaviors(): Promise<number[]> {
    const r = await call_rpc(this.conn, { behaviors: { listAllBehaviors: true } });
    return r.behaviors?.listAllBehaviors?.behaviors ?? [];
  }

  async getBehaviorDetails(behaviorId: number): Promise<GetBehaviorDetailsResponse> {
    const r = await call_rpc(this.conn, { behaviors: { getBehaviorDetails: { behaviorId } } });
    const v = r.behaviors?.getBehaviorDetails;
    if (!v) throw new StudioError(`getBehaviorDetails(${behaviorId}): 空のレスポンス`);
    return v;
  }

  // ── keymap ────────────────────────────────────────────────────────
  async getKeymap(): Promise<Keymap> {
    const r = await call_rpc(this.conn, { keymap: { getKeymap: true } });
    const v = r.keymap?.getKeymap;
    if (!v) throw new StudioError('getKeymap: 空のレスポンス');
    return v;
  }

  async getPhysicalLayouts(): Promise<PhysicalLayouts> {
    const r = await call_rpc(this.conn, { keymap: { getPhysicalLayouts: true } });
    const v = r.keymap?.getPhysicalLayouts;
    if (!v) throw new StudioError('getPhysicalLayouts: 空のレスポンス');
    return v;
  }

  async setActivePhysicalLayout(index: number): Promise<SetActivePhysicalLayoutResponse> {
    const r = await call_rpc(this.conn, { keymap: { setActivePhysicalLayout: index } });
    const v = r.keymap?.setActivePhysicalLayout;
    if (!v) throw new StudioError('setActivePhysicalLayout: 空のレスポンス');
    return v;
  }

  async setLayerBinding(
    layerId: number,
    keyPosition: number,
    binding: BehaviorBinding,
  ): Promise<SetLayerBindingResponse> {
    const r = await call_rpc(this.conn, {
      keymap: { setLayerBinding: { layerId, keyPosition, binding } },
    });
    const v = r.keymap?.setLayerBinding;
    if (v === undefined) throw new StudioError('setLayerBinding: 空のレスポンス');
    return v;
  }

  async addLayer(): Promise<AddLayerResponse> {
    const r = await call_rpc(this.conn, { keymap: { addLayer: {} } });
    const v = r.keymap?.addLayer;
    if (!v) throw new StudioError('addLayer: 空のレスポンス');
    return v;
  }

  async removeLayer(layerIndex: number): Promise<RemoveLayerResponse> {
    const r = await call_rpc(this.conn, { keymap: { removeLayer: { layerIndex } } });
    const v = r.keymap?.removeLayer;
    if (!v) throw new StudioError('removeLayer: 空のレスポンス');
    return v;
  }

  async moveLayer(startIndex: number, destIndex: number): Promise<MoveLayerResponse> {
    const r = await call_rpc(this.conn, { keymap: { moveLayer: { startIndex, destIndex } } });
    const v = r.keymap?.moveLayer;
    if (!v) throw new StudioError('moveLayer: 空のレスポンス');
    return v;
  }

  async restoreLayer(layerId: number, atIndex: number): Promise<RestoreLayerResponse> {
    const r = await call_rpc(this.conn, { keymap: { restoreLayer: { layerId, atIndex } } });
    const v = r.keymap?.restoreLayer;
    if (!v) throw new StudioError('restoreLayer: 空のレスポンス');
    return v;
  }

  async setLayerProps(layerId: number, name: string): Promise<SetLayerPropsResponse> {
    const r = await call_rpc(this.conn, { keymap: { setLayerProps: { layerId, name } } });
    const v = r.keymap?.setLayerProps;
    if (v === undefined) throw new StudioError('setLayerProps: 空のレスポンス');
    return v;
  }

  async checkUnsavedChanges(): Promise<boolean> {
    const r = await call_rpc(this.conn, { keymap: { checkUnsavedChanges: true } });
    return r.keymap?.checkUnsavedChanges ?? false;
  }

  async saveChanges(): Promise<SaveChangesResponse> {
    const r = await call_rpc(this.conn, { keymap: { saveChanges: true } });
    const v = r.keymap?.saveChanges;
    if (!v) throw new StudioError('saveChanges: 空のレスポンス');
    return v;
  }

  async discardChanges(): Promise<boolean> {
    const r = await call_rpc(this.conn, { keymap: { discardChanges: true } });
    return r.keymap?.discardChanges ?? false;
  }
}
