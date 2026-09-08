import Foundation
import IOKit.hid

// Passive HID input logger for kobu2 (VID 0x4B4F / PID 0x425A) pointer traffic ONLY.
// Logs Generic Desktop X/Y/Wheel, Consumer AC Pan and Button page values.
// Keyboard (usage page 7), other consumer keys and vendor pages are NOT logged.
setvbuf(stdout, nil, _IOLBF, 0)
let mgr = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
let match: [String: Any] = [kIOHIDVendorIDKey as String: 0x4b4f, kIOHIDProductIDKey as String: 0x425a]
IOHIDManagerSetDeviceMatching(mgr, match as CFDictionary)
let cb: IOHIDValueCallback = { _, _, _, value in
    let el = IOHIDValueGetElement(value)
    let up = IOHIDElementGetUsagePage(el), u = IOHIDElementGetUsage(el)
    let ok = (up == 0x01 && (u == 0x30 || u == 0x31 || u == 0x38)) || (up == 0x0C && u == 0x0238) || (up == 0x09)
    if !ok { return }
    let v = IOHIDValueGetIntegerValue(value)
    let ts = IOHIDValueGetTimeStamp(value)
    let now = Date().timeIntervalSince1970
    print(String(format: "%.6f %llu %u %u %ld", now, ts, up, u, v))
}
IOHIDManagerRegisterInputValueCallback(mgr, cb, nil)
IOHIDManagerScheduleWithRunLoop(mgr, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)
let r = IOHIDManagerOpen(mgr, IOOptionBits(kIOHIDOptionsTypeNone))
print(String(format: "# open result: 0x%08x (0 = ok, 0xe00002e2 = not permitted)", r))
if let devs = IOHIDManagerCopyDevices(mgr) as? Set<IOHIDDevice> {
    for d in devs {
        let name = IOHIDDeviceGetProperty(d, kIOHIDProductKey as CFString) as? String ?? "?"
        let pu = IOHIDDeviceGetProperty(d, kIOHIDPrimaryUsageKey as CFString) as? Int ?? -1
        let pup = IOHIDDeviceGetProperty(d, kIOHIDPrimaryUsagePageKey as CFString) as? Int ?? -1
        let tr = IOHIDDeviceGetProperty(d, kIOHIDTransportKey as CFString) as? String ?? "?"
        print("# device: \(name) usagePage=\(pup) usage=\(pu) transport=\(tr)")
    }
}
print("# start \(Date().timeIntervalSince1970)")
CFRunLoopRun()
