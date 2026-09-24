#![no_main]
#![no_std]

mod peripheral_led;
mod set_token;

use rmk::macros::rmk_peripheral;

#[rmk_peripheral(id = 0)]
mod keyboard_peripheral {
    // Bring the trait into scope so the macro-generated task join can call
    // `peripheral_led.polling_loop()` (mirrors the central's entry).
    use ::rmk::controller::PollingController;
    use crate::peripheral_led::PeripheralLedController;

    // Dynamic onboard RGB LED on the RIGHT half (replaces the old static green
    // output). The rmk_peripheral macro extracts this body into
    // `let mut peripheral_led = { <body> };` in the entry scope (after chip
    // init, before device init) and joins `peripheral_led.polling_loop()` into
    // the peripheral's task set — same mechanism as the central's status_led.
    //
    // P0_26 / P0_30 / P0_06 are claimed from `p` here. They are NOT declared as
    // static `[[split.peripheral.output]]` pins in keyboard.toml (the static
    // P0_30 green output was removed), so they are still owned by `p`.
    //
    // Controller initializers run before the split machinery starts, so this
    // block doubles as our earliest boot hook for the set-token stamp.
    #[controller(poll)]
    fn peripheral_led() {
        use ::embassy_nrf::gpio::{Level, Output, OutputDrive};
        // Multi-set independence: advertise THIS set's token so only our own
        // central scan-binds this half (see src/set_token.rs).
        crate::set_token::apply_split_set_token();
        let red = Output::new(p.P0_26, Level::High, OutputDrive::Standard);
        let green = Output::new(p.P0_30, Level::High, OutputDrive::Standard);
        let blue = Output::new(p.P0_06, Level::High, OutputDrive::Standard);
        PeripheralLedController::new(red, green, blue)
    }
}
