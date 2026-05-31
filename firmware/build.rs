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
    patch_rmk_battery_kobu_atomics();
    patch_rmk_kobu_settings_atomics();
    patch_rmk_via_custom_get_kobu();
    patch_rmk_via_custom_set_kobu_settings();
    patch_rmk_via_custom_save_kobu();
    patch_rmk_peripheral_bootloader_jump();
    patch_rmk_macro_adc_acquisition_time();
    patch_rmk_keymap_layer_pub();
    patch_rmk_last_key_tick_atomic();
    patch_rmk_record_last_key_tick();

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

/// Inject two `pub static AtomicU8` slots into rmk-0.8.2's `battery.rs` —
/// `KOBU_CENTRAL_BATTERY_PERCENT` and `KOBU_PERIPHERAL_BATTERY_PERCENT`.
/// The kobu firmware writes each side's decoded LiPo percentage into the
/// corresponding atomic from its bit-tag routing tap (see
/// `firmware/src/battery_source.rs`), and the patched `via/mod.rs`
/// `CustomGetValue` handler reads them back to answer Via Custom Channel
/// 0xC0 queries from `kobu-config`.
///
/// Atomics live inside rmk's crate because the `via/mod.rs` handler
/// (which we also patch) can only reach symbols visible from inside the
/// rmk crate. Marking them `pub` lets the kobu firmware crate write to
/// them via `rmk::input_device::battery::KOBU_*`.
fn patch_rmk_battery_kobu_atomics() {
    const MARKER: &str = "// kobu: battery atomics for via custom get applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/input_device/battery.rs") else {
        println!(
            "cargo:warning=kobu: could not find rmk-{RMK_VERSION} input_device/battery.rs; \
             kobu atomics patch was not applied"
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

    let anchor = "pub(crate) static BATTERY_UPDATE: Signal<crate::RawMutex, BatteryState> = Signal::new();";
    if !contents.contains(anchor) {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} input_device/battery.rs anchor missing in {}; \
             upstream may have changed — update firmware/build.rs",
            path.display()
        );
    }
    let injected = "pub(crate) static BATTERY_UPDATE: Signal<crate::RawMutex, BatteryState> = Signal::new();\n\n// kobu: pub atomics for the Via Custom Get handler. Each side's LiPo\n// percentage (0..=100) is mirrored here from the kobu-side bit-tag tap\n// in firmware/src/battery_source.rs, so the patched via/mod.rs handler\n// can answer kobu-config's CustomGetValue(channel=0xC0, id=0x10/0x11)\n// queries without reaching across crates.\npub static KOBU_CENTRAL_BATTERY_PERCENT: core::sync::atomic::AtomicU8 = core::sync::atomic::AtomicU8::new(0);\npub static KOBU_PERIPHERAL_BATTERY_PERCENT: core::sync::atomic::AtomicU8 = core::sync::atomic::AtomicU8::new(0);";
    contents = contents.replace(anchor, injected);

    contents.push('\n');
    contents.push_str(MARKER);
    contents.push('\n');

    fs::write(&path, contents).unwrap_or_else(|e| {
        panic!("kobu: failed to write {}: {e}", path.display());
    });
}

/// Wire the RMK 0.8 `ViaCommand::CustomGetValue` stub up so the kobu-config
/// web UI's `Via Custom Channel 0xC0` queries return the current LiPo
/// percentage on each kobu half.
///
/// Upstream RMK leaves CustomGet/Set/Save as `warn!()`-only stubs (issue
/// #39 in kobu's tracker). We replace the get-side stub with a kobu-aware
/// branch: when channel == 0xC0, the handler reads the matching atomic
/// (id 0x10 = central, id 0x11 = peripheral) out of
/// `crate::input_device::battery::KOBU_*` and writes the percent into the
/// response buffer at index 3 (the standard Via custom-value reply layout).
///
/// Set / Save are left as warnings — kobu's battery values are read-only.
fn patch_rmk_via_custom_get_kobu() {
    // v2 marker covers the extended id table (battery + writable settings).
    // Earlier kobu builds shipped v1 (battery-only); we leave the legacy
    // marker in place when found so the patch stays idempotent across
    // both fresh and previously-patched rmk caches.
    const MARKER_V2: &str = "// kobu: via CustomGetValue handler for channel 0xC0 (v2 settings) applied";
    const MARKER_V1: &str = "// kobu: via CustomGetValue handler for channel 0xC0 applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/host/via/mod.rs") else {
        println!(
            "cargo:warning=kobu: could not find rmk-{RMK_VERSION} host/via/mod.rs; \
             via CustomGet patch was not applied"
        );
        return;
    };

    println!("cargo:rerun-if-changed={}", path.display());

    let mut contents = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("kobu: failed to read {}: {e}", path.display());
    });

    if contents.contains(MARKER_V2) {
        return;
    }

    // The block we're replacing depends on whether v1 already patched
    // this file. Cargo's registry cache survives across builds, so when a
    // user has previously built a kobu firmware the v1 block is present
    // instead of the original `warn!()`-only stub. Detect both states.
    let original_block = r#"            ViaCommand::CustomGetValue => {
                // backlight/rgblight/rgb matrix/led matrix/audio settings here
                warn!("Custom get value -- not supported")
            }"#;
    let v1_block = r#"            ViaCommand::CustomGetValue => {
                // kobu Via Custom Channel 0xC0 — see firmware/src/config.rs and
                // web/src/protocol/customValue.ts for the id table. All kobu
                // ids are read-only from the host's perspective; the Set /
                // Save handlers still warn-and-drop.
                let channel = report.output_data[1];
                let id = report.output_data[2];
                if channel == 0xC0 {
                    match id {
                        0x10 => {
                            report.input_data[3] = crate::input_device::battery::KOBU_CENTRAL_BATTERY_PERCENT
                                .load(core::sync::atomic::Ordering::Relaxed);
                        }
                        0x11 => {
                            report.input_data[3] = crate::input_device::battery::KOBU_PERIPHERAL_BATTERY_PERCENT
                                .load(core::sync::atomic::Ordering::Relaxed);
                        }
                        _ => {
                            warn!("kobu: unknown CustomGetValue id 0x{:02X} on channel 0xC0", id);
                        }
                    }
                } else {
                    warn!("Custom get value -- not supported");
                }
            }"#;

    let new_block = r#"            ViaCommand::CustomGetValue => {
                // kobu Via Custom Channel 0xC0 — see firmware/src/config.rs and
                // web/src/protocol/customValue.ts for the id table.
                // - 0x01..0x07: read/write runtime settings backed by atomics
                //   in crate::input_device::battery (KOBU_*); the Set arm
                //   updates the same atomics so reads see live state.
                // - 0x10/0x11:  read-only battery percentages mirrored from
                //   kobu's source tap.
                let channel = report.output_data[1];
                let id = report.output_data[2];
                if channel == 0xC0 {
                    use core::sync::atomic::Ordering;
                    let kc = &crate::input_device::battery::KOBU_CENTRAL_BATTERY_PERCENT;
                    let kp = &crate::input_device::battery::KOBU_PERIPHERAL_BATTERY_PERCENT;
                    match id {
                        0x01 => {
                            // u16 BE at bytes 3..5
                            let v = crate::input_device::battery::KOBU_TRACKBALL_CPI.load(Ordering::Relaxed);
                            report.input_data[3] = (v >> 8) as u8;
                            report.input_data[4] = (v & 0xFF) as u8;
                        }
                        0x02 => {
                            report.input_data[3] = crate::input_device::battery::KOBU_SCROLL_THROTTLE_MS.load(Ordering::Relaxed);
                        }
                        0x03 => {
                            report.input_data[3] = if crate::input_device::battery::KOBU_SCROLL_INVERT_X.load(Ordering::Relaxed) { 1 } else { 0 };
                        }
                        0x04 => {
                            report.input_data[3] = if crate::input_device::battery::KOBU_SCROLL_INVERT_Y.load(Ordering::Relaxed) { 1 } else { 0 };
                        }
                        0x05 => {
                            let v = crate::input_device::battery::KOBU_STATUS_LED_PURPLE_HOLD_MS.load(Ordering::Relaxed);
                            report.input_data[3] = (v >> 8) as u8;
                            report.input_data[4] = (v & 0xFF) as u8;
                        }
                        0x06 => {
                            report.input_data[3] = crate::input_device::battery::KOBU_STATUS_LED_BAT_HIGH.load(Ordering::Relaxed);
                        }
                        0x07 => {
                            report.input_data[3] = crate::input_device::battery::KOBU_STATUS_LED_BAT_LOW.load(Ordering::Relaxed);
                        }
                        0x10 => {
                            report.input_data[3] = kc.load(Ordering::Relaxed);
                        }
                        0x11 => {
                            report.input_data[3] = kp.load(Ordering::Relaxed);
                        }
                        _ => {
                            warn!("kobu: unknown CustomGetValue id 0x{:02X} on channel 0xC0", id);
                        }
                    }
                } else {
                    warn!("Custom get value -- not supported");
                }
            }"#;

    let target = if contents.contains(v1_block) {
        v1_block
    } else if contents.contains(original_block) {
        original_block
    } else {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} host/via/mod.rs CustomGetValue block missing in {} (neither original nor kobu-v1 shape found); \
             upstream may have changed — update firmware/build.rs",
            path.display()
        );
    };
    contents = contents.replace(target, new_block);

    // Strip stale v1 marker, append v2.
    if contents.contains(MARKER_V1) {
        contents = contents.replace(&format!("\n{}\n", MARKER_V1), "\n");
    }
    contents.push('\n');
    contents.push_str(MARKER_V2);
    contents.push('\n');

    fs::write(&path, contents).unwrap_or_else(|e| {
        panic!("kobu: failed to write {}: {e}", path.display());
    });
}

/// Extend the `ViaCommand::CustomSetValue` arm so writes for kobu
/// channel `0xC0`, ids `0x01..=0x07` mutate the runtime config atomics
/// in `crate::input_device::battery::KOBU_*`. The existing
/// peripheral-bootloader-jump branch (channel 0xC0 / id 0x12) is
/// preserved verbatim; only the trailing `else` warn branch is replaced.
fn patch_rmk_via_custom_set_kobu_settings() {
    const MARKER: &str = "// kobu: via CustomSetValue handler for channel 0xC0 settings applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/host/via/mod.rs") else {
        return;
    };

    println!("cargo:rerun-if-changed={}", path.display());

    let mut contents = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("kobu: failed to read {}: {e}", path.display());
    });

    if contents.contains(MARKER) {
        return;
    }

    // Anchor reflects the bootloader-jump-patched Set arm (see
    // `patch_rmk_peripheral_bootloader_jump`). That patch always runs
    // before this one so the anchor below is what's in the file at
    // build time.
    let bootloader_patched_block = r#"            ViaCommand::CustomSetValue => {
                // kobu Via Custom Channel 0xC0 — write-only kobu commands
                // (currently just 0x12 = peripheral bootloader jump).
                let channel = report.output_data[1];
                let id = report.output_data[2];
                let value = report.output_data[3];
                #[cfg(all(feature = "_ble", feature = "split", feature = "controller"))]
                if channel == 0xC0 && id == 0x12 && value == 1 {
                    warn!("kobu: publishing PeripheralBootloaderJump from Via CustomSetValue");
                    crate::channel::send_controller_event_new(crate::event::ControllerEvent::PeripheralBootloaderJump);
                } else {
                    warn!("Custom set value -- not supported (channel={:02X} id={:02X})", channel, id);
                }
                #[cfg(not(all(feature = "_ble", feature = "split", feature = "controller")))]
                warn!("Custom set value -- not supported (channel={:02X} id={:02X})", channel, id);
            }"#;

    let new_block = r#"            ViaCommand::CustomSetValue => {
                // kobu Via Custom Channel 0xC0.
                //   0x01..=0x07: runtime settings — write into the matching
                //                atomic in crate::input_device::battery.
                //                Clamping mirrors firmware/src/config.rs.
                //   0x12:        peripheral bootloader-jump relay (BLE).
                let channel = report.output_data[1];
                let id = report.output_data[2];
                let value = report.output_data[3];
                let value2 = report.output_data[4];
                if channel == 0xC0 {
                    use core::sync::atomic::Ordering;
                    match id {
                        0x01 => {
                            // u16 BE, clamp 200..=3200 — matches
                            // firmware/src/config.rs::apply.
                            let raw = ((value as u16) << 8) | (value2 as u16);
                            let clamped = if raw < 200 { 200 } else if raw > 3200 { 3200 } else { raw };
                            crate::input_device::battery::KOBU_TRACKBALL_CPI.store(clamped, Ordering::Relaxed);
                        }
                        0x02 => {
                            let v = if value > 50 { 50 } else { value };
                            crate::input_device::battery::KOBU_SCROLL_THROTTLE_MS.store(v, Ordering::Relaxed);
                        }
                        0x03 => {
                            crate::input_device::battery::KOBU_SCROLL_INVERT_X.store(value != 0, Ordering::Relaxed);
                        }
                        0x04 => {
                            crate::input_device::battery::KOBU_SCROLL_INVERT_Y.store(value != 0, Ordering::Relaxed);
                        }
                        0x05 => {
                            // u16 BE, clamp 0..=2000.
                            let raw = ((value as u16) << 8) | (value2 as u16);
                            let clamped = if raw > 2000 { 2000 } else { raw };
                            crate::input_device::battery::KOBU_STATUS_LED_PURPLE_HOLD_MS.store(clamped, Ordering::Relaxed);
                        }
                        0x06 => {
                            // High threshold ≥ 20, ≤ 100. Keep low<high invariant.
                            let mut high = if value < 20 { 20 } else if value > 100 { 100 } else { value };
                            let mut low = crate::input_device::battery::KOBU_STATUS_LED_BAT_LOW.load(Ordering::Relaxed);
                            if low >= high { core::mem::swap(&mut low, &mut high); }
                            crate::input_device::battery::KOBU_STATUS_LED_BAT_HIGH.store(high, Ordering::Relaxed);
                            crate::input_device::battery::KOBU_STATUS_LED_BAT_LOW.store(low, Ordering::Relaxed);
                        }
                        0x07 => {
                            let mut low = if value > 50 { 50 } else { value };
                            let mut high = crate::input_device::battery::KOBU_STATUS_LED_BAT_HIGH.load(Ordering::Relaxed);
                            if low >= high { core::mem::swap(&mut low, &mut high); }
                            crate::input_device::battery::KOBU_STATUS_LED_BAT_HIGH.store(high, Ordering::Relaxed);
                            crate::input_device::battery::KOBU_STATUS_LED_BAT_LOW.store(low, Ordering::Relaxed);
                        }
                        #[cfg(all(feature = "_ble", feature = "split", feature = "controller"))]
                        0x12 if value == 1 => {
                            warn!("kobu: publishing PeripheralBootloaderJump from Via CustomSetValue");
                            crate::channel::send_controller_event_new(crate::event::ControllerEvent::PeripheralBootloaderJump);
                        }
                        _ => {
                            warn!("kobu: unknown CustomSetValue id 0x{:02X} on channel 0xC0", id);
                        }
                    }
                } else {
                    warn!("Custom set value -- not supported (channel={:02X} id={:02X})", channel, id);
                }
            }"#;

    if !contents.contains(bootloader_patched_block) {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} host/via/mod.rs CustomSetValue (bootloader-patched) block missing in {}; \
             upstream may have changed or peripheral-bootloader-jump patch is out of sync — update firmware/build.rs",
            path.display()
        );
    }
    contents = contents.replace(bootloader_patched_block, new_block);

    contents.push('\n');
    contents.push_str(MARKER);
    contents.push('\n');

    fs::write(&path, contents).unwrap_or_else(|e| {
        panic!("kobu: failed to write {}: {e}", path.display());
    });
}

/// Patch `ViaCommand::CustomSave` so saves on kobu channel `0xC0` are a
/// silent no-op success. Writes to the kobu atomics are applied
/// immediately by the Set handler — RMK 0.8 has no persistence layer
/// for our channel, so Save is purely a vial-gui-compat ack.
fn patch_rmk_via_custom_save_kobu() {
    const MARKER: &str = "// kobu: via CustomSave handler for channel 0xC0 applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/host/via/mod.rs") else {
        return;
    };

    println!("cargo:rerun-if-changed={}", path.display());

    let mut contents = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("kobu: failed to read {}: {e}", path.display());
    });

    if contents.contains(MARKER) {
        return;
    }

    let old_block = r#"            ViaCommand::CustomSave => {
                // backlight/rgblight/rgb matrix/led matrix/audio settings here
                warn!("Custom get value -- not supported")
            }"#;
    let new_block = r#"            ViaCommand::CustomSave => {
                // kobu Via Custom Channel 0xC0 — silently ack. Atomics
                // are mutated synchronously by CustomSetValue; vial-gui
                // -style tooling expects an explicit Save step, so we
                // succeed without doing anything for our channel.
                let channel = report.output_data[1];
                if channel != 0xC0 {
                    warn!("Custom save -- not supported (channel={:02X})", channel);
                }
            }"#;

    if !contents.contains(old_block) {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} host/via/mod.rs CustomSave block missing in {}; \
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

/// Add `pub static` atomics for kobu's writable runtime settings into
/// `rmk::input_device::battery`. Co-located with the existing battery
/// atomics so the Via Custom Get/Set handlers can reach them via a
/// single import path. Mirrors the schema in
/// `firmware/src/config.rs::KobuSettings`.
fn patch_rmk_kobu_settings_atomics() {
    const MARKER: &str = "// kobu: writable runtime settings atomics applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/input_device/battery.rs") else {
        return;
    };

    println!("cargo:rerun-if-changed={}", path.display());

    let mut contents = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("kobu: failed to read {}: {e}", path.display());
    });

    if contents.contains(MARKER) {
        return;
    }

    // Anchor: the last line of the battery-percent injection from
    // `patch_rmk_battery_kobu_atomics`. That patch runs before this
    // one, so the anchor is always in the file at this point.
    let anchor = "pub static KOBU_PERIPHERAL_BATTERY_PERCENT: core::sync::atomic::AtomicU8 = core::sync::atomic::AtomicU8::new(0);";
    if !contents.contains(anchor) {
        panic!(
            "kobu: expected battery-percent anchor in rmk-{RMK_VERSION} input_device/battery.rs at {}; \
             patch_rmk_battery_kobu_atomics must run first — order in build.rs::main",
            path.display()
        );
    }

    let injected = "pub static KOBU_PERIPHERAL_BATTERY_PERCENT: core::sync::atomic::AtomicU8 = core::sync::atomic::AtomicU8::new(0);\n\n// kobu: writable runtime settings. Mirrors firmware/src/config.rs schema.\n// The Via Custom Set handler in host/via/mod.rs writes here on a host\n// SetValue; firmware/src/{trackball,status_led}.rs read via thin\n// helpers in firmware/src/config.rs. Default values must match\n// `KobuSettings::default()` so a fresh build behaves identically.\npub static KOBU_TRACKBALL_CPI: core::sync::atomic::AtomicU16 = core::sync::atomic::AtomicU16::new(1000);\npub static KOBU_SCROLL_THROTTLE_MS: core::sync::atomic::AtomicU8 = core::sync::atomic::AtomicU8::new(0);\npub static KOBU_SCROLL_INVERT_X: core::sync::atomic::AtomicBool = core::sync::atomic::AtomicBool::new(false);\npub static KOBU_SCROLL_INVERT_Y: core::sync::atomic::AtomicBool = core::sync::atomic::AtomicBool::new(false);\npub static KOBU_STATUS_LED_PURPLE_HOLD_MS: core::sync::atomic::AtomicU16 = core::sync::atomic::AtomicU16::new(200);\npub static KOBU_STATUS_LED_BAT_HIGH: core::sync::atomic::AtomicU8 = core::sync::atomic::AtomicU8::new(60);\npub static KOBU_STATUS_LED_BAT_LOW: core::sync::atomic::AtomicU8 = core::sync::atomic::AtomicU8::new(20);";
    contents = contents.replace(anchor, injected);

    contents.push('\n');
    contents.push_str(MARKER);
    contents.push('\n');

    fs::write(&path, contents).unwrap_or_else(|e| {
        panic!("kobu: failed to write {}: {e}", path.display());
    });
}

/// Wire a split-link bootloader-jump relay so kobu-config can flash the
/// peripheral without the user double-tapping its physical RESET button.
/// Path: web UI → Vial `CustomSetValue(channel=0xC0, id=0x12, value=1)` →
/// central publishes `ControllerEvent::PeripheralBootloaderJump` →
/// `PeripheralManager::run` writes `SplitMessage::PeripheralBootloaderJump`
/// to the peripheral over the BLE split link → peripheral's
/// `SplitPeripheral::run` calls `crate::boot::jump_to_bootloader()` and
/// the device reboots into UF2 mode.
///
/// This is the deferred "split-bootloader-relay" follow-up tracked in
/// kobu's memory (`project-kobu-rmk`). It touches five upstream rmk
/// files; each `replacements` entry has its own panic-on-drift sentinel.
fn patch_rmk_peripheral_bootloader_jump() {
    const MARKER: &str = "// kobu: peripheral bootloader jump relay applied";
    const RMK_VERSION: &str = "0.8.2";

    let mut applied_any = false;

    // ── event.rs: add ControllerEvent::PeripheralBootloaderJump ───────
    if let Some(path) = find_rmk_file(RMK_VERSION, "src/event.rs") {
        let contents = fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!("kobu: failed to read {}: {e}", path.display());
        });
        if !contents.contains(MARKER) {
            println!("cargo:rerun-if-changed={}", path.display());
            let from = "    #[cfg(all(feature = \"_ble\", feature = \"split\"))]\n    ClearPeer,";
            let to = "    #[cfg(all(feature = \"_ble\", feature = \"split\"))]\n    ClearPeer,\n    /// kobu: trigger peripheral to reboot into UF2 bootloader, central → peripheral via split link\n    #[cfg(all(feature = \"_ble\", feature = \"split\"))]\n    PeripheralBootloaderJump,";
            if !contents.contains(from) {
                panic!(
                    "kobu: expected rmk-{RMK_VERSION} event.rs ClearPeer anchor missing in {}; \
                     upstream may have changed — update firmware/build.rs",
                    path.display()
                );
            }
            let mut new_contents = contents.replace(from, to);
            new_contents.push('\n');
            new_contents.push_str(MARKER);
            new_contents.push('\n');
            fs::write(&path, new_contents).unwrap_or_else(|e| {
                panic!("kobu: failed to write {}: {e}", path.display());
            });
            applied_any = true;
        }
    }

    // ── split/mod.rs: add SplitMessage::PeripheralBootloaderJump ──────
    if let Some(path) = find_rmk_file(RMK_VERSION, "src/split/mod.rs") {
        let contents = fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!("kobu: failed to read {}: {e}", path.display());
        });
        if !contents.contains(MARKER) {
            println!("cargo:rerun-if-changed={}", path.display());
            let from = "    /// Layer number from central to peripheral\n    Layer(u8),\n}";
            let to = "    /// Layer number from central to peripheral\n    Layer(u8),\n    /// kobu: tell peripheral to reboot into UF2 bootloader (central → peripheral)\n    PeripheralBootloaderJump,\n}";
            if !contents.contains(from) {
                panic!(
                    "kobu: expected rmk-{RMK_VERSION} split/mod.rs Layer anchor missing in {}; \
                     upstream may have changed — update firmware/build.rs",
                    path.display()
                );
            }
            let mut new_contents = contents.replace(from, to);
            new_contents.push('\n');
            new_contents.push_str(MARKER);
            new_contents.push('\n');
            fs::write(&path, new_contents).unwrap_or_else(|e| {
                panic!("kobu: failed to write {}: {e}", path.display());
            });
            applied_any = true;
        }
    }

    // ── split/driver.rs: PeripheralManager handles the controller event ─
    if let Some(path) = find_rmk_file(RMK_VERSION, "src/split/driver.rs") {
        let contents = fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!("kobu: failed to read {}: {e}", path.display());
        });
        if !contents.contains(MARKER) {
            println!("cargo:rerun-if-changed={}", path.display());
            let from = "                        ControllerEvent::Layer(layer) => {";
            let to = "                        #[cfg(all(feature = \"_ble\", feature = \"split\"))]\n                        ControllerEvent::PeripheralBootloaderJump => {\n                            debug!(\"kobu: relaying PeripheralBootloaderJump to peripheral {}\", self.id);\n                            if let Err(e) = self.transceiver.write(&SplitMessage::PeripheralBootloaderJump).await {\n                                match e {\n                                    SplitDriverError::Disconnected => return,\n                                    _ => error!(\"SplitDriver write error: {:?}\", e),\n                                }\n                            }\n                        }\n                        ControllerEvent::Layer(layer) => {";
            if !contents.contains(from) {
                panic!(
                    "kobu: expected rmk-{RMK_VERSION} split/driver.rs ControllerEvent::Layer anchor missing in {}; \
                     upstream may have changed — update firmware/build.rs",
                    path.display()
                );
            }
            let mut new_contents = contents.replace(from, to);
            new_contents.push('\n');
            new_contents.push_str(MARKER);
            new_contents.push('\n');
            fs::write(&path, new_contents).unwrap_or_else(|e| {
                panic!("kobu: failed to write {}: {e}", path.display());
            });
            applied_any = true;
        }
    }

    // ── split/peripheral.rs: peripheral side handles the split message ─
    if let Some(path) = find_rmk_file(RMK_VERSION, "src/split/peripheral.rs") {
        let contents = fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!("kobu: failed to read {}: {e}", path.display());
        });
        if !contents.contains(MARKER) {
            println!("cargo:rerun-if-changed={}", path.display());
            let from = "                        SplitMessage::Layer(layer) => {";
            let to = "                        SplitMessage::PeripheralBootloaderJump => {\n                            info!(\"kobu: received bootloader-jump from central, rebooting into UF2 mode\");\n                            crate::boot::jump_to_bootloader();\n                        }\n                        SplitMessage::Layer(layer) => {";
            if !contents.contains(from) {
                panic!(
                    "kobu: expected rmk-{RMK_VERSION} split/peripheral.rs SplitMessage::Layer anchor missing in {}; \
                     upstream may have changed — update firmware/build.rs",
                    path.display()
                );
            }
            let mut new_contents = contents.replace(from, to);
            new_contents.push('\n');
            new_contents.push_str(MARKER);
            new_contents.push('\n');
            fs::write(&path, new_contents).unwrap_or_else(|e| {
                panic!("kobu: failed to write {}: {e}", path.display());
            });
            applied_any = true;
        }
    }

    // ── via/mod.rs: CustomSetValue handler for channel 0xC0 id 0x12 ───
    if let Some(path) = find_rmk_file(RMK_VERSION, "src/host/via/mod.rs") {
        let contents = fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!("kobu: failed to read {}: {e}", path.display());
        });
        if !contents.contains(MARKER) {
            println!("cargo:rerun-if-changed={}", path.display());
            let from = "            ViaCommand::CustomSetValue => {\n                // backlight/rgblight/rgb matrix/led matrix/audio settings here\n                warn!(\"Custom set value -- not supported\")\n            }";
            let to = "            ViaCommand::CustomSetValue => {\n                // kobu Via Custom Channel 0xC0 — write-only kobu commands\n                // (currently just 0x12 = peripheral bootloader jump).\n                let channel = report.output_data[1];\n                let id = report.output_data[2];\n                let value = report.output_data[3];\n                #[cfg(all(feature = \"_ble\", feature = \"split\", feature = \"controller\"))]\n                if channel == 0xC0 && id == 0x12 && value == 1 {\n                    warn!(\"kobu: publishing PeripheralBootloaderJump from Via CustomSetValue\");\n                    crate::channel::send_controller_event_new(crate::event::ControllerEvent::PeripheralBootloaderJump);\n                } else {\n                    warn!(\"Custom set value -- not supported (channel={:02X} id={:02X})\", channel, id);\n                }\n                #[cfg(not(all(feature = \"_ble\", feature = \"split\", feature = \"controller\")))]\n                warn!(\"Custom set value -- not supported (channel={:02X} id={:02X})\", channel, id);\n            }";
            if !contents.contains(from) {
                panic!(
                    "kobu: expected rmk-{RMK_VERSION} host/via/mod.rs CustomSetValue stub missing in {}; \
                     upstream may have changed — update firmware/build.rs",
                    path.display()
                );
            }
            let mut new_contents = contents.replace(from, to);
            new_contents.push('\n');
            new_contents.push_str(MARKER);
            new_contents.push('\n');
            fs::write(&path, new_contents).unwrap_or_else(|e| {
                panic!("kobu: failed to write {}: {e}", path.display());
            });
            applied_any = true;
        }
    }

    if !applied_any {
        println!(
            "cargo:warning=kobu: peripheral bootloader jump relay patch — no files modified (already applied or rmk-{RMK_VERSION} not found)"
        );
    }
}

/// Expose `KeyMap::activate_layer` / `KeyMap::deactivate_layer` as `pub` so the
/// kobu firmware crate can drive them from `src/trackball.rs::run_auto_mouse_layer`.
///
/// RMK 0.8.2 declares both as `pub(crate)` (rmk-0.8.2/src/keymap.rs:363 and
/// :376), which is unreachable from the kobu crate. The kobu auto-mouse-layer
/// feature (BUG2) needs to activate the mouse layer (layer 4) when the
/// peripheral trackball moves and deactivate it after an inactivity timeout —
/// exactly what these two methods do (they also run `update_tri_layer`, so the
/// controller / split layer bookkeeping stays identical to a built-in LayerOn).
///
/// Widening visibility is the minimal change: no behavior is altered, the
/// methods are simply callable from outside the crate. Marker-idempotent;
/// panics if the upstream signatures drift so the breakage is loud.
fn patch_rmk_keymap_layer_pub() {
    const MARKER: &str = "// kobu: activate_layer/deactivate_layer made pub applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/keymap.rs") else {
        println!(
            "cargo:warning=kobu: could not find rmk-{RMK_VERSION} keymap.rs; \
             activate_layer/deactivate_layer pub patch was not applied"
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
            "    pub(crate) fn activate_layer(&mut self, layer_num: u8) {",
            "    pub fn activate_layer(&mut self, layer_num: u8) {",
        ),
        (
            "    pub(crate) fn deactivate_layer(&mut self, layer_num: u8) {",
            "    pub fn deactivate_layer(&mut self, layer_num: u8) {",
        ),
    ];

    for (from, to) in replacements {
        if !contents.contains(from) {
            panic!(
                "kobu: expected rmk-{RMK_VERSION} keymap.rs signature `{from}` missing in {}; \
                 upstream may have changed — update firmware/build.rs::patch_rmk_keymap_layer_pub",
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

/// Inject `pub static KOBU_LAST_KEY_TICKS: AtomicU32` into rmk's
/// `input_device/battery.rs`, co-located with the other kobu atomics. It holds
/// the embassy-time tick of the most recent key PRESS (written by
/// `patch_rmk_record_last_key_tick`), which `run_auto_mouse_layer` reads to
/// implement "require prior idle" — typing vibration jostles the right
/// trackball and was false-triggering the auto mouse layer, so we suppress
/// auto-mouse activation for a short window after any keypress.
fn patch_rmk_last_key_tick_atomic() {
    const MARKER: &str = "// kobu: last-key-tick atomic for auto-mouse prior-idle applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/input_device/battery.rs") else {
        return;
    };

    println!("cargo:rerun-if-changed={}", path.display());

    let mut contents = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("kobu: failed to read {}: {e}", path.display());
    });

    if contents.contains(MARKER) {
        return;
    }

    // Anchor on the last settings atomic injected by
    // `patch_rmk_kobu_settings_atomics` (which runs earlier), and append after it.
    let anchor = "pub static KOBU_STATUS_LED_BAT_LOW: core::sync::atomic::AtomicU8 = core::sync::atomic::AtomicU8::new(20);";
    if !contents.contains(anchor) {
        panic!(
            "kobu: expected KOBU_STATUS_LED_BAT_LOW anchor in rmk-{RMK_VERSION} input_device/battery.rs at {}; \
             patch_rmk_kobu_settings_atomics must run first — check order in build.rs::main",
            path.display()
        );
    }
    let injected = "pub static KOBU_STATUS_LED_BAT_LOW: core::sync::atomic::AtomicU8 = core::sync::atomic::AtomicU8::new(20);\n\n// kobu: embassy-time tick (32768 Hz) of the most recent key press. Written by\n// the keyboard processing funnel (see patch_rmk_record_last_key_tick); read by\n// firmware/src/trackball.rs::run_auto_mouse_layer for require-prior-idle so\n// typing vibration on the trackball does not false-trigger the mouse layer.\npub static KOBU_LAST_KEY_TICKS: core::sync::atomic::AtomicU32 = core::sync::atomic::AtomicU32::new(0);";
    contents = contents.replace(anchor, injected);

    contents.push('\n');
    contents.push_str(MARKER);
    contents.push('\n');

    fs::write(&path, contents).unwrap_or_else(|e| {
        panic!("kobu: failed to write {}: {e}", path.display());
    });
}

/// Record the embassy-time tick of every key PRESS into `KOBU_LAST_KEY_TICKS`,
/// inside rmk's `Keyboard::process_inner` (the single funnel for all key
/// events). Used for the auto-mouse-layer require-prior-idle gate. `Instant` is
/// already imported in keyboard.rs.
fn patch_rmk_record_last_key_tick() {
    const MARKER: &str = "// kobu: record last-key-tick in process_inner applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/keyboard.rs") else {
        return;
    };

    println!("cargo:rerun-if-changed={}", path.display());

    let mut contents = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("kobu: failed to read {}: {e}", path.display());
    });

    if contents.contains(MARKER) {
        return;
    }

    let from = r#"        // Matrix should process key pressed event first, record the timestamp of key changes
        if event.pressed {
            self.set_timer_value(event, Some(Instant::now()));
        }"#;
    let to = r#"        // Matrix should process key pressed event first, record the timestamp of key changes
        if event.pressed {
            self.set_timer_value(event, Some(Instant::now()));
            // kobu: stamp the last key-press tick for the auto-mouse-layer
            // require-prior-idle gate (firmware/src/trackball.rs).
            crate::input_device::battery::KOBU_LAST_KEY_TICKS
                .store(Instant::now().as_ticks() as u32, core::sync::atomic::Ordering::Relaxed);
        }"#;

    if !contents.contains(from) {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} keyboard.rs process_inner pressed-timestamp block missing in {}; \
             upstream may have changed — update firmware/build.rs::patch_rmk_record_last_key_tick",
            path.display()
        );
    }
    contents = contents.replace(from, to);

    contents.push('\n');
    contents.push_str(MARKER);
    contents.push('\n');

    fs::write(&path, contents).unwrap_or_else(|e| {
        panic!("kobu: failed to write {}: {e}", path.display());
    });
}
