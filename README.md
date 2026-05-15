# kobu

自作分割キーボード「kobitokey」にインスパイアされて作った派生キーボード「kobu」の KiCad プロジェクトとファームウェアです。親指キーを追加し、メインキー側を 2 キー削っています。

## 主要部品

- スイッチ: Kailh Choc V2 ホットスワップ（1.00u）
- ダイオード: SOD-123
- コネクタ: Hirose FH12-10S-0.5SH（FFC/FPC 10 ピン, 0.5mm ピッチ）
- MCU: Seeed XIAO nRF52840 BLE（左右親指ユニットに 1 個ずつ）
- トラックボール: PMW3610 光学センサー（左右親指ユニットに 1 個ずつ、3 線 SPI）

## キーマップ

![keymap](firmware/keymap/kobu.svg)
