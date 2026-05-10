//! Diagnostic-only build: identical scaffolding to `central.rs` but with
//! the matrix replaced by the standard `rmk::matrix::Matrix` configured
//! exactly like the macro-built `col2row` variant that is known to make
//! the main keys register on this hardware. Used to verify the outer
//! setup (BLE / USB / storage / run loop) is correct independently of
//! the mixed-diode matrix work.
//!
//! Build: `cargo build --release --bin central_test`
//! Output: `cargo objcopy --release --bin central_test -- -O ihex …`
//!
//! Expected behaviour with this build, per earlier user testing:
//!   - main keys (rows 0..2) register, but with mirrored col labels
//!     because we are *not* reversing col_pins here (just like the
//!     original macro col2row build).
//!   - thumb keys (row 3) are dead — col2row scan reverse-biases the
//!     thumb diodes (anode-on-/ROW per schematic).
//!   - cols on /COL3 / /COL4 may still be dead due to the separate
//!     hardware issues.
//!
//! If even this much does NOT register, the outer scaffolding has a
//! bug and the mixed-diode matrix work is masked by it.

#![no_std]
#![no_main]

#[path = "keymap.rs"]
mod keymap;
#[path = "vial.rs"]
mod vial;

use defmt::{info, unwrap};
use defmt_rtt as _;
use embassy_executor::Spawner;
use embassy_nrf::gpio::{Input, Level, Output, OutputDrive, Pull};
use embassy_nrf::mode::Async;
use embassy_nrf::peripherals::{RNG, USBD};
use embassy_nrf::usb::Driver;
use embassy_nrf::usb::vbus_detect::HardwareVbusDetect;
use embassy_nrf::{bind_interrupts, rng, usb};
use nrf_mpsl::Flash;
use nrf_sdc::mpsl::MultiprotocolServiceLayer;
use nrf_sdc::{self as sdc, mpsl};
use panic_probe as _;
use rand_chacha::ChaCha12Rng;
use rand_core::SeedableRng;
use rmk::ble::build_ble_stack;
use rmk::channel::EVENT_CHANNEL;
use rmk::config::{
    BehaviorConfig, BleBatteryConfig, DeviceConfig, PositionalConfig, RmkConfig, StorageConfig, VialConfig,
};
use rmk::debounce::default_debouncer::DefaultDebouncer;
use rmk::futures::future::{join, join4};
use rmk::input_device::Runnable;
use rmk::keyboard::Keyboard;
use rmk::matrix::{Matrix, OffsetMatrixWrapper};
use rmk::split::ble::central::{read_peripheral_addresses, scan_peripherals};
use rmk::split::central::run_peripheral_manager;
use rmk::{HostResources, initialize_keymap_and_storage, run_devices, run_rmk};
use static_cell::StaticCell;

use crate::keymap::{COL, NUM_LAYER, ROW};
use crate::vial::{VIAL_KEYBOARD_DEF, VIAL_KEYBOARD_ID};

bind_interrupts!(struct Irqs {
    USBD => usb::InterruptHandler<USBD>;
    RNG => rng::InterruptHandler<RNG>;
    EGU0_SWI0 => nrf_sdc::mpsl::LowPrioInterruptHandler;
    CLOCK_POWER => nrf_sdc::mpsl::ClockInterruptHandler, usb::vbus_detect::InterruptHandler;
    RADIO => nrf_sdc::mpsl::HighPrioInterruptHandler;
    TIMER0 => nrf_sdc::mpsl::HighPrioInterruptHandler;
    RTC0 => nrf_sdc::mpsl::HighPrioInterruptHandler;
});

#[embassy_executor::task]
async fn mpsl_task(mpsl: &'static MultiprotocolServiceLayer<'static>) -> ! {
    mpsl.run().await
}

const L2CAP_TXQ: u8 = 3;
const L2CAP_RXQ: u8 = 3;
const L2CAP_MTU: usize = 251;

fn build_sdc<'d, const N: usize>(
    p: nrf_sdc::Peripherals<'d>,
    rng: &'d mut rng::Rng<Async>,
    mpsl: &'d MultiprotocolServiceLayer,
    mem: &'d mut sdc::Mem<N>,
) -> Result<nrf_sdc::SoftdeviceController<'d>, nrf_sdc::Error> {
    sdc::Builder::new()?
        .support_scan()?
        .support_central()?
        .support_adv()?
        .support_peripheral()?
        .support_dle_peripheral()?
        .support_dle_central()?
        .support_phy_update_central()?
        .support_phy_update_peripheral()?
        .support_le_2m_phy()?
        .central_count(1)?
        .peripheral_count(1)?
        .buffer_cfg(L2CAP_MTU as u16, L2CAP_MTU as u16, L2CAP_TXQ, L2CAP_RXQ)?
        .build(p, rng, mpsl, mem)
}

fn ble_addr() -> [u8; 6] {
    let ficr = embassy_nrf::pac::FICR;
    let high = u64::from(ficr.deviceid(1).read());
    let addr = (high << 32) | u64::from(ficr.deviceid(0).read());
    let addr = addr | 0x0000_c000_0000_0000;
    unwrap!(addr.to_le_bytes()[..6].try_into())
}

#[embassy_executor::main]
async fn main(spawner: Spawner) {
    info!("Hello kobitokey-o-oyayubi central_test (standard col2row Matrix)!");

    let mut nrf_config = embassy_nrf::config::Config::default();
    nrf_config.dcdc.reg0_voltage = Some(embassy_nrf::config::Reg0Voltage::_3V3);
    nrf_config.dcdc.reg0 = true;
    nrf_config.dcdc.reg1 = true;
    let p = embassy_nrf::init(nrf_config);

    let _boot_led = Output::new(p.P0_30, Level::Low, OutputDrive::Standard);

    let mpsl_p = mpsl::Peripherals::new(p.RTC0, p.TIMER0, p.TEMP, p.PPI_CH19, p.PPI_CH30, p.PPI_CH31);
    let lfclk_cfg = mpsl::raw::mpsl_clock_lfclk_cfg_t {
        source: mpsl::raw::MPSL_CLOCK_LF_SRC_RC as u8,
        rc_ctiv: mpsl::raw::MPSL_RECOMMENDED_RC_CTIV as u8,
        rc_temp_ctiv: mpsl::raw::MPSL_RECOMMENDED_RC_TEMP_CTIV as u8,
        accuracy_ppm: mpsl::raw::MPSL_DEFAULT_CLOCK_ACCURACY_PPM as u16,
        skip_wait_lfclk_started: mpsl::raw::MPSL_DEFAULT_SKIP_WAIT_LFCLK_STARTED != 0,
    };
    static MPSL: StaticCell<MultiprotocolServiceLayer> = StaticCell::new();
    static SESSION_MEM: StaticCell<mpsl::SessionMem<1>> = StaticCell::new();
    let mpsl = MPSL.init(unwrap!(mpsl::MultiprotocolServiceLayer::with_timeslots(
        mpsl_p,
        Irqs,
        lfclk_cfg,
        SESSION_MEM.init(mpsl::SessionMem::new())
    )));
    spawner.must_spawn(mpsl_task(mpsl));
    let sdc_p = sdc::Peripherals::new(
        p.PPI_CH17, p.PPI_CH18, p.PPI_CH20, p.PPI_CH21, p.PPI_CH22, p.PPI_CH23, p.PPI_CH24, p.PPI_CH25, p.PPI_CH26,
        p.PPI_CH27, p.PPI_CH28, p.PPI_CH29,
    );
    let mut rng = rng::Rng::new(p.RNG, Irqs);
    let mut rng_gen = ChaCha12Rng::from_rng(&mut rng).unwrap();
    let mut sdc_mem = sdc::Mem::<8192>::new();
    let sdc = unwrap!(build_sdc(sdc_p, &mut rng, mpsl, &mut sdc_mem));
    let mut host_resources = HostResources::new();
    let stack = build_ble_stack(sdc, ble_addr(), &mut rng_gen, &mut host_resources).await;

    let driver = Driver::new(p.USBD, Irqs, HardwareVbusDetect::new(Irqs));
    let flash = Flash::take(mpsl, p.NVMC);

    // Standard Matrix layout, identical to the macro col2row variant.
    // Pins are NATURAL order — keymap col 0 = inner T column. Letters
    // will appear mirrored on the keymap, that is acceptable for this
    // diagnostic.
    let row_pins = [
        Input::new(p.P0_29, Pull::Down),
        Input::new(p.P0_04, Pull::Down),
        Input::new(p.P0_05, Pull::Down),
        Input::new(p.P1_11, Pull::Down),
    ];
    let mut col_pins = [
        Output::new(p.P1_12, Level::Low, OutputDrive::Standard),
        Output::new(p.P1_13, Level::Low, OutputDrive::Standard),
        Output::new(p.P1_14, Level::Low, OutputDrive::Standard),
        Output::new(p.P1_15, Level::Low, OutputDrive::Standard),
        Output::new(p.P0_10, Level::Low, OutputDrive::Standard),
    ];
    for o in col_pins.iter_mut() {
        o.set_low();
    }

    let keyboard_device_config = DeviceConfig {
        vid: 0x4b4f,
        pid: 0x4259,
        manufacturer: "s-katada",
        product_name: "kobitokey-o-oyayubi (test)",
        serial_number: "vial:f64c2b3c:000001",
    };
    let vial_config = VialConfig::new(VIAL_KEYBOARD_ID, VIAL_KEYBOARD_DEF, &[(0, 0)]);
    let ble_battery_config = BleBatteryConfig::new(None, false, None, false);
    let storage_config = StorageConfig {
        start_addr: 0,
        num_sectors: 6,
        ..Default::default()
    };
    let rmk_config = RmkConfig {
        device_config: keyboard_device_config,
        vial_config,
        ble_battery_config,
        storage_config,
    };

    let mut default_keymap = keymap::get_default_keymap();
    let mut behavior_config = BehaviorConfig::default();
    let mut positional_config = PositionalConfig::default();
    let (keymap, mut storage) = initialize_keymap_and_storage(
        &mut default_keymap,
        flash,
        &storage_config,
        &mut behavior_config,
        &mut positional_config,
    )
    .await;

    // Standard Matrix with col2row scan, identical to the macro variant.
    let debouncer = DefaultDebouncer::<4, 5>::new();
    let mut matrix = OffsetMatrixWrapper::<4, 5, _, 0, 0>(Matrix::<_, _, _, 4, 5, true>::new(row_pins, col_pins, debouncer));
    let mut keyboard = Keyboard::new(&keymap);

    let peripheral_addrs = read_peripheral_addresses::<1, _, ROW, COL, NUM_LAYER, 0>(&mut storage).await;

    info!("central_test up — entering run loop");

    join(
        join4(
            run_devices!((matrix) => EVENT_CHANNEL),
            keyboard.run(),
            run_peripheral_manager::<4, 5, 0, 5, _>(0, &peripheral_addrs, &stack),
            run_rmk(&keymap, driver, &stack, &mut storage, rmk_config),
        ),
        scan_peripherals(&stack, &peripheral_addrs),
    )
    .await;
}
