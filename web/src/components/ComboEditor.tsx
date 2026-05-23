/**
 * Combo editor — Phase 4.2 deliverable.
 *
 * One row per combo slot (kobu = 16). Each row shows 4 input keycode
 * slots + 1 output keycode + clear/reset controls. All keycode buttons
 * open the shared `KeycodePicker`; the same encoding used by the
 * keymap and macro editors flows through unchanged.
 *
 *   ┌────┬──────────┬──────────┬──────────┬──────────┬──┬──────────┬───┐
 *   │ #0 │ Q        │ W        │ —        │ —        │→ │ Esc      │ × │
 *   │ #1 │ J        │ K        │ —        │ —        │→ │ Esc      │ × │
 *   │ #2 │ +追加    │          │          │          │  │          │   │
 *   └────┴──────────┴──────────┴──────────┴──────────┴──┴──────────┴───┘
 *
 * "Disabled" entries (all-zero inputs + output) render the "+ 追加"
 * affordance instead of empty key buttons. The footer shows the dirty
 * count and a save button.
 */

import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { isComboEmpty } from '../protocol/commands';
import type { KeyboardLayoutDef } from '../protocol/handshake';
import { labelForKeycode } from '../protocol/keycodes';
import {
  selectDirtyMask,
  selectDuplicateIndices,
  selectIsDirty,
  useComboStore,
} from '../state/combos';
import { KeycodePicker } from './KeycodePicker';

export interface ComboEditorProps {
  definition: KeyboardLayoutDef;
  layerCount: number;
}

/** Which slot of which combo is currently being edited via the picker. */
type PickerTarget =
  | { index: number; kind: 'input'; slot: number }
  | { index: number; kind: 'output' };

export function ComboEditor({ definition, layerCount }: ComboEditorProps) {
  const phase = useComboStore((s) => s.phase);
  const count = useComboStore((s) => s.count);
  const local = useComboStore((s) => s.local);
  const setInput = useComboStore((s) => s.setInput);
  const setOutput = useComboStore((s) => s.setOutput);
  const clearCombo = useComboStore((s) => s.clearCombo);
  const resetCombo = useComboStore((s) => s.resetCombo);
  const save = useComboStore((s) => s.save);
  const reload = useComboStore((s) => s.reloadFromDevice);
  const dirty = useComboStore(selectIsDirty);
  const dirtyMask = useComboStore(useShallow(selectDirtyMask));
  const duplicates = useComboStore(useShallow(selectDuplicateIndices));

  const [pickerTarget, setPickerTarget] = useState<PickerTarget | null>(null);

  if (phase.kind === 'empty' || phase.kind === 'loading') {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">コンボを読み込み中…</p>;
  }

  const saving = phase.kind === 'saving';
  const error = phase.kind === 'error' ? phase.message : null;

  const currentKeycode = (() => {
    if (!pickerTarget) return 0;
    const entry = local[pickerTarget.index];
    if (!entry) return 0;
    if (pickerTarget.kind === 'input') return entry.inputs[pickerTarget.slot] ?? 0;
    return entry.output;
  })();

  return (
    <section
      aria-labelledby="combo-editor-heading"
      className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden"
    >
      <header className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
        <h3 id="combo-editor-heading" className="text-sm font-medium">
          コンボ
        </h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
          指定したキー（最大 4 つ）を同時に押すと出力キーが発火します。kobu は最大 {count} 個まで。
        </p>
      </header>

      <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
        {Array.from({ length: count }, (_, i) => {
          const entry = local[i];
          if (!entry) return null;
          const empty = isComboEmpty(entry);
          const isDirty = dirtyMask[i] === true;
          const isDup = duplicates.has(i);
          return (
            <ComboRow
              // biome-ignore lint/suspicious/noArrayIndexKey: slot index *is* the identity (#0..#N).
              key={`combo-${i}`}
              index={i}
              definition={definition}
              entry={entry}
              empty={empty}
              dirty={isDirty}
              duplicate={isDup}
              onPickInput={(slot) => setPickerTarget({ index: i, kind: 'input', slot })}
              onPickOutput={() => setPickerTarget({ index: i, kind: 'output' })}
              onClear={() => clearCombo(i)}
              onReset={() => resetCombo(i)}
              onRemoveInput={(slot) => setInput(i, slot, 0)}
            />
          );
        })}
      </div>

      <footer className="border-t border-zinc-200 dark:border-zinc-800 px-4 py-3 flex flex-wrap items-center gap-3 bg-zinc-50 dark:bg-zinc-900">
        <p className="text-xs text-zinc-500 dark:text-zinc-400 flex-1">
          {dirty ? '未保存の変更があります' : '変更はありません'}
        </p>
        <div className="flex items-center gap-2">
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
            {saving ? `保存中 ${phase.sent}/${phase.total}…` : dirty ? 'コンボを保存' : '保存済み'}
          </button>
        </div>
        {error && <div className="w-full text-sm text-rose-700 dark:text-rose-400">{error}</div>}
      </footer>

      {pickerTarget && (
        <KeycodePicker
          definition={definition}
          layerCount={layerCount}
          current={currentKeycode}
          onPick={(kc) => {
            if (pickerTarget.kind === 'input') {
              setInput(pickerTarget.index, pickerTarget.slot, kc);
            } else {
              setOutput(pickerTarget.index, kc);
            }
            setPickerTarget(null);
          }}
          onClose={() => setPickerTarget(null)}
        />
      )}
    </section>
  );
}

interface ComboRowProps {
  index: number;
  definition: KeyboardLayoutDef;
  entry: { inputs: [number, number, number, number]; output: number };
  empty: boolean;
  dirty: boolean;
  duplicate: boolean;
  onPickInput: (slot: number) => void;
  onPickOutput: () => void;
  onClear: () => void;
  onReset: () => void;
  onRemoveInput: (slot: number) => void;
}

function ComboRow({
  index,
  definition,
  entry,
  empty,
  dirty,
  duplicate,
  onPickInput,
  onPickOutput,
  onClear,
  onReset,
  onRemoveInput,
}: ComboRowProps) {
  return (
    <div
      className={[
        'px-4 py-2 flex flex-wrap items-center gap-2 text-sm',
        duplicate ? 'bg-rose-50 dark:bg-rose-950/30' : '',
      ].join(' ')}
    >
      <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400 w-8 inline-flex items-center gap-1">
        #{index}
        {dirty && (
          <span
            title="未保存の変更あり"
            className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500"
          />
        )}
      </span>

      {empty ? (
        <button
          type="button"
          onClick={() => onPickInput(0)}
          className="rounded-md border border-dashed border-zinc-300 dark:border-zinc-700 px-3 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 dark:text-zinc-400"
        >
          ＋ 追加
        </button>
      ) : (
        <>
          <div className="flex items-center gap-1">
            {entry.inputs.map((kc, slot) => (
              <InputKey
                // biome-ignore lint/suspicious/noArrayIndexKey: slot 0..3 is the identity.
                key={`in-${slot}`}
                kc={kc}
                definition={definition}
                onClick={() => onPickInput(slot)}
                onRemove={() => onRemoveInput(slot)}
              />
            ))}
          </div>
          <span className="text-zinc-400 dark:text-zinc-500 px-1">→</span>
          <button
            type="button"
            onClick={onPickOutput}
            className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1 font-mono min-w-[5rem] text-center hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            {entry.output === 0
              ? '—'
              : labelForKeycode(entry.output, { definition }).short ||
                `0x${entry.output.toString(16)}`}
          </button>
          <div className="ml-auto flex items-center gap-1">
            {duplicate && (
              <span
                className="text-xs text-rose-700 dark:text-rose-300 mr-2"
                title="同じ入力組み合わせのコンボがあります"
              >
                ⚠ 重複
              </span>
            )}
            <button
              type="button"
              onClick={onReset}
              className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              元に戻す
            </button>
            <button
              type="button"
              aria-label="削除"
              onClick={onClear}
              className="rounded px-2 py-1 text-zinc-500 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-950 dark:hover:text-rose-300"
            >
              ×
            </button>
          </div>
        </>
      )}
    </div>
  );
}

interface InputKeyProps {
  kc: number;
  definition: KeyboardLayoutDef;
  onClick: () => void;
  onRemove: () => void;
}

function InputKey({ kc, definition, onClick, onRemove }: InputKeyProps) {
  if (kc === 0) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="rounded border border-dashed border-zinc-300 dark:border-zinc-700 px-2 py-1 w-14 text-center text-zinc-400 dark:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        ＋
      </button>
    );
  }
  const label = labelForKeycode(kc, { definition });
  return (
    <span className="inline-flex items-center gap-0.5">
      <button
        type="button"
        onClick={onClick}
        className="rounded border border-zinc-300 dark:border-zinc-700 px-2 py-1 font-mono min-w-[3.5rem] text-center hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        {label.short || `0x${kc.toString(16)}`}
      </button>
      <button
        type="button"
        aria-label="この入力を削除"
        onClick={onRemove}
        className="text-xs text-zinc-400 hover:text-rose-600 px-0.5"
      >
        ×
      </button>
    </span>
  );
}
