//! Central (LEFT half) firmware.
//!
//! The kobitokey-o-oyayubi assembled boards have main-unit diodes
//! flipped (anode-on-/COL) while thumb-unit diodes are correct
//! (anode-on-/ROW). A regular RMK `Matrix` only scans in one direction,
//! so it can serve only half the keymap. We therefore replace the
//! `#[rmk_central]` macro with a hand-rolled main and a custom
//! `MixedDiodeMatrix` (see `mixed_matrix.rs`) that runs two clean scan
//! passes per cycle: col2row for the main 15 keys, then row2col for the
//! 4 thumb keys.

#![no_std]
#![no_main]

mod keymap;
mod mixed_matrix;
mod vial;

use defmt::{info, unwrap};
use defmt_rtt as _;
use embassy_executor::Spawner;
use embassy_nrf::gpio::{Flex, Level, Output, OutputDrive};
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
use rmk::futures::future::{join, join4};
use rmk::input_device::Runnable;
use rmk::keyboard::Keyboard;
use rmk::matrix::OffsetMatrixWrapper;
use rmk::split::ble::central::{read_peripheral_addresses, scan_peripherals};
use rmk::split::central::run_peripheral_manager;
use rmk::{HostResources, initialize_keymap_and_storage, run_devices, run_rmk};
use static_cell::StaticCell;

use crate::keymap::{COL, NUM_LAYER, ROW};
use crate::mixed_matrix::{COL_LOCAL, MixedDiodeMatrix, PIN_NUM, ROW_LOCAL, ThumbPhantom};
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
    info!("Hello kobitokey-o-oyayubi central (MixedDiodeMatrix)!");

    let mut nrf_config = embassy_nrf::config::Config::default();
    nrf_config.dcdc.reg0_voltage = Some(embassy_nrf::config::Reg0Voltage::_3V3);
    nrf_config.dcdc.reg0 = true;
    nrf_config.dcdc.reg1 = true;
    let p = embassy_nrf::init(nrf_config);

    // Boot LED (XIAO common-anode user LED, LOW = on).
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

    // 9-pin Flex array for the LEFT half. Order:
    //   pins[0..3] = ROW0..ROW3
    //   pins[4..8] = COL pins ordered so local col 0 = leftmost (pinky)
    //                column on the user's view = /COL4 wire = P0.10.
    let pins: [Flex<'static>; PIN_NUM] = [
        Flex::new(p.P0_29), // ROW0
        Flex::new(p.P0_04), // ROW1
        Flex::new(p.P0_05), // ROW2
        Flex::new(p.P1_11), // ROW3 (thumb-only)
        Flex::new(p.P0_10), // local col 0 → /COL4 wire (P pinky)
        Flex::new(p.P1_15), // local col 1 → /COL3 wire (W)
        Flex::new(p.P1_14), // local col 2 → /COL2 wire (E)
        Flex::new(p.P1_13), // local col 3 → /COL1 wire (R)
        Flex::new(p.P1_12), // local col 4 → /COL0 wire (T inner-index)
    ];

    let keyboard_device_config = DeviceConfig {
        vid: 0x4b4f,
        pid: 0x4259,
        manufacturer: "s-katada",
        product_name: "kobitokey-o-oyayubi",
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

    // Local matrix: 4×5 with phantom at (3, 0) for the left half. The
    // central is at unified col 0..4 so OffsetMatrixWrapper uses 0/0.
    let mut matrix = OffsetMatrixWrapper::<ROW_LOCAL, COL_LOCAL, _, 0, 0>(MixedDiodeMatrix::new(pins, ThumbPhantom::Col0));
    let mut keyboard = Keyboard::new(&keymap);

    let peripheral_addrs = read_peripheral_addresses::<1, _, ROW, COL, NUM_LAYER, 0>(&mut storage).await;

    info!("kobitokey-o-oyayubi central up — entering run loop");

    join(
        join4(
            run_devices!((matrix) => EVENT_CHANNEL),
            keyboard.run(),
            run_peripheral_manager::<ROW_LOCAL, COL_LOCAL, 0, 5, _>(0, &peripheral_addrs, &stack),
            run_rmk(&keymap, driver, &stack, &mut storage, rmk_config),
        ),
        scan_peripherals(&stack, &peripheral_addrs),
    )
    .await;
}
