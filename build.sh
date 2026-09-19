#!/bin/sh
# Packages extension/ into release/local-contact-avatars-<version>.xpi.
# The XPI is a plain ZIP of the extension/ directory, manifest.json at its root.
set -eu
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VERSION=$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)",*$/\1/p' "$ROOT_DIR/extension/manifest.json")
OUTPUT_FILE="$ROOT_DIR/release/local-contact-avatars-$VERSION.xpi"
[ -e "$OUTPUT_FILE" ] && { echo "Refusing to overwrite $OUTPUT_FILE" >&2; exit 1; }
cd "$ROOT_DIR/extension"
zip -X -q -r "$OUTPUT_FILE" .
cd "$ROOT_DIR/release"
sha256sum local-contact-avatars-*.xpi domain-contacts-*.vcf > SHA256SUMS
cat SHA256SUMS
