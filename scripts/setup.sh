#!/usr/bin/env bash
# Noroshiの準備: 検証済みBunを確認し、ウィザードを開始します。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"
REVIEWED_BUN_VERSION="1.3.14"

say() { printf '%s\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }

has_bun() {
	command -v bun >/dev/null 2>&1
}

say ""
say "Noroshi セットアップ"
say "  Bunと依存パッケージを確認し、ドメイン設定ウィザードを開始します。"
say ""

if ! has_bun; then
	warn "Bunがありません。NoroshiはBun 1.3.14を検証済みです。"
	say "  https://bun.sh/docs/installation の公式手順でBun 1.3.14を導入してください。"
	say "  ダウンロードしたインストーラーは内容と公式checksumを確認し、pipe実行しないでください。"
	exit 1
else
	installed_bun_version="$(bun --version)"
	if [[ "$installed_bun_version" != "$REVIEWED_BUN_VERSION" ]]; then
		warn "Bun $installed_bun_version は未検証です。検証済みの $REVIEWED_BUN_VERSION を使用してください。"
		exit 1
	fi
	ok "bun $installed_bun_version"
fi

bun install --frozen-lockfile
ok "依存パッケージを準備しました"
exec bun "$ROOT/scripts/setup.mjs" "$@"
