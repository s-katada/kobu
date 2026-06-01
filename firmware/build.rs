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
    // NOTE: peripheral_bootloader_jump must run BEFORE via_custom_set_kobu_settings:
    // the latter anchors on the CustomSetValue arm AFTER the bootloader-jump patch
    // has rewritten the upstream stub. (Order only matters on a pristine registry —
    // e.g. a clean cargo cache or CI — because the patches are marker-idempotent.)
    patch_rmk_peripheral_bootloader_jump();
    patch_rmk_via_custom_set_kobu_settings();
    patch_rmk_via_custom_save_kobu();
    patch_rmk_macro_adc_acquisition_time();
    patch_rmk_host_advertise_fast();
    patch_rmk_split_peripheral_advertise_fast();
    patch_rmk_split_peripheral_wake_on_pointer();
    patch_rmk_split_peripheral_publish_battery();
    patch_rmk_split_peripheral_decode_battery_while_advertising();
    patch_rmk_conn_params_fast_settling();
    patch_rmk_host_conn_low_latency();
    patch_rmk_split_conn_low_latency();
    patch_rmk_split_state_resync_fast();
    patch_rmk_force_ble_conn_type();
    patch_rmk_force_hid_cccd_on_connect();
    patch_rmk_gate_ble_writer_on_encrypted();
    patch_rmk_timeout_ble_writer();
    patch_rmk_request_security_on_connect();
    patch_rmk_keymap_layer_pub();
    patch_rmk_last_key_tick_atomic();
    patch_rmk_record_last_key_tick();
    // Round 7 — boot-trackball BLE wedge + mouse-drag/copy. These add NEW
    // atomics and NEW rmk patches, so a `cargo clean --release -p rmk` is
    // required once after pulling this change (see the buildrs-patch-recompile
    // note in project memory). The atomics injection MUST run before the
    // patches that reference the atomics by path are compiled, but ordering
    // among build.rs functions only matters for anchor availability — so the
    // atomics patch anchors on the last-key-tick atomic injected just above.
    patch_rmk_kobu_wedge_drag_atomics();
    patch_rmk_set_host_connected();
    patch_rmk_timeout_split_writes();
    patch_rmk_capture_mouse_buttons();
    patch_rmk_pmw3610_slower_poll();
    // Round 8 — the boot-trackball wedge (R1–R7 all failed). Root cause: the
    // peripheral forwards every pointer sample over the split link with an
    // UNBOUNDED blocking write (split/peripheral.rs), flooding the central's
    // single shared trouBLE RX pool during the Mac SMP/encryption window and
    // silently dropping the encryption PDU → "connected but dead until a
    // supervision-timeout reconnect." Fix: bound that forward (Layer A) AND gate
    // the whole PMW3610 pipeline on BOTH halves until the host link is READY
    // (BLE-encrypted OR USB) — Layer B. Adds new atomics + a new SplitMessage
    // variant; REQUIRES `cargo clean --release -p rmk` (registry-patch gotcha).
    patch_rmk_kobu_input_gate_atomics();
    patch_rmk_timeout_peripheral_event_write();
    patch_rmk_pmw3610_input_gate();
    patch_rmk_split_host_ready_variant();
    patch_rmk_emit_host_ready();
    patch_rmk_peripheral_apply_host_ready();
    // Round 10 — the wedge is a HANG (not reset) on the BONDED-RECONNECT-while-
    // Mac-holds-a-STALE-link path + trackball motion. On a stale resume the Mac
    // re-encrypts from the stored LTK and fires a dense GATT cache-revalidation
    // burst; kobu opened the trackball gate on the first encrypted GATT read
    // (R8), i.e. straight into that burst, BEFORE host TX credits were flowing —
    // the ~500Hz pointer flood then starved the single shared trouBLE TX queue +
    // 16-packet pool, the lone TxRunner parked on a host PDU, and the UNBOUNDED
    // `reply.send().await` in gatt_events_task deadlocked. Layer A bounds that
    // await; Layer C shrinks the stale window (5s->2s) like ZMK/KobitoKey.
    // (Layer B = a 2s post-encryption settle in run_input_gate_central, firmware;
    //  Layer D = bigger trouBLE pool via .cargo/config.toml env.)
    patch_rmk_timeout_gatt_reply();
    patch_rmk_supervision_timeout_2s();

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

/// Speed up macOS Bluetooth discovery + (re)pairing by lowering the host-
/// facing advertising interval from RMK's 200 ms default to 30 ms.
///
/// At 200 ms the device advertises only 5×/s; macOS scan windows often
/// took 10+ s to surface kobu in the Bluetooth picker. Apple's Accessory
/// Design Guidelines recommend 20–152.5 ms for connectable peripherals,
/// and 30 ms is the standard "fast pair" sweet spot — small enough for
/// near-instant discovery, large enough that battery cost is negligible
/// (and advertising stops once a host connects anyway).
fn patch_rmk_host_advertise_fast() {
    const MARKER: &str = "// kobu: host advertise interval lowered to 30 ms applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/ble/mod.rs") else {
        return;
    };

    println!("cargo:rerun-if-changed={}", path.display());

    let mut contents = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("kobu: failed to read {}: {e}", path.display());
    });

    if contents.contains(MARKER) {
        return;
    }

    // The Le1M lines are themselves a kobu patch (`patch_rmk_ble_for_macos`),
    // which runs before this one — so this anchor matches the post-patched
    // state of the file on every build.
    let old_block = r#"    let advertise_config = AdvertisementParameters {
        primary_phy: PhyKind::Le1M,
        secondary_phy: PhyKind::Le1M,
        tx_power: TxPower::Plus8dBm,
        interval_min: Duration::from_millis(200),
        interval_max: Duration::from_millis(200),
        ..Default::default()
    };"#;
    let new_block = r#"    let advertise_config = AdvertisementParameters {
        primary_phy: PhyKind::Le1M,
        secondary_phy: PhyKind::Le1M,
        tx_power: TxPower::Plus8dBm,
        // kobu: 30 ms ≈ Apple "fast pair" recommendation. Cuts macOS
        // discovery / re-pair time from ~10 s to ~1 s.
        interval_min: Duration::from_millis(30),
        interval_max: Duration::from_millis(30),
        ..Default::default()
    };"#;

    if !contents.contains(old_block) {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} ble/mod.rs advertise_config block missing in {}; \
             upstream may have changed or `patch_rmk_ble_for_macos` did not run first — update firmware/build.rs",
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

/// Speed up the split-link handshake by lowering the peripheral's
/// advertising interval from `AdvertisementParameters::default()`
/// (= 160 ms in trouble-host 0.5) to 30 ms.
///
/// The central scans for the peripheral with a 5 s connect timeout per
/// attempt; at 160 ms the peripheral advertises only 6×/s, so a missed
/// first scan window adds another 5 s + 500 ms retry. 30 ms keeps the
/// initial both-halves connection well under a second on a cold boot.
fn patch_rmk_split_peripheral_advertise_fast() {
    const MARKER: &str = "// kobu: split peripheral advertise interval lowered to 30 ms applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/split/ble/peripheral.rs") else {
        return;
    };

    println!("cargo:rerun-if-changed={}", path.display());

    let mut contents = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("kobu: failed to read {}: {e}", path.display());
    });

    if contents.contains(MARKER) {
        return;
    }

    // Two identical call sites (directed + undirected advertise); a global
    // replace handles both, and the patched literal is unique to this
    // file so subsequent builds short-circuit on the marker.
    let old_call = "&AdvertisementParameters::default()";
    let new_call = "&AdvertisementParameters { interval_min: Duration::from_millis(30), interval_max: Duration::from_millis(30), ..Default::default() }";

    if !contents.contains(old_call) {
        panic!(
            "kobu: expected `{old_call}` not found in {} — upstream may have changed; \
             update firmware/build.rs::patch_rmk_split_peripheral_advertise_fast",
            path.display()
        );
    }
    contents = contents.replace(old_call, new_call);

    contents.push('\n');
    contents.push_str(MARKER);
    contents.push('\n');

    fs::write(&path, contents).unwrap_or_else(|e| {
        panic!("kobu: failed to write {}: {e}", path.display());
    });
}

/// Cut the wait inside `set_conn_params` from 5 s + 5 s to 1 s + 1 s.
///
/// The upstream sequence "wait 5 s → request 15 ms → wait 5 s → request
/// 7.5 ms" means the host link only reaches its fast 133 Hz target ten
/// seconds after a host connects. Until then the keyboard is connected
/// but pointer / typing feel slower. 1 s + 1 s is still well above the
/// pairing / encryption settle time on macOS / iOS / Linux, but gets the
/// device to "full speed" within ~2 s of a fresh host connection.
fn patch_rmk_conn_params_fast_settling() {
    const MARKER: &str = "// kobu: set_conn_params settling delays shortened to 300 ms applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/ble/mod.rs") else {
        return;
    };

    println!("cargo:rerun-if-changed={}", path.display());

    let mut contents = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("kobu: failed to read {}: {e}", path.display());
    });

    if contents.contains(MARKER) {
        return;
    }

    // Anchor the first delay on its distinctive preceding comment so we
    // only retime the two set_conn_params waits, not other unrelated
    // 5-second timers elsewhere in the file.
    let first_old = "    // Wait for 5 seconds before setting connection parameters to avoid connection drop\n    embassy_time::Timer::after_secs(5).await;";
    let first_new = "    // kobu: was 5 s — 300 ms is enough on macOS/iOS/Linux and gets the\n    // device to the fast (7.5 ms) conn interval within ~0.6 s of connect.\n    embassy_time::Timer::after_millis(300).await;";

    // Anchor the second delay on the following distinctive comment line.
    let second_old = "    embassy_time::Timer::after_secs(5).await;\n\n    // Setting the conn param the second time ensures that we have best performance on all platforms";
    let second_new = "    embassy_time::Timer::after_millis(300).await;\n\n    // Setting the conn param the second time ensures that we have best performance on all platforms";

    if !contents.contains(first_old) || !contents.contains(second_old) {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} set_conn_params delay anchors missing in {}; \
             upstream may have changed — update firmware/build.rs::patch_rmk_conn_params_fast_settling",
            path.display()
        );
    }
    contents = contents.replace(first_old, first_new);
    contents = contents.replace(second_old, second_new);

    contents.push('\n');
    contents.push_str(MARKER);
    contents.push('\n');

    fs::write(&path, contents).unwrap_or_else(|e| {
        panic!("kobu: failed to write {}: {e}", path.display());
    });
}

/// Lower the host-link BLE slave latency from 30 to 0 in `set_conn_params`.
///
/// `set_conn_params` (ble/mod.rs) requests `max_latency: 30` in BOTH the
/// 15 ms and 7.5 ms `ConnectParams` stages. A slave latency of 30 lets the
/// keyboard skip up to 30 connection events (~450 ms at 15 ms, ~225 ms at
/// 7.5 ms) when it has nothing queued, which measurably degrades
/// time-to-first-report right after a (re)connect on macOS — part of BUG1's
/// "connected but slow to register" window. `0` forces the peripheral to
/// listen every interval; for a powered keyboard the extra idle current is
/// negligible. Supervision timeout (5 s) stays well within spec at latency 0.
///
/// Only the host link (ble/mod.rs) is touched. The split-link conn params in
/// `split/ble/central.rs` (`max_latency: 30, // 225ms`) are deliberately left
/// alone — those govern split-link power/stability and are a separate call;
/// since they live in a different file this in-file replace cannot reach them.
fn patch_rmk_host_conn_low_latency() {
    const MARKER: &str = "// kobu: host set_conn_params max_latency 30 -> 0 applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/ble/mod.rs") else {
        return;
    };

    println!("cargo:rerun-if-changed={}", path.display());

    let mut contents = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("kobu: failed to read {}: {e}", path.display());
    });

    if contents.contains(MARKER) {
        return;
    }

    // Both occurrences live in set_conn_params (the 15 ms and 7.5 ms stages).
    let from = "max_latency: 30,";
    let to = "max_latency: 0,";
    if !contents.contains(from) {
        panic!(
            "kobu: expected `{from}` in rmk-{RMK_VERSION} ble/mod.rs set_conn_params at {}; \
             upstream may have changed — update firmware/build.rs::patch_rmk_host_conn_low_latency",
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

/// Tighten the periodic CONNECTION_STATE re-sync the central pushes to each
/// peripheral from 3000 ms to 500 ms (split/driver.rs `PeripheralManager`).
///
/// The central tells the peripheral whether the host link is up via
/// `SplitMessage::ConnectionState`, sent once on `PeripheralManager` start and
/// then only on a periodic timer — there is NO event-driven push when the
/// host link actually comes up. So if the split link connects BEFORE the host
/// link (common on a cold boot), the peripheral holds a stale `Disconnected`
/// and drops every right-half key + the MAIN (right-side) trackball until the
/// next periodic re-sync — up to 3 s (part of BUG1). 500 ms caps that
/// staleness at ~0.5 s. Cost: one tiny `SplitMessage` every 0.5 s, negligible
/// on the BLE split link.
fn patch_rmk_split_state_resync_fast() {
    const MARKER: &str = "// kobu: split CONNECTION_STATE resync 3000 -> 500 ms applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/split/driver.rs") else {
        return;
    };

    println!("cargo:rerun-if-changed={}", path.display());

    let mut contents = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("kobu: failed to read {}: {e}", path.display());
    });

    if contents.contains(MARKER) {
        return;
    }

    let old_block = r#"            // Calculate the time until the next 3000ms sync
            let elapsed = last_sync_time.elapsed().as_millis();
            let wait_time = if elapsed >= 3000 { 1 } else { 3000 - elapsed };"#;
    let new_block = r#"            // kobu: was 3000 ms. 500 ms caps how long a peripheral can hold a
            // stale CONNECTION_STATE after the host link comes up (right-half
            // keys + main trackball were dead for up to 3 s on boot — BUG1).
            let elapsed = last_sync_time.elapsed().as_millis();
            let wait_time = if elapsed >= 500 { 1 } else { 500 - elapsed };"#;

    if !contents.contains(old_block) {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} split/driver.rs 3000 ms resync block missing in {}; \
             upstream may have changed — update firmware/build.rs::patch_rmk_split_state_resync_fast",
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

/// Force BLE-priority on boot regardless of any stale persisted
/// `ConnectionType=Usb` (RMK#157). kobu's `patch_rmk_ble_for_macos` rewrote
/// the *default* to Ble, but that default only applies when storage holds NO
/// ConnectionType — a `Usb` value persisted by an older firmware era survives
/// it and routes the device into the non-self-healing USB-priority dual-mode
/// branch. That branch only comes alive on a USB `configured()` callback or a
/// fresh BLE advertise-accept, so after a power cycle the keyboard is dead on
/// BOTH USB and BLE until the host is re-paired — exactly the reported
/// "works only after re-registering in Bluetooth, dead again after power-off"
/// symptom.
///
/// This patch stores `ConnectionType::Ble` UNCONDITIONALLY right after the
/// load, so a stale stored value can never select that branch again. Safe to
/// ship blind: the BLE-priority branch runs the USB keyboard concurrently
/// while advertising, so both USB and BLE HID stay alive, and kobu exposes no
/// keybinding to deliberately force USB-only mode (nothing regresses).
///
/// Anchors on the controller-event send that immediately follows the
/// connection-type load block. `patch_rmk_ble_for_macos` (which only rewrites
/// the default arm) runs earlier and leaves this anchor intact.
fn patch_rmk_force_ble_conn_type() {
    const MARKER: &str = "// kobu: force CONNECTION_TYPE=Ble on boot applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/ble/mod.rs") else {
        return;
    };

    println!("cargo:rerun-if-changed={}", path.display());

    let mut contents = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("kobu: failed to read {}: {e}", path.display());
    });

    if contents.contains(MARKER) {
        return;
    }

    let from = r#"        #[cfg(feature = "controller")]
        send_controller_event_new(ControllerEvent::ConnectionType(CONNECTION_TYPE.load(Ordering::SeqCst)));"#;
    let to = r#"        // kobu: force BLE-priority boot regardless of any stale persisted
        // ConnectionType=Usb (RMK#157). The BLE-priority branch runs the USB
        // keyboard concurrently while advertising, so USB still works; this
        // only prevents the non-self-healing USB-priority branch from being
        // selected by a stale stored value.
        CONNECTION_TYPE.store(ConnectionType::Ble.into(), Ordering::SeqCst);
        #[cfg(feature = "controller")]
        send_controller_event_new(ControllerEvent::ConnectionType(CONNECTION_TYPE.load(Ordering::SeqCst)));"#;

    if !contents.contains(from) {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} ble/mod.rs ConnectionType controller-event anchor missing in {}; \
             upstream may have changed — update firmware/build.rs::patch_rmk_force_ble_conn_type",
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

/// Force the HID input-report CCCDs to notifications-enabled on every BLE
/// connect, regardless of whether macOS re-writes the CCCD.
///
/// BUG1: after a power cycle (not right after a fresh UF2 flash) the keyboard
/// takes 30-60 s to start working. Over BLE macOS shows "connected" but no
/// keypresses register until it suddenly starts. Root cause: macOS caches the
/// bonded device's GATT/CCCD subscription state. On reconnect it does NOT
/// re-write the HID input-report CCCD (it believes it is still subscribed),
/// but the keyboard reset its in-RAM CCCD state on reboot. trouble-host's
/// `Characteristic::notify` checks `server.should_notify(conn, cccd_handle)`
/// and *silently* returns `Ok(())` when the CCCD is disabled (see
/// trouble-host-0.5.1 src/attribute.rs `notify`), so every `input_keyboard`/
/// mouse/media/system `notify()` is dropped on the floor. macOS eventually
/// (~30-60 s) re-subscribes and it springs to life.
///
/// Upstream RMK's mitigation (the `#[cfg(feature = "storage")]` block we
/// augment) tries to restore the CCCD table from flash, but it is unreliable:
///
///   1. It is gated on `read_trouble_bond_info(ACTIVE_PROFILE)` returning
///      `Some` AND `bond_info.info.identity.match_identity(peer_identity)`.
///      The persisted `cccd_table` is only written when a CCCD *write* event
///      arrives (`UPDATED_CCCD_TABLE` in gatt_events_task ->
///      ProfileManager::update_profile_cccd_table). On the very first bond, if
///      macOS subscribed before the bond was persisted — or if the device was
///      flashed/cleared — the stored table can be empty (all CCCDs disabled),
///      so restoring it restores *nothing*.
///   2. Even when a table was persisted, the only thing that matters on the
///      peripheral side is that `should_notify` returns true. Restoring a
///      possibly-stale/empty table does not guarantee that.
///
/// Our fix is unconditional and self-contained: pull the per-connection CCCD
/// table that trouble-host already seeded at connect time (it contains every
/// CCCD handle in the attribute table with notify/indicate = false — see
/// `CccdTables::new`/`connect` in trouble-host-0.5.1 src/attribute_server.rs),
/// flip the notify bit ON for the HID input-report characteristics' CCCD
/// handles, and write it back with `Server::set_cccd_table`. From then on
/// `should_notify` is true for those handles and the very first keypress
/// notification after reconnect is delivered.
///
/// The CCCD handles come straight off the generated `Characteristic` structs
/// exposed on the `Server` (each carries `cccd_handle: Option<u16>`):
///   * `server.hid_service.input_keyboard`        (0x2A4D keyboard input)
///   * `server.composite_service.mouse_report`    (0x2A4D mouse input)
///   * `server.composite_service.media_report`    (0x2A4D consumer input)
///   * `server.composite_service.system_report`   (0x2A4D system input)
///   * `server.host_service.input_data`           (Vial GUI, `host` feature)
///
/// `CccdTable` only exposes `new([(u16, CCCD); N])` / `inner()` publicly (its
/// per-entry mutators are private), and `CCCD` is `Copy` with a public
/// `set_notify(bool)`, so we copy `*table.inner()`, flip the matching entries
/// in place, and rebuild via `CccdTable::new`. We keep the storage restore as
/// a best-effort first step (it can carry CCCDs we don't force, e.g. battery)
/// and then force the HID input reports on top.
fn patch_rmk_force_hid_cccd_on_connect() {
    const MARKER: &str = "// kobu: force HID input-report CCCD notify on connect applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/ble/mod.rs") else {
        println!(
            "cargo:warning=kobu: could not find rmk-{RMK_VERSION} ble/mod.rs; \
             force-HID-CCCD patch was not applied"
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

    // Verbatim block from rmk-0.8.2 src/ble/mod.rs `run_ble_keyboard`
    // (the storage-conditional CCCD restore). Copied character-for-character;
    // if upstream changes it the patch panics rather than silently no-ops.
    let from = r#"    // Load CCCD table from storage
    #[cfg(feature = "storage")]
    if let Ok(Some(bond_info)) = storage
        .read_trouble_bond_info(ACTIVE_PROFILE.load(Ordering::SeqCst))
        .await
        && bond_info.info.identity.match_identity(&conn.raw().peer_identity())
    {
        info!("Loading CCCD table from storage: {:?}", bond_info.cccd_table);
        server.set_cccd_table(conn.raw(), bond_info.cccd_table.clone());
    }"#;

    let to = r#"    // Load CCCD table from storage (best effort — see below).
    #[cfg(feature = "storage")]
    if let Ok(Some(bond_info)) = storage
        .read_trouble_bond_info(ACTIVE_PROFILE.load(Ordering::SeqCst))
        .await
        && bond_info.info.identity.match_identity(&conn.raw().peer_identity())
    {
        info!("Loading CCCD table from storage: {:?}", bond_info.cccd_table);
        server.set_cccd_table(conn.raw(), bond_info.cccd_table.clone());
    }

    // kobu: unconditionally force the HID input-report CCCDs to
    // notifications-enabled on every connect. macOS caches the bonded
    // device's GATT subscription and does NOT re-write the input-report CCCD
    // on reconnect; trouble-host's notify() silently drops notifications when
    // should_notify() is false, so keypresses go nowhere for 30-60 s until
    // macOS eventually re-subscribes. We take the CCCD table trouble-host
    // already seeded for this connection (every CCCD handle present, all
    // disabled), flip notify ON for the HID input reports, and write it back.
    {
        use trouble_host::prelude::CccdTable;
        // The per-connection table is seeded at connect time and always
        // present here (GattConnection::try_new -> server.connect()), but
        // fall back to a default if for any reason it isn't.
        let current = server
            .get_cccd_table(conn.raw())
            .unwrap_or_else(CccdTable::default);
        let mut entries = *current.inner();

        // CCCD handles for every HID input-report characteristic that carries
        // keypress/pointer/consumer/system reports. Each generated
        // `Characteristic` exposes its `cccd_handle: Option<u16>`.
        let mut wanted: [Option<u16>; 5] = [None; 5];
        wanted[0] = server.hid_service.input_keyboard.cccd_handle;
        wanted[1] = server.composite_service.mouse_report.cccd_handle;
        wanted[2] = server.composite_service.media_report.cccd_handle;
        wanted[3] = server.composite_service.system_report.cccd_handle;
        #[cfg(feature = "host")]
        {
            // Vial GUI input report (host feature). Harmless to force on.
            wanted[4] = server.host_service.input_data.cccd_handle;
        }

        for w in wanted.iter().flatten() {
            for (handle, cccd) in entries.iter_mut() {
                if *handle == *w {
                    cccd.set_notify(true);
                }
            }
        }

        let forced = CccdTable::new(entries);
        info!("kobu: forcing HID input-report CCCD notify on connect: {:?}", forced);
        server.set_cccd_table(conn.raw(), forced);
    }"#;

    if !contents.contains(from) {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} ble/mod.rs storage-conditional CCCD restore block missing in {}; \
             upstream may have changed — update firmware/build.rs::patch_rmk_force_hid_cccd_on_connect",
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

/// BUG1 fix: proactively request link encryption on every (re)connect.
///
/// Symptom: after a cold reboot macOS shows the keyboard "connected" but no
/// key input registers for ~30-60s, then it works. Right after a fresh reflash
/// (which re-pairs) it works immediately.
///
/// Root cause (not the earlier CCCD theory — that was a red herring): a BLE
/// host only accepts HID-over-GATT input-report notifications over an ENCRYPTED
/// link. On a bonded reconnect macOS encrypts LAZILY (it does not re-pair, just
/// re-encrypts whenever it gets around to it), and RMK's `run_keyboard` starts
/// sending HID reports the moment the link is up — those pre-encryption reports
/// are silently dropped by macOS. RMK only calls `set_bondable(true)` and waits
/// passively, so nothing prompts macOS to encrypt promptly → dead until macOS
/// lazily encrypts (tens of seconds). Forcing the CCCD on did nothing because
/// the gate is encryption, not the notify subscription.
///
/// Fix: right after the connection is established (and made bondable), have the
/// peripheral send an SMP Security Request via `Connection::request_security()`.
/// This asks the central to (re)establish encryption NOW, using the stored LTK
/// for a bonded peer, so the link is encrypted within ~1s and HID flows. This
/// is the standard peripheral-side workaround for slow BLE-HID reconnect on
/// iOS/macOS. It is harmless when the central is already encrypting/encrypted.
fn patch_rmk_request_security_on_connect() {
    const MARKER: &str = "// kobu: request_security on connect applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/ble/mod.rs") else {
        println!(
            "cargo:warning=kobu: could not find rmk-{RMK_VERSION} ble/mod.rs; \
             request_security patch was not applied"
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

    let from = r#"            if let Err(e) = conn.raw().set_bondable(true) {
                error!("Set bondable error: {:?}", e);
            };
            Ok(conn)"#;
    let to = r#"            if let Err(e) = conn.raw().set_bondable(true) {
                error!("Set bondable error: {:?}", e);
            };
            // kobu: prompt the central to (re)establish encryption immediately.
            // macOS encrypts a bonded reconnect lazily and only accepts HID
            // notifications on an encrypted link, so without this the keyboard is
            // "connected but dead" for ~30-60s. An SMP Security Request makes
            // encryption happen within ~1s. Harmless if already encrypted.
            if let Err(e) = conn.raw().request_security() {
                error!("kobu: request_security error: {:?}", e);
            }
            Ok(conn)"#;

    if !contents.contains(from) {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} ble/mod.rs advertise() set_bondable block missing in {}; \
             upstream may have changed — update firmware/build.rs::patch_rmk_request_security_on_connect",
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

/// Issue #1 fix: let the split PERIPHERAL re-advertise on trackball motion, not
/// just on a key press.
///
/// After the split advertise to the central times out (directed 10s +
/// undirected 300s) without the central connecting, rmk's
/// `split/ble/peripheral.rs` parks on `KEY_EVENT_CHANNEL.receive().await` — it
/// only re-arms advertising when a KEY is pressed on the right half. The right
/// trackball (PMW3610) emits `Event::Joystick` on `EVENT_CHANNEL`, never on
/// `KEY_EVENT_CHANNEL`, so at cold boot "trackball only" could never bring the
/// split link up — only a keypress did (the reported symptom). Widen the wakeup
/// to wait on EITHER a key OR a pointer/trackball event.
fn patch_rmk_split_peripheral_wake_on_pointer() {
    const MARKER: &str = "// kobu: split peripheral wake on pointer or key applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/split/ble/peripheral.rs") else {
        println!(
            "cargo:warning=kobu: could not find rmk-{RMK_VERSION} split/ble/peripheral.rs; \
             split-peripheral wake-on-pointer patch was not applied"
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

    let from = r#"                    // Timeout, wait new keys to continue
                    error!("Connect to central timeout");
                    KEY_EVENT_CHANNEL.clear();
                    let _ = KEY_EVENT_CHANNEL.receive().await;"#;
    let to = r#"                    // kobu (issue #1): widen the post-timeout wakeup from
                    // KEY-only to key-OR-pointer. The right trackball emits
                    // Event::Joystick on EVENT_CHANNEL, never on
                    // KEY_EVENT_CHANNEL, so a KEY-only wait meant trackball-only
                    // input at cold boot could never re-arm the split advertise.
                    error!("Connect to central timeout");
                    KEY_EVENT_CHANNEL.clear();
                    crate::channel::EVENT_CHANNEL.clear();
                    match embassy_futures::select::select(
                        KEY_EVENT_CHANNEL.receive(),
                        crate::channel::EVENT_CHANNEL.receive(),
                    )
                    .await
                    {
                        embassy_futures::select::Either::First(_) => {}
                        embassy_futures::select::Either::Second(_) => {}
                    }"#;

    if !contents.contains(from) {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} split/ble/peripheral.rs KEY-only timeout-wakeup block missing in {}; \
             upstream may have changed — update firmware/build.rs::patch_rmk_split_peripheral_wake_on_pointer",
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

/// Mouse もっさり fix: lower the SPLIT-link BLE slave latency from 30 to 0 in
/// `defaul_central_conn_param()` (split/ble/central.rs). The split link runs at
/// a 7.5 ms interval but max_latency: 30 lets the peripheral skip up to ~225 ms
/// of connection events before delivering forwarded pointer reports — the
/// dominant source of the RIGHT trackball's lag. The host link was already set
/// to 0 (patch_rmk_host_conn_low_latency); the split link was left at 30.
/// sleep_manager_task's 200/25 overrides never run (SPLIT_CENTRAL_SLEEP_TIMEOUT
/// defaults 0 = disabled), so this single value governs the whole session.
fn patch_rmk_split_conn_low_latency() {
    const MARKER: &str = "// kobu: split defaul_central_conn_param max_latency 30 -> 0 applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/split/ble/central.rs") else {
        println!(
            "cargo:warning=kobu: could not find rmk-{RMK_VERSION} split/ble/central.rs; \
             split conn low-latency patch was not applied"
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

    // The trailing `// 225ms` comment makes this unique to defaul_central_conn_param();
    // the sleep_manager values are `200, // 4s` / `25, // 5s`.
    let from = "max_latency: 30, // 225ms";
    let to = "max_latency: 0, // kobu: was 30 (~225ms); 0 = listen every interval, kills split-link pointer lag";
    if !contents.contains(from) {
        panic!(
            "kobu: expected `{from}` in rmk-{RMK_VERSION} split/ble/central.rs at {}; \
             upstream may have changed — update firmware/build.rs::patch_rmk_split_conn_low_latency",
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

/// Peripheral LED support: make the split PERIPHERAL publish
/// `ControllerEvent::Battery` so its onboard RGB LED controller
/// (firmware/src/peripheral_led.rs) can show a boot battery colour.
///
/// The peripheral has no processor chain, so its raw `Event::Battery(adc)` is
/// only forwarded to the central. In `SplitPeripheral::run`'s EVENT_CHANNEL arm
/// we additionally decode it (XIAO BAT divider 510/1510, same formula as
/// firmware/src/battery_source.rs) and publish `ControllerEvent::Battery(percent)`
/// BEFORE forwarding the raw event unchanged (so the central's
/// KOBU_PERIPHERAL_BATTERY_PERCENT tap keeps working). `Event` is `Copy`, so the
/// `if let` match does not move `e`.
fn patch_rmk_split_peripheral_publish_battery() {
    const MARKER: &str = "// kobu: split peripheral publishes ControllerEvent::Battery applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/split/peripheral.rs") else {
        println!(
            "cargo:warning=kobu: could not find rmk-{RMK_VERSION} split/peripheral.rs; \
             peripheral battery-publish patch was not applied"
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

    let from = r#"                embassy_futures::select::Either3::Third(e) => {
                    if CONNECTION_STATE.load(core::sync::atomic::Ordering::Acquire) {"#;
    let to = r#"                embassy_futures::select::Either3::Third(e) => {
                    // kobu: decode + publish battery % for the onboard LED
                    // controller (the peripheral has no processor chain, so its
                    // raw Event::Battery is otherwise only forwarded to central).
                    // XIAO BAT divider 510/1510 — same formula as
                    // firmware/src/battery_source.rs. Event is Copy so this match
                    // does not move `e`; the raw event is still forwarded below.
                    #[cfg(feature = "controller")]
                    if let crate::event::Event::Battery(raw) = e {
                        let v = raw as i32;
                        let pct = if v > 4755 * 510 / 1510 {
                            100u8
                        } else if v < 4055 * 510 / 1510 {
                            0u8
                        } else {
                            ((v * 1510 / 510 - 4055) / 7) as u8
                        };
                        send_controller_event(&mut controller_pub, ControllerEvent::Battery(pct));
                    }
                    if CONNECTION_STATE.load(core::sync::atomic::Ordering::Acquire) {"#;
    if !contents.contains(from) {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} split/peripheral.rs Either3::Third arm missing in {}; \
             upstream may have changed — update firmware/build.rs::patch_rmk_split_peripheral_publish_battery",
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

/// WEDGE FIX (issue A): gate the BLE HID writer on an ENCRYPTED link.
///
/// trouble-host has ONE shared outbound L2CAP TX queue drained by a single
/// router that BLOCKS at the head awaiting per-connection link credits. macOS
/// only accepts HID notifications over an encrypted link and does not grant ACL
/// link credits to the kobu host connection until SMP encryption finishes
/// (~1 s after connect). If a host HID notify (esp. the high-rate trackball
/// MouseReport) is enqueued during that pre-encryption window, it sits at the
/// TxRouter head with no credits and STARVES the split link; the (blocking)
/// KEY_EVENT_CHANNEL / KEYBOARD_REPORT_CHANNEL then fill and keyboard.run +
/// matrix scanning wedge → the "roll the trackball before BT connects → whole
/// keyboard dead" hang. Fix: in `BleHidServer::write_report`, DROP the notify
/// (return Ok) until `security_level().encrypted()`. Safe: run_pointer_flush
/// re-emits from its accumulator and keys re-press after connect; nothing is
/// permanently lost, and macOS drops pre-encryption HID notifies anyway.
fn patch_rmk_gate_ble_writer_on_encrypted() {
    const MARKER: &str = "// kobu: gate BLE HID writer on encrypted link applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/ble/ble_server.rs") else {
        println!(
            "cargo:warning=kobu: could not find rmk-{RMK_VERSION} ble/ble_server.rs; \
             encryption-gate patch was not applied"
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

    let from = r#"    async fn write_report(&mut self, report: Self::ReportType) -> Result<usize, HidError> {
        match report {"#;
    let to = r#"    async fn write_report(&mut self, report: Self::ReportType) -> Result<usize, HidError> {
        // kobu (wedge fix): until the host link is ENCRYPTED, DROP HID notifies
        // instead of enqueuing them. A credit-less host notify enqueued during
        // the ~1 s pre-encryption window after connect sits at the head of
        // trouble-host's single shared outbound TX queue and STARVES the split
        // link, back-pressuring the blocking KEY_EVENT/KEYBOARD_REPORT channels
        // until keyboard.run and matrix scanning wedge (the "trackball before
        // BT connect → whole keyboard dead" hang). Dropping is safe:
        // run_pointer_flush re-emits from its accumulator, keys re-press, and
        // macOS ignores pre-encryption HID notifies anyway.
        if !self.conn.raw().security_level().map(|l| l.encrypted()).unwrap_or(false) {
            return Ok(0);
        }
        match report {"#;
    if !contents.contains(from) {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} ble_server.rs write_report head missing in {}; \
             upstream may have changed — update firmware/build.rs::patch_rmk_gate_ble_writer_on_encrypted",
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

/// THE definitive trackball-wedge fix (complements the encryption gate above).
///
/// Root cause (confirmed verbatim against the registry sources): `write_report`'s
/// per-report `notify(...).await` bottoms out in trouble-host's
/// `connection.send(pdu).await`, which BLOCKS on the single shared 8-deep
/// outbound L2CAP TX queue. That queue is drained by ONE TxRunner that
/// head-of-line-blocks awaiting per-connection link credits. When the host link
/// is credit-starved (the ~1 s post-connect window, or any later BLE congestion
/// / radio time-slicing of the split link), `notify` blocks unboundedly →
/// `run_writer` stops draining `KEYBOARD_REPORT_CHANNEL` → `keyboard.run`'s
/// `send_report` blocks → `KEY_EVENT_CHANNEL` fills → the BLOCKING (non-drop)
/// `KEY_EVENT_CHANNEL.send`s in `run_devices` and `split/driver.rs` wedge →
/// matrix scan + split key forwarding stall → the WHOLE keyboard is dead.
///
/// The encryption gate above only covers the PRE-encryption window (it returns
/// early before `security_level().encrypted()`). This bounds the residual: wrap
/// each of the four `notify` awaits in `embassy_time::with_timeout` and DROP the
/// report (`Ok(0)`) on timeout, so `write_report` can never block longer than the
/// timeout. That keeps `KEYBOARD_REPORT_CHANNEL` draining, which structurally
/// prevents the upstream chain from ever wedging — the hang becomes impossible
/// (self-clears within the timeout) regardless of credit state.
///
/// Timeouts: 8 ms for the mouse report (low latency, drop fast — `run_pointer_
/// flush` re-emits motion from its accumulator so a dropped frame is harmless),
/// 20 ms for keyboard/media/system (generous, so a real keystroke is NOT dropped
/// under brief congestion; the only residual risk — a dropped key *release*
/// sticking a key — needs sustained >20 ms starvation AND a release landing
/// exactly at congestion onset, and is corrected by the next full-state report).
/// `try_send` is NOT usable here: trouble-host's non-blocking sender is
/// `pub(crate)` and `Characteristic::notify` has no `try_` variant, so the
/// timeout is the only feasible bound at the rmk layer.
fn patch_rmk_timeout_ble_writer() {
    const MARKER: &str = "// kobu: timeout-bounded BLE HID writer applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/ble/ble_server.rs") else {
        println!(
            "cargo:warning=kobu: could not find rmk-{RMK_VERSION} ble/ble_server.rs; \
             timeout-bounded HID writer patch was not applied"
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

    // Each arm is anchored verbatim on its unique receiver + error string (raw
    // strings mirror the source's 16/20/16-space indentation exactly).
    // Replacement wraps the notify in with_timeout, dropping (Ok(0)) on timeout.
    // (label, from, to)
    let arms: [(&str, &str, &str); 4] = [
        (
            "keyboard",
            r#"                self.input_keyboard.notify(self.conn, &buf).await.map_err(|e| {
                    error!("Failed to notify keyboard report: {:?}", e);
                    HidError::BleError
                })?;"#,
            r#"                // kobu (definitive wedge fix): bound the notify so write_report
                // can NEVER block indefinitely on a full / credit-starved shared
                // outbound TX queue; drop on timeout to keep the HID writer
                // draining so the keyboard cannot wedge. 20 ms (generous) for keys.
                match ::embassy_time::with_timeout(
                    ::embassy_time::Duration::from_millis(20),
                    self.input_keyboard.notify(self.conn, &buf),
                )
                .await
                {
                    Ok(r) => r.map_err(|e| {
                        error!("Failed to notify keyboard report: {:?}", e);
                        HidError::BleError
                    })?,
                    Err(_) => return Ok(0),
                };"#,
        ),
        (
            "mouse",
            r#"                self.mouse_report.notify(self.conn, &buf).await.map_err(|e| {
                    error!("Failed to notify mouse report: {:?}", e);
                    HidError::BleError
                })?;"#,
            r#"                // kobu (definitive wedge fix): bound the notify so write_report
                // can NEVER block indefinitely on a full / credit-starved shared
                // outbound TX queue; drop on timeout to keep the HID writer
                // draining so the keyboard cannot wedge. 8 ms (drop fast) for
                // mouse — run_pointer_flush re-emits motion from its accumulator.
                match ::embassy_time::with_timeout(
                    ::embassy_time::Duration::from_millis(8),
                    self.mouse_report.notify(self.conn, &buf),
                )
                .await
                {
                    Ok(r) => r.map_err(|e| {
                        error!("Failed to notify mouse report: {:?}", e);
                        HidError::BleError
                    })?,
                    Err(_) => return Ok(0),
                };"#,
        ),
        (
            "media",
            r#"                self.media_report.notify(self.conn, &buf).await.map_err(|e| {
                    error!("Failed to notify media report: {:?}", e);
                    HidError::BleError
                })?;"#,
            r#"                // kobu (definitive wedge fix): bound the notify so write_report
                // can NEVER block indefinitely on a full / credit-starved shared
                // outbound TX queue; drop on timeout to keep the HID writer
                // draining so the keyboard cannot wedge. 20 ms for media keys.
                match ::embassy_time::with_timeout(
                    ::embassy_time::Duration::from_millis(20),
                    self.media_report.notify(self.conn, &buf),
                )
                .await
                {
                    Ok(r) => r.map_err(|e| {
                        error!("Failed to notify media report: {:?}", e);
                        HidError::BleError
                    })?,
                    Err(_) => return Ok(0),
                };"#,
        ),
        (
            "system",
            r#"                self.system_report.notify(self.conn, &buf).await.map_err(|e| {
                    error!("Failed to notify system report: {:?}", e);
                    HidError::BleError
                })?;"#,
            r#"                // kobu (definitive wedge fix): bound the notify so write_report
                // can NEVER block indefinitely on a full / credit-starved shared
                // outbound TX queue; drop on timeout to keep the HID writer
                // draining so the keyboard cannot wedge. 20 ms for system keys.
                match ::embassy_time::with_timeout(
                    ::embassy_time::Duration::from_millis(20),
                    self.system_report.notify(self.conn, &buf),
                )
                .await
                {
                    Ok(r) => r.map_err(|e| {
                        error!("Failed to notify system report: {:?}", e);
                        HidError::BleError
                    })?,
                    Err(_) => return Ok(0),
                };"#,
        ),
    ];

    for (label, from, to) in arms {
        if !contents.contains(from) {
            panic!(
                "kobu: expected rmk-{RMK_VERSION} ble_server.rs {label} notify arm missing in {}; \
                 upstream (or the gate patch's anchor) may have changed — \
                 update firmware/build.rs::patch_rmk_timeout_ble_writer",
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

/// Peripheral LED (part 2): decode + publish `ControllerEvent::Battery` on the
/// peripheral WHILE ADVERTISING / not connected, so the onboard RGB LED can show
/// the boot battery colour even when started alone (central off).
///
/// `patch_rmk_split_peripheral_publish_battery` only fires inside
/// `SplitPeripheral::run` (connected only). The peripheral's SAADC keeps pushing
/// `Event::Battery` to the single-consumer EVENT_CHANNEL regardless of BLE
/// state, but nothing drains it while advertising. Here we RACE a battery-decode
/// drain against the advertise via `select`; the drain runs ONLY while
/// advertising and is dropped the instant the advertise resolves, so
/// `SplitPeripheral::run` remains the SOLE EVENT_CHANNEL consumer once connected
/// (advertise and run are sequential in peri_task — never concurrent). `Event`
/// is Copy; the decode formula matches firmware/src/battery_source.rs (510/1510).
fn patch_rmk_split_peripheral_decode_battery_while_advertising() {
    const MARKER: &str = "// kobu: split peripheral decodes battery while advertising applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/split/ble/peripheral.rs") else {
        println!(
            "cargo:warning=kobu: could not find rmk-{RMK_VERSION} split/ble/peripheral.rs; \
             advertise-time battery-decode patch was not applied"
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

    let from = r#"            match split_peripheral_advertise(id, central_addr, &mut peripheral, &server).await {"#;
    let to = r#"            // kobu: while ADVERTISING (no EVENT_CHANNEL consumer otherwise),
            // drain Event::Battery and publish ControllerEvent::Battery so the
            // onboard LED shows the boot battery colour even when never
            // connected. Raced via select; dropped the instant advertise
            // resolves, so SplitPeripheral::run stays the sole consumer once
            // connected (EVENT_CHANNEL is single-consumer).
            #[cfg(feature = "controller")]
            let __kobu_battery_drain = async {
                loop {
                    let e = crate::channel::EVENT_CHANNEL.receive().await;
                    if let crate::event::Event::Battery(raw) = e {
                        let v = raw as i32;
                        let pct = if v > 4755 * 510 / 1510 {
                            100u8
                        } else if v < 4055 * 510 / 1510 {
                            0u8
                        } else {
                            ((v * 1510 / 510 - 4055) / 7) as u8
                        };
                        send_controller_event(&mut controller_pub, ControllerEvent::Battery(pct));
                    }
                }
            };
            #[cfg(feature = "controller")]
            let __kobu_adv = match ::embassy_futures::select::select(
                split_peripheral_advertise(id, central_addr, &mut peripheral, &server),
                __kobu_battery_drain,
            )
            .await
            {
                ::embassy_futures::select::Either::First(r) => r,
                ::embassy_futures::select::Either::Second(()) => unreachable!(),
            };
            #[cfg(not(feature = "controller"))]
            let __kobu_adv = split_peripheral_advertise(id, central_addr, &mut peripheral, &server).await;
            match __kobu_adv {"#;
    if !contents.contains(from) {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} split/ble/peripheral.rs split_peripheral_advertise call missing in {}; \
             upstream may have changed — update firmware/build.rs::patch_rmk_split_peripheral_decode_battery_while_advertising",
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

/// Round 7 atomics: inject `KOBU_HOST_CONNECTED` (auto-mouse bring-up gate) and
/// `KOBU_MOUSE_BUTTONS` (drag/copy fix) next to the other kobu atomics in
/// rmk's `input_device/battery.rs`. Anchored on the last-key-tick atomic so it
/// runs after `patch_rmk_last_key_tick_atomic`.
fn patch_rmk_kobu_wedge_drag_atomics() {
    const MARKER: &str = "// kobu: host-connected + mouse-buttons atomics applied";
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

    let anchor = "pub static KOBU_LAST_KEY_TICKS: core::sync::atomic::AtomicU32 = core::sync::atomic::AtomicU32::new(0);";
    if !contents.contains(anchor) {
        panic!(
            "kobu: expected KOBU_LAST_KEY_TICKS anchor in rmk-{RMK_VERSION} input_device/battery.rs at {}; \
             patch_rmk_last_key_tick_atomic must run first — check order in build.rs::main",
            path.display()
        );
    }
    let injected = "pub static KOBU_LAST_KEY_TICKS: core::sync::atomic::AtomicU32 = core::sync::atomic::AtomicU32::new(0);\n\n// kobu (round 7): true once the HOST (Mac) BLE link is encrypted, false on\n// disconnect. Written from the patched gatt_events_task in ble/mod.rs; read by\n// firmware/src/trackball.rs::run_auto_mouse_layer to hold the auto-mouse layer\n// OFF during the host connect+encryption bring-up window (the only trackball-\n// driven actor that emits a layer-change split write — see the wedge fix).\npub static KOBU_HOST_CONNECTED: core::sync::atomic::AtomicBool = core::sync::atomic::AtomicBool::new(false);\n\n// kobu (round 7): live HID mouse-button bitfield, mirrored from\n// Keyboard::send_mouse_report (keyboard.rs). The trackball motion/scroll\n// reports in firmware/src/trackball.rs OR this in so moving the ball while a\n// mouse button is held does not send buttons:0 and release a drag/selection.\npub static KOBU_MOUSE_BUTTONS: core::sync::atomic::AtomicU8 = core::sync::atomic::AtomicU8::new(0);";
    contents = contents.replace(anchor, injected);

    contents.push('\n');
    contents.push_str(MARKER);
    contents.push('\n');

    fs::write(&path, contents).unwrap_or_else(|e| {
        panic!("kobu: failed to write {}: {e}", path.display());
    });
}

/// Round 7 (auto-mouse bring-up gate, part of the wedge fix): set
/// `KOBU_HOST_CONNECTED` true once the host link is encrypted and false on
/// disconnect, from rmk's `gatt_events_task` in `ble/mod.rs`. Two set sites
/// cover both cases: `PairingComplete` (a fresh pairing) and the encrypted
/// branch of the GATT Read handler (a bonded reconnect re-encrypts via the
/// stored LTK WITHOUT a fresh PairingComplete, and macOS issues GATT reads the
/// moment the link is encrypted, so this fires within ~1 s of reconnect).
fn patch_rmk_set_host_connected() {
    const MARKER: &str = "// kobu: set KOBU_HOST_CONNECTED on encrypt applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/ble/mod.rs") else {
        return;
    };

    println!("cargo:rerun-if-changed={}", path.display());

    let mut contents = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("kobu: failed to read {}: {e}", path.display());
    });

    if contents.contains(MARKER) {
        return;
    }

    // (label, from, to)
    let replacements: [(&str, &str, &str); 3] = [
        (
            "PairingComplete set",
            r#"            GattConnectionEvent::PairingComplete { security_level, bond } => {
                info!("[gatt] pairing complete: {:?}", security_level);"#,
            r#"            GattConnectionEvent::PairingComplete { security_level, bond } => {
                info!("[gatt] pairing complete: {:?}", security_level);
                // kobu (round 7): host link is now encrypted (fresh pairing).
                crate::input_device::battery::KOBU_HOST_CONNECTED
                    .store(true, Ordering::Release);"#,
        ),
        (
            "encrypted-read set",
            r#"                        } else {
                            debug!("Read GATT Event to Unknown: {:?}", event.handle());
                        }

                        if conn.raw().security_level()?.encrypted() {
                            None"#,
            r#"                        } else {
                            debug!("Read GATT Event to Unknown: {:?}", event.handle());
                        }

                        if conn.raw().security_level()?.encrypted() {
                            // kobu (round 7): link is encrypted — mark host
                            // connected so the auto-mouse layer can arm. Covers
                            // bonded reconnects (re-encrypt via stored LTK, no
                            // fresh PairingComplete; macOS reads GATT right after).
                            crate::input_device::battery::KOBU_HOST_CONNECTED
                                .store(true, Ordering::Release);
                            None"#,
        ),
        (
            "disconnect clear",
            r#"            GattConnectionEvent::Disconnected { reason } => {
                info!("[gatt] disconnected: {:?}", reason);
                break;
            }"#,
            r#"            GattConnectionEvent::Disconnected { reason } => {
                info!("[gatt] disconnected: {:?}", reason);
                // kobu (round 7): host link gone — re-gate the auto-mouse layer.
                crate::input_device::battery::KOBU_HOST_CONNECTED
                    .store(false, Ordering::Release);
                break;
            }"#,
        ),
    ];

    for (label, from, to) in replacements {
        if !contents.contains(from) {
            panic!(
                "kobu: expected rmk-{RMK_VERSION} ble/mod.rs {label} anchor missing in {}; \
                 upstream may have changed — update firmware/build.rs::patch_rmk_set_host_connected",
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

/// THE round-7 wedge fix: bound every blocking PeripheralManager split-link
/// write so a credit-starved split link can NEVER head-of-line-block the single
/// shared trouble-host outbound TX queue (one `TxRunner` drains it and parks on
/// per-connection link credits). An unbounded `transceiver.write().await` at the
/// queue head with no peripheral credits stalls transmission of the HOST link's
/// queued SMP/ATT PDUs during the Mac's connect+encryption bring-up — the "roll
/// the trackball before BT connects → keyboard never comes up" hang. The
/// auto-mouse `ControllerEvent::Layer` write is the only trackball-driven
/// emitter on this path, but the periodic `ConnectionState` sync and
/// `KeyboardIndicator` writes share it, so all three are wrapped in
/// `with_timeout` and dropped on timeout (re-fire on the next transition / sync).
///
/// NOTE: rounds 5/6 only wrapped the HOST HID `notify()` arms in
/// `ble/ble_server.rs` — they never touched THIS split write, which is why they
/// did not fix the wedge.
fn patch_rmk_timeout_split_writes() {
    const MARKER: &str = "// kobu: timeout-bounded PeripheralManager split writes applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/split/driver.rs") else {
        println!(
            "cargo:warning=kobu: could not find rmk-{RMK_VERSION} split/driver.rs; \
             split-write timeout patch was not applied"
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

    // (label, from, to)
    let replacements: [(&str, &str, &str); 3] = [
        (
            "Layer",
            r#"                        ControllerEvent::Layer(layer) => {
                            // Send layer number to peripheral
                            debug!("Sending layer number to peripheral {}: {}", self.id, layer);
                            if let Err(e) = self.transceiver.write(&SplitMessage::Layer(layer)).await {
                                match e {
                                    SplitDriverError::Disconnected => return,
                                    _ => error!("SplitDriver write error: {:?}", e),
                                }
                            }
                        }"#,
            r#"                        ControllerEvent::Layer(layer) => {
                            // Send layer number to peripheral
                            debug!("Sending layer number to peripheral {}: {}", self.id, layer);
                            // kobu (wedge fix): bound the split write so it can
                            // never head-of-line-block the shared TX queue and
                            // starve the host SMP/PHY handshake during bring-up.
                            match embassy_time::with_timeout(
                                embassy_time::Duration::from_millis(20),
                                self.transceiver.write(&SplitMessage::Layer(layer)),
                            )
                            .await
                            {
                                Ok(Err(SplitDriverError::Disconnected)) => return,
                                Ok(Err(e)) => error!("SplitDriver write error: {:?}", e),
                                Ok(Ok(_)) => {}
                                Err(_) => warn!("kobu: split Layer write timed out (dropped)"),
                            }
                        }"#,
        ),
        (
            "KeyboardIndicator",
            r#"                            if let Err(e) = self
                                .transceiver
                                .write(&SplitMessage::KeyboardIndicator(led_indicator.into_bits()))
                                .await
                            {
                                match e {
                                    SplitDriverError::Disconnected => return,
                                    _ => error!("SplitDriver write error: {:?}", e),
                                }
                            }"#,
            r#"                            // kobu (wedge fix): bounded — see Layer arm.
                            match embassy_time::with_timeout(
                                embassy_time::Duration::from_millis(20),
                                self
                                    .transceiver
                                    .write(&SplitMessage::KeyboardIndicator(led_indicator.into_bits())),
                            )
                            .await
                            {
                                Ok(Err(SplitDriverError::Disconnected)) => return,
                                Ok(Err(e)) => error!("SplitDriver write error: {:?}", e),
                                Ok(Ok(_)) => {}
                                Err(_) => warn!("kobu: split KeyboardIndicator write timed out (dropped)"),
                            }"#,
        ),
        (
            "ConnectionState",
            r#"                    if let Err(e) = self.transceiver.write(&SplitMessage::ConnectionState(conn_state)).await {
                        match e {
                            SplitDriverError::Disconnected => return,
                            _ => error!("SplitDriver write error: {:?}", e),
                        }
                    }
                    last_sync_time = Instant::now();"#,
            r#"                    // kobu (wedge fix): bounded — see Layer arm.
                    match embassy_time::with_timeout(
                        embassy_time::Duration::from_millis(20),
                        self.transceiver.write(&SplitMessage::ConnectionState(conn_state)),
                    )
                    .await
                    {
                        Ok(Err(SplitDriverError::Disconnected)) => return,
                        Ok(Err(e)) => error!("SplitDriver write error: {:?}", e),
                        Ok(Ok(_)) => {}
                        Err(_) => warn!("kobu: split ConnectionState write timed out (dropped)"),
                    }
                    last_sync_time = Instant::now();"#,
        ),
    ];

    for (label, from, to) in replacements {
        if !contents.contains(from) {
            panic!(
                "kobu: expected rmk-{RMK_VERSION} split/driver.rs {label} write anchor missing in {}; \
                 upstream may have changed — update firmware/build.rs::patch_rmk_timeout_split_writes",
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

/// Round 7 drag/copy fix (capture side): mirror the live HID mouse-button
/// bitfield into `KOBU_MOUSE_BUTTONS` every time rmk sends a mouse report, so
/// the kobu trackball motion/scroll reports (firmware/src/trackball.rs) can OR
/// it back in. Without this, a trackball MouseReport carries `buttons: 0` and
/// releases a button the user is holding — breaking drag-to-select / copy.
fn patch_rmk_capture_mouse_buttons() {
    const MARKER: &str = "// kobu: capture live mouse buttons in send_mouse_report applied";
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

    let from = r#"    pub(crate) async fn send_mouse_report(&mut self) {
        // Prevent mouse report flooding, set maximum mouse report rate to 50 HZ
        self.send_report(Report::MouseReport(self.mouse_report)).await;"#;
    let to = r#"    pub(crate) async fn send_mouse_report(&mut self) {
        // kobu (drag/copy fix): mirror the live mouse-button bitfield so the
        // trackball motion/scroll reports can OR it in and not release a held
        // button (drag-to-select / copy) while the ball moves.
        crate::input_device::battery::KOBU_MOUSE_BUTTONS
            .store(self.mouse_report.buttons, core::sync::atomic::Ordering::Relaxed);
        // Prevent mouse report flooding, set maximum mouse report rate to 50 HZ
        self.send_report(Report::MouseReport(self.mouse_report)).await;"#;

    if !contents.contains(from) {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} keyboard.rs send_mouse_report anchor missing in {}; \
             upstream may have changed — update firmware/build.rs::patch_rmk_capture_mouse_buttons",
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

/// Round 7 wedge mitigation (radio-contention lever): lower the PMW3610 default
/// poll interval from 500 µs (2 kHz) to 2 ms (500 Hz). The RIGHT trackball
/// forwards one split-link BLE notification per non-zero sample; at 2 kHz that
/// flood competes with the Mac link's connect/encryption for the single nRF
/// radio during bring-up. 500 Hz is still ~7× the host HID report rate and the
/// central coalesces motion (run_pointer_flush) so NO travel is lost and the
/// cursor feel is unchanged — but the split-link packet rate (and the radio
/// airtime it costs during bring-up) drops 4×. Affects both halves' PMW3610
/// (the central scroll ball too — harmless at 500 Hz).
fn patch_rmk_pmw3610_slower_poll() {
    const MARKER: &str = "// kobu: PMW3610 default poll 500us -> 2ms applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/input_device/pmw3610.rs") else {
        println!(
            "cargo:warning=kobu: could not find rmk-{RMK_VERSION} input_device/pmw3610.rs; \
             PMW3610 poll-interval patch was not applied"
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

    let from = "poll_interval: Duration::from_micros(500),";
    let to = "poll_interval: Duration::from_micros(2000), // kobu: 500us->2ms, cut split-link radio flood during BLE bring-up (central coalesces, no feel change)";
    if !contents.contains(from) {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} pmw3610.rs default poll_interval anchor missing in {}; \
             upstream may have changed — update firmware/build.rs::patch_rmk_pmw3610_slower_poll",
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

/// Round 8 / Layer B1: inject the input-gate atomics + wake Signal next to the
/// other kobu atomics in rmk's `input_device/battery.rs`. KOBU_INPUT_GATED holds
/// the PMW3610 pipeline (both halves) OFF until the host link is READY;
/// KOBU_HOST_READY is the central's computed host-ready (BLE-encrypted OR USB)
/// that it sends to the peripheral via SplitMessage::HostReady; KOBU_INPUT_GATE_WAKE
/// wakes the parked read_event when the gate opens. Default GATED=true so the
/// trackball is silent at boot until proven READY (the wedge window).
fn patch_rmk_kobu_input_gate_atomics() {
    const MARKER: &str = "// kobu: input-gate atomics applied";
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

    let anchor = "pub static KOBU_MOUSE_BUTTONS: core::sync::atomic::AtomicU8 = core::sync::atomic::AtomicU8::new(0);";
    if !contents.contains(anchor) {
        panic!(
            "kobu: expected KOBU_MOUSE_BUTTONS anchor in rmk-{RMK_VERSION} input_device/battery.rs at {}; \
             patch_rmk_kobu_wedge_drag_atomics must run first — check order in build.rs::main",
            path.display()
        );
    }
    let injected = "pub static KOBU_MOUSE_BUTTONS: core::sync::atomic::AtomicU8 = core::sync::atomic::AtomicU8::new(0);\n\n// kobu (round 8): boot-trackball wedge gate. KOBU_INPUT_GATED true => the\n// PMW3610 read_event (firmware/src/trackball.rs pipeline source) parks before\n// SPI init/motion, so trackball activity cannot contend with the Mac\n// SMP/encryption bring-up. The CENTRAL drives its own gate from\n// run_input_gate_central (host_connected||vbus); it sends KOBU_HOST_READY to\n// the PERIPHERAL via SplitMessage::HostReady, which sets the peripheral's gate.\n// Default GATED=true => silent at boot until proven READY.\npub static KOBU_INPUT_GATED: core::sync::atomic::AtomicBool = core::sync::atomic::AtomicBool::new(true);\npub static KOBU_HOST_READY: core::sync::atomic::AtomicBool = core::sync::atomic::AtomicBool::new(false);\npub static KOBU_INPUT_GATE_WAKE: Signal<crate::RawMutex, ()> = Signal::new();";
    contents = contents.replace(anchor, injected);

    contents.push('\n');
    contents.push_str(MARKER);
    contents.push('\n');
    fs::write(&path, contents).unwrap_or_else(|e| {
        panic!("kobu: failed to write {}: {e}", path.display());
    });
}

/// Round 8 / Layer A: bound the ONLY remaining unbounded high-rate split
/// producer — the peripheral's per-sample pointer forward in
/// `SplitPeripheral::run` (R7 bounded only the CENTRAL's writes). A credit-
/// starved split link must DROP the pointer sample, never park the peripheral
/// pipeline. (Layer B gates the source so this rarely fires, but it is correct
/// hygiene for any post-connect congestion and matches upstream's non-blocking
/// pointer intent.) The `Key` write is left UNBOUNDED — keys must never drop.
fn patch_rmk_timeout_peripheral_event_write() {
    const MARKER: &str = "// kobu: bounded peripheral Event forward applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/split/peripheral.rs") else {
        println!(
            "cargo:warning=kobu: could not find rmk-{RMK_VERSION} split/peripheral.rs; \
             bounded peripheral Event forward patch was not applied"
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

    let from = r#"                        debug!("Writing split event to central: {:?}", e);
                        self.split_driver.write(&SplitMessage::Event(e)).await.ok();"#;
    let to = r#"                        debug!("Writing split event to central: {:?}", e);
                        // kobu (round 8 Layer A): bound this forward so a credit-
                        // starved split link DROPS the pointer sample rather than
                        // parking the peripheral pipeline.
                        let _ = ::embassy_time::with_timeout(
                            ::embassy_time::Duration::from_millis(20),
                            self.split_driver.write(&SplitMessage::Event(e)),
                        )
                        .await;"#;

    if !contents.contains(from) {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} split/peripheral.rs Event forward anchor missing in {}; \
             upstream may have changed — update firmware/build.rs::patch_rmk_timeout_peripheral_event_write",
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

/// Round 8 / Layer B2: gate the PMW3610 `read_event` loop on KOBU_INPUT_GATED.
/// Placed BEFORE `try_init` so even the lazy first-motion SPI init burst is
/// deferred out of the Mac bring-up window. While gated the task parks on
/// KOBU_INPUT_GATE_WAKE (costs nothing). Applies to BOTH halves (same rmk code).
fn patch_rmk_pmw3610_input_gate() {
    const MARKER: &str = "// kobu: PMW3610 read_event input gate applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/input_device/pmw3610.rs") else {
        println!(
            "cargo:warning=kobu: could not find rmk-{RMK_VERSION} input_device/pmw3610.rs; \
             read_event input-gate patch was not applied"
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

    let from = r#"        loop {
            Timer::after(self.poll_interval).await;

            if self.init_state != InitState::Ready && !self.try_init().await {"#;
    let to = r#"        loop {
            Timer::after(self.poll_interval).await;

            // kobu (round 8 Layer B): hold the ENTIRE pointer path (incl. the lazy
            // first-motion SPI init burst) off the executor & radio until the host
            // link is READY, so trackball motion at boot cannot contend with the
            // Mac SMP/encryption handshake (the boot-wedge). GATED by default;
            // opened by run_input_gate_central (central) or the HostReady split
            // message (peripheral). Parks on a Signal so it is free while gated.
            if crate::input_device::battery::KOBU_INPUT_GATED
                .load(core::sync::atomic::Ordering::Relaxed)
            {
                crate::input_device::battery::KOBU_INPUT_GATE_WAKE.wait().await;
                continue;
            }

            if self.init_state != InitState::Ready && !self.try_init().await {"#;

    if !contents.contains(from) {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} pmw3610.rs read_event loop anchor missing in {}; \
             upstream may have changed — update firmware/build.rs::patch_rmk_pmw3610_input_gate",
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

/// Round 8 / Layer B3: add `SplitMessage::HostReady(bool)` — the REAL host-link
/// state (BLE-encrypted OR USB), central->peripheral. Distinct from
/// ConnectionState, which the peripheral force-sets Connected the instant the
/// SPLIT link is up (so it is "split-up", NOT "Mac-up"). Added LAST to keep the
/// postcard discriminants of existing variants stable.
fn patch_rmk_split_host_ready_variant() {
    const MARKER: &str = "// kobu: SplitMessage::HostReady variant applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/split/mod.rs") else {
        println!(
            "cargo:warning=kobu: could not find rmk-{RMK_VERSION} split/mod.rs; \
             HostReady variant patch was not applied"
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

    let from = "    PeripheralBootloaderJump,\n}";
    let to = "    PeripheralBootloaderJump,\n    /// kobu (round 8): real host-ready (BLE-encrypted OR USB), central -> peripheral.\n    /// Distinct from ConnectionState (which is Connected-while-advertising). Gates\n    /// the peripheral pointer pipeline so it stays silent through Mac bring-up.\n    HostReady(bool),\n}";
    if !contents.contains(from) {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} split/mod.rs PeripheralBootloaderJump enum tail missing in {}; \
             upstream may have changed — update firmware/build.rs::patch_rmk_split_host_ready_variant",
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

/// Round 8 / Layer B4: the central's PeripheralManager pushes KOBU_HOST_READY to
/// the peripheral via SplitMessage::HostReady, riding the existing ≤500ms
/// ConnectionState resync (patch_rmk_split_state_resync_fast). Bounded like the
/// other split writes. Anchors on the round-7-patched ConnectionState arm, so it
/// MUST be registered after patch_rmk_timeout_split_writes in build.rs::main.
fn patch_rmk_emit_host_ready() {
    const MARKER: &str = "// kobu: central emits SplitMessage::HostReady applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/split/driver.rs") else {
        println!(
            "cargo:warning=kobu: could not find rmk-{RMK_VERSION} split/driver.rs; \
             emit-HostReady patch was not applied"
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

    let from = r#"                        Err(_) => warn!("kobu: split ConnectionState write timed out (dropped)"),
                    }
                    last_sync_time = Instant::now();"#;
    let to = r#"                        Err(_) => warn!("kobu: split ConnectionState write timed out (dropped)"),
                    }
                    // kobu (round 8 Layer B4): also push the REAL host-ready state
                    // so the peripheral gates its pointer pipeline through Mac
                    // bring-up. Bounded; rides the same <=500ms resync.
                    let __kobu_host_ready = crate::input_device::battery::KOBU_HOST_READY
                        .load(Ordering::Acquire);
                    match embassy_time::with_timeout(
                        embassy_time::Duration::from_millis(20),
                        self.transceiver.write(&SplitMessage::HostReady(__kobu_host_ready)),
                    )
                    .await
                    {
                        Ok(Err(SplitDriverError::Disconnected)) => return,
                        Ok(Err(e)) => error!("SplitDriver write error: {:?}", e),
                        Ok(Ok(_)) => {}
                        Err(_) => warn!("kobu: split HostReady write timed out (dropped)"),
                    }
                    last_sync_time = Instant::now();"#;

    if !contents.contains(from) {
        panic!(
            "kobu: expected round-7 ConnectionState arm in rmk-{RMK_VERSION} split/driver.rs at {}; \
             patch_rmk_timeout_split_writes must run first — check order in build.rs::main",
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

/// Round 8 / Layer B5: peripheral applies HostReady to its own input gate, and
/// re-closes the gate when the split link to central drops (so a reconnect
/// re-arms it via the next HostReady). Two edits in two files.
fn patch_rmk_peripheral_apply_host_ready() {
    const MARKER: &str = "// kobu: peripheral applies HostReady gate applied";
    const RMK_VERSION: &str = "0.8.2";

    // (a) split/peripheral.rs — handle the HostReady message.
    if let Some(path) = find_rmk_file(RMK_VERSION, "src/split/peripheral.rs") {
        let contents = fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!("kobu: failed to read {}: {e}", path.display());
        });
        if !contents.contains(MARKER) {
            println!("cargo:rerun-if-changed={}", path.display());
            let from = r#"                        SplitMessage::Layer(layer) => {
                            // Publish Layer to CONTROLLER_CHANNEL"#;
            let to = r#"                        SplitMessage::HostReady(ready) => {
                            // kobu (round 8 Layer B): central tells us the REAL
                            // host-link state. Gate this peripheral's PMW3610
                            // read_event so the pointer pipeline stays silent
                            // through Mac bring-up; open + wake the parked reader
                            // once the host is ready.
                            crate::input_device::battery::KOBU_INPUT_GATED
                                .store(!ready, core::sync::atomic::Ordering::Relaxed);
                            if ready {
                                crate::input_device::battery::KOBU_INPUT_GATE_WAKE.signal(());
                            }
                        }
                        SplitMessage::Layer(layer) => {
                            // Publish Layer to CONTROLLER_CHANNEL"#;
            if !contents.contains(from) {
                panic!(
                    "kobu: expected rmk-{RMK_VERSION} split/peripheral.rs Layer arm anchor missing in {}; \
                     upstream may have changed — update firmware/build.rs::patch_rmk_peripheral_apply_host_ready",
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
        }
    }

    // (b) split/ble/peripheral.rs — re-close the gate on split disconnect.
    if let Some(path) = find_rmk_file(RMK_VERSION, "src/split/ble/peripheral.rs") {
        let contents = fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!("kobu: failed to read {}: {e}", path.display());
        });
        if !contents.contains(MARKER) {
            println!("cargo:rerun-if-changed={}", path.display());
            let from = r#"                    CONNECTION_STATE.store(false, core::sync::atomic::Ordering::Release);
                    return Err(SplitDriverError::Disconnected);"#;
            let to = r#"                    CONNECTION_STATE.store(false, core::sync::atomic::Ordering::Release);
                    // kobu (round 8 Layer B): split link to central dropped —
                    // re-close the pointer gate so a reconnect re-arms it via the
                    // next HostReady, keeping the pipeline silent across bring-up.
                    crate::input_device::battery::KOBU_INPUT_GATED
                        .store(true, core::sync::atomic::Ordering::Relaxed);
                    return Err(SplitDriverError::Disconnected);"#;
            if !contents.contains(from) {
                panic!(
                    "kobu: expected rmk-{RMK_VERSION} split/ble/peripheral.rs Disconnected arm anchor missing in {}; \
                     upstream may have changed — update firmware/build.rs::patch_rmk_peripheral_apply_host_ready",
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
        }
    }
}

/// Round 10 / Layer A: bound the UNBOUNDED `reply.send().await` in rmk's
/// `gatt_events_task` (ble/mod.rs). On a stale bonded resume the Mac fires a
/// dense GATT cache-revalidation burst; if the single shared trouBLE outbound
/// queue is credit-starved (the lone TxRunner parked on a host PDU while the
/// trackball floods the split link), this reply send blocks forever, the conn
/// event pump stops calling conn.next(), and the whole link wedges with no
/// reset (the observed HANG). R5/R6 only bounded `write_report` notifies; R7/R8
/// only the split writes — THIS await was never bounded. Drop on timeout so the
/// event pump keeps running and can observe the eventual disconnect.
fn patch_rmk_timeout_gatt_reply() {
    const MARKER: &str = "// kobu: bounded gatt reply.send applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/ble/mod.rs") else {
        println!(
            "cargo:warning=kobu: could not find rmk-{RMK_VERSION} ble/mod.rs; \
             bounded gatt reply.send patch was not applied"
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

    let from = r#"                match result {
                    Ok(reply) => reply.send().await,
                    Err(e) => warn!("[gatt] error sending response: {:?}", e),
                }"#;
    let to = r#"                match result {
                    // kobu (round 10 Layer A): bound the GATT reply send so
                    // gatt_events_task can NEVER deadlock on a full / credit-
                    // starved shared outbound queue during a stale-resume burst.
                    // Drop on timeout; the event pump must keep polling
                    // conn.next() to observe disconnect and recover (the HANG fix).
                    Ok(reply) => match with_timeout(Duration::from_millis(20), reply.send()).await {
                        Ok(()) => {}
                        Err(_) => warn!("kobu: gatt reply send timed out (dropped)"),
                    },
                    Err(e) => warn!("[gatt] error sending response: {:?}", e),
                }"#;

    if !contents.contains(from) {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} ble/mod.rs gatt reply.send block missing in {}; \
             upstream may have changed — update firmware/build.rs::patch_rmk_timeout_gatt_reply",
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

/// Round 10 / Layer C: shrink the host-link supervision timeout 5s -> 2s in
/// `set_conn_params` (ble/mod.rs, both update stages). kobu's slide switch cuts
/// power with no BLE terminate, so the Mac keeps a STALE bonded link until ITS
/// supervision timeout fires; the wedge only happens on that stale-resume path.
/// A shorter timeout makes the Mac drop the stale link faster (mirrors ZMK's
/// CONFIG_BT_PERIPHERAL_PREF_TIMEOUT=2s on KobitoKey), shrinking the dangerous
/// window. NOTE: macOS may clamp/ignore a peripheral-requested timeout — must be
/// measured on-device; this only complements Layers A/B.
fn patch_rmk_supervision_timeout_2s() {
    const MARKER: &str = "// kobu: supervision_timeout 5s -> 2s applied";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/ble/mod.rs") else {
        return;
    };
    println!("cargo:rerun-if-changed={}", path.display());
    let mut contents = fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!("kobu: failed to read {}: {e}", path.display());
    });
    if contents.contains(MARKER) {
        return;
    }

    let from = "supervision_timeout: Duration::from_secs(5),";
    let to = "supervision_timeout: Duration::from_secs(2), // kobu (round 10): was 5s; shrink the stale-link window (Mac drops a dead kobu faster)";
    if !contents.contains(from) {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} ble/mod.rs supervision_timeout from_secs(5) missing in {}; \
             upstream may have changed — update firmware/build.rs::patch_rmk_supervision_timeout_2s",
            path.display()
        );
    }
    // Both update_conn_params stages use 5s; replace all.
    contents = contents.replace(from, to);

    contents.push('\n');
    contents.push_str(MARKER);
    contents.push('\n');
    fs::write(&path, contents).unwrap_or_else(|e| {
        panic!("kobu: failed to write {}: {e}", path.display());
    });
}
