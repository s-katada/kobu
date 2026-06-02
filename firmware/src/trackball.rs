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

/// Pulsed on every EMITTED pointer report (real cursor motion), including
/// slow/small mousing where the raw sensor sample was sub-count (x=y=0) and so
/// never pulsed [`AUTO_MOUSE_ACTIVITY`] — yet `pend_*` still periodically crosses
/// a full count and emits a report, so the cursor visibly moves. The auto-mouse
/// HOLD branch waits on EITHER signal, so layer 4 stays active while you keep
/// mousing slowly instead of dropping after [`AUTO_MOUSE_TIMEOUT`] of zero-delta
/// samples (the "マウスは動くのにレイヤーが消える" bug). It feeds the HOLD only,
/// never ACTIVATION, so it can't switch layer 4 on during typing.
static AUTO_MOUSE_KEEPALIVE: Signal<CriticalSectionRawMutex, ()> = Signal::new();

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

/// How long the mouse layer stays active after the last pointer motion. History:
/// 250 → 700 → 500 → 250 → 400 ms (the 400 ms margin was for sparse split-sample
/// arrival, but R23 confirmed samples arrive ~125/s and the HOLD now waits on the
/// per-sample AUTO_MOUSE_KEEPALIVE, so continuous mousing holds the layer fine at
/// a much shorter timeout). Cut HARD to 150 ms per the user's request ("結構ガク
/// ッと短く") so the layer drops promptly once you stop moving — less lingering
/// mouse layer when you go back to typing. (Briefly tried 140; user settled on
/// 150.)
///
/// This is the HOLD timeout ONLY; re-ACTIVATION is still guarded by
/// AUTO_MOUSE_PRIOR_IDLE (300 ms) + the travel threshold. Continuous/slow mousing
/// keeps the layer (KEEPALIVE fires on every arriving sample, ~8 ms apart, far
/// under 150 ms). ⚠️ Pressing a layer-4 mouse button does NOT refresh this window
/// (only ball motion does), so "stop, pause >150 ms, then click" can drop the
/// layer before the click and emit a base-layer key instead. If that bites,
/// raise back toward 250–300 ms. Tune by feel.
const AUTO_MOUSE_TIMEOUT: Duration = Duration::from_millis(150);

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
/// (Σ|dx|+|dy| in raw counts) exceeds this within one un-paused motion burst.
///
/// Was 80 (≈2.5 mm of ball travel), which — combined with the old 60 ms decay —
/// made a GENTLE/slow deliberate move ("そっと動かす") UNABLE to ever activate:
/// soft rolling emits only ~1–2 raw counts per non-zero sample with the non-zero
/// samples landing >60 ms apart (the sub-count polls return x=y=0 yet the cursor
/// still creeps via the `pend_*` carry), so the decay zeroed travel on every
/// sample and it never summed to 80. Net effect: no layer 4 → no purple LED →
/// the layer-4 mouse buttons unreachable — the user's exact report.
///
/// Lowered to 1 (the absolute floor — ANY single non-zero raw count activates)
/// per the user's explicit request ("1にしちゃおう", after 80→45→25→18→10→3).
/// Typing safety does NOT depend on this threshold: during active typing the
/// PRIOR_IDLE 300 ms window below zeroes travel on EVERY sample that arrives
/// within 300 ms of a keypress, so the bank can never accumulate while you are
/// actually typing — no matter how low this is (the user's "叩くだけでマウスレイ
/// ヤーになってほしくない" is handled there, not here).
///
/// ⚠️ At 1 there is NO sensor-noise margin: a single stray PMW3610 jitter count
/// while you are NOT touching the ball (>300 ms after the last keypress) can
/// flip layer 4 on for up to AUTO_MOUSE_TIMEOUT (400 ms). If that proves
/// annoying (random purple LED / a mouse-layer keycode slipping out when typing
/// resumes within that 400 ms), raise back to 3–5. Kept at 1 by request.
const AUTO_MOUSE_TRAVEL_THRESHOLD: i32 = 1;

/// Travel-accumulator decay window. If no motion sample arrives for this long,
/// the banked travel is forgotten before the next gate check, so a tiny wobble
/// now and another wobble later never *sum* across the quiet gap into a false
/// activation.
///
/// Was 60 ms — too short for genuine slow motion: a gentle "そっと" roll's
/// non-zero samples arrive sparsely (often 60–120 ms apart, since most polls are
/// sub-count), so a 60 ms window reset the bank on essentially every sample and
/// the move could never accumulate to threshold. Raised to 160 ms so those
/// sparse slow-motion samples *sum* into one burst. Kept well UNDER the typical
/// ~200 ms inter-keystroke cadence so consecutive keystroke wobbles still do NOT
/// chain across the window (an adversarial-review concern about 200 ms), and
/// PRIOR_IDLE independently zeroes travel during active typing regardless. Long
/// enough that the sub-ms sample gaps inside one genuine high-rate move never
/// reset it. 120–180 ms is the sane range.
const AUTO_MOUSE_TRAVEL_DECAY: Duration = Duration::from_millis(160);

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
    AUTO_MOUSE_KEEPALIVE.reset();

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
            // Hold layer 4 while EITHER raw motion (ACTIVITY) OR an emitted
            // report (KEEPALIVE) arrives within the window. KEEPALIVE covers
            // slow/small mousing whose raw sensor samples are sub-count (x=y=0)
            // but still move the cursor via the pend_* carry — without it the
            // layer dropped mid-mouse ("マウスは動くのにレイヤーが消える").
            let keep_alive = async {
                ::rmk::embassy_futures::select::select(
                    AUTO_MOUSE_ACTIVITY.wait(),
                    AUTO_MOUSE_KEEPALIVE.wait(),
                )
                .await;
            };
            match with_timeout(AUTO_MOUSE_TIMEOUT, keep_alive).await {
                Ok(_) => {} // more motion — keep the layer, re-arm the window
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

// ─── Pointer emission (inline, like ScrollProcessor) ────────────────
//
// History / why this changed: the right-half PMW3610 floods the central at
// the poll rate and every queue on the path to the host is drop-oldest, so
// an EARLIER design had `PointerProcessor` only *accumulate* into globals
// while a SEPARATE `run_pointer_flush` task drained them on a fixed 4 ms
// tick (gated on `KEYBOARD_REPORT_CHANNEL.len() <= 1`). That second task +
// per-report 4 ms tick + withholding gate was a pointer-ONLY baseline
// latency the (smooth) SCROLL path never paid — the bulk of the "もっさり".
//
// ZMK (KobitoKey, the smooth reference) forwards each pointer sample
// straight through its input pipeline with NO coalescer task, and kobu's
// own `ScrollProcessor` (confirmed ヌルヌル) likewise emits INLINE inside
// `process()`. So `PointerProcessor::process` now emits inline too, using
// the identical non-blocking `try_send` + `len()<=1` discipline as
// ScrollProcessor, and the same CPI / MAX_PENDING math the old flush task
// ran (moved into the processor via a per-instance `pend_*` carry). The
// emit stays NON-BLOCKING, so `process()` still returns promptly and
// EVENT_CHANNEL keeps draining — the old drop-oldest "のっぺり" protection
// is preserved; we only removed the extra async hop and the 4 ms tick.
// Source rate is now matched to the link (PMW3610 poll 8 ms ≈ ZMK
// REPORT_INTERVAL_MIN, see build.rs), so the channel rarely backs up.

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

/// Motion-freeze window after any mouse-button PRESS edge (click-shake guard).
/// Pressing a layer-4 MouseBtn makes finger pressure incidentally roll the ball
/// a few counts → the cursor jumps → misclick. For this long after a press edge,
/// pointer motion is suppressed (the counts stay banked in `pend_*`, NOT dropped,
/// so a genuine press-then-drag loses nothing — they emit the moment the freeze
/// lapses). 40 ms covers the press transient and is imperceptible. Fires only on
/// the press rising edge, never re-arming during a sustained hold, so click-drag
/// is unaffected.
const CLICK_FREEZE: Duration = Duration::from_millis(40);

/// Per-emit deadzone (in HID counts) applied ONLY while a mouse button is held:
/// swallow ≤ this many counts of tremor so a held-button finger can't jitter the
/// cursor, while a deliberate drag (which exceeds it) passes at full gain. At the
/// ~1200 effective CPI (600 × 1.5×), 2 counts ≈ <0.05 mm.
const HELD_DEADZONE: i32 = 2;

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
/// peripheral-forwarded, untouched) and emits MouseReport pointer motion
/// INLINE (like `ScrollProcessor`), so the pointer no longer pays the extra
/// flush-task hop + 4 ms tick that caused the baseline "もっさり".
pub struct PointerProcessor<
    'a,
    const ROW: usize,
    const COL: usize,
    const NUM_LAYER: usize,
    const NUM_ENCODER: usize,
> {
    keymap: &'a RefCell<KeyMap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>>,
    /// Owed pointer travel in milli-counts (1000 = 1 HID count), carried
    /// across events. Preserves sub-count precision for the fractional CPI
    /// multiplier and lets a momentarily-full report channel coalesce instead
    /// of queuing more reports. Clamped to `MAX_PENDING_MILLI` so motion that
    /// outruns the link is dropped (no lag tail) — the same backlog discipline
    /// the old `run_pointer_flush` used. Single-threaded executor, so this
    /// per-instance state needs no atomics.
    pend_x: i32,
    pend_y: i32,
    /// Last-seen HID button bitfield, for press (rising-edge) detection.
    prev_buttons: u8,
    /// Deadline until which pointer motion is suppressed after a button-press
    /// edge (click-shake guard). `None` when not freezing.
    freeze_until: Option<Instant>,
}

impl<'a, const ROW: usize, const COL: usize, const NUM_LAYER: usize, const NUM_ENCODER: usize>
    PointerProcessor<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>
{
    pub fn new(keymap: &'a RefCell<KeyMap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>>) -> Self {
        Self {
            keymap,
            pend_x: 0,
            pend_y: 0,
            prev_buttons: 0,
            freeze_until: None,
        }
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
                // Diagnostic (feature led-conn-diag): count every peripheral
                // pointer sample that REACHES the central — independent of the
                // emit gate — so the status LED can show the split-link delivery
                // rate. A のろのろ from split starvation shows as a low rate here.
                if cfg!(feature = "led-conn-diag") {
                    config::note_pointer_sample();
                }
                // Click-shake guard: detect a mouse-button PRESS rising edge and
                // start a brief motion-freeze, so the incidental ball roll while
                // pressing a layer-4 MouseBtn doesn't jump the cursor (misclick).
                // Read the held-button state once and reuse it below.
                let buttons = config::mouse_buttons();
                let now = Instant::now();
                if buttons & !self.prev_buttons != 0 {
                    self.freeze_until = Some(now + CLICK_FREEZE);
                }
                self.prev_buttons = buttons;
                // Emit the pointer report INLINE — exactly like ScrollProcessor
                // (the already-smooth scroll path), no separate flush task and
                // no 4 ms tick. ZMK forwards each pointer sample straight
                // through; this mirrors that. The CPI multiply, MAX_PENDING
                // clamp and ±127 clamp are the same math the old
                // run_pointer_flush ran, moved here so feel/gain and the
                // no-lag-tail behaviour are unchanged. Negate Y so finger-up
                // moves the cursor up (the right-half PMW3610 is mounted
                // mirrored, leaving Y inverted by default).
                //
                // `pend_*` (milli-counts) carries sub-count precision and lets
                // a momentarily-full channel coalesce. The `len() <= 1` +
                // non-blocking `try_send` keeps `process()` from ever blocking,
                // so EVENT_CHANNEL keeps draining — the exact drop-oldest
                // "のっぺり" protection the old accumulator was added for, now
                // without the extra task hop / tick latency.
                let mult = config::trackball_cpi() as i32;
                self.pend_x += (x as i32) * mult;
                self.pend_y += (-(y as i32)) * mult;
                // Diagnostic (feature `led-conn-diag`, compiled out otherwise):
                // count when accumulated travel exceeds the backlog ceiling and
                // is about to be clamp-dropped — this is the "under-travel" loss
                // that may be the のろのろ. The status LED flashes white when it
                // fires, so the user can tell dropped-travel from a slow link.
                if cfg!(feature = "led-conn-diag")
                    && (self.pend_x.abs() > MAX_PENDING_MILLI
                        || self.pend_y.abs() > MAX_PENDING_MILLI)
                {
                    config::note_motion_dropped();
                }
                self.pend_x = self.pend_x.clamp(-MAX_PENDING_MILLI, MAX_PENDING_MILLI);
                self.pend_y = self.pend_y.clamp(-MAX_PENDING_MILLI, MAX_PENDING_MILLI);
                let mut dx = (self.pend_x / CPI_DENOM).clamp(-127, 127);
                let mut dy = (self.pend_y / CPI_DENOM).clamp(-127, 127);
                // Click-shake suppression. pend_* is NOT consumed when suppressed
                // (consume only happens on a successful send below), so banked
                // travel survives — a real move begun during the freeze emits the
                // instant it lapses; only the incidental press-shake is swallowed.
                if matches!(self.freeze_until, Some(t) if now < t) {
                    // Within the press-edge freeze window: suppress all motion.
                    dx = 0;
                    dy = 0;
                } else if buttons != 0 && dx.abs() <= HELD_DEADZONE && dy.abs() <= HELD_DEADZONE {
                    // Button held + sub-deadzone tremor: swallow it. A deliberate
                    // drag exceeds HELD_DEADZONE and passes through at full gain.
                    dx = 0;
                    dy = 0;
                }
                if dx != 0 || dy != 0 {
                    let report = MouseReport {
                        // Carry the live held-button state (drag/copy fix): a
                        // bare buttons:0 would release a button held while
                        // dragging. See config::mouse_buttons / build.rs.
                        buttons,
                        x: dx as i8,
                        y: dy as i8,
                        wheel: 0,
                        pan: 0,
                    };
                    // Emit only when the shared HID channel is EMPTY, keeping
                    // exactly ONE pointer report in flight. Was `len() <= 1`
                    // (up to 2 queued = ~2 host intervals ≈ 30 ms of buffer
                    // latency); the central→macOS link is confirmed healthy
                    // (host steady ~15 ms, samples arriving fine), so the residual
                    // のろのろ is this emit-queue lag. `== 0` keeps 1-in-flight
                    // (~1 host interval ≈ 15 ms), matching ZMK's freshest-report-
                    // per-connection-event behaviour, and the unsent motion still
                    // coalesces losslessly into pend_*. At ~125 samples/s the
                    // writer never starves (an arrival refills within ~8 ms), so
                    // throughput stays at the host rate while latency halves.
                    if KEYBOARD_REPORT_CHANNEL.len() == 0
                        && KEYBOARD_REPORT_CHANNEL
                            .try_send(Report::MouseReport(report))
                            .is_ok()
                    {
                        // Consume only what actually went out; a non-empty
                        // channel leaves pend_* to coalesce on the next event.
                        self.pend_x -= dx * CPI_DENOM;
                        self.pend_y -= dy * CPI_DENOM;
                    }
                }
                // Wake the status-LED controller so it can flash purple for the
                // configured hold window. `Signal::signal` overwrites any
                // pending value — we only need the "something happened" edge.
                PERIPHERAL_ACTIVITY.signal(());
                // Keep the auto-mouse layer alive whenever ANY pointer sample
                // ARRIVES — not only on a successful emit (the old placement),
                // and not only on raw non-zero motion (that's AUTO_MOUSE_ACTIVITY
                // below). This covers sub-count creep, suppressed (freeze/dead-
                // zone) ticks, and a momentarily-full channel — the exact cases
                // the send-gated keep-alive missed, which dropped the layer mid-
                // mouse. HOLD only; ACTIVATION still keys off AUTO_MOUSE_ACTIVITY
                // + travel + prior-idle, so typing-after-mousing stays safe.
                AUTO_MOUSE_KEEPALIVE.signal(());
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
    //
    // kobu: lowered 2000 -> 1000 to cut the 起動時もっさり (the pointer was dead
    // ~2 s after every connect). 1000 ms still spans the dense stale-resume GATT
    // cache-revalidation burst because set_conn_params (ble/mod.rs) spends
    // 300+300 ms before the fast params land, so the trackball is still admitted
    // only after host TX credits flow — and the PMW3610 poll is now 8 ms (4x
    // less flood than the 2 ms that caused the wedge), so 1 s here is safer than
    // 2 s was at 500 Hz. If a stale-reconnect-while-moving wedge ever recurs,
    // raise back toward 1500-2000.
    const SETTLE_MS: u64 = 1000;
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
