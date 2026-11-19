#!/usr/bin/env bash
# Cuts a release of one package from main: bumps its package.json, pushes
# that commit, then pushes the <package>-v<version> tag that release.yml publishes.
set -euo pipefail

package=${1:-}
bump=${2:-}
case "$package" in
	vitest | mocha | jest) ;;
	*) package= ;;
esac
case "$bump" in
	major | minor | patch) ;;
	*) bump= ;;
esac
if [ -z "$package" ] || [ -z "$bump" ]; then
	echo "usage: pnpm run release <vitest|mocha|jest> <major|minor|patch>" >&2
	exit 2
fi

cd "$(git rev-parse --show-toplevel)"
manifest="packages/$package/package.json"

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != main ]; then
	echo "releases are cut from main, not from $branch" >&2
	exit 1
fi

if [ -n "$(git status --porcelain -- "$manifest")" ]; then
	echo "$manifest has uncommitted changes" >&2
	exit 1
fi

git fetch --quiet origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
	echo "main is not in sync with origin/main; pull or push first" >&2
	exit 1
fi

# The workspace lockfile does not record a workspace package's own version.
version=$(cd "packages/$package" && npm version "$bump" --no-git-tag-version)
tag="$package-$version"
git commit --quiet -m "release: $tag" -- "$manifest"
git tag "$tag"
git push origin main
git push origin "$tag"
echo "pushed $tag; release.yml stages it on npm"
