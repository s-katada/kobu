// ledger — read kobu2's pointer loss ledger over the Vial raw-HID channel.
//
// Polls Via Custom Channel 0xC0 ids 0x20..0x28 once a second and prints one row
// per second. The firmware counters are read-and-reset, so every column is a
// per-second rate. Works over USB or BLE, whichever the keyboard is using.
//
//   ARR    pointer samples that reached the central (right ball, across split)
//   EMIT   pointer reports accepted by the shared HID report channel
//   DEFER  pointer reports banked because the channel was busy (lossless)
//   WDROP  mouse notify calls that hit the 40 ms bound (lost delivery)
//   EVDR   split/driver.rs EVENT_CHANNEL drop-oldest evictions
//   FF     this binary's PMW3610 0xff frames rejected (left ball on central)
//   LSMP   this binary's PMW3610 non-zero motion samples (left ball)
//   FWD    bounded split forwards that carried instead of sending (peripheral)
//   INT    live host connection interval in ms
//   BATL   left/central battery %
//   BATR   right/peripheral battery % (0 = the right half has never reported,
//          i.e. the split link is not up in this session)
import Foundation
import IOKit.hid

let ids: [UInt8] = [0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x10, 0x11]
let names = ["ARR", "EMIT", "DEFER", "WDROP", "EVDR", "FF", "LSMP", "FWD", "INT", "BATL", "BATR"]
var values = [UInt8: Int]()
setvbuf(stdout, nil, _IOLBF, 0)

let mgr = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
let match: [String: Any] = [
    kIOHIDVendorIDKey as String: 0x4b4f,
    kIOHIDProductIDKey as String: 0x425a,
    kIOHIDPrimaryUsagePageKey as String: 0xFF60,
]
IOHIDManagerSetDeviceMatching(mgr, match as CFDictionary)
IOHIDManagerOpen(mgr, IOOptionBits(kIOHIDOptionsTypeNone))
guard let devs = IOHIDManagerCopyDevices(mgr) as? Set<IOHIDDevice>, let dev = devs.first else {
    print("no kobu2 raw-HID interface found (VID 0x4B4F / PID 0x425A, usage page 0xFF60).")
    print("is the keyboard connected? over BLE it appears only while paired and awake.")
    exit(1)
}
let transport = IOHIDDeviceGetProperty(dev, kIOHIDTransportKey as CFString) as? String ?? "?"
print("# kobu2 raw HID open, transport=\(transport)")
print("# " + (["time"] + names).map { $0.padding(toLength: 6, withPad: " ", startingAt: 0) }.joined())

var inbuf = [UInt8](repeating: 0, count: 32)
let cb: IOHIDReportCallback = { _, _, _, _, _, report, len in
    guard len >= 5 else { return }
    let b = UnsafeBufferPointer(start: report, count: Int(len))
    if b[0] == 0x08 && b[1] == 0xC0 {
        values[b[2]] = (Int(b[3]) << 8) | Int(b[4])
    }
}
IOHIDDeviceRegisterInputReportCallback(dev, &inbuf, 32, cb, nil)
IOHIDDeviceScheduleWithRunLoop(dev, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)

func poll() {
    for id in ids {
        var out = [UInt8](repeating: 0, count: 32)
        out[0] = 0x08          // Via CustomGetValue
        out[1] = 0xC0          // kobu channel
        out[2] = id
        IOHIDDeviceSetReport(dev, kIOHIDReportTypeOutput, 0, &out, 32)
        usleep(4000)
    }
}
let df = DateFormatter(); df.dateFormat = "HH:mm:ss"
var first = true
Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
    if !first {
        var row = df.string(from: Date()).padding(toLength: 10, withPad: " ", startingAt: 0)
        for (i, id) in ids.enumerated() {
            var v = values[id] ?? -1
            if names[i] == "INT" { v = v / 10 }            // 100 us units -> ms
            if id == 0x10 || id == 0x11 { v = v >> 8 }     // battery ids answer in one byte
            row += String(v).padding(toLength: 6, withPad: " ", startingAt: 0)
        }
        print(row)
    }
    first = false
    values.removeAll()
    poll()
}
poll()
RunLoop.current.run()
