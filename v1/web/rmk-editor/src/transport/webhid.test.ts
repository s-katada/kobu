import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emptyPacket,
  intoVialPacket,
  KOBU_PRODUCT_ID,
  KOBU_PRODUCT_IDS,
  KOBU_VENDOR_ID,
  KOBU2_PRODUCT_ID,
  TransportError,
  VIAL_PACKET_SIZE,
  VIAL_USAGE,
  VIAL_USAGE_PAGE,
} from './types';
import {
  buildSmokeTestPacket,
  getPreviouslyAuthorizedKobuDevices,
  isWebHidSupported,
  requestKobuDevice,
  WebHidTransport,
} from './webhid';

interface MockHIDDevice
  extends Pick<
    HIDDevice,
    'opened' | 'vendorId' | 'productId' | 'collections' | 'addEventListener' | 'removeEventListener'
  > {
  open: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  sendReport: ReturnType<typeof vi.fn>;
  emitInputReport(data: Uint8Array<ArrayBuffer>): void;
  _listeners: Map<string, ((event: HIDInputReportEvent) => void)[]>;
}

function createMockDevice(): MockHIDDevice {
  const listeners = new Map<string, ((event: HIDInputReportEvent) => void)[]>();
  let opened = false;
  const device: MockHIDDevice = {
    get opened() {
      return opened;
    },
    vendorId: KOBU_VENDOR_ID,
    productId: KOBU_PRODUCT_ID,
    collections: [
      {
        usagePage: VIAL_USAGE_PAGE,
        usage: VIAL_USAGE,
        inputReports: [],
        outputReports: [],
        featureReports: [],
        children: [],
      },
    ],
    open: vi.fn(async () => {
      opened = true;
    }),
    close: vi.fn(async () => {
      opened = false;
    }),
    sendReport: vi.fn(async () => undefined),
    addEventListener: ((type: string, cb: (event: HIDInputReportEvent) => void) => {
      const bucket = listeners.get(type) ?? [];
      bucket.push(cb);
      listeners.set(type, bucket);
    }) as MockHIDDevice['addEventListener'],
    removeEventListener: ((type: string, cb: (event: HIDInputReportEvent) => void) => {
      const bucket = listeners.get(type);
      if (!bucket) return;
      const idx = bucket.indexOf(cb);
      if (idx >= 0) bucket.splice(idx, 1);
    }) as MockHIDDevice['removeEventListener'],
    emitInputReport(data: Uint8Array<ArrayBuffer>) {
      const bucket = listeners.get('inputreport') ?? [];
      const event = {
        data: new DataView(data.buffer, data.byteOffset, data.byteLength),
      } as unknown as HIDInputReportEvent;
      for (const cb of bucket) cb(event);
    },
    _listeners: listeners,
  };
  return device;
}

function installFakeHid(devices: HIDDevice[], pick: HIDDevice | null) {
  const hid = {
    requestDevice: vi.fn(async (_options?: HIDDeviceRequestOptions) => (pick ? [pick] : [])),
    getDevices: vi.fn(async () => devices),
  };
  (navigator as unknown as { hid: typeof hid }).hid = hid;
  return hid;
}

function clearFakeHid() {
  delete (navigator as { hid?: unknown }).hid;
}

describe('isWebHidSupported', () => {
  afterEach(clearFakeHid);

  it('returns false when navigator.hid is absent', () => {
    expect(isWebHidSupported()).toBe(false);
  });

  it('returns true when navigator.hid is present', () => {
    installFakeHid([], null);
    expect(isWebHidSupported()).toBe(true);
  });
});

describe('requestKobuDevice', () => {
  afterEach(clearFakeHid);

  it('throws TransportError when WebHID is not available', async () => {
    await expect(requestKobuDevice()).rejects.toBeInstanceOf(TransportError);
  });

  it('returns the picked device', async () => {
    const dev = createMockDevice() as unknown as HIDDevice;
    installFakeHid([dev], dev);
    await expect(requestKobuDevice()).resolves.toBe(dev);
  });

  it('returns null when the user cancels the picker', async () => {
    installFakeHid([], null);
    await expect(requestKobuDevice()).resolves.toBeNull();
  });

  it('asks the picker for every kobu generation (v1 + kobu2)', async () => {
    const hid = installFakeHid([], null);
    await requestKobuDevice();
    expect(hid.requestDevice).toHaveBeenCalledWith({
      filters: KOBU_PRODUCT_IDS.map((productId) => ({
        vendorId: KOBU_VENDOR_ID,
        productId,
        usagePage: VIAL_USAGE_PAGE,
        usage: VIAL_USAGE,
      })),
    });
  });
});

describe('getPreviouslyAuthorizedKobuDevices', () => {
  afterEach(clearFakeHid);

  it('filters out non-kobu devices', async () => {
    const kobu = createMockDevice() as unknown as HIDDevice;
    const notKobu = {
      ...createMockDevice(),
      vendorId: 0x1234,
      productId: 0x5678,
    } as unknown as HIDDevice;
    installFakeHid([kobu, notKobu], null);
    const got = await getPreviouslyAuthorizedKobuDevices();
    expect(got).toEqual([kobu]);
  });

  it('accepts a kobu2 (v2 product id) device', async () => {
    const kobu2 = {
      ...createMockDevice(),
      productId: KOBU2_PRODUCT_ID,
    } as unknown as HIDDevice;
    installFakeHid([kobu2], null);
    await expect(getPreviouslyAuthorizedKobuDevices()).resolves.toEqual([kobu2]);
  });

  it('returns an empty list when WebHID is not available', async () => {
    await expect(getPreviouslyAuthorizedKobuDevices()).resolves.toEqual([]);
  });
});

describe('WebHidTransport', () => {
  let device: MockHIDDevice;

  beforeEach(() => {
    device = createMockDevice();
  });

  it('opens the device if not already opened', async () => {
    const transport = await WebHidTransport.open(device as unknown as HIDDevice);
    expect(device.open).toHaveBeenCalledOnce();
    await transport.close();
  });

  it('round-trips a packet via sendAndReceive', async () => {
    const transport = await WebHidTransport.open(device as unknown as HIDDevice);
    const out = buildSmokeTestPacket();
    const reply = new Uint8Array(new ArrayBuffer(VIAL_PACKET_SIZE));
    reply[0] = 0x01;
    reply[1] = 0x00;
    reply[2] = 0x09;

    const pending = transport.sendAndReceive(out);
    // Simulate kobu echoing back after the send completes.
    await Promise.resolve();
    device.emitInputReport(reply);

    const got = await pending;
    expect(got[0]).toBe(0x01);
    expect(got[2]).toBe(0x09);
    expect(device.sendReport).toHaveBeenCalledWith(0, out);
    await transport.close();
  });

  it('rejects a second sendAndReceive while one is in flight', async () => {
    const transport = await WebHidTransport.open(device as unknown as HIDDevice);
    const first = transport.sendAndReceive(buildSmokeTestPacket());
    await expect(transport.sendAndReceive(buildSmokeTestPacket())).rejects.toMatchObject({
      kind: 'concurrent-request',
    });
    device.emitInputReport(intoVialPacket(new Uint8Array(new ArrayBuffer(VIAL_PACKET_SIZE))));
    await first;
    await transport.close();
  });

  it('times out when no reply arrives', async () => {
    vi.useFakeTimers();
    try {
      const transport = await WebHidTransport.open(device as unknown as HIDDevice, {
        receiveTimeoutMs: 100,
      });
      const promise = transport.sendAndReceive(buildSmokeTestPacket());
      // Attach the rejection assertion before advancing timers so vitest does
      // not flag the rejection as unhandled in the brief window between fire
      // and the assertion catching it.
      const assertion = expect(promise).rejects.toMatchObject({ kind: 'receive-timeout' });
      await vi.advanceTimersByTimeAsync(150);
      await assertion;
      await transport.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects sendAndReceive after close()', async () => {
    const transport = await WebHidTransport.open(device as unknown as HIDDevice);
    await transport.close();
    await expect(transport.sendAndReceive(buildSmokeTestPacket())).rejects.toMatchObject({
      kind: 'disconnected',
    });
  });
});

describe('emptyPacket / intoVialPacket', () => {
  it('emptyPacket allocates exactly VIAL_PACKET_SIZE bytes', () => {
    const p = emptyPacket();
    expect(p.length).toBe(VIAL_PACKET_SIZE);
    expect(p.every((b) => b === 0)).toBe(true);
  });

  it('intoVialPacket rejects wrong sizes', () => {
    expect(() => intoVialPacket(new Uint8Array(new ArrayBuffer(16)))).toThrow(TransportError);
  });
});
