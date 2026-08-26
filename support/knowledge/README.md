# QuickMail-ja Support Knowledge

このディレクトリは、QuickMail-jaの日本語セットアップ支援で使う構造化ナレッジです。競合製品の本文を保存する資料集ではありません。

## 正本の優先順位

1. QuickMail-jaの`spec.md`と配布契約
2. Cloudflare、Resendの公式資料
3. 各製品の公式README、公式ドキュメント
4. 公式Issueやコミュニティ情報は候補発見だけに使う

`sources.json`は出典と確認期限、`patterns.json`はQuickMail-jaに適用できる日本語の診断・安全手順・停止条件を保持します。出典の本文、HTML、画像、引用文は保持しません。

現在のAI相談UIは、Patternの細かな手順や制約を質問文へコピーしません。同じPatternが参照する公式資料だけを段階別に示し、回答前に最新版を開いて確認日と参照URLを回答へ記載するよう依頼します。期限切れやリンク切れの場合は、同じ公式サイト内で現行ページを探し直します。未提供のSetup Skill、Setup MCP、静的FAQも、将来提供する場合はこのPatternを参照し、秘密値、メール本文、実アカウント識別子を自動で渡しません。
