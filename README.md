# SearXNG-backed `web_search` for DeepSeek Harness

A self-contained runbook that routes dsh's model-facing `web_search` through a
**local, keyless SearXNG** instance (fan-out to a resilient multi-engine set —
by default DuckDuckGo, Brave, Google, Google CSE, Bing, Mojeek, Ecosia,
Startpage, and Yahoo; per-instance overrides supported), while leaving
`web_fetch` untouched. No API keys, no hosted search, no per-query cost.

---

## What you get

| Capability | Before (default) | After (this plugin) |
|---|---|---|
| `web_search` | DeepSeek-hosted search (relative dates, opaque source) | Local SearXNG → resilient multi-engine set (absolute URLs, snippets, published dates) |
| `web_fetch` | dsh built-in HTTP fetch | **Unchanged** — still uses the `http` fetch provider |

---

## Prerequisites

- **dsh** (DeepSeek Harness) installed and running.
- **A local SearXNG instance** answering JSON on `127.0.0.1:8888` —
  or none at all: with `--install`, the installer builds, deploys, and
  configures one for you (see [Install](#install)). The included
  `searxng/searxng-install.sh` is fully self-contained:
  - Only `git` + `curl` (+ `sudo` on Linux) needed — **no system Python** (it bootstraps `uv`).
  - Installs a pinned SearXNG commit into `~/searxng/`.
  - Sets up an auto-start service (macOS LaunchAgent / Linux systemd).
  - Self-tests on exit (healthz + a live JSON search).

---

## Install

```bash
cd searxng-web-search/
```

**No local SearXNG yet?** Run with `--install` and it will build, deploy,
and configure one for you, then wire up dsh — everything in one shot:

```bash
./install.sh --install
```

**Already have one** (JSON-enabled, on `127.0.0.1:8888` — or point
`DSH_SEARXNG_URL` at wherever yours listens)? A bare run is all you need:

```bash
./install.sh
```

(Or, step by step: `./install.sh` for the dsh wiring, then
`bash searxng/searxng-install.sh` for the backend, separately.)

The installer:
1. Copies `plugin/{index.js,package.json,test.mjs}` → `~/searxng-web-search/`.
2. Writes/merges `$DSH_HOME/cordis.patch.yml` (the home-level wiring).
3. (With `--install`) runs the SearXNG installer: bootstraps `uv`, clones a
   pinned SearXNG commit into `~/searxng/`, creates the venv, writes
   `settings.yml` (JSON format enabled, fresh secret, safe-search locked),
   installs the auto-start service (macOS LaunchAgent / Linux systemd), and
   self-tests with a live JSON search. It's idempotent — safe to re-run.
   On Linux it needs `sudo` for the systemd unit; on a fresh machine the
   whole step takes a few minutes (clone + venv build).

**Restart dsh** after installing — on a fresh install the plugin module has
never been imported by the running process, so the restart is what loads it.
Afterwards, patch *config* changes — including the plugin row's own `config:`
block (e.g. switching `engines`) — are picked up **hot** while the process's
config watcher is alive. Note that in a long-running process (especially a
`dsh web` GUI session) that watcher can die, after which *no* patch change —
config or module — takes effect until dsh is restarted; module *code* changes
require a restart either way (the ESM loader caches by `file://` URL). The
safe rule of thumb: after touching the plugin or its patch row, restart dsh
once.

---

## How the plugin mounts

dsh's plugin loader resolves a patch row's `name:` field into a `file://` URI
and imports it as an ES module. Two constraints drive the design:

1. **Absolute path required.** The loader only rewrites absolute (or
   workspace-relative) paths into `file://` URIs. A bare package name like
   `"dsh-web-search-searxng"` will **not** resolve from a home-level patch —
   you must use the full path to the plugin copy, e.g.
   `$HOME/searxng-web-search/index.js` (or wherever `DSH_SEARXNG_PLUGIN_DIR`
   points).

2. **Self-contained module.** The plugin is mounted from a path *outside* dsh's
   install closure. Node resolves a module's bare imports by walking up from
   the module's own directory — a path outside the install cannot reach dsh's
   nested `node_modules`. Therefore `index.js` uses **only** Node builtins and
   the global `fetch` — zero npm dependencies. It loads in any context.

**Hot-reload nuance:** patch *config* changes (e.g. switching
`searchProvider`) hot-reload *while the process's config watcher is alive* —
in a long-running process (notably `dsh web` GUI sessions) that watcher can
die, after which even config changes need a restart. Module *code* changes
do **not** hot-reload at all — the ESM loader caches by `file://` URL.
Renaming `name:` (version suffix, e.g. `index.v2.js`) forces a re-import only
when the watcher is alive; otherwise restart dsh.

---

## Configuration

Every setting can be given in the plugin row's `config:` block (recommended —
it lives in `$DSH_HOME/cordis.patch.yml`; config changes there hot-reload
while the process's watcher is alive, see the nuance above), via environment
variables, or left to the built-in defaults. Precedence:
**config block > env var > default**.

| Setting | Config field | Env var | Default |
|---|---|---|---|
| SearXNG base URL | `url` | `DSH_SEARXNG_URL` | `http://127.0.0.1:8888` |
| Engine list | `engines` (list or comma string) | `DSH_SEARXNG_ENGINES` | `duckduckgo,brave,google,google cse,bing,mojeek,ecosia,startpage,yahoo` |
| Result cap per request | `max` | `DSH_SEARXNG_MAX` | `30` |

The default engine list deliberately spans nine backends: on any given
instance a few of the big three (DuckDuckGo/Brave/Google) may be
CAPTCHA-suspended or rate-limited after heavy use, and a wider net keeps
`web_search` productive regardless. If your instance has a particular set of
engines that stays responsive, pin them in the patch (config hot-reloads
while the process's watcher is alive; if the edit appears to have no effect,
the watcher is dead — restart dsh):

```yaml
# $DSH_HOME/cordis.patch.yml — edit the value in the existing row
- insert:
    - id: web-search-searxng
      name: /…/searxng-web-search/index.js   # absolute path, as written by install.sh
      config:
        engines: ["google cse", "bing", "mojeek"]
```

To discover which engines are responsive on your instance, see the
`unresponsive_engines` probe in *Testing & verification* below. Env vars
remain available for dsh environments where editing the home patch is
impractical:

```bash
export DSH_SEARXNG_URL="http://127.0.0.1:8888"
# export DSH_SEARXNG_ENGINES="duckduckgo,brave"
# export DSH_SEARXNG_MAX="20"
```

---

## Safe Search

SearXNG's `safe_search: 2` (strict) is the default, and `preferences.lock:
[safesearch]` **pins** it — neither the web UI nor a per-request
`?safesearch=` parameter can relax it. Since dsh never sends a `safesearch`
parameter, all its searches inherit the strict level.

Per-engine mapping (SearXNG's internal enforcement):
- **DuckDuckGo**: `ad=1` (strict family filter)
- **Brave**: `safeSearch=strict`
- **Google**: `safe=strict`

To verify, query the SearXNG instance directly:
```bash
curl -s http://127.0.0.1:8888/config | jq '.preferences.safesearch'
# → 2
```

---

## Privacy

Your search queries — including any code, file paths, or context the model
puts into a `web_search` call — are sent to the **configured engine set**
(by default DuckDuckGo, Brave, Google, Google CSE, Bing, Mojeek, Ecosia,
Startpage, and Yahoo) over the internet. SearXNG is a proxy/fan-out, not a
firewall.

- **Do not put confidential material** (secrets, customer data, unreleased
  code) into turns that trigger `web_search`.
- **On-prem alternative**: point the SearXNG base URL at a gateway-hosted
  instance and restrict its engine list (patch `config.engines` or
  `DSH_SEARXNG_ENGINES`) to internal/whitelisted engines to keep queries on
  your network.

The SearXNG instance itself binds to `127.0.0.1` only — it is not reachable
from other machines.

---

## Platforms

| OS | Auto-start mechanism | Notes |
|---|---|---|
| macOS | LaunchAgent (`~/Library/LaunchAgents/com.<user>.searxng.plist`) | `RunAtLoad` + `KeepAlive` (crash-only) |
| Linux | systemd unit (`/etc/systemd/system/searxng.service`) | `sudo` required; `enable --now` |
| Windows | Manual | Run: `SEARXNG_SETTINGS_PATH=… .venv\Scripts\python -m searx.webapp` |

The dsh plugin (`index.js`) and the patch (`cordis.patch.yml`) are
**platform-neutral** — they work identically everywhere.

---

## Supply chain

- **`uv`**: downloaded from the official `astral-sh/uv` GitHub release and
  **sha256-verified before use** (hard-pinned per-host hashes for the default
  version; fetched `.sha256` sidecar for overrides). A mismatch aborts the
  install.
- **SearXNG**: pinned to a specific commit
  (`f5035873ad39929c1a2467616faa408b0f97bc06` by default). SearXNG has no
  release tags — `master` is force-moved by upstream. To update:
  ```bash
  bash searxng/searxng-install.sh --update SEARXNG_REF=<new-sha>
  ```
- **No npm packages** in the plugin. No supply-chain surface beyond the two
  pinned upstreams above.

---

## Testing & verification

Once SearXNG is running:

```bash
# 1. Health check
curl -s http://127.0.0.1:8888/healthz
# → 200

# 2. Raw JSON search
curl -s 'http://127.0.0.1:8888/search?q=rust+web+framework&format=json&per_page=5' | jq '.results[0].title'

# 3. Check which engines were unresponsive (each entry is [name, reason]):
curl -s 'http://127.0.0.1:8888/search?q=test&format=json&per_page=5' | jq '.unresponsive_engines'
# → e.g. [["brave","Suspended: too many requests"]] means Brave was rate-limited
# → fix: pin the responsive subset in the patch row's config.engines (hot-reloads)

# 4. End-to-end plugin smoke test
DSH_SEARXNG_URL=http://127.0.0.1:8888 node ~/searxng-web-search/test.mjs

# 5. Verify safe-search enforcement
curl -s http://127.0.0.1:8888/config | jq '.preferences.safesearch'
# → 2
```

---

## File map

```
searxng-web-search/
  README.md                  ← you are here
  install.sh                 ← per-machine installer (copy plugin, write patch, optional SearXNG)
  cordis.patch.yml           ← reference home-level patch template (3 rows, with comments)
  plugin/
    index.js                 ← the SearXNG search provider (self-contained ESM, no deps)
    package.json             ← ESM manifest (type: module, private)
    test.mjs                 ← runnable smoke test (node test.mjs)
  searxng/
    searxng-install.sh       ← self-contained SearXNG installer (uv + clone + venv + service + self-test)
    settings.template.yml    ← SearXNG settings template (json format, strict safesearch, no cache)
```

---

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| Still getting DeepSeek-style results (relative dates like "2 hours ago") | The plugin isn't active yet. Restart dsh. Confirm `searchProvider: searxng` is in the active patch. |
| `web_search` fails with "DeepSeek search has no API key" after installing | The patch was written to the wrong dsh home. The harness home is `$DSH_HOME` if set, otherwise `~/.dsh`. Confirm `$DSH_HOME/cordis.patch.yml` exists (not just `~/.deepseek-harness/cordis.patch.yml`) and re-run `./install.sh` from a shell that exports the same `DSH_HOME` dsh runs with. |
| `SearXNG search failed to reach http://127.0.0.1:8888` | SearXNG isn't running. Check `systemctl status searxng` (Linux) or `launchctl list \| grep searxng` (macOS). Look at the stderr log. |
| 0 results from SearXNG | Two causes: (a) the requested engines are all suspended on this instance (rate-limiting / CAPTCHA — common for duckduckgo/brave/google on home and datacenter IPs): probe with the `unresponsive_engines` query in *Testing & verification*, then pin the responsive subset in the plugin row's `config.engines` (hot-reloads, no restart) or `DSH_SEARXNG_ENGINES`; (b) a **transient** per-request flake — a single request can momentarily come back empty even from a healthy instance, and a retry usually succeeds. Persistent zeros across retries point to (a). Not a mis-install either way. |
| A specific engine keeps reporting `Suspended: CAPTCHA` / `too many requests` | That backend has rate-limited the instance's outbound IP; it often clears with time (SearXNG auto-retries and the suspension lifts on its own schedule). Meanwhile, exclude it from `engines` and rely on the rest of the set. |
| `HTTP 403` from `/search?format=json` | `json` is missing from `search.formats` in `settings.yml`. The template includes it; if you have a pre-existing `settings.yml`, add `- json` under `search.formats`. |
| `insert` name not becoming a `file://` URI | The `name:` field in the patch row must be an **absolute path**. A bare package name or relative path won't resolve. Use the full path to the plugin copy, e.g. `$HOME/searxng-web-search/index.js`. |
| Plugin loads but `available()` returns false | `DSH_SEARXNG_URL` is set to a malformed URL (e.g. missing scheme). Must be `http://…` or `https://…`. |
| Module code changes not taking effect | ESM loader caches by `file://` URL, so a running process keeps the module it imported at boot. Restarting dsh is the reliable fix. Renaming `name:` (version suffix, e.g. `index.v2.js`) *can* force a re-import — but only while the process's config hot-reload is alive; a long-running process (especially `dsh web` GUI sessions) can lose that watcher, after which **no** patch edit takes effect until a restart. Verify the edit actually took effect (new behavior / a fresh write in `~/.dsh`) before relying on it. |
| `web_search` fails with "value is not lossless JSON" on every attempt | The running process has a **stale cached copy of the plugin** (an older version imported at boot under the same `file://` URL) whose output the current harness rejects — the on-disk plugin may already be fixed, but the process never re-imported it (see the row above). Fix: restart dsh. The current plugin version guards its output with a lossless-JSON self-check, so once the fresh process imports it, this error cannot recur. |
