/**
 * Keymap editing store.
 *
 * Holds the working copy of the device's keymap (layers + per-key
 * bindings), the firmware-reported behaviors and physical layout, the
 * current selection, and a binding-level undo/redo history. Every
 * mutation goes to the device immediately over RPC (ZMK Studio is a
 * live, settings-backed editor) and is mirrored locally on success; the
 * device persists nothing until `save()` (Studio "Save" writes the
 * settings to flash).
 *
 * The session itself lives in the connection store; actions read it
 * lazily so the two stores don't hard-depend on each other's init order.
 */

import { create } from 'zustand';
import { type FormattedBinding, formatBinding } from '../keymap/binding';
import type { StudioSession } from '../rpc/session';
import type {
  BehaviorBinding,
  GetBehaviorDetailsResponse,
  KeyPhysicalAttrs,
  Layer,
  PhysicalLayout,
} from '../rpc/types';
import { useConnectionStore } from './connection';

// All ZMK Studio "OK" result codes are 0; non-zero is an error variant.
const RPC_OK = 0;

interface BindingEdit {
  layerIndex: number;
  keyPosition: number;
  before: BehaviorBinding;
  after: BehaviorBinding;
}

interface KeymapState {
  loaded: boolean;
  busy: boolean;
  lastError: string | null;

  layers: Layer[];
  behaviors: Record<number, GetBehaviorDetailsResponse>;
  behaviorOrder: number[];
  physicalLayouts: PhysicalLayout[];
  activeLayoutIndex: number;
  layoutKeys: KeyPhysicalAttrs[];
  availableLayers: number;
  maxLayerNameLength: number;

  selectedLayer: number;
  selectedKey: number | null;
  unsaved: boolean;

  undoStack: BindingEdit[];
  redoStack: BindingEdit[];
}

interface KeymapActions {
  load: (session: StudioSession) => Promise<void>;
  reset: () => void;
  setUnsaved: (unsaved: boolean) => void;
  clearError: () => void;

  selectLayer: (index: number) => void;
  selectKey: (position: number | null) => void;

  setBinding: (layerIndex: number, keyPosition: number, binding: BehaviorBinding) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;

  addLayer: () => Promise<void>;
  removeLayer: (index: number) => Promise<void>;
  moveLayer: (from: number, to: number) => Promise<void>;
  renameLayer: (index: number, name: string) => Promise<void>;

  save: () => Promise<void>;
  discard: () => Promise<void>;
  factoryReset: () => Promise<void>;

  /** Label a binding using the loaded behavior metadata. */
  describe: (binding: BehaviorBinding | undefined) => FormattedBinding;
  layerName: (index: number) => string;
}

const INITIAL: KeymapState = {
  loaded: false,
  busy: false,
  lastError: null,
  layers: [],
  behaviors: {},
  behaviorOrder: [],
  physicalLayouts: [],
  activeLayoutIndex: 0,
  layoutKeys: [],
  availableLayers: 0,
  maxLayerNameLength: 0,
  selectedLayer: 0,
  selectedKey: null,
  unsaved: false,
  undoStack: [],
  redoStack: [],
};

function session(): StudioSession | null {
  return useConnectionStore.getState().session;
}

function replaceBinding(
  layers: Layer[],
  layerIndex: number,
  keyPosition: number,
  binding: BehaviorBinding,
): Layer[] {
  return layers.map((layer, i) => {
    if (i !== layerIndex) return layer;
    const bindings = layer.bindings.slice();
    bindings[keyPosition] = binding;
    return { ...layer, bindings };
  });
}

export const useKeymapStore = create<KeymapState & KeymapActions>((set, get) => ({
  ...INITIAL,

  load: async (s) => {
    const ids = await s.listAllBehaviors();
    const details = await Promise.all(ids.map((id) => s.getBehaviorDetails(id)));
    const behaviors: Record<number, GetBehaviorDetailsResponse> = {};
    for (const d of details) behaviors[d.id] = d;

    const layouts = await s.getPhysicalLayouts();
    const keymap = await s.getKeymap();
    const unsaved = await s.checkUnsavedChanges();

    const activeLayoutIndex = layouts.activeLayoutIndex;
    set({
      ...INITIAL,
      loaded: true,
      behaviors,
      behaviorOrder: ids,
      physicalLayouts: layouts.layouts,
      activeLayoutIndex,
      layoutKeys: layouts.layouts[activeLayoutIndex]?.keys ?? [],
      layers: keymap.layers,
      availableLayers: keymap.availableLayers,
      maxLayerNameLength: keymap.maxLayerNameLength,
      unsaved,
    });
  },

  reset: () => set({ ...INITIAL }),

  setUnsaved: (unsaved) => set({ unsaved }),
  clearError: () => set({ lastError: null }),

  selectLayer: (index) => set({ selectedLayer: index, selectedKey: null }),
  selectKey: (position) => set({ selectedKey: position }),

  setBinding: async (layerIndex, keyPosition, binding) => {
    const s = session();
    const layer = get().layers[layerIndex];
    if (!s || !layer) return;
    const before = layer.bindings[keyPosition];
    if (!before) return;
    set({ busy: true, lastError: null });
    try {
      const resp = await s.setLayerBinding(layer.id, keyPosition, binding);
      if (resp !== RPC_OK) {
        set({ lastError: `バインドの設定に失敗しました (code ${resp})` });
        return;
      }
      set((st) => ({
        layers: replaceBinding(st.layers, layerIndex, keyPosition, binding),
        undoStack: [...st.undoStack, { layerIndex, keyPosition, before, after: binding }],
        redoStack: [],
        unsaved: true,
      }));
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ busy: false });
    }
  },

  undo: async () => {
    const entry = get().undoStack.at(-1);
    const s = session();
    const layer = entry ? get().layers[entry.layerIndex] : undefined;
    if (!entry || !s || !layer) return;
    set({ busy: true, lastError: null });
    try {
      const resp = await s.setLayerBinding(layer.id, entry.keyPosition, entry.before);
      if (resp !== RPC_OK) {
        set({ lastError: `取り消しに失敗しました (code ${resp})` });
        return;
      }
      set((st) => ({
        layers: replaceBinding(st.layers, entry.layerIndex, entry.keyPosition, entry.before),
        undoStack: st.undoStack.slice(0, -1),
        redoStack: [...st.redoStack, entry],
        unsaved: true,
      }));
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ busy: false });
    }
  },

  redo: async () => {
    const entry = get().redoStack.at(-1);
    const s = session();
    const layer = entry ? get().layers[entry.layerIndex] : undefined;
    if (!entry || !s || !layer) return;
    set({ busy: true, lastError: null });
    try {
      const resp = await s.setLayerBinding(layer.id, entry.keyPosition, entry.after);
      if (resp !== RPC_OK) {
        set({ lastError: `やり直しに失敗しました (code ${resp})` });
        return;
      }
      set((st) => ({
        layers: replaceBinding(st.layers, entry.layerIndex, entry.keyPosition, entry.after),
        redoStack: st.redoStack.slice(0, -1),
        undoStack: [...st.undoStack, entry],
        unsaved: true,
      }));
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ busy: false });
    }
  },

  addLayer: async () => {
    const s = session();
    if (!s) return;
    set({ busy: true, lastError: null });
    try {
      const resp = await s.addLayer();
      if (!resp.ok) {
        set({ lastError: `レイヤーを追加できません (code ${resp.err})` });
        return;
      }
      const keymap = await s.getKeymap();
      set({
        layers: keymap.layers,
        availableLayers: keymap.availableLayers,
        selectedLayer: resp.ok.index,
        selectedKey: null,
        undoStack: [],
        redoStack: [],
        unsaved: true,
      });
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ busy: false });
    }
  },

  removeLayer: async (index) => {
    const s = session();
    if (!s) return;
    set({ busy: true, lastError: null });
    try {
      const resp = await s.removeLayer(index);
      if (!resp.ok) {
        set({ lastError: `レイヤーを削除できません (code ${resp.err})` });
        return;
      }
      const keymap = await s.getKeymap();
      set((st) => ({
        layers: keymap.layers,
        availableLayers: keymap.availableLayers,
        selectedLayer: Math.max(0, Math.min(st.selectedLayer, keymap.layers.length - 1)),
        selectedKey: null,
        undoStack: [],
        redoStack: [],
        unsaved: true,
      }));
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ busy: false });
    }
  },

  moveLayer: async (from, to) => {
    const s = session();
    if (!s || from === to) return;
    set({ busy: true, lastError: null });
    try {
      const resp = await s.moveLayer(from, to);
      if (!resp.ok) {
        set({ lastError: `レイヤーを移動できません (code ${resp.err})` });
        return;
      }
      set({
        layers: resp.ok.layers,
        availableLayers: resp.ok.availableLayers,
        selectedLayer: to,
        selectedKey: null,
        undoStack: [],
        redoStack: [],
        unsaved: true,
      });
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ busy: false });
    }
  },

  renameLayer: async (index, name) => {
    const s = session();
    const layer = get().layers[index];
    if (!s || !layer) return;
    set({ busy: true, lastError: null });
    try {
      const resp = await s.setLayerProps(layer.id, name);
      if (resp !== RPC_OK) {
        set({ lastError: `レイヤー名を変更できません (code ${resp})` });
        return;
      }
      set((st) => ({
        layers: st.layers.map((l, i) => (i === index ? { ...l, name } : l)),
        unsaved: true,
      }));
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ busy: false });
    }
  },

  save: async () => {
    const s = session();
    if (!s) return;
    set({ busy: true, lastError: null });
    try {
      const resp = await s.saveChanges();
      if (!resp.ok) {
        set({ lastError: `保存に失敗しました (code ${resp.err})` });
        return;
      }
      set({ unsaved: false, undoStack: [], redoStack: [] });
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ busy: false });
    }
  },

  discard: async () => {
    const s = session();
    if (!s) return;
    set({ busy: true, lastError: null });
    try {
      await s.discardChanges();
      const keymap = await s.getKeymap();
      set({
        layers: keymap.layers,
        availableLayers: keymap.availableLayers,
        maxLayerNameLength: keymap.maxLayerNameLength,
        unsaved: false,
        undoStack: [],
        redoStack: [],
        selectedKey: null,
      });
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ busy: false });
    }
  },

  factoryReset: async () => {
    const s = session();
    if (!s) return;
    set({ busy: true, lastError: null });
    try {
      await s.resetSettings();
      await get().load(s);
    } catch (err) {
      set({ lastError: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ busy: false });
    }
  },

  describe: (binding) => {
    const { behaviors, layerName } = get();
    const behavior = binding ? behaviors[binding.behaviorId] : undefined;
    return formatBinding(binding, behavior, layerName);
  },

  layerName: (index) => {
    const layer = get().layers[index];
    if (layer?.name) return layer.name;
    return `Layer ${index}`;
  },
}));
