# Codex / ChatGPT adapter note

CodexとChatGPTに対しては、Agent Plugins 1.0のportable root packageを使う。`plugin.json`、`skills/`、`mcp.json`を別の独自manifestへ変換しない。Codexは公式にAgent Pluginsのroot manifestを扱える版だけを対象にし、ChatGPTは公式に表示されるPlugins/Skillsのアップロードまたは管理画面の導線だけを使う。

このファイルはプロバイダー接続アダプターではない。Cloudflare、Resend、DNS、メールボックス、QuickMail管理のツールや認証情報を追加しない。cloneだけでインストールされる、またはすべてのChatGPT画面で利用できるとは主張しない。

## 状態

QMJ-11BではCodex/ChatGPTのクリーンプロファイルによるインストール・発見を実施していない。したがって、両方とも自動インストール・発見は未検証である。MCPが利用できない場合は、portable Skillを公式のアップロード導線で登録し、ブラウザレスの手動チェックリストを使う。

## 一次資料

- Agent Plugins Specification: <https://agent-plugins.org/specification>
- OpenAI Codex plugins: <https://developers.openai.com/codex/plugins>
- OpenAI plugins repository: <https://github.com/openai/plugins>
