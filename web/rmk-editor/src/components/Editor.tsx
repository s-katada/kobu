/**
 * Top-level editor view. Composed of:
 *   * `EditorToolbar`     — layer tabs, undo/redo, save
 *   * `KeymapView`        — split HTML keycap grid
 *   * `KeycodeDock`       — persistent inline picker docked below
 *   * `BluetoothPanel`    — Layer 3 BLE side panel (only on layer 3)
 *   * `MacroEditor`       — macro buffer editor
 *   * `ComboEditor`       — combo entries editor
 *   * `MorseEditor`       — tap-dance / morse editor
 *   * `KobuSettingsPanel` — kobu-specific runtime knobs
 *
 * Subscribes to the connection store so we know when to attach
 * (transitions to `ready`) and detach (transition out of `ready`).
 * The per-feature stores each own their slice of state from there on.
 *
 * Keyboard shortcuts (when no input is focused):
 *   - 1..9         jump to that layer (EditorToolbar)
 *   - Ctrl/Cmd+Z   undo / redo (EditorToolbar)
 *   - ←↑→↓         move the selected cell within the active layer
 *   - Backspace    clear the selected cell to KC_NO
 *   - T            set the selected cell to Transparent
 */

import { useCallback, useEffect, useState } from 'react';
import { encodeNo, encodeTransparent } from '../protocol/keycodes';
import { useComboStore } from '../state/combos';
import { useConnectionStore } from '../state/connection';
import { isCellDirty, useEditorStore } from '../state/editor';
import { useKobuSettingsStore } from '../state/kobuSettings';
import { useMacroStore } from '../state/macros';
import { useMorseStore } from '../state/morses';
import { useUnlockStore } from '../state/unlock';
import { BluetoothPanel } from './BluetoothPanel';
import { ComboEditor } from './ComboEditor';
import { EditorToolbar } from './EditorToolbar';
import { KeycodeDock } from './KeycodeDock';
import { KeymapView } from './KeymapView';
import { KobuBatteryPanel } from './KobuBatteryPanel';
import { KobuSettingsPanel } from './KobuSettingsPanel';
import { MacroEditor } from './MacroEditor';
import { MorseEditor } from './MorseEditor';
import { UnlockPanel } from './UnlockPanel';

export function Editor() {
  const connection = useConnectionStore((s) => s.state);
  const attach = useEditorStore((s) => s.attach);
  const detach = useEditorStore((s) => s.detach);
  const attachMacros = useMacroStore((s) => s.attach);
  const detachMacros = useMacroStore((s) => s.detach);
  const attachCombos = useComboStore((s) => s.attach);
  const detachCombos = useComboStore((s) => s.detach);
  const attachMorses = useMorseStore((s) => s.attach);
  const detachMorses = useMorseStore((s) => s.detach);
  const attachKobu = useKobuSettingsStore((s) => s.attach);
  const detachKobu = useKobuSettingsStore((s) => s.detach);
  const attachUnlock = useUnlockStore((s) => s.attach);
  const detachUnlock = useUnlockStore((s) => s.detach);

  // Attach the per-feature stores in lock-step with the connection.
  // They share one transport but keep independent dirty state.
  useEffect(() => {
    if (connection.kind === 'ready') {
      void attach(connection.transport, connection.handshake.definition);
      void attachMacros(connection.transport);
      void attachCombos(connection.transport);
      void attachMorses(connection.transport);
      void attachKobu(connection.transport);
      void attachUnlock(connection.transport);
    } else {
      detach();
      detachMacros();
      detachCombos();
      detachMorses();
      detachKobu();
      detachUnlock();
    }
  }, [
    connection,
    attach,
    detach,
    attachMacros,
    detachMacros,
    attachCombos,
    detachCombos,
    attachMorses,
    detachMorses,
    attachKobu,
    detachKobu,
    attachUnlock,
    detachUnlock,
  ]);

  const phase = useEditorStore((s) => s.phase);
  const definition = useEditorStore((s) => s.definition);
  const dimensions = useEditorStore((s) => s.dimensions);
  const local = useEditorStore((s) => s.local);
  const activeLayer = useEditorStore((s) => s.activeLayer);
  const selected = useEditorStore((s) => s.selected);
  const selectCell = useEditorStore((s) => s.selectCell);
  const setActiveLayer = useEditorStore((s) => s.setActiveLayer);
  const applyKeyToSelection = useEditorStore((s) => s.applyKeyToSelection);
  const setKey = useEditorStore((s) => s.setKey);

  // Unlock chord highlight: light up the physical keys to hold while unlocking.
  const unlockChord = useUnlockStore((s) => s.chord);
  const unlockActive = useUnlockStore((s) => s.status === 'unlocking');

  // Subscribe to the whole state for the dirty predicate — re-renders
  // are cheap and the helper closes over the latest snapshot.
  const editorState = useEditorStore();

  const [hoverCell, setHoverCell] = useState<{ row: number; col: number } | null>(null);

  const currentSelected = selected;
  const layerKeymap = local?.[activeLayer] ?? [];
  const currentKeycode = currentSelected
    ? (local?.[currentSelected.layer]?.[currentSelected.row]?.[currentSelected.col] ?? 0)
    : 0;
  const hoverKeycode = hoverCell ? (layerKeymap[hoverCell.row]?.[hoverCell.col] ?? 0) : null;

  // Arrow-key navigation + Backspace/Delete/T shortcuts.
  // The toolbar already owns 1..9 and ⌘/Ctrl+Z, so this hook only
  // handles cell-relative operations and stays out of input fields.
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (target.isContentEditable) return;
      }
      if (!dimensions) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Arrow keys: move the selection on the active layer's matrix.
      if (
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowRight' ||
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown'
      ) {
        if (!currentSelected) return;
        const dRow = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
        const dCol = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
        const nextRow = Math.max(0, Math.min(dimensions.rows - 1, currentSelected.row + dRow));
        const nextCol = Math.max(0, Math.min(dimensions.cols - 1, currentSelected.col + dCol));
        if (nextRow !== currentSelected.row || nextCol !== currentSelected.col) {
          e.preventDefault();
          selectCell({ layer: currentSelected.layer, row: nextRow, col: nextCol });
        }
        return;
      }

      if (!currentSelected) return;
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        setKey(currentSelected, encodeNo());
        return;
      }
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault();
        setKey(currentSelected, encodeTransparent());
      }
    },
    [currentSelected, dimensions, selectCell, setKey],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleKey]);

  if (connection.kind !== 'ready') return null;
  if (phase.kind === 'loading' || phase.kind === 'empty') {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">kobu からキーマップを読み込み中…</p>
    );
  }
  if (!definition || !dimensions || !local) {
    return phase.kind === 'error' ? (
      <p className="text-sm text-rose-700 dark:text-rose-400">{phase.message}</p>
    ) : null;
  }

  return (
    <section className="space-y-5">
      <EditorToolbar />

      <UnlockPanel />

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm text-zinc-500 dark:text-zinc-400">
          レイヤー{' '}
          <span className="text-zinc-900 dark:text-zinc-100 font-medium">{activeLayer}</span>
          {' / '}全 {dimensions.layers} 層
        </h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 flex flex-wrap items-center gap-x-2">
          <span>
            <kbd className="rounded border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-1 font-mono text-[10px]">
              1
            </kbd>
            ..
            <kbd className="rounded border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-1 font-mono text-[10px]">
              {dimensions.layers}
            </kbd>{' '}
            でレイヤー切替
          </span>
          <span aria-hidden>·</span>
          <span>
            <kbd className="rounded border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-1 font-mono text-[10px]">
              ←↑→↓
            </kbd>{' '}
            でセル移動
          </span>
          <span aria-hidden>·</span>
          <span>
            <kbd className="rounded border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-1 font-mono text-[10px]">
              ⌫
            </kbd>{' '}
            で無効
          </span>
          <span aria-hidden>·</span>
          <span>
            <kbd className="rounded border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-1 font-mono text-[10px]">
              T
            </kbd>{' '}
            で透過
          </span>
        </p>
      </div>

      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-gradient-to-b from-zinc-50 to-white dark:from-zinc-900 dark:to-zinc-950 shadow-sm p-4">
        <KeymapView
          definition={definition}
          keymap={layerKeymap}
          selected={currentSelected ? { row: currentSelected.row, col: currentSelected.col } : null}
          isDirty={(row, col) => isCellDirty(editorState, { layer: activeLayer, row, col })}
          chordCells={unlockChord}
          chordActive={unlockActive}
          onCellClick={(row, col) => {
            selectCell({ layer: activeLayer, row, col });
          }}
          onCellHover={(cell) => setHoverCell(cell)}
        />
      </div>

      <KeycodeDock
        definition={definition}
        layerCount={dimensions.layers}
        selected={currentSelected ? { row: currentSelected.row, col: currentSelected.col } : null}
        current={currentKeycode}
        hover={hoverKeycode}
        onPick={(kc) => {
          if (currentSelected) applyKeyToSelection(kc);
        }}
      />

      {activeLayer === 3 && (
        <BluetoothPanel
          definition={definition}
          layer3={local[3] ?? []}
          onSelectCell={(pos) => {
            if (pos.layer !== activeLayer) setActiveLayer(pos.layer);
            selectCell(pos);
          }}
        />
      )}

      <MacroEditor definition={definition} layerCount={dimensions.layers} />

      <ComboEditor definition={definition} layerCount={dimensions.layers} />

      <MorseEditor definition={definition} layerCount={dimensions.layers} />

      <KobuBatteryPanel />

      <KobuSettingsPanel />
    </section>
  );
}
