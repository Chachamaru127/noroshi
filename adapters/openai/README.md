# Codex / ChatGPT adapter note

このリポジトリのルートは、Agent Plugins 1.0のportable packageである。`plugin.json`、`skills/`、`mcp.json`を別の独自manifestへ変換しない。Agent Plugin ZIPにはQMJ-10 operations Skillと、参照資料を含むcanonical BYOK setup Skillを同梱する。

ただし、OpenAI Codex CLIのローカルmarketplaceは別のネイティブ配布面である。現行の公式ドキュメントは、プラグイン側に `.codex-plugin/plugin.json` と、必要に応じてルートの `.mcp.json` を置き、marketplace側に `.agents/plugins/marketplace.json` を置く形式を定義している。リポジトリにはこの形式のadapterを `.agents/plugins/noroshi-setup/` として同梱し、portable packageとは別の配布経路にしている。

このファイルはプロバイダー接続アダプターではない。Cloudflare、Resend、DNS、メールボックス、Noroshi管理のツールや認証情報を追加しない。cloneだけでインストールされる、またはすべてのChatGPT画面で利用できるとは主張しない。

リポジトリの `scripts/setup.mjs` はAgent Pluginのallowlistに含めない別の対話型CLIであり、plugin/MCPの自動実行経路から切り離す。`setup_apply` はprovider adapter unavailableのまま停止する。

## 状態

Codex CLI 0.149.1の一時クリーンプロファイルで、次を実測した（2026-08-30）。

- `codex plugin marketplace add <repo-root>` でこのリポジトリの `.agents/plugins/marketplace.json` を登録できた。
- `codex plugin list --json --available` で `noroshi-setup@noroshi` とBYOK setup Skillを含むnative pluginを発見し、`codex plugin add` 後にinstalled/enabled表示まで成功した。インストール先は公式のcache配下であった。
- インストール済みcacheの同じMCPコマンドでstdio initializeとtools/listを確認し、`setup_apply` は `provider_adapter_unavailable` で停止した。provider、DNS、メール、秘密値、外部送信は扱っていない。
- 一時 `HOME` / `CODEX_HOME`だけを使い、既存のglobal configはハッシュが変わらないことを確認した。

QMJ-11BのCodex CLI discovery gateは「portable rootをmarketplaceとして直接扱う: 不可」「リポジトリnative adapter: PASS」「一時クリーンプロファイルのinstall/enabled/MCP smoke: PASS」である。Codex CLIでは、marketplace登録後に新しいsessionを開始する。ChatGPT Workローカルタスクのlocal marketplaceは、公式のPlugins Directoryでmarketplaceを選択し、再起動後にインストールする別のUI確認が必要である。MCPが利用できない場合は、portable Skillを公式のアップロード導線で登録し、ブラウザレスの手動チェックリストを使う。

native adapterのSkillとSetup MCPランタイムは、canonical portable sourceから `bun run generate:codex-native-adapter` で同期し、`bun run check:codex-native-adapter` で一致を検証する。同期スクリプトはローカルファイルを生成するだけで、インストール、更新daemon、認証、外部通信を行わない。`.agents/plugins/` のnative marketplace metadataはAgent Plugin ZIPのallowlistに含めない。

## 一次資料

- Agent Plugins Specification: <https://agent-plugins.org/specification>
- OpenAI Codex plugins: <https://developers.openai.com/codex/plugins>
- OpenAI plugin packaging and local marketplaces: <https://developers.openai.com/plugins/build/plugins>
- OpenAI plugins repository: <https://github.com/openai/plugins>

## 実装ソースの確認記録

- Codex source commit: [2b5bdcf67547860f2e5c5a605009a70026796b2b](https://github.com/openai/codex/commit/2b5bdcf67547860f2e5c5a605009a70026796b2b)
- commit date: 2026-08-02
- 確認日: 2026-08-29
- 対応対象: Agent Plugins 1.0.0 の portable root 処理
- これは source commit の記録であり、Codex アプリの release version や ChatGPT の利用可否を意味しない。公開 metadata に release version がないため、version は断定しない。
