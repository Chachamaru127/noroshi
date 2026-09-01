# Gmail BYOK

## 機能ゲート

最初に、利用中のNoroshiがGmailコネクターを実装しているか、UIとリリースノートで確認する。READMEに「Gmailとの双方向同期はありません」とある版では、Google Cloud設定を開始しない。

## BYOK構成

Gmailコネクター対応版では、利用者が自分のGoogle Cloudプロジェクトを作り、Gmail API、OAuth同意画面、OAuth Clientを管理する。Noroshi公式の共通Client ID / Client Secretは配布しない。

確認時は次の公式資料を当日開く。

- Gmail API overview: https://developers.google.com/workspace/gmail/api/guides
- Gmail scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
- OAuth app audience: https://support.google.com/cloud/answer/15549945
- Verification exceptions: https://support.google.com/cloud/answer/13464323
- Gmail sync: https://developers.google.com/workspace/gmail/api/guides/sync
- Gmail push notifications: https://developers.google.com/workspace/gmail/api/guides/push

## 利用者へ説明すること

- 個人または限定された自己利用では、利用者自身のOAuthプロジェクトに対する公開審査が必須でない場合がある。Googleの現行条件を確認して案内する。
- OAuth公開状態がTestingの場合、Gmail権限を含む認可とrefresh tokenは通常7日で失効する。継続利用では公開状態と警告表示の意味を利用者が判断する。
- Google Workspaceでは管理者のAPI controlsにより接続できない場合がある。組織管理者の承認を迂回しない。
- `gmail.send`、`gmail.readonly`、`gmail.modify`の区分と必要性を説明し、実装が要求する最小scopeだけを選ぶ。広い`https://mail.google.com/`を便宜上選ばない。
- Client Secretやrefresh tokenをチャットへ貼らせない。利用者がNoroshiの秘密入力先へ直接登録する。

## ブラウザ案内の終点

Google Cloud Consoleで対象プロジェクト、Gmail API、OAuth consent、OAuth Clientの各画面を開き、必要項目の意味を説明するところまで。プロジェクト作成、規約同意、公開状態変更、Client作成、secret表示・コピー、Workspace管理者承認は利用者が行う。
