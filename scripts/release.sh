#!/bin/sh
# Create or push the release tag matching package.json. Never move existing tags.
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_directory/.."

fail() {
  echo "Error: $*" >&2
  exit 1
}

case "${1:-}" in
  tag|push) action=$1 ;;
  *) echo 'Usage: sh scripts/release.sh tag|push' >&2; exit 1 ;;
esac

# Read the committed package version, not an uncommitted version bump.
version=$(git show HEAD:package.json | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).version ?? "")')
[ -n "$version" ] || fail 'Cannot read the committed package version.'
tag="v$version"

if [ "$action" = tag ]; then
  [ -z "$(git status --porcelain)" ] || fail 'Commit or stash changes before creating a release tag.'

  if git show-ref --verify --quiet "refs/tags/$tag"; then
    [ "$(git rev-parse "$tag^{commit}")" = "$(git rev-parse HEAD)" ] ||
      fail "$tag already points to another commit. Bump the package version for a new release."
    echo "$tag already marks this commit."
  else
    git tag -a "$tag" -m "SDS $tag"
    echo "Created $tag. Run: sh scripts/release.sh push"
  fi
else
  git show-ref --verify --quiet "refs/tags/$tag" || fail "Create $tag first: sh scripts/release.sh tag"
  echo "Pushing $tag to origin to trigger the release workflow."
  git push origin "refs/tags/$tag:refs/tags/$tag"
fi
