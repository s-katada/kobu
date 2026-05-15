//! Trackball glue for kobu (both halves).
//!
//! LEFT half (= central, local PMW3610) drives SCROLL.
//! RIGHT half (= peripheral, forwarded PMW3610) drives POINTER motion.
//!
//! ## Why the axis relabel
//!
//! RMK 0.8's split protocol forwards peripheral pointing events to the
//! central as `Event::Joystick([AxisEvent { axis: X, .. }, AxisEvent { axis:
//! Y, .. }, ..])` — structurally identical to events produced by the
//! central's own PMW3610 device. Both land on the same `EVENT_CHANNEL` and
//! flow through the same processor chain, with no source tag.
//!
//! The trick: wrap the central-local device with [`AxisRelabel`] so its
//! Joystick events go out tagged with `Axis::H` / `Axis::V` instead of
//! `Axis::X` / `Axis::Y`. Peripheral events still arrive with X/Y. The
//! processor chain is `[ScrollProcessor, PointerProcessor]`:
//!
//! * [`ScrollProcessor`] matches H/V (central-local) → MouseReport wheel
//! * [`PointerProcessor`] matches X/Y (peripheral-forwarded) → MouseReport x/y
//!
//! Each processor returns `Stop` once it matches its axes, so the chain
//! routes deterministically.

use core::cell::RefCell;

use rmk::event::{Axis, Event};
use rmk::hid::Report;
use rmk::input_device::{InputDevice, InputProcessor, ProcessResult};
use rmk::keymap::KeyMap;
use usbd_hid::descriptor::MouseReport;

/// Wraps an inner `InputDevice` and rewrites `Event::Joystick` axes
/// X → H, Y → V. Used on the central side to tag locally-sourced
/// PMW3610 events so [`ScrollProcessor`] can claim them while leaving
/// peripheral-forwarded (still-X/Y) events for [`PointerProcessor`].
pub struct AxisRelabel<D> {
    inner: D,
}

impl<D> AxisRelabel<D> {
    pub fn new(inner: D) -> Self {
        Self { inner }
    }
}

impl<D: InputDevice> InputDevice for AxisRelabel<D> {
    async fn read_event(&mut self) -> Event {
        let mut event = self.inner.read_event().await;
        if let Event::Joystick(axes) = &mut event {
            for ev in axes.iter_mut() {
                ev.axis = match ev.axis {
                    Axis::X => Axis::H,
                    Axis::Y => Axis::V,
                    other => other,
                };
            }
        }
        event
    }
}

fn clamp_i8(value: i16) -> i8 {
    value.clamp(i8::MIN as i16, i8::MAX as i16) as i8
}

/// Scroll processor. Matches Joystick events with H/V axes (= LEFT half,
/// central-local, relabeled by [`AxisRelabel`]) and emits MouseReport
/// wheel deltas. Both axes are summed and negated into the vertical
/// wheel; `pan` is suppressed. See the LEFT-only commit history for the
/// rationale on this combined-vertical mapping.
pub struct ScrollProcessor<
    'a,
    const ROW: usize,
    const COL: usize,
    const NUM_LAYER: usize,
    const NUM_ENCODER: usize,
> {
    keymap: &'a RefCell<KeyMap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>>,
}

impl<'a, const ROW: usize, const COL: usize, const NUM_LAYER: usize, const NUM_ENCODER: usize>
    ScrollProcessor<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>
{
    pub fn new(keymap: &'a RefCell<KeyMap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>>) -> Self {
        Self { keymap }
    }
}

impl<'a, const ROW: usize, const COL: usize, const NUM_LAYER: usize, const NUM_ENCODER: usize>
    InputProcessor<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>
    for ScrollProcessor<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>
{
    async fn process(&mut self, event: Event) -> ProcessResult {
        match event {
            Event::Joystick(axes) => {
                let mut horizontal = 0i16;
                let mut vertical = 0i16;
                let mut matched = false;
                for ev in axes.iter() {
                    match ev.axis {
                        Axis::H => {
                            horizontal = ev.value;
                            matched = true;
                        }
                        Axis::V => {
                            vertical = ev.value;
                            matched = true;
                        }
                        _ => {}
                    }
                }
                if !matched {
                    return ProcessResult::Continue(event);
                }
                let report = MouseReport {
                    buttons: 0,
                    x: 0,
                    y: 0,
                    wheel: clamp_i8(-(horizontal + vertical)),
                    pan: 0,
                };
                self.send_report(Report::MouseReport(report)).await;
                ProcessResult::Stop
            }
            _ => ProcessResult::Continue(event),
        }
    }

    fn get_keymap(&self) -> &RefCell<KeyMap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>> {
        self.keymap
    }
}

/// Pointer processor. Matches Joystick events with X/Y axes (= RIGHT half,
/// peripheral-forwarded, untouched) and emits MouseReport pointer motion.
pub struct PointerProcessor<
    'a,
    const ROW: usize,
    const COL: usize,
    const NUM_LAYER: usize,
    const NUM_ENCODER: usize,
> {
    keymap: &'a RefCell<KeyMap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>>,
}

impl<'a, const ROW: usize, const COL: usize, const NUM_LAYER: usize, const NUM_ENCODER: usize>
    PointerProcessor<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>
{
    pub fn new(keymap: &'a RefCell<KeyMap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>>) -> Self {
        Self { keymap }
    }
}

impl<'a, const ROW: usize, const COL: usize, const NUM_LAYER: usize, const NUM_ENCODER: usize>
    InputProcessor<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>
    for PointerProcessor<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>
{
    async fn process(&mut self, event: Event) -> ProcessResult {
        match event {
            Event::Joystick(axes) => {
                let mut x = 0i16;
                let mut y = 0i16;
                let mut matched = false;
                for ev in axes.iter() {
                    match ev.axis {
                        Axis::X => {
                            x = ev.value;
                            matched = true;
                        }
                        Axis::Y => {
                            y = ev.value;
                            matched = true;
                        }
                        _ => {}
                    }
                }
                if !matched {
                    return ProcessResult::Continue(event);
                }
                let report = MouseReport {
                    buttons: 0,
                    x: clamp_i8(x),
                    y: clamp_i8(y),
                    wheel: 0,
                    pan: 0,
                };
                self.send_report(Report::MouseReport(report)).await;
                ProcessResult::Stop
            }
            _ => ProcessResult::Continue(event),
        }
    }

    fn get_keymap(&self) -> &RefCell<KeyMap<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>> {
        self.keymap
    }
}
