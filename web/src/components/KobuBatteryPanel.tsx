/**
 * Read-only kobu battery status panel — surfaces central and peripheral
 * LiPo percentages from the patched RMK Vial Custom Channel 0xC0.
 *
 * macOS Bluetooth menu cannot display kobu's left and right batteries
 * separately (every dual-BAS experiment in the 2026-05-25 session caused
 * macOS to drop the entire battery display), so the kobu-config web UI
 * is the canonical place to see both halves. Firmware-side wiring:
 *
 *   * `firmware/src/battery_source.rs` taps every `Event::Battery`
 *     before the upstream `BatteryProcessor` runs, decodes the LiPo
 *     percentage and stores it in
 *     `rmk::input_device::battery::KOBU_*_BATTERY_PERCENT` (atomics
 *     injected by `firmware/build.rs::patch_rmk_battery_kobu_atomics`).
 *   * `firmware/build.rs::patch_rmk_via_custom_get_kobu` rewrites the
 *     `ViaCommand::CustomGetValue` stub so channel `0xC0` ids `0x10`
 *     (central) and `0x11` (peripheral) return the matching atomic.
 *
 * This panel polls those two ids every `POLL_MS` while the keyboard is
 * attached so the user can watch the percentages change as either half
 * charges or discharges. There's no setter — battery percent is
 * read-only by definition.
 */

import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { getKobuValue, KOBU_VALUES } from '../protocol/customValue';
import { useKobuSettingsStore } from '../state/kobuSettings';
import type { WebHidTransport } from '../transport/webhid';

const POLL_MS = 5_000;

const CENTRAL_DEF = KOBU_VALUES.find((v) => v.key === 'central_battery_percent');
const PERIPHERAL_DEF = KOBU_VALUES.find((v) => v.key === 'peripheral_battery_percent');

interface BatteryReading {
  central: number | null;
  peripheral: number | null;
}

async function readBattery(transport: WebHidTransport): Promise<BatteryReading> {
  // Run sequentially so the WebHID transport doesn't see overlapping
  // request/reply round-trips — kobu's underlying RawHID endpoint isn't
  // pipelined.
  const central = CENTRAL_DEF ? await getKobuValue(transport, CENTRAL_DEF) : null;
  const peripheral = PERIPHERAL_DEF ? await getKobuValue(transport, PERIPHERAL_DEF) : null;
  return { central, peripheral };
}

function batteryColor(percent: number | null): string {
  if (percent === null) return 'text-zinc-500';
  if (percent >= 60) return 'text-emerald-600 dark:text-emerald-400';
  if (percent >= 20) return 'text-amber-600 dark:text-amber-400';
  return 'text-rose-600 dark:text-rose-400';
}

function formatPercent(value: number | null): string {
  if (value === null) return '—';
  return `${value}%`;
}

export function KobuBatteryPanel() {
  const transport = useKobuSettingsStore(useShallow((s) => s.transport));
  const phase = useKobuSettingsStore((s) => s.phase);
  const [reading, setReading] = useState<BatteryReading>({ central: null, peripheral: null });
  const [error, setError] = useState<string | null>(null);
  const ready = phase.kind === 'ready' && transport !== null;

  useEffect(() => {
    if (!ready || transport === null) {
      setReading({ central: null, peripheral: null });
      setError(null);
      return;
    }
    let cancelled = false;

    const tick = async () => {
      try {
        const next = await readBattery(transport);
        if (cancelled) return;
        setReading(next);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(String(err));
      }
    };

    void tick();
    const handle = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [ready, transport]);

  if (!ready) {
    return null;
  }

  return (
    <section
      aria-labelledby="kobu-battery-heading"
      className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden"
    >
      <header className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
        <h3 id="kobu-battery-heading" className="text-sm font-medium">
          バッテリー
        </h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
          左右の XIAO の LiPo 残量。{POLL_MS / 1000} 秒ごとに更新。
        </p>
      </header>

      <div className="grid grid-cols-2 gap-4 p-4">
        <div className="flex flex-col items-center gap-1">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">左 (central)</span>
          <span
            data-testid="kobu-battery-central"
            className={`text-2xl font-semibold ${batteryColor(reading.central)}`}
          >
            {formatPercent(reading.central)}
          </span>
        </div>
        <div className="flex flex-col items-center gap-1">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">右 (peripheral)</span>
          <span
            data-testid="kobu-battery-peripheral"
            className={`text-2xl font-semibold ${batteryColor(reading.peripheral)}`}
          >
            {formatPercent(reading.peripheral)}
          </span>
        </div>
      </div>

      {error !== null && (
        <p className="px-4 pb-3 text-xs text-rose-600 dark:text-rose-400">
          バッテリー値の取得に失敗しました: {error}
        </p>
      )}
    </section>
  );
}
