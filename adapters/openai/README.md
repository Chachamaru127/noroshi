# Codex / ChatGPT adapter note

このリポジトリのルートは、Agent Plugins 1.0のportable packageである。`plugin.json`、`skills/`、`mcp.json`を別の独自manifestへ変換しない。Agent Plugin ZIPにはQMJ-10 operations Skillと、参照資料を含むcanonical BYOK setup Skillを同梱する。

ただし、OpenAI Codex CLIのローカルmarketplaceは別のネイティブ配布面である。現行の公式ドキュメントは、プラグイン側に `.codex-plugin/plugin.json` と、必要に応じてルートの `.mcp.json` を置き、marketplace側に `.agents/plugins/marketplace.json` を置く形式を定義している。したがって、このリポジトリのルートにあるAgent Plugins 1.0形式だけで、Codex CLIのmarketplaceへ自動発見されるとは扱わない。Codex用のネイティブadapterが別途必要である。

このファイルはプロバイダー接続アダプターではない。Cloudflare、Resend、DNS、メールボックス、QuickMail管理のツールや認証情報を追加しない。cloneだけでインストールされる、またはすべてのChatGPT画面で利用できるとは主張しない。

リポジトリの `scripts/setup.mjs` はAgent Pluginのallowlistに含めない別の対話型CLIであり、plugin/MCPの自動実行経路から切り離す。`setup_apply` はprovider adapter unavailableのまま停止する。

## 状態

Codex CLI 0.149.1の一時クリーンプロファイルで、次を実測した（2026-08-29）。

- `codex plugin marketplace add <repo-root>` は、`marketplace root does not contain a supported manifest` で終了した。現リポジトリにはCodex CLIがmarketplaceとして読むカタログがないためである。
- 公式形式の一時fixture（`.codex-plugin/plugin.json`、ルート`.mcp.json`、`.agents/plugins/marketplace.json`）では、marketplace追加、`quickmail-ja-setup`のavailable表示、`codex plugin add`、installed/enabled表示まで成功した。インストール先は公式のcache配下であった。
- 同fixtureのMCPプロセスは、ローカルのstdio initialize応答まで確認した。provider、DNS、メール、秘密値、外部送信は扱っていない。

これは現在のリポジトリをCodex CLIへ導入できた証明ではない。QMJ-11BのCodex CLI discovery gateは「root packageの直接導入: FAIL」「公式native adapter fixture: PASS」「リポジトリにnative adapterを同梱: 未完了」である。ChatGPTデスクトップのlocal marketplaceは、公式のPlugins Directoryでmarketplaceを選択し、再起動後にインストールする別のUI確認が必要である。MCPが利用できない場合は、portable Skillを公式のアップロード導線で登録し、ブラウザレスの手動チェックリストを使う。

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
