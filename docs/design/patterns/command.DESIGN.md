# `command` UI profile delta

- 公開ラベル: `Outlook風`
- 検証日: 2026-08-27
- 共通semantic contract: `base.DESIGN.md`
- 公式原則の参照: [Fluent Nav](https://fluent2.microsoft.design/components/web/react/core/nav/usage)、[Fluent Toolbar](https://fluent2.microsoft.design/components/web/react/core/toolbar/usage)、[Fluent List](https://fluent2.microsoft.design/components/web/react/core/list/usage/)

Fluent 2の業務ナビゲーション、command階層、global/alias token、light/dark themeを参照する。React component、Microsoft asset、配布フォントは取り込まず、local CSS tokenで再実装する。

## Runtime entry

```js
{ id: "command", publicLabel: "Outlook風", render: renderCommand }
```

任意の `evaluatorDescription` を除き、これ以上のlayout dataをregistryへ追加しない。

## Layout delta

| viewport | 構造 | local rule |
|---|---|---|
| 1280px以上 | nav + message list + reading pane | nav 240px、list `clamp(340px, 30vw, 420px)`、detailは残り |
| 768–1279px | collapsed nav + list + reading pane | nav 64px、list `clamp(320px, 38vw, 380px)` |
| 767px以下 | 単一画面 | nav、list、detail、composeを履歴付きで切り替える |

- 上部command barは1行、最小高さ44px。主要操作だけを残し、収まらない操作は `その他` へ移す。
- list行高は44px。差出人、件名、日時を優先し、抜粋は利用可能幅に応じて1行だけ表示する。
- paneとlist行の角丸は4–8px。shadowより1px borderを使う。
- 読み取りpaneは選択なし、loading、errorをpane内状態として表示し、list選択を失わない。
- pane幅は実装とgeometry testで固定し、利用者設定やregistry dataにはしない。

## Visual delta

- light: background `#f5f5f5`、Fluent系blue `#0f6cbd`、selected `#ebf3fc`。
- dark: background `#1f1f1f`、primary `#479ef5`、selected `#243b4d`。
- fontはOSにある`Segoe UI`を先頭候補にし、配布しない。
- radiusは4-6px、shadowは弱く、paneとcommand barを1px borderで分ける。

## Action placement

- command bar: 新規メール、返信、手動転送、archive、移動、その他。
- nav: mailboxと利用者folder。選択中folderはtextとsurfaceで示す。
- list row: 未読、star、差出人、件名、日時。行内副操作はDOMに常駐させ、focus時に見える。
- reading pane: message metadata、本文、添付、返信開始。
- 削除は通常commandから間隔を取り、明確な日本語ラベルを付ける。

## Profile contract

- 公開ラベルは`Outlook風`とし、非公式の近似であることをデモ説明に残す。
- Segoe UIを配布せず、Microsoftロゴ、製品固有icon、コピーしたassetを使わない。
- ribbonを複製しない。commandを増やすための多段toolbarを作らない。
- pane構成とcollapseをrendererとresponsive CSSで固定し、registry値で調整しない。

## Acceptance anchors

- 1440pxでnav、list、reading paneの3領域が同時に見え、各paneの見出しがprogrammaticに識別できる。
- 1024pxでlistとreading paneが同時に使え、command barが水平scrollしない。
- 390pxで単一画面に縮退し、戻る操作でlistの選択とscroll位置を復元する。
- keyboardだけでfolder移動、message選択、本文確認、返信開始、手動転送まで到達できる。
