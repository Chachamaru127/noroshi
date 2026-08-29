# BYOKとブラウザ案内

## 所有関係

| 対象 | 所有者 | QuickMail-jaが提供するもの |
| --- | --- | --- |
| Cloudflareアカウント、Worker、D1、R2、DNS | 利用者 | 必要構成と確認方法 |
| Resendアカウント、送信ドメイン、APIキー | 利用者 | 送信連携と状態表示 |
| Google Cloudプロジェクト、OAuth Client | 利用者 | Gmailコネクターが実装済みの場合の接続機能 |
| ドメイン契約と各サービスの料金 | 利用者 | 料金の請求・代理契約はしない |

BYOKは「秘密値をAIへ渡す」方式ではない。利用者自身のアカウントで認証情報を発行し、利用者が秘密入力欄へ直接登録する方式である。

## 許可する公式origin

- Cloudflare: `https://dash.cloudflare.com`, `https://developers.cloudflare.com`
- Resend: `https://resend.com`
- Google Cloud / Gmail: `https://console.cloud.google.com`, `https://developers.google.com`, `https://support.google.com`
- QuickMail-ja: 利用者が対象として確認したデプロイoriginだけ

短縮URL、広告、検索結果のスポンサーリンク、似た綴りのドメインは開かない。予期しないoriginへ移動したら停止する。

## 人間へ引き渡す操作

- アカウント作成、ログイン、アカウント・組織・請求先の切替
- パスワード、パスキー、MFA、CAPTCHA、QRコード
- 利用規約、プライバシー条件、料金、プラン変更
- APIキー、OAuth Client Secret、セットアップキーの表示、コピー、入力
- リソース作成、保存、削除、DNS/MX変更、デプロイ、外部メール送信

AIは対象画面を開いて各項目の意味を説明できるが、これらを利用者の代わりに完了しない。

## 画面が一致しない場合

画面名やメニューが公式資料と一致しない場合は、推測で別のボタンを押さない。確認日、公式URL、現在見えている非秘密な見出しを示し、利用者に画面共有の範囲を確認してもらう。秘密値やメール本文を含む部分は共有対象から外す。
