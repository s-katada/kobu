//! Onboard RGB LED status controller for the central half (and the dongle,
//! which shares this file).
//!
//! Always-on staging (2026-08-13, per the user request 「起動したときに
//! バッテリー残量、繋がったら青、繋がらなかったら赤で光り続ける、レイヤーon
//! の時は各レイヤーの色」— replacing the 08-11 power-saving design whose
//! dark-when-happy steady state read as "the LED died"):
//!
//! 1. **Boot battery window** — for [`BOOT_BATTERY_WINDOW`] after power-on the
//!    LED shows the battery-level color (green / yellow / red, thresholds live
//!    in `crate::config`). `NrfAdc::read_event` samples the SAADC immediately
//!    on its first call and the kobu-patched `BatteryProcessor` publishes on
//!    every sample, so the color is available within ~1 s of boot.
//!
//! 2. **Connect confirmation** — solid blue when a host link comes up:
//!    [`BLE_CONNECT_SOLID`] on rmk's `BleState::Connected`, and
//!    [`HOST_CONNECT_FLASH`] on the encryption / USB-cable edge (seeded with
//!    VBUS at construction so booting on USB does not flash). Whichever
//!    lands first wins and a later one only ever EXTENDS the hold, never
//!    cuts it short. The split (right-half) link gets NO indication —
//!    the 08-13 solid-red alarm and solid-blue link colors were removed by
//!    the 2026-08-14 user spec.
//!
//! 3. **BLE waiting blink** (2026-09-10) — while the BLE stack is advertising
//!    and no host has answered yet, the LED blinks blue at
//!    [`BLE_WAIT_BLINK_PERIOD`]. It covers a profile switch (the layer-3
//!    BT_SEL keys), a reconnect after the host went away, and boot. It
//!    deliberately outranks the layer indicator: the profile keys live on
//!    layer 3, whose cyan would otherwise paint over the very feedback the
//!    user pressed them to get — the reason the previous firmware left
//!    「接続したかどうか、待機中なのかどうかよくわからない」. Bounded by
//!    [`BLE_WAIT_MAX`] so a host that never answers cannot blink the battery
//!    down; the waiting STATE outlives the cap, so a late connect still gets
//!    the long solid confirmation.
//!
//!    The wait is started and ended by rmk's own `BleState` events, NOT by
//!    `config::host_connected()`: switching profiles drops the connection
//!    future without a `Disconnected` event, so that atomic stays stale-true
//!    across exactly the switch this indicator exists for.
//!
//! 4. **Layer indicator** — whenever a NON-base layer is active the LED
//!    lights in that layer's color (see [`layer_color`]), including the
//!    auto-mouse layer 4 (purple). This is the only sustained light, and
//!    only while the layer is held/toggled.
//!
//! 5. Otherwise: **dark**.
//!
//! Typical boot reads as: battery color (~1 s) → blue blink while the Mac
//! link is being (re)established → 3 s of solid blue once it is up → dark.
//! A profile switch reads the same way from the blink onwards. Layer holds
//! paint their color.
//!
//! The R/G/B GPIOs (P0.26 / P0.30 / P0.06) are common-anode: pin LOW = on.
//!
//! Implemented as a [`PollingController`] so the boot-window expiry is
//! applied within one [`INTERVAL`] tick even when no event arrives.

use embassy_nrf::gpio::Output;
use embassy_time::{Duration, Instant};
use rmk::channel::{CONTROLLER_CHANNEL, ControllerSub};
use rmk::controller::{Controller, PollingController};
use rmk::event::ControllerEvent;

use crate::config;

/// How long the boot battery color is shown (re-armed to the first battery
/// sample's arrival so it is always fully visible). 1 s per the 2026-08-14
/// user spec — a quick glance, not a lingering display.
const BOOT_BATTERY_WINDOW: Duration = Duration::from_secs(1);

/// Period of the blue "waiting for a BLE host" blink: 400 ms = 2.5 Hz. Fast
/// enough to read as "working on it", slow enough not to look like a fault.
const BLE_WAIT_BLINK_PERIOD: Duration = Duration::from_millis(400);

/// How long the waiting blink may run. rmk keeps advertising for 300 s and
/// then sleeps; blinking that whole time would drain the battery for nothing,
/// and by a minute in the answer is already "it is not connecting". Only the
/// BLINK stops here — `ble_waiting` stays set, so a late connect is still
/// confirmed with the long solid.
const BLE_WAIT_MAX: Duration = Duration::from_secs(60);

/// Solid blue when a connection ENDS a waiting phase (profile switch,
/// reconnect, boot): long enough to read as steady light next to the blink.
const BLE_CONNECT_SOLID: Duration = Duration::from_secs(3);

/// Solid blue for a connect edge with no preceding wait — plugging in USB,
/// say. The 2026-08-14 spec's 1 s, unchanged.
const HOST_CONNECT_FLASH: Duration = Duration::from_millis(1000);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Color {
    Off,
    Green,
    Yellow,
    Red,
    Blue,
    Cyan,
    Purple,
    White,
}

/// Color shown while a given (non-base) layer is the active layer. The mapping
/// is arbitrary-but-stable so the user can learn "which color = which layer";
/// layer 4 (mouse) stays purple to match the previous trackball-activity flash.
/// Base layer 0 is never passed here (it maps to off in `target_color`).
fn layer_color(layer: u8) -> Color {
    match layer {
        1 => Color::Blue,   // Win overlay
        2 => Color::Green,  // numbers / symbols
        3 => Color::Cyan,   // settings / media / BLE
        4 => Color::Purple, // mouse (auto-mouse layer)
        5 => Color::Yellow, // Emacs
        6 => Color::White,  // Neovim
        // 7 (Linux) never reaches here — `target_color` maps it to dark /
        // mouse-purple BEFORE the lookup (see the layer-indicator branch).
        _ => Color::White,  // any future layer
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BatteryColor {
    Unknown,
    Green,
    Yellow,
    Red,
}

impl BatteryColor {
    /// Battery thresholds are read live from `crate::config` so a Vial
    /// `CustomSetValue` write retunes them without a reboot. Defaults (60 / 20)
    /// match the previous hardcoded constants.
    fn from_percent(p: u8) -> Self {
        let high = config::status_led_battery_high_threshold();
        let low = config::status_led_battery_low_threshold();
        if p > high {
            BatteryColor::Green
        } else if p > low {
            BatteryColor::Yellow
        } else {
            BatteryColor::Red
        }
    }

    fn as_color(&self) -> Color {
        match self {
            BatteryColor::Unknown => Color::Off,
            BatteryColor::Green => Color::Green,
            BatteryColor::Yellow => Color::Yellow,
            BatteryColor::Red => Color::Red,
        }
    }
}

/// Internal event type the controller processes (decoupled from the wider
/// `ControllerEvent` enum so `process_event` only sees what it can act on).
pub enum LedEvent {
    /// Central-side battery percentage (boot battery color).
    Battery(u8),
    /// Split link to the RIGHT half established (`true`) / down (`false`).
    SplitConnected(bool),
    Layer(u8),
    /// The BLE stack started advertising and is waiting for a host: a profile
    /// switch, a reconnect, or boot. Starts the blue blink.
    BleWaiting,
    /// A host answered. Ends the blink and shows the solid confirmation.
    BleConnected,
    /// BLE is out of the picture — USB took over, or advertising timed out
    /// and the stack went to sleep. Ends the blink with no confirmation.
    BleResolved,
}

pub struct StatusLedController<'d> {
    red: Output<'d>,
    green: Output<'d>,
    blue: Output<'d>,
    sub: ControllerSub,
    /// Last central battery color (boot window display). `Unknown` until the
    /// first `ControllerEvent::Battery` arrives (~1 s after boot).
    battery: BatteryColor,
    /// True once the boot window has been re-armed to the FIRST battery
    /// sample's arrival, so the battery color is always fully visible no
    /// matter how late the ADC pipeline delivers.
    battery_window_pinned: bool,
    /// True iff the RIGHT half (split peripheral) is currently connected.
    /// Defaults to false: at power-on nothing is connected yet, so past the
    /// boot battery window the LED rests red without waiting for rmk's first
    /// `SplitPeripheral(false)` announcement.
    split_connected: bool,
    /// Highest currently-active layer (0 = base). Updated from
    /// `ControllerEvent::Layer`.
    layer: u8,
    /// Instant after which the boot battery indication stops.
    boot_until: Instant,
    /// Host-connect edge detector state: last observed value of
    /// `host_connected() || vbus_present()`. Seeded with the VBUS state at
    /// construction so a USB cable already present at power-on does not
    /// count as a fresh "PC connected" event.
    host_seen: bool,
    /// Instant after which the solid blue "connected" confirmation goes dark.
    blue_until: Instant,
    /// True while BLE is advertising with no host yet (blue blink). Set by
    /// `ControllerEvent::BleState(_, Advertising)` and by a profile change,
    /// cleared once the host link is actually up (or USB takes over).
    ble_waiting: bool,
    /// Instant after which the waiting BLINK stops (the state itself stays).
    ble_wait_until: Instant,
    /// First `target_color` evaluation — the LED self-test runs relative to
    /// this, NOT to absolute uptime: the polling loop only starts after the
    /// whole entry init (embassy + SDC + storage), which can exceed the
    /// test's window and silently skip it.
    selftest_start: Option<Instant>,
    current: Color,
    /// Diagnostic (led-conn-diag) split-sample-arrival-rate window state:
    /// arrivals accumulated in the current window, the last computed per-second
    /// rate, and when the window started. Unused in the normal build.
    #[allow(dead_code)]
    samples_accum: u32,
    #[allow(dead_code)]
    last_rate: u32,
    #[allow(dead_code)]
    window_start: Instant,
}

impl<'d> StatusLedController<'d> {
    /// All three pins are expected to be initialized with `Level::High`
    /// (LED off) so the LED is dark until the first event arrives.
    pub fn new(red: Output<'d>, green: Output<'d>, blue: Output<'d>) -> Self {
        Self {
            red,
            green,
            blue,
            sub: CONTROLLER_CHANNEL.subscriber().unwrap(),
            battery: BatteryColor::Unknown,
            battery_window_pinned: false,
            split_connected: false,
            layer: 0,
            boot_until: Instant::now() + BOOT_BATTERY_WINDOW,
            host_seen: config::vbus_present(),
            // In the past: no flash pending at boot.
            blue_until: Instant::now(),
            // Boot is itself a waiting phase; rmk announces Advertising (and
            // the loaded profile) within milliseconds, which re-arms the cap.
            ble_waiting: false,
            ble_wait_until: Instant::now(),
            selftest_start: None,
            current: Color::Off,
            samples_accum: 0,
            last_rate: 0,
            window_start: Instant::now(),
        }
    }

    fn target_color(&mut self) -> Color {
        // Boot LED self-test — DIAGNOSTIC, off by default (build with
        // `--features led-selftest`): red → green → blue, 300 ms each, forced
        // at max drive before any status display. This is how the original
        // left XIAO's dead green/blue channels were confirmed (2026-08-13)
        // and how the replacement was verified. Runs relative to the FIRST
        // evaluation, not absolute uptime — the polling loop starts only
        // after entry init, which can outlast an uptime-anchored window.
        if cfg!(feature = "led-selftest") {
            let start = *self.selftest_start.get_or_insert_with(Instant::now);
            let since = Instant::now().saturating_duration_since(start);
            if since < Duration::from_millis(300) {
                return Color::Red;
            }
            if since < Duration::from_millis(600) {
                return Color::Green;
            }
            if since < Duration::from_millis(900) {
                return Color::Blue;
            }
        }
        // Host-connect edge: poll here (this runs every 50 ms tick) and start
        // the 1 s blue flash on the not-connected → connected transition.
        // "PC connected" = BLE link encrypted OR a USB cable appearing.
        let host_now = config::host_connected() || config::vbus_present();
        if host_now && !self.host_seen {
            self.hold_solid(HOST_CONNECT_FLASH);
        }
        if config::vbus_present() {
            // A cable is physically in: BLE is parked, so there is nothing to
            // wait for. This is a live GPIO read, unlike `host_connected()`,
            // which a profile switch leaves stale-true (rmk drops the
            // connection future without a `Disconnected` event) — precisely
            // the moment this indicator has to keep blinking.
            self.ble_waiting = false;
        }
        self.host_seen = host_now;
        // The 1 s "PC connected" flash is the freshest news — it interrupts
        // whatever else is showing (2026-08-14 user spec: 「接続したら1sほど
        // 青く光らせる」; no steady blue, no flash for the split link).
        if Instant::now() < self.blue_until {
            return Color::Blue;
        }
        // Red-only vocabulary for a board whose green/blue LED channels are
        // physically dead (see the `led-red-only` feature note in Cargo.toml):
        //   * boot window: fast blink = low battery, else dark
        //   * right half missing: solid red
        //   * linked: a short red blip every 4 s (alive + connected)
        //   * layers: not representable without color — dark
        if cfg!(feature = "led-red-only") {
            let now_ms = Instant::now().as_millis();
            if Instant::now() < self.boot_until {
                let low = matches!(self.battery, BatteryColor::Red);
                if low && now_ms % 300 < 150 {
                    return Color::Red;
                }
                return Color::Off;
            }
            if !self.split_connected {
                return Color::Red;
            }
            if now_ms % 4000 < 100 {
                return Color::Red;
            }
            return Color::Off;
        }
        // Boot battery window: show the charge state first (per the user's
        // boot narrative). `Unknown` renders off; the first sample lands
        // within ~1 s.
        if Instant::now() < self.boot_until {
            let base = self.battery.as_color();
            // While USB is plugged in (VBUS high), suppress the "low battery"
            // red — there may be no battery (or it reads 0%) but the cable is
            // powering it, so red is a false alarm. Show green instead.
            if config::vbus_present() && base == Color::Red {
                return Color::Green;
            }
            return base;
        }
        // BLE waiting blink. Deliberately ABOVE the layer indicator: the
        // BT_SEL keys live on layer 3, so its cyan would paint over exactly
        // the feedback the user pressed them to get. Below the boot battery
        // window, so the boot narrative (charge state first) survives.
        if self.ble_waiting && Instant::now() < self.ble_wait_until {
            let period = BLE_WAIT_BLINK_PERIOD.as_millis();
            return if Instant::now().as_millis() % period < period / 2 {
                Color::Blue
            } else {
                Color::Off
            };
        }
        // NOTE: no disconnected-red and no steady link color — removed by the
        // 2026-08-14 user spec (「未接続の場合赤に光らせる必要もありません」).
        // `split_connected` stays tracked for the led-red-only fallback.
        // Layer indicator: lights in the layer's color while a NON-base layer
        // is active (including auto-mouse purple).
        //
        // Linux (layer 7) is a quiet base-like mode, NOT an indicator state
        // (2026-08-26): rmk's Layer event carries only the HIGHEST active
        // layer, so a latched 7 would otherwise paint solid blue forever and
        // mask every other layer color (the 「winとlinuxモードのledの色が
        // おかしい」 report). While 7 is the reported top layer the LED goes
        // dark like the Mac base — except the auto-mouse purple, which is
        // recovered via the trackball task's side-channel flag (an
        // activate/deactivate of layer 4 still fires a Layer(7) event, so
        // repaints happen at the right moments). Trade-off, accepted: the
        // momentary number/settings layer colors don't show while Linux is
        // toggled (7 outranks 2/3 in the event), only purple does.
        let layer = if self.layer == 7 {
            if crate::trackball::AUTO_MOUSE_LED_ACTIVE.load(core::sync::atomic::Ordering::Relaxed) {
                4
            } else {
                0
            }
        } else {
            self.layer
        };
        if layer != 0 {
            return layer_color(layer);
        }
        // Steady state: dark (2026-08-14 user spec — no continuous glow; the
        // PC link announces itself with the 1 s flash above, the right half
        // needs no announcement at all).
        Color::Off
    }

    /// Diagnostic LED (feature `led-conn-diag`): show the live macOS host BLE
    /// connection interval as a color band, and flash WHITE for one tick
    /// whenever pointer travel was clamp-dropped since the last tick. Lets the
    /// user read, during a のろのろ moment, whether the host link is slow
    /// (purple/red band) or motion is being dropped at a fast link (white
    /// flashes over a green/blue band), or neither (clean fast band + no white
    /// + still のろのろ ⇒ the split link is starved). Only called from
    /// `update()`/`process_event()` under `if cfg!(feature = "led-conn-diag")`.
    /// Diagnostic LED (feature `led-conn-diag`): show the SPLIT-LINK pointer-
    /// sample ARRIVAL RATE at the central (samples/sec, windowed ~500 ms). The
    /// host-interval band (round 20) was the wrong variable — the host link is
    /// constant ~15 ms while のろのろ is intermittent, so のろのろ is upstream on
    /// the split. This shows it: GREEN = link keeping up, RED = starved.
    ///   White  : a central clamp-drop happened (would mean fast-but-dropping,
    ///            distinct from starvation) — kept top priority.
    ///   Off    : rate 0 = idle / not mousing (band only means something moving).
    ///   Green  : >80/s  (a continuous 8 ms move tops ~125/s; >80/s = healthy).
    ///   Yellow : 30..=80/s (degraded delivery).
    ///   Red    : 1..=29/s (samples arriving but far below source → SPLIT STARVATION).
    #[allow(dead_code)]
    fn diag_apply(&mut self) {
        // Round 24 verify: show the LIVE HOST (macOS) conn interval, to confirm
        // whether the request-once fix made macOS HOLD the link fast, or it is
        // still relaxing. (Split arrival is already confirmed fine = green.)
        //   Green ≤9ms (>111Hz) · Blue ≤12ms (~11.25ms) · Purple ≤20ms (~15ms,
        //   66Hz) · Red >20ms (relaxed = host still slipping) · Yellow = no data.
        // Keep the white clamp-drop flash as the top-priority signal.
        let _ = config::take_pointer_samples(); // drain so it doesn't accumulate
        let color = if config::take_motion_dropped() > 0 {
            Color::White
        } else {
            let us = config::host_conn_interval_us();
            if us == 0 {
                Color::Yellow
            } else if us <= 9_000 {
                Color::Green
            } else if us <= 12_000 {
                Color::Blue
            } else if us <= 20_000 {
                Color::Purple
            } else {
                Color::Red
            }
        };
        self.apply(color);
    }

    /// Diagnostic LED (feature `led-ball-diag`, round 7): tell which layer of
    /// the LEFT (central-local) PMW3610 pipeline is alive when the scroll
    /// next dies silently. Priority order (top wins), each a swap-and-check
    /// against the previous 50 ms tick:
    ///   Magenta (round 9, TOP priority): still within `BOOT_MARKER_WINDOW_MS`
    ///            of boot. `Instant::now()` is embassy-time UPTIME (monotonic
    ///            from power-on), so this is a literal boot marker, not a
    ///            state read. A magenta flash appearing SPONTANEOUSLY mid-
    ///            session (not at the user's own power-on) means the central
    ///            just rebooted — this is round 9's diagnostic for whether a
    ///            crash/brownout is happening (the hypothesis behind
    ///            reverting `patch_rmk_bitbang_atomic_bytes`, suspected of
    ///            tripping an MPSL interrupt-latency assert into a reset).
    ///            Reuses `Color::Purple`'s RGB (red+blue) — on this common-
    ///            anode LED that already IS magenta, so no new variant is
    ///            needed; this mode and the normal layer-indicator's Purple
    ///            (layer 4) never run in the same build (mutually exclusive
    ///            via the `led-ball-diag` / normal `cfg!` branch below).
    ///   Red    : sensor init never reached Ready this session (SDIO wedged;
    ///            see `patch_rmk_pmw3610_init_retry_forever`).
    ///   White  : an all-0xff burst frame was rejected since the last tick
    ///            (chronic flaky-SPI garbage; see
    ///            `patch_rmk_pmw3610_reject_ff_frame`).
    ///   Blue   : a scroll HID report was actually emitted since the last
    ///            tick (firmware fine end-to-end; a dead scroll with blue
    ///            still flashing points at macOS, not the firmware).
    ///   Green  : the sensor produced non-zero motion samples but none made
    ///            it to an emitted report (processor/channel layer eating
    ///            them).
    ///   Off    : Ready, no 0xff rejects, no samples at all this tick — the
    ///            sensor is configured but producing nothing (the
    ///            misconfigured-sensor / torn-write mode
    ///            `patch_rmk_pmw3610_verify_init_writes` targets).
    #[allow(dead_code)]
    fn diag_ball_apply(&mut self) {
        const BOOT_MARKER_WINDOW_MS: u64 = 5_000;
        let color = if Instant::now().as_millis() < BOOT_MARKER_WINDOW_MS {
            Color::Purple
        } else if !config::ball_init_ready() {
            Color::Red
        } else if config::take_ball_ff_rejects() > 0 {
            Color::White
        } else if config::take_scroll_emits() > 0 {
            Color::Blue
        } else if config::take_ball_motion_samples() > 0 {
            Color::Green
        } else {
            Color::Off
        };
        self.apply(color);
    }

    /// Show solid blue for at least `d` from now. Extend-only: a 1 s
    /// encryption-edge flash landing inside a 3 s BLE-connect confirmation
    /// must not cut it short.
    fn hold_solid(&mut self, d: Duration) {
        let until = Instant::now() + d;
        if until > self.blue_until {
            self.blue_until = until;
        }
    }

    fn apply(&mut self, color: Color) {
        // No "already showing this color" early-return: pins are re-asserted
        // on every call (≤ every 50 ms tick, 3 GPIO writes — free), so
        // `current` can never silently diverge from the physical pins.
        // (r, g, b) — true means LED on. Common-anode: LOW = on, HIGH = off.
        let (r, g, b) = match color {
            Color::Off => (false, false, false),
            Color::Green => (false, true, false),
            Color::Yellow => (true, true, false),
            Color::Red => (true, false, false),
            Color::Blue => (false, false, true),
            Color::Cyan => (false, true, true),
            Color::Purple => (true, false, true),
            Color::White => (true, true, true),
        };
        if r {
            self.red.set_low();
        } else {
            self.red.set_high();
        }
        if g {
            self.green.set_low();
        } else {
            self.green.set_high();
        }
        if b {
            self.blue.set_low();
        } else {
            self.blue.set_high();
        }
        self.current = color;
    }
}

impl<'d> Controller for StatusLedController<'d> {
    type Event = LedEvent;

    async fn process_event(&mut self, event: LedEvent) {
        match event {
            LedEvent::Battery(percent) => {
                self.battery = BatteryColor::from_percent(percent);
                // Re-arm the boot window from the FIRST sample's arrival:
                // the 5 s used to run from construction, so a slow ADC
                // pipeline (or a user looking up a beat late) could see the
                // window half-spent dark. Now the full battery color always
                // shows once, whenever the first sample lands.
                if !self.battery_window_pinned {
                    self.battery_window_pinned = true;
                    self.boot_until = Instant::now() + BOOT_BATTERY_WINDOW;
                }
            }
            LedEvent::SplitConnected(true) => {
                self.split_connected = true;
            }
            LedEvent::SplitConnected(false) => {
                // Published at the top of every connect attempt (~every 5.5 s
                // while the right half is away) and after a disconnect — every
                // `false` means "not connected right now", which we render red.
                self.split_connected = false;
            }
            LedEvent::Layer(layer) => {
                self.layer = layer;
            }
            LedEvent::BleWaiting => {
                // Re-arm on every announcement: rmk republishes Advertising at
                // the top of each attempt, and a profile switch lands here too.
                self.ble_waiting = true;
                self.ble_wait_until = Instant::now() + BLE_WAIT_MAX;
            }
            LedEvent::BleConnected => {
                self.ble_waiting = false;
                self.hold_solid(BLE_CONNECT_SOLID);
            }
            LedEvent::BleResolved => {
                self.ble_waiting = false;
            }
        }
        if cfg!(feature = "led-ball-diag") {
            // Diagnostic mode: the ball-diag band is driven by update() every
            // 50ms; battery/layer events do not repaint the LED.
            self.diag_ball_apply();
        } else if cfg!(feature = "led-conn-diag") {
            // Diagnostic mode: the host-interval band is driven by update()
            // every 50ms; battery/layer events do not repaint the LED.
            self.diag_apply();
        } else {
            let color = self.target_color();
            self.apply(color);
        }
    }

    /// Wait for a relevant `ControllerEvent` on `CONTROLLER_CHANNEL`. We act on
    /// `Battery` (boot battery color), `SplitPeripheral` (split-link indicator;
    /// kobu has exactly one peripheral so the id is ignored) and `Layer` (layer
    /// indicator); everything else is filtered out so `process_event` isn't
    /// woken for nothing. The host link has no controller event — it is polled
    /// in [`Self::refresh_host_edge`] from `update()`.
    async fn next_message(&mut self) -> LedEvent {
        loop {
            match self.sub.next_message_pure().await {
                ControllerEvent::Battery(percent) => return LedEvent::Battery(percent),
                ControllerEvent::SplitPeripheral(_id, connected) => {
                    return LedEvent::SplitConnected(connected);
                }
                ControllerEvent::Layer(layer) => return LedEvent::Layer(layer),
                // BLE link state, the authoritative source for this
                // indicator. `Advertising` is republished at the top of every
                // attempt, so a profile switch, a reconnect and boot all
                // arrive here; `Connected` ends the wait; `None` means USB
                // took over or advertising timed out into sleep.
                ControllerEvent::BleState(_profile, state) => match state {
                    rmk::ble::BleState::Advertising => return LedEvent::BleWaiting,
                    rmk::ble::BleState::Connected => return LedEvent::BleConnected,
                    rmk::ble::BleState::None => return LedEvent::BleResolved,
                },
                // A profile switch (layer-3 BT_SEL) tears the current link
                // down and re-advertises; start blinking at the keypress
                // rather than waiting for the stack to come round.
                ControllerEvent::BleProfile(_profile) => return LedEvent::BleWaiting,
                _ => continue,
            }
        }
    }
}

impl<'d> PollingController for StatusLedController<'d> {
    /// Poll often enough that the window expiries and the host-connect edge
    /// feel snappy; 50 ms is well under the human "LED stuck" threshold.
    const INTERVAL: Duration = Duration::from_millis(50);

    async fn update(&mut self) {
        if cfg!(feature = "led-ball-diag") {
            self.diag_ball_apply();
        } else if cfg!(feature = "led-conn-diag") {
            self.diag_apply();
        } else {
            let color = self.target_color();
            self.apply(color);
        }
    }
}
