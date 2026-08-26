# Forwarding Contract Brief

## Manual Forward

- `GET /compose?forward=<emailId>`: 同一ユーザー所有のメールだけを転送draftとして返す。
- `POST /api/mail`: `forwardOfId` と選択した元添付IDを受け取る。サーバーで所有権を再検証し、元添付をR2から読み込む。
- sessionは許可。API token経由では `mail:read` と `mail:send` の両方を要求する。
- 不正ID・別ユーザー所有・不正添付は404または403。元メールは変更しない。

## Automatic Forward Settings

- `GET /api/forwarding`: 現在ユーザーのsource address、destination状態、rule状態、直近attemptだけを返す。
- `POST /api/forwarding/destinations`: source address IDとdestinationを受け、所有権・宛先形式・同一ドメイン拒否を検証して確認メールを送る。
- `GET /api/forwarding/verify?token=...`: token hash、expiry、single-useを確認してdestinationをverifiedにする。
- `PATCH /api/forwarding/rules/:id`: verified destinationだけenable可能。宛先変更時は再確認が必要。
- `DELETE /api/forwarding/rules/:id`: ruleを無効化し、過去attemptと受信メールは保持する。

## Delivery

- inbound保存後に `(rule_id, source_email_id)` の一意jobを作る。
- handlerはjob作成後に初回送信を1回試し、一時失敗の再試行は最大3回とする。Resend呼出しは初回を含めて合計最大4回。
- 全試行は同じResend idempotency keyを使う。claimは条件付きD1 UPDATE 1本、完了は一致するlease tokenだけを受理する。
- MVPでは日次quota、quota reservation、provider開始phase、complaint/bounce自動停止、旧auto-delivery Worker互換を実装しない。
- providerへはサーバー生成のFrom、Reply-To、Subject、text/html、添付、idempotency keyだけを渡す。受信raw headerは渡さない。
- provider失敗は受信成功を巻き戻さない。attemptへ短いerror codeを保存する。

## External Dependencies

- Resend send APIとdelivery webhook
- Cloudflare D1、R2、Workers scheduled handler
- Cloudflare Email Routingは既存のWorker routeを維持し、転送設定のためのCloudflare API tokenは追加しない。

## Completion

- unit/integration tests、source-only typecheck、format check、production buildが通る。
- additive D1 migrationがremoteで適用され、table/indexをreadbackできる。
- browserでmanual/automatic flowsを確認する。
- 許可済み宛先だけでcanary送受信を行い、最後に検証用auto-forward ruleをdisabledへ戻す。
