# QuickMail-ja 1.0.0 互換性メモ

## 添付ファイル送信

- 新規添付の送信・返信は`multipart/form-data`へ統一しました。
- JSONの`attachments[].content`へbase64を埋め込む旧形式はHTTP 400で拒否します。
- Web UIはmultipartへ移行済みです。CLI/MCPは添付アップロード機能を公開していません。
- 既存メールの添付IDを指定する手動転送JSONは引き続き利用できます。
- 上限は最大5件、1件5MiB、合計25MiBです。
- multipartの`Content-Length`がない場合も、実際に読み取ったバイト数で同じ上限を適用します。

この変更は、大きなbase64 JSONを解析するときにCloudflare Workersのメモリ上限へ近づく問題を避けるためのものです。
