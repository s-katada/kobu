//! Trackball glue for kobu (both halves).
//!
//! LEFT half (= central, local PMW3610) drives SCROLL.
//! RIGHT half (= peripheral, forwarded PMW3610) drives POINTER motion.
//!
//! ## Why the axis relabel
//!
//! RMK 0.8's split protocol forwards peripheral pointing events to the
//! central as `Event::Joystick([AxisEvent { axis: X, .. }, AxisEvent { axis:
//! Y, .. }, ..])` — structurally identical to events produced by the
//! central's own PMW3610 device. Both land on the same `EVENT_CHANNEL` and
//! flow through the same processor chain, with no source tag.
//!
//! The trick: wrap the central-local device with [`AxisRelabel`] so its
//! Joystick events go out tagged with `Axis::H` / `Axis::V` instead of
//! `Axis::X` / `Axis::Y`. Peripheral events still arrive with X/Y. The
//! processor chain is `[ScrollProcessor, PointerProcessor]`:
//!
//! * [`ScrollProcessor`] matches H/V (central-local) → MouseReport wheel
//! * [`PointerProcessor`] matches X/Y (peripheral-forwarded) → MouseReport x/y
//!
//! Each processor returns `Stop` once it matches its axes, so the chain
//! routes deterministically.

use core::cell::RefCell;
use core::sync::atomic::{AtomicI32, Ordering};

use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::signal::Signal;
use embassy_time::{Instant, Timer};
use rmk::channel::KEYBOARD_REPORT_CHANNEL;
use rmk::event::{Axis, Event};
use rmk::hid::Report;
use rmk::input_device::{InputDevice, InputProcessor, ProcessResult};
use rmk::keymap::KeyMap;
use usbd_hid::descriptor::MouseReport;

use crate::config;

/// One-shot pulse emitted by [`PointerProcessor`] every time the peripheral
/// half forwards a Joystick(X,Y) event. The status-LED controller in
/// `src/status_led.rs` watches this signal and forces the LED to purple for
/// a short hold window, so the user sees the central LED light up while
/// the right-hand trackball is being moved.
pub static PERIPHERAL_ACTIVITY: Signal<CriticalSectionRawMutex, ()> = Signal::new();

// ─── Pointer delta accumulator ──────────────────────────────────────
//
// Why this exists (the "fully-wireless trackball feels のっぺり" bug):
//
// The peripheral PMW3610 is polled at 2 kHz and emits one Joystick event
// per non-zero sample. Every queue on the path to the host
// (rmk `run_devices!`, `PeripheralManager::run`, EVENT_CHANNEL_SIZE = 16)
// overflows with a **drop-oldest** policy — i.e. it discards motion
// rather than summing it. Over USB the host drains HID reports at ~1 kHz
// so the queues never back up and nothing is dropped. Fully wireless,
// the central→host BLE HID link only drains at the connection interval
// (~66–133 Hz, and lower while the single nRF radio also services the
// split link), so the report queue backs up, `PointerProcessor` would
// block on `send_report().await`, EVENT_CHANNEL fills, and a large
// fraction of the trackball's travel is silently dropped → the cursor
// under-travels and fast motion smears ("のっぺり").
//
// Fix: `PointerProcessor::process` no longer sends inline. It *sums*
// each sample into these accumulators and returns immediately, so
// EVENT_CHANNEL always drains and never drops. `run_pointer_flush`
// emits the accumulated delta at whatever rate the host link can
// actually accept — motion is now coalesced (summed), never discarded.
static POINTER_ACCUM_X: AtomicI32 = AtomicI32::new(0);
static POINTER_ACCUM_Y: AtomicI32 = AtomicI32::new(0);

/// Wakes [`run_pointer_flush`] when fresh pointer delta has been
/// accumulated. Latching `Signal` — a wake raised while the flush task
/// is busy is remembered, so no motion edge is missed.
static POINTER_PENDING: Signal<CriticalSectionRawMutex, ()> = Signal::new();

/// Multiplier base for `config::trackball_cpi()`: 1000 = 1.0×.
const CPI_DENOM: i32 = 1000;

/// Ceiling on "owed" (accumulated-but-unsent) travel, in milli-counts.
///
/// This is the single most important number for the fast-roll feel. A
/// fast ball spin produces motion far beyond what the BLE HID link can
/// carry (≈66–133 reports/s × ±127 counts). The earlier design tried to
/// preserve *all* of it by splitting into many ±127 reports and queuing
/// them — which buried the cursor under a multi-hundred-ms backlog that
/// kept gliding after the ball stopped ("超もっさり"). Instead we cap the
/// owed travel at ~2 reports' worth and drop the rest: the cursor stays
/// glued to the ball (≤~2 BLE intervals of catch-up, ~15–30 ms) and
/// macOS pointer acceleration turns the resulting saturated 127-count
/// reports into a genuinely fast cursor — fast *and* responsive.
const MAX_PENDING_MILLI: i32 = 254 * CPI_DENOM;

/// Re-try / re-sample cadence while draining (≈250 Hz). Comfortably
/// above any host BLE interval, so the channel's drain rate — not this
/// timer — sets the real report rate.
const FLUSH_TICK_MS: u64 = 4;

/// Drain the pointer accumulator to the host HID report channel.
///
/// Spawned alongside the processor chain on the central (see
/// `src/central.rs`). Coalesces the 2 kHz PMW3610 stream into one HID
/// report per host BLE interval, applying the live CPI multiplier from
/// `config::trackball_cpi()` (tunable from kobu-config, Via Custom
/// Channel 0xC0 id 0x01).
///
/// The emission is **non-blocking** (`try_send`) with a **bounded
/// backlog**: if the report channel is full (host link behind), the
/// unsent delta stays in `pend_*` and merges with new motion next tick
/// instead of queuing more reports. `pend_*` is clamped to
/// `MAX_PENDING_MILLI`, so motion that outruns the link is dropped
/// rather than turned into a lag tail. This keeps the cursor responsive
/// at any ball speed.
pub async fn run_pointer_flush() {
    // Owed travel in milli-counts (1000 = 1 HID count). Carrying it
    // across ticks both preserves sub-count precision for a fractional
    // CPI multiplier and lets a momentarily-full channel coalesce.
    let mut pend_x: i32 = 0;
    let mut pend_y: i32 = 0;
    loop {
        POINTER_PENDING.wait().await;
        // Drain until nothing is owed, then sleep on the next motion.
        loop {
            let mult = config::trackball_cpi() as i32;
            pend_x += POINTER_ACCUM_X.swap(0, Ordering::Relaxed) * mult;
            pend_y += POINTER_ACCUM_Y.swap(0, Ordering::Relaxed) * mult;
            // Drop travel beyond the backlog ceiling — no lag tail.
            pend_x = pend_x.clamp(-MAX_PENDING_MILLI, MAX_PENDING_MILLI);
            pend_y = pend_y.clamp(-MAX_PENDING_MILLI, MAX_PENDING_MILLI);

            let dx = (pend_x / CPI_DENOM).clamp(-127, 127);
            let dy = (pend_y / CPI_DENOM).clamp(-127, 127);
            if dx == 0 && dy == 0 {
                break;
            }
            let report = MouseReport {
                buttons: 0,
                x: dx as i8,
                y: dy as i8,
                wheel: 0,
                pan: 0,
            };
            // Only feed the shared report channel when it has nearly
            // drained (≤1 queued). `try_send` alone isn't enough: it
            // succeeds until the 16-deep channel is *full*, which over a
            // slow BLE link is ~120 ms of buffered pointer reports — the
            // exact backlog that made fast rolls glide ("もっさり"). Gating
            // on `len()` keeps at most ~2 reports in flight (~1–2 BLE
            // intervals), so the cursor tracks the ball in real time and
            // any motion the link can't take coalesces into pend_*.
            if KEYBOARD_REPORT_CHANNEL.len() <= 1
                && KEYBOARD_REPORT_CHANNEL
                    .try_send(Report::MouseReport(report))
                    .is_ok()
            {
                // Only consume what actually went out; an over-full
                // channel leaves pend_* intact to coalesce next tick.
                pend_x -= dx * CPI_DENOM;
                pend_y -= dy * CPI_DENOM;
            }
            Timer::after_millis(FLUSH_TICK_MS).await;
        }
    }
}

/// Wraps an inner `InputDevice` and rewrites `Event::Joystick` axes
/// X → H, Y → V. Used on the central side to tag locally-sourced
/// PMW3610 events so [`ScrollProcessor`] can claim them while leaving
/// peripheral-forwarded (still-X/Y) events for [`PointerProcessor`].
pub struct AxisRelabel<D> {
    inner: D,
}

impl<D> AxisRelabel<D> {
    pub fn new(inner: D) -> Self {
        Self { inner }
    }
}

impl<D: InputDevice> InputDevice for AxisRelabel<D> {
    async fn read_event(&mut self) -> Event {
        let mut event = self.inner.read_event().await;
        if let Event::Joystick(axes) = &mut event {
            for ev in axes.iter_mut() {
                ev.axis = match ev.axis {
                    Axis::X => Axis::H,
                    Axis::Y => Axis::V,
                    other => other,
                };
            }
        }
        event
    }
}

fn clamp_i8(value: i16) -> i8 {
    value.clamp(i8::MIN as i16, i8::MAX as i16) as i8
}

/// Scroll processor. Matches Joystick events with H/V axes (= LEFT half,
/// central-local, relabeled by [`AxisRelabel`]) and emits MouseReport
/// wheel deltas. Both axes are summed and negated into the vertical
/// wheel; `pan` is suppressed. See the LEFT-only commit history for the
/// rationale on this combined-vertical mapping.
///
/// Throttling / invert come from `crate::config` so a future Vial
/// `CustomSetValue` write retunes them at runtime without a reboot.
/// Defaults (no throttle, no invert) match the previous behaviour.
pub struct ScrollProcessor<
    'a,
    const ROW: usize,
    const COL: usize,
    const NUM_LAYER: usize,
    const NUM_ENCODER: usize,
> {
    keymap: &'a RefCell<KeyMap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>>,
    /// Earliest `Instant` at which the next scroll report may be
    /// emitted. `None` until the first report goes out. Compared
    /// against `Instant::now()` on every event; throttled reports are
    /// dropped (NOT accumulated — for the trackball use case "skip
    /// some" feels better than "send a giant burst later").
    next_emit_at: Option<Instant>,
}

impl<'a, const ROW: usize, const COL: usize, const NUM_LAYER: usize, const NUM_ENCODER: usize>
    ScrollProcessor<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>
{
    pub fn new(keymap: &'a RefCell<KeyMap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>>) -> Self {
        Self {
            keymap,
            next_emit_at: None,
        }
    }
}

impl<'a, const ROW: usize, const COL: usize, const NUM_LAYER: usize, const NUM_ENCODER: usize>
    InputProcessor<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>
    for ScrollProcessor<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>
{
    async fn process(&mut self, event: Event) -> ProcessResult {
        match event {
            Event::Joystick(axes) => {
                let mut horizontal = 0i16;
                let mut vertical = 0i16;
                let mut matched = false;
                for ev in axes.iter() {
                    match ev.axis {
                        Axis::H => {
                            horizontal = ev.value;
                            matched = true;
                        }
                        Axis::V => {
                            vertical = ev.value;
                            matched = true;
                        }
                        _ => {}
                    }
                }
                if !matched {
                    return ProcessResult::Continue(event);
                }

                // Throttle: drop reports that arrive faster than the
                // configured interval allows. The trackball's native
                // rate can be too fast for some applications, and
                // dropping intermediate samples feels better than
                // accumulating them into one big late wheel jump.
                let throttle = config::scroll_throttle();
                let now = Instant::now();
                if let Some(when) = self.next_emit_at {
                    if when > now {
                        return ProcessResult::Stop;
                    }
                }
                self.next_emit_at = Some(now + throttle);

                // Apply per-axis invert before the H+V sum, so the
                // user-facing semantics ("invert vertical scroll")
                // stay intuitive regardless of the H+V mixing rule.
                let h = if config::scroll_invert_x() { -horizontal } else { horizontal };
                let v = if config::scroll_invert_y() { -vertical } else { vertical };
                let report = MouseReport {
                    buttons: 0,
                    x: 0,
                    y: 0,
                    wheel: clamp_i8(-(h + v)),
                    pan: 0,
                };
                self.send_report(Report::MouseReport(report)).await;
                ProcessResult::Stop
            }
            _ => ProcessResult::Continue(event),
        }
    }

    fn get_keymap(&self) -> &RefCell<KeyMap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>> {
        self.keymap
    }
}

/// Pointer processor. Matches Joystick events with X/Y axes (= RIGHT half,
/// peripheral-forwarded, untouched) and emits MouseReport pointer motion.
pub struct PointerProcessor<
    'a,
    const ROW: usize,
    const COL: usize,
    const NUM_LAYER: usize,
    const NUM_ENCODER: usize,
> {
    keymap: &'a RefCell<KeyMap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>>,
}

impl<'a, const ROW: usize, const COL: usize, const NUM_LAYER: usize, const NUM_ENCODER: usize>
    PointerProcessor<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>
{
    pub fn new(keymap: &'a RefCell<KeyMap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>>) -> Self {
        Self { keymap }
    }
}

impl<'a, const ROW: usize, const COL: usize, const NUM_LAYER: usize, const NUM_ENCODER: usize>
    InputProcessor<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>
    for PointerProcessor<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>
{
    async fn process(&mut self, event: Event) -> ProcessResult {
        match event {
            Event::Joystick(axes) => {
                let mut x = 0i16;
                let mut y = 0i16;
                let mut matched = false;
                for ev in axes.iter() {
                    match ev.axis {
                        Axis::X => {
                            x = ev.value;
                            matched = true;
                        }
                        Axis::Y => {
                            y = ev.value;
                            matched = true;
                        }
                        _ => {}
                    }
                }
                if !matched {
                    return ProcessResult::Continue(event);
                }
                // Sum into the accumulator instead of emitting a report
                // inline. Returning immediately (no `send_report().await`)
                // keeps EVENT_CHANNEL draining so the central never hits
                // the drop-oldest path that loses motion when the host
                // BLE link is slow. `run_pointer_flush` turns the sum
                // into HID reports at the host's pace. Negate Y so
                // finger-up moves the cursor up (the right-half PMW3610
                // is mounted mirrored, leaving Y inverted by default).
                POINTER_ACCUM_X.fetch_add(x as i32, Ordering::Relaxed);
                POINTER_ACCUM_Y.fetch_add(-(y as i32), Ordering::Relaxed);
                POINTER_PENDING.signal(());
                // Wake the status-LED controller so it can flash purple
                // for the configured hold window. `Signal::signal` overwrites
                // any pending value, which is fine — we only need the
                // "something happened" edge, not a count.
                PERIPHERAL_ACTIVITY.signal(());
                ProcessResult::Stop
            }
            _ => ProcessResult::Continue(event),
        }
    }

    fn get_keymap(&self) -> &RefCell<KeyMap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>> {
        self.keymap
    }
}
