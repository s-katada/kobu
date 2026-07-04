//! Source-tagged battery routing for kobu's web-UI battery display.
//!
//! The macOS Bluetooth menu cannot show left/right battery separately for
//! a single BLE device (verified in the 2026-05-25 session: every dual
//! Battery Service experiment caused macOS to drop the entire battery
//! display). The user-facing answer is to surface both percentages in
//! kobu-config's web UI via the Via Custom Channel 0xC0 plumbing.
//!
//! This module keeps the central and peripheral battery streams apart on
//! the central side without disturbing the rest of RMK's battery
//! plumbing — `BATTERY_UPDATE`, `ControllerEvent::Battery` and the
//! status-LED controller all keep working off the central sample
//! unchanged. The mechanism is a bit-tag convention:
//!
//!   * [`CentralBatteryTagger`] wraps the central's macro-generated
//!     `adc_device` and OR's `0x8000` into the `u16` value carried by
//!     `Event::Battery`. The peripheral-half ADC samples ride the BLE
//!     split link untouched, so they arrive on `EVENT_CHANNEL` without
//!     the high bit set.
//!
//!   * [`KobuBatterySourceTap`] sits at the *head* of the processor
//!     chain. It always writes the decoded percentage into the
//!     appropriate `rmk::input_device::battery::KOBU_*_BATTERY_PERCENT`
//!     atomic so the patched Via `CustomGetValue` handler (see
//!     `firmware/build.rs::patch_rmk_via_custom_get_kobu`) can answer
//!     kobu-config's polls. For peripheral-sourced samples it then
//!     returns `ProcessResult::Stop` so the upstream `BatteryProcessor`
//!     never sees the peripheral value (otherwise the central LED and
//!     the central BAS instance would flicker between left/right
//!     percentages). For central-sourced samples the tap strips the
//!     high bit and returns `ProcessResult::Continue`, letting the
//!     upstream processor handle the event normally.

use core::cell::RefCell;
use core::sync::atomic::Ordering;

use rmk::event::Event;
use rmk::input_device::battery::{KOBU_CENTRAL_BATTERY_PERCENT, KOBU_PERIPHERAL_BATTERY_PERCENT};
use rmk::input_device::{InputDevice, InputProcessor, ProcessResult};
use rmk::keymap::KeyMap;

/// XIAO nRF52840 BLE on-module BAT divider ratio — must match the values
/// in `keyboard.toml`'s `[ble]` section. We need the percentage formula
/// here too because the upstream `BatteryProcessor` is reserved for
/// central samples (kept untouched so `BATTERY_UPDATE`,
/// `ControllerEvent::Battery`, and the status LED keep working) and we
/// decode peripheral samples ourselves before writing into
/// `KOBU_PERIPHERAL_BATTERY_PERCENT`.
const ADC_DIVIDER_MEASURED: i32 = 510;
const ADC_DIVIDER_TOTAL: i32 = 1510;

/// Bit set on `Event::Battery` values produced by the central's ADC
/// device wrapper so the [`KobuBatterySourceTap`] can tell central
/// samples apart from peripheral-forwarded ones (which arrive untagged).
/// The XIAO's SAADC is 12-bit (`val <= 4095`), so bit 15 is always free.
const KOBU_CENTRAL_SOURCE_BIT: u16 = 0x8000;

/// Decode a raw 12-bit SAADC sample (gain = 1/6, reference = internal 0.6V)
/// into a 0..=100 LiPo percentage. Same formula as upstream
/// `BatteryProcessor::get_battery_percent` so central and peripheral
/// readouts stay comparable.
fn lipo_percent_from_adc(val: u16) -> u8 {
    let val = val as i32;
    let measured = ADC_DIVIDER_MEASURED;
    let total = ADC_DIVIDER_TOTAL;
    if val > 4755_i32 * measured / total {
        100
    } else if val < 4055_i32 * measured / total {
        0
    } else {
        ((val * total / measured - 4055) / 7) as u8
    }
}

/// Wrap the central's `adc_device` so every `Event::Battery(val)` it
/// emits arrives with `KOBU_CENTRAL_SOURCE_BIT` set in `val`. The tagged
/// event still ends up on `EVENT_CHANNEL` (via `run_devices!`), then the
/// [`KobuBatterySourceTap`] at the chain head strips the bit before the
/// upstream `BatteryProcessor` ever sees the value, so the percentage
/// formula in `BatteryProcessor::get_battery_percent` works unchanged.
pub struct CentralBatteryTagger<D> {
    inner: D,
}

impl<D> CentralBatteryTagger<D> {
    pub fn new(inner: D) -> Self {
        Self { inner }
    }
}

impl<D: InputDevice> InputDevice for CentralBatteryTagger<D> {
    async fn read_event(&mut self) -> Event {
        let mut event = self.inner.read_event().await;
        if let Event::Battery(ref mut val) = event {
            *val |= KOBU_CENTRAL_SOURCE_BIT;
        }
        event
    }
}

/// Processor placed at the head of the central's chain so it sees every
/// `Event::Battery` before the upstream `BatteryProcessor` does. Always
/// mirrors the decoded percent into the matching kobu atomic so the Via
/// Custom Get handler can answer kobu-config's polls. Then splits the
/// stream into central / peripheral by `KOBU_CENTRAL_SOURCE_BIT`,
/// forwarding central samples downstream (so `BatteryProcessor` still
/// drives `BATTERY_UPDATE` / `ControllerEvent::Battery` for the LED and
/// the existing single BAS instance) and stopping peripheral samples
/// (otherwise the LED and the central BAS would flicker between
/// left/right values).
pub struct KobuBatterySourceTap<
    'a,
    const ROW: usize,
    const COL: usize,
    const NUM_LAYER: usize,
    const NUM_ENCODER: usize,
> {
    keymap: &'a RefCell<KeyMap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>>,
}

impl<
    'a,
    const ROW: usize,
    const COL: usize,
    const NUM_LAYER: usize,
    const NUM_ENCODER: usize,
> KobuBatterySourceTap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>
{
    pub fn new(keymap: &'a RefCell<KeyMap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>>) -> Self {
        Self { keymap }
    }
}

impl<
    'a,
    const ROW: usize,
    const COL: usize,
    const NUM_LAYER: usize,
    const NUM_ENCODER: usize,
> InputProcessor<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>
    for KobuBatterySourceTap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>
{
    async fn process(&mut self, event: Event) -> ProcessResult {
        match event {
            Event::Battery(val) => {
                if val & KOBU_CENTRAL_SOURCE_BIT != 0 {
                    let raw = val & !KOBU_CENTRAL_SOURCE_BIT;
                    let percent = lipo_percent_from_adc(raw);
                    KOBU_CENTRAL_BATTERY_PERCENT.store(percent, Ordering::Relaxed);
                    // Hand a clean value back to the upstream
                    // `BatteryProcessor` so `BATTERY_UPDATE` and
                    // `ControllerEvent::Battery` stay accurate.
                    ProcessResult::Continue(Event::Battery(raw))
                } else {
                    let percent = lipo_percent_from_adc(val);
                    KOBU_PERIPHERAL_BATTERY_PERCENT.store(percent, Ordering::Relaxed);
                    // Stop here so the upstream processor never sees a
                    // peripheral sample.
                    ProcessResult::Stop
                }
            }
            _ => ProcessResult::Continue(event),
        }
    }

    fn get_keymap(&self) -> &RefCell<KeyMap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>> {
        self.keymap
    }
}
