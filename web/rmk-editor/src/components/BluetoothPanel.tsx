/**
 * Layer 3 / Bluetooth-aware panel.
 *
 * kobu's Layer 3 is, by firmware convention, the BLE control layer:
 *   User0..User3  pick BT profile 0..3
 *   User4         next BT
 *   User5         previous BT
 *   User6         clear bond of current profile
 *   User7         switch default output mode (USB ⇄ BLE)
 *
 * Until Phase 6 lands the matching Custom Vial commands in firmware,
 * the editor can only **show** what is mapped where and **explain**
 * each control — it cannot trigger the actions from the web (the
 * keycodes only fire when a physical switch is pressed). The panel
 * makes that limitation explicit instead of pretending otherwise.
 */

import type { KeyboardLayoutDef } from '../protocol/handshake';
import { decodeKeycode, USER_BASE } from '../protocol/keycodes';
import type { EditPosition } from '../state/editor';

export interface BluetoothPanelProps {
  definition: KeyboardLayoutDef;
  /** Layer 3 keymap slice — `[row][col]` of u16 keycodes. */
  layer3: number[][];
  /** Echoes selection out to the editor so clicking a card highlights the SVG cell. */
  onSelectCell: (position: EditPosition) => void;
}

interface UserSlotLocation {
  userIndex: number;
  row: number;
  col: number;
}

function findUserSlots(layer3: number[][]): UserSlotLocation[] {
  const out: UserSlotLocation[] = [];
  for (let row = 0; row < layer3.length; row++) {
    const cols = layer3[row];
    if (!cols) continue;
    for (let col = 0; col < cols.length; col++) {
      const decoded = decodeKeycode(cols[col] ?? 0);
      if (decoded.kind === 'user') {
        out.push({ userIndex: decoded.index, row, col });
      }
    }
  }
  return out;
}

export function BluetoothPanel({ definition, layer3, onSelectCell }: BluetoothPanelProps) {
  const slots = findUserSlots(layer3);
  const custom = definition.customKeycodes ?? [];

  function locationFor(userIndex: number): UserSlotLocation | undefined {
    return slots.find((s) => s.userIndex === userIndex);
  }

  function describe(userIndex: number): { title: string; body: string } {
    const meta = custom[userIndex];
    if (!meta) {
      return {
        title: `User${userIndex}`,
        body: 'このスロットには customKeycode 情報がありません。',
      };
    }
    return { title: meta.shortName.replace(/\n/g, ' '), body: meta.title };
  }

  return (
    <section
      aria-labelledby="bt-panel-heading"
      className="rounded-md border border-zinc-200 dark:border-zinc-800 p-4 space-y-4"
    >
      <header className="space-y-1">
        <h3 id="bt-panel-heading" className="text-sm font-semibold">
          Bluetooth コントロール（レイヤー 3）
        </h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          kobu の User キーコードは、物理キーを実際に押すことでしか発火しません。Web
          からの直接操作は、 ファームウェアに対応する Custom Vial
          コマンドが実装され次第サポートされます（issue #39）。
        </p>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {[0, 1, 2, 3].map((profile) => (
          <ProfileCard
            key={profile}
            profile={profile}
            location={locationFor(profile)}
            description={describe(profile)}
            onSelectCell={onSelectCell}
          />
        ))}
        {[4, 5, 6, 7].map((userIdx) => {
          const loc = locationFor(userIdx);
          const desc = describe(userIdx);
          return (
            <BleControlCard
              key={userIdx}
              userIdx={userIdx}
              code={USER_BASE + userIdx}
              location={loc}
              description={desc}
              onSelectCell={onSelectCell}
            />
          );
        })}
      </div>
    </section>
  );
}

interface ProfileCardProps {
  profile: number;
  location: UserSlotLocation | undefined;
  description: { title: string; body: string };
  onSelectCell: (position: EditPosition) => void;
}

function ProfileCard({ profile, location, description, onSelectCell }: ProfileCardProps) {
  const mapped = location !== undefined;
  return (
    <article className="rounded-md border border-zinc-200 dark:border-zinc-800 p-3 bg-white dark:bg-zinc-900">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">BLE プロファイル {profile}</h4>
        <span
          className={[
            'text-[10px] uppercase tracking-wide font-medium',
            mapped ? 'text-emerald-700 dark:text-emerald-400' : 'text-zinc-400',
          ].join(' ')}
        >
          {mapped ? '割当あり' : '未割当'}
        </span>
      </div>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">{description.body}</p>
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        キーコード: <span className="font-mono">User{profile}</span> ・ ラベル:{' '}
        <span className="font-mono">{description.title}</span>
      </p>
      {location && (
        <button
          type="button"
          onClick={() => onSelectCell({ layer: 3, row: location.row, col: location.col })}
          className="mt-2 rounded border border-zinc-300 dark:border-zinc-700 px-2 py-0.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          キーマップで位置を表示 ({location.row},{location.col})
        </button>
      )}
    </article>
  );
}

interface BleControlCardProps {
  userIdx: number;
  code: number;
  location: UserSlotLocation | undefined;
  description: { title: string; body: string };
  onSelectCell: (position: EditPosition) => void;
}

function BleControlCard({
  userIdx,
  code,
  location,
  description,
  onSelectCell,
}: BleControlCardProps) {
  return (
    <article className="rounded-md border border-zinc-200 dark:border-zinc-800 p-3 bg-white dark:bg-zinc-900">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">{description.title}</h4>
        <span className="text-[10px] uppercase tracking-wide font-medium text-zinc-400">
          User{userIdx}
        </span>
      </div>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">{description.body}</p>
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
        キーコード: 0x{code.toString(16).padStart(4, '0')}
      </p>
      {location ? (
        <button
          type="button"
          onClick={() => onSelectCell({ layer: 3, row: location.row, col: location.col })}
          className="mt-2 rounded border border-zinc-300 dark:border-zinc-700 px-2 py-0.5 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          キーマップで位置を表示 ({location.row},{location.col})
        </button>
      ) : (
        <p className="mt-2 text-[11px] text-zinc-400 italic">レイヤー 3 には未割当</p>
      )}
    </article>
  );
}
