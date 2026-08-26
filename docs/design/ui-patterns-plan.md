# QuickMail-ja UI比較計画

## Design Read

Reading this as: 日本語利用者向けセルフホストWebメールの製品UI。非技術者が毎日使える既視感と信頼性を優先し、同じ機能を3つの情報構造で比較する。3つのブランド模倣や、3つの本番テーマを作る計画ではない。

`design-taste-frontend`はダッシュボード・多段製品UIを対象外としているため、視覚原則、状態設計、レスポンシブ、アクセシビリティ、商標模倣防止だけを採用する。メール製品の構造はMaterial 3、Fluent 2、Thunderbirdの公式資料を参照する。

## Design dials

- `DESIGN_VARIANCE: 3`
- `MOTION_INTENSITY: 2`
- `VISUAL_DENSITY: 7`

低モーション、高密度を共通基準にする。各案の比較で変えるのは密度、ペイン、境界、角丸、操作位置であり、機能やデータ量ではない。

## 共通契約

- 開発専用UIラボに隔離し、本番ルートとbundleから除外する。
- 架空の日本語メールfixtureだけを使う。実メール、顧客固有値、バックアップ、実ドメインを使わない。
- 現行の`/inbox`、`/folders/:id`、`/mail/:id`、`/compose`の意味と戻る操作を維持する。
- QuickMail-jaのsageアクセント、ロゴ、Remixicon、日本語ラベルを共通にする。
- Gmail、Outlook、Thunderbirdの名称は設計資料だけに記載する。公開表示は`シンプル`、`3ペイン`、`高密度`とする。
- ライト、ダーク、システム、モバイル、キーボード、スクリーンリーダー、`prefers-reduced-motion`を全案で用意する。
- Loading、Empty、Error、Success、Offline、選択中、長い日本語件名、添付、HTML本文、作成を同じfixtureで表示する。

## Pattern A: `calm` / シンプル

参考: Gmailの会話重視パターンと[Material 3 canonical layouts](https://m3.material.io/foundations/layout/canonical-examples/overview)

- 左ナビ + メール一覧を基本にし、1280px以上だけ任意の本文ペインを出す。
- 検索を上部の主役にする。
- 行高52-60px、角丸16-24px、余白を広めにする。
- 件名、差出人、抜粋の順で初見理解を優先する。
- 画面幅が狭い場合は一覧と本文を別画面にする。
- Googleロゴ、Google Sans、Material Symbols、Gmail固有色は使わない。

向く利用者: 非技術者、Gmail経験者、メール量が中程度の小規模組織。

## Pattern B: `command` / 3ペイン

参考: Outlookの業務向け構造と[Fluent Nav](https://fluent2.microsoft.design/components/web/react/core/nav/usage)、[Fluent Toolbar](https://fluent2.microsoft.design/components/web/react/core/toolbar/usage)、[Fluent List](https://fluent2.microsoft.design/components/web/react/core/list/usage/)

- 1280px以上で左ナビ + 360-420pxの一覧 + 本文の3ペインを既定にする。
- 上部コマンドバーは1行に保ち、収まらない操作を`その他`へ移す。
- 削除などの破壊操作を通常操作から離す。
- 行の副操作はDOMに常駐させ、マウス以外でも到達できるようにする。
- 行高40-48px、角丸4-8px、細い境界で情報密度を上げる。
- Microsoftロゴ、Segoe UI固定、Outlook固有色は使わない。

向く利用者: 事務局、複数フォルダを頻繁に扱う組織、Outlook経験者。

## Pattern C: `classic` / 高密度

参考: Thunderbirdの[folder pane / thread pane / message pane](https://developer.thunderbird.net/thunderbird-development/codebase-overview/mail-front-end)

- フォルダツリー + スレッド一覧 + 本文を常時分割する。
- 一覧上部へクイックフィルターを常設する。
- 差出人、件名、日付、添付、状態を規則的な列で示す。
- 行高36-44px、角丸2-6px、影を減らして境界線を使う。
- `標準`と`コンパクト`の密度選択を将来拡張点として残す。
- Thunderbirdロゴ、アイコン、配色、XUL外観を使わない。

向く利用者: 大量メール、フォルダ運用、キーボード中心の熟練者。

## 実装構造

候補:

```text
src/lib/ui/tokens.css
src/lib/design-prototypes/fixtures.ts
src/lib/design-prototypes/calm/
src/lib/design-prototypes/command/
src/lib/design-prototypes/classic/
src/routes/dev/design-lab/
```

- `tokens.css`は色だけでなく、密度、角丸、ペイン幅、フォーカス、状態を意味トークン化する。
- 3案は同じfixture型と操作契約を利用するが、本番のメール機能をforkしない。
- `dev/design-lab`は本番ビルドで404にする。
- 現行の外部Google Fonts読み込みは、選定案の統合前にシステムフォントまたは自己ホストへ置き換える。

## Binary DoD

### UI-1 現行基準

- 1440x900、1024x768、390x844のライト・ダーク基準画像が6枚ある。
- ナビ、一覧、本文、作成、設定の操作契約が文書化されている。
- 実メールデータの使用が0件である。

### UI-2 比較プロトタイプ

- `calm`、`command`、`classic`が同じfixtureで表示される。
- 3案すべてに一覧、本文、作成、選択中、Loading、Empty、Error、Offlineがある。
- ベンダーロゴ、固有フォント、固有アイコン、商標画像が0件である。
- 本番メールルートから3案へのimportが0件である。

### UI-3 品質

- 1440px、1024px、390pxで水平スクロールが0件である。
- モバイルの操作対象は44px以上である。
- キーボードだけでナビ、一覧選択、本文表示、返信開始まで到達できる。
- axeのserious/critical違反が0件、本文・ボタン・フォームはWCAG AAを満たす。
- `prefers-reduced-motion`で不要な自動アニメーションが0件である。
- ライト・ダークの計18 visual snapshotがreview済みである。

### UI-4 選定

- 同じ5タスクで、初見理解、一覧走査、フォルダ移動、本文確認、返信開始を比較する。
- 最大5人の日本語利用者で所要時間、迷い、誤操作を記録する。
- 採用案と2案の不採用理由をADRへ残す。
- 本番へ入れるデザインシステム依存は1系統だけである。

### UI-5 本番統合

- 未選択案は本番bundleに0件である。
- 現行の日本語UI、フォルダ、転送、作成、モバイル契約が維持される。
- メール一覧の通信失敗を画面内表示し、失敗後も選択状態を保持する。
- 外部Google Fontsへのリクエストが0件である。
- 既存254テストを欠落させず、新規UI契約テストも全て通る。
