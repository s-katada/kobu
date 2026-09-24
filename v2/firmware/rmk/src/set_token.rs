//! Per-keyboard-set identity for the classic (left=central) topology.
//!
//! Same wire format as the dongle topology's `../dongle/src/set_token.rs`:
//! a nonzero token in the split undirected advertisement so two physical
//! kobu2 sets cannot cross-pair during fresh pairing / bond loss. Bonded
//! pairs already use directed advertising and are independent; the token
//! closes the undirected window that made "both sets powered → もっさり /
//! layers dead" happen when a half fell back to scanning.
//!
//! Build the SECOND set with `--features set-2` (token 0x42, BLE name
//! `kobu2 squid`, USB/BLE PID 0x425B). Default builds are set 1 (token 0x41,
//! name `kobu2 octopus`, PID 0x425A). Flash BOTH halves of a set with the same
//! feature, then clear_storage once so they re-pair under the new token.
//!
//! Tokens stay clear of the dongle topology's 0x4B ('K') so a classic set
//! and a dongle set never cross-pair either.

use rmk::config::RmkConfig;

/// Set 1 (default). 0x41 = 'A'.
#[cfg(not(feature = "set-2"))]
pub const SPLIT_SET_TOKEN: u8 = 0x41;
/// Set 2. 0x42 = 'B'.
#[cfg(feature = "set-2")]
pub const SPLIT_SET_TOKEN: u8 = 0x42;

#[cfg(not(feature = "set-2"))]
#[allow(dead_code)] // central applies these; peripheral only needs the split token
pub const HOST_PRODUCT_NAME: &str = "kobu2 octopus";
#[cfg(feature = "set-2")]
#[allow(dead_code)]
pub const HOST_PRODUCT_NAME: &str = "kobu2 squid";

#[cfg(not(feature = "set-2"))]
#[allow(dead_code)]
pub const HOST_PRODUCT_ID: u16 = 0x425A;
#[cfg(feature = "set-2")]
#[allow(dead_code)]
pub const HOST_PRODUCT_ID: u16 = 0x425B;

/// Store the token into the patched-rmk atomic. Call once at boot, before
/// the split machinery starts advertising or scanning.
pub fn apply_split_set_token() {
    rmk::input_device::battery::KOBU_SPLIT_SET_TOKEN
        .store(SPLIT_SET_TOKEN, core::sync::atomic::Ordering::Relaxed);
}

/// Override the host-facing BLE/USB identity for this set so macOS lists
/// two keyboards as distinct devices (`kobu2 octopus` vs `kobu2 squid`)
/// instead of two identical `kobu2` entries fighting over the same bond
/// profile.
///
/// Central-only: the peripheral binary links this module for the split
/// token but never talks to the Mac.
#[allow(dead_code)]
pub fn apply_host_identity(rmk_config: &mut RmkConfig<'_>) {
    rmk_config.device_config.product_name = HOST_PRODUCT_NAME;
    rmk_config.device_config.pid = HOST_PRODUCT_ID;
}
