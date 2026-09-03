# 公開承認レシート

このディレクトリには、人が確認して `APPROVE` した次の2ファイルだけを置く。

- `baseline-review-receipt.json`: 固定18画面の視覚確認
- `voiceover-review-receipt.json`: Safari / VoiceOver実音声の3画面構成確認

候補ファイルや自動検証結果をここへコピーしただけでは公開できない。`release-gates.mjs` はファイル名・SHA-256・対象commit以降のUI差分・実施環境・3画面構成の合格を照合する。
