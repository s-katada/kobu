# pointer-loss — Mac 側から右ボールのサンプル欠落を測る

kobu2 が BLE で送ってくるマウスレポートを Mac 側で受け身に記録し、
「速く動かしている最中に、ホスト接続イベント（15ms）にレポートが乗らなかった割合」と
「欠けた分の移動量が次のレポートに繰り越されているか（保存比）」を数値化します。
2026-09-08 の計測では速い移動中の約 12% のイベントでレポートが欠け、保存比が 1.0
（＝欠けた移動量は消失）だったことが「もっさり＝アンダートラベル」の直接証拠になりました。

キーボードの usage page (0x07) は記録しません（キー入力は残らない）。

## 使い方

```sh
# 1. ビルド（nix devshell の SDK と衝突するので、システム SDK を明示）
cd v2/firmware/rmk/scripts/pointer-loss
env -u SDKROOT -u DEVELOPER_DIR SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk \
  /usr/bin/swiftc -O hidlog.swift -o hidlog

# 2. 記録（数分〜、右ボールを普段どおり動かす。Ctrl-C で終了）
./hidlog > hid_log.txt
#    先頭行 "# open result: 0x00000000" 以外（0xe00002e2 = 入力監視の許可なし）なら
#    システム設定 > プライバシーとセキュリティ > 入力監視 でターミナルを許可して再実行。

# 3. 集計
python3 analyze.py hid_log.txt
```

## 見るべき数値

- `P(no report at a connection event)`: 速い移動中の欠落率。修正後は 0.12 → 0.0x を期待。
- `CONSERVATION ... gap=2 events`: 30ms ギャップ後のレポートの移動量比。**1.0 なら移動量が消えている**、
  2.0 なら遅れて届いているだけ（カーソルは狙った場所に着く）。
- `TIMELINE`: 1 分ごとの欠落率。時間とともに悪化するか、うねりがあるかを見る。
- `WHEEL/PAN`: 左ボール（中央ローカル、スプリット経路なし）との比較用。
