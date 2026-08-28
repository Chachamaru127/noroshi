# `calm` UI profile delta

- 公開ラベル: `Gmail風`
- 検証日: 2026-08-27
- 共通semantic contract: `base.DESIGN.md`
- 公式原則の参照: [Material 3 canonical layouts](https://m3.material.io/foundations/layout/canonical-examples/overview) のlist-detail適応

Material 3のlist-detail、surface role、primary container、large shapeを参照し、Gmailの検索中心・Compose中心の印象へ近づける。コード、ロゴ、Google Sans、Material Symbolsは取り込まず、local CSS tokenで再実装する。

## Runtime entry

```js
{ id: "calm", publicLabel: "Gmail風", render: renderCalm }
```

任意の `evaluatorDescription` を除き、これ以上のlayout dataをregistryへ追加しない。

## Layout delta

| viewport | 構造 | local rule |
|---|---|---|
| 1280px以上 | nav + list。message選択時はlistをdetailへ置換 | nav 256px、contentは中央で最大1180px |
| 768–1279px | compact nav + list/detail置換 | nav 80px、text labelはtooltipとaccessible nameを残して省略可 |
| 767px以下 | 単一画面 | navはdrawerまたはbottom navigation。list、detail、composeを同時表示しない |

- 検索をtop bar中央の主役にし、desktopで幅 `min(680px, 60vw)` とする。
- 新規メールは左上の目立つ塗りbuttonにする。mobileでは44px以上の固定主要操作にする。
- list行高はdesktop 56px、mobile 64px。件名、差出人、抜粋の順で初見理解を優先する。
- list containerの角丸は16px、主要buttonは12–16px、pillは完全な丸にする。
- card shadowを常用しない。listのまとまりと選択は共通surface tokenで示す。
- detailから戻ると、直前のlist scroll位置と選択行へのfocusを戻す。

## Visual delta

- light: background `#f6f8fc`、primary `#0b57d0`、selected `#d3e3fd`、Compose `#c2e7ff`。
- dark: background `#111318`、primary `#a8c7fa`、selected `#3c4043`。
- fontは`Roboto`を先頭候補にするが配布せず、Arialと日本語sansへfallbackする。
- 検索は46pxのpill、Composeは56pxの大きい角丸button、listはゆとりを残す。

## Action placement

- top bar: 検索、表示切替、設定、account。
- nav: 新規メール、mailbox、利用者folder。
- list row: 選択、star、差出人、件名、抜粋、日時。副操作はfocus時にも表示する。
- detail header: 戻る、返信、全員に返信、手動転送、その他。
- 破壊操作は `その他` 内または十分に離れた位置に置く。

## Profile contract

- 公開ラベルは`Gmail風`とし、非公式の近似であることをデモ説明に残す。
- Google固有の赤、Google Sans、Material Symbols、ロゴ、コピーしたassetを使わない。
- 3ペインやtable列をこのprofileへ持ち込まない。
- list/detail置換をrendererとresponsive CSSで固定し、registry値で調整しない。

## Acceptance anchors

- 1440pxと1024pxで、検索、新規メール、受信一覧を最初のviewport内で認識できる。
- 390pxで水平scrollがなく、listからdetail、detailからlistへkeyboardまたは明示buttonで戻れる。
- profile切替前後で選択messageと下書きが変わらない。
