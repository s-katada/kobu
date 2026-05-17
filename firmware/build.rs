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
    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .ok()?;
    let src_root = PathBuf::from(home).join(".cargo/registry/src");
    let entries = fs::read_dir(&src_root).ok()?;
    let crate_dir = format!("rmk-{rmk_version}");
    let rel = Path::new(&crate_dir).join("src/ble/mod.rs");

    for entry in entries.flatten() {
        let candidate = entry.path().join(&rel);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}
