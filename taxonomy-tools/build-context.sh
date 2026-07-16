#!/usr/bin/env bash
# Assembles the Docker build context for the taxonomy-tools image.
#
# The taxonomy Python scripts parse TS source files at runtime via regex
# (taxonomy.ts, tax-sections.ts, classify-prompts.ts). These files live
# in the main repo under documents/ but don't belong in the sidecar's own
# directory. This script copies them into the build context so the
# Dockerfile can COPY them into the image at the path _common.py expects.
#
# Usage (from repo root):
#   bash taxonomy-tools/build-context.sh
#   docker build -t fk-encore-taxonomy-tools taxonomy-tools/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TS_DEST="$SCRIPT_DIR/ts-sources/documents"
SCRIPTS_DEST="$SCRIPT_DIR/scripts/taxonomy"

# Clean previous copies
rm -rf "$SCRIPT_DIR/ts-sources" "$SCRIPT_DIR/scripts"

# Copy TS source files the scripts parse at runtime
mkdir -p "$TS_DEST"
cp "$REPO_ROOT/documents/taxonomy.ts"         "$TS_DEST/"
cp "$REPO_ROOT/documents/tax-sections.ts"     "$TS_DEST/"
cp "$REPO_ROOT/documents/classify-prompts.ts" "$TS_DEST/"

# Copy the taxonomy scripts themselves
mkdir -p "$SCRIPTS_DEST"
cp "$REPO_ROOT/scripts/taxonomy/_common.py"       "$SCRIPTS_DEST/"
cp "$REPO_ROOT/scripts/taxonomy/diagnose.mjs"     "$SCRIPTS_DEST/"
cp "$REPO_ROOT/scripts/taxonomy/cloud_audit.py"   "$SCRIPTS_DEST/"
cp "$REPO_ROOT/scripts/taxonomy/cloud_teacher.py" "$SCRIPTS_DEST/"

echo "Build context ready in $SCRIPT_DIR"
