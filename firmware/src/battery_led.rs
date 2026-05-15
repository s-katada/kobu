//! Battery-percentage → onboard RGB LED color controller (LEFT / central half).
//!
//! Subscribes to RMK's `CONTROLLER_CHANNEL`, watches `ControllerEvent::Battery`
//! (published by `BatteryProcessor` once the SAADC has produced a reading),
//! and drives the XIAO nRF52840's onboard RGB LED to one of three colors:
//!
//!   * `> HIGH_THRESHOLD`  → Green  (R off, G on,  B off)
//!   * `> LOW_THRESHOLD`   → Yellow (R on,  G on,  B off)
//!   * otherwise            → Red    (R on,  G off, B off)
//!
//! The XIAO RGB LED is common-anode: drive pin LOW = LED on, HIGH = off.
//! On the LEFT board the relevant nRF52840 pins are R=P0.26, G=P0.30, B=P0.06.

use embassy_nrf::gpio::Output;
use rmk::channel::{CONTROLLER_CHANNEL, ControllerSub};
use rmk::controller::Controller;
use rmk::event::ControllerEvent;

/// Battery percentage above which the LED is green.
const HIGH_THRESHOLD: u8 = 60;
/// Battery percentage above which the LED is yellow. Below this threshold
/// the LED turns red.
const LOW_THRESHOLD: u8 = 20;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Color {
    Green,
    Yellow,
    Red,
    Off,
}

pub struct BatteryLedController<'d> {
    red: Output<'d>,
    green: Output<'d>,
    blue: Output<'d>,
    sub: ControllerSub,
    color: Color,
}

impl<'d> BatteryLedController<'d> {
    /// Create a new controller. All three pins are expected to be initialized
    /// with `Level::High` (LED off) so the LED is dark until the first
    /// battery reading arrives.
    pub fn new(red: Output<'d>, green: Output<'d>, blue: Output<'d>) -> Self {
        Self {
            red,
            green,
            blue,
            sub: CONTROLLER_CHANNEL.subscriber().unwrap(),
            color: Color::Off,
        }
    }

    fn apply(&mut self, color: Color) {
        if self.color == color {
            return;
        }
        let (r_on, g_on, b_on) = match color {
            Color::Green => (false, true, false),
            Color::Yellow => (true, true, false),
            Color::Red => (true, false, false),
            Color::Off => (false, false, false),
        };
        // Common-anode: LOW = on, HIGH = off.
        if r_on {
            self.red.set_low();
        } else {
            self.red.set_high();
        }
        if g_on {
            self.green.set_low();
        } else {
            self.green.set_high();
        }
        if b_on {
            self.blue.set_low();
        } else {
            self.blue.set_high();
        }
        self.color = color;
    }
}

impl<'d> Controller for BatteryLedController<'d> {
    type Event = ControllerEvent;

    async fn process_event(&mut self, event: ControllerEvent) {
        if let ControllerEvent::Battery(percent) = event {
            let color = if percent > HIGH_THRESHOLD {
                Color::Green
            } else if percent > LOW_THRESHOLD {
                Color::Yellow
            } else {
                Color::Red
            };
            self.apply(color);
        }
    }

    async fn next_message(&mut self) -> ControllerEvent {
        self.sub.next_message_pure().await
    }
}
