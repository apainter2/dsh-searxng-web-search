#!/usr/bin/env bash
# searxng-install.sh — self-contained, idempotent installer for a local SearXNG
# instance answering JSON on 127.0.0.1:8888.
#
# Preinstalled deps: git + curl (and sudo on Linux). No system Python needed.
#
# Usage:
#   ./searxng-install.sh [target-dir] [--update]
#
#   target-dir   Install directory (default: $HOME/searxng)
#   --update     Fetch latest branch refs and reset to the pinned commit
#
# Env overrides:
#   UV_VERSION    (default: 0.12.20)
#   SEARXNG_REF   (default: f5035873ad39929c1a2467616faa408b0f97bc06)

set -euo pipefail

# ─── constants ────────────────────────────────────────────────────────────────

UV_VERSION="${UV_VERSION:-0.12.20}"
SEARXNG_REF="${SEARXNG_REF:-f5035873ad39929c1a2467616faa408b0f97bc06}"
SEARXNG_REPO="https://github.com/searxng/searxng.git"
PORT=8888
BIND="127.0.0.1"

# ─── argument parsing ─────────────────────────────────────────────────────────

TARGET="${HOME}/searxng"
UPDATE=0

for arg in "$@"; do
  case "$arg" in
    --update) UPDATE=1 ;;
    --help|-h)
      cat <<'EOF'
Usage: searxng-install.sh [target-dir] [--update]

  target-dir   Install directory (default: $HOME/searxng)
  --update     Fetch branch refs and reset to the pinned SearXNG commit

Env:
  UV_VERSION   uv release to bootstrap (default: 0.12.20)
  SEARXNG_REF  Pinned SearXNG commit SHA (default: f5035873ad39929c1a2467616faa408b0f97bc06)
EOF
      exit 0
      ;;
    *) TARGET="$arg" ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── helpers ──────────────────────────────────────────────────────────────────

die() {
  echo "ERROR: $*" >&2
  exit 1
}

sha256_of() {
  # Portable sha256: use shasum (macOS) or sha256sum (Linux)
  if command -v sha256sum &>/dev/null; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum &>/dev/null; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "Neither sha256sum nor shasum found; cannot verify checksums"
  fi
}

detect_host() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin)
      case "$arch" in
        arm64)   echo "aarch64-apple-darwin" ;;
        x86_64)  echo "x86_64-apple-darwin" ;;
        *)       die "Unsupported macOS arch: $arch" ;;
      esac
      ;;
    Linux)
      case "$arch" in
        x86_64)        echo "x86_64-unknown-linux-gnu" ;;
        aarch64|arm64) echo "aarch64-unknown-linux-gnu" ;;
        *)             die "Unsupported Linux arch: $arch" ;;
      esac
      ;;
    *) die "Unsupported OS: $os" ;;
  esac
}

# ─── step 1: bootstrap uv ─────────────────────────────────────────────────────

bootstrap_uv() {
  local host
  host="$(detect_host)"
  export UV_PYTHON_INSTALL_DIR="$TARGET/.uv-python"
  export UV_CACHE_DIR="$TARGET/.uv-cache"
  mkdir -p "$TARGET/bin"
  local uvcmd="$TARGET/bin/uv"

  if [ -x "$uvcmd" ]; then
    echo "[uv] reusing existing $uvcmd ($("$uvcmd" --version))"
    return 0
  fi

  local url="https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${host}.tar.gz"
  local tmpdir
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' RETURN

  echo "[uv] downloading $url"
  curl -fsSL -o "$tmpdir/uv.tar.gz" "$url" || die "Step 1: uv download failed ($url)"

  # Verify sha256 before use
  local expected
  if [ "$UV_VERSION" = "0.12.20" ]; then
    case "$host" in
      aarch64-apple-darwin)    expected="848fdeb602ff1a1baacd4f6c8b7bdc6cf1ad026a6d9cf59475fda17c179743ca" ;;
      x86_64-apple-darwin)     expected="ac54283d211fd77cdc152b67606dbaf6406ff4ab03f3af4ae99468fa8e887141" ;;
      x86_64-unknown-linux-gnu) expected="6590717592ace991ff83a63fef799e3ad9d33ecc8f96c5d6bdd732496e79337f" ;;
      aarch64-unknown-linux-gnu) expected="8a7aad7bc76a2fae5151566ff3e43eacce0b2a113d5e4de3e4afe3e58fa2441e" ;;
      *) die "Step 1: no pinned hash for host '$host' with UV_VERSION=$UV_VERSION" ;;
    esac
  else
    # For non-default versions, fetch the published per-asset .sha256 file
    local shafile
    shafile="$(curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${host}.tar.gz.sha256")" \
      || die "Step 1: failed to fetch published sha256 for uv $UV_VERSION ($host)"
    expected="$(printf '%s\n' "$shafile" | awk '{print $1}')"
    # Sanity: must be 64 hex chars
    if ! printf '%s' "$expected" | grep -qE '^[0-9a-fA-F]{64}$'; then
      die "Step 1: unexpected sha256 from published file: '$expected'"
    fi
  fi

  local actual
  actual="$(sha256_of "$tmpdir/uv.tar.gz")"
  echo "[uv] sha256 actual   : $actual"
  echo "[uv] sha256 expected: $expected"
  if [ "$actual" != "$expected" ]; then
    die "Step 1: uv sha256 MISMATCH (got $actual, want $expected). Aborting before use."
  fi
  echo "[uv] sha256 OK"

  # Extract and install
  tar -xzf "$tmpdir/uv.tar.gz" -C "$tmpdir"
  # The tarball contains a single binary at the top level (uv) or in a dir
  local src
  if [ -f "$tmpdir/uv" ]; then
    src="$tmpdir/uv"
  elif [ -f "$tmpdir/uv-${host}/uv" ]; then
    src="$tmpdir/uv-${host}/uv"
  else
    # find the binary
    src="$(find "$tmpdir" -maxdepth 2 -name 'uv' -type f | head -1)"
    [ -n "$src" ] || die "Step 1: could not locate uv binary in tarball"
  fi
  cp "$src" "$uvcmd"
  chmod 0755 "$uvcmd"
  echo "[uv] installed $uvcmd ($("$uvcmd" --version))"
}

# ─── step 2: clone SearXNG at pinned commit ───────────────────────────────────

clone_searxng() {
  local repo="$TARGET/searxng"

  if [ -d "$repo/.git" ]; then
    if [ "$UPDATE" -eq 1 ]; then
      echo "[clone] --update: fetching refs and resetting to $SEARXNG_REF"
      git -C "$repo" fetch --prune origin || die "Step 2: git fetch failed"
      git -C "$repo" checkout --detach "$SEARXNG_REF" || die "Step 2: checkout $SEARXNG_REF failed"
    else
      echo "[clone] reusing existing clone at $repo"
    fi
  else
    echo "[clone] full-cloning SearXNG into $repo (pinned: $SEARXNG_REF)"
    git clone "$SEARXNG_REPO" "$repo" || die "Step 2: git clone failed"
    git -C "$repo" checkout --detach "$SEARXNG_REF" || die "Step 2: checkout $SEARXNG_REF failed (commit not found?)"
  fi

  # Assert HEAD equals the pinned commit
  local head
  head="$(git -C "$repo" rev-parse HEAD)"
  if [ "$head" != "$SEARXNG_REF" ]; then
    die "Step 2: HEAD is $head but pinned ref is $SEARXNG_REF. Aborting."
  fi
  echo "[clone] HEAD = $head ✓"
}

# ─── step 3: provision Python 3.13 + venv via uv ──────────────────────────────

provision_python() {
  local uv="$TARGET/bin/uv"
  local venv="$TARGET/.venv"

  if [ -x "$venv/bin/python" ]; then
    echo "[venv] reusing existing $venv"
  else
    echo "[venv] creating $venv (Python 3.13) via uv"
    "$uv" venv --python 3.13 "$venv" || die "Step 3: uv venv failed"
  fi

  echo "[pip] installing SearXNG requirements into $venv"
  "$uv" pip install --python "$venv/bin/python" -r "$TARGET/searxng/requirements.txt" \
    || die "Step 3: uv pip install failed"
  echo "[pip] done"
}

# ─── step 4: write settings.yml from template ─────────────────────────────────

write_settings() {
  local template="$SCRIPT_DIR/settings.template.yml"
  local out="$TARGET/settings.yml"

  if [ -f "$out" ]; then
    echo "[settings] keeping existing $out (not overwriting)"
    return 0
  fi

  [ -f "$template" ] || die "Step 4: template $template not found (must sit next to the script)"

  local secret
  secret="$(openssl rand -hex 32)" || die "Step 4: openssl rand failed"

  # Replace the placeholder (using bash parameter expansion to avoid sed pitfalls)
  local content
  content="$(cat "$template")"
  content="${content//__SEARXNG_SECRET_KEY__/$secret}"
  printf '%s\n' "$content" > "$out"
  chmod 600 "$out"
  echo "[settings] wrote $out (fresh secret, mode 600)"
}

# ─── step 5: install auto-start service ───────────────────────────────────────

install_service() {
  local user
  user="$(whoami)"
  local venv="$TARGET/.venv"
  local settings="$TARGET/settings.yml"
  local clone="$TARGET/searxng"
  local logs="$TARGET/logs"
  mkdir -p "$logs"

  local os
  os="$(uname -s)"

  if [ "$os" = "Darwin" ]; then
    # ── macOS: LaunchAgent ──
    local plist="$HOME/Library/LaunchAgents/com.${user}.searxng.plist"
    mkdir -p "$(dirname "$plist")"
    echo "[service] writing LaunchAgent: $plist"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.${user}.searxng</string>
  <key>ProgramArguments</key>
  <array>
    <string>${venv}/bin/python</string>
    <string>-m</string>
    <string>searx.webapp</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SEARXNG_SETTINGS_PATH</key>
    <string>${settings}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${clone}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>CrashOnly</key>
    <true/>
  </dict>
  <key>StandardOutPath</key>
  <string>${logs}/searxng.out.log</string>
  <key>StandardErrorPath</key>
  <string>${logs}/searxng.err.log</string>
</dict>
</plist>
PLIST
    # Reload the agent
    launchctl unload "$plist" 2>/dev/null || true
    launchctl load "$plist"
    echo "[service] LaunchAgent loaded"

  elif [ "$os" = "Linux" ]; then
    # ── Linux: systemd unit ──
    local unit="/etc/systemd/system/searxng.service"
    echo "[service] writing systemd unit: $unit (via sudo)"
    sudo tee "$unit" > /dev/null <<UNIT
[Unit]
Description=SearXNG metasearch engine (local)
After=network.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${clone}
Environment=SEARXNG_SETTINGS_PATH=${settings}
ExecStart=${venv}/bin/python -m searx.webapp
StandardOutput=append:${logs}/searxng.out.log
StandardError=append:${logs}/searxng.err.log
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
    sudo systemctl daemon-reload
    sudo systemctl enable --now searxng
    echo "[service] systemd unit enabled and started"

  else
    echo "[service] No auto-start for this OS. Start manually with:"
    echo "  SEARXNG_SETTINGS_PATH=${settings} ${venv}/bin/python -m searx.webapp"
  fi
}

# ─── step 6: self-test ─────────────────────────────────────────────────────────

self_test() {
  local url="http://${BIND}:${PORT}"
  echo ""
  echo "── Self-test ───────────────────────────────────────────────────────────"

  # Wait for healthz
  local i=0
  local max_wait=30
  local interval=2
  echo "[test] waiting up to ${max_wait}s for ${url}/healthz …"
  while [ $i -lt $max_wait ]; do
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' "${url}/healthz" 2>/dev/null || echo "000")"
    if [ "$code" = "200" ]; then
      echo "[test] healthz OK (${i}s)"
      break
    fi
    i=$((i + interval))
    sleep "$interval"
    if [ $i -ge $max_wait ]; then
      die "Self-test: ${url}/healthz did not return 200 within ${max_wait}s. Check the log: ${TARGET}/logs/searxng.err.log"
    fi
  done

  # JSON search — no engines= parameter on purpose: it uses SearXNG's default
  # engine set (dozens of engines), so at least one is almost always
  # responsive even when the big-3 (duckduckgo/brave/google) are
  # captcha-suspended or rate-limited. A 0-result response is still handled
  # below as a warning, not a failure.
  echo "[test] running JSON search (q='rust web framework', default engine set, per_page=10) …"
  local search_url="${url}/search?q=rust+web+framework&format=json&per_page=10"
  local body
  body="$(curl -fsSL "$search_url" 2>/dev/null || echo "")"

  if [ -z "$body" ]; then
    echo "[test] WARNING: search returned no body (upstream rate-limit/CAPTCHA?). This is not a mis-install."
    echo "[test]        Check 'unresponsive_engines' in the JSON response for details."
  else
    local count
    count="$(printf '%s' "$body" | grep -o '"url"' | wc -l | tr -d ' ')"
    if [ "$count" -gt 0 ]; then
      echo "[test] PASS: ${count} results returned"
    else
      echo "[test] WARNING: 0 results in JSON body (upstream CAPTCHA/rate-limiting likely)."
      echo "[test]         Check 'unresponsive_engines' in: ${body}"
      echo "[test]         This is normal and not a mis-install."
    fi
  fi

  # Final summary
  echo ""
  echo "═══════════════════════════════════════════════════════════════════════"
  echo "  SearXNG local install — summary"
  echo "═══════════════════════════════════════════════════════════════════════"
  echo "  Install dir : ${TARGET}"
  echo "  URL         : ${url}"
  echo "  Pinned ref  : ${SEARXNG_REF}"
  echo "  To update   : re-run this script with --update SEARXNG_REF=<new-sha>"
  echo ""
  echo "  dsh plugin  : export DSH_SEARXNG_URL=${url}"
  echo ""
  echo "  Uninstall   :"
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "    launchctl unload ~/Library/LaunchAgents/com.${user}.searxng.plist"
    echo "    rm -rf ${TARGET}"
  elif [ "$(uname -s)" = "Linux" ]; then
    echo "    sudo systemctl disable --now searxng"
    echo "    sudo rm /etc/systemd/system/searxng.service"
    echo "    sudo systemctl daemon-reload"
    echo "    rm -rf ${TARGET}"
  fi
  echo "═══════════════════════════════════════════════════════════════════════"
}

# ─── main ─────────────────────────────────────────────────────────────────────

main() {
  echo "SearXNG installer"
  echo "  target     : $TARGET"
  echo "  uv version : $UV_VERSION"
  echo "  searxng ref: $SEARXNG_REF"
  echo "  update     : $UPDATE"
  echo ""

  bootstrap_uv
  clone_searxng
  provision_python
  write_settings
  install_service
  self_test
}

main "$@"
