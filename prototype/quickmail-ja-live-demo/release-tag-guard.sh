#!/usr/bin/env bash
set -euo pipefail

tag="${1:-${TAG:-}}"
expected_sha="${2:-${EXPECTED_SHA:-}}"
repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9.]+)?$ ]] || {
  echo "Invalid release tag: $tag" >&2
  exit 1
}
[[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]] || {
  echo "Expected SHA must be a full lowercase commit SHA" >&2
  exit 1
}

object_json="$(gh api "repos/${repository}/git/ref/tags/${tag}")"
object_type="$(jq -er '.object.type' <<<"$object_json")"
object_sha="$(jq -er '.object.sha' <<<"$object_json")"
for _ in 1 2 3 4 5 6 7 8; do
  [[ "$object_type" == tag ]] || break
  object_json="$(gh api "repos/${repository}/git/tags/${object_sha}")"
  object_type="$(jq -er '.object.type' <<<"$object_json")"
  object_sha="$(jq -er '.object.sha' <<<"$object_json")"
done
[[ "$object_type" == commit && "$object_sha" =~ ^[0-9a-f]{40}$ ]] || {
  echo "Tag does not peel to a full commit SHA: $tag" >&2
  exit 1
}
[[ "$object_sha" == "$expected_sha" ]] || {
  echo "Release tag moved: expected $expected_sha, found $object_sha" >&2
  exit 1
}
printf '%s\n' "$object_sha"
