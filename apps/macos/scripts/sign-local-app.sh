#!/usr/bin/env bash
set -euo pipefail

APP="$1"
# Sign only the root bundle; --deep signing would replace nested Node entitlements.
codesign --force --sign - "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
