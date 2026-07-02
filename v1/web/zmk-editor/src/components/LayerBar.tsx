import { useEffect, useState } from 'react';
import { useKeymapStore } from '../state/keymap';

function btn(extra = ''): string {
  return `rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800 ${extra}`;
}

export function LayerBar() {
  const layers = useKeymapStore((s) => s.layers);
  const selectedLayer = useKeymapStore((s) => s.selectedLayer);
  const availableLayers = useKeymapStore((s) => s.availableLayers);
  const maxLayerNameLength = useKeymapStore((s) => s.maxLayerNameLength);
  const unsaved = useKeymapStore((s) => s.unsaved);
  const busy = useKeymapStore((s) => s.busy);
  const undoCount = useKeymapStore((s) => s.undoStack.length);
  const redoCount = useKeymapStore((s) => s.redoStack.length);

  const selectLayer = useKeymapStore((s) => s.selectLayer);
  const addLayer = useKeymapStore((s) => s.addLayer);
  const removeLayer = useKeymapStore((s) => s.removeLayer);
  const moveLayer = useKeymapStore((s) => s.moveLayer);
  const renameLayer = useKeymapStore((s) => s.renameLayer);
  const save = useKeymapStore((s) => s.save);
  const discard = useKeymapStore((s) => s.discard);
  const factoryReset = useKeymapStore((s) => s.factoryReset);
  const undo = useKeymapStore((s) => s.undo);
  const redo = useKeymapStore((s) => s.redo);

  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');

  const current = layers[selectedLayer];

  // Cancel an in-progress rename whenever the selected layer changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedLayer is the trigger, not used in the body
  useEffect(() => setRenaming(false), [selectedLayer]);

  const commitRename = () => {
    const name = draft.trim();
    if (name) void renameLayer(selectedLayer, name);
    setRenaming(false);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {layers.map((layer, i) => (
          <button
            type="button"
            key={layer.id}
            onClick={() => selectLayer(i)}
            className={[
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              i === selectedLayer
                ? 'bg-sky-600 text-white'
                : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700',
            ].join(' ')}
          >
            <span className="mr-1 opacity-60">{i}</span>
            {layer.name || `Layer ${i}`}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {renaming ? (
          <span className="flex items-center gap-1.5">
            <input
              // biome-ignore lint/a11y/noAutofocus: focusing the rename field is the intent
              autoFocus
              value={draft}
              maxLength={maxLayerNameLength || 16}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setRenaming(false);
              }}
              className="w-40 rounded-md border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            />
            <button type="button" className={btn()} onClick={commitRename}>
              OK
            </button>
            <button type="button" className={btn()} onClick={() => setRenaming(false)}>
              キャンセル
            </button>
          </span>
        ) : (
          <>
            <button
              type="button"
              className={btn()}
              disabled={busy || layers.length >= availableLayers}
              onClick={() => void addLayer()}
              title={`最大 ${availableLayers} レイヤー`}
            >
              ＋ レイヤー追加
            </button>
            <button
              type="button"
              className={btn()}
              disabled={busy || !current}
              onClick={() => {
                setDraft(current?.name ?? '');
                setRenaming(true);
              }}
            >
              名前変更
            </button>
            <button
              type="button"
              className={btn()}
              disabled={busy || layers.length <= 1}
              onClick={() => void removeLayer(selectedLayer)}
            >
              削除
            </button>
            <button
              type="button"
              className={btn()}
              disabled={busy || selectedLayer <= 0}
              onClick={() => void moveLayer(selectedLayer, selectedLayer - 1)}
            >
              ← 左へ
            </button>
            <button
              type="button"
              className={btn()}
              disabled={busy || selectedLayer >= layers.length - 1}
              onClick={() => void moveLayer(selectedLayer, selectedLayer + 1)}
            >
              右へ →
            </button>
          </>
        )}

        <span className="mx-1 h-5 w-px bg-zinc-300 dark:bg-zinc-700" />

        <button
          type="button"
          className={btn()}
          disabled={busy || undoCount === 0}
          onClick={() => void undo()}
        >
          元に戻す
        </button>
        <button
          type="button"
          className={btn()}
          disabled={busy || redoCount === 0}
          onClick={() => void redo()}
        >
          やり直し
        </button>

        <span className="ml-auto flex items-center gap-1.5">
          {unsaved && <span className="text-xs text-amber-600 dark:text-amber-400">未保存</span>}
          <button
            type="button"
            className={btn()}
            disabled={busy || !unsaved}
            onClick={() => void discard()}
          >
            破棄
          </button>
          <button
            type="button"
            className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={busy || !unsaved}
            onClick={() => void save()}
          >
            本体に保存
          </button>
          <button
            type="button"
            className={btn('text-red-700 dark:text-red-300')}
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  '工場出荷状態に戻します（キーマップの変更はすべて失われます）。よろしいですか？',
                )
              ) {
                void factoryReset();
              }
            }}
          >
            初期化
          </button>
        </span>
      </div>
    </div>
  );
}
