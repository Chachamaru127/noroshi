# QuickMail-ja 日本語圏・競合調査

確認日: 2026-08-27

## 結論

`Cloudflare上で動くWebメール`には直接競合が複数ある。QuickMail-jaは、競合不在ではなく、次の組み合わせで差別化する。

> 日本語利用者が、自分のCloudflareアカウント上に独自ドメインのメールを安全に構築・移行・復旧・運用できる、日本語ファーストのセルフホスト配布物

今回の公開調査では、次の全条件を同時に明示する保守済み配布物は確認できなかった。

- 日本語ファーストの固定UIと日本語運用資料
- Cloudflare Email Routing受信とResend送信の分離構成
- 保存後の手動・自動転送、フォルダ、差出人・件名ルール
- Outlook/EML移行
- MX切替前診断、差分、ロールバック
- Agent Plugins 1.0による承認付きセットアップ支援

これは非存在の証明ではない。非公開開発、受託システム、検索対象外の国内サービスは残る。公開表現は `同等の組み合わせは調査日時点で未確認` に限定し、`国内唯一`、`競合なし` は使わない。

## 調査方法

- QuickMail-jaの比較軸を`Cloudflare Email Routing -> Worker -> D1/R2`受信、Resend送信、日本語Webメールに固定した。
- GitHub、公式製品ページ、公式ドキュメント、国内ホスティング各社の日本語ページを横断した。
- `grok -p`は候補発見と反証に利用した。Grokの主張だけを事実根拠にはせず、表には一次情報URLを付けた。
- `direct`は同じ購入・導入判断に入るCloudflare-nativeメール、`adjacent`は用途か基盤が一部異なるもの、`substitute`はスタックが異なるが利用目的を置き換えるものとした。

## Cloudflare-nativeの直接・近接競合

| 製品                                                                    | 区分              | 受信・送信・保存                                                          | 日本語圏での位置                         | QuickMail-jaへの意味                                              |
| ----------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------- |
| [QuickMail](https://github.com/DivinPrince/quickmail)                   | upstream          | Workers/D1/R2。ResendまたはCloudflareを選択                               | 日本語ファーストの明記なし               | 上流であり、独立競合ではない。上流6コミットの継続監査が必要       |
| [Cloudflare Agentic Inbox](https://github.com/cloudflare/agentic-inbox) | direct            | Email Routing、Durable Objects、R2、Email Service、Web UI、AI/MCP         | 日本語ファーストの明記なし               | Cloudflare公式の強い比較対象。AIでは正面競争しない                |
| [AgentMail](https://github.com/mtpark-ai/AgentMail)                     | direct            | Email Routing、D1/R2、ResendまたはEmail Service、Web UI、DNS自動設定      | 日本語ファーストの明記なし               | 構成とセットアップ自動化が最も近い                                |
| [Mailflare](https://github.com/hieunc229/mailflare)                     | direct            | Email Routing、D1/R2、Email Sending、Web UI、ドメインAPI                  | 日本語ファーストの明記なし               | Cloudflare操作とWebメールで直接競合。ライセンス条件も別途比較する |
| [cf-mail](https://github.com/Coldplay-now/cf-mail)                      | direct            | Email Routing、D1/R2、Email Service、Web UI、任意転送                     | 英語・中国語。日本語ファーストの明記なし | 単一利用者の軽量構成で競合                                        |
| [Postern](https://github.com/skyphusion-labs/postern)                   | direct            | Email Routing、D1/R2/Vectorize、Webmail、IMAP、MCP、CLI                   | 日本語ファーストの明記なし               | agent/IMAP/APIを重視する上位機能競合                              |
| [HQBase](https://github.com/HQBase/hqbase)                              | direct/team       | Cloudflare上の共有メール、更新・バックアップ・復旧、OAuth MCP             | 日本語ファーストの明記なし               | チーム共有と運用面で強い。v1の対象顧客は分ける                    |
| [saasmail](https://github.com/choyiny/saasmail)                         | direct/team       | Email Routing、D1/R2/Queues、Resend等、共有Inbox、Claude onboarding skill | 日本語ファーストの明記なし               | setup skillまで含む重要な反証。Plugin優位は安全性と横断対応で作る |
| [Clawpost](https://github.com/hirefrank/clawpost)                       | adjacent/agent    | Email Routing、D1/R2、ResendまたはEmail Service、REST、CLI、MCP           | 日本語ファーストの明記なし               | 人間Webメールよりagent mailboxが中心                              |
| [Doota](https://github.com/etherCorps/doota)                            | adjacent/emerging | Cloudflare一式、暗号化、パスキー、予約送信、会話UI                        | 開発中。日本語ファーストの明記なし       | 暗号化・現代的UXの将来比較対象                                    |
| [cloudflare-email](https://github.com/MalikZu/cloudflare-email)         | adjacent          | Email Routing、D1/R2、検索・複数ドメインInbox                             | 日本語ファーストの明記なし               | 受信・検索中心の軽量競合                                          |
| [Cloud Mail](https://github.com/maillab/cloud-mail)                     | adjacent/direct   | Workers、D1/KV/R2、Cloudflare受信、Resend系送信、Web UI                   | 中国語・英語中心。日本語の完全性は未確認 | 中国語圏の同型実装。日本語だけを優位としない                      |

## 日本語で利用できる代替

| 製品・構成                                                                                                           | 区分                  | 日本語             | QuickMail-jaとの違い                                       |
| -------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------ | ---------------------------------------------------------- |
| [Roundcube](https://roundcube.net/about/)                                                                            | substitute/webmail    | 公式`ja_JP`        | IMAP/SMTPサーバが別途必要。成熟した日本語UIは強い比較対象  |
| [SnappyMail](https://github.com/the-djmaze/snappymail)                                                               | substitute/webmail    | 日本語ロケールあり | 軽量だが既存IMAP/SMTPが必要                                |
| [SOGo](https://www.sogo.nu/)                                                                                         | substitute/groupware  | 日本語ロケールあり | メール・予定表・連絡先。サーバ運用が必要                   |
| [mailcow](https://github.com/mailcow/mailcow-dockerized)                                                             | substitute/server     | 管理UIに日本語     | Postfix/Dovecot等をVPSで運用し、port 25、PTR、IP評価を負う |
| [Mailu](https://github.com/Mailu/Mailu)                                                                              | substitute/server     | 管理UIに日本語     | VPS上のSMTP/IMAPフルスタック                               |
| [Stalwart](https://github.com/stalwartlabs/stalwart)                                                                 | substitute/server     | 日本語UIは未確認   | SMTP/IMAP/JMAPサーバ。日本語の国内構築記事はある           |
| [さくらのメールボックス](https://rs.sakura.ad.jp/plan/mail/)                                                         | managed substitute    | 日本語             | 低価格で運用を委託できる。所有・拡張性より簡便さが勝つ     |
| [お名前メール](https://www.onamae.com/service/mail/lp/)                                                              | managed substitute    | 日本語             | 国内サポートと普通のメールクライアント接続が強い           |
| [Zoho Mail](https://www.zoho.com/jp/mail/)                                                                           | SaaS substitute       | 日本語             | 成熟したSaaS。セルフホストではない                         |
| [Google Workspace Gmail](https://workspace.google.com/intl/ja/products/gmail/)                                       | SaaS substitute       | 日本語             | 認知、検索、アプリ連携、管理で強い。無料代替を訴求しない   |
| [Microsoft 365 Outlook](https://www.microsoft.com/ja-jp/microsoft-365/outlook/outlook-for-business)                  | SaaS substitute       | 日本語             | Office連携と企業運用で強い                                 |
| [Cloudflare Email RoutingからGmailへ転送](https://developers.cloudflare.com/email-service/get-started/route-emails/) | functional substitute | 日本語解説多数     | 保存Webメールはないが、最小の受信手段として強い            |

価格は変動するため、この調査には固定しない。比較ページを公開する時点で各公式料金を再取得する。

## 競争上の判断

### 本質

メールエンジン自体は差別化になりにくい。Cloudflare-nativeのWebメール、Agent向けMCP、共有Inbox、AI下書きはすでに存在する。

### 勝ち筋

QuickMail-jaの優先順位は次の通りとする。

1. 日本語での安全な導入、切替、移行、復旧
2. Cloudflare受信とResend送信を混線させない構成
3. 非技術者が状態とロールバックを理解できる画面
4. Agent Plugins 1.0の読み取り診断と、承認単位を分離した初期設定支援
5. 日常のメール処理に馴染む選定済みUI

### 反証条件

次のどれかが確認されたら差別化表現を更新する。

- 日本語ファーストで同一トポロジの保守済み製品が公開された
- 直接競合がOutlook/EML移行、DNSスナップショット、ロールバック、Agent Plugins 1.0を一体化した
- 国内の小規模組織5件以上で、Gmail転送または低価格マネージドメールの方が一貫して選ばれた

## 名称リスク

[QuickMail.com](https://quickmail.com/)は既存の営業メールSaaSであり、上流もQuickMailを名乗る。公開前に[J-PlatPat](https://www.j-platpat.inpit.go.jp/)で文字列、称呼、関連区分を確認し、検索・商標・誤認リスクを独立判断する。名称確認が終わるまで大規模なブランド資産を作らない。

## 次回更新

- 公開前、および各リリース前に直接競合のREADMEとリリースを再確認する。
- Grokや検索結果は候補発見に使い、公開主張は一次情報で再検証する。
- `not observed`を`absent`へ置き換えない。
