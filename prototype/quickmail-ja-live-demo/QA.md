# 比較デモ QA 契約

`qa.mjs` は開発用比較デモだけを検証する。実メール送信、外部API、Cloudflare、Resend、本番データには接続しない。

## QA 専用依存

- package: `@axe-core/playwright@4.13.0`（完全固定）
- license: MPL-2.0
- source: <https://github.com/dequelabs/axe-core-npm>
- verified: 2026-08-27 (`npm view @axe-core/playwright version license homepage repository.url`)
- boundary: `devDependencies` と `qa.mjs` のみ。デモHTMLの実行時依存にはしない。
- image comparison: `pixelmatch@7.2.0`（ISC、<https://github.com/mapbox/pixelmatch>）と `pngjs@7.0.0`（MIT、<https://github.com/pngjs/pngjs>）を完全固定し、baseline比較にだけ使う。

## 自動検証面

- axe: 3画面構成 × 2配色 × 4状態 × 2幅 = 48面
- snapshot: 3画面構成 × 3幅 × 2配色 = 18枚
- browser: Chromiumを基準にし、Firefox/WebKitで機能・overflow・axe smoke
- deterministic: `ja-JP`、`Asia/Tokyo`、DPR 1、固定fixture clock、animation/caret無効
- reference container: GitHub Actionsと同じx86_64の `mcr.microsoft.com/playwright:v1.59.1-noble`
- baseline: `baselines/playwright-1.59.1-noble/` の18枚と比較する。通常実行はbaselineを更新しない。固定container内の明示的な `--update-baselines` だけが更新経路である。
- local comparison: macOSなど固定container外では実画像をpixel比較し、差分画像を保存する。自己生成hashとの比較ではない。macOS ChromiumとLinux referenceの2026-08-27実測最大差分は2.245%であり、既定閾値は2.5%とする。CI/reference container内は閾値0%の完全一致である。
- artifacts: `QMJ12C_ARTIFACT_DIR` が無ければ一意の一時ディレクトリを作り、trace、PNG、diff、`ui-flow-log.json`、`manifest.json` を生成する。既存の共有パスは削除しない。

## Baseline review receipt

baseline PNGは検証入力であり、生成した本人が承認済みとは扱わない。人による視覚レビュー結果は `baseline-review-receipt.schema.json` の形式で、対象commit、container、18件のhash、reviewer、判定、確認日時を結び付ける。現在のreceipt状態は人手レビュー待ちである。

VoiceOverの実音声は `VOICEOVER-CHECKLIST.md` の人手ゲートとして分離する。

2026-08-27の自動実行環境ではSafariの存在を確認したが、VoiceOverの実音声を安全に取得できる非破壊インターフェースは確認できなかった。OSのVoiceOverを自動起動して利用者の操作環境を変更することはせず、実音声は未検証のまま人手ゲートへ残す。Playwright WebKitとアクセシビリティツリーの検査は補完証拠であり、VoiceOver合格の証拠にはしない。
