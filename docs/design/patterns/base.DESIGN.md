# QuickMail-ja 共通semantic theme contract

- 検証日: 2026-08-27
- 適用先: `calm`、`command`、`classic`の比較デモ全体
- 責務: semantic token名、focus、icon、状態、light / dark契約

3profileは同じ機能を異なるメールUIの見た目で比較する。profileを変えるとpalette、font fallback、radius、densityが変わる。focus、icon、状態の意味とfixtureは変えない。

## Local token

全profileは同じ用途名を使い、値だけをprofileのCSS selectorで上書きする。

```css
--bg; --surface; --surface-2; --surface-3;
--text; --sub; --muted; --line;
--accent; --accent-2; --on-accent;
--compose-bg; --on-compose; --focus-ring;
--banner-bg; --banner-text; --banner-line;
--brand-mark-bg; --brand-mark-text;
--danger; --warn; --warn-bg; --good; --star;
--shadow; --font-ui; --layout-radius; --row-height;
```

各profileの具体値は`calm.DESIGN.md`、`command.DESIGN.md`、`classic.DESIGN.md`が所有する。rendererにhex値を埋め込まない。未読、選択、警告、失敗、成功を色だけで伝えず、太さ、icon、ラベルを併用する。

## Typography

```css
font-family: var(--font-ui);
font-size: 14px;
line-height: 1.5;
```

- 外部Web fontを読み込まない。Google SansやSegoe UIなどのフォントファイルを同梱・配布しない。
- 日本語本文は14px以上、補助情報は12px以上を基準とする。
- 未読はfont weightと明示ラベルで区別する。全大文字による強調を日本語UIへ使わない。
- 件名、差出人、抜粋の省略時も、選択後の本文で完全な値を確認できるようにする。

## Spacing primitive

共通単位は4pxとする。利用できる値は `4 / 8 / 12 / 16 / 24 / 32px`。どの値をどこに使うか、行高、pane幅、角丸、境界の強さは各profile deltaが決める。

## Focusと操作状態

- keyboard focusは `2px solid var(--qm-focus)` と2px以上のoffsetで常時見える。
- `:focus-visible`を使い、hoverだけに操作を隠さない。
- 選択状態とfocus状態は別々に認識できる。
- disabledは見た目だけでなくnative `disabled` または同等のsemanticsを持つ。
- `prefers-reduced-motion: reduce`では装飾的なtransitionとanimationを無効にする。
- モバイルの操作対象は44px以上にする。desktopの高密度行でも、行内の主要操作はkeyboardから到達できる。

## Icon

- repositoryで固定したRemixiconを共通icon languageとして使う。必要な操作には日本語のaccessible nameを付ける。
- iconだけで意味が曖昧な主要操作はtext labelを併用する。
- ベンダーロゴ、製品固有icon、Material Symbols、スクリーンショットを使わない。
- icon fontやassetを外部originから取得しない。

## State contract

### QMJ-12: 3profile共通のcore state

3profileは同じ架空fixtureで、比較に必要な日常操作だけを共通表示する。

- default / unread / starred
- inbox
- selected message
- compose / draft復帰

profile切替時は、選択中mailbox、選択中message、検索語、下書き、logical focus anchorを維持する。送信などの外部実行は比較デモでは行わない。

QMJ-12の異常系とaccessibilityは、同じfixture contractを使う代表経路だけを対象にする。検証面は `inbox / selected message / compose / error` の48-run axe contractとする。3profileすべてに全状態の完成matrixを要求しない。

### QMJ-14: 選定profileの完成責任

採用profileを本番へ統合する段階で、loading、empty、error、success、offline、長い日本語件名、添付、HTML本文を含む完全な状態matrixを検証する。未選択profileへこの責任を遡及させない。

## Runtime境界

registryは `id`、`publicLabel`、`render`、任意の短い `evaluatorDescription` だけを持つ。profile token objectやlayout schemaは作らない。paletteはCSS custom propertyとしてprofile selectorに置く。新profileの追加単位は、registry entry、profile delta文書、CSS token、renderer、契約testである。

dynamic plugin、remote theme、任意inheritance、productionの利用者別切替は対象外とする。
