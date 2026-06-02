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

use embassy_nrf::pac;
use embassy_time::Duration;
use rmk::input_device::battery::{
    KOBU_HOST_CONN_INTERVAL_US, KOBU_HOST_CONNECTED, KOBU_LAST_KEY_TICKS, KOBU_MOUSE_BUTTONS,
    KOBU_SCROLL_INVERT_X, KOBU_SCROLL_INVERT_Y, KOBU_SCROLL_THROTTLE_MS, KOBU_STATUS_LED_BAT_HIGH,
    KOBU_STATUS_LED_BAT_LOW, KOBU_STATUS_LED_PURPLE_HOLD_MS, KOBU_TRACKBALL_CPI,
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

/// embassy-time tick (32768 Hz base) of the most recent key press, stamped by
/// the patched RMK keyboard funnel. Read by `trackball.rs::run_auto_mouse_layer`
/// for "require prior idle": auto-mouse activation is suppressed for a short
/// window after any keypress, so typing vibration on the trackball cannot
/// false-trigger the mouse layer. Returns 0 until the first key is pressed.
pub fn last_key_ticks() -> u32 {
    KOBU_LAST_KEY_TICKS.load(ORD)
}

/// True once the HOST (Mac) BLE link is encrypted, false on disconnect. Set
/// from the patched `gatt_events_task` (see `build.rs::patch_rmk_set_host_connected`).
/// Read by `trackball.rs::run_auto_mouse_layer` to keep the auto-mouse layer —
/// the only trackball-driven emitter of a layer-change split write — OFF during
/// the host connect+encryption bring-up window.
pub fn host_connected() -> bool {
    KOBU_HOST_CONNECTED.load(ORD)
}

/// True when the nRF52840 POWER peripheral reports VBUS present (USB cable
/// supplying power). Used by `trackball.rs::run_input_gate_central` as the
/// USB-side "host ready" condition so the input gate (boot-trackball wedge fix)
/// opens at boot on USB instead of waiting for a BLE encryption that never
/// happens. Mirrors `status_led.rs::vbus_present`.
pub fn vbus_present() -> bool {
    pac::POWER.usbregstatus().read().vbusdetect()
}

/// Live HID mouse-button bitfield, mirrored from rmk's `send_mouse_report`
/// (see `build.rs::patch_rmk_capture_mouse_buttons`). OR'd into the trackball
/// motion/scroll reports so moving the ball while a button is held does not
/// send `buttons: 0` and release a drag/selection.
pub fn mouse_buttons() -> u8 {
    KOBU_MOUSE_BUTTONS.load(ORD)
}

pub fn scroll_throttle() -> Duration {
    Duration::from_millis(KOBU_SCROLL_THROTTLE_MS.load(ORD) as u64)
}

pub fn scroll_invert_x() -> bool {
    KOBU_SCROLL_INVERT_X.load(ORD)
}

// Retained for API symmetry and the kobu-config wire schema (Via Custom
// Channel 0xC0 id 0x04 / web SPA still read & write KOBU_SCROLL_INVERT_Y).
// The scroll path itself no longer uses the vertical axis — ScrollProcessor
// drives the wheel from the horizontal roll only — so this helper currently
// has no firmware-side reader.
#[allow(dead_code)]
pub fn scroll_invert_y() -> bool {
    KOBU_SCROLL_INVERT_Y.load(ORD)
}

// Retained for the kobu-config wire schema (Via Custom Channel 0xC0 id 0x05 /
// web SPA still read & write KOBU_STATUS_LED_PURPLE_HOLD_MS). The status LED is
// now driven by layer state (see src/status_led.rs), not a peripheral-activity
// purple hold, so this helper currently has no firmware-side reader.
#[allow(dead_code)]
pub fn status_led_purple_hold() -> Duration {
    Duration::from_millis(KOBU_STATUS_LED_PURPLE_HOLD_MS.load(ORD) as u64)
}

pub fn status_led_battery_high_threshold() -> u8 {
    KOBU_STATUS_LED_BAT_HIGH.load(ORD)
}

pub fn status_led_battery_low_threshold() -> u8 {
    KOBU_STATUS_LED_BAT_LOW.load(ORD)
}

// ─── Connection-interval diagnostic (feature `led-conn-diag`) ────────
//
// Temporary on-device diagnostic for the pointer-のろのろ investigation. With
// the feature on, the status LED (src/status_led.rs) shows the live macOS host
// BLE connection interval as a color band and flashes white when pointer travel
// is clamp-dropped, so the user can read — during a のろのろ moment — whether the
// host link is slow (purple/red) or motion is being dropped at a fast link
// (white over green/blue). These helpers are always defined (the diag call
// sites are `if cfg!(feature = "led-conn-diag")`-gated and eliminated from the
// normal build), so the firmware compiles identically with or without it.

/// Live macOS host BLE connection interval in microseconds (0 until the first
/// ConnectionParamsUpdated). Mirrors rmk's atomic populated by the patched gatt
/// task on every conn-param change. Read by the LED diagnostic band.
/// `allow(dead_code)`: only referenced under `cfg!(feature = "led-conn-diag")`.
#[allow(dead_code)]
pub fn host_conn_interval_us() -> u32 {
    KOBU_HOST_CONN_INTERVAL_US.load(ORD)
}

/// Diagnostic clamp-drop counter — incremented by `trackball.rs` each time
/// accumulated pointer travel exceeds the backlog ceiling (MAX_PENDING_MILLI)
/// and is about to be clamp-dropped (the under-travel that may cause のろのろ).
#[allow(dead_code)]
pub static KOBU_MOTION_DROPPED: core::sync::atomic::AtomicU32 =
    core::sync::atomic::AtomicU32::new(0);

/// Note one clamp-drop of pointer travel (diagnostic; called from trackball.rs).
#[allow(dead_code)]
pub fn note_motion_dropped() {
    KOBU_MOTION_DROPPED.fetch_add(1, ORD);
}

/// Read-and-reset the diagnostic clamp-drop counter. The status LED calls this
/// each 50 ms tick; a non-zero result flashes the LED white for that tick.
#[allow(dead_code)]
pub fn take_motion_dropped() -> u32 {
    KOBU_MOTION_DROPPED.swap(0, ORD)
}

/// Diagnostic split-sample ARRIVAL counter — incremented in trackball.rs
/// PointerProcessor::process on every peripheral Joystick(X/Y) event that
/// REACHES the central, independent of the emit gate. The status LED windows it
/// into a samples/sec rate so a のろのろ caused by the SPLIT link starving the
/// central of pointer samples shows up as a low rate (the host-interval band
/// could not see it). Only used under `led-conn-diag`.
#[allow(dead_code)]
pub static KOBU_POINTER_SAMPLES: core::sync::atomic::AtomicU32 =
    core::sync::atomic::AtomicU32::new(0);

/// Note one pointer sample arriving at the central (diagnostic).
#[allow(dead_code)]
pub fn note_pointer_sample() {
    KOBU_POINTER_SAMPLES.fetch_add(1, ORD);
}

/// Read-and-reset the diagnostic pointer-sample arrival counter (the status LED
/// windows this into a samples/sec rate band).
#[allow(dead_code)]
pub fn take_pointer_samples() -> u32 {
    KOBU_POINTER_SAMPLES.swap(0, ORD)
}
