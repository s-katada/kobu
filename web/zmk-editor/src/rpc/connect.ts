/**
 * Open a ZMK Studio connection over USB (Web Serial) or BLE (Web
 * Bluetooth).
 *
 * The ts-client transport `connect()` functions do the picker dance
 * (`navigator.serial.requestPort()` / `navigator.bluetooth.requestDevice()`)
 * and hand back an `RpcTransport`. We classify the failure modes the UI
 * cares about (user cancelled the picker vs. genuine failure) into a
 * single `ConnectError`.
 */

import { UserCancelledError } from '@zmkfirmware/zmk-studio-ts-client/transport/errors';
import { connect as connectGatt } from '@zmkfirmware/zmk-studio-ts-client/transport/gatt';
import type { RpcTransport } from '@zmkfirmware/zmk-studio-ts-client/transport/index';
import { connect as connectSerial } from '@zmkfirmware/zmk-studio-ts-client/transport/serial';
import { type StudioListeners, StudioSession } from './session';

export type TransportKind = 'usb' | 'ble';

export type ConnectErrorKind = 'cancelled' | 'unsupported' | 'failed';

export class ConnectError extends Error {
  readonly kind: ConnectErrorKind;
  constructor(kind: ConnectErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = 'ConnectError';
  }
}

export function isUsbSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

export function isBleSupported(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

function isCancellation(err: unknown): boolean {
  if (err instanceof UserCancelledError) return true;
  // Web Serial / Web Bluetooth pickers reject with a DOMException when the
  // user dismisses them without choosing a device.
  return err instanceof DOMException && (err.name === 'NotFoundError' || err.name === 'AbortError');
}

/**
 * Prompt the user to pick a device and open a Studio session. Must be
 * called from within a user gesture (the picker requires it).
 */
export async function connect(
  kind: TransportKind,
  listeners: StudioListeners = {},
): Promise<StudioSession> {
  let transport: RpcTransport;
  try {
    if (kind === 'usb') {
      if (!isUsbSupported()) {
        throw new ConnectError('unsupported', 'このブラウザは Web Serial に対応していません。');
      }
      transport = await connectSerial();
    } else {
      if (!isBleSupported()) {
        throw new ConnectError('unsupported', 'このブラウザは Web Bluetooth に対応していません。');
      }
      transport = await connectGatt();
    }
  } catch (err) {
    if (err instanceof ConnectError) throw err;
    if (isCancellation(err)) {
      throw new ConnectError('cancelled', 'デバイスの選択がキャンセルされました。');
    }
    throw new ConnectError(
      'failed',
      `接続に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return StudioSession.fromTransport(transport, listeners);
}
