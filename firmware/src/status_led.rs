//! Onboard RGB LED status controller for the LEFT / central half.
//!
//! Combines three state sources on the same R/G/B GPIOs (P0.26 / P0.30 / P0.06,
//! all common-anode: pin LOW = on):
//!
//! 1. **Battery percent** — subscribed from `CONTROLLER_CHANNEL`. Determines
//!    the *base* color shown when nothing else is going on:
//!      * `> 60%` → green
//!      * `> 20%` → yellow (red + green)
//!      * `≤ 20%` → red
//!
//! 2. **Physical VBUS (USB cable) presence** — sampled directly from the
//!    nRF52840 POWER peripheral's `USBREGSTATUS.VBUSDETECT` flag on every
//!    [`update`] tick. This is what hardware actually signals (USB cable
//!    plugged in supplying power), unlike `ControllerEvent::ConnectionType`
//!    which tracks the user's stored output preference. When VBUS is high
//!    the keyboard is being powered through USB, so the red "low battery"
//!    warning is not informative — the LED is forced to green for that case
//!    (covers "no battery plugged in" and "battery so dead it reads 0%").
//!    Yellow and green battery states pass through unchanged. Safe to share
//!    the POWER peripheral with embassy-nrf's `HardwareVbusDetect` because
//!    `USBREGSTATUS` is read-only and atomic.
//!
//! 3. **Peripheral trackball activity** — subscribed from
//!    [`crate::trackball::PERIPHERAL_ACTIVITY`], which the
//!    [`crate::trackball::PointerProcessor`] pulses on every Joystick(X,Y)
//!    event forwarded from the peripheral. While the peripheral ball has
//!    been moving in the last [`PURPLE_HOLD`], the LED is forced to purple
//!    (red + blue). Once the hold window expires the LED returns to the
//!    battery / VBUS color.
//!
//! Implemented as a [`PollingController`] so the 200 ms "purple hold" can
//! deterministically expire via the periodic [`update`] tick even when no
//! new events arrive — the same tick also re-samples VBUS so a USB-cable
//! plug / unplug is reflected on the LED within ≤ 50 ms.

use embassy_nrf::gpio::Output;
use embassy_nrf::pac;
use embassy_time::{Duration, Instant};
use rmk::channel::{CONTROLLER_CHANNEL, ControllerSub};
use rmk::controller::{Controller, PollingController};
use rmk::event::ControllerEvent;

use crate::config;
use crate::trackball::PERIPHERAL_ACTIVITY;

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
    Purple,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BatteryColor {
    Unknown,
    Green,
    Yellow,
    Red,
}

impl BatteryColor {
    /// Battery thresholds are read live from `crate::config` so a
    /// future Vial `CustomSetValue` write retunes them without a
    /// reboot. Defaults (60 / 20) match the previous hardcoded
    /// constants.
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
/// `ControllerEvent` enum so `process_event` doesn't see chatter it can't
/// act on).
pub enum LedEvent {
    Battery(u8),
    PeripheralActivity,
}

pub struct StatusLedController<'d> {
    red: Output<'d>,
    green: Output<'d>,
    blue: Output<'d>,
    sub: ControllerSub,
    battery: BatteryColor,
    peripheral_active_until: Option<Instant>,
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
            peripheral_active_until: None,
            current: Color::Off,
        }
    }

    fn target_color(&self) -> Color {
        match self.peripheral_active_until {
            Some(until) if until > Instant::now() => Color::Purple,
            _ => {
                let base = self.battery.as_color();
                // While USB cable is plugged in (VBUS high), suppress the
                // "low battery" red — there is no battery (or it reads 0%)
                // but the keyboard is being powered by the cable, so red is
                // a false alarm. Yellow / green still pass through to
                // reflect a healthy battery alongside USB (charging).
                if vbus_present() && base == Color::Red {
                    Color::Green
                } else {
                    base
                }
            }
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
            Color::Purple => (true, false, true),
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
            LedEvent::PeripheralActivity => {
                // Hold window is live-tunable via `crate::config`.
                // Default is 200 ms; a value of 0 disables the purple
                // overlay entirely.
                let hold = config::status_led_purple_hold();
                self.peripheral_active_until = if hold == Duration::from_ticks(0) {
                    None
                } else {
                    Some(Instant::now() + hold)
                };
            }
        }
        let color = self.target_color();
        self.apply(color);
    }

    /// Wait for either a relevant `ControllerEvent` on `CONTROLLER_CHANNEL`
    /// or a pulse on `PERIPHERAL_ACTIVITY`. Irrelevant events (everything
    /// other than `Battery`) are filtered out here so `process_event`
    /// doesn't wake up the LED logic for nothing. VBUS state is sampled
    /// directly inside [`target_color`] / [`update`], not delivered as an
    /// event — embassy-nrf's `HardwareVbusDetect` owns the POWER interrupt.
    async fn next_message(&mut self) -> LedEvent {
        use rmk::embassy_futures::select::{Either, select};
        loop {
            match select(self.sub.next_message_pure(), PERIPHERAL_ACTIVITY.wait()).await {
                Either::First(ControllerEvent::Battery(percent)) => return LedEvent::Battery(percent),
                Either::First(_) => continue,
                Either::Second(()) => return LedEvent::PeripheralActivity,
            }
        }
    }
}

impl<'d> PollingController for StatusLedController<'d> {
    /// Poll fast enough that the 200 ms purple-hold expiry feels snappy.
    /// 50 ms gives ≤ 50 ms latency on transitions, well under the human
    /// perceptual threshold for "LED stuck on".
    const INTERVAL: Duration = Duration::from_millis(50);

    async fn update(&mut self) {
        // Drop the active-until marker once it has expired so we don't
        // keep recomputing the same comparison forever.
        if let Some(until) = self.peripheral_active_until {
            if until <= Instant::now() {
                self.peripheral_active_until = None;
            }
        }
        let color = self.target_color();
        self.apply(color);
    }
}

