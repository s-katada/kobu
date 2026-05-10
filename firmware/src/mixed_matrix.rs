//! Hand-rolled split-half matrix that handles the kobitokey-o-oyayubi
//! mixed-diode assembly.
//!
//! Why a custom matrix instead of `rmk::matrix::bidirectional_matrix`:
//!   We tried BidirectionalMatrix first and it failed across the board
//!   (likely a combination of the per-cell pin direction toggle leaving
//!   pins in unexpected states and a row/col indexing quirk in the
//!   resume-from-scan_pos logic). This implementation uses straight
//!   embassy-nrf `Flex` pins and runs two clean scan passes per cycle:
//!
//!     Pass A — main keys (rows 0..2, all 5 cols), col2row direction:
//!       drive col_pins[c] HIGH, read row_pins[0..2]. Works for the
//!       reversed main-unit diodes (anode physically on /COL).
//!     Pass B — thumb keys (row 3 only), row2col direction:
//!       drive row_pins[3] HIGH, read col_pins[..]. Works for the
//!       schematic-correct thumb diodes (anode on /ROW).
//!
//! Phantom (no PCB switch) cells are listed as `Phantom` in the layout
//! and skipped during scan. Outputs are emitted in *local* (row, col)
//! coordinates; the central wraps this in `OffsetMatrixWrapper` and the
//! peripheral relies on `run_peripheral_manager`'s own (0, 5) shift.
//!
//! Pin index convention (must match the array passed to `MixedDiodeMatrix::new`):
//!     pins[0..3] = ROW0..ROW3
//!     pins[4..8] = the five COL pins, ordered so that local col 0 is
//!                  the leftmost column of *that half* on the user's
//!                  view (= /COL4 for left, /COL0 for right).

use embassy_nrf::gpio::{Flex, Level, OutputDrive, Pull};
use embassy_time::{Instant, Timer};
use rmk::debounce::default_debouncer::DefaultDebouncer;
use rmk::debounce::{DebounceState, DebouncerTrait};
use rmk::event::{Event, KeyboardEvent};
use rmk::input_device::InputDevice;
use rmk::matrix::{KeyState, MatrixTrait};

pub const ROW_LOCAL: usize = 4;
pub const COL_LOCAL: usize = 5;
pub const PIN_NUM: usize = 9;

const ROW_PIN_BASE: usize = 0;
const COL_PIN_BASE: usize = 4;

/// Which logical column on the local 4×5 matrix has no PCB switch on
/// row 3 (the thumb row). The rest of row 3 holds real switches.
#[derive(Clone, Copy)]
#[allow(dead_code)] // Each binary uses exactly one variant; the other looks dead per-bin.
pub enum ThumbPhantom {
    /// Phantom at local col 0. Use this on the left half (col 0 = pinky
    /// = /COL4 wire — no thumb switch on /COL4 row 3).
    Col0,
    /// Phantom at local col 4. Use this on the right half (col 4 =
    /// pinky = /COL4 wire).
    Col4,
}

pub struct MixedDiodeMatrix<'d> {
    pins: [Flex<'d>; PIN_NUM],
    debouncer: DefaultDebouncer<ROW_LOCAL, COL_LOCAL>,
    key_state: [[KeyState; COL_LOCAL]; ROW_LOCAL],
    phantom: ThumbPhantom,
    /// Pending events to drain before scanning anew. `read_event` returns
    /// one event per call (per the InputDevice contract), so when a scan
    /// finds multiple state changes we queue the rest here.
    pending: heapless::Deque<KeyboardEvent, 8>,
}

impl<'d> MixedDiodeMatrix<'d> {
    pub fn new(mut pins: [Flex<'d>; PIN_NUM], phantom: ThumbPhantom) -> Self {
        // Idle state: every pin is a pull-down input. Each scan cell will
        // briefly flip the appropriate pin to output HIGH and back.
        for pin in pins.iter_mut() {
            pin.set_as_input(Pull::Down);
        }
        Self {
            pins,
            debouncer: DefaultDebouncer::new(),
            key_state: [[KeyState::new(); COL_LOCAL]; ROW_LOCAL],
            phantom,
            pending: heapless::Deque::new(),
        }
    }

    fn is_phantom(&self, row: usize, col: usize) -> bool {
        if row != 3 {
            return false;
        }
        match self.phantom {
            ThumbPhantom::Col0 => col == 0,
            ThumbPhantom::Col4 => col == 4,
        }
    }

    fn drive_high(&mut self, idx: usize) {
        let p = &mut self.pins[idx];
        p.set_low();
        p.set_as_output(OutputDrive::Standard);
        p.set_high();
    }

    fn release_to_input(&mut self, idx: usize) {
        let p = &mut self.pins[idx];
        p.set_low();
        p.set_as_input(Pull::Down);
    }

    fn read(&mut self, idx: usize) -> bool {
        self.pins[idx].is_high()
    }

    /// Run one full scan of all 4×5 - 1 cells. For every cell where the
    /// debouncer reports a Debounced change, push a KeyboardEvent into
    /// `self.pending`. Returns once the scan is done.
    async fn scan_once(&mut self) {
        // ---- Pass A: main keys (rows 0..2). col2row direction. ----
        for col in 0..COL_LOCAL {
            self.drive_high(COL_PIN_BASE + col);
            // Allow the col line to settle; nrf-52840 push-pull rise time
            // is well below 1 µs, but with embassy-time 32 kHz tick,
            // `after_micros(1)` actually waits one tick (~30 µs), which
            // is fine.
            Timer::after_micros(1).await;

            for row in 0..3usize {
                let level = self.read(ROW_PIN_BASE + row);
                self.observe(row, col, level);
            }

            self.release_to_input(COL_PIN_BASE + col);
            // Give the diodes a moment to discharge before driving the
            // next col, otherwise a still-charged row line could read
            // HIGH on a different (row, col) cell.
            Timer::after_micros(1).await;
        }

        // ---- Pass B: thumb keys (row 3). row2col direction. ----
        self.drive_high(ROW_PIN_BASE + 3);
        Timer::after_micros(1).await;

        for col in 0..COL_LOCAL {
            if self.is_phantom(3, col) {
                continue;
            }
            let level = self.read(COL_PIN_BASE + col);
            self.observe(3, col, level);
        }

        self.release_to_input(ROW_PIN_BASE + 3);
        Timer::after_micros(1).await;
    }

    fn observe(&mut self, row: usize, col: usize, pin_high: bool) {
        let state = self.key_state[row][col];
        let result = self.debouncer.detect_change_with_debounce(row, col, pin_high, &state);
        if let DebounceState::Debounced = result {
            self.key_state[row][col].toggle_pressed();
            let pressed = self.key_state[row][col].pressed;
            // Queue the event; if the queue is full the oldest pending
            // event is dropped — events at this layer are press/release
            // pairs so a stuck-press-into-overflow scenario is hard to
            // hit in practice.
            if self.pending.is_full() {
                let _ = self.pending.pop_front();
            }
            let _ = self.pending.push_back(KeyboardEvent::key(row as u8, col as u8, pressed));
        }
    }
}

impl<'d> InputDevice for MixedDiodeMatrix<'d> {
    async fn read_event(&mut self) -> Event {
        loop {
            if let Some(ev) = self.pending.pop_front() {
                return Event::Key(ev);
            }
            self.scan_once().await;

            // No events this cycle — yield briefly so other tasks (BLE,
            // USB, keyboard processor) can run, then loop and scan
            // again. The 1 ms idle gap is comfortably below typical key
            // debounce windows but long enough to not starve the rest
            // of the executor.
            if self.pending.is_empty() {
                Timer::after(embassy_time::Duration::from_millis(1)).await;
            }
        }
    }
}

impl<'d> MatrixTrait<ROW_LOCAL, COL_LOCAL> for MixedDiodeMatrix<'d> {
    // The `async_matrix` feature gate is on `rmk`'s side and is enabled
    // because of our `rmk = { features = ["async_matrix", ...] }`. When
    // rmk is compiled that way, MatrixTrait requires `wait_for_key`, so
    // we must provide it unconditionally here (using cfg(feature = ...)
    // in *this* crate would target our own features and never match).
    async fn wait_for_key(&mut self) {
        // No-op. Our `read_event` always scans, so no async-wakeup is
        // needed. This is consistent with the empty impl in upstream
        // BidirectionalMatrix.
    }
}

// Suppress unused-instant warning if no pass-through ever uses this.
#[allow(dead_code)]
fn _unused_instant() -> Instant {
    Instant::now()
}

// Suppress unused-import warnings on Level — kept reachable in case a
// future revision wants to start a pin in a particular initial state.
#[allow(dead_code)]
fn _unused_level() -> Level {
    Level::Low
}
