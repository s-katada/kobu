import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { KeyboardLayoutDef } from '../protocol/handshake';
import {
  encodeLM,
  encodeLT,
  encodeMO,
  encodeMT,
  encodeOSM,
  encodeWM,
  MOD_CTRL,
  MOD_SHIFT,
} from '../protocol/keycodes';
import { KeycodePicker } from './KeycodePicker';

const DEFINITION: KeyboardLayoutDef = {
  matrix: { rows: 4, cols: 10 },
  layouts: { keymap: [] },
  customKeycodes: [
    { name: 'BT0', title: 'Bluetooth Channel 0', shortName: 'BT0' },
    { name: 'BT1', title: 'Bluetooth Channel 1', shortName: 'BT1' },
  ],
};

function open(opts: { current?: number } = {}) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(
    <KeycodePicker
      definition={DEFINITION}
      layerCount={4}
      current={opts.current ?? 0x04}
      onPick={onPick}
      onClose={onClose}
    />,
  );
  return { onPick, onClose };
}

describe('KeycodePicker', () => {
  it('renders the dialog with the current keycode label', () => {
    open({ current: 0x04 });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/0x0004/)).toBeInTheDocument();
  });

  it('shows the Basic catalogue by default and picks A on click', async () => {
    const { onPick } = open();
    // Each picker cell renders { shortLabel, name } in two spans inside a <button>.
    // Find the button whose nested "A" short label is followed by the "A" name (basic letter A).
    const dialog = screen.getByRole('dialog');
    const cell = within(dialog)
      .getAllByRole('button')
      .find((btn) => {
        const spans = btn.querySelectorAll('span');
        return spans.length === 2 && spans[0]?.textContent === 'A' && spans[1]?.textContent === 'A';
      });
    if (!cell) throw new Error('A button not found');
    await userEvent.click(cell);
    expect(onPick).toHaveBeenCalledWith(0x04);
  });

  it('switches catalogue when a tab is clicked', async () => {
    open();
    await userEvent.click(screen.getByRole('button', { name: 'メディア' }));
    expect(screen.getByText('AudioMute')).toBeInTheDocument();
  });

  it('search filters across all categories', async () => {
    open();
    const input = screen.getByPlaceholderText('検索…');
    await userEvent.type(input, 'enter');
    // "Enter" (basic) should appear; non-matching keys should not.
    expect(screen.getByText('Enter')).toBeInTheDocument();
    expect(screen.queryByText('AudioMute')).not.toBeInTheDocument();
  });

  it('search matches via Japanese alias', async () => {
    open();
    const input = screen.getByPlaceholderText('検索…');
    await userEvent.type(input, 'ひらがな');
    // Intl2 has the "カタカナ／ひらがな" description.
    expect(screen.getByText('International2')).toBeInTheDocument();
  });

  it('selecting a User catalogue tab shows the customKeycode names', async () => {
    open();
    await userEvent.click(screen.getByRole('button', { name: 'ユーザ' }));
    // BT0 appears in both the shortLabel span and the name span — use getAllByText.
    expect(screen.getAllByText('BT0').length).toBeGreaterThan(0);
    expect(screen.getAllByText('BT1').length).toBeGreaterThan(0);
  });

  it('Tap/Hold tab → MO buttons emit the right encoded keycode', async () => {
    const { onPick } = open();
    await userEvent.click(screen.getByRole('button', { name: 'タップ/ホールド' }));
    // Each MO / TO / TG / DF / OSL layer button has a unique aria-label
    // built from its kind + layer number, so layer 2 of MO is exact.
    await userEvent.click(screen.getByRole('button', { name: 'MO(2)' }));
    expect(onPick).toHaveBeenCalledWith(encodeMO(2));
  });

  it('Tap/Hold tab → enabling Shift then clicking "OSM を割り当て" emits OSM(LS)', async () => {
    const { onPick } = open();
    await userEvent.click(screen.getByRole('button', { name: 'タップ/ホールド' }));
    await userEvent.click(screen.getByLabelText('Shift'));
    await userEvent.click(screen.getByRole('button', { name: 'OSM を割り当て' }));
    expect(onPick).toHaveBeenCalledWith(encodeOSM(MOD_SHIFT));
  });

  it('Tap/Hold tab → MT (ctrl + A) emits the right encoded keycode', async () => {
    const { onPick } = open();
    await userEvent.click(screen.getByRole('button', { name: 'タップ/ホールド' }));
    await userEvent.click(screen.getByLabelText('Ctrl'));
    await userEvent.click(screen.getByRole('button', { name: 'MT を割り当て' }));
    expect(onPick).toHaveBeenCalledWith(encodeMT(0x04, MOD_CTRL));
  });

  it('Tap/Hold tab → WM (shift + A) emits the right encoded keycode', async () => {
    const { onPick } = open();
    await userEvent.click(screen.getByRole('button', { name: 'タップ/ホールド' }));
    await userEvent.click(screen.getByLabelText('Shift'));
    await userEvent.click(screen.getByRole('button', { name: 'WM を割り当て' }));
    expect(onPick).toHaveBeenCalledWith(encodeWM(0x04, MOD_SHIFT));
  });

  it('Tap/Hold tab → LT(2, A) button emits encodeLT', async () => {
    const { onPick } = open();
    await userEvent.click(screen.getByRole('button', { name: 'タップ/ホールド' }));
    await userEvent.click(screen.getByRole('button', { name: 'LT(2, キー)' }));
    expect(onPick).toHaveBeenCalledWith(encodeLT(2, 0x04));
  });

  it('Tap/Hold tab → LM(N) requires a modifier and emits encodeLM', async () => {
    const { onPick } = open();
    await userEvent.click(screen.getByRole('button', { name: 'タップ/ホールド' }));
    // Without modifier, LM(N) is disabled.
    expect(screen.getByRole('button', { name: 'LM(1)' })).toBeDisabled();
    await userEvent.click(screen.getByLabelText('Ctrl'));
    await userEvent.click(screen.getByRole('button', { name: 'LM(1)' }));
    expect(onPick).toHaveBeenCalledWith(encodeLM(1, MOD_CTRL));
  });

  it('shows an empty-state message when search has no results', async () => {
    open();
    await userEvent.type(screen.getByPlaceholderText('検索…'), 'zzzzzz');
    expect(screen.getByText('該当するキーコードがありません。')).toBeInTheDocument();
  });

  it('clicking the close button invokes onClose', async () => {
    const { onClose } = open();
    await userEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the backdrop invokes onClose', async () => {
    const { onClose } = open();
    const backdrop = screen.getByRole('dialog');
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape on the backdrop invokes onClose', () => {
    const { onClose } = open();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
