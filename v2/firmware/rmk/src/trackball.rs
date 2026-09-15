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
//! processor chain is
//! `[PeriphScrollRelabel, ScrollProcessor, PointerProcessor]`:
//!
//! * [`PeriphScrollRelabel`] (while H+J held) rewrites peripheral X/Y → H/V
//! * [`ScrollProcessor`] matches H/V (central-local, or right ball on H+J hold)
//!   → MouseReport wheel
//! * [`PointerProcessor`] matches X/Y (peripheral-forwarded) → MouseReport x/y
//!
//! Each processor returns `Stop` once it matches its axes, so the chain
//! routes deterministically. Releasing H+J clears the hold flag and the
//! right ball returns to pointer mode.

use core::cell::RefCell;
use core::sync::atomic::{AtomicBool, AtomicI32, Ordering};

use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::signal::Signal;
use embassy_time::{Duration, Instant, Timer, with_timeout};
use rmk::channel::KEYBOARD_REPORT_CHANNEL;
use rmk::descriptor::WheelMouseReport;
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

/// Diagnostic (round 7, feature `led-ball-diag`): incremented every time
/// [`ScrollProcessor`] actually emits a wheel HID report (the successful
/// `try_send` branch). Read-and-reset by `config::take_scroll_emits()`;
/// non-zero on a poll tick means the firmware emitted fine end-to-end, so a
/// dead scroll with this still flashing points at macOS, not the firmware.
/// Unconditional (cheap atomic add) so it always counts; only its LED
/// consumption is feature-gated.
pub static SCROLL_EMITS: core::sync::atomic::AtomicU32 = core::sync::atomic::AtomicU32::new(0);

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
// activates [`AUTO_MOUSE_LAYER`] on the first motion and holds it UNBOUNDED
// while the hand is resting/mousing — deactivation happens only on typing
// resume (the instant typing-kill) or once a CLICK completes and neither a
// follow-up press nor ball motion arrives within [`AUTO_MOUSE_CLICK_GRACE`]
// (the click-ends-the-session rule; see the hold branch). Scroll (the LEFT
// ball) does NOT trigger it — you scroll on the base layer while typing, so
// hijacking the layer on scroll would be surprising.

/// Pulsed on each non-zero peripheral pointer-motion event. Latching `Signal`,
/// so a pulse raised while [`run_auto_mouse_layer`] is mid-iteration is
/// remembered and the next `wait()` returns immediately — no motion edge is
/// lost and a fast flurry of samples collapses to "still moving".
static AUTO_MOUSE_ACTIVITY: Signal<CriticalSectionRawMutex, ()> = Signal::new();

/// Pulsed on every EMITTED pointer report (real cursor motion), including
/// slow/small mousing where the raw sensor sample was sub-count (x=y=0) and so
/// never pulsed [`AUTO_MOUSE_ACTIVITY`] — yet `pend_*` still periodically crosses
/// a full count and emits a report, so the cursor visibly moves. Historically
/// the HOLD branch's idle timer was re-armed by EITHER signal (the "マウスは動く
/// のにレイヤーが消える" fix); with the idle timeout now removed the hold branch
/// only DRAINS both signals so a stale latched pulse can't instantly re-activate
/// the layer right after the typing-kill. It feeds the HOLD only, never
/// ACTIVATION, so it can't switch layer 4 on during typing.
static AUTO_MOUSE_KEEPALIVE: Signal<CriticalSectionRawMutex, ()> = Signal::new();

/// Gross pointer travel (Σ|dx|+|dy| in raw 800-CPI counts) banked by
/// [`PointerProcessor`] since the last time [`run_auto_mouse_layer`] inspected
/// it. Separate from `POINTER_ACCUM_*` (which `run_pointer_flush` zeroes on its
/// own cadence) so the activation gate can read travel without racing the flush.
/// A typing wobble is small and decays between bursts so it never reaches the
/// threshold; one deliberate flick blows past it.
static AUTO_MOUSE_TRAVEL: AtomicI32 = AtomicI32::new(0);

/// Layer activated while the pointer is moving. Matches keyboard.toml layer 4
/// (the mouse layer). `NUM_LAYER` is 8, so this is always in range; if it ever
/// isn't, `activate_layer` warns and no-ops rather than panicking.
const AUTO_MOUSE_LAYER: u8 = 4;

/// True while [`run_auto_mouse_layer`] holds the mouse layer active. Read by
/// `src/status_led.rs`: rmk's `ControllerEvent::Layer` only carries the
/// HIGHEST active layer, so while the Linux toggle layer (7) is latched every
/// event reads "7" and the LED would mask the purple mouse indication without
/// this side channel (2026-08-26, 「winとlinuxモードのledの色がおかしい」fix).
pub static AUTO_MOUSE_LED_ACTIVE: AtomicBool = AtomicBool::new(false);

// Idle hold window — REMOVED (2026-08-26). History of the constant
// (AUTO_MOUSE_TIMEOUT): 250 → 700 → 500 → 250 → 400 → 150 → 600 → 400 →
// 300 ms → gone. The user's final call: 「(右トラボに)おいただけでも常にオート
// マウスレイヤーになるようにしたい」 — but a PMW3610 images the BALL, not the
// finger, so a resting still finger produces zero counts and is
// indistinguishable from "nobody touching". No idle window can express "while
// touched"; every value we tried either dropped the layer mid-rest (the
// complaint) or lingered too long after real mousing (the 600 ms era's
// 「ちょっと有効時間が長い」). So the hold is now UNBOUNDED and the layer drops
// ONLY on the instant typing-kill (a non-modifier key press falling through a
// transparent layer-4 slot, ≤1 poll, see `build.rs::patch_rmk_typing_tick`).
//
// Accepted trade-offs (user chose this knowingly, 2026-08-26):
//   * With AUTO_MOUSE_TRAVEL_THRESHOLD = 1, a single sensor-noise count now
//     leaves the purple LED on until the next keystroke or click instead of
//     300 ms. If that shows up, raise the threshold to 3–5 (do NOT re-add a
//     timeout).
//
// 2026-08-26 #2 (same day, 「検索フォームをクリックしてyから始まる文字を打とうと
// すると死ぬ？」— yes it did): the unbounded hold left the RIGHT alpha block a
// minefield after a click — Y/U/I/O are MouseBtn1/2/2/3 and H/J/K/L,N/M/,/. are
// `No` on layer 4, so "click the form, type a right-hand-initial word" produced
// stray clicks / dead keys until some LEFT-hand key finally typing-killed the
// layer. The 300 ms idle window used to bound that hole to 0.3 s; unbounded
// made it permanent. Fix: the CLICK-ENDS-THE-SESSION rule (user spec: 「クリック
// や右クリックが発動したら切れる」) — a completed click means the aim-and-shoot
// is done, so the layer drops AUTO_MOUSE_CLICK_GRACE after the release unless a
// follow-up press (double-click) or ball motion (keep mousing) cancels it. The
// pure resting hold (no click) remains unbounded.

/// Poll cadence of the ACTIVE hold loop. Bounds the worst-case latency of the
/// typing-kill (the only deactivation path). 25 ms is far below the ~80 ms+ gap
/// between two intentional keystrokes (so the SECOND keystroke of resumed
/// typing always lands post-kill, on the base layer), and the loop only runs
/// while the mouse layer is up, so the extra wakeups cost nothing in practice.
const AUTO_MOUSE_HOLD_POLL: Duration = Duration::from_millis(25);

/// Click-release grace: once ALL mouse buttons are released, the layer drops
/// after this long unless a follow-up button press (double/triple-click chain)
/// or ball motion (still mousing) arrives first — either cancels the countdown
/// and the hold returns to unbounded.
///
/// This window is the ONLY thing that can distinguish "2nd tap of a
/// double-click" from "typing y right after clicking a form" — the two are
/// physically identical events (same key, ball still), so dropping at the
/// press instant is impossible without killing double-click outright (the 2nd
/// tap would always type a letter). 300 → 100 ms (2026-08-26, user: 「押した
/// 瞬間から打てるようにはならない？…100ms後に入力できるようにしてほしい」):
/// the user prioritises typing immediately after a click over slow
/// double-clicks. 100 → 50 ms (2026-08-26 「50msにしましょう」), then
/// 50 → 120 ms (2026-08-26 #2): at 50 ms double-click-to-copy failed ~60% of
/// the time even with the PRIOR_IDLE click-drop exemption (touch-to-rearm) in
/// place — the 2nd tap's release→press gap routinely exceeds 50 ms and a
/// still ball banks no counts to re-activate in time. 120 ms sits inside the
/// typical double-click gap (~80–200 ms release→press) while still letting a
/// post-click keystroke land layer-free well before a human's click→type
/// latency (~300 ms+). The drop actually lands 120–145 ms after release
/// (quantised by AUTO_MOUSE_HOLD_POLL).
const AUTO_MOUSE_CLICK_GRACE: Duration = Duration::from_millis(120);

/// Require-prior-idle window (first line of defence against typing false-
/// triggers). Suppress auto-mouse *activation* for this long after any key
/// press (ZMK's "require-prior-idle" idea). Bumped 200 → 300 ms: at 200 ms the
/// *tail* of a hard-keystroke trackball wobble (which keeps emitting samples)
/// slipped through. Only gates INITIAL activation — once the mouse layer is up,
/// the unbounded hold keeps it regardless of key timing (only the typing-kill
/// drops it), so clicking the layer-4 mouse buttons never drops it.
///
/// CLICK-DROP EXEMPTION (2026-08-26 #3): a mouse-button press stamps the same
/// key tick as typing, so after the click-grace dropped the layer this window
/// also blocked "touch the ball → purple is back → click again" for 300 ms —
/// exactly the double-click timescale. A click is not typing, so the idle
/// branch now BYPASSES this gate when the key tick that would block it is
/// still the one recorded at a click-driven drop (`click_drop_keys`): no new
/// key has been pressed since the click, so there is no typing to protect.
/// The moment any key IS pressed after the drop the tick moves, the bypass
/// disarms, and the full 300 ms suppression applies as before (the user's
/// invariant: 「他のキーを強めにタイプして誤爆されなければ何をしてもよい」).
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
/// flip layer 4 on — and with the idle timeout removed (2026-08-26) it then
/// STAYS on until the next typing-kill keystroke, not just a few hundred ms.
/// If that proves annoying (random persistent purple LED / a mouse-layer
/// keycode slipping out when typing resumes), raise back to 3–5. Kept at 1 by
/// request.
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
    // Arm the in-rmk typing-resume detector (build.rs::patch_rmk_typing_tick):
    // tell the patched KeyMap::get_action_with_layer_cache WHICH layer is the
    // auto-mouse layer so it can stamp KOBU_LAST_TYPING_TICKS on key presses
    // that fall through its transparent slots. Stays 255 (= disabled, stamps
    // nothing) until this task arms it.
    rmk::input_device::battery::KOBU_AUTO_MOUSE_LAYER.store(AUTO_MOUSE_LAYER, Ordering::Relaxed);
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
    //
    // 2026-08-18: also arm on a live WIRED host (`rmk::usb::kobu_usb_hid_ready`,
    // injected by build.rs::patch_rmk_usb_hid_ready_flag). With the ZMK-parity
    // endpoint arbitration a cable-in boot now parks BLE entirely, so gating on
    // the BLE link alone would leave a wired session waiting out the full 12 s
    // fallback with no mouse layer. The wedge this gate protects against is the
    // Mac connect+encryption window, which a wired boot never enters — and the
    // flag is enumeration-gated, so a mere charger cannot open it.
    {
        let mut waited_ms = 0u64;
        while !(config::host_connected() || rmk::usb::kobu_usb_hid_ready()) && waited_ms < 12_000 {
            Timer::after_millis(100).await;
            waited_ms += 100;
        }
        // Small settle after the link is up before arming.
        Timer::after_millis(300).await;
        defmt::info!(
            "kobu: auto-mouse armed (host_connected={}, usb_hid={})",
            config::host_connected(),
            rmk::usb::kobu_usb_hid_ready()
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
    // KOBU_LAST_KEY_TICKS as sampled when the layer last dropped via the
    // click-grace (None after a typing-kill or a reactivation). While the
    // current key tick still equals this value, the only key press inside the
    // PRIOR_IDLE window is the click itself → the gate is bypassed so a ball
    // touch re-activates instantly (double-click support).
    let mut click_drop_keys: Option<u32> = None;
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
            //
            // Click-drop exemption: if the key tick that would block us is
            // still the one recorded when the click-grace dropped the layer,
            // no key has been pressed SINCE the click — there is no typing to
            // protect, so let a ball touch re-activate immediately (see the
            // AUTO_MOUSE_PRIOR_IDLE doc).
            let key_ticks = config::last_key_ticks();
            let idle = Duration::from_ticks(now_ticks.wrapping_sub(key_ticks) as u64);
            if idle < AUTO_MOUSE_PRIOR_IDLE && click_drop_keys != Some(key_ticks) {
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
                AUTO_MOUSE_LED_ACTIVE.store(true, Ordering::Relaxed);
                AUTO_MOUSE_TRAVEL.store(0, Ordering::Relaxed);
                last_motion = None;
                click_drop_keys = None;
            }
        } else {
            // Active: the resting/mousing hold is UNBOUNDED (2026-08-26,
            // 「置いただけでも常にオートマウスレイヤーになるようにしたい」 —
            // see the removed-idle-window comment above for why no timeout can
            // express "while the finger rests on the ball"). The layer drops
            // on exactly two events:
            //
            //   1. TYPING resumes: a key press that resolved through a
            //      transparent layer-4 slot to a lower layer — and is not a
            //      bare modifier — stamps KOBU_LAST_TYPING_TICKS
            //      (build.rs::patch_rmk_typing_tick); we kill within one
            //      ≤AUTO_MOUSE_HOLD_POLL poll. Keys DEFINED on layer 4
            //      (MouseBtn*) resolve AT layer 4 and never stamp. Bare
            //      modifier PRESSES never stamp — but their RELEASES do
            //      (2026-08-29, 「cmd,controlを叩いたら解除」): a bare
            //      Cmd/Ctrl TAP dismisses the layer, while a hold-then-click
            //      chord stays safe because the click keys resolve on layer 4
            //      throughout the hold and the click itself already ends the
            //      session via the grace below.
            //   2. A CLICK completes (2026-08-26 #2, click-ends-the-session):
            //      when the last mouse button RELEASES, a grace countdown of
            //      AUTO_MOUSE_CLICK_GRACE starts; if it expires the layer
            //      drops. A follow-up press (double/triple-click chain) or
            //      ball motion (still mousing) cancels the countdown and the
            //      hold returns to unbounded. A held button (drag) can never
            //      time out — the countdown only starts at release.
            //
            // We wait on ACTIVITY/KEEPALIVE (with a poll timeout) both to see
            // motion for the grace-cancel and to DRAIN the latching signals:
            // a stale pulse latched mid-hold would otherwise make the idle
            // branch's wait() fire immediately after a kill and re-judge
            // phantom motion.
            let mut typing_seen = config::last_typing_ticks();
            let mut prev_buttons = config::mouse_buttons();
            // Some(deadline) while a click-release grace countdown is live.
            let mut click_deadline: Option<Instant> = None;
            loop {
                let keep_alive = async {
                    ::rmk::embassy_futures::select::select(
                        AUTO_MOUSE_ACTIVITY.wait(),
                        AUTO_MOUSE_KEEPALIVE.wait(),
                    )
                    .await;
                };
                let moved = with_timeout(AUTO_MOUSE_HOLD_POLL, keep_alive).await.is_ok();
                let now = Instant::now();
                if moved {
                    // Ball moving again — still mousing; back to the
                    // unbounded hold.
                    click_deadline = None;
                }
                let buttons = config::mouse_buttons();
                if buttons != prev_buttons {
                    prev_buttons = buttons;
                    if buttons == 0 {
                        // Release edge, no button left down — the click
                        // finished. Start (or restart) the grace countdown.
                        click_deadline = Some(now + AUTO_MOUSE_CLICK_GRACE);
                    } else {
                        // Press edge (incl. the 2nd tap of a double-click) —
                        // clicking is still in progress.
                        click_deadline = None;
                    }
                }
                // Typing-kill: consume the stamp even while a button is held
                // (typing mid-drag shouldn't drop the layer NOR kill it on
                // release), and only kill when no button is down.
                let typing = config::last_typing_ticks();
                let typed = typing != typing_seen && buttons == 0;
                typing_seen = typing;
                let click_done = click_deadline.is_some_and(|d| now >= d);
                if typed || click_done {
                    if let Ok(mut km) = keymap.try_borrow_mut() {
                        km.deactivate_layer(AUTO_MOUSE_LAYER);
                        active = false;
                        AUTO_MOUSE_LED_ACTIVE.store(false, Ordering::Relaxed);
                        AUTO_MOUSE_TRAVEL.store(0, Ordering::Relaxed);
                        // Arm the PRIOR_IDLE click-drop exemption only for a
                        // click-driven drop; a typing-kill means the user is
                        // typing and must keep the full suppression.
                        click_drop_keys = if typed {
                            None
                        } else {
                            Some(config::last_key_ticks())
                        };
                        break;
                    }
                    // RefCell momentarily busy — stay active and retry the
                    // kill next poll. An expired click_deadline stays expired
                    // on its own; the typing stamp was already consumed, so
                    // rewind it one tick to keep `typed` armed for the retry.
                    if typed {
                        typing_seen = typing.wrapping_sub(1);
                    }
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
// Source rate is matched to the link rate (PMW3610 poll 8 ms ≈ ZMK
// REPORT_INTERVAL_MIN — a 4 ms experiment was HW-worse and rolled back,
// see build.rs::patch_rmk_pmw3610_slower_poll), so the channel rarely
// backs up.

/// Multiplier base for `config::trackball_cpi()`: 1000 = 1.0×.
const CPI_DENOM: i32 = 1000;

// Scroll sensitivity divisor: raw PMW3610 counts (at 600 CPI) per emitted
// wheel tick — "raw counts per scrolled line"; one HID wheel unit is one
// detent/line on the host (macOS layers its own acceleration on top).
//
// 効き pass (2026-08-16): the divisor is LIVE-TUNABLE — the hot path reads
// `config::scroll_step()` (Via Custom Channel 0xC0 id 0x08, web-editor
// slider; the Set handler clamps 4..=120; lower = stronger 効き, higher =
// calmer). Boot default is 30, defined at `KobuSettings::default` and the
// `KOBU_SCROLL_STEP` initialiser injected by
// `build.rs::patch_rmk_kobu_settings_atomics`. History of the 30: STEP=8
// scrolled "どえらい行数" after round 7's 500 µs → 2 ms poll change packed
// ~4× more counts into each sample, and the user wanted another ~3-4× calmer
// on top, so 8 × ~3.75 ≈ 30; at keyboard.toml cpi=600 = 23.6 counts/mm that
// is ~1.27 mm of ball travel per line. Not persisted: a reboot restores the
// default. `ScrollProcessor` carries the remainder, so a slow roll
// (per-sample |dx| < step) still accumulates to a tick instead of rounding
// to zero.

/// First-tick boost (効き pass): threshold in raw counts for the FIRST wheel
/// tick after the accumulator was reset — burst start (idle decay), direction
/// reversal (sign-flip reset), and boot. Every fresh gesture used to pay a
/// full step (default 30 ≈ 1.27 mm of ball travel) of dead travel before
/// anything moved on screen, which read as "効きが悪い" — the scroll seemed
/// to ignore the first nudge. 12 counts ≈ 0.51 mm gets the first line out
/// ~2.5× sooner while sustained speed is untouched (later ticks pay the full
/// step). The boosted tick is capped at ±1 unit — the boost buys LATENCY,
/// not amplitude. If the live step is tuned below this, the smaller of the
/// two wins (`min`), so a very sensitive setup is never made coarser.
const SCROLL_FIRST_TICK_STEP: i32 = 12;

/// ── Dominant-axis lock (効き pass; re-applied from the 08-10 design) ──
///
/// The wheel used to be fed `h + (-v)` — BOTH roll axes folded by summation.
/// The two contributions OPPOSE on the up+left / down+right diagonals (the
/// old comment's "Known trade-off"), so any vertical roll with sideways
/// drift — which is most human thumb rolls — lost part of its travel, and a
/// true diagonal was fully dead. Per burst we now LOCK onto the dominant
/// axis and feed the wheel that axis alone; the drift axis is discarded
/// instead of SUBTRACTED. Pure-vertical and pure-horizontal rolls are
/// bit-for-bit unchanged.
///
/// Mechanism (spec preserved in memory `project-kobu-scroll-axis-lock`):
/// per-sample each axis's gross |counts| decays by 1/AXIS_GROSS_DECAY_DIV
/// then accumulates; while Undecided, once gross_h + gross_v ≥
/// AXIS_LOCK_THRESHOLD the larger side wins (tie → V, the common scroll
/// intent); a locked burst can be stolen mid-flight when the other axis's
/// gross clears the threshold AND exceeds AXIS_SWITCH_MARGIN× the holder's
/// (a deliberate no-pause direction change follows within a few samples; a
/// 45° wobble cannot flap the lock). Lock and grosses reset at the
/// SCROLL_IDLE_DECAY burst boundary.
///
/// ⚠ AXIS_LOCK_THRESHOLD must stay ≤ 3 (see the memory note): a slow roll
/// delivering 1 count/sample must still cross it promptly — the integer 1/4
/// decay is a no-op below 4, and higher thresholds starve slow scroll.
const AXIS_LOCK_THRESHOLD: i32 = 3;
/// Steal margin: the non-locked axis takes over when its gross exceeds this
/// multiple of the holder's. 2× is decisive enough that diagonal wobble
/// never flaps, close enough that an intentional H↔V change follows in a
/// few samples.
const AXIS_SWITCH_MARGIN: i32 = 2;
/// Per-sample gross decay divisor (`g -= g/4`): recent samples dominate the
/// lock decision, so the lock tracks what the thumb is doing NOW, not the
/// whole burst's history.
const AXIS_GROSS_DECAY_DIV: i32 = 4;

/// Hard ceiling on wheel units emitted in a single event. At 500 Hz a hard
/// ball spin can pack ~90+ raw counts into one 2 ms sample; without this a
/// single sample could dump several line-ticks at once, reintroducing the
/// chunky "huge jump" feel even with a large scroll step. Capping per-event
/// units to a small number keeps fast spins smooth (many small reports) rather
/// than lumpy. Must be ≥ 1.
const SCROLL_MAX_UNITS: i32 = 3;

/// Idle window after which a banked sub-step scroll residue is stale and is
/// zeroed before banking the next sample. Without this, up to step-1 counts
/// (29 at the default step) left over from a roll minutes ago gave the next
/// unrelated touch a head start (or fought it, when opposite). 300 ms sits
/// safely ABOVE a slow gentle roll's sparse 60-120 ms sample gaps (the ZMK
/// slow-roll lesson: purging slow accumulation kills slow scroll), and far
/// below any human "came back to scroll later" gap, so genuine slow rolls
/// keep summing. Also the burst boundary that releases the dominant-axis
/// lock and re-arms the first-tick boost (効き pass).
const SCROLL_IDLE_DECAY: Duration = Duration::from_millis(300);

/// Ceiling on "owed" (accumulated-but-unsent) travel, in milli-counts.
///
/// Round 26: the mouse HID report is now 16-bit (`WheelMouseReport`, ±32767 per
/// axis, ZMK parity), so one report per BLE connection event carries the FULL
/// coalesced delta — there is no longer a host_rate × 127 cursor-speed ceiling
/// that the old i8 report forced us to drop motion against (the "のろのろ" /
/// under-travel root cause). So cap the owed travel at a full i16 axis: realistic
/// motion never reaches it (a 100 cm/s flick banks only ~600 counts per 15 ms
/// interval and the `len()==0`-gated emit drains the whole bank each interval),
/// and a rare multi-hundred-ms channel stall is emitted as ONE catch-up report
/// (an instant correct jump to where the ball actually went — like ZMK), not a
/// gliding backlog. The earlier 254-count cap existed only because an i8 report
/// could not carry more; with i16 it would needlessly throw motion away.
const MAX_PENDING_MILLI: i32 = 32767 * CPI_DENOM;

/// Motion-freeze window after any mouse-button PRESS edge (click-shake guard).
/// Pressing a layer-4 MouseBtn makes finger pressure incidentally roll the ball
/// a few counts → the cursor jumps → misclick. For this long after a press edge,
/// pointer motion is suppressed AND DISCARDED (press-edge `pend_*` reset + per-
/// sample zeroing in `process`).
///
/// It used to be 40 ms with the frozen counts *banked* in `pend_*` — which made
/// clicking while the ball was still settling WORSE, not better: the entire
/// banked roll was emitted as ONE report the instant the freeze lapsed, while
/// the button was still held (a click hold is ~100 ms), so the host saw
/// mousedown → jump → mouseup = a micro-DRAG, and the click missed or smeared
/// ("ポインタをほとんど静止した状態じゃないとちゃんとクリック出来ない"). A
/// click must land where the cursor was at the press edge; ball momentum from
/// before/during the press transient is noise, not drag intent, so it is now
/// dropped outright. Widened to 80 ms to also cover the ball's mechanical
/// settle when clicking out of motion. Deliberate press-then-drag is unhurt:
/// the grab happens at the press-edge cursor position and real drag motion
/// starts after the fingers re-settle (≈ the same 80 ms); only the freeze
/// window's travel is lost, invisible at drag speeds. Fires only on the press
/// rising edge, never re-arming during a sustained hold.
const CLICK_FREEZE: Duration = Duration::from_millis(80);

/// Smart conn-param re-assert (round 27): host interval (µs) above which we
/// consider the macOS link "relaxed for power-save" and worth nudging back to
/// the fast HID range. The healthy resting grant is ~15 ms (15000); macOS
/// relaxes a bonded idle link toward ~30-50 ms. 18 ms cleanly separates the two,
/// so a healthy 15 ms link never triggers a re-assert (no churn) but a genuine
/// power-save relaxation does. See `PointerProcessor::process`.
const REASSERT_INTERVAL_THRESHOLD_US: u32 = 18_000;

/// Minimum spacing between smart re-asserts. The re-assert is fired only while
/// the ball is ACTIVELY moving AND the link is relaxed, and never more than once
/// per this window — so it can never degrade into the old periodic 2 s conn-param
/// churn (which R24 removed). One nudge snaps macOS back within a connection
/// event or two (~30-100 ms) instead of waiting ~5 s for macOS to do it itself.
const REASSERT_COOLDOWN: Duration = Duration::from_secs(2);

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

/// While the H+J combo is held (`config::periph_as_scroll`), rewrite
/// peripheral Joystick X/Y → H/V so [`ScrollProcessor`] (next in the chain)
/// claims the right ball as scroll. Y is negated so finger-up scrolls up —
/// matching the pointer path's "right half is mounted mirrored" convention.
/// Left-ball events are already H/V (via [`AxisRelabel`]) and pass through
/// unchanged. When the combo is released the flag clears and events stay
/// X/Y for [`PointerProcessor`].
pub struct PeriphScrollRelabel<
    'a,
    const ROW: usize,
    const COL: usize,
    const NUM_LAYER: usize,
    const NUM_ENCODER: usize,
> {
    keymap: &'a RefCell<KeyMap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>>,
}

impl<'a, const ROW: usize, const COL: usize, const NUM_LAYER: usize, const NUM_ENCODER: usize>
    PeriphScrollRelabel<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>
{
    pub fn new(keymap: &'a RefCell<KeyMap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>>) -> Self {
        Self { keymap }
    }
}

impl<'a, const ROW: usize, const COL: usize, const NUM_LAYER: usize, const NUM_ENCODER: usize>
    InputProcessor<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>
    for PeriphScrollRelabel<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>
{
    async fn process(&mut self, event: Event) -> ProcessResult {
        if !config::periph_as_scroll() {
            return ProcessResult::Continue(event);
        }
        match event {
            Event::Joystick(mut axes) => {
                for ev in axes.iter_mut() {
                    match ev.axis {
                        Axis::X => ev.axis = Axis::H,
                        Axis::Y => {
                            // Right half is mounted mirrored (see PointerProcessor
                            // Y negation). Flip so finger-up → scroll up under the
                            // same ScrollProcessor V convention the left ball uses.
                            ev.axis = Axis::V;
                            ev.value = -ev.value;
                        }
                        _ => {}
                    }
                }
                ProcessResult::Continue(Event::Joystick(axes))
            }
            other => ProcessResult::Continue(other),
        }
    }

    fn get_keymap(&self) -> &RefCell<KeyMap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>> {
        self.keymap
    }
}

fn clamp_i8(value: i16) -> i8 {
    value.clamp(i8::MIN as i16, i8::MAX as i16) as i8
}

/// Scroll processor. Matches Joystick events with H/V axes (= LEFT half,
/// central-local, relabeled by [`AxisRelabel`]) and emits MouseReport
/// wheel deltas. Both axes fold into the vertical wheel (H as-is, V
/// negated — sign rationale at the `input` computation in `process`);
/// `pan` is suppressed.
///
/// Throttling / invert come from `crate::config` so a future Vial
/// `CustomSetValue` write retunes them at runtime without a reboot.
/// Defaults (no throttle, no invert) match the previous behaviour.
/// Which axis owns the current scroll burst (dominant-axis lock, 効き pass).
/// Design rationale at the `AXIS_LOCK_*` constants.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ScrollAxisLock {
    /// Burst just started — neither axis has accumulated enough gross travel
    /// to claim the wheel. Samples are not banked while undecided (≤ 2 counts
    /// lost per burst with AXIS_LOCK_THRESHOLD = 3).
    Undecided,
    /// Horizontal roll owns the wheel.
    H,
    /// Vertical roll owns the wheel.
    V,
}

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
    /// is emitted per `config::scroll_step()` accumulated counts (default 30,
    /// live-tunable via Via 0xC0 id 0x08); the remainder carries
    /// to the next event so slow rolls (per-sample |dx| < STEP) still add up
    /// to a tick instead of being lost to integer truncation.
    scroll_acc: i32,
    /// `Instant` of the last arriving H/V sample (any matched sample, even
    /// sub-step ones that emit nothing). Drives the idle decay: residue in
    /// `scroll_acc` older than `SCROLL_IDLE_DECAY` is zeroed before banking.
    last_event: Option<Instant>,
    /// Last time we asked the host link to re-tighten (smart re-assert, S2
    /// fix — the scroll-side mirror of `PointerProcessor::last_reassert`).
    /// `None` until the first re-assert. Rate-limits the re-assert to at most
    /// once per `REASSERT_COOLDOWN` so it can never become periodic churn.
    last_reassert: Option<Instant>,
    /// Dominant-axis lock state for the current burst (効き pass).
    axis_lock: ScrollAxisLock,
    /// Decayed gross |counts| seen on H this burst (lock/steal evidence).
    gross_h: i32,
    /// Decayed gross |counts| seen on V this burst (lock/steal evidence).
    gross_v: i32,
    /// True while the next emitted tick should use the boosted (smaller)
    /// `SCROLL_FIRST_TICK_STEP` threshold: armed at boot, on idle decay and
    /// on direction reversal; cleared once a boosted tick actually goes out.
    boost_next_tick: bool,
}

impl<'a, const ROW: usize, const COL: usize, const NUM_LAYER: usize, const NUM_ENCODER: usize>
    ScrollProcessor<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>
{
    pub fn new(keymap: &'a RefCell<KeyMap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>>) -> Self {
        Self {
            keymap,
            next_emit_at: None,
            scroll_acc: 0,
            last_event: None,
            last_reassert: None,
            axis_lock: ScrollAxisLock::Undecided,
            gross_h: 0,
            gross_v: 0,
            boost_next_tick: true,
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

                // Smart conn-param re-assert (S2 fix — scroll-side mirror of
                // the identical block in PointerProcessor::process). Until
                // now only the RIGHT (pointer) ball could nudge a macOS
                // power-save-relaxed link (~30-50 ms) back to the fast HID
                // band, so a left-ball-ONLY phase (scrolling while reading)
                // never recovered and every tick felt laggy until the pointer
                // moved; now any ball does. Runs on EVERY arriving H/V sample
                // — the PMW3610 device only emits on real motion, so this
                // stays activity-gated — and BEFORE the units==0 / throttle
                // early-returns, so even a sub-step gentle roll triggers
                // recovery. Same threshold + cooldown discipline as the
                // pointer side: never the periodic churn R24 removed. (`now`
                // is also reused by the throttle gate below.)
                let now = Instant::now();
                if config::host_conn_interval_us() > REASSERT_INTERVAL_THRESHOLD_US {
                    let due = match self.last_reassert {
                        Some(t) => now.duration_since(t) >= REASSERT_COOLDOWN,
                        None => true,
                    };
                    if due {
                        rmk::input_device::battery::KOBU_HOST_CONN_DRIFT.signal(());
                        self.last_reassert = Some(now);
                    }
                }

                // Direction (port of the ZMK both-axes->vertical-wheel mapping
                // the user HW-validated 2026-06-06 in kobu_left.overlay): both
                // roll axes drive the ONE vertical wheel. Horizontal keeps the
                // confirmed kobu convention — roll RIGHT (+dx -> +wheel) =
                // scroll UP, roll LEFT = scroll DOWN (HID wheel: positive =
                // up); scroll_invert_x (Via 0xC0 / web editor) flips it with
                // no reflash. Vertical is NEGATED: on ZMK this same left ball
                // read roll-up as -REL_Y and needed Y_INVERT so up=up;
                // AxisRelabel only renames axes (values pass through), so the
                // same raw sign arrives here — roll UP = -dy, hence the
                // negation gives roll UP = wheel+ = scroll UP. scroll_invert_y
                // (id 0x04) — a dead toggle while the axes were summed — now
                // genuinely flips the V contribution.
                let h = (if config::scroll_invert_x() { -horizontal } else { horizontal }) as i32;
                let v = if config::scroll_invert_y() {
                    vertical as i32
                } else {
                    -(vertical as i32)
                };

                // Idle decay (dead-zone fix): a gap ≥ SCROLL_IDLE_DECAY is a
                // burst boundary. Zero the STALE sub-step residue (so up to
                // step-1 counts from a roll minutes ago can't give the next
                // unrelated touch a head start or fight it), release the
                // dominant-axis lock, and re-arm the first-tick boost so the
                // fresh gesture answers promptly. See SCROLL_IDLE_DECAY for
                // why 300 ms keeps genuine slow rolls (60-120 ms sample gaps)
                // accumulating.
                if let Some(prev) = self.last_event {
                    if now.duration_since(prev) >= SCROLL_IDLE_DECAY {
                        self.scroll_acc = 0;
                        self.axis_lock = ScrollAxisLock::Undecided;
                        self.gross_h = 0;
                        self.gross_v = 0;
                        self.boost_next_tick = true;
                    }
                }
                self.last_event = Some(now);

                // Dominant-axis lock (効き pass — design rationale at the
                // AXIS_LOCK_* constants). Decay-then-accumulate each axis's
                // gross travel, settle who owns the burst, and feed the wheel
                // the owning axis ALONE — the old `h + (-v)` summation let
                // the drift axis SUBTRACT from the roll on the up+left /
                // down+right diagonals (dead diagonal, weakened drifty
                // rolls).
                self.gross_h -= self.gross_h / AXIS_GROSS_DECAY_DIV;
                self.gross_v -= self.gross_v / AXIS_GROSS_DECAY_DIV;
                self.gross_h += h.abs();
                self.gross_v += v.abs();
                match self.axis_lock {
                    ScrollAxisLock::Undecided => {
                        if self.gross_h + self.gross_v >= AXIS_LOCK_THRESHOLD {
                            // Tie goes to V — the overwhelmingly common
                            // scroll intent on a vertical wheel.
                            self.axis_lock = if self.gross_h > self.gross_v {
                                ScrollAxisLock::H
                            } else {
                                ScrollAxisLock::V
                            };
                        }
                    }
                    ScrollAxisLock::H => {
                        if self.gross_v >= AXIS_LOCK_THRESHOLD
                            && self.gross_v > AXIS_SWITCH_MARGIN * self.gross_h
                        {
                            self.axis_lock = ScrollAxisLock::V;
                        }
                    }
                    ScrollAxisLock::V => {
                        if self.gross_h >= AXIS_LOCK_THRESHOLD
                            && self.gross_h > AXIS_SWITCH_MARGIN * self.gross_v
                        {
                            self.axis_lock = ScrollAxisLock::H;
                        }
                    }
                }
                let input = match self.axis_lock {
                    ScrollAxisLock::Undecided => 0,
                    ScrollAxisLock::H => h,
                    ScrollAxisLock::V => v,
                };

                // Magnitude reduction: the PMW3610 emits a large per-sample
                // delta at 600 CPI, so emitting raw counts as wheel ticks
                // scrolled far too fast. Bank raw counts and emit one wheel
                // unit per `step` accumulated counts (live-tunable, Via 0xC0
                // id 0x08, default 30), carrying the remainder so slow rolls
                // (per-sample |input| < step) still add up to a tick instead
                // of rounding to zero.
                //
                // Direction-flip reset (dead-zone fix): an opposite-sign
                // residue used to make a reversal pay up to 2*step-1 counts
                // of dead travel before its first tick. Zero the bank on a
                // sign flip — and re-arm the first-tick boost, so the
                // reversed direction answers within SCROLL_FIRST_TICK_STEP
                // counts instead of a full step (効き pass).
                let step = config::scroll_step();
                if input != 0 && self.scroll_acc != 0 && input.signum() != self.scroll_acc.signum() {
                    self.scroll_acc = 0;
                    self.boost_next_tick = true;
                }
                self.scroll_acc += input;
                // Bound the bank so a busy-channel catch-up (units kept on a
                // dropped send, see below) plus one large 500 Hz sample can't
                // become a giant wheel jump. Sized to SCROLL_MAX_UNITS ticks'
                // worth of counts so the bank can never hold more than we are
                // willing to emit in one go.
                self.scroll_acc = self
                    .scroll_acc
                    .clamp(-SCROLL_MAX_UNITS * step, SCROLL_MAX_UNITS * step);
                // First tick of a fresh gesture / reversal goes out at the
                // boosted (smaller) threshold, capped at ±1 unit — the boost
                // buys latency, not amplitude. Subsequent ticks pay the full
                // step. Division truncates toward 0, then the per-event cap
                // keeps a single fast-spin sample (~90+ counts at 500 Hz) a
                // smooth small step instead of one chunky jump.
                let effective_step = if self.boost_next_tick {
                    step.min(SCROLL_FIRST_TICK_STEP)
                } else {
                    step
                };
                let max_units = if self.boost_next_tick { 1 } else { SCROLL_MAX_UNITS };
                let units = (self.scroll_acc / effective_step).clamp(-max_units, max_units);
                if units == 0 {
                    return ProcessResult::Stop;
                }

                // Throttle: once a unit is ready, drop it if still inside the
                // configured interval. Counts stay banked in scroll_acc (only
                // consumed below, after the gate passes), so a throttled tick
                // is deferred, not lost. Default throttle is 0 ms, so this
                // gate is normally inert.
                let throttle = config::scroll_throttle();
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
                    self.scroll_acc -= units * effective_step;
                    self.boost_next_tick = false;
                    self.next_emit_at = Some(now + throttle);
                    // kobu (round 7 ball-diag): count actual scroll emits so
                    // led-ball-diag can flash BLUE (firmware fine end-to-end).
                    SCROLL_EMITS.fetch_add(1, Ordering::Relaxed);
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
    /// Last time we asked the host link to re-tighten (smart re-assert,
    /// round 27). `None` until the first re-assert. Used to rate-limit the
    /// re-assert to at most once per `REASSERT_COOLDOWN` so it can never become
    /// the old periodic conn-param churn.
    last_reassert: Option<Instant>,
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
            last_reassert: None,
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
                // Loss ledger (2026-09-08, always on): count every sample that
                // reaches the central, and fold back any travel the BLE HID
                // writer had to drop on its 40 ms notify bound. That travel was
                // already deducted from pend_* when the report was handed over,
                // so before this it vanished silently — the measured
                // under-travel behind the もっさり. See config::take_hid_drop_travel
                // and build.rs::patch_rmk_hid_writer_drop_carry.
                config::note_ptr_arrival();
                let (drop_x, drop_y) = config::take_hid_drop_travel();
                if drop_x != 0 || drop_y != 0 {
                    self.pend_x = self.pend_x.saturating_add(drop_x.saturating_mul(CPI_DENOM));
                    self.pend_y = self.pend_y.saturating_add(drop_y.saturating_mul(CPI_DENOM));
                }
                // Click-shake guard: detect a mouse-button PRESS rising edge and
                // start a brief motion-freeze, so the incidental ball roll while
                // pressing a layer-4 MouseBtn doesn't jump the cursor (misclick).
                // Read the held-button state once and reuse it below.
                let buttons = config::mouse_buttons();
                let now = Instant::now();
                if buttons & !self.prev_buttons != 0 {
                    self.freeze_until = Some(now + CLICK_FREEZE);
                    // A click lands where the cursor is at the press edge:
                    // momentum already banked when the button went down (ball
                    // still settling, channel backlog) is noise, not drag
                    // intent — discard it, or it emits mid-hold and smears the
                    // click into a micro-drag.
                    self.pend_x = 0;
                    self.pend_y = 0;
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
                // 16-bit clamp (was ±127 for the old i8 report). One wide report
                // now carries the full coalesced delta, so the cursor tracks the
                // ball at any speed instead of saturating at ±127/report.
                let mut dx = (self.pend_x / CPI_DENOM).clamp(-32767, 32767);
                let mut dy = (self.pend_y / CPI_DENOM).clamp(-32767, 32767);
                // Click-shake suppression. The freeze branch DISCARDS (zeroes
                // pend_*): banking the press transient only deferred the cursor
                // jump to mid-click, where it smeared the click into a drag.
                // The held-deadzone branch below still BANKS (pend_* survives),
                // so a slow deliberate drag keeps accumulating to emission.
                if matches!(self.freeze_until, Some(t) if now < t) {
                    // Within the press-edge freeze window: suppress and DROP
                    // all motion — press-transient noise, not intent.
                    self.pend_x = 0;
                    self.pend_y = 0;
                    dx = 0;
                    dy = 0;
                } else if buttons != 0 && dx.abs() <= HELD_DEADZONE && dy.abs() <= HELD_DEADZONE {
                    // Button held + sub-deadzone tremor: swallow it. A deliberate
                    // drag exceeds HELD_DEADZONE and passes through at full gain.
                    dx = 0;
                    dy = 0;
                }
                if dx != 0 || dy != 0 {
                    let report = WheelMouseReport {
                        // Carry the live held-button state (drag/copy fix): a
                        // bare buttons:0 would release a button held while
                        // dragging. See config::mouse_buttons / build.rs.
                        buttons,
                        x: dx as i16,
                        y: dy as i16,
                        wheel: 0,
                        pan: 0,
                    };
                    // Emit gate (step9): `<= 1`, the SAME admission rule as
                    // ScrollProcessor. This used to be `== 0` ("freshest report
                    // only"), which is correct when the pointer is the only
                    // producer — but the channel is SHARED with scroll, and
                    // scroll's gate admits at `len() <= 1`. During simultaneous
                    // scroll+pointer use (the user's HW-isolated trigger for the
                    // 追従遅延: 両ボール同時/交互操作で発生、置くと治る) scroll
                    // keeps the channel at len >= 1, so a `== 0` pointer gate
                    // STRUCTURALLY starves: pointer reports defer into pend_*
                    // and reach the host as sparse, big, late jumps while scroll
                    // sails through — the cursor trails the hand. Peripheral
                    // exonerated on HW (queue-depth LED solid green during lag).
                    // Equal gates restore fair interleaving; pend_* still
                    // coalesces losslessly when the channel is genuinely busy.
                    if KEYBOARD_REPORT_CHANNEL.len() <= 1
                        && KEYBOARD_REPORT_CHANNEL
                            .try_send(Report::MouseReportWide(report))
                            .is_ok()
                    {
                        // Consume only what actually went out; a non-empty
                        // channel leaves pend_* to coalesce on the next event.
                        self.pend_x -= dx * CPI_DENOM;
                        self.pend_y -= dy * CPI_DENOM;
                        config::note_ptr_emit();
                    } else {
                        // Deferred, not lost: pend_* keeps the travel. Counted so
                        // the Via ledger can show the host link (not the sensor)
                        // setting the cadence during fast motion.
                        config::note_ptr_deferral();
                    }
                }
                // Wake the status-LED controller so it can flash purple for the
                // configured hold window. `Signal::signal` overwrites any
                // pending value — we only need the "something happened" edge.
                PERIPHERAL_ACTIVITY.signal(());
                // Smart conn-param re-assert (round 27 — the pointer "追従遅延"
                // fix). macOS relaxes the bonded host link for power-saving after
                // an idle spell (~15ms -> ~30-50ms); kobu's R24 made conn-params
                // request-once so nothing pulled it back, and macOS only
                // re-tightens on its own after ~5s of sustained activity — that
                // ~5s window is the "lag, then recovers" the user feels. Here, on
                // an ACTIVE pointer sample (this runs only when motion arrives),
                // if the live host interval is relaxed past the fast band, wake
                // the re-assert loop in rmk's set_conn_params (which requests the
                // 7.5-15ms range) so the link snaps back in ~one connection event
                // instead of ~5s. Rate-limited to once per REASSERT_COOLDOWN so it
                // is activity-gated + bounded — NOT the periodic churn R24 removed
                // (the loop's own >12ms gate still guards the actual request, and
                // a healthy 15ms link never crosses the 18ms threshold here).
                if config::host_conn_interval_us() > REASSERT_INTERVAL_THRESHOLD_US {
                    let due = match self.last_reassert {
                        Some(t) => now.duration_since(t) >= REASSERT_COOLDOWN,
                        None => true,
                    };
                    if due {
                        rmk::input_device::battery::KOBU_HOST_CONN_DRIFT.signal(());
                        self.last_reassert = Some(now);
                    }
                }
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
    // only after host TX credits flow — and the PMW3610 poll is 8 ms (4x
    // less flood than the 2 ms that caused the wedge), so 1 s here is safer
    // than 2 s was at 500 Hz. If a stale-reconnect-while-moving wedge ever
    // recurs, raise back toward 1500-2000.
    //
    // kobu: lowered 1000 -> 300 (2026-07-13): Mac-side log measured HID fully
    // attached at ~1.1 s after connect and the GATT burst finishing by ~1.2 s;
    // 300 ms past the (now params-update-latched) host_connected still clears
    // the burst, while the R10 wedge defenses that actually matter (8 ms poll =
    // 4x less flood, doubled TX pool/queue, bounded reply.send, timeout-bounded
    // split writes) are all still in place. Revert toward 1000-2000 if a
    // stale-reconnect-while-moving wedge ever recurs.
    const SETTLE_MS: u64 = 300;
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
