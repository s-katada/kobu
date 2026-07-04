/* nRF52840 with Adafruit UF2 bootloader (as shipped on Seeed XIAO nRF52840).
 *
 * Flash layout (must stay in sync with [storage] in keyboard.toml):
 *   0x000000..0x001000 (   4 KiB)  MBR
 *   0x001000..0x0A0000 ( 636 KiB)  app code  ← FLASH region declared below
 *   0x0A0000..0x0C0000 ( 128 KiB)  RMK storage (keymap + bonds + Vial state)
 *   0x0C0000..0x0F4000 ( 208 KiB)  unused / bootloader settings
 *   0x0F4000..0x100000 (  48 KiB)  Adafruit UF2 bootloader
 *
 * FLASH LENGTH is capped at 0x9F000 (636 KiB = 0xA0000 - 0x1000) so the
 * linker will refuse to place app code into the RMK storage window.
 * Without this cap the linker thinks 1020 KiB are available and would
 * happily overwrite stored keymap data once the binary grows.
 */
MEMORY
{
  FLASH : ORIGIN = 0x00001000, LENGTH = 636K
  RAM : ORIGIN = 0x20000008, LENGTH = 255K

  /* Raw nRF52840 (no bootloader, no RMK storage):                 */
  /* FLASH : ORIGIN = 0x00000000, LENGTH = 1024K                   */
  /* RAM   : ORIGIN = 0x20000000, LENGTH = 256K                    */
}
