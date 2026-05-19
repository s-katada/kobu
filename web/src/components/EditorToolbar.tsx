/**
 * Editor toolbar — layer tabs + Save / Undo / Redo / Revert controls.
 *
 * Also installs page-level keyboard shortcuts:
 *   1..9         jump to that layer (clamped to existing layers)
 *   Ctrl/Cmd+Z   undo
 *   Ctrl/Cmd+⇧+Z redo
 *
 * The component is purely a view over `useEditorStore`; the store
 * remains the single source of truth for whether a save is allowed,
 * the dirty mask, and the pending-cell count.
 */

import { useEffect } from 'react';
import { selectDirtyLayerMask, selectIsDirty, useEditorStore } from '../state/editor';

export function EditorToolbar() {
  const phase = useEditorStore((s) => s.phase);
  const dimensions = useEditorStore((s) => s.dimensions);
  const activeLayer = useEditorStore((s) => s.activeLayer);
  const setActiveLayer = useEditorStore((s) => s.setActiveLayer);
  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const save = useEditorStore((s) => s.save);
  const resetSelectionToBaseline = useEditorStore((s) => s.resetSelectionToBaseline);
  const dirtyMask = useEditorStore(selectDirtyLayerMask);
  const dirty = useEditorStore(selectIsDirty);
  const undoCount = useEditorStore((s) => s.undoStack.length);
  const redoCount = useEditorStore((s) => s.redoStack.length);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      // Layer shortcuts: 1..9 → layer 0..8
      if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const layer = Number(e.key) - 1;
        if (dimensions && layer < dimensions.layers) {
          e.preventDefault();
          setActiveLayer(layer);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dimensions, redo, setActiveLayer, undo]);

  // beforeunload guard while dirty.
  useEffect(() => {
    if (!dirty) return;
    function handler(e: BeforeUnloadEvent) {
      e.preventDefault();
    }
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  if (!dimensions) return null;

  const saving = phase.kind === 'saving';

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 dark:border-zinc-800 pb-3 mb-4">
      <div className="flex items-center gap-1" role="tablist" aria-label="レイヤー">
        {Array.from({ length: dimensions.layers }, (_, layer) => {
          const isActive = layer === activeLayer;
          const isDirty = (dirtyMask & (1 << layer)) !== 0;
          const tabId = `layer-tab-${layer}`;
          return (
            <button
              key={tabId}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveLayer(layer)}
              className={[
                'rounded-md px-3 py-1.5 text-sm font-medium border transition-colors',
                isActive
                  ? 'bg-zinc-900 dark:bg-zinc-100 text-zinc-50 dark:text-zinc-900 border-transparent'
                  : 'bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800',
              ].join(' ')}
            >
              <span>L{layer}</span>
              {isDirty && (
                <span
                  className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-amber-500 align-middle"
                  title="このレイヤーに未保存の変更があります"
                />
              )}
            </button>
          );
        })}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={undo}
          disabled={undoCount === 0 || saving}
          className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          元に戻す
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={redoCount === 0 || saving}
          className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          やり直し
        </button>
        <button
          type="button"
          onClick={resetSelectionToBaseline}
          disabled={saving}
          className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-900 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          選択セルを元に戻す
        </button>
        <button
          type="button"
          onClick={() => {
            void save();
          }}
          disabled={!dirty || saving}
          className="rounded-md bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? `保存中 ${phase.sent}/${phase.total}…` : dirty ? '保存' : '保存済み'}
        </button>
      </div>

      {phase.kind === 'error' && (
        <div className="w-full text-sm text-rose-700 dark:text-rose-400">{phase.message}</div>
      )}
    </div>
  );
}
