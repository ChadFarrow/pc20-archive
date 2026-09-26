#!/bin/bash
#
# Generates and loads the launchd agent that mirrors mp3s.nashownotes.com to the NAS.
#
#   ./scripts/install-agent.sh              # install and load
#   ./scripts/install-agent.sh --check      # print what would be written, change nothing
#
# The plist is generated rather than committed because it has to name absolute
# paths — this repo is public, and publishing someone's home directory layout
# buys nothing.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node)"
LABEL="com.chadfarrow.pc20-nas-sync"
TEMPLATE="$REPO/launchd/$LABEL.plist.template"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"

render() {
  sed -e "s|__REPO__|$REPO|g" -e "s|__NODE__|$NODE|g" -e "s|__HOME__|$HOME|g" "$TEMPLATE"
}

if [ "${1:-}" = "--check" ]; then
  if [ -f "$TARGET" ] && render | diff -q - "$TARGET" >/dev/null; then
    echo "installed agent matches the template."
  elif [ -f "$TARGET" ]; then
    echo "installed agent differs from the template:"
    render | diff - "$TARGET" || true
    exit 1
  else
    echo "not installed. Run ./scripts/install-agent.sh"
    exit 1
  fi
  exit 0
fi

[ -d /Volumes/pc20-archive ] || echo "warning: /Volumes/pc20-archive not mounted — the agent will no-op until it is"

mkdir -p "$HOME/Library/LaunchAgents"
render > "$TARGET"

launchctl unload "$TARGET" 2>/dev/null || true
launchctl load "$TARGET"

echo "installed and loaded $LABEL"
echo "  repo:  $REPO"
echo "  node:  $NODE"
echo "  log:   $HOME/Library/Logs/pc20-nas-sync.log"
