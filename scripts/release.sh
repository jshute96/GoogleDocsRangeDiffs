#!/bin/bash

# Cut a GitHub release for the extension.
#
# Steps, in order:
#   1. Verify versions in package.json and src/manifest.json match.
#   2. Verify the working tree is clean and we're on main.
#   3. Verify the tag doesn't already exist locally or on the remote.
#   4. Build + zip via scripts/zip_extension.sh --release VERSION
#      -> /tmp/GoogleDocsRangeDiffs-vVERSION.zip.
#   5. Create + push an annotated tag.
#   6. gh release create with the zip attached and auto-generated notes.
#      Always creates a draft by default — review and publish from the
#      GitHub UI. Pass --publish to skip the draft step.
#
# Note: the tag is pushed before the release is created, so if step 6
# fails (auth, network) the pushed tag is orphaned. Delete it with
#   git push --delete origin vX.Y.Z && git tag -d vX.Y.Z
# and retry.
#
# Usage:
#   scripts/release.sh             # creates a draft release (default)
#   scripts/release.sh --publish   # publishes immediately, no draft
#
# Bump versions before running by editing both package.json and src/manifest.json.

set -euo pipefail

usage() {
  cat <<EOF
Usage: scripts/release.sh [--publish] [--help]

Cuts a GitHub release for the extension. By default creates a draft so
you can review and publish from the GitHub UI.

Options:
  --publish   Publish immediately instead of creating a draft.
  --help      Show this help and exit.

Bump the version in package.json and src/manifest.json (must match) and
commit before running.
EOF
}

DRAFT_FLAG="--draft"
case "${1:-}" in
  "")          ;;
  --publish)   DRAFT_FLAG="" ;;
  -h|--help)   usage; exit 0 ;;
  *)           echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.."

# 1. Verify versions match.
PKG_VERSION=$(node -p "require('./package.json').version")
MANIFEST_VERSION=$(node -p "require('./src/manifest.json').version")

if [[ "$PKG_VERSION" != "$MANIFEST_VERSION" ]]; then
  echo "Version mismatch:"
  echo "  package.json:      $PKG_VERSION"
  echo "  src/manifest.json: $MANIFEST_VERSION"
  echo "Bump both to the same value before releasing."
  exit 1
fi

VERSION="$PKG_VERSION"
TAG="v$VERSION"
echo "Releasing $TAG"

# 2. Verify clean tree on main.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash changes first."
  git status --short
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo "Not on main (on $BRANCH). Switch to main before releasing."
  exit 1
fi

# 3. Verify tag is unused.
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists locally."
  exit 1
fi
if git ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists on origin."
  exit 1
fi

# 4. Build + zip.
bash scripts/zip_extension.sh --release "$VERSION"
ZIP="/tmp/GoogleDocsRangeDiffs-v${VERSION}.zip"
[[ -f "$ZIP" ]] || { echo "Expected zip at $ZIP, not found."; exit 1; }

# 5. Tag + push.
git tag -a "$TAG" -m "$TAG"
git push origin "$TAG"

# 6. Create the GitHub release.
gh release create "$TAG" "$ZIP" \
  --title "$TAG" \
  --generate-notes \
  $DRAFT_FLAG

echo
if [[ -n "$DRAFT_FLAG" ]]; then
  echo "Drafted $TAG. Review and publish at the URL above."
else
  echo "Released $TAG"
fi
