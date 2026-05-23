/**
 * Macro editor — the Phase 4.1 deliverable for kobu-config.
 *
 * Layout:
 *
 *   ┌─────────┬─────────────────────────────────────────────┐
 *   │ M0      │ アクション                                    │
 *   │ M1 ●    │ [↑ ↓] Tap   key  [Q]   ×                     │
 *   │ M2      │ [↑ ↓] Delay      [30ms] ×                    │
 *   │ ...     │ ＋ Tap  ＋ 押下  ＋ 離す  ＋ Delay              │
 *   ├─────────┴─────────────────────────────────────────────┤
 *   │ 12 / 256 B   [リセット] [読み直す] [保存]                  │
 *   └────────────────────────────────────────────────────────┘
 *
 * The picker is the same `KeycodePicker` used by the keymap editor;
 * macro `tap/down/up` actions only encode the low byte of the picked
 * keycode (the firmware byte stream is 1 byte per keycode).
 */

import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { KeyboardLayoutDef } from '../protocol/handshake';
import { labelForKeycode } from '../protocol/keycodes';
import type { MacroAction } from '../protocol/macros';
import { selectDirtyMask, selectIsDirty, selectUsedBytes, useMacroStore } from '../state/macros';
import { KeycodePicker } from './KeycodePicker';

export interface MacroEditorProps {
  definition: KeyboardLayoutDef;
  layerCount: number;
}

export function MacroEditor({ definition, layerCount }: MacroEditorProps) {
  const phase = useMacroStore((s) => s.phase);
  const count = useMacroStore((s) => s.count);
  const bufferSize = useMacroStore((s) => s.bufferSize);
  const activeIndex = useMacroStore((s) => s.activeIndex);
  const local = useMacroStore((s) => s.local);
  const setActiveIndex = useMacroStore((s) => s.setActiveIndex);
  const addAction = useMacroStore((s) => s.addAction);
  const updateAction = useMacroStore((s) => s.updateAction);
  const removeAction = useMacroStore((s) => s.removeAction);
  const moveAction = useMacroStore((s) => s.moveAction);
  const resetMacro = useMacroStore((s) => s.resetMacro);
  const save = useMacroStore((s) => s.save);
  const reload = useMacroStore((s) => s.reloadFromDevice);

  // selectDirtyMask returns a fresh array each call; useShallow keeps
  // the React subscription stable across renders.
  const dirtyMask = useMacroStore(useShallow(selectDirtyMask));
  const dirty = useMacroStore(selectIsDirty);
  const used = useMacroStore(selectUsedBytes);

  const [pickerFor, setPickerFor] = useState<{ index: number; position: number } | null>(null);

  if (phase.kind === 'empty' || phase.kind === 'loading') {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">マクロを読み込み中…</p>;
  }

  const current = local[activeIndex] ?? [];
  const usedPct = bufferSize > 0 ? Math.min(100, Math.round((used / bufferSize) * 100)) : 0;
  const saving = phase.kind === 'saving';
  const error = phase.kind === 'error' ? phase.message : null;

  return (
    <section
      aria-labelledby="macro-editor-heading"
      className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden"
    >
      <header className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
        <h3 id="macro-editor-heading" className="text-sm font-medium">
          マクロ
        </h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
          1 つのキーに複数キーの押下シーケンスを割り当てます。キーマップ側で{' '}
          <code className="font-mono text-[11px]">Macro N</code> を選択して呼び出します。
        </p>
      </header>

      <div className="flex flex-col md:flex-row">
        <aside className="md:w-40 border-b md:border-b-0 md:border-r border-zinc-200 dark:border-zinc-800 max-h-72 md:max-h-[26rem] overflow-auto">
          <div className="p-1 flex flex-col" role="tablist" aria-label="マクロ一覧">
            {Array.from({ length: count }, (_, i) => {
              const isActive = i === activeIndex;
              const isDirty = dirtyMask[i] === true;
              const empty = (local[i]?.length ?? 0) === 0;
              return (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: macro slot index *is* the identity here — M0..M31 are stable, slot 0 is always "Macro 0".
                  key={`macro-tab-${i}`}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveIndex(i)}
                  className={[
                    'w-full text-left rounded-md px-3 py-1.5 text-sm flex items-center justify-between',
                    isActive
                      ? 'bg-zinc-900 dark:bg-zinc-100 text-zinc-50 dark:text-zinc-900'
                      : 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
                  ].join(' ')}
                >
                  <span>
                    M{i}
                    {empty && <span className="ml-2 text-xs opacity-60">(空)</span>}
                  </span>
                  {isDirty && (
                    <span
                      title="未保存の変更あり"
                      className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500"
                    />
                  )}
                </button>
              );
            })}
          </div>
        </aside>

        <div className="flex-1 p-4 space-y-3">
          <ActionList
            definition={definition}
            actions={current}
            onReorder={(from, to) => moveAction(activeIndex, from, to)}
            onUpdate={(position, action) => updateAction(activeIndex, position, action)}
            onRemove={(position) => removeAction(activeIndex, position)}
            onPickKey={(position) => setPickerFor({ index: activeIndex, position })}
          />

          <div className="flex flex-wrap gap-2 pt-1">
            <AddActionButton
              label="＋ Tap"
              onClick={() => addAction(activeIndex, { kind: 'tap', keycode: 0x04 })}
            />
            <AddActionButton
              label="＋ 押下"
              onClick={() => addAction(activeIndex, { kind: 'down', keycode: 0x04 })}
            />
            <AddActionButton
              label="＋ 離す"
              onClick={() => addAction(activeIndex, { kind: 'up', keycode: 0x04 })}
            />
            <AddActionButton
              label="＋ Delay"
              onClick={() => addAction(activeIndex, { kind: 'delay', ms: 30 })}
            />
          </div>
        </div>
      </div>

      <footer className="border-t border-zinc-200 dark:border-zinc-800 px-4 py-3 flex flex-wrap items-center gap-3 bg-zinc-50 dark:bg-zinc-900">
        <div className="flex-1 min-w-[10rem]">
          <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
            <span>バッファ使用量</span>
            <span>
              {used} / {bufferSize} B
            </span>
          </div>
          <div className="h-1.5 bg-zinc-200 dark:bg-zinc-800 rounded-full overflow-hidden mt-1">
            <div
              role="progressbar"
              aria-valuenow={used}
              aria-valuemin={0}
              aria-valuemax={bufferSize}
              className={[
                'h-full transition-[width]',
                usedPct >= 95 ? 'bg-rose-500' : usedPct >= 80 ? 'bg-amber-500' : 'bg-emerald-500',
              ].join(' ')}
              style={{ width: `${usedPct}%` }}
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => resetMacro(activeIndex)}
            disabled={saving}
            className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            このマクロを元に戻す
          </button>
          <button
            type="button"
            onClick={() => {
              void reload();
            }}
            disabled={saving}
            className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            読み直す
          </button>
          <button
            type="button"
            onClick={() => {
              void save();
            }}
            disabled={!dirty || saving}
            className="rounded-md bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving
              ? `保存中 ${phase.written}/${phase.total} B…`
              : dirty
                ? 'マクロを保存'
                : '保存済み'}
          </button>
        </div>

        {error && <div className="w-full text-sm text-rose-700 dark:text-rose-400">{error}</div>}
      </footer>

      {pickerFor && (
        <KeycodePicker
          definition={definition}
          layerCount={layerCount}
          current={readKeycode(local[pickerFor.index]?.[pickerFor.position])}
          onPick={(kc) => {
            const seq = local[pickerFor.index];
            const action = seq?.[pickerFor.position];
            if (
              action &&
              (action.kind === 'tap' || action.kind === 'down' || action.kind === 'up')
            ) {
              // Macros encode the low byte of the QMK keycode — the high
              // byte (modifier flags etc.) is silently dropped, matching
              // how the firmware reads the buffer.
              updateAction(pickerFor.index, pickerFor.position, {
                kind: action.kind,
                keycode: kc & 0xff,
              });
            }
            setPickerFor(null);
          }}
          onClose={() => setPickerFor(null)}
        />
      )}
    </section>
  );
}

interface ActionListProps {
  definition: KeyboardLayoutDef;
  actions: MacroAction[];
  onReorder: (from: number, to: number) => void;
  onUpdate: (position: number, action: MacroAction) => void;
  onRemove: (position: number) => void;
  onPickKey: (position: number) => void;
}

function ActionList({
  definition,
  actions,
  onReorder,
  onUpdate,
  onRemove,
  onPickKey,
}: ActionListProps) {
  if (actions.length === 0) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400 italic">
        アクションを追加して開始してください。
      </p>
    );
  }
  return (
    <ol className="space-y-1.5">
      {actions.map((action, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: macro actions have no stable identity — adding synthetic ids would expand the data model; reorder churn is acceptable since rows are mostly stateless (selects + buttons).
          key={i}
          className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-200 dark:border-zinc-800 px-2 py-1.5"
        >
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="上へ"
              onClick={() => onReorder(i, i - 1)}
              disabled={i === 0}
              className="w-6 h-6 rounded text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-30"
            >
              ↑
            </button>
            <button
              type="button"
              aria-label="下へ"
              onClick={() => onReorder(i, i + 1)}
              disabled={i === actions.length - 1}
              className="w-6 h-6 rounded text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-30"
            >
              ↓
            </button>
          </div>

          <ActionRow
            definition={definition}
            action={action}
            onChange={(next) => onUpdate(i, next)}
            onPickKey={() => onPickKey(i)}
          />

          <button
            type="button"
            aria-label="削除"
            onClick={() => onRemove(i)}
            className="ml-auto w-7 h-7 rounded text-zinc-500 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-950 dark:hover:text-rose-300"
          >
            ×
          </button>
        </li>
      ))}
    </ol>
  );
}

interface ActionRowProps {
  definition: KeyboardLayoutDef;
  action: MacroAction;
  onChange: (next: MacroAction) => void;
  onPickKey: () => void;
}

function ActionRow({ definition, action, onChange, onPickKey }: ActionRowProps) {
  switch (action.kind) {
    case 'tap':
    case 'down':
    case 'up': {
      const label = labelForKeycode(action.keycode, { definition });
      return (
        <>
          <select
            aria-label="アクション種別"
            value={action.kind}
            onChange={(e) => {
              const next = e.target.value as 'tap' | 'down' | 'up';
              onChange({ kind: next, keycode: action.keycode });
            }}
            className="rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm px-2 py-1"
          >
            <option value="tap">Tap</option>
            <option value="down">押下</option>
            <option value="up">離す</option>
          </select>
          <button
            type="button"
            onClick={onPickKey}
            className="rounded border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-sm font-mono min-w-[5rem] text-center hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            {label.short || `0x${action.keycode.toString(16).padStart(2, '0')}`}
          </button>
        </>
      );
    }
    case 'delay':
      return (
        <>
          <span className="rounded bg-zinc-100 dark:bg-zinc-800 px-2 py-1 text-sm">Delay</span>
          <label className="flex items-center gap-1 text-sm">
            <input
              type="number"
              min={0}
              max={65025}
              step={10}
              value={action.ms}
              onChange={(e) => {
                const ms = Number(e.target.value);
                if (Number.isFinite(ms)) onChange({ kind: 'delay', ms });
              }}
              className="w-24 rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1"
            />
            <span className="text-zinc-500 dark:text-zinc-400">ms</span>
          </label>
        </>
      );
    case 'text':
      return (
        <>
          <span className="rounded bg-zinc-100 dark:bg-zinc-800 px-2 py-1 text-sm">Text</span>
          <span className="font-mono text-sm">
            {action.byte >= 0x20 && action.byte < 0x7f
              ? `'${String.fromCharCode(action.byte)}'`
              : `0x${action.byte.toString(16).padStart(2, '0')}`}
          </span>
        </>
      );
    case 'unsupported':
      return (
        <>
          <span className="rounded bg-amber-100 dark:bg-amber-900 px-2 py-1 text-sm">未対応</span>
          <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
            {action.bytes.map((b) => `0x${b.toString(16).padStart(2, '0')}`).join(' ')}
          </span>
        </>
      );
  }
}

function AddActionButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-dashed border-zinc-300 dark:border-zinc-700 px-3 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
    >
      {label}
    </button>
  );
}

function readKeycode(action: MacroAction | undefined): number {
  if (!action) return 0;
  if (action.kind === 'tap' || action.kind === 'down' || action.kind === 'up')
    return action.keycode;
  return 0;
}
