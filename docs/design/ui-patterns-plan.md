# Noroshi UI比較計画

## Design Read

Reading this as: 日本語利用者向けセルフホストWebメールの製品UI。非技術者が毎日使える既視感と信頼性を優先し、同じ機能を3つの情報構造で比較する。3つのブランド模倣や、3つの本番テーマを作る計画ではない。

`design-taste-frontend`はダッシュボード・多段製品UIを対象外としているため、視覚原則、状態設計、レスポンシブ、アクセシビリティ、商標模倣防止だけを採用する。メール製品の構造はMaterial 3、Fluent 2、Thunderbird/Boltの公式資料を参照するが、いずれのコンポーネント実装、Figma export、ブランドassetも取り込まない。

## Design dials

- `DESIGN_VARIANCE: 3`
- `MOTION_INTENSITY: 2`
- `VISUAL_DENSITY: 7`

低モーション、高密度を共通基準にする。各案の比較で変えるのは密度、ペイン、境界、角丸、操作位置であり、機能やデータ量ではない。

## 共通契約

- 開発専用UIラボに隔離し、本番ルートとbundleから除外する。
- 架空の日本語メールfixtureだけを使う。実メール、顧客固有値、バックアップ、実ドメインを使わない。
- 現行の`/inbox`、`/folders/:id`、`/mail/:id`、`/compose`の意味と戻る操作を維持する。
- semantic token名、Remixicon、日本語ラベル、状態の意味は共通にする。色、font fallback、角丸、密度はprofileが所有し、参照先を判別できる近似にする。
- 公開表示は`Gmail風`、`Outlook風`、`Thunderbird風`とし、非公式・非提携の比較であることを明示する。製品ロゴ、固有フォント、スクリーンショット、コピーしたassetは使わない。
- `docs/design/patterns/`の正本は共通visual themeのprimitive/semantic tokenと3つのUI profile deltaに分ける。公式sourceの役割とNoroshiのlocal valueを同じ値として扱わない。
- UI profileのruntime registryは固定ID、公開ラベル、renderer、任意の短い評価説明だけを持つ。pane幅、row高、breakpoint、collapse規則、paletteはDESIGN.mdとCSSに置き、data-driven runtime schemaへ膨らませない。focus semanticsとicon languageは共通にする。
- 新しい比較案はprofile entry、delta文書、renderer、契約testの追加で完結させる。dynamic plugin、外部profile、remote theme、任意inheritance、productionの利用者別切替は作らない。
- 比較段階では全案にライト、ダーク、モバイル、キーボード、スクリーンリーダー、`prefers-reduced-motion`の代表経路を用意する。全状態の完成責任は選定案の本番統合へ移す。
- 一覧、選択中の本文、作成を同じfixtureで比較する。Loading、Empty、Error、Success、Offline、長い日本語件名、添付、HTML本文は代表ケースで構造を壊さないことを確認する。

## Pattern A: `calm` / Gmail風

参考: Gmailの会話重視パターンと[Material 3 canonical layouts](https://m3.material.io/foundations/layout/canonical-examples/overview)

- 1440pxと1024pxはナビ + メール一覧を基本にし、選択時は一覧を本文へ置き換える。390pxはナビを畳んだ単一画面にする。
- 検索を上部の主役にする。
- 行高52-60px、角丸16-24px、余白を広めにする。
- 件名、差出人、抜粋の順で初見理解を優先する。
- 画面幅が狭い場合は一覧と本文を別画面にする。
- Googleロゴ、Google Sans、Material Symbols、Gmail固有色は使わない。

向く利用者: 非技術者、Gmail経験者、メール量が中程度の小規模組織。

## Pattern B: `command` / Outlook風

参考: Outlookの業務向け構造と[Fluent Nav](https://fluent2.microsoft.design/components/web/react/core/nav/usage)、[Fluent Toolbar](https://fluent2.microsoft.design/components/web/react/core/toolbar/usage)、[Fluent List](https://fluent2.microsoft.design/components/web/react/core/list/usage/)

- 1280px以上で左ナビ + 360-420pxの一覧 + 本文の3ペインを既定にする。
- 1024pxではフォルダを折り畳みナビへ縮退し、一覧 + 本文の2ペインにする。390pxでは単一画面にする。
- 上部コマンドバーは1行に保ち、収まらない操作を`その他`へ移す。
- 削除などの破壊操作を通常操作から離す。
- 行の副操作はDOMに常駐させ、マウス以外でも到達できるようにする。
- 行高40-48px、角丸4-8px、細い境界で情報密度を上げる。
- Microsoftロゴ、Segoe UI固定、Outlook固有色は使わない。

向く利用者: 事務局、複数フォルダを頻繁に扱う組織、Outlook経験者。

## Pattern C: `classic` / Thunderbird風

参考: Thunderbirdの[folder pane / thread pane / message pane](https://developer.thunderbird.net/thunderbird-development/codebase-overview/mail-front-end)

- 1440pxと1024pxはフォルダツリー + スレッド一覧 + 本文を分割する。1024pxでは添付・状態などの任意列を減らし、390pxは単一画面にする。
- 一覧上部へクイックフィルターを常設する。
- 差出人、件名、日付、添付、状態を規則的な列で示す。
- 行高36-44px、角丸2-6px、影を減らして境界線を使う。
- `標準`と`コンパクト`の密度選択を将来拡張点として残す。
- Thunderbirdロゴ、製品固有アイコン、XUL assetを使わない。配色と密度はBoltとdesktop UIに近いlocal tokenで表現する。

向く利用者: 大量メール、フォルダ運用、キーボード中心の熟練者。

## 公式ソースの扱い

- Fluent 2: [Design tokens](https://fluent2.microsoft.design/design-tokens)のglobal/alias二層と、Nav/Toolbar/Listの役割を参照する。Fluent UI ReactはSvelte実装へ追加しない。公式Figma kitは閲覧参考だけにする。
- Material 3: [Canonical layouts](https://m3.material.io/foundations/layout/canonical-examples/overview)のlist-detail適応と検索・FABの役割を参照する。Material Webはmaintenance modeのため導入しない。
- Thunderbird: [Mail front-end](https://developer.thunderbird.net/thunderbird-development/codebase-overview/mail-front-end)のfolder/thread/message paneを参照する。[Bolt](https://github.com/thunderbird/bolt-design-system)はtoken/release方針が未確立のため、完成済みtoken sourceとして扱わない。
- ライセンスがOSSでも商標、フォント、アイコン、Figma assetの再配布許可を意味しない。Google Sans、Segoe UIファイル、Material Symbols、各社ロゴ、製品固有アイコン、スクリーンショットは使わない。

## 実装構造

候補:

```text
docs/design/patterns/sources.md
docs/design/patterns/base.DESIGN.md
docs/design/patterns/calm.DESIGN.md
docs/design/patterns/command.DESIGN.md
docs/design/patterns/classic.DESIGN.md
prototype/quickmail-ja-live-demo/index.html
prototype/quickmail-ja-live-demo/test.mjs
```

- 3つのprofile `DESIGN.md`は独立した色表ではなく、`base.DESIGN.md`のvisual themeに対するlayout deltaを記録する。
- QMJ-12は既存の静的comparison prototypeだけを改善する。選定案のSvelte実装はQMJ-14だけで行い、二重のデザインラボを作らない。
- 公開比較previewと選定後の本番UIは外部Google Fontsを読み込まない。system fontを既定とし、フォントファイルを配布しない。

## Binary DoD

### UI-1 現行基準

- 1440x900、1024x768、390x844のライト・ダーク基準画像が6枚ある。
- ナビ、一覧、本文、作成、設定の操作契約が文書化されている。
- 実メールデータの使用が0件である。

### UI-2 比較プロトタイプ

- `calm`、`command`、`classic`が同じfixtureで表示される。
- 3案すべてに一覧、選択中の本文、作成がある。Loading、Empty、Error、Offlineは比較に必要な代表ケースを同じfixture contractで確認する。
- ベンダーロゴ、固有フォント、固有アイコン、商標画像が0件である。
- 公開previewのベンダー名ラベル、外部font request、新規runtime design-system依存が0件である。
- 本番メールルートから3案へのimportが0件である。

### UI-3 品質

- 1440px、1024px、390pxで水平スクロールが0件である。
- モバイルの操作対象は44px以上である。
- キーボードだけでナビ、一覧選択、本文表示、返信開始まで到達できる。
- axeのserious/critical違反が0件、本文・ボタン・フォームはWCAG AAを満たす。
- `prefers-reduced-motion`で不要な自動アニメーションが0件である。
- 3案 × 3幅 × ライト・ダークの計18 default-state visual snapshotがreview済みである。異常系はDOM/geometry契約と代表snapshotで確認する。

### UI-4 選定

- 同じ7タスクで、初見理解、一覧走査、検索、フォルダ移動、本文確認、返信開始、作成から下書き復帰を比較する。
- 最大5人の日本語利用者で所要時間、迷い、誤操作を記録する。
- 採用案と2案の不採用理由をADRへ残す。
- 本番へ入れるデザインシステム依存は1系統だけである。

### UI-5 本番統合

- 未選択案は本番bundleに0件である。
- 現行の日本語UI、フォルダ、転送、作成、モバイル契約が維持される。
- メール一覧の通信失敗を画面内表示し、失敗後も選択状態を保持する。
- 外部Google Fontsへのリクエストが0件である。
- 実装開始前の全テスト一覧を欠落させず、新規UI契約テストも全て通る。
