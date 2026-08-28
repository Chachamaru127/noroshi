# UI比較パターンの出典と採用境界

- 検証日: 2026-08-27
- 対象: QuickMail-ja の開発用比較デモ
- 正本: 共通の見た目は `base.DESIGN.md`、構造差は各 profile の `*.DESIGN.md`

## 参照する公式ソース

| 公式ソース | 参照する役割・原則 | QuickMail-jaへ取り込まないもの |
|---|---|---|
| [Fluent 2 Design tokens](https://fluent2.microsoft.design/design-tokens) | global / alias token、light/dark theme、青系accentの役割 | proprietary font、製品asset、実装package |
| [Fluent Nav](https://fluent2.microsoft.design/components/web/react/core/nav/usage) | 業務用ナビゲーションの階層と選択状態 | React component、Microsoft固有の外観 |
| [Fluent Toolbar](https://fluent2.microsoft.design/components/web/react/core/toolbar/usage) | 頻出操作とoverflow操作の分離 | ribbonの複製、製品固有icon |
| [Fluent List](https://fluent2.microsoft.design/components/web/react/core/list/usage/) | 高密度リストの情報階層 | component code、token値 |
| [Material 3 canonical layouts](https://m3.material.io/foundations/layout/canonical-examples/overview) | canonical layoutとlist-detailの幅別適応 | Material Web、Google固有の色・形・asset |
| [Thunderbird Mail front-end](https://developer.thunderbird.net/thunderbird-development/codebase-overview/mail-front-end) | folder / thread / messageの3ペイン構造、desktop密度 | Thunderbirdロゴ、製品固有icon、XUL asset |
| [Thunderbird Bolt Design System](https://github.com/thunderbird/bolt-design-system) | 公式design systemが発展途上であることの確認、語彙の参考 | 未確立tokenをQuickMail-jaの正本として採用すること |

公式ソースから借りるのは、情報構造とcomponentの役割だけである。値、asset、実装はQuickMail-jaが所有する。

## QuickMail-jaが所有する値

| 領域 | 正本 | 所有する内容 |
|---|---|---|
| 共通visual theme | `base.DESIGN.md` | sage系semantic color、system font、focus、icon方針、light / dark |
| Gmail風profile | `calm.DESIGN.md` | list-detail構成、余白、行高、角丸、幅別collapse |
| Outlook風profile | `command.DESIGN.md` | nav / list / reading pane、command配置、幅別collapse |
| Thunderbird風profile | `classic.DESIGN.md` | folder tree / thread table / message pane、列、密度、幅別collapse |
| fixtureと挙動 | prototype実装と契約test | 日本語の架空データ、選択維持、キーボード操作、状態表示 |

profileは共通semantic contractへの文書上の差分であり、runtime inheritanceではない。palette、font fallback、radius、densityはprofileごとにCSS custom propertyで定義する。focus semantics、icon、状態名は共通にする。

## 最小runtime contract

比較デモのregistryが持てるのは次だけとする。

```ts
type UIProfile = {
  id: "calm" | "command" | "classic";
  publicLabel: "Gmail風" | "Outlook風" | "Thunderbird風";
  render: (state: DemoState) => string;
  evaluatorDescription?: string;
};
```

`evaluatorDescription`はローカル評価用の短い説明であり、公開ラベルとは分離する。

pane幅、row高、breakpoint、density、collapse規則、角丸、操作配置はregistry dataにしない。各DESIGN文書、renderer / CSS、契約testで固定する。

## 明示的な非目標

- dynamic plugin、第三者profile、remote themeを読み込まない。
- profileの任意inheritanceや設定DSLを作らない。
- productionで利用者ごとにprofileを切り替える機能を作らない。
- Fluent UI、Material Web、Boltなどのruntime dependencyを追加しない。
- ベンダーのロゴ、固有icon、スクリーンショット、Figma assetを配布しない。製品名は非公式比較を示す`風`付きのテキストラベルに限定する。
- Google SansやSegoe UIなどのフォントファイルを同梱・外部読込しない。
- 比較デモの3profileを本番mail bundleへimportしない。

## ライセンス・商標の扱い

OSSライセンスは、商標、製品外観、フォント、Figma assetの再配布許可ではない。公開表示の`Gmail風`、`Outlook風`、`Thunderbird風`は非公式比較を示すテキストだけに使い、ロゴや提携表現へ拡張しない。
