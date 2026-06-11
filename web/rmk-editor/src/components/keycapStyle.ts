/**
 * キーキャップ描画の共有スタイルヘルパー。
 *
 * `KeymapView`（グリッドビュー）と `PhysicalKeymapView`（実機イラスト
 * ビュー）の両方が同じ `KeyLabel` → Tailwind クラスのマッピングを使う
 * ことで、トーン（レイヤー / 修飾 / マウス…）の見た目が二つのビューで
 * ずれないようにする。
 */

import type { KeyLabel } from '../protocol/keycodes';

/** `center` ラベル文字数に応じたフォントサイズ。 */
export function centerSize(text: string): string {
  if (text.length <= 1) return 'text-lg';
  if (text.length <= 2) return 'text-base';
  if (text.length <= 4) return 'text-sm';
  if (text.length <= 6) return 'text-xs';
  return 'text-[10px]';
}

/** キーキャップ本体の塗り・枠クラス。 */
export function cellTone(tone: KeyLabel['tone']): string {
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
      return 'bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700';
  }
}

/** 上部バッジ（ホールド側アクション等）の文字色クラス。 */
export function accentText(accent: KeyLabel['accent']): string {
  switch (accent) {
    case 'mod':
      return 'text-violet-700 dark:text-violet-300';
    case 'layer':
      return 'text-indigo-700 dark:text-indigo-300';
    case 'tap-hold':
      return 'text-sky-700 dark:text-sky-300';
    case 'special':
      return 'text-zinc-600 dark:text-zinc-400';
    default:
      return 'text-zinc-500 dark:text-zinc-400';
  }
}
