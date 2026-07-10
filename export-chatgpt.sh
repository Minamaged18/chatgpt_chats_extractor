#!/usr/bin/env bash
set -euo pipefail

# ── ChatGPT Conversation Exporter ────────────────────────────────────
# Downloads and runs the exporter with a local web UI.
# Prefers Node.js 18+ (passes Cloudflare), falls back to python3.
#
# Usage:
#   curl -sL URL/export-chatgpt.sh -o /tmp/export-chatgpt.sh && bash /tmp/export-chatgpt.sh
# ─────────────────────────────────────────────────────────────────────

GIST_BASE="https://gist.githubusercontent.com/ocombe/1d7604bd29a91ceb716304ef8b5aa4b5/raw"

if ! command -v curl &>/dev/null; then
  echo "Error: 'curl' is required but not found."
  exit 1
fi

# Determine runtime
RUNTIME=""
if command -v node &>/dev/null; then
  NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
  if [[ "$NODE_MAJOR" -ge 18 ]]; then
    RUNTIME="node"
  fi
fi
if [[ -z "$RUNTIME" ]] && command -v python3 &>/dev/null; then
  RUNTIME="python3"
fi
if [[ -z "$RUNTIME" ]]; then
  echo "Error: Node.js 18+ or python3 is required but neither was found."
  echo ""
  echo "  - Install Node.js: https://nodejs.org (recommended)"
  echo "  - Or install Xcode CLI tools: xcode-select --install (for python3)"
  exit 1
fi

# Download and run
TMPDIR_EXPORT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_EXPORT"' EXIT

if [[ "$RUNTIME" == "node" ]]; then
  SCRIPT="$TMPDIR_EXPORT/export.mjs"
  echo "Downloading exporter (Node.js)..."
  curl -sL "$GIST_BASE/export-chatgpt.mjs" -o "$SCRIPT"
  [[ -s "$SCRIPT" ]] || { echo "Error: Failed to download script."; exit 1; }
  node "$SCRIPT"
else
  SCRIPT="$TMPDIR_EXPORT/export.py"
  echo "Downloading exporter (Python)..."
  echo "Note: Python may be blocked by Cloudflare on some networks."
  echo "      If you get a 403, install Node.js 18+ (https://nodejs.org) and retry."
  echo ""
  curl -sL "$GIST_BASE/export-chatgpt.py" -o "$SCRIPT"
  [[ -s "$SCRIPT" ]] || { echo "Error: Failed to download script."; exit 1; }
  python3 "$SCRIPT"
fi
