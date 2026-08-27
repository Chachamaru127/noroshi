# 比較デモ QA 契約

`qa.mjs` は開発用比較デモだけを検証する。実メール送信、外部API、Cloudflare、Resend、本番データには接続しない。

## QA 専用依存

- package: `@axe-core/playwright@4.13.0`（完全固定）
- license: MPL-2.0
- source: <https://github.com/dequelabs/axe-core-npm>
- verified: 2026-08-27 (`npm view @axe-core/playwright version license homepage repository.url`)
- boundary: `devDependencies` と `qa.mjs` のみ。デモHTMLの実行時依存にはしない。

## 自動検証面

- axe: 3画面構成 × 2配色 × 4状態 × 2幅 = 48面
- snapshot: 3画面構成 × 3幅 × 2配色 = 18枚
- browser: Chromiumを基準にし、Firefox/WebKitで機能・overflow・axe smoke
- deterministic: `ja-JP`、`Asia/Tokyo`、DPR 1、固定fixture clock、animation/caret無効
- artifacts: `/tmp/qmj-12c-artifacts` に trace、PNG、`ui-flow-log.json`、`manifest.json` を生成する。バイナリはGitへ追加しない。

VoiceOverの実音声は `VOICEOVER-CHECKLIST.md` の人手ゲートとして分離する。

2026-08-27の自動実行環境ではSafariの存在を確認したが、VoiceOverの実音声を安全に取得できる非破壊インターフェースは確認できなかった。OSのVoiceOverを自動起動して利用者の操作環境を変更することはせず、実音声は未検証のまま人手ゲートへ残す。Playwright WebKitとアクセシビリティツリーの検査は補完証拠であり、VoiceOver合格の証拠にはしない。
