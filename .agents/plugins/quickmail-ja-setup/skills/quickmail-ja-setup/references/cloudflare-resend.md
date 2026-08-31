# CloudflareとResendのBYOK導入

## 正本

具体的な案内の前に、次を当日開いて確認する。

- Cloudflare Workers: https://developers.cloudflare.com/workers/
- Cloudflare Email Routing: https://developers.cloudflare.com/email-service/get-started/route-emails/
- Email Routing rules: https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/
- Wrangler authentication: https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
- Worker secrets: https://developers.cloudflare.com/workers/configuration/secrets/
- Service Bindings: https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/
- Wrangler D1 configuration: https://developers.cloudflare.com/workers/wrangler/configuration/#d1-databases
- D1 migrations: https://developers.cloudflare.com/d1/reference/migrations/
- Resend Domains: https://resend.com/docs/dashboard/domains/introduction
- Resend MX conflict guidance: https://resend.com/docs/knowledge-base/how-do-i-avoid-conflicting-with-my-mx-records

同梱の[setup-patterns.json](setup-patterns.json)から現在段階に一致するPatternだけを読む。リポジトリ内で`support/knowledge/patterns.json`も読める場合は版を照合し、新しい正本を優先する。Patternの`review_by`を過ぎていたら、安全な現状確認に限定する。

## 固定境界

- 受信はCloudflare Email RoutingからQuickMail-ja Workerの`email()`へ渡す。
- 送信はResend APIを使う。
- Resend Receivingを有効にしない。Resendの受信用MXをapexへ追加しない。
- Workerのデプロイ完了とメール開通は別である。
- 既存MXを変更する前に、DNSとRouting Rulesの現状を利用者が保存する。
- APIキーやセットアップキーはAIへ渡さず、利用者が秘密入力先へ直接登録する。
- Wranglerのデプロイ認証はCloudflareへデプロイする主体の認証であり、Worker実行時のAPI Tokenとは別に管理する。デプロイ認証をWorker secretへ流用しない。
- Email Routingの転送先Worker、Worker名、Service Bindingの`service`は別々に読み、同じ対象を指すことを確認する。Worker改名後はRouting Ruleが自動追従すると仮定しない。
- D1の`database_id`は作成したCloudflareアカウント内のデータベースを一意に示す値である。別アカウントや配布テンプレートの値を再利用しない。
- 空の新規D1は初期化する。既存D1は適用済みmigrationを読み、未適用分だけを順序どおり適用する。既存DBへ空DB用bootstrap SQLを再適用しない。

## 今回含めない機能

MBOX、IMAP、自動返信、List-Unsubscribeは別提案へ延期する。共有受信箱、WebSocket、カレンダー、自己更新、Cloudflare Email Serviceによる外部送信はQuickMail-jaの現行導入構成へ採用しない。外部送信はResendのまま維持する。

## 画面案内の終点

AIが案内できるのは、対象アカウント、ゾーン、ドメイン、Worker、D1、R2、Email Routing、Resend Domainの状態が確認できる画面まで。作成、保存、DNS変更、シークレット登録、デプロイ、Webhook作成、送信テストは別操作として利用者へ引き渡す。
