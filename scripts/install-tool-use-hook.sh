#!/bin/bash
# GMB-177: install the PostToolUse tool-use logger hook.
#
# This script ONLY copies hooks/tool-use-logger.mjs into $HOME/.claude/hooks/
# and makes it executable. It deliberately does NOT touch
# $HOME/.claude/settings.json - wiring the hook into PostToolUse is a
# decision for the user to make by hand (see the fragment this script prints
# at the end, and hooks/README.md). Nothing here writes global config.
#
# Safe to re-run: copying is idempotent.
#
# Override $HOME to install somewhere else (e.g. for testing against a fake
# HOME instead of your real one):
#   HOME=/tmp/fake-home bash scripts/install-tool-use-hook.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$REPO_ROOT/hooks/tool-use-logger.mjs"
DEST_DIR="$HOME/.claude/hooks"
DEST="$DEST_DIR/tool-use-logger.mjs"

if [ ! -f "$SRC" ]; then
  echo "error: $SRC not found (run this from a g-mesh-bench checkout)" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
cp "$SRC" "$DEST"
chmod +x "$DEST"

echo "Installed: $DEST"
echo
echo "This script did NOT modify $HOME/.claude/settings.json."
echo "Add the following to its \"hooks\" object yourself to wire it into PostToolUse"
echo "(merge with whatever \"hooks\" already has - e.g. this machine's existing"
echo "SubagentStop/Stop entries for task-handoff-check.sh - don't replace it):"
echo
cat <<'JSON'
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/hooks/tool-use-logger.mjs",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
JSON
echo
echo "Log path defaults to \$HOME/.claude/tool-use-log.jsonl. Override with the"
echo "TOOL_USE_LOG_PATH environment variable (set it in the hook command above,"
echo "e.g. \"command\": \"TOOL_USE_LOG_PATH=/path/to/log.jsonl node ~/.claude/hooks/tool-use-logger.mjs\")."
echo
echo "Analyze the log with: npx tsx scripts/analyzeToolUseLog.ts \$HOME/.claude/tool-use-log.jsonl"
