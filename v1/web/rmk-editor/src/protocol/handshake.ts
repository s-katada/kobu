/**
 * Handshake = the boring-but-mandatory dance the editor does at the
 * moment the WebHID transport opens. It tells us:
 *
 *   1. that the firmware speaks Vial at all (`GetProtocolVersion`),
 *   2. that we're talking to a kobu and not some other Vial board
 *      (`GetKeyboardId` cross-checked against `KOBU_KEYBOARD_UID`),
 *   3. the XZ-compressed JSON describing the physical layout
 *      (`GetSize` + `GetKeyboardDef` paged 32 bytes at a time,
 *      decompressed with the WASM `xz-decompress`).
 *
 * The decompressed JSON is the same `vial.json` the firmware build
 * (`firmware/build.rs`) embedded at flash time, so this module is
 * effectively how the web app discovers kobu's matrix size, layer
 * count, and customKeycodes labels without shipping that data itself.
 */

import { XzReadableStream } from 'xz-decompress';
import { KOBU2_PRODUCT_ID, TransportError, VIAL_PACKET_SIZE } from '../transport/types';
import type { WebHidTransport } from '../transport/webhid';
import {
  buildGetKeyboardDef,
  buildGetKeyboardId,
  buildGetProtocolVersion,
  buildGetSize,
  type KeyboardId,
  parseKeyboardId,
  parseProtocolVersion,
  parseSize,
} from './commands';

/**
 * UID baked into `firmware/build.rs`:
 *
 *   `vec![0xB9, 0xBC, 0x09, 0xB2, 0x9D, 0x37, 0x4C, 0xEA]`
 *
 * If the device reports anything else we refuse to interpret its
 * layout as kobu's.
 */
// `as const` on the array literal keeps the values immutable at the
// type level; `Object.freeze` on a TypedArray throws at runtime
// because views can't be frozen.
export const KOBU_KEYBOARD_UID: Uint8Array = new Uint8Array([
  0xb9, 0xbc, 0x09, 0xb2, 0x9d, 0x37, 0x4c, 0xea,
]);

export interface KeyboardLayoutDef {
  name?: string;
  vendorId?: string;
  productId?: string;
  matrix: { rows: number; cols: number };
  customKeycodes?: Array<{ name: string; title: string; shortName: string }>;
  layouts: { keymap: Array<Array<unknown>> };
}

/**
 * True when the definition self-identifies as kobu2 (v2 hardware: one
 * extra bottom-pinky key per half at keymap (3,0)/(3,9)). `productId`
 * is the hex string the firmware embeds in its vial.json (e.g.
 * "0x425A") — same VID and Vial UID as v1, different PID.
 */
export function isKobu2Definition(def: Pick<KeyboardLayoutDef, 'productId'>): boolean {
  return Number.parseInt(def.productId ?? '', 16) === KOBU2_PRODUCT_ID;
}

export interface HandshakeResult {
  viaProtocolVersion: number;
  keyboardId: KeyboardId;
  definition: KeyboardLayoutDef;
  /** True when the keyboard UID matches kobu's hardcoded value. */
  isKobu: boolean;
}

/** Byte-equality check used to confirm the connected device is kobu. */
export function uidEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Run the full handshake. Caller is expected to have a transport in
 * the `open` state — the connection store calls this from inside
 * `connectTo` so the device picker flow is unchanged.
 */
export async function performHandshake(transport: WebHidTransport): Promise<HandshakeResult> {
  // Step 1: Via protocol version — fastest cheap probe.
  const versionReply = await transport.sendAndReceive(buildGetProtocolVersion());
  const viaProtocolVersion = parseProtocolVersion(versionReply);

  // Step 2: Vial keyboard id (UID + feature flags).
  const idReply = await transport.sendAndReceive(buildGetKeyboardId());
  const keyboardId = parseKeyboardId(idReply);
  const isKobu = uidEquals(keyboardId.uid, KOBU_KEYBOARD_UID);

  // Step 3: keyboard definition byte length.
  const sizeReply = await transport.sendAndReceive(buildGetSize());
  const totalSize = parseSize(sizeReply);

  if (totalSize === 0 || totalSize > 1024 * 64) {
    throw new TransportError(
      'send-failed',
      `Implausible keyboard definition size from kobu: ${totalSize} bytes`,
    );
  }

  // Step 4: fetch the XZ blob 32 bytes at a time.
  const compressed = new Uint8Array(new ArrayBuffer(totalSize));
  const pageCount = Math.ceil(totalSize / VIAL_PACKET_SIZE);
  for (let page = 0; page < pageCount; page++) {
    const reply = await transport.sendAndReceive(buildGetKeyboardDef(page));
    const start = page * VIAL_PACKET_SIZE;
    const remaining = totalSize - start;
    const chunk = reply.subarray(0, Math.min(VIAL_PACKET_SIZE, remaining));
    compressed.set(chunk, start);
  }

  // Step 5: decompress + parse the embedded JSON.
  const definition = await decompressDefinition(compressed);

  return { viaProtocolVersion, keyboardId, definition, isKobu };
}

/**
 * Decompress an XZ-encoded buffer that holds the firmware's JSON
 * keyboard definition, then parse it as `KeyboardLayoutDef`.
 *
 * `xz-decompress` exposes a streaming API (`XzReadableStream`) that
 * works on `ReadableStream<Uint8Array>`. We wrap the in-memory buffer
 * in a one-chunk stream so we can use the same primitive.
 */
export async function decompressDefinition(compressed: Uint8Array): Promise<KeyboardLayoutDef> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(compressed);
      controller.close();
    },
  });
  const decompressed = new XzReadableStream(source);
  const text = await new Response(decompressed).text();
  return JSON.parse(text) as KeyboardLayoutDef;
}
