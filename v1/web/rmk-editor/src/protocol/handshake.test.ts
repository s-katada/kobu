import { beforeEach, describe, expect, it, vi } from 'vitest';
import { intoVialPacket, TransportError, type VialPacket } from '../transport/types';
import type { WebHidTransport } from '../transport/webhid';

// Identity-transform the XZ stream so tests can use plain UTF-8 JSON
// for the "compressed" definition. Mocked module-wide so all callers in
// this test file see the identity behaviour.
// Identity-substitute the XZ stream: callers do `new XzReadableStream(source)`
// and then `new Response(stream).text()`, so returning the underlying source is
// enough — we just need a constructable that satisfies the call site.
function IdentityXzStream(this: unknown, source: ReadableStream<Uint8Array>) {
  return source;
}
vi.mock('xz-decompress', () => ({
  XzReadableStream: IdentityXzStream as unknown as typeof globalThis.ReadableStream,
}));

// Importing AFTER the mock declaration so vitest hoists the mock first.
import { KOBU_KEYBOARD_UID, performHandshake, uidEquals } from './handshake';

const KOBU_UID = new Uint8Array(KOBU_KEYBOARD_UID);
const OTHER_UID = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

interface FakeOptions {
  uid?: Uint8Array;
  /** Total definition size in bytes (must match payload length). */
  defText?: string;
  /** Override the size reply (e.g. to test the size-validation path). */
  sizeOverride?: number;
}

class FakeTransport {
  uid: Uint8Array;
  defBytes: Uint8Array;
  sizeOverride: number | null;
  /** Records every command (first byte) actually sent. */
  sent: number[] = [];

  constructor(opts: FakeOptions = {}) {
    this.uid = opts.uid ?? KOBU_UID;
    this.defBytes = new TextEncoder().encode(
      opts.defText ??
        JSON.stringify({ name: 'kobu', matrix: { rows: 4, cols: 10 }, layouts: { keymap: [] } }),
    );
    this.sizeOverride = opts.sizeOverride ?? null;
  }

  async sendAndReceive(packet: VialPacket): Promise<VialPacket> {
    const cmd = packet[0];
    const sub = packet[1];
    this.sent.push(cmd ?? 0);
    const reply = new Uint8Array(new ArrayBuffer(32));

    if (cmd === 0x01) {
      // GetProtocolVersion — return BE u16 = 0x0009
      reply[1] = 0x00;
      reply[2] = 0x09;
    } else if (cmd === 0xfe && sub === 0x00) {
      // Vial GetKeyboardId
      // reply[0..4] = vial protocol version (LE u32) = 1
      reply[0] = 0x01;
      // reply[4..12] = uid (8 bytes)
      reply.set(this.uid, 4);
      // reply[12] = feature flags
      reply[12] = 0x00;
    } else if (cmd === 0xfe && sub === 0x01) {
      // GetSize — LE u32 of defBytes.length
      const size = this.sizeOverride ?? this.defBytes.length;
      reply[0] = size & 0xff;
      reply[1] = (size >> 8) & 0xff;
      reply[2] = (size >> 16) & 0xff;
      reply[3] = (size >> 24) & 0xff;
    } else if (cmd === 0xfe && sub === 0x02) {
      // GetKeyboardDef page N
      const pageIndex = (packet[2] ?? 0) | ((packet[3] ?? 0) << 8);
      const start = pageIndex * 32;
      const chunk = this.defBytes.subarray(start, Math.min(start + 32, this.defBytes.length));
      reply.set(chunk, 0);
    }

    return intoVialPacket(reply);
  }
}

function fake(opts: FakeOptions = {}): { t: WebHidTransport; raw: FakeTransport } {
  const raw = new FakeTransport(opts);
  return { t: raw as unknown as WebHidTransport, raw };
}

describe('uidEquals', () => {
  it('returns true for byte-identical arrays', () => {
    expect(uidEquals(KOBU_UID, KOBU_UID)).toBe(true);
    expect(uidEquals(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
  });

  it('returns false for different content', () => {
    expect(uidEquals(KOBU_UID, OTHER_UID)).toBe(false);
  });

  it('returns false for different lengths', () => {
    expect(uidEquals(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe('performHandshake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('completes the four-step dance against a kobu', async () => {
    const { t, raw } = fake();
    const result = await performHandshake(t);
    expect(result.viaProtocolVersion).toBe(0x0009);
    expect(result.isKobu).toBe(true);
    expect(result.definition.name).toBe('kobu');
    expect(result.definition.matrix).toEqual({ rows: 4, cols: 10 });
    // GetProtocolVersion (0x01) + GetKeyboardId (0xfe) + GetSize (0xfe) + N × GetKeyboardDef (0xfe)
    expect(raw.sent[0]).toBe(0x01);
    expect(raw.sent.slice(1)).toEqual(Array(raw.sent.length - 1).fill(0xfe));
  });

  it('marks isKobu false when the UID does not match KOBU_KEYBOARD_UID', async () => {
    const { t } = fake({ uid: OTHER_UID });
    const result = await performHandshake(t);
    expect(result.isKobu).toBe(false);
    expect(Array.from(result.keyboardId.uid)).toEqual(Array.from(OTHER_UID));
  });

  it('rejects a zero-byte definition size', async () => {
    const { t } = fake({ sizeOverride: 0 });
    await expect(performHandshake(t)).rejects.toBeInstanceOf(TransportError);
  });

  it('rejects an implausibly large definition size', async () => {
    const { t } = fake({ sizeOverride: 70 * 1024 });
    await expect(performHandshake(t)).rejects.toBeInstanceOf(TransportError);
  });

  it('reassembles a multi-page definition', async () => {
    const big = JSON.stringify({
      name: 'kobu-multipage',
      matrix: { rows: 4, cols: 10 },
      customKeycodes: Array.from({ length: 8 }, (_, i) => ({
        name: `U${i}`,
        title: `User ${i}`,
        shortName: `U${i}`,
      })),
      layouts: { keymap: Array.from({ length: 4 }, () => ['x', 'y', 'z']) },
    });
    expect(big.length).toBeGreaterThan(32 * 3); // forces ≥4 pages
    const { t, raw } = fake({ defText: big });
    const result = await performHandshake(t);
    expect(result.definition.name).toBe('kobu-multipage');
    expect(result.definition.customKeycodes).toHaveLength(8);
    // Number of GetKeyboardDef calls = ceil(size / 32)
    const expectedPages = Math.ceil(big.length / 32);
    const getDefCalls = raw.sent.filter((c, i) => i >= 3 && c === 0xfe).length;
    expect(getDefCalls).toBe(expectedPages);
  });
});
