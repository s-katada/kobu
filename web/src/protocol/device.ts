/**
 * Device-level commands that aren't tied to a particular sub-system
 * (keymap, macros, lighting). Right now there's just the bootloader
 * jump, but anything that simply rebooots / mode-switches the firmware
 * belongs here.
 */

import { emptyPacket, TransportError, type VialPacket } from '../transport/types';
import type { WebHidTransport } from '../transport/webhid';
import { buildBootloaderJump, ViaCommand } from './commands';
import { KOBU_CHANNEL } from './customValue';

/** kobu Custom Value id 0x12 — write-only trigger: peripheral bootloader jump. */
const KOBU_PERIPHERAL_BOOTLOADER_JUMP_ID = 0x12;

/**
 * Build the Vial `CustomSetValue` packet that asks the central firmware
 * to relay a `SplitMessage::PeripheralBootloaderJump` to the peripheral
 * half over the BLE split link. See
 * `firmware/build.rs::patch_rmk_peripheral_bootloader_jump` for the
 * full relay path.
 */
function buildPeripheralBootloaderJump(): VialPacket {
  const p = emptyPacket();
  p[0] = ViaCommand.CustomSetValue;
  p[1] = KOBU_CHANNEL;
  p[2] = KOBU_PERIPHERAL_BOOTLOADER_JUMP_ID;
  p[3] = 0x01;
  return p;
}

/**
 * Ask the firmware to reboot into UF2 mass-storage bootloader mode.
 *
 * The firmware reboots immediately on receiving this packet so the HID
 * endpoint disappears before any reply can come back. Both the send
 * itself and the reply timeout are treated as success — anything else
 * is a genuine error worth surfacing.
 */
export async function enterBootloader(transport: WebHidTransport): Promise<void> {
  try {
    await transport.sendAndReceive(buildBootloaderJump());
  } catch (err) {
    if (
      err instanceof TransportError &&
      (err.kind === 'receive-timeout' || err.kind === 'send-failed' || err.kind === 'disconnected')
    ) {
      // Expected — firmware rebooted before it could ack the command.
      return;
    }
    throw err;
  }
}

/**
 * Ask the central firmware to relay a bootloader-jump command to the
 * peripheral half over the BLE split link. Both sides must be flashed
 * with kobu firmware ≥ the commit that ships the
 * `patch_rmk_peripheral_bootloader_jump` relay (see
 * `firmware/build.rs`). Returns once the central has ack'd the Vial
 * write — by then the central has already published the
 * `PeripheralBootloaderJump` controller event, so the peripheral will
 * reboot into UF2 mode within a few hundred ms once the split link
 * carries the message.
 *
 * Unlike the central path this does *not* tear down the central's HID
 * endpoint, so we get a real ack and don't have to absorb a transport
 * timeout.
 */
export async function enterPeripheralBootloader(transport: WebHidTransport): Promise<void> {
  await transport.sendAndReceive(buildPeripheralBootloaderJump());
}
