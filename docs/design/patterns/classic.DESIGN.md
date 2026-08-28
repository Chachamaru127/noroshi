# `classic` UI profile delta

- 公開ラベル: `Thunderbird風`
- 検証日: 2026-08-27
- 共通semantic contract: `base.DESIGN.md`
- 公式原則の参照: [Thunderbird Mail front-end](https://developer.thunderbird.net/thunderbird-development/codebase-overview/mail-front-end) のfolder / thread / message pane

Thunderbird Mailのfolder / thread / message paneとBoltのdesktop / mobile / web一貫性を参照する。ロゴ、製品固有icon、XUL assetは取り込まず、local CSS tokenで再実装する。

## Runtime entry

```js
{ id: "classic", publicLabel: "Thunderbird風", render: renderClassic }
```

任意の `evaluatorDescription` を除き、これ以上のlayout dataをregistryへ追加しない。

## Layout delta

| viewport | 構造 | local rule |
|---|---|---|
| 1200px以上 | folder tree + thread table + message pane | folder 220px、thread `clamp(400px, 38vw, 560px)`、messageは残り |
| 768–1199px | folder tree + thread table + message pane | folder 184px、任意列を隠し、threadは最低360px |
| 767px以下 | 単一画面 | folder、thread、messageを履歴付きで切り替える |

- thread table上部にquick filterを常設する。
- desktopのrow高は40px、mobile listは52px。将来の密度設定は今回実装せず、この値を固定する。
- 列は状態、star、差出人、件名、添付、日時の順を基本とする。1024px未満では添付、状態などの任意列を減らす。
- 角丸は2–6px。shadowを使わず、paneとrowを1px borderで分ける。
- 列headerと各cellの対応をsemanticsで伝える。見た目だけのCSS gridにせず、screen readerで列の意味が分かる構造を使う。
- pane幅、表示列、row高はrenderer、CSS、geometry testで固定し、registry dataにはしない。

## Visual delta

- light: background `#f0f0f4`、blue `#0060df`、selected `#d9e8f6`。
- dark: background `#1c1b22`、primary `#0a84ff`、selected `#1f3449`、secondary accent `#80ebff`。
- OS標準font、2-6px radius、40px thread rowでdesktop mail clientの密度を出す。
- surfaceの境界はshadowよりborderを優先する。

## Action placement

- 最上部toolbar: 更新、新規メール、返信、手動転送、tag、その他。
- folder pane: mailbox、利用者folder、未読数。
- thread pane: quick filter、列header、thread rows。
- message pane: 件名、metadata、本文、添付、返信開始。
- mouse hoverで現れる副操作にもkeyboardで到達できる代替を置く。

## Profile contract

- 公開ラベルは`Thunderbird風`とし、非公式の近似であることをデモ説明に残す。
- Thunderbirdのロゴ、製品固有icon、XUL assetを使わない。
- `標準` / `コンパクト` 切替は将来候補に留め、今回のruntime設定やregistry fieldにしない。
- 3ペインと列縮退をrendererとresponsive CSSで固定し、任意schemaへ変換しない。

## Acceptance anchors

- 1440pxと1024pxでfolder、thread、messageが同時に見え、threadを列単位で走査できる。
- 1024pxで優先列を維持したまま任意列が減り、水平scrollが発生しない。
- 390pxで単一画面へ縮退し、操作対象が44px以上になる。
- keyboardだけでquick filter、thread選択、本文確認、返信開始、手動転送まで到達できる。
