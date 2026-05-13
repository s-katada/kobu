//! Trackball-to-scroll mapping for the LEFT half.
//!
//! Replaces the stock `Pmw3610Processor` (which emits mouse pointer x/y) so
//! that ball motion is reported as scroll wheel deltas instead.
//!
//! Both axes feed the vertical wheel and `pan` is held at 0:
//!   * `wheel = -(x + y)` — rolling the ball forward (sensor +Y) OR to the
//!     right (sensor +X) yields a negative HID wheel value, which the host
//!     interprets as a downward scroll.
//!   * If the physical "forward roll" direction comes out backwards on this
//!     PCB orientation, flip it at the sensor by setting
//!     `invert_y = true` (or `invert_x` for left/right) on the
//!     `[[split.central.input_device.pmw3610]]` entry in keyboard.toml —
//!     that's cleaner than editing this formula.

use core::cell::RefCell;

use rmk::event::{Axis, Event};
use rmk::hid::Report;
use rmk::input_device::{InputProcessor, ProcessResult};
use rmk::keymap::KeyMap;
use usbd_hid::descriptor::MouseReport;

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

fn clamp_i8(value: i16) -> i8 {
    value.clamp(i8::MIN as i16, i8::MAX as i16) as i8
}

impl<'a, const ROW: usize, const COL: usize, const NUM_LAYER: usize, const NUM_ENCODER: usize>
    InputProcessor<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>
    for ScrollProcessor<'a, ROW, COL, NUM_LAYER, NUM_ENCODER>
{
    async fn process(&mut self, event: Event) -> ProcessResult {
        match event {
            Event::Joystick(axes) => {
                let mut x = 0i16;
                let mut y = 0i16;
                let mut matched = false;
                for axis_event in axes.iter() {
                    match axis_event.axis {
                        Axis::X => {
                            x = axis_event.value;
                            matched = true;
                        }
                        Axis::Y => {
                            y = axis_event.value;
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
                    wheel: clamp_i8(-(x + y)),
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
