#!/usr/bin/env bash
# Cuts a release: sets the Maven version to the release version, commits,
# tags, pushes.
#
#   ./release.sh 1.3.0            # set version, commit, tag v1.3.0, push main + tag
#   ./release.sh 1.3.0 --dry-run  # do everything except push (undo with the
#                                 # printed commands)
#
# The Maven version of the javafx modules IS the release version: there is no
# -SNAPSHOT between releases, because the installer reports ${project.version}
# to the OS and jpackage refuses a -SNAPSHOT. So main always builds the last
# released version, until this script moves it on to the next one.
#
# Everything after the push happens in GitHub Actions (.github/workflows/
# release.yml): the tag push builds one installer per platform, freezes the
# [Unreleased] section of CHANGELOG.md into the version, writes that back to
# main, and attaches installers and release note to the GitHub release.
#
# This script only does the half that has to happen on a developer machine,
# and refuses in the cases where a push would produce a release we do not
# want: a tag that already exists, a dirty tree, a main that is not what
# origin has, an empty changelog.

set -euo pipefail

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

VERSION=""
DRY_RUN=false
ALLOW_EMPTY_CHANGELOG=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --allow-empty-changelog) ALLOW_EMPTY_CHANGELOG=true ;;
    -h|--help) usage ;;
    -*) echo "unknown option: $arg" >&2; usage ;;
    *) VERSION="${arg#v}" ;;
  esac
done
[ -n "$VERSION" ] || usage
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || { echo "version must look like 1.2.3 (got '$VERSION')" >&2; exit 2; }
TAG="v$VERSION"

cd "$(git rev-parse --show-toplevel)"
POM=javafx/pom.xml   # the parent; versions:set carries the version into every module

fail() { echo "error: $*" >&2; exit 1; }

# --- preconditions -----------------------------------------------------------

[ "$(git rev-parse --abbrev-ref HEAD)" = main ] \
  || fail "releases are cut from main (you are on $(git rev-parse --abbrev-ref HEAD))"

git diff --quiet && git diff --cached --quiet \
  || fail "working tree has uncommitted changes — commit them first, they are what gets released"

git fetch -q origin main "+refs/tags/*:refs/tags/*"
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
  || fail "main is not in sync with origin/main — pull or push first"

! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null \
  || fail "tag $TAG already exists"

latest=$(git tag -l 'v[0-9]*' | sort -V | tail -1)
if [ -n "$latest" ] && [ "$(printf '%s\n%s\n' "$latest" "$TAG" | sort -V | tail -1)" != "$TAG" ]; then
  fail "$TAG is not newer than the latest tag $latest"
fi

current=$(xmllint --xpath "/*[local-name()='project']/*[local-name()='version']/text()" "$POM")
[ -n "$current" ] || fail "no <version> in $POM"

unreleased=$(awk '/^## \[Unreleased\]/{f=1;next} /^## \[/{f=0} f' CHANGELOG.md | tr -d '[:space:]')
if [ -z "$unreleased" ] && [ "$ALLOW_EMPTY_CHANGELOG" = false ]; then
  fail "nothing under '## [Unreleased]' in CHANGELOG.md — write what is new for a user, or pass --allow-empty-changelog"
fi

# --- do it --------------------------------------------------------------------

echo "releasing $TAG (Maven version $current -> $VERSION, previous tag ${latest:-none})"

if [ "$current" != "$VERSION" ]; then
  # The parent and every module's <parent> reference, in one go.
  mvn -B -q -f "$POM" versions:set -DnewVersion="$VERSION" -DgenerateBackupPoms=false
  git add javafx/pom.xml javafx/*/pom.xml
  git diff --cached --quiet && fail "versions:set changed nothing — is $POM at $current?"
  git commit -q -m "The app tells the OS the same version the tag says: $VERSION"
  echo "committed version bump: $(git rev-parse --short HEAD)"
else
  echo "$POM already says $VERSION — nothing to bump"
fi

git tag -a "$TAG" -m "Release $VERSION"
echo "tagged $TAG"

if [ "$DRY_RUN" = true ]; then
  cat <<EOF

dry run — nothing pushed. To publish:
  git push origin main && git push origin $TAG
To undo:
  git tag -d $TAG$( [ "$current" != "$VERSION" ] && echo " && git reset --hard origin/main" )
EOF
  exit 0
fi

git push -q origin main
git push -q origin "$TAG"

repo=$(git remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')
cat <<EOF

pushed. GitHub Actions is now building the installers:
  https://github.com/$repo/actions/workflows/release.yml
The release appears here when the first installer job finishes:
  https://github.com/$repo/releases/tag/$TAG

When it is done, the workflow has pushed a "docs: freeze the changelog" commit
to main — run 'git pull' before your next change.
EOF

if command -v gh >/dev/null; then
  echo
  echo "watch it with:  gh run watch --repo $repo"
fi
