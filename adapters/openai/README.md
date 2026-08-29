# Codex / ChatGPT adapter note

CodexとChatGPTに対しては、Agent Plugins 1.0のportable root packageを使う。`plugin.json`、`skills/`、`mcp.json`を別の独自manifestへ変換しない。Agent Plugin ZIPにはQMJ-10 operations Skillと、参照資料を含むcanonical BYOK setup Skillを同梱する。Codexは公式にAgent Pluginsのroot manifestを扱える版だけを対象にし、ChatGPTは公式に表示されるPlugins/Skillsのアップロードまたは管理画面の導線だけを使う。

このファイルはプロバイダー接続アダプターではない。Cloudflare、Resend、DNS、メールボックス、QuickMail管理のツールや認証情報を追加しない。cloneだけでインストールされる、またはすべてのChatGPT画面で利用できるとは主張しない。

リポジトリの `scripts/setup.mjs` はAgent Pluginのallowlistに含めない別の対話型CLIであり、plugin/MCPの自動実行経路から切り離す。`setup_apply` はprovider adapter unavailableのまま停止する。

## 状態

QMJ-11BではCodex/ChatGPTのクリーンプロファイルによるインストール・発見を実施していない。したがって、両方とも自動インストール・発見は未検証である。MCPが利用できない場合は、portable Skillを公式のアップロード導線で登録し、ブラウザレスの手動チェックリストを使う。

## 一次資料

- Agent Plugins Specification: <https://agent-plugins.org/specification>
- OpenAI Codex plugins: <https://developers.openai.com/codex/plugins>
- OpenAI plugins repository: <https://github.com/openai/plugins>

## 実装ソースの確認記録

- Codex source commit: [2b5bdcf67547860f2e5c5a605009a70026796b2b](https://github.com/openai/codex/commit/2b5bdcf67547860f2e5c5a605009a70026796b2b)
- commit date: 2026-08-02
- 確認日: 2026-08-29
- 対応対象: Agent Plugins 1.0.0 の portable root 処理
- これは source commit の記録であり、Codex アプリの release version や ChatGPT の利用可否を意味しない。公開 metadata に release version がないため、version は断定しない。
