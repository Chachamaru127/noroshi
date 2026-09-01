# Forwarding Design Brief

## Goal

Noroshiの既存画面から、1通の手動転送と、保存済みメールアドレス単位の自動転送を安全に設定・確認できるようにする。

## Primary User

Noroshiへログインし、自分のメールアドレスを管理するユーザー。

## Important States

- メール詳細: 各メッセージにForward操作がある。
- Compose: 転送元情報と添付が初期表示され、宛先入力後に通常送信できる。
- Settings / Automatic forwarding:
  - 未設定
  - 確認メール送信済み（pending）
  - 確認済み・無効
  - 確認済み・有効
  - 転送失敗または停止
- 確認リンク: 成功、期限切れ、使用済み、不正tokenを区別する。

## Interaction Constraints

- Desktopとmobileの両方で既存Noroshiのコンポーネントと余白・色・button規約を再利用する。
- 自動転送の有効化前に「新着メールと添付が外部へ送られる」ことを明示する。
- 手動転送は添付名と合計サイズを表示し、各添付を外せる。
- エラーは秘密値、本文、完全な監査情報を表示しない。ユーザーが直せる短い説明を出す。

## Completion

- 所有する1通をForwardし、別スレッドとしてSentに保存できる。
- Settingsだけで転送先登録、確認、enable/disable、失敗状態確認ができる。
- 未確認・自己宛・同一管理ドメイン宛は有効化できない。
