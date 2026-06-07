/**
 * Categorized keycode picker.
 *
 * The body (`PickerBody`) is reused by:
 *   * `KeycodePicker` — a modal dialog used by Macro / Combo / Morse
 *     editors that need an ad-hoc keycode selector
 *   * `KeycodeDock` — the persistent inline dock used by the main
 *     keymap editor
 *
 * Categories follow the layout from issue #31 — Basic / Mods / Special
 * / Function / Media / System / Mouse / Layer / User / Other — with a
 * "Tap/Hold" tab that builds the parametric encodings (MT / LT / MO /
 * TG / TO / DF / OSL / OSM / WM / LM).
 *
 * Search is a single text input that scores against name, label,
 * description, and aliases across the active catalogue. A naive
 * scorer is good enough for ~300 keycodes — there is no perceivable
 * filter latency.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardLayoutDef } from '../protocol/handshake';
import {
  BASE_CATALOGUE,
  buildModBits,
  type Category,
  encodeDF,
  encodeLM,
  encodeLT,
  encodeMO,
  encodeMT,
  encodeNo,
  encodeOSL,
  encodeOSM,
  encodeTG,
  encodeTO,
  encodeTransparent,
  encodeWM,
  type KeycodeMeta,
  labelForKeycode,
  searchCatalogue,
  userCatalogue,
} from '../protocol/keycodes';

export interface KeycodePickerProps {
  definition: KeyboardLayoutDef;
  layerCount: number;
  /** Currently assigned keycode (used to preview "what's there now"). */
  current: number;
  onPick: (keycode: number) => void;
  onClose: () => void;
}

type Tab = Category | 'tap-hold';

const TAB_ORDER: { id: Tab; label: string }[] = [
  { id: 'basic', label: '基本' },
  { id: 'modifier', label: '修飾' },
  { id: 'special', label: '特殊' },
  { id: 'function', label: 'ファンクション' },
  { id: 'media', label: 'メディア' },
  { id: 'system', label: 'システム' },
  { id: 'mouse', label: 'マウス' },
  { id: 'layer', label: 'レイヤー' },
  { id: 'user', label: 'ユーザ' },
  { id: 'other', label: 'その他' },
  { id: 'tap-hold', label: 'タップ/ホールド' },
];

export function KeycodePicker({
  definition,
  layerCount,
  current,
  onPick,
  onClose,
}: KeycodePickerProps) {
  const currentLabel = labelForKeycode(current, { definition });

  // Modal focus management: focus the search box on open and restore focus to
  // whatever opened the dialog on close, so keyboard users aren't dropped at
  // the top of the document.
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const search = dialogRef.current?.querySelector<HTMLInputElement>('input[type="search"]');
    search?.focus();
    return () => opener?.focus?.();
  }, []);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="キーコードを選択"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="document"
        className="w-full max-w-4xl max-h-[90vh] overflow-y-auto bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 rounded-lg shadow-xl border border-zinc-200 dark:border-zinc-800"
      >
        <header className="flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">キーコードを選択</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              現在の割り当て: <span className="font-mono">{currentLabel.long}</span>（0x
              {current.toString(16).padStart(4, '0')}）
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            閉じる
          </button>
        </header>
        <PickerBody
          definition={definition}
          layerCount={layerCount}
          onPick={onPick}
          maxHeight="60vh"
        />
      </div>
    </div>
  );
}

export interface PickerBodyProps {
  definition: KeyboardLayoutDef;
  layerCount: number;
  onPick: (keycode: number) => void;
  /** When omitted, body fills its parent. */
  maxHeight?: string;
}

/**
 * The shared picker chrome: tab bar + search + key grid (or tap-hold
 * builder). Pure controlled component over `onPick`. Owns its own tab
 * state but exposes nothing else.
 */
export function PickerBody({ definition, layerCount, onPick, maxHeight }: PickerBodyProps) {
  const [tab, setTab] = useState<Tab>('basic');
  const [query, setQuery] = useState('');

  const users = useMemo(() => userCatalogue(definition), [definition]);

  const catalogueByCategory = useMemo(() => {
    const groups = new Map<Category, KeycodeMeta[]>();
    for (const meta of BASE_CATALOGUE) {
      const list = groups.get(meta.category) ?? [];
      list.push(meta);
      groups.set(meta.category, list);
    }
    return groups;
  }, []);

  const activeList: KeycodeMeta[] = useMemo(() => {
    if (tab === 'tap-hold') return [];
    if (tab === 'user') return users.slice();
    return catalogueByCategory.get(tab) ?? [];
  }, [tab, users, catalogueByCategory]);

  const hits = useMemo(() => {
    if (!query) return activeList;
    const corpus = tab === 'user' ? users : [...BASE_CATALOGUE, ...users];
    return searchCatalogue(corpus, query).map((h) => h.meta);
  }, [query, activeList, tab, users]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-2.5 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-950/30">
        {TAB_ORDER.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            aria-pressed={tab === t.id}
            className={[
              'rounded-full px-3 py-1 text-xs font-medium transition-colors',
              tab === t.id
                ? 'bg-zinc-900 dark:bg-zinc-100 text-zinc-50 dark:text-zinc-900'
                : 'text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => onPick(encodeNo())}
            className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-[11px] font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            title="このキーを無効化（KC_NO）"
          >
            無効
          </button>
          <button
            type="button"
            onClick={() => onPick(encodeTransparent())}
            className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-[11px] font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            title="透過（下のレイヤーから引き継ぐ）"
          >
            透過 ▽
          </button>
          <div className="relative">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="検索…"
              className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 pl-7 pr-3 py-1 text-sm w-52 focus:outline-none focus:ring-2 focus:ring-sky-400"
            />
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-500 pointer-events-none">
              <SearchIcon />
            </span>
          </div>
        </div>
      </div>

      <div className="overflow-y-auto p-3" style={maxHeight ? { maxHeight } : undefined}>
        {tab === 'tap-hold' && !query ? (
          <TapHoldEditor layerCount={layerCount} definition={definition} onPick={onPick} />
        ) : (
          <KeyGrid items={hits} onPick={onPick} definition={definition} />
        )}
      </div>
    </>
  );
}

function SearchIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="検索"
    >
      <title>検索</title>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

interface KeyGridProps {
  items: KeycodeMeta[];
  onPick: (kc: number) => void;
  definition: KeyboardLayoutDef;
}

function KeyGrid({ items, onPick, definition }: KeyGridProps) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400 py-6 text-center">
        該当するキーコードがありません。
      </p>
    );
  }
  return (
    <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-8 md:grid-cols-10 lg:grid-cols-12">
      {items.map((meta) => {
        const label = labelForKeycode(meta.code, { definition });
        return (
          <button
            key={meta.code}
            type="button"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', String(meta.code));
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => onPick(meta.code)}
            title={meta.description}
            aria-label={label.long}
            className={[
              'group h-14 rounded-md border text-xs font-medium flex flex-col items-center justify-center px-1 text-center',
              'transition-[transform,box-shadow,background-color] duration-100',
              'shadow-sm hover:-translate-y-px hover:shadow-md',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
              gridTone(label.tone),
            ].join(' ')}
          >
            <span className="font-mono leading-none truncate w-full">{meta.shortLabel}</span>
            <span className="mt-1 text-[10px] text-zinc-500 dark:text-zinc-400 line-clamp-1 leading-none">
              {meta.name}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function gridTone(tone: ReturnType<typeof labelForKeycode>['tone']): string {
  switch (tone) {
    case 'muted':
      return 'bg-zinc-50 dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800';
    case 'layer':
      return 'bg-indigo-50 dark:bg-indigo-950/60 border-indigo-200 dark:border-indigo-900';
    case 'mod':
      return 'bg-violet-50 dark:bg-violet-950/60 border-violet-200 dark:border-violet-900';
    case 'user':
      return 'bg-amber-50 dark:bg-amber-950/50 border-amber-200 dark:border-amber-900';
    case 'mouse':
      return 'bg-emerald-50 dark:bg-emerald-950/60 border-emerald-200 dark:border-emerald-900';
    case 'media':
      return 'bg-rose-50 dark:bg-rose-950/60 border-rose-200 dark:border-rose-900';
    case 'other':
      return 'bg-zinc-100 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700';
    default:
      return 'bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-750';
  }
}

interface TapHoldEditorProps {
  layerCount: number;
  definition: KeyboardLayoutDef;
  onPick: (kc: number) => void;
}

function TapHoldEditor({ layerCount, onPick }: TapHoldEditorProps) {
  const [tapKey, setTapKey] = useState<number>(0x04); // default to "A"
  const [ctrl, setCtrl] = useState(false);
  const [shift, setShift] = useState(false);
  const [alt, setAlt] = useState(false);
  const [gui, setGui] = useState(false);
  const [right, setRight] = useState(false);

  const mod = buildModBits({ ctrl, shift, alt, gui, right });

  const baseKeys = useMemo(
    () => BASE_CATALOGUE.filter((k) => k.code >= 0x04 && k.code <= 0xff),
    [],
  );

  return (
    <div className="space-y-5 text-sm">
      <section className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h3 className="font-semibold text-zinc-700 dark:text-zinc-200">レイヤー切替</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            ボタンを押すと選択中のセルに割り当てます。
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {(
            [
              { kind: 'MO', desc: '押している間だけ' },
              { kind: 'TO', desc: '切替（戻らない）' },
              { kind: 'TG', desc: 'トグル' },
              { kind: 'DF', desc: '既定レイヤー' },
              { kind: 'OSL', desc: '次の1キーだけ' },
            ] as const
          ).map(({ kind, desc }) => (
            <div key={kind} className="space-y-1">
              <div>
                <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  {kind}(レイヤー)
                </p>
                <p className="text-[10px] text-zinc-500 dark:text-zinc-400">{desc}</p>
              </div>
              <div className="flex flex-wrap gap-1">
                {Array.from({ length: layerCount }, (_, n) => {
                  const layerKey = `${kind}-layer-${n}`;
                  return (
                    <button
                      key={layerKey}
                      type="button"
                      aria-label={`${kind}(${n})`}
                      onClick={() => onPick(encodeFor(kind, n))}
                      className="rounded border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/60 px-2 py-0.5 text-xs font-medium text-indigo-800 dark:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-900"
                    >
                      L{n}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="font-semibold text-zinc-700 dark:text-zinc-200">修飾キーの選択</h3>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {(
            [
              ['Ctrl', ctrl, setCtrl],
              ['Shift', shift, setShift],
              ['Alt', alt, setAlt],
              ['GUI', gui, setGui],
            ] as const
          ).map(([labelText, value, set]) => (
            <label
              key={labelText}
              className={[
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium border cursor-pointer transition-colors select-none',
                value
                  ? 'bg-violet-600 text-white border-violet-600'
                  : 'bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800',
              ].join(' ')}
            >
              <input
                type="checkbox"
                checked={value}
                onChange={(e) => set(e.target.checked)}
                className="sr-only"
              />
              {labelText}
            </label>
          ))}
          <label
            className={[
              'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium border cursor-pointer transition-colors select-none',
              right
                ? 'bg-zinc-800 text-white border-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100'
                : 'bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 border-zinc-300 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800',
            ].join(' ')}
            title="右側修飾キー"
          >
            <input
              type="checkbox"
              checked={right}
              onChange={(e) => setRight(e.target.checked)}
              className="sr-only"
            />
            右側
          </label>
          <button
            type="button"
            onClick={() => onPick(encodeOSM(mod))}
            disabled={mod === 0}
            className="ml-1 rounded-md bg-violet-100 dark:bg-violet-900/40 text-violet-800 dark:text-violet-200 border border-violet-300 dark:border-violet-800 px-2.5 py-1 font-medium hover:bg-violet-200 dark:hover:bg-violet-900 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            OSM を割り当て
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="font-semibold text-zinc-700 dark:text-zinc-200">
          ベースキー <span className="text-xs font-normal text-zinc-500">(LT / MT / WM 用)</span>
        </h3>
        <select
          value={tapKey}
          onChange={(e) => setTapKey(Number(e.target.value))}
          className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm"
        >
          {baseKeys.map((k) => (
            <option key={k.code} value={k.code}>
              {k.name}
            </option>
          ))}
        </select>
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 p-3 space-y-2 bg-zinc-50/50 dark:bg-zinc-900/40">
          <h4 className="font-semibold text-zinc-700 dark:text-zinc-200">
            LT(レイヤー, キー) <span className="text-xs font-normal">— レイヤータップ</span>
          </h4>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            タップでベースキー、長押しでレイヤー切替。
          </p>
          <div className="flex flex-wrap gap-1">
            {Array.from({ length: layerCount }, (_, n) => {
              const ltKey = `lt-${n}`;
              return (
                <button
                  key={ltKey}
                  type="button"
                  aria-label={`LT(${n}, キー)`}
                  onClick={() => onPick(encodeLT(n, tapKey))}
                  className="rounded border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/60 px-2 py-0.5 text-xs font-medium text-indigo-800 dark:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-900"
                >
                  L{n}
                </button>
              );
            })}
          </div>
        </div>

        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 p-3 space-y-2 bg-zinc-50/50 dark:bg-zinc-900/40">
          <h4 className="font-semibold text-zinc-700 dark:text-zinc-200">
            MT(キー, 修飾) <span className="text-xs font-normal">— モッドタップ</span>
          </h4>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            タップでベースキー、長押しで修飾キー。
          </p>
          <button
            type="button"
            onClick={() => onPick(encodeMT(tapKey, mod))}
            disabled={mod === 0}
            className="rounded-md bg-violet-100 dark:bg-violet-900/40 text-violet-800 dark:text-violet-200 border border-violet-300 dark:border-violet-800 px-3 py-1 text-xs font-medium hover:bg-violet-200 dark:hover:bg-violet-900 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            MT を割り当て
          </button>
        </div>

        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 p-3 space-y-2 bg-zinc-50/50 dark:bg-zinc-900/40">
          <h4 className="font-semibold text-zinc-700 dark:text-zinc-200">
            WM(キー, 修飾) <span className="text-xs font-normal">— 修飾キー付き</span>
          </h4>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            ベースキーを修飾キー付きで1キーとして出力。
          </p>
          <button
            type="button"
            onClick={() => onPick(encodeWM(tapKey, mod))}
            disabled={mod === 0}
            className="rounded-md bg-violet-100 dark:bg-violet-900/40 text-violet-800 dark:text-violet-200 border border-violet-300 dark:border-violet-800 px-3 py-1 text-xs font-medium hover:bg-violet-200 dark:hover:bg-violet-900 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            WM を割り当て
          </button>
        </div>

        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 p-3 space-y-2 bg-zinc-50/50 dark:bg-zinc-900/40">
          <h4 className="font-semibold text-zinc-700 dark:text-zinc-200">
            LM(レイヤー, 修飾) <span className="text-xs font-normal">— レイヤー＋修飾</span>
          </h4>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            押している間、レイヤーと修飾を同時に有効化。
          </p>
          <div className="flex flex-wrap gap-1">
            {Array.from({ length: layerCount }, (_, n) => {
              const lmKey = `lm-${n}`;
              return (
                <button
                  key={lmKey}
                  type="button"
                  aria-label={`LM(${n})`}
                  disabled={mod === 0}
                  onClick={() => onPick(encodeLM(n, mod))}
                  className="rounded border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/60 px-2 py-0.5 text-xs font-medium text-indigo-800 dark:text-indigo-200 hover:bg-indigo-100 dark:hover:bg-indigo-900 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  L{n}
                </button>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}

function encodeFor(kind: 'MO' | 'TO' | 'TG' | 'DF' | 'OSL', layer: number): number {
  switch (kind) {
    case 'MO':
      return encodeMO(layer);
    case 'TO':
      return encodeTO(layer);
    case 'TG':
      return encodeTG(layer);
    case 'DF':
      return encodeDF(layer);
    case 'OSL':
      return encodeOSL(layer);
  }
}
