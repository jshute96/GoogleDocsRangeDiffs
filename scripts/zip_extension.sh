#!/bin/bash

# Make a zip file for distributing the extension.

set -e

TARGET="/tmp/GoogleDocsDiffRange.zip"

[[ -d "dist/" ]] || (echo "dist/ not found" && exit 1)

npm run build

rm "$TARGET"
cd dist && zip -r "$TARGET" .

echo
echo "Made zip file in $TARGET"
