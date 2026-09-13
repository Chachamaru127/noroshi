# BYOKとブラウザ案内

## 所有関係

| 対象                                      | 所有者 | Noroshiが提供するもの                     |
| ----------------------------------------- | ------ | ----------------------------------------- |
| Cloudflareアカウント、Worker、D1、R2、DNS | 利用者 | 必要構成と確認方法                        |
| Resendアカウント、送信ドメイン、APIキー   | 利用者 | 送信連携と状態表示                        |
| Google Cloudプロジェクト、OAuth Client    | 利用者 | Gmailコネクターが実装済みの場合の接続機能 |
| ドメイン契約と各サービスの料金            | 利用者 | 料金の請求・代理契約はしない              |

BYOKは「秘密値をAIへ渡す」方式ではない。利用者自身のアカウントで認証情報を発行し、利用者が秘密入力欄へ直接登録する方式である。

## 許可する公式origin

- Cloudflare: `https://dash.cloudflare.com`, `https://developers.cloudflare.com`
- Resend: `https://resend.com`
- Google Cloud / Gmail: `https://console.cloud.google.com`, `https://developers.google.com`, `https://support.google.com`
- OpenAI / ChatGPT Work: `https://help.openai.com`, `https://developers.openai.com`, `https://platform.openai.com`, `https://chatgpt.com`
- Bun: `https://bun.com`。直接ダウンロードを使う場合だけ、`https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14`
- Noroshi: 利用者が対象として確認したデプロイoriginだけ

OpenAIのoriginは、ChatGPT Workローカル/CodexのMCP設定、Work Cloudまたはホスト型ChatGPT Webのdeveloper mode、Secure MCP Tunnel、ChatGPT Appsの設定と公式資料にだけ使う。Workローカル経路ではdeveloper modeやTunnelを要求しない。Cloud経路で必要になる権限付与、TunnelやAppの最終作成、runtime API keyの表示と秘密値入力は利用者が行う。短縮URL、広告、検索結果のスポンサーリンク、似た綴りのドメインは開かない。予期しないoriginへ移動したら停止する。

Bunが未導入または1.3.14以外の場合、`https://bun.com/docs/installation`と上記のBun 1.3.14公式リリースを開く。`curl ... | bash`、`irm ... | iex`など、取得したスクリプトをそのまま実行するpipe installerはAIが実行しない。AIはOSとCPUを読み取り、公式releaseから該当する通常版assetと`SHASUMS256.txt`を特定する。利用者がassetをダウンロードし、SHA-256を照合してから展開し、既存のBunとは混在しないPATH上へ配置する。AIはその環境に対応する操作を1本ずつコピーできるコード枠で示す。新しいterminalで`bun --version`を実行し、出力が完全に`1.3.14`であることをAIがreadbackするまで依存関係の導入へ進まない。

## 人間だけが行う操作

- アカウント作成、ログイン、アカウント・組織・請求先の切替
- パスワード、パスキー、MFA、CAPTCHA、QRコード
- 利用規約、プライバシー条件、料金、プラン変更
- APIキー、OAuth Client Secret、セットアップキーの表示、コピー、入力

外部変更と外部メール送信は人間専用とは限らない。対象、完全な前後差分、費用、rollback、plan hash、有効期限を固定した次の1操作を利用者が承認し、ホストに安全な実行経路がある場合だけAIが実行できる。実行後は同じ画面またはAPIをreadbackする。安全な実行経路がない場合は、AIが公式画面を必要な場所まで開き、最終ボタンだけを人間へ引き渡す。

## ホスト能力の事前確認

| 能力             | 利用できる場合                               | 利用できない場合                                                                                                                                                                                                            |
| ---------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Computer Use     | 許可済み公式originの画面移動とreadbackを行う | 公式URLと手動メニュー経路を示す                                                                                                                                                                                             |
| 認証済みブラウザ | 現在の非秘密な状態を読み取る                 | 利用者がログイン後、状態名を確認する                                                                                                                                                                                        |
| terminal         | read-only確認と承認済みコマンドを分ける      | そのまま実行できる手動コマンドを示す                                                                                                                                                                                        |
| 秘密入力経路     | 秘密入力brokerがある場合だけそこへ引き渡す   | 利用者が画面またはterminalへ直接入力する                                                                                                                                                                                    |
| Setup MCP        | 保存済みミッションを`setup_resume`で再開する | 永続状態なしで外部設定を続けず、ChatGPT WorkローカルタスクまたはCodex CLIでplugin導入後の新しいタスクへ切り替える。Work Cloudとホスト型ChatGPT Webはローカル設定を読まないため、Tunnel/remote MCPがなければWorkローカル経路へ切り替える |
| Mailbox MCP      | 読み取り専用で最後のcanaryを確認する         | 対象ホストの公式追加画面を案内する                                                                                                                                                                                          |

Computer UseはAIホスト側の能力であり、このSkillが追加するものではない。
会話内だけの12段階表示は進捗の正本ではない。`setup_resume`でOSのユーザーstate領域に保存・再開できることを確認するまで、provider設定へ進まない。

## 承認の再利用

読み取り専用の事前確認には承認を求めない。開始時は今後発生するRisk Gateの種類だけを示す。grantは、対象、payload、変更前後の完全な差分、費用、rollback、plan hash、有効期限を固定し、実行直前の次の1操作に対してだけ発行する。同じ操作を複数回行う場合も先にまとめて発行しない。次の場合は新しい承認が必要になる。

- アカウント、ゾーン、ドメイン、リソースが変わった。
- DNS値、宛先、送信内容、削除対象などのpayloadが変わった。
- 該当grantが使用済みまたは期限切れになった、あるいは必要な操作数が増えた。
- readbackで対象の同一性を確認できない。

アカウント、ゾーン、ドメインの変更または欠落、セッション切れ、想定外origin、公式DOM変更を観測した時点で、発行済みgrantを承認台帳からすべて失効させる。変更した本人性項目がgrantのtargetやpayloadに無くても再利用しない。本人性を再確認しただけではgrantは戻らず、利用者の明示的な再承認で新しいgrantを発行する。

## 再開と画面復旧

1. タブ消失では許可済みかつ期待値と完全一致するoriginだけを実際に開き直し、その画面を再読取する。
2. セッション切れではログイン、MFA、CAPTCHAを利用者へ返す。
3. 公式DOM変更では、公式資料の確認日とURLを更新し、見えている非秘密な見出しから経路を取り直す。
4. 再開時は現在のoriginとアカウント、ゾーン、ドメインをすべて読み直す。欠落または期待値との差があれば既存承認を台帳から失効させ、明示的な再承認を待つ。
5. originと本人性の完全一致を確認した後にだけ、クリップボードの代替経路へ進む。ブラウザとOSのクリップボードが分離した場合は秘密値を再表示せず、利用者の直接入力または秘密入力brokerを使う。

疎通完了はprovider画面1か所で判定しない。メール証拠は同じ非秘密canaryをCloudflare Email Routing Activity、Worker/D1、Resend、Noroshi UIで照合する。canary tokenは`canary-`で始まる12〜72文字の小文字英数字とハイフンだけを使い、秘密値に見える文字列は証拠へ取り込まない。DNS証拠はメールcanaryと分離し、同じドメイン、configuration fingerprint、MX、TXTを権威DNSと公開DNSリゾルバで照合する。

## 画面が一致しない場合

画面名やメニューが公式資料と一致しない場合は、推測で別のボタンを押さない。確認日、公式URL、現在見えている非秘密な見出しを示し、許可済みorigin内で経路を取り直す。秘密値やメール本文を含む部分は共有対象から外す。
