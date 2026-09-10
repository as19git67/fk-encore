#!/usr/bin/env bash
#
# Start-up smoke test for one built service image.
#
# Four of the five internal services once shipped without service_auth.py:
# their Dockerfiles copy main.py by name, so a module added beside it never
# reached the image and every container died at import with
# ModuleNotFoundError. Nothing caught it. The Python suites run against the
# source tree, where the import resolves; the image build succeeds because
# Docker never runs the app; and no step ever started a built container.
#
# This runs the image and imports exactly what uvicorn would at startup,
# read from the image's own CMD so the check cannot drift away from the
# Dockerfile.
#
# It stops short of starting the server on purpose. Several of these
# services download models or open a database during startup, which is slow,
# needs the network, and would make the check fail for reasons that have
# nothing to do with the image. Importing the module is where the class of
# bug this exists for actually lands.
#
# Usage: smoke-test-image.sh <image>

set -euo pipefail

image="${1:?usage: smoke-test-image.sh <image>}"

# The CMD is ["uvicorn", "<module>:<attr>", "--host", ...]; pick the argument
# that looks like a module spec rather than assuming its position.
spec="$(docker inspect -f '{{ range .Config.Cmd }}{{ println . }}{{ end }}' "$image" \
  | grep -E '^[A-Za-z0-9_.]+:[A-Za-z0-9_]+$' | head -1 || true)"

if [ -z "$spec" ]; then
  echo "::error::no <module>:<attribute> argument found in the image's CMD"
  docker inspect -f '{{ json .Config.Cmd }}' "$image"
  exit 1
fi

module="${spec%%:*}"
attribute="${spec##*:}"
echo "Importing ${module}:${attribute} inside ${image}"

# The secret is mandatory at import — install_service_auth() raises without
# it — so the value here is what lets the import get far enough to prove the
# module is present. It authenticates nothing: the container is thrown away.
docker run --rm \
  -e INTERNAL_SERVICE_SECRET=ci-smoke-test \
  "$image" \
  python -c "
import importlib
import sys

try:
    module = importlib.import_module('${module}')
except Exception as exc:
    sys.exit(f'importing ${module} failed: {type(exc).__name__}: {exc}')

app = getattr(module, '${attribute}', None)
if app is None:
    sys.exit('${module} has no attribute ${attribute} — uvicorn could not start it')

print('ok: ${module}:${attribute} imported and present')
"
