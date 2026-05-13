#![no_main]
#![no_std]

mod scroll_processor;

use rmk::macros::rmk_central;

#[rmk_central]
mod keyboard_central {
    use crate::scroll_processor::ScrollProcessor;

    // Override the macro-generated entry so we can swap the default
    // `Pmw3610Processor` (which emits MouseReport x/y) for our own
    // `ScrollProcessor` (which emits MouseReport wheel). All other
    // generated bindings (`left_device`, `matrix`, `keyboard`, `keymap`,
    // `driver`, `stack`, `storage`, `rmk_config`, `peripheral_addrs`)
    // remain in scope and are reused verbatim.
    //
    // The variable names emitted by the rmk_macro 0.7 pmw3610 expansion are
    // `<sensor.name>_device` and `<sensor.name>_processor` (no `pmw3610_`
    // prefix); with `name = "left"` in keyboard.toml those are
    // `left_device` and `left_processor`.
    #[Overwritten(entry)]
    async fn rmk_entry() {
        use ::rmk::input_device::Runnable;

        // Discard the macro-generated default processor.
        let _ = left_processor;

        let mut scroll_processor = ScrollProcessor::new(&keymap);

        ::rmk::embassy_futures::join::join(
            ::rmk::embassy_futures::join::join(
                ::rmk::embassy_futures::join::join(
                    ::rmk::embassy_futures::join::join(
                        ::rmk::embassy_futures::join::join(
                            ::rmk::run_devices!(
                                (left_device, matrix) => ::rmk::channel::EVENT_CHANNEL,
                            ),
                            keyboard.run(),
                        ),
                        ::rmk::run_rmk(&keymap, driver, &stack, &mut storage, rmk_config),
                    ),
                    ::rmk::run_processor_chain!(
                        ::rmk::channel::EVENT_CHANNEL => [scroll_processor],
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
