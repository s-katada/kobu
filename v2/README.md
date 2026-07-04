# kobu v2

自作分割キーボード kobu の第 2 世代。v1 との**ハード面の違いは小指列最下段のキーを左右 1 個ずつ追加**したことだけです（19 → 20 キー/半分、計 40 キー）。

初代の PCB / ケース / ファームウェア / Web エディタは [`../v1/`](../v1/) にあります。

## ディレクトリ構成

| ディレクトリ | 中身 |
|---|---|
| [`case/`](case/) | ケースの STL |
| [`firmware/rmk/`](firmware/rmk/) | RMK ベースのファームウェア (Rust, thumbv7em-none-eabihf)。v1 の `firmware/rmk` からのフォーク |

## v1 とのファームウェア差分

- 追加キーは各半分の空いていたマトリクス交点 **ROW3×COL4**（小指列ネット × 親指行ネット）に配線。GPIO 追加なし・マトリクス寸法 (4×10) 変更なしで、keymap 座標では v1 で phantom だった **(3,0) / (3,9)** に載ります。レイヤー 0 の割り当ては左=LShift / 右=RShift（他レイヤーは透過）。
  - PCB 設計時の前提: /ROW3 をメインユニットへ FFC の予備線（10 ピン中 2 本空き）で延長し、逆順マッピング FFC ケーブル前提のピン配置（`firmware/rmk/keyboard.toml` 冒頭コメント参照）を維持すること。
- 識別子: name/product_name = **kobu2**、product_id = **0x425A**（VID `0x4b4f` と Vial keyboard UID は v1 と共通）。[web editor](../v1/web/rmk-editor/) は v1/v2 両方の PID を受け付けます。
- それ以外（build.rs の 74 レジストリパッチ、`src/`、メモリレイアウト、依存クレートのバージョン）は v1 と同一です。

## ⚠️ build.rs は v1 と同一内容に保つ

v1/v2 の build.rs はどちらも**共有 cargo registry のソースを in-place パッチ**します。両者が同一内容ならパッチは冪等で、どちらのツリーを先にビルドしても安全です。**片方だけにパッチを足して乖離させた場合**は、もう片方をビルドする前に

```sh
cargo clean --release -p rmk -p trouble-host -p rmk-macro
```

で 3 crate をパッチ済みソースから作り直してください（CI はジョブごとに pristine な registry なので無関係）。

## ビルド

v1 と同じで、リポジトリルートの devshell を使います:

```sh
cd v2/firmware/rmk        # direnv が firmware devshell を自動起動
cargo build --release --bin central
cargo build --release --bin peripheral
```

UF2 は CI が [firmware-latest リリース](../../releases/tag/firmware-latest)に `kobu2-rmk-central.uf2` / `kobu2-rmk-peripheral.uf2`（+ `-reset` 版）として公開します。ローカルで作る場合は devshell の `kobu-uf2conv`:

```sh
kobu-uf2conv target/thumbv7em-none-eabihf/release/central    kobu2-rmk-central.uf2
kobu-uf2conv target/thumbv7em-none-eabihf/release/peripheral kobu2-rmk-peripheral.uf2
```
