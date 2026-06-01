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
use embassy_time::{Duration, Instant, Timer, with_timeout};
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

// ─── Auto mouse layer ───────────────────────────────────────────────
//
// kobu's keymap reserves layer 4 as the mouse layer (MouseBtn1/2/3 etc.), but
// no key in keyboard.toml ever activates it — so before this it was completely
// unreachable. ZMK-style "auto mouse layer": moving the pointer (the RIGHT /
// peripheral trackball) temporarily switches to the mouse layer so the mouse
// buttons are at your fingertips, and it falls back to the previous layer after
// a short idle window.
//
// [`PointerProcessor`] pulses [`AUTO_MOUSE_ACTIVITY`] on every real (non-zero)
// pointer motion. [`run_auto_mouse_layer`] (spawned from `src/central.rs`)
// activates [`AUTO_MOUSE_LAYER`] on the first motion and deactivates it once no
// motion has arrived for [`AUTO_MOUSE_TIMEOUT`]. Scroll (the LEFT ball) does
// NOT trigger it — you scroll on the base layer while typing, so hijacking the
// layer on scroll would be surprising.

/// Pulsed on each non-zero peripheral pointer-motion event. Latching `Signal`,
/// so a pulse raised while [`run_auto_mouse_layer`] is mid-iteration is
/// remembered and the next `wait()` returns immediately — no motion edge is
/// lost and a fast flurry of samples collapses to "still moving".
static AUTO_MOUSE_ACTIVITY: Signal<CriticalSectionRawMutex, ()> = Signal::new();

/// Gross pointer travel (Σ|dx|+|dy| in raw 800-CPI counts) banked by
/// [`PointerProcessor`] since the last time [`run_auto_mouse_layer`] inspected
/// it. Separate from `POINTER_ACCUM_*` (which `run_pointer_flush` zeroes on its
/// own cadence) so the activation gate can read travel without racing the flush.
/// A typing wobble is small and decays between bursts so it never reaches the
/// threshold; one deliberate flick blows past it.
static AUTO_MOUSE_TRAVEL: AtomicI32 = AtomicI32::new(0);

/// Layer activated while the pointer is moving. Matches keyboard.toml layer 4
/// (the mouse layer). `NUM_LAYER` is 7, so this is always in range; if it ever
/// isn't, `activate_layer` warns and no-ops rather than panicking.
const AUTO_MOUSE_LAYER: u8 = 4;

/// How long the mouse layer stays active after the last pointer motion. 700 ms
/// keeps it up while you pause to aim a click but releases it soon after you
/// stop mousing, so typing right afterwards lands on the normal layers. Tune by
/// feel (≈400–1000 ms is reasonable).
const AUTO_MOUSE_TIMEOUT: Duration = Duration::from_millis(700);

/// Require-prior-idle window (first line of defence against typing false-
/// triggers). Suppress auto-mouse *activation* for this long after any key
/// press (ZMK's "require-prior-idle" idea). Bumped 200 → 300 ms: at 200 ms the
/// *tail* of a hard-keystroke trackball wobble (which keeps emitting samples)
/// slipped through. Only gates INITIAL activation — once the mouse layer is up,
/// AUTO_MOUSE_TIMEOUT keeps it regardless of key timing, so clicking the
/// layer-4 mouse buttons never drops it.
const AUTO_MOUSE_PRIOR_IDLE: Duration = Duration::from_millis(300);

/// Travel gate (the real fix, second/independent line of defence). Even after
/// the prior-idle window passes, do NOT activate until gross pointer travel
/// (Σ|dx|+|dy| in raw 800-CPI counts) exceeds this within one un-paused motion
/// burst. At 800 CPI, 80 counts ≈ 2.5 mm of ball travel — a short deliberate
/// flick clears it within a few ms (the PMW3610 polls at ~2 kHz); a hard-
/// keystroke wobble is a brief sub-mm oscillation that decays before it can sum
/// to 80, so it never activates. Lower = twitchier; 60–120 is the sane range.
const AUTO_MOUSE_TRAVEL_THRESHOLD: i32 = 80;

/// Travel-accumulator decay window. If no motion sample arrives for this long,
/// the banked travel is forgotten before the next gate check, so a tiny wobble
/// now and another 150 ms later never *sum* across the quiet gap into a false
/// activation. Short enough that two distinct wobbles don't chain, long enough
/// that the sub-ms sample gaps inside one genuine 2 kHz move never reset it.
const AUTO_MOUSE_TRAVEL_DECAY: Duration = Duration::from_millis(60);

/// Drive the auto mouse layer from pointer activity.
///
/// Spawned alongside the processor chain on the central (see `src/central.rs`).
/// Shares the one `KeyMap` `RefCell` with `run_rmk` / `keyboard.run()`; it only
/// ever borrows it for a single, non-`await` statement (`activate_layer` /
/// `deactivate_layer` are synchronous and run the same `update_tri_layer`
/// bookkeeping as a built-in `LayerOn`), so it can never hold a borrow across an
/// await and clash with key resolution on the single-threaded executor.
///
/// `activate_layer` / `deactivate_layer` are called only on the off→on and
/// on→off transitions (tracked by `active`), never on every motion sample, so
/// the layer-change controller event hits the split link at most twice per
/// mousing burst instead of per-event.
pub async fn run_auto_mouse_layer<
    const ROW: usize,
    const COL: usize,
    const NUM_LAYER: usize,
    const NUM_ENCODER: usize,
>(
    keymap: &RefCell<KeyMap<'_, ROW, COL, NUM_LAYER, NUM_ENCODER>>,
) {
    // Round 7: keep auto-mouse OUT of the host BLE bring-up window. The user
    // hit a hard wedge where rolling the trackball *first* at power-on killed
    // the whole keyboard (pressing a key first avoided it). The auto-mouse task
    // is the only trackball-triggered actor that mutates the keymap and emits a
    // layer-change split write during bring-up; if that write lands inside the
    // Mac connect+encryption window it can contend for the single radio / the
    // shared split-link TX queue and stall the handshake. The split write is now
    // also timeout-bounded in rmk (build.rs::patch_rmk_timeout_split_writes), so
    // this gate is defence in depth — but gating on the REAL host-connected
    // state (set on encryption in the patched gatt task,
    // build.rs::patch_rmk_set_host_connected) is strictly better than round 4's
    // fixed 3 s, which could expire *inside* a slow Mac connect. Generous
    // fallback so a host-less bring-up (USB-only bench testing, or a host that
    // never reads GATT) still arms auto-mouse eventually.
    {
        let mut waited_ms = 0u64;
        while !config::host_connected() && waited_ms < 12_000 {
            Timer::after_millis(100).await;
            waited_ms += 100;
        }
        // Small settle after the link is up before arming.
        Timer::after_millis(300).await;
        defmt::info!(
            "kobu: auto-mouse armed (host_connected={})",
            config::host_connected()
        );
    }
    // Discard motion banked during the delay so the first armed pulse starts a
    // clean burst.
    AUTO_MOUSE_TRAVEL.store(0, Ordering::Relaxed);
    AUTO_MOUSE_ACTIVITY.reset();

    let mut active = false;
    // Low-32-bit (32768 Hz) tick of the last motion sample counted toward the
    // travel gate. `None` while idle. Used to decay the travel accumulator
    // across quiet gaps so two unrelated wobbles can't sum into a false trigger.
    let mut last_motion: Option<u32> = None;
    loop {
        if !active {
            // Idle: park until the next pointer-motion pulse.
            AUTO_MOUSE_ACTIVITY.wait().await;
            // 32-bit tick math (KOBU_LAST_KEY_TICKS and Instant share the low-32
            // 32768 Hz tick; Cortex-M4 has no AtomicU64). wrapping_sub is exact
            // for any real elapsed time well under the ~36 h u32 wrap.
            let now_ticks = Instant::now().as_ticks() as u32;

            // Decay gate: if motion paused longer than the decay window, this
            // pulse starts a *fresh* burst — drop travel banked by an earlier,
            // now-stale burst (e.g. a wobble) before judging this one.
            if let Some(prev) = last_motion {
                if Duration::from_ticks(now_ticks.wrapping_sub(prev) as u64) >= AUTO_MOUSE_TRAVEL_DECAY {
                    AUTO_MOUSE_TRAVEL.store(0, Ordering::Relaxed);
                }
            }
            last_motion = Some(now_ticks);

            // Require-prior-idle: ignore motion within AUTO_MOUSE_PRIOR_IDLE of
            // the last key press — almost always typing vibration jostling the
            // ball. Re-loop instead of activating; a genuine move after a typing
            // pause still works. Reset the travel bank too so wobble counts from
            // the suppressed window don't carry into the post-window check.
            let idle = Duration::from_ticks(now_ticks.wrapping_sub(config::last_key_ticks()) as u64);
            if idle < AUTO_MOUSE_PRIOR_IDLE {
                AUTO_MOUSE_TRAVEL.store(0, Ordering::Relaxed);
                continue;
            }

            // Travel gate (the real fix): only activate once accumulated gross
            // travel since the burst started clears the threshold. A brief,
            // small, oscillating typing wobble never reaches it; one short
            // deliberate move blows past it within a few ms. DON'T zero on a
            // miss — a genuine move banks travel across several sub-ms samples
            // and must be allowed to *sum* up (the decay branch above discards a
            // *stale* burst).
            if AUTO_MOUSE_TRAVEL.load(Ordering::Relaxed) < AUTO_MOUSE_TRAVEL_THRESHOLD {
                continue;
            }

            // try_borrow_mut (not borrow_mut) defensively: on this single-thread
            // executor no other task holds a keymap borrow across an await, so
            // this should always succeed — but if it's ever busy we skip and the
            // latching AUTO_MOUSE_ACTIVITY signal retries on the next pulse,
            // rather than risking a RefCell panic.
            if let Ok(mut km) = keymap.try_borrow_mut() {
                km.activate_layer(AUTO_MOUSE_LAYER);
                active = true;
                AUTO_MOUSE_TRAVEL.store(0, Ordering::Relaxed);
                last_motion = None;
            }
        } else {
            // Active: stay on while motion keeps arriving within the window; the
            // first quiet window deactivates and returns to idle. The travel
            // gate is intentionally NOT re-checked here — once mousing, any
            // motion (even a small aim nudge) should hold the layer so the
            // layer-4 mouse buttons stay reachable.
            match with_timeout(AUTO_MOUSE_TIMEOUT, AUTO_MOUSE_ACTIVITY.wait()).await {
                Ok(()) => {} // more motion — keep the layer, re-arm the window
                Err(_) => {
                    if let Ok(mut km) = keymap.try_borrow_mut() {
                        km.deactivate_layer(AUTO_MOUSE_LAYER);
                        active = false;
                        AUTO_MOUSE_TRAVEL.store(0, Ordering::Relaxed);
                    }
                    // If busy, stay active and retry deactivate next timeout.
                }
            }
        }
    }
}

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

/// Scroll sensitivity divisor: raw PMW3610 counts (at 800 CPI) per emitted
/// wheel tick. Higher = slower / less sensitive scrolling. One HID wheel unit
/// = one scroll detent/line on the host (macOS then layers its own scroll
/// acceleration on top), so this is "raw counts per scrolled line".
///
/// Was 8, which scrolled "どえらい行数" (a tiny roll jumped a huge number of
/// lines). Two compounding causes:
///   1. Round 7 slowed the PMW3610 poll 500 µs → 2 ms (2 kHz → 500 Hz). The
///      sensor accumulates dx between polls, so each *sample* now carries ~4×
///      more counts than when STEP=8 was tuned — i.e. STEP=8 produced ~4× more
///      wheel units per physical roll after the poll change.
///   2. On top of that the user wants it ~3–4× less sensitive than it already
///      felt.
/// 30 ≈ 8 × ~3.75: it both undoes the 4× poll regression and lands close to a
/// 3.75× reduction versus the (already-too-fast) current feel. At 800 CPI =
/// 31.5 counts/mm, 30 counts ≈ ~1 mm of ball travel per scrolled line, which
/// reads as a calm, deliberate scroll. `ScrollProcessor` carries the remainder,
/// so a slow roll (per-sample |dx| < STEP) still accumulates to a tick instead
/// of rounding to zero. Tune 24–40 by feel; must be ≥ 1. (Could be wired to a
/// Vial Custom-channel field later; a fixed default is enough for now.)
const SCROLL_STEP: i32 = 30;

/// Hard ceiling on wheel units emitted in a single event. At 500 Hz a hard
/// ball spin can pack ~90+ raw counts into one 2 ms sample; without this a
/// single sample could dump several line-ticks at once, reintroducing the
/// chunky "huge jump" feel even with a large SCROLL_STEP. Capping per-event
/// units to a small number keeps fast spins smooth (many small reports) rather
/// than lumpy. Must be ≥ 1.
const SCROLL_MAX_UNITS: i32 = 3;

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
                // Carry the live held-button state (drag/copy fix): a bare
                // buttons:0 here would release a button the user is holding
                // while dragging. See config::mouse_buttons / build.rs.
                buttons: config::mouse_buttons(),
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
    /// Fractional scroll accumulator, in raw PMW3610 counts. One wheel unit
    /// is emitted per `SCROLL_STEP` accumulated counts; the remainder carries
    /// to the next event so slow rolls (per-sample |dx| < STEP) still add up
    /// to a tick instead of being lost to integer truncation.
    scroll_acc: i32,
}

impl<'a, const ROW: usize, const COL: usize, const NUM_LAYER: usize, const NUM_ENCODER: usize>
    ScrollProcessor<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>
{
    pub fn new(keymap: &'a RefCell<KeyMap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>>) -> Self {
        Self {
            keymap,
            next_emit_at: None,
            scroll_acc: 0,
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

                // Direction first (preserve the corrected mapping +
                // scroll_invert_x escape hatch). The vertical (V/dy) axis is
                // intentionally unused: scroll is driven by the LEFT ball's
                // HORIZONTAL roll only — roll RIGHT (+dx -> +wheel) = scroll
                // UP, roll LEFT = scroll DOWN (HID wheel: positive = up). If
                // this module reports a rightward roll as -dx, set
                // scroll_invert_x=true (Via 0xC0 / web editor) to flip with no
                // reflash.
                let _ = vertical; // V axis is claimed but unused for the wheel
                let h = if config::scroll_invert_x() { -horizontal } else { horizontal };

                // Magnitude reduction: the PMW3610 emits a large per-sample dx
                // at 800 CPI, so emitting raw dx as wheel ticks scrolled far
                // too fast. Bank raw counts and emit one wheel unit per
                // SCROLL_STEP counts, carrying the remainder so slow rolls
                // (|dx| < STEP per sample) still add up to a tick instead of
                // rounding to zero.
                self.scroll_acc += h as i32;
                // Bound the bank so a busy-channel catch-up (units kept on a
                // dropped send, see below) plus one large 500 Hz sample can't
                // become a giant wheel jump. Sized to SCROLL_MAX_UNITS ticks'
                // worth of counts so the bank can never hold more than we are
                // willing to emit in one go.
                self.scroll_acc = self
                    .scroll_acc
                    .clamp(-SCROLL_MAX_UNITS * SCROLL_STEP, SCROLL_MAX_UNITS * SCROLL_STEP);
                // truncates toward 0, then hard-cap per-event ticks so a single
                // fast-spin sample (which at 500 Hz can carry ~90+ counts)
                // emits a smooth small step instead of one chunky jump.
                let units = (self.scroll_acc / SCROLL_STEP).clamp(-SCROLL_MAX_UNITS, SCROLL_MAX_UNITS);
                if units == 0 {
                    return ProcessResult::Stop;
                }

                // Throttle: once a unit is ready, drop it if still inside the
                // configured interval. Counts stay banked in scroll_acc (only
                // consumed below, after the gate passes), so a throttled tick
                // is deferred, not lost. Default throttle is 0 ms, so this
                // gate is normally inert.
                let throttle = config::scroll_throttle();
                let now = Instant::now();
                if let Some(when) = self.next_emit_at {
                    if when > now {
                        return ProcessResult::Stop;
                    }
                }
                let report = MouseReport {
                    // Carry the live held-button state (drag/copy fix) — see
                    // run_pointer_flush. Lets you hold a button and scroll
                    // without the wheel report releasing it.
                    buttons: config::mouse_buttons(),
                    x: 0,
                    y: 0,
                    wheel: clamp_i8(units as i16),
                    pan: 0,
                };
                // Non-blocking emit: NEVER wedge the shared 16-deep
                // KEYBOARD_REPORT_CHANNEL. `keyboard.run()` sends its own key
                // HID reports through this same channel with a blocking
                // `send().await`; a blocking scroll send here filled the
                // channel during fast scrolling, which then blocked
                // `keyboard.run()` and stopped it draining KEY_EVENT_CHANNEL —
                // freezing the whole keyboard. Gate on len()<=1 so at most ~2
                // reports are in flight (same discipline as run_pointer_flush).
                //
                // kobu (left-scroll-stops fix): consume the banked units AND
                // advance the throttle ONLY when the report actually goes out.
                // Previously the units were consumed unconditionally and then
                // dropped when the channel was busy (e.g. while the RIGHT ball
                // was filling it with pointer reports), so left-ball scroll
                // "stopped" whenever the pointer was also moving. Keeping the
                // units on a miss lets them retry on the next event; scroll_acc
                // is clamped above so the catch-up stays small.
                if KEYBOARD_REPORT_CHANNEL.len() <= 1
                    && KEYBOARD_REPORT_CHANNEL
                        .try_send(Report::MouseReport(report))
                        .is_ok()
                {
                    self.scroll_acc -= units * SCROLL_STEP;
                    self.next_emit_at = Some(now + throttle);
                }
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
                // Arm / refresh the auto mouse layer, but only on real motion so
                // idle polling can't trap the user on the mouse layer. Bank
                // gross travel (|dx|+|dy| in raw 800-CPI counts) so the
                // activation gate in `run_auto_mouse_layer` can require a
                // *sustained* deliberate move rather than firing on a single
                // tiny typing-wobble sample. Sum BEFORE signalling so the waiter
                // sees this sample's travel. Single-threaded executor: this
                // load+store never interleaves with run_auto_mouse_layer's
                // store(0) (no await between), so it's effectively atomic.
                if x != 0 || y != 0 {
                    let travel = (x as i32).abs() + (y as i32).abs();
                    let prev = AUTO_MOUSE_TRAVEL.load(Ordering::Relaxed);
                    AUTO_MOUSE_TRAVEL.store(prev.saturating_add(travel), Ordering::Relaxed);
                    AUTO_MOUSE_ACTIVITY.signal(());
                }
                ProcessResult::Stop
            }
            _ => ProcessResult::Continue(event),
        }
    }

    fn get_keymap(&self) -> &RefCell<KeyMap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>> {
        self.keymap
    }
}

/// Drive the central's input gate (boot-trackball wedge fix, round 8).
///
/// Spawned on the central (see `src/central.rs`). Holds the PMW3610 pipeline —
/// on BOTH halves — OFF until the host link can actually receive input, so a
/// trackball rolled during the Mac connect+encryption bring-up cannot flood the
/// radio / the shared split-link TX and stall the SMP handshake (the
/// long-standing "roll the ball before BT connects → keyboard dead until a
/// reconnect" wedge). The peripheral's per-sample pointer forward is the flood
/// source; gating both halves' `read_event` at the source dries it up.
///
/// "host ready" = BLE link encrypted (`config::host_connected`) OR USB present
/// (`config::vbus_present`), so USB-only operation is never gated off. A
/// generous fallback force-opens the gate after ~12 s so a session with no host
/// at all (neither BLE nor USB) does not leave the trackballs dead forever.
///
/// Sets `KOBU_INPUT_GATED` (the central's own local scroll ball reads it) and
/// `KOBU_HOST_READY` (sent to the peripheral via `SplitMessage::HostReady`, which
/// gates the peripheral's pointer ball). On the closed→open edge it wakes the
/// parked `read_event` via `KOBU_INPUT_GATE_WAKE`.
pub async fn run_input_gate_central() {
    use rmk::input_device::battery::{KOBU_HOST_READY, KOBU_INPUT_GATED, KOBU_INPUT_GATE_WAKE};

    // Round 10: do NOT open the gate on the first encrypted GATT read. On a
    // bonded STALE resume (Mac still held the link when kobu rebooted) the Mac
    // re-encrypts instantly from the stored LTK and fires a dense GATT cache-
    // revalidation burst right at that moment. Opening the trackball straight
    // into that burst let the ~500 Hz pointer flood starve the single shared
    // trouBLE TX queue/pool, parking the lone TxRunner on a host PDU and hanging
    // the link (no reset). Require host_connected to hold for SETTLE_MS first,
    // so the burst drains and host TX credits are flowing before the trackball
    // is admitted. Resets on disconnect so a stale resume re-arms cleanly.
    const SETTLE_MS: u64 = 2000;
    // Backstop for a session with NO host at all (no BLE + no USB) so the balls
    // aren't dead forever. Far longer than any real connect+settle, so it never
    // pre-empts the settle path during the dangerous bring-up window.
    const FALLBACK_MS: u64 = 20_000;
    let mut waited_ms: u64 = 0;
    let mut connected_ms: u64 = 0;
    let mut announced_open = false;
    loop {
        if config::host_connected() {
            connected_ms = connected_ms.saturating_add(100);
        } else {
            connected_ms = 0;
        }
        let host_settled = connected_ms >= SETTLE_MS;
        let fallback = waited_ms >= FALLBACK_MS;
        let ready = host_settled || config::vbus_present() || fallback;
        KOBU_HOST_READY.store(ready, Ordering::Release);

        let gated_now = KOBU_INPUT_GATED.load(Ordering::Relaxed);
        if ready && gated_now {
            KOBU_INPUT_GATED.store(false, Ordering::Relaxed);
            KOBU_INPUT_GATE_WAKE.signal(());
            if !announced_open {
                announced_open = true;
                defmt::info!(
                    "kobu: input gate OPEN (settled={}, vbus={}, fallback={})",
                    host_settled,
                    config::vbus_present(),
                    fallback
                );
            }
        } else if !ready && !gated_now {
            KOBU_INPUT_GATED.store(true, Ordering::Relaxed);
            announced_open = false;
            defmt::info!("kobu: input gate CLOSED (host link down / re-arming)");
        }

        Timer::after_millis(100).await;
        waited_ms = waited_ms.saturating_add(100);
    }
}
