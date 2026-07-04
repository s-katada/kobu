/**
 * WebHID transport for the Vial wire protocol on kobu.
 *
 * Scope: ferry 32-byte packets in and out of kobu's vendor-defined
 * Raw HID interface (usage page 0xFF60, usage 0x61). The packet
 * *contents* — Via/Vial command catalogue, encoders, etc. — belong to
 * `src/protocol/`, which builds on top of this transport.
 */

import {
  emptyPacket,
  intoVialPacket,
  KOBU_PRODUCT_IDS,
  KOBU_VENDOR_ID,
  TransportError,
  VIAL_PACKET_SIZE,
  VIAL_REPORT_ID,
  VIAL_USAGE,
  VIAL_USAGE_PAGE,
  type VialPacket,
} from './types';

/**
 * True when the current browser exposes the WebHID API. Always false
 * during SSR / jsdom test runs unless the test polyfills it.
 */
export function isWebHidSupported(): boolean {
  return typeof navigator !== 'undefined' && 'hid' in navigator;
}

/**
 * Prompt the user to authorise a kobu device. Returns the picked
 * device, or null if the user cancelled the picker. Throws
 * `TransportError` when WebHID is unavailable.
 */
export async function requestKobuDevice(): Promise<HIDDevice | null> {
  if (!isWebHidSupported()) {
    throw new TransportError('webhid-unsupported', 'WebHID is not available in this browser');
  }
  const devices = await navigator.hid.requestDevice({
    // One filter entry per kobu generation (v1 / kobu2) — same VID and
    // Vial usage, different PID.
    filters: KOBU_PRODUCT_IDS.map((productId) => ({
      vendorId: KOBU_VENDOR_ID,
      productId,
      usagePage: VIAL_USAGE_PAGE,
      usage: VIAL_USAGE,
    })),
  });
  return devices[0] ?? null;
}

/**
 * Return any kobu devices the user has previously authorised on this
 * origin. Useful for auto-reconnecting on app load without a click.
 */
export async function getPreviouslyAuthorizedKobuDevices(): Promise<HIDDevice[]> {
  if (!isWebHidSupported()) return [];
  const devices = await navigator.hid.getDevices();
  return devices.filter(
    (d) =>
      d.vendorId === KOBU_VENDOR_ID &&
      KOBU_PRODUCT_IDS.includes(d.productId) &&
      d.collections.some((c) => c.usagePage === VIAL_USAGE_PAGE && c.usage === VIAL_USAGE),
  );
}

interface PendingRequest {
  resolve: (packet: VialPacket) => void;
  reject: (err: TransportError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One transport per opened device. Serialises request/response pairs
 * with a single-slot mailbox: starting a new sendAndReceive while
 * another is outstanding throws synchronously so callers can't
 * accidentally interleave Vial commands.
 *
 * Receive timeout defaults to 1 second — Vial commands all reply in
 * a few milliseconds, so a slow reply means kobu is wedged or
 * disconnected mid-flight, not "be patient".
 */
export class WebHidTransport {
  readonly device: HIDDevice;
  private receiveTimeoutMs: number;
  private pending: PendingRequest | null = null;
  private readonly onInputReport: (event: HIDInputReportEvent) => void;
  private closed = false;

  constructor(device: HIDDevice, options: { receiveTimeoutMs?: number } = {}) {
    this.device = device;
    this.receiveTimeoutMs = options.receiveTimeoutMs ?? 1000;
    this.onInputReport = (event) => this.handleInputReport(event);
  }

  static async open(
    device: HIDDevice,
    options: { receiveTimeoutMs?: number } = {},
  ): Promise<WebHidTransport> {
    if (!device.opened) {
      try {
        await device.open();
      } catch (err) {
        throw new TransportError('open-failed', `Failed to open kobu: ${String(err)}`);
      }
    }
    const transport = new WebHidTransport(device, options);
    device.addEventListener('inputreport', transport.onInputReport);
    return transport;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.device.removeEventListener('inputreport', this.onInputReport);
    this.failPending('disconnected', 'Transport closed before reply arrived');
    if (this.device.opened) {
      try {
        await this.device.close();
      } catch {
        // Closing a stale device sometimes throws on USB unplug — fine, we're going away anyway.
      }
    }
  }

  /**
   * Send a 32-byte packet and wait for the matching 32-byte reply.
   *
   * Vial doesn't have request ids: kobu echoes back on the same
   * interface in order, so this enforces sequential access. Callers
   * that need parallelism can build a queue on top.
   */
  async sendAndReceive(packet: VialPacket): Promise<VialPacket> {
    if (this.closed) {
      throw new TransportError('disconnected', 'Transport is closed');
    }
    if (this.pending !== null) {
      throw new TransportError(
        'concurrent-request',
        'Another sendAndReceive is in flight — Vial requires serial access',
      );
    }

    let pending!: PendingRequest;
    const reply = new Promise<VialPacket>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending === pending) this.pending = null;
        reject(new TransportError('receive-timeout', 'kobu did not reply within timeout'));
      }, this.receiveTimeoutMs);
      pending = { resolve, reject, timer };
    });
    this.pending = pending;

    try {
      await this.device.sendReport(VIAL_REPORT_ID, packet);
    } catch (err) {
      if (this.pending === pending) this.pending = null;
      clearTimeout(pending.timer);
      throw new TransportError('send-failed', `Failed to write Vial packet: ${String(err)}`);
    }

    return reply;
  }

  private handleInputReport(event: HIDInputReportEvent): void {
    const pending = this.pending;
    if (!pending) return;
    const view = event.data;
    if (view.byteLength !== VIAL_PACKET_SIZE) return;
    const copy = new Uint8Array(new ArrayBuffer(VIAL_PACKET_SIZE));
    copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve(intoVialPacket(copy));
  }

  private failPending(kind: 'disconnected', message: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(new TransportError(kind, message));
  }
}

/**
 * Build a 32-byte packet for the Via `GetProtocolVersion` command
 * (`0x01`). Used as a smoke test for the transport itself — Phase 2.1
 * (#25) wraps this and other commands in a proper protocol module.
 */
export function buildSmokeTestPacket(): VialPacket {
  const packet = emptyPacket();
  packet[0] = 0x01;
  return packet;
}
