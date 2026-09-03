# Noroshi product tour

2026-09-02に公開操作デモを収録した、字幕付きの無音動画です。
実メールの送信、サービスへのログイン、実データの入力は行っていません。

- 動画：`noroshi-product-tour.mp4`（H.264 / 1920×1080 / 30fps / 36.2秒）
- ポスター：`noroshi-product-tour-poster.jpg`
- 収録元：https://noroshi-ui-preview.pages.dev/
- 収録元のソース：`6f357be457f91623f6044a76357634747776a944`
- 収録元HTMLのSHA-256：`b18f3b82584a93757f8d947e5072022e260fe8cb3549055a4554911c75d64a06`

| 時間 | 操作 |
| --- | --- |
| 0〜7秒 | 受信トレイからメールを開く |
| 7〜13.2秒 | 返信を書き、下書きを保存する |
| 13.2〜19.2秒 | アーカイブへ移し、一覧で確認する |
| 19.2〜32.2秒 | Gmail風、Outlook風、Thunderbird風の比較デモを切り替える |
| 32.2〜36.2秒 | 操作デモへの案内 |

外観3パターンは比較デモ限定です。本体のテーマ切り替えやGmail等のアカウント接続を示す映像ではありません。
個人名、メールアドレス、本文は既存デモの架空データです。音楽、外部素材、顧客の画面は含みません。

ガイドの編集元は `../reports/2026-09-02-noroshi-product-guide.source.html` です。
動画とポスターはガイドHTML内にも埋め込み、ローカルでも再生できます。
字幕の内容は動画直下のテキスト説明からも読めます。

収録はPlaywright CLI、編集はFFmpegを使用しました。収録セッションの一時ファイルは配布対象外です。

## 公開時に含めるファイル

Cloudflare Pagesの `noroshi-ui-preview` はサイト全体をアップロードします。
次回の公開でもガイドを残すため、操作デモだけでなく次の構成を用意します。

```text
index.html                         ← prototype/noroshi-live-demo/index.html
_headers                           ← 同フォルダーの_headers + preview-guide.headers
guide/index.html                   ← reportsの生成済みガイドHTML
guide/noroshi-product-tour.mp4
guide/noroshi-product-tour-poster.jpg
```

元の操作デモのHTMLとセキュリティ設定は変更しません。
`preview-guide.headers` を末尾へ追加すると、動画を許可する設定は `/guide/` 配下だけに適用されます。
ガイド側も外部スクリプトと外部接続を許可しません。
ヘッダーの上書きは[Cloudflare公式仕様](https://developers.cloudflare.com/pages/configuration/headers/)で確認しています。

2026-09-02の公開先： https://noroshi-ui-preview.pages.dev/guide/
公開後にHTMLとMP4のSHA-256一致、動画再生、390pxと1200pxでの表示を確認済みです。
