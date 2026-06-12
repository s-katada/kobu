# kobu RMKファームウェア デバッグ全記録(2026-06-10 〜 06-12)

3日間にわたるRMKファームウェアのデバッグ・修正の全記録。**失敗も含めて実際にやった順番どおり**に記す。
各項目にコミットハッシュを併記(`git show <hash>` で詳細が追える)。

## TL;DR — 最終的に直ったもの

| 問題 | 真の原因 | 最終修正 |
|---|---|---|
| 右トラボの追従遅延(のろのろ) | **splitリンク7.5msとMacリンク15msの2:1電波調波ロック**(共有ラジオ上で位相が固定衝突) | split間隔を8.75msへ(調波外し) `a9ccb0d` |
| 左ボール無反応→右で復活 | macOSのconn interval省電力緩和+回復トリガが右ボール限定 | スクロール側にも再アサート `c1c4212` ほか |
| `;`/`:`の挙動が無茶苦茶 | **MacのKarabiner-Elements「Exchange semicolon and colon」が全キーボード適用**(ファームの出力が常時反転されて見えていた) | kobuをルールから除外+ファーム本体でネイティブ反転 `781e163`〜`7a70299` |
| tap&holdの誤爆・遅延 | rmk-macroのバグ(`= false`が無視される)他、多層 | Option B(balanced+press-edge+バッファリング) `5c772bf`〜`cd70a2a` |
| 高速タイプ後のCmd+Enterが壊れる | Flow TapがCmdサムをBackspace化+リリース時タップ確定 | 純LGui化+Flow Tap廃止+Enter press-edge `52a52d3` `2ce615d` |

---

## Phase 1: トラックボール遅延の根本調査(6/10 日中)

### 症状
1. **S1**: ポインタ(右トラボ)が最初は快適、使っていると「のろのろ」になる
2. **S2**: 左ボールを転がしても無反応。右トラボを動かすと左が復活する謎挙動

### 調査(マルチエージェント workflow、19体)
- 5方向の並列コード調査 → 統合 → 仮説ごとに2レンズ(機構/症状適合)の反証検証
- **確定した事実**:
  - macOSはアイドル時にBLE conn intervalを15ms→30〜50msへ緩める
  - それを戻す唯一のトリガ `KOBU_HOST_CONN_DRIFT` は **PointerProcessor(右ボール)にしか配線されていない**(trackball.rs:798-806)。左ボール・キー入力には無い → S2の「右で復活」と完全一致
  - **重大な地雷**: その再アサートループ自体が**コミットされていないレジストリ内手パッチ**(`r25`)で、`cargo clean -p rmk` で消える状態だった
  - trouBLE 0.5.1はPPCP(0x2A04)未実装(gap.rsでコメントアウト)→ ZMKと違いmacOSに「希望パラメータ」を宣言できていない
  - splitリンクは7.5ms固定・無実(この時点での結論。**半分正しく半分間違いだった** — 後述)
  - スクロールのステップ数学(30カウント/ティック、反転ヒステリシス59カウント、縦軸完全破棄)が左の決定論的無反応に寄与

### 教訓(この時点)
- ワークフロー調査エージェントは読み取り専用(`Explore`)で走らせ、終了後に`git status`とレジストリmtimeを監査する運用が正解だった

---

## Phase 2: 修正シリーズ step0〜step10(6/10夜〜6/11)

「症状別にFWを焼いて1つずつ試す」方式。各stepは累積。

### 成功した土台(6/10夜)
- **step0** `e734c83`: r25手パッチをbuild.rsへ正規移植(ビルド再現性の確保。これをやらないと以後のビルド全てが再アサート無しに退行していた)
- **step1** `c1c4212`: スクロール側(左ボール)にも同じ再アサートを実装 → **S2の構造的解消**
- **step2** `e537601`: trouble-hostへのbuild.rsパッチでPPCP(0x2A04)を公開(ZMKパリティ)。⚠️ macOSのGATTキャッシュにより**再ペアリングしないと見えない** — ユーザーが再ペア前にテストして一度「効かない」と誤判定する一幕あり
- **step3** `3a5a6c5`: スクロール感修正(アイドル減衰300ms・方向反転リセット・**縦軸を縦スクロールへ統合**)

### HWテストで判明した別問題(6/11)
- **Space変換ミス**(タップのつもりがholdになりSpaceが出ない)→ 対話で250msを選択 `046cdac` → **解消**(ただしこの値変更はフラッシュ保存のためclearlayout儀式が必要、という運用も確立)

### のろのろ撲滅の試行錯誤 — **6連敗の記録**(6/11)
診断LED(led-conn-diag)が「リンクは紫=15msで健康」を示し、リンク仮説が崩壊。以降:

1. ❌ **step5a**(実験UF2): ポインタemitゲート `==0`→`<=1`(報告レート66→125Hz化)→ **変化なし**
2. ❌ **step5b**(実験UF2): central通知キュー16→2(鮮度優先)→ **変化なし**
3. 🔶 **step5c** `93dd73f`: splitリンクCE長 0→4ms → ポインタは**変化なし**。ただし**左スクロール問題はここで完治**(副産物)
4. ❌ **step6** `0e0a8df`→revert `b9a1438`: ペリフェラル側イベント合体(coalescing)→ **悪化**(カクカク化)。「滞留の証明」と解釈したが、これは**誤った推論**だった(後の診断LEDは緑=滞留なし)。素直にrevert
5. ❓ **step7** `e186893`: split CE最低予約2ms → 「違いが分からない」
6. ❌ **step8** `40038f3`: SDCコントローラのL2CAPキュー3→8+メモリ増(rmk-macroへのパッチ)→ **変化なし**。診断LEDは緑(ペリフェラル無罪確定)
7. ❌ **step9** `9255f3a`: emitゲート公平化(scroll/pointer同条件)→ **変化なし**

### 決定打はユーザーの切り分け(6/11深夜)
- 発生条件の特定:「**スクロールとポインタを同時/交互に使うと発生**」
- **USB接続+MacのBluetooth完全OFF → ヌルヌル**(=ラジオ上にsplitリンクだけなら問題なし)
- → **共有ラジオ上の電波干渉**と確定。splitの7.5msはMacリンク15msの**ちょうど1/2(調波)**で、位相が悪いと同じsplitイベントが恒常的に潰される(クロックドリフトは分オーダーでしか回らない=「少し置くと治る」はmacOSの再アンカー)
- ✅ **step10** `a9ccb0d`: split間隔7.5→8.75ms(LCM=105ms、衝突が1/12に分散し自己回復)→ **解消!**

### 反省
- 5a〜9の6連敗は「コードを読んで仮説→盲撃ち」の限界。**ゼロコストの物理切り分け(BT-OFFテスト)を最初にやるべきだった**
- CI修正 `a90397c`: build.rsが3クレート(rmk/trouble-host/rmk-macro)をパッチするようになったのに`cargo clean`が rmk だけだった → CIビルドがPPCP/SDC修正を**無言で欠落**させる地雷を塞いだ

---

## Phase 3: tap&hold/セミコロンの泥沼(6/12 深夜〜昼)

### 失敗1: KobitoKeyフレーバー移植 `3e5a862` → revert `b45b1cb`
- KobitoKeyのkeymap実物を読み、lt=tap-preferred / mt=hold-preferred / ホームロウ=balanced の混在を1:1移植
- → **3つ壊れた**: 「git s」→「gits」、言語切替悪化、L+`;`コンボ死亡
- → 全revert。だがこの失敗が次の大発見の入口になった

### 大発見×3 `7576fe7`
1. **rmk-macroのバグ**: プロファイルの`hold_on_other_press = false`は**mode=Noneにコンパイルされ「デフォルト継承」になる**(=R27以来、tap-preferred設定は一度も効いておらず、全キーが実はhold_on_other_pressだった。「git s→git@」「holdが早すぎる」の万年原因)
2. **RMKのコンボはKeyAction完全一致**でマッチ(キーコードではない)→ `"Semicolon"`では`MT(Semicolon,...)`キーに永遠に当たらない=**L+`;`コンボは移植初日から死んでいた**
3. Flow Tap(ストリーム中のmorseキー=即タップ)導入で上記を整合 → 3問題とも解消をユーザー確認

### 失敗2〜4: Shift+`;`即応化の3連敗
- ❌ part1 `a2fb649`: 言語サムをFlow Tap除外 → ダメ
- ❌ part2 `8e7c846`: held側の巻き込み除外 → ダメ
- ❌ **choke-point** `4303eed` → revert `5e489d2`: morseタップ全部をforkテーブル経由に → **大退行**(Shift無しでも`;`が出る)
- ❌ fork-free設計 `b2a86ce`: fork廃止+TD化+layer2に`;` → 「治ってない」

### 真の黒幕の発見(6/12朝、ultracode workflow 18体)
4実験マトリクス(タップ/遅チョード/速チョード×離し順)をコードで再現できない矛盾から、エージェントがホスト側を捜索:

> **MacのKarabiner-Elementsに「Exchange semicolon and colon」ルールが有効(デバイス指定なし=kobuにも適用)。画面の`;`/`:`は常にデバイス出力の反転だった。**

- 全時代の不可解な観測(choke後の常時`;`、fork-freeの両逆転)が「正しい出力のKarabiner反転」として完全に再現
- ホストレイアウトはANSI(com.apple.keyboardtypeで確認)。JIS仮説は棄却
- ✅ `781e163`: ファームは素のUS出力に戻し、Karabinerに反転させる(当時の方針)+**おまけの大発見**: 純正`clear_layout`は**combo/fork/morseのVial保存領域を消していなかった**(boot時にfill_vecパディング後、保存スロットで上書きされる)→ clearlayoutを完全リシンク化するパッチ追加
- → ユーザー確認「サーガ完結」

### 教訓
- **キー出力が不可解なときは、ファームを疑う前に`karabiner.json`を確認する**(本リポジトリ最大の教訓)
- 実験マトリクス(ユーザーの実機観測)をコードで再現できない場合、その矛盾自体が「見えていないレイヤー」の存在証明

---

## Phase 4: ネイティブ反転・かな切替・Cmd+Enter(6/12 午前〜夕方)

### 要望: 反転をキーボード本体へ+Karabinerはkobu除外
- karabiner.jsonの該当ルールに`device_unless`(VID 19279/PID 16985+product名"kobu")を追加(バックアップ: `karabiner.json.bak-20260612`)
- `9fc8d17`: ネイティブ反転v2(タップ→WM変換+チョードはShiftマスク)+かな用Ctrl+英数コンボ

### 失敗5〜6: press-edgeが効かない2連敗 → 機構の発見
- ❌ v2: 「全部ダメ」→ EventViewerでデバイスID一致を確認(除外設定は正しい)
- ❌ v3 `f47580f`: **`;`キーはL+`;`コンボのメンバーなので押下が`WaitingCombo`でパークされ、None-armのpress-edge処理が一度も実行されていなかった**ことを発見し、バッファmatch前にhoist → それでもダメ
- ユーザーの神観測:「**電源を入れ直した直後(Karabinerが掴む前)は`;`が打てる**」=デバイス出力は正しい
- EventViewer実データで確定: **「shift解除とsemicolon押下を同一HIDレポートに同居」させるマスク方式は、ホスト側でkeydownが先に処理されて無効化される**(動いたり動かなかったりは順序の運)
- ✅ **v5** `7a70299`: マスクを**独立レポートとして先に送出** → **`;`解消!**
- 途中のv4 `109e3b5`(かな救済: flow-tapされたSpace保持中に言語サム→Backspaceで取消+Language1直接送出)は機能したが、Ctrl+英数コンボがサムを50msパークし「Backspaceが次のキーで出る」奇妙な見え方に → コンボ撤去

### Option B: tap&holdの最終形(ユーザー選択)
スペースの「一瞬出て消える」ちらつき(v4救済)がイマイチ → 3案提示しB(KobitoKey方式)を選択:
- `5c772bf`: LT専用プロファイル(tap-preferred)+LTのFlow Tap除外+**RMKに無かった「未確定中の後続キーを順序保証でバッファ」をパッチ追加**(ZMKは持っている。parity時代の「gits」の真の機構)
- ❌ ただし素のtap-preferredは**かな切替が200ms待ちで「鬼遅い」**
- `404ecb3`: balanced(permissive_hold)化 → 「かなりいい、あとほんの少し」
- ✅ **v6** `cd70a2a`: press-edge×2(言語サム押下でレイヤー即確定+ストリーム中のLanguage1は押下エッジで即送出)→ **「完璧!」**

### Cmd+Enter問題(6/12夕方)
- 症状: 高速タイプ→Cmd+Enterが「Backspace+Enter」になる
- 原因①: **Flow TapがCmdサム(MT(Backspace,LGui))を即Backspaceタップ化**
- ✅ `52a52d3`: Cmdサムを**純LGuiに変更**(ユーザー指示。タップBSは未使用)+**Flow Tap全廃**(全用途が別機構で代替済みになっていた)
- 原因②: 純Cmd化でKarabinerの「Cmd単体押し→かな」ルールがkobuで発火 → 言語系2ルールにもkobu除外を追加(フラッシュ不要、即時有効)
- 原因③: 「Cmdを先に離すと素のEnter」= balancedのEnterはリリース時にタップ確定するため
- ✅ **v7** `2ce615d`: **Enterチョードのpress-edge化**(修飾キー保持中のEnter押下=その瞬間に確定。Spaceは対象外=Cmd+Space誤爆/Cmd+レイヤー数字を保護)→ **「全部OK!」**

---

## 失敗から得た技術的教訓(再発防止メモ)

1. **ホストを先に疑え**: キー出力の怪奇現象は `~/.config/karabiner/karabiner.json` を最初に確認。Karabinerルールはデバイス無指定だと自作キーボードにも適用される
2. **rmk-macro 0.7.1**: morseプロファイルのモードフラグに`= false`を書いても**無視されてデフォルト継承**になる。有効にしたいモードだけ`= true`で書く
3. **RMKのコンボはKeyAction完全一致**: morseキー(MT/TD)をコンボに入れるならコンボ定義にフルアクション文字列を書く。またコンボメンバーのmorseキーは押下が`WaitingCombo`でパークされ、**押下時(None-arm)の特殊処理が走らない**
4. **HIDのmod-morph式マスク**: 修飾解除とキー押下を同一レポートに入れてはいけない(ホストの処理順が未定義)。**修飾だけの独立レポートを先に送る**
5. **RMKのnormal/balancedモードは後続キーをバッファしない**(ZMKはする)→ 順序逆転(「gits」)。`patch_rmk_normal_mode_buffering`で追加済み
6. **純正clear_layoutはcombo/fork/morseのVial保存を消さない** → `patch_rmk_clearlayout_resync_vial_tables`で完全リシンク化済み
7. **ビルド運用**: build.rsはrmk/trouble-host/rmk-macroの3クレートをレジストリ内パッチする。新パッチ追加時は対応する`cargo clean --release -p <crate>`が必須(CIは対応済み)
8. **フラッシュ運用**: keymap/morse/combo変更=clearlayout→通常の儀式(BLEボンドは保持される。ボンドごと消すのはclear_storage)。コード(レジストリパッチ)のみの変更=普通の上書きでOK
9. **盲撃ちの前に物理切り分け**: 「USB+BT-OFF」「電源直後のKarabiner未把握ウィンドウ」「Karabiner-EventViewer」のようなゼロコスト観測が、6連敗ぶんの試行錯誤より速い

## 最終構成(2026-06-12時点の挙動マップ)

| 操作 | 確定タイミング |
|---|---|
| 変換のSpaceタップ | リリース時(KobitoKey同等) |
| かな切替(Space+英数) | 英数サムに**触れた瞬間**(press-edge×2) |
| 数字レイヤー(Space+キー) | 相手キーのリリース時(balanced) |
| Cmd+Enter / Shift+Enter | Enter**押下の瞬間**(離し順不問) |
| Shift+`;` → `;` / タップ → `:` | 押下エッジ+独立レポートマスク(本体実装、ホスト非依存) |
| Cmdサム | 純LGui(tap無し) |
| Flow Tap | 廃止 |
| Karabiner | `;`/`:`交換・Ctrl単体・Cmd単体の3ルールからkobuを除外(他デバイスは従来どおり) |

主要な独自パッチ(build.rs内、すべてマーカー冪等): r25再アサート / PPCP / split CE長+予約 / split間隔8.75ms / SDCキュー8 / shift-chord press-edge(v3+v5) / かな救済(休眠) / kana press-edge / enter press-edge / normal-modeバッファリング / flow-tap除外群 / clearlayout完全リシンク
