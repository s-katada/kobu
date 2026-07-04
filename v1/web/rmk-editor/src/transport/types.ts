/**
 * Transport-layer constants for talking to kobu over the Vial wire
 * protocol. Each packet is exactly 32 bytes and carries one Via or Vial
 * command — the framing constants live here, the command catalogue
 * lives in `src/protocol/`.
 */

/** USB vendor id shared by every kobu generation (each `firmware/rmk/keyboard.toml`). */
export const KOBU_VENDOR_ID = 0x4b4f;

/** USB product id of kobu v1 (`v1/firmware/rmk/keyboard.toml`). */
export const KOBU_PRODUCT_ID = 0x4259;

/** USB product id of kobu v2 = "kobu2" (`v2/firmware/rmk/keyboard.toml`). */
export const KOBU2_PRODUCT_ID = 0x425a;

/**
 * Every product id the editor recognises as a kobu — same vendor id,
 * one product id per hardware generation. Extend when a new generation
 * ships; both the WebHID device picker filter and the reconnect
 * predicate iterate this list.
 */
export const KOBU_PRODUCT_IDS: readonly number[] = [KOBU_PRODUCT_ID, KOBU2_PRODUCT_ID];

/**
 * Raw HID usage page for Vial's vendor-defined report. Matches
 * `gen_hid_descriptor(usage_page = 0xFF60, usage = 0x61)` in
 * `rmk-0.8.2/src/descriptor.rs::ViaReport`.
 */
export const VIAL_USAGE_PAGE = 0xff60;
export const VIAL_USAGE = 0x61;

/**
 * Vial packet size. `VIAL_EP_SIZE` in
 * `rmk-types-0.2.2/src/protocol/vial.rs`. Both directions are exactly
 * this size — shorter writes are zero-padded at the call site.
 */
export const VIAL_PACKET_SIZE = 32;

/**
 * Output reports on the Vial collection are written with `reportId = 0`
 * (no report id prefix). WebHID's `sendReport` always takes the id as
 * a separate argument, so we keep this as a constant rather than
 * include it in the byte array.
 */
export const VIAL_REPORT_ID = 0;

/**
 * A Vial packet is always exactly 32 bytes. The backing buffer is an
 * `ArrayBuffer` (not `SharedArrayBuffer`) so it is assignable to the
 * `BufferSource` types WebHID requires.
 */
export type VialPacket = Uint8Array<ArrayBuffer> & { readonly __brand: 'VialPacket' };

/**
 * Cast a Uint8Array into the branded VialPacket type after asserting
 * its size. Throws synchronously rather than returning a falsy value
 * so the call site can rely on the cast unconditionally.
 */
export function intoVialPacket(buf: Uint8Array<ArrayBuffer>): VialPacket {
  if (buf.length !== VIAL_PACKET_SIZE) {
    throw new TransportError(
      'invalid-packet-size',
      `Vial packets must be exactly ${VIAL_PACKET_SIZE} bytes, got ${buf.length}`,
    );
  }
  return buf as VialPacket;
}

/** Allocate a fresh zero-filled packet for the caller to fill in. */
export function emptyPacket(): VialPacket {
  return new Uint8Array(new ArrayBuffer(VIAL_PACKET_SIZE)) as VialPacket;
}

export type TransportErrorKind =
  | 'webhid-unsupported'
  | 'device-not-selected'
  | 'open-failed'
  | 'send-failed'
  | 'receive-timeout'
  | 'disconnected'
  | 'invalid-packet-size'
  | 'concurrent-request';

export class TransportError extends Error {
  readonly kind: TransportErrorKind;

  constructor(kind: TransportErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = 'TransportError';
  }
}
