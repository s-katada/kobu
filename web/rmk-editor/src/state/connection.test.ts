import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCachedDefinition } from '../protocol/cache';
import type { HandshakeResult } from '../protocol/handshake';
import { KOBU_PRODUCT_ID, KOBU_VENDOR_ID, VIAL_USAGE, VIAL_USAGE_PAGE } from '../transport/types';

// Intercept the real handshake before importing the store so the store
// picks up our mocked version. The real handshake needs a working WASM
// XZ decoder + a 32-byte chunked round-trip choreography — way out of
// scope for a state-machine test.
const mockPerformHandshake = vi.fn();
vi.mock('../protocol/handshake', async () => {
  const actual =
    await vi.importActual<typeof import('../protocol/handshake')>('../protocol/handshake');
  return {
    ...actual,
    performHandshake: (transport: unknown) => mockPerformHandshake(transport),
  };
});

// Imported AFTER vi.mock so the store sees the mocked module.
const { useConnectionStore } = await import('./connection');

interface FakeHid {
  requestDevice: ReturnType<typeof vi.fn>;
  getDevices: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

function createFakeHid(): FakeHid {
  return {
    requestDevice: vi.fn(async () => []),
    getDevices: vi.fn(async () => []),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

function createMockDevice(productName = 'kobu'): HIDDevice {
  return {
    opened: false,
    vendorId: KOBU_VENDOR_ID,
    productId: KOBU_PRODUCT_ID,
    productName,
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
    open: vi.fn(async function (this: { opened: boolean }) {
      this.opened = true;
    }),
    close: vi.fn(async function (this: { opened: boolean }) {
      this.opened = false;
    }),
    forget: vi.fn(async () => undefined),
    sendReport: vi.fn(async () => undefined),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as HIDDevice;
}

const KOBU_UID = new Uint8Array([0xb9, 0xbc, 0x09, 0xb2, 0x9d, 0x37, 0x4c, 0xea]);

function fakeHandshakeResult(overrides: Partial<HandshakeResult> = {}): HandshakeResult {
  return {
    viaProtocolVersion: 0x0009,
    keyboardId: {
      vialProtocolVersion: 6,
      uid: KOBU_UID,
      featureFlags: 0,
    },
    definition: {
      matrix: { rows: 4, cols: 10 },
      layouts: { keymap: [[], [], [], []] },
    },
    isKobu: true,
    ...overrides,
  };
}

function resetStoreToIdle() {
  useConnectionStore.setState({ state: { kind: 'idle' } });
}

describe('useConnectionStore', () => {
  let fakeHid: FakeHid;

  beforeEach(() => {
    fakeHid = createFakeHid();
    (navigator as unknown as { hid: FakeHid }).hid = fakeHid;
    mockPerformHandshake.mockReset();
    clearCachedDefinition();
    resetStoreToIdle();
  });

  afterEach(() => {
    delete (navigator as { hid?: unknown }).hid;
    clearCachedDefinition();
  });

  it('promptConnect transitions idle → connecting → ready on happy path', async () => {
    const device = createMockDevice('kobu');
    fakeHid.requestDevice.mockResolvedValueOnce([device]);
    mockPerformHandshake.mockResolvedValueOnce(fakeHandshakeResult());

    await useConnectionStore.getState().promptConnect();

    const state = useConnectionStore.getState().state;
    expect(state.kind).toBe('ready');
    if (state.kind === 'ready') {
      expect(state.deviceName).toBe('kobu');
      expect(state.handshake.viaProtocolVersion).toBe(0x0009);
      expect(state.definitionFromCache).toBe(false);
    }
  });

  it('promptConnect goes to wrong-device when UID does not match kobu', async () => {
    const device = createMockDevice();
    fakeHid.requestDevice.mockResolvedValueOnce([device]);
    mockPerformHandshake.mockResolvedValueOnce(
      fakeHandshakeResult({
        isKobu: false,
        keyboardId: {
          vialProtocolVersion: 6,
          uid: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]),
          featureFlags: 0,
        },
      }),
    );

    await useConnectionStore.getState().promptConnect();

    const state = useConnectionStore.getState().state;
    expect(state.kind).toBe('wrong-device');
    if (state.kind === 'wrong-device') expect(state.uidHex).toBe('0000000000000000');
  });

  it('promptConnect returns to idle when user cancels picker', async () => {
    fakeHid.requestDevice.mockResolvedValueOnce([]);
    await useConnectionStore.getState().promptConnect();
    expect(useConnectionStore.getState().state.kind).toBe('idle');
  });

  it('promptConnect goes to error state with errorKind when open fails', async () => {
    const device = createMockDevice();
    (device.open as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Access denied'));
    fakeHid.requestDevice.mockResolvedValueOnce([device]);

    await useConnectionStore.getState().promptConnect();

    const state = useConnectionStore.getState().state;
    expect(state.kind).toBe('error');
    if (state.kind === 'error') {
      expect(state.errorKind).toBe('open-failed');
    }
  });

  it('clearError returns the store to idle', () => {
    useConnectionStore.setState({
      state: { kind: 'error', message: 'x', errorKind: 'unknown' },
    });
    useConnectionStore.getState().clearError();
    expect(useConnectionStore.getState().state.kind).toBe('idle');
  });

  it('disconnect closes the transport, forgets the device, and returns to idle', async () => {
    const device = createMockDevice();
    fakeHid.requestDevice.mockResolvedValueOnce([device]);
    mockPerformHandshake.mockResolvedValueOnce(fakeHandshakeResult());
    await useConnectionStore.getState().promptConnect();
    expect(useConnectionStore.getState().state.kind).toBe('ready');

    await useConnectionStore.getState().disconnect();
    expect(useConnectionStore.getState().state.kind).toBe('idle');
    expect(device.close).toHaveBeenCalled();
    expect(device.forget).toHaveBeenCalled();
  });

  it('disconnect still succeeds even if forget() throws', async () => {
    const device = createMockDevice();
    (device.forget as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('forget not supported'),
    );
    fakeHid.requestDevice.mockResolvedValueOnce([device]);
    mockPerformHandshake.mockResolvedValueOnce(fakeHandshakeResult());
    await useConnectionStore.getState().promptConnect();

    await useConnectionStore.getState().disconnect();
    expect(useConnectionStore.getState().state.kind).toBe('idle');
  });

  it('cached definition is auto-replaced when fresh handshake differs (firmware re-flash with new vial.json)', async () => {
    // 1st connect saves a definition to the cache.
    const device = createMockDevice();
    fakeHid.requestDevice.mockResolvedValueOnce([device]);
    mockPerformHandshake.mockResolvedValueOnce(fakeHandshakeResult());
    await useConnectionStore.getState().promptConnect();
    await useConnectionStore.getState().disconnect();

    // 2nd connect — handshake returns a DIFFERENT definition (e.g. an
    // updated vial.json embedded in newly-flashed firmware). The
    // connectTo helper must prefer the fresh definition and update
    // the cache, otherwise the user sees the stale layout indefinitely.
    fakeHid.requestDevice.mockResolvedValueOnce([device]);
    mockPerformHandshake.mockResolvedValueOnce(
      fakeHandshakeResult({
        definition: {
          matrix: { rows: 4, cols: 10 },
          layouts: { keymap: [['changed,0']] },
        },
      }),
    );
    await useConnectionStore.getState().promptConnect();

    const state = useConnectionStore.getState().state;
    expect(state.kind).toBe('ready');
    if (state.kind === 'ready') {
      expect(state.definitionFromCache).toBe(false);
      expect(state.handshake.definition.layouts.keymap).toEqual([['changed,0']]);
    }
  });

  it('second connect uses the cached definition', async () => {
    const device = createMockDevice();
    fakeHid.requestDevice.mockResolvedValueOnce([device]);
    mockPerformHandshake.mockResolvedValueOnce(fakeHandshakeResult());

    await useConnectionStore.getState().promptConnect();
    expect(useConnectionStore.getState().state.kind).toBe('ready');
    await useConnectionStore.getState().disconnect();

    // Second connect — handshake runs again but cache wins for definition.
    fakeHid.requestDevice.mockResolvedValueOnce([device]);
    mockPerformHandshake.mockResolvedValueOnce(fakeHandshakeResult());
    await useConnectionStore.getState().promptConnect();

    const state = useConnectionStore.getState().state;
    expect(state.kind).toBe('ready');
    if (state.kind === 'ready') expect(state.definitionFromCache).toBe(true);
  });

  it('promptConnect surfaces a TransportError kind on persistent handshake send-failed', async () => {
    const device = createMockDevice();
    fakeHid.requestDevice.mockResolvedValueOnce([device]);
    const { TransportError } = await import('../transport/types');
    // send-failed is transient — the store retries up to 3 times. Use
    // a persistent rejection so every retry fails and the kind bubbles
    // through to the error state.
    mockPerformHandshake.mockRejectedValue(
      new TransportError('send-failed', 'simulated send failure'),
    );

    await useConnectionStore.getState().promptConnect();

    const state = useConnectionStore.getState().state;
    expect(state.kind).toBe('error');
    if (state.kind === 'error') {
      expect(state.errorKind).toBe('send-failed');
      expect(state.message).toContain('simulated send failure');
    }
  });

  it('promptConnect surfaces unknown-kind error when handshake throws a non-TransportError', async () => {
    const device = createMockDevice();
    fakeHid.requestDevice.mockResolvedValueOnce([device]);
    mockPerformHandshake.mockRejectedValueOnce(new TypeError('boom'));

    await useConnectionStore.getState().promptConnect();

    const state = useConnectionStore.getState().state;
    expect(state.kind).toBe('error');
    if (state.kind === 'error') {
      expect(state.errorKind).toBe('unknown');
    }
  });

  it('promptConnect retries the handshake on a transient receive-timeout and succeeds on the second attempt', async () => {
    const device = createMockDevice();
    fakeHid.requestDevice.mockResolvedValueOnce([device]);
    const { TransportError } = await import('../transport/types');
    // First attempt: simulate the dropped-first-packet failure mode.
    mockPerformHandshake.mockRejectedValueOnce(
      new TransportError('receive-timeout', 'kobu did not reply within timeout'),
    );
    // Second attempt: succeeds.
    mockPerformHandshake.mockResolvedValueOnce(fakeHandshakeResult());

    await useConnectionStore.getState().promptConnect();

    expect(mockPerformHandshake).toHaveBeenCalledTimes(2);
    expect(useConnectionStore.getState().state.kind).toBe('ready');
  });

  it('promptConnect retries up to 3 times, then surfaces the final transient error', async () => {
    const device = createMockDevice();
    fakeHid.requestDevice.mockResolvedValueOnce([device]);
    const { TransportError } = await import('../transport/types');
    mockPerformHandshake.mockRejectedValue(new TransportError('receive-timeout', 'flaky'));

    await useConnectionStore.getState().promptConnect();

    expect(mockPerformHandshake).toHaveBeenCalledTimes(3);
    const state = useConnectionStore.getState().state;
    expect(state.kind).toBe('error');
    if (state.kind === 'error') {
      expect(state.errorKind).toBe('receive-timeout');
    }
  });

  it('promptConnect does not retry on non-transient errors (open-failed surfaces immediately)', async () => {
    const device = createMockDevice();
    (device.open as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Access denied'));
    fakeHid.requestDevice.mockResolvedValueOnce([device]);

    await useConnectionStore.getState().promptConnect();

    // open-failed bubbles out of the very first attempt — the
    // handshake is never even called.
    expect(mockPerformHandshake).not.toHaveBeenCalled();
    const state = useConnectionStore.getState().state;
    expect(state.kind).toBe('error');
    if (state.kind === 'error') {
      expect(state.errorKind).toBe('open-failed');
    }
  });

  it('promptConnect retries on transient send-failed', async () => {
    const device = createMockDevice();
    fakeHid.requestDevice.mockResolvedValueOnce([device]);
    const { TransportError } = await import('../transport/types');
    mockPerformHandshake.mockRejectedValueOnce(
      new TransportError('send-failed', 'transient send error'),
    );
    mockPerformHandshake.mockResolvedValueOnce(fakeHandshakeResult());

    await useConnectionStore.getState().promptConnect();

    expect(mockPerformHandshake).toHaveBeenCalledTimes(2);
    expect(useConnectionStore.getState().state.kind).toBe('ready');
  });

  it('promptConnect is a no-op when the store is already connecting', async () => {
    useConnectionStore.setState({ state: { kind: 'connecting' } });
    await useConnectionStore.getState().promptConnect();
    expect(fakeHid.requestDevice).not.toHaveBeenCalled();
    expect(useConnectionStore.getState().state.kind).toBe('connecting');
  });

  it('clearError does nothing when the store is not in an error state', () => {
    useConnectionStore.setState({ state: { kind: 'connecting' } });
    useConnectionStore.getState().clearError();
    expect(useConnectionStore.getState().state.kind).toBe('connecting');
  });

  it('disconnect is a no-op when not connected', async () => {
    useConnectionStore.setState({ state: { kind: 'idle' } });
    await useConnectionStore.getState().disconnect();
    expect(useConnectionStore.getState().state.kind).toBe('idle');
  });

  it('trySilentReconnect picks up a previously-authorised device without prompting', async () => {
    const device = createMockDevice();
    fakeHid.getDevices.mockResolvedValueOnce([device]);
    mockPerformHandshake.mockResolvedValueOnce(fakeHandshakeResult());

    await useConnectionStore.getState().trySilentReconnect();
    expect(useConnectionStore.getState().state.kind).toBe('ready');
    expect(fakeHid.requestDevice).not.toHaveBeenCalled();
  });

  it('trySilentReconnect is a no-op when there are no previously-authorised devices', async () => {
    fakeHid.getDevices.mockResolvedValueOnce([]);
    await useConnectionStore.getState().trySilentReconnect();
    expect(useConnectionStore.getState().state.kind).toBe('idle');
  });

  it('trySilentReconnect is a no-op when the store is not in idle state', async () => {
    useConnectionStore.setState({ state: { kind: 'connecting' } });
    await useConnectionStore.getState().trySilentReconnect();
    expect(fakeHid.getDevices).not.toHaveBeenCalled();
  });

  it('wrong-device disconnect closes the transport and returns to idle', async () => {
    const device = createMockDevice();
    fakeHid.requestDevice.mockResolvedValueOnce([device]);
    mockPerformHandshake.mockResolvedValueOnce(
      fakeHandshakeResult({
        isKobu: false,
        keyboardId: {
          vialProtocolVersion: 6,
          uid: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]),
          featureFlags: 0,
        },
      }),
    );
    await useConnectionStore.getState().promptConnect();
    expect(useConnectionStore.getState().state.kind).toBe('wrong-device');

    await useConnectionStore.getState().disconnect();
    expect(useConnectionStore.getState().state.kind).toBe('idle');
    expect(device.close).toHaveBeenCalled();
  });
});
