# QuickMail-ja 共通visual theme

- 検証日: 2026-08-27
- 適用先: `calm`、`command`、`classic`の比較デモ全体
- 責務: 色、書体、focus、icon、light / dark

3profileは同じ製品の構造比較である。profileを変えてもQuickMail-jaの色、文字、focus、icon、状態の意味は変えない。

## Local token

以下は公式design systemからコピーした値ではなく、QuickMail-jaが所有する値である。

### Light

```css
:root {
  --qm-bg: #f7f8f7;
  --qm-surface: #ffffff;
  --qm-surface-subtle: #f2f4f3;
  --qm-surface-selected: #e8eeea;
  --qm-text: #262b28;
  --qm-text-subtle: #68716c;
  --qm-text-muted: #626b66;
  --qm-border: #dfe4e1;
  --qm-accent: #527461;
  --qm-accent-soft: #dce8e1;
  --qm-on-accent: #ffffff;
  --qm-danger: #a63f3f;
  --qm-warning: #715015;
  --qm-warning-surface: #fff5d7;
  --qm-success: #3f714f;
  --qm-focus: #315e49;
}
```

### Dark

```css
[data-theme="dark"] {
  --qm-bg: #121513;
  --qm-surface: #1b201d;
  --qm-surface-subtle: #242a27;
  --qm-surface-selected: #2b3931;
  --qm-text: #edf2ef;
  --qm-text-subtle: #b2bcb6;
  --qm-text-muted: #96a29b;
  --qm-border: #3a443e;
  --qm-accent: #88ad99;
  --qm-accent-soft: #293b31;
  --qm-on-accent: #0f1813;
  --qm-danger: #f19a9a;
  --qm-warning: #e2bd73;
  --qm-warning-surface: #352d19;
  --qm-success: #93c7a5;
  --qm-focus: #add8bf;
}
```

Tokenは用途名で参照する。profile rendererにhex値を埋め込まない。未読、選択、警告、失敗、成功を色だけで伝えず、太さ、icon、ラベルを併用する。

## Typography

```css
font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
font-size: 14px;
line-height: 1.5;
```

- 外部Web fontを読み込まない。フォントファイルを配布しない。
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

3profileは同じfixtureと状態を表示する。

- default / selected / unread / starred
- loading / empty / error / offline / success
- 長い日本語件名 / 添付 / HTML本文
- compose / draft復帰

profile切替時は、選択中mailbox、選択中message、検索語、下書き、logical focus anchorを維持する。送信などの外部実行は比較デモでは行わない。

## Runtime境界

registryは `id`、`publicLabel`、`render`、任意の短い `evaluatorDescription` だけを持つ。profile token objectやlayout schemaは作らない。新profileの追加単位は、registry entry、profile delta文書、renderer、契約testである。

dynamic plugin、remote theme、任意inheritance、productionの利用者別切替は対象外とする。
