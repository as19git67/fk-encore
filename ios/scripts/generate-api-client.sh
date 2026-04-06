#!/bin/bash
# Generate OpenAPI spec and copy to iOS project for swift-openapi-generator
set -euo pipefail
cd "$(dirname "$0")/../.."

echo "Generating OpenAPI spec..."
encore gen client --lang=openapi --output=./openapi/spec.json

echo "Copying to iOS project..."
cp ./openapi/spec.json ./ios/openapi.yaml

echo "Done. Run 'swift build' in ios/ to regenerate Swift client code."
