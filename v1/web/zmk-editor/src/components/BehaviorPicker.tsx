import { useEffect, useMemo, useState } from 'react';
import { decodeKeycode, encodeKeycode, KEYCODE_PALETTE } from '../keymap/hidUsages';
import type { BehaviorBinding, BehaviorParameterValueDescription } from '../rpc/types';
import { useKeymapStore } from '../state/keymap';

const MOD_TOGGLES: ReadonlyArray<readonly [number, string]> = [
  [0x01, 'Ctrl'],
  [0x02, 'Shift'],
  [0x04, 'Alt'],
  [0x08, 'Cmd'],
];

// KEYCODE_PALETTE grouped by `group`, for <optgroup>s.
const PALETTE_GROUPS = (() => {
  const groups = new Map<string, typeof KEYCODE_PALETTE>();
  for (const opt of KEYCODE_PALETTE) {
    const list = groups.get(opt.group) ?? [];
    list.push(opt);
    groups.set(opt.group, list);
  }
  return [...groups.entries()];
})();

type ParamKind = 'none' | 'constants' | 'hidUsage' | 'layerId' | 'range';

function paramKind(descs: BehaviorParameterValueDescription[] | undefined): ParamKind {
  if (!descs || descs.length === 0) return 'none';
  if (descs.every((d) => d.constant !== undefined)) return 'constants';
  if (descs.some((d) => d.hidUsage !== undefined)) return 'hidUsage';
  if (descs.some((d) => d.layerId !== undefined)) return 'layerId';
  if (descs.some((d) => d.range !== undefined)) return 'range';
  return 'none';
}

const selectCls =
  'rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900';

function ParamControl({
  label,
  descs,
  value,
  onChange,
}: {
  label: string;
  descs: BehaviorParameterValueDescription[] | undefined;
  value: number;
  onChange: (v: number) => void;
}) {
  const layers = useKeymapStore((s) => s.layers);
  const kind = paramKind(descs);
  if (kind === 'none') return null;

  let control: React.ReactNode = null;

  if (kind === 'constants') {
    control = (
      <select
        className={selectCls}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {descs?.map((d) => (
          <option key={d.name + String(d.constant)} value={d.constant ?? 0}>
            {d.name || String(d.constant)}
          </option>
        ))}
      </select>
    );
  } else if (kind === 'layerId') {
    control = (
      <select
        className={selectCls}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {layers.map((l, i) => (
          <option key={l.id} value={i}>
            {i}: {l.name || `Layer ${i}`}
          </option>
        ))}
      </select>
    );
  } else if (kind === 'range') {
    const range = descs?.find((d) => d.range !== undefined)?.range;
    control = (
      <input
        type="number"
        className={`w-24 ${selectCls}`}
        value={value}
        min={range?.min}
        max={range?.max}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    );
  } else {
    // hidUsage — base key palette + implicit modifier toggles.
    const { mods, page, id } = decodeKeycode(value);
    const base = encodeKeycode(page, id, 0);
    const known = KEYCODE_PALETTE.some((o) => o.usage === base);
    control = (
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={selectCls}
          value={base}
          onChange={(e) => onChange(encodeKeycodeWithMods(Number(e.target.value), mods))}
        >
          {!known && <option value={base}>0x{id.toString(16)}</option>}
          {PALETTE_GROUPS.map(([group, opts]) => (
            <optgroup key={group} label={group}>
              {opts.map((o) => (
                <option key={o.usage} value={o.usage}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <span className="flex items-center gap-2">
          {MOD_TOGGLES.map(([bit, name]) => (
            <label
              key={name}
              className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-300"
            >
              <input
                type="checkbox"
                checked={(mods & bit) !== 0}
                onChange={(e) =>
                  onChange(encodeKeycodeWithMods(base, e.target.checked ? mods | bit : mods & ~bit))
                }
              />
              {name}
            </label>
          ))}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-zinc-500">{label}</span>
      {control}
    </div>
  );
}

function encodeKeycodeWithMods(baseUsage: number, mods: number): number {
  const { page, id } = decodeKeycode(baseUsage);
  return encodeKeycode(page, id, mods);
}

export function BehaviorPicker() {
  const layers = useKeymapStore((s) => s.layers);
  const behaviors = useKeymapStore((s) => s.behaviors);
  const behaviorOrder = useKeymapStore((s) => s.behaviorOrder);
  const selectedLayer = useKeymapStore((s) => s.selectedLayer);
  const selectedKey = useKeymapStore((s) => s.selectedKey);
  const busy = useKeymapStore((s) => s.busy);
  const setBinding = useKeymapStore((s) => s.setBinding);
  const selectKey = useKeymapStore((s) => s.selectKey);
  const describe = useKeymapStore((s) => s.describe);

  const [draft, setDraft] = useState<BehaviorBinding>({ behaviorId: 0, param1: 0, param2: 0 });

  // Re-seed the draft from the device's current binding whenever a
  // different key is selected.
  useEffect(() => {
    if (selectedKey === null) return;
    const layer = useKeymapStore.getState().layers[selectedLayer];
    const current = layer?.bindings[selectedKey];
    if (current) setDraft({ ...current });
  }, [selectedLayer, selectedKey]);

  const behavior = behaviors[draft.behaviorId];
  const set = behavior?.metadata?.[0];
  const current = useMemo(() => {
    if (selectedKey === null) return undefined;
    return layers[selectedLayer]?.bindings[selectedKey];
  }, [layers, selectedLayer, selectedKey]);

  if (selectedKey === null) {
    return (
      <div className="rounded-lg border border-zinc-200 p-4 text-sm text-zinc-500 dark:border-zinc-800">
        キーを選択すると、ここで割り当てを変更できます。
      </div>
    );
  }

  const changeBehavior = (behaviorId: number) => setDraft({ behaviorId, param1: 0, param2: 0 });

  return (
    <div className="space-y-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex items-center justify-between">
        <div className="text-sm">
          <span className="text-zinc-500">位置 {selectedKey}</span>
          <span className="mx-2 text-zinc-400">·</span>
          <span className="font-medium">現在: {describe(current).label || '（なし）'}</span>
        </div>
        <button
          type="button"
          onClick={() => selectKey(null)}
          className="text-xs text-zinc-500 underline"
        >
          選択解除
        </button>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-zinc-500">ビヘイビア</span>
        <select
          className={selectCls}
          value={draft.behaviorId}
          onChange={(e) => changeBehavior(Number(e.target.value))}
        >
          {behaviorOrder.map((id) => (
            <option key={id} value={id}>
              {behaviors[id]?.displayName ?? `#${id}`}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-wrap gap-4">
        <ParamControl
          label="パラメータ 1"
          descs={set?.param1}
          value={draft.param1}
          onChange={(v) => setDraft((d) => ({ ...d, param1: v }))}
        />
        <ParamControl
          label="パラメータ 2"
          descs={set?.param2}
          value={draft.param2}
          onChange={(v) => setDraft((d) => ({ ...d, param2: v }))}
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void setBinding(selectedLayer, selectedKey, draft)}
          className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          このキーに適用
        </button>
        <span className="text-xs text-zinc-400">→ {describe(draft).label || '（なし）'}</span>
      </div>
    </div>
  );
}
