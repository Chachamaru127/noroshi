# QuickMail-ja Support Knowledge

このディレクトリは、QuickMail-jaの日本語セットアップ支援で使う構造化ナレッジです。競合製品の本文を保存する資料集ではありません。

## 正本の優先順位

1. QuickMail-jaの`spec.md`と配布契約
2. Cloudflare、Resendの公式資料
3. 各製品の公式README、公式ドキュメント
4. 公式Issueやコミュニティ情報は候補発見だけに使う

`sources.json`は出典と確認期限、`patterns.json`はQuickMail-jaに適用できる日本語の診断・安全手順・停止条件を保持します。出典の本文、HTML、画像、引用文は保持しません。

期限切れ、リンク切れ、適用条件不一致の場合、Support AIは具体的な外部変更を案内せず、公式資料の再確認で停止します。AIへの質問、Plugin、MCP、静的FAQは同じPatternを参照し、秘密値、メール本文、実アカウント識別子を自動で渡しません。
