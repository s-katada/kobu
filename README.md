# kobu

自作分割キーボード「kobu」のモノレポです。世代ごとにディレクトリを分けています。

## ディレクトリ構成

| ディレクトリ | 中身 |
|---|---|
| [`v1/`](v1/) | 初代 kobu — KiCad PCB / ケース / ファームウェア (RMK・ZMK) / Web キーマップエディタ。詳細は [`v1/README.md`](v1/README.md) |
| [`v2/`](v2/) | kobu v2 — ケース / RMK ファームウェア。小指キーを左右 1 個ずつ追加した第 2 世代 (kobu2, PID 0x425A)。詳細は [`v2/README.md`](v2/README.md) |

## 開発環境

Nix flake / direnv。ルートの [`flake.nix`](flake.nix) が toolchain バージョンの単一情報源で、CI も同じ devshell で走ります。使い方は [`v1/README.md`](v1/README.md#開発環境) を参照。
