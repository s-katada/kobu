//! Kobu-specific runtime-tunable config.
//!
//! Read helpers that the `trackball` and `status_led` modules call on
//! every event. The atomic singletons themselves live in
//! `rmk::input_device::battery::KOBU_*` so the patched Via
//! `CustomGetValue` / `CustomSetValue` handlers (see
//! `firmware/build.rs::patch_rmk_via_custom_*`) can read/write them
//! without reaching across crate boundaries. This module is a thin
//! façade that:
//!
//!   * keeps the consumer-side API stable (`config::scroll_throttle()`
//!     returns a `Duration`, etc.)
//!   * lets a single import path (`rmk::input_device::battery::KOBU_*`)
//!     bridge the host control plane (Via Custom Channel 0xC0) and the
//!     event hot path (trackball, status LED) — atomics are lock-free
//!     reads on every event
//!
//! ## Persistence
//!
//! Values are *not* persisted across reboots. Every boot reloads the
//! defaults baked into the static initialisers (which must match
//! `KobuSettings::default()` below). Persistence is a follow-up that
//! would hook RMK's `sequential-storage` plumbing.

use core::sync::atomic::Ordering;

use embassy_time::Duration;
use rmk::input_device::battery::{
    KOBU_SCROLL_INVERT_X, KOBU_SCROLL_INVERT_Y, KOBU_SCROLL_THROTTLE_MS,
    KOBU_STATUS_LED_BAT_HIGH, KOBU_STATUS_LED_BAT_LOW, KOBU_STATUS_LED_PURPLE_HOLD_MS,
    KOBU_TRACKBALL_CPI,
};

/// Ordering used for all reads / writes here. `Relaxed` is correct
/// because:
///   * readers don't need cross-field consistency
///   * writers don't establish a happens-before with anything other
///     than their own subsequent read by the same writer
///   * we're on an ARMv7-EM core where every aligned 8/16-bit store
///     is atomic at the hardware level regardless
const ORD: Ordering = Ordering::Relaxed;

/// Logical schema for kobu's tunable runtime config. The wire IDs
/// match the table in issue #39 so the host-side handler can
/// reuse them verbatim.
///
/// `dead_code` because `apply()` is now the responsibility of the
/// patched RMK CustomSetValue handler — this struct remains as a
/// declarative reference (and a place to anchor the `Default::default()`
/// values that the atomic initialisers must match).
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KobuSettings {
    /// PMW3610 effective CPI. Treated as a 1.0× multiplier of the
    /// reported delta — the chip's internal CPI register is set
    /// elsewhere (board-level) and we tune the perceived sensitivity
    /// in software.
    pub trackball_cpi: u16,
    /// Minimum delay between consecutive scroll reports, in ms. 0
    /// disables throttling. Useful for users who want slower wheel
    /// scrolling than the trackball's native sample rate produces.
    pub scroll_throttle_ms: u8,
    pub scroll_invert_x: bool,
    pub scroll_invert_y: bool,
    /// How long the status LED stays purple after a peripheral
    /// trackball event. `0` disables the purple hold (LED stays on
    /// the battery / VBUS colour).
    pub status_led_purple_hold_ms: u16,
    /// Battery percentage above which the LED is green. Must be
    /// > `low_threshold`.
    pub status_led_battery_high_threshold: u8,
    /// Battery percentage at or below which the LED is red. Must be
    /// < `high_threshold`.
    pub status_led_battery_low_threshold: u8,
}

impl Default for KobuSettings {
    /// Defaults preserve the previously-hardcoded behaviour:
    ///
    ///   * 1× CPI multiplier (= PMW3610 native)
    ///   * no scroll throttling, no axis invert
    ///   * 200 ms purple hold
    ///   * battery thresholds 60% / 20%
    ///
    /// **These must match the static initialisers in
    /// `rmk::input_device::battery::KOBU_*`** — see the
    /// `patch_rmk_kobu_settings_atomics` injection in `build.rs`.
    fn default() -> Self {
        Self {
            trackball_cpi: 1000,
            scroll_throttle_ms: 0,
            scroll_invert_x: false,
            scroll_invert_y: false,
            status_led_purple_hold_ms: 200,
            status_led_battery_high_threshold: 60,
            status_led_battery_low_threshold: 20,
        }
    }
}

// ─── Read helpers (hot path) ───────────────────────────────────────

/// Live pointer-CPI multiplier (1000 = 1.0×). Read on every pointer
/// flush in `trackball.rs::run_pointer_flush`; tunable at runtime from
/// kobu-config via Via Custom Channel 0xC0 id 0x01.
pub fn trackball_cpi() -> u16 {
    KOBU_TRACKBALL_CPI.load(ORD)
}

pub fn scroll_throttle() -> Duration {
    Duration::from_millis(KOBU_SCROLL_THROTTLE_MS.load(ORD) as u64)
}

pub fn scroll_invert_x() -> bool {
    KOBU_SCROLL_INVERT_X.load(ORD)
}

pub fn scroll_invert_y() -> bool {
    KOBU_SCROLL_INVERT_Y.load(ORD)
}

pub fn status_led_purple_hold() -> Duration {
    Duration::from_millis(KOBU_STATUS_LED_PURPLE_HOLD_MS.load(ORD) as u64)
}

pub fn status_led_battery_high_threshold() -> u8 {
    KOBU_STATUS_LED_BAT_HIGH.load(ORD)
}

pub fn status_led_battery_low_threshold() -> u8 {
    KOBU_STATUS_LED_BAT_LOW.load(ORD)
}
