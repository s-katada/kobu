//! Onboard RGB LED status controller for the RIGHT / peripheral half.
//!
//! State (per the user spec):
//!
//!   * Boot battery window: for the first few seconds after power-on, show the
//!     BATTERY colour (green / yellow / red by %), as long as we are NOT yet
//!     connected to the central.
//!   * NOT connected to the central (peripheral-only startup, and after a
//!     disconnect): solid RED once the boot battery window has elapsed. RED is
//!     the resting state whenever there is no central link — whether or not we
//!     were ever connected.
//!   * Connected to the central (`ControllerEvent::SplitCentral(true)`): flash
//!     BLUE briefly, then OFF.
//!
//! Connection state arrives as `ControllerEvent::SplitCentral(bool)` from rmk's
//! split BLE peripheral loop: `false` is published at boot AND on every
//! advertise restart (so "not connected" is announced even when never
//! connected), `true` on connect. We treat EVERY `false` as "not connected" —
//! no special-casing of the boot announcement, because not-connected is exactly
//! the state we render as red.
//!
//! Battery arrives as `ControllerEvent::Battery(percent)`. The peripheral has no
//! processor chain, so two build.rs patches make this fire:
//!   * `patch_rmk_split_peripheral_publish_battery` — decode+publish while
//!     CONNECTED (inside `SplitPeripheral::run`).
//!   * `patch_rmk_split_peripheral_decode_battery_while_advertising` — decode+
//!     publish while ADVERTISING / not connected, which is what makes the boot
//!     battery colour appear on a peripheral started alone.
//!
//! R/G/B GPIOs P0.26 / P0.30 / P0.06 are common-anode: pin LOW = on, exactly
//! like the central (`src/status_led.rs`).

use core::sync::atomic::Ordering;

use embassy_nrf::gpio::Output;
use embassy_time::{Duration, Instant};
use rmk::channel::{CONTROLLER_CHANNEL, ControllerSub};
use rmk::controller::{Controller, PollingController};
use rmk::event::ControllerEvent;
use rmk::input_device::battery::{KOBU_STATUS_LED_BAT_HIGH, KOBU_STATUS_LED_BAT_LOW};

/// How long the boot battery colour is shown (while not connected) before
/// falling through to red.
const BOOT_BATTERY_WINDOW: Duration = Duration::from_secs(5);
/// How long the blue "connected" flash stays lit before going dark.
const CONNECTED_BLUE_WINDOW: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Color {
    Off,
    Green,
    Yellow,
    Red,
    Blue,
}

/// Battery percent → colour, using the same thresholds as the central (the
/// `KOBU_STATUS_LED_BAT_*` atomics, defaults 60 / 20). Read directly here rather
/// than via `crate::config` so the peripheral binary doesn't pull in the
/// central-only trackball/scroll helpers. On the peripheral these atomics keep
/// their defaults (the Vial write handler lives on the central).
fn battery_color(percent: u8) -> Color {
    let high = KOBU_STATUS_LED_BAT_HIGH.load(Ordering::Relaxed);
    let low = KOBU_STATUS_LED_BAT_LOW.load(Ordering::Relaxed);
    if percent > high {
        Color::Green
    } else if percent > low {
        Color::Yellow
    } else {
        Color::Red
    }
}

/// Internal event type (decoupled from the wider `ControllerEvent`).
pub enum PeriLedEvent {
    Battery(u8),
    Connected(bool),
}

pub struct PeripheralLedController<'d> {
    red: Output<'d>,
    green: Output<'d>,
    blue: Output<'d>,
    sub: ControllerSub,
    /// True iff currently connected to the central. Defaults to false: a
    /// peripheral powered on alone is not connected, so (after the boot battery
    /// window) it shows red.
    connected: bool,
    /// Last battery % seen (only valid once `have_battery`).
    battery: u8,
    have_battery: bool,
    boot_until: Instant,
    blue_until: Instant,
    current: Color,
    /// Diagnostic (led-conn-diag): pointer-production-rate window state — unused
    /// in the normal build.
    #[allow(dead_code)]
    samples_accum: u32,
    #[allow(dead_code)]
    last_rate: u32,
    #[allow(dead_code)]
    window_start: Instant,
}

impl<'d> PeripheralLedController<'d> {
    /// All three pins expected initialized `Level::High` (LED off).
    pub fn new(red: Output<'d>, green: Output<'d>, blue: Output<'d>) -> Self {
        Self {
            red,
            green,
            blue,
            sub: CONTROLLER_CHANNEL.subscriber().unwrap(),
            connected: false,
            battery: 0,
            have_battery: false,
            boot_until: Instant::now() + BOOT_BATTERY_WINDOW,
            blue_until: Instant::now(),
            current: Color::Off,
            samples_accum: 0,
            last_rate: 0,
            window_start: Instant::now(),
        }
    }

    fn target_color(&self) -> Color {
        if self.connected {
            // Connected: blue flash, then off.
            if Instant::now() < self.blue_until {
                Color::Blue
            } else {
                Color::Off
            }
        } else {
            // Not connected (peripheral-only startup, or after a disconnect):
            // battery colour during the boot window, then red. Red is the
            // resting state of an unconnected peripheral.
            if Instant::now() < self.boot_until && self.have_battery {
                battery_color(self.battery)
            } else {
                Color::Red
            }
        }
    }

    /// Diagnostic (feature `led-conn-diag`), v2 — 追従遅延 hunt: show the DEPTH
    /// of this peripheral's EVENT_CHANNEL (the 16-deep queue between the PMW3610
    /// device loop and the split write loop). If pointer samples pool here, queue
    /// depth IS cursor latency (each slot ≈ one 8 ms sample the cursor is behind
    /// the hand). Sampled every 50 ms poll, PEAK-held over a ~500 ms window so a
    /// transiently-deep queue is visible to the eye.
    ///   Green: 0–1 (no backlog) · Blue: 2–3 · Yellow: 4–7 · Red: ≥8 (≥64 ms behind).
    /// Mouse continuously and watch the RIGHT half's LED: solid Green during lag
    /// = the backlog is NOT here (suspicion moves to the central); Yellow/Red =
    /// found it (flash the step6-coalesce peripheral UF2).
    #[allow(dead_code)]
    fn diag_apply(&mut self) {
        let depth = rmk::channel::EVENT_CHANNEL.len() as u32;
        // Peak-hold: samples_accum doubles as the window's max depth.
        if depth > self.samples_accum {
            self.samples_accum = depth;
        }
        if Instant::now() - self.window_start >= Duration::from_millis(500) {
            self.last_rate = self.samples_accum; // displayed peak
            self.samples_accum = 0;
            self.window_start = Instant::now();
        }
        let peak = self.last_rate.max(self.samples_accum);
        let color = if peak >= 8 {
            Color::Red
        } else if peak >= 4 {
            Color::Yellow
        } else if peak >= 2 {
            Color::Blue
        } else {
            Color::Green
        };
        self.apply(color);
    }

    fn apply(&mut self, color: Color) {
        if self.current == color {
            return;
        }
        // (r, g, b) — true = on. Common-anode: LOW = on, HIGH = off.
        let (r, g, b) = match color {
            Color::Off => (false, false, false),
            Color::Green => (false, true, false),
            Color::Yellow => (true, true, false),
            Color::Red => (true, false, false),
            Color::Blue => (false, false, true),
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

impl<'d> Controller for PeripheralLedController<'d> {
    type Event = PeriLedEvent;

    async fn process_event(&mut self, event: PeriLedEvent) {
        match event {
            PeriLedEvent::Battery(p) => {
                self.battery = p;
                self.have_battery = true;
            }
            PeriLedEvent::Connected(true) => {
                self.connected = true;
                self.blue_until = Instant::now() + CONNECTED_BLUE_WINDOW;
            }
            PeriLedEvent::Connected(false) => {
                // Every SplitCentral(false) — boot announcement, advertise
                // restart, or real disconnect — means "not connected", which we
                // render as red (after the boot battery window). No boot-vs-loss
                // distinction needed.
                self.connected = false;
            }
        }
        if cfg!(feature = "led-conn-diag") {
            self.diag_apply();
        } else {
            let color = self.target_color();
            self.apply(color);
        }
    }

    /// Act only on `Battery` (boot colour) and `SplitCentral` (connected/lost);
    /// filter the rest so `process_event` isn't woken for nothing.
    async fn next_message(&mut self) -> PeriLedEvent {
        loop {
            match self.sub.next_message_pure().await {
                ControllerEvent::Battery(p) => return PeriLedEvent::Battery(p),
                ControllerEvent::SplitCentral(c) => return PeriLedEvent::Connected(c),
                _ => continue,
            }
        }
    }
}

impl<'d> PollingController for PeripheralLedController<'d> {
    /// Poll often enough that the boot-window → red transition (and blue-flash
    /// expiry) fire even without new events.
    const INTERVAL: Duration = Duration::from_millis(50);

    async fn update(&mut self) {
        if cfg!(feature = "led-conn-diag") {
            self.diag_apply();
        } else {
            let color = self.target_color();
            self.apply(color);
        }
    }
}
