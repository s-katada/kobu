import { KOBU_PHYSICAL_LAYOUT, layoutBounds } from '../keymap/physicalLayout';
import { useKeymapStore } from '../state/keymap';

// Pixels per ZMK unit (100 units = one 1U key ≈ 44px).
const U = 0.44;
const GAP = 4;

export function KeymapGrid() {
  const layers = useKeymapStore((s) => s.layers);
  const layoutKeys = useKeymapStore((s) => s.layoutKeys);
  const selectedLayer = useKeymapStore((s) => s.selectedLayer);
  const selectedKey = useKeymapStore((s) => s.selectedKey);
  const selectKey = useKeymapStore((s) => s.selectKey);
  const describe = useKeymapStore((s) => s.describe);

  // Prefer the firmware-reported layout; fall back to the bundled kobu
  // geometry before/without a meaningful layout.
  const keys = layoutKeys.length > 0 ? layoutKeys : KOBU_PHYSICAL_LAYOUT;
  const bounds = layoutBounds(keys);
  const layer = layers[selectedLayer];

  return (
    <div className="overflow-x-auto">
      <div className="relative" style={{ width: bounds.width * U, height: bounds.height * U }}>
        {keys.map((k, i) => {
          const binding = layer?.bindings[i];
          const f = describe(binding);
          const selected = selectedKey === i;
          const empty = f.none && f.label === '';
          return (
            <button
              type="button"
              // biome-ignore lint/suspicious/noArrayIndexKey: key positions are stable, fixed-length
              key={i}
              onClick={() => selectKey(i)}
              title={f.behaviorName}
              style={{
                left: k.x * U,
                top: k.y * U,
                width: k.width * U - GAP,
                height: k.height * U - GAP,
              }}
              className={[
                'absolute flex items-center justify-center rounded-md border p-0.5 text-center text-[11px] leading-tight transition-colors',
                selected
                  ? 'border-sky-500 bg-sky-100 ring-2 ring-sky-500 dark:bg-sky-900/60'
                  : empty
                    ? 'border-dashed border-zinc-200 bg-transparent text-zinc-300 dark:border-zinc-800 dark:text-zinc-700'
                    : f.transparent
                      ? 'border-zinc-200 bg-zinc-50 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-500'
                      : 'border-zinc-300 bg-white text-zinc-800 hover:border-sky-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100',
              ].join(' ')}
            >
              <span className="line-clamp-2 break-words">{f.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
