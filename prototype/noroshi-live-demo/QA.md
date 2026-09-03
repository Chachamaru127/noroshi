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
- reference container: GitHub Actionsと同じx86_64の `mcr.microsoft.com/playwright@sha256:eac9b0a5312cdab40ee8c2429df5bf19bffdccf8f3bf3c42268e173f97541645`（`v1.59.1-noble` のlinux/amd64 manifest）
- baseline: `baselines/playwright-1.59.1-noble/` の18枚と比較する。通常実行はbaselineを更新しない。固定container内の明示的な `--update-baselines` だけが更新経路である。
- local comparison: macOSなど固定container外では実画像をpixel比較し、差分画像を保存する。自己生成hashとの比較ではない。macOS ChromiumとLinux referenceの2026-08-27実測最大差分は2.226%であり、既定閾値は2.5%とする。CI/reference container内は閾値0%の完全一致である。
- artifacts: `QMJ12C_ARTIFACT_DIR` は実在するOS一時ディレクトリ配下のrootとして扱い、その中に実行ごとの一意な子ディレクトリを作る。指定が不正でも安全な一時領域へ失敗manifestを残す。symlinkや関連しない既存ファイルを上書き・削除しない。
- axe incomplete: 詳細を48面ごとにmanifestへ残す。serious/criticalとして返った全ノードを、そのセルでaxeが返した正確なselectorから一意に解決する。実computed foregroundと実効ancestor backgroundを測り、3:1以上の場合だけ許容する。selectorの部分一致allowlist、ルール除外、画面除外は使わない。manifestには各ノードのselector、HTML、色、比率、セル結合fingerprintを残す。
- update guard: baseline更新はlinux/x86_64、`/.dockerenv`、Ubuntu 24.04.4、Node/Playwright/Chromium版、image digest markerを照合する。これは誤操作防止であり暗号学的な権限証明ではない。公開権限は人の承認レシートが正本である。

CIのAction SHAは2026-08-27に公式tag/commitを照合した。checkout v5.1.0は <https://github.com/actions/checkout/commit/fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09>、setup-bun v2.2.0は <https://github.com/oven-sh/setup-bun/commit/0c5077e51419868618aeaa5fe8019c62421857d6>、upload-artifact v4.6.2は <https://github.com/actions/upload-artifact/commit/ea165f8d65b6e75b540449e92b4886f43607fa02>、download-artifact v4.3.0は <https://github.com/actions/download-artifact/commit/d3f86a106a0bac45b974a628896c90dbdf5c8093> を使う。PlaywrightはMCRのmulti-arch manifestからlinux/amd64 manifest digestを照合した。

## Baseline review receipt

baseline PNGは検証入力であり、生成した本人が承認済みとは扱わない。QAはartifact内に `PENDING_HUMAN_REVIEW` の候補を生成するだけである。人による視覚レビュー結果は `baseline-review-receipt.schema.json` の形式で、対象commit、固定image digest、baseline version、18件のhash、reviewer、判定、確認日時を結び付ける。VoiceOverは別の `voiceover-review-receipt.schema.json` を使う。`release-gates.mjs` は両方のcommitted `APPROVE` が揃わない限り公開を停止する。現在は両方とも人手レビュー待ちである。

`evaluations/AI-BASELINE-EVALUATION.md` はAIサブエージェントによる補助評価である。人間の視覚承認レシートではなく、公開ゲートを解除しない。

releaseはtag名だけを信用しない。preflightでannotated tagを含めてcommitまでpeelし、固定した40桁SHAをQA・package・archiveへ渡す。publishは配布物内のscriptを実行せず、固定workflow内の処理だけを使う。`release-evidence.json` はexact key/type/valueを検証するdataとして読み、downloadしたZIPのSHA-256を再計算する。publish直前にremote tagを再度peelし、同じSHAでなければ公開前に停止する。

VoiceOverの実音声は `VOICEOVER-CHECKLIST.md` の人手ゲートとして分離する。

2026-08-27の自動実行環境ではSafariの存在を確認したが、VoiceOverの実音声を安全に取得できる非破壊インターフェースは確認できなかった。OSのVoiceOverを自動起動して利用者の操作環境を変更することはせず、実音声は未検証のまま人手ゲートへ残す。Playwright WebKitとアクセシビリティツリーの検査は補完証拠であり、VoiceOver合格の証拠にはしない。
