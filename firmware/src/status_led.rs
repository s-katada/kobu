//! Onboard RGB LED status controller for the LEFT / central half.
//!
//! Power-conscious behavior (the LED used to be lit continuously, which is a
//! real drain on the small LiPo):
//!
//! 1. **Boot battery indication** — for [`BOOT_BATTERY_WINDOW`] after power-on
//!    the LED shows the battery-level color (green / yellow / red), so the user
//!    sees the charge state at a glance. After the window it goes dark.
//!
//! 2. **Layer indicator** — whenever a NON-base layer is active the LED lights
//!    in that layer's color (see [`layer_color`]); back on the base layer it is
//!    off. RMK emits [`ControllerEvent::Layer`] on every layer change
//!    (`activate_layer`/`deactivate_layer`/`toggle_layer` → `update_tri_layer`),
//!    including the auto-mouse layer 4, momentary `LT` layers and `TG` toggles,
//!    so this covers them all. The auto-mouse layer (4) is purple, matching the
//!    old peripheral-activity flash.
//!
//! 3. Otherwise (base layer, past the boot window) the LED is **off** — common
//!    case during normal typing, so the LED draws no current at rest.
//!
//! The R/G/B GPIOs (P0.26 / P0.30 / P0.06) are common-anode: pin LOW = on.
//!
//! Implemented as a [`PollingController`] so the boot-window expiry is applied
//! within one [`INTERVAL`] tick even when no event arrives. The VBUS flag is
//! also re-sampled each tick so a USB plug/unplug is reflected during the boot
//! battery window.

use embassy_nrf::gpio::Output;
use embassy_nrf::pac;
use embassy_time::{Duration, Instant};
use rmk::channel::{CONTROLLER_CHANNEL, ControllerSub};
use rmk::controller::{Controller, PollingController};
use rmk::event::ControllerEvent;

use crate::config;

/// How long after boot the battery color is shown before the LED goes dark.
const BOOT_BATTERY_WINDOW: Duration = Duration::from_secs(5);

/// Read the nRF52840 POWER peripheral's VBUS-present flag. `true` means a
/// USB cable is plugged in and supplying power, regardless of which output
/// (USB vs BLE) the keyboard is currently routing key events through.
fn vbus_present() -> bool {
    pac::POWER.usbregstatus().read().vbusdetect()
}

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
        1 => Color::Blue,   // Win/Linux overlay
        2 => Color::Green,  // numbers / symbols
        3 => Color::Cyan,   // settings / media / BLE
        4 => Color::Purple, // mouse (auto-mouse layer)
        5 => Color::Yellow, // Emacs
        6 => Color::White,  // Neovim
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
    /// Battery thresholds are read live from `crate::config` so a future Vial
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
    Battery(u8),
    Layer(u8),
}

pub struct StatusLedController<'d> {
    red: Output<'d>,
    green: Output<'d>,
    blue: Output<'d>,
    sub: ControllerSub,
    battery: BatteryColor,
    /// Highest currently-active layer (0 = base). Updated from
    /// `ControllerEvent::Layer`.
    layer: u8,
    /// Instant after which the boot battery indication stops.
    boot_until: Instant,
    current: Color,
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
            layer: 0,
            // Boot window starts now (construction happens once, in the entry
            // scope after embassy init, so the time driver is live).
            boot_until: Instant::now() + BOOT_BATTERY_WINDOW,
            current: Color::Off,
        }
    }

    fn target_color(&self) -> Color {
        // A non-base layer being active always wins — that's the layer
        // indicator, and the user wants to see it whenever they're on a layer.
        if self.layer != 0 {
            return layer_color(self.layer);
        }
        // Base layer: show battery only during the boot window, else go dark to
        // save power.
        if Instant::now() < self.boot_until {
            let base = self.battery.as_color();
            // While USB is plugged in (VBUS high), suppress the "low battery"
            // red — there may be no battery (or it reads 0%) but the cable is
            // powering it, so red is a false alarm. Show green instead.
            if vbus_present() && base == Color::Red {
                Color::Green
            } else {
                base
            }
        } else {
            Color::Off
        }
    }

    fn apply(&mut self, color: Color) {
        if self.current == color {
            return;
        }
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
            }
            LedEvent::Layer(layer) => {
                self.layer = layer;
            }
        }
        let color = self.target_color();
        self.apply(color);
    }

    /// Wait for a relevant `ControllerEvent` on `CONTROLLER_CHANNEL`. We act on
    /// `Battery` (boot indication) and `Layer` (layer indicator); everything
    /// else is filtered out so `process_event` isn't woken for nothing. VBUS is
    /// sampled directly in [`target_color`] / [`update`], not delivered as an
    /// event — embassy-nrf's `HardwareVbusDetect` owns the POWER interrupt.
    async fn next_message(&mut self) -> LedEvent {
        loop {
            match self.sub.next_message_pure().await {
                ControllerEvent::Battery(percent) => return LedEvent::Battery(percent),
                ControllerEvent::Layer(layer) => return LedEvent::Layer(layer),
                _ => continue,
            }
        }
    }
}

impl<'d> PollingController for StatusLedController<'d> {
    /// Poll often enough that the boot-window expiry and VBUS changes feel
    /// snappy; 50 ms is well under the human "LED stuck" threshold.
    const INTERVAL: Duration = Duration::from_millis(50);

    async fn update(&mut self) {
        let color = self.target_color();
        self.apply(color);
    }
}
