#![no_main]
#![no_std]

mod config;
mod status_led;
mod trackball;

use rmk::macros::rmk_central;

#[rmk_central]
mod keyboard_central {
    use crate::status_led::StatusLedController;
    use crate::trackball::{AxisRelabel, PointerProcessor, ScrollProcessor};

    // Status LED controller declared via the `rmk_macro` controller
    // attribute. The macro extracts the function body and emits
    // `let mut status_led = { <body> };` into the entry scope before our
    // override runs, so `status_led` is available below when we wire it
    // into the task join.
    //
    // The R/G/B pins are claimed from `p` here — they're not registered
    // as static `[[output]]` pins in keyboard.toml so `p.P0_26`,
    // `p.P0_30`, and `p.P0_06` are still owned by the peripherals struct
    // at this point. Uses `#[controller(poll)]` so the controller's
    // `update()` tick can deterministically expire the purple
    // peripheral-activity hold window.
    #[controller(poll)]
    fn status_led() {
        use ::embassy_nrf::gpio::{Level, Output, OutputDrive};
        let red = Output::new(p.P0_26, Level::High, OutputDrive::Standard);
        let green = Output::new(p.P0_30, Level::High, OutputDrive::Standard);
        let blue = Output::new(p.P0_06, Level::High, OutputDrive::Standard);
        StatusLedController::new(red, green, blue)
    }

    // Override the macro-generated entry so we can:
    //   1. wrap the central-local PMW3610 with `AxisRelabel` (X→H, Y→V),
    //   2. run `[ScrollProcessor, PointerProcessor, battery_processor]` as
    //      the processor chain, and
    //   3. spawn `battery_color_led` alongside everything else.
    //
    // Variable bindings still in scope from the macro at this point:
    //   * `left_device`, `left_processor`      — central-local PMW3610
    //   * `right_processor`                     — placeholder for the
    //                                             peripheral PMW3610
    //   * `adc_device`, `battery_processor`     — SAADC + battery decoder
    //                                             (from `[ble]` config)
    //   * `status_led`                          — our controller (above)
    //   * `matrix`, `keyboard`, `keymap`,
    //     `storage`, `driver`, `stack`,
    //     `rmk_config`, `peripheral_addrs`      — boilerplate from the macro
    #[Overwritten(entry)]
    async fn rmk_entry() {
        use ::rmk::controller::PollingController;
        use ::rmk::input_device::Runnable;

        // Discard the macro-generated default Pmw3610Processor bindings.
        let _ = left_processor;
        let _ = right_processor;

        let mut left_relabeled = AxisRelabel::new(left_device);
        let mut scroll_processor = ScrollProcessor::new(&keymap);
        let mut pointer_processor = PointerProcessor::new(&keymap);

        ::rmk::embassy_futures::join::join(
            ::rmk::embassy_futures::join::join(
                ::rmk::embassy_futures::join::join(
                    ::rmk::embassy_futures::join::join(
                        ::rmk::embassy_futures::join::join(
                            ::rmk::embassy_futures::join::join(
                                ::rmk::run_devices!(
                                    (left_relabeled, adc_device, matrix) => ::rmk::channel::EVENT_CHANNEL,
                                ),
                                keyboard.run(),
                            ),
                            ::rmk::run_rmk(&keymap, driver, &stack, &mut storage, rmk_config),
                        ),
                        ::rmk::run_processor_chain!(
                            ::rmk::channel::EVENT_CHANNEL => [scroll_processor, pointer_processor, battery_processor],
                        ),
                    ),
                    ::rmk::split::central::run_peripheral_manager::<4, 5, 0, 5, _>(
                        0,
                        &peripheral_addrs,
                        &stack,
                    ),
                ),
                ::rmk::split::ble::central::scan_peripherals(&stack, &peripheral_addrs),
            ),
            status_led.polling_loop(),
        )
        .await;
    }
}
