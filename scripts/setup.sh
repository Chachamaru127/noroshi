#!/usr/bin/env bash
# QuickMail-jaの準備: Bunがなければ確認後に公式インストーラーを実行し、ウィザードを開始します。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

say() { printf '%s\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }

has_bun() {
	command -v bun >/dev/null 2>&1
}

ask_yes() {
	# $1 prompt, default yes
	local reply
	if [[ ! -t 0 ]]; then
		return 1
	fi
	read -r -p "  $1 [Y/n] " reply || true
	reply="$(printf '%s' "$reply" | tr '[:upper:]' '[:lower:]')"
	[[ -z "$reply" || "$reply" == y || "$reply" == yes ]]
}

say ""
say "QuickMail-ja セットアップ"
say "  Bunと依存パッケージを確認し、ドメイン設定ウィザードを開始します。"
say ""

if ! has_bun; then
	warn "Bunがありません。QuickMail-jaはBunだけをサポートします。"
	if ask_yes "bun.shの公式インストーラーでBunを導入しますか？"; then
		if [[ "$(uname -s)" == "MINGW"* || "$(uname -s)" == "MSYS"* || "$(uname -s)" == "CYGWIN"* ]]; then
			say "  Windowsでは https://bun.sh の手順でBunを導入後、bash scripts/setup.shを再実行してください。"
			exit 1
		fi
		curl -fsSL https://bun.sh/install | bash
		export PATH="$BUN_INSTALL/bin:$PATH"
		if ! has_bun; then
			say "  Bunを導入しましたが、このシェルのPATHから見つかりません。"
			say "  $BUN_INSTALL/bin をPATHへ追加し、bash scripts/setup.shを再実行してください。"
			exit 1
		fi
		ok "bun $(bun --version)"
	else
		say "  Bunを導入してから再実行してください: https://bun.sh"
		exit 1
	fi
else
	ok "bun $(bun --version)"
fi

bun install
ok "依存パッケージを準備しました"
exec bun "$ROOT/scripts/setup.mjs" "$@"
