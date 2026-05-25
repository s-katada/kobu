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

/// Replace `BleBatteryServer::run` with a kobu-specific version that:
///
/// 1. Drops the upstream 30-second first-report timeout (we wait
///    indefinitely for the first `BatteryState::Normal` so a slow ADC
///    settle never makes us give up).
/// 2. Pushes a non-zero sentinel value (last known or 100) on connect
///    *before* waiting on `BATTERY_UPDATE`. macOS hides the
///    Bluetooth-menu battery indicator when BAS reads 0%; without a
///    pre-push the characteristic stays at the trouble_host default 0
///    until the first real ADC sample lands, which is enough time for
///    macOS to bind the device without a percentage.
/// 3. Drops the `wait_until_battery_state_available` keypress gate
///    (upstream only re-notifies after typing in the last 60s, which
///    makes a freshly-paired-but-idle keyboard look like it has no
///    battery).
/// 4. Adds a 60-second heartbeat so the same value is re-pushed even if
///    `BATTERY_UPDATE` is silent — this keeps `server.set` writing the
///    stored characteristic value so macOS GATT reads always see a fresh
///    timestamp.
fn patch_rmk_battery_service() {
    const MARKER: &str = "// kobu: BleBatteryServer aggressive-notify patch applied (v2 sentinel 73)";
    const RMK_VERSION: &str = "0.8.2";

    let Some(path) = find_rmk_file(RMK_VERSION, "src/ble/battery_service.rs") else {
        println!(
            "cargo:warning=kobu: could not find rmk-{RMK_VERSION} battery_service.rs; \
             aggressive-notify patch was not applied"
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

    let old_body = r#"    pub(crate) async fn run(&mut self) {
        // Wait 2 seconds, ensure that gatt server has been started
        Timer::after_secs(2).await;

        // First report after connected
        let first_report = async {
            loop {
                if let BatteryState::Normal(level) = BATTERY_UPDATE.wait().await {
                    if let Err(e) = self.battery_level.notify(self.conn, &level).await {
                        error!("Failed to notify battery level: {:?}", e);
                    } else {
                        return;
                    }
                }
                embassy_time::Timer::after_secs(2).await;
            }
        };

        // Try to do the first battery report in 30 seconds
        with_timeout(Duration::from_secs(30), first_report).await.ok();

        // Report the battery level.
        loop {
            let battery_state = self.wait_until_battery_state_available().await;
            // Check if there's latest battery state update
            if let BatteryState::Normal(level) = BATTERY_UPDATE.try_take().unwrap_or(battery_state)
                && let Err(e) = self.battery_level.notify(self.conn, &level).await
            {
                error!("Failed to notify battery level: {:?}", e);
            }
        }
    }"#;

    let new_body = r#"    pub(crate) async fn run(&mut self) {
        // Wait 2 seconds, ensure that gatt server has been started
        Timer::after_secs(2).await;

        // kobu patch (diagnostic sentinel 73): if try_take pulls a real
        // value, send it; otherwise send 73 as a distinguishable sentinel.
        // Some hosts (notably macOS) treat BAS level == 0 as "no data" and
        // refuse to update the menu off the previously shown value, so we
        // also clamp anything below 1 to 1 so the user can tell when ADC
        // genuinely reads zero.
        let mut last_level: u8 = 73;
        if let Some(BatteryState::Normal(level)) = BATTERY_UPDATE.try_take() {
            last_level = level.max(1);
        }
        if let Err(e) = self.battery_level.notify(self.conn, &last_level).await {
            error!("Failed to notify battery level (kobu initial): {:?}", e);
        }

        loop {
            let next = embassy_time::with_timeout(
                embassy_time::Duration::from_secs(60),
                BATTERY_UPDATE.wait(),
            )
            .await;
            if let Ok(BatteryState::Normal(level)) = next {
                last_level = level.max(1);
            }
            if let Err(e) = self.battery_level.notify(self.conn, &last_level).await {
                error!("Failed to notify battery level: {:?}", e);
            }
        }
    }"#;

    if !contents.contains(old_body) {
        panic!(
            "kobu: expected rmk-{RMK_VERSION} BleBatteryServer::run body missing in {}; \
             upstream may have changed — update firmware/build.rs",
            path.display()
        );
    }
    contents = contents.replace(old_body, new_body);

    contents.push('\n');
    contents.push_str(MARKER);
    contents.push('\n');

    fs::write(&path, contents).unwrap_or_else(|e| {
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
