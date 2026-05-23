//! Kobu-specific runtime-tunable config.
//!
//! Centralises the values that the trackball / scroll / status-LED
//! subsystems used to hardcode as `const`s. Every value lives in an
//! `Atomic*` singleton so:
//!
//!   * processors can read the current value on every event (no
//!     locking, no allocations)
//!   * a future Vial wire layer can update them at runtime without
//!     restarting any task
//!   * `Default::default()` preserves today's behaviour byte-for-byte,
//!     so this module landing on its own is a pure refactor
//!
//! ## Why atomics, not a `Mutex`
//!
//! Each setting is independent. Readers don't need a consistent
//! snapshot across multiple fields, and writers update one at a
//! time. Atomics give us lock-free reads on the hot path with no
//! priority-inversion risk between USB / BLE / scroll / pointer
//! tasks.
//!
//! ## Persistence (NOT YET WIRED)
//!
//! The Vial `CustomGetValue` / `CustomSetValue` / `CustomSave`
//! commands (0x07–0x09) are the intended host-side protocol. RMK 0.8
//! ships those as no-op stubs in `host/via/mod.rs`, so wiring them
//! up needs either:
//!
//!   * an RMK upstream PR adding a custom-value hook callback, or
//!   * a fork pinned via `[patch.crates-io]` in `Cargo.toml`, or
//!   * a sidecar HID interface on a different usage page
//!
//! Pick a path in the follow-up issue. Until then this module is a
//! pure data + atomic-singletons layer; only the firmware itself
//! mutates the values (e.g. on first-time init from defaults).

use core::sync::atomic::{AtomicBool, AtomicU16, AtomicU8, Ordering};

use embassy_time::Duration;

/// Ordering used for all reads / writes here. `Relaxed` is correct
/// because:
///   * readers don't need cross-field consistency
///   * writers don't establish a happens-before with anything other
///     than their own subsequent read by the same writer
///   * we're on an ARMv7-EM core where every aligned 8/16-bit store
///     is atomic at the hardware level regardless
const ORD: Ordering = Ordering::Relaxed;

/// Logical schema for kobu's tunable runtime config. The wire IDs
/// match the table in issue #39 so the future host-side handler can
/// reuse them verbatim.
///
/// `dead_code` because the host-side hook (Vial `CustomSetValue` /
/// `CustomGetValue` + persistence) is the deferred follow-up. The
/// struct, `apply()`, and `snapshot()` are the integration surface
/// that follow-up will plug into.
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

// ─── Singletons ─────────────────────────────────────────────────────
//
// One atomic per field. Initial values match `KobuSettings::default()`
// — keep them in sync with the Default impl above.
//
// `TRACKBALL_CPI` has no reader yet (PMW3610 native CPI is set
// board-level; the software multiplier consumer will arrive with the
// host-side hook). The other statics already feed live values into
// status_led / trackball, so they're not dead code.

#[allow(dead_code)]
static TRACKBALL_CPI: AtomicU16 = AtomicU16::new(1000);
static SCROLL_THROTTLE_MS: AtomicU8 = AtomicU8::new(0);
static SCROLL_INVERT_X: AtomicBool = AtomicBool::new(false);
static SCROLL_INVERT_Y: AtomicBool = AtomicBool::new(false);
static STATUS_LED_PURPLE_HOLD_MS: AtomicU16 = AtomicU16::new(200);
static STATUS_LED_BATTERY_HIGH_THRESHOLD: AtomicU8 = AtomicU8::new(60);
static STATUS_LED_BATTERY_LOW_THRESHOLD: AtomicU8 = AtomicU8::new(20);

// ─── Read helpers (hot path) ───────────────────────────────────────

#[allow(dead_code)]
pub fn trackball_cpi() -> u16 {
    TRACKBALL_CPI.load(ORD)
}

pub fn scroll_throttle() -> Duration {
    Duration::from_millis(SCROLL_THROTTLE_MS.load(ORD) as u64)
}

pub fn scroll_invert_x() -> bool {
    SCROLL_INVERT_X.load(ORD)
}

pub fn scroll_invert_y() -> bool {
    SCROLL_INVERT_Y.load(ORD)
}

pub fn status_led_purple_hold() -> Duration {
    Duration::from_millis(STATUS_LED_PURPLE_HOLD_MS.load(ORD) as u64)
}

pub fn status_led_battery_high_threshold() -> u8 {
    STATUS_LED_BATTERY_HIGH_THRESHOLD.load(ORD)
}

pub fn status_led_battery_low_threshold() -> u8 {
    STATUS_LED_BATTERY_LOW_THRESHOLD.load(ORD)
}

// ─── Write helpers (control plane) ─────────────────────────────────
//
// Used by the future Vial CustomSetValue handler. Validates each
// field against the spec from issue #39 and silently clamps anything
// out of range — the Vial wire layer cannot know in advance which
// values the firmware considers safe and the simplest "just clamp"
// behaviour beats either a no-op (silent confusion) or rejecting
// (latency on every retry).

#[allow(dead_code)]
pub fn apply(settings: KobuSettings) {
    TRACKBALL_CPI.store(settings.trackball_cpi.clamp(200, 3200), ORD);
    SCROLL_THROTTLE_MS.store(settings.scroll_throttle_ms.min(50), ORD);
    SCROLL_INVERT_X.store(settings.scroll_invert_x, ORD);
    SCROLL_INVERT_Y.store(settings.scroll_invert_y, ORD);
    STATUS_LED_PURPLE_HOLD_MS.store(settings.status_led_purple_hold_ms.min(2000), ORD);
    // Keep low < high so the LED tri-state stays well-defined. If the
    // host writes thresholds that cross, swap them.
    let mut high = settings.status_led_battery_high_threshold.clamp(20, 100);
    let mut low = settings.status_led_battery_low_threshold.min(50);
    if low >= high {
        core::mem::swap(&mut low, &mut high);
    }
    STATUS_LED_BATTERY_HIGH_THRESHOLD.store(high, ORD);
    STATUS_LED_BATTERY_LOW_THRESHOLD.store(low, ORD);
}

/// Read every field into a struct. Used by the future Vial
/// `CustomGetValue` handler.
#[allow(dead_code)]
pub fn snapshot() -> KobuSettings {
    KobuSettings {
        trackball_cpi: trackball_cpi(),
        scroll_throttle_ms: SCROLL_THROTTLE_MS.load(ORD),
        scroll_invert_x: scroll_invert_x(),
        scroll_invert_y: scroll_invert_y(),
        status_led_purple_hold_ms: STATUS_LED_PURPLE_HOLD_MS.load(ORD),
        status_led_battery_high_threshold: status_led_battery_high_threshold(),
        status_led_battery_low_threshold: status_led_battery_low_threshold(),
    }
}
