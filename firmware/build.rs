use const_gen::*;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::{env, fs};
use xz2::read::XzEncoder;

fn main() {
    println!("cargo:rerun-if-changed=vial.json");
    println!("cargo:rerun-if-changed=keyboard.toml");

    patch_rmk_ble_for_macos();
    patch_rmk_battery_service();
    patch_rmk_battery_processor_signal();
    patch_rmk_macro_adc_acquisition_time();

    generate_vial_config();

    let out = &PathBuf::from(env::var_os("OUT_DIR").unwrap());
    File::create(out.join("memory.x"))
        .unwrap()
        .write_all(include_bytes!("memory.x"))
        .unwrap();
    println!("cargo:rustc-link-search={}", out.display());

    println!("cargo:rerun-if-changed=memory.x");

    println!("cargo:rustc-link-arg=--nmagic");
    println!("cargo:rustc-link-arg=-Tlink.x");
    println!("cargo:rustc-link-arg=-Tdefmt.x");

    println!("cargo:rustc-linker=flip-link");
}

fn generate_vial_config() {
    let out_file = Path::new(&env::var_os("OUT_DIR").unwrap()).join("config_generated.rs");

    let p = Path::new("vial.json");
    let mut content = String::new();
    match File::open(p) {
        Ok(mut file) => {
            file.read_to_string(&mut content)
                .expect("Cannot read vial.json");
        }
        Err(e) => println!("Cannot find vial.json {:?}: {}", p, e),
    };

    let vial_cfg = json::stringify(json::parse(&content).unwrap());
    let mut keyboard_def_compressed: Vec<u8> = Vec::new();
    XzEncoder::new(vial_cfg.as_bytes(), 6)
        .read_to_end(&mut keyboard_def_compressed)
        .unwrap();

    let keyboard_id: Vec<u8> = vec![0xB9, 0xBC, 0x09, 0xB2, 0x9D, 0x37, 0x4C, 0xEA];
    let const_declarations = [
        const_declaration!(pub VIAL_KEYBOARD_DEF = keyboard_def_compressed),
        const_declaration!(pub VIAL_KEYBOARD_ID = keyboard_id),
    ]
    .map(|s| "#[allow(clippy::redundant_static_lifetimes)]\n".to_owned() + s.as_str())
    .join("\n");
    fs::write(out_file, const_declarations).unwrap();
}

/// Apply small, idempotent patches to the crates.io `rmk` 0.8.2 sources.
///
/// 1. Advertise on LE 1M PHY — macOS Bluetooth settings often ignore peripherals
///    that only advertise on LE 2M (RMK hard-codes 2M in `advertise()`).
/// 2. Default to BLE-priority when no connection preference is stored — RMK 0.8
///    otherwise defaults to USB, which suppresses BLE discovery while USB is
///    attached (HaoboGu/rmk#157, #159).
fn patch_rmk_ble_for_macos() {
    const MARKER: &str = "// kobu: macOS BLE patches applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_ble_mod(RMK_VERSION) else {
        println!(
            "cargo:warning=kobu: could not find rmk-{RMK_VERSION} in the cargo registry; \
             macOS BLE patches were not applied"
        );
        return;
    };

    println!("cargo:rerun-if-changed={}", path.display());

    let mut contents = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("kobu: failed to read {}: {e}", path.display());
    });

    if contents.contains(MARKER) {
        return;
    }

    let replacements = [
        (
            "primary_phy: PhyKind::Le2M,\n        secondary_phy: PhyKind::Le2M,",
            "primary_phy: PhyKind::Le1M,\n        secondary_phy: PhyKind::Le1M,",
        ),
        (
            "CONNECTION_TYPE.store(ConnectionType::Usb.into(), Ordering::SeqCst);",
            "CONNECTION_TYPE.store(ConnectionType::Ble.into(), Ordering::SeqCst);",
        ),
    ];

    for (from, to) in replacements {
        if !contents.contains(from) {
            panic!(
                "kobu: expected rmk-{RMK_VERSION} source fragment missing in {}; \
                 upstream may have changed — update firmware/build.rs",
                path.display()
            );
        }
        contents = contents.replace(from, to);
    }

    contents.push('\n');
    contents.push_str(MARKER);
    contents.push('\n');

    fs::write(&path, contents).unwrap_or_else(|e| {
        panic!("kobu: failed to write {}: {e}", path.display());
    });
}

fn find_rmk_ble_mod(rmk_version: &str) -> Option<PathBuf> {
    find_rmk_file(rmk_version, "src/ble/mod.rs")
}

fn find_rmk_file(rmk_version: &str, rel_path: &str) -> Option<PathBuf> {
    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .ok()?;
    let src_root = PathBuf::from(home).join(".cargo/registry/src");
    let entries = fs::read_dir(&src_root).ok()?;
    let crate_dir = format!("rmk-{rmk_version}");
    let rel = Path::new(&crate_dir).join(rel_path);

    for entry in entries.flatten() {
        let candidate = entry.path().join(&rel);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Replace `rmk-0.8.2/src/ble/battery_service.rs` wholesale with a kobu-flavoured
/// version that:
///
/// 1. Adds the BAS 1.1 `Battery Level Status` characteristic (UUID `0x2BED`)
///    next to the legacy Battery Level so hosts that understand BAS 1.1 (macOS
///    Sequoia, iOS 17+) can render a charging icon next to the kobu's
///    percentage.
/// 2. Rewrites `BleBatteryServer::run` to push a sentinel value immediately
///    on connect (macOS won't surface a BAS reading of 0%), drop the upstream
///    keypress gate, and heartbeat both characteristics every ~10s so VBUS
///    plug/unplug events get reflected in the Bluetooth menu without waiting
///    for the user to type a key.
/// 3. Polls VBUS via `embassy_nrf::pac::POWER.usbregstatus().vbusdetect()` on
///    every loop iteration — kobu's central is the only place that knows the
///    USB-power state, and we don't want to pipe a separate signal through
///    just for this.
///
/// We replace the entire upstream `battery_service.rs` body because the
/// changes touch the `BatteryService` struct, the `BleBatteryServer` type,
/// the constructor, and the run loop simultaneously — a fragile multi-hunk
/// find/replace would force us to re-tune every time we tweak one piece.
fn patch_rmk_battery_service() {
    // Increment the version suffix every time the embedded payload changes.
    const MARKER: &str = "// kobu: battery_service v3 (BAS 1.1 + VBUS charging) applied";
    // Sentinel that must be present in upstream rmk-0.8.2 — if missing, the
    // crate has been reorganised and our overwrite would land on the wrong
    // file.
    const UPSTREAM_SENTINEL: &str = "use crate::input_device::battery::{BATTERY_UPDATE, BatteryState};";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/ble/battery_service.rs") else {
        println!(
            "cargo:warning=kobu: could not find rmk-{RMK_VERSION} battery_service.rs; \
             v3 patch was not applied"
        );
        return;
    };

    println!("cargo:rerun-if-changed={}", path.display());

    let existing = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("kobu: failed to read {}: {e}", path.display());
    });

    if existing.contains(MARKER) {
        return;
    }

    if !existing.contains(UPSTREAM_SENTINEL) {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} battery_service.rs sentinel missing in {}; \
             upstream may have changed — update firmware/build.rs",
            path.display()
        );
    }

    let new_contents = r##"use embassy_time::Timer;
use trouble_host::prelude::*;

use super::ble_server::Server;
use crate::input_device::battery::{BATTERY_UPDATE, BatteryState};

/// Battery service — kobu v3 layout. Includes both the classic BAS 1.0
/// Battery Level (0x2A19) characteristic and the BAS 1.1 Battery Level
/// Status (0x2BED) characteristic so hosts that understand BAS 1.1 can
/// surface a charging icon alongside the percentage.
#[gatt_service(uuid = service::BATTERY)]
pub(crate) struct BatteryService {
    /// Battery Level — u8 percentage 0..=100.
    #[descriptor(uuid = descriptors::VALID_RANGE, read, value = [0, 100])]
    #[characteristic(uuid = characteristic::BATTERY_LEVEL, read, notify)]
    pub(crate) level: u8,

    /// Battery Level Status (BAS 1.1) — 3-byte payload.
    ///
    /// Byte 0: `flags` — kobu always sends 0 (no optional fields present;
    /// the battery level is carried by the legacy 0x2A19 characteristic
    /// rather than the BAS 1.1 in-band copy).
    ///
    /// Bytes 1..3: `power_state` as a little-endian u16 with the standard
    /// BAS 1.1 bit layout:
    ///
    ///   * bit 0      = battery present (always 1 — kobu has a LiPo).
    ///   * bits 1..2  = wired external power source. 00 = absent, 01 =
    ///                  present. We set 01 when VBUS is detected (USB
    ///                  plugged in).
    ///   * bits 3..4  = wireless external power source. Always 00.
    ///   * bits 5..6  = battery charge state. 00 = unknown,
    ///                  01 = charging, 10 = discharging-active,
    ///                  11 = discharging-inactive. kobu emits 01 when
    ///                  VBUS is present and 10 otherwise.
    ///   * bits 7..15 = unused / reserved bits — left zero.
    #[characteristic(uuid = characteristic::BATTERY_LEVEL_STATUS, read, notify)]
    pub(crate) level_status: [u8; 3],
}

pub(crate) struct BleBatteryServer<'stack, 'server, 'conn, P: PacketPool> {
    pub(crate) battery_level: Characteristic<u8>,
    pub(crate) battery_level_status: Characteristic<[u8; 3]>,
    pub(crate) conn: &'conn GattConnection<'stack, 'server, P>,
}

impl<'stack, 'server, 'conn, P: PacketPool> BleBatteryServer<'stack, 'server, 'conn, P> {
    pub(crate) fn new(server: &Server, conn: &'conn GattConnection<'stack, 'server, P>) -> Self {
        Self {
            battery_level: server.battery_service.level,
            battery_level_status: server.battery_service.level_status,
            conn,
        }
    }
}

impl<P: PacketPool> BleBatteryServer<'_, '_, '_, P> {
    pub(crate) async fn run(&mut self) {
        // Wait 2 seconds, ensure that gatt server has been started.
        Timer::after_secs(2).await;

        // Sentinel 73% on connect: macOS suppresses BAS readings of 0% so a
        // fresh GATT cache that has never been populated stays blank. By
        // pushing a non-zero distinguishable value immediately we coax the
        // menu into showing *something*; the heartbeat below overwrites it
        // with the real level as soon as BatteryProcessor has it.
        let mut last_level: u8 = 73;
        if let Some(BatteryState::Normal(level)) = BATTERY_UPDATE.try_take() {
            last_level = level.max(1);
        }
        if let Err(e) = self.battery_level.notify(self.conn, &last_level).await {
            error!("Failed to notify battery level (kobu initial): {:?}", e);
        }

        // Initial Battery Level Status push — same idea: get a real value into
        // the cached characteristic before macOS reads it.
        let mut last_charging = kobu_vbus_present();
        let status_bytes = kobu_encode_level_status(last_charging);
        if let Err(e) = self.battery_level_status.notify(self.conn, &status_bytes).await {
            error!("Failed to notify level status (kobu initial): {:?}", e);
        }

        loop {
            // Wake every 10 s (or sooner if BATTERY_UPDATE fires) so VBUS
            // plug/unplug shows up in the Bluetooth menu within ~10 s and the
            // host's cached characteristic value never drifts stale.
            let next = embassy_time::with_timeout(
                embassy_time::Duration::from_secs(10),
                BATTERY_UPDATE.wait(),
            )
            .await;
            if let Ok(BatteryState::Normal(level)) = next {
                last_level = level.max(1);
            }
            if let Err(e) = self.battery_level.notify(self.conn, &last_level).await {
                error!("Failed to notify battery level: {:?}", e);
            }

            let charging_now = kobu_vbus_present();
            last_charging = charging_now;
            let status_bytes = kobu_encode_level_status(last_charging);
            if let Err(e) = self.battery_level_status.notify(self.conn, &status_bytes).await {
                error!("Failed to notify level status: {:?}", e);
            }
        }
    }
}

/// True when the nRF52840's POWER peripheral reports VBUS present. Mirrors
/// `crate::status_led::vbus_present` in the kobu firmware so the BAS notify
/// loop can stay self-contained (no extra signal plumbing).
#[cfg(feature = "_nrf_ble")]
fn kobu_vbus_present() -> bool {
    embassy_nrf::pac::POWER.usbregstatus().read().vbusdetect()
}

#[cfg(not(feature = "_nrf_ble"))]
fn kobu_vbus_present() -> bool {
    false
}

/// Encode the BAS 1.1 Battery Level Status payload. See the doc comment on
/// `BatteryService::level_status` for the bit layout.
fn kobu_encode_level_status(charging: bool) -> [u8; 3] {
    // Battery is always present on kobu (bit 0 = 1).
    let mut power_state: u16 = 0b0000_0001;
    if charging {
        // bits 1..2 = 01 (wired external power present).
        power_state |= 0b0000_0010;
        // bits 5..6 = 01 (charging).
        power_state |= 0b0010_0000;
    } else {
        // bits 5..6 = 10 (discharging-active).
        power_state |= 0b0100_0000;
    }
    [0x00, (power_state & 0xff) as u8, ((power_state >> 8) & 0xff) as u8]
}

"##;

    let mut out = String::from(new_contents);
    out.push_str(MARKER);
    out.push('\n');

    fs::write(&path, out).unwrap_or_else(|e| {
        panic!("kobu: failed to write {}: {e}", path.display());
    });
}

/// Bump the acquisition time on every macro-generated SAADC channel from the
/// embassy-nrf default `Time::_10US` to `Time::_40US`. XIAO nRF52840 BLE's
/// on-module 1M / 1M BAT divider presents a ≈500 kΩ source impedance to
/// `P0_31`. With 10 µs the SAADC sample-and-hold capacitor never finishes
/// charging, so the ADC reads ≈0 and `BatteryProcessor` decodes 0%. nRF5
/// reference manual table for SAADC acquisition vs. source impedance maps
/// 500 kΩ → 40 µs, which is what we install here.
///
/// The patch targets the rmk-macro proc-macro crate's source (`adc.rs`) and
/// rewrites the quoted ChannelConfig construction so every battery /
/// joystick channel emitted by the macro picks up the new time. The change
/// is idempotent (marker line) and panics if the upstream fragment moves.
fn patch_rmk_macro_adc_acquisition_time() {
    const MARKER: &str = "// kobu: SAADC acquisition-time bump applied";
    const RMK_MACRO_VERSION: &str = "0.7.1";

    let Some(path) = find_rmk_macro_file(RMK_MACRO_VERSION, "src/input_device/adc.rs") else {
        println!(
            "cargo:warning=kobu: could not find rmk-macro-{RMK_MACRO_VERSION} adc.rs; \
             SAADC acquisition-time patch was not applied"
        );
        return;
    };

    println!("cargo:rerun-if-changed={}", path.display());

    let mut contents = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("kobu: failed to read {}: {e}", path.display());
    });

    if contents.contains(MARKER) {
        return;
    }

    let replacements = [
        // Battery / generic single-ended channel.
        (
            "saadc::ChannelConfig::single_ended(p.#adc_pin_def.degrade_saadc())",
            "{ let mut __cfg = saadc::ChannelConfig::single_ended(p.#adc_pin_def.degrade_saadc()); __cfg.time = saadc::Time::_40US; __cfg }",
        ),
        // VDDH internal divider channel.
        (
            "saadc::ChannelConfig::single_ended(saadc::VddhDiv5Input.degrade_saadc())",
            "{ let mut __cfg = saadc::ChannelConfig::single_ended(saadc::VddhDiv5Input.degrade_saadc()); __cfg.time = saadc::Time::_40US; __cfg }",
        ),
    ];

    let mut applied = 0;
    for (from, to) in replacements {
        if contents.contains(from) {
            contents = contents.replace(from, to);
            applied += 1;
        }
    }

    if applied == 0 {
        panic!(
            "kobu: expected rmk-macro-{RMK_MACRO_VERSION} ChannelConfig::single_ended fragment missing in {}; \
             upstream may have changed — update firmware/build.rs",
            path.display()
        );
    }

    contents.push('\n');
    contents.push_str(MARKER);
    contents.push('\n');

    fs::write(&path, contents).unwrap_or_else(|e| {
        panic!("kobu: failed to write {}: {e}", path.display());
    });
}

fn find_rmk_macro_file(rmk_macro_version: &str, rel_path: &str) -> Option<PathBuf> {
    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .ok()?;
    let src_root = PathBuf::from(home).join(".cargo/registry/src");
    let entries = fs::read_dir(&src_root).ok()?;
    let crate_dir = format!("rmk-macro-{rmk_macro_version}");
    let rel = Path::new(&crate_dir).join(rel_path);

    for entry in entries.flatten() {
        let candidate = entry.path().join(&rel);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Drop the "only signal when the percent changes" guard inside
/// `BatteryProcessor::process` so `BATTERY_UPDATE.signal()` fires on every
/// `Event::Battery` the ADC produces.
///
/// Why: `BATTERY_UPDATE` is an embassy_sync `Signal`, single-consumer. The
/// kobu `BleBatteryServer::run` consumes it via `try_take` / `wait` on every
/// BLE connection. With the upstream guard, once a connection has drained
/// the Signal the BatteryProcessor stops refreshing it (because the
/// per-sample percent doesn't change), so the *next* connection's
/// `try_take` returns `None` and the kobu sentinel (100%) wins. With this
/// patch every ADC tick reposts the value, which lets reconnects see the
/// true level and lets the 60-second heartbeat loop in our patched
/// `BleBatteryServer` actually carry fresh data.
fn patch_rmk_battery_processor_signal() {
    const MARKER: &str = "// kobu: BatteryProcessor always-signal patch applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/input_device/battery.rs") else {
        println!(
            "cargo:warning=kobu: could not find rmk-{RMK_VERSION} input_device/battery.rs; \
             BatteryProcessor always-signal patch was not applied"
        );
        return;
    };

    println!("cargo:rerun-if-changed={}", path.display());

    let mut contents = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("kobu: failed to read {}: {e}", path.display());
    });

    if contents.contains(MARKER) {
        return;
    }

    let old_block = r#"                        // Update the battery state
                        if self.battery_state != BatteryState::Normal(battery_percent) {
                            self.battery_state = BatteryState::Normal(battery_percent);
                            // Send signal
                            BATTERY_UPDATE.signal(self.battery_state);
                        }"#;
    let new_block = r#"                        // kobu patch: always update state and re-signal so
                        // BleBatteryServer reconnects can always see the latest
                        // percent without needing the value to change first.
                        self.battery_state = BatteryState::Normal(battery_percent);
                        BATTERY_UPDATE.signal(self.battery_state);"#;

    if !contents.contains(old_block) {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} BatteryProcessor signal block missing in {}; \
             upstream may have changed — update firmware/build.rs",
            path.display()
        );
    }
    contents = contents.replace(old_block, new_block);

    contents.push('\n');
    contents.push_str(MARKER);
    contents.push('\n');

    fs::write(&path, contents).unwrap_or_else(|e| {
        panic!("kobu: failed to write {}: {e}", path.display());
    });
}
