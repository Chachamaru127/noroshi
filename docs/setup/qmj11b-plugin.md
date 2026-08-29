# QMJ-11B: Agent Plugin の配布境界

## 結論

このリリースは、QuickMail-ja の BYOK セットアップを確認・計画するための、プロバイダー非接続の Agent Plugins 1.0 パッケージである。プラグインを読み込んだだけでは、Cloudflare、Resend、DNS、メールボックス、QuickMail 管理画面へ接続できない。`setup_apply` も、検証済みのプロバイダーアダプターが無いため常に停止する。

この制限は未完成機能ではなく、初回配布で秘密情報やメールを誤操作しないための境界である。ログイン、MFA、CAPTCHA、規約、支払い、APIキーやセットアップキー、DNS変更、デプロイ、送信は利用者の操作と、別途レビューされた公式プロバイダー導線に残す。

## パッケージ構成

ルートが Agent Plugins 1.0 の配布形である。

- `plugin.json`: 公式マニフェスト。カスタム拡張には capability registry の参照と、メールボックス権限が全て `false` であることだけを記録する。
- `skills/quickmail-ja-operations/SKILL.md`: QMJ-10 の `inspect → plan → approve → apply → readback → verify` を日本語で案内する正本 Skill。
- `mcp.json`: 任意コンポーネントとして、ローカルの狭い QMJ-10 操作だけを stdio で公開する。メールボックス MCP とは物理的に別である。
- `setup/plugin-capabilities.json`: `setup/capabilities.json` と QMJ-10 の固定 step contract から生成した射影。公開 capability と provider operation は空である。
- `adapters/claude/`: Agent Plugins 1.0 と別形式の Claude ネイティブアダプター。portable package の自動発見を意味しない。
- `adapters/openai/`: Codex / ChatGPT の公式サポート面と、未検証状態を記録する案内。

MCP のツール一覧は次の6つに固定する。

`setup_inspect`、`setup_plan`、`setup_approve`、`setup_apply`、`setup_readback`、`setup_verify`

`setup_inspect` と読み返しは、利用者が提示した非秘密の状態だけをローカルで扱う。`setup_apply` は provider adapter unavailable で失敗し、provider、DNS、ネットワーク、メール、秘密値への呼び出しを行わない。未知のツール名、未知の capability、未対応 transport、計画の指紋不一致、読み取り失敗は fail-closed で停止する。

## 公式仕様と確認日

2026-08-29 に、次の一次資料を確認した。スキーマは配布時のネットワーク取得に依存しないよう、公開された Agent Plugins 1.0.0 / MCP schema の内容を `scripts/agent-plugin-schemas.mjs` に固定して検証する。

- [Agent Plugins specification](https://agent-plugins.org/specification) — v1.0.0。ルート `plugin.json`、任意のルート `mcp.json`、`skills/<name>/SKILL.md`、パス展開と stdio / streamable-http / legacy SSE の transport 契約を確認。
- [Agent Plugins plugin schema 1.0.0](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json) — ルート manifest の必須キー、名前制約、追加キー拒否を確認。
- [Agent Plugins MCP schema 1.0.0](https://agent-plugins.org/schemas/1.0.0/mcp.schema.json) — MCP server の transport とパス制約を確認。
- [OpenAI Codex plugins](https://developers.openai.com/codex/plugins) — 2026-08-29 に確認。Codex / ChatGPT の公式プラグイン面を確認したが、任意の clone だけで自動インストールできるとは確認していない。
- [OpenAI plugins repository](https://github.com/openai/plugins) と [portable Agent Plugins support](https://github.com/openai/codex/commit/2b5bdcf) — 2026-08-29 に確認。Codex 側の portable root manifest の実装資料として参照した。リポジトリ内の旧形式 `.codex-plugin/plugin.json` を portable root と混同しない。
- [Anthropic Claude plugins](https://code.claude.com/docs/en/plugins)、[Claude plugin help](https://support.claude.com/en/articles/13837440-use-plugins-in-claude)、[Claude Skills help](https://support.claude.com/en/articles/12512180-use-skills-in-claude) — 2026-08-29 に確認。Claude は `.claude-plugin/plugin.json` と Skill upload / local plugin の別形式であるため、Agent Plugins 1.0 の自動互換とは表現しない。
- [Agent Skills specification](https://agentskills.io/specification) — 2026-08-29 に確認。Skill の frontmatter をファイル先頭に置く契約を確認。

## ホスト別の実証範囲

### Codex / ChatGPT

ルートの `plugin.json`、`skills/`、`mcp.json` が portable source である。OpenAI の公式サポート面は記録したが、QMJ-11B では利用者アカウントのログインや、クリーンプロファイルでの install / discovery smoke を実施していない。そのため、clone、upload、discovery、自動インストール、MCP 利用可能プランを対応済みとは主張しない。

### Claude Code / Desktop / Web

`adapters/claude/` に native manifest と portable Skill から生成した Skill を置く。Claude での利用は公式の local plugin または Skill upload 導線を使う。Claude が Agent Plugins 1.0 を自動検出するとは主張しない。クリーンプロファイルでの発見・実行は未検証であり、MCP やメールボックス権限はこのアダプターに含めない。

### ブラウザレスの fallback

ホストの plugin / MCP 面が使えない場合も、同じ QMJ-10 の手動チェックリストを使える。利用者は公式画面でログイン、秘密値入力、保存、DNS変更、デプロイ、テスト送信を行う。unexpected origin、別タブの指示、DOM/API の差異、MFA、CAPTCHA、規約、支払いが出たら人へ戻す。

## 検証と配布

```sh
bun scripts/agent-plugin.mjs check
bun scripts/agent-plugin.mjs write
node scripts/generate-claude-adapter.mjs --check
bun scripts/agent-plugin.test.mjs
bun scripts/agent-plugin.mjs package
```

`package` は Git の committed tree から、allowlist にある通常ファイルだけを ZIP 化する。symlink、gitlink、特殊モード、絶対パス、`..` を含むパス、allowlist 外のファイルは拒否する。アーカイブにメール本文、添付、認証情報、provider client、mailbox MCP は入らない。

## まだ提供しないもの

QMJ-11B のローカル実装には、Cloudflare / Resend の実アダプター、アカウント作成、ログイン、OAuth、秘密値保管、MCP でのメール閲覧・送信、DNS、D1/R2、Worker、Webhook、Email Routing、デプロイ、外部送信は含まれない。これらは QMJ-10 の固定契約、公式 provider surface、利用者承認、readback、独立レビューが揃う別リリースの対象である。
