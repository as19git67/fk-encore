"""Test setup for the taxonomy-tools sidecar.

The sidecar and the taxonomy scripts live in different directories but run as
one unit inside the image (scripts under /app/scripts/taxonomy, main.py at
/app). These tests import both from their real locations in the repo rather
than from an assembled build context, so they run without build-context.sh.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SIDECAR_DIR = REPO_ROOT / "taxonomy-tools"
SCRIPTS_DIR = REPO_ROOT / "scripts" / "taxonomy"

for path in (SIDECAR_DIR, SCRIPTS_DIR):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))
