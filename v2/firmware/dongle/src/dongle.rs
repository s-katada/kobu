//! Prospector display DONGLE — the split CENTRAL of the kobu2 dongle topology.
//!
//! USB-connected to the host; holds two BLE central links (peripheral id 0 =
//! RIGHT half, id 1 = LEFT half); no keys or trackball of its own (the 0x0
//! matrix from keyboard.toml parks forever under async_matrix); drives the
//! Prospector's ST7789V2 status screen (src/display.rs).
//!
//! The processor chain and helper tasks are the classic central's
//! (../rmk/src/{trackball,config,status_led}.rs shared via #[path]) with two
//! substitutions:
//!
//!   * No local AxisRelabel wrapper — the LEFT half's Joystick events arrive
//!     already relabeled X→H/Y→V by the registry patch
//!     `patch_rmk_peripheral_manager_source_disambiguation` (id 1 only), so
//!     ScrollProcessor still claims H/V (left ball = scroll) and
//!     PointerProcessor claims X/Y (right ball = pointer) unchanged.
//!   * `DongleBatteryRouter` replaces `CentralBatteryTagger` +
//!     `KobuBatterySourceTap`: the dongle has no battery (its macro-generated
//!     adc_device is discarded — USB-powered, P0_31 floats), and both halves'
//!     forwarded samples are routed into the SAME Via 0xC0 atomics as the
//!     classic topology (0x10 = left, 0x11 = right), min() forwarded to BAS.
//!
//! The onboard XIAO RGB LED keeps the classic StatusLedController as a
//! boot/bring-up diagnostic alongside the screen (with two peripherals its
//! "split connected" facet reflects whichever half reported last — the screen
//! is the authoritative per-half view).

#![no_main]
#![no_std]

#[path = "../../rmk/src/config.rs"]
mod config;
mod display;
mod dongle_battery;
mod set_token;
#[path = "../../rmk/src/status_led.rs"]
mod status_led;
#[path = "../../rmk/src/trackball.rs"]
mod trackball;

use rmk::macros::rmk_central;

#[rmk_central]
mod keyboard_central {
    use crate::dongle_battery::DongleBatteryRouter;
    use crate::status_led::StatusLedController;
    use crate::trackball::{
        PeriphScrollRelabel, PointerProcessor, ScrollProcessor, run_auto_mouse_layer,
        run_input_gate_central,
    };

    // Onboard RGB LED (P0.26/P0.30/P0.06) as a bring-up diagnostic. Claimed
    // from `p` here; controller initializers run before the entry body.
    #[controller(poll)]
    fn status_led() {
        use ::embassy_nrf::gpio::{Level, Output, OutputDrive};
        let red = Output::new(p.P0_26, Level::High, OutputDrive::Standard);
        let green = Output::new(p.P0_30, Level::High, OutputDrive::Standard);
        let blue = Output::new(p.P0_06, Level::High, OutputDrive::Standard);
        StatusLedController::new(red, green, blue)
    }

    // Override the macro-generated entry to
    //   1. drop the dongle's own input devices (0x0 matrix, floating-pin ADC,
    //      and the two placeholder Pmw3610Processors the macro emits for the
    //      peripherals' trackballs),
    //   2. run [DongleBatteryRouter, PeriphScrollRelabel, Scroll, Pointer,
    //      battery_processor] as the chain (PeriphScrollRelabel remaps the
    //      right ball to scroll while H+J is held),
    //   3. run TWO peripheral managers (id 0 = right at col offset 5, id 1 =
    //      left at col offset 0 — must match the [[split.peripheral]] order),
    //   4. join the Prospector display task on the pins the Prospector
    //      adapter wires to SPIM3 (see src/display.rs).
    #[Overwritten(entry)]
    async fn rmk_entry() {
        use ::rmk::controller::PollingController;
        use ::rmk::input_device::Runnable;

        // Discard the macro-generated bindings this topology doesn't run:
        // the placeholder processors for the halves' PMW3610s (replaced by
        // Scroll/PointerProcessor), the dongle's own ADC (no battery), and
        // the 0x0 matrix (nothing to scan; peripheral managers feed the
        // channels directly).
        let _ = right_processor;
        let _ = left_processor;
        let _ = adc_device;
        let _ = matrix;

        let mut battery_router = DongleBatteryRouter::new(&keymap);
        let mut periph_scroll_relabel = PeriphScrollRelabel::new(&keymap);
        let mut scroll_processor = ScrollProcessor::new(&keymap);
        let mut pointer_processor = PointerProcessor::new(&keymap);

        // Same boot pointer-CPI multiplier as the classic central (1.5×,
        // live-tunable via kobu-config 0xC0 id 0x01; not persisted).
        ::rmk::input_device::battery::KOBU_TRACKBALL_CPI
            .store(1500, ::core::sync::atomic::Ordering::Relaxed);

        // Multi-set independence: only scan-bind halves advertising THIS
        // set's token (must run before scan_peripherals starts below).
        crate::set_token::apply_split_set_token();

        ::rmk::embassy_futures::join::join(
            ::rmk::embassy_futures::join::join(
                ::rmk::embassy_futures::join::join(
                    ::rmk::embassy_futures::join::join(
                        keyboard.run(),
                        ::rmk::run_rmk(&keymap, driver, &stack, &mut storage, rmk_config),
                    ),
                    ::rmk::embassy_futures::join::join(
                        ::rmk::run_processor_chain!(
                            ::rmk::channel::EVENT_CHANNEL => [battery_router, periph_scroll_relabel, scroll_processor, pointer_processor, battery_processor],
                        ),
                        // One manager per half. Generics are <ROW, COL,
                        // ROW_OFFSET, COL_OFFSET>; ids index peripheral_addrs
                        // AND match the halves' advertised ids, in
                        // [[split.peripheral]] order: 0 = RIGHT (cols 5..9),
                        // 1 = LEFT (cols 0..4).
                        ::rmk::embassy_futures::join::join(
                            ::rmk::split::central::run_peripheral_manager::<4, 5, 0, 5, _>(
                                0,
                                &peripheral_addrs,
                                &stack,
                            ),
                            ::rmk::split::central::run_peripheral_manager::<4, 5, 0, 0, _>(
                                1,
                                &peripheral_addrs,
                                &stack,
                            ),
                        ),
                    ),
                ),
                ::rmk::split::ble::central::scan_peripherals(&stack, &peripheral_addrs),
            ),
            ::rmk::embassy_futures::join::join(
                ::rmk::embassy_futures::join::join(
                    status_led.polling_loop(),
                    // Input gate: holds both halves' PMW3610 pipelines off
                    // until the host link is ready. On the dongle VBUS is
                    // present whenever it has power at all, so the gate opens
                    // at boot and HostReady reaches the halves on the ≤500 ms
                    // resync.
                    run_input_gate_central(),
                ),
                ::rmk::embassy_futures::join::join(
                    // Auto mouse layer: right ball motion → layer 4, typing
                    // kills it instantly (same machinery as the classic
                    // central — key events arrive via the split link).
                    run_auto_mouse_layer(&keymap),
                    // Prospector status screen on SPIM2 (SCK P1.13, MOSI
                    // P1.15, CS P1.14, DC P1.12, RST P0.29, BL P1.11).
                    // SPIM2, not the adapter's nominal SPIM3: embassy-nrf 0.8
                    // lacks the nRF52840 anomaly-198 workaround and SPIM3 TX
                    // corrupts under BLE/USB RAM traffic — see display.rs.
                    crate::display::run(
                        p.SPI2, p.P1_13, p.P1_15, p.P1_14, p.P1_12, p.P0_29, p.P1_11,
                    ),
                ),
            ),
        )
        .await;
    }
}
