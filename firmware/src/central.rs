#![no_main]
#![no_std]

mod battery_source;
mod config;
mod status_led;
mod trackball;

use rmk::macros::rmk_central;

#[rmk_central]
mod keyboard_central {
    use crate::battery_source::{CentralBatteryTagger, KobuBatterySourceTap};
    use crate::status_led::StatusLedController;
    use crate::trackball::{AxisRelabel, PointerProcessor, ScrollProcessor, run_pointer_flush};

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

        // Wrap the macro-generated `adc_device` so its `Event::Battery`
        // samples arrive with the kobu source-tag bit set. The upstream
        // `BatteryProcessor` never sees the bit because
        // `KobuBatterySourceTap` (chain head) strips it before forwarding
        // central samples downstream. The tap also mirrors each side's
        // percentage into `rmk::input_device::battery::KOBU_*_BATTERY_PERCENT`
        // so the patched Via Custom Get handler can answer kobu-config polls.
        let mut tagged_adc = CentralBatteryTagger::new(adc_device);
        let mut battery_source_tap = KobuBatterySourceTap::new(&keymap);

        // "ビュンビュン" default: assert a 2.5× pointer-CPI multiplier at
        // boot (effective ~2000 CPI over the 800 hardware CPI). The
        // multiplier is applied in trackball.rs::run_pointer_flush and is
        // live-tunable from kobu-config (Via Custom Channel 0xC0 id 0x01,
        // range 0.2×–3.2×). Persistence across reboots is a follow-up, so
        // we re-assert the snappy default every boot rather than relying
        // on the atomic's 1000 (= 1.0×) initialiser.
        ::rmk::input_device::battery::KOBU_TRACKBALL_CPI
            .store(2500, ::core::sync::atomic::Ordering::Relaxed);

        ::rmk::embassy_futures::join::join(
            ::rmk::embassy_futures::join::join(
                ::rmk::embassy_futures::join::join(
                    ::rmk::embassy_futures::join::join(
                        ::rmk::embassy_futures::join::join(
                            ::rmk::embassy_futures::join::join(
                                ::rmk::run_devices!(
                                    (left_relabeled, tagged_adc, matrix) => ::rmk::channel::EVENT_CHANNEL,
                                ),
                                keyboard.run(),
                            ),
                            ::rmk::run_rmk(&keymap, driver, &stack, &mut storage, rmk_config),
                        ),
                        ::rmk::run_processor_chain!(
                            ::rmk::channel::EVENT_CHANNEL => [battery_source_tap, scroll_processor, pointer_processor, battery_processor],
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
            ::rmk::embassy_futures::join::join(
                status_led.polling_loop(),
                // Drain the coalesced pointer accumulator to the host at
                // the BLE report rate. Decouples the 2 kHz PMW3610 event
                // rate from the slower wireless HID link so trackball
                // motion is summed, not dropped. See src/trackball.rs.
                run_pointer_flush(),
            ),
        )
        .await;
    }
}
