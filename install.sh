#!/usr/bin/env bash
# install.sh — per-machine installer for the SearXNG-backed web_search plugin.
#
# Usage:
#   ./install.sh [--install] [--unwire]
#
#   (no flags)    Copy the plugin, write/merge the home-level patch, print hints
#   --install     Additionally invoke searxng/searxng-install.sh to set up SearXNG
#   --unwire      Remove the SearXNG rows from the patch (restore backup if present)
#
# Env overrides:
#   DSH_HOME              dsh home dir (default: $DSH_HOME or ~/.dsh)
#   DSH_SEARXNG_PLUGIN_DIR  Where to copy the plugin (default: $HOME/searxng-web-search)

set -euo pipefail

# ─── resolve paths ────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-${HOME}/.dsh}"
PLUGIN_DIR="${DSH_SEARXNG_PLUGIN_DIR:-${HOME}/searxng-web-search}"
PATCH_FILE="$DSH_HOME/cordis.patch.yml"
SEARXNG_INSTALLER="$SCRIPT_DIR/searxng/searxng-install.sh"

# ─── parse args ───────────────────────────────────────────────────────────────

DO_INSTALL=0
DO_UNWIRE=0

for arg in "$@"; do
  case "$arg" in
    --install) DO_INSTALL=1 ;;
    --unwire)  DO_UNWIRE=1 ;;
    --help|-h)
      cat <<'EOF'
Usage: install.sh [--install] [--unwire]

  (no flags)   Copy plugin + write/merge home-level patch + print hints
  --install    Also run searxng/searxng-install.sh to set up a local SearXNG
  --unwire     Remove SearXNG rows from the patch (restore backup if present)

Env:
  DSH_HOME                dsh home (default: $DSH_HOME or ~/.dsh)
  DSH_SEARXNG_PLUGIN_DIR  Plugin copy destination (default: ~/searxng-web-search)
EOF
      exit 0
      ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

# ─── --unwire path ────────────────────────────────────────────────────────────

if [ "$DO_UNWIRE" -eq 1 ]; then
  echo "Unwiring SearXNG web_search plugin…"

  if [ ! -f "$PATCH_FILE" ]; then
    echo "  No patch file at $PATCH_FILE — nothing to do."
    exit 0
  fi

  # Restore the most recent backup if one exists
  local_backup=""
  for bak in "$PATCH_FILE".bak.*; do
    [ -f "$bak" ] && local_backup="$bak"
  done

  if [ -n "$local_backup" ]; then
    echo "  Restoring from backup: $local_backup"
    cp "$local_backup" "$PATCH_FILE"
    rm -f "$local_backup"
    echo "  Done. Restart dsh to apply."
  else
    echo "  No backup found. The SearXNG rows in $PATCH_FILE must be removed manually."
    echo ""
    echo "  Remove these three blocks (and their comments):"
    echo "    1. The '- id: web' block with 'searchProvider: searxng'"
    echo "    2. The '- id: web-search-deepseek' block with 'disabled: true'"
    echo "    3. The '- insert:' block with 'id: web-search-searxng'"
    echo ""
    echo "  Then restart dsh."
  fi
  exit 0
fi

# ─── step 1: copy the plugin ──────────────────────────────────────────────────

echo "SearXNG web_search plugin installer"
echo "  DSH_HOME   : $DSH_HOME"
echo "  plugin dir : $PLUGIN_DIR"
echo ""

echo "[1/3] Copying plugin to $PLUGIN_DIR …"
mkdir -p "$PLUGIN_DIR"
cp "$SCRIPT_DIR/plugin/index.js"     "$PLUGIN_DIR/index.js"
cp "$SCRIPT_DIR/plugin/package.json"  "$PLUGIN_DIR/package.json"
cp "$SCRIPT_DIR/plugin/test.mjs"      "$PLUGIN_DIR/test.mjs"
chmod +x "$PLUGIN_DIR/index.js" 2>/dev/null || true
echo "      ✓ index.js, package.json, test.mjs"

# ─── step 2: write/merge the home-level patch ─────────────────────────────────

echo "[2/3] Writing/merging $PATCH_FILE …"
mkdir -p "$DSH_HOME"

# Read the template (from this runbook)
template_content="$(cat "$SCRIPT_DIR/cordis.patch.yml")"

# Expand the __DSH_HOME__ placeholder using bash parameter expansion
# (NOT sed — sed misparses paths containing | or &).
# The placeholder must resolve to the PARENT of the plugin copy destination so
# that "__DSH_HOME__/searxng-web-search/index.js" points at the actual file.
PLUGIN_PARENT="$(cd "$PLUGIN_DIR/.." && pwd)"
expanded_content="${template_content//__DSH_HOME__/$PLUGIN_PARENT}"

if [ ! -f "$PATCH_FILE" ]; then
  # File absent → write it fresh
  printf '%s\n' "$expanded_content" > "$PATCH_FILE"
  echo "      ✓ created (new file)"
else
  # File exists — check if SearXNG rows are already present
  if grep -q 'web-search-searxng' "$PATCH_FILE"; then
    echo "      ✓ already contains SearXNG rows — leaving as-is"
  else
    # Collision check: does the target already declare - id: web or - id: web-search-deepseek?
    collision=0
    if grep -qE '^\s*-\s+id:\s*web\s*$' "$PATCH_FILE"; then
      echo "      ⚠  collision: existing '- id: web' found in target"
      echo "         existing block:"
      grep -A3 '^\s*-\s*id:\s*web\s*$' "$PATCH_FILE" | sed 's/^/           /'
      collision=1
    fi
    if grep -qE '^\s*-\s*id:\s*web-search-deepseek\s*$' "$PATCH_FILE"; then
      echo "      ⚠  collision: existing '- id: web-search-deepseek' found in target"
      echo "         existing block:"
      grep -A2 '^\s*-\s*id:\s*web-search-deepseek\s*$' "$PATCH_FILE" | sed 's/^/           /'
      collision=1
    fi

    if [ "$collision" -eq 1 ]; then
      echo ""
      echo "      Appending ONLY the '- insert:' block for manual reconciliation."
      echo "      You will need to manually merge the 'web' and 'web-search-deepseek' rows."
      echo ""
      # Append only the insert block
      insert_block="$(printf '%s\n' "$expanded_content" | awk '/^- insert:/{found=1} found{print}')"
      {
        echo ""
        echo "# --- SearXNG web_search (appended $(date +%Y-%m-%d), needs manual reconciliation) ---"
        printf '%s\n' "$insert_block"
      } >> "$PATCH_FILE"
      echo "      ✓ appended insert block only"
    else
      # No collision: back up and append all three rows under a dated banner
      local_ts="$(date +%Y%m%d%H%M%S)"
      cp "$PATCH_FILE" "$PATCH_FILE.bak.${local_ts}"
      {
        echo ""
        echo "# --- SearXNG web_search (added $(date +%Y-%m-%d %H:%M)) ---"
        printf '%s\n' "$expanded_content"
      } >> "$PATCH_FILE"
      echo "      ✓ appended all three rows (backup: cordis.patch.yml.bak.${local_ts})"
    fi
  fi
fi

# ─── step 3: optional SearXNG install ─────────────────────────────────────────

echo "[3/3] SearXNG instance …"

if [ "$DO_INSTALL" -eq 1 ]; then
  echo "      Running $SEARXNG_INSTALLER …"
  bash "$SEARXNG_INSTALLER" "$HOME/searxng"
  echo "      ✓ SearXNG installed"
else
  # Auto-detect: is anything listening on port 8888?
  if command -v nc &>/dev/null; then
    if nc -z 127.0.0.1 8888 2>/dev/null; then
      echo "      ✓ something is already listening on 127.0.0.1:8888"
    else
      echo "      No SearXNG detected on 127.0.0.1:8888."
      echo "      To install one:  ./install.sh --install"
      echo "      (or run:        $SEARXNG_INSTALLER)"
    fi
  else
    # Fallback: try curl
    if curl -sf http://127.0.0.1:8888/healthz &>/dev/null; then
      echo "      ✓ SearXNG is reachable on 127.0.0.1:8888"
    else
      echo "      No SearXNG detected on 127.0.0.1:8888."
      echo "      To install one:  ./install.sh --install"
      echo "      (or run:        $SEARXNG_INSTALLER)"
    fi
  fi
fi

# ─── next steps ───────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  Next steps"
echo "═══════════════════════════════════════════════════════════════════════"
echo ""
echo "  1. Restart dsh once. Module code changes never hot-reload (the ESM"
echo "     loader caches by file:// URL), and even patch config changes only"
echo "     hot-reload while the process's config watcher is alive — in a"
echo "     long-running dsh (especially a 'dsh web' GUI session) that watcher"
echo "     can be dead, so the restart is the reliable path either way."
echo ""
echo "  2. Verify the wiring:"
echo "     • Run:  DSH_SEARXNG_URL=http://127.0.0.1:8888 node $PLUGIN_DIR/test.mjs"
echo "     • Or in a dsh session, use web_search and confirm results come from"
echo "       SearXNG (titles/snippets from DuckDuckGo/Brave/Google, not DeepSeek)."
echo ""
echo "  3. To uninstall later:  ./install.sh --unwire"
echo ""
echo "  Env vars (all optional; the patch row's config block takes precedence):"
echo "     DSH_SEARXNG_URL     (default: http://127.0.0.1:8888)"
echo "     DSH_SEARXNG_ENGINES (default: duckduckgo,brave,google,google cse,bing,mojeek,ecosia,startpage,yahoo)"
echo "     DSH_SEARXNG_MAX     (default: 30)"
echo "═══════════════════════════════════════════════════════════════════════"
