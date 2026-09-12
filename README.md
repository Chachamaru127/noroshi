# Noroshi

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)

> ### **[ライブデモを試す](https://noroshi-ui-preview.pages.dev/)** 👈

## 自分のドメインで、読む。返す。整理する。

独自ドメインのメールを、自分のCloudflareアカウントで送受信する、日本語のセルフホスト型Webメールです。
メールサーバーを借りない、運用しない。導入はAIが案内し、人はログイン、秘密値の入力、管理画面での確認と承認を行います。

### ▶️ [動画で見る（36秒）](https://noroshi-ui-preview.pages.dev/guide/)

[![Noroshiの製品動画。日本語の受信トレイ、返信、整理をデモ画面で紹介](./docs/media/noroshi-product-tour-poster.jpg)](https://noroshi-ui-preview.pages.dev/guide/)

[製品ガイド](https://noroshi-ui-preview.pages.dev/guide/) / [ライブデモ](https://noroshi-ui-preview.pages.dev/) / [動画を開く（MP4）](https://noroshi-ui-preview.pages.dev/guide/noroshi-product-tour.mp4)

動画とデモは架空のメールを使った操作例です。

**構成**: TypeScript / SvelteKit / Cloudflare Workers + D1 + R2 / Resend / MIT License

---

## できること

|            | 内容                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| 読む       | 受信トレイ、スレッド表示、スター、添付のダウンロード、ライトとダークのテーマ、デスクトップ通知、スマホ対応（PWA） |
| 返す       | 返信、新規作成、下書き、署名と差出人名、添付（1件5MiB、合計25MiB、最大5件）                                       |
| 整理する   | フォルダー作成、差出人と件名による自動振り分け                                                                    |
| 転送する   | 1通ずつの手動転送。受信後の自動転送（宛先の確認、有効と無効の切り替え、状態表示、二重送信防止）                   |
| 複数で使う | 複数のドメイン、ユーザー、アドレスを1つの環境で                                                                   |
| 持ち込む   | OutlookやEMLファイルから過去メールを取り込み                                                                      |
| つなぐ     | REST API、CLI `noroshi`、MCPサーバー（AIクライアントからメールボックスを操作）                                    |
| 保存先     | 受信メール、送信履歴、添付はすべて自分のCloudflareアカウント（D1とR2）                                            |

受信はCloudflare Email Routing、送信はResendを使います。どちらも利用者自身のアカウントです。

---

## 費用

「メールアドレスが欲しいだけ」のために、1ユーザーごとの月額を払い続けていませんか。

|                              | Google Workspace Business Starter                                                                                                | Noroshi                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 課金単位                     | 1ユーザーごとの月額                                                                                                              | 固定費なし。自分のCloudflareとResendの利用量に応じて                                                      |
| 月額                         | ¥800 / ユーザー（年契約の標準価格。最初の3か月は¥400。2026-09-03時点の[公式価格](https://workspace.google.com/intl/ja/pricing)） | ¥0から                                                                                                    |
| 計算例: 5人で1年（標準価格） | ¥48,000                                                                                                                          | 無料枠内なら ¥0（ドメイン代は別）                                                                         |
| 無料枠                       | なし                                                                                                                             | Cloudflare Email Routing 無料、Workers 10万リクエスト/日、Resend 3,000通/月（100通/日）、D1とR2にも無料枠 |
| メールの保存場所             | Googleのサーバー                                                                                                                 | 自分のCloudflareアカウント                                                                                |
| ソースコード                 | 非公開                                                                                                                           | MIT                                                                                                       |

Microsoft 365 Business Basicも同じく1ユーザーごとの月額課金です（[公式価格](https://www.microsoft.com/ja-jp/microsoft-365/business)）。
Noroshi自体は無料です。独自ドメインの取得と更新費、無料枠を超えた分は利用者の負担です。料金は変わるため[Cloudflare](https://www.cloudflare.com/plans/developer-platform/)と[Resend](https://resend.com/pricing)の公式ページで確認してください。

---

## 導入する

導入では、AIが開始前の不足をまとめて確認し、使えるブラウザ、コンピュータ操作、ターミナルで実作業を進めます。外部変更は対象と戻し方を示し、1操作ずつ承認を得ます。日を跨いだ場合は保存した開通ミッションから再開します。

1. 各サービスへのログイン（MFA、CAPTCHA、規約同意を含む）
2. 独自ドメインの取得と支払い
3. 秘密値（APIキー、セットアップキー）と最初の管理者情報の入力。AIには見せません
4. AIに安全な実行経路がない場合だけ、開いてもらった公式画面の最終ボタンを押すこと

### 用意するもの

1. 独自ドメイン（DNSをCloudflareで管理できるもの）
2. Cloudflareアカウント（無料プランで可）
3. Resendアカウント（無料プランで可）
4. ターミナルまたはブラウザを操作できるAI

### ChatGPTデスクトップのCodex / Codex CLIに渡す指示文

コード枠の右上にあるコピーボタンを押し、ChatGPTデスクトップのCodexローカルタスクまたはCodex CLIへそのまま貼り付けます。ドメインやメールアドレスを先に書き換える必要はありません。

```text
Noroshiのセットアップを始めてください。

最初に、Noroshiが「Cloudflare Email Routingで受信し、Resendで送信する、自分のCloudflare上の日本語Webメール」であることを2〜3文で説明してください。人が行う操作と、あなたが行う操作も短く示してください。その後、「セットアップを始めますか？」と聞き、私が同意するまで外部変更をしないでください。

同意後は、https://github.com/Chachamaru127/noroshi を取得し、skills/noroshi-setup/SKILL.md と docs/setup-and-operations.md を読んでください。最初にSetup MCPのsetup_resumeを実測してください。利用できない場合は、永続するNoroshi開通ミッションがないままセットアップを続行しないでください。docs/setup-and-operations.mdの手順でnoroshi-setup pluginを導入し、ChatGPTデスクトップのCodexローカルタスクまたはCodex CLIで新しいタスクを開始してください。setup_resumeによる保存と再開を最初に確認してください。ホスト型ChatGPT WebはローカルCodex設定を読みません。Webからprivate MCPを使う場合だけ、公式Secure MCP Tunnelまたはレビュー済みのremote MCP経路を別途確認してください。会話内だけのTODOを日跨ぎ進捗の正本にしないでください。scripts/setup.mjsをAIのセットアップ経路として実行しないでください。

質問より先に、あなた自身が使えるブラウザ、コンピュータ操作、ターミナル、秘密入力経路、Mailbox MCPを実測してください。Bun 1.3.14、リポジトリ内のWrangler、CloudflareとResendのログイン状態、ドメインの権威DNS・DNSSEC・TTL・既存MXも、安全な読み取りで確認してください。ブラウザとコンピュータ操作が使える場合、Chrome拡張の確認は不要です。自動確認できなかったCloudflare/Resendアカウント、ドメイン、既存メールの利用状況、本人が管理するテスト受信先だけを、一度に質問してください。

不足があれば、説明だけで終わらせないでください。ブラウザ操作が使える場合はCloudflare、Resend、Noroshiの許可済み公式画面を必要な場所まで実際に開いてください。Bunが未導入または1.3.14以外の場合は、https://bun.com/docs/installation と https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14 の必要な場所を開いてください。`curl ... | bash`や`irm ... | iex`のようなpipe installerは実行しないでください。OSとCPUを読み取り、公式releaseから該当する通常版assetとSHASUMS256.txtを特定してください。私がassetをダウンロードし、SHA-256を照合してから展開し、既存のBunとは混在しないPATH上へ配置します。人がコマンドを実行する必要がある場合は、確認した環境に対応する操作を1本ずつコピーできるコード枠で出してください。新しいterminalで`bun --version`が完全に`1.3.14`を返すまで次へ進まないでください。

ログイン、MFA、CAPTCHA、規約同意、支払い、アカウントやチームの切替、ドメイン購入、秘密値の表示・入力は私が行います。それ以外は、利用可能なブラウザ、コンピュータ操作、ターミナルを使って、できるだけあなたが進めてください。外部変更と送信は、対象、変更前後、費用、戻し方を示し、私が承認した1操作だけを実行してください。実行後は同じ画面またはAPIを読み返してください。現在のホストに安全な実行経路がない操作は、公式画面を開いて最終ボタンだけ私へ渡してください。

開始時に12項目の「🔥 Noroshi 開通ミッション」を表示し、秘密を含まない進捗を日を跨いで再開できる状態へ保存してください。途中で止まった操作は同じwriteや送信を繰り返さず、最初にreadbackしてください。

完了条件は、本人管理の宛先へテストメールが1通届くこと、その返信をCloudflare Email RoutingとNoroshiで受信できること、mail:read専用キーを使う別のread-only Mailbox MCPがChatGPT WorkまたはCodexに接続され、whoamiと同じ確認メールをMCPから読めることです。APIキー、パスワード、メール本文をチャット、コマンド引数、MCP設定、進捗ファイル、ログ、スクリーンショットへ残さないでください。
```

OpenAI公式の[MCP資料](https://learn.chatgpt.com/docs/extend/mcp)では、ChatGPTデスクトップ、Codex CLI、IDE拡張は同じCodexホストのMCP設定を共有し、ローカルstdio（標準入出力）MCPを直接起動できます。ChatGPTデスクトップでは、必ずローカルタスクを選びます。ホスト型ChatGPT WebはローカルCodex設定を読みません。[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)は、Webなどのホスト型画面からprivate MCPへ接続する場合だけ使います。

自分で進める場合は、[導入と運用ガイド](docs/setup-and-operations.md)の手順で`bun run setup`を実行します。

---

## しくみ

```
[ 差出人 ]
    │ MX
[ Cloudflare Email Routing ]
    │
[ Noroshi ]  SvelteKit on Cloudflare Workers
    ├─⇄ [ D1 ]  本文、索引、送信履歴
    ├─⇄ [ R2 ]  添付
    │ 送信
[ Resend ] → [ 宛先 ]
    │ 配信結果（Webhook）→ D1

[ ブラウザ / PWA ] ⇄ Web UI
[ noroshi CLI / MCP ] ⇄ REST API
```

---

## ライセンスと由来

MIT Licenseです。原文は[LICENSE.md](LICENSE.md)を参照してください。

Noroshiは[DivinPrince/quickmail](https://github.com/DivinPrince/quickmail)を上流として、日本語UIとセルフホスト運用機能を追加した派生版です。上流の著作権表示とMITライセンスを維持します。
名前は、離れた相手へ合図を届けた「狼煙」に由来します。

Issue / PRは[Chachamaru127/noroshi](https://github.com/Chachamaru127/noroshi)へ。開発者: [@Chachamaru127](https://github.com/Chachamaru127)

---

## 補足

- 動画とライブデモの「Gmail風」「Outlook風」「Thunderbird風」は比較デモ限定で、本番画面の機能ではありません。各社とは無関係の独自実装です。
- 対応していないもの: IMAP / POP、Gmailとの双方向同期、大量配信やメルマガ、Google WorkspaceやMicrosoft 365との機能互換。
- Resend無料プランは1日100通までです。それ以上はResendの有料プランが必要です。
- 導入と運用の詳細（DNS、コスト、バックアップ、復旧、更新、API / CLI / MCP、開発コマンド）: [docs/setup-and-operations.md](docs/setup-and-operations.md)
- 仕様の正本: [spec.md](spec.md)。添付APIの変更点: [docs/release-notes-1.0.md](docs/release-notes-1.0.md)
