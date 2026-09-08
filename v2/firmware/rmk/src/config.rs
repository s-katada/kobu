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
    KOBU_BALL_FF_REJECTS, KOBU_BALL_INIT_READY, KOBU_HID_DROP_DX, KOBU_HID_DROP_DY,
    KOBU_HOST_CONN_INTERVAL_US, KOBU_HOST_CONNECTED, KOBU_LAST_KEY_TICKS, KOBU_LAST_TYPING_TICKS,
    KOBU_MOUSE_BUTTONS, KOBU_PERIPHERAL_SAMPLES, KOBU_PTR_ARRIVALS, KOBU_PTR_DEFERRALS,
    KOBU_PTR_EMITS, KOBU_SCROLL_INVERT_X, KOBU_SCROLL_INVERT_Y, KOBU_SCROLL_STEP,
    KOBU_SCROLL_THROTTLE_MS, KOBU_STATUS_LED_BAT_HIGH, KOBU_STATUS_LED_BAT_LOW,
    KOBU_STATUS_LED_PURPLE_HOLD_MS, KOBU_TRACKBALL_CPI,
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
    /// Scroll sensitivity divisor: raw PMW3610 counts accumulated per emitted
    /// wheel tick (lower = stronger 効き / more lines per roll, higher =
    /// calmer). The Set handler clamps to 4..=120. The first tick of a fresh
    /// gesture instead uses `min(scroll_step, SCROLL_FIRST_TICK_STEP)` — see
    /// `trackball.rs` (効き pass).
    pub scroll_step: u8,
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
    ///   * 30-count scroll divisor (≈ 1.27 mm of ball travel per line at
    ///     cpi 600)
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
            scroll_step: 30,
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

/// embassy-time tick (32768 Hz base, low 32 bits) of the most recent TYPING key
/// press: a press that resolved through a *transparent* slot of the auto-mouse
/// layer to a lower layer and is not a bare modifier (stamped by the patched
/// `KeyMap::get_action_with_layer_cache`, see `build.rs::patch_rmk_typing_tick`;
/// stamps only while the auto-mouse layer is active). Read by
/// `trackball.rs::run_auto_mouse_layer`'s hold loop to drop the mouse layer the
/// instant the user resumes typing — mouse buttons and the layer-4 mousing
/// chords (Cmd+C/V, Tab…) resolve AT layer 4 and never stamp. Returns 0 until
/// the first such press.
pub fn last_typing_ticks() -> u32 {
    KOBU_LAST_TYPING_TICKS.load(ORD)
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

// Flips the vertical-roll contribution to the wheel (Via Custom Channel 0xC0
// id 0x04 / web SPA). Regained a real reader in the 効き pass: the
// dominant-axis lock in ScrollProcessor feeds the wheel the V axis whenever
// it owns the burst, so this toggle now genuinely reverses vertical
// scrolling. It was a dead toggle while the axes were summed.
pub fn scroll_invert_y() -> bool {
    KOBU_SCROLL_INVERT_Y.load(ORD)
}

/// Live scroll sensitivity divisor in raw counts per wheel tick (Via Custom
/// Channel 0xC0 id 0x08, web-editor slider; default 30, clamped 4..=120 by
/// the Set handler). Read by `trackball.rs::ScrollProcessor` on every banked
/// sample. Guarded ≥ 1 here so a rogue write can never zero the divisor.
pub fn scroll_step() -> i32 {
    KOBU_SCROLL_STEP.load(ORD).max(1) as i32
}

// Retained for the kobu-config wire schema (Via Custom Channel 0xC0 id 0x05 /
// web SPA still read & write KOBU_STATUS_LED_PURPLE_HOLD_MS). The status LED is
// now driven by layer state (see src/status_led.rs), not a peripheral-activity
// purple hold, so this helper currently has no firmware-side reader.
#[allow(dead_code)]
pub fn status_led_purple_hold() -> Duration {
    Duration::from_millis(KOBU_STATUS_LED_PURPLE_HOLD_MS.load(ORD) as u64)
}

// Read by the central status LED's boot battery window (src/status_led.rs)
// and writable live from kobu-config (Via Custom Channel 0xC0 ids 0x06/0x07).
// The RIGHT half's boot color uses the same atomics directly at their
// defaults (src/peripheral_led.rs — the Vial write handler lives on the
// central only).
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

// ─── Ball-diagnosis LED (feature `led-ball-diag`, round 7) ───────────
//
// Temporary on-device diagnostic for the scroll-death recurrence: with the
// feature on, the status LED (src/status_led.rs) shows which layer of the
// LEFT (central-local) PMW3610 pipeline is alive. The counters below are
// unconditional (cheap atomic ops; always counting, in every build) — only
// the LED's read/branch side is `if cfg!(feature = "led-ball-diag")`-gated,
// so the normal binary is byte-for-byte unaffected.

/// True once the LEFT PMW3610's `try_init` has reached `InitState::Ready`
/// this session (see `build.rs::patch_rmk_pmw3610_init_retry_forever`).
/// `allow(dead_code)`: only referenced under `cfg!(feature = "led-ball-diag")`.
#[allow(dead_code)]
pub fn ball_init_ready() -> bool {
    KOBU_BALL_INIT_READY.load(ORD)
}

/// Read-and-reset the LEFT PMW3610's all-0xff burst-frame reject counter (see
/// `build.rs::patch_rmk_pmw3610_reject_ff_frame`). Non-zero means the flaky-SPI
/// idle-high rejection fired at least once since the last poll.
#[allow(dead_code)]
pub fn take_ball_ff_rejects() -> u32 {
    KOBU_BALL_FF_REJECTS.swap(0, ORD)
}

/// Read-and-reset the LEFT ball's non-zero-motion SAMPLE counter (the
/// central's own attached PMW3610's production count — see
/// `build.rs::patch_rmk_pmw3610_input_gate`'s `KOBU_PERIPHERAL_SAMPLES`,
/// incremented in `read_event` on this bin). Non-zero means the sensor
/// produced at least one non-zero motion sample since the last poll.
#[allow(dead_code)]
pub fn take_ball_motion_samples() -> u32 {
    KOBU_PERIPHERAL_SAMPLES.swap(0, ORD)
}

/// Read-and-reset kobu's own scroll-report-EMITTED counter (see
/// `trackball.rs::SCROLL_EMITS`, incremented on every successful wheel
/// `try_send`). Non-zero means the firmware actually sent a scroll HID
/// report since the last poll — a dead scroll with this still nonzero points
/// at macOS, not the firmware.
#[allow(dead_code)]
pub fn take_scroll_emits() -> u32 {
    crate::trackball::SCROLL_EMITS.swap(0, ORD)
}

// ─── Loss ledger (2026-09-08, always on) ─────────────────────────────
//
// The pointer path is: right-half PMW3610 -> split link -> ARRIVALS at the
// central -> PointerProcessor (EMITS on a successful try_send, DEFERRALS when
// the shared report channel is busy and travel stays banked in pend_*) -> BLE
// HID writer -> Mac. A host-side capture on 2026-09-08 showed the Mac missing
// ~15% of connection events during fast motion; these counters, exposed over
// Via 0xC0 ids 0x20-0x28 (build.rs::patch_rmk_via_custom_get_loss_ledger),
// say which stage the samples stop at. All are cheap Relaxed atomics.

/// Count a pointer sample that reached the central (post-AxisRelabel match).
pub fn note_ptr_arrival() {
    KOBU_PTR_ARRIVALS.fetch_add(1, ORD);
}

/// Count a pointer report that was accepted by the shared report channel.
pub fn note_ptr_emit() {
    KOBU_PTR_EMITS.fetch_add(1, ORD);
}

/// Count a pointer report deferred because the channel was busy. Travel stays
/// banked in `pend_*`, so this is lossless coalescing, not loss — but a high
/// rate means the host link, not the sensor, is setting the cursor's cadence.
pub fn note_ptr_deferral() {
    KOBU_PTR_DEFERRALS.fetch_add(1, ORD);
}

/// Read-and-clear the travel (HID counts) that the BLE HID writer had to drop
/// when its 40 ms notify bound expired (see
/// `build.rs::patch_rmk_hid_writer_drop_carry`). `PointerProcessor` folds this
/// back into `pend_*`, so the cursor still lands where the ball went. Clamped
/// so a pathological backlog can never fling the cursor across the screen.
pub fn take_hid_drop_travel() -> (i32, i32) {
    const MAX_CARRY: i32 = 500;
    let x = KOBU_HID_DROP_DX.swap(0, ORD).clamp(-MAX_CARRY, MAX_CARRY);
    let y = KOBU_HID_DROP_DY.swap(0, ORD).clamp(-MAX_CARRY, MAX_CARRY);
    (x, y)
}
