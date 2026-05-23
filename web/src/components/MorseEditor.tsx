/**
 * Tap-dance / Morse editor — Phase 4.3 deliverable.
 *
 * One card per morse slot. Inside each card: four keycode buttons
 * (tap / hold / double-tap / hold-after-tap) plus a tap-term number
 * input. A row of preset templates lets the user fill in common
 * patterns ("tap=Esc / hold=Ctrl", "() pair", "clear") with one
 * click — the issue called these out as a UX nicety.
 *
 * Each card also shows advisory warnings:
 *   * tap-term outside 50..1000 ms is unusable in practice
 *   * an all-zero entry is a no-op
 *
 * Both are warnings, not blockers — the firmware accepts whatever we
 * send.
 */

import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { MorseEntry } from '../protocol/commands';
import type { KeyboardLayoutDef } from '../protocol/handshake';
import { labelForKeycode } from '../protocol/keycodes';
import { MAX_TAP_TERM_MS, MIN_TAP_TERM_MS } from '../protocol/morses';
import {
  computeWarnings,
  MORSE_PRESETS,
  type MorsePreset,
  type MorseWarning,
  selectDirtyMask,
  selectIsDirty,
  useMorseStore,
} from '../state/morses';
import { KeycodePicker } from './KeycodePicker';

export interface MorseEditorProps {
  definition: KeyboardLayoutDef;
  layerCount: number;
}

type PickerField = 'tap' | 'hold' | 'doubleTap' | 'holdAfterTap';

interface PickerTarget {
  index: number;
  field: PickerField;
}

export function MorseEditor({ definition, layerCount }: MorseEditorProps) {
  const phase = useMorseStore((s) => s.phase);
  const count = useMorseStore((s) => s.count);
  const local = useMorseStore((s) => s.local);
  const setTap = useMorseStore((s) => s.setTap);
  const setHold = useMorseStore((s) => s.setHold);
  const setDoubleTap = useMorseStore((s) => s.setDoubleTap);
  const setHoldAfterTap = useMorseStore((s) => s.setHoldAfterTap);
  const setTapTerm = useMorseStore((s) => s.setTapTerm);
  const clearEntry = useMorseStore((s) => s.clearEntry);
  const resetEntry = useMorseStore((s) => s.resetEntry);
  const applyPreset = useMorseStore((s) => s.applyPreset);
  const save = useMorseStore((s) => s.save);
  const reload = useMorseStore((s) => s.reloadFromDevice);
  const dirty = useMorseStore(selectIsDirty);
  const dirtyMask = useMorseStore(useShallow(selectDirtyMask));
  // `computeWarnings` returns a fresh array per entry — wrapping it
  // through `useShallow` would still flag every render as "changed"
  // (inner array references differ). Memoising over `local` (whose
  // reference is stable until an edit lands) is the right level.
  const warnings = useMemo<MorseWarning[][]>(() => local.map(computeWarnings), [local]);

  const [picker, setPicker] = useState<PickerTarget | null>(null);

  if (phase.kind === 'empty' || phase.kind === 'loading') {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">タップダンスを読み込み中…</p>;
  }

  const saving = phase.kind === 'saving';
  const error = phase.kind === 'error' ? phase.message : null;
  const currentKeycode = (() => {
    if (!picker) return 0;
    const entry = local[picker.index];
    if (!entry) return 0;
    return entry[picker.field];
  })();

  const setFieldFn = (field: PickerField): ((index: number, kc: number) => void) => {
    switch (field) {
      case 'tap':
        return setTap;
      case 'hold':
        return setHold;
      case 'doubleTap':
        return setDoubleTap;
      case 'holdAfterTap':
        return setHoldAfterTap;
    }
  };

  return (
    <section
      aria-labelledby="morse-editor-heading"
      className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden"
    >
      <header className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
        <h3 id="morse-editor-heading" className="text-sm font-medium">
          タップダンス
        </h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
          タップ回数とホールド時間で複数の動作を 1 つのキーに割り当てます。最大 {count} 個。
          <span className="ml-2 text-zinc-400">
            キーマップ側で TD(N) を選択すると有効化されます。
          </span>
        </p>
      </header>

      <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
        {Array.from({ length: count }, (_, i) => {
          const entry = local[i];
          if (!entry) return null;
          return (
            <MorseRow
              // biome-ignore lint/suspicious/noArrayIndexKey: TD(N) slot index is the identity.
              key={`morse-${i}`}
              index={i}
              entry={entry}
              definition={definition}
              dirty={dirtyMask[i] === true}
              warnings={warnings[i] ?? []}
              onPick={(field) => setPicker({ index: i, field })}
              onTapTermChange={(ms) => setTapTerm(i, ms)}
              onClear={() => clearEntry(i)}
              onReset={() => resetEntry(i)}
              onApplyPreset={(preset) => applyPreset(i, preset)}
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
            {saving
              ? `保存中 ${phase.sent}/${phase.total}…`
              : dirty
                ? 'タップダンスを保存'
                : '保存済み'}
          </button>
        </div>
        {error && <div className="w-full text-sm text-rose-700 dark:text-rose-400">{error}</div>}
      </footer>

      {picker && (
        <KeycodePicker
          definition={definition}
          layerCount={layerCount}
          current={currentKeycode}
          onPick={(kc) => {
            setFieldFn(picker.field)(picker.index, kc);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </section>
  );
}

interface MorseRowProps {
  index: number;
  entry: MorseEntry;
  definition: KeyboardLayoutDef;
  dirty: boolean;
  warnings: MorseWarning[];
  onPick: (field: PickerField) => void;
  onTapTermChange: (ms: number) => void;
  onClear: () => void;
  onReset: () => void;
  onApplyPreset: (preset: MorsePreset) => void;
}

function MorseRow({
  index,
  entry,
  definition,
  dirty,
  warnings,
  onPick,
  onTapTermChange,
  onClear,
  onReset,
  onApplyPreset,
}: MorseRowProps) {
  const outOfRange = warnings.includes('out-of-range');
  const noOp = warnings.includes('no-op');
  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400 inline-flex items-center gap-1">
          TD({index})
          {dirty && (
            <span
              title="未保存の変更あり"
              className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500"
            />
          )}
        </span>
        {noOp && (
          <span className="text-xs text-zinc-500 dark:text-zinc-400 italic">
            未設定 — どのアクションも割り当てられていません
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <PresetMenu onApply={onApplyPreset} />
          <button
            type="button"
            onClick={onReset}
            className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            元に戻す
          </button>
          <button
            type="button"
            aria-label="クリア"
            onClick={onClear}
            className="rounded px-2 py-1 text-zinc-500 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-950 dark:hover:text-rose-300"
          >
            ×
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <FieldButton
          label="タップ"
          kc={entry.tap}
          definition={definition}
          onClick={() => onPick('tap')}
        />
        <FieldButton
          label="ホールド"
          kc={entry.hold}
          definition={definition}
          onClick={() => onPick('hold')}
        />
        <FieldButton
          label="二度押し"
          kc={entry.doubleTap}
          definition={definition}
          onClick={() => onPick('doubleTap')}
        />
        <FieldButton
          label="タップ→ホールド"
          kc={entry.holdAfterTap}
          definition={definition}
          onClick={() => onPick('holdAfterTap')}
        />
      </div>

      <div className="flex items-center gap-2 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-zinc-500 dark:text-zinc-400">タップ判定時間</span>
          <input
            type="number"
            min={0}
            max={2000}
            step={10}
            value={entry.tapTermMs}
            onChange={(e) => {
              const ms = Number(e.target.value);
              if (Number.isFinite(ms)) onTapTermChange(ms);
            }}
            className={[
              'w-24 rounded border bg-white dark:bg-zinc-900 px-2 py-1 font-mono text-right',
              outOfRange ? 'border-rose-400' : 'border-zinc-300 dark:border-zinc-700',
            ].join(' ')}
            aria-invalid={outOfRange}
          />
          <span className="text-zinc-500 dark:text-zinc-400">ms</span>
        </label>
        {outOfRange && (
          <span className="text-xs text-rose-700 dark:text-rose-300">
            ⚠ 推奨範囲は {MIN_TAP_TERM_MS}–{MAX_TAP_TERM_MS} ms
          </span>
        )}
      </div>
    </div>
  );
}

interface FieldButtonProps {
  label: string;
  kc: number;
  definition: KeyboardLayoutDef;
  onClick: () => void;
}

function FieldButton({ label, kc, definition, onClick }: FieldButtonProps) {
  const labelText =
    kc === 0 ? '—' : labelForKeycode(kc, { definition }).short || `0x${kc.toString(16)}`;
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
    >
      <span className="block text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {label}
      </span>
      <span className="block font-mono">{labelText}</span>
    </button>
  );
}

function PresetMenu({ onApply }: { onApply: (preset: MorsePreset) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="rounded px-2 py-1 text-xs border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        テンプレート ▾
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 z-10 w-72 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shadow-md"
        >
          {MORSE_PRESETS.map((preset) => (
            <button
              key={preset.name}
              type="button"
              role="menuitem"
              onClick={() => {
                onApply(preset);
                setOpen(false);
              }}
              className="block w-full text-left px-3 py-2 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-900 border-b last:border-b-0 border-zinc-100 dark:border-zinc-900"
            >
              <span className="font-medium block">{preset.name}</span>
              <span className="text-zinc-500 dark:text-zinc-400 block mt-0.5">
                {preset.description}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
