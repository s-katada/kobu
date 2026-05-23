/**
 * Top-level editor view. Composed of:
 *   * `EditorToolbar`     — layer tabs, undo/redo, save
 *   * `KeymapView`        — 4×10 split SVG
 *   * `BluetoothPanel`    — Layer 3 BLE side panel (only on layer 3)
 *   * `KeycodePicker`     — modal opened by clicking a key cell
 *   * `MacroEditor`       — macro buffer editor
 *   * `ComboEditor`       — combo entries editor
 *   * `MorseEditor`       — tap-dance / morse editor
 *   * `KobuSettingsPanel` — kobu-specific runtime knobs
 *
 * Subscribes to the connection store so we know when to attach
 * (transitions to `ready`) and detach (transition out of `ready`).
 * The per-feature stores each own their slice of state from there on.
 */

import { useEffect, useState } from 'react';
import { useComboStore } from '../state/combos';
import { useConnectionStore } from '../state/connection';
import { isCellDirty, useEditorStore } from '../state/editor';
import { useKobuSettingsStore } from '../state/kobuSettings';
import { useMacroStore } from '../state/macros';
import { useMorseStore } from '../state/morses';
import { BluetoothPanel } from './BluetoothPanel';
import { ComboEditor } from './ComboEditor';
import { EditorToolbar } from './EditorToolbar';
import { KeycodePicker } from './KeycodePicker';
import { KeymapView } from './KeymapView';
import { KobuSettingsPanel } from './KobuSettingsPanel';
import { MacroEditor } from './MacroEditor';
import { MorseEditor } from './MorseEditor';

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

  // Attach the per-feature stores in lock-step with the connection.
  // They share one transport but keep independent dirty state.
  useEffect(() => {
    if (connection.kind === 'ready') {
      void attach(connection.transport, connection.handshake.definition);
      void attachMacros(connection.transport);
      void attachCombos(connection.transport);
      void attachMorses(connection.transport);
      void attachKobu(connection.transport);
    } else {
      detach();
      detachMacros();
      detachCombos();
      detachMorses();
      detachKobu();
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

  // Subscribe to the whole state for the dirty predicate — re-renders
  // are cheap and the helper closes over the latest snapshot.
  const editorState = useEditorStore();

  const [pickerOpen, setPickerOpen] = useState(false);

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

  const layerKeymap = local[activeLayer] ?? [];
  const currentSelected = selected;
  const currentKeycode = currentSelected
    ? (local[currentSelected.layer]?.[currentSelected.row]?.[currentSelected.col] ?? 0)
    : 0;

  return (
    <section className="space-y-4">
      <EditorToolbar />

      <div className="flex items-baseline justify-between">
        <h3 className="text-sm text-zinc-500 dark:text-zinc-400">
          レイヤー{' '}
          <span className="text-zinc-900 dark:text-zinc-100 font-medium">{activeLayer}</span>
          {' / '}全 {dimensions.layers} 層
        </h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          キーをクリックして再割り当て。<kbd>1</kbd>..<kbd>{dimensions.layers}</kbd>{' '}
          でレイヤー切替。
        </p>
      </div>

      <KeymapView
        definition={definition}
        keymap={layerKeymap}
        selected={currentSelected ? { row: currentSelected.row, col: currentSelected.col } : null}
        isDirty={(row, col) => isCellDirty(editorState, { layer: activeLayer, row, col })}
        onCellClick={(row, col) => {
          selectCell({ layer: activeLayer, row, col });
          setPickerOpen(true);
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

      {pickerOpen && currentSelected && (
        <KeycodePicker
          definition={definition}
          layerCount={dimensions.layers}
          current={currentKeycode}
          onPick={(kc) => {
            applyKeyToSelection(kc);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      <MacroEditor definition={definition} layerCount={dimensions.layers} />

      <ComboEditor definition={definition} layerCount={dimensions.layers} />

      <MorseEditor definition={definition} layerCount={dimensions.layers} />

      <KobuSettingsPanel />
    </section>
  );
}
