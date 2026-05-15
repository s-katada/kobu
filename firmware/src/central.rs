#![no_main]
#![no_std]

mod trackball;

use rmk::macros::rmk_central;

#[rmk_central]
mod keyboard_central {
    use crate::trackball::{AxisRelabel, PointerProcessor, ScrollProcessor};

    // Override the macro-generated entry so we can:
    //   1. wrap the local PMW3610 device with AxisRelabel (X→H, Y→V), and
    //   2. run our own [ScrollProcessor, PointerProcessor] chain instead of
    //      the default Pmw3610Processor pair the macro would emit for the
    //      central's "left" and the peripheral's "right" devices.
    //
    // Variable bindings still in scope from the macro:
    //   * `left_device`, `left_processor`     — central-local PMW3610
    //                                           (`name = "left"` in toml)
    //   * `right_processor`                    — placeholder for the
    //                                           peripheral PMW3610 (name =
    //                                           "right"); the device itself
    //                                           runs on the peripheral
    //   * `matrix`, `keyboard`, `keymap`, `storage`, `driver`, `stack`,
    //     `rmk_config`, `peripheral_addrs`     — boilerplate from the macro
    #[Overwritten(entry)]
    async fn rmk_entry() {
        use ::rmk::input_device::Runnable;

        // Discard the macro-generated default Pmw3610Processor bindings;
        // we route through our own chain below.
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
                            ::rmk::run_devices!(
                                (left_relabeled, matrix) => ::rmk::channel::EVENT_CHANNEL,
                            ),
                            keyboard.run(),
                        ),
                        ::rmk::run_rmk(&keymap, driver, &stack, &mut storage, rmk_config),
                    ),
                    ::rmk::run_processor_chain!(
                        ::rmk::channel::EVENT_CHANNEL => [scroll_processor, pointer_processor],
                    ),
                ),
                ::rmk::split::central::run_peripheral_manager::<4, 5, 0, 5, _>(
                    0,
                    &peripheral_addrs,
                    &stack,
                ),
            ),
            ::rmk::split::ble::central::scan_peripherals(&stack, &peripheral_addrs),
        )
        .await;
    }
}
