# Claude adapter

これはAgent Plugins 1.0のportable packageそのものではなく、Claude Code/Desktopが使うネイティブな`.claude-plugin/plugin.json`形式へ変換した薄いアダプターである。`skills/quickmail-ja-operations/SKILL.md`はportable Skillから生成され、MCP設定・メールボックス権限・プロバイダー認証情報を持たない。

Claude公式のローカルプラグインまたはSkillアップロード導線を利用する。ログイン、MFA、秘密値入力、保存、プロバイダー変更、送信は利用者が行う。QMJ-11BではClaude Code/Desktopのクリーンプロファイルでの発見・実行をまだ確認していないため、自動インストールや自動ブラウザ操作を対応済みとは扱わない。

一次資料: <https://code.claude.com/docs/en/plugins> / <https://support.claude.com/en/articles/12512180-use-skills-in-claude>
