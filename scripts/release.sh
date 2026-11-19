#!/usr/bin/env bash
# Cuts a release of one package from main: sets the version in its
# package.json, pushes that commit, then pushes the <package>-v<version> tag
# that release.yml publishes.
#
# A release candidate (1.3.0-rc1) is published under the npm dist-tag `rc`, so
# `npm install <package>` and version ranges keep resolving to the last
# production release. From a production version name the bump; from a release
# candidate, cut the next candidate or promote it.
set -euo pipefail

usage() {
	cat >&2 <<'USAGE'
usage: pnpm run release <vitest|mocha|jest> <major|minor|patch> [--rc]
       pnpm run release <vitest|mocha|jest> <rc|promote>

  from a production version (1.2.3):
    patch | minor | major        1.2.4 | 1.3.0 | 2.0.0
    patch | minor | major --rc   1.2.4-rc1 | 1.3.0-rc1 | 2.0.0-rc1
  from a release candidate (1.3.0-rc1):
    rc                           1.3.0-rc2
    promote                      1.3.0
USAGE
	exit 2
}

package=${1:-}
action=${2:-}
flag=${3:-}
case "$package" in
	vitest | mocha | jest) ;;
	*) usage ;;
esac
case "$action" in
	major | minor | patch) [ -z "$flag" ] || [ "$flag" = --rc ] || usage ;;
	rc | promote) [ -z "$flag" ] || usage ;;
	*) usage ;;
esac
[ $# -le 3 ] || usage

cd "$(git rev-parse --show-toplevel)"
manifest="packages/$package/package.json"

current=$(node -p "require('./$manifest').version")
if [[ $current =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)(-rc([0-9]+))?$ ]]; then
	major=${BASH_REMATCH[1]}
	minor=${BASH_REMATCH[2]}
	patch=${BASH_REMATCH[3]}
	candidate=${BASH_REMATCH[5]}
else
	echo "$manifest has version $current, which is neither x.y.z nor x.y.z-rcN" >&2
	exit 1
fi

if [ -n "$candidate" ]; then
	case "$action" in
		rc) next="$major.$minor.$patch-rc$((candidate + 1))" ;;
		promote) next="$major.$minor.$patch" ;;
		*)
			echo "$package is at release candidate $current: use rc for the next candidate or promote to release $major.$minor.$patch" >&2
			exit 1
			;;
	esac
else
	case "$action" in
		major) next="$((major + 1)).0.0" ;;
		minor) next="$major.$((minor + 1)).0" ;;
		patch) next="$major.$minor.$((patch + 1))" ;;
		*)
			echo "$package is at $current, not a release candidate: name the bump (major, minor or patch), with --rc for a candidate" >&2
			exit 1
			;;
	esac
	[ "$flag" != --rc ] || next="$next-rc1"
fi

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
(cd "packages/$package" && npm version "$next" --no-git-tag-version >/dev/null)
tag="$package-v$next"
git commit --quiet -m "release: $tag" -- "$manifest"
git tag "$tag"
git push origin main
git push origin "$tag"
echo "pushed $tag ($current -> $next); release.yml stages it on npm"
