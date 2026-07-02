import { useKeymapStore } from '../state/keymap';
import { BehaviorPicker } from './BehaviorPicker';
import { KeymapGrid } from './KeymapGrid';
import { LayerBar } from './LayerBar';

export function Editor() {
  const loaded = useKeymapStore((s) => s.loaded);
  const lastError = useKeymapStore((s) => s.lastError);
  const clearError = useKeymapStore((s) => s.clearError);

  if (!loaded) {
    return <p className="text-sm text-zinc-500">キーマップを読み込み中…</p>;
  }

  return (
    <div className="space-y-5">
      {lastError && (
        <div className="flex items-start gap-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
          <span className="flex-1">{lastError}</span>
          <button type="button" onClick={clearError} className="font-medium underline">
            閉じる
          </button>
        </div>
      )}
      <LayerBar />
      <KeymapGrid />
      <BehaviorPicker />
    </div>
  );
}
