#!/bin/bash
# Generate OpenAPI spec from Encore.ts backend
set -euo pipefail
cd "$(dirname "$0")/.."

echo "Generating OpenAPI spec..."
encore gen client --lang=openapi --output=./openapi/spec.json
echo "Done: openapi/spec.json"
